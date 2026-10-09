import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NeonHttpMigrationError, parseMigrationArguments, recordMigrationStatements, runNeonHttpMigration } from "../scripts/neon-http-migration";

describe("opt-in Neon HTTP migration", () => {
  it("records the sixty-nine migration statements in repository order", async () => {
    const statements = await recordMigrationStatements();
    assert.equal(statements.length, 69);
    assert.match(statements[0], /CREATE TABLE IF NOT EXISTS social_identities/i);
    assert.match(statements[1], /CREATE INDEX IF NOT EXISTS social_identities_wallet_idx/i);
    assert.match(statements[2], /CREATE TABLE IF NOT EXISTS transient_security_states/i);
    assert.match(statements[3], /CREATE INDEX IF NOT EXISTS transient_security_states_expiry_idx/i);
    assert.match(statements[4], /CREATE TABLE IF NOT EXISTS arc_payments/i);
    assert.match(statements[5], /ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS source_platform/i);
    assert.match(statements[6], /ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS source_username_normalized/i);
    // Arc payments and vault links carry their chain; rows from before are Arc Testnet's (additive, so older code still runs).
    assert.match(statements[7], /ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 5042002/i);
    assert.match(statements[8], /ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS note TEXT$/i);
    // The fee the router took (2026-10-05): invite rewards come only from a fee verified on chain.
    assert.match(statements[9], /ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS fee_units TEXT$/i);
    assert.match(statements[10], /CREATE INDEX IF NOT EXISTS arc_payments_sender_idx/i);
    assert.match(statements[11], /CREATE INDEX IF NOT EXISTS arc_payments_recipient_idx/i);
    assert.match(statements[12], /CREATE TABLE IF NOT EXISTS claim_fundings/i);
    assert.match(statements[13], /ALTER TABLE claim_fundings ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 5042002/i);
    assert.match(statements[14], /CREATE TABLE IF NOT EXISTS stock_transfers[\s\S]*PRIMARY KEY \(chain_id, transaction_hash\)/i);
    assert.match(statements[15], /ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS note TEXT$/i);
    assert.match(statements[16], /ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS fee_units TEXT$/i);
    assert.match(statements[17], /CREATE INDEX IF NOT EXISTS stock_transfers_sender_idx/i);
    assert.match(statements[18], /CREATE INDEX IF NOT EXISTS stock_transfers_recipient_idx/i);
    assert.match(statements[19], /CREATE TABLE IF NOT EXISTS stock_claim_escrows[\s\S]*PRIMARY KEY \(chain_id, escrow_address\)[\s\S]*UNIQUE \(chain_id, deployment_transaction_hash\)/i);
    assert.match(statements[20], /CREATE TABLE IF NOT EXISTS stock_claims[\s\S]*PRIMARY KEY \(chain_id, payment_id\)[\s\S]*UNIQUE \(chain_id, funding_transaction_hash\)/i);
    // Solana (2026-10-04): an account's verified Solana address, Solana transfers, and the Solana vault.
    assert.match(statements[21], /CREATE TABLE IF NOT EXISTS account_addresses[\s\S]*PRIMARY KEY \(wallet_address, family\)[\s\S]*UNIQUE \(family, address\)/i);
    assert.match(statements[22], /CREATE TABLE IF NOT EXISTS solana_transfers[\s\S]*PRIMARY KEY \(signature, payment_index\)/i);
    assert.match(statements[23], /CREATE INDEX IF NOT EXISTS solana_transfers_sender_idx/i);
    assert.match(statements[24], /CREATE INDEX IF NOT EXISTS solana_transfers_recipient_idx/i);
    assert.match(statements[25], /CREATE TABLE IF NOT EXISTS solana_vaults[\s\S]*program_id TEXT PRIMARY KEY/i);
    assert.match(statements[26], /ALTER TABLE solana_vaults ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ$/i);
    assert.match(statements[27], /CREATE TABLE IF NOT EXISTS solana_claims[\s\S]*payment_id TEXT PRIMARY KEY[\s\S]*funding_signature TEXT NOT NULL UNIQUE/i);
    assert.match(statements[28], /CREATE INDEX IF NOT EXISTS solana_claims_recipient_idx/i);
    assert.match(statements[29], /CREATE INDEX IF NOT EXISTS solana_claims_payer_idx/i);
    // SP and the admin panel (2026-10-05): rule versions, the ledger and the audit log only grow.
    assert.match(statements[30], /CREATE OR REPLACE FUNCTION hapapay_append_only\(\) RETURNS trigger/i);
    assert.match(statements[31], /CREATE TABLE IF NOT EXISTS sp_rules[\s\S]*version INTEGER PRIMARY KEY/i);
    assert.match(statements[32], /INSERT INTO sp_rules \(version, rules, created_by, note\) VALUES \(1, '\{"earning":true[\s\S]*ON CONFLICT \(version\) DO NOTHING$/i);
    assert.match(statements[33], /CREATE OR REPLACE TRIGGER sp_rules_append_only BEFORE UPDATE OR DELETE ON sp_rules FOR EACH ROW/i);
    assert.match(statements[34], /CREATE OR REPLACE TRIGGER sp_rules_no_truncate BEFORE TRUNCATE ON sp_rules FOR EACH STATEMENT/i);
    assert.match(statements[35], /CREATE TABLE IF NOT EXISTS sp_ledger[\s\S]*amount NUMERIC\(14, 1\) NOT NULL[\s\S]*source_key TEXT NOT NULL UNIQUE[\s\S]*REFERENCES sp_rules \(version\)/i);
    // SP count in tenths (the rescale of 2026-10-05): a ledger made by the first SP SQL moves from BIGINT.
    assert.match(statements[36], /^\s*DO \$\$[\s\S]*= 'bigint' THEN\s*ALTER TABLE sp_ledger ALTER COLUMN amount TYPE NUMERIC\(14, 1\);[\s\S]*\$\$\s*$/i);
    // Invites (2026-10-05): a ledger made before them gets a kind check that accepts `referral`.
    assert.match(statements[37], /^\s*DO \$\$[\s\S]*conname = 'sp_ledger_kind_check'[\s\S]*LIKE '%''referral''%'[\s\S]*ADD CONSTRAINT sp_ledger_kind_check CHECK \(kind IN \([^)]*'referral'\)\)[\s\S]*\$\$\s*$/i);
    assert.match(statements[38], /ALTER TABLE sp_ledger ADD COLUMN IF NOT EXISTS fee_usd_units BIGINT CHECK \(fee_usd_units >= 0\)$/i);
    assert.match(statements[39], /CREATE INDEX IF NOT EXISTS sp_ledger_account_idx/i);
    assert.match(statements[40], /CREATE INDEX IF NOT EXISTS sp_ledger_created_idx/i);
    assert.match(statements[41], /CREATE OR REPLACE TRIGGER sp_ledger_append_only/i);
    assert.match(statements[42], /CREATE OR REPLACE TRIGGER sp_ledger_no_truncate/i);
    // Until the ledger's first row, version 1 follows the starting rules; the trigger is off only for that update.
    assert.match(statements[43], /^\s*DO \$\$[\s\S]*NOT EXISTS \(SELECT 1 FROM sp_ledger\) AND NOT EXISTS \(SELECT 1 FROM sp_rules WHERE version > 1\)[\s\S]*LOCK TABLE sp_ledger IN SHARE MODE;\s*IF NOT EXISTS \(SELECT 1 FROM sp_ledger\) THEN\s*ALTER TABLE sp_rules DISABLE TRIGGER sp_rules_append_only;\s*UPDATE sp_rules SET rules = '\{"earning":true,"perDollar":1,"perPayment":0,[\s\S]*WHERE version = 1;\s*ALTER TABLE sp_rules ENABLE TRIGGER sp_rules_append_only;[\s\S]*\$\$\s*$/i);
    assert.match(statements[44], /CREATE TABLE IF NOT EXISTS sp_account_flags/i);
    // Invites: codes, who joined with whose, USDC rewards, payout batches and payouts, each only growing.
    assert.match(statements[45], /CREATE TABLE IF NOT EXISTS sp_referral_codes[\s\S]*code TEXT PRIMARY KEY CHECK[\s\S]*account TEXT NOT NULL UNIQUE/i);
    assert.match(statements[46], /CREATE OR REPLACE TRIGGER sp_referral_codes_append_only/i);
    assert.match(statements[47], /CREATE OR REPLACE TRIGGER sp_referral_codes_no_truncate/i);
    assert.match(statements[48], /CREATE TABLE IF NOT EXISTS sp_referrals[\s\S]*invitee TEXT PRIMARY KEY[\s\S]*REFERENCES sp_referral_codes \(code\)[\s\S]*CHECK \(invitee <> referrer\)/i);
    assert.match(statements[49], /CREATE INDEX IF NOT EXISTS sp_referrals_referrer_idx/i);
    assert.match(statements[50], /CREATE UNIQUE INDEX IF NOT EXISTS sp_referrals_pair_idx ON sp_referrals \(LEAST\(invitee, referrer\), GREATEST\(invitee, referrer\)\)$/i);
    assert.match(statements[51], /CREATE OR REPLACE TRIGGER sp_referrals_append_only/i);
    assert.match(statements[52], /CREATE OR REPLACE TRIGGER sp_referrals_no_truncate/i);
    assert.match(statements[53], /CREATE TABLE IF NOT EXISTS referral_fee_rewards[\s\S]*source_key TEXT NOT NULL UNIQUE[\s\S]*usdc_units BIGINT NOT NULL,[\s\S]*REFERENCES sp_ledger \(id\)[\s\S]*CHECK \(\(source_key LIKE 'fee:%' AND usdc_units >= 0\) OR \(source_key LIKE 'fee-reverse:%' AND usdc_units < 0\)\)/i);
    assert.match(statements[54], /CREATE INDEX IF NOT EXISTS referral_fee_rewards_referrer_idx/i);
    assert.match(statements[55], /CREATE OR REPLACE TRIGGER referral_fee_rewards_append_only/i);
    assert.match(statements[56], /CREATE OR REPLACE TRIGGER referral_fee_rewards_no_truncate/i);
    assert.match(statements[57], /CREATE TABLE IF NOT EXISTS referral_payout_batches[\s\S]*total_units BIGINT NOT NULL CHECK \(total_units > 0\)/i);
    assert.match(statements[58], /CREATE OR REPLACE TRIGGER referral_payout_batches_append_only/i);
    assert.match(statements[59], /CREATE OR REPLACE TRIGGER referral_payout_batches_no_truncate/i);
    assert.match(statements[60], /CREATE TABLE IF NOT EXISTS referral_fee_payouts[\s\S]*REFERENCES referral_payout_batches \(id\)[\s\S]*UNIQUE \(batch, referrer\)/i);
    assert.match(statements[61], /CREATE INDEX IF NOT EXISTS referral_fee_payouts_referrer_idx/i);
    assert.match(statements[62], /CREATE OR REPLACE TRIGGER referral_fee_payouts_append_only/i);
    assert.match(statements[63], /CREATE OR REPLACE TRIGGER referral_fee_payouts_no_truncate/i);
    assert.match(statements[64], /CREATE TABLE IF NOT EXISTS admin_audit_log/i);
    assert.match(statements[65], /CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx/i);
    assert.match(statements[66], /CREATE OR REPLACE TRIGGER admin_audit_log_append_only/i);
    assert.match(statements[67], /CREATE OR REPLACE TRIGGER admin_audit_log_no_truncate/i);
    assert.match(statements[68], /CREATE TABLE IF NOT EXISTS admin_settings/i);
  });

  it("keeps native PostgreSQL default and enables HTTP only with an explicit transport flag", () => {
    assert.deepEqual(parseMigrationArguments([]), { transport: "pg", checkOnly: false });
    assert.deepEqual(parseMigrationArguments(["--transport=neon-http"]), { transport: "neon-http", checkOnly: false });
    assert.deepEqual(parseMigrationArguments(["--transport=neon-http", "--check-only"]), { transport: "neon-http", checkOnly: true });
    assert.deepEqual(parseMigrationArguments(["--check-only"]), { transport: "pg", checkOnly: true });
    assert.throws(() => parseMigrationArguments(["--transport=auto"]), /unsupported migration option/i);
  });

  it("redacts transaction failures and marks post-submission outcome unknown without retry", async () => {
    let submissions = 0;
    const credentialLike = "postgresql://user:secret@host/db";
    await assert.rejects(() => runNeonHttpMigration({
      async transaction() { submissions += 1; throw new Error(`request ${credentialLike} failed`); },
      async query() { throw new Error("schema read should not run"); },
    }, { checkOnly: false }), (error: unknown) => {
      assert.ok(error instanceof NeonHttpMigrationError);
      assert.equal(error.commitStatus, "unknown");
      assert.match(error.message, /UNKNOWN/);
      assert.doesNotMatch(error.message, /secret|postgresql|host/i);
      return true;
    });
    assert.equal(submissions, 1);
  });

  it("aborts a bounded transaction timeout and reports UNKNOWN without submitting again", async () => {
    let submissions = 0;
    await assert.rejects(() => runNeonHttpMigration({
      transaction(_statements, signal) {
        submissions += 1;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("secret timeout body")), { once: true }));
      },
      async query() { throw new Error("schema read should not run"); },
    }, { checkOnly: false, timeoutMs: 5 }), (error: unknown) => {
      assert.ok(error instanceof NeonHttpMigrationError);
      assert.equal(error.commitStatus, "unknown");
      assert.doesNotMatch(error.message, /secret timeout body/i);
      return true;
    });
    assert.equal(submissions, 1);
  });
});
