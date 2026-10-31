import { useState, type FormEvent } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ELYSIUM_BATCH_MAX } from "../../domain/elysium";
import { platformName, type Platform } from "../../domain/payment-intent";
import { playCue, speak } from "../../sound";
import { api, short, usd } from "../api";
import { PlatformPicker, prepare, StageLine, useAmount, AmountField, useOpen, usePayment, type PreparedCall } from "../pay";
import { useSession } from "../session";

type Row = { id: number; platform: Platform; username: string; amount: string };
type Prepared = PreparedCall & { recipients: Array<{ platform: Platform; username: string; recipient: string; amount: string; fee: string }> };

let nextId = 1;
const row = (platform: Platform = "x"): Row => ({ id: nextId++, platform, username: "", amount: "" });

/**
 * Split: up to ten verified handles paid in one Elysium transaction (the router's payNativeBatch). Split a total
 * evenly, or give each person their own amount. Every handle is resolved before anything is signed.
 */
export function SplitPage() {
  const session = useSession();
  const [rows, setRows] = useState<Row[]>(() => [row(), row()]);
  const [mode, setMode] = useState<"even" | "each">("even");
  const total = useAmount();
  const [note, setNote] = useState("");
  const [review, setReview] = useState<Prepared>();
  const [preparing, setPreparing] = useState(false);
  const { stage, setStage, sign } = usePayment();
  const { open, reason } = useOpen();
  const update = (id: number, change: Partial<Row>) => setRows((current) => current.map((entry) => entry.id === id ? { ...entry, ...change } : entry));
  const share = mode === "even" && total.hypeAmount ? (Number(total.hypeAmount) / rows.length).toFixed(6).replace(/\.?0+$/, "") : "";

  async function onReview(event: FormEvent) {
    event.preventDefault();
    if (!session.wallet && !(await session.connect())) return;
    const recipients = rows.map((entry) => ({ platform: entry.platform, username: entry.username, amount: mode === "even" ? share : entry.amount }));
    if (recipients.some((entry) => !entry.username.trim() || !entry.amount || Number(entry.amount) <= 0)) return setStage({ kind: "error", text: "Give every row a handle and an amount." });
    setPreparing(true);
    setStage({ kind: "idle" });
    try {
      const prepared = await prepare<Prepared>("/api/elysium/payments/prepare-batch", { network: session.networkId, recipients, note });
      setReview(prepared);
      playCue("open");
      speak(`Review. Split ${prepared.display.amount} HYPE between ${prepared.recipients.length} people. Total with fees ${prepared.display.total} HYPE.`);
    } catch (error) {
      playCue("error");
      setStage({ kind: "error", text: error instanceof Error ? error.message : "The split could not be prepared." });
    } finally {
      setPreparing(false);
    }
  }

  const busy = stage.kind === "signing" || stage.kind === "confirming";
  return <div className="page-card">
    <header className="page-head">
      <p className="eyebrow">Split</p>
      <h1>Pay up to <span className="aurora-text">ten people</span> in one transaction</h1>
      <p className="muted">One signature, one block, everyone paid at once. Each payment carries its own 1% fee; the note goes to all.</p>
    </header>
    {review ? <article className="review glass">
      <ul className="split-list">
        {review.recipients.map((entry, index) => <li key={entry.recipient} style={{ animationDelay: `${index * 60}ms` }}>
          <ProviderIcon provider={entry.platform} /><span>@{entry.username}<small>{platformName(entry.platform)} · {short(entry.recipient)}</small></span><b>{entry.amount} HYPE</b>
        </li>)}
      </ul>
      <dl className="rows">
        <div><dt>Paid out</dt><dd><b className="big-num">{review.display.amount} HYPE</b>{session.hype && <small>≈ {usd(Number(review.display.amount) * session.hype.mid)}</small>}</dd></div>
        <div><dt>Fees</dt><dd>{review.display.fee} HYPE<small>1% of each payment, on top</small></dd></div>
        <div><dt>Total</dt><dd><b>{review.display.total} HYPE</b><small>plus gas</small></dd></div>
        {review.note && <div><dt>Note</dt><dd>{review.note}</dd></div>}
      </dl>
      <StageLine stage={stage} />
      <div className="actions">
        <button type="button" className="btn btn-aurora btn-lg" disabled={busy} onClick={() => void sign(review, (hash) => api("/api/elysium/payments/confirm-batch", { network: session.networkId, hash, recipients: review.recipients.map(({ platform, username }) => ({ platform, username })) }), `Split sent to ${review.recipients.length} people.`)}>{stage.kind === "signing" ? "Open your wallet…" : stage.kind === "confirming" ? "Confirming…" : `Sign and pay ${review.recipients.length}`}</button>
        <button type="button" className="btn btn-glass" disabled={busy} onClick={() => { setReview(undefined); setStage({ kind: "idle" }); }}>Edit</button>
      </div>
    </article> : <form className="form" onSubmit={onReview}>
      {!open && <p className="banner">{reason}</p>}
      <div className="seg" role="radiogroup" aria-label="How to split">
        <button type="button" role="radio" aria-checked={mode === "even"} onClick={() => setMode("even")}>Split a total evenly</button>
        <button type="button" role="radio" aria-checked={mode === "each"} onClick={() => setMode("each")}>Amount for each</button>
      </div>
      {mode === "even" && <AmountField field={total} label="Total" big />}
      <ol className="split-rows">
        {rows.map((entry, index) => <li key={entry.id}>
          <span className="split-n">{index + 1}</span>
          <PlatformPicker compact value={entry.platform} onChange={(platform) => update(entry.id, { platform })} />
          <input aria-label={`Handle ${index + 1}`} value={entry.username} onChange={(event) => update(entry.id, { username: event.target.value })} placeholder="@handle" autoComplete="off" />
          {mode === "each"
            ? <input aria-label={`HYPE for row ${index + 1}`} className="split-amount" value={entry.amount} onChange={(event) => update(entry.id, { amount: event.target.value })} inputMode="decimal" placeholder="HYPE" />
            : <span className="split-share">{share ? `${share} HYPE` : "—"}</span>}
          <button type="button" className="icon-btn" aria-label={`Remove row ${index + 1}`} disabled={rows.length <= 1} onClick={() => setRows((current) => current.filter((item) => item.id !== entry.id))}>×</button>
        </li>)}
      </ol>
      <button type="button" className="btn btn-glass" disabled={rows.length >= ELYSIUM_BATCH_MAX} onClick={() => setRows((current) => [...current, row(current.at(-1)?.platform)])}>+ Add a person ({rows.length}/{ELYSIUM_BATCH_MAX})</button>
      <label className="field"><span>Note <small className="muted">optional, for everyone</small></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={140} placeholder="team dinner" /></label>
      <StageLine stage={stage} />
      <button type="submit" className="btn btn-aurora btn-lg" disabled={!open || preparing}>{preparing ? "Preparing…" : "Review the split"}</button>
    </form>}
  </div>;
}
