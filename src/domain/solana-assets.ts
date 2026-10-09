import { SOL_DECIMALS } from "./solana-chains.js";

/** The token program that owns a mint: the original SPL Token program or Token-2022 (token extensions). */
export type SolanaTokenProgram = "token" | "token-2022";
export type SolanaAssetKind = "native" | "cash" | "stock" | "etf";

/**
 * Something HaPaPay moves on Solana. `symbol` is the issuer's own (SOL, USDC, TSLAx); `ticker` is what people
 * type (TSLA for TSLAx). A `scaled` mint uses Token-2022's scaled UI amount: wallets show the raw balance times a
 * multiplier the issuer moves for dividends and splits, so amounts are read and shown the way wallets show them.
 */
export type SolanaAssetListing = {
  symbol: string;
  ticker: string;
  name: string;
  kind: SolanaAssetKind;
  /** The mint (base58). SOL has none. */
  mint?: string;
  decimals: number;
  program?: SolanaTokenProgram;
  scaled?: boolean;
};

export const SOLANA_TOKEN_PROGRAM_ADDRESSES: Record<SolanaTokenProgram, string> = {
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "token-2022": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
};

/** Every xStock on Solana uses 8 decimals; the sync script refuses a mint that does not. */
export const XSTOCK_DECIMALS = 8;

/**
 * SOL itself. HaPaPay does not send it: it stays known so a request for it is answered, a wallet's SOL for network fees is shown, and records
 * written before then are read.
 */
export const SOLANA_SOL: SolanaAssetListing = { symbol: "SOL", ticker: "SOL", name: "Solana", kind: "native", decimals: SOL_DECIMALS };

/** What a request to send SOL is told, in the chat and by every route that prepares a Solana transaction. */
export const NO_SOL_SENDING = "HaPaPay does not send SOL. It sends stablecoins (USDC and USDG) and stocks (xStocks on Solana, Stock Tokens on Robinhood Chain). Keep a little SOL in your wallet for Solana's network fees.";

/**
 * SPL Token's native mint, wrapped SOL. The vault program holds token accounts only, so a vault link for SOL holds it
 * wrapped as this token: the funding wraps it in the payer's own wrapped-SOL account, and a claim or refund unwraps it
 * again in the same transaction, so SOL goes in and SOL comes out.
 */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Every listed token can wait in the Solana vault; SOL, which HaPaPay does not send, cannot. */
export function vaultHoldsAsset(asset: Pick<SolanaAssetListing, "mint" | "kind">) {
  return Boolean(asset.mint) && asset.mint !== WRAPPED_SOL_MINT && asset.kind !== "native";
}

/**
 * USD Coin on Solana, Circle's native mint (https://developers.circle.com/stablecoins/usdc-contract-addresses). Read
 * from mainnet on 2026-10-04: owned by the SPL Token program, 6 decimals, no extensions.
 */
export const SOLANA_USDC: SolanaAssetListing = {
  symbol: "USDC",
  ticker: "USDC",
  name: "USD Coin",
  kind: "cash",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
  program: "token",
};

/**
 * Global Dollar on Solana, the mint xStocks lists as a Solana settlement stablecoin. Read from mainnet on 2026-10-04:
 * Token-2022, 6 decimals, a transfer fee configured at 0, no transfer hook, and a permanent delegate (the issuer can
 * move or burn balances). A transfer fee above 0 is refused at preparation, so a recipient always gets the amount.
 */
export const SOLANA_USDG: SolanaAssetListing = {
  symbol: "USDG",
  ticker: "USDG",
  name: "Global Dollar",
  kind: "cash",
  mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
  decimals: 6,
  program: "token-2022",
};
export const SOLANA_ASSETS_VERIFIED_ON = "2026-10-04";

/** USDC and USDG: the Solana stablecoins HaPaPay sends. The xStocks list lives in `solana-stocks.ts`; SOL is not sent. */
export const SOLANA_BASE_ASSETS: readonly SolanaAssetListing[] = [SOLANA_USDC, SOLANA_USDG];

export function isSolanaStock(asset: Pick<SolanaAssetListing, "kind">) {
  return asset.kind === "stock" || asset.kind === "etf";
}
