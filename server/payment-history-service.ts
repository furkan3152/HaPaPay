import { decodeAbiParameters, getAddress, parseAbiParameters, parseUnits, type Address, type Hex } from "viem";
import type { Platform } from "../src/domain/payment-intent";
import { routedPaymentFee, routedPaymentNote } from "../src/domain/routed-payments.js";
import { StockReceiptPendingError, StockTransferRejectedError, StockTransferUnavailableError } from "./stock-transfer-service.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type PaymentRecord = {
  /** The Arc chain the payment was confirmed on; history only ever lists the running network's payments. */
  chainId: number;
  transactionHash: Hex;
  sender: Address;
  recipient: Address;
  platform: Platform;
  username: string;
  amount: string;
  blockNumber: bigint;
  confirmedAt: string;
  sourcePlatform?: Platform;
  sourceUsername?: string;
  /** The note the payment's own transaction carries after `pay`, read from chain when it was confirmed. */
  note?: string;
  /**
   * USDC base units of the fee HaPaPay's router took for this payment, from the router's `Paid` event in the
   * receipt. Absent for a payment that did not go through the router (it paid no fee) and for rows from before fees
   * were kept (2026-10-05).
   */
  feeUnits?: string;
};

export interface PaymentRepository {
  save(record: PaymentRecord): Promise<PaymentRecord>;
  list(chainId: number, wallet: Address): Promise<PaymentRecord[]>;
}

/** Rows recorded before Arc payments carried their chain are Arc Testnet payments. */
export const ARC_PAYMENTS_LEGACY_CHAIN_ID = 5_042_002;

export class DuplicatePaymentError extends Error {
  constructor() {
    super("Arc transaction was already confirmed.");
    this.name = "DuplicatePaymentError";
  }
}

type SqlResult = { rows: Array<Record<string, unknown>> };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS arc_payments (
        transaction_hash TEXT PRIMARY KEY,
        sender_address TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        platform TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        amount_text TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL
        ,source_platform TEXT
        ,source_username_normalized TEXT
      )
    `);
    await this.pool.query("ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS source_platform TEXT");
    await this.pool.query("ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS source_username_normalized TEXT");
    await this.pool.query(`ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT ${ARC_PAYMENTS_LEGACY_CHAIN_ID}`);
    await this.pool.query("ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS note TEXT");
    // The fee the router took, kept since invites (2026-10-05) so an inviter's reward never exceeds a fee really paid.
    await this.pool.query("ALTER TABLE arc_payments ADD COLUMN IF NOT EXISTS fee_units TEXT");
    await this.pool.query("CREATE INDEX IF NOT EXISTS arc_payments_sender_idx ON arc_payments (sender_address, block_number DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS arc_payments_recipient_idx ON arc_payments (recipient_address, block_number DESC)");
  }

  async save(record: PaymentRecord) {
    const values = [
      record.transactionHash,
      record.sender,
      record.recipient,
      record.platform,
      record.username,
      record.amount,
      record.blockNumber.toString(),
      record.confirmedAt,
      record.sourcePlatform ?? null,
      record.sourceUsername ?? null,
      record.chainId,
      record.note ?? null,
      record.feeUnits ?? null,
    ];
    let inserted: SqlResult;
    try {
      inserted = await this.pool.query(
        `INSERT INTO arc_payments
          (transaction_hash, sender_address, recipient_address, platform, username_normalized, amount_text, block_number, confirmed_at, source_platform, source_username_normalized, chain_id, note, fee_units)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        values,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicatePaymentError();
      throw error;
    }
    const row = inserted.rows[0];
    if (!row) throw new Error("Arc payment history insert did not return a record.");
    return rowToPaymentRecord(row);
  }

  async list(chainId: number, wallet: Address) {
    const result = await this.pool.query(
      `SELECT * FROM arc_payments
       WHERE chain_id = $2 AND (sender_address = $1 OR recipient_address = $1)
       ORDER BY block_number DESC`,
      [getAddress(wallet), chainId],
    );
    return result.rows.map(rowToPaymentRecord);
  }
}

