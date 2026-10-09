import { platformName, type Platform } from "../src/domain/payment-intent.js";
import { isStockClaimPlatform, type StockClaimPlatform } from "../src/domain/stock-claims.js";
import { claimsLink, isLockableName, lockIdsOf, locksOnlyToName, locksToName, nameLockId, tellsAccountAge, type VaultLock } from "../src/domain/vault-lock.js";
import { RecipientLookupUnavailableError, type DiscoveredRecipient } from "./recipient-discovery.js";
import type { VerifiedSocialAccount } from "./verified-identity-service";

export type VaultRecipientDirectory = { lookup(platform: Platform, username: string): Promise<DiscoveredRecipient> };

/** Who a vault link waits for: the account behind the handle, or the handle's name where no account can be looked up. */
export type VaultRecipient = { platform: StockClaimPlatform; username: string; providerUserId: string; lock: VaultLock };

/**
 * X did not answer the lookup that would lock a link to an account. The link can wait for the X name instead, which
 * the slip offers the sender before anything is signed (`409` with `lock: "name"`).
 */
export class VaultNameLockOffer extends Error {
  readonly lock = "name" as const;
  constructor(username: string) {
    super(`X is not answering account lookups for HaPaPay right now, so this link cannot be locked to @${username}'s X account. You can lock it to the X name @${username} instead: whoever connects X to HaPaPay with that name claims it, with an account older than the link.`);
    this.name = "VaultNameLockOffer";
  }
}

/**
 * The account or name a vault link waits for (`vault-lock.ts`). Discord and Telegram links wait for the name. An X
 * link waits for the name when the sender's review says so (`lock: "name"`), and for the account otherwise; when X
 * does not answer that lookup, `VaultNameLockOffer` asks the sender instead of failing. GitHub and Farcaster links wait
 * for the account. A handle the platform does not know, or one it cannot have, throws the directory's plain Error,
 * which the services turn into the sender's to fix.
 */
export async function vaultRecipient(directory: VaultRecipientDirectory, platform: StockClaimPlatform, username: string, lock?: VaultLock): Promise<VaultRecipient> {
  const handle = username.trim().replace(/^@/, "").toLowerCase();
  if (locksOnlyToName(platform) || (platform === "x" && lock === "name")) {
    if (!isLockableName(platform, handle)) throw new Error(`Invalid ${platformName(platform)} username.`);
    return { platform, username: handle, providerUserId: nameLockId(handle), lock: "name" };
  }
  try {
    const found = await directory.lookup(platform, handle);
    return { platform: found.platform, username: found.username, providerUserId: found.providerUserId, lock: "account" };
  } catch (error) {
    if (platform === "x" && error instanceof RecipientLookupUnavailableError) throw new VaultNameLockOffer(handle);
    throw error;
  }
}

/**
 * When a link was made, for the age check of a name lock: the time its funding was recorded, or, for a link this
 * server never recorded, the earliest it can have been made (its expiry less the longest window).
 */
export function linkMadeAt(record: { confirmedAt?: string } | undefined, expirySeconds: bigint, maxWindowSeconds: number) {
  const recorded = record?.confirmedAt ? Date.parse(record.confirmedAt) : Number.NaN;
  return Number.isFinite(recorded) ? recorded : (Number(expirySeconds) - maxWindowSeconds) * 1000;
}

/**
 * Whether one of these verified accounts is the one a link waits for (`claimsLink`): its account ID, or on Discord,
 * Telegram and X its name, confirmed by the platform after the link was made and held by an account older than it.
 */
export function anyClaimsLink(accounts: readonly VerifiedSocialAccount[], key: string, keyFor: (platform: StockClaimPlatform, lockId: string) => string, madeAtMs: number) {
  return accounts.some((account) => isVaultAccount(account) && claimsLink(account, key, keyFor, madeAtMs));
}

/** Every identity key an account's links can carry: its account's, and its name's where links wait for names. */
export function identityKeysOf(account: VerifiedSocialAccount, keyFor: (platform: StockClaimPlatform, lockId: string) => string) {
  return isVaultAccount(account) ? lockIdsOf(account).map((id) => keyFor(account.platform, id).toLowerCase()) : [];
}

export function isVaultAccount(account: VerifiedSocialAccount): account is VerifiedSocialAccount & { platform: StockClaimPlatform } {
  return isStockClaimPlatform(account.platform);
}

/** How a link's lock reads for its page: waiting for the name when its identity key is the name's. */
export function lockOfLink(recipient: { platform: StockClaimPlatform; username: string }, key: string, keyFor: (platform: StockClaimPlatform, lockId: string) => string): VaultLock {
  return locksToName(recipient.platform) && keyFor(recipient.platform, nameLockId(recipient.username)).toLowerCase() === key.toLowerCase() ? "name" : "account";
}

/**
 * Why a session cannot claim a link waiting for a name (`mayClaimByName`): none of its accounts on that platform had
 * the name when the platform last confirmed it after the link was made, or the one that has it was made after the
 * link.
 */
export function notTheNameHolder(platform: StockClaimPlatform, username: string) {
  const name = platformName(platform);
  const age = tellsAccountAge(platform) ? "; an account made after the link cannot claim it" : "";
  return `This link waits for the ${name} name @${username}. Connect ${name} to HaPaPay with the account that has that name now (connect it again if it is connected already)${age}.`;
}
