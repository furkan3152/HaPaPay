import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "node:http";
import { newDb } from "pg-mem";
import { encodeErrorResult, encodeFunctionData, getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { createChatDraft } from "../server/chat-service";
import { readStockClaimConfig } from "../server/robinhood-network";
import {
  DuplicateStockClaimError,
  MemoryStockClaimRepository,
  PostgresStockClaimRepository,
  StockClaimService,
  claimRejection,
  stockClaimIdentityKey,
  type StockClaimEscrowRecord,
  type StockClaimRecord,
  type StockClaimRepository,
} from "../server/stock-claim-service";
import { StockTransferUnavailableError, stockTokenTransferAbi, type StockChainClient } from "../server/stock-transfer-service";
import { FEE_BURN_VAULT, FEE_ROUTER, feeContractsClient as feeClient } from "./fixtures/fee-contracts";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";
import { STOCK_TOKEN_ALLOWLISTS } from "../src/domain/robinhood-stock-tokens";
import { ROBINHOOD_USDG } from "../src/domain/robinhood-assets";
import {
  STOCK_CLAIM_WINDOW_CHOICES,
  matchesStockClaimAction,
  matchesStockClaimFunding,
  parseStockClaimPath,
  stockClaimEscrowAbi,
  stockClaimPath,
  stockClaimPlatformHash,
  stockTokenApproveAbi,
  type PreparedStockClaimAction,
  type PreparedStockClaimFunding,
  settledLink,
} from "../src/domain/stock-claims";

const TSLA = STOCK_TOKEN_ALLOWLISTS["robinhood-testnet"].tokens.find((token) => token.symbol === "TSLA")!;
const OWNER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A" as const;
const ESCROW = "0x8a7e4E1B6f1cA842a9b84E5CB18A46EDF2Ceb789" as const;
const OTHER_ESCROW = "0x2222222222222222222222222222222222222222" as const;
const PAYER = "0x1111111111111111111111111111111111111111" as const;
const PAYMENT_ID = `0x${"ab".repeat(32)}` as const;
const ROUTER = FEE_ROUTER;
const BURN_VAULT = FEE_BURN_VAULT;
const feeContractsClient = (overrides: { treasury?: Address; feeBps?: bigint } = {}) => feeClient({ escrow: ESCROW, owner: OWNER, ...overrides });

function escrowRecord(overrides: Partial<StockClaimEscrowRecord> = {}): StockClaimEscrowRecord {
  return {
    chainId: 46630,
    escrow: ESCROW,
    deploymentTransactionHash: `0x${"01".repeat(32)}`,
    owner: OWNER,
    verifier: PAYER,
    blockNumber: 100n,
    registeredAt: "2026-09-29T10:00:00.000Z",
    ...overrides,
  };
}

function claimRecord(overrides: Partial<StockClaimRecord> = {}): StockClaimRecord {
  return {
    chainId: 46630,
    paymentId: PAYMENT_ID,
    escrow: ESCROW,
    fundingTransactionHash: `0x${"02".repeat(32)}`,
    tokenAddress: TSLA.address,
    tokenSymbol: "TSLA",
    payer: PAYER,
    recipientPlatform: "github",
    recipientUsername: "octo-new",
    amount: "2.5",
    units: 2_500_000_000_000_000_000n,
    expiry: 1_790_000_000n,
    blockNumber: 120n,
    confirmedAt: "2026-09-29T10:05:00.000Z",
    ...overrides,
  };
}

describe("stock claim configuration", () => {
  const arcKey = generatePrivateKey();
  const identityKey = generatePrivateKey();

  it("lets testnet share the Arc Testnet claim attestor and needs the contract owner", () => {
    const config = readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, CONTRACT_OWNER_ADDRESS: OWNER.toLowerCase() });
    assert.equal(config.operator, OWNER);
    assert.equal(config.networks["robinhood-testnet"].attestor?.address, privateKeyToAccount(arcKey).address);
    assert.deepEqual(config.networks["robinhood-testnet"].setup, []);
    assert.equal(config.networks["robinhood-mainnet"].attestor, undefined);
    assert.deepEqual(config.networks["robinhood-mainnet"].setup, ["ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"]);

    const dedicated = generatePrivateKey();
    assert.equal(readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY: dedicated, CONTRACT_OWNER_ADDRESS: OWNER })
      .networks["robinhood-testnet"].attestor?.address, privateKeyToAccount(dedicated).address);
    const withoutOwner = readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, CONTRACT_OWNER_ADDRESS: "not-an-address" });
    assert.equal(withoutOwner.operator, undefined);
    assert.deepEqual(withoutOwner.networks["robinhood-testnet"].setup, ["CONTRACT_OWNER_ADDRESS"]);
  });

  it("takes the Robinhood operator from its own variable, so the Arc contract owner can stay as deployed", () => {
    const operator = privateKeyToAccount(generatePrivateKey()).address;
    const config = readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, ROBINHOOD_OPERATOR_ADDRESS: operator.toLowerCase(), CONTRACT_OWNER_ADDRESS: OWNER });
    assert.equal(config.operator, operator);
    assert.deepEqual(config.networks["robinhood-testnet"].setup, []);
    const malformed = readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, ROBINHOOD_OPERATOR_ADDRESS: "0x1234", CONTRACT_OWNER_ADDRESS: OWNER });
    assert.equal(malformed.operator, undefined, "a malformed operator never falls back to the Arc owner");
    assert.deepEqual(malformed.networks["robinhood-testnet"].setup, ["ROBINHOOD_OPERATOR_ADDRESS"]);
  });

  it("keeps sharing the Arc Testnet claim key with Robinhood Testnet after Arc moves to mainnet, which has its own keys", () => {
    // Arc Mainnet reads ARC_MAINNET_* keys only, so CLAIM_ATTESTOR_PRIVATE_KEY stays a testnet key in either mode.
    const config = readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: generatePrivateKey(), CONTRACT_OWNER_ADDRESS: OWNER });
    assert.equal(config.networks["robinhood-testnet"].attestor?.address, privateKeyToAccount(arcKey).address);
    assert.deepEqual(config.networks["robinhood-testnet"].setup, []);
  });

  it("gives mainnet only a dedicated, well-formed key", () => {
    const mainnetKey = generatePrivateKey();
    assert.equal(readStockClaimConfig({ CLAIM_ATTESTOR_PRIVATE_KEY: arcKey, ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: mainnetKey, CONTRACT_OWNER_ADDRESS: OWNER })
      .networks["robinhood-mainnet"].attestor?.address, privateKeyToAccount(mainnetKey).address);
    const arcMainnetClaimKey = generatePrivateKey();
    const arcMainnetIdentityKey = generatePrivateKey();
    for (const shared of [arcKey, identityKey, arcKey.toUpperCase().replace("0X", "0x"), arcMainnetClaimKey, arcMainnetIdentityKey]) {
      const config = readStockClaimConfig({
        CLAIM_ATTESTOR_PRIVATE_KEY: arcKey,
        IDENTITY_ATTESTOR_PRIVATE_KEY: identityKey,
        ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: arcMainnetClaimKey,
        ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: arcMainnetIdentityKey,
        ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: shared,
        CONTRACT_OWNER_ADDRESS: OWNER,
      });
      assert.equal(config.networks["robinhood-mainnet"].attestor, undefined, "a key used by another role is refused");
    }
    const testnetKey = generatePrivateKey();
    assert.equal(readStockClaimConfig({ ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY: testnetKey, ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: testnetKey, CONTRACT_OWNER_ADDRESS: OWNER })
      .networks["robinhood-mainnet"].attestor, undefined, "a testnet key is never a mainnet key");
    assert.equal(readStockClaimConfig({ ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: "0x1234", CONTRACT_OWNER_ADDRESS: OWNER })
      .networks["robinhood-mainnet"].attestor, undefined);
  });
});

