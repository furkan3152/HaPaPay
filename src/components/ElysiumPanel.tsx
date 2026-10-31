import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { type Hex } from "viem";
import { countdown, elysiumTxUrl, HYPE, type ElysiumLiveStats, type ElysiumMarket, type ElysiumNetworkId, type ElysiumNetworkView, type ElysiumPaymentRecord } from "../domain/elysium";
import { platformName, type Platform } from "../domain/payment-intent";
import { elysiumApi, sendElysiumTransaction, waitForServer } from "../elysium-desk";
import { playCue, speak } from "../sound";
import { evmProvider } from "../wallet/wallet-bridge";
import { DotText } from "./DotText";
import "./elysium-panel.css";

type Prepared = {
  network: ElysiumNetworkId; chainId: string; to: string; value: string; data: Hex; gas: string;
  recipient: string; platform: Platform; username: string; amount: string; fee: string;
  display: { amount: string; fee: string; total: string }; note: string;
};
type Phase = { kind: "idle" } | { kind: "review"; prepared: Prepared } | { kind: "signing"; prepared: Prepared } | { kind: "waiting"; prepared: Prepared; hash: string } | { kind: "done"; payment: ElysiumPaymentRecord } | { kind: "error"; text: string };

const PLATFORMS: Platform[] = ["x", "github", "telegram", "discord", "farcaster"];
const usd = (value: number, digits = 2) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) });
const compact = (value: number) => value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

/**
 * The desk's Elysium panel: pay a verified handle in HYPE on Elysium, with the chain's pulse (block height, ~100 ms
 * block time, what a payment costs right now) and Hyperliquid's markets beside it, so an amount can be written in
 * dollars and settled in HYPE at the live mid. The server prepares the exact router call; the wallet signs it; the
 * payment is recorded only from its receipt.
 */
