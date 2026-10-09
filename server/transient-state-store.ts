type SqlResult = { rows: Array<Record<string, unknown>> };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

export interface TransientStateStore {
  put(namespace: string, key: string, value: unknown, expiresAt: number): Promise<void>;
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  take<T>(namespace: string, key: string): Promise<T | undefined>;
}

export class MemoryTransientStateStore implements TransientStateStore {
  private readonly records = new Map<string, { value: unknown; expiresAt: number }>();

  async put(namespace: string, key: string, value: unknown, expiresAt: number) {
    this.records.set(`${namespace}:${key}`, { value, expiresAt });
  }

  async get<T>(namespace: string, key: string) {
    const record = this.records.get(`${namespace}:${key}`);
    if (!record) return undefined;
    return record.value as T;
  }

  async take<T>(namespace: string, key: string) {
    const compoundKey = `${namespace}:${key}`;
    const record = this.records.get(compoundKey);
    if (!record) {
      this.records.delete(compoundKey);
      return undefined;
    }
    this.records.delete(compoundKey);
    return record.value as T;
  }
}

/** How often a store clears states that expired over an hour ago, after a write (audit, 2026-10-06: none ever were). */
const PURGE_EVERY_MS = 10 * 60_000;
const PURGE_GRACE_MS = 60 * 60_000;

export class PostgresTransientStateStore implements TransientStateStore {
  private purgedAt = 0;

  constructor(private readonly pool: SqlPool, private readonly now: () => number = Date.now) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS transient_security_states (
        namespace TEXT NOT NULL,
        state_key TEXT NOT NULL,
        state_value JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (namespace, state_key)
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS transient_security_states_expiry_idx ON transient_security_states (expires_at)");
  }

  async put(namespace: string, key: string, value: unknown, expiresAt: number) {
    await this.pool.query(
      `INSERT INTO transient_security_states (namespace, state_key, state_value, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (namespace, state_key) DO UPDATE
       SET state_value = EXCLUDED.state_value, expires_at = EXCLUDED.expires_at`,
      [namespace, key, JSON.stringify(value), new Date(expiresAt)],
    );
    const now = this.now();
    if (now - this.purgedAt >= PURGE_EVERY_MS) {
      this.purgedAt = now;
      // A purge that fails is tried again after the next interval; the write itself already succeeded.
      await this.pool.query("DELETE FROM transient_security_states WHERE expires_at < $1", [new Date(now - PURGE_GRACE_MS)]).catch(() => undefined);
    }
  }

  async get<T>(namespace: string, key: string) {
    const result = await this.pool.query(
      `SELECT state_value FROM transient_security_states
       WHERE namespace = $1 AND state_key = $2 AND expires_at > $3`,
      [namespace, key, new Date()],
    );
    return deserialize<T>(result.rows[0]?.state_value);
  }

  async take<T>(namespace: string, key: string) {
    const result = await this.pool.query(
      `DELETE FROM transient_security_states
       WHERE namespace = $1 AND state_key = $2 AND expires_at > $3
       RETURNING state_value`,
      [namespace, key, new Date()],
    );
    return deserialize<T>(result.rows[0]?.state_value);
  }
}

function deserialize<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
