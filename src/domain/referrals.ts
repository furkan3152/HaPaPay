/**
 * Invites: every account has an invite code; an account that joins with it earns its
 * inviter a share of its SP and a share of each payment it sends, which HaPaPay pays in USDC on Solana from its
 * fee. Shared by the server, which keeps the records, and the pages, which show the link. A payout's Solana
 * transaction is built and checked in `referral-payout.ts`, so the desk's first chunk carries no Solana library.
 */

/** Eight letters and digits that cannot be misread: no 0, O, 1, I or L. */
export const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REFERRAL_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
/** The query parameter an invite link carries: `https://hapapay.example/app?ref=K7Q2M9XA`. */
export const REFERRAL_PARAM = "ref";

/** A code as typed or linked (any case, spaces around it), or undefined when it cannot be one. */
export function referralCode(input: unknown) {
  if (typeof input !== "string") return undefined;
  const code = input.trim().toUpperCase();
  return REFERRAL_CODE_PATTERN.test(code) ? code : undefined;
}

export const referralLink = (origin: string, code: string) => `${origin.replace(/\/+$/, "")}/app?${REFERRAL_PARAM}=${code}`;

/** What joining with a code did: joined, or why not. */
export type ReferralJoinStatus = "joined" | "already" | "self" | "unknown" | "not_new" | "cycle";

/** USDC base units (6 decimals) as dollars, cents always shown and smaller digits only when there are some: $12.50, $0.125. */
export function formatUsdc(units: bigint | string) {
  const value = BigInt(units);
  const size = value < 0n ? -value : value;
  const fraction = (size % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${value < 0n ? "-" : ""}$${(size / 1_000_000n).toLocaleString("en-US")}.${fraction}`;
}

/** A payout goes to someone owed at least a dollar, so a transaction's network fee and rent never outweigh it. */
export const REFERRAL_PAYOUT_MINIMUM_UNITS = 1_000_000n;
/** At most this many people per payout transaction, which keeps it well inside Solana's size limit. */
export const REFERRAL_PAYOUT_MAX_ITEMS = 8;
/** A payout batch's ID: 16 hex digits, in its memo so the chain ties the transaction to the batch. */
export const REFERRAL_BATCH_PATTERN = /^[0-9a-f]{16}$/;
export const referralPayoutMemo = (batch: string) => `HaPaPay invite rewards ${batch}`;
