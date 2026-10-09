import { z } from "zod";
import type { SolanaAssetListing } from "../src/domain/solana-assets.js";

/**
 * Indicative USD prices for the Solana board from Jupiter's public price API (https://dev.jup.ag/docs/price), which
 * carries the xStocks share price and multiplier. No payment amount, fee or check uses them; besides the board, they
 * value xStock payments for SP and invite rewards.
 */
export const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const priceSchema = z.record(z.object({
  usdPrice: z.number().positive().optional(),
  stockData: z.object({ price: z.number().positive().optional() }).passthrough().optional(),
}).passthrough());

export type SolanaQuote = { symbol: string; price?: number };
export type SolanaMarketSnapshot = { asOf?: string; status: "live" | "unavailable"; source: string; quotes: Record<string, number> };

/**
 * One price per asset, by symbol: an xStock's share price (what one token shows in a wallet), otherwise the token's
 * USD price. Reads are cached for two minutes (about 20 requests per refresh for the whole list), failed reads too.
 */
export class SolanaMarketData {
  private cached?: { at: number; snapshot: SolanaMarketSnapshot };

  constructor(private readonly options: { assets: readonly SolanaAssetListing[]; fetcher?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number }) {}

  async snapshot(): Promise<SolanaMarketSnapshot> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < (this.options.ttlMs ?? 120_000)) return this.cached.snapshot;
    const snapshot = await this.read().catch(() => ({ status: "unavailable" as const, source: "Jupiter", quotes: {} }));
    this.cached = { at: now, snapshot };
    return snapshot;
  }

  private async read(): Promise<SolanaMarketSnapshot> {
    const fetcher = this.options.fetcher ?? fetch;
    const bySymbol = new Map(this.options.assets.map((asset) => [asset.mint ?? SOL_MINT, asset]));
    const ids = [...bySymbol.keys()];
    const quotes: Record<string, number> = {};
    for (let index = 0; index < ids.length; index += 50) {
      const response = await fetcher(`${JUPITER_PRICE_URL}?ids=${ids.slice(index, index + 50).join(",")}`, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000) });
      if (!response.ok) throw new Error("Price read failed.");
      const prices = priceSchema.parse(await response.json());
      for (const [mint, entry] of Object.entries(prices)) {
        const asset = bySymbol.get(mint);
        const price = asset?.scaled ? entry.stockData?.price ?? entry.usdPrice : entry.usdPrice;
        if (asset && price) quotes[asset.symbol] = price;
      }
    }
    return { status: Object.keys(quotes).length ? "live" : "unavailable", asOf: new Date((this.options.now ?? Date.now)()).toISOString(), source: "Jupiter", quotes };
  }
}
