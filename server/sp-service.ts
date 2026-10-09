import { randomUUID } from "node:crypto";
import { getAddress, type Address } from "viem";
import {
  DEFAULT_SP_RULES,
  REFERRAL_SOURCE_KINDS,
  SP_ADJUST_LIMIT,
  amountUsd,
  capped,
  cappedBy,
  isTenths,
  referralFeeUnits,
  referralSp,
  roundSp,
  validateSpRules,
  volumeSp,
  type SpAssetClass,
  type SpEntry,
  type SpEntryKind,
  type SpNetwork,
  type SpRules,
} from "../src/domain/sp.js";
import { platformName, type Platform } from "../src/domain/payment-intent.js";
import { APPEND_ONLY_FUNCTION, appendOnlyTriggers } from "./append-only.js";
import type { ReferralBinding, ReferralStore } from "./referral-store.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlClient = { query(text: string, values?: unknown[]): Promise<SqlResult> };
type SqlPool = SqlClient & { connect?: () => Promise<SqlClient & { release(): void }> };

/**
 * SP's ledger. Every award, bonus, adjustment and reversal is one row keyed by what earned it
 * (`source_key`), so the same payment can never earn twice however often it is recorded or synced; a balance is the sum
 * of an account's rows, so there is nothing to fall out of step. Amounts are SP in tenths (NUMERIC(14, 1) in
 * PostgreSQL, so sums are exact). Awards for one account run one at a time (an advisory lock in PostgreSQL) so the daily
 * cap and the per-person limit see every earlier award.
 */
export type SpLedgerRow = {
  id: string;
  account: Address;
  kind: SpEntryKind;
  amount: number;
  sourceKey: string;
  network: SpNetwork | null;
  usdCents: number | null;
  /**
   * For a payment: the dollar value, in millionths (USDC base units), of the 1% fee HaPaPay verified on chain when
   * it recorded the payment; null when no fee was verified (a transfer that did not go through HaPaPay's fee).
   * Invite rewards in USDC come only from this.
   */
  feeUsdUnits: number | null;
  counterparty: string | null;
  detail: string;
  rulesVersion: number;
  actor: string | null;
  reason: string | null;
  createdAt: string;
  /**
   * The row's time to the microsecond, as the database keeps it, for the next page's cursor: rows written with the
   * database's own clock carry microseconds that `createdAt` drops (audit, 2026-10-06: a cursor of milliseconds
   * skipped a row in the same millisecond). Absent where the store keeps milliseconds only.
   */
  cursorAt?: string;
};

export type SpLedgerDraft = Omit<SpLedgerRow, "id" | "createdAt" | "actor" | "reason" | "feeUsdUnits"> & { feeUsdUnits?: number | null; actor?: string | null; reason?: string | null; createdAt?: Date };
export type SpRulesVersion = { version: number; rules: SpRules; createdBy: string; note: string | null; createdAt: string };
export type SpFlags = { frozen: boolean; reason: string | null; updatedBy: string; updatedAt: string };

/** A stretch of time, `from` included and `to` not: one UTC day for the caps, one UTC month for invites. */
export type SpWindow = { from: Date; to: Date };

/** What an award can ask while it holds the account. */
export interface SpAccountTransaction {
  exists(sourceKey: string): Promise<boolean>;
  /** SP from these kinds in a window (the daily cap counts payments and claims). */
  sumIn(account: Address, kinds: SpEntryKind[], window: SpWindow): Promise<number>;
  /** Rows of a kind that earned SP in a window, for one counterparty or any. */
  countIn(account: Address, kind: SpEntryKind, window: SpWindow, counterparty?: string): Promise<number>;
  hasEntry(account: Address, kind: SpEntryKind, counterparty?: string): Promise<boolean>;
  frozen(account: Address): Promise<boolean>;
  /** The row, or undefined when its source key is already in the ledger. */
  insert(draft: SpLedgerDraft): Promise<SpLedgerRow | undefined>;
}

/** `before` is a cursor from `ledgerCursor` (time, then id), so a backfilled old payment sits in its own place. */
export type SpLedgerFilter = { limit: number; before?: string; account?: Address; kind?: SpEntryKind; since?: Date; includeZero?: boolean };

export const ledgerCursor = (row: Pick<SpLedgerRow, "createdAt" | "id" | "cursorAt">) => `${row.cursorAt ?? row.createdAt}|${row.id}`;
const parseCursor = (cursor: string | undefined) => {
  const [time, id] = (cursor ?? "").split("|");
  // An ISO time in UTC with up to six decimals of a second; the exact text goes to the database.
  return cursor && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(time ?? "") && Number.isFinite(Date.parse(time)) && /^\d{1,18}$/.test(id ?? "")
    ? { time: new Date(time), text: time, id }
    : undefined;
};

export interface SpRepository {
  withAccount<T>(account: Address, work: (transaction: SpAccountTransaction) => Promise<T>): Promise<T>;
  rules(): Promise<SpRulesVersion>;
  rulesAt(at: Date): Promise<SpRulesVersion>;
  rulesHistory(limit: number): Promise<SpRulesVersion[]>;
  saveRules(rules: SpRules, actor: string, note: string | null): Promise<SpRulesVersion>;
  balance(account: Address): Promise<number>;
  /** SP an account earned from payments and claims since a moment (the daily cap's count). */
  volumeSince(account: Address, since: Date): Promise<number>;
  entry(id: string): Promise<SpLedgerRow | undefined>;
  /** The row a source key earned, if any. */
  entryBySource(sourceKey: string): Promise<SpLedgerRow | undefined>;
  /** An account's SP of one kind, all time (what its invites earned, for one). */
  /** The SP rows of one kind add up to, less their reversals. */
  kindTotal(account: Address, kind: SpEntryKind): Promise<number>;
  ledger(filter: SpLedgerFilter): Promise<SpLedgerRow[]>;
  sourceKeys(keys: string[]): Promise<Set<string>>;
  leaderboard(limit: number): Promise<Array<{ account: Address; balance: number }>>;
  /** Accounts with any SP row, in address order after `after`. */
  accounts(after: string | undefined, limit: number): Promise<{ wallets: Address[]; next: string | null }>;
  totals(since: Date): Promise<{ issued: number; taken: number; holders: number; today: number; entries: number }>;
  flags(account: Address): Promise<SpFlags | undefined>;
  setFlags(account: Address, frozen: boolean, reason: string | null, actor: string): Promise<SpFlags>;
}

const startOfUtcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
/** The UTC day or month an activity happened in: an old payment synced today counts against its own day's cap. */
const utcDay = (at: Date): SpWindow => ({ from: startOfUtcDay(at), to: new Date(startOfUtcDay(at).getTime() + 86_400_000) });
const utcMonth = (at: Date): SpWindow => ({ from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)), to: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)) });
const inWindow = (createdAt: string, window: SpWindow) => Date.parse(createdAt) >= window.from.getTime() && Date.parse(createdAt) < window.to.getTime();
const VOLUME_KINDS: SpEntryKind[] = ["payment", "claim"];
export const SP_KINDS: readonly SpEntryKind[] = ["payment", "claim", "invite", "first_payment", "first_claim", "linked_account", "solana_address", "adjustment", "reversal", "referral"];

