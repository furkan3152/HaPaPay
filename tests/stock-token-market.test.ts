import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";
import { readStockTokenQuotes, readStockTokenRegistry, stockTokenDisplayName, stockTokenKind } from "../server/stock-token-registry";
import { StockTokenMarketData } from "../server/stock-token-market";
import { renderStockTokenModule, verifyStockTokensOnChain } from "../scripts/sync-stock-tokens";
import type { StockTokenListing } from "../src/domain/stock-tokens";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const listings: StockTokenListing[] = [
  { symbol: "AAPL", name: "Apple", kind: "stock", address: AAPL },
  { symbol: "NVDA", name: "NVIDIA", kind: "stock", address: NVDA },
];

function asset(symbol: string, address: string, extra: Record<string, unknown> = {}) {
  return {
    id: `0x${"0".repeat(64)}`,
    tokenSymbol: symbol,
    tokenName: `${symbol} Corp • Robinhood Token`,
    deployments: [{ contractAddress: address, chainId: 4663, networkName: "Robinhood Chain" }],
    currentMultiplier: "1.000000000000000000",
    pendingMultiplier: "",
    status: "ASSET_STATUS_ACTIVE",
    tokenDecimals: 18,
    ...extra,
  };
}

function quote(symbol: string, address: string, bid: string, ask: string, extra: Record<string, unknown> = {}) {
  return { tokenSymbol: symbol, deployments: [{ contractAddress: address, chainId: 4663 }], bid, ask, currency: "USD", isTradingHalt: false, generatedAt: "2026-09-28T12:00:00Z", ...extra };
}

describe("official stock-token registry parsing", () => {
  it("keeps active 18-decimal Robinhood Chain assets and drops ambiguous or foreign entries", () => {
    const tokens = readStockTokenRegistry({
      assets: [
        asset("NVDA", NVDA.toLowerCase(), { currentMultiplier: "1.000775159164630595" }),
        asset("OLD", "0x1111111111111111111111111111111111111111", { status: "ASSET_STATUS_INACTIVE" }),
        asset("SIX", "0x2222222222222222222222222222222222222222", { tokenDecimals: 6 }),
        asset("ETHX", "0x3333333333333333333333333333333333333333", { deployments: [{ contractAddress: "0x3333333333333333333333333333333333333333", chainId: 1 }] }),
        asset("DUP", "0x4444444444444444444444444444444444444444"),
        asset("DUP", "0x5555555555555555555555555555555555555555"),
        asset("BAD", "not-an-address"),
        { tokenSymbol: "nope" },
      ],
    });
    assert.deepEqual(tokens, [{ symbol: "NVDA", name: "NVDA Corp", kind: "stock", address: NVDA, multiplier: "1.000775159164630595", uid: `0x${"0".repeat(64)}` }]);
    assert.throws(() => readStockTokenRegistry({ items: [] }));
  });

  it("cleans display names and classifies funds conservatively", () => {
    assert.equal(stockTokenDisplayName("ImmunityBio, • Robinhood Token"), "ImmunityBio");
    assert.equal(stockTokenKind("SPDR S&P 500 ETF Trust"), "etf");
    assert.equal(stockTokenKind("Invesco QQQ"), "etf");
    assert.equal(stockTokenKind("United States Oil Fund"), "etf");
    assert.equal(stockTokenKind("Apple"), "stock");
  });

  it("reads quotes only with a single Robinhood Chain deployment", () => {
    assert.deepEqual(readStockTokenQuotes({ quotes: [quote("NVDA", NVDA, "229.8", "230.0"), quote("AAPL", "0x0", "1", "2")] }), [
      { symbol: "NVDA", address: NVDA, bid: "229.8", ask: "230.0", halted: false, generatedAt: "2026-09-28T12:00:00Z" },
    ]);
  });
});

