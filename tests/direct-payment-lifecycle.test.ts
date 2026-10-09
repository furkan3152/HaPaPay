import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { MemoryPaymentRepository, PaymentHistoryService } from "../server/payment-history-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { buildArcUsdcTransfer } from "../src/domain/arc-transaction";
import { resolveFoundryBinary } from "../scripts/foundry-binary";
import { verifyClaimEscrowContract } from "../server/readiness";
import { approvalCovers, quoteFee } from "../server/stock-transfer-service";
import { FEE_FORWARDER_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts";
import { feeForwarderAbi, payRouterAbi } from "../src/domain/fees";
import { readPaymentNote } from "../src/domain/payment-note";
import { matchesRoutedBatch, type PreparedBatch } from "../src/domain/routed-payments";
import { matchesArcPayment } from "../src/domain/arc-review";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 5_042_002,
  name: "Arc Testnet direct payment simulation",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const tokenAbi = parseAbi([
  "function mint(address recipient, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
]);

describe("Arc direct social payment lifecycle on a real EVM", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  before(async () => {
    const port = await unusedPort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(resolveFoundryBinary("anvil"), [
      "--silent", "--port", String(port), "--chain-id", String(chain.id), "--mnemonic", mnemonic,
    ], { stdio: "ignore" });
    await waitForRpc(rpcUrl);
  });

  after(async () => {
    if (!anvil.killed) anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  });

  it("moves exact 6-decimal USDC, verifies the receipt, and rejects false claims and replay", async () => {
    const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const sender = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const stranger = mnemonicToAccount(mnemonic, { addressIndex: 3 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
    const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });
    const token = await compileMockUsdc();
    const deploymentHash = await deployerWallet.deployContract({ abi: token.abi, bytecode: token.bytecode });
    const usdc = (await publicClient.waitForTransactionReceipt({ hash: deploymentHash })).contractAddress!;
    const mintHash = await deployerWallet.writeContract({
      address: usdc,
      abi: tokenAbi,
      functionName: "mint",
      args: [sender.address, parseUnits("20", 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const prepared = buildArcUsdcTransfer({ usdc, recipient: recipient.address, amount: "7.25" });
    const transactionHash = await senderWallet.sendTransaction({
      to: prepared.to,
      data: prepared.data,
      value: 0n,
    });
    await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    const repository = new MemoryPaymentRepository();
    const payments = new PaymentHistoryService({ chainId: chain.id, usdc, repository, client: publicClient });

    await assert.rejects(
      payments.confirm({ transactionHash, sender: sender.address, recipient: stranger.address, platform: "x", username: "mallory", amount: "7.25" }),
      /reviewed Arc USDC transfer/,
    );
    await assert.rejects(
      payments.confirm({ transactionHash, sender: sender.address, recipient: recipient.address, platform: "x", username: "nora", amount: "7.26" }),
      /reviewed Arc USDC transfer/,
    );

    const confirmed = await payments.confirm({
      transactionHash,
      sender: sender.address,
      recipient: recipient.address,
      platform: "x",
      username: "Nora",
      amount: "7.25",
      sourcePlatform: "github",
      sourceUsername: "ArcBuilder",
    });
    assert.equal(confirmed.direction, "sent");
    assert.equal(confirmed.amount, "7.25");
    assert.deepEqual(confirmed.sourceIdentity, { platform: "github", username: "arcbuilder" });
    assert.equal(await publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [sender.address] }), parseUnits("12.75", 6));
    assert.equal(await publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [recipient.address] }), parseUnits("7.25", 6));
    assert.equal((await payments.list(sender.address)).length, 1);
    assert.equal((await payments.list(recipient.address))[0]?.direction, "received");

    await assert.rejects(
      payments.confirm({ transactionHash, sender: sender.address, recipient: recipient.address, platform: "x", username: "nora", amount: "7.25" }),
      /already confirmed/,
    );
  });

  it("completes the Turkish chat-to-wallet-to-confirmed-history HTTP journey and reports replay as a conflict", async () => {
    const deployer = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const sender = mnemonicToAccount(mnemonic, { addressIndex: 4 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 5 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
    const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });
    const token = await compileMockUsdc();
    const deploymentHash = await deployerWallet.deployContract({ abi: token.abi, bytecode: token.bytecode });
    const usdc = (await publicClient.waitForTransactionReceipt({ hash: deploymentHash })).contractAddress!;
    const mintHash = await deployerWallet.writeContract({
      address: usdc,
      abi: tokenAbi,
      functionName: "mint",
      args: [sender.address, parseUnits("10", 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const identities = new VerifiedIdentityService();
    identities.link(sender.address, { platform: "github", providerUserId: "gh-sender-4", username: "arc-builder", verifiedAt: new Date().toISOString() });
    identities.link(recipient.address, { platform: "x", providerUserId: "x-recipient-5", username: "nora", verifiedAt: new Date().toISOString() });
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "direct-http-lifecycle-secret-32-chars" });
    const payments = new PaymentHistoryService({ chainId: chain.id, usdc, repository: new MemoryPaymentRepository(), client: publicClient });
    const app = createApp({
      auth,
      identities,
      payments,
      network: {
        ready: true,
        environment: "testnet",
        chainName: "Arc Testnet",
        chainId: chain.id,
        chainIdHex: `0x${chain.id.toString(16)}`,
        rpcUrl,
        usdcAddress: usdc,
      },
    });
    const server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const challenge = await fetch(`${origin}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: sender.address }),
      }).then((response) => response.json()) as { id: string; message: string };
      const signature = await sender.signMessage({ message: challenge.message });
      const login = await fetch(`${origin}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie") ?? "";

      const chatResponse = await fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "GitHub hesabımdan X'teki @nora'ya 4,5 USDC gönder" }),
      });
      assert.equal(chatResponse.status, 200);
      const draft = await chatResponse.json() as {
        status: string;
        parser: string;
        resolvedAddress: Address;
        intent: { kind: "send"; amount: string; token: "USDC"; recipient: { platform: "x"; username: string }; sourcePlatform: "github"; status: "draft" };
      };
      assert.equal(draft.status, "ready_for_review");
      assert.equal(draft.parser, "local");
      assert.equal(draft.resolvedAddress, recipient.address);

      const prepareResponse = await fetch(`${origin}/api/payment/prepare`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft.intent, expectedRecipientAddress: draft.resolvedAddress }),
      });
      assert.equal(prepareResponse.status, 200);
      const prepared = await prepareResponse.json() as { transaction: { to: Address; data: Hex; value: Hex; from: Address } };
      assert.equal(prepared.transaction.from, sender.address);
      const transactionHash = await senderWallet.sendTransaction({
        to: prepared.transaction.to,
        data: prepared.transaction.data,
        value: BigInt(prepared.transaction.value),
      });
      await publicClient.waitForTransactionReceipt({ hash: transactionHash });

      const confirmationBody = {
        transactionHash,
        amount: draft.intent.amount,
        recipient: draft.intent.recipient,
        sourcePlatform: draft.intent.sourcePlatform,
      };
      const confirmation = await fetch(`${origin}/api/payments/confirm`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(confirmationBody),
      });
      assert.equal(confirmation.status, 201);
      const confirmed = await confirmation.json() as { direction: string; amount: string; sourceIdentity: { platform: string; username: string } };
      assert.equal(confirmed.direction, "sent");
      assert.equal(confirmed.amount, "4.5");
      assert.deepEqual(confirmed.sourceIdentity, { platform: "github", username: "arc-builder" });

      const history = await fetch(`${origin}/api/payments`, { headers: { Cookie: cookie } });
      assert.equal(history.status, 200);
      assert.equal((await history.json() as { payments: unknown[] }).payments.length, 1);

      const replay = await fetch(`${origin}/api/payments/confirm`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(confirmationBody),
      });
      assert.equal(replay.status, 409);
      assert.deepEqual(await replay.json(), { error: "Arc transaction was already confirmed." });
    } finally {
      await close(server);
    }
  });
});

