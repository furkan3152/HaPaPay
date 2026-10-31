import { lazy, Suspense, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { onSoundChange, setSound, setVoice, soundEnabled, voiceAvailable, voiceEnabled } from "../sound";
import { short } from "./api";
import { Logo } from "./Logo";
import { linkProps, navigate, usePath } from "./router";
import { SessionProvider, useSession } from "./session";
import { Sky } from "./Sky";
import { BlockRiver, LiveDot, MarketTape, Ticker, useStats } from "./widgets";
import { Home } from "./pages/Home";
import { SendPage } from "./pages/Send";
import { SplitPage } from "./pages/Split";
import { RequestPage } from "./pages/Request";
import { ActivityPage } from "./pages/Activity";
import { IdentityPage } from "./pages/Identity";
import { ReceiptPage } from "./pages/Receipt";
import { DocsPage } from "./pages/Docs";
import "./elysa.css";

const AdminPage = lazy(() => import("../components/AdminPage"));

const APP_TABS = [
  ["/app", "Send", "M4 12h13M12 5l7 7-7 7"],
  ["/app/split", "Split", "M12 4v6M12 10l-6 9M12 10l6 9"],
  ["/app/request", "Request", "M12 20V7M5 12l7-7 7 7"],
  ["/app/activity", "Activity", "M4 13h4l2-6 4 12 2-6h4"],
  ["/app/identity", "Identity", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9c.6-3.5 3.4-6 7-6s6.4 2.5 7 6"],
] as const;

export function ElysaApp() {
  return <SessionProvider><Shell /></SessionProvider>;
}

function readMotion() {
  try {
    return localStorage.getItem("elysa.motion") !== "off";
  } catch {
    return true;
  }
}

function Shell() {
  const path = usePath();
  const pathname = path.split("?")[0];
  const [motion, setMotion] = useState(readMotion);
  const home = pathname === "/";
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? "on" : "off";
    try { localStorage.setItem("elysa.motion", motion ? "on" : "off"); } catch { /* private mode */ }
  }, [motion]);
  useEffect(() => {
    const titles: Record<string, string> = { "/": "ElysaPay · Pay anyone on Elysium by name", "/docs": "How ElysaPay works · ElysaPay", "/admin": "Admin · ElysaPay" };
    document.title = titles[pathname] ?? (pathname.startsWith("/r/") ? "Receipt · ElysaPay" : "ElysaPay");
  }, [pathname]);

  let page: ReactNode;
  const pay = pathname.match(/^\/pay\/(github|x|telegram|discord|farcaster)\/([^/]{1,64})$/);
  const receipt = pathname.match(/^\/r\/(elysium-testnet|elysium-mainnet)\/(0x[0-9a-fA-F]{64})$/);
  if (home) page = <Home motion={motion} />;
  else if (pathname === "/docs") page = <DocsPage />;
  else if (pathname === "/admin") page = <AdminGate />;
  else if (receipt) page = <ReceiptPage network={receipt[1] as "elysium-testnet" | "elysium-mainnet"} hash={receipt[2]} />;
  else if (pay || pathname.startsWith("/app")) page = <AppLayout pathname={pathname}>
    {pay ? <SendPage payTo={{ platform: pay[1] as never, username: decodeURIComponent(pay[2]) }} />
      : pathname === "/app/split" ? <SplitPage />
      : pathname === "/app/request" ? <RequestPage />
      : pathname === "/app/activity" ? <ActivityPage />
      : pathname === "/app/identity" ? <IdentityPage />
      : <SendPage />}
  </AppLayout>;
  else page = <NotFound />;

  return <div className={`elysa ${home ? "is-home" : ""}`}>
    <Sky motion={motion} variant={home ? "hero" : "app"} />
    <TopBar pathname={pathname} />
    <Notice />
    <main className="elysa-main" key={pathname}>{page}</main>
    <Footer motion={motion} onMotion={() => setMotion((value) => !value)} />
  </div>;
}

function TopBar({ pathname }: { pathname: string }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const live = Boolean(session.network?.enabled);
  return <header className="topbar">
    <a className="topbar-brand" aria-label="ElysaPay home" {...linkProps("/")}><Logo /></a>
    <nav className="topbar-nav" aria-label="Main">
      <a {...linkProps("/app")} aria-current={pathname.startsWith("/app") || pathname.startsWith("/pay") ? "page" : undefined}>App</a>
      <a {...linkProps("/docs")} aria-current={pathname === "/docs" ? "page" : undefined}>Docs</a>
      {session.wallet && <a {...linkProps("/admin")} aria-current={pathname === "/admin" ? "page" : undefined}>Admin</a>}
    </nav>
    <div className="topbar-actions">
      <div className="net-switch" role="radiogroup" aria-label="Elysium network">
        {(session.networks ?? []).map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={session.networkId === entry.id} onClick={() => session.setNetworkId(entry.id)} title={entry.reason ?? entry.chainName}>
          <LiveDot live={entry.enabled} /> {entry.environment === "mainnet" ? "Mainnet" : "Testnet"}
        </button>)}
      </div>
      <SoundToggle />
      {session.wallet
        ? <div className="wallet-menu" ref={menu}>
          <button type="button" className="btn btn-glass wallet-chip" aria-expanded={open} onClick={() => setOpen((value) => !value)}><LiveDot live={live} /> {short(session.wallet)}</button>
          {open && <div className="wallet-pop" role="menu">
            <a role="menuitem" {...linkProps("/app/identity")} onClick={(event) => { event.preventDefault(); setOpen(false); navigate("/app/identity"); }}>Identity</a>
            <a role="menuitem" {...linkProps("/app/activity")} onClick={(event) => { event.preventDefault(); setOpen(false); navigate("/app/activity"); }}>Activity</a>
            <button role="menuitem" type="button" onClick={() => { setOpen(false); void session.disconnect(); }}>Disconnect</button>
          </div>}
        </div>
        : <button type="button" className="btn btn-aurora" disabled={session.status === "connecting"} onClick={() => void session.connect()}>{session.status === "connecting" ? "Connecting…" : "Connect"}</button>}
    </div>
  </header>;
}