export class MemorySpRepository implements SpRepository {
  private readonly rows: SpLedgerRow[] = [];
  private readonly versions: SpRulesVersion[];
  private readonly flagsByAccount = new Map<string, SpFlags>();
  private queue = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date(), launchedAt = new Date(0)) {
    this.versions = [{ version: 1, rules: structuredClone(DEFAULT_SP_RULES), createdBy: "system", note: "Starting rules", createdAt: launchedAt.toISOString() }];
  }

  async withAccount<T>(account: Address, work: (transaction: SpAccountTransaction) => Promise<T>) {
    // One award at a time, as PostgreSQL's advisory lock does per account.
    const run = this.queue.then(() => work(this.transaction()));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private transaction(): SpAccountTransaction {
    const mine = (account: Address) => this.rows.filter((row) => row.account === account);
    return {
      exists: async (sourceKey) => this.rows.some((row) => row.sourceKey === sourceKey),
      sumIn: async (account, kinds, window) => roundSp(mine(account).filter((row) => kinds.includes(row.kind) && inWindow(row.createdAt, window)).reduce((sum, row) => sum + row.amount, 0)),
      countIn: async (account, kind, window, counterparty) => mine(account).filter((row) => row.kind === kind && row.amount > 0 && inWindow(row.createdAt, window) && (counterparty === undefined || row.counterparty === counterparty)).length,
      hasEntry: async (account, kind, counterparty) => mine(account).some((row) => row.kind === kind && (counterparty === undefined || row.counterparty === counterparty)),
      frozen: async (account) => Boolean(this.flagsByAccount.get(account)?.frozen),
      insert: async (draft) => {
        if (this.rows.some((row) => row.sourceKey === draft.sourceKey)) return undefined;
        const row: SpLedgerRow = { ...draft, id: String(this.rows.length + 1), feeUsdUnits: draft.feeUsdUnits ?? null, actor: draft.actor ?? null, reason: draft.reason ?? null, createdAt: (draft.createdAt ?? this.now()).toISOString() };
        this.rows.push(row);
        return structuredClone(row);
      },
    };
  }

  async rules() {
    return structuredClone(this.versions[this.versions.length - 1]);
  }

  async rulesAt(at: Date) {
    const found = [...this.versions].reverse().find((version) => Date.parse(version.createdAt) <= at.getTime()) ?? this.versions[0];
    return structuredClone(found);
  }

  async rulesHistory(limit: number) {
    return [...this.versions].reverse().slice(0, limit).map((version) => structuredClone(version));
  }

  async saveRules(rules: SpRules, actor: string, note: string | null) {
    const version = { version: this.versions.length + 1, rules: structuredClone(rules), createdBy: actor, note, createdAt: this.now().toISOString() };
    this.versions.push(version);
    return structuredClone(version);
  }

  async balance(account: Address) {
    return roundSp(this.rows.filter((row) => row.account === account).reduce((sum, row) => sum + row.amount, 0));
  }

  async volumeSince(account: Address, since: Date) {
    return roundSp(this.rows.filter((row) => row.account === account && VOLUME_KINDS.includes(row.kind) && Date.parse(row.createdAt) >= since.getTime()).reduce((sum, row) => sum + row.amount, 0));
  }

  async entry(id: string) {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? structuredClone(row) : undefined;
  }

  async entryBySource(sourceKey: string) {
    const row = this.rows.find((candidate) => candidate.sourceKey === sourceKey);
    return row ? structuredClone(row) : undefined;
  }

  async kindTotal(account: Address, kind: SpEntryKind) {
    const own = this.rows.filter((row) => row.account === account);
    const reversals = new Set(own.filter((row) => row.kind === kind).map((row) => `reverse:${row.id}`));
    return roundSp(own.filter((row) => row.kind === kind || (row.kind === "reversal" && reversals.has(row.sourceKey))).reduce((sum, row) => sum + row.amount, 0));
  }

  async ledger(filter: SpLedgerFilter) {
    const cursor = parseCursor(filter.before);
    const newestFirst = (left: SpLedgerRow, right: SpLedgerRow) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || Number(right.id) - Number(left.id);
    return this.rows
      .filter((row) => (!cursor || Date.parse(row.createdAt) < cursor.time.getTime() || (Date.parse(row.createdAt) === cursor.time.getTime() && Number(row.id) < Number(cursor.id)))
        && (!filter.account || row.account === filter.account)
        && (!filter.kind || row.kind === filter.kind)
        && (!filter.since || Date.parse(row.createdAt) >= filter.since.getTime())
        && (filter.includeZero || row.amount !== 0))
      .sort(newestFirst)
      .slice(0, filter.limit)
      .map((row) => structuredClone(row));
  }

  async sourceKeys(keys: string[]) {
    const wanted = new Set(keys);
    return new Set(this.rows.filter((row) => wanted.has(row.sourceKey)).map((row) => row.sourceKey));
  }

  async leaderboard(limit: number) {
    const totals = new Map<Address, number>();
    for (const row of this.rows) totals.set(row.account, roundSp((totals.get(row.account) ?? 0) + row.amount));
    return [...totals].map(([account, balance]) => ({ account, balance })).filter((entry) => entry.balance > 0)
      .sort((left, right) => right.balance - left.balance || left.account.localeCompare(right.account)).slice(0, limit);
  }

  async accounts(after: string | undefined, limit: number) {
    const wallets = [...new Set(this.rows.map((row) => row.account))].sort().filter((wallet) => after === undefined || wallet > after).slice(0, limit);
    return { wallets, next: wallets.length === limit ? wallets[wallets.length - 1] : null };
  }

  async totals(since: Date) {
    const holders = new Set((await this.leaderboard(Number.MAX_SAFE_INTEGER)).map((entry) => entry.account));
    return {
      issued: roundSp(this.rows.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0)),
      taken: roundSp(this.rows.filter((row) => row.amount < 0).reduce((sum, row) => sum - row.amount, 0)),
      holders: holders.size,
      today: roundSp(this.rows.filter((row) => row.amount > 0 && Date.parse(row.createdAt) >= since.getTime()).reduce((sum, row) => sum + row.amount, 0)),
      entries: this.rows.length,
    };
  }

  async flags(account: Address) {
    const flags = this.flagsByAccount.get(account);
    return flags ? structuredClone(flags) : undefined;
  }

  async setFlags(account: Address, frozen: boolean, reason: string | null, actor: string) {
    const flags = { frozen, reason, updatedBy: actor, updatedAt: this.now().toISOString() };
    this.flagsByAccount.set(account, flags);
    return structuredClone(flags);
  }
}

const ledgerRow = (row: Record<string, unknown>): SpLedgerRow => ({
  id: String(row.id),
  account: getAddress(String(row.account)),
  kind: String(row.kind) as SpEntryKind,
  amount: Number(row.amount),
  sourceKey: String(row.source_key),
  network: row.network === null || row.network === undefined ? null : String(row.network) as SpNetwork,
  usdCents: row.usd_cents === null || row.usd_cents === undefined ? null : Number(row.usd_cents),
  feeUsdUnits: row.fee_usd_units === null || row.fee_usd_units === undefined ? null : Number(row.fee_usd_units),
  counterparty: row.counterparty === null || row.counterparty === undefined ? null : String(row.counterparty),
  detail: String(row.detail),
  rulesVersion: Number(row.rules_version),
  actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
  reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  createdAt: new Date(row.created_at as string | Date).toISOString(),
  ...(typeof row.cursor_at === "string" ? { cursorAt: row.cursor_at } : {}),
});

