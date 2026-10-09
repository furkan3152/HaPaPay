import type { Address } from "viem";

/**
 * Arc's official chain parameters, bundled so that neither the server's environment nor its responses decide which
 * chain a wallet signs for. Mainnet was revalidated against docs.arc.io and a live RPC read on 2026-10-03 (chain
 * 0x13b2, USDC bytecode, decimals() == 6). Both networks expose USDC's six-decimal ERC-20 interface at the same
 * address; the chain ID tells them apart. Native USDC (gas) uses 18 decimals and is never mixed with these units.
 */
export const ARC_TESTNET = {
  environment: "testnet" as const,
  chainName: "Arc Testnet",
  chainId: 5_042_002,
  rpcUrl: "https://rpc.testnet.arc.io/",
  explorerUrl: "https://explorer.testnet.arc.io/",
  faucetUrl: "https://faucet.circle.com/",
  usdcAddress: "0x3600000000000000000000000000000000000000" as Address,
};

export const ARC_MAINNET = {
  environment: "mainnet" as const,
  chainName: "Arc Mainnet",
  chainId: 5_042,
  rpcUrl: "https://rpc.mainnet.arc.io/",
  explorerUrl: "https://explorer.arc.io/",
  usdcAddress: "0x3600000000000000000000000000000000000000" as Address,
};

export type ArcNetworkId = "arc-testnet" | "arc-mainnet";

export const ARC_CHAINS: Record<ArcNetworkId, typeof ARC_TESTNET | typeof ARC_MAINNET> = {
  "arc-testnet": ARC_TESTNET,
  "arc-mainnet": ARC_MAINNET,
};

/** The wallet's network entry for an Arc chain, from the bundled constants only. Gas is native USDC with 18 decimals. */
export function arcWalletChain(network: ArcNetworkId) {
  const chain = ARC_CHAINS[network];
  return {
    chainId: `0x${chain.chainId.toString(16)}` as `0x${string}`,
    chainName: chain.chainName,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: [chain.rpcUrl],
    blockExplorerUrls: [chain.explorerUrl],
  };
}
