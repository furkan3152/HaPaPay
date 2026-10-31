import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { countdown, ELYSIUM_MAINNET_LAUNCH, type ElysiumBlock, type ElysiumLiveStats, type ElysiumNetworkId } from "../domain/elysium";
import { api, compact, pct, usd } from "./api";
import { useSession } from "./session";

/** Fades and lifts its content in as it scrolls into view (once). Reduced motion shows it as is. */
export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const node = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = node.current;
    if (!element || typeof IntersectionObserver === "undefined") return setShown(true);
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setShown(true);
        observer.disconnect();
      }
    }, { threshold: 0.15 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={node} className={`reveal ${shown ? "is-in" : ""} ${className}`} style={{ "--delay": `${delay}ms` } as CSSProperties}>{children}</div>;
}

/** A number that rolls to its new value instead of jumping. */
export function Ticker({ value, format = (n: number) => n.toLocaleString("en-US") }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(value);
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(origin + (value - origin) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className="ticker">{format(Math.round(shown))}</span>;
}

/** Live block height, block time and payment cost for a network, read every two seconds while on screen. */
export function useStats(networkId: ElysiumNetworkId, enabled = true) {
  const [stats, setStats] = useState<ElysiumLiveStats>();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const read = () => !document.hidden && api<ElysiumLiveStats>(`/api/elysium/stats/${networkId}`).then((value) => { if (!cancelled) setStats(value); }).catch(() => undefined);
    void read();
    const timer = window.setInterval(read, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [networkId, enabled]);
  return stats;
}

/**
 * The block river: Elysium's newest blocks flowing in from the left, about ten a second. Each tile is a block; its
 * glow is how many transactions it carried. It is the chain itself, read once a second, not an illustration.
 */
export function BlockRiver({ networkId, compactView = false }: { networkId: ElysiumNetworkId; compactView?: boolean }) {
  const [blocks, setBlocks] = useState<ElysiumBlock[]>([]);
  const [error, setError] = useState(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    const read = () => !document.hidden && api<{ blocks: ElysiumBlock[] }>(`/api/elysium/blocks/${networkId}`).then((value) => {
      if (cancelled) return;
      setError(false);
      setBlocks(value.blocks);
    }).catch(() => { if (!cancelled) setError(true); });
    void read();
    const timer = window.setInterval(read, 1_200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [networkId]);
  const busiest = Math.max(1, ...blocks.map((block) => block.txCount));
  const shown = blocks.slice(0, compactView ? 14 : 28);
  const span = blocks.length > 1 ? (blocks[0].timestamp - blocks[blocks.length - 1].timestamp) : 0;
  const rate = span > 0 ? blocks.length / span : undefined;
  return <div className={`river ${compactView ? "river-compact" : ""}`} aria-label="Newest Elysium blocks">
    <div className="river-track">
      {shown.map((block, index) => {
        const fresh = !seen.current.has(block.number);
        seen.current.add(block.number);
        return <div key={block.number} className={`river-block ${fresh && index < 6 ? "is-fresh" : ""}`} style={{ "--heat": block.txCount / busiest, "--i": index } as CSSProperties} title={`Block ${block.number} · ${block.txCount} tx`}>
          <span>#{Number(block.number).toLocaleString("en-US")}</span>
          <b>{block.txCount}<small> tx</small></b>
        </div>;
      })}
      {!shown.length && <div className="river-empty">{error ? "The chain could not be read right now." : "Listening to Elysium…"}</div>}
    </div>
    {!compactView && <p className="river-caption">{rate ? `${rate.toFixed(1)} blocks per second right now` : "Reading blocks…"} · live from Elysium {networkId === "elysium-mainnet" ? "mainnet" : "Testnet"}</p>}
  </div>;
}

/** Hyperliquid's tape, sliding: HYPE first. */
export function MarketTape() {
  const { markets } = useSession();
  if (!markets?.length) return null;
  return <div className="tape" aria-label="Hyperliquid perps">
    <div className="tape-track">
      {[...markets, ...markets].map((market, index) => <span key={`${market.coin}-${index}`} aria-hidden={index >= markets.length} data-up={(market.change24h ?? 0) >= 0}>
        <b>{market.coin}</b> {usd(market.mid, market.mid < 10 ? 4 : 2)} <i>{market.change24h === null ? "" : pct(market.change24h)}</i>
        {market.openInterest !== null && <small>OI ${compact(market.openInterest)}</small>}
      </span>)}
    </div>
  </div>;
}

/** Days, hours, minutes and seconds to Elysium's planned mainnet launch. */
export function LaunchCountdown({ large = false }: { large?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = countdown(ELYSIUM_MAINNET_LAUNCH, now);
  if (left.done) return <p className="countdown-done">Elysium mainnet launch day is here.</p>;
  return <div className={`countdown ${large ? "countdown-large" : ""}`} role="timer" aria-label={`${left.days} days ${left.hours} hours ${left.minutes} minutes until Elysium mainnet`}>
    {([[left.days, "days"], [left.hours, "hours"], [left.minutes, "min"], [left.seconds, "sec"]] as const).map(([value, label]) => <span key={label}>
      <b key={`${label}-${value}`}>{String(value).padStart(2, "0")}</b><small>{label}</small>
    </span>)}
  </div>;
}

/** A small live dot: mint while the chain answers. */
export function LiveDot({ live }: { live: boolean }) {
  return <span className={`live-dot ${live ? "is-live" : ""}`} aria-hidden="true" />;
}
