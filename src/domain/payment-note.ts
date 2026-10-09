import { concatHex, hexToBytes, stringToHex, type Hex } from "viem";

/**
 * A payment note: a short text the sender attaches to a payment. It rides in the same
 * transaction, after the fee router's `pay` arguments, where anyone can read it and nobody can change or remove it;
 * HaPaPay also keeps it with the verified payment in its own database. The router ignores bytes after its
 * arguments, so a note moves no value and needs no contract change.
 */
export const PAYMENT_NOTE_MAX_CHARACTERS = 140;
/** What the note's bytes start with, so an explorer's UTF-8 view and HaPaPay can tell the note from the call. */
export const PAYMENT_NOTE_PREFIX = "HaPaPay note: ";
/** `pay(address,address,uint256,bytes32)`: a selector and four 32-byte words. A note starts right after them. */
export const ROUTER_PAY_CALL_BYTES = 4 + 4 * 32;

export type PaymentNoteCheck = { ok: true; note?: string } | { ok: false; error: string };

/**
 * A note as it is written on chain: NFC, every run of whitespace one space, trimmed. Control characters, lone
 * surrogates and invisible format characters (bidirectional overrides among them, which could make a note read
 * differently in an explorer) are refused; the zero-width joiner that emoji sequences use is kept. Empty is no note.
 */
export function checkPaymentNote(input: unknown): PaymentNoteCheck {
  if (input === undefined || input === null) return { ok: true };
  if (typeof input !== "string") return { ok: false, error: "A note must be text." };
  const note = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!note) return { ok: true };
  if (/[\p{Cc}\p{Cs}]/u.test(note) || /(?!\u200D)\p{Cf}/u.test(note)) {
    return { ok: false, error: "A note cannot contain hidden or control characters." };
  }
  if ([...note].length > PAYMENT_NOTE_MAX_CHARACTERS) {
    return { ok: false, error: `A note can be at most ${PAYMENT_NOTE_MAX_CHARACTERS} characters.` };
  }
  return { ok: true, note };
}

/** The bytes a note adds after the call: its prefix and the note in UTF-8, or nothing without a note. */
export function paymentNoteSuffix(note?: string): Hex {
  return note ? stringToHex(`${PAYMENT_NOTE_PREFIX}${note}`) : "0x";
}

/** The call with the note after it. */
export function appendPaymentNote(data: Hex, note?: string): Hex {
  return note ? concatHex([data, paymentNoteSuffix(note)]) : data;
}

/**
 * The note a transaction's input carries after a call of `callBytes` bytes, when it is one HaPaPay would write:
 * valid UTF-8 after the prefix, already in its checked form. Anything else after the call is not a note.
 */
export function readPaymentNote(input: Hex, callBytes = ROUTER_PAY_CALL_BYTES): string | undefined {
  const bytes = hexToBytes(input);
  if (bytes.length <= callBytes) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(callBytes));
  } catch {
    return undefined;
  }
  if (!text.startsWith(PAYMENT_NOTE_PREFIX)) return undefined;
  const written = text.slice(PAYMENT_NOTE_PREFIX.length);
  const check = checkPaymentNote(written);
  return check.ok && check.note === written ? check.note : undefined;
}