describe("indicative stock-token market data", () => {
  function fakeFetch(responses: Record<string, unknown | Error>) {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = responses[url];
      if (body instanceof Error) throw body;
      return { ok: body !== undefined, status: body === undefined ? 503 : 200, json: async () => body };
    };
    return { fetch, calls };
  }

  it("prices the allowlist by exact ticker and address and caches reads", async () => {
    let now = 1_000;
    const upstream = fakeFetch({
      "https://api.robinhood.com/rhj/assets": { assets: [asset("NVDA", NVDA, { currentMultiplier: "2.000000000000000000" }), asset("AAPL", "0x9999999999999999999999999999999999999999")] },
      "https://api.robinhood.com/rhj/prices": { quotes: [quote("NVDA", NVDA, "100", "102", { isTradingHalt: true }), quote("AAPL", "0x9999999999999999999999999999999999999999", "300", "301")] },
    });
    const market = new StockTokenMarketData({ fetch: upstream.fetch, now: () => now, tokens: listings });
    const snapshot = await market.snapshot();
    assert.equal(snapshot.chain.id, 4663);
    assert.deepEqual(snapshot.prices, { status: "live", asOf: "2026-09-28T12:00:00Z", source: "https://api.robinhood.com/rhj/prices" });
    assert.deepEqual(snapshot.tokens, [
      { symbol: "AAPL", name: "Apple", kind: "stock", address: AAPL },
      { symbol: "NVDA", name: "NVIDIA", kind: "stock", address: NVDA, price: "202.00", multiplier: "2.000000000000000000", halted: true },
    ], "a registry entry with a different address never prices the allowlisted AAPL contract");

    await market.snapshot();
    assert.equal(upstream.calls.length, 2, "reads within the TTL are cached");
    now += 16_000;
    await market.snapshot();
    assert.equal(upstream.calls.filter((url) => url.endsWith("/prices")).length, 2, "quotes refresh after 15 seconds");
    assert.equal(upstream.calls.filter((url) => url.endsWith("/assets")).length, 1, "multipliers are cached longer");
  });

  it("serves the verified catalog without prices when the upstream fails", async () => {
    const upstream = fakeFetch({ "https://api.robinhood.com/rhj/prices": new Error("offline") });
    const market = new StockTokenMarketData({ fetch: upstream.fetch, tokens: listings });
    const snapshot = await market.snapshot();
    assert.equal(snapshot.prices.status, "unavailable");
    assert.deepEqual(snapshot.tokens, listings);
  });

  it("serves testnet faucet tokens as priceless test assets without upstream reads", async () => {
    const upstream = fakeFetch({});
    const snapshot = await new StockTokenMarketData({ fetch: upstream.fetch }).snapshot("robinhood-testnet");
    assert.equal(upstream.calls.length, 0);
    assert.equal(snapshot.network, "robinhood-testnet");
    assert.equal(snapshot.chain.id, 46630);
    assert.deepEqual(snapshot.prices, { status: "test_assets" });
    assert.deepEqual(snapshot.tokens.map((token) => token.symbol), ["AMD", "AMZN", "NFLX", "PLTR", "TSLA"]);
    assert.ok(snapshot.tokens.every((token) => token.price === undefined));
  });

  it("exposes the catalog through a non-cacheable API route", async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "localhost", sessionSecret: "a".repeat(32) }),
      stocks: { snapshot: async (network) => ({ network: network ?? "robinhood-mainnet", chain: { id: 4663, name: "Robinhood Chain", explorerUrl: "https://robinhoodchain.blockscout.com" }, allowlistVerifiedOn: "2026-09-28", prices: { status: "unavailable" as const, source: "test" }, tokens: listings }) },
    });
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/stocks`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual((await response.json()).tokens, listings);
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/stocks?network=robinhood-testnet`)).json()).network, "robinhood-testnet");
      for (const network of ["arc-testnet", "robinhood-testnet ", "4663"]) {
        const rejected = await fetch(`http://127.0.0.1:${port}/api/stocks?network=${encodeURIComponent(network)}`);
        assert.equal(rejected.status, 400, network);
        assert.equal(rejected.headers.get("cache-control"), "no-store");
      }

      const fallback = createApp({ auth: new WalletAuthService({ domain: "localhost", sessionSecret: "a".repeat(32) }) }).listen(0);
      try {
        const fallbackPort = (fallback.address() as { port: number }).port;
        const body = await (await fetch(`http://127.0.0.1:${fallbackPort}/api/stocks`)).json();
        assert.ok(body.tokens.length >= 100);
        assert.equal(body.prices.status, "unavailable");
        const testnet = await (await fetch(`http://127.0.0.1:${fallbackPort}/api/stocks?network=robinhood-testnet`)).json();
        assert.equal(testnet.tokens.length, 5);
        assert.equal(testnet.prices.status, "test_assets");
      } finally {
        fallback.close();
      }
    } finally {
      server.close();
    }
  });
});

