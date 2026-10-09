import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paymentNetworkCatalog, resolvePaymentNetwork, PaymentNetworkSelectionError } from "../src/domain/payment-network";

describe("payment network preference", () => {
  it("lists four truthful choices and resolves auto only to verified Arc Testnet", () => {
    assert.deepEqual(paymentNetworkCatalog(true).map(({ id, available }) => [id, available]), [
      ["arc-testnet", true], ["arc-mainnet", false], ["robinhood-testnet", false], ["robinhood-mainnet", false],
    ]);
    assert.equal(resolvePaymentNetwork(undefined, true), "arc-testnet");
    assert.equal(resolvePaymentNetwork("auto", true), "arc-testnet");
  });

  it("exposes Arc Mainnet only when its independently verified runtime is selected", () => {
    assert.deepEqual(paymentNetworkCatalog(false, true).map(({ id, available }) => [id, available]), [
      ["arc-testnet", false], ["arc-mainnet", true], ["robinhood-testnet", false], ["robinhood-mainnet", false],
    ]);
    assert.equal(resolvePaymentNetwork(undefined, false, true), "arc-mainnet");
    assert.equal(resolvePaymentNetwork("arc-mainnet", false, true), "arc-mainnet");
  });

  it("rejects malformed preferences as 400 before selecting a route", () => {
    for (const input of [null, "Arc Testnet", "arc-testnet,robinhood-mainnet", 4663, {}]) {
      assert.throws(() => resolvePaymentNetwork(input, true), (error) => error instanceof PaymentNetworkSelectionError && error.status === 400);
    }
  });

  it("rejects every unavailable explicit choice with 503 and no fallback", () => {
    for (const input of ["arc-mainnet", "robinhood-testnet", "robinhood-mainnet"] as const) {
      assert.throws(() => resolvePaymentNetwork(input, true), (error) => error instanceof PaymentNetworkSelectionError && error.status === 503);
    }
    assert.throws(() => resolvePaymentNetwork("arc-testnet", false), (error) => error instanceof PaymentNetworkSelectionError && error.status === 503);
    assert.throws(() => resolvePaymentNetwork("auto", false), (error) => error instanceof PaymentNetworkSelectionError && error.status === 503);
  });

  it("keeps auto testnet-first when both Arc environments are available", () => {
    assert.equal(resolvePaymentNetwork("auto", true, true), "arc-testnet");
  });
});
