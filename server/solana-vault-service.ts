import { createHash, randomBytes } from "node:crypto";
import { address, getBase58Decoder, isAddress, isSignature, signature as toSignature, type Address as SolanaAddress, type Base58EncodedBytes, type Base64EncodedWireTransaction } from "@solana/kit";
import type { Address } from "viem";
import { pagedPendingLinks, PENDING_CLAIMS_LIMIT, type SolanaPendingVaultLink, type VaultRecipient } from "../src/domain/pending-claims.js";
import { countedUiAmount, effectiveMultiplier, recordedUiAmount, unitsToUiAmount } from "../src/domain/solana-amounts.js";
import { NO_SOL_SENDING, isSolanaStock, type SolanaAssetListing } from "../src/domain/solana-assets.js";
import { SOLANA_MAINNET } from "../src/domain/solana-chains.js";
import { readDeployedProgram } from "../src/domain/solana-program-deploy.js";
import { vaultAssetByMint } from "../src/domain/solana-stocks.js";
import { SOLANA_MAX_COMPUTE_UNITS } from "../src/domain/solana-transfers.js";
import { SOLANA_VAULT_ARTIFACT } from "../src/domain/solana-vault-artifact.js";
import {
  compileVaultAction,
  compileVaultFunding,
  decodeVaultPayment,
  fromHex,
  platformHash,
  providerUserIdHash,
  solanaClaimPath,
  SOLANA_CLAIM_SIGNATURE_SECONDS,
  SOLANA_VAULT_CLOSE_WAIT_SECONDS,
  SOLANA_VAULT_MAX_WINDOW_SECONDS,
  SOLANA_VAULT_REVISION,
  VAULT_PAYMENT_SCAN,
  toHex,
  vaultClaimMessage,
  vaultFee,
  vaultHoldsAsset,
  vaultIdentityKey,
  vaultPaymentAddress,
  vaultToken,
  wireTransaction,
  type PreparedSolanaVaultAction,
  type PreparedSolanaVaultFunding,
  type SolanaVaultLinkDetails,
  type SolanaVaultStatus,
  type VaultPaymentState,
} from "../src/domain/solana-vault.js";
import { STOCK_CLAIM_PLATFORMS, STOCK_CLAIM_WINDOW_HOURS, isStockClaimPlatform, type StockClaimPlatform } from "../src/domain/stock-claims.js";
import type { Platform } from "../src/domain/payment-intent.js";
import { locksToName, type VaultLock } from "../src/domain/vault-lock.js";
import { RecipientLookupUnavailableError, type DiscoveredRecipient } from "./recipient-discovery.js";
import { anyClaimsLink, identityKeysOf, linkMadeAt, lockOfLink, notTheNameHolder, VaultNameLockOffer, vaultRecipient } from "./vault-recipient.js";
import type { SolanaConfig, SolanaRpc } from "./solana-network.js";
import { SolanaTransactionExpiredError, SolanaTransferError, SolanaUnavailableError, type SolanaTransferService } from "./solana-transfer-service.js";
import type { VerifiedSocialAccount } from "./verified-identity-service.js";
import type { VaultClaimCandidate, VaultSettlement } from "./vault-settlement.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

/**
 * The vault program the operator registered after the server read it back from chain. `retiredAt` is set when the
 * operator stops new links before closing the program; registering it again clears it.
 */
export type SolanaVaultRecord = { programId: string; owner: string; verifier: string; treasury: string; registeredAt: string; retiredAt?: string };

/** One funded vault link, recorded after its payment account was read back from the program. */
export type SolanaClaimRecord = {
  paymentId: `0x${string}`;
  programId: string;
  fundingSignature: string;
  mint: string;
  tokenSymbol: string;
  payerWallet: Address;
  payerAddress: string;
  recipientPlatform: StockClaimPlatform;
  recipientUsername: string;
  amount: string;
  units: bigint;
  expiry: bigint;
  slot: bigint;
  confirmedAt: string;
  sourcePlatform?: string;
  sourceUsername?: string;
};

export interface SolanaVaultRepository {
  /** Records a verified program; registering it again makes it the active one once more and takes new links again. */
  saveVault(record: SolanaVaultRecord): Promise<SolanaVaultRecord>;
  /** The most recently registered program: the one new links fund, unless it is retired. */
  activeVault(): Promise<SolanaVaultRecord | undefined>;
  /** Stops new links for a program; links it already holds stay claimable. Undefined when it is not registered. */
  retireVault(programId: string, retiredAt: string): Promise<SolanaVaultRecord | undefined>;
  vault(programId: string): Promise<SolanaVaultRecord | undefined>;
  /** Idempotent for the same funding signature; another signature for the same payment ID is refused. */
  saveClaim(record: SolanaClaimRecord): Promise<SolanaClaimRecord>;
  claim(paymentId: string): Promise<SolanaClaimRecord | undefined>;
  waitingFor(recipients: readonly VaultRecipient[], now: bigint, limit: number, offset?: number): Promise<SolanaClaimRecord[]>;
  fundedBy(payerWallet: Address, limit: number, offset?: number): Promise<SolanaClaimRecord[]>;
}

/** Only the operator's Solana address set on the server may register the program. Answered as 403. */
export class SolanaVaultOperatorError extends Error {
  constructor() {
    super("Only the operator's Solana address set on this server (SOLANA_OPERATOR_ADDRESS) can register, pause or close the vault program.");
    this.name = "SolanaVaultOperatorError";
  }
}

/** No vault holds a link with this ID. Answered as 404. */
export class SolanaClaimNotFoundError extends Error {
  constructor(message = "This claim link was not found.") {
    super(message);
    this.name = "SolanaClaimNotFoundError";
  }
}

/** The payment ID is already recorded with another funding transaction. Answered as 409. */
export class DuplicateSolanaClaimError extends Error {
  constructor() {
    super("This claim link was already recorded with another funding transaction.");
    this.name = "DuplicateSolanaClaimError";
  }
}

