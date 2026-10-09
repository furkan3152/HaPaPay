import { REFERRAL_PARAM, referralCode, type ReferralJoinStatus } from "./domain/referrals";
import type { SpRules } from "./domain/sp";

/**
 * Invites on the desk. A link `…/app?ref=CODE` leaves its code in this browser until the
 * wallet is verified; the desk then sends it once, and the server decides whether the account joins. The code is kept
 * only in this browser and only until the server has answered for it.
 */
const STORAGE_KEY = "hapapay.invite";

/** Keeps the code of the invite link the page was opened with, and takes it out of the address bar. */
export function rememberInviteFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(REFERRAL_PARAM)) return;
    const code = referralCode(url.searchParams.get(REFERRAL_PARAM));
    url.searchParams.delete(REFERRAL_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (code) window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Storage or history refused (a private window, a sandbox): the link simply works as a plain visit.
  }
}

function pendingInvite() {
  try {
    return referralCode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function forgetInvite() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/**
 * Sends a remembered code for the verified account. The server's answer is final (joined, already invited, not a new
 * account…), so the code is forgotten then; when the server could not check it, it is kept for the next visit.
 */
export async function joinWithPendingInvite(): Promise<ReferralJoinStatus | undefined> {
  const code = pendingInvite();
  if (!code) return undefined;
  const response = await fetch("/api/sp/referral", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const result = await response.json().catch(() => ({})) as { status?: ReferralJoinStatus };
  if (response.ok && result.status) {
    forgetInvite();
    return result.status;
  }
  if (response.status === 400) forgetInvite();
  return undefined;
}

/** An account's invites as the server reports them; USDC amounts are base units (6 decimals). */
export type ReferralSummary = {
  code: string;
  invited: number;
  joined: boolean;
  sp: number;
  fees: { earned: string; paid: string; owed: string };
  solanaAddress: string | null;
  minimumPayout: string;
  rules: SpRules["referral"];
};

export async function readReferral(): Promise<ReferralSummary> {
  const response = await fetch("/api/sp/referral", { cache: "no-store" });
  const result = await response.json().catch(() => ({})) as Partial<ReferralSummary> & { error?: string };
  if (!response.ok || typeof result.code !== "string" || !result.fees || !result.rules) throw new Error(result.error ?? "Your invites could not be read. Try again.");
  return result as ReferralSummary;
}
