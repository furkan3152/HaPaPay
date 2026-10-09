import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { encodeAbiParameters, keccak256, padHex, parseAbiParameters, stringToHex, toEventSelector, toHex, TransactionReceiptNotFoundError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { ClaimFundingService, MemoryClaimFundingRepository } from "../server/claim-funding-service";
import { ClaimRedemptionService } from "../server/claim-redemption-service";
import { DuplicatePaymentError, MemoryPaymentRepository, PaymentHistoryService } from "../server/payment-history-service";
import { StockReceiptPendingError, StockTransferRejectedError, StockTransferUnavailableError } from "../server/stock-transfer-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";

/**
 * Audit, 2026-10-06: Arc confirmations refused a receipt the server's RPC had not seen yet as a failed verification,
 * recorded one transaction again when its hash was re-posted in another case, and answered with the RPC's own error
 * text, which names the provider's endpoint. They now read the receipt again for a while and then answer "pending",
 * keep one row per transaction, and answer RPC and directory outages with fixed messages.
 */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const PAYMENT_CREATED = toEventSelector("PaymentCreated(bytes32,address,bytes32,address,uint256,uint256,uint256)");
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ESCROW = "0x4444444444444444444444444444444444444444" as const;
const PAYER = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const HASH = `0x${"cd".repeat(32)}` as const;
const LABELLED_HASH = `0x${"ce".repeat(32)}` as const;
const PAYMENT_ID = `0x${"ef".repeat(32)}` as const;
const PROVIDER_URL = "https://example.quiknode.pro/SECRET-PROVIDER-TOKEN/";
const retry = { attempts: 3, delayMs: 1 };

const paymentReceipt = {
  status: "success" as const, from: PAYER.address, blockNumber: 10n,
  logs: [{ address: USDC, topics: [TRANSFER_TOPIC, padHex(PAYER.address, { size: 32 }), padHex(RECIPIENT, { size: 32 })] as const, data: toHex(5_000_000n, { size: 32 }) }],
};
const identityKey = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [keccak256(stringToHex("github")), keccak256(stringToHex("583231"))]));
const fundingReceipt = {
  status: "success" as const, from: PAYER.address, blockNumber: 10n,
  logs: [{
    address: ESCROW, topics: [PAYMENT_CREATED, PAYMENT_ID, padHex(PAYER.address, { size: 32 }), identityKey] as const,
    data: encodeAbiParameters(parseAbiParameters("address, uint256, uint256, uint256"), [USDC, 5_000_000n, 50_000n, BigInt(Math.floor(Date.now() / 1000) + 86_400)]),
  }],
};

/** An RPC that has no receipt for the first `missing` reads, as when it trails the wallet's RPC by a block. */
function trailing<R>(receipt: R, missing: number) {
  let reads = 0;
  return {
    reads: () => reads,
    getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      reads++;
      if (reads <= missing) throw new TransactionReceiptNotFoundError({ hash });
      return receipt;
    },
  };
}

const failing = {
  getTransactionReceipt: async (): Promise<never> => {
    throw new Error(`HTTP request failed.\n\nStatus: 429\nURL: ${PROVIDER_URL}\nVersion: viem@2`);
  },
};

const lookup = async () => ({ platform: "github" as const, providerUserId: "583231", username: "octocat" });

