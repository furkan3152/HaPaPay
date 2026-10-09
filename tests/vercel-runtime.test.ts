import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateDatabase, verifyDatabaseSchema } from "../server/database";
import { migrateViaNeonHttp, recordMigrationStatements, runNeonHttpMigration } from "../scripts/neon-http-migration";
import { neonConfig } from "@neondatabase/serverless";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Client, Pool } from "pg";
import { createApp } from "../server/app";
import { WalletAuthService } from "../server/wallet-auth";

const completeColumns = [
  ["social_identities", "platform", "text", true],
  ["social_identities", "provider_user_id", "text", true],
  ["social_identities", "username_normalized", "text", true],
  ["social_identities", "wallet_address", "text", true],
  ["social_identities", "verified_at", "timestamp with time zone", true],
  ["transient_security_states", "namespace", "text", true],
  ["transient_security_states", "state_key", "text", true],
  ["transient_security_states", "state_value", "jsonb", true],
  ["transient_security_states", "expires_at", "timestamp with time zone", true],
  ["arc_payments", "transaction_hash", "text", true],
  ["arc_payments", "sender_address", "text", true],
  ["arc_payments", "recipient_address", "text", true],
  ["arc_payments", "platform", "text", true],
  ["arc_payments", "username_normalized", "text", true],
  ["arc_payments", "amount_text", "text", true],
  ["arc_payments", "block_number", "bigint", true],
  ["arc_payments", "confirmed_at", "timestamp with time zone", true],
  ["arc_payments", "source_platform", "text", false],
  ["arc_payments", "source_username_normalized", "text", false],
  ["arc_payments", "chain_id", "integer", true],
  ["arc_payments", "note", "text", false],
  ["arc_payments", "fee_units", "text", false],
  ["claim_fundings", "payment_id", "text", true],
  ["claim_fundings", "transaction_hash", "text", true],
  ["claim_fundings", "payer_address", "text", true],
  ["claim_fundings", "recipient_platform", "text", true],
  ["claim_fundings", "recipient_username_normalized", "text", true],
  ["claim_fundings", "amount_text", "text", true],
  ["claim_fundings", "expiry", "bigint", true],
  ["claim_fundings", "block_number", "bigint", true],
  ["claim_fundings", "confirmed_at", "timestamp with time zone", true],
  ["claim_fundings", "source_platform", "text", false],
  ["claim_fundings", "source_username_normalized", "text", false],
  ["claim_fundings", "chain_id", "integer", true],
  ["stock_transfers", "chain_id", "integer", true],
  ["stock_transfers", "transaction_hash", "text", true],
  ["stock_transfers", "token_address", "text", true],
  ["stock_transfers", "token_symbol", "text", true],
  ["stock_transfers", "sender_address", "text", true],
  ["stock_transfers", "recipient_address", "text", true],
  ["stock_transfers", "platform", "text", true],
  ["stock_transfers", "username_normalized", "text", true],
  ["stock_transfers", "amount_text", "text", true],
  ["stock_transfers", "units_text", "text", true],
  ["stock_transfers", "block_number", "bigint", true],
  ["stock_transfers", "confirmed_at", "timestamp with time zone", true],
  ["stock_transfers", "source_platform", "text", false],
  ["stock_transfers", "source_username_normalized", "text", false],
  ["stock_transfers", "note", "text", false],
  ["stock_transfers", "fee_units", "text", false],
  ["stock_claim_escrows", "chain_id", "integer", true],
  ["stock_claim_escrows", "escrow_address", "text", true],
  ["stock_claim_escrows", "deployment_transaction_hash", "text", true],
  ["stock_claim_escrows", "owner_address", "text", true],
  ["stock_claim_escrows", "verifier_address", "text", true],
  ["stock_claim_escrows", "block_number", "bigint", true],
  ["stock_claim_escrows", "registered_at", "timestamp with time zone", true],
  ["stock_claims", "chain_id", "integer", true],
  ["stock_claims", "payment_id", "text", true],
  ["stock_claims", "escrow_address", "text", true],
  ["stock_claims", "funding_transaction_hash", "text", true],
  ["stock_claims", "token_address", "text", true],
  ["stock_claims", "token_symbol", "text", true],
  ["stock_claims", "payer_address", "text", true],
  ["stock_claims", "recipient_platform", "text", true],
  ["stock_claims", "recipient_username_normalized", "text", true],
  ["stock_claims", "amount_text", "text", true],
  ["stock_claims", "units_text", "text", true],
  ["stock_claims", "expiry", "bigint", true],
  ["stock_claims", "block_number", "bigint", true],
  ["stock_claims", "confirmed_at", "timestamp with time zone", true],
  ["stock_claims", "source_platform", "text", false],
  ["stock_claims", "source_username_normalized", "text", false],
  ["account_addresses", "wallet_address", "text", true],
  ["account_addresses", "family", "text", true],
  ["account_addresses", "address", "text", true],
  ["account_addresses", "verified_at", "timestamp with time zone", true],
  ...[
    ["signature", "text", true], ["payment_index", "integer", true], ["mint", "text", true], ["token_symbol", "text", true],
    ["sender_wallet", "text", true], ["sender_address", "text", true], ["recipient_wallet", "text", true], ["recipient_address", "text", true],
    ["platform", "text", true], ["username_normalized", "text", true], ["amount_text", "text", true], ["units_text", "text", true],
    ["fee_units_text", "text", true], ["note", "text", false], ["slot", "bigint", true], ["confirmed_at", "timestamp with time zone", true],
    ["source_platform", "text", false], ["source_username_normalized", "text", false],
  ].map((row) => ["solana_transfers", ...row]),
  ...[
    ["program_id", "text", true], ["owner_address", "text", true], ["verifier_address", "text", true], ["treasury_address", "text", true],
    ["registered_at", "timestamp with time zone", true], ["retired_at", "timestamp with time zone", false],
  ].map((row) => ["solana_vaults", ...row]),
  ...[
    ["payment_id", "text", true], ["program_id", "text", true], ["funding_signature", "text", true], ["mint", "text", true],
    ["token_symbol", "text", true], ["payer_wallet", "text", true], ["payer_address", "text", true], ["recipient_platform", "text", true],
    ["recipient_username_normalized", "text", true], ["amount_text", "text", true], ["units_text", "text", true], ["expiry", "bigint", true],
    ["slot", "bigint", true], ["confirmed_at", "timestamp with time zone", true], ["source_platform", "text", false], ["source_username_normalized", "text", false],
  ].map((row) => ["solana_claims", ...row]),
  // SP and the admin panel (2026-10-05).
  ...[
    ["version", "integer", true], ["rules", "jsonb", true], ["created_by", "text", true], ["note", "text", false], ["created_at", "timestamp with time zone", true],
  ].map((row) => ["sp_rules", ...row]),
  ...[
    ["id", "bigint", true], ["account", "text", true], ["kind", "text", true], ["amount", "numeric(14,1)", true], ["source_key", "text", true],
    ["network", "text", false], ["usd_cents", "bigint", false], ["fee_usd_units", "bigint", false], ["counterparty", "text", false], ["detail", "text", true],
    ["rules_version", "integer", true], ["actor", "text", false], ["reason", "text", false], ["created_at", "timestamp with time zone", true],
  ].map((row) => ["sp_ledger", ...row]),
  ...[
    ["account", "text", true], ["frozen", "boolean", true], ["reason", "text", false], ["updated_by", "text", true], ["updated_at", "timestamp with time zone", true],
  ].map((row) => ["sp_account_flags", ...row]),
  ...[
    ["id", "bigint", true], ["actor", "text", true], ["action", "text", true], ["target", "text", false], ["details", "jsonb", true], ["created_at", "timestamp with time zone", true],
  ].map((row) => ["admin_audit_log", ...row]),
  ...[
    ["key", "text", true], ["value", "jsonb", true], ["updated_by", "text", true], ["updated_at", "timestamp with time zone", true],
  ].map((row) => ["admin_settings", ...row]),
  // Invites (2026-10-05).
  ...[["code", "text", true], ["account", "text", true], ["created_at", "timestamp with time zone", true]].map((row) => ["sp_referral_codes", ...row]),
  ...[["invitee", "text", true], ["referrer", "text", true], ["code", "text", true], ["created_at", "timestamp with time zone", true]].map((row) => ["sp_referrals", ...row]),
  ...[
    ["id", "bigint", true], ["source_key", "text", true], ["referrer", "text", true], ["invitee", "text", true], ["network", "text", true],
    ["payment_usd_cents", "bigint", true], ["usdc_units", "bigint", true], ["sp_entry_id", "bigint", true], ["rules_version", "integer", true],
    ["reason", "text", false], ["created_at", "timestamp with time zone", true],
  ].map((row) => ["referral_fee_rewards", ...row]),
  ...[
    ["id", "text", true], ["payer", "text", true], ["items", "jsonb", true], ["total_units", "bigint", true], ["last_valid_block_height", "bigint", true],
    ["created_by", "text", true], ["created_at", "timestamp with time zone", true],
  ].map((row) => ["referral_payout_batches", ...row]),
  ...[
    ["id", "bigint", true], ["batch", "text", true], ["referrer", "text", true], ["solana_address", "text", true], ["usdc_units", "bigint", true],
    ["signature", "text", true], ["paid_by", "text", true], ["created_at", "timestamp with time zone", true],
  ].map((row) => ["referral_fee_payouts", ...row]),
].map(([name, column, data_type, not_null]) => ({ name, relkind: "r", column, data_type, not_null }));
const completeConstraints = [
  { name: "social_identities", kind: "p", valid: true, deferrable: false, columns: ["platform", "provider_user_id"] },
  { name: "social_identities", kind: "u", valid: true, deferrable: false, columns: ["platform", "username_normalized"] },
  { name: "transient_security_states", kind: "p", valid: true, deferrable: false, columns: ["namespace", "state_key"] },
  { name: "arc_payments", kind: "p", valid: true, deferrable: false, columns: ["transaction_hash"] },
  { name: "claim_fundings", kind: "p", valid: true, deferrable: false, columns: ["payment_id"] },
  { name: "claim_fundings", kind: "u", valid: true, deferrable: false, columns: ["transaction_hash"] },
  { name: "stock_transfers", kind: "p", valid: true, deferrable: false, columns: ["chain_id", "transaction_hash"] },
  { name: "stock_claim_escrows", kind: "p", valid: true, deferrable: false, columns: ["chain_id", "escrow_address"] },
  { name: "stock_claim_escrows", kind: "u", valid: true, deferrable: false, columns: ["chain_id", "deployment_transaction_hash"] },
  { name: "stock_claims", kind: "p", valid: true, deferrable: false, columns: ["chain_id", "payment_id"] },
  { name: "stock_claims", kind: "u", valid: true, deferrable: false, columns: ["chain_id", "funding_transaction_hash"] },
  { name: "account_addresses", kind: "p", valid: true, deferrable: false, columns: ["family", "wallet_address"] },
  { name: "account_addresses", kind: "u", valid: true, deferrable: false, columns: ["address", "family"] },
  { name: "solana_transfers", kind: "p", valid: true, deferrable: false, columns: ["payment_index", "signature"] },
  { name: "solana_vaults", kind: "p", valid: true, deferrable: false, columns: ["program_id"] },
  { name: "solana_claims", kind: "p", valid: true, deferrable: false, columns: ["payment_id"] },
  { name: "solana_claims", kind: "u", valid: true, deferrable: false, columns: ["funding_signature"] },
  { name: "sp_rules", kind: "p", valid: true, deferrable: false, columns: ["version"] },
  { name: "sp_ledger", kind: "p", valid: true, deferrable: false, columns: ["id"] },
  { name: "sp_ledger", kind: "u", valid: true, deferrable: false, columns: ["source_key"] },
  { name: "sp_account_flags", kind: "p", valid: true, deferrable: false, columns: ["account"] },
  { name: "admin_audit_log", kind: "p", valid: true, deferrable: false, columns: ["id"] },
  { name: "admin_settings", kind: "p", valid: true, deferrable: false, columns: ["key"] },
  { name: "sp_referral_codes", kind: "p", valid: true, deferrable: false, columns: ["code"] },
  { name: "sp_referral_codes", kind: "u", valid: true, deferrable: false, columns: ["account"] },
  { name: "sp_referrals", kind: "p", valid: true, deferrable: false, columns: ["invitee"] },
  { name: "referral_fee_rewards", kind: "p", valid: true, deferrable: false, columns: ["id"] },
  { name: "referral_fee_rewards", kind: "u", valid: true, deferrable: false, columns: ["source_key"] },
  { name: "referral_payout_batches", kind: "p", valid: true, deferrable: false, columns: ["id"] },
  { name: "referral_fee_payouts", kind: "p", valid: true, deferrable: false, columns: ["id"] },
  { name: "referral_fee_payouts", kind: "u", valid: true, deferrable: false, columns: ["batch", "referrer"] },
];
/** The append-only tables' triggers: UPDATE and DELETE refused per row, TRUNCATE per statement. */
const completeTriggers = ["sp_rules", "sp_ledger", "admin_audit_log", "sp_referral_codes", "sp_referrals", "referral_fee_rewards", "referral_payout_batches", "referral_fee_payouts"].flatMap((name) => [
  { name, trigger: `${name}_append_only`, enabled: "O" },
  { name, trigger: `${name}_no_truncate`, enabled: "O" },
]);

