import type { Platform } from "../src/domain/payment-intent";
import type { TransientStateStore } from "./transient-state-store.js";

export type DiscoveredRecipient = {
  platform: "github" | "x" | "farcaster";
  providerUserId: string;
  username: string;
};

/** Farcaster's official fname registry (https://docs.farcaster.xyz/reference/fname/api). */
export const FARCASTER_FNAME_REGISTRY_URL = "https://fnames.farcaster.xyz";

/** How long the chat keeps a directory's answer, so a request typed again does not spend GitHub's hourly quota again. */
const EXISTS_TTL_MS = 5 * 60_000;
const EXISTS_MAX_ENTRIES = 500;
/**
 * The directories the chat asks about a handle anyone can type: GitHub's and Farcaster's cost nothing. X's lookups
 * count against the operator's X API plan, so only a payment's preparation asks X.
 */
const ASKED_FROM_THE_CHAT = new Set<Platform>(["github", "farcaster"]);
/**
 * The handles each vault platform can have, so one that can never exist is answered without asking anyone (audit,
 * 2026-10-06: a 42-character wallet address was offered a vault link as an X handle). X: 1 to 15 letters, digits or
 * "_". GitHub: up to 39 letters, digits, "-" or "_" (managed accounts), not starting with "-". Farcaster: an fname.
 */
const HANDLE_FORMS: Partial<Record<Platform, RegExp>> = {
  x: /^[a-z0-9_]{1,15}$/,
  github: /^[a-z0-9_][a-z0-9_-]{0,38}$/,
  farcaster: /^[a-z0-9][a-z0-9-]{0,15}$/,
};

/** How long a platform that refused this server's lookups (401, 402 or 403) is not asked again, nor offered a vault link. */
const REFUSED_PAUSE_MS = 10 * 60_000;
/** The platforms whose lookups use this server's own key, so they can refuse it: GitHub (when a token is set) and X. */
const KEYED_LOOKUPS = new Set<Platform>(["github", "x"]);
/** How long one lookup may take before the sender is told to try again, instead of a button that keeps waiting. */
const LOOKUP_TIMEOUT_MS = 8_000;

/**
 * Whether the platform's directory knows the handle: `true`, `false` (no such account, or a handle it cannot have),
 * `"unavailable"` when the platform cannot be asked (it refuses this server's lookups for now, or this server has no
 * key for it), or undefined when it is not asked.
 */
export type RecipientExistence = boolean | "unavailable" | undefined;

/**
 * A lookup the platform refused or limited, worded for the person sending: nothing about the handle, so the sender
 * cannot fix it by spelling it again, and the vault slip's button never seems to do nothing.
 */
export class RecipientLookupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientLookupUnavailableError";
  }
}

const PLATFORM_LABELS: Partial<Record<Platform, string>> = { github: "GitHub", x: "X", farcaster: "Farcaster" };

export class OfficialRecipientDirectory {
  private readonly fetch: typeof globalThis.fetch;
  private readonly known = new Map<string, { exists: boolean; until: number }>();
  private readonly refusedUntil = new Map<Platform, number>();

  constructor(private readonly options: {
    githubToken?: string;
    xBearerToken?: string;
    fetch?: typeof globalThis.fetch;
    /** Shared by every server instance, so one refusal pauses the platform everywhere. */
    stateStore?: TransientStateStore;
    now?: () => number;
  } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Whether the platform refused this server's lookups in the last ten minutes, here or on another instance. */
  async refused(platform: Platform) {
    const now = this.now();
    if ((this.refusedUntil.get(platform) ?? 0) > now) return true;
    const shared = await this.options.stateStore?.get<{ until: number }>("directory-refused", platform).catch(() => undefined);
    if (!shared || shared.until <= now) return false;
    this.refusedUntil.set(platform, shared.until);
    return true;
  }

  private async refuse(platform: Platform, status: number): Promise<never> {
    const until = this.now() + REFUSED_PAUSE_MS;
    this.refusedUntil.set(platform, until);
    await this.options.stateStore?.put("directory-refused", platform, { until, status }, until).catch(() => undefined);
    // The operator reads this in the server's logs: a 401 is the key, a 402 the X account's credits, a 403 its access.
    console.warn(`${PLATFORM_LABELS[platform] ?? platform} refused a user lookup (HTTP ${status}); its vault links pause for ten minutes.`);
    throw new RecipientLookupUnavailableError(refusedMessage(platform));
  }

  /** The platform's answer, or a fixed message when it cannot be reached at all or does not answer in time. */
  private async ask(platform: Platform, url: string, init: RequestInit) {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    } catch {
      throw new RecipientLookupUnavailableError(`${PLATFORM_LABELS[platform] ?? platform} could not be reached just now. Try again in a moment.`);
    }
  }

