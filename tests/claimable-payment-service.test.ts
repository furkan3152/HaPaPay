import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, keccak256, parseUnits, stringToHex } from "viem";
import { ClaimablePaymentService } from "../server/claimable-payment-service";
import { RecipientLookupUnavailableError } from "../server/recipient-discovery";
import { StockTransferRejectedError, StockTransferUnavailableError } from "../server/stock-transfer-service";
import { VaultNameLockOffer } from "../server/vault-recipient";
import { stockClaimEscrowAbi, stockTokenApproveAbi } from "../src/domain/stock-claims";
import type { FeeSchedule } from "../src/domain/fees";

const USDC = "0x1111111111111111111111111111111111111111" as const;
const ESCROW = "0x3333333333333333333333333333333333333333" as const;
const PAYER = "0x4444444444444444444444444444444444444444" as const;
const FEES: FeeSchedule = {
  router: "0x5555555555555555555555555555555555555555",
  burnVault: "0x6666666666666666666666666666666666666666",
  treasury: "0x7777777777777777777777777777777777777777",
  feeBps: 100,
  burnShareBps: 5000,
  sink: "forwarder",
};

/** The payer's USDC balance in the mocks: enough for every link here. */
const BALANCE = parseUnits("1000", 6);

/** A router that quotes `bps` for every payer, as `feeBpsFor` does on chain, beside the payer's USDC balance. */
const router = (bps: bigint, reads: string[] = []) => ({
  readContract: async (call: { address: string; functionName: string; args?: readonly unknown[] }) => {
    reads.push(`${call.address}:${call.functionName}:${String(call.args?.[0])}`);
    return call.functionName === "balanceOf" ? BALANCE : bps;
  },
});