/** The pair index on invites as PostgreSQL prints it: one invite per pair of accounts, in either direction. */
const completePairs = [{ is_unique: true, valid: true, definition: "CREATE UNIQUE INDEX sp_referrals_pair_idx ON public.sp_referrals USING btree (LEAST(invitee, referrer), GREATEST(invitee, referrer))" }];

/** The ledger's kind check as PostgreSQL prints it, with invites. */
const completeKinds = [{ definition: "CHECK ((kind = ANY (ARRAY['payment'::text, 'claim'::text, 'invite'::text, 'first_payment'::text, 'first_claim'::text, 'linked_account'::text, 'solana_address'::text, 'adjustment'::text, 'reversal'::text, 'referral'::text])))" }];

function catalogFixture(columns = completeColumns, constraints = completeConstraints, triggers = completeTriggers, kinds = completeKinds, pairs: Array<Record<string, unknown>> = completePairs) {
  const statements: string[] = [];
  return {
    statements,
    async query(statement: string) {
      statements.push(statement);
      if (statement.includes("pg_catalog.pg_index")) return { rows: pairs };
      if (statement.includes("pg_catalog.pg_trigger")) return { rows: triggers };
      if (statement.includes("pg_get_constraintdef")) return { rows: kinds };
      return { rows: statement.includes("pg_catalog.pg_constraint") ? constraints : columns };
    },
  };
}

