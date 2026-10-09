import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, keccak256, padHex, parseAbiParameters, parseUnits, stringToHex, toEventSelector, type Hex } from "viem";
import { ClaimFundingService, MemoryClaimFundingRepository } from "../server/claim-funding-service";

const escrow = "0x3333333333333333333333333333333333333333" as const;
const usdc = "0x3600000000000000000000000000000000000000" as const;
const payer = "0x4444444444444444444444444444444444444444" as const;
const paymentId = `0x${"ab".repeat(32)}` as const;
const transactionHash = `0x${"cd".repeat(32)}` as const;
const platformHash = keccak256(stringToHex("github"));
const providerHash = keccak256(stringToHex("424242"));
const identityKey = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [platformHash, providerHash]));
/** The reviewed StockClaimEscrow's funding event, which Arc shares with Robinhood Chain. */
const PAYMENT_CREATED = toEventSelector("PaymentCreated(bytes32,address,bytes32,address,uint256,uint256,uint256)");

const funding = (data: { token?: `0x${string}`; amount?: bigint; fee?: bigint; expiry?: bigint; key?: Hex } = {}) => ({
  getTransactionReceipt: async () => ({
    status: "success" as const, from: payer, blockNumber: 77n,
    logs: [{
      address: escrow,
      topics: [PAYMENT_CREATED, paymentId, padHex(payer, { size: 32 }), data.key ?? identityKey] as Hex[],
      data: encodeAbiParameters(parseAbiParameters("address, uint256, uint256, uint256"), [
        data.token ?? usdc, data.amount ?? parseUnits("3.25", 6), data.fee ?? 32_500n, data.expiry ?? 1_789_560_000n,
      ]),
    }],
  }),
});

const service = (client: ReturnType<typeof funding>, repository = new MemoryClaimFundingRepository(), providerUserId = "424242") => new ClaimFundingService({
  chainId: 5_042,
  escrow,
  usdc,
  repository,
  directory: { lookup: async () => ({ platform: "github", providerUserId, username: "outside-user" }) },
  client,
  now: () => new Date("2026-09-13T12:00:00.000Z"),
});

describe("server-verified claim funding", () => {
  it("records metadata, on its own chain, only after the exact escrow PaymentCreated log verifies", async () => {
    const repository = new MemoryClaimFundingRepository();
    const record = await service(funding(), repository).confirm({ transactionHash, paymentId, payer, platform: "github", username: "outside-user", amount: "3.25", sourceIdentity: { platform: "github", username: "ada" } });
    assert.equal(record.status, "funded");
    assert.equal(record.claimPath, `/claim/${paymentId}`);
    assert.deepEqual((await repository.get(5_042, paymentId))?.sourceIdentity, { platform: "github", username: "ada" });
    assert.equal(await repository.get(5_042_002, paymentId), undefined, "a link is never read back on another Arc chain");
  });

  it("rejects a receipt with a different immutable recipient identity", async () => {
    await assert.rejects(() => service(funding(), new MemoryClaimFundingRepository(), "999").confirm({ transactionHash, paymentId, payer, platform: "github", username: "outside-user", amount: "3.25" }), /exact reviewed escrow funding/);
  });

  it("rejects a link funded in another token, for another amount, or with a fee above 1%", async () => {
    for (const changed of [
      { token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const },
      { amount: parseUnits("3.24", 6) },
      { fee: 32_501n },
    ]) {
      await assert.rejects(() => service(funding(changed)).confirm({ transactionHash, paymentId, payer, platform: "github", username: "outside-user", amount: "3.25" }), /exact reviewed escrow funding/, JSON.stringify(changed, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    }
  });
});
