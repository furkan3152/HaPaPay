import type { SpNetwork } from "./domain/sp";

/**
 * SP on the desk. A vault link the desk claims is reported to the server, which checks the
 * claim on chain and awards it; the report is kept in this browser until the server has checked it, so a tab closed
 * right after a claim still earns its SP at the next visit.
 */
type ClaimReport = { network: SpNetwork; paymentId: string; transaction?: string; at: number };

const STORE_KEY = "hapapay.sp.claims";
const MAX_AGE_MS = 7 * 86_400_000;
export const SP_EVENT = "hapapay:sp";

/** Tells the desk that SP may have changed: it reads the balance again and shows what was awarded. */
export function announceSp(awarded = 0) {
  window.dispatchEvent(new CustomEvent(SP_EVENT, { detail: { awarded } }));
}

function stored(): ClaimReport[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ClaimReport => typeof item === "object" && item !== null
      && ["solana", "arc", "robinhood"].includes((item as ClaimReport).network)
      && /^0x[0-9a-fA-F]{64}$/.test(String((item as ClaimReport).paymentId))
      && typeof (item as ClaimReport).at === "number" && Date.now() - (item as ClaimReport).at < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function save(reports: ClaimReport[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(reports.slice(-50)));
  } catch {
    // Without storage the report is sent once; the server's own sync still finds most claims.
  }
}

async function send(report: ClaimReport) {
  try {
    const response = await fetch("/api/sp/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: report.network, paymentId: report.paymentId, ...(report.transaction ? { transaction: report.transaction } : {}) }),
    });
    const result = await response.json().catch(() => ({})) as { status?: string; awarded?: number };
    // Kept while the server could not tell yet: no session, a chain not read, a receipt not seen yet, no price yet.
    const later = response.status === 401 || response.status === 429 || response.status >= 500 || result.status === "pending" || result.status === "open";
    if (!later) save(stored().filter((item) => item.paymentId.toLowerCase() !== report.paymentId.toLowerCase()));
    announceSp(response.ok && typeof result.awarded === "number" ? result.awarded : 0);
  } catch {
    // Offline: kept for the next visit.
  }
}

/** Reports a vault link this wallet just claimed, keeping it until the server has checked it. */
export async function reportSpClaim(report: Omit<ClaimReport, "at">) {
  const entry = { ...report, at: Date.now() };
  save([...stored().filter((item) => item.paymentId.toLowerCase() !== report.paymentId.toLowerCase()), entry]);
  await send(entry);
}

/** Sends the reports an earlier visit could not finish. */
export async function retrySpClaimReports() {
  for (const report of stored()) await send(report);
}