export class MemoryPaymentRepository implements PaymentRepository {
  private readonly records = new Map<Hex, PaymentRecord>();

  async save(record: PaymentRecord) {
    const existing = this.records.get(record.transactionHash);
    if (existing) throw new DuplicatePaymentError();
    this.records.set(record.transactionHash, record);
    return record;
  }

  async list(chainId: number, wallet: Address) {
    return [...this.records.values()]
      .filter((record) => record.chainId === chainId && (record.sender === wallet || record.recipient === wallet))
      .sort((left, right) => Number(right.blockNumber - left.blockNumber));
  }
}

type ReceiptClient = {
  getTransactionReceipt(input: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    from: Address;
    blockNumber: bigint;
    logs: Array<{ address: Address; topics: readonly Hex[]; data: Hex }>;
  }>;
  /** The transaction itself, for the note after `pay`. Without it no note is read. */
  getTransaction?(input: { hash: Hex }): Promise<{ input: Hex }>;
};

export class PaymentHistoryService {
  constructor(private readonly options: {
    chainId: number;
    usdc: Address;
    repository: PaymentRepository;
    client: ReceiptClient;
    /** HaPaPay's fee router on this chain, whose `Paid` event shows the fee a payment paid. */
    router?: Address;
    /** The network's name in messages ("Arc Mainnet"). */
    chainName?: string;
    /** How often and how far apart a receipt the RPC does not have yet is asked for again. */
    receiptRetry?: { attempts?: number; delayMs?: number };
    now?: () => Date;
  }) {}

  async confirm(input: {
    transactionHash: string;
    sender: string;
    recipient: string;
    platform: Platform;
    username: string;
    amount: string;
    sourcePlatform?: Platform;
    sourceUsername?: string;
  }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new StockTransferRejectedError("Invalid Arc transaction hash.");
    // One transaction is one row whatever case its hash is written in (audit, 2026-10-06: the same payment re-posted
    // in upper case was recorded again).
    const transactionHash = input.transactionHash.toLowerCase() as Hex;
    const sender = getAddress(input.sender);
    const recipient = getAddress(input.recipient);
    const units = parseUnits(input.amount, 6);
    const receipt = await arcReceipt(this.options.client, transactionHash, this.options.chainName ?? "Arc", this.options.receiptRetry);
    if (receipt.status !== "success") throw new StockTransferRejectedError("Arc transaction reverted; payment was not completed.");
    if (getAddress(receipt.from) !== sender) throw new StockTransferRejectedError("Arc transaction sender does not match the wallet session.");

    const transfer = receipt.logs.find((log) => {
      if (getAddress(log.address) !== getAddress(this.options.usdc) || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
      if (!log.topics[1] || !log.topics[2]) return false;
      const eventSender = topicAddress(log.topics[1]);
      const eventRecipient = topicAddress(log.topics[2]);
      const [eventUnits] = decodeAbiParameters(parseAbiParameters("uint256"), log.data);
      return eventSender === sender && eventRecipient === recipient && eventUnits === units;
    });
    if (!transfer) throw new StockTransferRejectedError("Receipt does not contain the reviewed Arc USDC transfer.");
    const note = await this.note(transactionHash, recipient, units);
    const fee = this.options.router
      ? routedPaymentFee(receipt.logs, { router: this.options.router, payer: sender, recipient, token: this.options.usdc, units })
      : undefined;

    const record = await this.options.repository.save({
      chainId: this.options.chainId,
      transactionHash,
      sender,
      recipient,
      platform: input.platform,
      username: input.username.trim().replace(/^@/, "").toLowerCase(),
      amount: input.amount,
      blockNumber: receipt.blockNumber,
      confirmedAt: (this.options.now?.() ?? new Date()).toISOString(),
      sourcePlatform: input.sourcePlatform,
      sourceUsername: input.sourceUsername?.trim().replace(/^@/, "").toLowerCase(),
      ...(note ? { note } : {}),
      ...(fee !== undefined && fee > 0n ? { feeUnits: fee.toString() } : {}),
    });
    return historyEntry(record, sender);
  }

  /** The note after this payment's `pay`, read again briefly when the RPC fails, so a note is never lost. */
  private async note(hash: Hex, recipient: Address, units: bigint) {
    const read = this.options.client.getTransaction;
    if (!read) return undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        const transaction = await read.call(this.options.client, { hash });
        return routedPaymentNote(transaction.input, { token: this.options.usdc, recipient, units });
      } catch {
        if (attempt >= 3) throw new StockTransferUnavailableError("Arc could not return this transaction just now. Try verifying it again.");
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  }

  async list(inputWallet: string) {
    const wallet = getAddress(inputWallet);
    return (await this.options.repository.list(this.options.chainId, wallet)).map((record) => historyEntry(record, wallet));
  }
}

function topicAddress(topic: Hex) {
  return getAddress(`0x${topic.slice(-40)}`);
}

/**
 * A receipt from the server's Arc RPC, asked for again while it does not have it yet: the wallet's RPC can see a
 * transaction a moment before the server's does (audit, 2026-10-06: a payment confirmed at once was refused as
 * unverifiable and never recorded). Still missing after the retries, it is pending and the browser verifies again; any
 * other failure is the RPC's, never the payment's.
 */
export async function arcReceipt<T>(
  client: { getTransactionReceipt(input: { hash: Hex }): Promise<T> },
  hash: Hex,
  chainName: string,
  retry: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, retry.attempts ?? 8);
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      const missing = error instanceof Error && error.name === "TransactionReceiptNotFoundError";
      if (!missing) throw new StockTransferUnavailableError(`${chainName} could not return this receipt right now. Try again shortly.`);
      if (attempt >= attempts) throw new StockReceiptPendingError(chainName);
      await new Promise((resolve) => setTimeout(resolve, retry.delayMs ?? 1_000));
    }
  }
}

