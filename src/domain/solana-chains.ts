/**
 * Solana mainnet, bundled so that neither the server's environment nor its responses decide which cluster a wallet
 * signs for. The genesis hash
 * identifies mainnet-beta (the server's RPC must report it); its first 32 characters are the CAIP-2 reference wallets
 * use (`solana:5eykt4Us…`).
 * Gas (the network fee and the rent for a new token account) is paid in SOL by the sender's wallet.
 */
export const SOLANA_MAINNET = {
  id: "solana-mainnet" as const,
  name: "Solana",
  cluster: "mainnet-beta" as const,
  genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const,
  rpcUrl: "https://api.mainnet-beta.solana.com",
  explorerUrl: "https://solscan.io",
};

export type SolanaNetworkId = typeof SOLANA_MAINNET.id;

/** QuickNode's Solana mainnet endpoints: `https://<name>.solana-mainnet.quiknode.pro/<token>/`, websocket on `wss:`. */
export const SOLANA_BROWSER_RPC_HOST = ".solana-mainnet.quiknode.pro";

/**
 * The RPC pages use for Solana (`SOLANA_BROWSER_RPC_URL`).
 * Solana's public endpoint answers 403 to any request that carries a browser's Origin, so pages need a provider's; only
 * an https QuickNode Solana mainnet endpoint without credentials, port or fragment is accepted, by the server and again
 * by the page. Its token is public by design: the endpoint's referrer allow-list is what keeps it to this site.
 */
export function parseSolanaBrowserRpcUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  const name = host.slice(0, -SOLANA_BROWSER_RPC_HOST.length);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return undefined;
  return host.endsWith(SOLANA_BROWSER_RPC_HOST) && /^[a-z0-9-]+$/.test(name) ? url.toString() : undefined;
}

/** SOL itself: 9 decimals (lamports). */
export const SOL_DECIMALS = 9;

/** A Solana address (base58 of 32 bytes): 32 to 44 characters from the base58 alphabet. Shape only; see `isAddress`. */
export const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A transaction signature (base58 of 64 bytes): 64 to 88 characters. */
export const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** The explorer page for a transaction or an account on Solana mainnet. */
export function solanaExplorerUrl(kind: "tx" | "account", value: string) {
  return `${SOLANA_MAINNET.explorerUrl}/${kind}/${value}`;
}

/** Where a Solana vault link is claimed: the payment ID in hex, like the EVM vault's links. */
export function solanaClaimPath(paymentId: string) {
  return `/claim/solana/${paymentId.toLowerCase()}`;
}

export function parseSolanaClaimPath(pathname: string): { paymentId: `0x${string}` } | undefined {
  const match = pathname.match(/^\/claim\/solana\/(0x[0-9a-fA-F]{64})$/);
  return match ? { paymentId: match[1].toLowerCase() as `0x${string}` } : undefined;
}
