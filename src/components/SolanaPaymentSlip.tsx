import { useState } from "react";
import { checkPaymentNote } from "../domain/payment-note";
import { platformName } from "../domain/payment-intent";
import { solanaFee, uiAmountToUnits } from "../domain/solana-amounts";
import { isSolanaStock, type SolanaAssetListing } from "../domain/solana-assets";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import { matchesSolanaTransfer, type PreparedSolanaTransfer } from "../domain/solana-transfers";
import { TransactionExpiredError } from "../domain/transaction-receipt";
import { formatUnits, parseUnits } from "viem";
import { readScaledMultiplier, sendSolanaTransaction, short, solanaTransactionUrl, solanaWalletFor } from "../solana-desk";
import "./solana.css";
import { DotIcon } from "./DotIcon";
import { DotText } from "./DotText";
import { NoteField } from "./NoteField";
import { ProviderIcon } from "./ProviderIcon";
import { VerifiedMark } from "./StatusMarks";
import { StockTile, formatUsd } from "./StockTokenList";

/** What the chat's Solana review names: the asset from the bundled list, who gets what, and the note. */
export type SolanaReview = {
  asset: Pick<SolanaAssetListing, "symbol" | "name" | "kind" | "mint" | "decimals" | "program" | "scaled">;
  /** `listed`: each person gets the amount the request wrote for them. */
  mode: "single" | "each" | "split" | "listed";
  amount: string;
  payments: Array<{ recipient: { platform: string; username: string }; address: string; amount: string }>;
  totalAmount: string;
  sourcePlatform?: string;
  note?: string;
};

/**
 * One sent transaction and the payments it carries (positions in the review). "failed" means Solana refused it, or its
 * blockhash ran out before it landed, and nothing moved, so those payments can be signed again; anything else is never
 * sent twice. `lastValidBlockHeight` is the prepared one, so a later check can tell a dropped transaction apart.
 */
type Part = { signature: string; indexes: number[]; units: string[]; lastValidBlockHeight?: string; status: "pending" | "confirmed" | "failed" | "verification_failed" };

/**
 * A Solana payment to one or several people, in one transaction where it fits: the review shows the amounts, the 1%
 * fee that goes to HaPaPay and the note; the server prepares the transaction; the browser rebuilds it from this
 * review (reading a scaled xStock's multiplier from Solana itself) and opens the wallet only when every byte matches;
 * the server records it after reading the confirmed transaction back.
 */
