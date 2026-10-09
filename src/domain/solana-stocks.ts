import { SOLANA_BASE_ASSETS, SOLANA_SOL, WRAPPED_SOL_MINT, XSTOCK_DECIMALS, type SolanaAssetListing } from "./solana-assets.js";
import { SOLANA_XSTOCK_ROWS, SOLANA_XSTOCKS_VERIFIED_ON } from "./solana-stock-tokens.js";

export { SOLANA_XSTOCKS_VERIFIED_ON };

/** The verified xStocks on Solana, every one a scaled Token-2022 mint with 8 decimals. Generated; see the sync script. */
export const SOLANA_XSTOCKS: readonly SolanaAssetListing[] = SOLANA_XSTOCK_ROWS.map(([symbol, ticker, name, mint, kind]) => ({
  symbol,
  ticker,
  name,
  kind: kind === "e" ? "etf" : "stock",
  mint,
  decimals: XSTOCK_DECIMALS,
  program: "token-2022",
  scaled: true,
}));

/** Every asset HaPaPay moves on Solana: USDC and USDG first, then the xStocks. SOL is not one of them. */
export const SOLANA_ASSETS: readonly SolanaAssetListing[] = [...SOLANA_BASE_ASSETS, ...SOLANA_XSTOCKS];

const bySymbol = new Map(SOLANA_ASSETS.map((asset) => [asset.symbol.toUpperCase(), asset]));
const exactSymbol = new Map(SOLANA_ASSETS.map((asset) => [asset.symbol, asset]));
const byTicker = new Map(SOLANA_ASSETS.map((asset) => [asset.ticker.toUpperCase(), asset]));
const byMint = new Map(SOLANA_ASSETS.filter((asset) => asset.mint).map((asset) => [asset.mint!, asset]));

/**
 * The asset a word names on Solana: its issuer symbol written as listed (VRTx), else the ticker people type (VRTX),
 * else a symbol in any case (tslax). Eight tickers are another xStock's symbol in capitals (VRTX is Vertex, VRTx is
 * Vertiv; GDX, CLX, DGX, COPX, BAX, BRX, SNXX the same), so the ticker comes before a symbol in other case (audit,
 * 2026-10-06: "1 VRTX" became Vertiv). USDC and USDG are their own tickers, and no stock shares them.
 */
export function solanaAssetByName(word: string) {
  const written = word.trim();
  const key = written.toUpperCase();
  return exactSymbol.get(written) ?? byTicker.get(key) ?? bySymbol.get(key);
}

/** The listing for this exact symbol and mint, if there is one; a mint the list does not know is never moved. */
export function allowlistedSolanaAsset(input: { symbol: string; mint?: string }) {
  const asset = bySymbol.get(input.symbol.toUpperCase());
  if (!asset || asset.symbol !== input.symbol) return undefined;
  return (asset.mint ?? undefined) === (input.mint ?? undefined) ? asset : undefined;
}

export function solanaAssetByMint(mint: string) {
  return byMint.get(mint);
}

/** The asset a vault link holds, from the mint the vault program recorded: wrapped SOL is SOL. */
export function vaultAssetByMint(mint: string) {
  return mint === WRAPPED_SOL_MINT ? SOLANA_SOL : byMint.get(mint);
}

/** Tickers and symbols with a Solana listing, so a request can tell a stock from a handle or a word. */
export const KNOWN_SOLANA_TICKERS: ReadonlySet<string> = new Set(SOLANA_ASSETS.flatMap((asset) => [asset.ticker.toUpperCase(), asset.symbol.toUpperCase()]));
