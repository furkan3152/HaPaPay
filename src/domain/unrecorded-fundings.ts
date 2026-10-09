/**
 * Vault links whose funding left the wallet but whose record did not reach the server, kept in this browser until a
 * record succeeds (audit, 2026-10-06: a link whose recording failed and whose tab was then closed appeared in nobody's
 * Claims, and its payment ID was shown nowhere). Each entry is the exact confirm request the slip would send again;
 * the desk sends it again after the next sign-in. Recording is idempotent on the server: an entry already recorded
 * answers as recorded and is forgotten.
 */
export type UnrecordedFunding = {
  /** The confirm route: Arc, Robinhood Chain or Solana vault links. */
  url: "/api/claims/confirm-funding" | "/api/stocks/claims/confirm-funding" | "/api/solana/claims/confirm";
  body: Record<string, unknown>;
  /** The account (EVM wallet) that funded it; only its own session sends it again. */
  wallet: string;
  /** The funding transaction's hash or signature, which names the entry. */
  transaction: string;
  savedAt: number;
  attempts: number;
};

const KEY = "hapapay:unrecorded-fundings:v1";
/** A funding is kept at most this long: a link's window is at most 30 days. */
const KEEP_MS = 31 * 24 * 60 * 60_000;
/** Refusals (a 4xx the server gives for this record) before a funding is given up; outages never count. */
const MAX_ATTEMPTS = 10;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function read(storage: Storage | undefined): UnrecordedFunding[] {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is UnrecordedFunding => typeof entry?.url === "string" && typeof entry?.transaction === "string" && typeof entry?.wallet === "string") : [];
  } catch {
    return [];
  }
}

function write(storage: Storage | undefined, entries: UnrecordedFunding[]) {
  try {
    storage?.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Private windows and full storage keep nothing; the slip still offers to record again while it is open.
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Keeps a funding's confirm request until it is recorded. */
export function rememberUnrecordedFunding(entry: Omit<UnrecordedFunding, "savedAt" | "attempts">, storage = browserStorage(), now = Date.now()) {
  const kept = read(storage).filter((candidate) => candidate.transaction !== entry.transaction);
  write(storage, [...kept, { ...entry, savedAt: now, attempts: 0 }]);
}

/** Forgets a funding once the server has recorded it. */
export function forgetUnrecordedFunding(transaction: string, storage = browserStorage()) {
  const entries = read(storage);
  const kept = entries.filter((entry) => entry.transaction !== transaction);
  if (kept.length !== entries.length) write(storage, kept);
}

/**
 * Sends this wallet's kept fundings again, oldest first. One the server records (or already has, 409) is forgotten, as
 * is one Solana says never landed (410: nothing moved). An outage, a missing session or a rate limit leaves it as it
 * was; any other refusal counts, and a funding refused `MAX_ATTEMPTS` times or older than a month is given up. Answers
 * how many were recorded now.
 */
export async function retryUnrecordedFundings(wallet: string, send: (url: string, body: Record<string, unknown>) => Promise<{ status: number }>, storage = browserStorage(), now = Date.now()) {
  const before = read(storage);
  const entries = before.filter((entry) => now - entry.savedAt < KEEP_MS && entry.attempts < MAX_ATTEMPTS);
  let recorded = 0;
  const kept: UnrecordedFunding[] = [];
  for (const entry of entries) {
    if (entry.wallet.toLowerCase() !== wallet.toLowerCase()) {
      kept.push(entry);
      continue;
    }
    let status = 0;
    try {
      status = (await send(entry.url, entry.body)).status;
    } catch {
      status = 0;
    }
    if ((status >= 200 && status < 300) || status === 409) recorded++;
    else if (status === 410) continue;
    else if (status === 0 || status === 401 || status === 429 || status >= 500) kept.push(entry);
    else kept.push({ ...entry, attempts: entry.attempts + 1 });
  }
  // A funding kept meanwhile (another tab, a slip) is not lost, and one recorded and forgotten meanwhile stays forgotten.
  const after = read(storage);
  const added = after.filter((entry) => !before.some((old) => old.transaction === entry.transaction));
  write(storage, [...kept.filter((entry) => after.some((current) => current.transaction === entry.transaction)), ...added]);
  return recorded;
}