describe("stock claim repositories", () => {
  async function exercise(repository: StockClaimRepository, reopen: () => StockClaimRepository) {
    assert.equal(await repository.activeEscrow(46630), undefined);
    await repository.saveEscrow(escrowRecord());
    await repository.saveEscrow(escrowRecord({ escrow: OTHER_ESCROW, deploymentTransactionHash: `0x${"03".repeat(32)}`, registeredAt: "2026-09-29T11:00:00.000Z" }));
    assert.equal((await repository.activeEscrow(46630))?.escrow, OTHER_ESCROW, "the latest registration funds new links");
    await repository.saveEscrow(escrowRecord({ registeredAt: "2026-09-29T12:00:00.000Z" }));
    assert.equal((await repository.activeEscrow(46630))?.escrow, ESCROW, "registering again reactivates an escrow");
    assert.equal(await repository.activeEscrow(4663), undefined, "escrows are chain-scoped");
    assert.equal((await repository.escrow(46630, OTHER_ESCROW.toLowerCase() as Address))?.deploymentTransactionHash, `0x${"03".repeat(32)}`);
    assert.equal(await repository.escrow(4663, ESCROW), undefined);

    const stored = claimRecord({ sourcePlatform: "github", sourceUsername: "ayse-dev" });
    assert.deepEqual(await repository.saveClaim(stored), stored);
    assert.deepEqual(await repository.saveClaim(stored), stored, "the same funding confirms twice");
    await assert.rejects(() => repository.saveClaim(claimRecord({ fundingTransactionHash: `0x${"04".repeat(32)}` })), DuplicateStockClaimError);
    await assert.rejects(() => repository.saveClaim(claimRecord({ paymentId: `0x${"cd".repeat(32)}` })), DuplicateStockClaimError, "one funding transaction backs one link");
    assert.deepEqual(await reopen().claim(46630, PAYMENT_ID.toUpperCase().replace("0X", "0x") as Hex), stored);
    assert.equal(await reopen().claim(4663, PAYMENT_ID), undefined);
  }

  it("keeps escrows and claim links in PostgreSQL across process recreation", async () => {
    const database = newDb();
    const pool = new (database.adapters.createPg().Pool)();
    const repository = new PostgresStockClaimRepository(pool);
    await repository.migrate();
    await exercise(repository, () => new PostgresStockClaimRepository(pool));
  });

  it("behaves the same in memory for local development", async () => {
    const repository = new MemoryStockClaimRepository();
    await exercise(repository, () => repository);
  });
});

