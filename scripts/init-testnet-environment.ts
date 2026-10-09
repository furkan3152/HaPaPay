import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type InitializeTestnetEnvironmentInput = {
  templatePath: string;
  envPath: string;
  secretsDirectory: string;
  now?: () => Date;
};

export async function initializeTestnetEnvironment(input: InitializeTestnetEnvironmentInput) {
  const envPath = resolve(input.envPath);
  const secretsDirectory = resolve(input.secretsDirectory);
  const ownerKeyPath = resolve(secretsDirectory, "arc-testnet-owner.key");
  const accountsPath = resolve(secretsDirectory, "arc-testnet-accounts.json");
  await assertAbsent(envPath, "Runtime environment");
  await assertAbsent(ownerKeyPath, "Arc Testnet owner key");
  await assertAbsent(accountsPath, "Arc Testnet accounts file");

  const keys = uniquePrivateKeys(3);
  const [identityAttestorKey, claimAttestorKey, ownerKey] = keys;
  const identityAttestor = privateKeyToAccount(identityAttestorKey);
  const claimAttestor = privateKeyToAccount(claimAttestorKey);
  const owner = privateKeyToAccount(ownerKey);
  let environment = await readFile(input.templatePath, "utf8");
  environment = setEnvironmentValue(environment, "SESSION_SECRET", randomBytes(32).toString("hex"));
  environment = setEnvironmentValue(environment, "IDENTITY_ATTESTOR_PRIVATE_KEY", identityAttestorKey);
  environment = setEnvironmentValue(environment, "CLAIM_ATTESTOR_PRIVATE_KEY", claimAttestorKey);
  environment = setEnvironmentValue(environment, "CONTRACT_OWNER_ADDRESS", owner.address);

  const accounts = {
    schemaVersion: 1,
    network: "Arc Testnet",
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    fundingStatus: "unfunded",
    identityAttestor: identityAttestor.address,
    claimAttestor: claimAttestor.address,
    owner: owner.address,
  };

  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
  await chmod(secretsDirectory, 0o700);
  const created: string[] = [];
  try {
    await writeFile(ownerKeyPath, `${ownerKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(ownerKeyPath);
    await writeFile(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(accountsPath);
    await writeFile(envPath, environment, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(envPath);
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path).catch(() => undefined)));
    throw error;
  }

  return { envPath, ownerKeyPath, accountsPath };
}

async function assertAbsent(path: string, label: string) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`${label} already exists at ${path}; refusing to overwrite it.`);
}

function uniquePrivateKeys(count: number) {
  const keys = new Set<`0x${string}`>();
  while (keys.size < count) keys.add(generatePrivateKey());
  return [...keys];
}

function setEnvironmentValue(source: string, name: string, value: string) {
  const pattern = new RegExp(`^${name}=.*$`, "mu");
  if (!pattern.test(source)) throw new Error(`${name} is missing from the environment template.`);
  return source.replace(pattern, `${name}=${value}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const output = await initializeTestnetEnvironment({
    templatePath: resolve(".env.example"),
    envPath: resolve(".env"),
    secretsDirectory: resolve(".secrets"),
  });
  console.log(`Created ${output.envPath}.`);
  console.log(`Stored testnet owner recovery material and public account metadata under ${resolve(".secrets")}.`);
  console.log("No secret values were printed. Deploy the contracts from /operator/stock-escrow with the owner wallet.");
}