describe("Arc direct payments through the fee router on a real EVM", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  before(async () => {
    const port = await unusedPort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(resolveFoundryBinary("anvil"), [
      "--silent", "--port", String(port), "--chain-id", String(chain.id), "--mnemonic", mnemonic, "--accounts", "20",
    ], { stdio: "ignore" });
    await waitForRpc(rpcUrl);
  });

  after(async () => {
    if (!anvil.killed) anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  });

  it("prepares approve and pay, delivers the exact amount, sends the whole fee to the operator, and refuses self-sends and short balances", async () => {
    const operator = mnemonicToAccount(mnemonic, { addressIndex: 6 });
    const attestor = mnemonicToAccount(mnemonic, { addressIndex: 7 });
    const sender = mnemonicToAccount(mnemonic, { addressIndex: 8 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 9 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const operatorWallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
    const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });
    const deploy = async (abi: readonly unknown[], bytecode: Hex, args: readonly unknown[] = []) =>
      (await publicClient.waitForTransactionReceipt({ hash: await operatorWallet.deployContract({ abi: abi as Abi, bytecode, args }) })).contractAddress!;
    const token = await compileMockUsdc();
    const usdc = getAddress(await deploy(token.abi, token.bytecode));
    const forwarder = await deploy(feeForwarderAbi, FEE_FORWARDER_ARTIFACT.bytecode, [operator.address]);
    const router = await deploy(payRouterAbi, PAY_ROUTER_ARTIFACT.bytecode, [forwarder, operator.address]);
    const escrow = await deploy(stockClaimEscrowAbi, STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, [attestor.address, router]);
    await publicClient.waitForTransactionReceipt({ hash: await operatorWallet.writeContract({ address: usdc, abi: tokenAbi, functionName: "mint", args: [sender.address, parseUnits("10", 6)] }) });

    const reader = { getBytecode: ({ address }: { address: Address }) => publicClient.getBytecode({ address }), readContract: (call: never) => publicClient.readContract(call) };
    const { fees } = await verifyClaimEscrowContract({ escrow, claimVerifier: attestor.address, operator: operator.address, chainName: chain.name }, reader as never);
    const arcFees = {
      schedule: fees,
      quote: (payer: Address, units: bigint) => quoteFee(reader as never, fees, payer, units, chain.name),
      usdcBalance: async (owner: Address) => await publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [owner] }),
      approvalCovers: (owner: Address, total: bigint) => approvalCovers(reader as never, usdc, owner, getAddress(router), total),
    };
    const identities = new VerifiedIdentityService();
    identities.link(sender.address, { platform: "github", providerUserId: "gh-sender-8", username: "fee-sender", verifiedAt: new Date().toISOString() });
    identities.link(recipient.address, { platform: "x", providerUserId: "x-recipient-9", username: "nora", verifiedAt: new Date().toISOString() });
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "routed-http-lifecycle-secret-32-chars" });
    const paymentRecords = new MemoryPaymentRepository();
    const payments = new PaymentHistoryService({ chainId: chain.id, usdc, repository: paymentRecords, client: publicClient, router: getAddress(router) });
    const app = createApp({
      auth,
      identities,
      payments,
      arcFees,
      network: { ready: true, environment: "testnet", chainName: "Arc Testnet", chainId: chain.id, chainIdHex: `0x${chain.id.toString(16)}`, rpcUrl, usdcAddress: usdc },
    });
    const server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const balance = (owner: Address) => publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    try {
      const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address }) }).then((response) => response.json()) as { id: string; message: string };
      const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature: await sender.signMessage({ message: challenge.message }) }) });
      const cookie = login.headers.get("set-cookie") ?? "";
      const prepare = (body: Record<string, unknown>) => fetch(`${origin}/api/payment/prepare`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const intent = { kind: "send", amount: "4", token: "USDC", recipient: { platform: "x", username: "nora" }, status: "draft" };

      const network = await fetch(`${origin}/api/network`).then((response) => response.json()) as { fees: { router: string; sink: string } };
      assert.equal(network.fees.router, getAddress(router));
      assert.equal(network.fees.sink, "forwarder");

      const short = await prepare({ ...intent, amount: "9.95", expectedRecipientAddress: recipient.address });
      assert.equal(short.status, 400);
      assert.match((await short.json() as { error: string }).error, /needs 10\.0495 USDC, the amount plus the 1% fee/);
      const self = await prepare({ ...intent, recipient: { platform: "github", username: "fee-sender" }, expectedRecipientAddress: sender.address });
      assert.equal(self.status, 400);
      assert.match((await self.json() as { error: string }).error, /your own wallet/);

      const response = await prepare({ ...intent, expectedRecipientAddress: recipient.address });
      assert.equal(response.status, 200);
      const prepared = await response.json() as { fee: { units: string; totalUnits: string; router: string }; paymentRef: Hex; transactions: Array<{ purpose: string; to: Address; data: Hex; value: Hex; from: Address }> };
      assert.deepEqual(prepared.transactions.map((transaction) => [transaction.purpose, transaction.to, transaction.from]), [["approve", usdc, sender.address], ["pay", getAddress(router), sender.address]]);
      assert.deepEqual(decodeFunctionData({ abi: payRouterAbi, data: prepared.transactions[1].data }).args, [usdc, recipient.address, parseUnits("4", 6), prepared.paymentRef]);
      assert.equal(prepared.fee.units, "40000");
      assert.equal(prepared.fee.totalUnits, "4040000");
      let payHash: Hex = "0x";
      for (const transaction of prepared.transactions) {
        payHash = await senderWallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash: payHash })).status, "success");
      }
      assert.equal(await balance(recipient.address), parseUnits("4", 6), "the recipient gets exactly the amount");
      assert.equal(await balance(forwarder), 20_000n);
      assert.equal(await balance(operator.address), 20_000n);
      await publicClient.waitForTransactionReceipt({ hash: await senderWallet.writeContract({ address: forwarder, abi: feeForwarderAbi, functionName: "forward", args: [usdc] }) });
      assert.equal(await balance(operator.address), 40_000n, "the whole fee reaches the operator");

      const confirmation = await fetch(`${origin}/api/payments/confirm`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ transactionHash: payHash, amount: "4", recipient: intent.recipient }) });
      assert.equal(confirmation.status, 201, "the routed payment carries the exact USDC Transfer to the recipient");
      const record = (await paymentRecords.list(chain.id, sender.address)).find((entry) => entry.transactionHash === payHash);
      assert.equal(record?.feeUnits, "40000", "the router's Paid event shows the 1% fee the payment paid");

      // The approval went through but the second signature never came: the retry asks only for pay.
      const second = await (await prepare({ ...intent, amount: "2", expectedRecipientAddress: recipient.address })).json() as typeof prepared;
      assert.deepEqual(second.transactions.map((transaction) => transaction.purpose), ["approve", "pay"]);
      await publicClient.waitForTransactionReceipt({ hash: await senderWallet.sendTransaction({ to: second.transactions[0].to, data: second.transactions[0].data, value: 0n }) });
      const retried = await (await prepare({ ...intent, amount: "2", expectedRecipientAddress: recipient.address })).json() as typeof prepared;
      assert.deepEqual(retried.transactions.map((transaction) => transaction.purpose), ["pay"], "the approval is not asked for twice");
      const retryHash = await senderWallet.sendTransaction({ to: retried.transactions[0].to, data: retried.transactions[0].data, value: 0n });
      assert.equal((await publicClient.waitForTransactionReceipt({ hash: retryHash })).status, "success");
      assert.equal(await balance(recipient.address), parseUnits("6", 6), "the retried payment delivers exactly its amount");
      const again = await (await prepare({ ...intent, amount: "2", expectedRecipientAddress: recipient.address })).json() as typeof prepared;
      assert.deepEqual(again.transactions.map((transaction) => transaction.purpose), ["approve", "pay"], "a used approval is asked for again");

      // A plain transfer to the same person carries the same Transfer log and is recorded, but it paid no fee.
      const plainHash = await senderWallet.writeContract({ address: usdc, abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [recipient.address, parseUnits("1", 6)] });
      await publicClient.waitForTransactionReceipt({ hash: plainHash });
      const plain = await fetch(`${origin}/api/payments/confirm`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ transactionHash: plainHash, amount: "1", recipient: intent.recipient }) });
      assert.equal(plain.status, 201);
      const plainRecord = (await paymentRecords.list(chain.id, sender.address)).find((entry) => entry.transactionHash === plainHash);
      assert.ok(plainRecord);
      assert.equal(plainRecord.feeUnits, undefined, "no Paid event, no fee: it earns an inviter nothing");
    } finally {
      await close(server);
    }
  });

  it("pays several people with one approval and a note on chain, and keeps each note with its verified payment", async () => {
    const operator = mnemonicToAccount(mnemonic, { addressIndex: 10 });
    const attestor = mnemonicToAccount(mnemonic, { addressIndex: 11 });
    const sender = mnemonicToAccount(mnemonic, { addressIndex: 12 });
    const people = [13, 14, 15].map((addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }));
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const operatorWallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
    const senderWallet = createWalletClient({ account: sender, chain, transport: http(rpcUrl) });
    const deploy = async (abi: readonly unknown[], bytecode: Hex, args: readonly unknown[] = []) =>
      (await publicClient.waitForTransactionReceipt({ hash: await operatorWallet.deployContract({ abi: abi as Abi, bytecode, args }) })).contractAddress!;
    const token = await compileMockUsdc();
    const usdc = getAddress(await deploy(token.abi, token.bytecode));
    const forwarder = await deploy(feeForwarderAbi, FEE_FORWARDER_ARTIFACT.bytecode, [operator.address]);
    const router = await deploy(payRouterAbi, PAY_ROUTER_ARTIFACT.bytecode, [forwarder, operator.address]);
    const escrow = await deploy(stockClaimEscrowAbi, STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, [attestor.address, router]);
    await publicClient.waitForTransactionReceipt({ hash: await operatorWallet.writeContract({ address: usdc, abi: tokenAbi, functionName: "mint", args: [sender.address, parseUnits("20", 6)] }) });
    const reader = { getBytecode: ({ address }: { address: Address }) => publicClient.getBytecode({ address }), readContract: (call: never) => publicClient.readContract(call) };
    const { fees } = await verifyClaimEscrowContract({ escrow, claimVerifier: attestor.address, operator: operator.address, chainName: chain.name }, reader as never);
    const identities = new VerifiedIdentityService();
    people.forEach((person, index) => identities.link(person.address, { platform: "x", providerUserId: `x-batch-${index}`, username: `p${index}`, verifiedAt: new Date().toISOString() }));
    const payments = new PaymentHistoryService({ chainId: chain.id, usdc, repository: new MemoryPaymentRepository(), client: publicClient });
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "routed-batch-lifecycle-secret-32-chars" }),
      identities,
      payments,
      arcFees: {
        schedule: fees,
        quote: (payer: Address, units: bigint) => quoteFee(reader as never, fees, payer, units, chain.name),
        usdcBalance: async (owner: Address) => await publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [owner] }),
        approvalCovers: (owner: Address, total: bigint) => approvalCovers(reader as never, usdc, owner, getAddress(router), total),
      },
      network: { ready: true, environment: "testnet", chainName: "Arc Testnet", chainId: chain.id, chainIdHex: `0x${chain.id.toString(16)}`, rpcUrl, usdcAddress: usdc },
    });
    const server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const balance = (owner: Address) => publicClient.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
    try {
      const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address }) }).then((response) => response.json()) as { id: string; message: string };
      const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature: await sender.signMessage({ message: challenge.message }) }) });
      const cookie = login.headers.get("set-cookie") ?? "";
      const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

      // The chat reads the request into a reviewed batch: 10 USDC split three ways, with the note.
      const chat = await (await post("/api/chat", { message: "Split 10 USDC between @p0, @p1 and @p2 on X note: thanks for dinner 🍕" })).json() as {
        status: string; batch: { note: string; payments: Array<{ recipient: { platform: string; username: string }; resolvedAddress: Address; amount: string }> };
      };
      assert.equal(chat.status, "batch_review");
      assert.deepEqual(chat.batch.payments.map(({ amount }) => amount), ["3.333334", "3.333333", "3.333333"]);
      const recipients = chat.batch.payments.map(({ recipient, resolvedAddress, amount }) => ({ ...recipient, amount, expectedRecipientAddress: resolvedAddress }));

      const refused = await post("/api/payment/prepare-batch", { recipients: [...recipients, recipients[0]], note: chat.batch.note });
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { error: "@p0 on X is in this request twice. Review it again." });
      const hidden = await post("/api/payment/prepare-batch", { recipients, note: "rent\u202Edue" });
      assert.deepEqual(await hidden.json(), { error: "A note cannot contain hidden or control characters." });

      const response = await post("/api/payment/prepare-batch", { recipients, note: chat.batch.note });
      assert.equal(response.status, 200);
      const prepared = await response.json() as PreparedBatch & { networkId: "arc-testnet" };
      assert.equal(prepared.note, "thanks for dinner 🍕");
      assert.equal(prepared.totalUnits, "10099999", "the amounts and each payment's 1% fee, rounded down per payment as the router does");
      assert.ok(prepared.approval, "one approval for everything");
      assert.equal(matchesRoutedBatch(prepared, {
        token: usdc,
        router,
        wallet: sender.address,
        note: chat.batch.note,
        payments: recipients.map(({ expectedRecipientAddress, amount }) => ({ recipient: expectedRecipientAddress, units: parseUnits(amount, 6).toString() })),
      }), true, "the browser's own check accepts exactly what the server prepared");

      await publicClient.waitForTransactionReceipt({ hash: await senderWallet.sendTransaction({ to: prepared.approval!.to, data: prepared.approval!.data, value: 0n }) });
      const hashes: Hex[] = [];
      for (const payment of prepared.payments) {
        const hash = await senderWallet.sendTransaction({ to: payment.transaction.to, data: payment.transaction.data, value: 0n });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, "success", "the router ignores the note after its arguments");
        assert.equal(readPaymentNote((await publicClient.getTransaction({ hash })).input), "thanks for dinner 🍕", "the note is on chain");
        hashes.push(hash);
        const confirmed = await post("/api/payments/confirm", { transactionHash: hash, amount: payment.amount, recipient: { platform: payment.recipient.platform, username: payment.recipient.username } });
        assert.equal(confirmed.status, 201);
        assert.equal((await confirmed.json() as { note?: string }).note, "thanks for dinner 🍕", "the note is kept with the verified payment");
      }
      assert.deepEqual(await Promise.all(people.map((person) => balance(person.address))), [3_333_334n, 3_333_333n, 3_333_333n]);
      assert.equal(await balance(sender.address), parseUnits("20", 6) - 10_099_999n);
      const history = await (await fetch(`${origin}/api/payments`, { headers: { Cookie: cookie } })).json() as { payments: Array<{ transactionHash: string; note?: string }> };
      assert.deepEqual(history.payments.map(({ note }) => note), ["thanks for dinner 🍕", "thanks for dinner 🍕", "thanks for dinner 🍕"]);

      // One person, with a note: the single route writes it after `pay` too, and a plain payment carries none.
      const single = await (await post("/api/payment/prepare", { kind: "send", amount: "1", token: "USDC", status: "draft", recipient: { platform: "x", username: "p0" }, expectedRecipientAddress: people[0].address, note: "  happy   birthday " })).json() as { note: string; fee: { totalUnits: string }; paymentRef: Hex; transactions: Array<{ to: Address; data: Hex }> };
      assert.equal(single.note, "happy birthday");
      assert.equal(matchesArcPayment({ ...single, networkId: "arc-testnet", chainId: chain.id } as never, { network: "arc-testnet", recipient: people[0].address, amount: "1", wallet: sender.address, note: "happy birthday" }), false, "the bundled Arc Testnet is not this simulated chain");
      let singleHash: Hex = "0x";
      for (const transaction of single.transactions) {
        singleHash = await senderWallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
        await publicClient.waitForTransactionReceipt({ hash: singleHash });
      }
      const singleConfirmed = await (await post("/api/payments/confirm", { transactionHash: singleHash, amount: "1", recipient: { platform: "x", username: "p0" } })).json() as { note?: string };
      assert.equal(singleConfirmed.note, "happy birthday");
      const plain = await (await post("/api/payment/prepare", { kind: "send", amount: "1", token: "USDC", status: "draft", recipient: { platform: "x", username: "p1" }, expectedRecipientAddress: people[1].address })).json() as { transactions: Array<{ to: Address; data: Hex }> };
      let plainHash: Hex = "0x";
      for (const transaction of plain.transactions) {
        plainHash = await senderWallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
        await publicClient.waitForTransactionReceipt({ hash: plainHash });
      }
      assert.equal("note" in await (await post("/api/payments/confirm", { transactionHash: plainHash, amount: "1", recipient: { platform: "x", username: "p1" } })).json(), false);
      const short = await post("/api/payment/prepare-batch", { recipients: recipients.map((recipient) => ({ ...recipient, amount: "5" })) });
      assert.equal(short.status, 400);
      assert.match((await short.json() as { error: string }).error, /^Your wallet needs 15\.15 USDC, the amounts plus the 1% fee\.$/);
    } finally {
      await close(server);
    }
  });
});

async function compileMockUsdc() {
  const source = await readFile(new URL("./fixtures/MockUSDC.sol", import.meta.url), "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "MockUSDC.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
  assert.deepEqual(errors, []);
  const artifact = output.contracts["MockUSDC.sol"].MockUSDC;
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` as Hex };
}

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing direct payment test port."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function listen(app: ReturnType<typeof createApp>) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForRpc(rpcUrl: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Anvil RPC did not start.");
}