describe("what a claim page says about a settled link", () => {
  it("says claimed before the window closes, and claimed or refunded after it", () => {
    // A claimed link reads "Claimed", not "unavailable", and offers neither Verify wallet nor Refund.
    const expiresAt = "2026-03-12T11:12:00.000Z";
    assert.equal(settledLink(expiresAt, Date.parse("2026-03-10T16:00:00.000Z")).label, "Claimed");
    assert.match(settledLink(expiresAt, Date.parse("2026-03-10T16:00:00.000Z")).note, /^This link was claimed on chain\./);
    assert.equal(settledLink(expiresAt, Date.parse("2026-03-12T11:00:00.000Z")).label, "Claimed or refunded", "inside the margin a refund cannot be ruled out");
    assert.equal(settledLink(expiresAt, Date.parse("2026-03-13T00:00:00.000Z")).label, "Claimed or refunded");
    // The page's heading and lead say it too, instead of asking the visitor to claim.
    assert.equal(settledLink(expiresAt, Date.parse("2026-03-10T16:00:00.000Z")).heading, "This vault link was claimed");
    assert.equal(settledLink(expiresAt, Date.parse("2026-03-13T00:00:00.000Z")).heading, "This vault link is closed");
    assert.match(settledLink(expiresAt, Date.parse("2026-03-13T00:00:00.000Z")).intro, /or its sender took it back after the window closed\.$/);
  });
});

