import { createHash, randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { appendOnlyTriggers } from "./append-only.js";
import { MemoryTransientStateStore, type TransientStateStore } from "./transient-state-store.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

/**
 * The admin panel. An admin is a wallet
 * named in `ADMIN_WALLET_ADDRESSES` or one of the operator wallets the server already trusts with its contracts; a
 * session alone reads, and every change is signed by that wallet for that change only, then written to the audit log.
 */
export function readAdminWallets(environment: Partial<Record<"ADMIN_WALLET_ADDRESSES" | "ROBINHOOD_OPERATOR_ADDRESS" | "ARC_MAINNET_OPERATOR_ADDRESS", string | undefined>>) {
  const problems: string[] = [];
  const wallets = new Set<Address>();
  for (const value of (environment.ADMIN_WALLET_ADDRESSES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (isAddress(value, { strict: false })) wallets.add(getAddress(value));
    else problems.push("ADMIN_WALLET_ADDRESSES must be wallet addresses separated by commas.");
  }
  for (const value of [environment.ROBINHOOD_OPERATOR_ADDRESS, environment.ARC_MAINNET_OPERATOR_ADDRESS]) {
    const input = value?.trim();
    if (input && isAddress(input, { strict: false })) wallets.add(getAddress(input));
  }
  return { wallets: [...wallets], problems: [...new Set(problems)] };
}

export const ADMIN_ACTIONS = {
  "sp.rules": "Change the SP rules",
  "sp.adjust": "Add or take SP",
  "sp.reverse": "Reverse an SP entry",
  "sp.freeze": "Stop or restart an account's SP",
  "sp.sync": "Award SP for confirmed activity that has none",
  "switches.set": "Pause or resume a feature",
  "notice.set": "Show or clear the desk notice",
} as const;
export type AdminAction = keyof typeof ADMIN_ACTIONS;
export const isAdminAction = (value: unknown): value is AdminAction => typeof value === "string" && Object.prototype.hasOwnProperty.call(ADMIN_ACTIONS, value);

/** JSON with every object's keys in order, so the payload an admin signed hashes the same when it comes back. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const payloadHash = (payload: unknown) => createHash("sha256").update(canonicalJson(payload)).digest("hex");

/** The change in words, as the wallet shows it before the admin signs: one line per field that matters. */
export function adminActionLines(action: AdminAction, payload: Record<string, unknown>): string[] {
  const text = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").slice(0, 200);
  switch (action) {
    case "sp.adjust": return [`Account: ${text(payload.account)}`, `SP: ${Number(payload.amount) > 0 ? "+" : ""}${text(payload.amount)}`, `Reason: ${text(payload.reason)}`];
    case "sp.reverse": return [`Entry: ${text(payload.entryId)}`, `Reason: ${text(payload.reason)}`];
    case "sp.freeze": return [`Account: ${text(payload.account)}`, `Earning: ${payload.frozen ? "stopped" : "restarted"}`, `Reason: ${text(payload.reason)}`];
    case "sp.rules": {
      // Invite shares are paid partly in USDC, so the wallet shows them in words, not only in the hash.
      const referral = (payload.rules as { referral?: { pointsShare?: unknown; feeShareBps?: unknown } } | undefined)?.referral;
      const invites = referral ? [`Invites: ${Math.round(Number(referral.pointsShare) * 1000) / 10}% of SP, ${text(referral.feeShareBps)}% of each verified fee in USDC`] : [];
      return [`Rules: ${payloadHash(payload.rules).slice(0, 16)}`, ...invites, `Note: ${text(payload.note)}`];
    }
    case "sp.sync": return [`Accounts: ${payload.account ? text(payload.account) : "every account"}${payload.after ? ` after ${text(payload.after)}` : ""}`];
    case "switches.set": return [`Feature: ${text(payload.key)}`, `Now: ${payload.paused ? "paused" : "running"}`, ...(payload.paused ? [`Message: ${text(payload.message) || "the standard pause message"}`] : [])];
    case "notice.set": return payload.text ? [`Notice (${payload.tone === "warning" ? "warning" : "info"}): ${text(payload.text)}`] : ["Notice: cleared"];
  }
}

type ActionChallenge = { address: Address; action: AdminAction; hash: string; message: string; expiresAt: number };

export class AdminAuthService {
  private readonly wallets: Set<Address>;
  private readonly stateStore: TransientStateStore;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(private readonly options: { domain: string; wallets: Address[]; stateStore?: TransientStateStore; now?: () => Date; nonce?: () => string }) {
    this.wallets = new Set(options.wallets.map((wallet) => getAddress(wallet)));
    this.stateStore = options.stateStore ?? new MemoryTransientStateStore();
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(18).toString("base64url"));
  }

  get configured() {
    return this.wallets.size > 0;
  }

  isAdmin(address: string | undefined) {
    return Boolean(address && isAddress(address, { strict: false }) && this.wallets.has(getAddress(address)));
  }

  /** A one-time, five-minute message naming the wallet, the change and its exact payload (by hash). */
  async challenge(input: { address: string; action: AdminAction; payload: Record<string, unknown> }) {
    const address = getAddress(input.address);
    if (!this.isAdmin(address)) throw new AdminRefusedError("This wallet is not an admin of HaPaPay.");
    const id = this.nonce();
    const issuedAt = this.now();
    const expiresAt = issuedAt.getTime() + 5 * 60_000;
    const hash = payloadHash(input.payload);
    const message = [
      `${this.options.domain} admin change`,
      "",
      `Wallet: ${address}`,
      `Action: ${ADMIN_ACTIONS[input.action]}`,
      ...adminActionLines(input.action, input.payload),
      `Payload: ${hash}`,
      `Nonce: ${id}`,
      `Issued at: ${issuedAt.toISOString()}`,
      `Expiration: ${new Date(expiresAt).toISOString()}`,
      "This changes HaPaPay's records. It does not move funds.",
    ].join("\n");
    await this.stateStore.put("admin-action", id, { address, action: input.action, hash, message, expiresAt } satisfies ActionChallenge, expiresAt);
    return { id, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Takes the challenge (once) and checks the same wallet signed it for this action and this payload. */
  async verify(input: { address: string; challengeId: string; signature: Hex; action: AdminAction; payload: Record<string, unknown> }) {
    const challenge = await this.stateStore.take<ActionChallenge>("admin-action", input.challengeId);
    if (!challenge) throw new AdminRefusedError("This approval was not found or was already used. Sign the change again.");
    if (challenge.expiresAt <= this.now().getTime()) throw new AdminRefusedError("This approval expired. Sign the change again.");
    const address = getAddress(input.address);
    if (!this.isAdmin(address)) throw new AdminRefusedError("This wallet is not an admin of HaPaPay.");
    if (challenge.address !== address || challenge.action !== input.action || challenge.hash !== payloadHash(input.payload)) {
      throw new AdminRefusedError("The signed change does not match this request. Nothing changed.");
    }
    const valid = await verifyMessage({ address, message: challenge.message, signature: input.signature }).catch(() => false);
    if (!valid) throw new AdminRefusedError("The wallet signature does not match the change. Nothing changed.");
    return { message: challenge.message, signature: input.signature };
  }
}

export class AdminRefusedError extends Error {}

export type AdminAuditEntry = {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export interface AdminAuditRepository {
  record(entry: { actor: string; action: string; target?: string; details: Record<string, unknown> }): Promise<AdminAuditEntry>;
  list(filter: { limit: number; before?: string; action?: string; actor?: string }): Promise<AdminAuditEntry[]>;
}

export class MemoryAdminAuditRepository implements AdminAuditRepository {
  private readonly entries: AdminAuditEntry[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(entry: { actor: string; action: string; target?: string; details: Record<string, unknown> }) {
    const saved = { id: String(this.entries.length + 1), actor: entry.actor, action: entry.action, target: entry.target ?? null, details: structuredClone(entry.details), createdAt: this.now().toISOString() };
    this.entries.push(saved);
    return structuredClone(saved);
  }

  async list(filter: { limit: number; before?: string; action?: string; actor?: string }) {
    return this.entries
      .filter((entry) => (!filter.before || Number(entry.id) < Number(filter.before))
        && (!filter.action || entry.action === filter.action)
        && (!filter.actor || entry.actor.toLowerCase() === filter.actor.toLowerCase()))
      .reverse()
      .slice(0, filter.limit)
      .map((entry) => structuredClone(entry));
  }
}

export class PostgresAdminAuditRepository implements AdminAuditRepository {
  constructor(private readonly pool: SqlPool) {}

  /** The audit log keeps every row: a trigger refuses UPDATE, DELETE and TRUNCATE (`hapapay_append_only`, created with SP's tables). */
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGSERIAL PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at DESC)");
    for (const statement of appendOnlyTriggers("admin_audit_log")) await this.pool.query(statement);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async record(entry: { actor: string; action: string; target?: string; details: Record<string, unknown> }) {
    const result = await this.pool.query(
      "INSERT INTO admin_audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, actor, action, target, details, created_at",
      [entry.actor, entry.action, entry.target ?? null, JSON.stringify(entry.details)],
    );
    return auditRow(result.rows[0]);
  }

  async list(filter: { limit: number; before?: string; action?: string; actor?: string }) {
    const result = await this.pool.query(
      `SELECT id, actor, action, target, details, created_at FROM admin_audit_log
       WHERE ($2::bigint IS NULL OR id < $2::bigint) AND ($3::text IS NULL OR action = $3) AND ($4::text IS NULL OR lower(actor) = lower($4))
       ORDER BY id DESC LIMIT $1`,
      [filter.limit, filter.before ?? null, filter.action ?? null, filter.actor ?? null],
    );
    return result.rows.map(auditRow);
  }
}

const auditRow = (row: Record<string, unknown>): AdminAuditEntry => ({
  id: String(row.id),
  actor: String(row.actor),
  action: String(row.action),
  target: row.target === null || row.target === undefined ? null : String(row.target),
  details: (typeof row.details === "string" ? JSON.parse(row.details) : row.details) as Record<string, unknown>,
  createdAt: new Date(row.created_at as string | Date).toISOString(),
});

export type AdminSetting<T> = { value: T; updatedBy: string; updatedAt: string };

export interface AdminSettingsRepository {
  get<T>(key: string): Promise<AdminSetting<T> | undefined>;
  /** Every setting whose key starts with this prefix, by key. */
  list<T>(prefix: string): Promise<Map<string, AdminSetting<T>>>;
  set<T>(key: string, value: T, actor: string): Promise<AdminSetting<T>>;
}

export class MemoryAdminSettingsRepository implements AdminSettingsRepository {
  private readonly values = new Map<string, AdminSetting<unknown>>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async get<T>(key: string) {
    const value = this.values.get(key);
    return value ? structuredClone(value) as AdminSetting<T> : undefined;
  }

  async list<T>(prefix: string) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as AdminSetting<T>]));
  }

  async set<T>(key: string, value: T, actor: string) {
    const saved = { value: structuredClone(value), updatedBy: actor, updatedAt: this.now().toISOString() };
    this.values.set(key, saved);
    return structuredClone(saved);
  }
}

