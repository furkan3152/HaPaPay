import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import solc from "solc";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ClaimablePaymentService } from "../server/claimable-payment-service";
import { ClaimRedemptionService } from "../server/claim-redemption-service";
import { ClaimFundingService, MemoryClaimFundingRepository } from "../server/claim-funding-service";
import { RecipientLookupUnavailableError } from "../server/recipient-discovery";
import { VaultNameLockOffer } from "../server/vault-recipient";
import { IdentityRegistryLinkService } from "./fixtures/identity-registry-calls";
import { verifyClaimEscrowContract } from "../server/readiness";
import { resolveFoundryBinary } from "../scripts/foundry-binary";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../src/domain/arc-identity-registry-artifact";
import { arcIdentityRegistryAbi } from "../src/domain/arc-identity-registry";
import { FEE_FORWARDER_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts";
import { feeForwarderAbi, payRouterAbi } from "../src/domain/fees";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 5_042_002,
  name: "Arc Testnet lifecycle simulation",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const tokenAbi = parseAbi([
  "function mint(address recipient, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const registryReadAbi = parseAbi([
  "function nonces(address wallet) view returns (uint256)",
  "function resolveProviderIdentity(bytes32 platformHash, bytes32 providerUserIdHash) view returns (address)",
  "function resolveHandle(bytes32 platformHash, bytes32 usernameHash) view returns (address)",
]);
const zeroAddress = "0x0000000000000000000000000000000000000000" as const;

describe("Arc social identity and claimable payment lifecycles on a real EVM", () => {
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

  it("funds an Arc USDC link with the 1% fee, OAuth-claims it exactly once, refunds a second with its fee, and sends the whole fee to the operator", async () => {
    const verifier = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const payer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const operator = mnemonicToAccount(mnemonic, { addressIndex: 5 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
    const operatorWallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
    const payerWallet = createWalletClient({ account: payer, chain, transport: http(rpcUrl) });
    const recipientWallet = createWalletClient({ account: recipient, chain, transport: http(rpcUrl) });
    const artifacts = await compileLifecycleContracts();
    const deploy = async (abi: readonly unknown[], bytecode: Hex, args: readonly unknown[] = []) =>
      (await publicClient.waitForTransactionReceipt({ hash: await operatorWallet.deployContract({ abi: abi as Abi, bytecode, args }) })).contractAddress!;

    // What the operator page deploys on Arc: the fee forwarder, the router behind it, then the escrow on that router.
    const token = await deploy(artifacts.token.abi, artifacts.token.bytecode);
    const forwarder = await deploy(feeForwarderAbi, FEE_FORWARDER_ARTIFACT.bytecode, [operator.address]);
    const router = await deploy(payRouterAbi, PAY_ROUTER_ARTIFACT.bytecode, [forwarder, operator.address]);
    const escrow = await deploy(stockClaimEscrowAbi, STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, [verifier.address, router]);
    await confirmed(publicClient, operatorWallet.writeContract({ address: token, abi: tokenAbi, functionName: "mint", args: [payer.address, parseUnits("100", 6)] }));

    // The server's startup checks accept exactly this deployment and report the forwarder schedule.
    const reader = { getBytecode: ({ address }: { address: Address }) => publicClient.getBytecode({ address }), readContract: (call: never) => publicClient.readContract(call) };
    const { fees } = await verifyClaimEscrowContract({ escrow, claimVerifier: verifier.address, operator: operator.address, chainName: chain.name }, reader as never);
    assert.deepEqual(fees, { router: getAddress(router), burnVault: getAddress(forwarder), treasury: operator.address, feeBps: 100, burnShareBps: 5000, sink: "forwarder" });
    await assert.rejects(() => verifyClaimEscrowContract({ escrow, claimVerifier: verifier.address, operator: payer.address, chainName: chain.name }, reader as never), /owner does not match the configured operator/);

    const baseTimestamp = (await publicClient.getBlock()).timestamp;
    const paymentIds = [`0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`] as const;
    let paymentIndex = 0;
    const funding = new ClaimablePaymentService({
      usdc: token,
      escrow,
      fees,
      client: { readContract: (call: never) => publicClient.readContract(call) } as never,
      chainName: chain.name,
      directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "alice" }) },
      now: () => new Date(Number(baseTimestamp) * 1000),
      randomBytes32: () => paymentIds[paymentIndex++],
    });
    const balance = (owner: Address) => publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner] });

    // Funding records come from the exact PaymentCreated receipt, as POST /api/claims/confirm-funding records them.
    const records = new MemoryClaimFundingRepository();
    const fundings = new ClaimFundingService({
      chainId: chain.id,
      escrow,
      usdc: token,
      repository: records,
      directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "alice" }) },
      client: publicClient as never,
      now: () => new Date(Number(baseTimestamp) * 1000),
    });
    const alice = [{ platform: "github" as const, providerUserId: "424242", username: "alice", verifiedAt: new Date().toISOString() }];
    const pendingFor = async (wallet: Address, accounts: typeof alice, at: bigint) => {
      const links = await redemptionService(publicClient, escrow, token, verifier, at, records).pending({ wallet, accounts });
      return { incoming: links.incoming.map((link) => [link.paymentId, link.status, link.amount]), outgoing: links.outgoing.map((link) => [link.paymentId, link.status, link.amount]) };
    };

    const first = await funding.prepare({ platform: "github", username: "alice", amount: "12.5", expiryHours: 24, payer: payer.address });
    assert.equal(first.fee.totalAmount, "12.625");
    const firstHashes = await sendPrepared(publicClient, (transaction) => payerWallet.sendTransaction(transaction), first.transactions);
    assert.equal(await balance(escrow), parseUnits("12.625", 6), "the escrow holds the amount and the fee");
    await fundings.confirm({ transactionHash: firstHashes.at(-1)!, paymentId: first.paymentId, payer: payer.address, platform: "github", username: "alice", amount: "12.5" });
    // The link waits under the recipient's pending claims as soon as their GitHub account is linked, and under the
    // payer's sent links; another account that later took the handle "alice" sees nothing.
    assert.deepEqual(await pendingFor(recipient.address, alice, baseTimestamp + 1n), { incoming: [[first.paymentId, "claimable", "12.5"]], outgoing: [] });
    assert.deepEqual(await pendingFor(payer.address, [], baseTimestamp + 1n), { incoming: [], outgoing: [[first.paymentId, "waiting", "12.5"]] });
    assert.deepEqual(await pendingFor(recipient.address, [{ ...alice[0], providerUserId: "999" }], baseTimestamp + 1n), { incoming: [], outgoing: [] });
    const redemption = redemptionService(publicClient, escrow, token, verifier, baseTimestamp + 1n);
    const claim = await redemption.prepareClaim(recipient.address, alice, first.paymentId);
    await confirmed(publicClient, recipientWallet.sendTransaction({ to: claim.transaction.to, data: claim.transaction.data, value: 0n }));
    assert.deepEqual(await pendingFor(recipient.address, alice, baseTimestamp + 1n), { incoming: [], outgoing: [] }, "a claimed link leaves both lists");
    assert.deepEqual(await pendingFor(payer.address, [], baseTimestamp + 1n), { incoming: [], outgoing: [] });
    assert.equal(await balance(recipient.address), parseUnits("12.5", 6), "the recipient gets exactly the amount");
    assert.equal(await balance(forwarder), 62_500n);
    assert.equal(await balance(operator.address), 62_500n);
    await assert.rejects(() => recipientWallet.sendTransaction({ to: claim.transaction.to, data: claim.transaction.data, value: 0n }));

    // Anyone can forward the burn half; it can only reach the operator, who then holds the whole fee.
    await confirmed(publicClient, recipientWallet.writeContract({ address: forwarder, abi: feeForwarderAbi, functionName: "forward", args: [token] }));
    assert.equal(await balance(operator.address), 125_000n);
    assert.equal(await balance(forwarder), 0n);

    const second = await funding.prepare({ platform: "github", username: "alice", amount: "3", expiryHours: 24, payer: payer.address });
    const secondHashes = await sendPrepared(publicClient, (transaction) => payerWallet.sendTransaction(transaction), second.transactions);
    await fundings.confirm({ transactionHash: secondHashes.at(-1)!, paymentId: second.paymentId, payer: payer.address, platform: "github", username: "alice", amount: "3" });
    await testClient.increaseTime({ seconds: 86_410 });
    await testClient.mine({ blocks: 1 });
    // Once the window closes the recipient can no longer claim it, and the payer can take it back.
    assert.deepEqual(await pendingFor(recipient.address, alice, baseTimestamp + 86_411n), { incoming: [], outgoing: [] });
    assert.deepEqual(await pendingFor(payer.address, [], baseTimestamp + 86_411n), { incoming: [], outgoing: [[second.paymentId, "refundable", "3"]] });
    const refund = await redemptionService(publicClient, escrow, token, verifier, baseTimestamp + 86_411n).prepareRefund(payer.address, second.paymentId);
    await assert.rejects(() => recipientWallet.sendTransaction({ to: refund.transaction.to, data: refund.transaction.data, value: 0n }));
    await confirmed(publicClient, payerWallet.sendTransaction({ to: refund.transaction.to, data: refund.transaction.data, value: 0n }));
    assert.equal(await balance(payer.address), parseUnits("87.375", 6), "a refund returns the amount and its fee");
    assert.equal(await balance(escrow), 0n);
    assert.deepEqual(await pendingFor(payer.address, [], baseTimestamp + 86_411n), { incoming: [], outgoing: [] }, "a refunded link leaves the list");
  });

  it("lets an Arc link wait for a Discord or X name: whoever connects that platform with it afterwards claims, never a newer account", async () => {
    // Money sent to someone who has not joined can be claimed once they connect that platform.
    const verifier = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const operator = mnemonicToAccount(mnemonic, { addressIndex: 5 });
    const payer = mnemonicToAccount(mnemonic, { addressIndex: 6 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 7 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const operatorWallet = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
    const payerWallet = createWalletClient({ account: payer, chain, transport: http(rpcUrl) });
    const recipientWallet = createWalletClient({ account: recipient, chain, transport: http(rpcUrl) });
    const artifacts = await compileLifecycleContracts();
    const deploy = async (abi: readonly unknown[], bytecode: Hex, args: readonly unknown[] = []) =>
      (await publicClient.waitForTransactionReceipt({ hash: await operatorWallet.deployContract({ abi: abi as Abi, bytecode, args }) })).contractAddress!;
    const token = await deploy(artifacts.token.abi, artifacts.token.bytecode);
    const forwarder = await deploy(feeForwarderAbi, FEE_FORWARDER_ARTIFACT.bytecode, [operator.address]);
    const router = await deploy(payRouterAbi, PAY_ROUTER_ARTIFACT.bytecode, [forwarder, operator.address]);
    const escrow = await deploy(stockClaimEscrowAbi, STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, [verifier.address, router]);
    await confirmed(publicClient, operatorWallet.writeContract({ address: token, abi: tokenAbi, functionName: "mint", args: [payer.address, parseUnits("20", 6)] }));
    const reader = { getBytecode: ({ address }: { address: Address }) => publicClient.getBytecode({ address }), readContract: (call: never) => publicClient.readContract(call) };
    const { fees } = await verifyClaimEscrowContract({ escrow, claimVerifier: verifier.address, operator: operator.address, chainName: chain.name }, reader as never);
    const balance = (owner: Address) => publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner] });

    // Neither Discord nor a refusing X is ever asked: the link waits for the name.
    const asked: string[] = [];
    const directory = { lookup: async (platform: string, username: string): Promise<never> => { asked.push(`${platform}:${username}`); throw new RecipientLookupUnavailableError("X is not answering account lookups for HaPaPay right now."); } };
    const baseTimestamp = (await publicClient.getBlock()).timestamp;
    const madeAt = Number(baseTimestamp) * 1000;
    const funding = new ClaimablePaymentService({ usdc: token, escrow, fees, client: { readContract: (call: never) => publicClient.readContract(call) } as never, chainName: chain.name, directory, now: () => new Date(madeAt) });
    const records = new MemoryClaimFundingRepository();
    const fundings = new ClaimFundingService({ chainId: chain.id, escrow, usdc: token, repository: records, directory, client: publicClient as never, now: () => new Date(madeAt) });

    const link = await funding.prepare({ platform: "discord", username: "@New.Friend", amount: "4", expiryHours: 48, payer: payer.address });
    assert.deepEqual(link.identity, { platform: "discord", username: "new.friend", providerUserId: "name:new.friend", lock: "name" });
    const hashes = await sendPrepared(publicClient, (transaction) => payerWallet.sendTransaction(transaction), link.transactions);
    await fundings.confirm({ transactionHash: hashes.at(-1)!, paymentId: link.paymentId, payer: payer.address, platform: "discord", username: "new.friend", amount: "4", lock: "name" });
    // X refused the lookup: the sender is offered the name, and a link they agreed to lock to it is made.
    await assert.rejects(() => funding.prepare({ platform: "x", username: "jack", amount: "1", expiryHours: 48, payer: payer.address }), VaultNameLockOffer);
    const xLink = await funding.prepare({ platform: "x", username: "@Jack", amount: "1", expiryHours: 48, payer: payer.address, lock: "name" });
    assert.deepEqual(xLink.identity, { platform: "x", username: "jack", providerUserId: "name:jack", lock: "name" });
    const xHashes = await sendPrepared(publicClient, (transaction) => payerWallet.sendTransaction(transaction), xLink.transactions);
    await fundings.confirm({ transactionHash: xHashes.at(-1)!, paymentId: xLink.paymentId, payer: payer.address, platform: "x", username: "jack", amount: "1", lock: "name" });
    assert.deepEqual(asked, ["x:jack"], "only X was asked, once, before the sender agreed to the name");

    const redemption = redemptionService(publicClient, escrow, token, verifier, baseTimestamp + 60n, records);
    assert.equal((await redemption.details(link.paymentId)).lock, "name");
    const discordId = (at: number) => String((BigInt(at) - 1_420_070_400_000n) << 22n);
    const xId = (at: number) => String((BigInt(at) - 1_288_834_974_657n) << 22n);
    const after = new Date(madeAt + 30_000).toISOString();
    const holder = { platform: "discord" as const, providerUserId: discordId(madeAt - 200 * 86_400_000), username: "new.friend", verifiedAt: after };
    const newer = { ...holder, providerUserId: discordId(madeAt + 5_000) };
    const signedInBefore = { ...holder, verifiedAt: new Date(madeAt - 86_400_000).toISOString() };
    const jack = { platform: "x" as const, providerUserId: xId(madeAt - 900 * 86_400_000), username: "jack", verifiedAt: after };
    const incoming = async (accounts: Array<typeof holder | typeof jack>) => (await redemption.pending({ wallet: recipient.address, accounts })).incoming.map((pending) => [pending.paymentId, pending.recipient.platform, pending.amount]);
    assert.deepEqual(await incoming([holder]), [[link.paymentId, "discord", "4"]], "it waits under Claims once Discord is connected with the name");
    assert.deepEqual(await incoming([newer]), []);
    assert.deepEqual(await incoming([signedInBefore]), []);
    assert.deepEqual(await incoming([jack]), [[xLink.paymentId, "x", "1"]]);
    await assert.rejects(() => redemption.prepareClaim(recipient.address, [newer], link.paymentId), /^StockTransferRejectedError: This link waits for the Discord name @new\.friend\..*an account made after the link cannot claim it\.$/);
    await assert.rejects(() => redemption.prepareClaim(recipient.address, [signedInBefore], link.paymentId), /connect it again if it is connected already/);
    await assert.rejects(() => redemption.prepareClaim(recipient.address, [jack], link.paymentId), /waits for the Discord name/);
    await assert.rejects(() => redemption.prepareClaim(recipient.address, [{ ...jack, providerUserId: xId(madeAt + 5_000) }], xLink.paymentId), /waits for the X name @jack/);

    const claim = await redemption.prepareClaim(recipient.address, [jack, holder], link.paymentId);
    await confirmed(publicClient, recipientWallet.sendTransaction({ to: claim.transaction.to, data: claim.transaction.data, value: 0n }));
    const xClaim = await redemption.prepareClaim(recipient.address, [jack], xLink.paymentId);
    await confirmed(publicClient, recipientWallet.sendTransaction({ to: xClaim.transaction.to, data: xClaim.transaction.data, value: 0n }));
    assert.equal(await balance(recipient.address), parseUnits("5", 6), "the names' holder gets exactly both amounts");
    assert.equal(await balance(escrow), 0n);
    assert.deepEqual(await incoming([jack, holder]), [], "claimed links leave the list");
  });

  it("links one OAuth identity to its wallet, rejects replay and stranger unlink, then supports rename and owner unlink", async () => {
    const verifier = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const wallet = mnemonicToAccount(mnemonic, { addressIndex: 3 });
    const stranger = mnemonicToAccount(mnemonic, { addressIndex: 4 });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const verifierWallet = createWalletClient({ account: verifier, chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account: wallet, chain, transport: http(rpcUrl) });
    const strangerClient = createWalletClient({ account: stranger, chain, transport: http(rpcUrl) });
    const artifacts = await compileLifecycleContracts();
    const deploymentHash = await verifierWallet.deployContract({
      abi: artifacts.registry.abi,
      bytecode: artifacts.registry.bytecode,
      args: [verifier.address],
    });
    const registry = (await publicClient.waitForTransactionReceipt({ hash: deploymentHash })).contractAddress!;
    const baseTimestamp = (await publicClient.getBlock()).timestamp;
    const service = new IdentityRegistryLinkService({
      chainId: chain.id,
      registry,
      attestor: verifier,
      now: () => new Date(Number(baseTimestamp) * 1000),
      readNonce: (owner) => publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "nonces", args: [owner] }),
      readIdentityOwner: (platformHash, providerUserIdHash) => publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "resolveProviderIdentity", args: [platformHash, providerUserIdHash] }),
    });
    const account = { platform: "github" as const, providerUserId: "583231", username: "Arc-Builder", verifiedAt: new Date().toISOString() };
    const platformHash = keccak256(stringToHex("github"));
    const providerUserIdHash = keccak256(stringToHex(account.providerUserId));
    const oldUsernameHash = keccak256(stringToHex("arc-builder"));
    const newUsernameHash = keccak256(stringToHex("arc-builder-new"));

    const link = await service.prepare(wallet.address, account);
    await confirmed(publicClient, walletClient.sendTransaction({ to: link.transaction.to, data: link.transaction.data, value: 0n }));
    assert.equal(await publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "resolveProviderIdentity", args: [platformHash, providerUserIdHash] }), wallet.address);
    assert.equal(await publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "resolveHandle", args: [platformHash, oldUsernameHash] }), wallet.address);
    await assert.rejects(() => walletClient.sendTransaction({ to: link.transaction.to, data: link.transaction.data, value: 0n }));

    const renamedAccount = { ...account, username: "Arc-Builder-New" };
    const rename = await service.prepare(wallet.address, renamedAccount);
    await confirmed(publicClient, walletClient.sendTransaction({ to: rename.transaction.to, data: rename.transaction.data, value: 0n }));
    assert.equal(await publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "resolveHandle", args: [platformHash, oldUsernameHash] }), zeroAddress);
    assert.equal(await publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "resolveHandle", args: [platformHash, newUsernameHash] }), wallet.address);

    const unlink = await service.prepareUnlink(wallet.address, renamedAccount);
    assert.equal(unlink.registered, true);
    await assert.rejects(() => strangerClient.sendTransaction({ to: unlink.transaction.to, data: unlink.transaction.data, value: 0n }));
    await confirmed(publicClient, walletClient.sendTransaction({ to: unlink.transaction.to, data: unlink.transaction.data, value: 0n }));
    assert.equal(await publicClient.readContract({ address: registry, abi: registryReadAbi, functionName: "resolveProviderIdentity", args: [platformHash, providerUserIdHash] }), zeroAddress);
  });
});

