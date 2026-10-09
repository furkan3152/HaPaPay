import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newDb } from "pg-mem";
import { PostgresClaimFundingRepository } from "../server/claim-funding-service";

describe("persistent claim funding metadata", () => {
  it("survives process recreation with source and recipient identities", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool();
    const first = new PostgresClaimFundingRepository(pool);
    await first.migrate();
    const record = {
      chainId: 5_042,
      transactionHash: `0x${"cd".repeat(32)}` as const,
      paymentId: `0x${"ab".repeat(32)}` as const,
      payer: "0x4444444444444444444444444444444444444444" as const,
      recipientPlatform: "github" as const,
      recipientUsername: "outside-user",
      amount: "3.25",
      expiry: 1_789_560_000n,
      blockNumber: 77n,
      confirmedAt: "2026-09-13T12:00:00.000Z",
      sourceIdentity: { platform: "github" as const, username: "ada" },
    };
    await first.save(record);
    const restarted = new PostgresClaimFundingRepository(pool);
    assert.deepEqual(await restarted.get(5_042, record.paymentId), record);
    assert.equal(await restarted.get(5_042_002, record.paymentId), undefined, "another Arc chain never reads it");
    await pool.end();
  });
});