describe("stock claim review checks in the browser", () => {
  const units = "2500000000000000000";
  const totalUnits = "2525000000000000000";
  const nowSeconds = 1_790_000_000;
  const expiry = String(nowSeconds + 72 * 3600);
  const fee = { router: ROUTER, feeBps: 100, units: "25000000000000000", amount: "0.025", burnShare: "12500000000000000", treasuryShare: "12500000000000000", totalUnits, totalAmount: "2.525" };
  function prepared(overrides: { approve?: Hex; fund?: Hex; from?: Address; value?: string; expiry?: string } = {}): PreparedStockClaimFunding {
    const fundExpiry = BigInt(overrides.expiry ?? expiry);
    return {
      networkId: "robinhood-testnet",
      chainId: 46630,
      chainIdHex: "0xb626",
      chainName: "Robinhood Chain Testnet",
      escrow: ESCROW,
      token: { symbol: "TSLA", name: TSLA.name, address: TSLA.address, decimals: 18 },
      amount: "2.5",
      units,
      balance: "10",
      paymentId: PAYMENT_ID,
      recipient: { platform: "github", username: "octo-new" },
      lock: "account",
      expiry: overrides.expiry ?? expiry,
      expiresAt: new Date(Number(expiry) * 1000).toISOString(),
      claimPath: stockClaimPath("robinhood-testnet", PAYMENT_ID),
      fee,
      transactions: [
        { purpose: "approve", from: overrides.from ?? PAYER, to: TSLA.address, value: overrides.value ?? "0x0", data: overrides.approve ?? encodeFunctionData({ abi: stockTokenApproveAbi, functionName: "approve", args: [ESCROW, BigInt(totalUnits)] }) },
        { purpose: "fund", from: overrides.from ?? PAYER, to: ESCROW, value: "0x0", data: overrides.fund ?? encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "createPayment", args: [PAYMENT_ID, TSLA.address, stockClaimPlatformHash("github"), keccak256(stringToHex("583231")), BigInt(units), fundExpiry] }) },
      ],
    };
  }
  const review = { network: "robinhood-testnet" as const, token: TSLA.address, payer: PAYER, units, escrow: ESCROW, platform: "github" as const, nowSeconds };

  it("opens the wallet only for the exact approve and fund of the reviewed link", () => {
    assert.equal(matchesStockClaimFunding(prepared(), review), true);
    assert.equal(matchesStockClaimFunding(prepared({ approve: encodeFunctionData({ abi: stockTokenApproveAbi, functionName: "approve", args: [ESCROW, BigInt(units)] }) }), review), false, "an approval without the fee cannot fund the link");
    assert.equal(matchesStockClaimFunding({ ...prepared(), fee: { ...fee, units: "50000000000000000", totalUnits: "2550000000000000000", burnShare: "25000000000000000", treasuryShare: "25000000000000000" } }, review), false, "a fee above 1%");
    assert.equal(matchesStockClaimFunding({ ...prepared(), fee: { ...fee, totalUnits: units } }, review), false, "a total that does not add up");
    assert.equal(matchesStockClaimFunding({ ...prepared(), fee: { ...fee, burnShare: "0", treasuryShare: fee.units } }, review), false, "a split other than half and half");
    assert.equal(matchesStockClaimFunding(prepared({ approve: encodeFunctionData({ abi: stockTokenApproveAbi, functionName: "approve", args: [OTHER_ESCROW, BigInt(units)] }) }), review), false, "approval to another spender");
    assert.equal(matchesStockClaimFunding(prepared({ approve: encodeFunctionData({ abi: stockTokenApproveAbi, functionName: "approve", args: [ESCROW, 2n ** 256n - 1n] }) }), review), false, "unlimited approval");
    assert.equal(matchesStockClaimFunding(prepared({ fund: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "createPayment", args: [PAYMENT_ID, TSLA.address, stockClaimPlatformHash("x"), keccak256(stringToHex("583231")), BigInt(units), BigInt(expiry)] }) }), review), false, "another platform");
    assert.equal(matchesStockClaimFunding(prepared({ fund: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "createPayment", args: [`0x${"ef".repeat(32)}`, TSLA.address, stockClaimPlatformHash("github"), keccak256(stringToHex("583231")), BigInt(units), BigInt(expiry)] }) }), review), false, "another payment ID");
    assert.equal(matchesStockClaimFunding(prepared({ fund: encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "refund", args: [PAYMENT_ID] }) }), review), false, "another escrow call");
    assert.equal(matchesStockClaimFunding(prepared({ expiry: String(nowSeconds + 32 * 24 * 3600) }), review), false, "window over 31 days");
    assert.equal(matchesStockClaimFunding(prepared({ expiry: String(nowSeconds - 1) }), review), false, "already expired");
    assert.equal(matchesStockClaimFunding(prepared({ from: OTHER_ESCROW }), review), false, "another sender");
    assert.equal(matchesStockClaimFunding(prepared({ value: "0x1" }), review), false, "native value");
    assert.equal(matchesStockClaimFunding(prepared(), { ...review, units: "1" }), false, "another amount");
    assert.equal(matchesStockClaimFunding(prepared(), { ...review, network: "robinhood-mainnet" }), false, "another chain");
    assert.equal(matchesStockClaimFunding({ ...prepared(), transactions: prepared().transactions.slice(0, 1) }, review), false, "missing funding");
  });

  it("accepts a claim only to the session wallet and a refund only of this link", () => {
    const action = (data: Hex, from: Address = PAYER): PreparedStockClaimAction => ({
      networkId: "robinhood-testnet", chainId: 46630, chainIdHex: "0xb626", paymentId: PAYMENT_ID, escrow: ESCROW,
      token: { symbol: "TSLA", name: TSLA.name, address: TSLA.address }, amount: "2.5",
      transaction: { from, to: ESCROW, data, value: "0x0" },
    });
    const claimReview = { network: "robinhood-testnet" as const, escrow: ESCROW, wallet: PAYER, paymentId: PAYMENT_ID, action: "claim" as const };
    const claimData = encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "claim", args: [PAYMENT_ID, PAYER, 1n, "0x1234"] });
    assert.equal(matchesStockClaimAction(action(claimData), claimReview), true);
    assert.equal(matchesStockClaimAction(action(encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "claim", args: [PAYMENT_ID, OTHER_ESCROW, 1n, "0x1234"] })), claimReview), false);
    assert.equal(matchesStockClaimAction(action(claimData), { ...claimReview, action: "refund" }), false);
    assert.equal(matchesStockClaimAction(action(claimData), { ...claimReview, escrow: OTHER_ESCROW }), false);
    const refundData = encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "refund", args: [PAYMENT_ID] });
    assert.equal(matchesStockClaimAction(action(refundData), { ...claimReview, action: "refund" }), true);
    assert.equal(matchesStockClaimAction(action(encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "refund", args: [`0x${"ef".repeat(32)}`] })), { ...claimReview, action: "refund" }), false);
    assert.equal(matchesStockClaimAction(action(refundData, OTHER_ESCROW), { ...claimReview, action: "refund" }), false);
  });

  it("round-trips claim paths for both Robinhood networks only", () => {
    assert.deepEqual(parseStockClaimPath(stockClaimPath("robinhood-mainnet", PAYMENT_ID)), { network: "robinhood-mainnet", paymentId: PAYMENT_ID });
    assert.equal(parseStockClaimPath(`/claim/stock/arc-testnet/${PAYMENT_ID}`), undefined);
    assert.equal(parseStockClaimPath(`/claim/${PAYMENT_ID}`), undefined);
  });
});

