/**
 * SP, HaPaPay's points: earned by payments and vault links confirmed through HaPaPay on
 * any network, with one balance per account (the EVM wallet a session signs with). SP have no cash value and cannot be
 * bought, sold or sent; the operator sets these rules from the admin panel, and each change is a new version. Shared by
 * the server, which awards SP, and the pages, which explain how to earn them.
 *
 * SP count in tenths: every amount in the ledger, every bonus and
 * the daily cap is a whole number of tenths, such as 12.5 SP.
 */

export type SpNetwork = "solana" | "arc" | "robinhood";
export type SpAssetClass = "stable" | "crypto" | "stock";

export type SpRules = {
  /** Earning on or off for everyone. */
  earning: boolean;
  /** SP for each US dollar a payment or a claimed vault link moves, for its sender. */
  perDollar: number;
  /** SP for each payment worth at least `minUsd`, on top of the dollars. */
  perPayment: number;
  /** SP for each US dollar a vault link brings the person who claims it. */
  claimPerDollar: number;
  /** A payment or a claim below this many US dollars earns nothing. */
  minUsd: number;
  /** At most this much SP a day (UTC) from payments and claims, per account. Bonuses do not count. */
  dailyCap: number;
  /** At most this many payments a day (UTC) from one account to the same person earn SP. */
  pairDailyLimit: number;
  networks: Record<SpNetwork, number>;
  assets: Record<SpAssetClass, number>;
  bonuses: {
    /** The account's first payment that earns SP. */
    firstPayment: number;
    /** Each social account linked, once per account and platform, and once ever per provider account. */
    linkedAccount: number;
    /** Adding a Solana address, once per account and once ever per address. */
    solanaAddress: number;
    /** The first vault link an account claims. */
    firstClaim: number;
    /** For the sender, when a vault link they sent is claimed. */
    inviteClaimed: number;
  };
  /** At most this many invite bonuses a month (UTC) per account. */
  inviteMonthlyLimit: number;
  /** A time-boxed multiplier on payments and claims, such as a weekend at 2x. */
  boost: { multiplier: number; startsAt: string; endsAt: string } | null;
  /**
   * Invites: an account that joined with someone's invite link earns that person a share of its SP,
   * and a share of the fee HaPaPay verified on each payment it sends, paid in USDC.
   */
  referral: {
    /** The share of the SP an invited account earns that its inviter earns too (0.15 is 15%). */
    pointsShare: number;
    /**
     * The inviter's share, in USDC, of the 1% fee HaPaPay verified on each payment an invited account sends: basis
     * points of the payment out of the fee's 100, so also the percent of the fee (50 is half the fee, 0.5% of the payment).
     */
    feeShareBps: number;
    /** At most this much SP a day (UTC) from invites, per inviter. */
    dailyCap: number;
  };
};

/**
 * The starting balance: a dollar sent earns 1 SP and a payment earns nothing for itself, so a 25 USDC payment earns 25 SP on every
 * network and asset, and splitting it into small payments earns no more. Bonuses are small and once only. The 1% fee
 * makes SP cost money to farm (a dollar of fees for each 100 SP), and the daily cap and the per-person limit stop the
 * rest: sending back and forth between two accounts earns at most 3 payments a day each way, and nobody earns more than
 * 1,000 SP a day from payments and claims.
 */
export const DEFAULT_SP_RULES: SpRules = {
  earning: true,
  perDollar: 1,
  perPayment: 0,
  claimPerDollar: 0.5,
  minUsd: 1,
  dailyCap: 1_000,
  pairDailyLimit: 3,
  networks: { solana: 1, arc: 1, robinhood: 1 },
  assets: { stable: 1, crypto: 1, stock: 1 },
  bonuses: { firstPayment: 10, linkedAccount: 2, solanaAddress: 2, firstClaim: 5, inviteClaimed: 5 },
  inviteMonthlyLimit: 10,
  boost: null,
  referral: { pointsShare: 0.15, feeShareBps: 50, dailyCap: 500 },
};

/** The fee share can never pass HaPaPay's own 1% fee, so an invite can never pay more than its payments cost. */
export const REFERRAL_MAX_FEE_SHARE_BPS = 100;

/** The most an admin can add or take in one adjustment. */
export const SP_ADJUST_LIMIT = 10_000_000;

const BOUNDS = {
  perDollar: [0, 100],
  perPayment: [0, 1_000],
  claimPerDollar: [0, 100],
  minUsd: [0, 100_000],
  dailyCap: [0, 1_000_000],
  pairDailyLimit: [0, 1_000],
  multiplier: [0, 10],
  bonus: [0, 10_000],
  inviteMonthlyLimit: [0, 10_000],
} as const;
const MAX_BOOST_DAYS = 31;

