import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { platformName } from "../domain/payment-intent";
import { solanaFee, uiAmountToUnits } from "../domain/solana-amounts";
import { isSolanaStock, type SolanaAssetListing } from "../domain/solana-assets";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import { matchesVaultFunding, type PreparedSolanaVaultFunding } from "../domain/solana-vault";
import { STOCK_CLAIM_WINDOW_CHOICES, type StockClaimPlatform } from "../domain/stock-claims";
import type { VaultLock } from "../domain/vault-lock";
import { TransactionExpiredError } from "../domain/transaction-receipt";
import { forgetUnrecordedFunding, rememberUnrecordedFunding } from "../domain/unrecorded-fundings";
import { readScaledMultiplier, sendSolanaTransaction, solanaTransactionUrl, solanaWalletFor } from "../solana-desk";
import { CopyButton } from "./CopyButton";
import { DotIcon } from "./DotIcon";
import { DotText } from "./DotText";
import { ProviderIcon } from "./ProviderIcon";

/**
 * A reviewed Solana vault link: one token amount for someone who has not joined yet, waiting for their GitHub, X or
 * Farcaster account, or for their Discord, Telegram or X name (`lock`, `vault-lock.ts`).
 */
export type SolanaVaultReview = {
  asset: Pick<SolanaAssetListing, "symbol" | "name" | "kind" | "mint" | "decimals" | "program" | "scaled">;
  recipient: { platform: StockClaimPlatform; username: string };
  amount: string;
  expiryHours: number;
  sourcePlatform?: string;
  lock: VaultLock;
};

function windowLabel(hours: number) {
  return hours % 24 === 0 && hours > 72 ? `${hours / 24} days` : `${hours} hours`;
}

/**
 * The Solana vault: the amount and 1% move into the payment's own account in the vault program, waiting for the
 * recipient's immutable account ID, or for their name where no account can be looked up. They claim it with their
 * official sign-in within the window; after it the payer takes it back. The browser rebuilds `create_payment` from
 * this review and the registered program before the wallet opens, and the server records the link only after reading
 * the payment back from the program.
 */
