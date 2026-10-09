import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newDb } from "pg-mem";
import { PostgresTransientStateStore } from "../server/transient-state-store";

describe("persistent transient security state seam", () => {
  it("survives service recreation and atomically consumes a state once", async () => {
    const memoryDb = newDb();
    const adapter = memoryDb.adapters.createPg();
    const pool = new adapter.Pool();
    const first = new PostgresTransientStateStore(pool);
    await first.migrate();
    await first.put("oauth", "one-time-state", { wallet: "0xabc", provider: "github" }, Date.now() + 60_000);

    const second = new PostgresTransientStateStore(pool);
    assert.deepEqual(await second.get("oauth", "one-time-state"), { wallet: "0xabc", provider: "github" });
    assert.deepEqual(await second.take("oauth", "one-time-state"), { wallet: "0xabc", provider: "github" });
    assert.equal(await first.take("oauth", "one-time-state"), undefined);
  });

  it("does not return expired state", async () => {
    const memoryDb = newDb();
    const adapter = memoryDb.adapters.createPg();
    const pool = new adapter.Pool();
    const store = new PostgresTransientStateStore(pool);
    await store.migrate();
    await store.put("wallet", "expired", { value: true }, Date.now() - 1);
    assert.equal(await store.get("wallet", "expired"), undefined);
    assert.equal(await store.take("wallet", "expired"), undefined);
  });
});