describe("claimable payment preparation", () => {
  it("funds the reviewed escrow with USDC for an officially resolved immutable identity and approves the amount plus the fee", async () => {
    const reads: string[] = [];
    const service = new ClaimablePaymentService({
      usdc: USDC,
      escrow: ESCROW,
      fees: FEES,
      client: router(100n, reads) as never,
      chainName: "Arc Mainnet",
      directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "alice" }) },
      now: () => new Date("2026-09-13T12:00:00.000Z"),
      randomBytes32: () => `0x${"ab".repeat(32)}`,
    });

    const result = await service.prepare({ platform: "github", username: "Alice", amount: "12.5", expiryHours: 72, payer: PAYER });
    assert.equal(result.identity.providerUserId, "424242");
    assert.equal(result.identity.username, "alice");
    assert.equal(result.expiresAt, "2026-09-16T12:00:00.000Z");
    assert.equal(result.escrow, ESCROW);
    assert.deepEqual(reads, [`${FEES.router}:feeBpsFor:${PAYER}`, `${USDC}:allowance:${PAYER}`, `${USDC}:balanceOf:${PAYER}`], "the fee is the router's rate for this payer, and the payer's approval and balance are read too");
    assert.deepEqual(result.fee, {
      router: FEES.router,
      feeBps: 100,
      units: "125000",
      amount: "0.125",
      burnShare: "62500",
      treasuryShare: "62500",
      totalUnits: "12625000",
      totalAmount: "12.625",
    });
    assert.equal(result.transactions.length, 2);
    assert.equal(result.transactions[0].to, USDC);
    assert.equal(result.transactions[1].to, ESCROW);

    const approval = decodeFunctionData({ abi: stockTokenApproveAbi, data: result.transactions[0].data });
    assert.deepEqual(approval.args, [ESCROW, parseUnits("12.625", 6)]);
    const creation = decodeFunctionData({ abi: stockClaimEscrowAbi, data: result.transactions[1].data });
    assert.equal(creation.functionName, "createPayment");
    assert.deepEqual(creation.args, [
      `0x${"ab".repeat(32)}`,
      USDC,
      keccak256(stringToHex("github")),
      keccak256(stringToHex("424242")),
      parseUnits("12.5", 6),
      1_789_560_000n,
    ]);
  });

  it("leaves the approval out when one from an earlier attempt already covers the amount plus the fee", async () => {
    const reader = {
      readContract: async (call: { functionName: string }) => call.functionName === "allowance" ? parseUnits("12.625", 6) : call.functionName === "balanceOf" ? BALANCE : 100n,
    };
    const service = new ClaimablePaymentService({
      usdc: USDC, escrow: ESCROW, fees: FEES, client: reader as never, chainName: "Arc Mainnet",
      directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "alice" }) },
    });
    const result = await service.prepare({ platform: "github", username: "alice", amount: "12.5", expiryHours: 72, payer: PAYER });
    assert.deepEqual(result.transactions.map((transaction) => transaction.purpose), ["fund"]);
    const short = new ClaimablePaymentService({
      usdc: USDC, escrow: ESCROW, fees: FEES, chainName: "Arc Mainnet",
      client: { readContract: async (call: { functionName: string }) => call.functionName === "allowance" ? parseUnits("12.624999", 6) : call.functionName === "balanceOf" ? BALANCE : 100n } as never,
      directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "alice" }) },
    });
    assert.deepEqual((await short.prepare({ platform: "github", username: "alice", amount: "12.5", expiryHours: 72, payer: PAYER })).transactions.map((transaction) => transaction.purpose), ["approve", "fund"], "one unit short asks for the approval again");
  });

  it("charges a lower holder rate and nothing on amounts too small to round to a fee", async () => {
    const service = new ClaimablePaymentService({
      usdc: USDC, escrow: ESCROW, fees: FEES, client: router(50n) as never, chainName: "Arc Mainnet",
      directory: { lookup: async () => ({ platform: "x", providerUserId: "7", username: "alice" }) },
    });
    const half = await service.prepare({ platform: "x", username: "alice", amount: "10", expiryHours: 24, payer: PAYER });
    assert.equal(half.fee.feeBps, 50);
    assert.equal(half.fee.units, "50000");
    const tiny = await service.prepare({ platform: "x", username: "alice", amount: "0.000099", expiryHours: 24, payer: PAYER });
    assert.equal(tiny.fee.units, "0");
    assert.deepEqual(decodeFunctionData({ abi: stockTokenApproveAbi, data: tiny.transactions[0].data }).args, [ESCROW, 99n]);
  });

  it("refuses a link the wallet cannot pay for with the fee and the gas both signatures take in USDC", async () => {
    // Audit, 2026-10-06: Arc takes gas in USDC from the same balance, and a short balance only showed as a reverted funding.
    const holding = (balance: bigint, gasReserve?: () => Promise<bigint>) => new ClaimablePaymentService({
      usdc: USDC, escrow: ESCROW, fees: FEES, chainName: "Arc Mainnet", gasReserve,
      client: { readContract: async (call: { functionName: string }) => call.functionName === "balanceOf" ? balance : call.functionName === "allowance" ? 0n : 100n } as never,
      directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "alice" }) },
    });
    const link = { platform: "github" as const, username: "alice", amount: "10", expiryHours: 24, payer: PAYER };
    assert.equal((await holding(parseUnits("10.1", 6)).prepare(link)).transactions.length, 2, "the amount and the fee, with no gas price to read");
    await assert.rejects(() => holding(parseUnits("10.099999", 6)).prepare(link), /holds 10.099999 USDC; this link needs 10.1 USDC: the amount plus the fee\./);
    await assert.rejects(() => holding(parseUnits("10.1", 6), async () => 34_000n).prepare(link), /needs 10.134 USDC: the amount plus the fee and about 0.034 USDC for gas/);
    assert.equal((await holding(parseUnits("10.134", 6), async () => 34_000n).prepare(link)).transactions.length, 2);
  });

  it("refuses a router quote above 1% and unsafe or excessively long escrow windows", async () => {
    const greedy = new ClaimablePaymentService({
      usdc: USDC, escrow: ESCROW, fees: FEES, client: router(101n) as never, chainName: "Arc Mainnet",
      directory: { lookup: async () => ({ platform: "x", providerUserId: "7", username: "alice" }) },
    });
    await assert.rejects(() => greedy.prepare({ platform: "x", username: "alice", amount: "1", expiryHours: 24, payer: PAYER }), /quoted an unexpected fee/);
    await assert.rejects(() => greedy.prepare({ platform: "x", username: "alice", amount: "1", expiryHours: 24 * 31, payer: PAYER }), /between 24 hours and 30 days/);
  });

  it("says why the account could not be looked up instead of a fixed failure", async () => {
    // When X refuses every lookup, the vault slip's answer says why.
    const service = (lookup: () => Promise<never>) => new ClaimablePaymentService({
      usdc: USDC, escrow: ESCROW, fees: FEES, client: router(100n) as never, chainName: "Arc Mainnet", directory: { lookup },
    });
    const prepare = (lookup: () => Promise<never>, platform: "x" | "github" = "x") => service(lookup).prepare({ platform, username: "newcomer", amount: "1", expiryHours: 72, payer: PAYER });
    const refused = "GitHub is not answering account lookups for HaPaPay right now, so the money cannot be locked to a GitHub account in the vault.";
    await assert.rejects(prepare(async () => { throw new RecipientLookupUnavailableError(refused); }, "github"), (error) => error instanceof StockTransferUnavailableError && error.message === refused);
    // X not answering offers the X name instead (2026-10-06): the slip asks the sender before anything is signed.
    await assert.rejects(prepare(async () => { throw new RecipientLookupUnavailableError("X is not answering."); }), (error) => error instanceof VaultNameLockOffer && error.lock === "name" && /lock it to the X name @newcomer instead/.test(error.message));
    await assert.rejects(prepare(async () => { throw new Error("X account was not found."); }), (error) => error instanceof StockTransferRejectedError && error.message === "X account was not found.");
    await assert.rejects(prepare(async () => { throw new Error("socket hang up at 10.0.0.1"); }), (error) => error instanceof StockTransferUnavailableError && !/10\.0\.0\.1/.test(error.message), "anything else stays a fixed message");
  });
});
