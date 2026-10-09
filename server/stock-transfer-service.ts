import {
  decodeAbiParameters,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseAbi,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { randomBytes } from "node:crypto";
import { checkPaymentNote } from "../src/domain/payment-note.js";
import { PAYMENT_BATCH_MAX_RECIPIENTS, routedApproveCall, routedPayCall, routedPaymentFee, routedPaymentNote } from "../src/domain/routed-payments.js";
import type { Platform } from "../src/domain/payment-intent.js";
import {
  PLATFORM_FEE_BPS,
  platformFee,
  payRouterAbi,
  splitPlatformFee,
  type PreparedPlatformFee,
  type FeeSchedule,
} from "../src/domain/fees.js";
import {
  STOCK_CHAINS,
  normalizeStockAmount,
  stockTokenUnits,
  tokenDecimals,
  transferAvailabilityFor,
  type StockNetworkId,
  type StockTokenListing,
  type StockTransferAvailability,
} from "../src/domain/stock-tokens.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RUNTIME_RETRY_MS = 30_000;

export const stockTokenTransferAbi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  // Robinhood Stock Tokens and plain OpenZeppelin ERC-20s.
  "error IsPaused()",
  "error Blocked(address account)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidReceiver(address receiver)",
  // Paxos tokens (USDG): PaxosBaseAbstract and PaxosTokenV2.
  "error ContractPaused()",
  "error AddressFrozen()",
  "error InsufficientFunds()",
  "error ZeroAddress()",
]);

type TransactionReceipt = {
  status: "success" | "reverted";
  from: Address;
  blockNumber: bigint;
  /** Set when the transaction created a contract. */
  contractAddress?: Address | null;
  logs: Array<{ address: Address; topics: readonly Hex[]; data: Hex }>;
};

/** The subset of a viem public client used for one Robinhood chain. */
export type StockChainClient = {
  getChainId(): Promise<number>;
  getBytecode(input: { address: Address }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  call(input: { account: Address; to: Address; data: Hex }): Promise<{ data?: Hex }>;
  getTransactionReceipt(input: { hash: Hex }): Promise<TransactionReceipt>;
  /** The transaction itself, for the note after `pay`. Without it no note is read. */
  getTransaction?(input: { hash: Hex }): Promise<{ input: Hex }>;
};

export type StockTransferRecord = {
  chainId: number;
  transactionHash: Hex;
  tokenAddress: Address;
  tokenSymbol: string;
  sender: Address;
  recipient: Address;
  platform: Platform;
  username: string;
  amount: string;
  units: bigint;
  blockNumber: bigint;
  confirmedAt: string;
  sourcePlatform?: Platform;
  sourceUsername?: string;
  /** The note the transfer's own transaction carries after `pay`, read from chain when it was confirmed. */
  note?: string;
  /**
   * Base units of the fee HaPaPay's router took for this transfer, from the router's `Paid` event in the receipt.
   * Absent for a transfer that did not go through the router (it paid no fee) and for rows from before fees were kept.
   */
  feeUnits?: string;
};

export interface StockTransferRepository {
  save(record: StockTransferRecord): Promise<StockTransferRecord>;
  list(wallet: Address): Promise<StockTransferRecord[]>;
}

export class DuplicateStockTransferError extends Error {
  constructor() {
    super("This stock-token transfer was already confirmed.");
    this.name = "DuplicateStockTransferError";
  }
}

/** A reviewed transfer the chain or the receipt contradicts. The message is written for the sender. Maps to HTTP 400. */
export class StockTransferRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockTransferRejectedError";
  }
}

/** The network is off, misconfigured, or its RPC failed verification. Maps to HTTP 503. */
export class StockTransferUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockTransferUnavailableError";
  }
}

/** The chain has no receipt for the hash yet. The wallet may still be broadcasting it; retrying is safe. */
export class StockReceiptPendingError extends Error {
  constructor(chainName: string) {
    super(`${chainName} has no receipt for this transaction yet. Check the explorer, then verify again.`);
    this.name = "StockReceiptPendingError";
  }
}

type SqlResult = { rows: Array<Record<string, unknown>> };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