const rulesRow = (row: Record<string, unknown>): SpRulesVersion => {
  const stored = (typeof row.rules === "string" ? JSON.parse(row.rules) : row.rules) as Record<string, unknown> | null;
  // A version saved before invites existed carries no invite rules: it takes the starting ones.
  const parsed = validateSpRules(stored && typeof stored === "object" ? { referral: DEFAULT_SP_RULES.referral, ...stored } : stored);
  return {
    version: Number(row.version),
    // A stored version that no longer validates (it cannot: every save is validated) falls back to earning nothing.
    rules: "rules" in parsed ? parsed.rules : { ...DEFAULT_SP_RULES, earning: false },
    createdBy: String(row.created_by),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
};

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * The ledger's kinds include `referral` since invites; a ledger made before them has a check without it,
 * which is replaced once (every row already in the table passes the new one).
 */
const LEDGER_KINDS = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'sp_ledger'::regclass AND conname = 'sp_ledger_kind_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''referral''%') THEN
      ALTER TABLE sp_ledger DROP CONSTRAINT IF EXISTS sp_ledger_kind_check;
      ALTER TABLE sp_ledger ADD CONSTRAINT sp_ledger_kind_check CHECK (kind IN (${SP_KINDS.map((kind) => `'${kind}'`).join(", ")}));
    END IF;
  END
  $$
`;

/**
 * SP count in tenths; a ledger table from an earlier schema kept whole SP in a BIGINT. Every value stays as it is,
 * now with room for a decimal.
 */
const LEDGER_IN_TENTHS = `
  DO $$
  BEGIN
    IF (SELECT pg_catalog.format_type(atttypid, atttypmod) FROM pg_catalog.pg_attribute
        WHERE attrelid = 'sp_ledger'::regclass AND attname = 'amount' AND NOT attisdropped) = 'bigint' THEN
      ALTER TABLE sp_ledger ALTER COLUMN amount TYPE NUMERIC(14, 1);
    END IF;
  END
  $$
`;

/**
 * Until the ledger's first row, version 1 is the code's starting rules: the rules were rescaled before anything was
 * earned, and a database from an earlier schema holds the earlier ones. Once any row is written (or an
 * admin saved a version 2), version 1 never changes again. The ledger is locked against new rows while it is checked
 * again and version 1 changes, and the append-only trigger is off only for that one update.
 */
const STARTING_RULES_UNTIL_FIRST_ROW = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM sp_ledger) AND NOT EXISTS (SELECT 1 FROM sp_rules WHERE version > 1)
      AND EXISTS (SELECT 1 FROM sp_rules WHERE version = 1 AND created_by = 'system' AND rules <> ${sqlText(JSON.stringify(DEFAULT_SP_RULES))}::jsonb) THEN
      LOCK TABLE sp_ledger IN SHARE MODE;
      IF NOT EXISTS (SELECT 1 FROM sp_ledger) THEN
        ALTER TABLE sp_rules DISABLE TRIGGER sp_rules_append_only;
        UPDATE sp_rules SET rules = ${sqlText(JSON.stringify(DEFAULT_SP_RULES))}::jsonb WHERE version = 1;
        ALTER TABLE sp_rules ENABLE TRIGGER sp_rules_append_only;
      END IF;
    END IF;
  END
  $$
`;

export class PostgresSpRepository implements SpRepository {
  constructor(private readonly pool: SqlPool) {}

  /**
   * Three tables: the rule versions (append-only, starting with version 1, the default rules), the ledger (append-only)
   * and the per-account flags. The append-only function is created here for every such table.
   */
  async migrate() {
    await this.pool.query(APPEND_ONLY_FUNCTION);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sp_rules (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        rules JSONB NOT NULL,
        created_by TEXT NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`INSERT INTO sp_rules (version, rules, created_by, note) VALUES (1, ${sqlText(JSON.stringify(DEFAULT_SP_RULES))}::jsonb, 'system', 'Starting rules') ON CONFLICT (version) DO NOTHING`);
    for (const statement of appendOnlyTriggers("sp_rules")) await this.pool.query(statement);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sp_ledger (
        id BIGSERIAL PRIMARY KEY,
        account TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${SP_KINDS.map((kind) => `'${kind}'`).join(", ")})),
        amount NUMERIC(14, 1) NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        network TEXT CHECK (network IN ('solana', 'arc', 'robinhood')),
        usd_cents BIGINT,
        fee_usd_units BIGINT CHECK (fee_usd_units >= 0),
        counterparty TEXT,
        detail TEXT NOT NULL,
        rules_version INTEGER NOT NULL REFERENCES sp_rules (version),
        actor TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(LEDGER_IN_TENTHS);
    await this.pool.query(LEDGER_KINDS);
    // A ledger made before invites gets the verified fee's column; its rows keep null, so they reward no USDC.
    await this.pool.query("ALTER TABLE sp_ledger ADD COLUMN IF NOT EXISTS fee_usd_units BIGINT CHECK (fee_usd_units >= 0)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS sp_ledger_account_idx ON sp_ledger (account, created_at DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS sp_ledger_created_idx ON sp_ledger (created_at DESC)");
    for (const statement of appendOnlyTriggers("sp_ledger")) await this.pool.query(statement);
    await this.pool.query(STARTING_RULES_UNTIL_FIRST_ROW);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sp_account_flags (
        account TEXT PRIMARY KEY,
        frozen BOOLEAN NOT NULL,
        reason TEXT,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async withAccount<T>(account: Address, work: (transaction: SpAccountTransaction) => Promise<T>) {
    if (!this.pool.connect) return work(this.transaction(this.pool));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7))", [account]);
      const result = await work(this.transaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private transaction(client: SqlClient): SpAccountTransaction {
    return {
      exists: async (sourceKey) => (await client.query("SELECT 1 FROM sp_ledger WHERE source_key = $1", [sourceKey])).rows.length > 0,
      sumIn: async (account, kinds, window) => Number((await client.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM sp_ledger WHERE account = $1 AND kind = ANY($2::text[]) AND created_at >= $3 AND created_at < $4",
        [account, kinds, window.from.toISOString(), window.to.toISOString()],
      )).rows[0]?.total ?? 0),
      countIn: async (account, kind, window, counterparty) => Number((await client.query(
        "SELECT COUNT(*) AS total FROM sp_ledger WHERE account = $1 AND kind = $2 AND amount > 0 AND created_at >= $3 AND created_at < $4 AND ($5::text IS NULL OR counterparty = $5)",
        [account, kind, window.from.toISOString(), window.to.toISOString(), counterparty ?? null],
      )).rows[0]?.total ?? 0),
      hasEntry: async (account, kind, counterparty) => (await client.query(
        "SELECT 1 FROM sp_ledger WHERE account = $1 AND kind = $2 AND ($3::text IS NULL OR counterparty = $3) LIMIT 1",
        [account, kind, counterparty ?? null],
      )).rows.length > 0,
      frozen: async (account) => (await client.query("SELECT frozen FROM sp_account_flags WHERE account = $1", [account])).rows[0]?.frozen === true,
      insert: async (draft) => {
        const result = await client.query(
          `INSERT INTO sp_ledger (account, kind, amount, source_key, network, usd_cents, fee_usd_units, counterparty, detail, rules_version, actor, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, date_trunc('milliseconds', now())))
           ON CONFLICT (source_key) DO NOTHING
           RETURNING *`,
          [draft.account, draft.kind, draft.amount, draft.sourceKey, draft.network, draft.usdCents, draft.feeUsdUnits ?? null, draft.counterparty, draft.detail, draft.rulesVersion, draft.actor ?? null, draft.reason ?? null, draft.createdAt?.toISOString() ?? null],
        );
        return result.rows[0] ? ledgerRow(result.rows[0]) : undefined;
      },
    };
  }

