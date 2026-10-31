import { useEffect, useState, type CSSProperties } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import { pct, usd } from "../api";
import { LogoMark } from "../Logo";
import { linkProps } from "../router";
import { useSession } from "../session";
import { BlockRiver, LaunchCountdown, LiveDot, MarketTape, Reveal, Ticker, useStats } from "../widgets";

/** The orbit's handles; the comet visits them in turn. Illustrative: these are not real payments. */
const ORBIT = [
  { platform: "x", handle: "alice", amount: "12.5" },
  { platform: "github", handle: "octocat", amount: "3" },
  { platform: "farcaster", handle: "dwr", amount: "40" },
  { platform: "telegram", handle: "carol", amount: "0.8" },
  { platform: "discord", handle: "nova", amount: "7.25" },
] as const;

const FEATURES = [
  { title: "Pay a name, not an address", text: "Send HYPE to a GitHub, X, Farcaster, Telegram or Discord account. ElysaPay resolves it to the wallet that account verified, right before you sign.", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9c.6-3.5 3.4-6 7-6s6.4 2.5 7 6", span: "wide" },
  { title: "Split with ten, sign once", text: "One transaction pays up to ten people on Elysium's router, each with their exact amount.", icon: "M12 4v6M12 10l-6 9M12 10l6 9" },
  { title: "Links and QR codes", text: "Request a payment with a link to your handle. The payer sees it filled in and signs.", icon: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" },
  { title: "Dollars in, HYPE out", text: "Write the amount in dollars; it settles in HYPE at Hyperliquid's live mid. The review shows the exact HYPE.", icon: "M12 3v18M17 7.5C16 6 14.2 5 12 5c-2.8 0-5 1.5-5 3.5S9.2 11 12 11.5s5 1.5 5 3.5-2.2 3.5-5 3.5c-2.4 0-4.4-1.1-5.2-2.7" },
  { title: "Receipts that show the speed", text: "Every payment gets a shareable receipt, with the seconds it took Elysium to confirm it.", icon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  { title: "Your keys, your signature", text: "ElysaPay prepares and verifies; your wallet signs. Payments are recorded only from the chain's own receipt.", icon: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z", span: "full" },
] as const;

export function Home({ motion }: { motion: boolean }) {
  const session = useSession();
  const stats = useStats(session.networkId, Boolean(session.network?.rpcUrl));
  const [visit, setVisit] = useState(0);
  useEffect(() => {
    if (!motion) return;
    const timer = window.setInterval(() => setVisit((value) => (value + 1) % ORBIT.length), 2600);
    return () => window.clearInterval(timer);
  }, [motion]);
  const target = ORBIT[visit];
  const hype = session.hype;

  return <div className="home">
    <section className="hero">
      <div className="hero-copy">
        <a className="pill" {...linkProps("/app")}><LiveDot live={Boolean(stats)} /> Live on Elysium Testnet · mainnet Nov 9</a>
        <h1 className="hero-title">
          <span className="line">Pay anyone</span>
          <span className="line">on <span className="aurora-text">Elysium</span></span>
          <span className="line">by their name.</span>
        </h1>
        <p className="lead">ElysaPay turns a social handle into a payment address on Elysium, the DeFi layer 2 for Hyperliquid. Type <b>@alice</b>, review, sign. It lands in about a tenth of a second.</p>
        <div className="hero-cta">
          <a className="btn btn-aurora btn-lg" {...linkProps("/app")}>Launch app <span aria-hidden="true">→</span></a>
          <a className="btn btn-glass btn-lg" {...linkProps("/docs")}>How it works</a>
        </div>
        <dl className="hero-stats">
          <div><dt>Block</dt><dd>{stats ? <Ticker value={Number(stats.blockNumber)} /> : "…"}</dd></div>
          <div><dt>Block time</dt><dd>{stats?.blockTimeMs ? `${stats.blockTimeMs} ms` : "~100 ms"}</dd></div>
          <div><dt>HYPE</dt><dd>{hype ? <>{usd(hype.mid)} <i data-up={(hype.change24h ?? 0) >= 0}>{hype.change24h === null ? "" : pct(hype.change24h)}</i></> : "…"}</dd></div>
        </dl>
      </div>

      <div className="hero-art" aria-hidden="true">
        <div className="orbit">
          <div className="orbit-ring r1" /><div className="orbit-ring r2" /><div className="orbit-ring r3" />
          <div className="orbit-core"><LogoMark size={88} /><span className="core-pulse" /></div>
          {ORBIT.map((entry, index) => <div key={entry.handle} className={`orbit-node ${index === visit ? "is-target" : ""}`} style={{ "--a": `${(index / ORBIT.length) * 360 - 90}deg` } as CSSProperties}>
            <span className="node-chip"><ProviderIcon provider={entry.platform} />@{entry.handle}</span>
          </div>)}
          <div key={visit} className="comet-run" style={{ "--a": `${(visit / ORBIT.length) * 360 - 90}deg` } as CSSProperties}><span className="comet-head" /></div>
        </div>
        <div className="hero-receipt glass" key={`r-${visit}`}>
          <span className="tick">✓</span>
          <div><b>{target.amount} HYPE → @{target.handle}</b><small>confirmed in a block · example</small></div>
        </div>
      </div>
    </section>

    <Reveal><section className="band"><MarketTape /></section></Reveal>

    <Reveal>
      <section className="section">
        <header className="section-head"><p className="eyebrow">The chain, live</p><h2>Ten blocks a second, <span className="aurora-text">streaming</span></h2><p className="muted">Each tile is a real Elysium block as it lands; brighter tiles carried more transactions. A payment you send rides one of them.</p></header>
        {session.network?.rpcUrl ? <BlockRiver networkId={session.networkId} /> : <p className="muted">Reading Elysium…</p>}
      </section>
    </Reveal>

    <section className="section">
      <Reveal><header className="section-head"><p className="eyebrow">What you can do</p><h2>Everything a payment needs. <span className="aurora-text">Nothing it doesn't.</span></h2></header></Reveal>
      <div className="bento">
        {FEATURES.map((feature, index) => <Reveal key={feature.title} delay={index * 70} className={"span" in feature ? `bento-${feature.span}` : ""}>
          <article className="bento-card glass" onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            event.currentTarget.style.setProperty("--x", `${event.clientX - box.left}px`);
            event.currentTarget.style.setProperty("--y", `${event.clientY - box.top}px`);
          }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={feature.icon} /></svg>
            <h3>{feature.title}</h3>
            <p>{feature.text}</p>
          </article>
        </Reveal>)}
      </div>
    </section>

    <section className="section">
      <Reveal><header className="section-head"><p className="eyebrow">How it works</p><h2>Three steps, <span className="aurora-text">one signature</span></h2></header></Reveal>
      <ol className="steps">
        {[
          ["Link your accounts", "Sign in with your wallet and link the handles people know you by, each through its own official sign-in."],
          ["Name who you pay", "Pick a platform, write the handle and an amount in HYPE or dollars. Review shows the wallet, the fee and the total."],
          ["Sign, and it lands", "Your wallet signs. Elysium confirms it in a block or two, and you get a receipt you can share."],
        ].map(([title, text], index) => <Reveal key={title} delay={index * 120}><li className="glass"><span className="step-n">{index + 1}</span><h3>{title}</h3><p>{text}</p></li></Reveal>)}
      </ol>
    </section>

    <Reveal>
      <section className="section elysium">
        <div className="elysium-copy">
          <p className="eyebrow">Built for Elysium</p>
          <h2>The DeFi layer 2 <span className="aurora-text">for Hyperliquid</span></h2>
          <p className="muted">Elysium is Kinetiq's Arbitrum Orbit chain: it settles to HyperEVM, runs on HYPE, and makes a block about every 100 milliseconds. ElysaPay brings payments by name to it from the first block.</p>
          <ul className="facts">
            <li><b>~100 ms</b><span>blocks</span></li>
            <li><b>HYPE</b><span>gas and payments</span></li>
            <li><b>HyperEVM</b><span>settlement</span></li>
            <li><b>1%</b><span>fee, added on top</span></li>
          </ul>
        </div>
        <div className="launch glass">
          <p className="eyebrow">Mainnet</p>
          <h3>Elysium goes live in</h3>
          <LaunchCountdown large />
          <p className="muted">Planned for November 9, 2026. Everything runs on Elysium Testnet until then.</p>
        </div>
      </section>
    </Reveal>

    <Reveal>
      <section className="cta glass">
        <LogoMark size={56} />
        <h2>Your name is your address.</h2>
        <p className="muted">Link an account, share a link, get paid on Elysium.</p>
        <a className="btn btn-aurora btn-lg" {...linkProps("/app")}>Launch app <span aria-hidden="true">→</span></a>
      </section>
    </Reveal>
  </div>;
}