export class PostgresStockTransferRepository implements StockTransferRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS stock_transfers (
        chain_id INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        platform TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        amount_text TEXT NOT NULL,
        units_text TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL,
        source_platform TEXT,
        source_username_normalized TEXT,
        PRIMARY KEY (chain_id, transaction_hash)
      )
    `);
    await this.pool.query("ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS note TEXT");
    // The fee the router took, kept since invites (2026-10-05) so an inviter's reward never exceeds a fee really paid.
    await this.pool.query("ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS fee_units TEXT");
    await this.pool.query("CREATE INDEX IF NOT EXISTS stock_transfers_sender_idx ON stock_transfers (sender_address, block_number DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS stock_transfers_recipient_idx ON stock_transfers (recipient_address, block_number DESC)");
  }

  async save(record: StockTransferRecord) {
    let inserted: SqlResult;
    try {
      inserted = await this.pool.query(
        `INSERT INTO stock_transfers
          (chain_id, transaction_hash, token_address, token_symbol, sender_address, recipient_address, platform,
           username_normalized, amount_text, units_text, block_number, confirmed_at, source_platform, source_username_normalized, note, fee_units)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [
          record.chainId,
          record.transactionHash,
          record.tokenAddress,
          record.tokenSymbol,
          record.sender,
          record.recipient,
          record.platform,
          record.username,
          record.amount,
          record.units.toString(),
          record.blockNumber.toString(),
          record.confirmedAt,
          record.sourcePlatform ?? null,
          record.sourceUsername ?? null,
          record.note ?? null,
          record.feeUnits ?? null,
        ],
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DuplicateStockTransferError();
      throw error;
    }
    const row = inserted.rows[0];
    if (!row) throw new Error("Stock transfer history insert did not return a record.");
    return rowToStockTransfer(row);
  }

  async list(wallet: Address) {
    const result = await this.pool.query(
      `SELECT * FROM stock_transfers
       WHERE sender_address = $1 OR recipient_address = $1
       ORDER BY confirmed_at DESC, block_number DESC`,
      [getAddress(wallet)],
    );
    return result.rows.map(rowToStockTransfer);
  }
}

export class MemoryStockTransferRepository implements StockTransferRepository {
  private readonly records = new Map<string, StockTransferRecord>();

  async save(record: StockTransferRecord) {
    const key = `${record.chainId}:${record.transactionHash.toLowerCase()}`;
    if (this.records.has(key)) throw new DuplicateStockTransferError();
    this.records.set(key, record);
    return record;
  }

  async list(wallet: Address) {
    return [...this.records.values()]
      .filter((record) => record.sender === wallet || record.recipient === wallet)
      .sort((left, right) => right.confirmedAt.localeCompare(left.confirmedAt) || Number(right.blockNumber - left.blockNumber));
  }
}

type Switch = { enabled: boolean; reason?: string };
type NetworkRuntime = {
  /** Robinhood Stock Tokens. */
  stock: Switch;
  /** Every other listed asset: USDG. */
  tokens: Switch;
  /** Present whenever the network has a valid RPC, even with both switches off: claims, refunds and reads use it. */
  client?: StockChainClient;
  unconfigured?: string;
  verified?: boolean;
  failedAt?: number;
  failure?: string;
};

/**
 * Prepares and verifies wallet-signed ERC-20 transfers of allowlisted Robinhood Chain tokens: Stock Tokens and USDG.
 * The server never signs or broadcasts: it builds exact calldata, pre-flights it with eth_call from the
 * sender, and records a transfer only after the receipt shows the exact token Transfer log.
 */
export class StockTransferService {
  private readonly runtimes: Record<StockNetworkId, NetworkRuntime>;
  private readonly verifiedTokens = new Set<string>();
  private readonly now: () => number;

  private readonly receiptAttempts: number;
  private readonly receiptRetryMs: number;