export class PostgresSolanaVaultRepository implements SolanaVaultRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS solana_vaults (
        program_id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        verifier_address TEXT NOT NULL,
        treasury_address TEXT NOT NULL,
        registered_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query("ALTER TABLE solana_vaults ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS solana_claims (
        payment_id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL,
        funding_signature TEXT NOT NULL UNIQUE,
        mint TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        payer_wallet TEXT NOT NULL,
        payer_address TEXT NOT NULL,
        recipient_platform TEXT NOT NULL,
        recipient_username_normalized TEXT NOT NULL,
        amount_text TEXT NOT NULL,
        units_text TEXT NOT NULL,
        expiry BIGINT NOT NULL,
        slot BIGINT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL,
        source_platform TEXT,
        source_username_normalized TEXT
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS solana_claims_recipient_idx ON solana_claims (recipient_platform, recipient_username_normalized, expiry)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS solana_claims_payer_idx ON solana_claims (payer_wallet, expiry DESC)");
  }

  async saveVault(record: SolanaVaultRecord) {
    const result = await this.pool.query(
      `INSERT INTO solana_vaults (program_id, owner_address, verifier_address, treasury_address, registered_at, retired_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (program_id) DO UPDATE
         SET owner_address = EXCLUDED.owner_address, verifier_address = EXCLUDED.verifier_address,
             treasury_address = EXCLUDED.treasury_address, registered_at = EXCLUDED.registered_at, retired_at = NULL
       RETURNING *`,
      [record.programId, record.owner, record.verifier, record.treasury, record.registeredAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Solana vault insert did not return a record.");
    return rowToVault(row);
  }

  async activeVault() {
    const result = await this.pool.query("SELECT * FROM solana_vaults ORDER BY registered_at DESC LIMIT 1");
    return result.rows[0] ? rowToVault(result.rows[0]) : undefined;
  }

  async vault(programId: string) {
    const result = await this.pool.query("SELECT * FROM solana_vaults WHERE program_id = $1", [programId]);
    return result.rows[0] ? rowToVault(result.rows[0]) : undefined;
  }

  async retireVault(programId: string, retiredAt: string) {
    await this.pool.query("UPDATE solana_vaults SET retired_at = $2 WHERE program_id = $1 AND retired_at IS NULL", [programId, retiredAt]);
    return this.vault(programId);
  }

  async saveClaim(record: SolanaClaimRecord) {
    let inserted: SqlResult;
    try {
      inserted = await this.pool.query(
        `INSERT INTO solana_claims
          (payment_id, program_id, funding_signature, mint, token_symbol, payer_wallet, payer_address, recipient_platform,
           recipient_username_normalized, amount_text, units_text, expiry, slot, confirmed_at, source_platform, source_username_normalized)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (payment_id) DO NOTHING
         RETURNING *`,
        [
          record.paymentId, record.programId, record.fundingSignature, record.mint, record.tokenSymbol, record.payerWallet, record.payerAddress,
          record.recipientPlatform, record.recipientUsername, record.amount, record.units.toString(), record.expiry.toString(),
          record.slot.toString(), record.confirmedAt, record.sourcePlatform ?? null, record.sourceUsername ?? null,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DuplicateSolanaClaimError();
      throw error;
    }
    const stored = inserted.rows[0] ? rowToClaim(inserted.rows[0]) : await this.claim(record.paymentId);
    if (!stored || stored.fundingSignature !== record.fundingSignature) throw new DuplicateSolanaClaimError();
    return stored;
  }

  async claim(paymentId: string) {
    const result = await this.pool.query("SELECT * FROM solana_claims WHERE payment_id = $1", [paymentId.toLowerCase()]);
    return result.rows[0] ? rowToClaim(result.rows[0]) : undefined;
  }

  async waitingFor(recipients: readonly VaultRecipient[], now: bigint, limit: number, offset = 0) {
    if (!recipients.length) return [];
    const matches = recipients.map((_, index) => `(recipient_platform = $${3 + index * 2} AND recipient_username_normalized = $${4 + index * 2})`);
    const result = await this.pool.query(
      `SELECT * FROM solana_claims WHERE expiry >= $1 AND (${matches.join(" OR ")}) ORDER BY expiry ASC, slot ASC, payment_id ASC LIMIT $2 OFFSET $${3 + recipients.length * 2}`,
      [now.toString(), limit, ...recipients.flatMap((recipient) => [recipient.platform, recipient.username]), offset],
    );
    return result.rows.map(rowToClaim);
  }

  async fundedBy(payerWallet: Address, limit: number, offset = 0) {
    const result = await this.pool.query("SELECT * FROM solana_claims WHERE payer_wallet = $1 ORDER BY expiry DESC, slot DESC, payment_id ASC LIMIT $2 OFFSET $3", [payerWallet, limit, offset]);
    return result.rows.map(rowToClaim);
  }
}

export class MemorySolanaVaultRepository implements SolanaVaultRepository {
  private readonly vaults = new Map<string, SolanaVaultRecord>();
  private readonly claims = new Map<string, SolanaClaimRecord>();

  async saveVault(record: SolanaVaultRecord) {
    const stored = { ...record, retiredAt: undefined };
    this.vaults.set(record.programId, stored);
    return stored;
  }

  async activeVault() {
    return [...this.vaults.values()].sort((left, right) => right.registeredAt.localeCompare(left.registeredAt))[0];
  }

  async vault(programId: string) {
    return this.vaults.get(programId);
  }

  async retireVault(programId: string, retiredAt: string) {
    const record = this.vaults.get(programId);
    if (record && !record.retiredAt) this.vaults.set(programId, { ...record, retiredAt });
    return this.vaults.get(programId);
  }

  async saveClaim(record: SolanaClaimRecord) {
    const key = record.paymentId.toLowerCase();
    const existing = this.claims.get(key);
    const reused = [...this.claims.values()].some((stored) => stored.fundingSignature === record.fundingSignature && stored.paymentId !== key);
    if ((existing && existing.fundingSignature !== record.fundingSignature) || reused) throw new DuplicateSolanaClaimError();
    const stored = existing ?? { ...record, paymentId: key as `0x${string}` };
    this.claims.set(key, stored);
    return stored;
  }

  async claim(paymentId: string) {
    return this.claims.get(paymentId.toLowerCase());
  }

  async waitingFor(recipients: readonly VaultRecipient[], now: bigint, limit: number, offset = 0) {
    return [...this.claims.values()]
      .filter((record) => record.expiry >= now && recipients.some((recipient) => recipient.platform === record.recipientPlatform && recipient.username === record.recipientUsername))
      .sort((left, right) => Number(left.expiry - right.expiry) || Number(left.slot - right.slot))
      .slice(offset, offset + limit);
  }

  async fundedBy(payerWallet: Address, limit: number, offset = 0) {
    return [...this.claims.values()]
      .filter((record) => record.payerWallet === payerWallet)
      .sort((left, right) => Number(right.expiry - left.expiry) || Number(right.slot - left.slot))
      .slice(offset, offset + limit);
  }
}

function rowToVault(row: Record<string, unknown>): SolanaVaultRecord {
  return {
    programId: String(row.program_id),
    owner: String(row.owner_address),
    verifier: String(row.verifier_address),
    treasury: String(row.treasury_address),
    registeredAt: new Date(String(row.registered_at)).toISOString(),
    ...(row.retired_at ? { retiredAt: new Date(String(row.retired_at)).toISOString() } : {}),
  };
}

function rowToClaim(row: Record<string, unknown>): SolanaClaimRecord {
  return {
    paymentId: String(row.payment_id) as `0x${string}`,
    programId: String(row.program_id),
    fundingSignature: String(row.funding_signature),
    mint: String(row.mint),
    tokenSymbol: String(row.token_symbol),
    payerWallet: String(row.payer_wallet) as Address,
    payerAddress: String(row.payer_address),
    recipientPlatform: String(row.recipient_platform) as StockClaimPlatform,
    recipientUsername: String(row.recipient_username_normalized),
    amount: String(row.amount_text),
    units: BigInt(String(row.units_text)),
    expiry: BigInt(String(row.expiry)),
    slot: BigInt(String(row.slot)),
    confirmedAt: new Date(String(row.confirmed_at)).toISOString(),
    sourcePlatform: row.source_platform ? String(row.source_platform) : undefined,
    sourceUsername: row.source_username_normalized ? String(row.source_username_normalized) : undefined,
  };
}

type RecipientDirectory = {
  lookup(platform: Platform, username: string): Promise<DiscoveredRecipient>;
  supports?(platform: Platform): boolean;
};

/** Rent of the payment record the program keeps for good, so a payment ID can never be funded twice. */
const PAYMENT_ACCOUNT_BYTES = 163n;

/** A link's identity key as the program stores it, for a platform and a lock ID (an account ID, or a name). */
function solanaKey(platform: StockClaimPlatform, lockId: string) {
  return toHex(vaultIdentityKey(platformHash(platform), providerUserIdHash(lockId)));
}
/** An SPL token account: the vault's own, and a payer's wrapped-SOL account while a SOL link is funded. */
const TOKEN_ACCOUNT_BYTES = 165n;
/** The mint and token program a link shows for an asset: the vault's own token, wrapped SOL for SOL. */
const vaultView = (asset: SolanaAssetListing) => {
  const { mint, program } = vaultToken(asset);
  return { mint, program };
};
const SIGNATURE_FEE_LAMPORTS = 5_000n;

function validPaymentId(input: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input)) throw new SolanaClaimNotFoundError();
  return input.toLowerCase() as `0x${string}`;
}

/** Whether these bytes are exactly the pinned vault build, followed only by zeros. */
export function codeIsVaultBuild(code: Uint8Array | undefined) {
  if (!code || code.length < SOLANA_VAULT_ARTIFACT.size) return false;
  const digest = createHash("sha256").update(code.subarray(0, SOLANA_VAULT_ARTIFACT.size)).digest("hex");
  return digest === SOLANA_VAULT_ARTIFACT.sha256 && code.subarray(SOLANA_VAULT_ARTIFACT.size).every((byte) => byte === 0);
}

/**
 * HaPaPay's Solana vault: links for USDC, USDG and xStocks sent to
 * someone who has not joined, waiting for their account or their name (`vault-lock.ts`). The payer's wallet funds the
 * program; the recipient's wallet claims after the official provider proves the account the link waits for, and the
 * server's Solana attestor signs that one claim. The server builds unsigned transactions only and never signs or sends
 * a transfer.
 */
export class SolanaVaultService {
  private readonly now: () => Date;
  private readonly cacheMs: number;
  private active?: { record?: SolanaVaultRecord; readAt: number };
  private readonly verified = new Map<string, number>();

  constructor(private readonly options: {
    config: SolanaConfig;
    rpc: SolanaRpc;
    repository: SolanaVaultRepository;
    transfers: Pick<SolanaTransferService, "availability" | "mintState" | "checkMint" | "units" | "balances" | "computePrice" | "onMainnet"> & Partial<Pick<SolanaTransferService, "expired">>;
    directory: RecipientDirectory;
    now?: () => Date;
    randomBytes32?: () => Uint8Array;
    cacheMs?: number;
    confirmAttempts?: number;
    confirmRetryMs?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.cacheMs = options.cacheMs ?? 30_000;
  }

  private seconds() {
    return BigInt(Math.floor(this.now().getTime() / 1000));
  }

  /** The environment variable names still missing before a program can be registered. */
  private setup() {
    const { config } = this.options;
    return [
      ...(config.operator ? [] : ["SOLANA_OPERATOR_ADDRESS"]),
      ...(config.attestor ? [] : ["SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY"]),
      ...(config.treasury ? [] : ["SOLANA_TREASURY_ADDRESS"]),
    ];
  }

  private async activeVault() {
    if (this.active && this.now().getTime() - this.active.readAt < this.cacheMs) return this.active.record;
    const record = await this.options.repository.activeVault();
    this.active = { record, readAt: this.now().getTime() };
    return record;
  }

  /**
   * Reads a program back from chain and refuses anything but the pinned build, upgradeable only by this server's
   * operator (or by nobody), with this server's operator, attestor and treasury in its settings and the 1% fee. The
   * operator could replace the code, so every transaction is prepared only after a fresh read (`fresh`).
   */
  private async verifyProgram(programId: string, options: { fresh?: boolean; codeOnly?: boolean } = {}) {
    const { config } = this.options;
    const cached = this.verified.get(programId);
    if (!options.fresh && cached && this.now().getTime() - cached < this.cacheMs) return;
    if (!isAddress(programId)) throw new SolanaTransferError("This is not a Solana program address.");
    await this.options.transfers.onMainnet();
    let deployed;
    try {
      deployed = await readDeployedProgram(this.options.rpc, programId);
    } catch {
      throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
    }
    if (!deployed?.code) throw new SolanaTransferError("No upgradeable-loader program with code was found at this address on Solana.");
    if (!codeIsVaultBuild(deployed.code)) throw new SolanaTransferError("This program's code is not the HaPaPay vault build this server accepts.");
    if (deployed.authority !== undefined && deployed.authority !== config.operator) throw new SolanaTransferError("This program's upgrade authority is not the operator address set on this server.");
    // A refund needs only the reviewed code: it pays the payer back whatever the settings say now.
    if (options.codeOnly) return;
    const settings = deployed.config;
    if (!settings || settings.revision !== SOLANA_VAULT_REVISION || settings.feeBps !== 100) throw new SolanaTransferError("This program's settings are missing or are not revision 1 with the 1% fee.");
    if (settings.owner !== config.operator) throw new SolanaTransferError("This program's owner is not the operator address set on this server.");
    if (settings.verifier !== config.attestor?.publicKey) throw new SolanaTransferError("This program's claim attestor is not the key set on this server.");
    if (settings.treasury !== config.treasury) throw new SolanaTransferError("This program's treasury is not the treasury set on this server.");
    this.verified.set(programId, this.now().getTime());
  }

  /** Whether new links can be funded, and the program and platforms they use. */
  async availability(): Promise<{ enabled: boolean; reason?: string; programId?: string; platforms?: StockClaimPlatform[] }> {
    const { config } = this.options;
    if (!config.transfers.enabled && !config.stocks.enabled) return { enabled: false, reason: config.transfers.reason ?? "Solana transfers are off on this server." };
    if (this.setup().length) return { enabled: false, reason: "Vault links are not set up on Solana yet." };
    let record: SolanaVaultRecord | undefined;
    try {
      record = await this.activeVault();
    } catch {
      return { enabled: false, reason: "The Solana vault could not be read just now." };
    }
    if (!record) return { enabled: false, reason: "The Solana vault program is not deployed yet." };
    if (record.retiredAt) return { enabled: false, reason: "New vault links are stopped on Solana: the operator is closing the vault program. Links already sent can still be claimed or taken back." };
    try {
      await this.verifyProgram(record.programId);
    } catch (error) {
      return { enabled: false, reason: error instanceof SolanaTransferError ? `The registered Solana vault no longer matches this server: ${error.message}` : "The Solana vault could not be read just now." };
    }
    // Discord, Telegram and X links can wait for the name, so they need no lookup (2026-10-06).
    const platforms = STOCK_CLAIM_PLATFORMS.filter((platform) => locksToName(platform) || (this.options.directory.supports?.(platform) ?? true));
    return { enabled: true, programId: record.programId, platforms };
  }

  async status(): Promise<SolanaVaultStatus> {
    const { config } = this.options;
    const availability = await this.availability();
    let record: SolanaVaultRecord | undefined;
    try {
      record = await this.activeVault();
    } catch {
      record = undefined;
    }
    const program = record ? { id: record.programId, registeredAt: record.registeredAt, ...(record.retiredAt ? await this.closeState(record.programId, record.retiredAt) : {}) } : undefined;
    return {
      network: SOLANA_MAINNET.id,
      artifact: { size: SOLANA_VAULT_ARTIFACT.size, sha256: SOLANA_VAULT_ARTIFACT.sha256, revision: SOLANA_VAULT_REVISION, path: SOLANA_VAULT_ARTIFACT.path },
      operator: config.operator,
      verifier: config.attestor?.publicKey,
      treasury: config.treasury,
      setup: this.setup(),
      ...(program ? { program } : {}),
      enabled: availability.enabled,
      ...(program?.closed ? { reason: "The Solana vault program is closed. Deploy a new one to open vault links again." } : availability.reason ? { reason: availability.reason } : {}),
    };
  }

  /**
   * For a program whose new links are stopped: whether its code account is still there, and the links it still holds,
   * read from chain (every open payment account, not only the ones recorded here). It can be closed once it holds
   * none and new links have been stopped longer than any funding prepared before could still land.
   */
  private async closeState(programId: string, retiredAt: string): Promise<{ retiredAt: string; closed?: boolean; close?: NonNullable<SolanaVaultStatus["program"]>["close"] }> {
    const readyAt = new Date(new Date(retiredAt).getTime() + SOLANA_VAULT_CLOSE_WAIT_SECONDS * 1000).toISOString();
    try {
      await this.options.transfers.onMainnet();
      const deployed = await readDeployedProgram(this.options.rpc, programId);
      if (!deployed?.code) return { retiredAt, closed: true };
      const expiries = await this.openPaymentExpiries(programId);
      const lastExpiry = expiries.length ? new Date(Number(expiries.reduce((latest, expiry) => (expiry > latest ? expiry : latest))) * 1000).toISOString() : undefined;
      return { retiredAt, close: { openLinks: expiries.length, ...(lastExpiry ? { lastExpiry } : {}), readyAt, ready: expiries.length === 0 && this.now().getTime() >= new Date(readyAt).getTime() } };
    } catch {
      return { retiredAt };
    }
  }

  /** The expiry of every payment the program still holds: its open payment accounts, read with a filtered scan. */
  private async openPaymentExpiries(programId: string) {
    const base58 = getBase58Decoder();
    const header = new Uint8Array([...new TextEncoder().encode(VAULT_PAYMENT_SCAN.tag), SOLANA_VAULT_REVISION]);
    const accounts = await this.options.rpc.getProgramAccounts(address(programId), {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: VAULT_PAYMENT_SCAN.expiryOffset, length: 8 },
      filters: [
        { dataSize: BigInt(VAULT_PAYMENT_SCAN.size) },
        { memcmp: { offset: 0n, bytes: base58.decode(header) as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: BigInt(VAULT_PAYMENT_SCAN.statusOffset), bytes: base58.decode(new Uint8Array([VAULT_PAYMENT_SCAN.open])) as Base58EncodedBytes, encoding: "base58" } },
      ],
    }).send();
    return accounts.map(({ account }) => Buffer.from((account.data as unknown as [string, string])[0], "base64").readBigInt64LE(0));
  }

  /**
   * Stops new links on the active program, the first step before the operator closes it. Links it already holds stay
   * claimable and refundable; registering the program again takes new links once more.
   */
  async retire(input: { operatorAddress?: string }) {
    const { config } = this.options;
    if (!config.operator || !input.operatorAddress || input.operatorAddress !== config.operator) throw new SolanaVaultOperatorError();
    this.active = undefined;
    const record = await this.activeVault();
    if (!record) throw new SolanaTransferError("No Solana vault program is registered.");
    await this.options.repository.retireVault(record.programId, this.now().toISOString());
    this.active = undefined;
    return this.status();
  }

  /** Registers a deployed program after reading it back. `operatorAddress` is the session's verified Solana address. */
  async register(input: { programId: string; operatorAddress?: string }) {
    const { config } = this.options;
    const setup = this.setup();
    if (setup.length) throw new SolanaUnavailableError(`This server needs ${setup.join(" and ")} before the Solana vault can be registered.`);
    if (!input.operatorAddress || input.operatorAddress !== config.operator) throw new SolanaVaultOperatorError();
    await this.verifyProgram(input.programId, { fresh: true });
    await this.options.repository.saveVault({ programId: input.programId, owner: config.operator!, verifier: config.attestor!.publicKey, treasury: config.treasury!, registeredAt: this.now().toISOString() });
    this.active = undefined;
    return this.status();
  }

  /** The account or name a link waits for (`vaultRecipient`); X's offer of a name lock reaches the slip as it is. */
  private async recipient(platform: StockClaimPlatform, username: string, lock?: VaultLock) {
    try {
      return await vaultRecipient(this.options.directory, platform, username, lock);
    } catch (error) {
      if (error instanceof VaultNameLockOffer) throw error;
      const message = error instanceof Error ? error.message : "The account could not be looked up.";
      if (/not found|invalid/i.test(message)) throw new SolanaTransferError(message);
      // The directory's own words for a refused, limited or unreachable lookup; anything else is never shown as it is.
      throw new SolanaUnavailableError(error instanceof RecipientLookupUnavailableError ? message : "The account could not be looked up just now. Try again in a moment.");
    }
  }

  private async latest() {
    try {
      return (await this.options.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    } catch {
      throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
    }
  }

  /** Simulates the transaction from its signer and returns the compute limit it needs, or a readable refusal. */
  private async measure(transaction: string, refusal: (logs: string) => string) {
    let simulation;
    try {
      simulation = (await this.options.rpc.simulateTransaction(transaction as Base64EncodedWireTransaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }).send()).value;
    } catch {
      throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
    }
    if (simulation.err) {
      const text = `${(simulation.logs ?? []).join("\n")}\n${JSON.stringify(simulation.err, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`;
      throw new SolanaTransferError(refusal(text));
    }
    const consumed = Number(simulation.unitsConsumed ?? BigInt(SOLANA_MAX_COMPUTE_UNITS));
    return Math.min(SOLANA_MAX_COMPUTE_UNITS, Math.ceil(consumed * 1.15) + 2_000);
  }

  private async rent(bytes: bigint) {
    try {
      return BigInt(await this.options.rpc.getMinimumBalanceForRentExemption(bytes).send());
    } catch {
      throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
    }
  }

  /**
   * One unsigned `create_payment` for a reviewed link: the amount and 1% move from the payer's token account into the
   * payment's own account, locked to the recipient's immutable account ID. Nothing is recorded until it lands.
   */
  async prepare(input: { payer: string; asset: SolanaAssetListing; amount: string; platform: StockClaimPlatform; username: string; expiryHours: number; lock?: VaultLock }): Promise<PreparedSolanaVaultFunding> {
    const { asset } = input;
    // HaPaPay does not send SOL: refused before anything is read.
    if (asset.kind === "native") throw new SolanaTransferError(NO_SOL_SENDING);
    const availability = await this.availability();
    if (!availability.enabled || !availability.programId) throw new SolanaUnavailableError(availability.reason ?? "Vault links are off on Solana.");
    // The operator holds the upgrade authority, so the code is read again before anything is prepared.
    await this.verifyProgram(availability.programId, { fresh: true });
    if (!vaultHoldsAsset(asset)) throw new SolanaTransferError("A Solana vault link holds USDC, USDG and xStocks only.");
    const assetSwitch = this.options.transfers.availability(asset);
    if (!assetSwitch.enabled) throw new SolanaUnavailableError(assetSwitch.reason ?? `${asset.symbol} transfers are off on Solana.`);
    if (!isStockClaimPlatform(input.platform) || !(availability.platforms ?? []).includes(input.platform)) {
      throw new SolanaUnavailableError("This server cannot look up accounts on that platform, so it cannot lock a vault link to one.");
    }
    const { min, max } = STOCK_CLAIM_WINDOW_HOURS;
    if (!Number.isInteger(input.expiryHours) || input.expiryHours < min || input.expiryHours > max) throw new SolanaTransferError("The claim window must be between 24 hours and 30 days.");
    if (!isAddress(input.payer)) throw new SolanaTransferError("Add a Solana address to your wallet before sending on Solana.");
    const decimals = input.amount.split(".")[1]?.length ?? 0;
    if (!/^\d+(?:\.\d+)?$/.test(input.amount) || decimals > asset.decimals) throw new SolanaTransferError(`Enter a ${asset.symbol} amount greater than zero with at most ${asset.decimals} decimals.`);
    const identity = await this.recipient(input.platform, input.username, input.lock);
    const now = this.seconds();
    const state = await this.options.transfers.mintState(asset);
    this.options.transfers.checkMint(asset, state, now);
    const { units, multiplier } = this.options.transfers.units(asset, input.amount, state, now);
    const feeUnits = vaultFee(units);
    const balance = await this.options.transfers.balances(input.payer, asset);
    // SOL pays for the link too: the payment record's rent (kept for good), the vault's token account (back when the
    // link settles), the wrapped-SOL account for the moment it is open, and the network fee.
    const reserve = vaultToken(asset).wrapped ? await this.rent(PAYMENT_ACCOUNT_BYTES) + 2n * await this.rent(TOKEN_ACCOUNT_BYTES) + 2n * SIGNATURE_FEE_LAMPORTS : 0n;
    if (balance.units < units + feeUnits + reserve) {
      const need = unitsToUiAmount(units + feeUnits, asset.decimals, multiplier);
      const have = unitsToUiAmount(balance.units, asset.decimals, multiplier);
      throw new SolanaTransferError(`Your Solana wallet holds ${have} ${asset.symbol}; this link needs ${need} ${asset.symbol}, the amount plus the 1% fee${reserve ? `, and about ${unitsToUiAmount(reserve, asset.decimals, 1)} SOL more for its rent and the network fee` : ""}.`);
    }
    const paymentId = this.options.randomBytes32?.() ?? Uint8Array.from(randomBytes(32));
    if (paymentId.length !== 32) throw new Error("Invalid payment ID source.");
    const expiry = now + BigInt(input.expiryHours * 60 * 60);
    const latest = await this.latest();
    const programId = availability.programId;
    const payment = await vaultPaymentAddress(programId, paymentId);
    const computeUnitPrice = await this.options.transfers.computePrice([address(input.payer), payment as SolanaAddress]);
    const plan = {
      programId, payer: input.payer, asset, paymentId, platformHash: platformHash(identity.platform), providerUserIdHash: providerUserIdHash(identity.providerUserId),
      units, expiry, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, computeUnitPrice,
    };
    const limit = await this.measure(wireTransaction(await compileVaultFunding({ ...plan, computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS })), (text) =>
      /insufficient (funds|lamports)|InsufficientFunds/i.test(text)
        ? "Your Solana wallet needs a little more SOL for the network fee and the link's rent."
        : `Solana would refuse this ${asset.symbol} vault link right now. Nothing was prepared.`);
    const transaction = wireTransaction(await compileVaultFunding({ ...plan, computeUnitLimit: limit }));
    const rent = await this.rent(PAYMENT_ACCOUNT_BYTES);
    return {
      network: SOLANA_MAINNET.id,
      programId,
      payer: input.payer,
      paymentId: toHex(paymentId) as `0x${string}`,
      platform: identity.platform,
      providerUserIdHash: toHex(providerUserIdHash(identity.providerUserId)) as `0x${string}`,
      recipient: { platform: identity.platform, username: identity.username },
      lock: identity.lock,
      asset: { symbol: asset.symbol, name: asset.name, ...vaultView(asset), decimals: asset.decimals, kind: asset.kind, ...(asset.scaled ? { scaled: true } : {}) },
      amount: input.amount,
      units: units.toString(),
      feeUnits: feeUnits.toString(),
      ...(asset.scaled ? { multiplier } : {}),
      expiry: expiry.toString(),
      expiresAt: new Date(Number(expiry) * 1000).toISOString(),
      rentLamports: rent.toString(),
      networkFeeLamports: (SIGNATURE_FEE_LAMPORTS + (BigInt(limit) * computeUnitPrice + 999_999n) / 1_000_000n).toString(),
      claimPath: solanaClaimPath(toHex(paymentId)),
      transaction,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight.toString(),
      computeUnitLimit: limit,
      computeUnitPrice: computeUnitPrice.toString(),
    };
  }

  /**
   * For SP: how a recorded link ended. The program keeps a settled link's account with its status (claimed or
   * refunded) and the account it was locked to, so whichever candidate holds that account claimed it.
   */
  async settlement(record: Pick<SolanaClaimRecord, "programId" | "paymentId">, input: { candidates: readonly VaultClaimCandidate[] }): Promise<VaultSettlement> {
    const payment = await this.readPayment(record.programId, record.paymentId);
    if (!payment) return { state: "unknown" };
    if (payment.status === "open") return { state: "open" };
    if (payment.status === "refunded") return { state: "refunded" };
    const key = toHex(payment.identityKey).toLowerCase();
    const claimer = input.candidates.find((candidate) => candidate.accounts.some((account) => identityKeysOf(account, solanaKey).includes(key)));
    return { state: "claimed", claimer: claimer?.wallet ?? null };
  }

  private async readPayment(programId: string, paymentId: `0x${string}`) {
    await this.options.transfers.onMainnet();
    let info;
    try {
      info = await this.options.rpc.getAccountInfo(await vaultPaymentAddress(programId, fromHex(paymentId)), { encoding: "base64", commitment: "confirmed" }).send();
    } catch {
      throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
    }
    if (!info.value || info.value.owner !== programId) return undefined;
    return decodeVaultPayment(Uint8Array.from(Buffer.from(info.value.data[0], "base64")));
  }

  private async readTransaction(signatureText: string) {
    await this.options.transfers.onMainnet();
    const attempts = this.options.confirmAttempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      try {
        const transaction = await this.options.rpc.getTransaction(toSignature(signatureText), { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
        if (transaction || attempt >= attempts) return transaction;
      } catch {
        if (attempt >= attempts) throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
      }
      await new Promise((done) => setTimeout(done, this.options.confirmRetryMs ?? 1_000));
    }
  }

  /**
   * Records a link once its transaction is confirmed and the program holds exactly the reviewed payment: this payer,
   * mint, account, units and fee. One payment ID is recorded with one transaction only. A link whose window has closed
   * is recorded too, so its payer finds it under Claims and takes it back (audit, 2026-10-06: a funding recorded only
   * after its window had nowhere to appear, and its payment ID was shown nowhere).
   */
  async confirmFunding(input: {
    signature: string;
    paymentId: string;
    programId: string;
    payerWallet: Address;
    payerAddress: string;
    asset: SolanaAssetListing;
    amount: string;
    units: string;
    platform: StockClaimPlatform;
    username: string;
    /** The lock the prepared link carried: a link waiting for a name is checked without a lookup. */
    lock?: VaultLock;
    source?: { platform: string; username: string };
    /** The prepared transaction's, so one that can no longer land is told apart from one not confirmed yet. */
    lastValidBlockHeight?: bigint;
  }) {
    if (!isSignature(input.signature)) throw new SolanaTransferError("This is not a Solana transaction signature.");
    const paymentId = validPaymentId(input.paymentId);
    if (!await this.options.repository.vault(input.programId)) throw new SolanaTransferError("This is not the registered Solana vault program.");
    // SOL is no longer prepared, but a SOL link funded before then is still recorded.
    if (!vaultHoldsAsset(input.asset) && input.asset.kind !== "native") throw new SolanaTransferError("A Solana vault link holds USDC, USDG and xStocks only.");
    const units = BigInt(input.units);
    if (units <= 0n) throw new SolanaTransferError("A vault link must hold more than zero.");
    const identity = await this.recipient(input.platform, input.username, input.lock);
    const identityKey = toHex(vaultIdentityKey(platformHash(identity.platform), providerUserIdHash(identity.providerUserId)));
    const transaction = await this.readTransaction(input.signature);
    if (!transaction) {
      if (input.lastValidBlockHeight !== undefined && await this.options.transfers.expired?.(input.signature, input.lastValidBlockHeight)) throw new SolanaTransactionExpiredError();
      throw new SolanaTransferError("Solana has not confirmed this transaction yet. Verify it again in a moment.");
    }
    if (transaction.meta?.err) throw new SolanaTransferError("This Solana transaction failed, so nothing is held in the vault.");
    const keys = transaction.transaction.message.accountKeys.map((key) => String(typeof key === "string" ? key : key.pubkey));
    if (keys[0] !== input.payerAddress) throw new SolanaTransferError("This transaction was not sent from your Solana address.");
    const paymentAccount = await vaultPaymentAddress(input.programId, fromHex(paymentId));
    if (!keys.includes(paymentAccount) || !keys.includes(input.programId)) throw new SolanaTransferError("This transaction did not fund this vault link.");
    const payment = await this.readPayment(input.programId, paymentId);
    if (!payment) throw new SolanaTransferError("The vault does not hold this link.");
    if (payment.payer !== input.payerAddress || payment.mint !== vaultToken(input.asset).mint || toHex(payment.identityKey) !== identityKey || payment.units !== units || payment.feeUnits !== vaultFee(units)) {
      throw new SolanaTransferError("The vault does not hold the reviewed link.");
    }
    const record = await this.options.repository.saveClaim({
      paymentId,
      programId: input.programId,
      fundingSignature: input.signature,
      mint: vaultToken(input.asset).mint,
      tokenSymbol: input.asset.symbol,
      payerWallet: input.payerWallet,
      payerAddress: input.payerAddress,
      recipientPlatform: identity.platform,
      recipientUsername: identity.username,
      // The amount comes from the units the vault holds; the browser's amount is kept only when it names exactly them.
      amount: await this.recordedAmount(input.asset, input.amount, units),
      units,
      expiry: payment.expiry,
      slot: BigInt(transaction.slot),
      confirmedAt: transaction.blockTime ? new Date(Number(transaction.blockTime) * 1000).toISOString() : this.now().toISOString(),
      sourcePlatform: input.source?.platform,
      sourceUsername: input.source?.username.trim().replace(/^@/, "").toLowerCase(),
    });
    return { paymentId: record.paymentId, claimPath: solanaClaimPath(record.paymentId), expiresAt: new Date(Number(record.expiry) * 1000).toISOString() };
  }

  /** The program a link lives in: the one its record names, or the active one for a link funded elsewhere. */
  private async programFor(paymentId: `0x${string}`) {
    const record = await this.options.repository.claim(paymentId);
    const programId = record?.programId ?? (await this.activeVault())?.programId;
    if (!programId) throw new SolanaClaimNotFoundError();
    return { record, programId };
  }

  private async amountOf(asset: SolanaAssetListing, units: bigint) {
    if (!asset.scaled) return unitsToUiAmount(units, asset.decimals, 1);
    const state = await this.options.transfers.mintState(asset);
    return unitsToUiAmount(units, asset.decimals, effectiveMultiplier(state.scaled, this.seconds()));
  }

  private async recordedAmount(asset: SolanaAssetListing, reviewed: string, units: bigint) {
    const multiplier = asset.scaled ? effectiveMultiplier((await this.options.transfers.mintState(asset)).scaled, this.seconds()) : 1;
    return recordedUiAmount(reviewed, units, asset.decimals, multiplier);
  }

  async details(paymentIdInput: string): Promise<SolanaVaultLinkDetails> {
    const paymentId = validPaymentId(paymentIdInput);
    const { record, programId } = await this.programFor(paymentId);
    const payment = await this.readPayment(programId, paymentId);
    const labels = record ? {
      recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
      fundingSignature: record.fundingSignature,
      ...(record.sourcePlatform && record.sourceUsername ? { sourceIdentity: { platform: record.sourcePlatform, username: record.sourceUsername } } : {}),
    } : {};
    if (!payment) {
      if (!record) throw new SolanaClaimNotFoundError();
      throw new SolanaUnavailableError("The vault does not show this link right now. Try again in a moment.");
    }
    const asset = vaultAssetByMint(payment.mint);
    if (!asset) throw new SolanaClaimNotFoundError("This claim link does not hold a listed token.");
    const view = { symbol: asset.symbol, name: asset.name, ...vaultView(asset), decimals: asset.decimals, kind: asset.kind };
    const base = { network: SOLANA_MAINNET.id, programId, paymentId, payer: payment.payer, asset: view, expiresAt: new Date(Number(payment.expiry) * 1000).toISOString() };
    // A settled link names nobody: its page only says it was claimed or refunded (audit, 2026-10-06).
    if (payment.status !== "open") {
      return { ...base, ...(record ? { fundingSignature: record.fundingSignature } : {}), amount: (record && countedUiAmount(record, asset)) ?? await this.amountOf(asset, payment.units), status: "settled" };
    }
    return {
      ...base,
      ...labels,
      ...(record ? { lock: lockOfLink({ platform: record.recipientPlatform, username: record.recipientUsername }, toHex(payment.identityKey), solanaKey) } : {}),
      amount: await this.amountOf(asset, payment.units),
      fee: await this.amountOf(asset, payment.feeUnits),
      status: this.seconds() > payment.expiry ? "expired" : "claimable",
    };
  }

  private async action(plan: Parameters<typeof compileVaultAction>[0], refusal: (text: string) => string) {
    const limit = await this.measure(wireTransaction(await compileVaultAction({ ...plan, computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS })), refusal);
    return { transaction: wireTransaction(await compileVaultAction({ ...plan, computeUnitLimit: limit })), computeUnitLimit: limit };
  }

  /**
   * The attestor's signature over this one claim, for the session's Solana address, when a verified account is the
   * one the link is locked to. An xStock claim also needs the recipient's eligibility statement.
   */
  async prepareClaim(input: { paymentId: string; wallet?: string; accounts: VerifiedSocialAccount[]; eligibilityConfirmed?: boolean }): Promise<PreparedSolanaVaultAction> {
    const { config } = this.options;
    if (!config.attestor || !config.treasury) throw new SolanaUnavailableError("Vault links are not set up on Solana.");
    if (!input.wallet) throw new SolanaTransferError("Add a Solana address to your wallet before claiming on Solana.");
    const paymentId = validPaymentId(input.paymentId);
    const { record, programId } = await this.programFor(paymentId);
    await this.verifyProgram(programId, { fresh: true });
    const payment = await this.readPayment(programId, paymentId);
    if (!payment) throw new SolanaClaimNotFoundError();
    if (payment.status !== "open") throw new SolanaTransferError("This claim link was already claimed or refunded.");
    const asset = vaultAssetByMint(payment.mint);
    if (!asset) throw new SolanaClaimNotFoundError("This claim link does not hold a listed token.");
    const assetSwitch = this.options.transfers.availability(asset);
    if (!assetSwitch.enabled) throw new SolanaUnavailableError(assetSwitch.reason ?? `${asset.symbol} transfers are off on Solana.`);
    if (isSolanaStock(asset) && input.eligibilityConfirmed !== true) throw new SolanaTransferError("Confirm that you may hold xStocks before claiming.");
    const now = this.seconds();
    if (now > payment.expiry) throw new SolanaTransferError("The claim window has closed. The sender can take the tokens back.");
    const key = toHex(payment.identityKey);
    // The account the link waits for, or on Discord, Telegram and X the name, held by an account older than the link.
    const matched = anyClaimsLink(input.accounts, key, solanaKey, linkMadeAt(record, payment.expiry, SOLANA_VAULT_MAX_WINDOW_SECONDS));
    if (!matched) throw new SolanaTransferError(record && lockOfLink({ platform: record.recipientPlatform, username: record.recipientUsername }, key, solanaKey) === "name"
      ? notTheNameHolder(record.recipientPlatform, record.recipientUsername)
      : "None of your verified accounts is the one this claim is locked to. Connect it through its official provider first.");
    const claimDeadline = now + BigInt(SOLANA_CLAIM_SIGNATURE_SECONDS) < payment.expiry ? now + BigInt(SOLANA_CLAIM_SIGNATURE_SECONDS) : payment.expiry;
    const message = vaultClaimMessage({ programId, paymentId: fromHex(paymentId), identityKey: payment.identityKey, mint: payment.mint, recipient: input.wallet, units: payment.units, expiry: payment.expiry, claimDeadline });
    const attestation = { publicKey: config.attestor.publicKey, signature: config.attestor.sign(message), message };
    const latest = await this.latest();
    const computeUnitPrice = await this.options.transfers.computePrice([address(input.wallet)]);
    const plan = {
      action: "claim" as const, programId, wallet: input.wallet, paymentId: fromHex(paymentId), asset, payer: payment.payer, treasury: config.treasury,
      blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS, computeUnitPrice, claimDeadline, attestation,
    };
    const built = await this.action(plan, (text) => /insufficient (funds|lamports)|InsufficientFunds|no record of a prior credit|AccountNotFound/i.test(text)
      ? "Your Solana wallet needs a little SOL (about 0.002, a little more when the network is busy) for the network fee and your token account before it can claim."
      : `Solana would refuse this claim right now.`);
    return {
      network: SOLANA_MAINNET.id, action: "claim", programId, paymentId, wallet: input.wallet, payer: payment.payer, treasury: config.treasury,
      asset: { symbol: asset.symbol, name: asset.name, ...vaultView(asset), decimals: asset.decimals },
      amount: await this.amountOf(asset, payment.units),
      claimDeadline: claimDeadline.toString(),
      attestation: { publicKey: attestation.publicKey, signature: toHex(attestation.signature), message: toHex(message) },
      transaction: built.transaction,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight.toString(),
      computeUnitLimit: built.computeUnitLimit,
      computeUnitPrice: computeUnitPrice.toString(),
    };
  }

  /** The payer's refund after the window closes; no attestation is involved. */
  async prepareRefund(input: { paymentId: string; wallet?: string }): Promise<PreparedSolanaVaultAction> {
    const { config } = this.options;
    if (!input.wallet) throw new SolanaTransferError("Add your Solana address to your wallet before taking a link back.");
    const paymentId = validPaymentId(input.paymentId);
    const { programId } = await this.programFor(paymentId);
    await this.verifyProgram(programId, { fresh: true, codeOnly: true });
    const payment = await this.readPayment(programId, paymentId);
    if (!payment) throw new SolanaClaimNotFoundError();
    if (payment.status !== "open") throw new SolanaTransferError("This claim link was already claimed or refunded.");
    if (payment.payer !== input.wallet) throw new SolanaTransferError("Only the Solana address that funded this link can take it back.");
    const asset = vaultAssetByMint(payment.mint);
    if (!asset) throw new SolanaClaimNotFoundError("This claim link does not hold a listed token.");
    if (this.seconds() <= payment.expiry) throw new SolanaTransferError(`The tokens can be taken back after the claim window closes at ${new Date(Number(payment.expiry) * 1000).toISOString()}.`);
    const latest = await this.latest();
    const computeUnitPrice = await this.options.transfers.computePrice([address(input.wallet)]);
    const plan = {
      action: "refund" as const, programId, wallet: input.wallet, paymentId: fromHex(paymentId), asset, payer: payment.payer, treasury: config.treasury ?? payment.payer,
      blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS, computeUnitPrice,
    };
    const built = await this.action(plan, () => "Solana would refuse this refund right now.");
    return {
      network: SOLANA_MAINNET.id, action: "refund", programId, paymentId, wallet: input.wallet, payer: payment.payer, treasury: plan.treasury,
      asset: { symbol: asset.symbol, name: asset.name, ...vaultView(asset), decimals: asset.decimals },
      amount: await this.amountOf(asset, payment.units),
      transaction: built.transaction,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight.toString(),
      computeUnitLimit: built.computeUnitLimit,
      computeUnitPrice: computeUnitPrice.toString(),
    };
  }

  /**
   * The Solana links the session can act on, each read back from the program: links sent to one of its verified
   * accounts, or to its name, whose window is open, and links its Solana address funded that are still held.
   */
  async pending(input: { wallet: Address; solanaAddress?: string; accounts: VerifiedSocialAccount[]; limit?: number }) {
    const limit = input.limit ?? PENDING_CLAIMS_LIMIT;
    const now = this.seconds();
    const vaultAccounts = input.accounts.filter((account): account is VerifiedSocialAccount & { platform: StockClaimPlatform } => isStockClaimPlatform(account.platform));
    const recipients = vaultAccounts.map(({ platform, username }) => ({ platform, username: username.toLowerCase() }));
    const payments = new Map<string, VaultPaymentState | undefined>();
    let onMainnet: Promise<void> | undefined;
    /** Reads a page's payment accounts from the program, a hundred at a time. */
    const readPage = async (page: SolanaClaimRecord[]) => {
      const records = [...new Map(page.filter((record) => !payments.has(record.paymentId)).map((record) => [record.paymentId, record])).values()];
      if (!records.length) return;
      const accounts = await Promise.all(records.map(async (record) => vaultPaymentAddress(record.programId, fromHex(record.paymentId))));
      await (onMainnet ??= this.options.transfers.onMainnet());
      for (let start = 0; start < records.length; start += 100) {
        let found;
        try {
          found = await this.options.rpc.getMultipleAccounts(accounts.slice(start, start + 100), { encoding: "base64", commitment: "confirmed" }).send();
        } catch {
          throw new SolanaUnavailableError("Solana could not be read just now.");
        }
        found.value.forEach((value, index) => {
          const record = records[start + index];
          payments.set(record.paymentId, value && value.owner === record.programId ? decodeVaultPayment(Uint8Array.from(Buffer.from(value.data[0], "base64"))) : undefined);
        });
      }
    };
    const view = async (record: SolanaClaimRecord, payment: VaultPaymentState, status: SolanaPendingVaultLink["status"]): Promise<SolanaPendingVaultLink | undefined> => {
      const asset = vaultAssetByMint(payment.mint);
      if (!asset || payment.units === 0n) return undefined;
      return {
        network: SOLANA_MAINNET.id,
        chainName: SOLANA_MAINNET.name,
        paymentId: record.paymentId,
        escrow: record.programId,
        token: { symbol: asset.symbol, name: asset.name, address: vaultToken(asset).mint, kind: asset.kind === "native" ? "community" : asset.kind, decimals: asset.decimals },
        amount: await this.amountOf(asset, payment.units),
        recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
        sender: { wallet: payment.payer, ...(record.sourcePlatform && record.sourceUsername ? { platform: record.sourcePlatform, username: record.sourceUsername } : {}) },
        expiresAt: new Date(Number(payment.expiry) * 1000).toISOString(),
        status,
        ...(status === "claimable" && isSolanaStock(asset) ? { statementRequired: true } : {}),
        claimPath: solanaClaimPath(record.paymentId),
      };
    };
    return pagedPendingLinks({
      limit,
      waitingFor: (offset) => this.options.repository.waitingFor(recipients, now, limit, offset),
      fundedBy: (offset) => this.options.repository.fundedBy(input.wallet, limit, offset),
      check: async (waiting, funded) => {
        await readPage([...waiting, ...funded]);
        return {
          incoming: (await Promise.all(waiting.map(async (record) => {
            const payment = payments.get(record.paymentId);
            const mine = payment && anyClaimsLink(vaultAccounts, toHex(payment.identityKey), solanaKey, linkMadeAt(record, payment.expiry, SOLANA_VAULT_MAX_WINDOW_SECONDS));
            return payment?.status === "open" && now <= payment.expiry && mine ? view(record, payment, "claimable") : undefined;
          }))).filter((link): link is SolanaPendingVaultLink => link !== undefined),
          outgoing: (await Promise.all(funded.map(async (record) => {
            const payment = payments.get(record.paymentId);
            return payment?.status === "open" && payment.payer === input.solanaAddress ? view(record, payment, now > payment.expiry ? "refundable" : "waiting") : undefined;
          }))).filter((link): link is SolanaPendingVaultLink => link !== undefined),
        };
      },
    });
  }
}