function redemptionService(client: ReturnType<typeof createPublicClient>, escrow: Address, usdc: Address, verifier: ReturnType<typeof mnemonicToAccount>, now: bigint, records?: MemoryClaimFundingRepository) {
  return new ClaimRedemptionService({
    chainId: chain.id,
    escrow,
    usdc,
    attestor: verifier,
    expectedVerifier: verifier.address,
    records,
    network: { id: "arc-testnet", name: chain.name },
    now: () => new Date(Number(now) * 1000),
    readPayment: async (paymentId) => {
      const [payer, token, identityKey, amount, fee, expiry] = await client.readContract({ address: escrow, abi: stockClaimEscrowAbi, functionName: "payments", args: [paymentId] });
      return { payer, token, identityKey, amount, fee, expiry };
    },
  });
}

async function sendPrepared(client: ReturnType<typeof createPublicClient>, send: (transaction: { to: Address; data: Hex; value: bigint }) => Promise<Hex>, transactions: Array<{ to: Address; data: Hex }>) {
  const hashes: Hex[] = [];
  for (const transaction of transactions) {
    hashes.push((await confirmed(client, send({ to: transaction.to, data: transaction.data, value: 0n }))).transactionHash);
  }
  return hashes;
}

async function confirmed(client: ReturnType<typeof createPublicClient>, hashPromise: Promise<Hex>) {
  const receipt = await client.waitForTransactionReceipt({ hash: await hashPromise });
  assert.equal(receipt.status, "success");
  return receipt;
}

async function compileLifecycleContracts() {
  const token = await readFile(new URL("./fixtures/MockUSDC.sol", import.meta.url), "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "MockUSDC.sol": { content: token } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
  assert.deepEqual(errors, []);
  return {
    // The registry and the fee contracts are the committed builds the operator page deploys.
    registry: { abi: arcIdentityRegistryAbi as unknown as Abi, bytecode: ARC_IDENTITY_REGISTRY_ARTIFACT.bytecode },
    token: { abi: output.contracts["MockUSDC.sol"].MockUSDC.abi, bytecode: `0x${output.contracts["MockUSDC.sol"].MockUSDC.evm.bytecode.object}` as Hex },
  };
}

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing lifecycle test port."));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
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
