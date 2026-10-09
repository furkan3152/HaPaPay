import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "dotenv";
import { initializeSolanaAttestor } from "../scripts/init-solana-attestor";
import { readSolanaAttestorKey, readSolanaConfig, verifySolanaSignature } from "../server/solana-network";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Solana attestor initializer", () => {
  it("creates one new attestor key the server reads, privately, with only its address beside it", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "hapapay-solana-"));
    temporaryDirectories.push(parentDirectory);
    const outputDirectory = join(parentDirectory, "HaPaPay Solana Attestor");

    const output = await initializeSolanaAttestor({ outputDirectory, now: () => new Date("2026-10-04T12:00:00.000Z") });
    const environment = parse(await readFile(output.environmentPath));
    const account = JSON.parse(await readFile(output.accountPath, "utf8")) as Record<string, unknown>;

    assert.deepEqual(Object.keys(environment), ["SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY"]);
    const attestor = readSolanaAttestorKey(environment.SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY);
    assert.ok(attestor, "the server reads the key, a 64-byte secret whose public half matches");
    assert.equal(account.claimAttestor, attestor.publicKey);
    const message = new TextEncoder().encode("claim");
    assert.equal(verifySolanaSignature(attestor.publicKey, message, attestor.sign(message)), true);
    assert.equal(readSolanaConfig({ SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY: environment.SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY }).attestor?.publicKey, attestor.publicKey);
    assert.doesNotMatch(JSON.stringify(account), /private.?key|secret/iu);
    assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(output.environmentPath)).mode & 0o777, 0o600);
    assert.equal((await stat(output.accountPath)).mode & 0o777, 0o600);

    const second = await initializeSolanaAttestor({ outputDirectory: join(parentDirectory, "Another") });
    assert.notEqual(parse(await readFile(second.environmentPath)).SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY, environment.SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY);
  });

  it("refuses to replace an existing package", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "hapapay-solana-"));
    temporaryDirectories.push(parentDirectory);
    const outputDirectory = join(parentDirectory, "HaPaPay Solana Attestor");
    await writeFile(outputDirectory, "preserve-me", { mode: 0o600 });
    await assert.rejects(initializeSolanaAttestor({ outputDirectory }), /already exists/iu);
    assert.equal(await readFile(outputDirectory, "utf8"), "preserve-me");
  });
});
