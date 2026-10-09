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
  type PrivateKeyAccount,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { readStockClaimConfig, robinhoodChainClient } from "../server/robinhood-network";
import { MemoryStockClaimRepository, StockClaimService } from "../server/stock-claim-service";
import { MemoryStockTransferRepository, StockTransferService } from "../server/stock-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact";
import { BURN_VAULT_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../src/domain/fee-artifacts";
import { burnVaultAbi, payRouterAbi } from "../src/domain/fees";
import { matchesStockReview, type PreparedStockTransfer } from "../src/domain/stock-tokens";
import {
  matchesStockClaimAction,
  matchesStockClaimFunding,
  stockClaimEscrowAbi,
  type PreparedStockClaimAction,
  type PreparedStockClaimFunding,
  type StockClaimDetails,
  type StockEscrowDeployment,
} from "../src/domain/stock-claims";
import { resolveFoundryBinary } from "../scripts/foundry-binary";

const mnemonic = "test test test test test test test test test test test junk";
const chain = defineChain({
  id: 46_630,
  name: "Robinhood Chain Testnet simulation",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const TSLA = STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens.find((token) => token.symbol === "TSLA")!;
const stockAbi = parseAbi([
  "function mint(address recipient, uint256 amount)",
  "function setPaused(bool value)",
  "function setBlocked(address account, bool value)",
  "function balanceOf(address owner) view returns (uint256)",
]);

describe("Robinhood stock claim links on a real EVM", () => {
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

  it("deploys the burn vault, fee router and escrow from the operator wallet, charges the 1% fee on links and direct payments, claims by OAuth identity, and refunds an expired link with its fee", async () => {
    const transferRecords = new MemoryStockTransferRepository();
    const operator = mnemonicToAccount(mnemonic, { addressIndex: 0 });
    const payer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
    const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 });
    const stranger = mnemonicToAccount(mnemonic, { addressIndex: 3 });
    const attestorKey = generatePrivateKey();
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
    const wallet = (account: typeof operator) => createWalletClient({ account, chain, transport: http(rpcUrl) });
    const mined = async (hash: Hex) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };

    // The faucet TSLA stand-in runs at the real allowlisted testnet address.
    const fixture = await compileMockStockToken();
    const deployed = (await mined(await wallet(operator).deployContract({ abi: fixture.abi, bytecode: fixture.bytecode }))).contractAddress!;
    await testClient.setCode({ address: TSLA.address, bytecode: (await publicClient.getCode({ address: deployed }))! });
    const admin = async (functionName: "mint" | "setPaused" | "setBlocked", args: readonly unknown[]) => {
      await mined(await wallet(operator).writeContract({ address: TSLA.address, abi: stockAbi, functionName, args } as never));
    };
    const balance = (owner: Address) => publicClient.readContract({ address: TSLA.address, abi: stockAbi, functionName: "balanceOf", args: [owner] });
    await admin("mint", [payer.address, parseUnits("10", 18)]);

    // The server's clock follows the chain, so expiry checks agree with block.timestamp after time travel.
    let clock = Number((await publicClient.getBlock()).timestamp) * 1000;
    const identities = new VerifiedIdentityService();
    identities.link(payer.address, { platform: "github", providerUserId: "gh-payer-1", username: "ayse-dev", verifiedAt: new Date().toISOString() });
    const stockTransfers = new StockTransferService({
      networks: {
        "robinhood-testnet": { enabled: true, client: robinhoodChainClient(rpcUrl) },
        "robinhood-mainnet": { enabled: false, reason: "Mainnet stock transfers are turned off on this server." },
      },
      repository: transferRecords,
      now: () => clock,
      receiptRetry: { attempts: 2, delayMs: 50 },
    });
    const lookups: string[] = [];
    const stockClaims = new StockClaimService({
      transfers: stockTransfers,
      repository: new MemoryStockClaimRepository(),
      directory: {
        async lookup(platform, username) {
          lookups.push(`${platform}:${username}`);
          if (platform === "github" && username === "octo-new") return { platform: "github", providerUserId: "583231", username: "octo-new" };
          throw new Error("GitHub account was not found.");
        },
      },
      config: readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: attestorKey, CONTRACT_OWNER_ADDRESS: operator.address }),
      now: () => clock,
      cacheMs: 0,
    });
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "stock-claim-lifecycle-secret-32-chars" }),
      identities,
      stockTransfers,
      stockClaims,
    });
    const server = await listen(app);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const session = await signIn(origin, operator);
      const payerSession = await signIn(origin, payer);
      const recipientSession = await signIn(origin, recipient);
      const strangerSession = await signIn(origin, stranger);

      // 1. The operator page: the verifier to deploy with, and no escrow yet.
      const status = await (await fetch(`${origin}/api/stocks/escrow`)).json() as {
        contract: { runtimeCodeHash: Hex; securityRevision: string };
        feeContracts: { router: { runtimeCodeHash: Hex }; burnVault: { runtimeCodeHash: Hex }; feeBps: number; burnShareBps: number };
        networks: StockEscrowDeployment[];
      };
      assert.equal(status.contract.runtimeCodeHash, STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash);
      assert.equal(status.contract.securityRevision, "2");
      assert.equal(status.feeContracts.router.runtimeCodeHash, PAY_ROUTER_ARTIFACT.runtimeCodeHash);
      assert.equal(status.feeContracts.burnVault.runtimeCodeHash, BURN_VAULT_ARTIFACT.runtimeCodeHash);
      assert.equal(status.feeContracts.feeBps, 100);
      assert.equal(status.feeContracts.burnShareBps, 5000);
      const testnet = status.networks.find((entry) => entry.network === "robinhood-testnet")!;
      assert.deepEqual(testnet.setup, []);
      assert.equal(testnet.verifier, privateKeyToAccount(attestorKey).address);
      assert.equal(testnet.operator, operator.address);
      assert.equal(testnet.escrow, undefined);
      assert.deepEqual(testnet.claims, { enabled: false, reason: "No claim escrow is deployed on Robinhood Chain Testnet yet." });
      const mainnet = status.networks.find((entry) => entry.network === "robinhood-mainnet")!;
      assert.deepEqual(mainnet.setup, ["ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY", "ROBINHOOD_MAINNET_TOKEN_TRANSFERS=enabled"]);
      assert.equal(mainnet.claims.enabled, false);

      // 2. The operator page: the burn vault, the fee router (that vault, the operator as treasury), then the escrow
      // with the server's verifier and that router, all bundled creation code sent from the operator wallet.
      const burnVault = getAddress((await mined(await wallet(operator).deployContract({ abi: burnVaultAbi, bytecode: BURN_VAULT_ARTIFACT.bytecode }))).contractAddress!);
      const router = getAddress((await mined(await wallet(operator).deployContract({ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT.bytecode, args: [burnVault, operator.address] }))).contractAddress!);
      const deployment = await wallet(operator).deployContract({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [testnet.verifier!, router] });
      const escrow = getAddress((await mined(deployment)).contractAddress!);
      const register = (cookie: string, transactionHash: Hex) => post(origin, cookie, "/api/stocks/escrow/register", { network: "robinhood-testnet", transactionHash });
      assert.equal((await register(payerSession, deployment)).status, 403, "only the configured contract owner registers");
      // A router that pays its treasury half to anyone but the operator is refused, and so is an escrow built on it.
      const strangerRouter = getAddress((await mined(await wallet(operator).deployContract({ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT.bytecode, args: [burnVault, stranger.address] }))).contractAddress!);
      const wrongTreasury = await wallet(operator).deployContract({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [testnet.verifier!, strangerRouter] });
      await mined(wrongTreasury);
      const treasuryRefused = await register(session, wrongTreasury);
      assert.equal(treasuryRefused.status, 400);
      assert.match((await treasuryRefused.json() as { error: string }).error, /pay its treasury half to it/);
      const wrongVerifier = await wallet(operator).deployContract({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [stranger.address, router] });
      await mined(wrongVerifier);
      const refused = await register(session, wrongVerifier);
      assert.equal(refused.status, 400);
      assert.match((await refused.json() as { error: string }).error, /verifier is not this server's claim attestor/);
      const notAContract = await wallet(operator).sendTransaction({ to: stranger.address, value: 1n });
      await mined(notAContract);
      assert.equal((await register(session, notAContract)).status, 400);
      const registered = await register(session, deployment);
      assert.equal(registered.status, 201);
      const registration = await registered.json() as StockEscrowDeployment;
      assert.equal(registration.escrow?.address, escrow);
      const fees = { router, burnVault, treasury: operator.address, feeBps: 100, burnShareBps: 5000 };
      assert.deepEqual(registration.fees, fees);
      assert.deepEqual(registration.claims, { enabled: true, escrow, platforms: ["github", "x", "farcaster", "discord", "telegram"], stockTokens: true, tokens: true, fees });
      const board = await (await fetch(`${origin}/api/stocks?network=robinhood-testnet`)).json() as { claims: unknown; fees: unknown };
      assert.deepEqual(board.claims, { enabled: true, escrow, platforms: ["github", "x", "farcaster", "discord", "telegram"], stockTokens: true, tokens: true, fees });
      assert.deepEqual(board.fees, fees, "direct payments on the network use the same router");
      const health = await (await fetch(`${origin}/api/health`)).json() as { stockClaims: Record<string, string> };
      assert.deepEqual(health.stockClaims, { "robinhood-testnet": "escrow_verified", "robinhood-mainnet": "disabled" });

      // 3. The payer asks for a transfer to a GitHub user who is not on HaPaPay yet.
      const draft = await (await post(origin, payerSession, "/api/chat", { message: "Send 2.5 TSLA to @octo-new on GitHub", networkPreference: "robinhood-testnet" })).json() as {
        status: string; escrow: Address; units: string; expiryHours: number;
        stockIntent: { asset: { symbol: string; address: Address }; amount: string; recipient: { platform: "github"; username: string } };
      };
      assert.equal(draft.status, "stock_claim_review");
      assert.equal(draft.escrow, escrow);
      assert.equal(draft.expiryHours, 72);
      const request = {
        network: "robinhood-testnet",
        token: { symbol: draft.stockIntent.asset.symbol, address: draft.stockIntent.asset.address },
        amount: draft.stockIntent.amount,
        recipient: draft.stockIntent.recipient,
      };
      const prepareLink = async (body: Record<string, unknown> = {}) => post(origin, payerSession, "/api/stocks/claims/prepare", { ...request, expiryHours: draft.expiryHours, ...body });
      const tooMuch = await prepareLink({ amount: "25" });
      assert.equal(tooMuch.status, 400);
      assert.equal((await tooMuch.json() as { error: string }).error, "Your wallet holds 10 TSLA; this claim link needs 25.25 TSLA.", "the fee is part of what the wallet must hold");
      await admin("setBlocked", [escrow, true]);
      assert.match((await (await prepareLink()).json() as { error: string }).error, /blocks TSLA transfers to the claim escrow/);
      await admin("setBlocked", [escrow, false]);
      const unknown = await prepareLink({ recipient: { platform: "github", username: "nobody-here" } });
      assert.equal(unknown.status, 400);

      const preparedResponse = await prepareLink();
      assert.equal(preparedResponse.status, 200);
      const prepared = await preparedResponse.json() as PreparedStockClaimFunding;
      const review = { network: "robinhood-testnet" as const, token: TSLA.address, payer: payer.address, units: draft.units, escrow, platform: "github" as const, nowSeconds: clock / 1000 };
      assert.equal(matchesStockClaimFunding(prepared, review), true);
      assert.equal(matchesStockClaimFunding(prepared, { ...review, escrow: stranger.address }), false);
      assert.deepEqual(prepared.fee, {
        router, feeBps: 100, units: parseUnits("0.025", 18).toString(), amount: "0.025",
        burnShare: parseUnits("0.0125", 18).toString(), treasuryShare: parseUnits("0.0125", 18).toString(),
        totalUnits: parseUnits("2.525", 18).toString(), totalAmount: "2.525",
      });
      assert.equal(matchesStockClaimFunding({ ...prepared, fee: { ...prepared.fee, units: parseUnits("0.05", 18).toString() } }, review), false, "a fee above 1% is refused");
      assert.equal(prepared.claimPath, `/claim/stock/robinhood-testnet/${prepared.paymentId}`);
      const hashes: Hex[] = [];
      for (const transaction of prepared.transactions) {
        hashes.push(await wallet(payer).sendTransaction({ to: transaction.to, data: transaction.data, value: BigInt(transaction.value) }));
        await mined(hashes.at(-1)!);
      }
      await assert.rejects(() => wallet(payer).sendTransaction({ to: prepared.transactions[1].to, data: prepared.transactions[1].data }), "a funded payment ID cannot be funded twice");
      assert.equal(await balance(escrow), parseUnits("2.525", 18), "the escrow holds the amount and the fee");
      assert.equal(await balance(burnVault), 0n, "no fee is paid before the claim");

      // The browser sends the fund transaction's hash; the server records it only from the exact PaymentCreated log.
      const confirm = (cookie: string, body: Record<string, unknown> = {}) => post(origin, cookie, "/api/stocks/claims/confirm-funding", {
        ...request, escrow, paymentId: prepared.paymentId, transactionHash: hashes[1], ...body,
      });
      assert.equal((await confirm(payerSession, { transactionHash: hashes[0] })).status, 400, "the approval receipt is not a funding");
      assert.equal((await confirm(strangerSession)).status, 400, "only the payer's session confirms");
      assert.equal((await confirm(payerSession, { amount: "2" })).status, 400, "the amount must match the event");
      const confirmed = await confirm(payerSession);
      assert.equal(confirmed.status, 201);
      const record = await confirmed.json() as { claimPath: string; recipient: { platform: string; username: string }; amount: string; transactionHash: Hex };
      assert.equal(record.claimPath, prepared.claimPath);
      assert.deepEqual(record.recipient, { platform: "github", username: "octo-new" });
      assert.equal((await confirm(payerSession)).status, 201, "confirmation is idempotent for the same transaction");

      // 4. The recipient opens the link.
      const detailsPath = `/api/stocks/claims/robinhood-testnet/${prepared.paymentId}`;
      const details = await (await fetch(`${origin}${detailsPath}`)).json() as StockClaimDetails;
      assert.equal(details.status, "claimable");
      assert.equal(details.amount, "2.5");
      assert.equal(details.fee, "0.025");
      assert.equal(details.token.symbol, "TSLA");
      assert.equal(details.escrow, escrow);
      assert.equal(details.payer, payer.address);
      assert.deepEqual(details.recipient, { platform: "github", username: "octo-new" });
      assert.equal((await fetch(`${origin}/api/stocks/claims/robinhood-testnet/0x${"99".repeat(32)}`)).status, 404);
      assert.equal((await fetch(`${origin}/api/stocks/claims/arc-testnet/${prepared.paymentId}`)).status, 404);

      const prepareClaim = (cookie: string) => post(origin, cookie, `${detailsPath}/prepare-claim`, {});
      const unlinked = await prepareClaim(recipientSession);
      assert.equal(unlinked.status, 400);
      assert.match((await unlinked.json() as { error: string }).error, /None of your verified accounts/);
      // A different GitHub account with the same handle text cannot claim: the lock is the immutable ID.
      identities.link(stranger.address, { platform: "github", providerUserId: "999999", username: "octo-new-2", verifiedAt: new Date().toISOString() });
      assert.equal((await prepareClaim(strangerSession)).status, 400);
      identities.link(recipient.address, { platform: "github", providerUserId: "583231", username: "octo-new", verifiedAt: new Date().toISOString() });

      // Issuer controls surface before the wallet opens, through the escrow's bubbled token errors.
      await admin("setPaused", [true]);
      assert.match((await (await prepareClaim(recipientSession)).json() as { error: string }).error, /TSLA transfers are paused by the issuer/);
      await admin("setPaused", [false]);
      await admin("setBlocked", [recipient.address, true]);
      assert.match((await (await prepareClaim(recipientSession)).json() as { error: string }).error, /blocks TSLA transfers to your wallet/);
      await admin("setBlocked", [recipient.address, false]);

      const claimResponse = await prepareClaim(recipientSession);
      assert.equal(claimResponse.status, 200);
      const claim = await claimResponse.json() as PreparedStockClaimAction;
      assert.equal(matchesStockClaimAction(claim, { network: "robinhood-testnet", escrow, wallet: recipient.address, paymentId: prepared.paymentId, action: "claim" }), true);
      assert.equal(matchesStockClaimAction(claim, { network: "robinhood-testnet", escrow, wallet: stranger.address, paymentId: prepared.paymentId, action: "claim" }), false);
      // The signed claim only works from the recipient's own wallet.
      await assert.rejects(() => wallet(stranger).sendTransaction({ to: claim.transaction.to, data: claim.transaction.data }));
      await mined(await wallet(recipient).sendTransaction({ to: claim.transaction.to, data: claim.transaction.data }));
      assert.equal(await balance(recipient.address), parseUnits("2.5", 18), "the recipient receives exactly the amount");
      assert.equal(await balance(escrow), 0n);
      assert.equal(await balance(burnVault), parseUnits("0.0125", 18), "half of the fee goes to the burn vault");
      assert.equal(await balance(operator.address), parseUnits("0.0125", 18), "half of the fee goes to the operator's treasury");
      const settled = await (await fetch(`${origin}${detailsPath}`)).json() as StockClaimDetails;
      assert.equal(settled.status, "settled");
      assert.equal(settled.amount, "2.5");
      assert.equal(settled.recipient, undefined, "a settled link names nobody");
      assert.equal(settled.sourceIdentity, undefined);
      assert.match((await (await prepareClaim(recipientSession)).json() as { error: string }).error, /already claimed or refunded/);

      // 5. A second link nobody claims: only the payer takes it back, and only after the window closes.
      const second = await (await prepareLink({ amount: "1", expiryHours: 24 })).json() as PreparedStockClaimFunding;
      assert.equal(matchesStockClaimFunding(second, { ...review, units: parseUnits("1", 18).toString() }), true);
      let secondFunding: Hex | undefined;
      for (const transaction of second.transactions) {
        secondFunding = await wallet(payer).sendTransaction({ to: transaction.to, data: transaction.data });
        await mined(secondFunding);
      }
      const secondPath = `/api/stocks/claims/robinhood-testnet/${second.paymentId}`;
      const prepareRefund = (cookie: string) => post(origin, cookie, `${secondPath}/prepare-refund`, {});
      assert.match((await (await prepareRefund(payerSession)).json() as { error: string }).error, /after the claim window closes/);
      await testClient.increaseTime({ seconds: 24 * 60 * 60 + 5 });
      await testClient.mine({ blocks: 1 });
      clock = Number((await publicClient.getBlock()).timestamp) * 1000;
      // Its record reaches the server only after the window closed (a tab closed first): it is recorded all the same
      // and listed to its payer to take back (audit, 2026-10-06: it was refused, and the link reached no Claims list).
      assert.equal((await confirm(payerSession, { amount: "1", paymentId: second.paymentId, transactionHash: secondFunding })).status, 201);
      const late = await stockClaims.pending({ network: "robinhood-testnet", wallet: payer.address, accounts: [] });
      assert.deepEqual(late.outgoing.filter((link) => link.paymentId === second.paymentId).map((link) => link.status), ["refundable"]);
      assert.equal((await (await fetch(`${origin}${secondPath}`)).json() as StockClaimDetails).status, "expired");
      assert.match((await (await post(origin, recipientSession, `${secondPath}/prepare-claim`, {})).json() as { error: string }).error, /claim window has closed/);
      assert.match((await (await prepareRefund(recipientSession)).json() as { error: string }).error, /Only the wallet that funded/);
      const refund = await (await prepareRefund(payerSession)).json() as PreparedStockClaimAction;
      assert.equal(matchesStockClaimAction(refund, { network: "robinhood-testnet", escrow, wallet: payer.address, paymentId: second.paymentId, action: "refund" }), true);
      const before = await balance(payer.address);
      await mined(await wallet(payer).sendTransaction({ to: refund.transaction.to, data: refund.transaction.data }));
      assert.equal(await balance(payer.address) - before, parseUnits("1.01", 18), "a refund returns the amount and the fee");
      assert.equal(await balance(burnVault), parseUnits("0.0125", 18), "an unclaimed link pays no fee");

      // 6. A direct payment to the now-linked recipient goes through the same router: approve amount plus fee, then pay.
      const directReview = { network: "robinhood-testnet" as const, token: TSLA.address, sender: payer.address, recipient: recipient.address, units: parseUnits("1", 18).toString() };
      const directResponse = await post(origin, payerSession, "/api/stocks/transfers/prepare", {
        network: "robinhood-testnet", token: { symbol: "TSLA", address: TSLA.address }, amount: "1",
        recipient: { platform: "github", username: "octo-new" }, expectedRecipientAddress: recipient.address,
      });
      assert.equal(directResponse.status, 200);
      const direct = await directResponse.json() as PreparedStockTransfer;
      assert.equal(direct.transaction, undefined);
      assert.deepEqual(direct.transactions?.map((call) => call.purpose), ["approve", "pay"]);
      assert.equal(direct.fee?.totalAmount, "1.01");
      assert.equal(matchesStockReview(direct, directReview), true);
      assert.equal(matchesStockReview(direct, { ...directReview, recipient: stranger.address }), false);
      assert.equal(matchesStockReview({ ...direct, fee: { ...direct.fee!, router: stranger.address } }, directReview), false, "the pay call must target the reviewed router");
      // A fee the review never showed is never signed (audit, 2026-10-06), and the router must be the one it showed.
      assert.equal(matchesStockReview(direct, { ...directReview, router: direct.fee!.router }), true);
      assert.equal(matchesStockReview(direct, { ...directReview, router: null }), false);
      assert.equal(matchesStockReview(direct, { ...directReview, router: stranger.address }), false);
      const recipientBefore = await balance(recipient.address);
      let payHash: Hex | undefined;
      for (const call of direct.transactions!) {
        payHash = await wallet(payer).sendTransaction({ to: call.to, data: call.data });
        await mined(payHash);
      }
      assert.equal(await balance(recipient.address) - recipientBefore, parseUnits("1", 18));
      assert.equal(await balance(burnVault), parseUnits("0.0175", 18));
      assert.equal(await balance(operator.address), parseUnits("0.0175", 18));
      const directConfirmed = await post(origin, payerSession, "/api/stocks/transfers/confirm", {
        network: "robinhood-testnet", token: { symbol: "TSLA", address: TSLA.address }, amount: "1",
        recipient: { platform: "github", username: "octo-new" }, transactionHash: payHash,
      });
      assert.equal(directConfirmed.status, 201, "the routed payment's receipt carries the exact transfer to the recipient");
      const directRecord = (await transferRecords.list(payer.address)).find((record) => record.transactionHash === payHash?.toLowerCase());
      assert.equal(directRecord?.feeUnits, parseUnits("0.01", 18).toString(), "the router's Paid event shows the 1% fee the payment paid");
      assert.equal((await (await fetch(`${origin}${secondPath}`)).json() as StockClaimDetails).status, "settled");

      // 7. A Discord user who has not joined: Discord cannot be looked up, so the link waits for the name, and
      // whoever connects Discord with that name afterwards, on an account older than the link, claims it.
      const discordDraft = await (await post(origin, payerSession, "/api/chat", { message: "Send 1 TSLA to new.friend on Discord", networkPreference: "robinhood-testnet" })).json() as {
        status: string; vaultLock: string; units: string; expiryHours: number;
        stockIntent: { amount: string; recipient: { platform: string; username: string } };
      };
      assert.deepEqual([discordDraft.status, discordDraft.vaultLock, discordDraft.stockIntent.recipient], ["stock_claim_review", "name", { platform: "discord", username: "new.friend" }]);
      const discordRequest = { ...request, amount: discordDraft.stockIntent.amount, recipient: discordDraft.stockIntent.recipient, expiryHours: discordDraft.expiryHours };
      const lookupsBefore = lookups.length;
      const discordPrepared = await (await post(origin, payerSession, "/api/stocks/claims/prepare", discordRequest)).json() as PreparedStockClaimFunding;
      assert.equal(discordPrepared.lock, "name");
      assert.equal(lookups.length, lookupsBefore, "a Discord name is never looked up");
      assert.equal(matchesStockClaimFunding(discordPrepared, { ...review, platform: "discord", units: discordDraft.units, nowSeconds: clock / 1000 }), true);
      let discordFunding: Hex | undefined;
      for (const transaction of discordPrepared.transactions) {
        discordFunding = await wallet(payer).sendTransaction({ to: transaction.to, data: transaction.data });
        await mined(discordFunding);
      }
      const discordConfirmed = await post(origin, payerSession, "/api/stocks/claims/confirm-funding", { ...discordRequest, escrow, paymentId: discordPrepared.paymentId, transactionHash: discordFunding, lock: "name" });
      assert.equal(discordConfirmed.status, 201);
      const discordPath = `/api/stocks/claims/robinhood-testnet/${discordPrepared.paymentId}`;
      const discordDetails = await (await fetch(`${origin}${discordPath}`)).json() as StockClaimDetails;
      assert.deepEqual([discordDetails.status, discordDetails.lock, discordDetails.recipient], ["claimable", "name", { platform: "discord", username: "new.friend" }]);
      // The claim routes allow 30 requests a minute from one address, which this test nearly spends: the refusals are
      // asked of the service the routes call.
      const claimDiscordAs = async (wallet: Address) => stockClaims.prepareClaim({ network: "robinhood-testnet", paymentId: discordPrepared.paymentId, wallet, accounts: (await identities.profile(wallet)).accounts.map((account) => identities.account(wallet, account.platform)!) });
      // The recipient's GitHub account is not the Discord name.
      await assert.rejects(() => claimDiscordAs(recipient.address), /^StockTransferRejectedError: This link waits for the Discord name @new\.friend\./);
      // Discord IDs carry when the account was made: an account opened after the link with the name cannot take it.
      const discordId = (madeAt: number) => String((BigInt(madeAt) - 1_420_070_400_000n) << 22n);
      identities.link(stranger.address, { platform: "discord", providerUserId: discordId(clock + 60_000), username: "new.friend", verifiedAt: new Date(clock + 120_000).toISOString() });
      await assert.rejects(() => claimDiscordAs(stranger.address), /an account made after the link cannot claim it/);
      assert.deepEqual((await stockClaims.pending({ network: "robinhood-testnet", wallet: stranger.address, accounts: [identities.account(stranger.address, "discord")!] })).incoming, []);
      // The person who had the name all along connects Discord: the link waits under their Claims, and they claim it.
      identities.link(recipient.address, { platform: "discord", providerUserId: discordId(clock - 400 * 86_400_000), username: "new.friend", verifiedAt: new Date(clock + 180_000).toISOString() });
      const holder = identities.account(recipient.address, "discord")!;
      assert.deepEqual((await stockClaims.pending({ network: "robinhood-testnet", wallet: recipient.address, accounts: [holder] })).incoming.map((link) => [link.paymentId, link.recipient.platform, link.amount]), [[discordPrepared.paymentId, "discord", "1"]]);
      const discordClaim = await post(origin, recipientSession, `${discordPath}/prepare-claim`, {});
      assert.equal(discordClaim.status, 200);
      const discordAction = await discordClaim.json() as PreparedStockClaimAction;
      const recipientBeforeDiscord = await balance(recipient.address);
      await mined(await wallet(recipient).sendTransaction({ to: discordAction.transaction.to, data: discordAction.transaction.data }));
      assert.equal(await balance(recipient.address) - recipientBeforeDiscord, parseUnits("1", 18), "the name's holder receives exactly the amount");
      assert.equal((await (await fetch(`${origin}${discordPath}`)).json() as StockClaimDetails).status, "settled");

      // 8. An escrow whose ownership left the operator gets no new funding, though existing links stay readable.
      await mined(await wallet(operator).writeContract({ address: escrow, abi: stockClaimEscrowAbi, functionName: "transferOwnership", args: [stranger.address] }));
      const orphaned = await prepareLink();
      assert.equal(orphaned.status, 503);
      assert.match((await orphaned.json() as { error: string }).error, /not owned by the operator wallet set on this server/);
      assert.equal((await fetch(`${origin}${detailsPath}`)).status, 200);
      assert.ok(lookups.includes("github:octo-new"));
    } finally {
      await close(server);
    }
  });
});

async function signIn(origin: string, account: PrivateKeyAccount | ReturnType<typeof mnemonicToAccount>) {
  const challengeResponse = await fetch(`${origin}/api/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const challenge = await challengeResponse.json() as { id: string; message: string };
  const signature = await account.signMessage({ message: challenge.message });
  const login = await fetch(`${origin}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature }),
  });
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function post(origin: string, cookie: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function compileMockStockToken() {
  const source = await readFile(new URL("./fixtures/MockStockToken.sol", import.meta.url), "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "MockStockToken.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  }))) as { errors?: Array<{ severity: string; formattedMessage: string }>; contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  assert.deepEqual(output.errors?.filter((error) => error.severity === "error") ?? [], []);
  const artifact = output.contracts["MockStockToken.sol"].MockStockToken;
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` as Hex };
}

async function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing stock claim test port."));
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
