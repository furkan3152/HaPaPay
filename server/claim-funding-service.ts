import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseUnits,
  stringToHex,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import type { Platform } from "../src/domain/payment-intent";
import type { VaultRecipient } from "../src/domain/pending-claims.js";
import type { StockClaimPlatform } from "../src/domain/stock-claims.js";
import { platformFee } from "../src/domain/fees.js";
import { ARC_PAYMENTS_LEGACY_CHAIN_ID, arcReceipt } from "./payment-history-service.js";
import type { DiscoveredRecipient } from "./recipient-discovery";
import { StockTransferRejectedError, StockTransferUnavailableError } from "./stock-transfer-service.js";
import type { VaultLock } from "../src/domain/vault-lock.js";
import { vaultRecipient } from "./vault-recipient.js";

/** The vault escrow's funding event (the reviewed StockClaimEscrow, which Arc shares with Robinhood Chain). */
const PAYMENT_CREATED_TOPIC = toEventSelector("PaymentCreated(bytes32,address,bytes32,address,uint256,uint256,uint256)");

export type ClaimFundingRecord = {
  /** The Arc chain the link was funded on; links are only ever read back on the running network. */
  chainId: number;
  transactionHash: Hex;
  paymentId: Hex;
  payer: Address;
  recipientPlatform: StockClaimPlatform;
  recipientUsername: string;
  amount: string;
  expiry: bigint;
  blockNumber: bigint;
  confirmedAt: string;
  sourceIdentity?: { platform: Platform; username: string };
};

export interface ClaimFundingRepository {
  save(record: ClaimFundingRecord): Promise<ClaimFundingRecord>;
  get(chainId: number, paymentId: Hex): Promise<ClaimFundingRecord | undefined>;
  /** Links on this chain sent to any of these accounts whose window is still open at `now`, soonest deadline first. */
  waitingFor(chainId: number, recipients: readonly VaultRecipient[], now: bigint, limit: number, offset?: number): Promise<ClaimFundingRecord[]>;
  /** Links on this chain the wallet funded, latest deadline first. */
  fundedBy(chainId: number, payer: Address, limit: number, offset?: number): Promise<ClaimFundingRecord[]>;
}

type SqlResult = { rows: Array<Record<string, unknown>> };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