function effectivePgConnection(config: { connectionString: string; options?: string }) {
  // Constructing pg.Client parses connection parameters but does not connect.
  const parameters: unknown = Reflect.get(new Client(config), "connectionParameters");
  if (!parameters || typeof parameters !== "object" || !("host" in parameters) || typeof parameters.host !== "string") {
    throw new Error("Isolated PostgreSQL connection parameters could not be verified.");
  }
  const options = "options" in parameters ? parameters.options : undefined;
  if (options !== undefined && typeof options !== "string") throw new Error("Isolated PostgreSQL options could not be verified.");
  return { host: parameters.host, options };
}

function isolatedPostgresConfig(connectionString: string, schema?: string) {
  const url = new URL(connectionString);
  if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:") || url.search || url.hash
    || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")) {
    throw new Error("Isolated PostgreSQL must use an unmodified loopback URL.");
  }
  if (schema && !/^hapapay_(?:vercel_guard|http_transaction|check_only)_[a-f0-9]{32}$/.test(schema)) {
    throw new Error("Isolated PostgreSQL requires a generated UUID schema.");
  }
  const config = { connectionString, ...(schema ? { options: `-c search_path=${schema}` } : {}) };
  const effective = effectivePgConnection(config);
  if ((effective.host !== "127.0.0.1" && effective.host !== "::1")
    || (schema && effective.options !== config.options)) {
    throw new Error("Isolated PostgreSQL effective host or search path is unsafe.");
  }
  return config;
}

