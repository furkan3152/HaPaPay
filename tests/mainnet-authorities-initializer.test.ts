import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { initializeMainnetAuthorities } from "../scripts/init-mainnet-authorities";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Arc Mainnet authority initializer", () => {
  it("creates the two Arc Mainnet attestor keys under their own names, privately, without a deployer key", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "hapapay-mainnet-"));
    temporaryDirectories.push(parentDirectory);
    const outputDirectory = join(parentDirectory, "HaPaPay Mainnet Credentials");

    const output = await initializeMainnetAuthorities({
      outputDirectory,
      now: () => new Date("2026-10-03T06:00:00.000Z"),
    });
    const environment = parse(await readFile(output.attestorEnvPath));
    const accounts = JSON.parse(await readFile(output.accountsPath, "utf8")) as Record<string, unknown>;

    const keys = [environment.ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY, environment.ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY];
    keys.forEach((key) => assert.match(key, /^0x[0-9a-f]{64}$/u));
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(Object.keys(environment).sort(), ["ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY", "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY"]);
    assert.equal(accounts.identityAttestor, privateKeyToAccount(environment.ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY as `0x${string}`).address);
    assert.equal(accounts.claimAttestor, privateKeyToAccount(environment.ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY as `0x${string}`).address);
    assert.doesNotMatch(JSON.stringify(accounts), /private.?key|secret/iu);
    assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(output.attestorEnvPath)).mode & 0o777, 0o600);
    assert.equal((await stat(output.accountsPath)).mode & 0o777, 0o600);
  });

  it("refuses to replace an existing credential package", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "hapapay-mainnet-"));
    temporaryDirectories.push(parentDirectory);
    const outputDirectory = join(parentDirectory, "HaPaPay Mainnet Credentials");
    await writeFile(outputDirectory, "preserve-me", { mode: 0o600 });

    await assert.rejects(
      initializeMainnetAuthorities({ outputDirectory }),
      /already exists/iu,
    );
    assert.equal(await readFile(outputDirectory, "utf8"), "preserve-me");
  });
});
