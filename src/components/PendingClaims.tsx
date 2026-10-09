import type { ReactNode } from "react";
import { platformName } from "../domain/payment-intent";
import type { PendingVaultLink, PendingVaultLinks } from "../domain/pending-claims";
import { DotIcon } from "./DotIcon";
import { ProviderIcon } from "./ProviderIcon";
import { StockTile } from "./StockTokenList";
import "./pending-claims.css";

/** The claim or refund running from this list: "signing" while the wallet is open, then its receipt. */
export type PendingClaimAction = {
  paymentId: string;
  action: "claim" | "refund";
  /** "refused": stopped before anything was sent, with `message` saying why. */
  status: "signing" | "pending" | "confirmed" | "failed" | "refused";
  hash?: string;
  explorerUrl?: string;
  /** Why it stopped, shown on the link itself, where the button was pressed. */
  message?: string;
};

type PendingClaimsProps = {
  links?: PendingVaultLinks;
  loading: boolean;
  error?: string;
  authenticated: boolean;
  /** How many of the wallet's verified accounts can receive vault links (GitHub, X, Farcaster). */
  vaultAccounts: number;
  busy: boolean;
  action?: PendingClaimAction;
  /** Payment IDs whose Stock Token statement the recipient has ticked. */
  statements: ReadonlySet<string>;
  onStatement: (paymentId: string, confirmed: boolean) => void;
  onClaim: (link: PendingVaultLink) => void;
  onRefund: (link: PendingVaultLink) => void;
  onCopy: (link: PendingVaultLink) => void;
  onRefresh: () => void;
  onConnect: () => void;
  emptyArtwork?: ReactNode;
};

