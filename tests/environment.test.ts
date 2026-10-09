import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadEnvironmentFile } from "../server/environment";

const created: string[] = [];

afterEach(async () => {
  delete process.env.HAPAPAY_ENV_TEST;
  delete process.env.HAPAPAY_EXISTING_TEST;
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime environment file seam", () => {
  it("loads server-only configuration from a selected env file without replacing shell secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hapapay-env-"));
    created.push(directory);
    const path = join(directory, ".env");
    await writeFile(path, "HAPAPAY_ENV_TEST=from-file\nHAPAPAY_EXISTING_TEST=from-file\n", "utf8");
    process.env.HAPAPAY_EXISTING_TEST = "from-shell";

    const result = loadEnvironmentFile(path);

    assert.equal(result.loaded, true);
    assert.equal(process.env.HAPAPAY_ENV_TEST, "from-file");
    assert.equal(process.env.HAPAPAY_EXISTING_TEST, "from-shell");
  });

  it("allows a missing local env file while production validation remains separate", () => {
    assert.deepEqual(loadEnvironmentFile("/definitely/missing/hapapay.env"), { loaded: false });
  });
});
