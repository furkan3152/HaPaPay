import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OAuthFlowStore } from "../server/oauth-flow-store";

describe("OAuth state seam", () => {
  it("binds a one-time provider callback to the wallet session that started it", async () => {
    const store = new OAuthFlowStore({
      now: () => new Date("2026-09-13T10:00:00.000Z"),
      random: () => "one-time-csrf-state",
    });
    const flow = await store.create({
      wallet: "0x1111111111111111111111111111111111111111",
      provider: "github",
      returnTo: `/claim/0x${"ab".repeat(32)}`,
    });

    assert.deepEqual(await store.consume({
      state: flow.state,
      wallet: "0x1111111111111111111111111111111111111111",
      provider: "github",
    }), {
      wallet: "0x1111111111111111111111111111111111111111",
      provider: "github",
      codeVerifier: undefined,
      returnTo: `/claim/0x${"ab".repeat(32)}`,
    });
    await assert.rejects(
      store.consume({ state: flow.state, wallet: "0x1111111111111111111111111111111111111111", provider: "github" }),
      /already used/,
    );
  });

  it("returns a stock claim recipient to the claim page on either Robinhood network", async () => {
    const store = new OAuthFlowStore({ random: () => "stock-claim-state" });
    const claimPath = `/claim/stock/robinhood-testnet/0x${"cd".repeat(32)}`;
    const flow = await store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "github", returnTo: claimPath });
    const consumed = await store.consume({ state: flow.state, wallet: "0x1111111111111111111111111111111111111111", provider: "github" });
    assert.equal(consumed.returnTo, claimPath);
    for (const returnTo of [
      `/claim/stock/robinhood-mainnet/0x${"cd".repeat(32)}`,
    ]) {
      await store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "x", returnTo });
    }
    for (const returnTo of [
      `/claim/stock/arc-testnet/0x${"cd".repeat(32)}`,
      `/claim/stock/robinhood-testnet/0x${"cd".repeat(31)}`,
      `/claim/stock/robinhood-testnet/0x${"cd".repeat(32)}/extra`,
      `//evil.example/claim/stock/robinhood-testnet/0x${"cd".repeat(32)}`,
    ]) {
      await assert.rejects(() => store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "github", returnTo }), /return path/, returnTo);
    }
  });

  it("returns a Solana vault link's recipient to its claim page", async () => {
    // Audit, 2026-10-06: GitHub and X Connect on a Solana claim page answered "Invalid OAuth return path".
    const store = new OAuthFlowStore({ random: () => "solana-claim-state" });
    const claimPath = `/claim/solana/0x${"ab".repeat(32)}`;
    const flow = await store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "x", returnTo: claimPath });
    assert.equal((await store.consume({ state: flow.state, wallet: "0x1111111111111111111111111111111111111111", provider: "x" })).returnTo, claimPath);
    for (const returnTo of [`/claim/solana/0x${"ab".repeat(31)}`, `/claim/solana/0x${"ab".repeat(32)}/x`, `//evil.example/claim/solana/0x${"ab".repeat(32)}`]) {
      await assert.rejects(() => store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "github", returnTo }), /return path/, returnTo);
    }
  });

  it("returns a link started on the payment desk to the desk", async () => {
    const store = new OAuthFlowStore({ random: () => "desk-state" });
    const flow = await store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "github", returnTo: "/" });
    assert.equal((await store.consume({ state: flow.state, wallet: "0x1111111111111111111111111111111111111111", provider: "github" })).returnTo, "/");
    for (const returnTo of ["//evil.example", "/\\evil.example", "/operator/../claim"]) {
      await assert.rejects(() => store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "github", returnTo }), /return path/, returnTo);
    }
  });

  it("rejects external OAuth return URLs", async () => {
    const store = new OAuthFlowStore();
    await assert.rejects(() => store.create({
      wallet: "0x1111111111111111111111111111111111111111",
      provider: "github",
      returnTo: "https://evil.example/steal",
    }), /return path/);
  });

  it("rejects a callback arriving under another wallet session", async () => {
    const store = new OAuthFlowStore({ random: () => "state-bound-to-wallet" });
    const flow = await store.create({ wallet: "0x1111111111111111111111111111111111111111", provider: "x" });
    await assert.rejects(
      store.consume({ state: flow.state, wallet: "0x2222222222222222222222222222222222222222", provider: "x" }),
      /different wallet/,
    );
  });
});
