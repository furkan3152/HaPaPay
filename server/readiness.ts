import { getAddress, keccak256, type Address, type Hex } from "viem";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../src/domain/arc-identity-registry-artifact.js";
import { ARC_IDENTITY_REGISTRY_REVISION, arcIdentityRegistryAbi } from "../src/domain/arc-identity-registry.js";
import type { FeeSchedule } from "../src/domain/fees.js";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact.js";
import { STOCK_CLAIM_ESCROW_REVISION, stockClaimEscrowAbi } from "../src/domain/stock-claims.js";
import { ARC_CONTRACT_VARIABLES, type ArcNetworkConfig } from "./arc-network.js";
import { verifyFeeContracts } from "./fee-verification.js";
import { isPublishedSessionSecret } from "./runtime-config.js";

type ReadinessEnvironment = Partial<Record<
  | "ARC_NETWORK_MODE"
  | "SESSION_SECRET"
  | "DATABASE_URL"
  | "OPENROUTER_API_KEY"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "X_CLIENT_ID"
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_BOT_USERNAME"
  | "DISCORD_CLIENT_ID"
  | "DISCORD_CLIENT_SECRET"
  | "FARCASTER_OPTIMISM_RPC_URL"
  | "ARC_IDENTITY_REGISTRY_ADDRESS"
  | "IDENTITY_ATTESTOR_PRIVATE_KEY"
  | "ARC_CLAIM_ESCROW_ADDRESS"
  | "CLAIM_ATTESTOR_PRIVATE_KEY"
  | "CONTRACT_OWNER_ADDRESS"
  | "X_API_BEARER_TOKEN"
  | "ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS"
  | "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY"
  | "ARC_MAINNET_CLAIM_ESCROW_ADDRESS"
  | "ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY",
  string | undefined
>>;

export type ConfigurationReadinessCheck = {
  id: string;
  status: "ready" | "missing" | "unverified";
  missing: string[];
};

export type ContractRuntimeReadiness = {
  identityRegistry: boolean;
  claimEscrow: boolean;
};

