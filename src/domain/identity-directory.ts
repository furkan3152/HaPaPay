import type { Platform } from "./payment-intent";

type SocialAccount = { platform: Platform; username: string };
type Address = `0x${string}`;

function identityKey(platform: Platform, username: string) {
  return `${platform}:${username.trim().replace(/^@/, "").toLowerCase()}`;
}

export class IdentityDirectory {
  private readonly owners = new Map<string, Address>();
  private readonly profiles = new Map<Address, SocialAccount[]>();

  link(wallet: Address, accounts: SocialAccount[]) {
    for (const account of accounts) {
      const currentOwner = this.owners.get(identityKey(account.platform, account.username));
      if (currentOwner && currentOwner !== wallet) {
        throw new Error("Social identity is already linked to another wallet.");
      }
    }

    const normalized = accounts.map((account) => ({
      ...account,
      username: account.username.trim().replace(/^@/, "").toLowerCase(),
    }));
    normalized.forEach((account) => this.owners.set(identityKey(account.platform, account.username), wallet));
    this.profiles.set(wallet, normalized);
  }

  resolve(platform: Platform, username: string) {
    return this.owners.get(identityKey(platform, username));
  }

  profile(wallet: Address) {
    return { wallet, accounts: this.profiles.get(wallet) ?? [] };
  }
}
