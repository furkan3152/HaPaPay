import type { Address } from "viem";
import type { Platform } from "../src/domain/payment-intent";
import type { VerifiedSocialAccount } from "./verified-identity-service";

export type IdentityProfile = {
  wallet: Address;
  accounts: Array<{ platform: Platform; username: string; verified: true }>;
};

export type IdentityStore = {
  link(wallet: string, proof: VerifiedSocialAccount): IdentityProfile | Promise<IdentityProfile>;
  resolve(platform: Platform, username: string): Address | undefined | Promise<Address | undefined>;
  profile(wallet: string): IdentityProfile | Promise<IdentityProfile>;
  account(wallet: string, platform: Platform): VerifiedSocialAccount | undefined | Promise<VerifiedSocialAccount | undefined>;
  unlink(wallet: string, platform: Platform): IdentityProfile | undefined | Promise<IdentityProfile | undefined>;
};
