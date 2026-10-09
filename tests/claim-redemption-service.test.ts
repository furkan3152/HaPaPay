import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters, recoverMessageAddress, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ClaimRedemptionService, claimActionsAbi } from "../server/claim-redemption-service";

const paymentId = `0x${"ab".repeat(32)}` as const;
const escrow = "0x3333333333333333333333333333333333333333" as const;
const payer = "0x4444444444444444444444444444444444444444" as const;
const recipient = "0x5555555555555555555555555555555555555555" as const;
const usdc = "0x3600000000000000000000000000000000000000" as const;
const attestor = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const identityKey = keccak256(new Uint8Array([
  ...hexBytes(keccak256(stringToHex("github"))),
  ...hexBytes(keccak256(stringToHex("424242"))),
]));

describe("claim and refund preparation", () => {
  it("returns public escrow details using six-decimal USDC accounting", async () => {
    const service = new ClaimRedemptionService({
      chainId: 9_999_999, escrow, usdc, attestor,
      readPayment: async () => ({ payer, token: usdc, identityKey, amount: 3_250_000n, fee: 32_500n, expiry: 1_789_560_000n }),
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    assert.deepEqual(await service.details(paymentId), {
      paymentId,
      payer,
      amount: "3.25",
      fee: "0.0325",
      expiresAt: "2026-09-16T12:00:00.000Z",
      status: "claimable",
    });
  });

  it("refuses an attestor that is not the escrow's configured verifier", () => {
    assert.throws(() => new ClaimRedemptionService({
      chainId: 9_999_999,
      escrow,
      usdc,
      expectedVerifier: "0x9999999999999999999999999999999999999999",
      attestor,
      readPayment: async () => ({ payer, token: usdc, identityKey, amount: 1n, fee: 0n, expiry: 1_800_000_000n }),
    }), /does not match the escrow verifier/);
  });

  it("signs a claim only for a wallet with the matching OAuth-verified immutable identity, binding the escrow's token", async () => {
    const service = new ClaimRedemptionService({
      chainId: 9_999_999,
      escrow,
      usdc,
      attestor,
      readPayment: async () => ({ payer, token: usdc, identityKey, amount: 2_500_000n, fee: 25_000n, expiry: 1_789_560_000n }),
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const result = await service.prepareClaim(recipient, [{ platform: "github", providerUserId: "424242", username: "alice", verifiedAt: "2026-09-13T00:00:00.000Z" }], paymentId);
    const decoded = decodeFunctionData({ abi: claimActionsAbi, data: result.transaction.data });
    assert.equal(decoded.functionName, "claim");
    assert.equal(decoded.args?.[0], paymentId);
    assert.equal(decoded.args?.[1], recipient);
    assert.equal(decoded.args?.[2], 1_789_301_400n);
    // The reviewed StockClaimEscrow's attestation: chain, escrow, payment, identity, token, recipient, amount, expiry, deadline.
    const attestation = keccak256(encodeAbiParameters(
      parseAbiParameters("uint256, address, bytes32, bytes32, address, address, uint256, uint256, uint256"),
      [9_999_999n, escrow, paymentId, identityKey, usdc, recipient, 2_500_000n, 1_789_560_000n, 1_789_301_400n],
    ));
    assert.equal(await recoverMessageAddress({ message: { raw: attestation }, signature: decoded.args?.[3] as `0x${string}` }), attestor.address);
  });

  it("refuses a link the escrow holds in any token other than USDC", async () => {
    const service = new ClaimRedemptionService({
      chainId: 9_999_999, escrow, usdc, attestor,
      readPayment: async () => ({ payer, token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", identityKey, amount: 1n, fee: 0n, expiry: 1_789_560_000n }),
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    await assert.rejects(() => service.details(paymentId), /not an Arc USDC link/);
  });

  it("rejects a different verified social identity", async () => {
    const service = new ClaimRedemptionService({
      chainId: 9_999_999, escrow, usdc, attestor,
      readPayment: async () => ({ payer, token: usdc, identityKey, amount: 1n, fee: 0n, expiry: 1_789_560_000n }),
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    await assert.rejects(() => service.prepareClaim(recipient, [{ platform: "github", providerUserId: "999", username: "alice", verifiedAt: "2026-09-13T00:00:00.000Z" }], paymentId), /do not match/);
  });

  it("prepares refund only for the payer after expiry", async () => {
    const service = new ClaimRedemptionService({
      chainId: 9_999_999, escrow, usdc, attestor,
      readPayment: async () => ({ payer, token: usdc, identityKey, amount: 1n, fee: 0n, expiry: 1_789_000_000n }),
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    const result = await service.prepareRefund(payer, paymentId);
    assert.equal(decodeFunctionData({ abi: claimActionsAbi, data: result.transaction.data }).functionName, "refund");
    await assert.rejects(() => service.prepareRefund(recipient, paymentId), /Only the payer/);
  });
});

function hexBytes(value: `0x${string}`) {
  return Buffer.from(value.slice(2), "hex");
}