  async rules() {
    const result = await this.pool.query("SELECT * FROM sp_rules ORDER BY version DESC LIMIT 1");
    return result.rows[0] ? rulesRow(result.rows[0]) : { version: 1, rules: DEFAULT_SP_RULES, createdBy: "system", note: null, createdAt: new Date(0).toISOString() };
  }

  async rulesAt(at: Date) {
    const result = await this.pool.query("SELECT * FROM sp_rules WHERE created_at <= $1 ORDER BY version DESC LIMIT 1", [at.toISOString()]);
    if (result.rows[0]) return rulesRow(result.rows[0]);
    // Activity from before SP started (a backfill) counts by the first rules.
    const first = await this.pool.query("SELECT * FROM sp_rules ORDER BY version ASC LIMIT 1");
    return first.rows[0] ? rulesRow(first.rows[0]) : this.rules();
  }

  async rulesHistory(limit: number) {
    const result = await this.pool.query("SELECT * FROM sp_rules ORDER BY version DESC LIMIT $1", [limit]);
    return result.rows.map(rulesRow);
  }

  async saveRules(rules: SpRules, actor: string, note: string | null) {
    // The next version number; the primary key refuses a second writer that read the same latest version.
    const result = await this.pool.query(
      `INSERT INTO sp_rules (version, rules, created_by, note)
       SELECT COALESCE(MAX(version), 0) + 1, $1::jsonb, $2, $3 FROM sp_rules
       RETURNING *`,
      [JSON.stringify(rules), actor, note],
    );
    return rulesRow(result.rows[0]);
  }

  async balance(account: Address) {
    return Number((await this.pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM sp_ledger WHERE account = $1", [account])).rows[0]?.total ?? 0);
  }

  async volumeSince(account: Address, since: Date) {
    return Number((await this.pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM sp_ledger WHERE account = $1 AND kind = ANY($2::text[]) AND created_at >= $3",
      [account, VOLUME_KINDS, since.toISOString()],
    )).rows[0]?.total ?? 0);
  }

  async entry(id: string) {
    if (!/^\d{1,18}$/.test(id)) return undefined;
    const result = await this.pool.query("SELECT * FROM sp_ledger WHERE id = $1", [id]);
    return result.rows[0] ? ledgerRow(result.rows[0]) : undefined;
  }

  async entryBySource(sourceKey: string) {
    const result = await this.pool.query("SELECT * FROM sp_ledger WHERE source_key = $1", [sourceKey]);
    return result.rows[0] ? ledgerRow(result.rows[0]) : undefined;
  }

  async kindTotal(account: Address, kind: SpEntryKind) {
    // Net of the reversals of those rows, so a reversed invite share no longer counts (audit, 2026-10-06).
    return Number((await this.pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM sp_ledger
       WHERE account = $1 AND (kind = $2 OR (kind = 'reversal' AND source_key IN (SELECT 'reverse:' || id FROM sp_ledger WHERE account = $1 AND kind = $2)))`,
      [account, kind],
    )).rows[0]?.total ?? 0);
  }

  async ledger(filter: SpLedgerFilter) {
    const cursor = parseCursor(filter.before);
    const result = await this.pool.query(
      `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM sp_ledger
       WHERE ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::bigint)) AND ($4::text IS NULL OR account = $4)
         AND ($5::text IS NULL OR kind = $5) AND ($6::timestamptz IS NULL OR created_at >= $6) AND ($7::boolean OR amount <> 0)
       ORDER BY created_at DESC, id DESC LIMIT $1`,
      [filter.limit, cursor?.text ?? null, cursor?.id ?? null, filter.account ?? null, filter.kind ?? null, filter.since?.toISOString() ?? null, Boolean(filter.includeZero)],
    );
    return result.rows.map(ledgerRow);
  }

  async sourceKeys(keys: string[]) {
    if (!keys.length) return new Set<string>();
    const result = await this.pool.query("SELECT source_key FROM sp_ledger WHERE source_key = ANY($1::text[])", [keys]);
    return new Set(result.rows.map((row) => String(row.source_key)));
  }

  async leaderboard(limit: number) {
    const result = await this.pool.query(
      "SELECT account, SUM(amount) AS balance FROM sp_ledger GROUP BY account HAVING SUM(amount) > 0 ORDER BY SUM(amount) DESC, account LIMIT $1",
      [limit],
    );
    return result.rows.map((row) => ({ account: getAddress(String(row.account)), balance: Number(row.balance) }));
  }

  async accounts(after: string | undefined, limit: number) {
    const result = await this.pool.query("SELECT DISTINCT account FROM sp_ledger WHERE $1::text IS NULL OR account > $1 ORDER BY account LIMIT $2", [after ?? null, limit]);
    const wallets = result.rows.map((row) => getAddress(String(row.account)));
    return { wallets, next: wallets.length === limit ? String(result.rows[result.rows.length - 1].account) : null };
  }

  async totals(since: Date) {
    const row = (await this.pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS issued, COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0) AS taken,
              COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND created_at >= $1), 0) AS today, COUNT(*) AS entries,
              (SELECT COUNT(*) FROM (SELECT account FROM sp_ledger GROUP BY account HAVING SUM(amount) > 0) AS positive) AS holders
       FROM sp_ledger`,
      [since.toISOString()],
    )).rows[0] ?? {};
    return { issued: Number(row.issued ?? 0), taken: Number(row.taken ?? 0), holders: Number(row.holders ?? 0), today: Number(row.today ?? 0), entries: Number(row.entries ?? 0) };
  }

  async flags(account: Address) {
    const row = (await this.pool.query("SELECT * FROM sp_account_flags WHERE account = $1", [account])).rows[0];
    return row ? { frozen: row.frozen === true, reason: row.reason === null ? null : String(row.reason), updatedBy: String(row.updated_by), updatedAt: new Date(row.updated_at as string | Date).toISOString() } : undefined;
  }

  async setFlags(account: Address, frozen: boolean, reason: string | null, actor: string) {
    const updatedAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO sp_account_flags (account, frozen, reason, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account) DO UPDATE SET frozen = EXCLUDED.frozen, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [account, frozen, reason, actor, updatedAt],
    );
    return { frozen, reason, updatedBy: actor, updatedAt };
  }
}

/** A price in US dollars for an asset on a network, or undefined while none is known. */
export type SpPrices = (network: SpNetwork, symbol: string) => Promise<number | undefined>;

/** An amount of one asset as the records keep it: a decimal string ("25", "0.15"). */
export type SpAmount = { symbol: string; assetClass: SpAssetClass; amount: string };