  constructor(private readonly options: {
    /** `enabled` switches Stock Tokens; `tokens` switches USDG and follows `enabled` when omitted. */
    networks: Partial<Record<StockNetworkId, { enabled: boolean; reason?: string; tokens?: Switch; client?: StockChainClient }>>;
    repository: StockTransferRepository;
    now?: () => number;
    /** The server's RPC can trail the wallet's by a block or two, so a missing receipt is re-read briefly. */
    receiptRetry?: { attempts: number; delayMs: number };
  }) {
    this.now = options.now ?? Date.now;
    this.receiptAttempts = Math.max(1, options.receiptRetry?.attempts ?? 8);
    this.receiptRetryMs = options.receiptRetry?.delayMs ?? 1_000;
    const runtime = (network: StockNetworkId): NetworkRuntime => {
      const config = options.networks[network];
      const unconfigured = `${STOCK_CHAINS[network].name} stock transfers are not configured on this server.`;
      if (!config?.client) {
        const off = { enabled: false, reason: config?.reason ?? unconfigured };
        return { stock: off, tokens: { enabled: false, reason: config?.tokens?.reason ?? off.reason }, unconfigured: off.reason };
      }
      return {
        stock: config.enabled ? { enabled: true } : { enabled: false, reason: config.reason ?? unconfigured },
        tokens: config.tokens ?? (config.enabled ? { enabled: true } : { enabled: false, reason: config.reason ?? unconfigured }),
        client: config.client,
      };
    };
    this.runtimes = { "robinhood-mainnet": runtime("robinhood-mainnet"), "robinhood-testnet": runtime("robinhood-testnet") };
  }

  /** Stock Tokens in `enabled`, USDG in `tokens`. */
  availability(network: StockNetworkId): StockTransferAvailability {
    const { stock, tokens } = this.runtimes[network];
    return { ...stock, tokens: { ...tokens } };
  }

  /** Whether transfers of this listed token run on the network. */
  assetAvailability(network: StockNetworkId, token: Pick<StockTokenListing, "kind">) {
    return transferAvailabilityFor(this.availability(network), token);
  }

  /** The network's client once its chain ID, and the token contract when one is given, have been verified. */
  async verifiedClient(network: StockNetworkId, token?: StockTokenListing) {
    const client = await this.client(network);
    if (token) await this.verifyToken(network, client, token);
    return client;
  }

  /** A receipt from this network, re-read briefly while the server's RPC catches up with the wallet's. */
  async transactionReceipt(network: StockNetworkId, hash: Hex) {
    return this.receipt(await this.client(network), hash, STOCK_CHAINS[network].name);
  }

