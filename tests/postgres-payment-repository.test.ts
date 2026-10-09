import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newDb } from "pg-mem";
import { PostgresPaymentRepository } from "../server/payment-history-service";

describe("persistent Arc payment history repository", () => {
  it("survives process recreation for both sides of a verified transfer", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool();
    const first = new PostgresPaymentRepository(pool);
    await first.migrate();
    const record = {
      chainId: 5_042,
      transactionHash: `0x${"ab".repeat(32)}` as const,
      sender: "0x1111111111111111111111111111111111111111" as const,
      recipient: "0x2222222222222222222222222222222222222222" as const,
      platform: "github" as const,
      username: "octocat",
      amount: "12.5",
      blockNumber: 9123n,
      confirmedAt: "2026-09-13T11:00:00.000Z",
    };
    await first.save(record);
    await assert.rejects(() => first.save(record), /already confirmed/);

    const restarted = new PostgresPaymentRepository(pool);
    assert.deepEqual(await restarted.list(5_042, record.sender), [record]);
    assert.deepEqual(await restarted.list(5_042, record.recipient), [record]);
    assert.deepEqual(await restarted.list(5_042_002, record.sender), [], "another Arc chain never lists it");
    await pool.end();
  });

  it("labels rows recorded before payments carried their chain as Arc Testnet", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool();
    const repository = new PostgresPaymentRepository(pool);
    await repository.migrate();
    // An insert by code from before the chain column, as the live release runs while the migration lands.
    await pool.query(`INSERT INTO arc_payments (transaction_hash, sender_address, recipient_address, platform, username_normalized, amount_text, block_number, confirmed_at)
      VALUES ('0x${"cd".repeat(32)}', '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 'github', 'octocat', '1', 5, '2026-09-14T00:00:00.000Z')`);
    const [legacy] = await repository.list(5_042_002, "0x1111111111111111111111111111111111111111");
    assert.equal(legacy.chainId, 5_042_002);
    assert.deepEqual(await repository.list(5_042, "0x1111111111111111111111111111111111111111"), []);
    await pool.end();
  });
});
