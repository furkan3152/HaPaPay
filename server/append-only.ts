/**
 * Tables that only grow: the SP ledger, the SP
 * rule versions and the admin audit log. A trigger refuses UPDATE, DELETE and TRUNCATE on them, so neither a bug nor a
 * mistaken query can rewrite history; corrections are new rows (a reversal, a new rule version).
 */
export const APPEND_ONLY_FUNCTION = `
  CREATE OR REPLACE FUNCTION hapapay_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'HaPaPay keeps every row of %: rows can be added, never changed or removed', TG_TABLE_NAME;
  END
  $$
`;

export const appendOnlyTriggers = (table: string) => [
  `CREATE OR REPLACE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hapapay_append_only()`,
  `CREATE OR REPLACE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION hapapay_append_only()`,
];

/** Every append-only table and its two triggers, for the schema check. Invites (2026-10-05) added the last five. */
export const APPEND_ONLY_TABLES = [
  "sp_rules", "sp_ledger", "admin_audit_log",
  "sp_referral_codes", "sp_referrals", "referral_fee_rewards", "referral_payout_batches", "referral_fee_payouts",
] as const;
