import { useState, type FormEvent } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import { platformName, type Platform } from "../../domain/payment-intent";
import { playCue, speak } from "../../sound";
import { api, short, usd } from "../api";
import { AmountField, PlatformPicker, prepare, StageLine, useAmount, useOpen, usePayment, type PreparedCall } from "../pay";
import { useSession } from "../session";

type Prepared = PreparedCall & { recipient: string; platform: Platform; username: string; amount: string; fee: string };

/**
 * Send: one verified handle, an amount in HYPE or dollars, an optional note. Review shows exactly what the router
 * will do; the wallet signs it; the receipt opens when Elysium confirms it. A pay link (/pay/x/alice?amount=5)
 * opens here with the handle, the amount and the note filled in.
 */
export function SendPage({ payTo }: { payTo?: { platform: Platform; username: string } }) {
  const session = useSession();
  const query = new URLSearchParams(window.location.search);
  const [platform, setPlatform] = useState<Platform>(payTo?.platform ?? "x");
  const [username, setUsername] = useState(payTo ? `@${payTo.username}` : "");
  const field = useAmount(query.get("amount") ?? "");
  const [note, setNote] = useState(query.get("note") ?? "");
  const [review, setReview] = useState<Prepared>();
  const [preparing, setPreparing] = useState(false);
  const { stage, setStage, sign } = usePayment();
  const { open, reason } = useOpen();

  async function onReview(event: FormEvent) {
    event.preventDefault();
    if (!session.wallet && !(await session.connect())) return;
    if (!field.hypeAmount) return setStage({ kind: "error", text: field.inDollars && !field.mid ? "The HYPE price is not loaded yet; write the amount in HYPE." : "Write an amount." });
    setPreparing(true);
    setStage({ kind: "idle" });
    try {
      const prepared = await prepare<Prepared>("/api/elysium/payments/prepare", { network: session.networkId, platform, username, amount: field.hypeAmount, note });
      setReview(prepared);
      playCue("open");
      speak(`Review. Send ${prepared.display.amount} HYPE to ${prepared.username} on ${platformName(prepared.platform)}. The fee is ${prepared.display.fee} HYPE.`);
    } catch (error) {
      playCue("error");
      setStage({ kind: "error", text: error instanceof Error ? error.message : "The payment could not be prepared." });
    } finally {
      setPreparing(false);
    }
  }

  const busy = stage.kind === "signing" || stage.kind === "confirming";
  return <div className="page-card">
    <header className="page-head">
      <p className="eyebrow">{payTo ? "Payment link" : "Send"}</p>
      <h1>{payTo ? <>Pay <span className="aurora-text">@{payTo.username}</span></> : <>Send HYPE to a <span className="aurora-text">name</span></>}</h1>
      <p className="muted">{payTo ? `On ${platformName(payTo.platform)}, to the wallet they verified on ElysaPay.` : "Any GitHub, X, Farcaster, Telegram or Discord account that has verified a wallet on ElysaPay."}</p>
    </header>

    {review ? <article className="review glass" aria-live="polite">
      <div className="review-flight" aria-hidden="true">
        <span className="orb orb-from">{short(session.wallet)}</span>
        <svg viewBox="0 0 200 40" preserveAspectRatio="none"><path className="flight-path" d="M4 30 C 60 0, 140 0, 196 30" /><circle className="flight-dot" r="3.5"><animateMotion dur="1.8s" repeatCount="indefinite" path="M4 30 C 60 0, 140 0, 196 30" /></circle></svg>
        <span className="orb orb-to"><ProviderIcon provider={review.platform} /> @{review.username}</span>
      </div>
      <dl className="rows">
        <div><dt>Recipient</dt><dd>@{review.username} · {platformName(review.platform)}<small>{short(review.recipient)} · verified wallet</small></dd></div>
        <div><dt>Amount</dt><dd><b className="big-num">{review.display.amount} HYPE</b>{field.mid && <small>≈ {usd(Number(review.display.amount) * field.mid)}</small>}</dd></div>
        <div><dt>Fee</dt><dd>{review.display.fee} HYPE<small>1%, added on top: @{review.username} receives exactly the amount</small></dd></div>
        <div><dt>Total</dt><dd><b>{review.display.total} HYPE</b><small>plus gas, a fraction of a cent on Elysium</small></dd></div>
        {review.note && <div><dt>Note</dt><dd>{review.note}<small>written on chain</small></dd></div>}
        <div><dt>Network</dt><dd>{session.network?.chainName}</dd></div>
      </dl>
      <StageLine stage={stage} />
      <div className="actions">
        <button type="button" className="btn btn-aurora btn-lg" disabled={busy} onClick={() => void sign(review, (hash) => api("/api/elysium/payments/confirm", { network: session.networkId, hash, platform: review.platform, username: review.username }), `Sent. ${review.username} received ${review.display.amount} HYPE.`)}>{stage.kind === "signing" ? "Open your wallet…" : stage.kind === "confirming" ? "Confirming…" : "Sign and send"}</button>
        <button type="button" className="btn btn-glass" disabled={busy} onClick={() => { setReview(undefined); setStage({ kind: "idle" }); }}>Edit</button>
      </div>
    </article>
      : <form className="form" onSubmit={onReview}>
        {!open && <p className="banner">{reason}</p>}
        {!payTo && <PlatformPicker value={platform} onChange={setPlatform} />}
        {!payTo && <label className="field"><span>Handle</span><span className="handle-wrap"><ProviderIcon provider={platform} /><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="@alice" autoComplete="off" required /></span></label>}
        <AmountField field={field} big />
        <label className="field"><span>Note <small className="muted">optional, written on chain</small></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={140} placeholder="for the pizza" /></label>
        <StageLine stage={stage} />
        <button type="submit" className="btn btn-aurora btn-lg" disabled={!open || preparing}>{preparing ? "Preparing…" : session.wallet ? "Review" : "Connect and review"}</button>
        {session.network?.faucetUrl && <p className="hint center">Need testnet HYPE? <a href={session.network.faucetUrl} target="_blank" rel="noreferrer">Kinetiq's faucet</a>{session.network.bridgeUrl && <> or <a href={session.network.bridgeUrl} target="_blank" rel="noreferrer">the bridge</a></>}.</p>}
      </form>}
  </div>;
}
