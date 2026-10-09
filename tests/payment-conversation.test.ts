import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyPaymentConversation, paymentConversationReducer } from "../src/domain/payment-conversation";

describe("payment assistant conversation", () => {
  it("retains a submitted request and its assistant reply as text-only conversation", () => {
    const waiting = paymentConversationReducer(emptyPaymentConversation, { type: "request", id: 1, message: "Send 4.5 USDC to @nora on X" });
    assert.equal(waiting.pendingId, 1);
    assert.deepEqual(waiting.turns, [{ id: 1, request: "Send 4.5 USDC to @nora on X" }]);
    const completed = paymentConversationReducer(waiting, { type: "reply", id: 1, message: "Review the recipient and amount before signing." });
    assert.equal(completed.pendingId, undefined);
    assert.deepEqual(completed.turns, [{ id: 1, request: "Send 4.5 USDC to @nora on X", reply: "Review the recipient and amount before signing." }]);
  });

  it("ignores late replies to a cancelled request after a network change", () => {
    const waiting = paymentConversationReducer(emptyPaymentConversation, { type: "request", id: 1, message: "Send 4.5 USDC to @nora on X" });
    const cancelled = paymentConversationReducer(waiting, { type: "cancel", id: 1, message: "Network changed. Create a new draft." });
    const next = paymentConversationReducer(cancelled, { type: "request", id: 2, message: "Send 8 USDC to @octocat on GitHub" });
    const stale = paymentConversationReducer(next, { type: "reply", id: 1, message: "The old recipient is ready." });
    assert.deepEqual(stale, next);
    assert.equal(stale.pendingId, 2);
    assert.equal(stale.turns[0].reply, "Network changed. Create a new draft.");
  });

  it("keeps only the ten most recent exchanges without retaining actionable payment data", () => {
    let conversation = emptyPaymentConversation;
    for (let id = 1; id <= 12; id++) {
      conversation = paymentConversationReducer(conversation, { type: "request", id, message: `Payment request ${id}` });
      conversation = paymentConversationReducer(conversation, { type: "reply", id, message: `Payment review ${id}` });
    }
    assert.equal(conversation.turns.length, 10);
    assert.deepEqual(conversation.turns[0], { id: 3, request: "Payment request 3", reply: "Payment review 3" });
    assert.deepEqual(conversation.turns[9], { id: 12, request: "Payment request 12", reply: "Payment review 12" });
  });

  it("clears completed chat text but never removes an outstanding request", () => {
    const waiting = paymentConversationReducer(emptyPaymentConversation, { type: "request", id: 1, message: "Send 4.5 USDC to @nora on X" });
    assert.deepEqual(paymentConversationReducer(waiting, { type: "clear" }), waiting);
    const failed = paymentConversationReducer(waiting, { type: "reply", id: 1, message: "The assistant is unavailable. Try again." });
    const cleared = paymentConversationReducer(failed, { type: "clear" });
    assert.deepEqual(cleared, { turns: [] });
    assert.deepEqual(paymentConversationReducer(cleared, { type: "reply", id: 1, message: "Late old reply" }), cleared);
  });
});
