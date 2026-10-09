import { fallback, getAddress, http, type Address } from "viem";
import { ARC_MAINNET, ARC_TESTNET } from "../src/domain/arc-chains.js";

export { ARC_MAINNET, ARC_TESTNET };

/**
 * Keyless Arc Mainnet endpoints that Arc's own documentation lists beside Circle's (docs.arc.io, RPC endpoints, checked
 * 2026-10-04): QuickNode, Blockdaemon and dRPC under mainnet.arc.io. The server reads through them only when Circle's
 * endpoint fails or answers with an error (it documents -32014 while its backends disagree on height). The browser and
 * the wallet keep Circle's endpoint from the bundled constants, and no endpoint carries a key.
 */
export const ARC_MAINNET_FALLBACK_RPC_URLS = [
  "https://rpc.quicknode.mainnet.arc.io",
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://rpc.drpc.mainnet.arc.io",
] as const;

/** How the server reads an Arc network: its configured endpoint, and on Arc Mainnet the documented keyless fallbacks. */
export function arcReadTransport(rpcUrl: string, environment?: "testnet" | "mainnet", fallbacks: readonly string[] = ARC_MAINNET_FALLBACK_RPC_URLS) {
  const primary = http(rpcUrl, { timeout: 10_000, retryCount: 1 });
  if (environment !== "mainnet") return primary;
  return fallback([primary, ...fallbacks.map((url) => http(url, { timeout: 10_000, retryCount: 1 }))]);
}

/**
 * The server's Arc reads: a provider's endpoint first when `ARC_MAINNET_RPC_URL` names one, then the official
 * endpoint and the documented keyless fallbacks, as without a provider.
 */
export function arcServerTransport(network: { rpcUrl: string; serverRpcUrl?: string; environment?: "testnet" | "mainnet" }) {
  if (!network.serverRpcUrl) return arcReadTransport(network.rpcUrl, network.environment);
  return arcReadTransport(network.serverRpcUrl, network.environment, [network.rpcUrl, ...ARC_MAINNET_FALLBACK_RPC_URLS]);
}

const ARC_TESTNET_RPC_HOST = new URL(ARC_TESTNET.rpcUrl).hostname.toLowerCase();
const ARC_MAINNET_RPC_HOST = new URL(ARC_MAINNET.rpcUrl).hostname.toLowerCase();
const ARC_MAINNET_RPC_ORIGIN = new URL(ARC_MAINNET.rpcUrl).origin;
const ARC_MAINNET_EXPLORER_ORIGIN = new URL(ARC_MAINNET.explorerUrl).origin;

type NetworkEnvironment = Partial<Record<
  "ARC_NETWORK_MODE" | "ARC_MAINNET_RPC_URL" | "ARC_MAINNET_CHAIN_ID" | "ARC_MAINNET_EXPLORER_URL" | "ARC_MAINNET_USDC_ADDRESS",
  string | undefined
>>;

export type ArcNetworkConfig =
  | { ready: false; reason: string; environment?: "testnet" | "mainnet"; chainName?: string }
  | {
    ready: true;
    chainId: number;
    chainIdHex: `0x${string}`;
    /** The official RPC: what wallets are given. */
    rpcUrl: string;
    /** A provider's RPC for the server's own reads (`ARC_MAINNET_RPC_URL`). It may carry a key: never sent to a browser. */
    serverRpcUrl?: string;
    explorerUrl?: string;
    faucetUrl?: string;
    usdcAddress: Address;
    environment?: "testnet" | "mainnet";
    chainName?: string;
  };

export function readArcNetworkConfig(environment: NetworkEnvironment): ArcNetworkConfig {
  const mode = environment.ARC_NETWORK_MODE?.trim().toLowerCase() || "testnet";
  if (mode === "testnet") {
    return {
      ready: true,
      ...ARC_TESTNET,
      chainIdHex: `0x${ARC_TESTNET.chainId.toString(16)}`,
    };
  }
  if (mode !== "mainnet") throw new Error("ARC_NETWORK_MODE must be either testnet or mainnet.");
  const mainnet = readArcMainnetConfig(environment);
  return { ...mainnet, environment: "mainnet", chainName: "Arc Mainnet" };
}

