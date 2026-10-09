import { useEffect, useRef, useState } from "react";
import { DotMorph } from "./DotMorph";
import { DecodeText } from "./DecodeText";
import { DotArrow } from "./DotIcon";
import { DotText } from "./DotText";
import { ProviderIcon } from "./ProviderIcon";
import { BrandMark } from "./BrandMark";
import { platformName } from "../domain/payment-intent";
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
  ["01", "Type a request", "Send 2 TSLA to @toly on X, or pick a stock from the board.", "/docs/quick-start"],
  ["02", "Review the draft", "Recipient, network, amount and gas are shown before anything is signed.", "/docs/sending"],
  ["03", "Sign in your wallet", "Your wallet signs and pays the gas. The server checks the receipt on chain.", "/docs/security"],
] as const;

/**
 * The home page at "/": what HaPaPay does, how a payment works and what it can send, with the way into the desk at
 * "/app". The dots gather into $ and change into €, as on the desk; on the vault's route the dotted bird carries
 * the payment from you to the vault to the recipient. Availability is read from the server, so a locked transfer or a
 * vault that is not deployed reads as such. The dot-matrix text answers the pointer like the dots, and every card opens
 * the docs section that explains it.
 */
export function HomePage({ status, stockCount, xstockCount, motion, onToggleMotion }: {
  status: HomeStatus;
  /** xStocks on HaPaPay's Solana list. */
  xstockCount: number;
  /** Robinhood Stock Tokens (companies and funds) on the mainnet allowlist. */
  stockCount: number;
  motion: boolean;
  onToggleMotion: () => void;
}) {
  const state = (live: boolean, on: string, off: string) => status.checking ? "checking" : live ? on : off;
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
        <p className="home-eyebrow">Social payments on Robinhood Chain</p>
        <DotText as="h1" id="home-title" text="Send money and stocks to a verified handle" />
        <p className="home-lead">HaPaPay turns a social handle into a payment address. Sign in once for a wallet on Robinhood Chain, Solana and Arc, name a GitHub, X, Telegram, Discord or Farcaster account, review the transfer, and your own wallet signs it.</p>
        <div className="home-actions">
          <a className="home-open" href="/app"><DecodeText text="Open the desk" /> <DotArrow direction="right" /></a>
          <a className="home-docs" href="/docs"><DecodeText text="Read the docs" /></a>
        </div>
        <ul className="home-status" aria-label="Networks on this server" aria-busy={status.checking}>
          <li className={status.stockTokens ? "live" : undefined}>Stock Tokens · {state(status.stockTokens, "wallet-signed", "signing locked")}</li>
          <li className={status.tokens ? "live" : undefined}>USDG · {state(status.tokens, "wallet-signed", "signing locked")}</li>
          <li className={status.solana ? "live" : undefined}>Solana · {state(Boolean(status.solana), "wallet-signed", "signing locked")}</li>
          <li className={status.vault ? "live" : undefined}>Vault links · {state(status.vault, "open", "not open yet")}</li>
        </ul>
      </div>
      <div className="home-art">
        <DotMorph shapes={["$", "€"]} motion={motion} onToggleMotion={onToggleMotion} />
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
        <p>Not on HaPaPay yet? The payment waits in the vault, a contract on Robinhood Chain (and on Arc, or a program on Solana) until they connect their account (GitHub, X, Farcaster, Discord or Telegram) and claim it. If nobody claims it in time, you take it back.</p>
        {!status.checking && !status.vault && <p className="home-note">Vault links are not open yet. {status.vaultReason ?? ""}</p>}
        <a className="home-more" href="/docs/vault">How the vault works <DotArrow direction="right" /></a>
      </div>
      <div className="home-route" aria-hidden="true"><DotText text="You" /><i /><DotText text="Vault" /><i /><DotText text="@toly" /><span className="route-bird"><BrandMark /></span></div>
    </section>

    <section className="home-section" aria-labelledby="assets-title">
      <DotText as="h2" id="assets-title" text="What you can send" />
      <ul className="home-assets">
        {([
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
      <p>HaPaPay never holds your keys, never signs a transfer for you, and never holds your tokens. The server prepares exact transactions, checks them on chain, and verifies receipts. The only thing it signs is a one-time claim authorization for the vault.</p>
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
      <p>HaPaPay is not affiliated with, endorsed by, or officially connected with the Solana Foundation, the xStocks issuer, Robinhood Markets, Inc., Paxos, Circle or Arc.</p>
    </section>
  </div>;
}
