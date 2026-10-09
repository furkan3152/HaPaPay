import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { parse } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { initializeTestnetEnvironment } from "../scripts/init-testnet-environment";

const temporaryDirectories: string[] = [];
const templatePath = fileURLToPath(new URL("../.env.example", import.meta.url));

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Arc Testnet environment initializer", () => {
  it("creates separated testnet authorities without exposing the owner key in the runtime env", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hapapay-env-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    const secretsDirectory = join(directory, ".secrets");

    const output = await initializeTestnetEnvironment({
      templatePath,
      envPath,
      secretsDirectory,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });
    const environment = parse(await readFile(envPath));
    const ownerPrivateKey = (await readFile(output.ownerKeyPath, "utf8")).trim() as `0x${string}`;
    const accounts = JSON.parse(await readFile(output.accountsPath, "utf8")) as Record<string, string>;

    assert.match(environment.SESSION_SECRET, /^[0-9a-f]{64}$/u);
    const authorityKeys = [
      environment.IDENTITY_ATTESTOR_PRIVATE_KEY,
      environment.CLAIM_ATTESTOR_PRIVATE_KEY,
    ];
    authorityKeys.forEach((key) => assert.match(key, /^0x[0-9a-f]{64}$/u));
    assert.equal(new Set([...authorityKeys, ownerPrivateKey]).size, 3);
    assert.equal(privateKeyToAccount(ownerPrivateKey).address, environment.CONTRACT_OWNER_ADDRESS);
    assert.equal(environment.DEPLOYER_PRIVATE_KEY, undefined, "the retired command-line deployer has no key");
    assert.equal(environment.ARC_IDENTITY_REGISTRY_ADDRESS, "");
    assert.equal(environment.ARC_CLAIM_ESCROW_ADDRESS, "");
    assert.equal(accounts.fundingStatus, "unfunded");
    assert.equal(accounts.owner, environment.CONTRACT_OWNER_ADDRESS);
    assert.doesNotMatch(JSON.stringify(accounts), /private.?key|secret/iu);
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    assert.equal((await stat(output.ownerKeyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(secretsDirectory)).mode & 0o777, 0o700);
  });

  it("refuses to replace an existing runtime environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hapapay-env-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    await writeFile(envPath, "USER_VALUE=preserve-me\n", { mode: 0o600 });

    await assert.rejects(
      initializeTestnetEnvironment({
        templatePath,
        envPath,
        secretsDirectory: join(directory, ".secrets"),
      }),
      /already exists/iu,
    );
    assert.equal(await readFile(envPath, "utf8"), "USER_VALUE=preserve-me\n");
  });
});
