import { formatUnits, parseUnits, stringToHex, type Hex } from "viem";

/**
 * Elysium: Kinetiq's DeFi layer 2 for the Hyperliquid ecosystem. It is an Arbitrum Orbit (Nitro, AnyTrust) chain that
 * settles to HyperEVM and takes HYPE as its gas token, with ~100 ms blocks from a single Conduit sequencer and no
 * public mempool (transactions are ordered by priority fee).
 *
 * Checked on 2026-10-31:
 * - Testnet (live since 2026-09-22): chain 99801, public RPCs by Kinetiq and Conduit, Conduit and Kinetiq explorers,
 *   Kinetiq's faucet and the 1:1 HYPE bridge from HyperEVM Testnet.
 * - Mainnet: public launch planned for 2026-11-09. Conduit has deployed chain 99901 with HyperEVM (999) as its parent,
 *   but Kinetiq has not published the public RPC or explorer yet. ElysaPay therefore ships mainnet switched off: an
 *   admin enters the official RPC and explorer in the admin panel once Kinetiq publishes them, the server checks the
 *   RPC really answers chain 99901, and only then can mainnet be switched on.
 * - HyperCore precompiles (market data, CoreWriter) are not on Elysium yet; Kinetiq plans them for an ArbOS upgrade
 *   after mainnet. ElysaPay reads Hyperliquid's market data from Hyperliquid's public info API meanwhile.
 * - A plain HYPE transfer costs about 21,140 gas because Orbit adds the parent-chain posting cost: never hard-code
 *   21,000. The desk always lets the wallet (or the server's estimate) set the gas.
 */
export type ElysiumNetworkId = "elysium-testnet" | "elysium-mainnet";
export const ELYSIUM_NETWORK_IDS: readonly ElysiumNetworkId[] = ["elysium-testnet", "elysium-mainnet"];
export const isElysiumNetworkId = (value: unknown): value is ElysiumNetworkId => value === "elysium-testnet" || value === "elysium-mainnet";

export type ElysiumChain = {
  id: ElysiumNetworkId;
  environment: "testnet" | "mainnet";
  chainName: string;
  chainId: number;
  /** The public RPC wallets are given. Undefined until it is published (mainnet before launch). */
  rpcUrl?: string;
  /** Further public RPCs the server may read through when the first one fails. */
  fallbackRpcUrls: readonly string[];
  /** Explorer origin, and how it spells transaction and address pages. */
  explorerUrl?: string;
  explorerTxPath: string;
  explorerAddressPath: string;
  faucetUrl?: string;
  bridgeUrl?: string;
  parentChain: { name: string; chainId: number };
};

export const ELYSIUM_TESTNET: ElysiumChain = {
  id: "elysium-testnet",
  environment: "testnet",
  chainName: "Elysium Testnet",
  chainId: 99_801,
  rpcUrl: "https://testnet-rpc.elysium.kinetiq.xyz",
  fallbackRpcUrls: ["https://rpc-elysium-testnet.t.conduit.xyz"],
  explorerUrl: "https://explorer-elysium-testnet.t.conduit.xyz",
  explorerTxPath: "/tx/",
  explorerAddressPath: "/address/",
  faucetUrl: "https://elysium.kinetiq.xyz/testnet-faucet",
  bridgeUrl: "https://elysium.kinetiq.xyz/testnet-bridge",
  parentChain: { name: "HyperEVM Testnet", chainId: 998 },
};

export const ELYSIUM_MAINNET: ElysiumChain = {
  id: "elysium-mainnet",
  environment: "mainnet",
  chainName: "Elysium",
  chainId: 99_901,
  fallbackRpcUrls: [],
  explorerTxPath: "/tx/",
  explorerAddressPath: "/address/",
  parentChain: { name: "HyperEVM", chainId: 999 },
};

export const ELYSIUM_CHAINS: Record<ElysiumNetworkId, ElysiumChain> = {
  "elysium-testnet": ELYSIUM_TESTNET,
  "elysium-mainnet": ELYSIUM_MAINNET,
};

/** Elysium's planned public mainnet launch (the day, as Kinetiq announced it; the hour was not published). */
export const ELYSIUM_MAINNET_LAUNCH = "2026-11-09T00:00:00Z";
/** Elysium's target block time. */
export const ELYSIUM_TARGET_BLOCK_MS = 100;
export const HYPE = { name: "HYPE", symbol: "HYPE", decimals: 18 } as const;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** The ElysaPay fee: 1%, added on top and rounded up, exactly as `ElysaPayRouter.feeFor` computes it. */
export const ELYSIUM_FEE_BPS = 100n;
export const elysiumFee = (amount: bigint) => (amount * ELYSIUM_FEE_BPS + 9_999n) / 10_000n;
export const ELYSIUM_NOTE_MAX_BYTES = 160;
export const ELYSIUM_BATCH_MAX = 10;