const within = (value: unknown, [low, high]: readonly [number, number]): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A number of SP with at most one decimal: 12.5, not 12.55. */
export function isTenths(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value * 10 - Math.round(value * 10)) < 1e-6;
}

/** A sum or difference of SP back on its tenth (0.1 + 0.2 is 0.3), and never -0. */
export function roundSp(value: number) {
  const tenths = Math.round(value * 10);
  return tenths === 0 ? 0 : tenths / 10;
}

/** Rules as an admin sent them, checked field by field; anything out of range is refused with the field's name. */
export function validateSpRules(input: unknown): { rules: SpRules } | { error: string } {
  if (!record(input)) return { error: "The rules must be an object." };
  if (typeof input.earning !== "boolean") return { error: "earning must be true or false." };
  for (const field of ["perDollar", "perPayment", "claimPerDollar", "minUsd", "dailyCap", "pairDailyLimit", "inviteMonthlyLimit"] as const) {
    if (!within(input[field], BOUNDS[field])) return { error: `${field} must be a number from ${BOUNDS[field][0]} to ${BOUNDS[field][1].toLocaleString("en")}.` };
  }
  for (const field of ["pairDailyLimit", "inviteMonthlyLimit"] as const) {
    if (!Number.isInteger(input[field])) return { error: `${field} must be a whole number.` };
  }
  for (const field of ["perPayment", "dailyCap"] as const) {
    if (!isTenths(input[field])) return { error: `${field} must have at most one decimal.` };
  }
  const networks = input.networks;
  if (!record(networks) || !(["solana", "arc", "robinhood"] as const).every((key) => within(networks[key], BOUNDS.multiplier))) {
    return { error: "Each network multiplier must be a number from 0 to 10." };
  }
  const assets = input.assets;
  if (!record(assets) || !(["stable", "crypto", "stock"] as const).every((key) => within(assets[key], BOUNDS.multiplier))) {
    return { error: "Each asset multiplier must be a number from 0 to 10." };
  }
  const bonuses = input.bonuses;
  const bonusKeys = ["firstPayment", "linkedAccount", "solanaAddress", "firstClaim", "inviteClaimed"] as const;
  if (!record(bonuses) || !bonusKeys.every((key) => within(bonuses[key], BOUNDS.bonus) && isTenths(bonuses[key]))) {
    return { error: "Each bonus must be a number from 0 to 10,000 with at most one decimal." };
  }
  let boost: SpRules["boost"] = null;
  if (input.boost !== null && input.boost !== undefined) {
    const value = input.boost;
    if (!record(value) || !within(value.multiplier, [1, BOUNDS.multiplier[1]]) || typeof value.startsAt !== "string" || typeof value.endsAt !== "string") {
      return { error: "A boost needs a multiplier from 1 to 10 and a start and an end." };
    }
    const starts = Date.parse(value.startsAt);
    const ends = Date.parse(value.endsAt);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) return { error: "A boost must end after it starts." };
    if (ends - starts > MAX_BOOST_DAYS * 86_400_000) return { error: `A boost can last at most ${MAX_BOOST_DAYS} days.` };
    boost = { multiplier: value.multiplier, startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString() };
  }
  const referral = input.referral;
  if (!record(referral)) return { error: "The invite rules are missing." };
  if (!within(referral.pointsShare, [0, 1])) return { error: "The invite SP share must be a number from 0 to 1 (0.15 is 15%)." };
  if (!Number.isInteger(referral.feeShareBps) || !within(referral.feeShareBps, [0, REFERRAL_MAX_FEE_SHARE_BPS])) {
    return { error: `The invite fee share must be a whole number from 0 to ${REFERRAL_MAX_FEE_SHARE_BPS}: the percent of the 1% fee each payment verified (50 is half of it).` };
  }
  if (!within(referral.dailyCap, BOUNDS.dailyCap) || !isTenths(referral.dailyCap)) return { error: "The invite daily cap must be a number from 0 to 1,000,000 with at most one decimal." };
  return {
    rules: {
      earning: input.earning,
      perDollar: input.perDollar as number,
      perPayment: roundSp(input.perPayment as number),
      claimPerDollar: input.claimPerDollar as number,
      minUsd: input.minUsd as number,
      dailyCap: roundSp(input.dailyCap as number),
      pairDailyLimit: input.pairDailyLimit as number,
      networks: { solana: networks.solana as number, arc: networks.arc as number, robinhood: networks.robinhood as number },
      assets: { stable: assets.stable as number, crypto: assets.crypto as number, stock: assets.stock as number },
      bonuses: Object.fromEntries(bonusKeys.map((key) => [key, roundSp(bonuses[key] as number)])) as SpRules["bonuses"],
      inviteMonthlyLimit: input.inviteMonthlyLimit as number,
      boost,
      referral: { pointsShare: referral.pointsShare as number, feeShareBps: referral.feeShareBps as number, dailyCap: roundSp(referral.dailyCap as number) },
    },
  };
}