export type OnchainContractClient = {
  getBytecode(input: { address: Address }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};

export function buildConfigurationReadiness(
  environment: ReadinessEnvironment,
  network: ArcNetworkConfig,
  runtimeVerified: boolean,
  contracts: ContractRuntimeReadiness = { identityRegistry: false, claimEscrow: false },
) {
  const names = ARC_CONTRACT_VARIABLES[network.environment === "mainnet" ? "mainnet" : "testnet"];
  const checks: ConfigurationReadinessCheck[] = [
    network.ready ? ready("arc_network_config") : { id: "arc_network_config", status: "unverified", missing: [] },
    runtimeVerified ? ready("arc_network_runtime") : { id: "arc_network_runtime", status: "unverified", missing: [] },
    required("session_security", environment, ["SESSION_SECRET"], () => (environment.SESSION_SECRET?.trim().length ?? 0) >= 32
      && !isPublishedSessionSecret(environment.SESSION_SECRET)),
    required("postgres_persistence", environment, ["DATABASE_URL"]),
    required("openrouter", environment, ["OPENROUTER_API_KEY"]),
    required("github_oauth", environment, ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]),
    required("x_oauth", environment, ["X_CLIENT_ID"]),
    required("telegram_login", environment, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME"]),
    required("discord_oauth", environment, ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"]),
    required("farcaster_verification", environment, ["FARCASTER_OPTIMISM_RPC_URL"]),
    contractCapability("identity_registry", environment, [names.registry, names.identityAttestor], contracts.identityRegistry),
    contractCapability("claim_escrow", environment, [names.escrow, names.claimAttestor], contracts.claimEscrow),
    required("x_non_user_discovery", environment, ["X_API_BEARER_TOKEN"]),
  ];
  const missingVariables = [...new Set(checks.flatMap((check) => check.missing))];
  return {
    ready: checks.every((check) => check.status === "ready"),
    network: {
      environment: network.environment ?? "unselected",
      chainName: network.chainName,
      chainId: network.ready ? network.chainId : undefined,
      runtimeVerified,
    },
    checks,
    missingVariables,
  };
}

/**
 * The Arc identity registry, verified on chain: the bundled ArcIdentityRegistry runtime code at its reviewed revision,
 * this server's identity attestor as verifier, and the operator as owner when one is expected.
 */
export async function verifyIdentityRegistryContract(
  expected: { registry: Address; identityVerifier: Address; owner?: Address },
  client: OnchainContractClient,
) {
  await requireReviewedCode(client, expected.registry, ARC_IDENTITY_REGISTRY_ARTIFACT.runtimeCodeHash, "Configured Arc identity registry is not the reviewed ArcIdentityRegistry build.");
  const securityRevision = await requireSecurityRevision(client, expected.registry, arcIdentityRegistryAbi, "Arc identity registry", ARC_IDENTITY_REGISTRY_REVISION);
  const verifier = await readAddress(client, expected.registry, arcIdentityRegistryAbi, "verifier");
  if (!sameAddress(verifier, expected.identityVerifier)) {
    throw new Error("Arc identity registry verifier does not match the configured identity attestor.");
  }
  if (expected.owner) {
    const owner = await readAddress(client, expected.registry, arcIdentityRegistryAbi, "owner");
    if (!sameAddress(owner, expected.owner)) throw new Error("Arc identity registry owner does not match the configured contract owner.");
  }
  return { securityRevision };
}

/**
 * The Arc vault escrow, verified on chain: the bundled StockClaimEscrow runtime code (the same reviewed build as on
 * Robinhood Chain; each payment names USDC as its token) at its reviewed revision, this server's claim attestor as
 * verifier, owned by the operator, and the fee contracts behind it: the reviewed router and the fee forwarder, both
 * paying the operator, so the whole Arc fee reaches the operator.
 */
export async function verifyClaimEscrowContract(
  expected: { escrow: Address; claimVerifier: Address; operator: Address; chainName: string },
  client: OnchainContractClient,
): Promise<{ securityRevision: bigint; fees: FeeSchedule }> {
  await requireReviewedCode(client, expected.escrow, STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash, "Configured Arc claim escrow is not the reviewed StockClaimEscrow build.");
  const securityRevision = await requireSecurityRevision(client, expected.escrow, stockClaimEscrowAbi, "Arc claim escrow", STOCK_CLAIM_ESCROW_REVISION);
  const verifier = await readAddress(client, expected.escrow, stockClaimEscrowAbi, "verifier");
  if (!sameAddress(verifier, expected.claimVerifier)) {
    throw new Error("Arc claim escrow verifier does not match the configured claim attestor.");
  }
  const owner = await readAddress(client, expected.escrow, stockClaimEscrowAbi, "owner");
  if (!sameAddress(owner, expected.operator)) throw new Error("Arc claim escrow owner does not match the configured operator wallet.");
  const fees = await verifyFeeContracts(client, {
    escrow: expected.escrow,
    operator: expected.operator,
    sink: "forwarder",
    chainName: expected.chainName,
    fail: (message) => new Error(message),
    unreachable: () => new Error(`${expected.chainName} fee contracts could not be read.`),
  });
  return { securityRevision, fees };
}

function required(
  id: string,
  environment: ReadinessEnvironment,
  names: Array<keyof ReadinessEnvironment>,
  additionalValidation?: () => boolean,
) {
  const absent = names.filter((name) => !environment[name]?.trim());
  if (!absent.length && (!additionalValidation || additionalValidation())) return ready(id);
  return missing(id, absent.length ? absent : names);
}

function contractCapability(
  id: string,
  environment: ReadinessEnvironment,
  names: Array<keyof ReadinessEnvironment>,
  verified: boolean,
) {
  const configured = required(id, environment, names);
  if (configured.status === "missing") return configured;
  return verified ? ready(id) : { id, status: "unverified" as const, missing: [] };
}

async function requireReviewedCode(client: OnchainContractClient, address: Address, runtimeCodeHash: Hex, message: string) {
  let bytecode: Hex | undefined;
  try {
    bytecode = await client.getBytecode({ address });
  } catch {
    throw new Error("Arc contract code could not be read.");
  }
  if (!bytecode || bytecode === "0x" || keccak256(bytecode) !== runtimeCodeHash) throw new Error(message);
}

async function requireSecurityRevision(client: OnchainContractClient, address: Address, abi: readonly unknown[], label: string, expected: bigint) {
  let revision: unknown;
  try {
    revision = await client.readContract({ address, abi, functionName: "securityRevision" });
  } catch {
    throw new Error(`${label} security revision could not be read.`);
  }
  if (typeof revision !== "bigint" || revision !== expected) {
    throw new Error(`${label} security revision must be ${expected}.`);
  }
  return revision;
}

async function readAddress(client: OnchainContractClient, address: Address, abi: readonly unknown[], functionName: "owner" | "verifier") {
  let value: unknown;
  try {
    value = await client.readContract({ address, abi, functionName });
  } catch {
    throw new Error(`Arc contract ${functionName} could not be read.`);
  }
  if (typeof value !== "string") throw new Error(`Arc contract ${functionName} binding is malformed.`);
  return getAddress(value);
}

function sameAddress(actual: Address, expected: Address) {
  return getAddress(actual) === getAddress(expected);
}

function ready(id: string): ConfigurationReadinessCheck {
  return { id, status: "ready", missing: [] };
}

function missing(id: string, names: Array<keyof ReadinessEnvironment>): ConfigurationReadinessCheck {
  return { id, status: "missing", missing: names.map(String) };
}