describe("Arc confirmations", () => {
  it("reads a payment's receipt again while the server's RPC trails the wallet's, then answers pending", async () => {
    const client = trailing(paymentReceipt, 2);
    const payments = new PaymentHistoryService({ chainId: 5042, usdc: USDC, repository: new MemoryPaymentRepository(), client, receiptRetry: retry });
    const confirm = { transactionHash: HASH, sender: PAYER.address, recipient: RECIPIENT, platform: "x" as const, username: "nora", amount: "5" };
    const recorded = await payments.confirm(confirm);
    assert.equal(recorded.transactionHash, HASH);
    assert.equal(client.reads(), 3);

    const never = new PaymentHistoryService({ chainId: 5042, usdc: USDC, repository: new MemoryPaymentRepository(), client: trailing(paymentReceipt, 99), receiptRetry: retry, chainName: "Arc Mainnet" });
    await assert.rejects(() => never.confirm(confirm), (error) => error instanceof StockReceiptPendingError && /^Arc Mainnet has no receipt/.test(error.message));
    const down = new PaymentHistoryService({ chainId: 5042, usdc: USDC, repository: new MemoryPaymentRepository(), client: failing, receiptRetry: retry });
    await assert.rejects(() => down.confirm(confirm), (error) => error instanceof StockTransferUnavailableError && !error.message.includes("quiknode"));
  });

  it("keeps one row for a payment whatever case its hash is written in", async () => {
    const payments = new PaymentHistoryService({ chainId: 5042, usdc: USDC, repository: new MemoryPaymentRepository(), client: trailing(paymentReceipt, 0) });
    const confirm = { sender: PAYER.address, recipient: RECIPIENT, platform: "x" as const, username: "nora", amount: "5" };
    await payments.confirm({ ...confirm, transactionHash: HASH });
    await assert.rejects(() => payments.confirm({ ...confirm, transactionHash: `0x${HASH.slice(2).toUpperCase()}` }), DuplicatePaymentError);
    await assert.rejects(() => payments.confirm({ ...confirm, transactionHash: `0x${"Cd".repeat(32)}` }), DuplicatePaymentError);
    assert.equal((await payments.list(RECIPIENT)).length, 1);
  });

  it("records a vault funding once, after a trailing RPC, and says a directory outage is to be verified again", async () => {
    const repository = new MemoryClaimFundingRepository();
    const fundings = new ClaimFundingService({ chainId: 5042, escrow: ESCROW, usdc: USDC, repository, client: trailing(fundingReceipt, 1), directory: { lookup }, receiptRetry: retry });
    const confirm = { payer: PAYER.address, platform: "github" as const, username: "octocat", amount: "5" };
    const first = await fundings.confirm({ ...confirm, transactionHash: HASH, paymentId: PAYMENT_ID });
    assert.equal(first.claimPath, `/claim/${PAYMENT_ID}`);
    const again = await fundings.confirm({ ...confirm, transactionHash: `0x${HASH.slice(2).toUpperCase()}`, paymentId: `0x${PAYMENT_ID.slice(2).toUpperCase()}` });
    assert.equal(again.paymentId, PAYMENT_ID, "the same link, not a second row");
    assert.equal((await repository.fundedBy(5042, PAYER.address, 20)).length, 1);
    assert.equal((await fundings.metadata(`0x${PAYMENT_ID.slice(2).toUpperCase()}`))?.paymentId, PAYMENT_ID);

    const outage = new ClaimFundingService({
      chainId: 5042, escrow: ESCROW, usdc: USDC, repository: new MemoryClaimFundingRepository(), client: trailing(fundingReceipt, 0),
      directory: { lookup: async () => { throw new Error("GitHub account lookup failed."); } },
    });
    await assert.rejects(() => outage.confirm({ ...confirm, transactionHash: HASH, paymentId: PAYMENT_ID }), (error) => error instanceof StockTransferUnavailableError && /Verify the funding again/.test(error.message));
    const unknown = new ClaimFundingService({
      chainId: 5042, escrow: ESCROW, usdc: USDC, repository: new MemoryClaimFundingRepository(), client: trailing(fundingReceipt, 0),
      directory: { lookup: async () => { throw new Error("GitHub account was not found."); } },
    });
    await assert.rejects(() => unknown.confirm({ ...confirm, transactionHash: HASH, paymentId: PAYMENT_ID }), (error) => error instanceof StockTransferRejectedError && error.message === "GitHub account was not found.");
  });

  it("records a vault funding whose window has already closed, so its payer finds it under Claims and takes it back", async () => {
    // Audit, 2026-10-06: a record that reached the server only after the window (a tab closed first) was refused, and
    // the link reached no Claims list.
    const closed = {
      ...fundingReceipt,
      logs: [{ ...fundingReceipt.logs[0], data: encodeAbiParameters(parseAbiParameters("address, uint256, uint256, uint256"), [USDC, 5_000_000n, 50_000n, BigInt(Math.floor(Date.now() / 1000) - 60)]) }],
    };
    const repository = new MemoryClaimFundingRepository();
    const fundings = new ClaimFundingService({ chainId: 5042, escrow: ESCROW, usdc: USDC, repository, client: trailing(closed, 0), directory: { lookup } });
    const recorded = await fundings.confirm({ transactionHash: HASH, paymentId: PAYMENT_ID, payer: PAYER.address, platform: "github", username: "octocat", amount: "5" });
    assert.ok(Date.parse(recorded.expiresAt) < Date.now());
    assert.deepEqual((await repository.fundedBy(5042, PAYER.address, 20)).map((record) => record.paymentId), [PAYMENT_ID]);
    assert.deepEqual(await repository.waitingFor(5042, [{ platform: "github", username: "octocat" }], BigInt(Math.floor(Date.now() / 1000)), 20), [], "and never offered to its recipient");
  });

  describe("over HTTP", () => {
    let server: Server;
    let origin: string;
    let cookie: string;

    before(async () => {
      const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "arc-confirmations-secret-with-32-chars" });
      const identities = new VerifiedIdentityService();
      identities.link(RECIPIENT, { platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: "2026-09-13T10:00:00.000Z" });
      const receipts = new Map<string, number>();
      const app = createApp({
        auth,
        identities,
        payments: new PaymentHistoryService({
          chainId: 5042,
          usdc: USDC,
          repository: new MemoryPaymentRepository(),
          receiptRetry: retry,
          client: {
            // The first hash is mined, the second is never seen, and any other one fails at the provider.
            getTransactionReceipt: async ({ hash }) => {
              receipts.set(hash, (receipts.get(hash) ?? 0) + 1);
              if (hash.toLowerCase() === HASH || hash === LABELLED_HASH) return paymentReceipt;
              if (hash === `0x${"ab".repeat(32)}`) throw new TransactionReceiptNotFoundError({ hash });
              return failing.getTransactionReceipt();
            },
          },
        }),
        redemptions: new ClaimRedemptionService({
          chainId: 5042,
          escrow: ESCROW,
          usdc: USDC,
          attestor: privateKeyToAccount("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"),
          readPayment: async () => {
            throw new Error(`HTTP request failed.\nURL: ${PROVIDER_URL}`);
          },
        }),
      });
      await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Missing test port");
          origin = `http://127.0.0.1:${address.port}`;
          resolve();
        });
      });
      const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: PAYER.address }) }).then((response) => response.json()) as { id: string; message: string };
      const signature = await PAYER.signMessage({ message: challenge.message });
      const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: PAYER.address, challengeId: challenge.id, signature }) });
      cookie = login.headers.get("set-cookie") ?? "";
    });

    after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const confirm = (transactionHash: string) => fetch(`${origin}/api/payments/confirm`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ transactionHash, amount: "5", recipient: { platform: "x", username: "nora" } }),
    });

    it("records a payment once, says pending with Retry-After while the receipt is missing, and hides the provider", async () => {
      assert.equal((await confirm(HASH)).status, 201);
      assert.equal((await confirm(`0x${HASH.slice(2).toUpperCase()}`)).status, 409, "a re-post in another case is the same payment");
      const pending = await confirm(`0x${"ab".repeat(32)}`);
      assert.equal(pending.status, 503);
      assert.equal(pending.headers.get("retry-after"), "5");
      assert.equal((await pending.json() as { pending?: boolean }).pending, true);
      const down = await confirm(`0x${"12".repeat(32)}`);
      assert.equal(down.status, 503);
      const body = await down.text();
      assert.doesNotMatch(body, /quiknode|SECRET|https?:\/\//);
      const malformed = await fetch(`${origin}/api/payments/confirm`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ transactionHash: "0x12" }) });
      assert.equal(malformed.status, 400);
      assert.doesNotMatch(await malformed.text(), /"code"|invalid_string|regex/, "a schema error is a fixed message, not the validator's report");
    });

    it("records a payment whose source account was unlinked since, without its label", async () => {
      // The payment already moved; the account it was sent from only labels it (audit, 2026-10-06).
      const labelled = await fetch(`${origin}/api/payments/confirm`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ transactionHash: LABELLED_HASH, amount: "5", recipient: { platform: "x", username: "nora" }, sourcePlatform: "github" }),
      });
      assert.equal(labelled.status, 201);
      const record = await labelled.json() as Record<string, unknown>;
      assert.equal(record.transactionHash, LABELLED_HASH);
      assert.equal(record.sourcePlatform ?? record.sourceIdentity, undefined);
    });

    it("answers a vault link the RPC cannot read with a fixed message", async () => {
      const page = await fetch(`${origin}/api/claims/${PAYMENT_ID}`);
      assert.equal(page.status, 503);
      assert.doesNotMatch(await page.text(), /quiknode|SECRET|https?:\/\//);
      const claim = await fetch(`${origin}/api/claims/${PAYMENT_ID}/prepare-claim`, { method: "POST", headers: { Cookie: cookie } });
      assert.doesNotMatch(await claim.text(), /quiknode|SECRET|https?:\/\//);
    });
  });
});