/** The boost multiplier at a moment: 1 outside the window. */
export function boostAt(rules: SpRules, at: Date) {
  if (!rules.boost) return 1;
  const time = at.getTime();
  return time >= Date.parse(rules.boost.startsAt) && time < Date.parse(rules.boost.endsAt) ? rules.boost.multiplier : 1;
}

/**
 * SP for one payment (sender) or one claimed vault link (claimer), before the daily cap: nothing when earning is off or
 * the value is under the minimum, else the payment's own SP plus its dollars, times the network's, the asset's and any
 * boost's multipliers, rounded down to a tenth of an SP.
 */
export function volumeSp(input: { usd: number; network: SpNetwork; asset: SpAssetClass; rules: SpRules; at: Date; kind: "payment" | "claim" }) {
  const { rules } = input;
  if (!rules.earning || !Number.isFinite(input.usd) || input.usd < rules.minUsd || input.usd <= 0) return 0;
  const raw = input.kind === "claim"
    ? input.usd * rules.claimPerDollar
    : rules.perPayment + input.usd * rules.perDollar;
  const total = raw * rules.networks[input.network] * rules.assets[input.asset] * boostAt(rules, input.at);
  // Down to the tenth, with a hair over the float's error, so 0.7 x 3 is 2.1 and not 2.0.
  return Math.max(0, Math.floor(total * 10 + 1e-6) / 10);
}

/** What is left under the daily cap. */
export function capped(points: number, earnedToday: number, rules: SpRules) {
  return cappedBy(points, earnedToday, rules.dailyCap);
}

/** What is left under a cap, never below zero. */
export function cappedBy(points: number, earned: number, cap: number) {
  return Math.max(0, roundSp(Math.min(points, cap - earned)));
}

/** The inviter's SP for an invited account's entry: its share, rounded down to the tenth; nothing while earning is off. */
export function referralSp(amount: number, rules: SpRules) {
  if (!rules.earning || !Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(0, Math.floor(amount * rules.referral.pointsShare * 10 + 1e-6) / 10);
}

/**
 * The inviter's reward for an invited account's payment, in USDC base units (6 decimals): its share of the fee verified
 * on chain, whose dollar value is given in the same units. The share is in basis points of the payment, of which the
 * fee is 100, so 50 is half the fee: a $25 payment's 0.25 fee (250,000 units) gives 125,000, rounded down.
 */
export function referralFeeUnits(feeUsdUnits: number, rules: SpRules) {
  if (!Number.isSafeInteger(feeUsdUnits) || feeUsdUnits <= 0) return 0n;
  return BigInt(feeUsdUnits) * BigInt(rules.referral.feeShareBps) / BigInt(REFERRAL_MAX_FEE_SHARE_BPS);
}

/** A decimal token amount, as the records keep it ("25", "0.15"), in US dollars at a price; 0 for anything else. */
export function amountUsd(amount: string, priceUsd: number) {
  if (!/^\d{1,30}(?:\.\d{1,30})?$/.test(amount) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  const value = Number(amount) * priceUsd;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export type SpEntryKind =
  | "payment"
  | "claim"
  | "invite"
  | "first_payment"
  | "first_claim"
  | "linked_account"
  | "solana_address"
  | "adjustment"
  | "reversal"
  | "referral";

/** One line of an account's SP history, as the pages show it. */
export type SpEntry = {
  id: string;
  kind: SpEntryKind;
  amount: number;
  network: SpNetwork | null;
  usdCents: number | null;
  detail: string;
  createdAt: string;
};

export const SP_ENTRY_LABELS: Record<SpEntryKind, string> = {
  payment: "Payment",
  claim: "Vault link claimed",
  invite: "Your vault link was claimed",
  first_payment: "First payment",
  first_claim: "First claim",
  linked_account: "Account linked",
  solana_address: "Solana address added",
  adjustment: "Adjusted by HaPaPay",
  reversal: "Reversed by HaPaPay",
  referral: "From someone you invited",
};

/** The entries an invited account earns that earn its inviter a share: activity and bonuses, never corrections or invites of its own. */
export const REFERRAL_SOURCE_KINDS: readonly SpEntryKind[] = ["payment", "claim", "invite", "first_payment", "first_claim", "linked_account", "solana_address"];

/** SP with one decimal and thousands separators, as the desk shows a balance or an entry: 1,234.5 and 25.0. */
export function formatSp(value: number) {
  return roundSp(value).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** An amount of SP in a sentence about the rules, without a trailing .0: "10 SP", "2.5 SP". */
export function formatSpBrief(value: number) {
  return roundSp(value).toLocaleString("en-US", { maximumFractionDigits: 1 });
}
