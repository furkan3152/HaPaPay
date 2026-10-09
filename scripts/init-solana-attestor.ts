import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddressEncoder, getBase58Decoder, type Address } from "@solana/kit";
import { readSolanaAttestorKey } from "../server/solana-network";

type InitializeSolanaAttestorInput = {
  outputDirectory: string;
  now?: () => Date;
};

/**
 * Creates the Solana vault's claim attestor in a new, private directory without printing it: a new ed25519 key used
 * for nothing else (the server refuses one that is the operator's or the treasury's). It is written as base58 of the
 * 64-byte secret key, the form wallets export. The vault program is deployed from /operator/stock-escrow by the
 * operator's own wallet, so no deployer key exists.
 */
export async function initializeSolanaAttestor(input: InitializeSolanaAttestorInput) {
  const outputDirectory = resolve(input.outputDirectory);
  await assertAbsent(outputDirectory);

  const environmentPath = join(outputDirectory, "solana-attestor.env");
  const accountPath = join(outputDirectory, "solana-attestor.json");
  const instructionsPath = join(outputDirectory, "README.txt");
  const seed = Uint8Array.from(randomBytes(32));
  const attestor = readSolanaAttestorKey(getBase58Decoder().decode(seed))!;
  const secretKey = getBase58Decoder().decode(Uint8Array.from([...seed, ...getAddressEncoder().encode(attestor.publicKey as Address)]));

  const account = {
    schemaVersion: 1,
    network: "Solana mainnet",
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    claimAttestor: attestor.publicKey,
  };
  const instructions = [
    "HAPAPAY - SOLANA VAULT CLAIM ATTESTOR",
    "",
    "This directory contains a production signing key. Keep it offline and never upload it to GitHub, cloud drives, chat, or screenshots.",
    "",
    "Files:",
    "- solana-attestor.env: SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY, used for nothing else.",
    "- solana-attestor.json: its public address only.",
    "",
    "Add the value to the hosting provider's Production environment as a sensitive variable, with SOLANA_OPERATOR_ADDRESS",
    "and SOLANA_TREASURY_ADDRESS, and redeploy. Then deploy the vault program from /operator/stock-escrow with the operator's",
    "wallet; the program names this address as its claim attestor. Never use the operator's or the treasury's key here.",
    "",
  ].join("\n");

  await mkdir(outputDirectory, { mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  try {
    await writeFile(environmentPath, `SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY=${secretKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(accountPath, `${JSON.stringify(account, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(instructionsPath, instructions, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }

  return { outputDirectory, environmentPath, accountPath, instructionsPath };
}

async function assertAbsent(path: string) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`A Solana attestor package already exists at ${path}; refusing to overwrite it.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const outputDirectory = process.argv[2]
    ? resolve(process.argv[2])
    : join(homedir(), "Desktop", "HaPaPay Solana Attestor");
  const output = await initializeSolanaAttestor({ outputDirectory });
  console.log(`Created the Solana vault's claim attestor at ${output.outputDirectory}.`);
  console.log("No private key was printed. Add it to the Production environment as a sensitive variable.");
}
