import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { padHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { MemoryPaymentRepository, PaymentHistoryService } from "../server/payment-history-service";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

describe("verified Arc payment history HTTP API", () => {
  let server: Server;
  let origin: string;
  let cookie: string;
  const hash = `0x${"ab".repeat(32)}` as const;

  before(async () => {
    const sender = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const recipient = "0x2222222222222222222222222222222222222222" as const;
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "payment-history-secret-with-32-characters" });
    const identities = new VerifiedIdentityService();
    identities.link(recipient, { platform: "x", providerUserId: "x-22", username: "nora", verifiedAt: "2026-09-13T10:00:00.000Z" });
    identities.link(sender.address, { platform: "github", providerUserId: "gh-sender", username: "ada", verifiedAt: "2026-09-13T10:00:00.000Z" });
    const payments = new PaymentHistoryService({
      chainId: 5_042_002,
      usdc: "0x1111111111111111111111111111111111111111",
      repository: new MemoryPaymentRepository(),
      client: {
        getTransactionReceipt: async () => ({
          status: "success" as const,
          from: sender.address,
          blockNumber: 4812n,
          logs: [{
            address: "0x1111111111111111111111111111111111111111" as const,
            topics: [TRANSFER_TOPIC, padHex(sender.address, { size: 32 }), padHex(recipient, { size: 32 })],
            data: toHex(2_500_000n, { size: 32 }),
          }],
        }),
      },
      now: () => new Date("2026-09-13T11:00:00.000Z"),
    });
    const app = createApp({ auth, identities, payments });
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

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("stores and lists a payment only after its Arc USDC transfer log verifies", async () => {
    const confirmed = await fetch(`${origin}/api/payments/confirm`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ transactionHash: hash, amount: "2.5", sourcePlatform: "github", recipient: { platform: "x", username: "nora" } }),
    });
    assert.equal(confirmed.status, 201);
    assert.deepEqual(await confirmed.json(), {
      transactionHash: hash,
      direction: "sent",
      counterparty: "0x2222222222222222222222222222222222222222",
      platform: "x",
      username: "nora",
      amount: "2.5",
      blockNumber: "4812",
      confirmedAt: "2026-09-13T11:00:00.000Z",
      sourceIdentity: { platform: "github", username: "ada" },
    });

    const history = await fetch(`${origin}/api/payments`, { headers: { Cookie: cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as { payments: unknown[] }).payments.length, 1);
  });

  it("rejects a browser claim whose amount does not match the Arc log", async () => {
    const response = await fetch(`${origin}/api/payments/confirm`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ transactionHash: `0x${"cd".repeat(32)}`, amount: "3", recipient: { platform: "x", username: "nora" } }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Receipt does not contain the reviewed Arc USDC transfer." });

    const history = await fetch(`${origin}/api/payments`, { headers: { Cookie: cookie } });
    assert.equal((await history.json() as { payments: unknown[] }).payments.length, 1);
  });
});
