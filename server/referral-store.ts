import { randomInt } from "node:crypto";
import { getAddress, type Address } from "viem";
import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_PATTERN } from "../src/domain/referrals.js";
import type { SpNetwork } from "../src/domain/sp.js";
import { appendOnlyTriggers } from "./append-only.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlClient = { query(text: string, values?: unknown[]): Promise<SqlResult> };

/**
 * Invites: who invited whom, what each inviter is owed in USDC and what was paid. Every
 * table only grows (the append-only trigger): an invite is never moved to another inviter, a reward never changes,
 * and a payout is a row written only after its transaction was read back from Solana. What an inviter is owed is the
 * sum of its rewards less the sum of its payouts, so there is no balance to fall out of step.
 */
export type ReferralBinding = { invitee: Address; referrer: Address; code: string; createdAt: string };

export type FeeRewardDraft = {
  /**
   * `fee:` and the source key of the invited account's payment row, so a payment rewards once; `fee-reverse:` and the
   * same key for taking that reward back when the payment's SP entry is reversed (negative units, once).
   */
  sourceKey: string;
  referrer: Address;
  invitee: Address;
  network: SpNetwork;
  paymentUsdCents: number;
  /** USDC base units (6 decimals); negative only for a reversal. */
  units: bigint;
  spEntryId: string;
  rulesVersion: number;
  reason: string | null;
  createdAt: Date;
};
export type FeeReward = Omit<FeeRewardDraft, "createdAt"> & { id: string; createdAt: string };

export type PayoutItem = { referrer: Address; address: string; units: string };
export type PayoutBatch = { id: string; payer: string; items: PayoutItem[]; totalUnits: string; lastValidBlockHeight: string; createdBy: string; createdAt: string };
export type Payout = { id: string; batch: string; referrer: Address; address: string; units: string; signature: string; paidBy: string; createdAt: string };

export interface ReferralStore {
  codeOf(account: Address): Promise<string | undefined>;
  accountOf(code: string): Promise<Address | undefined>;
  /** The account's code, made the first time it is asked for. */
  ensureCode(account: Address): Promise<string>;
  referrerOf(invitee: Address): Promise<ReferralBinding | undefined>;
  /**
   * Writes the invite once; an account that already has an inviter keeps it, and that one is returned. Undefined when
   * the inviter was invited by this account (two accounts never invite each other, even when both join at once).
   */
  bind(binding: Omit<ReferralBinding, "createdAt">): Promise<ReferralBinding | undefined>;
  invitedCount(referrer: Address): Promise<number>;
  invitees(referrer: Address, limit: number): Promise<ReferralBinding[]>;
  /** True when the reward was written; false when its source key already was. */
  insertFeeReward(draft: FeeRewardDraft): Promise<boolean>;
  feeReward(sourceKey: string): Promise<FeeReward | undefined>;
  feeRewardKeys(keys: string[]): Promise<Set<string>>;
  feeTotals(referrer: Address): Promise<{ earned: bigint; paid: bigint }>;
  /** Inviters owed at least `minimum` units, most owed first. */
  owed(minimum: bigint, limit: number, offset?: number): Promise<Array<{ referrer: Address; owed: bigint }>>;
  totals(): Promise<{ invites: number; earned: bigint; paid: bigint }>;
  saveBatch(batch: Omit<PayoutBatch, "createdAt">): Promise<PayoutBatch>;
  batch(id: string): Promise<PayoutBatch | undefined>;
  batches(limit: number): Promise<PayoutBatch[]>;
  /** Writes a batch's payouts once (one per inviter per batch); returns how many were new. */
  savePayouts(payouts: Array<Omit<Payout, "id" | "createdAt">>): Promise<number>;
  payoutsOf(batch: string): Promise<Payout[]>;
}

/** A new code: eight characters drawn evenly from the alphabet with the system's secure random source. */
export function newReferralCode() {
  return Array.from({ length: 8 }, () => REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)]).join("");
}

const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
/** A reward is never negative; its reversal always is. */
const signFits = (draft: Pick<FeeRewardDraft, "sourceKey" | "units">) => (draft.sourceKey.startsWith("fee-reverse:") ? draft.units < 0n : draft.sourceKey.startsWith("fee:") && draft.units >= 0n);