export class PostgresAdminSettingsRepository implements AdminSettingsRepository {
  constructor(private readonly pool: SqlPool, private readonly now: () => Date = () => new Date()) {}

  async get<T>(key: string) {
    const result = await this.pool.query("SELECT value, updated_by, updated_at FROM admin_settings WHERE key = $1", [key]);
    return result.rows[0] ? settingRow<T>(result.rows[0]) : undefined;
  }

  async list<T>(prefix: string) {
    // The prefix is matched as text, never as a pattern: `starts_with` has no wildcards to escape.
    const result = await this.pool.query("SELECT key, value, updated_by, updated_at FROM admin_settings WHERE starts_with(key, $1) ORDER BY key", [prefix]);
    return new Map(result.rows.map((row) => [String(row.key), settingRow<T>(row)]));
  }

  async set<T>(key: string, value: T, actor: string) {
    const updatedAt = this.now().toISOString();
    await this.pool.query(
      `INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), actor, updatedAt],
    );
    return { value, updatedBy: actor, updatedAt };
  }
}

const settingRow = <T>(row: Record<string, unknown>): AdminSetting<T> => ({
  value: (typeof row.value === "string" ? JSON.parse(row.value) : row.value) as T,
  updatedBy: String(row.updated_by),
  updatedAt: new Date(row.updated_at as string | Date).toISOString(),
});
