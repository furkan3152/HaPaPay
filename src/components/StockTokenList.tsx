import { useState, type CSSProperties } from "react";
import { isStockToken, type StockTokenListing, type StockTokenQuote, type StockTokenSnapshot } from "../domain/stock-tokens";
import "./stock-token-list.css";
import { DotIcon } from "./DotIcon";

const popularSymbols = ["NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "GOOGL", "META", "SPY", "QQQ", "PLTR", "AMD", "COIN"];
/** USDG leads the Popular view on mainnet; it is not a Stock Token. */
const tokenSymbols = ["USDG"];
const pageSize = 12;
const views = ["popular", "stock", "etf", "tokens"] as const;
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const ROBINHOOD_TESTNET_FAUCET_URL = "https://faucet.testnet.chain.robinhood.com";

export function formatUsd(value: string) {
  return usd.format(Number(value));
}

/** Ticker tile on a slip. Our own mark: the registry logo URLs all serve one Robinhood placeholder. */
export function StockTile({ token, size = "regular" }: { token: Pick<StockTokenListing, "symbol" | "kind">; size?: "regular" | "large" }) {
  return <span className={`stock-tile stock-tile-${token.kind} stock-tile-${size}`} aria-hidden="true">
    {token.symbol.slice(0, 2)}
  </span>;
}

type View = typeof views[number];

export function StockTokenList({ snapshot, loading, activeSymbol, onSelect }: {
  snapshot: StockTokenSnapshot;
  loading: boolean;
  activeSymbol?: string;
  onSelect: (token: StockTokenQuote) => void;
}) {
  const [view, setView] = useState<View>("popular");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const testAssets = snapshot.prices.status === "test_assets";
  const search = query.trim().toLowerCase();
  const matches = search
    ? snapshot.tokens.filter((token) => token.symbol.toLowerCase().includes(search) || token.name.toLowerCase().includes(search))
    : testAssets
      ? snapshot.tokens
      : view === "popular"
        ? [...tokenSymbols, ...popularSymbols].map((symbol) => snapshot.tokens.find((token) => token.symbol === symbol)).filter((token) => token !== undefined)
        : view === "tokens"
          ? snapshot.tokens.filter((token) => !isStockToken(token))
          : snapshot.tokens.filter((token) => token.kind === view);
  // Popular is a short, fixed list (USDG and a dozen tickers), so it is shown whole.
  const visible = view === "popular" && !search && !testAssets ? matches : matches.slice(0, limit);
  const counts = {
    stock: snapshot.tokens.filter((token) => token.kind === "stock").length,
    etf: snapshot.tokens.filter((token) => token.kind === "etf").length,
    tokens: snapshot.tokens.filter((token) => !isStockToken(token)).length,
  };
  const asOf = snapshot.prices.asOf ? new Date(snapshot.prices.asOf) : undefined;

  function changeView(next: View) {
    setView(next);
    setLimit(pageSize);
  }

  return <section className="stock-board" id="stocks" aria-labelledby="stock-board-title" aria-busy={loading}>
    <div className="stock-board-head">
      <h2 id="stock-board-title">{testAssets ? "Test stock board" : "Stock board"}</h2>
      <p>{snapshot.chain.name} · {snapshot.tokens.length} {testAssets ? "faucet tokens" : "tokens"}</p>
    </div>

    {!testAssets && <label className="stock-search">
      <span>Search tokens</span>
      <div><DotIcon name="search" size={15} /><input type="search" value={query} placeholder="Ticker, company or USDG" onChange={(event) => { setQuery(event.target.value); setLimit(pageSize); }} /></div>
    </label>}

    {!testAssets && !search && <div className="stock-views" role="group" aria-label="Stock list" style={{ "--segments": counts.tokens > 0 ? 4 : 3, "--segment": views.indexOf(view) } as CSSProperties}>
      <button type="button" aria-pressed={view === "popular"} onClick={() => changeView("popular")}>Popular</button>
      <button type="button" aria-pressed={view === "stock"} onClick={() => changeView("stock")}>Stocks <span>{counts.stock}</span></button>
      <button type="button" aria-pressed={view === "etf"} onClick={() => changeView("etf")}>ETFs <span>{counts.etf}</span></button>
      {counts.tokens > 0 && <button type="button" aria-pressed={view === "tokens"} onClick={() => changeView("tokens")}>Tokens <span>{counts.tokens}</span></button>}
    </div>}

    {visible.length > 0 ? <ul className="stock-rows" aria-label={search ? "Matching stock tokens" : "Stock tokens"}>
      {visible.map((token, index) => <li key={token.address} style={{ "--row": Math.min(index, 12) } as CSSProperties}>
        {/* Named by what it shows, in order, with the words a glance adds said aloud (audit, 2026-10-06: a name that
            differed from the visible words could not be spoken to a voice-control user). */}
        <button type="button" className={`stock-row ${token.symbol === activeSymbol ? "stock-row-active" : ""}`} onClick={() => onSelect(token)}>
          <span className="stock-row-name"><b>{token.symbol}</b><small>{token.name}</small>{token.kind === "cash" && <span className="visually-hidden">, a dollar stablecoin,</span>}</span>
          <span className="stock-row-price">
            {testAssets ? <b className="stock-test-tag">TEST</b> : token.kind === "cash" ? <b>{formatUsd("1")}</b> : token.price ? <b>{formatUsd(token.price)}<span className="visually-hidden"> per token,</span></b> : <b className="stock-row-no-price">{loading ? "…" : "—"}<span className="visually-hidden">no price yet,</span></b>}
            {token.halted ? <small className="stock-halted">Halted</small> : <small className="stock-row-send">Send</small>}
          </span>
        </button>
      </li>)}
    </ul> : <p className="stock-empty">No token matches “{query.trim()}”.</p>}

    {matches.length > visible.length && <button type="button" className="stock-more" onClick={() => setLimit((current) => current + 20)}>
      Show {Math.min(20, matches.length - visible.length)} more
    </button>}

    <div className="stock-notes">
      {testAssets
        ? <p>Robinhood Chain Testnet faucet tokens. They have no real value. Contracts checked on chain on {snapshot.allowlistVerifiedOn}.</p>
        : <p>{snapshot.prices.status === "live"
          ? <>Indicative prices from Robinhood’s public Stock Token API{asOf && !Number.isNaN(asOf.getTime()) ? <>, {new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(asOf)}</> : null}.</>
          : loading ? "Loading prices…" : "Prices are unavailable right now; the token list is still verified."} Contracts checked on chain on {snapshot.allowlistVerifiedOn}.</p>}
      {!testAssets && <p>Stock Tokens give economic exposure, not ownership of the underlying shares. They are not for U.S. persons, and other regional restrictions apply.</p>}
      {!testAssets && counts.tokens > 0 && <p>USDG (Global Dollar) is a dollar stablecoin issued by Paxos and shown at $1. Its issuer can pause transfers and freeze addresses.</p>}
      <p>HaPaPay is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.</p>
      <div className="stock-links">
        {testAssets && <a href={ROBINHOOD_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">Get test tokens <DotIcon name="arrow-up-right" size={13} /></a>}
        <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">About Stock Tokens <DotIcon name="arrow-up-right" size={13} /></a>
      </div>
    </div>
  </section>;
}
