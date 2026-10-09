import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type InitializeMainnetAuthoritiesInput = {
  outputDirectory: string;
  now?: () => Date;
};

/**
 * Creates Arc Mainnet's two attestor keys in a new, private directory without printing them: the identity attestor
 * the registry names as verifier, and the claim attestor the escrow names. Both are used for nothing else. The
 * contracts themselves are deployed from /operator/stock-escrow by the operator wallet, so no deployer key exists.
 */
export async function initializeMainnetAuthorities(input: InitializeMainnetAuthoritiesInput) {
  const outputDirectory = resolve(input.outputDirectory);
  await assertAbsent(outputDirectory);

  const attestorEnvPath = join(outputDirectory, "arc-mainnet-attestors.env");
  const accountsPath = join(outputDirectory, "arc-mainnet-accounts.json");
  const instructionsPath = join(outputDirectory, "README.txt");
  const [identityAttestorKey, claimAttestorKey] = uniquePrivateKeys(2);
  const identityAttestor = privateKeyToAccount(identityAttestorKey);
  const claimAttestor = privateKeyToAccount(claimAttestorKey);

  const attestorEnvironment = [
    `ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY=${identityAttestorKey}`,
    `ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY=${claimAttestorKey}`,
    "",
  ].join("\n");
  const accounts = {
    schemaVersion: 2,
    network: "Arc Mainnet",
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    identityAttestor: identityAttestor.address,
    claimAttestor: claimAttestor.address,
  };
  const instructions = [
    "HAPAPAY - ARC MAINNET ATTESTORS",
    "",
    "This directory contains production signing keys. Keep it offline and never upload it to GitHub, cloud drives, chat, or screenshots.",
    "",
    "Files:",
    "- arc-mainnet-attestors.env: the identity attestor and claim attestor keys, each used for nothing else.",
    "- arc-mainnet-accounts.json: their public addresses only.",
    "",
    "Add both values to the hosting provider's Production environment as sensitive variables, then redeploy.",
    "Deploy the contracts from /operator/stock-escrow with the operator wallet, then set the registry and escrow addresses",
    "and ARC_NETWORK_MODE=mainnet. Never reuse a Testnet or Robinhood Chain key here; the server refuses a shared key.",
    "",
  ].join("\n");

  await mkdir(outputDirectory, { mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  try {
    await writeFile(attestorEnvPath, attestorEnvironment, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(instructionsPath, instructions, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }

  return { outputDirectory, attestorEnvPath, accountsPath, instructionsPath };
}

async function assertAbsent(path: string) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Mainnet credential package already exists at ${path}; refusing to overwrite it.`);
}

function uniquePrivateKeys(count: number) {
  const keys = new Set<`0x${string}`>();
  while (keys.size < count) keys.add(generatePrivateKey());
  return [...keys];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const outputDirectory = process.argv[2]
    ? resolve(process.argv[2])
    : join(homedir(), "Desktop", "HaPaPay Mainnet Credentials");
  const output = await initializeMainnetAuthorities({ outputDirectory });
  console.log(`Created the Arc Mainnet attestor keys at ${output.outputDirectory}.`);
  console.log("No private key was printed. Add both to the Production environment as sensitive variables.");
}
