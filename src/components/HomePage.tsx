import { useEffect, useRef, useState } from "react";
import { DotMorph } from "./DotMorph";
import { DecodeText } from "./DecodeText";
import { DotArrow } from "./DotIcon";
import { DotText } from "./DotText";
import { ProviderIcon } from "./ProviderIcon";
import { BrandMark } from "./BrandMark";
import { platformName } from "../domain/payment-intent";
import { countdown, ELYSIUM_MAINNET_LAUNCH, type ElysiumMarket, type ElysiumNetworkView } from "../domain/elysium";
import "./home-page.css";

/** What the server reports for Robinhood Chain mainnet and Solana right now; `checking` until the first read arrives. */
export type HomeStatus = {
  checking: boolean;
  /** USDC and USDG on Solana, and xStocks on Solana. */
  solana?: boolean;
  xstocks?: boolean;
  stockTokens: boolean;
  tokens: boolean;
  vault: boolean;
  vaultReason?: string;
  /** The Arc network this server runs for USDC, as it reports it; undefined while Arc is unavailable. */
  arc?: "testnet" | "mainnet";
};

const providers = ["github", "x", "telegram", "discord", "farcaster"] as const;
/** The three steps of a payment, each opening the docs section that covers it. */
const steps = [
  ["01", "Name a handle", "Pay @alice on X in HYPE from the Elysium panel, or write a request like Send 2 TSLA to @toly on X.", "/docs/quick-start"],
  ["02", "Review the draft", "Recipient, network, amount and gas are shown before anything is signed.", "/docs/sending"],
  ["03", "Sign in your wallet", "Your wallet signs and pays the gas. The server checks the receipt on chain.", "/docs/security"],
] as const;

/** What Elysium brings, as the chain documents it; each line is something ElysaPay uses. */
const elysiumFacts = [
  ["~100 ms", "blocks", "A payment confirms before the review card has finished closing."],
  ["HYPE", "gas and payments", "Elysium's gas token is HYPE, bridged 1:1 from HyperEVM: you pay and are paid in it."],
  ["HyperEVM", "settlement", "An Arbitrum Orbit layer 2 that settles to HyperEVM, built by Kinetiq for DeFi and trading."],
  ["1%", "added on top", "A constant in the router, shown before you sign: the recipient always gets exactly the amount written."],
] as const;

