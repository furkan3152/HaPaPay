import { useEffect, useState } from "react";
import { isSolanaStock } from "../domain/solana-assets";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import type { SolanaVaultLinkDetails } from "../domain/solana-vault";
import { short, signSolanaVaultAction, solanaTransactionUrl } from "../solana-desk";
import { platformName } from "../domain/payment-intent";
import { settledLink } from "../domain/stock-claims";
import { DotIcon } from "./DotIcon";
import { DotText } from "./DotText";
import { VerifiedMark } from "./StatusMarks";
import { StockTile } from "./StockTokenList";

type Action = { signature?: string; action: "claim" | "refund"; status: "signing" | "pending" | "confirmed" | "failed" };

/**
 * The claim page of a Solana vault link (/claim/solana/<id>): what the program holds, for which account, until when.
 * The recipient claims to the account's own Solana address once its verified GitHub, X, Farcaster, Discord or Telegram account is the
 * one the link is locked to; the payer takes it back after the window. Both sign only a transaction the browser
 * rebuilt from the link.
 */
export default function SolanaClaimSlip({ paymentId, wallet, solanaAddress, accounts, busy, setBusy, onConnect, onAddSolana, onManage, onMessage, onSettled, onDetails }: {
  paymentId: `0x${string}`;
  wallet?: string;
  solanaAddress?: string;
  accounts: ReadonlyArray<{ platform: string; username: string }>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onConnect: () => void;
  onAddSolana: () => Promise<void>;
  onManage: () => void;
  onMessage: (message: string) => void;
  onSettled: () => void;
  /** The link as read, so the page around the slip can say when it is settled. */
  onDetails?: (details: SolanaVaultLinkDetails) => void;
}) {
  const [details, setDetails] = useState<SolanaVaultLinkDetails>();
  const [error, setError] = useState<string>();
  const [eligible, setEligible] = useState(false);
  const [action, setAction] = useState<Action>();

  async function load() {
    try {
      const response = await fetch(`/api/solana/claims/${paymentId}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as SolanaVaultLinkDetails & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "This claim link could not be loaded.");
      setDetails(result);
      setError(undefined);
      onDetails?.(result);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "This claim link could not be loaded.";
      setError(message);
      onMessage(message);
    }
  }

  useEffect(() => { void load(); }, [paymentId]);

  const isPayer = Boolean(details && solanaAddress && details.payer === solanaAddress);
  const stock = details ? isSolanaStock(details.asset) : false;
  const linked = details?.recipient ? accounts.find((account) => account.platform === details.recipient!.platform) : undefined;
  const needsEligibility = stock && details?.status === "claimable" && !isPayer && !action;

  async function act(kind: "claim" | "refund") {
    if (!details) return;
    if (!wallet) return void onConnect();
    if (!solanaAddress) return void await onAddSolana();
    setBusy(true);
    setAction({ action: kind, status: "signing" });
    try {
      const { slot } = await signSolanaVaultAction({
        paymentId,
        programId: details.programId,
        mint: details.asset.mint,
        action: kind,
        solanaAddress,
        eligibilityConfirmed: kind === "claim" && stock ? eligible : undefined,
        onSubmitted: (signature) => {
          setAction({ signature, action: kind, status: "pending" });
          onMessage(`Your ${kind} was submitted. Waiting for Solana to confirm it.`);
        },
      });
      setAction((current) => current ? { ...current, status: "confirmed" } : current);
      onMessage(kind === "claim" ? `${details.amount} ${details.asset.symbol} reached your Solana wallet. Confirmed in Solana slot ${slot}.` : `${details.amount} ${details.asset.symbol} went back to your Solana wallet. Confirmed in Solana slot ${slot}.`);
      onSettled();
      void load();
    } catch (failure) {
      setAction((current) => current?.signature ? { ...current, status: "failed" } : undefined);
      onMessage(failure instanceof Error ? failure.message : `The ${kind} was not signed.`);
    } finally {
      setBusy(false);
    }
  }

  const platform = details?.recipient ? platformName(details.recipient.platform) : "GitHub, X, Farcaster, Discord or Telegram";
  return <article className="payment-slip stock-slip claim-slip claim-redeem solana-slip" data-network-theme="solana" data-state={action?.status === "signing" ? undefined : action?.status}>
    <div className="slip-top">
      <div><small>{action?.status === "confirmed" ? action.action === "claim" ? "Claimed to your wallet" : "Back in your wallet" : !details ? "Claim link" : details.status === "settled" ? settledLink(details.expiresAt).label : details.status === "expired" ? "Claim window closed" : "Reserved for you"}</small><strong><DotText text={details?.amount ?? "—"} /> <span className="slip-symbol">{details?.asset.symbol ?? ""}</span></strong></div>
      {action?.status === "confirmed" && <VerifiedMark />}
      {details && stock ? <StockTile token={{ symbol: details.asset.symbol, kind: details.asset.kind === "etf" ? "etf" : "stock" }} size="large" /> : <div className="platform-avatar"><DotIcon name="lock" size={18} /></div>}
    </div>
    <div className="claim-id"><small>Claim link</small><code>{paymentId.slice(0, 14)}…{paymentId.slice(-8)}</code></div>
    {details?.recipient && <div className="claim-route"><span>{details.sourceIdentity ? `@${details.sourceIdentity.username}` : short(details.payer)}</span><i /><b>@{details.recipient.username}</b></div>}
    {details?.status === "settled" && !action && <p className="claim-settled" role="status">{settledLink(details.expiresAt).note}</p>}
    {details && <div className="claim-expiry"><span>{details.status === "claimable" ? "Claim by" : "Claim window"}</span><b>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(details.expiresAt))}</b></div>}
    {details && <dl className="stock-facts">
      <div><dt>Network</dt><dd>{SOLANA_MAINNET.name} mainnet</dd></div>
      <div><dt>Asset</dt><dd>{details.asset.kind === "native"
        ? <>{details.asset.name} · native<small>Held as wrapped SOL while it waits; the claim unwraps it, so SOL reaches your wallet</small></>
        : <>{details.asset.name} · <a href={`${SOLANA_MAINNET.explorerUrl}/token/${details.asset.mint}`} target="_blank" rel="noreferrer">{short(details.asset.mint)} <DotIcon name="arrow-up-right" size={12} /></a></>}</dd></div>
      <div><dt>Vault</dt><dd><a href={`${SOLANA_MAINNET.explorerUrl}/account/${details.programId}`} target="_blank" rel="noreferrer">{short(details.programId)} <DotIcon name="arrow-up-right" size={12} /></a><small>The HaPaPay vault program holds it until it is claimed or taken back; its code is checked before every claim and refund</small></dd></div>
      <div><dt>Network fee</dt><dd>SOL, paid by your wallet<small>{details.asset.kind === "native" ? "About 0.002 SOL needed at the moment of claiming; the wrapped-SOL account's rent comes back in the same transaction" : `About 0.002 SOL with a new token account for ${details.asset.symbol}`}</small></dd></div>
    </dl>}
    {error && !details && <p className="escrow-console-note" role="alert">{error}</p>}
    {needsEligibility && <label className="stock-eligibility">
      <input type="checkbox" checked={eligible} disabled={busy} onChange={(event) => setEligible(event.target.checked)} />
      <span>I am not a U.S. person and I am outside the United States, and xStocks are permitted where I am. <a href="https://xstocks.fi" target="_blank" rel="noreferrer">Restrictions</a></span>
    </label>}
    {details?.status !== "settled" && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size={16} /><span>{details?.lock === "name" && details.recipient
      ? <><b>Waiting for the {platform} name @{details.recipient.username}.</b> Connect {platform} to HaPaPay with the account that has that name now, again if it is already connected; the server signs a one-time claim only for it{details.recipient.platform === "telegram" ? "" : ", only when the account is older than the link,"} and only for your own Solana address.</>
      : <><b>Locked to one {platform} account.</b> The server signs a one-time claim only when your connected account is the one this link was made for, and only for your own Solana address.</>}</span></div>}
    {details?.status === "claimable" && wallet && details.recipient && !linked && !isPayer && <button className="stock-verify-again" onClick={onManage}>Connect your {platform} account</button>}
    {action?.signature ? <a className={`transaction-link ${action.status === "confirmed" ? "confirmed" : action.status === "failed" ? "verification-failed" : "pending"}`} href={solanaTransactionUrl(action.signature)} target="_blank" rel="noreferrer">{action.status === "confirmed" ? action.action === "claim" ? "Claim confirmed" : "Refund confirmed" : action.status === "failed" ? "Check in explorer" : "Transaction submitted"} · {action.signature.slice(0, 10)}…</a>
      : details && details.status !== "settled" && <div className="claim-actions">
        <button disabled={busy || details.status !== "claimable" || isPayer || (Boolean(wallet) && Boolean(solanaAddress) && needsEligibility && !eligible)} onClick={() => void act("claim")}>{!wallet ? "Verify wallet" : !solanaAddress ? "Add your Solana address" : "Claim with my identity"}</button>
        <button disabled={busy || details.status !== "expired" || (Boolean(wallet) && Boolean(solanaAddress) && !isPayer)} onClick={() => void act("refund")}>Take back after expiry</button>
      </div>}
  </article>;
}
