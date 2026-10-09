import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import solc from "solc";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readStockClaimConfig, robinhoodChainClient } from "../server/robinhood-network";
import { MemoryStockClaimRepository, StockClaimService } from "../server/stock-claim-service";
import { MemoryStockTransferRepository, StockTransferService } from "../server/stock-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { ROBINHOOD_USDG } from "../src/domain/robinhood-assets";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact";
import { BURN_VAULT_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts";
import { burnVaultAbi, payRouterAbi } from "../src/domain/fees";
import {
  matchesStockClaimAction,
  matchesStockClaimFunding,
  stockClaimEscrowAbi,
  type PreparedStockClaimAction,
  type PreparedStockClaimFunding,
  type StockClaimDetails,
  type StockEscrowDeployment,
} from "../src/domain/stock-claims";
import type { PendingVaultLink } from "../src/domain/pending-claims";
import { matchesStockBatch, matchesStockReview, type PreparedStockBatch, type PreparedStockTransfer } from "../src/domain/stock-tokens";
import { resolveFoundryBinary } from "../scripts/foundry-binary";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain simulation",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const NVDA = STOCK_TOKEN_ALLOWLISTS["robinhood-mainnet"].tokens.find((token) => token.symbol === "NVDA")!;
const usdgAbi = parseAbi([
  "function mint(address recipient, uint256 amount)",
  "function setPaused(bool value)",
  "function setFrozen(address account, bool value)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const stockAbi = parseAbi(["function mint(address recipient, uint256 amount)", "function balanceOf(address owner) view returns (uint256)"]);

describe("Robinhood Chain mainnet assets on a real EVM", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;

  before(async () => {
    const port = await unusedPort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(resolveFoundryBinary("anvil"), ["--silent", "--port", String(port), "--chain-id", String(chain.id), "--mnemonic", mnemonic], { stdio: "ignore" });
    await waitForRpc(rpcUrl);
  });

  after(async () => {
    if (!anvil.killed) anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
  });

  it("moves USDG without the Stock Token statement, keeps NVDA behind it, and vaults both for a Farcaster account", async () => {
    const operator = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const payer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const selin = mnemonicToAccount(mnemonic, { addressIndex: 3 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
    const wallet = (account: typeof operator) => createWalletClient({ account, chain, transport: http(rpcUrl) });
    const mined = async (hash: Hex) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    const placeAt = async (address: Address, fixture: { abi: Abi; bytecode: Hex }) => {
      const deployed = (await mined(await wallet(operator).deployContract({ abi: fixture.abi, bytecode: fixture.bytecode }))).contractAddress!;
      await testClient.setCode({ address, bytecode: (await publicClient.getCode({ address: deployed }))! });
    };

    // Stand-ins run at the real allowlisted mainnet addresses: a Paxos-style USDG and an NVDA Stock Token.
    await placeAt(ROBINHOOD_USDG.address, await compile("MockPaxosToken.sol", "MockPaxosToken"));
    await placeAt(NVDA.address, await compile("MockStockToken.sol", "MockStockToken", (source) => source.replace('"Tesla"', '"NVIDIA"').replace('"TSLA"', '"NVDA"')));
    const usdg = async (functionName: "mint" | "setPaused" | "setFrozen", args: readonly unknown[]) => {
      await mined(await wallet(operator).writeContract({ address: ROBINHOOD_USDG.address, abi: usdgAbi, functionName, args } as never));
    };
    const usdgBalance = (owner: Address) => publicClient.readContract({ address: ROBINHOOD_USDG.address, abi: usdgAbi, functionName: "balanceOf", args: [owner] });
    await usdg("mint", [payer.address, parseUnits("1000", 6)]);
    await mined(await wallet(operator).writeContract({ address: NVDA.address, abi: stockAbi, functionName: "mint", args: [payer.address, parseUnits("5", 18)] }));

    let clock = Number((await publicClient.getBlock()).timestamp) * 1000;
    const identities = new VerifiedIdentityService();
    identities.link(payer.address, { platform: "github", providerUserId: "gh-payer-1", username: "ayse-dev", verifiedAt: new Date().toISOString() });
    identities.link(selin.address, { platform: "x", providerUserId: "x-selin-1", username: "selin", verifiedAt: new Date().toISOString() });
    const stockTransfers = new StockTransferService({
      networks: { "robinhood-mainnet": { enabled: true, tokens: { enabled: true }, client: robinhoodChainClient(rpcUrl) } },
      repository: new MemoryStockTransferRepository(),
      now: () => clock,
      receiptRetry: { attempts: 2, delayMs: 50 },
    });
    const stockClaims = new StockClaimService({
      transfers: stockTransfers,
      repository: new MemoryStockClaimRepository(),
      directory: {
        async lookup(platform, username) {
          if (platform === "farcaster" && username === "dwr") return { platform: "farcaster", providerUserId: "3", username: "dwr" };
          throw new Error("Farcaster account was not found.");
        },
        supports: () => true,
      },
      config: readStockClaimConfig({ ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: generatePrivateKey(), CONTRACT_OWNER_ADDRESS: operator.address }),
      now: () => clock,
      cacheMs: 0,
    });
    const server = await listen(createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "robinhood-mainnet-assets-secret-32" }),
      identities,
      stockTransfers,
      stockClaims,
    }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const operatorSession = await signIn(origin, operator);
      const payerSession = await signIn(origin, payer);
      const recipientSession = await signIn(origin, recipient);
      const error = async (response: Response) => (await response.json() as { error: string }).error;

      // 1. The mainnet board leads with USDG and reports both switches.
      const board = await (await fetch(`${origin}/api/stocks?network=robinhood-mainnet`)).json() as { tokens: Array<{ symbol: string; kind: string; decimals?: number }>; transfers: unknown };
      assert.deepEqual(board.tokens[0], { symbol: "USDG", name: "Global Dollar", kind: "cash", address: ROBINHOOD_USDG.address, decimals: 6 });
      assert.deepEqual(board.transfers, { enabled: true, tokens: { enabled: true } });

      // 2. A direct USDG transfer needs no Stock Token statement and moves six-decimal units.
      const draft = await (await post(origin, payerSession, "/api/chat", { message: "Send 25.5 USDG to @selin on X", networkPreference: "robinhood-mainnet" })).json() as {
        status: string; units: string; resolvedAddress: Address; transferEnabled: boolean;
        stockIntent: { asset: { symbol: string; address: Address; kind: string; decimals: number }; amount: string; recipient: { platform: "x"; username: string } };
      };
      assert.equal(draft.status, "stock_review");
      assert.equal(draft.units, "25500000");
      assert.equal(draft.transferEnabled, true);
      assert.equal(draft.stockIntent.asset.kind, "cash");
      const transfer = { network: "robinhood-mainnet", token: { symbol: "USDG", address: ROBINHOOD_USDG.address }, amount: "25.5", recipient: draft.stockIntent.recipient };
      const prepareTransfer = (body: Record<string, unknown> = {}) => post(origin, payerSession, "/api/stocks/transfers/prepare", { ...transfer, expectedRecipientAddress: draft.resolvedAddress, ...body });
      const preparedResponse = await prepareTransfer();
      assert.equal(preparedResponse.status, 200);
      const prepared = await preparedResponse.json() as PreparedStockTransfer;
      assert.deepEqual(prepared.token, { symbol: "USDG", name: "Global Dollar", address: ROBINHOOD_USDG.address, decimals: 6 });
      assert.equal(prepared.balance, "1000");
      assert.equal(matchesStockReview(prepared, { network: "robinhood-mainnet", token: ROBINHOOD_USDG.address, sender: payer.address, recipient: draft.resolvedAddress, units: draft.units }), true);
      // No fee router is registered yet, so this payment is one plain transfer.
      assert.equal(prepared.fee, undefined);
      // The review showed no fee, so it agrees; a review that showed a router's fee does not (audit, 2026-10-06).
      assert.equal(matchesStockReview(prepared, { network: "robinhood-mainnet", token: ROBINHOOD_USDG.address, sender: payer.address, recipient: draft.resolvedAddress, units: draft.units, router: null }), true);
      assert.equal(matchesStockReview(prepared, { network: "robinhood-mainnet", token: ROBINHOOD_USDG.address, sender: payer.address, recipient: draft.resolvedAddress, units: draft.units, router: "0x5555555555555555555555555555555555555555" }), false);
      const sent = await wallet(payer).sendTransaction({ to: prepared.transaction!.to, data: prepared.transaction!.data });
      await mined(sent);
      const confirmed = await post(origin, payerSession, "/api/stocks/transfers/confirm", { ...transfer, transactionHash: sent });
      assert.equal(confirmed.status, 201);
      assert.equal(await usdgBalance(selin.address), 25_500_000n);
      const history = await (await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: payerSession } })).json() as { transfers: Array<{ amount: string; asset: { symbol: string } }> };
      assert.deepEqual(history.transfers.map((entry) => [entry.asset.symbol, entry.amount]), [["USDG", "25.5"]]);

      // Paxos issuer controls and short balances are explained before any wallet opens.
      await usdg("setFrozen", [payer.address, true]);
      assert.equal(await error(await prepareTransfer()), "The issuer has frozen USDG for this wallet or for the recipient.");
      await usdg("setFrozen", [payer.address, false]);
      await usdg("setPaused", [true]);
      assert.match(await error(await prepareTransfer()), /USDG transfers are paused by the issuer/);
      await usdg("setPaused", [false]);
      assert.equal(await error(await prepareTransfer({ amount: "5000" })), "Your wallet holds less than 5000 USDG this transfer needs.");
      assert.match(await error(await prepareTransfer({ amount: "1.1234567" })), /at most 6 decimals/);

      // NVDA is a Stock Token: a mainnet transfer still needs the sender's statement.
      const nvda = { network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address }, amount: "1", recipient: draft.stockIntent.recipient, expectedRecipientAddress: draft.resolvedAddress };
      assert.match(await error(await post(origin, payerSession, "/api/stocks/transfers/prepare", nvda)), /before a mainnet transfer/);
      assert.equal((await post(origin, payerSession, "/api/stocks/transfers/prepare", { ...nvda, eligibilityConfirmed: true })).status, 200);

      // 3. The operator deploys the mainnet vault with its dedicated attestor.
      const status = await (await fetch(`${origin}/api/stocks/escrow`)).json() as { networks: StockEscrowDeployment[] };
      const mainnet = status.networks.find((entry) => entry.network === "robinhood-mainnet")!;
      assert.deepEqual(mainnet.setup, []);
      assert.equal(mainnet.stockTransfersEnabled, true);
      assert.equal(mainnet.tokenTransfersEnabled, true);
      const burnVault = getAddress((await mined(await wallet(operator).deployContract({ abi: burnVaultAbi, bytecode: BURN_VAULT_ARTIFACT.bytecode }))).contractAddress!);
      const router = getAddress((await mined(await wallet(operator).deployContract({ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT.bytecode, args: [burnVault, operator.address] }))).contractAddress!);
      const deployment = await wallet(operator).deployContract({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [mainnet.verifier!, router] });
      const escrow = getAddress((await mined(deployment)).contractAddress!);
      assert.equal((await post(origin, operatorSession, "/api/stocks/escrow/register", { network: "robinhood-mainnet", transactionHash: deployment })).status, 201);

      // 4. USDG for a Farcaster account that has not joined: no statement, and any sender may keep it for a week.
      const vaultDraft = await (await post(origin, payerSession, "/api/chat", { message: "Send 10 USDG to @dwr on Farcaster", networkPreference: "robinhood-mainnet" })).json() as {
        status: string; escrow: Address; units: string; expiryHours: number;
        stockIntent: { recipient: { platform: "farcaster"; username: string } };
      };
      assert.equal(vaultDraft.status, "stock_claim_review");
      assert.equal(vaultDraft.escrow, escrow);
      assert.equal(vaultDraft.units, "10000000");
      assert.equal(vaultDraft.expiryHours, 72, "a new link starts at three days");
      const link = { network: "robinhood-mainnet", token: { symbol: "USDG", address: ROBINHOOD_USDG.address }, amount: "10", recipient: vaultDraft.stockIntent.recipient, expiryHours: 168 };
      assert.equal((await post(origin, payerSession, "/api/stocks/claims/prepare", { ...link, expiryHours: 721 })).status, 400, "30 days is the longest window");
      const fundingResponse = await post(origin, payerSession, "/api/stocks/claims/prepare", link);
      assert.equal(fundingResponse.status, 200);
      const funding = await fundingResponse.json() as PreparedStockClaimFunding;
      assert.equal(BigInt(funding.expiry), BigInt(Math.floor(clock / 1000) + 168 * 3600), "a seven-day window without holding any token");
      assert.equal(matchesStockClaimFunding(funding, {
        network: "robinhood-mainnet", token: ROBINHOOD_USDG.address, payer: payer.address, units: vaultDraft.units, escrow, platform: "farcaster", nowSeconds: clock / 1000,
      }), true);
      let fundingHash: Hex | undefined;
      for (const transaction of funding.transactions) {
        fundingHash = await wallet(payer).sendTransaction({ to: transaction.to, data: transaction.data });
        await mined(fundingHash);
      }
      const recorded = await post(origin, payerSession, "/api/stocks/claims/confirm-funding", { ...link, escrow, paymentId: funding.paymentId, transactionHash: fundingHash });
      assert.equal(recorded.status, 201);
      assert.deepEqual((await recorded.json() as { recipient: unknown }).recipient, { platform: "farcaster", username: "dwr" });
      const detailsPath = `/api/stocks/claims/robinhood-mainnet/${funding.paymentId}`;
      const details = await (await fetch(`${origin}${detailsPath}`)).json() as StockClaimDetails;
      assert.deepEqual([details.status, details.amount, details.token.kind, details.token.decimals], ["claimable", "10", "cash", 6]);

      // The payer sees the link waiting; the recipient sees nothing until a Farcaster account is linked.
      const pendingOf = async (session: string) => {
        const response = await fetch(`${origin}/api/claims/pending`, { headers: { Cookie: session } });
        assert.equal(response.status, 200);
        const links = await response.json() as { incoming: PendingVaultLink[]; outgoing: PendingVaultLink[]; unavailable: string[] };
        assert.deepEqual(links.unavailable, []);
        const brief = (entry: PendingVaultLink) => [entry.paymentId, entry.status, entry.token.symbol, entry.amount, entry.statementRequired ?? false];
        return { incoming: links.incoming.map(brief), outgoing: links.outgoing.map(brief) };
      };
      assert.deepEqual(await pendingOf(payerSession), { incoming: [], outgoing: [[funding.paymentId, "waiting", "USDG", "10", false]] });
      assert.deepEqual(await pendingOf(recipientSession), { incoming: [], outgoing: [] });

      // The claim is locked to FID 3: only a wallet whose verified Farcaster account is FID 3 gets an authorization.
      assert.match(await error(await post(origin, recipientSession, `${detailsPath}/prepare-claim`, {})), /None of your verified accounts/);
      identities.link(recipient.address, { platform: "farcaster", providerUserId: "3", username: "dwr", verifiedAt: new Date().toISOString() });
      // As soon as the account is linked, the link waits under the recipient's pending claims.
      assert.deepEqual(await pendingOf(recipientSession), { incoming: [[funding.paymentId, "claimable", "USDG", "10", false]], outgoing: [] });
      await usdg("setFrozen", [recipient.address, true]);
      assert.match(await error(await post(origin, recipientSession, `${detailsPath}/prepare-claim`, {})), /issuer has frozen USDG for your wallet or for the claim escrow/);
      await usdg("setFrozen", [recipient.address, false]);
      const claimResponse = await post(origin, recipientSession, `${detailsPath}/prepare-claim`, {});
      assert.equal(claimResponse.status, 200, "a USDG claim needs no Stock Token statement");
      const claim = await claimResponse.json() as PreparedStockClaimAction;
      assert.equal(matchesStockClaimAction(claim, { network: "robinhood-mainnet", escrow, wallet: recipient.address, paymentId: funding.paymentId, action: "claim" }), true);
      const operatorBefore = await usdgBalance(operator.address);
      await mined(await wallet(recipient).sendTransaction({ to: claim.transaction.to, data: claim.transaction.data }));
      assert.equal(await usdgBalance(recipient.address), 10_000_000n, "the recipient receives exactly 10 USDG");
      assert.equal(await usdgBalance(escrow), 0n);
      assert.equal(await usdgBalance(burnVault), 50_000n, "0.05 USDG, half of the 1% fee, waits in the burn vault");
      assert.equal(await usdgBalance(operator.address) - operatorBefore, 50_000n, "the other half reaches the operator's treasury");
      assert.deepEqual(await pendingOf(recipientSession), { incoming: [], outgoing: [] }, "a claimed link leaves both lists");
      assert.deepEqual(await pendingOf(payerSession), { incoming: [], outgoing: [] });

      // 5. An NVDA vault link keeps the Stock Token statement on both sides.
      const stockLink = { network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address }, amount: "1", recipient: vaultDraft.stockIntent.recipient, expiryHours: 72 };
      assert.match(await error(await post(origin, payerSession, "/api/stocks/claims/prepare", stockLink)), /before a mainnet claim link/);
      const stockFunding = await (await post(origin, payerSession, "/api/stocks/claims/prepare", { ...stockLink, eligibilityConfirmed: true })).json() as PreparedStockClaimFunding;
      let stockHash: Hex | undefined;
      for (const transaction of stockFunding.transactions) {
        stockHash = await wallet(payer).sendTransaction({ to: transaction.to, data: transaction.data });
        await mined(stockHash);
      }
      assert.equal((await post(origin, payerSession, "/api/stocks/claims/confirm-funding", { ...stockLink, escrow, paymentId: stockFunding.paymentId, transactionHash: stockHash })).status, 201);
      const stockPath = `/api/stocks/claims/robinhood-mainnet/${stockFunding.paymentId}`;
      assert.deepEqual(await pendingOf(recipientSession), { incoming: [[stockFunding.paymentId, "claimable", "NVDA", "1", true]], outgoing: [] }, "a Stock Token claim asks for the statement");
      assert.match(await error(await post(origin, recipientSession, `${stockPath}/prepare-claim`, {})), /before claiming on mainnet/);
      const stockClaim = await (await post(origin, recipientSession, `${stockPath}/prepare-claim`, { eligibilityConfirmed: true })).json() as PreparedStockClaimAction;
      await mined(await wallet(recipient).sendTransaction({ to: stockClaim.transaction.to, data: stockClaim.transaction.data }));
      assert.equal(await publicClient.readContract({ address: NVDA.address, abi: stockAbi, functionName: "balanceOf", args: [recipient.address] }), parseUnits("1", 18));
      clock = Number((await publicClient.getBlock()).timestamp) * 1000;

      // 6. One NVDA each to two people with a note: one approval of everything, then one `pay` each, the note on chain.
      const omer = mnemonicToAccount(mnemonic, { addressIndex: 4 });
      identities.link(omer.address, { platform: "x", providerUserId: "x-omer-1", username: "omer", verifiedAt: new Date().toISOString() });
      const batchDraft = await (await post(origin, payerSession, "/api/chat", { message: "@selin ve @omer'e x'te 1'er NVDA gönder not: tebrikler 🎉", networkPreference: "robinhood-mainnet" })).json() as {
        status: string; transferEnabled: boolean;
        batch: { mode: string; note: string; payments: Array<{ recipient: { platform: "x"; username: string }; resolvedAddress: Address; amount: string; units: string }> };
      };
      assert.equal(batchDraft.status, "batch_review");
      assert.equal(batchDraft.transferEnabled, true);
      assert.deepEqual([batchDraft.batch.mode, batchDraft.batch.note], ["each", "tebrikler 🎉"]);
      const batchBody = {
        network: "robinhood-mainnet",
        token: { symbol: "NVDA", address: NVDA.address },
        recipients: batchDraft.batch.payments.map(({ recipient: person, amount, resolvedAddress }) => ({ ...person, amount, expectedRecipientAddress: resolvedAddress })),
        note: batchDraft.batch.note,
      };
      assert.match(await error(await post(origin, payerSession, "/api/stocks/transfers/prepare-batch", batchBody)), /before a mainnet transfer/, "a Stock Token batch keeps the statement");
      const batchResponse = await post(origin, payerSession, "/api/stocks/transfers/prepare-batch", { ...batchBody, eligibilityConfirmed: true });
      assert.equal(batchResponse.status, 200);
      const batch = await batchResponse.json() as PreparedStockBatch;
      assert.equal(matchesStockBatch(batch, {
        network: "robinhood-mainnet",
        token: NVDA.address,
        router,
        sender: payer.address,
        note: "tebrikler 🎉",
        payments: batchDraft.batch.payments.map(({ resolvedAddress, units }) => ({ recipient: resolvedAddress, units })),
      }), true);
      assert.equal(batch.totalUnits, (parseUnits("2", 18) + parseUnits("0.02", 18)).toString());
      if (batch.approval) await mined(await wallet(payer).sendTransaction({ to: batch.approval.to, data: batch.approval.data }));
      for (const payment of batch.payments) {
        const hash = await wallet(payer).sendTransaction({ to: payment.transaction.to, data: payment.transaction.data });
        await mined(hash);
        const recordedTransfer = await post(origin, payerSession, "/api/stocks/transfers/confirm", {
          network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address }, amount: payment.amount, recipient: { platform: payment.recipient.platform, username: payment.recipient.username }, transactionHash: hash,
        });
        assert.equal(recordedTransfer.status, 201);
        assert.equal((await recordedTransfer.json() as { note?: string }).note, "tebrikler 🎉");
      }
      for (const person of [selin, omer]) {
        assert.equal(await publicClient.readContract({ address: NVDA.address, abi: stockAbi, functionName: "balanceOf", args: [person.address] }), parseUnits("1", 18));
      }
      const notes = await (await fetch(`${origin}/api/stocks/transfers`, { headers: { Cookie: payerSession } })).json() as { transfers: Array<{ asset: { symbol: string }; note?: string }> };
      assert.deepEqual(notes.transfers.filter(({ asset }) => asset.symbol === "NVDA").map(({ note }) => note), ["tebrikler 🎉", "tebrikler 🎉"]);
      // Each transfer alone fits the 1.97 NVDA left, all of them with their fees do not: named before any wallet opens.
      assert.equal(await error(await post(origin, payerSession, "/api/stocks/transfers/prepare-batch", { ...batchBody, eligibilityConfirmed: true })), "Your wallet holds 1.97 NVDA; these payments need 2.02 NVDA, the amounts plus the 1% fee.");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
    }
  });
});

async function signIn(origin: string, account: ReturnType<typeof mnemonicToAccount>) {
  const challenge = await (await fetch(`${origin}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  })).json() as { id: string; message: string };
  const login = await fetch(`${origin}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }),
  });
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function post(origin: string, cookie: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function compile(file: string, contract: string, edit: (source: string) => string = (source) => source) {
  const source = edit(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  assert.deepEqual(output.errors?.filter((entry) => entry.severity === "error") ?? [], []);
  const artifact = output.contracts[file][contract];
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` as Hex };
}

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing mainnet asset test port."));
      server.close((failure) => failure ? reject(failure) : resolve(address.port));
    });
  });
}

async function listen(app: ReturnType<typeof createApp>) {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
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