export class MemoryReferralStore implements ReferralStore {
  private readonly codes = new Map<string, { account: Address; createdAt: string }>();
  private readonly bindings = new Map<Address, ReferralBinding>();
  private readonly rewards: FeeReward[] = [];
  private readonly batchRows: PayoutBatch[] = [];
  private readonly payouts: Payout[] = [];

  constructor(private readonly now: () => Date = () => new Date(), private readonly makeCode: () => string = newReferralCode) {}

  async codeOf(account: Address) {
    return [...this.codes].find(([, value]) => value.account === account)?.[0];
  }

  async accountOf(code: string) {
    return this.codes.get(code)?.account;
  }

  async ensureCode(account: Address) {
    const existing = await this.codeOf(account);
    if (existing) return existing;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = this.makeCode();
      if (!REFERRAL_CODE_PATTERN.test(code) || this.codes.has(code)) continue;
      this.codes.set(code, { account, createdAt: this.now().toISOString() });
      return code;
    }
    throw new Error("No free invite code was found.");
  }

  async referrerOf(invitee: Address) {
    const binding = this.bindings.get(invitee);
    return binding ? { ...binding } : undefined;
  }

  async bind(input: Omit<ReferralBinding, "createdAt">) {
    const existing = this.bindings.get(input.invitee);
    if (existing) return { ...existing };
    if (input.invitee === input.referrer || this.codes.get(input.code)?.account !== input.referrer) throw new Error("The invite does not match its code.");
    if (this.bindings.get(input.referrer)?.referrer === input.invitee) return undefined;
    const binding = { ...input, createdAt: this.now().toISOString() };
    this.bindings.set(input.invitee, binding);
    return { ...binding };
  }

  async invitedCount(referrer: Address) {
    return [...this.bindings.values()].filter((binding) => binding.referrer === referrer).length;
  }

  async invitees(referrer: Address, limit: number) {
    return [...this.bindings.values()].filter((binding) => binding.referrer === referrer)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit).map((binding) => ({ ...binding }));
  }

  async insertFeeReward(draft: FeeRewardDraft) {
    if (!signFits(draft)) throw new Error("A reward is never negative and its reversal always is.");
    if (this.rewards.some((reward) => reward.sourceKey === draft.sourceKey)) return false;
    this.rewards.push({ ...draft, id: String(this.rewards.length + 1), createdAt: draft.createdAt.toISOString() });
    return true;
  }

  async feeReward(sourceKey: string) {
    const reward = this.rewards.find((candidate) => candidate.sourceKey === sourceKey);
    return reward ? { ...reward } : undefined;
  }

  async feeRewardKeys(keys: string[]) {
    const wanted = new Set(keys);
    return new Set(this.rewards.filter((reward) => wanted.has(reward.sourceKey)).map((reward) => reward.sourceKey));
  }

  async feeTotals(referrer: Address) {
    return {
      earned: sum(this.rewards.filter((reward) => reward.referrer === referrer).map((reward) => reward.units)),
      paid: sum(this.payouts.filter((payout) => payout.referrer === referrer).map((payout) => BigInt(payout.units))),
    };
  }

  async owed(minimum: bigint, limit: number, offset = 0) {
    const referrers = [...new Set(this.rewards.map((reward) => reward.referrer))];
    const balances = await Promise.all(referrers.map(async (referrer) => {
      const totals = await this.feeTotals(referrer);
      return { referrer, owed: totals.earned - totals.paid };
    }));
    return balances.filter((entry) => entry.owed >= minimum && entry.owed > 0n)
      .sort((left, right) => (left.owed === right.owed ? left.referrer.localeCompare(right.referrer) : left.owed > right.owed ? -1 : 1)).slice(offset, offset + limit);
  }

  async totals() {
    return { invites: this.bindings.size, earned: sum(this.rewards.map((reward) => reward.units)), paid: sum(this.payouts.map((payout) => BigInt(payout.units))) };
  }

  async saveBatch(batch: Omit<PayoutBatch, "createdAt">) {
    if (this.batchRows.some((row) => row.id === batch.id)) throw new Error("A payout batch with this ID exists.");
    const row = { ...structuredClone(batch), createdAt: this.now().toISOString() };
    this.batchRows.push(row);
    return structuredClone(row);
  }

  async batch(id: string) {
    const row = this.batchRows.find((candidate) => candidate.id === id);
    return row ? structuredClone(row) : undefined;
  }

  async batches(limit: number) {
    return [...this.batchRows].reverse().slice(0, limit).map((row) => structuredClone(row));
  }

  async savePayouts(rows: Array<Omit<Payout, "id" | "createdAt">>) {
    let written = 0;
    for (const row of rows) {
      if (this.payouts.some((payout) => payout.batch === row.batch && payout.referrer === row.referrer)) continue;
      this.payouts.push({ ...row, id: String(this.payouts.length + 1), createdAt: this.now().toISOString() });
      written++;
    }
    return written;
  }

  async payoutsOf(batch: string) {
    return this.payouts.filter((payout) => payout.batch === batch).map((payout) => ({ ...payout }));
  }
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const bindingRow = (row: Record<string, unknown>): ReferralBinding => ({ invitee: getAddress(String(row.invitee)), referrer: getAddress(String(row.referrer)), code: String(row.code), createdAt: iso(row.created_at) });
const batchRow = (row: Record<string, unknown>): PayoutBatch => ({
  id: String(row.id),
  payer: String(row.payer),
  items: (typeof row.items === "string" ? JSON.parse(row.items) : row.items) as PayoutItem[],
  totalUnits: String(row.total_units),
  lastValidBlockHeight: String(row.last_valid_block_height),
  createdBy: String(row.created_by),
  createdAt: iso(row.created_at),
});
const rewardRow = (row: Record<string, unknown>): FeeReward => ({
  id: String(row.id), sourceKey: String(row.source_key), referrer: getAddress(String(row.referrer)), invitee: getAddress(String(row.invitee)),
  network: String(row.network) as SpNetwork, paymentUsdCents: Number(row.payment_usd_cents), units: BigInt(String(row.usdc_units)), spEntryId: String(row.sp_entry_id),
  rulesVersion: Number(row.rules_version), reason: row.reason === null || row.reason === undefined ? null : String(row.reason), createdAt: iso(row.created_at),
});
const payoutRow = (row: Record<string, unknown>): Payout => ({
  id: String(row.id), batch: String(row.batch), referrer: getAddress(String(row.referrer)), address: String(row.solana_address),
  units: String(row.usdc_units), signature: String(row.signature), paidBy: String(row.paid_by), createdAt: iso(row.created_at),
});
/** PostgreSQL sums BIGINT as NUMERIC, which arrives as a string of whole units. */
const units = (value: unknown) => BigInt(String(value ?? "0").split(".")[0] || "0");

