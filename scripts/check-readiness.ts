import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readArcContractConfig, readArcNetworkConfig, type ArcContractEnvironment } from "../server/arc-network";
import { verifyArcRuntime } from "../server/arc-runtime-verification";
import { loadEnvironmentFile } from "../server/environment";
import {
  buildConfigurationReadiness,
  verifyClaimEscrowContract,
  verifyIdentityRegistryContract,
} from "../server/readiness";

loadEnvironmentFile();

const network = readArcNetworkConfig({
  ARC_NETWORK_MODE: process.env.ARC_NETWORK_MODE,
  ARC_MAINNET_RPC_URL: process.env.ARC_MAINNET_RPC_URL,
  ARC_MAINNET_CHAIN_ID: process.env.ARC_MAINNET_CHAIN_ID,
  ARC_MAINNET_EXPLORER_URL: process.env.ARC_MAINNET_EXPLORER_URL,
  ARC_MAINNET_USDC_ADDRESS: process.env.ARC_MAINNET_USDC_ADDRESS,
});
const contracts = readArcContractConfig(process.env as ArcContractEnvironment, network.environment === "mainnet" ? "mainnet" : "testnet");

let runtimeVerified = false;
let runtimeError: string | undefined;
const verified = { identityRegistry: false, claimEscrow: false };
const problems: string[] = [];
if (network.ready) {
  const publicClient = createPublicClient({ transport: http(network.rpcUrl) });
  try {
    await verifyArcRuntime(network, publicClient);
    runtimeVerified = true;
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : "Arc runtime verification failed.";
  }
  const contractClient = {
    getBytecode: ({ address }: { address: Address }) => publicClient.getBytecode({ address }),
    readContract: (input: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => publicClient.readContract(input as never),
  };
  if (runtimeVerified && contracts.registryAddress && contracts.identityAttestorKey) {
    try {
      // As at startup, the Arc Mainnet registry's owner is always checked.
      if (network.environment === "mainnet" && !contracts.operator) throw new Error("The operator wallet is not set, so the registry's owner cannot be verified.");
      await verifyIdentityRegistryContract({
        registry: getAddress(contracts.registryAddress),
        identityVerifier: attestorAddress(contracts.identityAttestorKey),
        ...(contracts.operator ? { owner: contracts.operator } : {}),
      }, contractClient);
      verified.identityRegistry = true;
    } catch (error) {
      problems.push(`identity_registry: ${error instanceof Error ? error.message : "not verified"}`);
    }
  }
  if (runtimeVerified && contracts.escrowAddress && contracts.claimAttestorKey && contracts.operator) {
    try {
      await verifyClaimEscrowContract({
        escrow: getAddress(contracts.escrowAddress),
        claimVerifier: attestorAddress(contracts.claimAttestorKey),
        operator: contracts.operator,
        chainName: network.chainName ?? "Arc",
      }, contractClient);
      verified.claimEscrow = true;
    } catch (error) {
      problems.push(`claim_escrow: ${error instanceof Error ? error.message : "not verified"}`);
    }
  }
}

const report = buildConfigurationReadiness({
  ARC_NETWORK_MODE: process.env.ARC_NETWORK_MODE,
  SESSION_SECRET: process.env.SESSION_SECRET,
  DATABASE_URL: process.env.DATABASE_URL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  X_CLIENT_ID: process.env.X_CLIENT_ID,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  FARCASTER_OPTIMISM_RPC_URL: process.env.FARCASTER_OPTIMISM_RPC_URL,
  ARC_IDENTITY_REGISTRY_ADDRESS: process.env.ARC_IDENTITY_REGISTRY_ADDRESS,
  IDENTITY_ATTESTOR_PRIVATE_KEY: process.env.IDENTITY_ATTESTOR_PRIVATE_KEY,
  ARC_CLAIM_ESCROW_ADDRESS: process.env.ARC_CLAIM_ESCROW_ADDRESS,
  CLAIM_ATTESTOR_PRIVATE_KEY: process.env.CLAIM_ATTESTOR_PRIVATE_KEY,
  CONTRACT_OWNER_ADDRESS: process.env.CONTRACT_OWNER_ADDRESS,
  X_API_BEARER_TOKEN: process.env.X_API_BEARER_TOKEN,
  ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS: process.env.ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS,
  ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY: contracts.identityAttestorKey && network.environment === "mainnet" ? contracts.identityAttestorKey : undefined,
  ARC_MAINNET_CLAIM_ESCROW_ADDRESS: process.env.ARC_MAINNET_CLAIM_ESCROW_ADDRESS,
  ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: contracts.claimAttestorKey && network.environment === "mainnet" ? contracts.claimAttestorKey : undefined,
}, network, runtimeVerified, verified);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ...report, ...(runtimeError ? { runtimeError } : {}) }, null, 2)}\n`);
} else {
  process.stdout.write(`HaPaPay configuration readiness\n`);
  process.stdout.write(`Network: ${report.network.chainName ?? report.network.environment}${report.network.chainId ? ` (${report.network.chainId})` : ""}\n`);
  for (const check of report.checks) {
    const marker = check.status === "ready" ? "PASS" : check.status === "unverified" ? "WAIT" : "MISS";
    process.stdout.write(`[${marker}] ${check.id}${check.missing.length ? `: ${check.missing.join(", ")}` : ""}\n`);
  }
  if (runtimeError) process.stdout.write(`Arc runtime: ${runtimeError}\n`);
  for (const problem of problems) process.stdout.write(`Arc contract ${problem}\n`);
  process.stdout.write(report.ready ? "READY: runtime configuration is complete.\n" : "NOT READY: configure the missing items above.\n");
}

process.exitCode = report.ready ? 0 : 1;

function attestorAddress(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Configured attestor key is malformed.");
  return privateKeyToAccount(value as Hex).address;
}

