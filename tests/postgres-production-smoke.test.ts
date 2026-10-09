import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresClaimFundingRepository } from "../server/claim-funding-service";
import { PostgresPaymentRepository } from "../server/payment-history-service";
import { PostgresIdentityRepository } from "../server/postgres-identity-repository";
import { PostgresTransientStateStore } from "../server/transient-state-store";
import { PostgresStockTransferRepository } from "../server/stock-transfer-service";
import { migrateDatabase, postgresStores, verifyDatabaseSchema } from "../server/database";
import { ledgerCursor, PostgresSpRepository, SpService } from "../server/sp-service";
import { PostgresAdminRecords } from "../server/admin-records";
import { PostgresSolanaTransferRepository } from "../server/solana-transfer-service";
import { DeskControls } from "../server/desk-controls";
import { DEFAULT_SP_RULES } from "../src/domain/sp";

const databaseUrl = process.env.REAL_DATABASE_URL;
const schema = `hapapay_smoke_${process.pid}_${Date.now()}`;

describe("real PostgreSQL persistence smoke", { skip: !databaseUrl }, () => {
  let admin: Pool;
  let pool: Pool;

  before(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = scopedPool();
  });

  after(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("migrates and preserves identities, one-time state, payments, claim metadata, and stock transfers across restart", async () => {
    const identity = new PostgresIdentityRepository(pool);
    const transient = new PostgresTransientStateStore(pool);
    const payments = new PostgresPaymentRepository(pool);
    const claims = new PostgresClaimFundingRepository(pool);
    const stockTransfers = new PostgresStockTransferRepository(pool);
    // Every repository's migration, as production runs it: the schema check covers every table.
    await migrateDatabase(pool);
    await verifyDatabaseSchema(pool);

    const wallet = "0x1111111111111111111111111111111111111111" as const;
    await identity.link(wallet, {
      platform: "github",
      providerUserId: "real-pg-583231",
      username: "Real-PG-User",
      verifiedAt: "2026-09-14T08:00:00.000Z",
    });
    await transient.put("oauth", "restart-state", { wallet, provider: "github" }, Date.now() + 60_000);
    const payment = {
      chainId: 5_042,
      transactionHash: `0x${"ab".repeat(32)}` as const,
      sender: wallet,
      recipient: "0x2222222222222222222222222222222222222222" as const,
      platform: "github" as const,
      username: "recipient",
      amount: "4.5",
      blockNumber: 101n,
      confirmedAt: "2026-09-14T08:01:00.000Z",
      sourcePlatform: "github" as const,
      sourceUsername: "real-pg-user",
    };
    await payments.save(payment);
    const claim = {
      chainId: 5_042,
      transactionHash: `0x${"cd".repeat(32)}` as const,
      paymentId: `0x${"ef".repeat(32)}` as const,
      payer: wallet,
      recipientPlatform: "x" as const,
      recipientUsername: "outside-user",
      amount: "2.25",
      expiry: 1_900_000_000n,
      blockNumber: 102n,
      confirmedAt: "2026-09-14T08:02:00.000Z",
      sourceIdentity: { platform: "github" as const, username: "real-pg-user" },
    };
    await claims.save(claim);
    const stockTransfer = {
      chainId: 46630,
      transactionHash: `0x${"ab".repeat(32)}` as const,
      tokenAddress: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" as const,
      tokenSymbol: "TSLA",
      sender: wallet,
      recipient: "0x2222222222222222222222222222222222222222" as const,
      platform: "x" as const,
      username: "recipient",
      amount: "0.5",
      units: 500_000_000_000_000_000n,
      blockNumber: 103n,
      confirmedAt: "2026-09-14T08:03:00.000Z",
      sourcePlatform: "github" as const,
      sourceUsername: "real-pg-user",
    };
    await stockTransfers.save(stockTransfer);

    await pool.end();
    pool = scopedPool();
    const restartedIdentity = new PostgresIdentityRepository(pool);
    const restartedTransient = new PostgresTransientStateStore(pool);
    const restartedPayments = new PostgresPaymentRepository(pool);
    const restartedClaims = new PostgresClaimFundingRepository(pool);
    const restartedStockTransfers = new PostgresStockTransferRepository(pool);

    assert.equal(await restartedIdentity.resolve("github", "@REAL-PG-USER"), wallet);
    assert.deepEqual(await restartedIdentity.account(wallet, "github"), {
      platform: "github",
      providerUserId: "real-pg-583231",
      username: "real-pg-user",
      verifiedAt: "2026-09-14T08:00:00.000Z",
    });
    assert.deepEqual(await restartedTransient.get("oauth", "restart-state"), { wallet, provider: "github" });
    assert.deepEqual(await restartedPayments.list(5_042, wallet), [payment]);
    assert.deepEqual(await restartedClaims.get(5_042, claim.paymentId), claim);
    assert.deepEqual(await restartedStockTransfers.list(wallet), [stockTransfer]);

    const consumed = await Promise.all([
      restartedTransient.take("oauth", "restart-state"),
      restartedTransient.take("oauth", "restart-state"),
    ]);
    assert.equal(consumed.filter(Boolean).length, 1);
    await assert.rejects(() => restartedPayments.save(payment), /already confirmed/);
    await assert.rejects(() => restartedClaims.save({
      ...claim,
      transactionHash: `0x${"12".repeat(32)}`,
    }), /already recorded/);
    await assert.rejects(() => restartedStockTransfers.save(stockTransfer), /already confirmed/);
    // The Arc payment above shares this hash; stock history is keyed by chain, so another chain still records.
    await restartedStockTransfers.save({ ...stockTransfer, chainId: 4663 });
  });

  // SP and the admin panel: what a real database must guarantee.
  it("keeps every SP row, rule version and audit entry: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await migrateDatabase(pool);
    await migrateDatabase(pool);
    await verifyDatabaseSchema(pool);
    const stores = postgresStores(pool);
    const sp = new SpService({ repository: stores.spRepository, rulesCacheMs: 0 });
    const wallet = "0x3333333333333333333333333333333333333333" as const;
    const award = await sp.awardPayment({
      account: wallet, network: "solana", sourceKey: "solana:smoke:0", counterparty: "0x4444444444444444444444444444444444444444",
      amount: { symbol: "USDC", assetClass: "stable", amount: "25" }, detail: "25 USDC", at: new Date("2026-10-05T10:00:00Z"),
    });
    assert.deepEqual(award, { awarded: 25 + 10 });
    // SP count in tenths: the database keeps 12.7 exactly, and sums it exactly.
    const tenth = await sp.awardPayment({
      account: wallet, network: "solana", sourceKey: "solana:smoke:1", counterparty: "0x4444444444444444444444444444444444444444",
      amount: { symbol: "USDC", assetClass: "stable", amount: "12.75" }, detail: "12.75 USDC", at: new Date("2026-10-05T10:05:00Z"),
    });
    assert.deepEqual(tenth, { awarded: 12.7 });
    assert.equal((await pool.query("SELECT amount::text AS amount FROM sp_ledger WHERE source_key = 'solana:smoke:1'")).rows[0].amount, "12.7");
    await stores.adminAuditRepository.record({ actor: wallet, action: "notice.set", details: { text: "Hello" } });
    for (const table of ["sp_ledger", "sp_rules", "admin_audit_log"]) {
      await assert.rejects(() => pool.query(`UPDATE ${table} SET created_at = now()`), /keeps every row/, `${table} refuses UPDATE`);
      await assert.rejects(() => pool.query(`DELETE FROM ${table}`), /keeps every row/, `${table} refuses DELETE`);
      await assert.rejects(() => pool.query(`TRUNCATE ${table} CASCADE`), /keeps every row/, `${table} refuses TRUNCATE`);
    }
    assert.equal(await stores.spRepository.balance(wallet), 47.7, "nothing was lost");
    assert.deepEqual((await stores.spRepository.rulesAt(new Date(0))).rules, DEFAULT_SP_RULES, "version 1 is the starting rules");
    await assert.rejects(() => pool.query("INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version) VALUES ($1, 'adjustment', 1, 'solana:smoke:0', 'x', 1)", [wallet]), /duplicate key/, "a source earns once");
    await assert.rejects(() => pool.query("INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version) VALUES ($1, 'gift', 1, 'gift:1', 'x', 1)", [wallet]), /check constraint/, "only known kinds");
    await assert.rejects(() => pool.query("INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version) VALUES ($1, 'adjustment', 1, 'adjust:x', 'x', 99)", [wallet]), /foreign key/, "only saved rule versions");
  });

  it("awards concurrent payments one at a time per account, so the cap holds across connections", async () => {
    await migrateDatabase(pool);
    const stores = postgresStores(pool);
    const sp = new SpService({ repository: stores.spRepository, rulesCacheMs: 0 });
    const saved = await sp.saveRules({ actor: "smoke", rules: { ...DEFAULT_SP_RULES, dailyCap: 100.5, pairDailyLimit: 1_000 } });
    assert.ok(saved.version >= 2);
    const wallet = "0x5555555555555555555555555555555555555555" as const;
    const at = new Date(Date.now() + 60_000);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => sp.awardPayment({
      account: wallet, network: "arc", sourceKey: `arc:concurrent:${index}`, counterparty: "0x6666666666666666666666666666666666666666",
      amount: { symbol: "USDC", assetClass: "stable", amount: "25" }, fee: { units: 250_000n, paymentUnits: 25_000_000n }, detail: "25 USDC", at,
    })));
    assert.equal(results.reduce((sum, result) => sum + result.awarded, 0), 100.5 + 10, "the daily cap (four payments and half an SP of the fifth) and the first-payment bonus, no more");
    assert.equal(await stores.spRepository.balance(wallet), 110.5);
    const page = await stores.spRepository.ledger({ account: wallet, limit: 5, includeZero: true });
    const next = await stores.spRepository.ledger({ account: wallet, limit: 20, includeZero: true, before: `${page[4].createdAt}|${page[4].id}` });
    assert.equal(page.length + next.length, 13, "twelve payments and the bonus, each listed once");
    assert.equal(new Set([...page, ...next].map((row) => row.id)).size, 13);
  });

  it("moves a database that ran the first SP SQL to tenths, the rescaled starting rules (only while nothing is earned) and invites", async () => {
    for (const earned of [false, true]) {
      const legacy = `${schema}_first_sp_${earned ? "earned" : "empty"}`;
      await admin.query(`CREATE SCHEMA ${legacy}`);
      const legacyPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${legacy}` });
      try {
        await firstSpSql(legacyPool);
        if (earned) await legacyPool.query("INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version) VALUES ('0x7777777777777777777777777777777777777777', 'payment', 255, 'arc:0x01', '25 USDC', 1)");
        await migrateDatabase(legacyPool);
        await migrateDatabase(legacyPool);
        await verifyDatabaseSchema(legacyPool);
        const column = await legacyPool.query("SELECT pg_catalog.format_type(atttypid, atttypmod) AS type FROM pg_catalog.pg_attribute WHERE attrelid = 'sp_ledger'::regclass AND attname = 'amount'");
        assert.equal(column.rows[0].type, "numeric(14,1)");
        const stores = postgresStores(legacyPool);
        const history = await stores.spRepository.rulesHistory(10);
        assert.equal(history.length, 1, "no extra version");
        if (earned) {
          assert.equal(history[0].rules.perDollar, 10, "once anything is earned, version 1 stays as it was");
          assert.equal(await stores.spRepository.balance("0x7777777777777777777777777777777777777777"), 255, "every row keeps its value");
        } else {
          assert.deepEqual(history[0].rules, DEFAULT_SP_RULES, "nothing was earned, so version 1 takes the rescaled rules");
        }
        await assert.rejects(() => legacyPool.query("UPDATE sp_rules SET note = 'changed'"), /keeps every row/, "the trigger is back on");
        await assert.rejects(() => legacyPool.query("TRUNCATE sp_ledger CASCADE"), /keeps every row/);
        await legacyPool.query("INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version) VALUES ('0x7777777777777777777777777777777777777777', 'referral', 1.5, 'referral:legacy', 'x', 1)");
        await assert.rejects(() => legacyPool.query("INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version) VALUES ('0x7777777777777777777777777777777777777777', 'gift', 1, 'gift:legacy', 'x', 1)"), /check constraint/, "the kinds took invites and nothing else");
      } finally {
        await legacyPool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
      }
    }
  });

  it("shares an invited account's SP and half the fee with its inviter once, keeps every invite row, and records a payout once", async () => {
    const own = `${schema}_invites`;
    await admin.query(`CREATE SCHEMA ${own}`);
    const ownPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${own}` });
    try {
      await migrateDatabase(ownPool);
      await verifyDatabaseSchema(ownPool);
      const stores = postgresStores(ownPool);
      const referrals = stores.referralStore;
      const sp = new SpService({ repository: stores.spRepository, referrals, rulesCacheMs: 0 });
      const inviter = "0x8888888888888888888888888888888888888888" as const;
      const invitee = "0x9999999999999999999999999999999999999999" as const;
      const other = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" as const;
      const code = await referrals.ensureCode(inviter);
      assert.equal(await referrals.ensureCode(inviter), code, "an account keeps its code");
      assert.equal(await referrals.accountOf(code), inviter);
      const binding = await referrals.bind({ invitee, referrer: inviter, code });
      assert.ok(binding);
      assert.equal((await referrals.bind({ invitee, referrer: other, code: await referrals.ensureCode(other) }))?.referrer, inviter, "an account joins once");
      await assert.rejects(() => ownPool.query("INSERT INTO sp_referrals (invitee, referrer, code) VALUES ($1, $1, $2)", [other, code]), /check constraint/, "never one's own inviter");
      assert.equal(await referrals.invitedCount(inviter), 1);
      // Two accounts joining with each other's code at the same moment: the pair's unique index lets only one of them join.
      const [first, second] = ["0x1212121212121212121212121212121212121212", "0x3434343434343434343434343434343434343434"] as const;
      const [firstCode, secondCode] = [await referrals.ensureCode(first), await referrals.ensureCode(second)];
      const both = await Promise.all([referrals.bind({ invitee: first, referrer: second, code: secondCode }), referrals.bind({ invitee: second, referrer: first, code: firstCode })]);
      assert.equal(both.filter(Boolean).length, 1, "one joins, the other is refused as a cycle");
      await assert.rejects(() => ownPool.query("INSERT INTO sp_referrals (invitee, referrer, code) VALUES ($1, $2, $3)", both[0] ? [second, first, firstCode] : [first, second, secondCode]), /duplicate key/);

      // $200 on Solana with its verified 1% fee ($2), after the invite: 200 SP and 10 for a first payment; 15% of each to
      // the inviter, and half of the fee in USDC.
      const at = new Date(Date.parse(binding.createdAt) + 1_000);
      await sp.awardPayment({
        account: invitee, network: "solana", sourceKey: "solana:invite:0", counterparty: "0x4444444444444444444444444444444444444444",
        amount: { symbol: "USDC", assetClass: "stable", amount: "200" }, fee: { units: 2_000_000n, paymentUnits: 200_000_000n }, detail: "200 USDC", at,
      });
      assert.equal((await stores.spRepository.entryBySource("solana:invite:0"))?.feeUsdUnits, 2_000_000, "the fee's dollar value is kept to the millionth");
      // The same payment without a verified fee (a plain transfer) earns its sender SP but its inviter no USDC.
      await sp.awardPayment({
        account: invitee, network: "solana", sourceKey: "solana:invite:nofee", counterparty: "0x5555555555555555555555555555555555555555",
        amount: { symbol: "USDC", assetClass: "stable", amount: "50" }, detail: "50 USDC", at,
      });
      assert.equal(await stores.spRepository.balance(invitee), 260);
      assert.equal(await stores.spRepository.balance(inviter), 39);
      assert.deepEqual(await referrals.feeTotals(inviter), { earned: 1_000_000n, paid: 0n });
      assert.equal(await sp.referralCatchUp(invitee), 0, "nothing is shared twice");
      assert.deepEqual(await referrals.owed(1_000_000n, 10), [{ referrer: inviter, owed: 1_000_000n }]);
      assert.equal((await sp.referralSummary(inviter))?.sp, 39);

      const solana = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
      const batch = await referrals.saveBatch({
        id: "0123456789abcdef", payer: solana, items: [{ referrer: inviter, address: solana, units: "1000000" }], totalUnits: "1000000", lastValidBlockHeight: "250", createdBy: inviter,
      });
      assert.deepEqual((await referrals.batch(batch.id))?.items, [{ referrer: inviter, address: solana, units: "1000000" }]);
      const payout = { batch: batch.id, referrer: inviter, address: solana, units: "1000000", signature: "smoke-signature", paidBy: inviter };
      assert.equal(await referrals.savePayouts([payout]), 1);
      assert.equal(await referrals.savePayouts([payout]), 0, "a batch pays each inviter once");
      assert.deepEqual(await referrals.feeTotals(inviter), { earned: 1_000_000n, paid: 1_000_000n });
      assert.deepEqual(await referrals.owed(1n, 10), []);

      // Reversing the payment takes back the SP it gave the inviter and its USDC reward: paid already, so it is owed back.
      const payment = await stores.spRepository.entryBySource("solana:invite:0");
      assert.ok(payment);
      await sp.reverse({ actor: "smoke", entryId: payment.id, reason: "Smoke test" });
      assert.equal(await stores.spRepository.balance(inviter), 9, "the shares of the first-payment bonus and the fee-less payment are left");
      assert.deepEqual(await referrals.feeTotals(inviter), { earned: 0n, paid: 1_000_000n });
      assert.equal((await referrals.feeReward("fee-reverse:solana:invite:0"))?.units, -1_000_000n);
      assert.deepEqual(await referrals.owed(1n, 10), []);
      assert.equal((await sp.referralSummary(inviter))?.fees.owed, "-1000000");
      assert.deepEqual(await referrals.totals(), { invites: 2, earned: 0n, paid: 1_000_000n }, "the invite above and one of the pair");
      const reward = (value: string, units: number) => ownPool.query(
        "INSERT INTO referral_fee_rewards (source_key, referrer, invitee, network, payment_usd_cents, usdc_units, sp_entry_id, rules_version, created_at) VALUES ($1, $2, $3, 'solana', 100, $4, $5, 1, now())",
        [value, inviter, invitee, units, payment.id],
      );
      await assert.rejects(() => reward("fee:solana:negative:0", -1), /check constraint/, "a reward is never negative");
      await assert.rejects(() => reward("fee-reverse:solana:positive:0", 1), /check constraint/, "a reversal always is");
      await assert.rejects(() => reward("gift:solana:0", 1), /check constraint/, "only rewards and their reversals");

      for (const table of ["sp_referral_codes", "sp_referrals", "referral_fee_rewards", "referral_payout_batches", "referral_fee_payouts"]) {
        await assert.rejects(() => ownPool.query(`UPDATE ${table} SET created_at = now()`), /keeps every row/, `${table} refuses UPDATE`);
        await assert.rejects(() => ownPool.query(`DELETE FROM ${table}`), /keeps every row/, `${table} refuses DELETE`);
        await assert.rejects(() => ownPool.query(`TRUNCATE ${table} CASCADE`), /keeps every row/, `${table} refuses TRUNCATE`);
      }
      assert.equal(await stores.spRepository.balance(inviter), 9, "nothing was lost");
    } finally {
      await ownPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${own} CASCADE`);
    }
  });

  it("reads the admin panel's views across every table and keeps settings per key", async () => {
    await migrateDatabase(pool);
    const stores = postgresStores(pool);
    const controls = new DeskControls(stores.adminSettingsRepository, 0);
    await controls.setPause({ feature: "solana.vault", paused: true, message: "Upgrading", actor: "smoke" });
    await controls.setPause({ feature: "arc.payments", paused: true, actor: "smoke" });
    await controls.setPause({ feature: "arc.payments", paused: false, actor: "smoke" });
    await controls.setNotice({ text: "Back soon", tone: "info", actor: "smoke" });
    const view = await controls.view();
    assert.deepEqual(Object.keys(view.paused), ["solana.vault"]);
    assert.equal(view.notice?.text, "Back soon");
    const counts = await stores.adminRecords.counts();
    assert.equal(typeof counts.payments.solana, "number");
    const accounts = await stores.adminRecords.accounts(undefined, 100);
    assert.ok(accounts.wallets.length >= 1);
    assert.ok(Array.isArray(await stores.adminRecords.activity({ kind: "payment", limit: 10 })));
    assert.ok(Array.isArray(await stores.adminRecords.activity({ kind: "vault_link", limit: 10, wallet: "0x3333333333333333333333333333333333333333" })));
    const audit = await stores.adminAuditRepository.list({ limit: 10, action: "notice.set" });
    assert.ok(audit.length >= 1);
  });

  function scopedPool() {
    return new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  }

  it("pages the SP ledger and the admin activity without skipping rows of the same moment", async () => {
    // Audit, 2026-10-06: a ledger cursor in milliseconds skipped rows the database stamped microseconds apart, and an
    // activity cursor of the time alone skipped the rest of a Solana batch, whose payments share one time.
    await migrateDatabase(pool);
    const account = "0x7777777777777777777777777777777777777777";
    await pool.query(`INSERT INTO sp_ledger (account, kind, amount, source_key, detail, rules_version, created_at) VALUES
      ($1, 'adjustment', 5, 'adjust:page-a', 'Added by HaPaPay', 1, '2026-10-05T12:00:00.123400Z'),
      ($1, 'adjustment', 7, 'adjust:page-b', 'Added by HaPaPay', 1, '2026-10-05T12:00:00.123456Z')`, [account]);
    const ledger = new PostgresSpRepository(pool);
    const first = await ledger.ledger({ account: account as never, limit: 1, includeZero: true });
    assert.equal(first[0].sourceKey, "adjust:page-b");
    const second = await ledger.ledger({ account: account as never, limit: 1, includeZero: true, before: ledgerCursor(first[0]) });
    assert.deepEqual(second.map((row) => row.sourceKey), ["adjust:page-a"]);

    const transfers = new PostgresSolanaTransferRepository(pool);
    const base = {
      signature: "page-batch", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenSymbol: "USDC", senderWallet: "0x1111111111111111111111111111111111111111" as const,
      senderAddress: "S", platform: "github", amount: "1", units: "1000000", feeUnits: "10000", slot: 5n, confirmedAt: "2026-10-05T12:00:00.000Z",
    };
    await transfers.save([0, 1, 2].map((index) => ({ ...base, paymentIndex: index, recipientWallet: `0x${String(index + 2).repeat(40)}` as `0x${string}`, recipientAddress: `R${index}`, username: `user${index}` })));
    const records = new PostgresAdminRecords(pool);
    const page = await records.activity({ kind: "payment", limit: 2 });
    const last = page.at(-1)!;
    const next = await records.activity({ kind: "payment", limit: 2, before: `${last.confirmedAt}|${last.id}` });
    assert.deepEqual([...page, ...next].map((row) => row.id).filter((id) => id.startsWith("page-batch")).sort(), ["page-batch:0", "page-batch:1", "page-batch:2"]);
  });
});

/** SP's tables as the first SP SQL (2026-10-05, before the rescale) made them: whole SP and the first starting rules. */
async function firstSpSql(pool: Pool) {
  const firstRules = {
    earning: true, perDollar: 10, perPayment: 5, claimPerDollar: 5, minUsd: 1, dailyCap: 20_000, pairDailyLimit: 5,
    networks: { solana: 1, arc: 1, robinhood: 1 }, assets: { stable: 1, crypto: 1, stock: 1 },
    bonuses: { firstPayment: 100, linkedAccount: 25, solanaAddress: 25, firstClaim: 100, inviteClaimed: 50 }, inviteMonthlyLimit: 20, boost: null,
  };
  await pool.query(`CREATE OR REPLACE FUNCTION hapapay_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'HaPaPay keeps every row of %: rows can be added, never changed or removed', TG_TABLE_NAME;
    END
    $$`);
  await pool.query("CREATE TABLE sp_rules (version INTEGER PRIMARY KEY CHECK (version > 0), rules JSONB NOT NULL, created_by TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("INSERT INTO sp_rules (version, rules, created_by, note) VALUES (1, $1::jsonb, 'system', 'Starting rules')", [JSON.stringify(firstRules)]);
  await pool.query(`CREATE TABLE sp_ledger (
    id BIGSERIAL PRIMARY KEY, account TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('payment', 'claim', 'invite', 'first_payment', 'first_claim', 'linked_account', 'solana_address', 'adjustment', 'reversal')),
    amount BIGINT NOT NULL, source_key TEXT NOT NULL UNIQUE, network TEXT CHECK (network IN ('solana', 'arc', 'robinhood')), usd_cents BIGINT,
    counterparty TEXT, detail TEXT NOT NULL, rules_version INTEGER NOT NULL REFERENCES sp_rules (version), actor TEXT, reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const table of ["sp_rules", "sp_ledger"]) {
    await pool.query(`CREATE OR REPLACE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hapapay_append_only()`);
    await pool.query(`CREATE OR REPLACE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION hapapay_append_only()`);
  }
}