  /** One read of a receipt for the browser to poll: null while it is not mined, so the browser asks again. */
  async readReceipt(network: StockNetworkId, hash: Hex) {
    const client = await this.client(network);
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
      throw new StockTransferUnavailableError(`${STOCK_CHAINS[network].name} could not return this receipt right now. Try again shortly.`);
    }
  }

  private async client(network: StockNetworkId) {
    const runtime = this.runtimes[network];
    const chain = STOCK_CHAINS[network];
    if (!runtime.client) throw new StockTransferUnavailableError(runtime.unconfigured ?? `${chain.name} stock transfers are off.`);
    if (runtime.verified) return runtime.client;
    if (runtime.failedAt !== undefined && this.now() - runtime.failedAt < RUNTIME_RETRY_MS) {
      throw new StockTransferUnavailableError(runtime.failure ?? `${chain.name} could not be verified. Try again shortly.`);
    }
    try {
      const reported = await runtime.client.getChainId();
      if (reported !== chain.id) {
        runtime.failure = `The ${chain.name} RPC reports chain ${reported}, not ${chain.id}. Stock transfers are paused.`;
        runtime.failedAt = this.now();
        throw new StockTransferUnavailableError(runtime.failure);
      }
    } catch (error) {
      if (error instanceof StockTransferUnavailableError) throw error;
      runtime.failure = `${chain.name} is not reachable right now. Try again shortly.`;
      runtime.failedAt = this.now();
      throw new StockTransferUnavailableError(runtime.failure);
    }
    runtime.verified = true;
    return runtime.client;
  }

  private async verifyToken(network: StockNetworkId, client: StockChainClient, token: StockTokenListing) {
    const key = `${network}:${token.address}`;
    if (this.verifiedTokens.has(key)) return;
    const chainName = STOCK_CHAINS[network].name;
    let code: Hex | undefined, decimals: unknown, symbol: unknown;
    try {
      [code, decimals, symbol] = await Promise.all([
        client.getBytecode({ address: token.address }),
        client.readContract({ address: token.address, abi: stockTokenTransferAbi, functionName: "decimals" }).catch(() => undefined),
        client.readContract({ address: token.address, abi: stockTokenTransferAbi, functionName: "symbol" }).catch(() => undefined),
      ]);
    } catch {
      throw new StockTransferUnavailableError(`${chainName} is not reachable right now. Try again shortly.`);
    }
    if (!code || code === "0x") throw new StockTransferUnavailableError(`${token.symbol} has no contract code on ${chainName}.`);
    if (Number(decimals) !== tokenDecimals(token) || symbol !== token.symbol) {
      throw new StockTransferUnavailableError(`${token.symbol} on ${chainName} no longer matches the verified allowlist.`);
    }
    this.verifiedTokens.add(key);
  }

  /**
   * The wallet calls for one reviewed payment. Without fee contracts on the network it is one `transfer`. With them
   * it is an approval of the amount plus the fee to the fee router, then `pay`, which sends exactly the amount to the
   * recipient and the fee to the burn vault and treasury in the same transaction; a note rides after `pay`'s
   * arguments. The fee path is `prepareBatch` for one person.
   */
  async prepare(input: {
    network: StockNetworkId;
    sender: string;
    recipient: string;
    token: StockTokenListing;
    amount: string;
    fees?: FeeSchedule;
    paymentRef?: Hex;
    note?: string;
  }) {
    if (input.fees) {
      const batch = await this.prepareBatch({ ...input, fees: input.fees, payments: [{ recipient: input.recipient, amount: input.amount }], paymentRefs: input.paymentRef ? [input.paymentRef] : undefined });
      const [payment] = batch.payments;
      const { payments: _payments, approval, totalUnits: _total, totalAmount: _totalAmount, feeBps: _bps, ...common } = batch;
      return {
        ...common,
        amount: payment.amount,
        units: payment.units,
        fee: payment.fee,
        paymentRef: payment.paymentRef,
        transactions: [...(approval ? [approval] : []), payment.transaction],
      };
    }
    const chain = STOCK_CHAINS[input.network];
    const note = checkPaymentNote(input.note);
    if (!note.ok || note.note) throw new StockTransferRejectedError(`A note rides on the fee router's payment, which ${chain.name} does not run here.`);
    const { client, decimals, sender } = await this.ready(input.network, input.token, input.sender);
    const recipient = getAddress(input.recipient);
    const amount = this.amount(input.token, input.amount, decimals);
    const units = stockTokenUnits(amount, decimals);
    const data = await this.preflight(client, chain.name, input.token, sender, recipient, units, decimals, amount);
    const held = await this.balance(client, chain.name, input.token, sender);
    return { ...this.common(input.network, input.token, decimals, held), amount, units: units.toString(), transaction: { from: sender, to: input.token.address, data, value: "0x0" as const } };
  }

  /**
   * The wallet calls for reviewed payments of one token to one or more people through the fee router: at most one
   * approval of every amount plus its fee, then one `pay` per person, each with the note after its arguments. Every
   * transfer is pre-flighted from the sender, so a balance, pause or issuer blocklist problem for anyone surfaces
   * before the wallet opens, and so are the fee legs.
   */
  async prepareBatch(input: {
    network: StockNetworkId;
    sender: string;
    token: StockTokenListing;
    payments: Array<{ recipient: string; amount: string }>;
    fees: FeeSchedule;
    note?: string;
    paymentRefs?: Hex[];
  }) {
    const chain = STOCK_CHAINS[input.network];
    const note = checkPaymentNote(input.note);
    if (!note.ok) throw new StockTransferRejectedError(note.error);
    if (!input.payments.length || input.payments.length > PAYMENT_BATCH_MAX_RECIPIENTS) {
      throw new StockTransferRejectedError(`One request pays between one and ${PAYMENT_BATCH_MAX_RECIPIENTS} people.`);
    }
    const { client, decimals, sender } = await this.ready(input.network, input.token, input.sender);
    const items = input.payments.map((payment) => {
      const amount = this.amount(input.token, payment.amount, decimals);
      const recipient = getAddress(payment.recipient);
      if (recipient === sender) throw new StockTransferRejectedError("This handle points to your own wallet, so there is nothing to send.");
      return { recipient, amount, units: stockTokenUnits(amount, decimals) };
    });
    // Pre-flight the exact transfers from the sender. Through the fee router the token sees the same movements.
    for (const item of items) await this.preflight(client, chain.name, input.token, sender, item.recipient, item.units, decimals, item.amount);
    const held = await this.balance(client, chain.name, input.token, sender);
    const fees = input.fees;
    const { bps } = await quoteFee(client, fees, sender, items[0].units, chain.name);
    const priced = items.map((item) => ({ ...item, quote: { fee: platformFee(item.units, bps), bps } }));
    const total = priced.reduce((sum, item) => sum + item.units + item.quote.fee, 0n);
    if (held < total) {
      throw new StockTransferRejectedError(`Your wallet holds ${formatUnits(held, decimals)} ${input.token.symbol}; ${items.length > 1 ? "these payments need" : "this payment needs"} ${formatUnits(total, decimals)} ${input.token.symbol}, the ${items.length > 1 ? "amounts" : "amount"} plus the ${Number(bps) / 100}% fee.`);
    }
    // The fee legs meet the issuer's checks too, for example a frozen burn vault, so they are pre-flighted as well.
    const { burnShare, treasuryShare } = priced.reduce((sum, item) => {
      const split = splitPlatformFee(item.quote.fee);
      return { burnShare: sum.burnShare + split.burnShare, treasuryShare: sum.treasuryShare + split.treasuryShare };
    }, { burnShare: 0n, treasuryShare: 0n });
    for (const [destination, share] of [[fees.burnVault, burnShare], [fees.treasury, treasuryShare]] as const) {
      if (share === 0n || getAddress(destination) === sender) continue;
      try {
        await client.call({ account: sender, to: input.token.address, data: encodeFunctionData({ abi: stockTokenTransferAbi, functionName: "transfer", args: [destination, share] }) });
      } catch (error) {
        if (!isRevert(error)) throw new StockTransferUnavailableError(`${chain.name} is not reachable right now. Try again shortly.`);
        throw new StockTransferRejectedError(`The ${input.token.symbol} contract would not accept the fee, so your wallet was not opened. Try again later.`);
      }
    }
    const references = priced.map((_, index) => (input.paymentRefs?.[index] ?? `0x${randomBytes(32).toString("hex")}`).toLowerCase() as Hex);
    if (references.some((reference) => !/^0x[0-9a-f]{64}$/.test(reference)) || new Set(references).size !== references.length) {
      throw new Error("Invalid payment reference source.");
    }
    // An approval left from an attempt whose later signatures never came already covers these payments.
    const approved = await approvalCovers(client, input.token.address, sender, getAddress(fees.router), total);
    return {
      ...this.common(input.network, input.token, decimals, held),
      ...(note.note ? { note: note.note } : {}),
      feeBps: Number(bps),
      totalUnits: total.toString(),
      totalAmount: formatUnits(total, decimals),
      ...(approved ? {} : { approval: { ...routedApproveCall({ token: input.token.address, router: fees.router, units: total }), purpose: "approve" as const, from: sender, value: "0x0" as const } }),
      payments: priced.map((item, index) => ({
        recipient: item.recipient,
        amount: item.amount,
        units: item.units.toString(),
        fee: preparedFee(fees, item.quote, item.units, decimals),
        paymentRef: references[index],
        transaction: {
          ...routedPayCall({ token: input.token.address, router: fees.router, recipient: item.recipient, units: item.units, paymentRef: references[index], note: note.note }),
          purpose: "pay" as const,
          from: sender,
          value: "0x0" as const,
        },
      })),
    };
  }

  /**
   * How much of a listed token a wallet holds, as the token counts it, for the chat's choice of network. Undefined when the chain or the token cannot be verified or read. It is never a permission:
   * preparation reads the balance again, and the wallet signs.
   */
  async holding(network: StockNetworkId, token: StockTokenListing, owner: string): Promise<string | undefined> {
    try {
      const client = await this.client(network);
      await this.verifyToken(network, client, token);
      return formatUnits(await this.balance(client, STOCK_CHAINS[network].name, token, getAddress(owner)), tokenDecimals(token));
    } catch {
      return undefined;
    }
  }

  /** The network's verified client and token, for a sender whose transfers are switched on. */
  private async ready(network: StockNetworkId, token: StockTokenListing, sender: string) {
    const chain = STOCK_CHAINS[network];
    const availability = this.assetAvailability(network, token);
    if (!availability.enabled) throw new StockTransferUnavailableError(availability.reason ?? `${token.symbol} transfers are off on ${chain.name}.`);
    const client = await this.client(network);
    await this.verifyToken(network, client, token);
    return { client, decimals: tokenDecimals(token), sender: getAddress(sender) };
  }

  private amount(token: StockTokenListing, input: string, decimals: number) {
    const amount = normalizeStockAmount(input, decimals);
    if (!amount) throw new StockTransferRejectedError(`Enter a ${token.symbol} amount greater than zero with at most ${decimals} decimals.`);
    return amount;
  }

  /** The exact `transfer` from the sender, by `eth_call`: the token's own answer before any wallet opens. */
  private async preflight(client: StockChainClient, chainName: string, token: StockTokenListing, sender: Address, recipient: Address, units: bigint, decimals: number, amount: string) {
    const data = encodeFunctionData({ abi: stockTokenTransferAbi, functionName: "transfer", args: [recipient, units] });
    let result: { data?: Hex };
    try {
      result = await client.call({ account: sender, to: token.address, data });
    } catch (error) {
      if (!isRevert(error)) throw new StockTransferUnavailableError(`${chainName} is not reachable right now. Try again shortly.`);
      throw new StockTransferRejectedError(transferRejection(error, token.symbol, sender, { decimals, amount }));
    }
    if (!returnedTrue(result.data)) throw new StockTransferRejectedError(`The ${token.symbol} contract did not accept this transfer.`);
    return data;
  }

  private async balance(client: StockChainClient, chainName: string, token: StockTokenListing, sender: Address) {
    let balance: unknown;
    try {
      balance = await client.readContract({ address: token.address, abi: stockTokenTransferAbi, functionName: "balanceOf", args: [sender] });
    } catch {
      throw new StockTransferUnavailableError(`${chainName} is not reachable right now. Try again shortly.`);
    }
    return typeof balance === "bigint" ? balance : 0n;
  }

  private common(network: StockNetworkId, token: StockTokenListing, decimals: number, held: bigint) {
    const chain = STOCK_CHAINS[network];
    return {
      networkId: network,
      chainId: chain.id,
      chainIdHex: `0x${chain.id.toString(16)}` as const,
      chainName: chain.name,
      // Public endpoint for the wallet's network entry; a configured provider URL stays on the server.
      rpcUrl: chain.rpcUrl,
      explorerUrl: chain.explorerUrl,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      token: { symbol: token.symbol, name: token.name, address: token.address, decimals },
      balance: formatUnits(held, decimals),
    };
  }

  async confirm(input: {
    network: StockNetworkId;
    transactionHash: string;
    sender: string;
    recipient: string;
    token: StockTokenListing;
    amount: string;
    platform: Platform;
    username: string;
    sourcePlatform?: Platform;
    sourceUsername?: string;
    /** HaPaPay's fee router on this network, whose `Paid` event shows the fee the transfer paid. */
    router?: Address;
  }) {
    const chain = STOCK_CHAINS[input.network];
    const client = await this.client(input.network);
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new StockTransferRejectedError("Invalid transaction hash.");
    const transactionHash = input.transactionHash.toLowerCase() as Hex;
    const sender = getAddress(input.sender);
    const recipient = getAddress(input.recipient);
    const decimals = tokenDecimals(input.token);
    const amount = normalizeStockAmount(input.amount, decimals);
    if (!amount) throw new StockTransferRejectedError("Invalid token amount.");
    const units = stockTokenUnits(amount, decimals);
    const receipt = await this.receipt(client, transactionHash, chain.name);
    if (receipt.status !== "success") throw new StockTransferRejectedError(`The ${chain.name} transaction reverted; nothing was transferred.`);
    if (getAddress(receipt.from) !== sender) throw new StockTransferRejectedError("The transaction sender does not match the wallet session.");

    const transfer = receipt.logs.find((log) => {
      if (getAddress(log.address) !== input.token.address || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
      if (!log.topics[1] || !log.topics[2]) return false;
      const [value] = decodeAbiParameters(parseAbiParameters("uint256"), log.data);
      return topicAddress(log.topics[1]) === sender && topicAddress(log.topics[2]) === recipient && value === units;
    });
    if (!transfer) throw new StockTransferRejectedError(`The receipt does not contain the reviewed ${input.token.symbol} transfer.`);
    const note = await this.note(client, transactionHash, chain.name, { token: input.token.address, recipient, units });
    const fee = input.router ? routedPaymentFee(receipt.logs, { router: input.router, payer: sender, recipient, token: input.token.address, units }) : undefined;

    const record = await this.options.repository.save({
      chainId: chain.id,
      transactionHash,
      tokenAddress: input.token.address,
      tokenSymbol: input.token.symbol,
      sender,
      recipient,
      platform: input.platform,
      username: input.username.trim().replace(/^@/, "").toLowerCase(),
      amount,
      units,
      blockNumber: receipt.blockNumber,
      confirmedAt: new Date(this.now()).toISOString(),
      sourcePlatform: input.sourcePlatform,
      sourceUsername: input.sourceUsername?.trim().replace(/^@/, "").toLowerCase(),
      ...(note ? { note } : {}),
      ...(fee !== undefined && fee > 0n ? { feeUnits: fee.toString() } : {}),
    });
    return stockHistoryEntry(record, sender);
  }

  /** The note after this transfer's `pay`, read again briefly when the RPC fails, so a note is never lost. */
  private async note(client: StockChainClient, hash: Hex, chainName: string, expected: { token: Address; recipient: Address; units: bigint }) {
    if (!client.getTransaction) return undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        return routedPaymentNote((await client.getTransaction({ hash })).input, expected);
      } catch {
        if (attempt >= 3) throw new StockTransferUnavailableError(`${chainName} could not return this transaction just now. Try verifying it again.`);
        await new Promise((resolve) => setTimeout(resolve, this.receiptRetryMs));
      }
    }
  }

  async list(inputWallet: string) {
    const wallet = getAddress(inputWallet);
    return (await this.options.repository.list(wallet)).map((record) => stockHistoryEntry(record, wallet));
  }

  private async receipt(client: StockChainClient, hash: Hex, chainName: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (error) {
        const missing = error instanceof Error && error.name === "TransactionReceiptNotFoundError";
        if (!missing) throw new StockTransferUnavailableError(`${chainName} could not return this receipt right now. Try again shortly.`);
        if (attempt >= this.receiptAttempts) throw new StockReceiptPendingError(chainName);
        await new Promise((resolve) => setTimeout(resolve, this.receiptRetryMs));
      }
    }
  }
}

