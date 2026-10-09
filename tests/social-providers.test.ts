import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubOAuthProvider,
  DiscordOAuthProvider,
  ProviderAccessError,
  ProviderSetupError,
  TelegramBotTokenCheck,
  TelegramSignatureError,
  XOAuthProvider,
  verifyTelegramLogin,
} from "../server/social-providers";

describe("social provider verification seam", () => {
  it("tells a refused site setting apart from a refused sign-in", async () => {
    const github = (answer: Record<string, string>) => new GitHubOAuthProvider(
      { clientId: "github-client", clientSecret: "github-secret", redirectUri: "https://hapapay.test/callback" },
      async () => new Response(JSON.stringify(answer), { status: 200 }),
    );
    for (const error of ["incorrect_client_credentials", "redirect_uri_mismatch"]) {
      await assert.rejects(github({ error, error_description: "refused" }).verifyCallback("code"), ProviderSetupError);
    }
    await assert.rejects(github({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }).verifyCallback("code"), (error) => !(error instanceof ProviderSetupError) && /incorrect or expired/.test(String(error)));
    const status = (code: number) => async () => new Response(JSON.stringify({ error: code === 401 ? "invalid_client" : "invalid_grant" }), { status: code });
    await assert.rejects(new XOAuthProvider({ clientId: "x", clientSecret: "s", redirectUri: "https://hapapay.test/x" }, status(401)).verifyCallback("code", "verifier"), ProviderSetupError);
    await assert.rejects(new XOAuthProvider({ clientId: "x", clientSecret: "s", redirectUri: "https://hapapay.test/x" }, status(400)).verifyCallback("code", "verifier"), (error) => !(error instanceof ProviderSetupError));
    await assert.rejects(new DiscordOAuthProvider({ clientId: "d", clientSecret: "s", redirectUri: "https://hapapay.test/d" }, status(401)).verifyCallback("code"), ProviderSetupError);
    await assert.rejects(new DiscordOAuthProvider({ clientId: "d", clientSecret: "s", redirectUri: "https://hapapay.test/d" }, status(400)).verifyCallback("code"), (error) => !(error instanceof ProviderSetupError));
  });

  it("says when X signs a person in but refuses this site's read of the account", async () => {
    // X answers 401, 402 or 403 on users/me when the site's X app lost its access or its developer account has no
    // credits left; the desk says so instead of failing the claim silently.
    const x = (status: number) => new XOAuthProvider(
      { clientId: "x-client", clientSecret: "x-secret", redirectUri: "https://hapapay.test/api/oauth/x/callback" },
      async (input) => String(input).includes("oauth2/token")
        ? new Response(JSON.stringify({ access_token: "x-access-token" }), { status: 200 })
        : new Response(JSON.stringify({ title: "Refused" }), { status }),
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const status of [401, 402, 403]) await assert.rejects(x(status).verifyCallback("code", "verifier"), ProviderAccessError);
      for (const status of [429, 500, 503]) await assert.rejects(x(status).verifyCallback("code", "verifier"), (error) => !(error instanceof ProviderAccessError) && !(error instanceof ProviderSetupError));
    } finally {
      console.warn = warn;
    }
  });

  it("revalidates the GitHub user after exchanging the callback code", async () => {
    const requests: string[] = [];
    const provider = new GitHubOAuthProvider(
      { clientId: "github-client", clientSecret: "github-secret", redirectUri: "https://hapapay.test/callback" },
      async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("access_token")) {
          return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 583231, login: "Arc-Builder" }), { status: 200 });
      },
    );

    const account = await provider.verifyCallback("short-lived-code");
    assert.deepEqual(account, {
      platform: "github",
      providerUserId: "583231",
      username: "Arc-Builder",
    });
    assert.deepEqual(requests, [
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
  });

  it("builds the X authorization request with S256 PKCE", () => {
    const provider = new XOAuthProvider({
      clientId: "x-client",
      redirectUri: "https://hapapay.test/api/oauth/x/callback",
    });
    const url = new URL(provider.authorizationUrl("csrf-state", "a-secure-code-verifier-123456789012345678901234567890"));
    assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
    assert.equal(url.searchParams.get("state"), "csrf-state");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.notEqual(url.searchParams.get("code_challenge"), "a-secure-code-verifier-123456789012345678901234567890");
  });

  it("revalidates the X user after the PKCE code exchange", async () => {
    const provider = new XOAuthProvider(
      {
        clientId: "x-client",
        clientSecret: "x-secret",
        redirectUri: "https://hapapay.test/api/oauth/x/callback",
      },
      async (input) => String(input).includes("oauth2/token")
        ? new Response(JSON.stringify({ access_token: "x-access-token" }), { status: 200 })
        : new Response(JSON.stringify({ data: { id: "7788", username: "bob_on_x" } }), { status: 200 }),
    );

    assert.deepEqual(
      await provider.verifyCallback("short-code", "pkce-code-verifier"),
      { platform: "x", providerUserId: "7788", username: "bob_on_x" },
    );
  });

  it("accepts an authentic, fresh Telegram Login Widget payload", () => {
    const result = verifyTelegramLogin(
      {
        id: "424242",
        first_name: "Deniz",
        username: "deniz",
        auth_date: "1789293600",
        hash: "d452c0bc87c78af0255cec8598463adb0a96895cad6b05fcc7f65506951809d2",
      },
      "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      new Date("2026-09-13T10:01:00.000Z"),
    );
    assert.deepEqual(result, { platform: "telegram", providerUserId: "424242", username: "deniz" });
  });

  it("refuses the same Telegram payload under a token with a stray line break, which the server trims away", () => {
    const payload = { id: "424242", first_name: "Deniz", username: "deniz", auth_date: "1789293600", hash: "d452c0bc87c78af0255cec8598463adb0a96895cad6b05fcc7f65506951809d2" };
    const at = new Date("2026-09-13T10:01:00.000Z");
    assert.throws(() => verifyTelegramLogin(payload, "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11\n", at), TelegramSignatureError);
    assert.equal(verifyTelegramLogin(payload, "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11\n".trim(), at).providerUserId, "424242");
    // Telegram's login window answers with a numeric id; it is stored as text.
    assert.equal(verifyTelegramLogin({ ...payload, id: 424242 as unknown as string }, "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", at).providerUserId, "424242");
  });

  it("asks Telegram whether the bot token is still the bot's, and keeps only a real answer", async () => {
    const asked: string[] = [];
    let answer: number | "offline" = 401;
    let clock = 1_000_000;
    const check = new TelegramBotTokenCheck("123456:revoked-token", async (input) => {
      asked.push(String(input));
      if (answer === "offline") throw new Error("network down");
      return new Response(JSON.stringify({ ok: answer === 200 }), { status: answer });
    }, () => clock);
    assert.equal(await check.refused(), true);
    assert.deepEqual(asked, ["https://api.telegram.org/bot123456:revoked-token/getMe"]);
    // Kept for five minutes, then asked again.
    answer = 200;
    assert.equal(await check.refused(), true);
    assert.equal(asked.length, 1);
    clock += 5 * 60_000 + 1;
    assert.equal(await check.refused(), false);
    // Telegram down or unreachable is no answer: not refused, and not kept.
    clock += 5 * 60_000 + 1;
    answer = 502;
    assert.equal(await check.refused(), false);
    answer = "offline";
    assert.equal(await check.refused(), false);
    answer = 404;
    assert.equal(await check.refused(), true);
    assert.equal(asked.length, 5);
  });

  it("links Discord only after the identify endpoint returns the provider user id", async () => {
    const provider = new DiscordOAuthProvider(
      { clientId: "discord-client", clientSecret: "discord-secret", redirectUri: "https://hapapay.test/api/oauth/discord/callback" },
      async (input) => String(input).includes("oauth2/token")
        ? new Response(JSON.stringify({ access_token: "discord-access" }), { status: 200 })
        : new Response(JSON.stringify({ id: "991122", username: "arc.friend" }), { status: 200 }),
    );
    assert.deepEqual(await provider.verifyCallback("discord-code"), {
      platform: "discord",
      providerUserId: "991122",
      username: "arc.friend",
    });
  });

  it("keeps the discriminator of a Discord account still on the old, shared names", async () => {
    const answering = (user: Record<string, string>) => new DiscordOAuthProvider(
      { clientId: "discord-client", clientSecret: "discord-secret", redirectUri: "https://hapapay.test/api/oauth/discord/callback" },
      async (input) => String(input).includes("oauth2/token") ? Response.json({ access_token: "discord-access" }) : Response.json(user),
    );
    assert.equal((await answering({ id: "991122", username: "ali", discriminator: "0" }).verifyCallback("code")).username, "ali");
    assert.equal((await answering({ id: "991123", username: "ali", discriminator: "4821" }).verifyCallback("code")).username, "ali#4821", "never the name a link to @ali waits for");
  });
});