describe("stock-token allowlist synchronization", () => {
  const uid = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as const;
  const beacon = "0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5";
  const beaconSlot = `0x${"0".repeat(24)}${beacon.slice(2).toLowerCase()}` as const;
  type Reads = { code?: `0x${string}`; decimals: unknown; symbol: unknown; name: unknown; uid: unknown; uiMultiplier: unknown; beacon?: `0x${string}` };
  function reader(reads: Record<string, Reads>, chainId = 4663) {
    return {
      getChainId: async () => chainId,
      getBytecode: async ({ address }: { address: string }) => reads[address].code,
      getStorageAt: async ({ address }: { address: string }) => reads[address].beacon,
      readContract: async ({ address, functionName }: { address: string; functionName: "decimals" | "symbol" | "name" | "uid" | "uiMultiplier" }) => reads[address][functionName],
    };
  }
  const good = (symbol: string, id: number): Reads => ({ code: "0x6080", decimals: 18, symbol, name: `${symbol} • Robinhood Token`, uid: uid(id), uiMultiplier: 10n ** 18n, beacon: beaconSlot });
  const registry = [
    { ...listings[0], multiplier: "1", uid: uid(1) },
    { ...listings[1], multiplier: "1", uid: uid(2) },
  ];

  it("keeps only contracts whose chain, bytecode, decimals, symbol, uid and multiplier match", async () => {
    const result = await verifyStockTokensOnChain(registry, reader({ [AAPL]: good("AAPL", 1), [NVDA]: { ...good("NVDA", 2), decimals: 6 } }), { chainId: 4663, retryDelayMs: 0 });
    assert.deepEqual(result.verified, [listings[0]]);
    assert.deepEqual(result.rejected, [{ symbol: "NVDA", reason: "decimals() returned 6" }]);

    const wrongUid = await verifyStockTokensOnChain(registry.slice(0, 1), reader({ [AAPL]: good("AAPL", 9) }), { chainId: 4663, retryDelayMs: 0 });
    assert.match(wrongUid.rejected[0].reason, /does not match the registry/);
    const plainErc20 = await verifyStockTokensOnChain(registry.slice(0, 1), reader({ [AAPL]: { ...good("AAPL", 1), uiMultiplier: 0n } }), { chainId: 4663, retryDelayMs: 0 });
    assert.deepEqual(plainErc20.rejected, [{ symbol: "AAPL", reason: "uiMultiplier() is missing" }]);
    await assert.rejects(verifyStockTokensOnChain(registry, reader({}, 46630), { chainId: 4663 }), /Expected chain 4663/);
  });

  it("verifies pinned testnet faucet tokens against the Stock beacon and reads their names on chain", async () => {
    const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
    const MOCK = "0x2C00c9B4F9b682dee1b0ED2401BDE214CaC437BA";
    const result = await verifyStockTokensOnChain(
      [{ symbol: "TSLA", address: TSLA }, { symbol: "NVDA", address: MOCK }],
      reader({ [TSLA]: { ...good("TSLA", 7), name: "Tesla" }, [MOCK]: { ...good("NVDA", 8), beacon: undefined } }, 46630),
      { chainId: 46630, beacon, retryDelayMs: 0 },
    );
    assert.deepEqual(result.verified, [{ symbol: "TSLA", name: "Tesla", kind: "stock", address: TSLA }]);
    assert.deepEqual(result.rejected, [{ symbol: "NVDA", reason: "beacon missing is not the pinned Stock beacon" }]);
  });

  it("retries transport failures but rejects a token that never reads back", async () => {
    let attempts = 0;
    const flaky = { ...reader({ [AAPL]: good("AAPL", 1) }), getBytecode: async () => { attempts++; if (attempts < 2) throw new Error("rate limited"); return "0x6080" as const; } };
    assert.equal((await verifyStockTokensOnChain(registry.slice(0, 1), flaky, { chainId: 4663, retryDelayMs: 0 })).verified.length, 1);
    const down = { ...flaky, getBytecode: async () => { throw new Error("down\nstack"); } };
    assert.deepEqual((await verifyStockTokensOnChain(registry.slice(0, 1), down, { chainId: 4663, retryDelayMs: 0 })).rejected, [{ symbol: "AAPL", reason: "RPC read failed: down" }]);
  });

  it("renders a typed, dated module with one allowlist per network", () => {
    const source = renderStockTokenModule({ tokens: listings, verifiedOn: "2026-09-28" }, { tokens: [listings[0]], verifiedOn: "2026-09-29" });
    assert.match(source, /ROBINHOOD_STOCK_TOKENS_VERIFIED_ON = "2026-09-28"/);
    assert.match(source, /ROBINHOOD_TESTNET_STOCK_TOKENS_VERIFIED_ON = "2026-09-29"/);
    assert.match(source, /\{ symbol: "NVDA", name: "NVIDIA", kind: "stock", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" \}/);
    assert.match(source, /"robinhood-testnet": \{ tokens: ROBINHOOD_TESTNET_STOCK_TOKENS/);
    assert.match(source, /import type \{ StockNetworkId, StockTokenListing \} from "\.\/stock-tokens\.js"/);
  });
});
