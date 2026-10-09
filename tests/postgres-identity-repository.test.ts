import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newDb } from "pg-mem";
import { PostgresIdentityRepository } from "../server/postgres-identity-repository";

describe("persistent identity repository seam", () => {
  it("survives service recreation and rejects a second wallet claiming the provider account", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool();
    const firstProcess = new PostgresIdentityRepository(pool);
    await firstProcess.migrate();
    await firstProcess.link("0x1111111111111111111111111111111111111111", {
      platform: "github",
      providerUserId: "583231",
      username: "Arc-Builder",
      verifiedAt: "2026-09-13T10:00:00.000Z",
    });

    const restartedProcess = new PostgresIdentityRepository(pool);
    assert.equal(
      await restartedProcess.resolve("github", "@ARC-BUILDER"),
      "0x1111111111111111111111111111111111111111",
    );
    assert.deepEqual(
      await restartedProcess.account("0x1111111111111111111111111111111111111111", "github"),
      { platform: "github", providerUserId: "583231", username: "arc-builder", verifiedAt: "2026-09-13T10:00:00.000Z" },
    );
    await assert.rejects(
      restartedProcess.link("0x2222222222222222222222222222222222222222", {
        platform: "github",
        providerUserId: "583231",
        username: "Arc-Builder",
        verifiedAt: "2026-09-13T10:01:00.000Z",
      }),
      /already linked/,
    );
    await pool.end();
  });

  it("removes a handle from payment resolution through the store interface", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool();
    const repository = new PostgresIdentityRepository(pool);
    await repository.migrate();
    await repository.link("0x1111111111111111111111111111111111111111", {
      platform: "telegram",
      providerUserId: "tg-91",
      username: "arc-user",
      verifiedAt: "2026-09-13T10:00:00.000Z",
    });

    const profile = await repository.unlink("0x1111111111111111111111111111111111111111", "telegram");
    assert.deepEqual(profile?.accounts, []);
    assert.equal(await repository.resolve("telegram", "arc-user"), undefined);
    await pool.end();
  });

  it("moves a handle that changed hands to the account a fresh sign-in proves holds it now", async () => {
    const database = newDb();
    const pool = new (database.adapters.createPg().Pool)();
    const repository = new PostgresIdentityRepository(pool);
    await repository.migrate();
    const earlier = "0x1111111111111111111111111111111111111111";
    const now = "0x2222222222222222222222222222222222222222";
    await repository.link(earlier, { platform: "x", providerUserId: "1001", username: "coolname", verifiedAt: "2026-09-13T10:00:00.000Z" });
    await repository.link(now, { platform: "x", providerUserId: "2002", username: "coolname", verifiedAt: "2026-10-06T10:00:00.000Z" });
    assert.equal(await repository.resolve("x", "coolname"), now);
    assert.equal((await repository.account(earlier, "x"))?.username, "#1001");
    await repository.link(earlier, { platform: "x", providerUserId: "1001", username: "renamed", verifiedAt: "2026-10-06T11:00:00.000Z" });
    assert.equal(await repository.resolve("x", "renamed"), earlier);
    await assert.rejects(repository.link(now, { platform: "x", providerUserId: "1001", username: "renamed", verifiedAt: "2026-10-06T12:00:00.000Z" }), /already linked/, "an account stays with its wallet");
    await pool.end();
  });
});
