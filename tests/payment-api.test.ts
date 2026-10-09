import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { ClaimablePaymentService } from "../server/claimable-payment-service";
import { ClaimRedemptionService } from "../server/claim-redemption-service";
import { ARC_TESTNET, readArcNetworkConfig } from "../server/arc-network";

const FEES = {
  router: "0x5555555555555555555555555555555555555555",
  burnVault: "0x6666666666666666666666666666666666666666",
  treasury: "0x7777777777777777777777777777777777777777",
  feeBps: 100,
  burnShareBps: 5000,
  sink: "forwarder",
} as const;

describe("authenticated payment preparation HTTP API", () => {
  let server: Server;
  let origin: string;
  let cookie: string;
  let identities: VerifiedIdentityService;

  before(async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "payment-api-secret-with-32-characters" });
    const sender = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    identities = new VerifiedIdentityService();
    identities.link("0x2222222222222222222222222222222222222222", {
      platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: new Date().toISOString(),
    });
    identities.link(sender.address, {
      platform: "github", providerUserId: "424242", username: "claimant", verifiedAt: new Date().toISOString(),
    });
    const githubIdentityKey = keccak256(encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32"),
      [keccak256(stringToHex("github")), keccak256(stringToHex("424242"))],
    ));
    const activePaymentId = `0x${"ef".repeat(32)}` as const;
    const expiredPaymentId = `0x${"12".repeat(32)}` as const;
    const settledPaymentId = `0x${"5e".repeat(32)}` as const;
    const app = createApp({
      auth,
      identities,
      network: readArcNetworkConfig({ ARC_NETWORK_MODE: "testnet" }),
      // Three USDC on Arc Testnet, read before a plain transfer without a fee, which keeps 0.01 USDC aside for gas.
      arcUsdcBalance: async () => 3_000_000n,
      arcTransferGas: async () => 10_000n,
      claims: new ClaimablePaymentService({
        usdc: ARC_TESTNET.usdcAddress,
        escrow: "0x4444444444444444444444444444444444444444",
        fees: FEES,
        client: { readContract: async (call: { functionName: string }) => call.functionName === "balanceOf" ? 1_000_000_000n : 100n } as never,
        chainName: "Arc Testnet",
        directory: { lookup: async () => ({ platform: "github", providerUserId: "424242", username: "outside-user" }) },
        randomBytes32: () => `0x${"cd".repeat(32)}`,
      }),
      redemptions: new ClaimRedemptionService({
        chainId: 9_999_999,
        escrow: "0x4444444444444444444444444444444444444444",
        usdc: ARC_TESTNET.usdcAddress,
        attestor: privateKeyToAccount("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"),
        readPayment: async (paymentId) => paymentId === activePaymentId
          ? { payer: "0x9999999999999999999999999999999999999999", token: ARC_TESTNET.usdcAddress, identityKey: githubIdentityKey, amount: 3_250_000n, fee: 32_500n, expiry: 1_800_000_000n }
          : paymentId === expiredPaymentId
            ? { payer: sender.address, token: ARC_TESTNET.usdcAddress, identityKey: githubIdentityKey, amount: 1_000_000n, fee: 10_000n, expiry: 1_700_000_000n }
            : { payer: "0x0000000000000000000000000000000000000000", token: "0x0000000000000000000000000000000000000000", identityKey: `0x${"00".repeat(32)}`, amount: 0n, fee: 0n, expiry: 0n },
        now: () => new Date("2026-09-13T12:00:00.000Z"),
      }),
      claimFundings: {
        confirm: async (input) => ({
          paymentId: input.paymentId as `0x${string}`,
          transactionHash: input.transactionHash as `0x${string}`,
          payer: input.payer as `0x${string}`,
          recipient: { platform: input.platform, username: input.username },
          amount: input.amount,
          expiresAt: "2027-01-15T08:00:00.000Z",
          blockNumber: "77",
          confirmedAt: "2026-09-13T12:00:00.000Z",
          sourceIdentity: input.sourceIdentity,
          status: "funded" as const,
          claimPath: `/claim/${input.paymentId}`,
        }),
        // Recorded: the open link, and one the escrow no longer holds (claimed); nothing else.
        metadata: async (paymentId: string) => paymentId !== activePaymentId && paymentId !== settledPaymentId ? undefined : ({
          paymentId: paymentId as `0x${string}`,
          transactionHash: `0x${"cd".repeat(32)}` as `0x${string}`,
          payer: "0x9999999999999999999999999999999999999999" as const,
          recipient: { platform: "github" as const, username: "outside-user" },
          amount: "3.25",
          expiresAt: "2027-01-15T08:00:00.000Z",
          blockNumber: "77",
          confirmedAt: "2026-09-13T12:00:00.000Z",
          sourceIdentity: { platform: "github" as const, username: "claimant" },
        }),
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address }) }).then((response) => response.json()) as { id: string; message: string };
    const signature = await sender.signMessage({ message: challenge.message });
    const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature }) });
    cookie = login.headers.get("set-cookie") ?? "";
  });

  it("prepares claim and expired refund transactions through authenticated HTTP seams", async () => {
    const activePaymentId = `0x${"ef".repeat(32)}`;
    const claim = await fetch(`${origin}/api/claims/${activePaymentId}/prepare-claim`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json() as { transaction: { to: string } }).transaction.to, "0x4444444444444444444444444444444444444444");

    const expiredPaymentId = `0x${"12".repeat(32)}`;
    const refund = await fetch(`${origin}/api/claims/${expiredPaymentId}/prepare-refund`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(refund.status, 200);
    assert.equal((await refund.json() as { transaction: { to: string } }).transaction.to, "0x4444444444444444444444444444444444444444");
  });

  it("publishes onchain claim amount and expiry without requiring a wallet session", async () => {
    const activePaymentId = `0x${"ef".repeat(32)}`;
    const response = await fetch(`${origin}/api/claims/${activePaymentId}`);
    assert.equal(response.status, 200);
    const result = await response.json() as { amount: string; status: string; expiresAt: string };
    assert.deepEqual(result, {
      paymentId: activePaymentId,
      payer: "0x9999999999999999999999999999999999999999",
      amount: "3.25",
      fee: "0.0325",
      expiresAt: "2027-01-15T08:00:00.000Z",
      status: "claimable",
      recipient: { platform: "github", username: "outside-user" },
      sourceIdentity: { platform: "github", username: "claimant" },
    });
  });

  it("says a recorded link the escrow no longer holds was settled, and still refuses one it never recorded", async () => {
    // A claimed Arc link is reported as settled, not as a 404 "Claimable payment is unavailable", and a settled link
    // names nobody, so a payer's wallet never leads to the handle it paid.
    const settledPaymentId = `0x${"5e".repeat(32)}`;
    const settled = await fetch(`${origin}/api/claims/${settledPaymentId}`);
    assert.equal(settled.status, 200);
    assert.deepEqual(await settled.json(), {
      paymentId: settledPaymentId,
      payer: "0x9999999999999999999999999999999999999999",
      amount: "3.25",
      expiresAt: "2027-01-15T08:00:00.000Z",
      status: "settled",
    });
    const unknown = await fetch(`${origin}/api/claims/0x${"aa".repeat(32)}`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "Claimable payment is unavailable." });
  });

  it("confirms escrow funding before publishing its invite link", async () => {
    const response = await fetch(`${origin}/api/claims/confirm-funding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        transactionHash: `0x${"cd".repeat(32)}`,
        paymentId: `0x${"ab".repeat(32)}`,
        platform: "github",
        username: "outside-user",
        amount: "3.25",
        sourcePlatform: "github",
      }),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { claimPath: string; sourceIdentity: { username: string } };
    assert.equal(result.claimPath, `/claim/0x${"ab".repeat(32)}`);
    assert.equal(result.sourceIdentity.username, "claimant");
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("re-resolves the verified recipient and returns a wallet-signable Arc transaction", async () => {
    const response = await fetch(`${origin}/api/payment/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        kind: "send", amount: "2.5", token: "USDC",
        recipient: { platform: "x", username: "nora" }, status: "draft",
        sourcePlatform: "github",
        expectedRecipientAddress: "0x2222222222222222222222222222222222222222",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { chainIdHex: string; networkId: string; senderIdentity: { platform: string; username: string }; transaction: { to: string; data: string } };
    assert.equal(result.chainIdHex, "0x4cef52");
    assert.equal(result.networkId, "arc-testnet");
    assert.equal(result.transaction.to, ARC_TESTNET.usdcAddress);
    assert.match(result.transaction.data, /2222222222222222222222222222222222222222/);
    assert.deepEqual(result.senderIdentity, { platform: "github", username: "claimant" });
  });

  it("refuses a plain Arc transfer the wallet's USDC does not cover, gas included, before a wallet opens", async () => {
    const prepare = (amount: string) => fetch(`${origin}/api/payment/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        kind: "send", amount, token: "USDC",
        recipient: { platform: "x", username: "nora" }, status: "draft",
        expectedRecipientAddress: "0x2222222222222222222222222222222222222222",
      }),
    });
    for (const [amount, needs] of [["3.5", "3.51"], ["3", "3.01"]]) {
      const response = await prepare(amount);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: `Your wallet needs ${needs} USDC: the amount and about 0.01 USDC for gas, which Arc takes in USDC.` });
    }
    assert.equal((await prepare("2.99")).status, 200);
  });

  it("publishes a verified receive address for social payment links", async () => {
    const response = await fetch(`${origin}/api/resolve/x/%40NORA`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      platform: "x",
      username: "nora",
      address: "0x2222222222222222222222222222222222222222",
    });
  });

  it("prepares a two-step escrow payment for an officially discoverable non-user", async () => {
    const response = await fetch(`${origin}/api/claims/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ platform: "github", username: "outside-user", amount: "3.25", expiryHours: 72, sourcePlatform: "github" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { chainIdHex: string; networkId: string; escrow: string; fee: { units: string; totalAmount: string }; senderIdentity: { platform: string; username: string }; identity: { providerUserId: string }; transactions: Array<{ from: string; purpose: string }> };
    assert.equal(result.chainIdHex, "0x4cef52");
    assert.equal(result.networkId, "arc-testnet");
    assert.equal(result.identity.providerUserId, "424242");
    assert.equal(result.escrow, "0x4444444444444444444444444444444444444444");
    assert.deepEqual([result.fee.units, result.fee.totalAmount], ["32500", "3.2825"], "the sender approves the amount plus the 1% fee");
    assert.deepEqual(result.senderIdentity, { platform: "github", username: "claimant" });
    assert.deepEqual(result.transactions.map((transaction) => transaction.purpose), ["approve", "fund"]);
    assert.ok(result.transactions.every((transaction) => transaction.from));
  });

  it("rejects an unlinked source identity instead of inventing social attribution", async () => {
    const response = await fetch(`${origin}/api/payment/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        kind: "send", amount: "1", token: "USDC", sourcePlatform: "telegram",
        recipient: { platform: "x", username: "nora" }, status: "draft",
        expectedRecipientAddress: "0x3333333333333333333333333333333333333333",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Link and verify your Telegram account before sending from it." });
  });

  it("rejects a recipient identity that changed after the user reviewed the draft", async () => {
    identities.link("0x2222222222222222222222222222222222222222", {
      platform: "x", providerUserId: "x-22", username: "nora-renamed", verifiedAt: new Date().toISOString(),
    });
    identities.link("0x3333333333333333333333333333333333333333", {
      platform: "x", providerUserId: "x-33", username: "nora", verifiedAt: new Date().toISOString(),
    });

    const response = await fetch(`${origin}/api/payment/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        kind: "send", amount: "2.5", token: "USDC",
        recipient: { platform: "x", username: "nora" }, status: "draft",
        expectedRecipientAddress: "0x2222222222222222222222222222222222222222",
      }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Recipient identity changed after review. Review the payment again.",
    });
  });
});

describe("Arc Mainnet payment preparation", () => {
  it("never prepares a fee-free payment on Arc Mainnet: without verified fee contracts it waits", async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "payment-api-mainnet-secret-32-chars!" });
    const sender = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const identities = new VerifiedIdentityService();
    identities.link("0x2222222222222222222222222222222222222222", { platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: new Date().toISOString() });
    const app = createApp({ auth, identities, network: readArcNetworkConfig({ ARC_NETWORK_MODE: "mainnet" }) });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address }) }).then((response) => response.json()) as { id: string; message: string };
      const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: sender.address, challengeId: challenge.id, signature: await sender.signMessage({ message: challenge.message }) }) });
      const response = await fetch(`${origin}/api/payment/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: login.headers.get("set-cookie") ?? "" },
        body: JSON.stringify({
          kind: "send", amount: "2.5", token: "USDC", recipient: { platform: "x", username: "nora" }, status: "draft",
          networkPreference: "arc-mainnet", expectedRecipientAddress: "0x2222222222222222222222222222222222222222",
        }),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json() as { error: string }).error, /fee contracts are verified/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
