import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";
import { VerifiedIdentityService } from "../server/verified-identity-service";

describe("verified identity unlink HTTP API", () => {
  let server: Server;
  let origin: string;
  let cookie: string;

  before(async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "unlink-api-secret-with-at-least-32-characters" });
    const identities = new VerifiedIdentityService();
    const wallet = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    identities.link(wallet.address, {
      platform: "github", providerUserId: "github-42", username: "octocat", verifiedAt: new Date().toISOString(),
    });
    const app = createApp({ auth, identities });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    const challenge = await fetch(`${origin}/api/auth/challenge`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address }),
    }).then((response) => response.json()) as { id: string; message: string };
    const signature = await wallet.signMessage({ message: challenge.message });
    const login = await fetch(`${origin}/api/auth/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet.address, challengeId: challenge.id, signature }),
    });
    cookie = login.headers.get("set-cookie") ?? "";
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  it("stops resolving a social handle as soon as its owner removes it", async () => {
    const removed = await fetch(`${origin}/api/identity/github`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { wallet: "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c", accounts: [] }, "nothing about an onchain record");

    const resolved = await fetch(`${origin}/api/resolve/github/octocat`);
    assert.equal(resolved.status, 404);
  });
});
