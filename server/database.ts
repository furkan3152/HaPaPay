import { Pool } from "pg";
import { PostgresIdentityRepository } from "./postgres-identity-repository.js";
import { PostgresTransientStateStore } from "./transient-state-store.js";
import { PostgresPaymentRepository } from "./payment-history-service.js";
import { PostgresClaimFundingRepository } from "./claim-funding-service.js";
import { PostgresStockTransferRepository } from "./stock-transfer-service.js";
import { PostgresStockClaimRepository } from "./stock-claim-service.js";
import { PostgresAccountAddressRepository } from "./account-address-service.js";
import { PostgresSolanaTransferRepository } from "./solana-transfer-service.js";
import { PostgresSolanaVaultRepository } from "./solana-vault-service.js";
import { PostgresSpRepository } from "./sp-service.js";
import { PostgresReferralStore } from "./referral-store.js";
import { PostgresAdminAuditRepository, PostgresAdminSettingsRepository } from "./admin-service.js";
import { PostgresAdminRecords } from "./admin-records.js";
import { APPEND_ONLY_TABLES } from "./append-only.js";

export function createDatabasePool(databaseUrl: string) {
  return new Pool({ connectionString: databaseUrl, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
}

type DatabaseQuery = { query(statement: string, parameters?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };

export function postgresStores(pool: DatabaseQuery) {
  return {
    identities: new PostgresIdentityRepository(pool),
    transientState: new PostgresTransientStateStore(pool),
    paymentRepository: new PostgresPaymentRepository(pool),
    claimFundingRepository: new PostgresClaimFundingRepository(pool),
    stockTransferRepository: new PostgresStockTransferRepository(pool),
    stockClaimRepository: new PostgresStockClaimRepository(pool),
    accountAddressRepository: new PostgresAccountAddressRepository(pool),
    solanaTransferRepository: new PostgresSolanaTransferRepository(pool),
    solanaVaultRepository: new PostgresSolanaVaultRepository(pool),
    spRepository: new PostgresSpRepository(pool),
    referralStore: new PostgresReferralStore(pool),
    adminAuditRepository: new PostgresAdminAuditRepository(pool),
    adminSettingsRepository: new PostgresAdminSettingsRepository(pool),
    adminRecords: new PostgresAdminRecords(pool),
  };
}

export async function migrateDatabase(pool: DatabaseQuery) {
  const stores = postgresStores(pool);
  await stores.identities.migrate();
  await stores.transientState.migrate();
  await stores.paymentRepository.migrate();
  await stores.claimFundingRepository.migrate();
  await stores.stockTransferRepository.migrate();
  await stores.stockClaimRepository.migrate();
  await stores.accountAddressRepository.migrate();
  await stores.solanaTransferRepository.migrate();
  await stores.solanaVaultRepository.migrate();
  // SP and the admin panel (2026-10-05): the append-only function comes with SP's tables, before the audit log uses it.
  await stores.spRepository.migrate();
  // Invites (2026-10-05) reference SP's ledger and rule versions, so they come after them.
  await stores.referralStore.migrate();
  await stores.adminAuditRepository.migrate();
}

export async function attachVercelDatabasePool(pool: Pool) {
  const { attachDatabasePool } = await import("@vercel/functions");
  attachDatabasePool(pool);
}

const requiredColumns: Record<string, Record<string, [string, boolean]>> = {
  social_identities: {
    platform: ["text", true], provider_user_id: ["text", true], username_normalized: ["text", true],
    wallet_address: ["text", true], verified_at: ["timestamp with time zone", true],
  },
  transient_security_states: {
    namespace: ["text", true], state_key: ["text", true], state_value: ["jsonb", true],
    expires_at: ["timestamp with time zone", true],
  },
  arc_payments: {
    transaction_hash: ["text", true], sender_address: ["text", true], recipient_address: ["text", true],
    platform: ["text", true], username_normalized: ["text", true], amount_text: ["text", true],
    block_number: ["bigint", true], confirmed_at: ["timestamp with time zone", true],
    source_platform: ["text", false], source_username_normalized: ["text", false],
    chain_id: ["integer", true], note: ["text", false], fee_units: ["text", false],
  },
  claim_fundings: {
    payment_id: ["text", true], transaction_hash: ["text", true], payer_address: ["text", true],
    recipient_platform: ["text", true], recipient_username_normalized: ["text", true], amount_text: ["text", true],
    expiry: ["bigint", true], block_number: ["bigint", true], confirmed_at: ["timestamp with time zone", true],
    source_platform: ["text", false], source_username_normalized: ["text", false],
    chain_id: ["integer", true],
  },
  stock_transfers: {
    chain_id: ["integer", true], transaction_hash: ["text", true], token_address: ["text", true], token_symbol: ["text", true],
    sender_address: ["text", true], recipient_address: ["text", true], platform: ["text", true],
    username_normalized: ["text", true], amount_text: ["text", true], units_text: ["text", true],
    block_number: ["bigint", true], confirmed_at: ["timestamp with time zone", true],
    source_platform: ["text", false], source_username_normalized: ["text", false], note: ["text", false], fee_units: ["text", false],
  },
  stock_claim_escrows: {
    chain_id: ["integer", true], escrow_address: ["text", true], deployment_transaction_hash: ["text", true],
    owner_address: ["text", true], verifier_address: ["text", true], block_number: ["bigint", true],
    registered_at: ["timestamp with time zone", true],
  },
  stock_claims: {
    chain_id: ["integer", true], payment_id: ["text", true], escrow_address: ["text", true], funding_transaction_hash: ["text", true],
    token_address: ["text", true], token_symbol: ["text", true], payer_address: ["text", true], recipient_platform: ["text", true],
    recipient_username_normalized: ["text", true], amount_text: ["text", true], units_text: ["text", true], expiry: ["bigint", true],
    block_number: ["bigint", true], confirmed_at: ["timestamp with time zone", true],
    source_platform: ["text", false], source_username_normalized: ["text", false],
  },
  account_addresses: {
    wallet_address: ["text", true], family: ["text", true], address: ["text", true], verified_at: ["timestamp with time zone", true],
  },
  solana_transfers: {
    signature: ["text", true], payment_index: ["integer", true], mint: ["text", true], token_symbol: ["text", true],
    sender_wallet: ["text", true], sender_address: ["text", true], recipient_wallet: ["text", true], recipient_address: ["text", true],
    platform: ["text", true], username_normalized: ["text", true], amount_text: ["text", true], units_text: ["text", true],
    fee_units_text: ["text", true], note: ["text", false], slot: ["bigint", true], confirmed_at: ["timestamp with time zone", true],
    source_platform: ["text", false], source_username_normalized: ["text", false],
  },
  solana_vaults: {
    program_id: ["text", true], owner_address: ["text", true], verifier_address: ["text", true], treasury_address: ["text", true],
    registered_at: ["timestamp with time zone", true], retired_at: ["timestamp with time zone", false],
  },
  solana_claims: {
    payment_id: ["text", true], program_id: ["text", true], funding_signature: ["text", true], mint: ["text", true],
    token_symbol: ["text", true], payer_wallet: ["text", true], payer_address: ["text", true], recipient_platform: ["text", true],
    recipient_username_normalized: ["text", true], amount_text: ["text", true], units_text: ["text", true], expiry: ["bigint", true],
    slot: ["bigint", true], confirmed_at: ["timestamp with time zone", true],
    source_platform: ["text", false], source_username_normalized: ["text", false],
  },
  sp_rules: {
    version: ["integer", true], rules: ["jsonb", true], created_by: ["text", true], note: ["text", false], created_at: ["timestamp with time zone", true],
  },
  sp_ledger: {
    id: ["bigint", true], account: ["text", true], kind: ["text", true], amount: ["numeric(14,1)", true], source_key: ["text", true],
    network: ["text", false], usd_cents: ["bigint", false], fee_usd_units: ["bigint", false], counterparty: ["text", false], detail: ["text", true],
    rules_version: ["integer", true], actor: ["text", false], reason: ["text", false], created_at: ["timestamp with time zone", true],
  },
  sp_account_flags: {
    account: ["text", true], frozen: ["boolean", true], reason: ["text", false], updated_by: ["text", true], updated_at: ["timestamp with time zone", true],
  },
  admin_audit_log: {
    id: ["bigint", true], actor: ["text", true], action: ["text", true], target: ["text", false], details: ["jsonb", true], created_at: ["timestamp with time zone", true],
  },
  admin_settings: {
    key: ["text", true], value: ["jsonb", true], updated_by: ["text", true], updated_at: ["timestamp with time zone", true],
  },
  sp_referral_codes: {
    code: ["text", true], account: ["text", true], created_at: ["timestamp with time zone", true],
  },
  sp_referrals: {
    invitee: ["text", true], referrer: ["text", true], code: ["text", true], created_at: ["timestamp with time zone", true],
  },
  referral_fee_rewards: {
    id: ["bigint", true], source_key: ["text", true], referrer: ["text", true], invitee: ["text", true], network: ["text", true],
    payment_usd_cents: ["bigint", true], usdc_units: ["bigint", true], sp_entry_id: ["bigint", true], rules_version: ["integer", true],
    reason: ["text", false], created_at: ["timestamp with time zone", true],
  },
  referral_payout_batches: {
    id: ["text", true], payer: ["text", true], items: ["jsonb", true], total_units: ["bigint", true], last_valid_block_height: ["bigint", true],
    created_by: ["text", true], created_at: ["timestamp with time zone", true],
  },
  referral_fee_payouts: {
    id: ["bigint", true], batch: ["text", true], referrer: ["text", true], solana_address: ["text", true], usdc_units: ["bigint", true],
    signature: ["text", true], paid_by: ["text", true], created_at: ["timestamp with time zone", true],
  },
};

const requiredConstraints = [
  ["social_identities", "p", ["platform", "provider_user_id"]],
  ["social_identities", "u", ["platform", "username_normalized"]],
  ["transient_security_states", "p", ["namespace", "state_key"]],
  ["arc_payments", "p", ["transaction_hash"]],
  ["claim_fundings", "p", ["payment_id"]],
  ["claim_fundings", "u", ["transaction_hash"]],
  ["stock_transfers", "p", ["chain_id", "transaction_hash"]],
  ["stock_claim_escrows", "p", ["chain_id", "escrow_address"]],
  ["stock_claim_escrows", "u", ["chain_id", "deployment_transaction_hash"]],
  ["stock_claims", "p", ["chain_id", "payment_id"]],
  ["stock_claims", "u", ["chain_id", "funding_transaction_hash"]],
  ["account_addresses", "p", ["wallet_address", "family"]],
  ["account_addresses", "u", ["family", "address"]],
  ["solana_transfers", "p", ["signature", "payment_index"]],
  ["solana_vaults", "p", ["program_id"]],
  ["solana_claims", "p", ["payment_id"]],
  ["solana_claims", "u", ["funding_signature"]],
  ["sp_rules", "p", ["version"]],
  ["sp_ledger", "p", ["id"]],
  ["sp_ledger", "u", ["source_key"]],
  ["sp_account_flags", "p", ["account"]],
  ["admin_audit_log", "p", ["id"]],
  ["admin_settings", "p", ["key"]],
  ["sp_referral_codes", "p", ["code"]],
  ["sp_referral_codes", "u", ["account"]],
  ["sp_referrals", "p", ["invitee"]],
  ["referral_fee_rewards", "p", ["id"]],
  ["referral_fee_rewards", "u", ["source_key"]],
  ["referral_payout_batches", "p", ["id"]],
  ["referral_fee_payouts", "p", ["id"]],
  ["referral_fee_payouts", "u", ["batch", "referrer"]],
] as const;

const expectedRelations = `WITH expected(name) AS (
  VALUES ('social_identities'), ('transient_security_states'), ('arc_payments'), ('claim_fundings'), ('stock_transfers'),
    ('stock_claim_escrows'), ('stock_claims'), ('account_addresses'), ('solana_transfers'), ('solana_vaults'), ('solana_claims'),
    ('sp_rules'), ('sp_ledger'), ('sp_account_flags'), ('admin_audit_log'), ('admin_settings'),
    ('sp_referral_codes'), ('sp_referrals'), ('referral_fee_rewards'), ('referral_payout_batches'), ('referral_fee_payouts')
)`;

function missingSchema(): never {
  throw new Error("Required database schema is missing or incompatible. Run and verify the production migration command before serving requests.");
}

export async function verifyDatabaseSchema(pool: { query(statement: string): Promise<{ rows: Array<Record<string, unknown>> }> }) {
  const columns = await pool.query(`${expectedRelations}
    SELECT expected.name, relation.relkind, attribute.attname AS column,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS not_null
    FROM expected
    LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = pg_catalog.to_regclass(expected.name)
    LEFT JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0 AND NOT attribute.attisdropped`);
  const actualColumns = new Map(columns.rows.map((row) => [`${row.name}.${row.column}`, row]));
  for (const [name, expected] of Object.entries(requiredColumns)) {
    for (const [column, [dataType, notNull]] of Object.entries(expected)) {
      const actual = actualColumns.get(`${name}.${column}`);
      if (!actual || actual.relkind !== "r" || actual.data_type !== dataType || actual.not_null !== notNull) missingSchema();
    }
  }

  const constraints = await pool.query(`${expectedRelations}
    SELECT expected.name, catalog_constraint.contype AS kind, catalog_constraint.convalidated AS valid,
      catalog_constraint.condeferrable AS deferrable,
      ARRAY(SELECT attribute.attname::text
        FROM unnest(catalog_constraint.conkey) AS key(attnum)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = catalog_constraint.conrelid AND attribute.attnum = key.attnum
        ORDER BY attribute.attname) AS columns
    FROM expected
    LEFT JOIN pg_catalog.pg_constraint AS catalog_constraint
      ON catalog_constraint.conrelid = pg_catalog.to_regclass(expected.name)
      AND catalog_constraint.contype IN ('p', 'u')`);
  for (const [name, kind, required] of requiredConstraints) {
    const expectedSet = [...required].sort().join("\0");
    const found = constraints.rows.some((row) => row.name === name && row.kind === kind
      && row.valid === true && row.deferrable === false
      && Array.isArray(row.columns) && row.columns.every((column) => typeof column === "string")
      && [...row.columns].sort().join("\0") === expectedSet);
    if (!found) missingSchema();
  }

  // The tables that only grow must still refuse UPDATE, DELETE and TRUNCATE: an enabled trigger of each kind.
  const triggers = await pool.query(`SELECT relation.relname AS name, catalog_trigger.tgname AS trigger, catalog_trigger.tgenabled AS enabled
    FROM pg_catalog.pg_trigger AS catalog_trigger
    JOIN pg_catalog.pg_class AS relation ON relation.oid = catalog_trigger.tgrelid
    WHERE NOT catalog_trigger.tgisinternal
      AND relation.oid IN (${APPEND_ONLY_TABLES.map((table) => `pg_catalog.to_regclass('${table}')`).join(", ")})`);
  for (const table of APPEND_ONLY_TABLES) {
    for (const trigger of [`${table}_append_only`, `${table}_no_truncate`]) {
      const found = triggers.rows.some((row) => row.name === table && row.trigger === trigger && (row.enabled === "O" || row.enabled === "A"));
      if (!found) missingSchema();
    }
  }

  // The ledger must accept invite rows: a ledger made before invites has a kind check without them.
  const kinds = await pool.query(`SELECT pg_catalog.pg_get_constraintdef(catalog_constraint.oid) AS definition
    FROM pg_catalog.pg_constraint AS catalog_constraint
    WHERE catalog_constraint.conrelid = pg_catalog.to_regclass('sp_ledger') AND catalog_constraint.conname = 'sp_ledger_kind_check'`);
  if (!kinds.rows.some((row) => typeof row.definition === "string" && row.definition.includes("'referral'"))) missingSchema();

  // One invite per pair of accounts in either direction: two accounts never invite each other, even at the same moment.
  const pairs = await pool.query(`SELECT catalog_index.indisunique AS is_unique, catalog_index.indisvalid AS valid,
      pg_catalog.pg_get_indexdef(catalog_index.indexrelid) AS definition
    FROM pg_catalog.pg_index AS catalog_index
    JOIN pg_catalog.pg_class AS relation ON relation.oid = catalog_index.indexrelid
    WHERE catalog_index.indrelid = pg_catalog.to_regclass('sp_referrals') AND relation.relname = 'sp_referrals_pair_idx'`);
  if (!pairs.rows.some((row) => row.is_unique === true && row.valid === true && typeof row.definition === "string"
    && row.definition.includes("LEAST(invitee, referrer)") && row.definition.includes("GREATEST(invitee, referrer)"))) missingSchema();
}