/**
 * Whether the payer has already approved at least `total` of the token to `spender`, as after an approval whose second
 * signature never came. The payment then needs only its second call. A failed read counts as no approval, so the
 * approval is asked for again. Leftover allowance is harmless: the router and the escrow only ever pull from the
 * wallet that calls them.
 */
export async function approvalCovers(client: Pick<StockChainClient, "readContract">, token: Address, owner: Address, spender: Address, total: bigint) {
  try {
    const allowance = await client.readContract({ address: token, abi: stockTokenTransferAbi, functionName: "allowance", args: [owner, spender] });
    return typeof allowance === "bigint" && allowance >= total;
  } catch {
    return false;
  }
}

export function revertData(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth++) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isRevert(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth++) {
    const { name, code, message, data } = current as { name?: unknown; code?: unknown; message?: unknown; data?: unknown };
    if (name === "ExecutionRevertedError" || name === "RawContractError" || code === 3) return true;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return true;
    if (typeof message === "string" && /execution reverted/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function returnedTrue(data: Hex | undefined) {
  if (!data || data === "0x") return false;
  try {
    return decodeFunctionResult({ abi: stockTokenTransferAbi, functionName: "transfer", data }) === true;
  } catch {
    return false;
  }
}

/** A readable reason for a transfer the token contract would reject. */
export function transferRejection(error: unknown, symbol: string, sender: Address, context: { decimals?: number; amount?: string } = {}) {
  const decimals = context.decimals ?? 18;
  const data = revertData(error);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: stockTokenTransferAbi, data });
      if (decoded.errorName === "ERC20InsufficientBalance") {
        const [, balance, needed] = decoded.args as readonly [Address, bigint, bigint];
        return `Your wallet holds ${formatUnits(balance, decimals)} ${symbol}; this transfer needs ${formatUnits(needed, decimals)} ${symbol}.`;
      }
      if (decoded.errorName === "InsufficientFunds") {
        return `Your wallet holds less than ${context.amount ? `${context.amount} ` : "the amount of "}${symbol} this transfer needs.`;
      }
      if (decoded.errorName === "IsPaused") return `${symbol} transfers are paused by the issuer right now, for example during a corporate action. Try again later.`;
      if (decoded.errorName === "ContractPaused") return `${symbol} transfers are paused by the issuer right now. Try again later.`;
      if (decoded.errorName === "AddressFrozen") return `The issuer has frozen ${symbol} for this wallet or for the recipient.`;
      if (decoded.errorName === "Blocked") {
        const [account] = decoded.args as readonly [Address];
        return getAddress(account) === sender
          ? `The issuer's compliance list blocks ${symbol} transfers from this wallet.`
          : `The issuer's compliance list blocks ${symbol} transfers to this recipient.`;
      }
      if (decoded.errorName === "ERC20InvalidReceiver" || decoded.errorName === "ZeroAddress") return `${symbol} cannot be sent to this recipient address.`;
    } catch {
      // Unknown revert data falls through to the generic message.
    }
  }
  return `The ${symbol} contract would reject this transfer, so your wallet was not opened.`;
}