describe("stock claim rejection messages", () => {
  const revert = (data: Hex) => Object.assign(new Error("Execution reverted."), { cause: Object.assign(new Error("RPC error"), { code: 3, data }) });
  const context = { symbol: "TSLA", wallet: PAYER, escrow: ESCROW };
  const error = (errorName: string, args?: readonly unknown[]) => revert(encodeErrorResult({ abi: [...stockClaimEscrowAbi, ...stockTokenTransferAbi], errorName, args } as never));

  it("names the party an issuer block applies to", () => {
    assert.equal(claimRejection(error("Blocked", [ESCROW]), { ...context, action: "fund" }), "The issuer's compliance list blocks TSLA transfers to the claim escrow.");
    assert.equal(claimRejection(error("Blocked", [PAYER]), { ...context, action: "fund" }), "The issuer's compliance list blocks TSLA transfers from your wallet.");
    assert.equal(claimRejection(error("Blocked", [PAYER]), { ...context, action: "claim" }), "The issuer's compliance list blocks TSLA transfers to your wallet.");
    assert.equal(claimRejection(error("Blocked", [ESCROW]), { ...context, action: "refund" }), "The issuer's compliance list blocks TSLA transfers from the claim escrow.");
  });

  it("explains escrow reverts and falls back without leaking provider text", () => {
    assert.match(claimRejection(error("IsPaused"), { ...context, action: "claim" }), /paused by the issuer/);
    assert.match(claimRejection(error("ClaimExpired"), { ...context, action: "claim" }), /claim window has closed/);
    assert.match(claimRejection(error("PaymentUnavailable"), { ...context, action: "claim" }), /already claimed or refunded/);
    assert.match(claimRejection(error("NotPayer"), { ...context, action: "refund" }), /Only the wallet that funded/);
    assert.match(claimRejection(error("TransferAmountMismatch"), { ...context, action: "claim" }), /exact amount/);
    assert.equal(claimRejection(new Error("upstream https://rpc.example/key failed"), { ...context, action: "refund" }), "The escrow would reject this refund, so your wallet was not opened.");
  });
});

describe("stock claim chat drafts", () => {
  const claims = { enabled: true, escrow: ESCROW };

  it("offers a vault link to an unverified GitHub, X or Farcaster account when the escrow is live", async () => {
    const draft = await createChatDraft("Send 2.5 TSLA to @octo-new on GitHub", undefined, () => undefined, "Arc Testnet", "robinhood-testnet", true, claims) as Record<string, unknown>;
    assert.equal(draft.status, "stock_claim_review");
    assert.equal(draft.escrow, ESCROW);
    assert.equal(draft.units, "2500000000000000000");
    assert.equal(draft.expiryHours, 72);
    assert.match(String(draft.message), /not on HaPaPay yet[\s\S]*TSLA in the Robinhood Chain Testnet vault[\s\S]*official GitHub account within the window you pick, 72 hours to 30 days/);
    const farcaster = await createChatDraft("Send 1 TSLA to @dwr on Farcaster", undefined, () => undefined, "Arc Testnet", "robinhood-testnet", true, claims) as Record<string, unknown>;
    assert.equal(farcaster.status, "stock_claim_review");
    assert.match(String(farcaster.message), /official Farcaster account/);
  });

  it("lets Discord and Telegram links wait for the name, and keeps invite-first wording when claim links are off", async () => {
    const telegram = await createChatDraft("Send 2.5 TSLA to @deniz on Telegram", undefined, () => undefined, "Arc Testnet", "robinhood-testnet", true, { ...claims, platforms: ["github", "x", "farcaster", "discord", "telegram"] }) as Record<string, unknown>;
    assert.equal(telegram.status, "stock_claim_review");
    assert.equal(telegram.vaultLock, "name");
    assert.match(String(telegram.message), /TSLA in the Robinhood Chain Testnet vault for the Telegram name @deniz: whoever connects Telegram to HaPaPay with that name claims it/);
    const off = await createChatDraft("Send 2.5 TSLA to @octo-new on GitHub", undefined, () => undefined, "Arc Testnet", "robinhood-testnet", true, { enabled: false, reason: "No claim escrow is deployed on Robinhood Chain Testnet yet." });
    assert.equal(off.status, "needs_clarification");
    assert.match(String(off.message), /vault is not open: No claim escrow is deployed on Robinhood Chain Testnet yet\./);
    const withoutXLookup = await createChatDraft("Send 1 TSLA to @selin on X", undefined, () => undefined, "Arc Testnet", "robinhood-testnet", true, { ...claims, platforms: ["github"] });
    assert.equal(withoutXLookup.status, "needs_clarification", "no claim link where the handle cannot be resolved to an account ID");
  });
});