/** A payment confirmed through HaPaPay: SP for its sender. */
export type SpPaymentEvent = {
  account: Address;
  network: SpNetwork;
  sourceKey: string;
  /** The recipient's account when they have one, for the per-person limit and to skip payments to oneself. */
  counterparty: Address | null;
  amount: SpAmount;
  /**
   * The 1% fee HaPaPay verified on chain for this payment, in the same token's base units, with the payment's own
   * base units to scale it by. Absent when no fee was verified; such a payment earns its sender SP but its inviter no USDC.
   */
  fee?: SpVerifiedFee;
  detail: string;
  at: Date;
  /** When the SP was first owed, for how long a missing price is waited for (the payment itself by default). */
  owedSince?: Date;
};

export type SpVerifiedFee = { units: bigint; paymentUnits: bigint };

/** The verified fee's dollar value in millionths: the payment's dollar value scaled by fee units over payment units. */
export function feeUsdUnits(usd: number | null, fee: SpVerifiedFee | undefined) {
  if (usd === null || !fee || fee.units <= 0n || fee.paymentUnits <= 0n || !Number.isFinite(usd) || usd <= 0) return null;
  return Number(BigInt(Math.round(usd * 1_000_000)) * fee.units / fee.paymentUnits);
}

/** A vault link claimed: SP for the claimer, and the link's payment SP and the invite bonus for its sender. */
export type SpClaimEvent = {
  /** Null when the chain shows the link claimed but not by whom; the sender still earns. */
  claimer: Address | null;
  sender: Address;
  network: SpNetwork;
  /** The link, network-scoped: `<network>:<payment id>`. */
  link: string;
  amount: SpAmount;
  /** The fee the link paid, when its record proves it; the sender's payment row keeps it as a payment's does. */
  fee?: SpVerifiedFee;
  detail: string;
  at: Date;
  /** When the link was funded, for how long a missing price is waited for. */
  fundedAt: Date;
};

export type SpAwardResult = { awarded: number; pending?: boolean };

/** How long an asset with no US dollar price is waited for before its activity is closed with no SP. */
export const SP_PRICE_GRACE_MS = 72 * 3_600_000;

const ZERO_REASONS = {
  frozen: "SP earning is stopped for this account",
  off: "SP earning was off",
  self: "A payment to oneself earns no SP",
  pair: "The daily limit of rewarded payments to this person was reached",
  cap: "The daily SP cap was reached",
  minimum: "Below the minimum value that earns SP",
  price: "No US dollar price was available for this asset",
  refunded: "The vault link was refunded, so it earns no SP",
  invites: "The monthly limit of invite bonuses was reached",
  tenth: "Less than a tenth of an SP",
  inviteCap: "The daily cap on SP from people you invited was reached",
  fee: "It did not pay HaPaPay's fee, so it earns no SP",
} as const;

/** What an inviter's row says it came from. */
const REFERRAL_DETAILS: Partial<Record<SpEntryKind, string>> = {
  payment: "Someone you invited paid",
  claim: "Someone you invited claimed a vault link",
  invite: "A vault link from someone you invited was claimed",
  first_payment: "First payment of someone you invited",
  first_claim: "First claim of someone you invited",
  linked_account: "Someone you invited linked an account",
  solana_address: "Someone you invited added a Solana address",
};

const sameAddress = (left: string | null, right: string) => left !== null && left.toLowerCase() === right.toLowerCase();
/** A row an inviter shares: written after the invite, by the invited account, and not with the inviter on the other side. */
const sharedRow = (row: SpLedgerRow, binding: ReferralBinding) =>
  row.account === binding.invitee && Date.parse(row.createdAt) >= Date.parse(binding.createdAt) && !sameAddress(row.counterparty, binding.referrer);
/** Activity and bonuses that earned SP give the inviter a share of that SP. */
const sharesSp = (row: SpLedgerRow, binding: ReferralBinding) => sharedRow(row, binding) && REFERRAL_SOURCE_KINDS.includes(row.kind) && row.amount > 0;
/**
 * A payment to someone else whose 1% fee was verified on chain gives the inviter a share of that fee, whatever SP it
 * earned under the caps, unless the invited account's SP were stopped when it was awarded (a stopped account earns
 * its inviter nothing). A transfer that paid no fee gives nothing, so a reward never exceeds the fee it comes from.
 */
const sharesFee = (row: SpLedgerRow, binding: ReferralBinding) => sharedRow(row, binding) && row.kind === "payment" && row.network !== null
  && row.feeUsdUnits !== null && row.feeUsdUnits > 0 && !sameAddress(row.counterparty, row.account) && row.reason !== ZERO_REASONS.frozen;

export class SpService {
  private cached?: { at: number; version: SpRulesVersion };

  constructor(private readonly options: { repository: SpRepository; referrals?: ReferralStore; prices?: SpPrices; now?: () => Date; rulesCacheMs?: number }) {}

  /** Who invited whom and the invite rewards, when this server keeps them. */
  get referrals() {
    return this.options.referrals;
  }

  /**
   * Runs an award for one account, then gives its inviter a share of every row it wrote. The share is written after
   * the account's lock is released, so two accounts' locks are never held at once.
   */
  private async forAccount<T>(account: Address, work: (transaction: SpAccountTransaction) => Promise<T>): Promise<T> {
    const written: SpLedgerRow[] = [];
    const result = await this.options.repository.withAccount(account, (transaction) => work({
      ...transaction,
      insert: async (draft) => {
        const row = await transaction.insert(draft);
        if (row) written.push(row);
        return row;
      },
    }));
    if (written.length) await this.shareWithInviter(written);
    return result;
  }

  private async shareWithInviter(rows: SpLedgerRow[]) {
    const referrals = this.options.referrals;
    if (!referrals) return;
    try {
      const binding = await referrals.referrerOf(rows[0].account);
      if (binding) for (const row of rows) await this.shareRow(row, binding);
    } catch {
      // Nothing is lost: the invited account's next sync gives the inviter what this missed (`referralCatchUp`).
    }
  }