export default function ElysiumPanel({ wallet, onConnect, visible }: { wallet?: string; onConnect: () => void; visible: boolean }) {
  const [networks, setNetworks] = useState<ElysiumNetworkView[]>();
  const [paused, setPaused] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [networkId, setNetworkId] = useState<ElysiumNetworkId>("elysium-testnet");
  const [stats, setStats] = useState<ElysiumLiveStats>();
  const [markets, setMarkets] = useState<ElysiumMarket[]>();
  const [platform, setPlatform] = useState<Platform>("x");
  const [username, setUsername] = useState("");
  const [amount, setAmount] = useState("");
  const [inDollars, setInDollars] = useState(false);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [history, setHistory] = useState<ElysiumPaymentRecord[]>();
  const [now, setNow] = useState(Date.now());
  const pulse = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    elysiumApi<{ networks: ElysiumNetworkView[]; paused: { message: string } | null }>("/api/elysium")
      .then((value) => {
        if (cancelled) return;
        setNetworks(value.networks);
        setPaused(value.paused?.message);
        // Mainnet becomes the default the moment it is open.
        if (value.networks.find((entry) => entry.id === "elysium-mainnet")?.enabled) setNetworkId((current) => current === "elysium-testnet" && !sessionStorage.getItem("elysapay.network") ? "elysium-mainnet" : current);
      })
      .catch((reason) => { if (!cancelled) setLoadError(reason instanceof Error ? reason.message : "Elysium could not be read."); });
    return () => { cancelled = true; };
  }, [visible]);

  const view = networks?.find((entry) => entry.id === networkId);

  // The chain's pulse: every four seconds while the panel is open and the network has an RPC.
  useEffect(() => {
    if (!visible || !view?.rpcUrl) return setStats(undefined);
    let cancelled = false;
    const read = () => elysiumApi<ElysiumLiveStats>(`/api/elysium/stats/${networkId}`).then((value) => {
      if (cancelled) return;
      setStats(value);
      pulse.current?.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2.4)", opacity: 0 }], { duration: 900, easing: "ease-out" });
    }).catch(() => undefined);
    void read();
    const timer = window.setInterval(read, 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [visible, networkId, view?.rpcUrl]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const read = () => elysiumApi<{ markets: ElysiumMarket[] }>("/api/elysium/markets").then((value) => { if (!cancelled) setMarkets(value.markets); }).catch(() => undefined);
    void read();
    const timer = window.setInterval(read, 15_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { cancelled = true; window.clearInterval(timer); window.clearInterval(clock); };
  }, [visible]);

  const loadHistory = () => {
    if (!wallet) return setHistory(undefined);
    elysiumApi<{ payments: ElysiumPaymentRecord[] }>("/api/elysium/payments").then((value) => setHistory(value.payments)).catch(() => setHistory([]));
  };
  useEffect(() => { if (visible) loadHistory(); }, [visible, wallet]);

  const hype = markets?.find((market) => market.coin === "HYPE");
  /** The amount in HYPE that goes to the server: typed in HYPE, or converted from dollars at the live mid. */
  const hypeAmount = useMemo(() => {
    const value = Number(amount.replace(",", "."));
    if (!amount.trim() || !Number.isFinite(value) || value <= 0) return "";
    if (!inDollars) return amount.trim().replace(",", ".");
    if (!hype) return "";
    return (value / hype.mid).toFixed(6).replace(/\.?0+$/, "");
  }, [amount, inDollars, hype]);

  const pickNetwork = (id: ElysiumNetworkId) => {
    sessionStorage.setItem("elysapay.network", id);
    setNetworkId(id);
    setPhase({ kind: "idle" });
  };

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!wallet) return onConnect();
    if (!hypeAmount) return setPhase({ kind: "error", text: inDollars && !hype ? "The HYPE price is not loaded yet; write the amount in HYPE." : "Write an amount." });
    try {
      const prepared = await elysiumApi<Prepared>("/api/elysium/payments/prepare", { network: networkId, platform, username, amount: hypeAmount, note });
      setPhase({ kind: "review", prepared });
      playCue("open");
      speak(`Review. Send ${prepared.display.amount} HYPE to ${prepared.username} on ${platformName(prepared.platform)}, on ${view?.chainName ?? "Elysium"}. The fee is ${prepared.display.fee} HYPE, for a total of ${prepared.display.total} HYPE.`);
    } catch (reason) {
      playCue("error");
      setPhase({ kind: "error", text: reason instanceof Error ? reason.message : "The payment could not be prepared." });
    }
  }

  async function sign(prepared: Prepared) {
    const provider = evmProvider();
    if (!provider || !wallet || !view) return onConnect();
    setPhase({ kind: "signing", prepared });
    try {
      // The wallet is asked for exactly what was reviewed: the router, the value and the call the server prepared.
      if (prepared.to.toLowerCase() !== view.contracts.router?.toLowerCase()) throw new Error("The prepared payment does not go to the ElysaPay router this network lists. Nothing was signed.");
      const hash = await sendElysiumTransaction(provider, wallet, view, { to: prepared.to, data: prepared.data, value: BigInt(prepared.value), gas: BigInt(prepared.gas) });
      playCue("send");
      setPhase({ kind: "waiting", prepared, hash });
      const result = await waitForServer(() => elysiumApi<{ status: "pending" } | { status: "confirmed"; payment: ElysiumPaymentRecord }>("/api/elysium/payments/confirm", { network: networkId, hash, platform: prepared.platform, username: prepared.username }), 60, 1_000);
      if (result.status !== "confirmed") throw new Error("The payment is not confirmed yet.");
      setPhase({ kind: "done", payment: result.payment });
      playCue("success");
      speak(`Sent. ${result.payment.username} received ${result.payment.amount} HYPE.`);
      setAmount("");
      setNote("");
      loadHistory();
    } catch (reason) {
      playCue("error");
      setPhase({ kind: "error", text: reason instanceof Error ? reason.message.split("\n")[0] : "The payment did not go through." });
    }
  }

  if (loadError) return <p className="stock-empty" role="alert">{loadError}</p>;
  if (!networks || !view) return <p className="stock-empty" aria-busy="true">Reading Elysium…</p>;
  const launch = view.launch ? countdown(view.launch, now) : undefined;
  const open = view.enabled && Boolean(view.contracts.router) && !paused;
  const usdValue = hype && hypeAmount ? Number(hypeAmount) * hype.mid : undefined;

  return <div className="elysium-panel">
    <div className="elysium-head">
      <DotText as="h2" text="Elysium" />
      <span className="elysium-live" data-live={Boolean(stats)}><span ref={pulse} aria-hidden="true" />{stats ? "live" : view.enabled ? "connecting" : "off"}</span>
    </div>
    <div className="board-networks elysium-networks" role="group" aria-label="Elysium network" style={{ "--segment": networkId === "elysium-testnet" ? 0 : 1 } as CSSProperties}>
      {networks.map((entry) => <button key={entry.id} type="button" aria-pressed={networkId === entry.id} onClick={() => pickNetwork(entry.id)}>{entry.environment === "mainnet" ? "Mainnet" : "Testnet"}</button>)}
    </div>

    {stats ? <dl className="elysium-pulse">
      <div><dt>Block</dt><dd>{Number(stats.blockNumber).toLocaleString("en-US")}</dd></div>
      <div><dt>Block time</dt><dd>{stats.blockTimeMs ? `${stats.blockTimeMs} ms` : "—"}</dd></div>
      <div><dt>Payment gas</dt><dd>{Number(stats.paymentCostHype) < 0.000001 ? "<0.000001" : stats.paymentCostHype} HYPE</dd></div>
    </dl> : launch && !launch.done && !view.enabled ? <div className="elysium-countdown-card">
      <p>Elysium mainnet launches in</p>
      <div className="elysium-clock" aria-label={`${launch.days} days ${launch.hours} hours ${launch.minutes} minutes`}>
        {[[launch.days, "days"], [launch.hours, "hrs"], [launch.minutes, "min"], [launch.seconds, "sec"]].map(([value, label]) => <span key={label}><DotText text={String(value).padStart(2, "0")} /><small>{label}</small></span>)}
      </div>
      <small>Planned for Nov 9, 2026. Try everything on testnet until then.</small>
    </div> : null}

    {markets && markets.length > 0 && <div className="elysium-markets" aria-label="Hyperliquid perps">
      <div className="elysium-tape"><div className="elysium-ticker">{[...markets, ...markets].map((market, index) => <span key={`${market.coin}-${index}`} aria-hidden={index >= markets.length} data-up={(market.change24h ?? 0) >= 0}>
        <b>{market.coin}</b> {usd(market.mid, market.mid < 10 ? 4 : 2)} <i>{market.change24h === null ? "" : percent(market.change24h)}</i>
      </span>)}</div></div>
      {hype && <dl className="elysium-hype">
        <div><dt>HYPE funding / h</dt><dd>{hype.funding === null ? "—" : percent(hype.funding, 4)}</dd></div>
        <div><dt>Open interest</dt><dd>{hype.openInterest === null ? "—" : `$${compact(hype.openInterest)}`}</dd></div>
        <div><dt>24h volume</dt><dd>{hype.dayVolumeUsd === null ? "—" : `$${compact(hype.dayVolumeUsd)}`}</dd></div>
      </dl>}
      <small className="elysium-source">Hyperliquid perps, read from Hyperliquid's public API. Not advice.</small>
    </div>}

    {phase.kind === "review" || phase.kind === "signing" || phase.kind === "waiting" ? <article className="payment-slip elysium-slip" data-network-theme="elysium" aria-live="polite">
      <header><DotText as="h3" text="Review" /><span>{view.chainName}</span></header>
      <dl>
        <div><dt>Recipient</dt><dd>@{phase.prepared.username} · {platformName(phase.prepared.platform)}<small>{short(phase.prepared.recipient)} · verified</small></dd></div>
        <div><dt>Amount</dt><dd>{phase.prepared.display.amount} HYPE{hype ? <small>≈ {usd(Number(phase.prepared.display.amount) * hype.mid)}</small> : null}</dd></div>
        <div><dt>Fee</dt><dd>{phase.prepared.display.fee} HYPE<small>1%, added on top; the recipient gets exactly the amount</small></dd></div>
        <div><dt>Total</dt><dd><b>{phase.prepared.display.total} HYPE</b><small>plus gas{stats ? ` (about ${stats.paymentCostHype} HYPE)` : ""}</small></dd></div>
        {phase.prepared.note && <div><dt>Note</dt><dd>{phase.prepared.note}<small>written on chain</small></dd></div>}
      </dl>
      {phase.kind === "waiting" ? <p className="elysium-status" role="status"><span className="elysium-spinner" aria-hidden="true" />Confirming on {view.chainName}… {view.explorerUrl && <a href={elysiumTxUrl(view, phase.hash)} target="_blank" rel="noreferrer">View</a>}</p>
        : <div className="elysium-actions">
          <button type="button" className="primary" disabled={phase.kind === "signing"} onClick={() => void sign(phase.prepared)}>{phase.kind === "signing" ? "Open your wallet…" : "Sign and send"}</button>
          <button type="button" onClick={() => setPhase({ kind: "idle" })}>Edit</button>
        </div>}
    </article> : phase.kind === "done" ? <article className="payment-slip elysium-slip elysium-done" data-network-theme="elysium" role="status">
      <div className="elysium-burst" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ "--i": index } as CSSProperties} />)}</div>
      <svg className="elysium-wreath" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <defs><linearGradient id="ew-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FBE7AE" /><stop offset="55%" stopColor="#D8B15A" /><stop offset="100%" stopColor="#9C7A2E" /></linearGradient></defs>
        <path d="M44 106 C18 92 10 60 26 30" pathLength={1} />
        <path d="M76 106 C102 92 110 60 94 30" pathLength={1} />
        {Array.from({ length: 7 }, (_, index) => {
          const t = index / 6;
          const left = { x: 44 - 30 * Math.sin(t * 1.7) - 4 * t, y: 106 - 74 * t };
          return <g key={index}>
            <ellipse className="ew-leaf" style={{ "--i": index } as CSSProperties} cx={left.x - 6} cy={left.y - 3} rx="7" ry="3" transform={`rotate(${-30 - index * 8} ${left.x - 6} ${left.y - 3})`} />
            <ellipse className="ew-leaf" style={{ "--i": index } as CSSProperties} cx={120 - left.x + 6} cy={left.y - 3} rx="7" ry="3" transform={`rotate(${30 + index * 8} ${120 - left.x + 6} ${left.y - 3})`} />
          </g>;
        })}
        <text x="60" y="72" textAnchor="middle">Ε</text>
      </svg>
      <DotText as="h3" text="Sent" />
      <p>@{phase.payment.username} received <b>{phase.payment.amount} HYPE</b> on {view.chainName}.</p>
      <div className="elysium-actions">
        {view.explorerUrl && <a className="button-link" href={elysiumTxUrl(view, phase.payment.hash)} target="_blank" rel="noreferrer">View on the explorer</a>}
        <button type="button" onClick={() => setPhase({ kind: "idle" })}>New payment</button>
      </div>
    </article> : <form className="elysium-form" onSubmit={review}>
      {!open && <p className="elysium-locked">{paused ?? view.reason ?? "Payments are not open on this network."}</p>}
      <div className="elysium-row">
        <label>Platform<select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{PLATFORMS.map((entry) => <option key={entry} value={entry}>{platformName(entry)}</option>)}</select></label>
        <label>Handle<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="@alice" autoComplete="off" required /></label>
      </div>
      <div className="elysium-row">
        <label>Amount<span className="elysium-amount"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder={inDollars ? "25" : "0.5"} required />
          <button type="button" className="elysium-unit" aria-label={`Amount in ${inDollars ? "dollars" : "HYPE"}; switch`} onClick={() => setInDollars((value) => !value)}>{inDollars ? "USD" : HYPE.symbol}</button></span></label>
      </div>
      {hypeAmount && <p className="elysium-convert">{inDollars ? `≈ ${hypeAmount} HYPE at ${usd(hype?.mid ?? 0, 4)}` : usdValue !== undefined ? `≈ ${usd(usdValue)}` : ""}</p>}
      <label>Note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={140} placeholder="for the pizza" /></label>
      {phase.kind === "error" && <p className="elysium-error" role="alert">{phase.text}</p>}
      <button type="submit" className="primary" disabled={!open}>{wallet ? "Review" : "Connect to pay"}</button>
      {view.faucetUrl && <p className="elysium-hint">Need testnet HYPE? <a href={view.faucetUrl} target="_blank" rel="noreferrer">Kinetiq's faucet</a>{view.bridgeUrl && <> or <a href={view.bridgeUrl} target="_blank" rel="noreferrer">the bridge</a></>}.</p>}
    </form>}

    {wallet && history && history.length > 0 && <section className="elysium-history" aria-label="Your Elysium payments">
      <h3>Your Elysium payments</h3>
      <ul>{history.slice(0, 8).map((payment) => {
        const out = payment.payer.toLowerCase() === wallet.toLowerCase();
        const entry = networks.find((candidate) => candidate.id === payment.network);
        return <li key={payment.hash} data-direction={out ? "out" : "in"}>
          <span>{out ? `To @${payment.username}` : `From ${short(payment.payer)}`}<small>{entry?.chainName} · {new Date(payment.confirmedAt).toLocaleDateString("en")}</small></span>
          <a href={entry ? elysiumTxUrl(entry, payment.hash) : undefined} target="_blank" rel="noreferrer">{out ? "−" : "+"}{payment.amount} HYPE</a>
        </li>;
      })}</ul>
    </section>}
  </div>;
}
