import { ROBINHOOD_ASSET_ALLOWLISTS } from "../src/domain/robinhood-assets.js";
import {
  stockTokenCatalog as catalogSnapshot,
  stockTokenPrice,
  type StockNetworkId,
  type StockTokenListing,
  type StockTokenSnapshot,
} from "../src/domain/stock-tokens.js";
import {
  readStockTokenQuotes,
  readStockTokenRegistry,
  STOCK_TOKEN_PRICES_URL,
  STOCK_TOKEN_REGISTRY_URL,
  type RegistryQuote,
} from "./stock-token-registry.js";

type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type Cached<T> = { at: number; value?: T };

async function readThrough<T>(cache: Cached<T>, now: number, ttlMs: number, load: () => Promise<T>) {
  // A failed read is cached for the same TTL, so an upstream outage cannot turn every page view into a request.
  if (now - cache.at < ttlMs) return cache.value;
  try {
    cache.value = await load();
  } catch {
    cache.value = undefined;
  }
  cache.at = now;
  return cache.value;
}

/**
 * Catalog with no market data: the verified Stock Tokens plus, on mainnet, USDG. Testnet
 * faucet tokens never have a price; mainnet falls back here on failure.
 */
export function stockTokenCatalog(
  network: StockNetworkId = "robinhood-mainnet",
  tokens: readonly StockTokenListing[] = ROBINHOOD_ASSET_ALLOWLISTS[network].tokens,
): StockTokenSnapshot {
  const catalog = catalogSnapshot(network, tokens, ROBINHOOD_ASSET_ALLOWLISTS[network].verifiedOn);
  return network === "robinhood-mainnet" ? { ...catalog, prices: { ...catalog.prices, source: STOCK_TOKEN_PRICES_URL } } : catalog;
}

/**
 * Indicative mainnet prices for the verified allowlist. Market data never adds a token, changes an address or feeds
 * amount conversion; besides the board, it values Stock Token payments for SP and invite rewards. Entries are joined by exact contract address and ticker.
 * Testnet snapshots are served from the allowlist without any upstream call.
 */
export class StockTokenMarketData {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly tokens: readonly StockTokenListing[];
  private readonly quoteTtlMs: number;
  private readonly registryTtlMs: number;
  private readonly timeoutMs: number;
  private readonly quotes: Cached<RegistryQuote[]> = { at: Number.NEGATIVE_INFINITY };
  private readonly multipliers: Cached<Map<string, string>> = { at: Number.NEGATIVE_INFINITY };
  private inflight?: Promise<StockTokenSnapshot>;

  constructor(options: {
    fetch?: Fetcher;
    now?: () => number;
    tokens?: readonly StockTokenListing[];
    quoteTtlMs?: number;
    registryTtlMs?: number;
    timeoutMs?: number;
  } = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.tokens = options.tokens ?? ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens;
    this.quoteTtlMs = options.quoteTtlMs ?? 15_000;
    this.registryTtlMs = options.registryTtlMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  snapshot(network: StockNetworkId = "robinhood-mainnet"): Promise<StockTokenSnapshot> {
    if (network === "robinhood-testnet") return Promise.resolve(stockTokenCatalog("robinhood-testnet"));
    this.inflight ??= this.build().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async build(): Promise<StockTokenSnapshot> {
    const now = this.now();
    const [quotes, multipliers] = await Promise.all([
      readThrough(this.quotes, now, this.quoteTtlMs, async () => readStockTokenQuotes(await this.read(STOCK_TOKEN_PRICES_URL))),
      readThrough(this.multipliers, now, this.registryTtlMs, async () => new Map(
        readStockTokenRegistry(await this.read(STOCK_TOKEN_REGISTRY_URL)).map((token) => [`${token.symbol}:${token.address}`, token.multiplier]),
      )),
    ]);
    const catalog = stockTokenCatalog("robinhood-mainnet", this.tokens);
    if (!quotes || !multipliers) return catalog;

    const quoteByToken = new Map(quotes.map((quote) => [`${quote.symbol}:${quote.address}`, quote]));
    let asOf: string | undefined;
    let priced = 0;
    const tokens = catalog.tokens.map((token) => {
      const key = `${token.symbol}:${token.address}`;
      const quote = quoteByToken.get(key);
      const multiplier = multipliers.get(key);
      const price = quote && multiplier ? stockTokenPrice(quote.bid, quote.ask, multiplier) : undefined;
      if (!quote || !multiplier || !price) return { ...token, ...(multiplier ? { multiplier } : {}) };
      priced++;
      if (quote.generatedAt && !Number.isNaN(Date.parse(quote.generatedAt)) && (!asOf || quote.generatedAt > asOf)) asOf = quote.generatedAt;
      return { ...token, price, multiplier, halted: quote.halted };
    });
    return {
      ...catalog,
      prices: priced > 0 ? { status: "live", asOf, source: STOCK_TOKEN_PRICES_URL } : catalog.prices,
      tokens,
    };
  }

  private async read(url: string) {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Stock token market data request failed (${response.status}).`);
    return response.json();
  }
}
