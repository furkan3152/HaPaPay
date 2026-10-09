import { getAddress, type Address } from "viem";
import type { Platform } from "../src/domain/payment-intent";
import { IdentityConflictError, type VerifiedSocialAccount } from "./verified-identity-service.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

function normalizeUsername(username: string) {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export class PostgresIdentityRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS social_identities (
        platform TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        verified_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (platform, provider_user_id),
        UNIQUE (platform, username_normalized)
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS social_identities_wallet_idx ON social_identities (wallet_address)");
  }

  async link(inputWallet: string, proof: VerifiedSocialAccount) {
    const wallet = getAddress(inputWallet);
    const username = normalizeUsername(proof.username);
    try {
      const values = [proof.platform, proof.providerUserId, username, wallet, proof.verifiedAt];
      const current = await this.pool.query(
        "SELECT wallet_address FROM social_identities WHERE platform = $1 AND provider_user_id = $2",
        [proof.platform, proof.providerUserId],
      );
      if (current.rows.length && getAddress(String(current.rows[0].wallet_address)) !== wallet) {
        throw new IdentityConflictError("This verified provider account is already linked to another wallet.");
      }
      // A handle another account still holds here changed hands at the provider: this sign-in proves who holds it now,
      // so the earlier account keeps its link under a released handle ("#" and its ID, which no handle can be) and
      // payments to the handle reach its new owner (audit, 2026-10-06).
      await this.pool.query(
        `UPDATE social_identities SET username_normalized = '#' || provider_user_id
         WHERE platform = $1 AND username_normalized = $2 AND provider_user_id <> $3`,
        [proof.platform, username, proof.providerUserId],
      );
      if (current.rows.length) {
        await this.pool.query(
          `UPDATE social_identities
           SET username_normalized = $3, verified_at = $5
           WHERE platform = $1 AND provider_user_id = $2 AND wallet_address = $4`,
          values,
        );
        return this.profile(wallet);
      }

      const inserted = await this.pool.query(
        `INSERT INTO social_identities
           (platform, provider_user_id, username_normalized, wallet_address, verified_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING wallet_address`,
        values,
      );
      if (!inserted.rows.length) throw new IdentityConflictError("This verified provider account is already linked to another wallet.");
      return this.profile(wallet);
    } catch (error) {
      if (error instanceof IdentityConflictError) throw error;
      const code = (error as { code?: string }).code;
      if (code === "23505" || (error instanceof Error && /unique|duplicate/i.test(error.message))) {
        throw new IdentityConflictError("This verified provider account or handle is already linked to another wallet.");
      }
      throw error;
    }
  }

  async resolve(platform: Platform, username: string): Promise<Address | undefined> {
    const result = await this.pool.query(
      "SELECT wallet_address FROM social_identities WHERE platform = $1 AND username_normalized = $2",
      [platform, normalizeUsername(username)],
    );
    const wallet = result.rows[0]?.wallet_address;
    return typeof wallet === "string" ? getAddress(wallet) : undefined;
  }

  async profile(inputWallet: string) {
    const wallet = getAddress(inputWallet);
    const result = await this.pool.query(
      "SELECT platform, username_normalized FROM social_identities WHERE wallet_address = $1 ORDER BY platform",
      [wallet],
    );
    return {
      wallet,
      accounts: result.rows.map((row) => ({
        platform: row.platform as Platform,
        username: String(row.username_normalized),
        verified: true as const,
      })),
    };
  }

  async account(inputWallet: string, platform: Platform): Promise<VerifiedSocialAccount | undefined> {
    const wallet = getAddress(inputWallet);
    const result = await this.pool.query(
      `SELECT provider_user_id, username_normalized, verified_at
       FROM social_identities WHERE wallet_address = $1 AND platform = $2
       ORDER BY verified_at DESC LIMIT 1`,
      [wallet, platform],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const verifiedAt = row.verified_at instanceof Date
      ? row.verified_at.toISOString()
      : new Date(String(row.verified_at)).toISOString();
    return {
      platform,
      providerUserId: String(row.provider_user_id),
      username: String(row.username_normalized),
      verifiedAt,
    };
  }

  async unlink(inputWallet: string, platform: Platform) {
    const wallet = getAddress(inputWallet);
    const removed = await this.pool.query(
      `DELETE FROM social_identities
       WHERE wallet_address = $1 AND platform = $2
       RETURNING provider_user_id`,
      [wallet, platform],
    );
    if (!removed.rows.length) return undefined;
    return this.profile(wallet);
  }
}
