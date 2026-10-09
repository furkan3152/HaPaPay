import { getAddress, type Address } from "viem";
import type { Platform } from "../src/domain/payment-intent";

export type VerifiedSocialAccount = {
  platform: Platform;
  providerUserId: string;
  username: string;
  verifiedAt: string;
};

type StoredAccount = VerifiedSocialAccount & { wallet: Address };

/** A provider account linked to another wallet. Its message names what is taken ("already linked"). */
export class IdentityConflictError extends Error {}

/**
 * The handle kept for an account whose handle a fresh sign-in proved now belongs to another account: no handle can
 * start with "#", so it resolves to nobody until its owner signs in again, while the account stays linked by its
 * immutable ID (and so can still claim vault links locked to it).
 */
export function releasedHandle(providerUserId: string) {
  return `#${providerUserId}`;
}

function normalizeUsername(username: string) {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export class VerifiedIdentityService {
  private readonly accountOwners = new Map<string, StoredAccount>();
  private readonly handleOwners = new Map<string, Address>();
  private readonly walletAccounts = new Map<Address, Map<string, StoredAccount>>();

  link(inputWallet: string, proof: VerifiedSocialAccount) {
    const wallet = getAddress(inputWallet);
    const accountKey = `${proof.platform}:${proof.providerUserId}`;
    const username = normalizeUsername(proof.username);
    const existing = this.accountOwners.get(accountKey);
    if (existing && existing.wallet !== wallet) {
      throw new IdentityConflictError("This verified provider account is already linked to another wallet.");
    }

    const handleKey = `${proof.platform}:${username}`;
    // A handle another account still holds here changed hands at the provider: this sign-in proves who holds it now,
    // so the earlier account keeps its link under a released handle (audit, 2026-10-06: the new owner was refused as
    // "taken" while payments to the handle kept reaching the earlier account).
    const stale = [...this.accountOwners.values()].find((account) => account.platform === proof.platform && account.username === username && account.providerUserId !== proof.providerUserId);
    if (stale) {
      this.handleOwners.delete(handleKey);
      stale.username = releasedHandle(stale.providerUserId);
      this.handleOwners.set(`${stale.platform}:${stale.username}`, stale.wallet);
    }
    const handleOwner = this.handleOwners.get(handleKey);
    if (handleOwner && handleOwner !== wallet) {
      throw new IdentityConflictError("This social handle is already linked to another wallet.");
    }

    if (existing && existing.username !== username) {
      this.handleOwners.delete(`${proof.platform}:${existing.username}`);
    }

    const stored = { ...proof, username, wallet };
    this.accountOwners.set(accountKey, stored);
    this.handleOwners.set(handleKey, wallet);
    const accounts = this.walletAccounts.get(wallet) ?? new Map<string, StoredAccount>();
    accounts.set(accountKey, stored);
    this.walletAccounts.set(wallet, accounts);
    return this.profile(wallet);
  }

  resolve(platform: Platform, username: string) {
    return this.handleOwners.get(`${platform}:${normalizeUsername(username)}`);
  }

  profile(inputWallet: string) {
    const wallet = getAddress(inputWallet);
    const accounts = [...(this.walletAccounts.get(wallet)?.values() ?? [])].map((account) => ({
      platform: account.platform,
      username: account.username,
      verified: true as const,
    }));
    return { wallet, accounts };
  }

  account(inputWallet: string, platform: Platform) {
    const wallet = getAddress(inputWallet);
    const account = [...(this.walletAccounts.get(wallet)?.values() ?? [])]
      .find((candidate) => candidate.platform === platform);
    if (!account) return undefined;
    return {
      platform: account.platform,
      providerUserId: account.providerUserId,
      username: account.username,
      verifiedAt: account.verifiedAt,
    };
  }

  unlink(inputWallet: string, platform: Platform) {
    const wallet = getAddress(inputWallet);
    const accounts = this.walletAccounts.get(wallet);
    if (!accounts) return undefined;
    const matches = [...accounts.entries()].filter(([, account]) => account.platform === platform);
    if (!matches.length) return undefined;
    for (const [accountKey, account] of matches) {
      accounts.delete(accountKey);
      this.accountOwners.delete(accountKey);
      const handleKey = `${account.platform}:${account.username}`;
      if (this.handleOwners.get(handleKey) === wallet) this.handleOwners.delete(handleKey);
    }
    if (!accounts.size) this.walletAccounts.delete(wallet);
    return this.profile(wallet);
  }
}