export class PostgresClaimFundingRepository implements ClaimFundingRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS claim_fundings (
        payment_id TEXT PRIMARY KEY,
        transaction_hash TEXT NOT NULL UNIQUE,
        payer_address TEXT NOT NULL,
        recipient_platform TEXT NOT NULL,
        recipient_username_normalized TEXT NOT NULL,
        amount_text TEXT NOT NULL,
        expiry BIGINT NOT NULL,
        block_number BIGINT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL,
        source_platform TEXT,
        source_username_normalized TEXT
      )
    `);
    await this.pool.query(`ALTER TABLE claim_fundings ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT ${ARC_PAYMENTS_LEGACY_CHAIN_ID}`);
  }

  async save(record: ClaimFundingRecord) {
    const result = await this.pool.query(
      `INSERT INTO claim_fundings
        (payment_id, transaction_hash, payer_address, recipient_platform, recipient_username_normalized, amount_text, expiry, block_number, confirmed_at, source_platform, source_username_normalized, chain_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING *`,
      [record.paymentId, record.transactionHash, record.payer, record.recipientPlatform, record.recipientUsername, record.amount, record.expiry.toString(), record.blockNumber.toString(), record.confirmedAt, record.sourceIdentity?.platform ?? null, record.sourceIdentity?.username ?? null, record.chainId],
    );
    const stored = result.rows[0] ?? (await this.pool.query("SELECT * FROM claim_fundings WHERE payment_id = $1", [record.paymentId])).rows[0];
    const parsed = rowToClaimFunding(stored);
    if (parsed.transactionHash.toLowerCase() !== record.transactionHash.toLowerCase() || parsed.chainId !== record.chainId) throw new StockTransferRejectedError("Claim payment ID was already recorded with another transaction.");
    return parsed;
  }

  async get(chainId: number, paymentId: Hex) {
    const row = (await this.pool.query("SELECT * FROM claim_fundings WHERE payment_id = $1 AND chain_id = $2", [paymentId, chainId])).rows[0];
    return row ? rowToClaimFunding(row) : undefined;
  }

  async waitingFor(chainId: number, recipients: readonly VaultRecipient[], now: bigint, limit: number, offset = 0) {
    if (!recipients.length) return [];
    const matches = recipients.map((_, index) => `(recipient_platform = $${4 + index * 2} AND recipient_username_normalized = $${5 + index * 2})`);
    const result = await this.pool.query(
      `SELECT * FROM claim_fundings WHERE chain_id = $1 AND expiry >= $2 AND (${matches.join(" OR ")})
       ORDER BY expiry ASC, block_number ASC, payment_id ASC LIMIT $3 OFFSET $${4 + recipients.length * 2}`,
      [chainId, now.toString(), limit, ...recipients.flatMap((recipient) => [recipient.platform, recipient.username]), offset],
    );
    return result.rows.map(rowToClaimFunding);
  }

  async fundedBy(chainId: number, payer: Address, limit: number, offset = 0) {
    const result = await this.pool.query(
      "SELECT * FROM claim_fundings WHERE chain_id = $1 AND payer_address = $2 ORDER BY expiry DESC, block_number DESC, payment_id ASC LIMIT $3 OFFSET $4",
      [chainId, getAddress(payer), limit, offset],
    );
    return result.rows.map(rowToClaimFunding);
  }
}

export class MemoryClaimFundingRepository implements ClaimFundingRepository {
  private readonly records = new Map<Hex, ClaimFundingRecord>();
  async save(record: ClaimFundingRecord) {
    const existing = this.records.get(record.paymentId);
    if (existing && (existing.transactionHash.toLowerCase() !== record.transactionHash.toLowerCase() || existing.chainId !== record.chainId)) throw new StockTransferRejectedError("Claim payment ID was already recorded with another transaction.");
    this.records.set(record.paymentId, existing ?? record);
    return existing ?? record;
  }
  async get(chainId: number, paymentId: Hex) {
    const record = this.records.get(paymentId);
    return record?.chainId === chainId ? record : undefined;
  }
  async waitingFor(chainId: number, recipients: readonly VaultRecipient[], now: bigint, limit: number, offset = 0) {
    return [...this.records.values()]
      .filter((record) => record.chainId === chainId && record.expiry >= now
        && recipients.some((recipient) => recipient.platform === record.recipientPlatform && recipient.username === record.recipientUsername))
      .sort((left, right) => Number(left.expiry - right.expiry) || Number(left.blockNumber - right.blockNumber))
      .slice(offset, offset + limit);
  }
  async fundedBy(chainId: number, payer: Address, limit: number, offset = 0) {
    return [...this.records.values()]
      .filter((record) => record.chainId === chainId && record.payer === getAddress(payer))
      .sort((left, right) => Number(right.expiry - left.expiry) || Number(right.blockNumber - left.blockNumber))
      .slice(offset, offset + limit);
  }
}

type ReceiptClient = {
  getTransactionReceipt(input: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    from: Address;
    blockNumber: bigint;
    logs: Array<{ address: Address; topics: readonly Hex[]; data: Hex }>;
  }>;
};

type RecipientDirectory = { lookup(platform: Platform, username: string): Promise<DiscoveredRecipient> };

export class ClaimFundingService {
  private readonly escrow: Address;
  private readonly usdc: Address;
  constructor(private readonly options: {
    chainId: number;
    escrow: Address;
    usdc: Address;
    repository: ClaimFundingRepository;
    directory: RecipientDirectory;
    client: ReceiptClient;
    /** The network's name in messages ("Arc Mainnet"). */
    chainName?: string;
    /** How often and how far apart a receipt the RPC does not have yet is asked for again. */
    receiptRetry?: { attempts?: number; delayMs?: number };
    now?: () => Date;
  }) {
    this.escrow = getAddress(options.escrow);
    this.usdc = getAddress(options.usdc);
  }

  async confirm(input: {
    transactionHash: string;
    paymentId: string;
    payer: string;
    platform: StockClaimPlatform;
    username: string;
    amount: string;
    /** The lock the prepared link carried: a link waiting for a name is checked without a lookup. */
    lock?: VaultLock;
    sourceIdentity?: { platform: Platform; username: string };
  }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new StockTransferRejectedError("Invalid Arc transaction hash.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.paymentId)) throw new StockTransferRejectedError("Invalid claim payment ID.");
    // One link is one row whatever case its hash and ID are written in (audit, 2026-10-06).
    const transactionHash = input.transactionHash.toLowerCase() as Hex;
    const paymentId = input.paymentId.toLowerCase() as Hex;
    const payer = getAddress(input.payer);
    const amount = parseUnits(input.amount, 6);
    const identity = await recipientIdentity(this.options.directory, input.platform, input.username, input.lock);
    const identityKey = keccak256(encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32"),
      [keccak256(stringToHex(identity.platform)), keccak256(stringToHex(identity.providerUserId))],
    ));
    const receipt = await arcReceipt(this.options.client, transactionHash, this.options.chainName ?? "Arc", this.options.receiptRetry);
    if (receipt.status !== "success" || getAddress(receipt.from) !== payer) throw new StockTransferRejectedError("Arc escrow funding transaction was not successful for this wallet.");

    // The escrow emits USDC as the link's token, the exact amount, the fee it took on top (never above 1% of the
    // amount) and the expiry.
    let expiry: bigint | undefined;
    const matchingLog = receipt.logs.find((log) => {
      if (getAddress(log.address) !== this.escrow || log.topics[0]?.toLowerCase() !== PAYMENT_CREATED_TOPIC.toLowerCase()) return false;
      if (log.topics[1]?.toLowerCase() !== paymentId.toLowerCase() || !log.topics[2] || log.topics[3]?.toLowerCase() !== identityKey.toLowerCase()) return false;
      if (topicAddress(log.topics[2]) !== payer) return false;
      const [token, eventAmount, fee, eventExpiry] = decodeAbiParameters(parseAbiParameters("address, uint256, uint256, uint256"), log.data);
      if (getAddress(token) !== this.usdc || eventAmount !== amount || fee > platformFee(amount)) return false;
      expiry = eventExpiry;
      return true;
    });
    if (!matchingLog || expiry === undefined) throw new StockTransferRejectedError("Receipt does not contain the exact reviewed escrow funding.");
    // A link whose window has closed is recorded too: its payer finds it under Claims and takes it back.
    const now = this.options.now?.() ?? new Date();
    const record = await this.options.repository.save({
      chainId: this.options.chainId,
      transactionHash,
      paymentId,
      payer,
      recipientPlatform: identity.platform,
      recipientUsername: identity.username,
      amount: input.amount,
      expiry,
      blockNumber: receipt.blockNumber,
      confirmedAt: now.toISOString(),
      sourceIdentity: input.sourceIdentity,
    });
    return { ...publicRecord(record), status: "funded" as const, claimPath: `/claim/${record.paymentId}` };
  }

  async metadata(paymentIdInput: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentIdInput)) return undefined;
    const record = await this.options.repository.get(this.options.chainId, paymentIdInput.toLowerCase() as Hex)
      // Links recorded before IDs were kept in lower case keep the case they were sent in.
      ?? (paymentIdInput === paymentIdInput.toLowerCase() ? undefined : await this.options.repository.get(this.options.chainId, paymentIdInput as Hex));
    return record ? publicRecord(record) : undefined;
  }
}

/**
 * The account a link is locked to, from the platform's official directory: a handle it does not know is the payer's to
 * correct (400); a directory that cannot answer right now is asked again when the funding is verified again (503).
 */
async function recipientIdentity(directory: RecipientDirectory, platform: StockClaimPlatform, username: string, lock?: VaultLock) {
  try {
    return await vaultRecipient(directory, platform, username, lock);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/was not found\.$|^Invalid (?:social|X|Farcaster|Discord|Telegram) username/.test(message)) throw new StockTransferRejectedError(message);
    throw new StockTransferUnavailableError(`${platform === "x" ? "X" : platform === "github" ? "GitHub" : "Farcaster"} could not confirm the account just now. Verify the funding again in a moment; the USDC stays in the vault.`);
  }
}

function topicAddress(topic: Hex) {
  return getAddress(`0x${topic.slice(-40)}`);
}

function publicRecord(record: ClaimFundingRecord) {
  return {
    paymentId: record.paymentId,
    transactionHash: record.transactionHash,
    payer: record.payer,
    recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
    amount: record.amount,
    expiresAt: new Date(Number(record.expiry) * 1000).toISOString(),
    blockNumber: record.blockNumber.toString(),
    confirmedAt: record.confirmedAt,
    ...(record.sourceIdentity ? { sourceIdentity: record.sourceIdentity } : {}),
  };
}

function rowToClaimFunding(row: Record<string, unknown>): ClaimFundingRecord {
  const record: ClaimFundingRecord = {
    chainId: row.chain_id === undefined || row.chain_id === null ? ARC_PAYMENTS_LEGACY_CHAIN_ID : Number(row.chain_id),
    transactionHash: String(row.transaction_hash) as Hex,
    paymentId: String(row.payment_id) as Hex,
    payer: getAddress(String(row.payer_address)),
    recipientPlatform: String(row.recipient_platform) as StockClaimPlatform,
    recipientUsername: String(row.recipient_username_normalized),
    amount: String(row.amount_text),
    expiry: BigInt(String(row.expiry)),
    blockNumber: BigInt(String(row.block_number)),
    confirmedAt: row.confirmed_at instanceof Date ? row.confirmed_at.toISOString() : new Date(String(row.confirmed_at)).toISOString(),
  };
  if (row.source_platform && row.source_username_normalized) {
    record.sourceIdentity = { platform: String(row.source_platform) as Platform, username: String(row.source_username_normalized) };
  }
  return record;
}