function topicAddress(topic: Hex) {
  return getAddress(`0x${topic.slice(-40)}`);
}

function stockNetworkForChain(chainId: number): StockNetworkId | undefined {
  return (Object.keys(STOCK_CHAINS) as StockNetworkId[]).find((network) => STOCK_CHAINS[network].id === chainId);
}

export function stockHistoryEntry(record: StockTransferRecord, wallet: Address) {
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
    asset: {
      type: "stock-token" as const,
      symbol: record.tokenSymbol,
      address: record.tokenAddress,
      chainId: record.chainId,
      network: stockNetworkForChain(record.chainId),
    },
    ...(record.sourcePlatform && record.sourceUsername ? { sourceIdentity: { platform: record.sourcePlatform, username: record.sourceUsername } } : {}),
    ...(record.note ? { note: record.note } : {}),
  };
}

function rowToStockTransfer(row: Record<string, unknown>): StockTransferRecord {
  const confirmedAt = row.confirmed_at instanceof Date ? row.confirmed_at.toISOString() : new Date(String(row.confirmed_at)).toISOString();
  const record: StockTransferRecord = {
    chainId: Number(row.chain_id),
    transactionHash: String(row.transaction_hash) as Hex,
    tokenAddress: getAddress(String(row.token_address)),
    tokenSymbol: String(row.token_symbol),
    sender: getAddress(String(row.sender_address)),
    recipient: getAddress(String(row.recipient_address)),
    platform: String(row.platform) as Platform,
    username: String(row.username_normalized),
    amount: String(row.amount_text),
    units: BigInt(String(row.units_text)),
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

/**
 * The router's fee rate for this payer, read on chain so a holder rate is honored, and the fee on top of
 * `units` it implies (the router's own formula). A rate above 1% is refused.
 */
export async function quoteFee(client: StockChainClient, fees: FeeSchedule, payer: Address, units: bigint, chainName: string) {
  let bps: unknown;
  try {
    bps = await client.readContract({ address: fees.router, abi: payRouterAbi, functionName: "feeBpsFor", args: [payer] });
  } catch {
    throw new StockTransferUnavailableError(`${chainName} is not reachable right now. Try again shortly.`);
  }
  if (typeof bps !== "bigint" || bps < 0n || bps > PLATFORM_FEE_BPS) throw new StockTransferUnavailableError(`The ${chainName} fee router quoted an unexpected fee.`);
  return { fee: platformFee(units, bps), bps };
}

/** What the review shows about the fee: its rate and size, its two halves and the total the wallet approves. */
export function preparedFee(fees: FeeSchedule, quote: { fee: bigint; bps: bigint }, units: bigint, decimals: number): PreparedPlatformFee {
  const { fee, bps } = quote;
  const { burnShare, treasuryShare } = splitPlatformFee(fee);
  return {
    router: fees.router,
    feeBps: Number(bps),
    units: fee.toString(),
    amount: formatUnits(fee, decimals),
    burnShare: burnShare.toString(),
    treasuryShare: treasuryShare.toString(),
    totalUnits: (units + fee).toString(),
    totalAmount: formatUnits(units + fee, decimals),
  };
}