function historyEntry(record: PaymentRecord, wallet: Address) {
  const sent = record.sender === wallet;
  return {
    transactionHash: record.transactionHash,
    direction: sent ? "sent" as const : "received" as const,
    counterparty: sent ? record.recipient : record.sender,
    platform: record.platform,
    username: record.username,
    amount: record.amount,
    blockNumber: record.blockNumber.toString(),
    confirmedAt: record.confirmedAt,
    ...(record.sourcePlatform && record.sourceUsername ? { sourceIdentity: { platform: record.sourcePlatform, username: record.sourceUsername } } : {}),
    ...(record.note ? { note: record.note } : {}),
  };
}

function rowToPaymentRecord(row: Record<string, unknown>): PaymentRecord {
  const confirmedAt = row.confirmed_at instanceof Date
    ? row.confirmed_at.toISOString()
    : new Date(String(row.confirmed_at)).toISOString();
  const record: PaymentRecord = {
    chainId: row.chain_id === undefined || row.chain_id === null ? ARC_PAYMENTS_LEGACY_CHAIN_ID : Number(row.chain_id),
    transactionHash: String(row.transaction_hash) as Hex,
    sender: getAddress(String(row.sender_address)),
    recipient: getAddress(String(row.recipient_address)),
    platform: String(row.platform) as Platform,
    username: String(row.username_normalized),
    amount: String(row.amount_text),
    blockNumber: BigInt(String(row.block_number)),
    confirmedAt,
  };
  if (row.source_platform && row.source_username_normalized) {
    record.sourcePlatform = String(row.source_platform) as Platform;
    record.sourceUsername = String(row.source_username_normalized);
  }
  if (typeof row.note === "string" && row.note) record.note = row.note;
  if (typeof row.fee_units === "string" && /^\d+$/.test(row.fee_units)) record.feeUnits = row.fee_units;
  return record;
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