function deadline(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function senderLabel(link: PendingVaultLink) {
  return link.sender.username && link.sender.platform
    ? `@${link.sender.username} on ${platformName(link.sender.platform)}`
    : `${link.sender.wallet.slice(0, 6)}…${link.sender.wallet.slice(-4)}`;
}

/**
 * Pending claims: vault links waiting for the wallet's verified accounts, and the links it sent that nobody has
 * claimed yet. The list comes from the server, which reads every link back from its escrow; the buttons hand a link
 * to the desk, whose signers prepare the claim or refund on the server and check it before any wallet opens.
 */
export function PendingClaims({ links, loading, error, authenticated, vaultAccounts, busy, action, statements, onStatement, onClaim, onRefund, onCopy, onRefresh, onConnect, emptyArtwork }: PendingClaimsProps) {
  const incoming = links?.incoming ?? [];
  const outgoing = links?.outgoing ?? [];
  const running = action && (action.status === "signing" || action.status === "pending");

  const status = (link: PendingVaultLink) => action?.paymentId === link.paymentId && action.hash
    ? <a className={`claim-item-receipt ${action.status}`} href={action.explorerUrl ? `${action.explorerUrl.replace(/\/$/, "")}/tx/${action.hash}` : undefined} target="_blank" rel="noreferrer">
      {action.status === "confirmed" ? action.action === "claim" ? "Claim verified" : "Refund verified" : action.status === "failed" ? "Check in explorer" : "Transaction submitted"} · {action.hash.slice(0, 10)}…
    </a>
    : undefined;

  const item = (link: PendingVaultLink, side: "incoming" | "outgoing") => {
    const mine = action?.paymentId === link.paymentId;
    const settled = mine && action.status === "confirmed";
    const needsStatement = side === "incoming" && Boolean(link.statementRequired);
    const cash = link.token.symbol === "USDC" || link.token.kind === "cash";
    return <li className="claim-item" key={`${link.network}:${link.paymentId}`} data-status={settled ? "settled" : link.status}>
      <div className="claim-item-head">
        {cash ? <span className="claim-coin" aria-hidden="true">$</span> : <StockTile token={{ symbol: link.token.symbol, kind: link.token.kind ?? "stock" }} />}
        <div className="claim-item-main">
          <strong>{link.amount} <span>{link.token.symbol}</span></strong>
          <small>{side === "incoming" ? `From ${senderLabel(link)}` : `For @${link.recipient.username}`}</small>
          <small className="claim-item-route"><ProviderIcon provider={link.recipient.platform} /> {side === "incoming" ? `To your ${platformName(link.recipient.platform)} @${link.recipient.username}` : platformName(link.recipient.platform)} · {link.chainName}</small>
        </div>
      </div>
      <p className="claim-item-deadline">{link.status === "refundable" ? `Window closed ${deadline(link.expiresAt)}` : link.status === "waiting" ? `Open until ${deadline(link.expiresAt)}` : `Claim by ${deadline(link.expiresAt)}`}</p>
      {needsStatement && !settled && <label className="stock-eligibility claim-item-statement">
        <input type="checkbox" checked={statements.has(link.paymentId)} disabled={busy} onChange={(event) => onStatement(link.paymentId, event.target.checked)} />
        <span>I am not a U.S. person and I am outside the United States, and Robinhood Stock Tokens are permitted where I am. <a href="https://docs.robinhood.com/chain/stock-tokens/" target="_blank" rel="noreferrer">Restrictions</a></span>
      </label>}
      {status(link)}
      {/* A refusal shown only in the conversation, far from this panel, would look like nothing happened. */}
      {mine && action.message && (action.status === "refused" || action.status === "failed") && <p className="claim-item-error" role="alert">{action.message}</p>}
      {/* A submitted or verified call shows its receipt; a failed one shows it and the buttons again. */}
      {!settled && !(mine && action.status === "pending") && <div className="claim-item-actions">
        {side === "incoming" && <button type="button" className="claim-item-primary" disabled={busy || Boolean(running) || (needsStatement && !statements.has(link.paymentId))} onClick={() => onClaim(link)}>{mine && action.status === "signing" ? "Confirm in wallet…" : needsStatement && !statements.has(link.paymentId) ? "Confirm eligibility" : mine && action.status === "failed" ? "Try again" : "Claim"}</button>}
        {side === "outgoing" && link.status === "refundable" && <button type="button" className="claim-item-primary" disabled={busy || Boolean(running)} onClick={() => onRefund(link)}>{mine && action.status === "signing" ? "Confirm in wallet…" : mine && action.status === "failed" ? "Try again" : "Take back"}</button>}
        {side === "outgoing" && link.status === "waiting" && <button type="button" onClick={() => onCopy(link)}><DotIcon name="link" size={13} /> Copy claim link</button>}
        <a href={link.claimPath}>Open link</a>
      </div>}
    </li>;
  };

  return <section className="pending-claims" aria-labelledby="pending-claims-title" aria-busy={loading}>
    <div className="pending-claims-heading">
      <div><h2 id="pending-claims-title">Pending claims</h2><p>{authenticated ? "Read from the vaults on chain" : "Vault links for your accounts"}</p></div>
      {authenticated && <button type="button" className="claims-refresh" onClick={onRefresh} disabled={loading} aria-label="Check the vaults again" title="Check the vaults again"><DotIcon name="refresh" size={16} /></button>}
    </div>

    {!authenticated ? <div className="claims-message claims-message-empty">
      {emptyArtwork}<strong>Money sent before you joined</strong><p>Verify your wallet. Payments sent to your GitHub, X, Farcaster, Discord or Telegram account wait here until you claim them.</p>
    </div> : <>
      {error && <div className="claims-load-error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh} disabled={loading}>Try again</button></div>}
      {links && links.unavailable.length > 0 && <p className="claims-unavailable" role="status">{links.unavailable.join(" and ")} could not be read just now, so {links.unavailable.length === 1 ? "its" : "their"} links are not shown. Try again in a moment.</p>}
      {loading && <p className="claims-loading" role="status">{links ? "Checking the vaults again…" : "Checking the vaults…"}</p>}

      <div className="claims-group">
        <h3>Waiting for you{incoming.length ? ` · ${incoming.length}` : ""}</h3>
        {incoming.length > 0 ? <ul className="claims-list" aria-label="Vault links waiting for your accounts">{incoming.map((link) => item(link, "incoming"))}</ul>
          : links && !loading && <div className="claims-message">
            {vaultAccounts > 0 ? <p>Nothing is waiting for your accounts. A link sent to a connected account shows up here as soon as it is funded.</p>
              : <><p>Connect your GitHub, X, Farcaster, Discord or Telegram account. Payments sent to it before you joined show up here, ready to claim.</p><button type="button" onClick={onConnect}>Connect an account</button></>}
          </div>}
      </div>

      {outgoing.length > 0 && <div className="claims-group">
        <h3>Sent, not claimed yet · {outgoing.length}</h3>
        <ul className="claims-list" aria-label="Vault links you sent">{outgoing.map((link) => item(link, "outgoing"))}</ul>
      </div>}
    </>}
  </section>;
}
