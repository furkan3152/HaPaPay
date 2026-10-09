import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concatHex, encodeFunctionData, hexToString, sliceHex, stringToHex } from "viem";
import {
  PAYMENT_NOTE_MAX_CHARACTERS,
  PAYMENT_NOTE_PREFIX,
  ROUTER_PAY_CALL_BYTES,
  appendPaymentNote,
  checkPaymentNote,
  paymentNoteSuffix,
  readPaymentNote,
} from "../src/domain/payment-note";
import { payRouterAbi } from "../src/domain/fees";

const pay = encodeFunctionData({
  abi: payRouterAbi,
  functionName: "pay",
  args: ["0x3600000000000000000000000000000000000000", "0x1111111111111111111111111111111111111111", 5_000_000n, `0x${"ab".repeat(32)}`],
});

describe("payment notes written on chain", () => {
  it("keeps a note in one checked form: NFC, single spaces, trimmed, at most 140 characters", () => {
    assert.deepEqual(checkPaymentNote(undefined), { ok: true });
    assert.deepEqual(checkPaymentNote("   "), { ok: true }, "an empty note is no note");
    assert.deepEqual(checkPaymentNote("  thanks\n for\tdinner  "), { ok: true, note: "thanks for dinner" });
    assert.deepEqual(checkPaymentNote("Cafe\u0301"), { ok: true, note: "Café" }, "composed, so the bytes on chain are one form");
    assert.deepEqual(checkPaymentNote("teşekkürler 🍕 👨\u200D👩\u200D👧"), { ok: true, note: "teşekkürler 🍕 👨\u200D👩\u200D👧" }, "emoji sequences keep their joiners");
    assert.equal(checkPaymentNote("x".repeat(PAYMENT_NOTE_MAX_CHARACTERS)).ok, true);
    assert.deepEqual(checkPaymentNote("x".repeat(PAYMENT_NOTE_MAX_CHARACTERS + 1)), { ok: false, error: "A note can be at most 140 characters." });
    assert.equal(checkPaymentNote("🍕".repeat(PAYMENT_NOTE_MAX_CHARACTERS)).ok, true, "characters, not UTF-16 units");
    for (const hidden of ["rent\u202Edue", "a\u2066b", "a\u200Bb", "a\u0000b", "a\u0007b", "a\uD800b", "a\u00ADb"]) {
      assert.deepEqual(checkPaymentNote(hidden), { ok: false, error: "A note cannot contain hidden or control characters." }, JSON.stringify(hidden));
    }
    assert.deepEqual(checkPaymentNote(42), { ok: false, error: "A note must be text." });
  });

  it("rides after the call with its prefix, and reads back only in its checked form", () => {
    assert.equal(paymentNoteSuffix(undefined), "0x");
    assert.equal(appendPaymentNote(pay, undefined), pay);
    const noted = appendPaymentNote(pay, "thanks for dinner");
    assert.equal(sliceHex(noted, 0, ROUTER_PAY_CALL_BYTES), pay, "the call itself is unchanged");
    assert.equal(hexToString(sliceHex(noted, ROUTER_PAY_CALL_BYTES)), `${PAYMENT_NOTE_PREFIX}thanks for dinner`);
    assert.equal(readPaymentNote(noted), "thanks for dinner");
    assert.equal(readPaymentNote(appendPaymentNote(pay, "yemek için 🍕")), "yemek için 🍕");
    assert.equal(readPaymentNote(pay), undefined, "no bytes after the call, no note");
    assert.equal(readPaymentNote(concatHex([pay, stringToHex("some other data")])), undefined, "bytes without the prefix are not a note");
    assert.equal(readPaymentNote(concatHex([pay, stringToHex(`${PAYMENT_NOTE_PREFIX}  two  spaces`)])), undefined, "a form the desk never writes");
    assert.equal(readPaymentNote(concatHex([pay, stringToHex(PAYMENT_NOTE_PREFIX), "0xff"])), undefined, "invalid UTF-8");
    assert.equal(readPaymentNote(concatHex([pay, stringToHex(`${PAYMENT_NOTE_PREFIX}bad\u202Enote`)])), undefined);
  });
});
