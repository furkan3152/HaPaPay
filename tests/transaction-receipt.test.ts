import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitForTransactionReceipt } from "../src/domain/transaction-receipt";

describe("transaction lifecycle seam", () => {
  it("reports success only after a successful receipt exists", async () => {
    const receipts = [null, null, { status: "0x1", blockNumber: "0x2a" }];
    const result = await waitForTransactionReceipt(
      async () => receipts.shift() ?? null,
      { attempts: 3, intervalMs: 0 },
    );
    assert.deepEqual(result, { status: "confirmed", blockNumber: "0x2a" });
  });

  it("keeps a deployment's contract address, which the operator pages read to chain their deployments", async () => {
    const result = await waitForTransactionReceipt(
      async () => ({ status: "0x1", blockNumber: "0x2c", contractAddress: "0x1111111111111111111111111111111111111111" }),
      { attempts: 1, intervalMs: 0 },
    );
    assert.equal(result.status, "confirmed");
    assert.equal(result.contractAddress, "0x1111111111111111111111111111111111111111");
  });

  it("does not label a reverted receipt as a completed payment", async () => {
    await assert.rejects(
      waitForTransactionReceipt(async () => ({ status: "0x0", blockNumber: "0x2b" }), { attempts: 1, intervalMs: 0 }),
      /reverted/,
    );
  });
});
