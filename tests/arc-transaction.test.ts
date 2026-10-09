import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arcGasReserve, buildArcUsdcTransfer, walletRpcTransaction } from "../src/domain/arc-transaction";

describe("Arc transaction preparation seam", () => {
  it("encodes an ERC-20 USDC transfer with six-decimal accounting", () => {
    assert.deepEqual(
      buildArcUsdcTransfer({
        usdc: "0x1111111111111111111111111111111111111111",
        recipient: "0x2222222222222222222222222222222222222222",
        amount: "12.50",
      }),
      {
      to: "0x1111111111111111111111111111111111111111",
      data: "0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000bebc20",
      value: "0x0",
      },
    );
  });

  it("keeps twice the gas of every call aside in six-decimal USDC, rounded up", () => {
    // Arc takes gas in native 18-decimal USDC from the balance the six-decimal interface shows (audit, 2026-10-06).
    const gwei = 1_000_000_000n;
    assert.equal(arcGasReserve(160n * gwei, { approvals: 1, payments: 1 }), 89_600n, "0.0896 USDC at 160 gwei for an approval and a payment");
    assert.equal(arcGasReserve(160n * gwei, { approvals: 0, payments: 3 }), 192_000n);
    assert.equal(arcGasReserve(1n, { approvals: 0, payments: 1 }), 1n, "a fraction of a unit still reserves one");
    assert.equal(arcGasReserve(0n, { approvals: 1, payments: 1 }), 0n);
  });

  it("requires the caller to supply the network-approved USDC address", () => {
    assert.throws(() => buildArcUsdcTransfer({
      usdc: "not-an-address" as `0x${string}`,
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "1",
    }), /address/i);
  });

  it("removes UI metadata before sending a transaction to the wallet RPC", () => {
    assert.deepEqual(walletRpcTransaction({
      purpose: "approve",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: "0x0",
    }), {
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      data: "0x1234",
      value: "0x0",
    });
  });
});