export class PostgresReferralStore implements ReferralStore {
  constructor(private readonly pool: SqlClient) {}

  /** Five tables, each only growing; the append-only function comes with SP's tables, which are migrated first. */
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sp_referral_codes (
        code TEXT PRIMARY KEY CHECK (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$'),
        account TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const statement of appendOnlyTriggers("sp_referral_codes")) await this.pool.query(statement);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sp_referrals (
        invitee TEXT PRIMARY KEY,
        referrer TEXT NOT NULL,
        code TEXT NOT NULL REFERENCES sp_referral_codes (code),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (invitee <> referrer)
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS sp_referrals_referrer_idx ON sp_referrals (referrer, created_at DESC)");
    // One invite per pair of accounts, in either direction: two accounts joining with each other's code at once cannot both join.
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS sp_referrals_pair_idx ON sp_referrals (LEAST(invitee, referrer), GREATEST(invitee, referrer))");
    for (const statement of appendOnlyTriggers("sp_referrals")) await this.pool.query(statement);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS referral_fee_rewards (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        referrer TEXT NOT NULL,
        invitee TEXT NOT NULL,
        network TEXT NOT NULL CHECK (network IN ('solana', 'arc', 'robinhood')),
        payment_usd_cents BIGINT NOT NULL CHECK (payment_usd_cents >= 0),
        usdc_units BIGINT NOT NULL,
        sp_entry_id BIGINT NOT NULL REFERENCES sp_ledger (id),
        rules_version INTEGER NOT NULL REFERENCES sp_rules (version),
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        CHECK ((source_key LIKE 'fee:%' AND usdc_units >= 0) OR (source_key LIKE 'fee-reverse:%' AND usdc_units < 0))
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS referral_fee_rewards_referrer_idx ON referral_fee_rewards (referrer, created_at DESC)");
    for (const statement of appendOnlyTriggers("referral_fee_rewards")) await this.pool.query(statement);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS referral_payout_batches (
        id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
        payer TEXT NOT NULL,
        items JSONB NOT NULL,
        total_units BIGINT NOT NULL CHECK (total_units > 0),
        last_valid_block_height BIGINT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const statement of appendOnlyTriggers("referral_payout_batches")) await this.pool.query(statement);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS referral_fee_payouts (
        id BIGSERIAL PRIMARY KEY,
        batch TEXT NOT NULL REFERENCES referral_payout_batches (id),
        referrer TEXT NOT NULL,
        solana_address TEXT NOT NULL,
        usdc_units BIGINT NOT NULL CHECK (usdc_units > 0),
        signature TEXT NOT NULL,
        paid_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (batch, referrer)
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS referral_fee_payouts_referrer_idx ON referral_fee_payouts (referrer, created_at DESC)");
    for (const statement of appendOnlyTriggers("referral_fee_payouts")) await this.pool.query(statement);
  }

  async codeOf(account: Address) {
    const row = (await this.pool.query("SELECT code FROM sp_referral_codes WHERE account = $1", [account])).rows[0];
    return row ? String(row.code) : undefined;
  }

  async accountOf(code: string) {
    const row = (await this.pool.query("SELECT account FROM sp_referral_codes WHERE code = $1", [code])).rows[0];
    return row ? getAddress(String(row.account)) : undefined;
  }

  async ensureCode(account: Address) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this.codeOf(account);
      if (existing) return existing;
      // A code taken by someone else, or a second request writing first, leaves nothing; the loop reads again.
      await this.pool.query("INSERT INTO sp_referral_codes (code, account) VALUES ($1, $2) ON CONFLICT DO NOTHING", [newReferralCode(), account]);
    }
    throw new Error("No free invite code was found.");
  }

  async referrerOf(invitee: Address) {
    const row = (await this.pool.query("SELECT * FROM sp_referrals WHERE invitee = $1", [invitee])).rows[0];
    return row ? bindingRow(row) : undefined;
  }

  async bind(input: Omit<ReferralBinding, "createdAt">) {
    // Either unique key may refuse the row: the invitee's own (it already joined) or the pair's (the other way round).
    await this.pool.query(
      `INSERT INTO sp_referrals (invitee, referrer, code)
       SELECT $1, $2, code FROM sp_referral_codes WHERE code = $3 AND account = $2
       ON CONFLICT DO NOTHING`,
      [input.invitee, input.referrer, input.code],
    );
    const binding = await this.referrerOf(input.invitee);
    if (binding) return binding;
    if ((await this.referrerOf(input.referrer))?.referrer === input.invitee) return undefined;
    throw new Error("The invite does not match its code.");
  }

  async invitedCount(referrer: Address) {
    return Number((await this.pool.query("SELECT COUNT(*) AS total FROM sp_referrals WHERE referrer = $1", [referrer])).rows[0]?.total ?? 0);
  }

  async invitees(referrer: Address, limit: number) {
    return (await this.pool.query("SELECT * FROM sp_referrals WHERE referrer = $1 ORDER BY created_at DESC LIMIT $2", [referrer, limit])).rows.map(bindingRow);
  }

  async insertFeeReward(draft: FeeRewardDraft) {
    const result = await this.pool.query(
      `INSERT INTO referral_fee_rewards (source_key, referrer, invitee, network, payment_usd_cents, usdc_units, sp_entry_id, rules_version, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_key) DO NOTHING RETURNING id`,
      [draft.sourceKey, draft.referrer, draft.invitee, draft.network, draft.paymentUsdCents, draft.units.toString(), draft.spEntryId, draft.rulesVersion, draft.reason, draft.createdAt.toISOString()],
    );
    return result.rows.length > 0;
  }

  async feeReward(sourceKey: string) {
    const row = (await this.pool.query("SELECT * FROM referral_fee_rewards WHERE source_key = $1", [sourceKey])).rows[0];
    return row ? rewardRow(row) : undefined;
  }

  async feeRewardKeys(keys: string[]) {
    if (!keys.length) return new Set<string>();
    const result = await this.pool.query("SELECT source_key FROM referral_fee_rewards WHERE source_key = ANY($1::text[])", [keys]);
    return new Set(result.rows.map((row) => String(row.source_key)));
  }

  async feeTotals(referrer: Address) {
    const row = (await this.pool.query(
      `SELECT (SELECT COALESCE(SUM(usdc_units), 0) FROM referral_fee_rewards WHERE referrer = $1) AS earned,
              (SELECT COALESCE(SUM(usdc_units), 0) FROM referral_fee_payouts WHERE referrer = $1) AS paid`,
      [referrer],
    )).rows[0] ?? {};
    return { earned: units(row.earned), paid: units(row.paid) };
  }

  async owed(minimum: bigint, limit: number, offset = 0) {
    const result = await this.pool.query(
      `SELECT referrer, owed FROM (
         SELECT rewards.referrer, rewards.earned - COALESCE(paid.total, 0) AS owed
         FROM (SELECT referrer, SUM(usdc_units) AS earned FROM referral_fee_rewards GROUP BY referrer) AS rewards
         LEFT JOIN (SELECT referrer, SUM(usdc_units) AS total FROM referral_fee_payouts GROUP BY referrer) AS paid ON paid.referrer = rewards.referrer
       ) AS balances
       WHERE owed >= $1 AND owed > 0 ORDER BY owed DESC, referrer LIMIT $2 OFFSET $3`,
      [minimum.toString(), limit, offset],
    );
    return result.rows.map((row) => ({ referrer: getAddress(String(row.referrer)), owed: units(row.owed) }));
  }

  async totals() {
    const row = (await this.pool.query(
      `SELECT (SELECT COUNT(*) FROM sp_referrals) AS invites,
              (SELECT COALESCE(SUM(usdc_units), 0) FROM referral_fee_rewards) AS earned,
              (SELECT COALESCE(SUM(usdc_units), 0) FROM referral_fee_payouts) AS paid`,
    )).rows[0] ?? {};
    return { invites: Number(row.invites ?? 0), earned: units(row.earned), paid: units(row.paid) };
  }

  async saveBatch(batch: Omit<PayoutBatch, "createdAt">) {
    const result = await this.pool.query(
      `INSERT INTO referral_payout_batches (id, payer, items, total_units, last_valid_block_height, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING *`,
      [batch.id, batch.payer, JSON.stringify(batch.items), batch.totalUnits, batch.lastValidBlockHeight, batch.createdBy],
    );
    return batchRow(result.rows[0]);
  }

  async batch(id: string) {
    const row = (await this.pool.query("SELECT * FROM referral_payout_batches WHERE id = $1", [id])).rows[0];
    return row ? batchRow(row) : undefined;
  }

  async batches(limit: number) {
    return (await this.pool.query("SELECT * FROM referral_payout_batches ORDER BY created_at DESC, id DESC LIMIT $1", [limit])).rows.map(batchRow);
  }

  async savePayouts(rows: Array<Omit<Payout, "id" | "createdAt">>) {
    if (!rows.length) return 0;
    // One statement, so a batch's payouts are written together or not at all.
    const result = await this.pool.query(
      `INSERT INTO referral_fee_payouts (batch, referrer, solana_address, usdc_units, signature, paid_by)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[])
       ON CONFLICT (batch, referrer) DO NOTHING RETURNING id`,
      [rows.map((row) => row.batch), rows.map((row) => row.referrer), rows.map((row) => row.address), rows.map((row) => row.units), rows.map((row) => row.signature), rows.map((row) => row.paidBy)],
    );
    return result.rows.length;
  }

  async payoutsOf(batch: string) {
    return (await this.pool.query("SELECT * FROM referral_fee_payouts WHERE batch = $1 ORDER BY id", [batch])).rows.map(payoutRow);
  }
}