export default function SolanaVaultSlip({ review, programId, wallet, solanaAddress, enabled, reason, busy, setBusy, onConnect, onAddSolana, onMessage, onFunded, onWindow, onLock }: {
  review: SolanaVaultReview;
  programId?: string;
  wallet?: string;
  solanaAddress?: string;
  enabled: boolean;
  reason?: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onConnect: () => void;
  onAddSolana: () => Promise<void>;
  onMessage: (message: string) => void;
  /** The link is recorded: the sender's Claims list it as sent and not claimed yet. */
  onFunded: () => void;
  onWindow: (hours: number) => void;
  /** X did not answer the lookup for an account lock: the review now waits for the name, which the sender confirms. */
  onLock: (lock: VaultLock) => void;
}) {
  const [eligible, setEligible] = useState(false);
  const [funding, setFunding] = useState<{ signature: string; status: "pending" | "confirmed" | "verification_failed"; link?: string; record?: Record<string, unknown> }>();
  const { asset, recipient } = review;
  const stock = isSolanaStock(asset);
  const fee = solanaFee(parseUnits(review.amount, asset.decimals));
  const ready = enabled && Boolean(programId);

  /** A funding that never landed: nothing moved, so it is forgotten and the slip offers the funding again. */
  function dropped(signature: string) {
    forgetUnrecordedFunding(signature);
    setFunding(undefined);
  }

  async function record(body: Record<string, unknown>, signature: string) {
    const response = await fetch("/api/solana/claims/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})) as { claimPath?: string; expiresAt?: string; error?: string; expired?: boolean };
    if (response.status === 410 && result.expired) {
      dropped(signature);
      throw new TransactionExpiredError();
    }
    if (!response.ok || !result.claimPath) {
      setFunding({ signature, status: "verification_failed", record: body });
      throw new Error(`The vault may hold the payment, but the link could not be recorded yet: ${(result.error ?? "try again in a moment").replace(/\.$/, "")}.`);
    }
    forgetUnrecordedFunding(signature);
    const link = `${window.location.origin}${result.claimPath}`;
    setFunding({ signature, status: "confirmed", link });
    onFunded();
    // Recorded after its window closed, a link can only be taken back (from Claims), not claimed.
    if (result.expiresAt && Date.parse(result.expiresAt) <= Date.now()) return void onMessage(`The link is recorded, but its window has closed, so @${recipient.username} can no longer claim it. Take the ${asset.symbol} back under Claims.`);
    onMessage(review.lock === "name"
      ? `${review.amount} ${asset.symbol} is in the Solana vault for the ${platformName(recipient.platform)} name @${recipient.username}. Send this link to them; they claim it within ${windowLabel(review.expiryHours)} by connecting ${platformName(recipient.platform)} with that name, and it also waits under their Claims once they do.`
      : `${review.amount} ${asset.symbol} is in the Solana vault. Send this link to @${recipient.username}; they claim it with their official ${platformName(recipient.platform)} account within ${windowLabel(review.expiryHours)}, and it also waits under their Claims once they link that account.`);
  }

  async function fund() {
    if (!wallet) return void onConnect();
    if (!solanaAddress) return void await onAddSolana();
    if (funding?.status === "verification_failed" && funding.record) {
      setBusy(true);
      try {
        await record(funding.record, funding.signature);
      } catch (error) {
        onMessage(error instanceof TransactionExpiredError ? `${error.message} Keep it in the vault again to send it.` : error instanceof Error ? error.message : "The vault link could not be recorded yet.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!programId || funding) return;
    const payer = wallet;
    let submittedSignature: string | undefined;
    setBusy(true);
    try {
      const handle = await solanaWalletFor(solanaAddress);
      const multiplier = asset.scaled && asset.mint ? await readScaledMultiplier(asset.mint) : 1;
      const response = await fetch("/api/solana/claims/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: { symbol: asset.symbol, mint: asset.mint },
          amount: review.amount,
          recipient,
          lock: review.lock,
          expiryHours: review.expiryHours,
          ...(review.sourcePlatform ? { sourcePlatform: review.sourcePlatform } : {}),
          ...(stock ? { eligibilityConfirmed: eligible } : {}),
        }),
      });
      const prepared = await response.json().catch(() => ({})) as PreparedSolanaVaultFunding & { error?: string; lock?: VaultLock };
      // X did not answer the lookup for an account lock: the slip now offers the name lock, and nothing was signed.
      if (response.status === 409 && prepared.lock === "name") {
        onLock("name");
        throw new Error(prepared.error ?? "This link can wait for the name instead. Check it and keep it in the vault again.");
      }
      if (!response.ok) throw new Error(prepared.error ?? "The vault link could not be prepared. Try again.");
      const units = uiAmountToUnits(review.amount, asset.decimals, multiplier);
      const matches = prepared.recipient?.platform === recipient.platform && prepared.recipient.username === recipient.username && prepared.lock === review.lock
        && await matchesVaultFunding(prepared, { programId, payer: solanaAddress, asset: { mint: asset.mint, program: asset.program }, platform: recipient.platform, units, nowSeconds: BigInt(Math.floor(Date.now() / 1000)) });
      if (!matches) throw new Error("The prepared vault funding does not match this review. Nothing was signed.");
      onMessage(`Sign in your wallet: ${review.amount} ${asset.symbol} and the 1% fee go into the Solana vault for ${windowLabel(review.expiryHours)}.`);
      const confirmation = (signature: string): Record<string, unknown> => ({
        signature,
        paymentId: prepared.paymentId,
        programId,
        asset: { symbol: asset.symbol, mint: asset.mint },
        amount: review.amount,
        units: prepared.units,
        recipient,
        lock: review.lock,
        ...(review.sourcePlatform ? { sourcePlatform: review.sourcePlatform } : {}),
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      });
      const { signature } = await sendSolanaTransaction(handle, prepared.transaction, {
        onSubmitted: (submitted) => {
          submittedSignature = submitted;
          // From here the funding may land. Its record request is kept in this browser until the server has it, and is
          // sent again after the next sign-in if this tab closes first (audit, 2026-10-06: such a link reached no Claims
          // list and its payment ID was shown nowhere).
          rememberUnrecordedFunding({ url: "/api/solana/claims/confirm", body: confirmation(submitted), wallet: payer, transaction: submitted });
          setFunding({ signature: submitted, status: "pending", record: confirmation(submitted) });
        },
        revertedMessage: "Solana refused the vault funding, so nothing moved.",
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      });
      await record(confirmation(signature), signature);
    } catch (error) {
      if (error instanceof TransactionExpiredError || (error instanceof Error && /refused the vault funding/.test(error.message))) {
        if (submittedSignature) forgetUnrecordedFunding(submittedSignature);
        setFunding(undefined);
      } else {
        // A funding that may have landed is recorded again from the slip, never funded twice.
        setFunding((current) => current?.status === "pending" ? { ...current, status: "verification_failed" } : current);
      }
      onMessage(error instanceof TransactionExpiredError ? `${error.message} Keep it in the vault again to send it.` : error instanceof Error ? error.message : "The vault link was not funded.");
    } finally {
      setBusy(false);
    }
  }

  const label = funding?.status === "verification_failed" ? "Record the link again"
    : !ready ? "Solana vault links are off on this server"
    : !wallet ? "Verify your wallet first"
    : !solanaAddress ? "Add your Solana address"
    : stock && !eligible ? "Confirm eligibility to continue"
    : review.lock === "name" ? `Keep it for the name @${recipient.username}`
    : "Keep it in the Solana vault";

  return <article className="payment-slip claim-slip solana-slip" data-network-theme="solana" data-state={funding?.status}>
    <div className="slip-top"><div><small>{funding?.link ? "Waiting in the vault" : `${asset.symbol} vault link`}</small><strong><DotText text={review.amount} /> <span className="slip-symbol">{asset.symbol}</span></strong></div><div className="platform-avatar"><ProviderIcon provider={recipient.platform} /></div></div>
    <div className="recipient-line"><div><small>Not on HaPaPay yet</small><b>@{recipient.username}</b></div><span>{platformName(recipient.platform)}</span></div>
    <div className="claim-steps"><span><b>1</b> Amount + fee in</span><i /><span><b>2</b> {windowLabel(review.expiryHours)} in the vault</span><i /><span><b>3</b> Official claim</span></div>
    {!funding && <div className="vault-window" role="group" aria-label="Vault window">
      <span>Vault window</span>
      {STOCK_CLAIM_WINDOW_CHOICES.map((hours) => <button type="button" key={hours} aria-pressed={review.expiryHours === hours} disabled={busy} onClick={() => onWindow(hours)}>{windowLabel(hours)}</button>)}
    </div>}
    <dl className="stock-facts">
      <div><dt>Network</dt><dd>{SOLANA_MAINNET.name} mainnet<small>Held by the HaPaPay vault program, checked against its reviewed code before every transaction</small></dd></div>
      <div><dt>Fee</dt><dd>{asset.scaled ? "≈ " : ""}{formatUnits(fee, asset.decimals)} {asset.symbol} · 1%<small>Paid only when @{recipient.username} claims it, and returned with a refund</small></dd></div>
      <div><dt>Total</dt><dd>{asset.scaled ? "≈ " : ""}{formatUnits(parseUnits(review.amount, asset.decimals) + fee, asset.decimals)} {asset.symbol}<small>From your Solana wallet · @{recipient.username} receives exactly {review.amount}</small></dd></div>
      <div><dt>Rent</dt><dd>About 0.003 SOL<small>The vault's token account comes back to you when the link is claimed or taken back; about 0.0015 SOL stays with the link's record for good</small></dd></div>
    </dl>
    {stock && !funding && <label className="stock-eligibility">
      <input type="checkbox" checked={eligible} disabled={busy} onChange={(event) => setEligible(event.target.checked)} />
      <span>I am not a U.S. person and I am outside the United States. To my knowledge the recipient is too, and xStocks are permitted where we both are. <a href="https://xstocks.fi" target="_blank" rel="noreferrer">Restrictions</a></span>
    </label>}
    <div className={`mainnet-lock ${ready ? "mainnet-ready" : ""}`}><DotIcon name={ready ? "shield" : "lock"} size={16} /><span>{!ready
      ? <><b>Vault links are off.</b> {reason ?? "The Solana vault is not open on this server yet."}</>
      : review.lock === "name"
        ? <><b>Locked to the {platformName(recipient.platform)} name @{recipient.username}.</b> Whoever connects {platformName(recipient.platform)} to HaPaPay with that name claims it{recipient.platform === "telegram" ? "" : ", with an account older than this link"}. Check the spelling; if nobody claims it within {windowLabel(review.expiryHours)}, you take it back.</>
        : <><b>The claim is locked to an immutable provider ID, not a username.</b> A renamed account cannot redirect the tokens.</>}</span></div>
    {funding && <a className={`transaction-link ${funding.status === "confirmed" ? "confirmed" : funding.status === "verification_failed" ? "verification-failed" : "pending"}`} href={solanaTransactionUrl(funding.signature)} target="_blank" rel="noreferrer">{funding.status === "confirmed" ? "In the vault" : funding.status === "verification_failed" ? "Check in explorer" : "Transaction submitted"} · {funding.signature.slice(0, 10)}…</a>}
    {funding?.link ? <div className="claim-link"><span>Claim link</span><CopyButton text={funding.link} /><code>{funding.link}</code></div>
      : (!funding || funding.status === "verification_failed") && <button className={funding ? "stock-verify-again" : undefined} disabled={busy || (!funding && (!ready || (Boolean(wallet) && Boolean(solanaAddress) && stock && !eligible)))} onClick={() => void fund()}>{label}</button>}
  </article>;
}