export default function SolanaPaymentSlip({ review, wallet, solanaAddress, treasury, transfers, price, busy, setBusy, onConnect, onAddSolana, onMessage, onRecorded }: {
  review: SolanaReview;
  wallet?: string;
  solanaAddress?: string;
  treasury?: string;
  transfers: { enabled: boolean; reason?: string };
  price?: number;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onConnect: () => void;
  onAddSolana: () => Promise<void>;
  onMessage: (message: string) => void;
  onRecorded: () => void;
}) {
  const [note, setNote] = useState(review.note ?? "");
  const [eligible, setEligible] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const { asset, payments } = review;
  const stock = isSolanaStock(asset);
  const several = payments.length > 1;
  const units = parseUnits(review.totalAmount, asset.decimals);
  const fee = payments.reduce((sum, payment) => sum + solanaFee(parseUnits(payment.amount, asset.decimals)), 0n);
  const value = asset.kind === "cash" ? Number(review.totalAmount) : price ? Number(review.totalAmount) * price : undefined;
  const live = parts.filter(({ status }) => status !== "failed");
  const remaining = payments.map((_, index) => index).filter((index) => !live.some(({ indexes }) => indexes.includes(index)));
  const done = remaining.length === 0 && live.every(({ status }) => status === "confirmed");
  const unrecorded = live.filter(({ status }) => status === "pending" || status === "verification_failed");
  const started = live.length > 0;
  const needsEligibility = stock && transfers.enabled && remaining.length > 0;
  const update = (signature: string, status: Part["status"]) => setParts((current) => current.map((part) => part.signature === signature ? { ...part, status } : part));

  /**
   * Asks the server to record a landed transaction from chain; it answers 409 when it already has, and 410 when the
   * transaction can no longer land, which marks its payments as not sent.
   */
  async function record(part: Pick<Part, "signature" | "indexes" | "units" | "lastValidBlockHeight">, checkedNote?: string) {
    const confirmation = await fetch("/api/solana/transfers/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signature: part.signature,
        asset: { symbol: asset.symbol, ...(asset.mint ? { mint: asset.mint } : {}) },
        recipients: part.indexes.map((index, position) => ({ ...payments[index].recipient, amount: payments[index].amount, units: part.units[position] })),
        ...(review.sourcePlatform ? { sourcePlatform: review.sourcePlatform } : {}),
        ...(checkedNote ? { note: checkedNote } : {}),
        ...(part.lastValidBlockHeight ? { lastValidBlockHeight: part.lastValidBlockHeight } : {}),
      }),
    });
    const result = await confirmation.json().catch(() => ({})) as { error?: string; expired?: boolean };
    if (confirmation.status === 410 && result.expired) {
      update(part.signature, "failed");
      throw new TransactionExpiredError();
    }
    const recorded = confirmation.ok || confirmation.status === 409;
    update(part.signature, recorded ? "confirmed" : "verification_failed");
    if (!recorded) throw new Error(`The payment could not be recorded yet: ${(result.error ?? "try again in a moment").replace(/\.$/, "")}.`);
  }

  async function verifyAgain() {
    const checked = checkPaymentNote(note);
    // Payments no transaction carries yet stay unsent whatever the check finds.
    const unsent = remaining.length;
    setBusy(true);
    try {
      // Each transaction is checked on its own, so one that cannot be recorded yet does not hold up the others.
      let failure: unknown;
      for (const part of unrecorded) await record(part, checked.ok ? checked.note : undefined).catch((error: unknown) => { failure ??= error; });
      if (failure) throw failure;
      onMessage(unsent ? "Recorded. The other payments are not sent yet: sign the remaining payments to send them." : "The payment is confirmed and recorded.");
      onRecorded();
    } catch (error) {
      onMessage(error instanceof TransactionExpiredError ? `${error.message} Sign again to send it.` : error instanceof Error ? error.message : "The payment could not be recorded yet.");
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!wallet) return void onConnect();
    if (!solanaAddress) return void await onAddSolana();
    if (unrecorded.length) return void await verifyAgain();
    const checked = checkPaymentNote(note);
    if (!checked.ok) return void onMessage(checked.error);
    // Only the payments not sent yet are prepared, so a retry never pays anyone twice.
    const pending = remaining;
    if (!pending.length) return;
    setBusy(true);
    try {
      const handle = await solanaWalletFor(solanaAddress);
      const multiplier = asset.scaled && asset.mint ? await readScaledMultiplier(asset.mint) : 1;
      const response = await fetch("/api/solana/transfers/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: { symbol: asset.symbol, ...(asset.mint ? { mint: asset.mint } : {}) },
          recipients: pending.map((index) => ({ ...payments[index].recipient, amount: payments[index].amount, expectedRecipientAddress: payments[index].address })),
          ...(review.sourcePlatform ? { sourcePlatform: review.sourcePlatform } : {}),
          ...(checked.note ? { note: checked.note } : {}),
          ...(stock ? { eligibilityConfirmed: eligible } : {}),
        }),
      });
      const prepared = await response.json().catch(() => ({})) as PreparedSolanaTransfer & { error?: string };
      if (!response.ok) throw new Error(prepared.error ?? "The Solana payment could not be prepared. Try again.");
      const matches = Boolean(treasury) && await matchesSolanaTransfer(prepared, {
        sender: solanaAddress,
        treasury: treasury!,
        asset: { symbol: asset.symbol, mint: asset.mint, decimals: asset.decimals, program: asset.program },
        payments: pending.map((index) => ({ recipient: payments[index].address, units: uiAmountToUnits(payments[index].amount, asset.decimals, multiplier) })),
        note: checked.note,
      });
      if (!matches) throw new Error("The prepared payment does not match this review. Nothing was signed.");
      onMessage(prepared.transactions.length > 1 ? `The payments need ${prepared.transactions.length} Solana transactions. Sign each in your wallet.` : "Sign the payment in your wallet. It moves in one Solana transaction.");
      for (const transaction of prepared.transactions) {
        const part = {
          indexes: transaction.payments.map((position) => pending[position]),
          units: transaction.payments.map((position) => prepared.payments[position].units),
          lastValidBlockHeight: transaction.lastValidBlockHeight,
        };
        let signature = "";
        try {
          signature = (await sendSolanaTransaction(handle, transaction.transaction, {
            onSubmitted: (submitted) => setParts((current) => [...current, { signature: submitted, ...part, status: "pending" }]),
            revertedMessage: "Solana refused the transaction, so nothing moved.",
            lastValidBlockHeight: transaction.lastValidBlockHeight,
          })).signature;
        } catch (error) {
          // A refused or expired transaction moved nothing; one still pending is left alone and checked again later.
          if (error instanceof TransactionExpiredError || (error instanceof Error && /refused the transaction/.test(error.message))) {
            setParts((current) => current.map((entry) => entry.status === "pending" && entry.indexes.join() === part.indexes.join() ? { ...entry, status: "failed" } : entry));
          }
          throw error;
        }
        await record({ signature, ...part }, checked.note);
      }
      onMessage(several ? `Paid ${payments.length} people on Solana. Confirmed and recorded.` : `${review.totalAmount} ${asset.symbol} reached @${payments[0].recipient.username} on Solana. Confirmed and recorded.`);
      onRecorded();
    } catch (error) {
      onMessage(error instanceof TransactionExpiredError ? `${error.message} Sign again to send it.` : error instanceof Error ? error.message : "The Solana payment was not signed.");
    } finally {
      setBusy(false);
    }
  }

  const label = unrecorded.length ? "Verify the payment again"
    : !transfers.enabled ? stock ? "xStocks transfers are off on this server" : "Solana transfers are off on this server"
    : !wallet ? "Verify your wallet first"
    : !solanaAddress ? "Add your Solana address"
    : needsEligibility && !eligible ? "Confirm eligibility to continue"
    : started ? "Sign the remaining payments"
    : "Review and sign in wallet";

  return <article className="payment-slip stock-slip solana-slip" data-network-theme="solana" data-state={done ? "confirmed" : started ? "pending" : undefined}>
    <div className="slip-top">
      <div><small>{several ? `${payments.length} payments on Solana` : `${stock ? "xStock" : asset.symbol} payment on Solana`}</small><strong><DotText text={review.totalAmount} /> <span className="slip-symbol">{asset.symbol}</span></strong></div>
      {done && <VerifiedMark />}
      {several || asset.kind === "cash" ? <div className="platform-avatar">{several ? <DotIcon name="link" size={18} /> : <ProviderIcon provider={payments[0].recipient.platform} />}</div> : <StockTile token={{ symbol: asset.symbol, kind: asset.kind === "etf" ? "etf" : "stock" }} size="large" />}
    </div>
    {several ? <ul className="solana-recipients" aria-label="Who receives it">
      {payments.map(({ recipient, address, amount }) => <li key={`${recipient.platform}:${recipient.username}`}>
        <ProviderIcon provider={recipient.platform} /><b>@{recipient.username}</b><span>{amount} {asset.symbol}</span><code>{short(address)}</code>
      </li>)}
    </ul> : <>
      <div className="recipient-line">
        <div><small>Recipient</small><b>@{payments[0].recipient.username}</b></div>
        <span>{platformName(payments[0].recipient.platform)}</span>
      </div>
      <div className="route-line"><span>{review.sourcePlatform ? `Your ${platformName(review.sourcePlatform)} identity` : "Your Solana wallet"}</span><i /><span>{short(payments[0].address)}</span></div>
    </>}
    <dl className="stock-facts">
      <div><dt>Network</dt><dd>{SOLANA_MAINNET.name} mainnet<small>{several ? "Everyone is paid in one transaction where it fits" : "One transaction, signed by your Solana wallet"}</small></dd></div>
      <div><dt>Asset</dt><dd>{asset.name}{asset.mint ? <> · <a href={`${SOLANA_MAINNET.explorerUrl}/token/${asset.mint}`} target="_blank" rel="noreferrer">{short(asset.mint)} <DotIcon name="arrow-up-right" size={12} /></a></> : " · native"}{asset.scaled && <small>Amounts as your wallet shows them; the issuer's multiplier is read from Solana before you sign</small>}</dd></div>
      <div><dt>Fee</dt><dd>{asset.scaled ? "≈ " : ""}{formatUnits(fee, asset.decimals)} {asset.symbol} · 1%<small>Goes to HaPaPay; {several ? "everyone receives exactly their amount" : `@${payments[0].recipient.username} receives exactly ${review.totalAmount}`}</small></dd></div>
      <div><dt>Total</dt><dd>{asset.scaled ? "≈ " : ""}{formatUnits(units + fee, asset.decimals)} {asset.symbol}<small>From your Solana wallet</small></dd></div>
      <div><dt>Value</dt><dd>{value !== undefined ? `≈ ${formatUsd(value.toFixed(2))} (${asset.kind === "cash" ? "dollar stablecoin" : "indicative"})` : "Price unavailable"}</dd></div>
      <div><dt>Network fee</dt><dd>SOL, paid by your wallet<small>A recipient without an account for {asset.symbol} gets one opened for about 0.0015 SOL, once</small></dd></div>
    </dl>
    <NoteField id="solana-note" value={note} disabled={busy || started} onChange={setNote} />
    {needsEligibility && <label className="stock-eligibility">
      <input type="checkbox" checked={eligible} disabled={busy} onChange={(event) => setEligible(event.target.checked)} />
      <span>I am not a U.S. person and I am outside the United States. To my knowledge the recipients are too, and xStocks are permitted where we all are. <a href="https://xstocks.fi" target="_blank" rel="noreferrer">Restrictions</a></span>
    </label>}
    <div className={`mainnet-lock ${transfers.enabled ? "mainnet-ready" : ""}`}>{transfers.enabled ? <DotIcon name="shield" size={16} /> : <DotIcon name="lock" size={16} />}<span>{transfers.enabled
      ? <><b>Live transfer.</b> Every recipient is resolved again, and the transaction is simulated from your wallet before it opens.</>
      : <><b>Signing locked.</b> {transfers.reason ?? "Solana transfers are not available on this server right now."} This draft never reaches your wallet.</>}</span></div>
    {parts.map(({ signature, status }) => <a key={signature} className={`transaction-link ${status === "confirmed" ? "confirmed" : status === "pending" ? "pending" : "verification-failed"}`} href={solanaTransactionUrl(signature)} target="_blank" rel="noreferrer">
      {status === "confirmed" ? "Payment confirmed" : status === "failed" ? "Not sent, nothing moved" : status === "verification_failed" ? "Check in explorer" : "Transaction submitted"} · {signature.slice(0, 10)}…
    </a>)}
    {!done && <button className={unrecorded.length ? "stock-verify-again" : undefined} disabled={busy || (!unrecorded.length && (!transfers.enabled || (Boolean(wallet) && Boolean(solanaAddress) && needsEligibility && !eligible)))} onClick={() => void sign()}>{label}</button>}
  </article>;
}
