import { useState, type CSSProperties } from "react";
import { isSolanaStock, SOLANA_ASSETS_VERIFIED_ON, type SolanaAssetListing } from "../domain/solana-assets";
import { SOLANA_ASSETS, SOLANA_XSTOCKS_VERIFIED_ON } from "../domain/solana-stocks";
import "./stock-token-list.css";
import "./solana.css";
import { DotIcon } from "./DotIcon";
import { formatUsd } from "./StockTokenList";

const popular = ["USDC", "USDG", "NVDAx", "AAPLx", "TSLAx", "MSFTx", "AMZNx", "GOOGLx", "METAx", "SPYx", "QQQx", "COINx", "MSTRx"];
const views = ["popular", "stock", "etf", "tokens"] as const;
const pageSize = 12;
type View = typeof views[number];

/**
 * The Solana board, in the stock board's own style: USDC and USDG, and every xStock checked on chain. SOL is not
 * sent, so it is not on the board. Prices
 * come from the server (Jupiter's public price API) and are indicative only; picking a row writes a request.
 */
export default function SolanaStockBoard({ quotes, asOf, stocksLive, activeSymbol, onSelect }: {
  quotes: Record<string, number>;
  asOf?: string;
  stocksLive: boolean;
  activeSymbol?: string;
  onSelect: (asset: SolanaAssetListing) => void;
}) {
  const [view, setView] = useState<View>("popular");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(pageSize);
  const search = query.trim().toLowerCase();
  const matches = search
    ? SOLANA_ASSETS.filter((asset) => asset.symbol.toLowerCase().includes(search) || asset.ticker.toLowerCase().includes(search) || asset.name.toLowerCase().includes(search))
    : view === "popular"
      ? popular.map((symbol) => SOLANA_ASSETS.find((asset) => asset.symbol === symbol)).filter((asset): asset is SolanaAssetListing => asset !== undefined)
      : view === "tokens"
        ? SOLANA_ASSETS.filter((asset) => !isSolanaStock(asset))
        : SOLANA_ASSETS.filter((asset) => asset.kind === view);
  const visible = view === "popular" && !search ? matches : matches.slice(0, limit);
  const counts = {
    stock: SOLANA_ASSETS.filter((asset) => asset.kind === "stock").length,
    etf: SOLANA_ASSETS.filter((asset) => asset.kind === "etf").length,
    tokens: SOLANA_ASSETS.filter((asset) => !isSolanaStock(asset)).length,
  };
  const when = asOf ? new Date(asOf) : undefined;
  const price = (asset: SolanaAssetListing) => asset.kind === "cash" ? 1 : quotes[asset.symbol];

  function changeView(next: View) {
    setView(next);
    setLimit(pageSize);
  }

  return <section className="stock-board solana-board" aria-labelledby="solana-board-title">
    <div className="stock-board-head">
      <h2 id="solana-board-title">Solana board</h2>
      <p>Solana · {SOLANA_ASSETS.length} assets</p>
    </div>
    <label className="stock-search">
      <span>Search Solana assets</span>
      <div><DotIcon name="search" size={15} /><input type="search" value={query} placeholder="Ticker, company or USDC" onChange={(event) => { setQuery(event.target.value); setLimit(pageSize); }} /></div>
    </label>
    {!search && <div className="stock-views" role="group" aria-label="Solana list" style={{ "--segments": 4, "--segment": views.indexOf(view) } as CSSProperties}>
      <button type="button" aria-pressed={view === "popular"} onClick={() => changeView("popular")}>Popular</button>
      <button type="button" aria-pressed={view === "stock"} onClick={() => changeView("stock")}>xStocks <span>{counts.stock}</span></button>
      <button type="button" aria-pressed={view === "etf"} onClick={() => changeView("etf")}>ETFs <span>{counts.etf}</span></button>
      <button type="button" aria-pressed={view === "tokens"} onClick={() => changeView("tokens")}>Tokens <span>{counts.tokens}</span></button>
    </div>}
    {visible.length > 0 ? <ul className="stock-rows" aria-label={search ? "Matching Solana assets" : "Solana assets"}>
      {visible.map((asset, index) => {
        const value = price(asset);
        return <li key={asset.symbol} style={{ "--row": Math.min(index, 12) } as CSSProperties}>
          {/* Named by what it shows, in order (audit, 2026-10-06), with the words a glance adds said aloud. */}
          <button type="button" className={`stock-row ${asset.symbol === activeSymbol ? "stock-row-active" : ""}`} onClick={() => onSelect(asset)}>
            <span className="stock-row-name"><b>{asset.symbol}</b><small>{asset.name}</small>{asset.kind === "cash" && <span className="visually-hidden">, a dollar stablecoin,</span>}</span>
            <span className="stock-row-price">
              {value ? <b>{formatUsd(String(value))}{isSolanaStock(asset) && <span className="visually-hidden"> per share,</span>}</b> : <b className="stock-row-no-price">—<span className="visually-hidden">no price yet,</span></b>}
              {isSolanaStock(asset) && !stocksLive ? <small className="stock-halted"><span className="visually-hidden">Transfers </span>Off</small> : <small className="stock-row-send">Send</small>}
            </span>
          </button>
        </li>;
      })}
    </ul> : <p className="stock-empty">No asset matches “{query.trim()}”.</p>}
    {matches.length > visible.length && <button type="button" className="stock-more" onClick={() => setLimit((current) => current + 20)}>
      Show {Math.min(20, matches.length - visible.length)} more
    </button>}
    <div className="stock-notes">
      <p>{Object.keys(quotes).length ? <>Indicative prices from Jupiter{when && !Number.isNaN(when.getTime()) ? <>, {new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(when)}</> : null}; an xStock shows its share price.</> : "Prices are unavailable right now; the asset list is still verified."} Mints checked on chain on {SOLANA_XSTOCKS_VERIFIED_ON > SOLANA_ASSETS_VERIFIED_ON ? SOLANA_XSTOCKS_VERIFIED_ON : SOLANA_ASSETS_VERIFIED_ON}.</p>
      <p>xStocks are tokens that track shares and give economic exposure, not ownership of them. They are not for U.S. persons, and other regional restrictions apply.{stocksLive ? "" : " xStocks transfers are off on this server until the operator turns them on."}</p>
      <p>USDC and USDG are dollar stablecoins shown at $1; their issuers can pause transfers and freeze balances. HaPaPay is not affiliated with Solana, the xStocks issuer, Circle or Paxos.</p>
      <div className="stock-links">
        <a href="https://xstocks.fi" target="_blank" rel="noreferrer">About xStocks <DotIcon name="arrow-up-right" size={13} /></a>
      </div>
    </div>
  </section>;
}