function SoundToggle() {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => onSoundChange(rerender), []);
  const sound = soundEnabled();
  const voice = voiceEnabled();
  return <div className="sound-toggles">
    <button type="button" className="icon-btn" aria-pressed={sound} onClick={() => setSound(!sound)} aria-label={sound ? "Turn sound off" : "Turn sound on"} title={sound ? "Sound on" : "Sound off"}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" />{sound ? <path className="wave" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" /> : <path className="wave" d="m16 9 5 6m0-6-5 6" />}</svg>
    </button>
    {voiceAvailable() && <button type="button" className="icon-btn" aria-pressed={voice} onClick={() => setVoice(!voice)} aria-label={voice ? "Stop reading reviews aloud" : "Read reviews aloud"} title={voice ? "Voice on" : "Voice off"}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path className="wave" d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>
    </button>}
  </div>;
}

function Notice() {
  const { notice, setNotice } = useSession();
  if (!notice) return null;
  return <div className="toast" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}>×</button></div>;
}

/** The app: a rail of sections, the page, and the network's pulse beside it. */
function AppLayout({ pathname, children }: { pathname: string; children: ReactNode }) {
  const session = useSession();
  const stats = useStats(session.networkId, Boolean(session.network?.rpcUrl));
  return <div className="app-grid">
    <nav className="app-rail" aria-label="App">
      {APP_TABS.map(([to, label, icon]) => <a key={to} {...linkProps(to)} aria-current={pathname === to || (to === "/app" && pathname.startsWith("/pay/")) ? "page" : undefined}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon} /></svg><span>{label}</span>
      </a>)}
    </nav>
    <section className="app-main">{children}</section>
    <aside className="app-side" aria-label="Elysium right now">
      <div className="glass side-card">
        <header><h2>{session.network?.chainName ?? "Elysium"}</h2><span className={`chip ${stats ? "chip-live" : ""}`}><LiveDot live={Boolean(stats)} />{stats ? "live" : session.network?.enabled ? "connecting" : "off"}</span></header>
        {stats ? <dl className="side-stats">
          <div><dt>Block</dt><dd><Ticker value={Number(stats.blockNumber)} /></dd></div>
          <div><dt>Block time</dt><dd>{stats.blockTimeMs ? `${stats.blockTimeMs} ms` : "—"}</dd></div>
          <div><dt>Payment gas</dt><dd>{Number(stats.paymentCostHype) < 0.000001 ? "<0.000001" : stats.paymentCostHype} HYPE</dd></div>
          <div><dt>HYPE</dt><dd>{session.hype ? `$${session.hype.mid.toFixed(2)}` : "—"}</dd></div>
        </dl> : <p className="muted">{session.network?.reason ?? "Reading the chain…"}</p>}
        {session.network?.rpcUrl && <BlockRiver networkId={session.networkId} compactView />}
      </div>
      <MarketTape />
    </aside>
  </div>;
}

function AdminGate() {
  const session = useSession();
  return <div className="page-narrow admin-wrap">
    <Suspense fallback={<p className="muted">Loading the admin panel…</p>}>
      <AdminPage wallet={session.wallet} walletVerifying={session.status === "connecting"} message={session.notice} onConnect={() => void session.connect()} />
    </Suspense>
  </div>;
}

function NotFound() {
  return <div className="page-narrow center">
    <div className="glass not-found"><h1>Lost in the clouds</h1><p className="muted">This page is not on ElysaPay.</p><a className="btn btn-aurora" {...linkProps("/")}>Back home</a></div>
  </div>;
}

function Footer({ motion, onMotion }: { motion: boolean; onMotion: () => void }) {
  return <footer className="footer">
    <div className="footer-inner">
      <div><Logo size={26} /><p className="muted">Pay anyone on Elysium by their name. Your wallet signs every payment.</p></div>
      <nav aria-label="Footer">
        <a {...linkProps("/app")}>App</a>
        <a {...linkProps("/docs")}>Docs</a>
        <a href="https://github.com/furkan3152/ElysaPay" target="_blank" rel="noreferrer">GitHub</a>
        <button type="button" className="link-btn" aria-pressed={!motion} onClick={onMotion}>{motion ? "Pause animations" : "Play animations"}</button>
      </nav>
    </div>
    <p className="footer-legal">ElysaPay is independent and not affiliated with Kinetiq, Elysium or Hyperliquid. Contracts are unaudited; start small. Market data is information, not advice.</p>
  </footer>;
}
