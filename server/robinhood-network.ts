import { createPublicClient, fallback, getAddress, http, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { STOCK_CHAINS, type StockNetworkId } from "../src/domain/stock-tokens.js";
import type { StockChainClient } from "./stock-transfer-service.js";

type RobinhoodEnvironment = Partial<Record<
  | "ROBINHOOD_TESTNET_RPC_URL"
  | "ROBINHOOD_MAINNET_RPC_URL"
  | "ROBINHOOD_TESTNET_STOCK_TRANSFERS"
  | "ROBINHOOD_MAINNET_STOCK_TRANSFERS"
  | "ROBINHOOD_TESTNET_TOKEN_TRANSFERS"
  | "ROBINHOOD_MAINNET_TOKEN_TRANSFERS",
  string | undefined
>>;

export type RobinhoodTransferConfig = {
  network: StockNetworkId;
  /** Robinhood Stock Tokens. */
  enabled: boolean;
  reason?: string;
  /** Every other listed asset (USDG): not a Stock Token, so not behind the Stock Token switch. */
  tokens: { enabled: boolean; reason?: string };
  /** Server-side RPC. It may carry a provider key, so it is never returned to the browser. Unset when invalid. */
  rpcUrl?: string;
};

function serverRpcUrl(value: string | undefined, fallback: string) {
  const input = value?.trim();
  if (!input) return fallback;
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.toString() : undefined;
}

/**
 * Stock Token transfers on Robinhood Chain Testnet are on by default (faucet tokens, no value). Mainnet moves
 * real Stock Tokens, so it runs only when the operator sets ROBINHOOD_MAINNET_STOCK_TRANSFERS=enabled. The other
 * listed assets (USDG) are not Stock Tokens: they run by default, and ROBINHOOD_*_TOKEN_TRANSFERS=disabled
 * turns them off. Chain parameters are fixed; environment values can only point at an RPC, which is verified first.
 */
export function readRobinhoodTransferConfig(environment: RobinhoodEnvironment): Record<StockNetworkId, RobinhoodTransferConfig> {
  const switchSetting = (flag: string | undefined) => {
    const setting = flag?.trim().toLowerCase() ?? "";
    return ["", "enabled", "disabled"].includes(setting) ? setting : undefined;
  };
  const read = (
    network: StockNetworkId,
    flags: { stock: string | undefined; tokens: string | undefined },
    stockDefault: boolean,
    rpcInput: string | undefined,
  ): RobinhoodTransferConfig => {
    const chain = STOCK_CHAINS[network];
    const rpcUrl = serverRpcUrl(rpcInput, chain.rpcUrl);
    if (!rpcUrl) {
      const reason = `The ${chain.name} RPC URL on this server must be an HTTPS URL.`;
      return { network, enabled: false, reason, tokens: { enabled: false, reason } };
    }
    const stock = switchSetting(flags.stock);
    const tokens = switchSetting(flags.tokens);
    const stockEnabled = stock === "" ? stockDefault : stock === "enabled";
    const stockSwitch = stock === undefined
      ? { enabled: false, reason: `${chain.name} stock transfers are misconfigured on this server.` }
      : stockEnabled
        ? { enabled: true }
        : {
            enabled: false,
            reason: network === "robinhood-mainnet"
              ? "Mainnet stock transfers are turned off on this server. The operator enables them after reviewing eligibility."
              : "Testnet stock transfers are turned off on this server.",
          };
    return {
      network,
      ...stockSwitch,
      tokens: tokens === undefined
        ? { enabled: false, reason: `${chain.name} token transfers are misconfigured on this server.` }
        : tokens === "disabled"
          ? { enabled: false, reason: `USDG transfers are turned off on ${chain.name} on this server.` }
          : { enabled: true },
      rpcUrl,
    };
  };
  return {
    "robinhood-testnet": read(
      "robinhood-testnet",
      { stock: environment.ROBINHOOD_TESTNET_STOCK_TRANSFERS, tokens: environment.ROBINHOOD_TESTNET_TOKEN_TRANSFERS },
      true,
      environment.ROBINHOOD_TESTNET_RPC_URL,
    ),
    "robinhood-mainnet": read(
      "robinhood-mainnet",
      { stock: environment.ROBINHOOD_MAINNET_STOCK_TRANSFERS, tokens: environment.ROBINHOOD_MAINNET_TOKEN_TRANSFERS },
      false,
      environment.ROBINHOOD_MAINNET_RPC_URL,
    ),
  };
}

/**
 * A read-only viem client for one Robinhood chain. Nothing here can sign; the browser wallet signs transfers. With a
 * provider RPC configured (`ROBINHOOD_*_RPC_URL`), the chain's public endpoint takes over when the provider fails.
 */
export function robinhoodChainClient(rpcUrl: string, publicRpcUrl?: string): StockChainClient {
  const primary = http(rpcUrl, { timeout: 10_000, retryCount: 1 });
  const transport = publicRpcUrl && publicRpcUrl !== rpcUrl ? fallback([primary, http(publicRpcUrl, { timeout: 10_000, retryCount: 1 })]) : primary;
  const client = createPublicClient({ transport });
  return {
    getChainId: () => client.getChainId(),
    getBytecode: ({ address }) => client.getCode({ address }),
    readContract: (input) => client.readContract(input as never),
    call: ({ account, to, data }) => client.call({ account, to, data }),
    getTransactionReceipt: ({ hash }) => client.getTransactionReceipt({ hash }),
    getTransaction: ({ hash }) => client.getTransaction({ hash }),
  };
}

type StockClaimEnvironment = Partial<Record<
  | "ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY"
  | "ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"
  | "CLAIM_ATTESTOR_PRIVATE_KEY"
  | "IDENTITY_ATTESTOR_PRIVATE_KEY"
  | "ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"
  | "ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY"
  | "ROBINHOOD_OPERATOR_ADDRESS"
  | "CONTRACT_OWNER_ADDRESS",
  string | undefined
>>;

export type StockClaimNetworkConfig = {
  /** Signs claim attestations for this network's escrow. It never leaves the server. */
  attestor?: LocalAccount;
  /** Server settings still missing, by environment variable name; empty when the network can run claim links. */
  setup: string[];
};

export type StockClaimConfig = {
  /**
   * The Robinhood Chain operator wallet: it alone may register the vault escrow and the fee contracts,
   * every accepted contract must be owned by it, and it receives the treasury half of each fee.
   */
  operator?: Address;
  networks: Record<StockNetworkId, StockClaimNetworkConfig>;
};

/**
 * Stock claim links need a claim attestor per network and the operator's wallet. The operator is
 * ROBINHOOD_OPERATOR_ADDRESS, or CONTRACT_OWNER_ADDRESS when that is not set; the Arc contracts keep verifying their
 * owner against CONTRACT_OWNER_ADDRESS alone, so moving the Robinhood operator never breaks them. Robinhood Chain
 * Testnet may share the Arc Testnet claim attestor (CLAIM_ATTESTOR_PRIVATE_KEY, which Arc Mainnet never uses: it has
 * its own ARC_MAINNET_* keys): both are test networks and every attestation is bound to its chain ID, escrow and
 * token. Mainnet needs its own key, and a key already used by a test network or by another role is refused rather
 * than reused.
 */
export function readStockClaimConfig(environment: StockClaimEnvironment): StockClaimConfig {
  const operatorName = environment.ROBINHOOD_OPERATOR_ADDRESS?.trim() ? "ROBINHOOD_OPERATOR_ADDRESS" : "CONTRACT_OWNER_ADDRESS";
  const operatorInput = environment.ROBINHOOD_OPERATOR_ADDRESS?.trim() || environment.CONTRACT_OWNER_ADDRESS?.trim();
  let operator: Address | undefined;
  try {
    operator = operatorInput ? getAddress(operatorInput) : undefined;
  } catch {
    operator = undefined;
  }
  const ownerSetup = operator ? [] : [operatorName];
  const key = (value: string | undefined) => value?.trim() ? value.trim() : undefined;
  const account = (value: string | undefined) => value && /^0x[0-9a-fA-F]{64}$/.test(value) ? privateKeyToAccount(value as Hex) : undefined;

  const testnetName = key(environment.ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY)
    ? "ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY"
    : "CLAIM_ATTESTOR_PRIVATE_KEY";
  const testnetKey = key(environment.ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY) ?? key(environment.CLAIM_ATTESTOR_PRIVATE_KEY);
  const testnetAttestor = account(testnetKey);

  const mainnetKey = key(environment.ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY);
  const otherKeys = [
    environment.CLAIM_ATTESTOR_PRIVATE_KEY,
    environment.IDENTITY_ATTESTOR_PRIVATE_KEY,
    environment.ROBINHOOD_TESTNET_CLAIM_ATTESTOR_PRIVATE_KEY,
    environment.ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY,
    environment.ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY,
  ].map(key).filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  const mainnetShared = Boolean(mainnetKey && otherKeys.includes(mainnetKey.toLowerCase()));
  const mainnetAttestor = mainnetShared ? undefined : account(mainnetKey);

  return {
    operator,
    networks: {
      "robinhood-testnet": { attestor: testnetAttestor, setup: [...(testnetAttestor ? [] : [testnetName]), ...ownerSetup] },
      "robinhood-mainnet": { attestor: mainnetAttestor, setup: [...(mainnetAttestor ? [] : ["ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY"]), ...ownerSetup] },
    },
  };
}
