import { PAYMENT_NOTE_MAX_CHARACTERS, checkPaymentNote } from "../domain/payment-note";

/**
 * The note that rides with a payment. It is written on chain, where anyone can read it and nobody can change or
 * remove it, so the review says so and the sender can change or clear it until the wallet opens.
 */
export function NoteField({ id, value, onChange, disabled }: { id: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const check = checkPaymentNote(value);
  const length = check.ok && check.note ? [...check.note].length : 0;
  return <div className="note-field">
    <label htmlFor={id}><span>Note</span><small>Optional · public on chain</small></label>
    <div className="note-input">
      <input id={id} value={value} maxLength={400} disabled={disabled} autoComplete="off" placeholder="For example: thanks for dinner" aria-describedby={`${id}-help`} aria-invalid={!check.ok} onChange={(event) => onChange(event.target.value)} />
      {value && !disabled && <button type="button" aria-label="Clear the note" onClick={() => onChange("")}>Clear</button>}
    </div>
    <p id={`${id}-help`} className={check.ok ? undefined : "note-error"} role={check.ok ? undefined : "alert"}>
      {check.ok
        ? `${length}/${PAYMENT_NOTE_MAX_CHARACTERS} · Written on chain with the payment: anyone can read it and it cannot be removed.`
        : check.error}
    </p>
  </div>;
}
