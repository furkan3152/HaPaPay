import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import type { IdentityStore } from "../server/identity-store";
import { WalletAuthService } from "../server/wallet-auth";

describe("wallet session HTTP API", () => {
  let server: Server;
  let origin: string;

  before(async () => {
    const app = createApp({
      auth: new WalletAuthService({
        domain: "127.0.0.1",
        sessionSecret: "integration-secret-with-32-characters",
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
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("authenticates a wallet without exposing the session token to JavaScript", async () => {
    const account = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const challengeResponse = await fetch(`${origin}/api/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    });
    const challenge = await challengeResponse.json() as { id: string; message: string };
    const signature = await account.signMessage({ message: challenge.message });

    const verifyResponse = await fetch(`${origin}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: account.address, challengeId: challenge.id, signature }),
    });
    const cookie = verifyResponse.headers.get("set-cookie");
    assert.match(cookie ?? "", /^hapapay_session=.*HttpOnly/);
    assert.match(cookie ?? "", /SameSite=Lax/);
    assert.match(cookie ?? "", /Max-Age=2592000(?:;|$)/, "the browser keeps the session for 30 days");
    const body = await verifyResponse.json() as Record<string, unknown>;
    assert.equal("token" in body, false);
    const days = (Date.parse(String(body.expiresAt)) - Date.now()) / 86_400_000;
    assert.ok(days > 29.99 && days <= 30, `the session lasts 30 days, not ${days}`);

    const meResponse = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie ?? "" } });
    assert.deepEqual(await meResponse.json(), { authenticated: true, address: account.address });
  });

  it("protects browser responses with a restrictive security policy", async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.match(response.headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  it("rate limits repeated wallet challenge creation", async () => {
    const requests = [];
    for (let index = 0; index < 12; index += 1) {
      requests.push(await fetch(`${origin}/api/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: "0x1111111111111111111111111111111111111111" }),
      }));
    }
    assert.equal(requests.at(-1)?.status, 429);
    assert.ok(requests.at(-1)?.headers.get("ratelimit"));
  });
});

describe("linked accounts read", () => {
  it("answers a failed read with a retryable 503 that says nothing was removed", async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "integration-secret-with-32-characters" });
    const account = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    let failing = true;
    const identities: IdentityStore = {
      link: () => { throw new Error("not used"); },
      resolve: () => undefined,
      profile: async (wallet) => {
        if (failing) throw new Error("Connection terminated due to connection timeout");
        return { wallet: getAddress(wallet), accounts: [{ platform: "github", username: "octocat", verified: true }] };
      },
      account: () => undefined,
      unlink: () => undefined,
    };
    const app = createApp({ auth, identities });
    const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      const challenge = await auth.createChallenge(account.address);
      const session = await auth.verifyChallenge({ address: account.address, challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
      const cookie = `hapapay_session=${session.token}`;

      const failed = await fetch(`${origin}/api/profile`, { headers: { Cookie: cookie } });
      assert.equal(failed.status, 503);
      assert.equal(failed.headers.get("retry-after"), "2");
      assert.equal(failed.headers.get("cache-control"), "no-store");
      const error = await failed.json() as { error: string };
      assert.match(error.error, /still linked/);
      assert.doesNotMatch(error.error, /timeout|connection/i, "no database error text reaches the browser");

      failing = false;
      const read = await fetch(`${origin}/api/profile`, { headers: { Cookie: cookie } });
      assert.equal(read.status, 200);
      assert.deepEqual(await read.json(), { wallet: account.address, accounts: [{ platform: "github", username: "octocat", verified: true }] });
      assert.equal((await fetch(`${origin}/api/profile`)).status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