function isolatedCliUrl(connectionString: string, schema: string) {
  const config = isolatedPostgresConfig(connectionString, schema);
  const url = new URL(connectionString);
  url.searchParams.set("options", config.options!);
  const effective = effectivePgConnection({ connectionString: url.toString() });
  if (url.searchParams.size !== 1 || url.searchParams.get("options") !== config.options
    || (effective.host !== "127.0.0.1" && effective.host !== "::1") || effective.options !== config.options) {
    throw new Error("Isolated PostgreSQL CLI host or search path is unsafe.");
  }
  return url.toString();
}

describe("Vercel database readiness seam", () => {
  it("rejects a connection-free URL fixture whose pg host override targets a remote server", () => {
    assert.throws(() => isolatedPostgresConfig("postgresql://127.0.0.1:5432/postgres?host=managed.example"), /isolated PostgreSQL/i);
  });

  it("rejects a connection-free URL fixture whose pg options override escapes the UUID schema", () => {
    const schema = `hapapay_http_transaction_${"a".repeat(32)}`;
    assert.throws(() => isolatedPostgresConfig("postgresql://127.0.0.1:5432/postgres?options=-c%20search_path%3Dpublic", schema), /isolated PostgreSQL/i);
  });

  it("submits all sixty-nine recorded migration statements in one HTTP transaction, then reads schema only", async () => {
    const fixture = catalogFixture();
    const submissions: string[][] = [];
    await runNeonHttpMigration({
      async transaction(statements, signal) {
        assert.equal(signal.aborted, false);
        submissions.push(statements);
        return statements.map(() => ({ rows: [] }));
      },
      query: (statement) => fixture.query(statement),
    }, { checkOnly: false });
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].length, 69);
    assert.equal(fixture.statements.length, 5);
    fixture.statements.forEach((statement) => assert.match(statement, /SELECT/i));
  });

  it("rejects an incomplete HTTP transaction result before claiming schema verification", async () => {
    const fixture = catalogFixture();
    await assert.rejects(() => runNeonHttpMigration({
      async transaction() { return [{ rows: [] }]; },
      query: (statement) => fixture.query(statement),
    }, { checkOnly: false }), /UNKNOWN/);
    assert.equal(fixture.statements.length, 0);
  });

  it("check-only verifies schema without submitting any HTTP migration statement", async () => {
    const fixture = catalogFixture();
    let submissions = 0;
    await runNeonHttpMigration({
      async transaction() { submissions += 1; return []; },
      query: (statement) => fixture.query(statement),
    }, { checkOnly: true });
    assert.equal(submissions, 0);
    assert.equal(fixture.statements.length, 5);
  });

  it("redacts a failed read-only HTTP catalog query and does not submit in check-only mode", async () => {
    let submissions = 0;
    await assert.rejects(() => runNeonHttpMigration({
      async transaction() { submissions += 1; return []; },
      async query() { throw new Error("https://secret-host.example/secret-token"); },
    }, { checkOnly: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /schema verification failed/i);
      assert.doesNotMatch(error.message, /secret-host|secret-token/);
      return true;
    });
    assert.equal(submissions, 0);
  });

  it("uses one pinned SDK batch fetch and parses HTTP catalog booleans/arrays", async () => {
    const originalFetch = neonConfig.fetchFunction;
    const bodies: Array<Record<string, unknown>> = [];
    const result = (fields: Array<[string, number]>, rows: unknown[][]) => ({
      fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })), rows, rowCount: rows.length,
    });
    neonConfig.fetchFunction = async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      bodies.push(body);
      let response: Record<string, unknown>;
      if (Array.isArray(body.queries)) {
        assert.equal(body.queries.length, 69);
        response = { results: body.queries.map(() => result([], [])) };
      } else if (String(body.query).includes("pg_catalog.pg_index")) {
        response = result([["is_unique", 16], ["valid", 16], ["definition", 25]], completePairs.map((row) => [row.is_unique ? "t" : "f", row.valid ? "t" : "f", row.definition]));
      } else if (String(body.query).includes("pg_get_constraintdef")) {
        response = result([["definition", 25]], completeKinds.map((row) => [row.definition]));
      } else if (String(body.query).includes("pg_catalog.pg_trigger")) {
        response = result([["name", 25], ["trigger", 25], ["enabled", 18]], completeTriggers.map((row) => [row.name, row.trigger, row.enabled]));
      } else if (String(body.query).includes("pg_catalog.pg_class")) {
        response = result([["name", 25], ["relkind", 25], ["column", 25], ["data_type", 25], ["not_null", 16]],
          completeColumns.map((row) => [row.name, row.relkind, row.column, row.data_type, row.not_null ? "t" : "f"]));
      } else {
        response = result([["name", 25], ["kind", 25], ["valid", 16], ["deferrable", 16], ["columns", 1009]],
          completeConstraints.map((row) => [row.name, row.kind, row.valid ? "t" : "f", row.deferrable ? "t" : "f", `{${row.columns.join(",")}}`]));
      }
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await migrateViaNeonHttp("postgresql://fixture:fixture@ep-fixture.neon.tech/fixture", { checkOnly: false });
      assert.equal(bodies.length, 6);
      assert.ok(Array.isArray(bodies[0].queries));
      assert.equal(bodies.slice(1).every((body) => typeof body.query === "string"), true);
    } finally {
      neonConfig.fetchFunction = originalFetch;
    }
  });

  it("checks the twenty-one persisted tables without trying to migrate during a request", async () => {
    const pool = catalogFixture();
    await verifyDatabaseSchema(pool);
    assert.equal(pool.statements.length, 5);
    for (const statement of pool.statements) {
      assert.match(statement, /SELECT/i);
      assert.doesNotMatch(statement, /CREATE|ALTER|INSERT|UPDATE|DELETE/i);
    }
  });

  it("refuses to serve when a required persisted table is absent", async () => {
    const pool = catalogFixture(completeColumns.filter((row) => row.name !== "claim_fundings"));
    await assert.rejects(() => verifyDatabaseSchema(pool), /database schema/i);
    const withoutStockHistory = catalogFixture(completeColumns.filter((row) => row.name !== "stock_transfers"));
    await assert.rejects(() => verifyDatabaseSchema(withoutStockHistory), /database schema/i);
    const unscopedStockHistory = catalogFixture(completeColumns, completeConstraints.map((row) => row.name === "stock_transfers" ? { ...row, columns: ["transaction_hash"] } : row));
    await assert.rejects(() => verifyDatabaseSchema(unscopedStockHistory), /database schema/i, "stock history must be chain-scoped");
    for (const table of ["stock_claim_escrows", "stock_claims", "account_addresses", "solana_transfers", "solana_vaults", "solana_claims"]) {
      await assert.rejects(() => verifyDatabaseSchema(catalogFixture(completeColumns.filter((row) => row.name !== table))), /database schema/i, `${table} is required`);
    }
    const reusableFunding = catalogFixture(completeColumns, completeConstraints.filter((row) => !(row.name === "stock_claims" && row.kind === "u")));
    await assert.rejects(() => verifyDatabaseSchema(reusableFunding), /database schema/i, "one funding transaction must back one claim link");
    const sharedSolanaAddress = catalogFixture(completeColumns, completeConstraints.filter((row) => !(row.name === "account_addresses" && row.kind === "u")));
    await assert.rejects(() => verifyDatabaseSchema(sharedSolanaAddress), /database schema/i, "one Solana address belongs to one account");
    const reusableSolanaFunding = catalogFixture(completeColumns, completeConstraints.filter((row) => !(row.name === "solana_claims" && row.kind === "u")));
    await assert.rejects(() => verifyDatabaseSchema(reusableSolanaFunding), /database schema/i, "one Solana funding transaction must back one link");
    for (const table of ["sp_rules", "sp_ledger", "sp_account_flags", "admin_audit_log", "admin_settings"]) {
      await assert.rejects(() => verifyDatabaseSchema(catalogFixture(completeColumns.filter((row) => row.name !== table))), /database schema/i, `${table} is required`);
    }
    const reusableSource = catalogFixture(completeColumns, completeConstraints.filter((row) => !(row.name === "sp_ledger" && row.kind === "u")));
    await assert.rejects(() => verifyDatabaseSchema(reusableSource), /database schema/i, "one activity earns SP once");
    const wholeSp = catalogFixture(completeColumns.map((row) => row.name === "sp_ledger" && row.column === "amount" ? { ...row, data_type: "bigint" } : row));
    await assert.rejects(() => verifyDatabaseSchema(wholeSp), /database schema/i, "a ledger from the first SP SQL keeps whole SP and must be migrated to tenths");
    for (const table of ["sp_referral_codes", "sp_referrals", "referral_fee_rewards", "referral_payout_batches", "referral_fee_payouts"]) {
      await assert.rejects(() => verifyDatabaseSchema(catalogFixture(completeColumns.filter((row) => row.name !== table))), /database schema/i, `${table} is required`);
    }
    const twiceInvited = catalogFixture(completeColumns, completeConstraints.filter((row) => !(row.name === "referral_fee_payouts" && row.kind === "u")));
    await assert.rejects(() => verifyDatabaseSchema(twiceInvited), /database schema/i, "a payout batch pays each inviter once");
    const beforeInvites = catalogFixture(completeColumns, completeConstraints, completeTriggers, [{ definition: completeKinds[0].definition.replace(", 'referral'::text", "") }]);
    await assert.rejects(() => verifyDatabaseSchema(beforeInvites), /database schema/i, "a ledger whose kinds do not include invites must be migrated");
    const pairsAllowed = catalogFixture(completeColumns, completeConstraints, completeTriggers, completeKinds, []);
    await assert.rejects(() => verifyDatabaseSchema(pairsAllowed), /database schema/i, "two accounts must never invite each other");
    const pairsInvalid = catalogFixture(completeColumns, completeConstraints, completeTriggers, completeKinds, [{ ...completePairs[0], valid: false }]);
    await assert.rejects(() => verifyDatabaseSchema(pairsInvalid), /database schema/i, "an index left invalid by a failed build protects nothing");
    // Invite rewards come only from fees verified on chain: the payments keep the fee, and the ledger its dollar value.
    for (const [table, column] of [["arc_payments", "fee_units"], ["stock_transfers", "fee_units"], ["sp_ledger", "fee_usd_units"]]) {
      const without = catalogFixture(completeColumns.filter((row) => !(row.name === table && row.column === column)));
      await assert.rejects(() => verifyDatabaseSchema(without), /database schema/i, `${table}.${column} is required`);
    }
  });

  it("refuses an SP ledger, rule history or audit log that could be rewritten", async () => {
    for (const missing of completeTriggers) {
      const without = catalogFixture(completeColumns, completeConstraints, completeTriggers.filter((row) => row !== missing));
      await assert.rejects(() => verifyDatabaseSchema(without), /database schema/i, `${missing.trigger} is required`);
    }
    const disabled = catalogFixture(completeColumns, completeConstraints, completeTriggers.map((row) => row.trigger === "sp_ledger_append_only" ? { ...row, enabled: "D" } : row));
    await assert.rejects(() => verifyDatabaseSchema(disabled), /database schema/i, "a disabled trigger protects nothing");
  });

  it("refuses a table that has not received its latest column migration", async () => {
    const pool = catalogFixture(completeColumns.filter((row) => !(row.name === "arc_payments" && row.column === "source_platform")));
    await assert.rejects(() => verifyDatabaseSchema(pool), /database schema/i);
  });

  it("refuses a claim-funding table missing its required source username column", async () => {
    const pool = catalogFixture(completeColumns.filter((row) => !(row.name === "claim_fundings" && row.column === "source_username_normalized")));
    await assert.rejects(() => verifyDatabaseSchema(pool), /database schema/i);
  });

  it("refuses a schema missing the verified provider-handle uniqueness guarantee", async () => {
    const pool = catalogFixture(completeColumns, completeConstraints.filter((row) => !(row.name === "social_identities" && row.kind === "u")));
    await assert.rejects(() => verifyDatabaseSchema(pool), /database schema/i);
  });

  it("checks migration-defined columns, types and constraints on isolated PostgreSQL", { skip: !(process.env.REAL_DATABASE_URL && process.env.HAPAPAY_ISOLATED_POSTGRES === "1") }, async () => {
    const connectionString = process.env.REAL_DATABASE_URL!;
    const adminConfig = isolatedPostgresConfig(connectionString);
    const schema = `hapapay_vercel_guard_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool(adminConfig);
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool(isolatedPostgresConfig(connectionString, schema));
      await assert.rejects(() => verifyDatabaseSchema(pool!), /database schema/i);
      await migrateDatabase(pool);
      await verifyDatabaseSchema(pool);
      await pool.query("ALTER TABLE social_identities DROP CONSTRAINT social_identities_platform_username_normalized_key");
      await assert.rejects(() => verifyDatabaseSchema(pool!), /database schema/i);
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("rolls back and idempotently commits the fixed transaction on isolated loopback PostgreSQL", { skip: !(process.env.REAL_DATABASE_URL && process.env.HAPAPAY_ISOLATED_POSTGRES === "1") }, async () => {
    const connectionString = process.env.REAL_DATABASE_URL!;
    const adminConfig = isolatedPostgresConfig(connectionString);
    const schema = `hapapay_http_transaction_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool(adminConfig);
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool(isolatedPostgresConfig(connectionString, schema));
      const statements = await recordMigrationStatements();
      const applyTransaction = async (commit: boolean) => {
        const client = await pool!.connect();
        try {
          await client.query("BEGIN");
          for (const statement of statements) await client.query(statement);
          await client.query(commit ? "COMMIT" : "ROLLBACK");
        } finally {
          client.release();
        }
      };
      await applyTransaction(false);
      await assert.rejects(() => verifyDatabaseSchema(pool!), /database schema/i);
      await applyTransaction(true);
      await verifyDatabaseSchema(pool);
      await applyTransaction(true);
      await verifyDatabaseSchema(pool);
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("native CLI names the missing DATABASE_URL instead of a generic failure", () => {
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    delete environment.NODE_OPTIONS;
    // Run from an empty folder so a developer's own .env cannot supply the setting.
    const folder = mkdtempSync(join(tmpdir(), "hapapay-migrate-"));
    try {
      const command = spawnSync(process.execPath, [resolvePath("node_modules/tsx/dist/cli.mjs"), resolvePath("scripts/migrate-database.ts")], {
        cwd: folder, encoding: "utf8", env: environment,
      });
      assert.equal(command.status, 1);
      assert.equal(command.stderr.trim(), "DATABASE_URL is required in production.");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("native CLI names an unsupported option instead of a generic failure", () => {
    const command = spawnSync(process.execPath, [resolvePath("node_modules/tsx/dist/cli.mjs"), resolvePath("scripts/migrate-database.ts"), "--nope"], {
      encoding: "utf8",
    });
    assert.equal(command.status, 1);
    assert.equal(command.stderr.trim(), "Unsupported migration option.");
  });

  it("native CLI check-only leaves an empty isolated PostgreSQL schema untouched", { skip: !(process.env.REAL_DATABASE_URL && process.env.HAPAPAY_ISOLATED_POSTGRES === "1") }, async () => {
    const connectionString = process.env.REAL_DATABASE_URL!;
    const adminConfig = isolatedPostgresConfig(connectionString);
    const schema = `hapapay_check_only_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool(adminConfig);
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scopedUrl = isolatedCliUrl(connectionString, schema);
      const command = spawnSync(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/migrate-database.ts", "--check-only"], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATABASE_URL: scopedUrl },
      });
      assert.equal(command.status, 1);
      assert.match(command.stderr, /Database migration failed/);
      const relations = await admin.query("SELECT count(*)::integer AS count FROM pg_catalog.pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'r'", [schema]);
      assert.equal(relations.rows[0].count, 0);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("exports without opening the database and returns a generic non-cacheable bootstrap failure", async () => {
    const priorUrl = process.env.APP_URL;
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.APP_URL = "";
    process.env.NODE_ENV = "production";
    let listener: Server | undefined;
    try {
      const app = (await import("../server.js")).default;
      listener = await new Promise<Server>((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
      });
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Service temporarily unavailable." });
    } finally {
      if (listener) await new Promise<void>((resolve, reject) => listener!.close((error) => error ? reject(error) : resolve()));
      if (priorUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = priorUrl;
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it("rejects malformed Vercel client IPs before protected wallet handlers", async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "localhost", sessionSecret: "vercel-ingress-test-secret-32-characters" }),
      vercelIngress: true,
    });
    const listener = await new Promise<Server>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      for (const forwarded of [undefined, "1.2.3.4, 5.6.7.8", "1.2.3.4:55"]) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/auth/challenge`, {
          method: "POST", headers: { "Content-Type": "application/json", ...(forwarded ? { "X-Forwarded-For": forwarded } : {}) },
          body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }),
        });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { error: "Service temporarily unavailable." });
      }
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("separates Vercel wallet quotas by validated client IP and rejects malformed chat ingress", async () => {
    const app = createApp({
      auth: new WalletAuthService({ domain: "localhost", sessionSecret: "vercel-quota-test-secret-32-characters" }),
      vercelIngress: true,
    });
    const listener = await new Promise<Server>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      const challenge = (ip: string) => fetch(`${origin}/api/auth/challenge`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }),
      });
      for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await challenge("203.0.113.10")).status, 200);
      assert.equal((await challenge("203.0.113.10")).status, 429);
      assert.equal((await challenge("203.0.113.11")).status, 200);
      const chat = await fetch(`${origin}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10, 203.0.113.11" },
        body: JSON.stringify({ message: "test" }),
      });
      assert.equal(chat.status, 503);
      assert.equal(chat.headers.get("cache-control"), "no-store");
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps direct/local wallet quotas independent of forwarded-header values", async (t) => {
    // The rate limiter reports the untrusted X-Forwarded-For once on console.error; expect it instead of printing it.
    const print = console.error;
    const logged = t.mock.method(console, "error", (...args: unknown[]) => {
      if ((args[0] as { code?: string } | undefined)?.code !== "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR") print(...args);
    });
    const app = createApp({
      auth: new WalletAuthService({ domain: "localhost", sessionSecret: "direct-quota-test-secret-32-characters" }),
    });
    const listener = await new Promise<Server>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    try {
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/auth/challenge`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${attempt + 1}` },
          body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }),
        });
        assert.equal(response.status, attempt === 10 ? 429 : 200);
      }
      assert.deepEqual(logged.mock.calls.map((call) => (call.arguments[0] as { code?: string } | undefined)?.code), ["ERR_ERL_UNEXPECTED_X_FORWARDED_FOR"]);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });
});