describe("stock claim availability", () => {
  const attestor = privateKeyToAccount(generatePrivateKey());
  const service = (options: { transfers?: boolean; repository?: StockClaimRepository; owner?: string; supports?: (platform: string) => boolean; client?: StockChainClient } = {}) => new StockClaimService({
    transfers: {
      availability: () => options.transfers === false ? { enabled: false, reason: "Testnet stock transfers are turned off on this server." } : { enabled: true },
      verifiedClient: async () => { if (!options.client) throw new Error("no chain reads expected"); return options.client; },
      transactionReceipt: async () => { throw new Error("no chain reads expected"); },
    },
    repository: options.repository ?? new MemoryStockClaimRepository(),
    directory: { lookup: async () => { throw new Error("no lookups expected"); }, ...(options.supports ? { supports: options.supports } : {}) },
    config: {
      operator: options.owner === undefined ? OWNER : undefined,
      networks: {
        "robinhood-testnet": { attestor, setup: options.owner === undefined ? [] : ["CONTRACT_OWNER_ADDRESS"] },
        "robinhood-mainnet": { setup: ["ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"] },
      },
    },
  });

  it("explains each missing piece without touching the chain", async () => {
    assert.deepEqual(await service({ transfers: false }).availability("robinhood-testnet"), { enabled: false, reason: "Testnet stock transfers are turned off on this server." });
    assert.deepEqual(await service({ owner: "" }).availability("robinhood-testnet"), { enabled: false, reason: "Stock claim links are not set up on Robinhood Chain Testnet yet." });
    assert.deepEqual(await service().availability("robinhood-testnet"), { enabled: false, reason: "No claim escrow is deployed on Robinhood Chain Testnet yet." });
    const registered = new MemoryStockClaimRepository();
    await registered.saveEscrow(escrowRecord({ verifier: getAddress(attestor.address) }));
    const client = await feeContractsClient();
    const fees = { router: ROUTER, burnVault: BURN_VAULT, treasury: OWNER, feeBps: 100, burnShareBps: 5000 };
    assert.deepEqual(await service({ repository: registered, client }).availability("robinhood-testnet"), { enabled: true, escrow: ESCROW, platforms: ["github", "x", "farcaster", "discord", "telegram"], stockTokens: true, tokens: true, fees });
    assert.deepEqual(await service({ repository: registered, client, supports: (platform) => platform === "github" }).availability("robinhood-testnet"), { enabled: true, escrow: ESCROW, platforms: ["github", "x", "discord", "telegram"], stockTokens: true, tokens: true, fees }, "without X's lookup key, X links wait for the name");
    assert.deepEqual((await service({ repository: registered, client, supports: () => false }).availability("robinhood-testnet")).platforms, ["x", "discord", "telegram"], "names need no lookup");
    assert.deepEqual(await service({ repository: registered, client }).feeSchedule("robinhood-testnet"), fees, "direct payments use the same router");
    assert.equal(await service().feeSchedule("robinhood-testnet"), undefined, "payments stay fee-free until an escrow is registered");
    // The fee contracts must pay the treasury half to the operator and charge exactly 1%, or links stop.
    assert.match((await service({ repository: registered, client: await feeContractsClient({ treasury: PAYER }) }).availability("robinhood-testnet")).reason ?? "", /pay its treasury half to it/);
    assert.match((await service({ repository: registered, client: await feeContractsClient({ feeBps: 200n }) }).availability("robinhood-testnet")).reason ?? "", /reviewed 1% fee split in half/);
    const strangerTreasury = await feeContractsClient({ treasury: PAYER });
    await assert.rejects(() => service({ repository: registered, client: strangerTreasury }).feeSchedule("robinhood-testnet"), /pay its treasury half to it/, "a broken router stops payments instead of skipping the fee");
    const rotated = new MemoryStockClaimRepository();
    await rotated.saveEscrow(escrowRecord({ verifier: PAYER }));
    assert.match((await service({ repository: rotated }).availability("robinhood-testnet")).reason ?? "", /no longer matches this server's settings/);
    const broken: StockClaimRepository = {
      saveEscrow: (record) => registered.saveEscrow(record),
      activeEscrow: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:5432"); },
      escrow: (chainId, address) => registered.escrow(chainId, address),
      saveClaim: (record) => registered.saveClaim(record),
      claim: (chainId, paymentId) => registered.claim(chainId, paymentId),
      waitingFor: (...input) => registered.waitingFor(...input),
      fundedBy: (...input) => registered.fundedBy(...input),
    };
    assert.deepEqual(await service({ repository: broken }).availability("robinhood-testnet"), { enabled: false, reason: "Stock claim links are unavailable right now. Try again shortly." });
  });
});

describe("vault windows", () => {
  const MAINNET_ESCROW = "0x7777777777777777777777777777777777777777" as const;
  const OPERATOR = "0x8888888888888888888888888888888888888888" as const;
  const VERIFIER = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const claims = (lookups: string[]) => new StockClaimService({
    transfers: {
      availability: () => ({ enabled: true, tokens: { enabled: true } }),
      // The escrow's fee contracts answer; the token check after the window check stops the preparation.
      verifiedClient: async (_network, token) => {
        if (token) throw new StockTransferUnavailableError("stop after the window check");
        return feeClient({ escrow: MAINNET_ESCROW, owner: OPERATOR });
      },
      transactionReceipt: async () => { throw new Error("unused"); },
    },
    repository: {
      saveEscrow: async (record) => record,
      activeEscrow: async () => ({ chainId: 4663, escrow: MAINNET_ESCROW, deploymentTransactionHash: `0x${"01".repeat(32)}`, owner: OPERATOR, verifier: VERIFIER.address, blockNumber: 1n, registeredAt: new Date(0).toISOString() }),
      escrow: async () => undefined,
      saveClaim: async (record) => record,
      claim: async () => undefined,
      waitingFor: async () => [],
      fundedBy: async () => [],
    },
    directory: {
      lookup: async (platform, username) => { lookups.push(`${platform}:${username}`); return { platform: "farcaster", providerUserId: "3", username: "dwr" }; },
      supports: () => true,
    },
    config: { operator: OPERATOR, networks: { "robinhood-mainnet": { attestor: VERIFIER, setup: [] }, "robinhood-testnet": { setup: [] } } },
  });
  const input = { network: "robinhood-mainnet" as const, payer: PAYER, token: ROBINHOOD_USDG, amount: "10", platform: "farcaster" as const, username: "dwr" };

  it("lets every sender choose from 24 hours to 30 days, with no token to hold", async () => {
    const lookups: string[] = [];
    for (const expiryHours of [24, ...STOCK_CLAIM_WINDOW_CHOICES]) {
      await assert.rejects(claims(lookups).prepare({ ...input, expiryHours }), /stop after the window check/);
    }
    assert.equal(lookups.length, 5, "every offered window goes on to the lookup");
    assert.deepEqual([...STOCK_CLAIM_WINDOW_CHOICES], [72, 168, 336, 720]);
    for (const expiryHours of [23, 721, 72.5]) {
      await assert.rejects(claims(lookups).prepare({ ...input, expiryHours }), /between 24 hours and 30 days/);
    }
    assert.equal(lookups.length, 5, "a window out of range is refused before any lookup");
  });
});

describe("stock claim HTTP gates", () => {
  it("requires a session, the eligibility statement for mainnet Stock Tokens, and a configured service", async () => {
    const calls: string[] = [];
    const stockClaims = {
      availability: async () => ({ enabled: true, escrow: ESCROW }),
      feeSchedule: async () => undefined,
      deployment: async () => { throw new Error("unused"); },
      register: async () => { calls.push("register"); return {} as never; },
      prepare: async () => { calls.push("prepare"); return {} as never; },
      confirmFunding: async () => { calls.push("confirm"); return {} as never; },
      details: async () => { calls.push("details"); return {} as never; },
      prepareClaim: async (input: { eligibilityConfirmed?: boolean }) => { calls.push(`claim:${input.eligibilityConfirmed}`); return {} as never; },
      prepareRefund: async () => { calls.push("refund"); return {} as never; },
    };
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "stock-claim-gates-secret-with-32-chars" });
    const identities = new VerifiedIdentityService();
    const server = await new Promise<Server>((resolve) => {
      const listener = createApp({ auth, identities, stockClaims }).listen(0, "127.0.0.1", () => resolve(listener));
    });
    const bare = await new Promise<Server>((resolve) => {
      const listener = createApp({ auth, identities }).listen(0, "127.0.0.1", () => resolve(listener));
    });
    const origin = (listener: Server) => {
      const address = listener.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    };
    try {
      const account = privateKeyToAccount(generatePrivateKey());
      const challenge = await (await fetch(`${origin(server)}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: account.address }) })).json() as { id: string; message: string };
      const login = await fetch(`${origin(server)}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const post = (path: string, body: unknown, withSession = true, target = server) => fetch(`${origin(target)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(withSession ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
      });
      const link = { network: "robinhood-testnet", token: { symbol: "TSLA", address: TSLA.address }, amount: "2.5", recipient: { platform: "github", username: "@Octo-New" }, expiryHours: 72 };
      const NVDA = STOCK_TOKEN_ALLOWLISTS["robinhood-mainnet"].tokens.find((token) => token.symbol === "NVDA")!;

      assert.equal((await post("/api/stocks/claims/prepare", link, false)).status, 401);
      assert.equal((await post("/api/stocks/escrow/register", { network: "robinhood-testnet", transactionHash: `0x${"01".repeat(32)}` }, false)).status, 401);
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, recipient: { platform: "email", username: "deniz" } })).status, 400, "only the five platforms");
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, lock: "handle" })).status, 400, "a lock is an account or a name");
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, expiryHours: 800 })).status, 400);
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, token: { symbol: "TSLA", address: NVDA.address } })).status, 400, "allowlist is per network and address");
      const mainnet = await post("/api/stocks/claims/prepare", { ...link, network: "robinhood-mainnet", token: { symbol: "NVDA", address: NVDA.address } });
      assert.equal(mainnet.status, 400);
      assert.match((await mainnet.json() as { error: string }).error, /before a mainnet claim link/);
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, network: "robinhood-mainnet", token: { symbol: "USDG", address: ROBINHOOD_USDG.address }, amount: "25.1234567" })).status, 400, "USDG has six decimals");
      assert.deepEqual(calls, [], "nothing reached the service");

      assert.equal((await post("/api/stocks/claims/prepare", link)).status, 200);
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, recipient: { platform: "farcaster", username: "dwr" } })).status, 200, "Farcaster names resolve to FIDs");
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, recipient: { platform: "telegram", username: "deniz" }, lock: "name" })).status, 200, "a Telegram link waits for the name (2026-10-06)");
      assert.equal((await post("/api/stocks/claims/prepare", { ...link, network: "robinhood-mainnet", token: { symbol: "USDG", address: ROBINHOOD_USDG.address }, amount: "25" })).status, 200, "USDG is not a Stock Token, so no statement");
      // The claim route passes the statement on; the service checks it against the payment's token.
      assert.equal((await post(`/api/stocks/claims/robinhood-mainnet/${PAYMENT_ID}/prepare-claim`, {})).status, 200);
      assert.equal((await post(`/api/stocks/claims/robinhood-mainnet/${PAYMENT_ID}/prepare-claim`, { eligibilityConfirmed: true })).status, 200);
      assert.equal((await post(`/api/stocks/claims/robinhood-testnet/${PAYMENT_ID}/prepare-refund`, {})).status, 200);
      assert.deepEqual(calls, ["prepare", "prepare", "prepare", "prepare", "claim:undefined", "claim:true", "refund"]);

      const unconfigured = await post("/api/stocks/claims/prepare", link, true, bare);
      assert.equal(unconfigured.status, 503);
      assert.deepEqual(await unconfigured.json(), { error: "Stock claim links are not configured on this server." });
      const stocks = await (await fetch(`${origin(bare)}/api/stocks?network=robinhood-testnet`)).json() as { claims: unknown };
      assert.deepEqual(stocks.claims, { enabled: false, reason: "Stock claim links are not configured on this server." });
      assert.equal((await fetch(`${origin(bare)}/api/stocks/escrow`)).status, 503);
      assert.equal((await fetch(`${origin(bare)}/api/stocks/claims/robinhood-testnet/${PAYMENT_ID}`)).status, 503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

describe("stock claim identity key", () => {
  it("matches the escrow's keccak256(abi.encode(platformHash, providerUserIdHash))", () => {
    // Values from the Forge suite: PLATFORM = keccak256("github"), PROVIDER = keccak256("424242").
    assert.equal(stockClaimIdentityKey("github", "424242"), keccak256(`0x${keccak256(stringToHex("github")).slice(2)}${keccak256(stringToHex("424242")).slice(2)}`));
  });
});