/** Elysium's networks as this server runs them, and Hyperliquid's tape; both optional, both read once. */
function useElysium() {
  const [networks, setNetworks] = useState<ElysiumNetworkView[]>();
  const [markets, setMarkets] = useState<ElysiumMarket[]>();
  useEffect(() => {
    let cancelled = false;
    fetch("/api/elysium", { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined).then((value) => { if (!cancelled && value) setNetworks(value.networks); }).catch(() => undefined);
    fetch("/api/elysium/markets", { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined).then((value) => { if (!cancelled && value) setMarkets(value.markets); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return { networks, markets };
}

function LaunchClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = countdown(ELYSIUM_MAINNET_LAUNCH, now);
  if (left.done) return <p className="home-launch-done">Elysium mainnet launch day: November 9, 2026.</p>;
  return <div className="home-clock" role="timer" aria-label={`Elysium mainnet in ${left.days} days, ${left.hours} hours and ${left.minutes} minutes`}>
    {([[left.days, "days"], [left.hours, "hours"], [left.minutes, "min"], [left.seconds, "sec"]] as const).map(([value, label]) => <span key={label}><DotText text={String(value).padStart(2, "0")} /><small>{label}</small></span>)}
  </div>;
}

/**
 * The home page at "/": what ElysaPay does, how a payment works and what it can send, with the way into the desk at
 * "/app". The dots gather into $ and change into €, as on the desk; on the vault's route the dotted bird carries
 * the payment from you to the vault to the recipient. Availability is read from the server, so a locked transfer or a
 * vault that is not deployed reads as such. The dot-matrix text answers the pointer like the dots, and every card opens
 * the docs section that explains it.
 */
export function HomePage({ status, stockCount, xstockCount, motion, onToggleMotion }: {
  status: HomeStatus;
  /** xStocks on ElysaPay's Solana list. */
  xstockCount: number;
  /** Robinhood Stock Tokens (companies and funds) on the mainnet allowlist. */
  stockCount: number;
  motion: boolean;
  onToggleMotion: () => void;
}) {
  const state = (live: boolean, on: string, off: string) => status.checking ? "checking" : live ? on : off;
  const elysium = useElysium();
  const testnet = elysium.networks?.find((entry) => entry.id === "elysium-testnet");
  const mainnet = elysium.networks?.find((entry) => entry.id === "elysium-mainnet");
  const hype = elysium.markets?.find((market) => market.coin === "HYPE");
  // The first time the vault section comes into view, the dotted bird carries the payment along its route.
  const vault = useRef<HTMLElement>(null);
  const [vaultSeen, setVaultSeen] = useState(false);
  useEffect(() => {
    const node = vault.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const watcher = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVaultSeen(true);
      watcher.disconnect();
    }, { threshold: 0.6 });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, []);
  return <div className="home">
    <section className="home-hero" aria-labelledby="home-title">
      <div className="home-copy">
        <p className="home-eyebrow">Social payments on Elysium</p>
        <DotText as="h1" id="home-title" text="Pay any handle in HYPE" />
        <p className="home-lead">ElysaPay turns a social handle into a payment address on Elysium, the DeFi layer 2 for Hyperliquid. Name a GitHub, X, Telegram, Discord or Farcaster account, review the payment, and your own wallet signs it. Stablecoins and stocks still travel on Robinhood Chain, Solana and Arc.</p>
        <div className="home-actions">
          <a className="home-open" href="/app"><DecodeText text="Open the desk" /> <DotArrow direction="right" /></a>
          <a className="home-docs" href="/docs"><DecodeText text="Read the docs" /></a>
        </div>
        <ul className="home-status" aria-label="Networks on this server" aria-busy={status.checking}>
          <li className={testnet?.enabled && testnet.contracts.router ? "live" : undefined}>Elysium Testnet · {!elysium.networks ? "checking" : testnet?.enabled && testnet.contracts.router ? "wallet-signed" : "opening soon"}</li>
          <li className={mainnet?.enabled && mainnet.contracts.router ? "live" : undefined}>Elysium mainnet · {!elysium.networks ? "checking" : mainnet?.enabled && mainnet.contracts.router ? "wallet-signed" : "Nov 9"}</li>
          <li className={status.stockTokens ? "live" : undefined}>Stock Tokens · {state(status.stockTokens, "wallet-signed", "signing locked")}</li>
          <li className={status.tokens ? "live" : undefined}>USDG · {state(status.tokens, "wallet-signed", "signing locked")}</li>
          <li className={status.solana ? "live" : undefined}>Solana · {state(Boolean(status.solana), "wallet-signed", "signing locked")}</li>
          <li className={status.vault ? "live" : undefined}>Vault links · {state(status.vault, "open", "not open yet")}</li>
        </ul>
      </div>
      <div className="home-art">
        <DotMorph shapes={["elysium", "$"]} motion={motion} onToggleMotion={onToggleMotion} />
      </div>
    </section>

    <section className="home-section home-elysium" id="elysium" aria-labelledby="elysium-title">
      <div className="home-elysium-head">
        <DotText as="h2" id="elysium-title" text="Built for Elysium" />
        <p>Elysium is Kinetiq's layer 2 for the Hyperliquid ecosystem: an Arbitrum Orbit chain with ~100 ms blocks that settles to HyperEVM and runs on HYPE. ElysaPay brings handle payments to it from the first block of mainnet.</p>
        {hype && <p className="home-hype">HYPE <b>${hype.mid.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>{hype.change24h !== null && <i data-up={hype.change24h >= 0}>{hype.change24h >= 0 ? "+" : ""}{(hype.change24h * 100).toFixed(2)}% 24h</i>}<small>Hyperliquid perp mid</small></p>}
      </div>
      <ul className="home-facts">{elysiumFacts.map(([value, label, note]) => <li key={label}><DotText as="strong" text={value} /><b>{label}</b><span>{note}</span></li>)}</ul>
      <div className="home-launch">
        <div><DotText as="h3" text="Mainnet" /><p>Elysium's public mainnet is planned for November 9, 2026. Every ElysaPay feature runs on Elysium Testnet now.</p></div>
        <LaunchClock />
      </div>
    </section>

    <section className="home-section" id="how" aria-labelledby="how-title">
      <DotText as="h2" id="how-title" text="How it works" />
      <ol className="home-steps">
        {steps.map(([number, title, note, href]) => <li key={number}><a className="home-card" href={href}>
          <DotText className="home-step-number" text={number} />
          <b>{title}</b>
          <span>{note}</span>
          <DotArrow direction="right" />
        </a></li>)}
      </ol>
    </section>

    <section ref={vault} className={`home-section home-vault ${vaultSeen ? "in-view" : ""}`} aria-labelledby="vault-title">
      <div>
        <DotText as="h2" id="vault-title" text="Send to someone new" />
        <p>Not on ElysaPay yet? The payment waits in the vault, a contract on Robinhood Chain (and on Arc, or a program on Solana) until they connect their account (GitHub, X, Farcaster, Discord or Telegram) and claim it. If nobody claims it in time, you take it back.</p>
        {!status.checking && !status.vault && <p className="home-note">Vault links are not open yet. {status.vaultReason ?? ""}</p>}
        <a className="home-more" href="/docs/vault">How the vault works <DotArrow direction="right" /></a>
      </div>
      <div className="home-route" aria-hidden="true"><DotText text="You" /><i /><DotText text="Vault" /><i /><DotText text="@toly" /><span className="route-bird"><BrandMark /></span></div>
    </section>

    <section className="home-section" aria-labelledby="assets-title">
      <DotText as="h2" id="assets-title" text="What you can send" />
      <ul className="home-assets">
        {([
          ["HYPE", "Elysium's native token, paid straight to a verified handle through the ElysaPay router; write it in HYPE or in dollars at the live mid.", "/docs/elysium"],
          ["Stock Tokens", `${stockCount} companies and funds on Robinhood Chain, taken from the official registry and checked on chain.`, "/docs/networks"],
          ["USDG", "Global Dollar, a dollar stablecoin issued by Paxos, on Robinhood Chain and Solana.", "/docs/sending"],
          ["USDC", status.arc === "mainnet"
            ? "USDC on Solana, or on Arc Mainnet when you write “on Arc”."
            : "USDC on Solana, sent by handle from your own wallet.", "/docs/networks"],
          ["xStocks", `${xstockCount} xStocks on Solana, tokens that track companies and funds, each mint checked on chain.`, "/docs/networks"],
        ] as const).map(([name, note, href]) => <li key={name}><a className="home-card" href={href}>
          <DotText as="strong" text={name} />
          <span>{note}</span>
          <DotArrow direction="right" />
        </a></li>)}
      </ul>
    </section>

    <section className="home-section home-trust" aria-labelledby="trust-title">
      <DotText as="h2" id="trust-title" text="Non-custodial by design" />
      <p>ElysaPay never holds your keys, never signs a transfer for you, and never holds your tokens. The server prepares exact transactions, checks them on chain, and verifies receipts. The only thing it signs is a one-time claim authorization for the vault.</p>
      <p>People link their accounts through each platform's official login, and every linked account points to one wallet.</p>
      <a className="home-more" href="/docs/security">Read the security model <DotArrow direction="right" /></a>
      <ul className="home-providers" aria-label="Accounts you can link">
        {providers.map((id) => <li key={id}><a href="/docs/accounts"><ProviderIcon provider={id} /> {platformName(id)}</a></li>)}
      </ul>
    </section>

    <section className="home-end" aria-label="Start">
      <a className="home-open" href="/app"><DecodeText text="Open the desk" /> <DotArrow direction="right" /></a>
      <a className="home-docs" href="/docs"><DecodeText text="Read the docs" /></a>
    </section>

    <section className="home-legal" aria-label="Disclosures">
      <p>xStocks and Stock Tokens give economic exposure, not ownership of the underlying shares. They are not for U.S. persons, and other regional restrictions apply.</p>
      <p>ElysaPay is not affiliated with, endorsed by, or officially connected with Kinetiq, Elysium, Hyperliquid, the Solana Foundation, the xStocks issuer, Robinhood Markets, Inc., Paxos, Circle or Arc.</p>
    </section>
  </div>;
}