/**
 * Arc Mainnet, open now that Arc documents public availability (docs.arc.io, checked 2026-10-03). The chain, RPC, explorer and USDC are the bundled constants; the chain ID,
 * explorer and USDC overrides are optional and must name exactly those values. `ARC_MAINNET_RPC_URL` may instead name
 * a provider's https endpoint (such as QuickNode) for the server's own reads, with no credentials
 * before the host and no fragment; it must report Arc Mainnet's chain ID at boot, and wallets keep the official RPC.
 * Testnet values are rejected outright.
 */
export function readArcMainnetConfig(environment: NetworkEnvironment): ArcNetworkConfig {
  const rpcInput = environment.ARC_MAINNET_RPC_URL?.trim() || ARC_MAINNET.rpcUrl;
  const chainInput = environment.ARC_MAINNET_CHAIN_ID?.trim() || String(ARC_MAINNET.chainId);
  const usdcInput = environment.ARC_MAINNET_USDC_ADDRESS?.trim() || ARC_MAINNET.usdcAddress;
  const chainId = Number(chainInput);
  const rpcUrl = new URL(rpcInput);
  if (rpcUrl.protocol !== "https:" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Arc mainnet configuration is malformed.");
  }
  if (chainId === ARC_TESTNET.chainId || rpcUrl.hostname.toLowerCase() === ARC_TESTNET_RPC_HOST || rpcUrl.hostname.toLowerCase().includes("testnet")) {
    throw new Error("Arc testnet configuration cannot be used as mainnet.");
  }
  const usdcAddress = getAddress(usdcInput);
  if (chainId !== ARC_MAINNET.chainId || usdcAddress.toLowerCase() !== ARC_MAINNET.usdcAddress.toLowerCase()) {
    return { ready: false, reason: "Official Arc mainnet chain and USDC parameters do not match the verified tuple." };
  }
  const official = rpcUrl.hostname.toLowerCase() === ARC_MAINNET_RPC_HOST && rpcUrl.origin === ARC_MAINNET_RPC_ORIGIN && rpcUrl.pathname === "/" && !rpcUrl.search && !rpcUrl.hash;
  if (!official && (rpcUrl.username || rpcUrl.password || rpcUrl.hash)) {
    return { ready: false, reason: "ARC_MAINNET_RPC_URL must be the official Arc Mainnet RPC or a provider's https endpoint without credentials before the host." };
  }
  if (environment.ARC_MAINNET_EXPLORER_URL) {
    const explorerUrl = new URL(environment.ARC_MAINNET_EXPLORER_URL);
    if (explorerUrl.protocol !== "https:" || explorerUrl.origin !== ARC_MAINNET_EXPLORER_ORIGIN) {
      return { ready: false, reason: "Official Arc mainnet chain, RPC, and explorer parameters do not match the verified tuple." };
    }
  }
  return {
    ready: true,
    ...ARC_MAINNET,
    chainIdHex: `0x${ARC_MAINNET.chainId.toString(16)}`,
    ...(official ? {} : { serverRpcUrl: rpcUrl.toString() }),
  };
}

export type ArcContractEnvironment = Partial<Record<
  | "ARC_IDENTITY_REGISTRY_ADDRESS"
  | "IDENTITY_ATTESTOR_PRIVATE_KEY"
  | "ARC_CLAIM_ESCROW_ADDRESS"
  | "CLAIM_ATTESTOR_PRIVATE_KEY"
  | "CONTRACT_OWNER_ADDRESS"
  | "ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS"
  | "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY"
  | "ARC_MAINNET_CLAIM_ESCROW_ADDRESS"
  | "ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"
  | "ARC_MAINNET_OPERATOR_ADDRESS"
  | "ROBINHOOD_OPERATOR_ADDRESS"
  | "ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY"
  | "ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY",
  string | undefined
>>;

