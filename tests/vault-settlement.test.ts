import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiParameters, type Address, type Hex } from "viem";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims";
import { stockClaimIdentityKey } from "../server/stock-claim-service";
import { evmVaultSettlement, SETTLED_BEFORE_EXPIRY_MARGIN_SECONDS, type SettlementReceipt } from "../server/vault-settlement";
import type { VerifiedSocialAccount } from "../server/verified-identity-service";

const ESCROW = getAddress("0x8a7e4e1b6f1ca842a9b84e5cb18a46edf2ceb789");
const OTHER_ESCROW = getAddress("0x6666666666666666666666666666666666666666");
const PAYER = getAddress("0x4444444444444444444444444444444444444444");
const CLAIMER = getAddress("0x5555555555555555555555555555555555555555");
const TOKEN = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const PAYMENT = `0x${"ab".repeat(32)}` as Hex;
const FUNDING = `0x${"0f".repeat(32)}` as Hex;
const CLAIM = `0x${"0c".repeat(32)}` as Hex;
const NOW = 1_790_000_000n;
const OCTOCAT: VerifiedSocialAccount = { platform: "github", providerUserId: "583231", username: "octocat", verifiedAt: "2026-10-03T09:00:00.000Z" };
const ZERO = "0x0000000000000000000000000000000000000000";

const created = (escrow: Address, identityKey: Hex) => ({
  address: escrow,
  topics: encodeEventTopics({ abi: stockClaimEscrowAbi, eventName: "PaymentCreated", args: { paymentId: PAYMENT, payer: PAYER, identityKey } }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("address, uint256, uint256, uint256"), [TOKEN, 10_000_000n, 100_000n, NOW + 86_400n]),
});
const claimed = (escrow: Address, recipient: Address) => ({
  address: escrow,
  topics: encodeEventTopics({ abi: stockClaimEscrowAbi, eventName: "PaymentClaimed", args: { paymentId: PAYMENT, recipient, token: TOKEN } }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10_000_000n, 100_000n]),
});

function settle(input: { payer?: Address; expiry?: bigint; receipts?: Record<string, SettlementReceipt | null>; claimTransaction?: Hex; candidates?: Array<{ wallet: Address; accounts: VerifiedSocialAccount[] }> }) {
  return evmVaultSettlement({
    escrow: ESCROW,
    paymentId: PAYMENT,
    expiry: input.expiry ?? NOW + 86_400n,
    fundingTransaction: FUNDING,
    claimTransaction: input.claimTransaction,
    candidates: input.candidates ?? [{ wallet: CLAIMER, accounts: [OCTOCAT] }],
    now: NOW,
    readPayer: async () => input.payer ?? ZERO,
    readReceipt: async (hash) => input.receipts?.[hash] ?? null,
    identityKeys: (account) => account.platform === "github" ? [stockClaimIdentityKey("github", account.providerUserId)] : [],
  });
}

/** How SP learns a vault link was claimed on Arc and Robinhood Chain. */
describe("EVM vault link settlement", () => {
  const key = stockClaimIdentityKey("github", OCTOCAT.providerUserId);

  it("takes the claimer from the claim receipt's event, from this escrow only", async () => {
    const success = (log: ReturnType<typeof claimed>): SettlementReceipt => ({ status: "success", from: CLAIMER, logs: [log] });
    assert.deepEqual(await settle({ claimTransaction: CLAIM, receipts: { [CLAIM]: success(claimed(ESCROW, CLAIMER)) }, payer: PAYER }), { state: "claimed", claimer: CLAIMER });
    // Another escrow's event, a reverted transaction or no receipt say nothing; the payment is still in the vault.
    assert.deepEqual(await settle({ claimTransaction: CLAIM, receipts: { [CLAIM]: success(claimed(OTHER_ESCROW, CLAIMER)) }, payer: PAYER }), { state: "open" });
    assert.deepEqual(await settle({ claimTransaction: CLAIM, receipts: { [CLAIM]: { status: "reverted", from: CLAIMER, logs: [claimed(ESCROW, CLAIMER)] } }, payer: PAYER }), { state: "open" });
    assert.deepEqual(await settle({ claimTransaction: CLAIM, payer: PAYER }), { state: "open" });
  });

  it("reads a link the escrow forgot while its window is open as claimed, by whoever holds the account it was locked to", async () => {
    const funding: SettlementReceipt = { status: "success", from: PAYER, logs: [created(ESCROW, key)] };
    assert.deepEqual(await settle({ receipts: { [FUNDING]: funding } }), { state: "claimed", claimer: CLAIMER });
    assert.deepEqual(await settle({ receipts: { [FUNDING]: funding }, candidates: [{ wallet: CLAIMER, accounts: [{ ...OCTOCAT, providerUserId: "1" }] }] }), { state: "claimed", claimer: null }, "a renamed handle's new owner did not claim it");
  });

  it("says unknown when a refund could explain it or the link was funded elsewhere", async () => {
    const funding: SettlementReceipt = { status: "success", from: PAYER, logs: [created(ESCROW, key)] };
    assert.deepEqual(await settle({ expiry: NOW + SETTLED_BEFORE_EXPIRY_MARGIN_SECONDS, receipts: { [FUNDING]: funding } }), { state: "unknown" });
    assert.deepEqual(await settle({ expiry: NOW - 1n, receipts: { [FUNDING]: funding } }), { state: "unknown" });
    assert.deepEqual(await settle({ receipts: { [FUNDING]: { status: "success", from: PAYER, logs: [created(OTHER_ESCROW, key)] } } }), { state: "unknown" }, "the network's escrow changed since");
    assert.deepEqual(await settle({}), { state: "unknown" }, "no funding receipt");
  });
});
