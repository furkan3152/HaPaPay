import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paymentAssetSymbol, paymentCounterparty, selectPaymentActivity, type PaymentHistoryItem } from "../src/domain/payment-activity";

const receipt: PaymentHistoryItem = {
  transactionHash: `0x${"a".repeat(64)}`,
  direction: "received",
  counterparty: "0x1111111111111111111111111111111111111111",
  platform: "x",
  username: "recipient",
  amount: "9007199254.740991",
  blockNumber: "812345",
  confirmedAt: "2026-09-24T09:00:00.000Z",
};

describe("verified payment activity", () => {
  it("identifies an incoming sender from source identity, never from recipient metadata", () => {
    assert.deepEqual(paymentCounterparty({ ...receipt, sourceIdentity: { platform: "github", username: "nora" } }), {
      label: "@nora", platform: "GitHub",
    });
    assert.deepEqual(paymentCounterparty(receipt), { label: receipt.counterparty });
    assert.deepEqual(paymentCounterparty({ ...receipt, direction: "sent" }), { label: "@recipient", platform: "X" });
  });

  it("filters sent and received receipts without changing their order or exact amounts", () => {
    const sent = { ...receipt, direction: "sent" as const, transactionHash: `0x${"b".repeat(64)}` };
    const payments = [receipt, sent];
    assert.deepEqual(selectPaymentActivity(payments, { direction: "sent" }).items, [sent]);
    assert.deepEqual(selectPaymentActivity(payments, { direction: "received" }).items, [receipt]);
    assert.deepEqual(selectPaymentActivity(payments).items, [receipt, sent]);
    assert.equal(selectPaymentActivity(payments).items[0].amount, "9007199254.740991");
    assert.deepEqual(payments, [receipt, sent]);
  });

  it("searches counterparty handles, providers, wallets and hashes with the direction filter", () => {
    const incoming = { ...receipt, sourceIdentity: { platform: "github", username: "nora" } };
    const outgoing = { ...receipt, direction: "sent" as const, transactionHash: `0x${"b".repeat(64)}` };
    const payments = [incoming, outgoing];
    for (const query of ["  @NORA ", "nora", "GITHUB", "aaaa"]) {
      assert.deepEqual(selectPaymentActivity(payments, { query }).items, [incoming]);
    }
    assert.deepEqual(selectPaymentActivity(payments, { query: "111111" }).items, payments);
    assert.deepEqual(selectPaymentActivity(payments, { query: "recipient" }).items, [outgoing]);
    assert.deepEqual(selectPaymentActivity(payments, { query: "nora", direction: "sent" }).items, []);
    assert.deepEqual(selectPaymentActivity(payments, { query: "missing" }).items, []);
    assert.deepEqual(selectPaymentActivity(payments, { query: "  " }).items, payments);
  });

  it("shows five matches at a time and counts matches before pagination", () => {
    const payments = Array.from({ length: 12 }, (_, index) => ({ ...receipt, transactionHash: `0x${index.toString(16).padStart(64, "0")}` }));
    assert.deepEqual(selectPaymentActivity(payments), { items: payments.slice(0, 5), total: 12, hasMore: true });
    assert.deepEqual(selectPaymentActivity(payments, { limit: 10 }), { items: payments.slice(0, 10), total: 12, hasMore: true });
    assert.deepEqual(selectPaymentActivity(payments, { limit: 15 }), { items: payments, total: 12, hasMore: false });
    assert.deepEqual(selectPaymentActivity(payments, { direction: "sent" }), { items: [], total: 0, hasMore: false });
  });

  it("labels stock-token receipts with their ticker and finds them by it", () => {
    const stock: PaymentHistoryItem = {
      ...receipt,
      transactionHash: `0x${"c".repeat(64)}`,
      amount: "2.5",
      asset: { type: "stock-token", symbol: "TSLA", address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", chainId: 46630, network: "robinhood-testnet" },
    };
    assert.equal(paymentAssetSymbol(receipt), "USDC");
    assert.equal(paymentAssetSymbol(stock), "TSLA");
    assert.deepEqual(selectPaymentActivity([receipt, stock], { query: "tsla" }).items, [stock]);
    assert.deepEqual(selectPaymentActivity([receipt, stock], { query: "usdc" }).items, [receipt]);
  });
});
