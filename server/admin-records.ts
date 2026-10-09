import { getAddress, isAddress, type Address } from "viem";
import { ARC_MAINNET } from "./arc-network.js";
import { STOCK_CHAINS } from "../src/domain/stock-tokens.js";

type SqlPool = { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

const ROBINHOOD_MAINNET_ID = STOCK_CHAINS["robinhood-mainnet"].id;

/** One payment or vault link as the admin panel lists it, on any network. */
export type AdminActivityRow = {
  network: "solana" | "arc" | "robinhood";
  kind: "payment" | "vault_link";
  id: string;
  sender: string;
  recipient: string | null;
  platform: string;
  username: string;
  amount: string;
  symbol: string;
  expiresAt: string | null;
  confirmedAt: string;
};

export type AdminCounts = {
  accounts: number;
  linkedAccounts: number;
  payments: Record<"solana" | "arc" | "robinhood", number>;
  vaultLinks: Record<"solana" | "arc" | "robinhood", number>;
};

/**
 * What the admin panel reads across every account: recent payments and vault links on the
 * three mainnets, counts, and every wallet that ever used HaPaPay (for awarding SP to everyone). Reads only.
 */
export interface AdminRecords {
  activity(input: { kind: "payment" | "vault_link"; limit: number; before?: string; wallet?: Address }): Promise<AdminActivityRow[]>;
  counts(): Promise<AdminCounts>;
  /** Every wallet that sent, funded, linked an account or holds SP, in address order after `after`. */
  accounts(after: string | undefined, limit: number): Promise<{ wallets: Address[]; next: string | null }>;
}

const activityRow = (row: Record<string, unknown>): AdminActivityRow => ({
  network: String(row.network) as AdminActivityRow["network"],
  kind: String(row.kind) as AdminActivityRow["kind"],
  id: String(row.id),
  sender: String(row.sender),
  recipient: row.recipient === null || row.recipient === undefined ? null : String(row.recipient),
  platform: String(row.platform),
  username: String(row.username),
  amount: String(row.amount),
  symbol: String(row.symbol),
  expiresAt: row.expiry === null || row.expiry === undefined ? null : new Date(Number(row.expiry) * 1000).toISOString(),
  confirmedAt: new Date(row.confirmed_at as string | Date).toISOString(),
});

export class PostgresAdminRecords implements AdminRecords {
  constructor(private readonly pool: SqlPool) {}

  async activity(input: { kind: "payment" | "vault_link"; limit: number; before?: string; wallet?: Address }) {
    // The cursor is the last row's time and ID: payments of one Solana transaction share a time, and a cursor of the
    // time alone skipped the rest of them (audit, 2026-10-06). A time alone still works as before.
    const [beforeTime, beforeId] = (input.before ?? "").split("|");
    const before = beforeTime && Number.isFinite(Date.parse(beforeTime)) ? new Date(beforeTime).toISOString() : null;
    const beforeRow = before && beforeId ? beforeId : null;
    const wallet = input.wallet ? getAddress(input.wallet) : null;
    const union = input.kind === "payment"
      ? `SELECT 'arc' AS network, 'payment' AS kind, transaction_hash AS id, sender_address AS sender, recipient_address AS recipient, platform,
                username_normalized AS username, amount_text AS amount, 'USDC' AS symbol, NULL::bigint AS expiry, confirmed_at
           FROM arc_payments WHERE chain_id = ${ARC_MAINNET.chainId}
         UNION ALL
         SELECT 'robinhood', 'payment', transaction_hash, sender_address, recipient_address, platform, username_normalized, amount_text, token_symbol, NULL::bigint, confirmed_at
           FROM stock_transfers WHERE chain_id = ${ROBINHOOD_MAINNET_ID}
         UNION ALL
         SELECT 'solana', 'payment', signature || ':' || payment_index, sender_wallet, recipient_wallet, platform, username_normalized, amount_text, token_symbol, NULL::bigint, confirmed_at
           FROM solana_transfers`
      : `SELECT 'arc' AS network, 'vault_link' AS kind, payment_id AS id, payer_address AS sender, NULL::text AS recipient, recipient_platform AS platform,
                recipient_username_normalized AS username, amount_text AS amount, 'USDC' AS symbol, expiry, confirmed_at
           FROM claim_fundings WHERE chain_id = ${ARC_MAINNET.chainId}
         UNION ALL
         SELECT 'robinhood', 'vault_link', payment_id, payer_address, NULL, recipient_platform, recipient_username_normalized, amount_text, token_symbol, expiry, confirmed_at
           FROM stock_claims WHERE chain_id = ${ROBINHOOD_MAINNET_ID}
         UNION ALL
         SELECT 'solana', 'vault_link', payment_id, payer_wallet, NULL, recipient_platform, recipient_username_normalized, amount_text, token_symbol, expiry, confirmed_at
           FROM solana_claims`;
    const result = await this.pool.query(
      `SELECT * FROM (${union}) AS activity
       WHERE ($2::timestamptz IS NULL OR confirmed_at < $2 OR ($4::text IS NOT NULL AND confirmed_at = $2 AND id < $4))
         AND ($3::text IS NULL OR sender = $3 OR recipient = $3)
       ORDER BY confirmed_at DESC, id DESC LIMIT $1`,
      [input.limit, before, wallet, beforeRow],
    );
    return result.rows.map(activityRow);
  }

  async counts() {
    const row = (await this.pool.query(`SELECT
        (SELECT COUNT(DISTINCT wallet_address) FROM social_identities) AS accounts,
        (SELECT COUNT(*) FROM social_identities) AS linked_accounts,
        (SELECT COUNT(*) FROM arc_payments WHERE chain_id = ${ARC_MAINNET.chainId}) AS arc_payments,
        (SELECT COUNT(*) FROM stock_transfers WHERE chain_id = ${ROBINHOOD_MAINNET_ID}) AS robinhood_payments,
        (SELECT COUNT(*) FROM solana_transfers) AS solana_payments,
        (SELECT COUNT(*) FROM claim_fundings WHERE chain_id = ${ARC_MAINNET.chainId}) AS arc_links,
        (SELECT COUNT(*) FROM stock_claims WHERE chain_id = ${ROBINHOOD_MAINNET_ID}) AS robinhood_links,
        (SELECT COUNT(*) FROM solana_claims) AS solana_links`)).rows[0] ?? {};
    const count = (key: string) => Number(row[key] ?? 0);
    return {
      accounts: count("accounts"),
      linkedAccounts: count("linked_accounts"),
      payments: { solana: count("solana_payments"), arc: count("arc_payments"), robinhood: count("robinhood_payments") },
      vaultLinks: { solana: count("solana_links"), arc: count("arc_links"), robinhood: count("robinhood_links") },
    };
  }

  async accounts(after: string | undefined, limit: number) {
    const result = await this.pool.query(
      `SELECT wallet FROM (
         SELECT sender_address AS wallet FROM arc_payments WHERE chain_id = ${ARC_MAINNET.chainId}
         UNION SELECT sender_address FROM stock_transfers WHERE chain_id = ${ROBINHOOD_MAINNET_ID}
         UNION SELECT sender_wallet FROM solana_transfers
         UNION SELECT payer_address FROM claim_fundings WHERE chain_id = ${ARC_MAINNET.chainId}
         UNION SELECT payer_address FROM stock_claims WHERE chain_id = ${ROBINHOOD_MAINNET_ID}
         UNION SELECT payer_wallet FROM solana_claims
         UNION SELECT wallet_address FROM social_identities
         UNION SELECT wallet_address FROM account_addresses
         UNION SELECT account FROM sp_ledger
       ) AS known
       WHERE $1::text IS NULL OR wallet > $1
       ORDER BY wallet LIMIT $2`,
      [after ?? null, limit],
    );
    const raw = result.rows.map((row) => String(row.wallet));
    return {
      wallets: [...new Set(raw.filter((wallet) => isAddress(wallet, { strict: false })).map((wallet) => getAddress(wallet)))],
      next: raw.length === limit ? raw[raw.length - 1] : null,
    };
  }
}