  /**
   * An invited account's row earns its inviter: a share of its SP for activity and bonuses (`referral:<row id>`, under
   * the invite cap), and for a payment a share of its dollar value in USDC (`fee:<source key>`). Each is keyed by the
   * row, so it is given once however often this runs.
   */
  private async shareRow(row: SpLedgerRow, binding: ReferralBinding) {
    const shareSp = sharesSp(row, binding);
    const shareFee = sharesFee(row, binding);
    if (!shareSp && !shareFee) return false;
    // A row an admin reversed before it was shared gives the inviter nothing.
    if (await this.options.repository.entryBySource(`reverse:${row.id}`)) return false;
    const at = new Date(row.createdAt);
    const { version, rules } = await this.options.repository.rulesAt(at);
    if (shareSp) {
      await this.options.repository.withAccount(binding.referrer, async (transaction) => {
        const sourceKey = `referral:${row.id}`;
        if (await transaction.exists(sourceKey)) return;
        let amount = referralSp(row.amount, rules);
        let reason: string | null = null;
        if (await transaction.frozen(binding.referrer)) [amount, reason] = [0, ZERO_REASONS.frozen];
        else if (!rules.earning) [amount, reason] = [0, ZERO_REASONS.off];
        else if (amount === 0) reason = ZERO_REASONS.tenth;
        else {
          const allowed = cappedBy(amount, await transaction.sumIn(binding.referrer, ["referral"], utcDay(at)), rules.referral.dailyCap);
          if (allowed < amount) reason = ZERO_REASONS.inviteCap;
          amount = allowed;
        }
        await transaction.insert({
          account: binding.referrer, kind: "referral", amount, sourceKey, network: row.network, usdCents: null, counterparty: binding.invitee,
          detail: REFERRAL_DETAILS[row.kind] ?? "Someone you invited earned SP", rulesVersion: version, reason, createdAt: at,
        });
      });
    }
    if (shareFee && this.options.referrals) {
      const units = referralFeeUnits(row.feeUsdUnits!, rules);
      await this.options.referrals.insertFeeReward({
        sourceKey: `fee:${row.sourceKey}`, referrer: binding.referrer, invitee: binding.invitee, network: row.network!, paymentUsdCents: row.usdCents ?? 0,
        units, spEntryId: row.id, rulesVersion: version, reason: units > 0n ? null : "Invite fee rewards were off", createdAt: at,
      });
    }
    // An admin who reversed the row while this was sharing it looked for the share before it was written: take it back
    // here. Each side writes before it looks, so one of the two always sees the other.
    const reversal = await this.options.repository.entryBySource(`reverse:${row.id}`);
    if (reversal) await this.takeBack(row, reversal.rulesVersion, reversal.actor ?? "system", reversal.reason ?? "Reversed");
    return true;
  }

  /**
   * Gives an invited account's inviter whatever its rows since the invite have not given yet: rows written while
   * sharing failed, or before this server kept invites. Safe to repeat. Returns how many rows it shared.
   */
  async referralCatchUp(inviteeInput: Address) {
    const referrals = this.options.referrals;
    if (!referrals) return 0;
    const binding = await referrals.referrerOf(getAddress(inviteeInput));
    if (!binding) return 0;
    let before: string | undefined;
    let shared = 0;
    for (let page = 0; page < 50; page++) {
      const rows = await this.options.repository.ledger({ account: binding.invitee, since: new Date(binding.createdAt), limit: 200, before, includeZero: true });
      const candidates = rows.filter((row) => sharesSp(row, binding) || sharesFee(row, binding));
      if (candidates.length) {
        const [spDone, feeDone] = await Promise.all([
          this.options.repository.sourceKeys(candidates.map((row) => `referral:${row.id}`)),
          referrals.feeRewardKeys(candidates.map((row) => `fee:${row.sourceKey}`)),
        ]);
        for (const row of candidates) {
          if ((sharesSp(row, binding) && !spDone.has(`referral:${row.id}`)) || (sharesFee(row, binding) && !feeDone.has(`fee:${row.sourceKey}`))) {
            if (await this.shareRow(row, binding)) shared++;
          }
        }
      }
      if (rows.length < 200) break;
      before = ledgerCursor(rows[rows.length - 1]);
    }
    return shared;
  }

  /** An account's invites for the desk: its code, how many joined with it, what they earned it, and whether it joined with one. */
  async referralSummary(accountInput: Address) {
    const referrals = this.options.referrals;
    if (!referrals) return undefined;
    const account = getAddress(accountInput);
    const [code, invited, joined, sp, fees] = await Promise.all([
      referrals.ensureCode(account),
      referrals.invitedCount(account),
      referrals.referrerOf(account),
      this.options.repository.kindTotal(account, "referral"),
      referrals.feeTotals(account),
    ]);
    return { code, invited, joined: Boolean(joined), sp, fees: { earned: fees.earned.toString(), paid: fees.paid.toString(), owed: (fees.earned - fees.paid).toString() } };
  }

  private get now() {
    return this.options.now ? this.options.now() : new Date();
  }

  get repository() {
    return this.options.repository;
  }

  /** The rules in force, read again at most every 15 seconds per instance. */
  async rules() {
    const ttl = this.options.rulesCacheMs ?? 15_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.version;
    const version = await this.options.repository.rules();
    this.cached = { at: Date.now(), version };
    return version;
  }

  async summary(account: Address) {
    const [balance, flags, rules, today] = await Promise.all([
      this.options.repository.balance(account),
      this.options.repository.flags(account),
      this.rules(),
      this.options.repository.volumeSince(account, startOfUtcDay(this.now)),
    ]);
    return { balance, today, dailyCap: rules.rules.dailyCap, frozen: Boolean(flags?.frozen), rulesVersion: rules.version };
  }

  /** An account's SP history, newest first, with a cursor for the next page. Rows that earned nothing are left out. */
  async history(account: Address, limit: number, before?: string): Promise<{ entries: SpEntry[]; next: string | null }> {
    const rows = await this.options.repository.ledger({ account, limit: limit + 1, before });
    return { entries: rows.slice(0, limit).map(toEntry), next: rows.length > limit ? ledgerCursor(rows[limit - 1]) : null };
  }

  /**
   * The amount in US dollars: stablecoins at $1, anything else at its price. Undefined while no price is known and
   * the activity is newer than `SP_PRICE_GRACE_MS`; null after that, so the activity is closed with no SP.
   */
  private async value(network: SpNetwork, amount: SpAmount, owedSince: Date): Promise<number | null | undefined> {
    if (amount.assetClass === "stable") return amountUsd(amount.amount, 1);
    const price = await this.options.prices?.(network, amount.symbol).catch(() => undefined);
    if (price !== undefined && Number.isFinite(price) && price > 0) return amountUsd(amount.amount, price);
    return this.now.getTime() - owedSince.getTime() > SP_PRICE_GRACE_MS ? null : undefined;
  }

  /**
   * SP for a confirmed payment, once: a row with what it earned (none for a payment to oneself, past the per-person or
   * daily limit, below the minimum, without a price, while earning is off or the account is stopped), and the
   * first-payment bonus with the first payment that earns. Without a price yet, the payment waits for a later sync.
   */
  async awardPayment(event: SpPaymentEvent): Promise<SpAwardResult> {
    const usd = await this.value(event.network, event.amount, event.owedSince ?? event.at);
    if (usd === undefined) return { awarded: 0, pending: true };
    const account = getAddress(event.account);
    const counterparty = event.counterparty ? getAddress(event.counterparty) : null;
    const { version, rules } = await this.options.repository.rulesAt(event.at);
    return this.forAccount(account, async (transaction) => {
      if (await transaction.exists(event.sourceKey)) return { awarded: 0 };
      const day = utcDay(event.at);
      let amount = usd === null ? 0 : volumeSp({ usd, network: event.network, asset: event.amount.assetClass, rules, at: event.at, kind: "payment" });
      let reason: string | null = null;
      if (await transaction.frozen(account)) [amount, reason] = [0, ZERO_REASONS.frozen];
      else if (!rules.earning) [amount, reason] = [0, ZERO_REASONS.off];
      else if (counterparty === account) [amount, reason] = [0, ZERO_REASONS.self];
      // On Arc and Robinhood Chain every direct payment HaPaPay prepares goes through the fee router, so one without
      // its verified fee was sent around the desk: it is recorded, and earns nothing (audit, 2026-10-06: plain
      // transfers back and forth earned SP for gas alone, while the documented cost of SP is the fee). A vault link's
      // escrow takes its fee at the claim.
      else if (event.network !== "solana" && !event.sourceKey.startsWith("vault:") && !event.fee) [amount, reason] = [0, ZERO_REASONS.fee];
      else if (usd === null) reason = ZERO_REASONS.price;
      else if (counterparty && await transaction.countIn(account, "payment", day, counterparty) >= rules.pairDailyLimit) [amount, reason] = [0, ZERO_REASONS.pair];
      else if (amount === 0) reason = ZERO_REASONS.minimum;
      else {
        const allowed = capped(amount, await transaction.sumIn(account, VOLUME_KINDS, day), rules);
        if (allowed < amount) reason = ZERO_REASONS.cap;
        amount = allowed;
      }
      const row = await transaction.insert({
        account, kind: "payment", amount, sourceKey: event.sourceKey, network: event.network, usdCents: usd === null ? null : Math.round(usd * 100),
        feeUsdUnits: feeUsdUnits(usd, event.fee), counterparty, detail: event.detail, rulesVersion: version, reason, createdAt: event.at,
      });
      if (!row) return { awarded: 0 };
      let bonus = 0;
      if (amount > 0 && rules.bonuses.firstPayment > 0 && !await transaction.hasEntry(account, "first_payment")) {
        const first = await transaction.insert({
          account, kind: "first_payment", amount: rules.bonuses.firstPayment, sourceKey: `first_payment:${account}`, network: event.network,
          usdCents: null, counterparty: null, detail: "Your first payment on HaPaPay", rulesVersion: version, createdAt: event.at,
        });
        bonus = first?.amount ?? 0;
      }
      return { awarded: roundSp(row.amount + bonus) };
    });
  }