  /** The answer's JSON body, or a fixed message when it is cut off or is not JSON (a proxy's page, for one). */
  private async read<T>(platform: Platform, response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new RecipientLookupUnavailableError(`${PLATFORM_LABELS[platform] ?? platform} could not look the account up just now. Try again in a moment.`);
    }
  }

  /** Whether this server can resolve a handle on the platform to its immutable account ID. */
  supports(platform: Platform) {
    return platform === "github" || platform === "farcaster" || (platform === "x" && Boolean(this.options.xBearerToken));
  }

  /**
   * Whether the platform knows the handle: false only when its directory says the account does not exist (or the
   * handle cannot be one), undefined when it is not asked (X, Telegram, Discord) or cannot answer (a rate limit, an
   * outage).
   */
  async exists(platform: Platform, username: string, now = Date.now()): Promise<RecipientExistence> {
    const handle = username.trim().replace(/^@/, "").toLowerCase();
    if (HANDLE_FORMS[platform] && !HANDLE_FORMS[platform].test(handle)) return false;
    // X without its key, or a platform that refused this server's lookups until the pause ends, cannot be asked: its
    // vault links wait for the name instead (2026-10-06).
    if (platform === "x" && !this.supports("x")) return "unavailable";
    if (this.supports(platform) && KEYED_LOOKUPS.has(platform) && await this.refused(platform)) return "unavailable";
    if (!this.supports(platform) || !ASKED_FROM_THE_CHAT.has(platform)) return undefined;
    const key = `${platform}:${handle}`;
    const kept = this.known.get(key);
    if (kept && kept.until > now) return kept.exists;
    let exists: boolean | undefined;
    try {
      await this.lookup(platform, username);
      exists = true;
    } catch (error) {
      if (error instanceof RecipientLookupUnavailableError && await this.refused(platform)) return "unavailable";
      exists = /was not found\.$|^Invalid (?:social|X|Farcaster) username/.test(error instanceof Error ? error.message : "") ? false : undefined;
    }
    // Only answers are kept; a refusal or an outage is asked again next time. Payments never read this: preparing one
    // looks the account up again.
    if (exists !== undefined) {
      this.known.delete(key);
      if (this.known.size >= EXISTS_MAX_ENTRIES) this.known.delete(this.known.keys().next().value!);
      this.known.set(key, { exists, until: now + EXISTS_TTL_MS });
    }
    return exists;
  }

  async lookup(platform: Platform, inputUsername: string): Promise<DiscoveredRecipient> {
    const username = inputUsername.trim().replace(/^@/, "").toLowerCase();
    if (!username || username.length > 64) throw new Error("Invalid social username.");
    if (platform === "github") return this.lookupGitHub(username);
    if (platform === "x") return this.lookupX(username);
    if (platform === "farcaster") return this.lookupFarcaster(username);
    throw new Error("Invite this person to link their account first; this platform does not support official non-user lookup.");
  }

  private async lookupGitHub(username: string): Promise<DiscoveredRecipient> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "HaPaPay",
    };
    if (this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
    if (await this.refused("github")) throw new RecipientLookupUnavailableError(refusedMessage("github"));
    const response = await this.ask("github", `https://api.github.com/users/${encodeURIComponent(username)}`, { headers });
    if (response.status === 404) throw new Error("GitHub account was not found.");
    // A user lookup needs no key: only a bad configured token is refused (401). Without one GitHub allows 60 lookups
    // an hour and answers the rest, and its secondary limits, with 403 or 429.
    if (response.status === 401) return this.refuse("github", response.status);
    if (response.status === 403 || response.status === 429) {
      throw new RecipientLookupUnavailableError("GitHub is limiting account lookups right now. Try again in a few minutes.");
    }
    if (!response.ok) throw new RecipientLookupUnavailableError("GitHub could not look the account up just now. Try again in a moment.");
    const user = await this.read<{ id?: number; login?: string; type?: string }>("github", response);
    if (!Number.isSafeInteger(user.id) || !user.login || (user.type && user.type !== "User")) throw new Error("GitHub returned an invalid user identity.");
    return { platform: "github", providerUserId: String(user.id), username: user.login.toLowerCase() };
  }

  private async lookupX(username: string): Promise<DiscoveredRecipient> {
    if (!this.options.xBearerToken) throw new RecipientLookupUnavailableError("This server cannot look up X accounts, so the money cannot wait in the vault for an X account. Ask them to join HaPaPay and link X so you can pay them directly.");
    if (!/^[a-z0-9_]{1,15}$/i.test(username)) throw new Error("Invalid X username.");
    if (await this.refused("x")) throw new RecipientLookupUnavailableError(refusedMessage("x"));
    const response = await this.ask("x", `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`, {
      headers: { Authorization: `Bearer ${this.options.xBearerToken}` },
    });
    if (response.status === 404) throw new Error("X account was not found.");
    // 401: the key is wrong; 402: the X developer account has no credits left; 403: the key's access excludes lookups.
    if (response.status === 401 || response.status === 402 || response.status === 403) return this.refuse("x", response.status);
    if (response.status === 429) throw new RecipientLookupUnavailableError("X is limiting account lookups right now. Try again in a few minutes.");
    if (!response.ok) throw new RecipientLookupUnavailableError("X could not look the account up just now. Try again in a moment.");
    const body = await this.read<{ data?: { id?: string; username?: string }; errors?: Array<{ title?: string; resource_type?: string }> }>("x", response);
    // X answers a username nobody holds with 200 and a "Not Found Error" for the user, not with a 404.
    if (!body.data && body.errors?.some((error) => error.title === "Not Found Error" && error.resource_type === "user")) throw new Error("X account was not found.");
    if (!body.data?.id || !body.data.username) throw new Error("X returned an invalid user identity.");
    return { platform: "x", providerUserId: body.data.id, username: body.data.username.toLowerCase() };
  }

  /**
   * An fname resolves to the FID it currently belongs to: the `to` field of its latest transfer in the fname
   * registry. FIDs never change hands, so a payment locked to one stays with that account even if the name moves.
   */
  private async lookupFarcaster(username: string): Promise<DiscoveredRecipient> {
    if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(username)) {
      throw new Error(username.endsWith(".eth")
        ? "Invalid Farcaster username: .eth names are ENS names. Use the account's Farcaster name instead."
        : "Invalid Farcaster username.");
    }
    const response = await this.ask("farcaster", `${FARCASTER_FNAME_REGISTRY_URL}/transfers/current?name=${encodeURIComponent(username)}`, {
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) throw new Error("Farcaster account was not found.");
    if (!response.ok) throw new RecipientLookupUnavailableError("Farcaster could not look the name up just now. Try again in a moment.");
    const body = await this.read<{ transfer?: { username?: string; to?: number } }>("farcaster", response);
    const fid = body.transfer?.to;
    // Unregistering an fname is a transfer to FID 0.
    if (fid === 0) throw new Error("Farcaster account was not found.");
    if (typeof fid !== "number" || !Number.isSafeInteger(fid) || fid < 0 || body.transfer?.username?.toLowerCase() !== username) {
      throw new Error("Farcaster returned an invalid user identity.");
    }
    return { platform: "farcaster", providerUserId: String(fid), username };
  }
}

/** What the sender reads while a platform refuses this server's lookups. */
function refusedMessage(platform: Platform) {
  const name = PLATFORM_LABELS[platform] ?? platform;
  return `${name} is not answering account lookups for HaPaPay right now, so the money cannot be locked to ${name === "X" ? "an" : "a"} ${name} account in the vault. Try again later, or ask them to join HaPaPay and link ${name} so you can pay them directly.`;
}