/** The environment variable names one Arc network reads its contract settings from. */
export const ARC_CONTRACT_VARIABLES = {
  testnet: {
    registry: "ARC_IDENTITY_REGISTRY_ADDRESS",
    identityAttestor: "IDENTITY_ATTESTOR_PRIVATE_KEY",
    escrow: "ARC_CLAIM_ESCROW_ADDRESS",
    claimAttestor: "CLAIM_ATTESTOR_PRIVATE_KEY",
    operator: "CONTRACT_OWNER_ADDRESS",
  },
  mainnet: {
    registry: "ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS",
    identityAttestor: "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY",
    escrow: "ARC_MAINNET_CLAIM_ESCROW_ADDRESS",
    claimAttestor: "ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY",
    operator: "ARC_MAINNET_OPERATOR_ADDRESS",
  },
} as const;

export type ArcContractConfig = {
  registryAddress?: string;
  identityAttestorKey?: string;
  escrowAddress?: string;
  claimAttestorKey?: string;
  /** The wallet that deploys and owns the Arc contracts and receives the whole Arc fee. */
  operator?: Address;
  /** An operator value is set but is not an address: both contract groups stay off rather than skip the owner check. */
  operatorInvalid?: true;
  /** Settings this network still needs, by variable name. A key shared with another role counts as missing. */
  setup: string[];
};

/**
 * The Arc contract settings of one network. Testnet keeps its original names and verifies ownership against
 * CONTRACT_OWNER_ADDRESS. Mainnet reads only ARC_MAINNET_* names, so its keys and addresses never overwrite the
 * testnet ones, and its operator is ARC_MAINNET_OPERATOR_ADDRESS, or ROBINHOOD_OPERATOR_ADDRESS (the Robinhood operator
 * wallet) when that is unset. A mainnet attestor key equal to any other attestor key is refused rather than reused.
 */
export function readArcContractConfig(environment: ArcContractEnvironment, mode: "testnet" | "mainnet"): ArcContractConfig {
  const value = (input: string | undefined) => input?.trim() ? input.trim() : undefined;
  const names = ARC_CONTRACT_VARIABLES[mode];
  const operatorInput = mode === "mainnet"
    ? value(environment.ARC_MAINNET_OPERATOR_ADDRESS) ?? value(environment.ROBINHOOD_OPERATOR_ADDRESS)
    : value(environment.CONTRACT_OWNER_ADDRESS);
  let operator: Address | undefined;
  let operatorInvalid = false;
  try {
    operator = operatorInput ? getAddress(operatorInput) : undefined;
  } catch {
    operator = undefined;
    operatorInvalid = true;
  }
  let identityAttestorKey = value(environment[names.identityAttestor]);
  let claimAttestorKey = value(environment[names.claimAttestor]);
  if (mode === "mainnet") {
    const others = [
      environment.IDENTITY_ATTESTOR_PRIVATE_KEY,
      environment.CLAIM_ATTESTOR_PRIVATE_KEY,
      environment.ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY,
      environment.ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY,
    ].map(value).filter((key): key is string => Boolean(key)).map((key) => key.toLowerCase());
    const shared = (key: string | undefined, sibling: string | undefined) => Boolean(key && (others.includes(key.toLowerCase()) || key.toLowerCase() === sibling?.toLowerCase()));
    const identityShared = shared(identityAttestorKey, claimAttestorKey);
    const claimShared = shared(claimAttestorKey, identityAttestorKey);
    if (identityShared) identityAttestorKey = undefined;
    if (claimShared) claimAttestorKey = undefined;
  }
  const registryAddress = value(environment[names.registry]);
  const escrowAddress = value(environment[names.escrow]);
  const setup = [
    ...(operator ? [] : [mode === "mainnet" ? `${names.operator} or ROBINHOOD_OPERATOR_ADDRESS` : names.operator]),
    ...(identityAttestorKey ? [] : [names.identityAttestor]),
    ...(claimAttestorKey ? [] : [names.claimAttestor]),
    ...(registryAddress ? [] : [names.registry]),
    ...(escrowAddress ? [] : [names.escrow]),
  ];
  return { registryAddress, identityAttestorKey, escrowAddress, claimAttestorKey, operator, ...(operatorInvalid ? { operatorInvalid: true as const } : {}), setup };
}
