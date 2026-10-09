import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp, telegramBotId } from "../server/app";
import { OAuthFlowStore } from "../server/oauth-flow-store";
import { GitHubOAuthProvider, XOAuthProvider } from "../server/social-providers";
import { VerifiedIdentityService } from "../server/verified-identity-service";
import { WalletAuthService } from "../server/wallet-auth";

async function listen(app: ReturnType<typeof createApp>) {
  const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function signIn(origin: string, key = generatePrivateKey()) {
  const wallet = privateKeyToAccount(key);
  const challenge = await (await fetch(`${origin}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address }) })).json() as { id: string; message: string };
  const verify = await fetch(`${origin}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet.address, challengeId: challenge.id, signature: await wallet.signMessage({ message: challenge.message }) }) });
  return { address: wallet.address, cookie: (verify.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("wallet disconnect and provider sign-ins that say why they did not link", () => {
  let server: Server;
  let origin: string;
  let githubAnswer: "ok" | "down" | "credentials" = "ok";
  let xAccountRead = 200;
  let telegramTokenRefused = false;
  let telegramTokenChecks = 0;
  const identities = new VerifiedIdentityService();

  before(async () => {
    const github = new GitHubOAuthProvider(
      { clientId: "client", clientSecret: "secret", redirectUri: "http://127.0.0.1/callback" },
      async (url) => {
        if (githubAnswer === "down") return new Response("{}", { status: 502 });
        if (githubAnswer === "credentials" && String(url).includes("access_token")) {
          return new Response(JSON.stringify({ error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." }), { status: 200 });
        }
        return String(url).includes("access_token")
          ? new Response(JSON.stringify({ access_token: "provider-token" }), { status: 200 })
          : new Response(JSON.stringify({ id: 424242, login: "claimant" }), { status: 200 });
      },
    );
    const x = new XOAuthProvider(
      { clientId: "x-client", clientSecret: "x-secret", redirectUri: "http://127.0.0.1/x-callback" },
      async (url) => String(url).includes("oauth2/token")
        ? new Response(JSON.stringify({ access_token: "x-token" }), { status: 200 })
        : new Response(JSON.stringify(xAccountRead === 200 ? { data: { id: "7788", username: "claimant_x" } } : { title: "Refused" }), { status: xAccountRead }),
    );
    let state = 0;
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "identity-session-secret-with-32-chars" }),
      github,
      x,
      identities,
      telegramBotToken: "123456789:AAE-not-a-real-token-only-for-tests",
      telegramBotUsername: "hapapay_test_bot",
      telegramTokenCheck: { refused: async () => { telegramTokenChecks++; return telegramTokenRefused; } },
      appOrigin: "https://hapapay.example",
      oauthFlows: new OAuthFlowStore({ random: () => `identity-session-state-${state++}` }),
    });
    ({ server, origin } = await listen(app));
  });

  after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const startGitHub = async (cookie: string, returnTo = "/") => {
    const start = await fetch(`${origin}/api/oauth/github/start?returnTo=${encodeURIComponent(returnTo)}`, { headers: { Cookie: cookie } });
    assert.equal(start.status, 200);
    return new URL((await start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
  };
  const callback = async (query: string, cookie?: string) => (await fetch(`${origin}/api/oauth/github/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" })).headers.get("location");

  it("disconnects by clearing the session cookie, and refuses a plain form post", async () => {
    const { cookie } = await signIn(origin);
    const refused = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" });
    assert.equal(refused.status, 415);
    assert.equal(refused.headers.get("set-cookie"), null);
    const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") ?? "", /^hapapay_session=; HttpOnly; Path=\/; SameSite=Lax; Max-Age=0/);
    assert.deepEqual(await (await fetch(`${origin}/api/me`)).json(), { authenticated: false });
  });

  it("names the reason a GitHub sign-in did not link", async () => {
    const first = await signIn(origin);
    const second = await signIn(origin);
    // No session: the cookie ended before GitHub answered.
    assert.equal(await callback(`state=${await startGitHub(first.cookie)}&code=c`), "/?link_error=github&reason=session");
    // The person cancelled on GitHub: back to where they started, with nothing linked.
    const claimPath = `/claim/0x${"cd".repeat(32)}`;
    assert.equal(await callback(`state=${await startGitHub(first.cookie, claimPath)}&error=access_denied`, first.cookie), `${claimPath}?link_error=github&reason=denied`);
    // An unknown or used state, and a state another wallet started.
    assert.equal(await callback("state=never-issued&code=c", first.cookie), "/?link_error=github&reason=expired");
    assert.equal(await callback(`state=${await startGitHub(first.cookie)}&code=c`, second.cookie), "/?link_error=github&reason=session");
    // GitHub did not confirm the account.
    githubAnswer = "down";
    assert.equal(await callback(`state=${await startGitHub(first.cookie)}&code=c`, first.cookie), "/?link_error=github&reason=failed");
    // GitHub refused this site's own OAuth settings: every sign-in fails until the operator fixes them, and it says so.
    githubAnswer = "credentials";
    assert.equal(await callback(`state=${await startGitHub(first.cookie)}&code=c`, first.cookie), "/?link_error=github&reason=setup");
    githubAnswer = "ok";
    // Linked to the first wallet; the second wallet is told the account is taken.
    assert.equal(await callback(`state=${await startGitHub(first.cookie)}&code=c`, first.cookie), "/?linked=github");
    assert.equal(await callback(`state=${await startGitHub(second.cookie)}&code=c`, second.cookie), "/?link_error=github&reason=taken");
    assert.equal(identities.resolve("github", "claimant"), getAddress(first.address));
  });

  it("says when X signs a person in but refuses this site's read of the account", async () => {
    const { address, cookie } = await signIn(origin);
    const startX = async () => {
      const start = await fetch(`${origin}/api/oauth/x/start`, { headers: { Cookie: cookie } });
      assert.equal(start.status, 200);
      return new URL((await start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
    };
    const finish = async () => (await fetch(`${origin}/api/oauth/x/callback?state=${await startX()}&code=c`, { headers: { Cookie: cookie }, redirect: "manual" })).headers.get("location");
    const warn = console.warn;
    console.warn = () => {};
    try {
      // 402: the site's X developer account has no credits left; every X link fails until the operator restores it.
      xAccountRead = 402;
      assert.equal(await finish(), "/?link_error=x&reason=access");
      xAccountRead = 403;
      assert.equal(await finish(), "/?link_error=x&reason=access");
      // A busy X is the person's to retry.
      xAccountRead = 429;
      assert.equal(await finish(), "/?link_error=x&reason=failed");
    } finally {
      console.warn = warn;
      xAccountRead = 200;
    }
    assert.equal(await finish(), "/?linked=x");
    assert.equal(identities.resolve("x", "claimant_x"), getAddress(address));
  });

  it("offers Telegram through its login popup with the bot ID, and lets the page read the popup's answer", async () => {
    const providers = await (await fetch(`${origin}/api/providers`)).json() as { appOrigin: string | null; providers: Array<Record<string, unknown>> };
    assert.equal(providers.appOrigin, "https://hapapay.example", "the desk learns the site's own origin");
    assert.deepEqual(providers.providers.find((provider) => provider.id === "telegram"), {
      id: "telegram", name: "Telegram", configured: true, method: "Log in with Telegram", botUsername: "hapapay_test_bot", botId: "123456789",
    });
    const csp = (await fetch(`${origin}/api/health`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'self' https:\/\/oauth\.telegram\.org/);
    assert.match(csp, /script-src 'self' https:\/\/telegram\.org https:\/\/challenges\.cloudflare\.com;/, "still no unsafe-eval");
    assert.equal(telegramBotId("123456789:secret-part"), "123456789");
    assert.equal(telegramBotId("not-a-token"), undefined);
    assert.equal(telegramBotId(undefined), undefined);
  });

  it("links a Telegram login signed with the bot token, and says when Telegram refuses the site's token", async () => {
    const session = await signIn(origin);
    // What Telegram's login window answers (numbers for id and auth_date), signed as Telegram signs it.
    const signed = (fields: Record<string, string | number>, botToken: string) => {
      const check = Object.keys(fields).sort().map((name) => `${name}=${fields[name]}`).join("\n");
      return { ...fields, hash: createHmac("sha256", createHash("sha256").update(botToken).digest()).update(check).digest("hex") };
    };
    const verify = (body: unknown) => fetch(`${origin}/api/oauth/telegram/verify`, { method: "POST", headers: { Cookie: session.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const login = { id: 5550001, first_name: "Probe", username: "hapapay_probe", auth_date: Math.floor(Date.now() / 1000) };
    const otherToken = "123456789:AAE-a-revoked-token-only-for-tests";

    // The hash does not match and Telegram still accepts the site's token: it is the login that is wrong.
    const forged = await verify(signed(login, otherToken));
    assert.equal(forged.status, 401);
    assert.deepEqual(await forged.json(), { error: "Telegram signature is invalid." });
    // Telegram refuses the site's token (revoked or mistyped): every login fails this way, and the answer says it is the site.
    telegramTokenRefused = true;
    const refused = await verify(signed(login, otherToken));
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: "Telegram refused HaPaPay's bot token, so nothing was linked.", reason: "setup" });
    telegramTokenRefused = false;
    // A login without a hash is a signature that does not match, not a server error.
    const { hash: _hash, ...unsigned } = signed(login, otherToken);
    assert.deepEqual(await (await verify(unsigned)).json(), { error: "Telegram signature is invalid." });

    // Signed with the site's token: linked, without asking Telegram about the token.
    const checks = telegramTokenChecks;
    const linked = await verify(signed(login, "123456789:AAE-not-a-real-token-only-for-tests"));
    assert.equal(linked.status, 200);
    assert.equal(identities.resolve("telegram", "hapapay_probe"), getAddress(session.address));
    assert.equal(telegramTokenChecks, checks);
  });
});

describe("identity links live on HaPaPay's servers", () => {
  it("offers no onchain record: no registry routes, and Remove answers from the database alone", async () => {
    const identities = new VerifiedIdentityService();
    const app = createApp({
      auth: new WalletAuthService({ domain: "127.0.0.1", sessionSecret: "registry-status-secret-with-32-chars" }),
      identities,
      network: { ready: true, chainId: 5042, chainIdHex: "0x13b2", rpcUrl: "https://rpc.mainnet.arc.io/", usdcAddress: "0x3600000000000000000000000000000000000000", environment: "mainnet", chainName: "Arc Mainnet" },
    });
    const { server, origin } = await listen(app);
    try {
      assert.equal((await (await fetch(`${origin}/api/providers`)).json() as { appOrigin: unknown }).appOrigin, null, "no origin outside production");
      const network = await (await fetch(`${origin}/api/network`)).json() as Record<string, unknown>;
      assert.equal("registryReady" in network || "registryConfigured" in network, false);
      const session = await signIn(origin);
      identities.link(session.address, { platform: "github", providerUserId: "5005", username: "bob", verifiedAt: "2026-10-04T00:00:00.000Z" });
      for (const [method, path] of [["GET", "/api/identity/registry"], ["POST", "/api/identity/github/prepare-registry-link"], ["POST", "/api/identity/github/prepare-registry-unlink"]] as const) {
        assert.equal((await fetch(`${origin}${path}`, { method, headers: { Cookie: session.cookie } })).status, 404, path);
      }
      const removed = await fetch(`${origin}/api/identity/github`, { method: "DELETE", headers: { Cookie: session.cookie } });
      assert.equal(removed.status, 200);
      assert.deepEqual(await removed.json(), { wallet: getAddress(session.address), accounts: [] });
      assert.equal(identities.resolve("github", "bob"), undefined);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