/** The contracts an admin deploys on each Elysium network from their own wallet. */
export type ElysiumContractKind = "router" | "token" | "pass";
export const ELYSIUM_CONTRACT_KINDS: readonly ElysiumContractKind[] = ["router", "token", "pass"];
export const ELYSIUM_CONTRACT_LABELS: Record<ElysiumContractKind, string> = {
  router: "ElysaPay router (payments)",
  token: "ELYSA token (ERC-20)",
  pass: "Elysian Pass (ERC-721)",
};
export type ElysiumContracts = Partial<Record<ElysiumContractKind, `0x${string}`>>;

/** A network as the server reports it to the desk and the admin panel. */
export type ElysiumNetworkView = {
  id: ElysiumNetworkId;
  chainName: string;
  environment: "testnet" | "mainnet";
  chainId: number;
  chainIdHex: `0x${string}`;
  rpcUrl: string | null;
  explorerUrl: string | null;
  explorerTxPath: string;
  explorerAddressPath: string;
  faucetUrl: string | null;
  bridgeUrl: string | null;
  parentChain: { name: string; chainId: number };
  /** Switched on by an admin, with a working RPC on the right chain. */
  enabled: boolean;
  /** Why payments are not open on it, when they are not. */
  reason?: string;
  contracts: ElysiumContracts;
  launch?: string;
};

export type ElysiumLiveStats = {
  network: ElysiumNetworkId;
  blockNumber: string;
  /** Average milliseconds between the last blocks the server sampled. */
  blockTimeMs: number | null;
  /** Gas price in wei, and the cost of a router payment at that price (about 60k gas) in HYPE. */
  gasPriceWei: string;
  paymentCostHype: string;
  readAt: string;
};

/** One block as the block river draws it. */
export type ElysiumBlock = { number: string; timestamp: number; txCount: number; gasUsed: string; baseFeeGwei: number | null };

export type ElysiumMarket = {
  coin: string;
  mid: number;
  prevDay: number | null;
  change24h: number | null;
  dayVolumeUsd: number | null;
  openInterest: number | null;
  /** Hourly funding rate (a fraction: 0.0001 is 0.01%). */
  funding: number | null;
};

export type ElysiumPaymentRecord = {
  network: ElysiumNetworkId;
  hash: `0x${string}`;
  payer: `0x${string}`;
  recipient: `0x${string}`;
  platform: string;
  username: string;
  token: "HYPE";
  amount: string;
  fee: string;
  note: string;
  blockNumber: string;
  confirmedAt: string;
};

/** The wallet's network entry for an Elysium network, from the server's view only after it checked the RPC. */
export function elysiumWalletChain(view: Pick<ElysiumNetworkView, "chainIdHex" | "chainName" | "rpcUrl" | "explorerUrl">) {
  return {
    chainId: view.chainIdHex,
    chainName: view.chainName,
    nativeCurrency: HYPE,
    rpcUrls: view.rpcUrl ? [view.rpcUrl] : [],
    ...(view.explorerUrl ? { blockExplorerUrls: [view.explorerUrl] } : {}),
  };
}

export function elysiumTxUrl(view: Pick<ElysiumNetworkView, "explorerUrl" | "explorerTxPath">, hash: string) {
  return view.explorerUrl ? `${view.explorerUrl.replace(/\/$/, "")}${view.explorerTxPath}${hash}` : undefined;
}

export function elysiumAddressUrl(view: Pick<ElysiumNetworkView, "explorerUrl" | "explorerAddressPath">, address: string) {
  return view.explorerUrl ? `${view.explorerUrl.replace(/\/$/, "")}${view.explorerAddressPath}${address}` : undefined;
}

/** A HYPE amount as people write it ("0.5", "12"), up to 18 decimals; undefined when it is not one. */
export function parseHype(input: string): bigint | undefined {
  const value = input.trim().replace(",", ".");
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(value)) return undefined;
  const units = parseUnits(value, HYPE.decimals);
  return units > 0n ? units : undefined;
}

export const formatHype = (units: bigint, digits = 6) => {
  const text = formatUnits(units, HYPE.decimals);
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
};

/** The note as the router stores it: UTF-8 bytes, at most 160. */
export function elysiumNoteBytes(note: string): Hex | undefined {
  const hex = stringToHex(note.trim());
  return (hex.length - 2) / 2 <= ELYSIUM_NOTE_MAX_BYTES ? hex : undefined;
}

/** Whole milliseconds until a moment (never below zero), broken into days, hours, minutes and seconds. */
export function countdown(target: string, now = Date.now()) {
  const left = Math.max(0, new Date(target).getTime() - now);
  const seconds = Math.floor(left / 1000);
  return { done: left === 0, days: Math.floor(seconds / 86_400), hours: Math.floor(seconds / 3_600) % 24, minutes: Math.floor(seconds / 60) % 60, seconds: seconds % 60 };
}