  /**
   * A claimed vault link. The claimer earns claim SP and, once, the first-claim bonus; the sender earns the link's
   * payment SP (a link earns when it is delivered, so a refunded link never earns) and the invite bonus, at most
   * `inviteMonthlyLimit` a month. Each side is keyed by the link (`claim:`, `vault:`, `invite:`), so it earns once.
   */
  async awardClaim(event: SpClaimEvent): Promise<{ claimer: SpAwardResult; sender: SpAwardResult }> {
    const usd = await this.value(event.network, event.amount, event.fundedAt);
    if (usd === undefined) return { claimer: { awarded: 0, pending: true }, sender: { awarded: 0, pending: true } };
    const claimer = event.claimer ? getAddress(event.claimer) : null;
    const sender = getAddress(event.sender);
    const { version, rules } = await this.options.repository.rulesAt(event.at);
    const day = utcDay(event.at);
    const claimed = !claimer ? { awarded: 0 } : await this.forAccount(claimer, async (transaction) => {
      const sourceKey = `claim:${event.link}`;
      if (await transaction.exists(sourceKey)) return { awarded: 0 };
      let amount = usd === null ? 0 : volumeSp({ usd, network: event.network, asset: event.amount.assetClass, rules, at: event.at, kind: "claim" });
      let reason: string | null = null;
      if (await transaction.frozen(claimer)) [amount, reason] = [0, ZERO_REASONS.frozen];
      else if (!rules.earning) [amount, reason] = [0, ZERO_REASONS.off];
      else if (sender === claimer) [amount, reason] = [0, ZERO_REASONS.self];
      else if (usd === null) reason = ZERO_REASONS.price;
      else if (amount === 0) reason = ZERO_REASONS.minimum;
      else {
        const allowed = capped(amount, await transaction.sumIn(claimer, VOLUME_KINDS, day), rules);
        if (allowed < amount) reason = ZERO_REASONS.cap;
        amount = allowed;
      }
      const row = await transaction.insert({
        account: claimer, kind: "claim", amount, sourceKey, network: event.network, usdCents: usd === null ? null : Math.round(usd * 100),
        counterparty: sender, detail: event.detail, rulesVersion: version, reason, createdAt: event.at,
      });
      if (!row) return { awarded: 0 };
      let bonus = 0;
      if (amount > 0 && rules.bonuses.firstClaim > 0 && !await transaction.hasEntry(claimer, "first_claim")) {
        const first = await transaction.insert({
          account: claimer, kind: "first_claim", amount: rules.bonuses.firstClaim, sourceKey: `first_claim:${claimer}`, network: event.network,
          usdCents: null, counterparty: null, detail: "Your first vault link claimed", rulesVersion: version, createdAt: event.at,
        });
        bonus = first?.amount ?? 0;
      }
      return { awarded: roundSp(row.amount + bonus) };
    });
    const sent = await this.awardPayment({
      account: sender, network: event.network, sourceKey: `vault:${event.link}`, counterparty: claimer, amount: event.amount, fee: event.fee,
      detail: event.detail, at: event.at, owedSince: event.fundedAt,
    });
    if (sender === claimer) return { claimer: claimed, sender: sent };
    const invite = await this.forAccount(sender, async (transaction) => {
      const sourceKey = `invite:${event.link}`;
      if (await transaction.exists(sourceKey)) return 0;
      let amount = rules.earning ? rules.bonuses.inviteClaimed : 0;
      let reason: string | null = rules.earning ? null : ZERO_REASONS.off;
      if (await transaction.frozen(sender)) [amount, reason] = [0, ZERO_REASONS.frozen];
      else if (amount > 0 && await transaction.countIn(sender, "invite", utcMonth(event.at)) >= rules.inviteMonthlyLimit) [amount, reason] = [0, ZERO_REASONS.invites];
      const row = await transaction.insert({
        account: sender, kind: "invite", amount, sourceKey, network: event.network, usdCents: null, counterparty: claimer,
        detail: event.detail, rulesVersion: version, reason, createdAt: event.at,
      });
      return row?.amount ?? 0;
    });
    return { claimer: claimed, sender: { awarded: roundSp(sent.awarded + invite) } };
  }

  /** Closes a refunded vault link for its sender with no SP, so it is never read from chain again. */
  async closeRefundedLink(event: Pick<SpClaimEvent, "sender" | "network" | "link" | "detail" | "at">) {
    const sender = getAddress(event.sender);
    const { version } = await this.options.repository.rulesAt(event.at);
    await this.options.repository.withAccount(sender, (transaction) => transaction.insert({
      account: sender, kind: "payment", amount: 0, sourceKey: `vault:${event.link}`, network: event.network, usdCents: null,
      counterparty: null, detail: event.detail, rulesVersion: version, reason: ZERO_REASONS.refunded, createdAt: event.at,
    }));
  }

  /**
   * The bonus for linking a social account: once ever per provider account and once per platform per account. A
   * second account on a platform that already earned is written with no SP, so it is not looked at again.
   */
  async awardLinkedAccount(event: { account: Address; platform: Platform; providerUserId: string; at: Date }): Promise<SpAwardResult> {
    const account = getAddress(event.account);
    const { version, rules } = await this.options.repository.rulesAt(event.at);
    return this.forAccount(account, async (transaction) => {
      const sourceKey = `linked:${event.platform}:${event.providerUserId}`;
      if (await transaction.exists(sourceKey)) return { awarded: 0 };
      let amount = rules.earning ? rules.bonuses.linkedAccount : 0;
      let reason: string | null = rules.earning ? null : ZERO_REASONS.off;
      if (await transaction.hasEntry(account, "linked_account", event.platform)) [amount, reason] = [0, `This account already earned SP for a ${platformName(event.platform)} account`];
      else if (await transaction.frozen(account)) [amount, reason] = [0, ZERO_REASONS.frozen];
      const row = await transaction.insert({
        account, kind: "linked_account", amount, sourceKey, network: null, usdCents: null, counterparty: event.platform,
        detail: `${platformName(event.platform)} account linked`, rulesVersion: version, reason, createdAt: event.at,
      });
      return { awarded: row?.amount ?? 0 };
    });
  }

