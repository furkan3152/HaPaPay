import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../server/app";
import { OAuthFlowStore } from "../server/oauth-flow-store";
import { GitHubOAuthProvider } from "../server/social-providers";
import { WalletAuthService } from "../server/wallet-auth";

describe("OAuth return-path HTTP flow", () => {
  let server: Server;
  let origin: string;
  let cookie: string;

  before(async () => {
    const auth = new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "oauth-return-secret-with-32-characters" });
    const github = new GitHubOAuthProvider(
      { clientId: "client", clientSecret: "secret", redirectUri: "http://127.0.0.1/callback" },
      async (url) => String(url).includes("access_token")
        ? new Response(JSON.stringify({ access_token: "provider-token" }), { status: 200 })
        : new Response(JSON.stringify({ id: 424242, login: "claimant" }), { status: 200 }),
    );
    let state = 0;
    const app = createApp({ auth, github, oauthFlows: new OAuthFlowStore({ random: () => `claim-return-state-${state++}` }) });
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

  it("returns the verified recipient to the original claim URL", async () => {
    const claimPath = `/claim/0x${"ab".repeat(32)}`;
    const start = await fetch(`${origin}/api/oauth/github/start?returnTo=${encodeURIComponent(claimPath)}`, { headers: { Cookie: cookie } });
    assert.equal(start.status, 200);
    const authorizationUrl = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
    const callback = await fetch(`${origin}/api/oauth/github/callback?state=${authorizationUrl.searchParams.get("state")}&code=provider-code`, {
      headers: { Cookie: cookie }, redirect: "manual",
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `${claimPath}?linked=github`);
  });

  it("links from the payment desk itself and answers a bad return path in JSON", async () => {
    // The desk sends its own path; this was rejected with an HTML 500, so GitHub and X linking never opened.
    const start = await fetch(`${origin}/api/oauth/github/start?returnTo=%2F`, { headers: { Cookie: cookie } });
    assert.equal(start.status, 200);
    const authorizationUrl = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
    assert.equal(authorizationUrl.origin, "https://github.com");
    const callback = await fetch(`${origin}/api/oauth/github/callback?state=${authorizationUrl.searchParams.get("state")}&code=provider-code`, {
      headers: { Cookie: cookie }, redirect: "manual",
    });
    assert.equal(callback.headers.get("location"), "/?linked=github");

    const refused = await fetch(`${origin}/api/oauth/github/start?returnTo=${encodeURIComponent("https://evil.example/")}`, { headers: { Cookie: cookie } });
    assert.equal(refused.status, 400);
    assert.match(refused.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await refused.json(), { error: "Invalid OAuth return path." });
  });
});
