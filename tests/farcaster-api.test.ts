import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";
import { VerifiedIdentityService } from "../server/verified-identity-service";

describe("Sign in with Farcaster HTTP API", () => {
  let server: Server;
  let origin: string;
  let cookie: string;
  const identities = new VerifiedIdentityService();

  before(async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "farcaster-api-secret-with-32-characters" });
    const app = createApp({
      auth,
      identities,
      farcaster: {
        start: async () => ({ requestId: "request-id", url: "farcaster://connect", expiresAt: "2026-09-13T10:10:00.000Z" }),
        complete: async () => ({ state: "verified" as const, account: { platform: "farcaster" as const, providerUserId: "6841", username: "arc-user" } }),
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
    const wallet = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const challenge = await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address }) }).then((response) => response.json()) as { id: string; message: string };
    const signature = await wallet.signMessage({ message: challenge.message });
    const login = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, challengeId: challenge.id, signature }) });
    cookie = login.headers.get("set-cookie") ?? "";
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("stores the FID only after the SIWF request verifies", async () => {
    const start = await fetch(`${origin}/api/oauth/farcaster/start`, { method: "POST", headers: { Cookie: cookie } });
    assert.deepEqual(await start.json(), { requestId: "request-id", url: "farcaster://connect", expiresAt: "2026-09-13T10:10:00.000Z" });
    const complete = await fetch(`${origin}/api/oauth/farcaster/complete`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "request-id" }) });
    assert.equal(complete.status, 200);
    assert.equal(await identities.resolve("farcaster", "arc-user"), "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c");
  });
});
