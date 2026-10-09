import type { ArcNetworkId } from "./arc-chains.js";
import type { SolanaNetworkId } from "./solana-chains.js";
import type { StockClaimPlatform } from "./stock-claims.js";
import type { StockNetworkId, StockTokenKind } from "./stock-tokens.js";

/**
 * How many links of each kind (waiting for you, sent by you) one network contributes, so a single request reads a
 * bounded number of payments back from the chain.
 */
export const PENDING_CLAIMS_LIMIT = 20;
/** How many pages of records one network reads at most while it looks for links still in the vault. */
export const PENDING_CLAIMS_MAX_PAGES = 5;

/**
 * Lists the links still in the vault a page of records at a time, until each side has `limit` links or its records
 * run out (at most `PENDING_CLAIMS_MAX_PAGES` pages). The limit applies to links still held, not to records (audit,
 * 2026-10-06: a payer's older refundable link was hidden behind twenty newer links that had been claimed). `check`
 * reads one page back from chain; a link sent to one's own account is listed once, under incoming.
 */
export async function pagedPendingLinks<R, L extends { paymentId: string }>(input: {
  limit: number;
  waitingFor(offset: number): Promise<R[]>;
  fundedBy(offset: number): Promise<R[]>;
  check(waiting: R[], funded: R[]): Promise<{ incoming: L[]; outgoing: L[] }>;
}) {
  const incoming: L[] = [];
  const outgoing: L[] = [];
  const claimable = new Set<string>();
  let waitingDone = false;
  let fundedDone = false;
  for (let page = 0; page < PENDING_CLAIMS_MAX_PAGES; page++) {
    const wantWaiting = !waitingDone && incoming.length < input.limit;
    const wantFunded = !fundedDone && outgoing.length < input.limit;
    if (!wantWaiting && !wantFunded) break;
    const offset = page * input.limit;
    const [waiting, funded] = await Promise.all([wantWaiting ? input.waitingFor(offset) : [], wantFunded ? input.fundedBy(offset) : []]);
    if (waiting.length < input.limit) waitingDone = true;
    if (funded.length < input.limit) fundedDone = true;
    if (!waiting.length && !funded.length) break;
    const found = await input.check(waiting, funded);
    for (const link of found.incoming) {
      incoming.push(link);
      claimable.add(link.paymentId.toLowerCase());
    }
    outgoing.push(...found.outgoing.filter((link) => !claimable.has(link.paymentId.toLowerCase())));
  }
  return { incoming: incoming.slice(0, input.limit), outgoing: outgoing.slice(0, input.limit) };
}

/** An account a vault link can be locked to: the platform and the handle it was sent to. */
export type VaultRecipient = { platform: StockClaimPlatform; username: string };

/**
 * One vault link the session wallet can act on, read back from the escrow that holds it. Links waiting for one of
 * the wallet's verified accounts are "claimable" while their window is open. Links the wallet funded are "waiting"
 * while the recipient can still claim them and "refundable" once the window has closed.
 */
type PendingVaultLinkBase = {
  chainName: string;
  paymentId: `0x${string}`;
  amount: string;
  recipient: VaultRecipient;
  expiresAt: string;
  status: "claimable" | "waiting" | "refundable";
  /** A mainnet Stock Token or xStock claim needs the recipient's eligibility statement. */
  statementRequired?: boolean;
  claimPath: string;
};

/** A link held by an EVM escrow on Arc or Robinhood Chain. */
export type EvmPendingVaultLink = PendingVaultLinkBase & {
  network: ArcNetworkId | StockNetworkId;
  chainId: number;
  escrow: `0x${string}`;
  token: { symbol: string; name: string; address: `0x${string}`; kind?: StockTokenKind; decimals: number };
  /** The sender's verified account when the payment named one; the funding wallet in every case. */
  sender: { wallet: `0x${string}`; platform?: string; username?: string };
};

/** A link held by the Solana vault program: `escrow` is the program ID, the token's address its mint. */
export type SolanaPendingVaultLink = PendingVaultLinkBase & {
  network: SolanaNetworkId;
  escrow: string;
  token: { symbol: string; name: string; address: string; kind?: StockTokenKind; decimals: number };
  /** The funding Solana address, and the sender's verified account when the payment named one. */
  sender: { wallet: string; platform?: string; username?: string };
};

export type PendingVaultLink = EvmPendingVaultLink | SolanaPendingVaultLink;

export type PendingVaultLinks = {
  incoming: PendingVaultLink[];
  outgoing: PendingVaultLink[];
  /** Networks whose escrow could not be read just now. Their links are left out, never guessed. */
  unavailable: string[];
};

/**
 * Orders a list for reading: links waiting for you by the soonest deadline, and your own links with the ones you
 * can take back first, then by deadline.
 */
export function sortPendingVaultLinks(links: PendingVaultLinks): PendingVaultLinks {
  const byDeadline = (left: PendingVaultLink, right: PendingVaultLink) => left.expiresAt.localeCompare(right.expiresAt);
  return {
    incoming: [...links.incoming].sort(byDeadline),
    outgoing: [...links.outgoing].sort((left, right) => Number(right.status === "refundable") - Number(left.status === "refundable") || byDeadline(left, right)),
    unavailable: [...links.unavailable],
  };
}
