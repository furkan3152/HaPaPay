import type { Platform } from "./payment-intent.js";

/**
 * Who a vault link waits for. GitHub, X and Farcaster accounts are looked up before they join, so a link to them is locked
 * to the account's immutable ID ("account"). Discord and Telegram cannot be looked up by name, and X answers lookups
 * only while its API serves this site, so a link to them is locked to the name the person has there ("name"): whoever
 * connects that platform to HaPaPay with that name after the link was made, through its official sign-in, claims
 * it, as long as their account is older than the link where the platform says when an account was made (X and
 * Discord).
 */
export type VaultLock = "account" | "name";

/**
 * What a name lock stands in for an account ID with. Every platform's account IDs are digits, so no account ID can
 * be mistaken for a name.
 */
const NAME_LOCK_PREFIX = "name:";

/** The lock ID of a link locked to a name: "name:" and the handle in lower case, without its "@". */
export function nameLockId(username: string) {
  return `${NAME_LOCK_PREFIX}${username.trim().replace(/^@/, "").toLowerCase()}`;
}

export function isNameLockId(providerUserId: string) {
  return providerUserId.startsWith(NAME_LOCK_PREFIX);
}

/** Platforms that never look an account up before it joins: a link to them always waits for the name. */
export function locksOnlyToName(platform: string): platform is "discord" | "telegram" {
  return platform === "discord" || platform === "telegram";
}

/** Platforms whose links may wait for a name: Discord and Telegram always, X while it does not answer lookups. */
export function locksToName(platform: string): platform is "discord" | "telegram" | "x" {
  return locksOnlyToName(platform) || platform === "x";
}

/**
 * The names each platform allows, so a link never waits for a name nobody can have. X: 1 to 15 letters, digits or
 * "_". Discord (since its 2023 usernames): 2 to 32 lower-case letters, digits, "_" or ".", never "..". Telegram: 4
 * to 32 letters, digits or "_", starting with a letter (5 for most names; 4 for collectible ones).
 */
const NAME_FORMS: Partial<Record<Platform, RegExp>> = {
  x: /^[a-z0-9_]{1,15}$/,
  discord: /^(?!.*\.\.)[a-z0-9_.]{2,32}$/,
  telegram: /^[a-z][a-z0-9_]{3,31}$/,
};

export function isLockableName(platform: Platform, username: string) {
  return NAME_FORMS[platform]?.test(username.trim().replace(/^@/, "").toLowerCase()) ?? false;
}

/** Discord's and X's ID epochs: their IDs are snowflakes whose top bits are milliseconds since these. */
const DISCORD_EPOCH = 1_420_070_400_000n;
const X_EPOCH = 1_288_834_974_657n;
/**
 * X gave accounts sequential 32-bit IDs until about 2013 and snowflakes after that, so an ID below 2^32 belongs to an
 * account older than any link.
 */
const X_FIRST_SNOWFLAKE = 1n << 32n;

/**
 * When an account was made, read from its ID where the platform's IDs carry it (Discord and X snowflakes), in
 * milliseconds; undefined where they do not (Telegram).
 */
export function accountCreatedAt(platform: string, providerUserId: string): number | undefined {
  if (!/^\d{1,20}$/.test(providerUserId)) return undefined;
  const id = BigInt(providerUserId);
  if (platform === "discord") return Number((id >> 22n) + DISCORD_EPOCH);
  if (platform === "x") return id < X_FIRST_SNOWFLAKE ? 0 : Number((id >> 22n) + X_EPOCH);
  return undefined;
}

/** Platforms whose account IDs tell when the account was made, so a name lock also checks its age. */
export function tellsAccountAge(platform: string) {
  return platform === "discord" || platform === "x";
}

/**
 * Whether a verified account may claim a link waiting for its name. The platform confirmed the name when the account
 * was connected, after the link was made, so a name kept from an earlier sign-in (its holder may have renamed since)
 * never claims; and where the platform tells when an account was made, it was made before the link, so nobody can
 * open a new account with a name a link waits for and take it.
 */
export function mayClaimByName(account: { platform: string; providerUserId: string; verifiedAt: string }, linkMadeAtMs: number) {
  const verified = Date.parse(account.verifiedAt);
  if (!Number.isFinite(verified) || verified < linkMadeAtMs) return false;
  const created = accountCreatedAt(account.platform, account.providerUserId);
  return created === undefined || created < linkMadeAtMs;
}

/**
 * Every lock ID this account can claim with: its account ID, and on Discord, Telegram and X its name as well. The
 * name still has to pass `mayClaimByName` for the link at hand.
 */
export function lockIdsOf(account: { platform: string; providerUserId: string; username: string }) {
  return locksToName(account.platform) ? [account.providerUserId, nameLockId(account.username)] : [account.providerUserId];
}

/**
 * Whether this verified account is the one a link waits for. `keyFor` derives a link's identity key from a platform
 * and a lock ID the way that network's vault does; a link locked to a name also needs `mayClaimByName` for the time
 * the link was made (`linkMadeAtMs`).
 */
export function claimsLink<A extends { platform: string; providerUserId: string; username: string; verifiedAt: string }>(
  account: A,
  key: string,
  keyFor: (platform: A["platform"], lockId: string) => string,
  linkMadeAtMs: number,
) {
  const wanted = key.toLowerCase();
  if (keyFor(account.platform, account.providerUserId).toLowerCase() === wanted) return true;
  return locksToName(account.platform)
    && keyFor(account.platform, nameLockId(account.username)).toLowerCase() === wanted
    && mayClaimByName(account, linkMadeAtMs);
}

/** How a name lock reads on slips and claim pages: "the Discord name @ali". */
export function nameLockLabel(platformName: string, username: string) {
  return `the ${platformName} name @${username.trim().replace(/^@/, "").toLowerCase()}`;
}
