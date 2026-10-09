import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The provider refused this site's own OAuth settings (its client ID, secret or callback URL), not the person signing
 * in. Every sign-in fails until the operator fixes the provider app or the server variables.
 */
export class ProviderSetupError extends Error {}
/**
 * The provider signed the person in but refused this site's own read of who they are: X answers that with 401, 402 or
 * 403 when the site's X app has lost its access or its developer account has no credits left. Every X link fails
 * until the operator restores it, so it is not the person's to retry.
 */
export class ProviderAccessError extends Error {}

export class GitHubOAuthProvider {
  constructor(
    private readonly config: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly request: ProviderFetch = fetch,
  ) {}

  authorizationUrl(state: string) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async verifyCallback(code: string) {
    const tokenResponse = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      }),
    });
    if (!tokenResponse.ok) throw new Error("GitHub token exchange failed.");
    const tokenBody = await tokenResponse.json() as { access_token?: string; error?: string; error_description?: string };
    if (tokenBody.error === "incorrect_client_credentials" || tokenBody.error === "redirect_uri_mismatch") {
      throw new ProviderSetupError(`GitHub refused this site's OAuth settings (${tokenBody.error}).`);
    }
    if (!tokenBody.access_token) throw new Error(tokenBody.error_description ?? "GitHub returned no access token.");

    const userResponse = await this.request("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenBody.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!userResponse.ok) throw new Error("GitHub identity lookup failed.");
    const user = await userResponse.json() as { id?: number; login?: string };
    if (!user.id || !user.login) throw new Error("GitHub returned an incomplete identity.");
    return { platform: "github" as const, providerUserId: String(user.id), username: user.login };
  }
}

export class XOAuthProvider {
  constructor(
    private readonly config: { clientId: string; clientSecret?: string; redirectUri: string },
    private readonly request: ProviderFetch = fetch,
  ) {}

  authorizationUrl(state: string, codeVerifier: string) {
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", "tweet.read users.read");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async verifyCallback(code: string, codeVerifier: string) {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (this.config.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`;
    }
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });
    const tokenResponse = await this.request("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers,
      body,
    });
    if (tokenResponse.status === 401) throw new ProviderSetupError("X refused this site's OAuth client.");
    if (!tokenResponse.ok) throw new Error("X token exchange failed.");
    const tokenBody = await tokenResponse.json() as { access_token?: string };
    if (!tokenBody.access_token) throw new Error("X returned no access token.");

    const userResponse = await this.request("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (userResponse.status === 401 || userResponse.status === 402 || userResponse.status === 403) {
      console.warn(`X refused to read a signed-in account (HTTP ${userResponse.status}); X links fail until the X developer account's access or credits are restored.`);
      throw new ProviderAccessError("X refused this site's read of the signed-in account.");
    }
    if (!userResponse.ok) throw new Error("X identity lookup failed.");
    const userBody = await userResponse.json() as { data?: { id?: string; username?: string } };
    if (!userBody.data?.id || !userBody.data.username) throw new Error("X returned an incomplete identity.");
    return { platform: "x" as const, providerUserId: userBody.data.id, username: userBody.data.username };
  }
}

export class DiscordOAuthProvider {
  constructor(
    private readonly config: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly request: ProviderFetch = fetch,
  ) {}

  authorizationUrl(state: string) {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async verifyCallback(code: string) {
    const tokenResponse = await this.request("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
      }),
    });
    if (tokenResponse.status === 401) throw new ProviderSetupError("Discord refused this site's OAuth client.");
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed.");
    const tokenBody = await tokenResponse.json() as { access_token?: string };
    if (!tokenBody.access_token) throw new Error("Discord returned no access token.");
    const userResponse = await this.request("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (!userResponse.ok) throw new Error("Discord identity lookup failed.");
    const user = await userResponse.json() as { id?: string; username?: string; discriminator?: string };
    if (!user.id || !user.username) throw new Error("Discord returned an incomplete identity.");
    // An account still on Discord's old names (a discriminator other than "0") shares its name with others, so it keeps
    // the discriminator: it is never taken for the unique name a payment or a vault link waits for (2026-10-06).
    const legacy = user.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : "";
    return { platform: "discord" as const, providerUserId: user.id, username: `${user.username}${legacy}` };
  }
}

export type TelegramLoginPayload = {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
};

/** Telegram's hash does not match the login data under this site's bot token. */
export class TelegramSignatureError extends Error {}
/** Telegram's login data that cannot link: too old, or an account without a public username. Answered as 401. */
export class TelegramLoginError extends Error {}

export function verifyTelegramLogin(payload: TelegramLoginPayload, botToken: string, now = new Date()) {
  const { hash, ...fields } = payload;
  const dataCheckString = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const receivedBuffer = Buffer.from(typeof hash === "string" ? hash : "", "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw new TelegramSignatureError("Telegram signature is invalid.");
  }

  const authenticatedAt = Number(payload.auth_date) * 1000;
  const age = now.getTime() - authenticatedAt;
  if (!Number.isFinite(authenticatedAt) || age < -60_000 || age > 10 * 60_000) {
    throw new TelegramLoginError("Telegram authentication is stale.");
  }
  if (!payload.username) throw new TelegramLoginError("Telegram account must have a public username.");
  // Telegram's login window answers with numbers for id and auth_date; the stored provider ID is text.
  return { platform: "telegram" as const, providerUserId: String(payload.id), username: payload.username };
}

/**
 * Asks Telegram (`getMe`) whether this site's bot token is still the bot's token. A revoked or mistyped token makes
 * every Telegram signature fail while the bot ID still opens the right login window, so a signature that does not match
 * is checked here once. The answer is kept for five minutes; no answer (network) counts as accepted. The token goes
 * only to api.telegram.org and is never logged.
 */
export class TelegramBotTokenCheck {
  private answer?: { refused: boolean; until: number };

  constructor(
    private readonly botToken: string,
    private readonly request: ProviderFetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async refused() {
    if (this.answer && this.answer.until > this.now()) return this.answer.refused;
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.botToken}/getMe`);
      if (!response.ok && response.status !== 401 && response.status !== 404) return false;
      this.answer = { refused: !response.ok, until: this.now() + 5 * 60_000 };
      return this.answer.refused;
    } catch {
      return false;
    }
  }
}