  /** The bonus for adding a Solana address: once ever per address and once per account, the same way. */
  async awardSolanaAddress(event: { account: Address; address: string; at: Date }): Promise<SpAwardResult> {
    const account = getAddress(event.account);
    const { version, rules } = await this.options.repository.rulesAt(event.at);
    return this.forAccount(account, async (transaction) => {
      const sourceKey = `solana_address:${event.address}`;
      if (await transaction.exists(sourceKey)) return { awarded: 0 };
      let amount = rules.earning ? rules.bonuses.solanaAddress : 0;
      let reason: string | null = rules.earning ? null : ZERO_REASONS.off;
      if (await transaction.hasEntry(account, "solana_address")) [amount, reason] = [0, "This account already earned SP for a Solana address"];
      else if (await transaction.frozen(account)) [amount, reason] = [0, ZERO_REASONS.frozen];
      const row = await transaction.insert({
        account, kind: "solana_address", amount, sourceKey, network: "solana", usdCents: null, counterparty: null,
        detail: "Solana address added", rulesVersion: version, reason, createdAt: event.at,
      });
      return { awarded: row?.amount ?? 0 };
    });
  }

  /** An admin's adjustment: SP with at most one decimal, either way, with a reason. */
  async adjust(input: { actor: string; account: Address; amount: number; reason: string }) {
    if (!isTenths(input.amount) || input.amount === 0 || Math.abs(input.amount) > SP_ADJUST_LIMIT) throw new SpRequestError(SP_ADJUST_ERROR);
    const reason = checkedReason(input.reason);
    const account = getAddress(input.account);
    const amount = roundSp(input.amount);
    const { version } = await this.rules();
    const row = await this.options.repository.withAccount(account, (transaction) => transaction.insert({
      account, kind: "adjustment", amount, sourceKey: `adjust:${randomUUID()}`, network: null, usdCents: null,
      counterparty: null, detail: amount > 0 ? "Added by HaPaPay" : "Taken by HaPaPay", rulesVersion: version,
      actor: input.actor, reason,
    }));
    if (!row) throw new SpRequestError("The adjustment was not written. Try again.");
    return row;
  }

  /**
   * Reverses one entry, once: a new row with the opposite amount; the original stays. What the entry gave an inviter
   * goes with it. An entry that earned no SP is reversed only to take back the USDC reward its payment gave an inviter.
   * Running it again finishes a reversal that stopped halfway, and only then says it was already reversed.
   */
  async reverse(input: { actor: string; entryId: string; reason: string }) {
    const reason = checkedReason(input.reason);
    const entry = await this.options.repository.entry(input.entryId);
    if (!entry) throw new SpRequestError("That SP entry was not found.");
    if (entry.kind === "reversal") throw new SpRequestError("A reversal cannot be reversed; add an adjustment instead.");
    const reward = entry.kind === "payment" ? await this.options.referrals?.feeReward(`fee:${entry.sourceKey}`) : undefined;
    if (entry.amount === 0 && !(reward && reward.units > 0n)) throw new SpRequestError("That entry earned no SP, so there is nothing to reverse.");
    const { version } = await this.rules();
    const row = await this.options.repository.withAccount(entry.account, (transaction) => transaction.insert({
      account: entry.account, kind: "reversal", amount: entry.amount === 0 ? 0 : -entry.amount, sourceKey: `reverse:${entry.id}`, network: entry.network,
      usdCents: entry.usdCents, counterparty: entry.counterparty, detail: `Reversal of #${entry.id}: ${entry.detail}`.slice(0, 300), rulesVersion: version,
      actor: input.actor, reason,
    }));
    const tookBack = await this.takeBack(entry, version, input.actor, reason);
    if (row) return row;
    const earlier = await this.options.repository.entryBySource(`reverse:${entry.id}`);
    if (tookBack && earlier) return earlier;
    throw new SpRequestError("That entry was already reversed.");
  }

  /**
   * Takes back what a reversed entry gave its inviter, each once: the SP share (a reversal of its `referral:` row) and
   * a payment's USDC reward (a negative `fee-reverse:` reward, so a reward not paid yet is never paid and one already
   * paid is set against the inviter's next rewards). Safe to repeat; says whether it wrote anything.
   */
  private async takeBack(entry: SpLedgerRow, version: number, actor: string, reason: string) {
    const because = `#${entry.id}, which it came from, was reversed: ${reason}`.slice(0, 300);
    let wrote = false;
    const shared = entry.kind === "referral" ? undefined : await this.options.repository.entryBySource(`referral:${entry.id}`);
    if (shared && shared.amount !== 0) {
      const reversal = await this.options.repository.withAccount(shared.account, (transaction) => transaction.insert({
        account: shared.account, kind: "reversal", amount: -shared.amount, sourceKey: `reverse:${shared.id}`, network: shared.network,
        usdCents: null, counterparty: shared.counterparty, detail: `Reversal of #${shared.id}: ${shared.detail}`.slice(0, 300), rulesVersion: version,
        actor, reason: because,
      }));
      wrote = wrote || Boolean(reversal);
    }
    const reward = entry.kind === "payment" ? await this.options.referrals?.feeReward(`fee:${entry.sourceKey}`) : undefined;
    if (reward && reward.units > 0n) {
      const written = await this.options.referrals!.insertFeeReward({
        sourceKey: `fee-reverse:${entry.sourceKey}`, referrer: reward.referrer, invitee: reward.invitee, network: reward.network, paymentUsdCents: reward.paymentUsdCents,
        units: -reward.units, spEntryId: entry.id, rulesVersion: version, reason: because, createdAt: this.now,
      });
      wrote = wrote || written;
    }
    return wrote;
  }

  async setFrozen(input: { actor: string; account: Address; frozen: boolean; reason: string }) {
    return this.options.repository.setFlags(getAddress(input.account), input.frozen, checkedReason(input.reason), input.actor);
  }

  async saveRules(input: { actor: string; rules: unknown; note?: string }) {
    const checked = validateSpRules(input.rules);
    if ("error" in checked) throw new SpRequestError(checked.error);
    const note = input.note?.trim().slice(0, 300) || null;
    const saved = await this.options.repository.saveRules(checked.rules, input.actor, note);
    this.cached = undefined;
    return saved;
  }
}

export class SpRequestError extends Error {}

export const SP_ADJUST_ERROR = `The adjustment must be SP with at most one decimal, not zero, up to ${SP_ADJUST_LIMIT.toLocaleString("en-US")} either way.`;

function checkedReason(input: string) {
  const reason = input.trim();
  if (reason.length < 3 || reason.length > 300) throw new SpRequestError("Give a reason of 3 to 300 characters.");
  return reason;
}

export const toEntry = (row: SpLedgerRow): SpEntry => ({
  id: row.id,
  kind: row.kind,
  amount: row.amount,
  network: row.network,
  usdCents: row.usdCents,
  detail: row.detail,
  createdAt: row.createdAt,
});
