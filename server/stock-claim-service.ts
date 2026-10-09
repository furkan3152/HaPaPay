import { randomBytes } from "node:crypto";
import {
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { Platform } from "../src/domain/payment-intent.js";
import { pagedPendingLinks, PENDING_CLAIMS_LIMIT, type PendingVaultLink, type VaultRecipient } from "../src/domain/pending-claims.js";
import { robinhoodAsset } from "../src/domain/robinhood-assets.js";
import { platformFee, type FeeSchedule } from "../src/domain/fees.js";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../src/domain/stock-claim-escrow-artifact.js";
import {
  STOCK_CLAIM_ESCROW_REVISION,
  STOCK_CLAIM_MAX_WINDOW_SECONDS,
  STOCK_CLAIM_PLATFORMS,
  STOCK_CLAIM_WINDOW_HOURS,
  isStockClaimPlatform,
  stockClaimEscrowAbi,
  stockClaimPath,
  stockClaimPlatformHash,
  stockTokenApproveAbi,
  type StockClaimAvailability,
  type StockClaimDetails,
  type StockClaimPlatform,
  type StockEscrowDeployment,
} from "../src/domain/stock-claims.js";
import {
  STOCK_CHAINS,
  isStockToken,
  normalizeStockAmount,
  tokenDecimals,
  transferAvailabilityFor,
  type StockNetworkId,
  type StockTokenListing,
} from "../src/domain/stock-tokens.js";
import { RecipientLookupUnavailableError, type DiscoveredRecipient } from "./recipient-discovery.js";
import { locksToName, type VaultLock } from "../src/domain/vault-lock.js";
import { anyClaimsLink, identityKeysOf, linkMadeAt, lockOfLink, notTheNameHolder, VaultNameLockOffer, vaultRecipient } from "./vault-recipient.js";
import { verifyFeeContracts, type FeeContractReader } from "./fee-verification.js";
import type { StockClaimConfig } from "./robinhood-network.js";
import {
  StockTransferRejectedError,
  StockTransferUnavailableError,
  approvalCovers,
  isRevert,
  preparedFee,
  quoteFee,
  returnedTrue,
  revertData,
  stockTokenTransferAbi,
  type StockChainClient,
  type StockTransferService,
} from "./stock-transfer-service.js";
import type { VerifiedSocialAccount } from "./verified-identity-service.js";
import { evmVaultSettlement, type VaultClaimCandidate, type VaultSettlement } from "./vault-settlement.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A claim authorization is usable for ten minutes, or until the claim window closes if that is sooner. */
const CLAIM_SIGNATURE_SECONDS = 600n;

export type StockClaimEscrowRecord = {
  chainId: number;
  escrow: Address;
  deploymentTransactionHash: Hex;
  owner: Address;
  verifier: Address;
  blockNumber: bigint;
  registeredAt: string;
};

export type StockClaimRecord = {
  chainId: number;
  paymentId: Hex;
  escrow: Address;
  fundingTransactionHash: Hex;
  tokenAddress: Address;
  tokenSymbol: string;
  payer: Address;
  recipientPlatform: StockClaimPlatform;
  recipientUsername: string;
  amount: string;
  units: bigint;
  expiry: bigint;
  blockNumber: bigint;
  confirmedAt: string;
  sourcePlatform?: Platform;
  sourceUsername?: string;
};

export interface StockClaimRepository {
  /** Records an operator-verified escrow; registering it again makes it the chain's active escrow once more. */
  saveEscrow(record: StockClaimEscrowRecord): Promise<StockClaimEscrowRecord>;
  /** The most recently registered escrow on a chain: the one new claim links fund. */
  activeEscrow(chainId: number): Promise<StockClaimEscrowRecord | undefined>;
  escrow(chainId: number, address: Address): Promise<StockClaimEscrowRecord | undefined>;
  /** Idempotent for the same funding transaction; a different transaction for the same payment ID is refused. */
  saveClaim(record: StockClaimRecord): Promise<StockClaimRecord>;
  claim(chainId: number, paymentId: Hex): Promise<StockClaimRecord | undefined>;
  /** Links on this chain sent to any of these accounts whose window is still open at `now`, soonest deadline first. */
  waitingFor(chainId: number, recipients: readonly VaultRecipient[], now: bigint, limit: number, offset?: number): Promise<StockClaimRecord[]>;
  /** Links on this chain the wallet funded, latest deadline first. */
  fundedBy(chainId: number, payer: Address, limit: number, offset?: number): Promise<StockClaimRecord[]>;
}

/** Only the contract owner configured on the server may register a claim escrow. Maps to HTTP 403. */
export class StockEscrowOperatorError extends Error {
  constructor() {
    super("Only the contract owner wallet set on this server can register a claim escrow.");
    this.name = "StockEscrowOperatorError";
  }
}

/** No escrow holds a claim for this link. Maps to HTTP 404. */
export class StockClaimNotFoundError extends Error {
  constructor(message = "This claim link was not found.") {
    super(message);
    this.name = "StockClaimNotFoundError";
  }
}

/** The payment ID is already recorded with another funding transaction. Maps to HTTP 409. */
export class DuplicateStockClaimError extends Error {
  constructor() {
    super("This claim link was already recorded with another funding transaction.");
    this.name = "DuplicateStockClaimError";
  }
}

type SqlResult = { rows: Array<Record<string, unknown>> };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

export class PostgresStockClaimRepository implements StockClaimRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS stock_claim_escrows (
        chain_id INTEGER NOT NULL,
        escrow_address TEXT NOT NULL,
        deployment_transaction_hash TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        verifier_address TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        registered_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (chain_id, escrow_address),
        UNIQUE (chain_id, deployment_transaction_hash)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS stock_claims (
        chain_id INTEGER NOT NULL,
        payment_id TEXT NOT NULL,
        escrow_address TEXT NOT NULL,
        funding_transaction_hash TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        payer_address TEXT NOT NULL,
        recipient_platform TEXT NOT NULL,
        recipient_username_normalized TEXT NOT NULL,
        amount_text TEXT NOT NULL,
        units_text TEXT NOT NULL,
        expiry BIGINT NOT NULL,
        block_number BIGINT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL,
        source_platform TEXT,
        source_username_normalized TEXT,
        PRIMARY KEY (chain_id, payment_id),
        UNIQUE (chain_id, funding_transaction_hash)
      )
    `);
  }

  async saveEscrow(record: StockClaimEscrowRecord) {
    const result = await this.pool.query(
      `INSERT INTO stock_claim_escrows
        (chain_id, escrow_address, deployment_transaction_hash, owner_address, verifier_address, block_number, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chain_id, escrow_address) DO UPDATE
         SET owner_address = EXCLUDED.owner_address, verifier_address = EXCLUDED.verifier_address, registered_at = EXCLUDED.registered_at
       RETURNING *`,
      [record.chainId, record.escrow, record.deploymentTransactionHash, record.owner, record.verifier, record.blockNumber.toString(), record.registeredAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Stock claim escrow insert did not return a record.");
    return rowToEscrow(row);
  }

  async activeEscrow(chainId: number) {
    const result = await this.pool.query(
      "SELECT * FROM stock_claim_escrows WHERE chain_id = $1 ORDER BY registered_at DESC, block_number DESC LIMIT 1",
      [chainId],
    );
    return result.rows[0] ? rowToEscrow(result.rows[0]) : undefined;
  }

  async escrow(chainId: number, address: Address) {
    const result = await this.pool.query("SELECT * FROM stock_claim_escrows WHERE chain_id = $1 AND escrow_address = $2", [chainId, getAddress(address)]);
    return result.rows[0] ? rowToEscrow(result.rows[0]) : undefined;
  }

  async saveClaim(record: StockClaimRecord) {
    let inserted: SqlResult;
    try {
      inserted = await this.pool.query(
        `INSERT INTO stock_claims
          (chain_id, payment_id, escrow_address, funding_transaction_hash, token_address, token_symbol, payer_address,
           recipient_platform, recipient_username_normalized, amount_text, units_text, expiry, block_number, confirmed_at,
           source_platform, source_username_normalized)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (chain_id, payment_id) DO NOTHING
         RETURNING *`,
        [
          record.chainId,
          record.paymentId,
          record.escrow,
          record.fundingTransactionHash,
          record.tokenAddress,
          record.tokenSymbol,
          record.payer,
          record.recipientPlatform,
          record.recipientUsername,
          record.amount,
          record.units.toString(),
          record.expiry.toString(),
          record.blockNumber.toString(),
          record.confirmedAt,
          record.sourcePlatform ?? null,
          record.sourceUsername ?? null,
        ],
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DuplicateStockClaimError();
      throw error;
    }
    const stored = inserted.rows[0] ? rowToClaim(inserted.rows[0]) : await this.claim(record.chainId, record.paymentId);
    if (!stored || stored.fundingTransactionHash !== record.fundingTransactionHash) throw new DuplicateStockClaimError();
    return stored;
  }

  async claim(chainId: number, paymentId: Hex) {
    const result = await this.pool.query("SELECT * FROM stock_claims WHERE chain_id = $1 AND payment_id = $2", [chainId, paymentId.toLowerCase()]);
    return result.rows[0] ? rowToClaim(result.rows[0]) : undefined;
  }

  async waitingFor(chainId: number, recipients: readonly VaultRecipient[], now: bigint, limit: number, offset = 0) {
    if (!recipients.length) return [];
    const matches = recipients.map((_, index) => `(recipient_platform = $${4 + index * 2} AND recipient_username_normalized = $${5 + index * 2})`);
    const result = await this.pool.query(
      `SELECT * FROM stock_claims WHERE chain_id = $1 AND expiry >= $2 AND (${matches.join(" OR ")})
       ORDER BY expiry ASC, block_number ASC, payment_id ASC LIMIT $3 OFFSET $${4 + recipients.length * 2}`,
      [chainId, now.toString(), limit, ...recipients.flatMap((recipient) => [recipient.platform, recipient.username]), offset],
    );
    return result.rows.map(rowToClaim);
  }

  async fundedBy(chainId: number, payer: Address, limit: number, offset = 0) {
    const result = await this.pool.query(
      "SELECT * FROM stock_claims WHERE chain_id = $1 AND payer_address = $2 ORDER BY expiry DESC, block_number DESC, payment_id ASC LIMIT $3 OFFSET $4",
      [chainId, getAddress(payer), limit, offset],
    );
    return result.rows.map(rowToClaim);
  }
}

export class MemoryStockClaimRepository implements StockClaimRepository {
  private readonly escrows = new Map<string, StockClaimEscrowRecord>();
  private readonly claims = new Map<string, StockClaimRecord>();

  async saveEscrow(record: StockClaimEscrowRecord) {
    const key = `${record.chainId}:${record.escrow}`;
    const stored = { ...(this.escrows.get(key) ?? record), owner: record.owner, verifier: record.verifier, registeredAt: record.registeredAt };
    this.escrows.set(key, stored);
    return stored;
  }

  async activeEscrow(chainId: number) {
    return [...this.escrows.values()]
      .filter((record) => record.chainId === chainId)
      .sort((left, right) => right.registeredAt.localeCompare(left.registeredAt) || Number(right.blockNumber - left.blockNumber))[0];
  }

  async escrow(chainId: number, address: Address) {
    return this.escrows.get(`${chainId}:${getAddress(address)}`);
  }

  async saveClaim(record: StockClaimRecord) {
    const key = `${record.chainId}:${record.paymentId.toLowerCase()}`;
    const existing = this.claims.get(key);
    const reusedTransaction = [...this.claims.values()].some((stored) => stored.chainId === record.chainId
      && stored.fundingTransactionHash === record.fundingTransactionHash && stored.paymentId !== record.paymentId);
    if ((existing && existing.fundingTransactionHash !== record.fundingTransactionHash) || reusedTransaction) throw new DuplicateStockClaimError();
    this.claims.set(key, existing ?? record);
    return existing ?? record;
  }

  async claim(chainId: number, paymentId: Hex) {
    return this.claims.get(`${chainId}:${paymentId.toLowerCase()}`);
  }

  async waitingFor(chainId: number, recipients: readonly VaultRecipient[], now: bigint, limit: number, offset = 0) {
    return [...this.claims.values()]
      .filter((record) => record.chainId === chainId && record.expiry >= now
        && recipients.some((recipient) => recipient.platform === record.recipientPlatform && recipient.username === record.recipientUsername))
      .sort((left, right) => Number(left.expiry - right.expiry) || Number(left.blockNumber - right.blockNumber))
      .slice(offset, offset + limit);
  }

  async fundedBy(chainId: number, payer: Address, limit: number, offset = 0) {
    return [...this.claims.values()]
      .filter((record) => record.chainId === chainId && record.payer === getAddress(payer))
      .sort((left, right) => Number(right.expiry - left.expiry) || Number(right.blockNumber - left.blockNumber))
      .slice(offset, offset + limit);
  }
}

type RecipientDirectory = {
  lookup(platform: Platform, username: string): Promise<DiscoveredRecipient>;
  /** Platforms without an official lookup on this server get no claim links. Absent means every platform. */
  supports?(platform: Platform): boolean;
};
type EscrowPayment = { payer: Address; token: Address; identityKey: Hex; amount: bigint; fee: bigint; expiry: bigint };
type EscrowCheck = "code" | "claim" | "funding";

/**
 * Vault (claim) links for allowlisted Robinhood Chain tokens (Stock Tokens and USDG) sent to a GitHub, X
 * or Farcaster account that has not joined HaPaPay. The payer's wallet approves and funds the escrow; the
 * recipient's wallet claims after the official provider proves the immutable account the payment is locked to, and
 * the server's attestor signs that one claim. The server never signs or broadcasts a transfer and never holds
 * tokens. Chain and token verification come from the transfer service, so both features trust the same RPC checks.
 */
export class StockClaimService {
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly activeEscrows = new Map<number, { record?: StockClaimEscrowRecord; readAt: number }>();
  private readonly verifiedEscrows = new Map<string, number>();
  private readonly verifiedFees = new Map<string, { schedule: FeeSchedule; readAt: number }>();

  constructor(private readonly options: {
    transfers: Pick<StockTransferService, "availability" | "verifiedClient" | "transactionReceipt"> & Partial<Pick<StockTransferService, "readReceipt">>;
    repository: StockClaimRepository;
    directory: RecipientDirectory;
    config: StockClaimConfig;
    now?: () => number;
    randomBytes32?: () => Hex;
    /** How long an escrow lookup or on-chain escrow check is reused. */
    cacheMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 30_000;
  }

  /** Stock Token and USDG switches of the network; links run while at least one of them is on. */
  private switches(network: StockNetworkId) {
    const transfers = this.options.transfers.availability(network);
    const tokens = transfers.tokens ?? { enabled: transfers.enabled, reason: transfers.reason };
    return { transfers, stock: transfers.enabled, tokens: tokens.enabled, any: transfers.enabled || tokens.enabled };
  }

  async availability(network: StockNetworkId): Promise<StockClaimAvailability> {
    const chain = STOCK_CHAINS[network];
    const switches = this.switches(network);
    if (!switches.any) return { enabled: false, reason: switches.transfers.reason ?? `${chain.name} transfers are off on this server.` };
    if (this.options.config.networks[network].setup.length) return { enabled: false, reason: `Stock claim links are not set up on ${chain.name} yet.` };
    let record: StockClaimEscrowRecord | undefined;
    try {
      record = await this.activeEscrow(network);
    } catch {
      return { enabled: false, reason: "Stock claim links are unavailable right now. Try again shortly." };
    }
    if (!record) return { enabled: false, reason: `No claim escrow is deployed on ${chain.name} yet.` };
    const attestor = this.options.config.networks[network].attestor;
    if (!attestor || record.verifier !== getAddress(attestor.address) || record.owner !== this.options.config.operator) {
      return { enabled: false, reason: `The ${chain.name} claim escrow no longer matches this server's settings.` };
    }
    // Discord, Telegram and X links can wait for the name, so they need no lookup (2026-10-06).
    const platforms = STOCK_CLAIM_PLATFORMS.filter((platform) => locksToName(platform) || (this.options.directory.supports?.(platform) ?? true));
    let fees: FeeSchedule;
    try {
      fees = await this.escrowFees(network, record.escrow);
    } catch (error) {
      return { enabled: false, reason: error instanceof Error ? error.message : "Vault links are unavailable right now. Try again shortly." };
    }
    return { enabled: true, escrow: record.escrow, platforms, stockTokens: switches.stock, tokens: switches.tokens, fees };
  }

  /**
   * The fee contracts every payment on this network goes through: the router behind the registered escrow, verified
   * on chain. Undefined until the operator has registered an escrow, so payments stay fee-free until then; a
   * registered escrow whose fee contracts cannot be verified stops payments instead of skipping the fee.
   */
  async feeSchedule(network: StockNetworkId): Promise<FeeSchedule | undefined> {
    const record = await this.activeEscrow(network);
    if (!record) return undefined;
    return this.escrowFees(network, record.escrow);
  }

  /** What the operator page needs to deploy and register an escrow. Addresses only. */
  async deployment(network: StockNetworkId): Promise<StockEscrowDeployment> {
    const chain = STOCK_CHAINS[network];
    const config = this.options.config.networks[network];
    const record = await this.activeEscrow(network).catch(() => undefined);
    const switches = this.switches(network);
    const transfersEnabled = switches.any;
    // Links need at least one asset that may move on the network: mainnet USDG runs unless turned off.
    const transfersFlag = network === "robinhood-mainnet" ? "ROBINHOOD_MAINNET_TOKEN_TRANSFERS=enabled" : "ROBINHOOD_TESTNET_STOCK_TRANSFERS=enabled";
    const fees = record ? await this.escrowFees(network, record.escrow).catch(() => undefined) : undefined;
    return {
      network,
      chainId: chain.id,
      chainName: chain.name,
      explorerUrl: chain.explorerUrl,
      transfersEnabled,
      stockTransfersEnabled: switches.stock,
      tokenTransfersEnabled: switches.tokens,
      verifier: config.attestor ? getAddress(config.attestor.address) : undefined,
      operator: this.options.config.operator,
      escrow: record ? {
        address: record.escrow,
        deploymentTransactionHash: record.deploymentTransactionHash,
        blockNumber: record.blockNumber.toString(),
        registeredAt: record.registeredAt,
      } : undefined,
      ...(fees ? { fees } : {}),
      claims: await this.availability(network),
      setup: transfersEnabled ? config.setup : [...config.setup, transfersFlag],
    };
  }

  /**
   * Registers an escrow the operator deployed from the operator page. The receipt must be a successful contract
   * creation from the operator's session wallet, the runtime code must be the bundled StockClaimEscrow build, and
   * the contract must report revision 2, this server's attestor as verifier, and the operator as owner. Its fee
   * router and burn vault must be the bundled builds too, owned by the operator, with the operator as treasury.
   */
  async register(input: { network: StockNetworkId; transactionHash: string; wallet: string }) {
    const chain = STOCK_CHAINS[input.network];
    const config = this.options.config.networks[input.network];
    const operator = this.options.config.operator;
    if (!config.attestor || !operator) {
      throw new StockTransferUnavailableError(`This server needs ${config.setup.join(" and ")} before a ${chain.name} claim escrow can be registered.`);
    }
    if (getAddress(input.wallet) !== operator) throw new StockEscrowOperatorError();
    const switches = this.switches(input.network);
    if (!switches.any) throw new StockTransferUnavailableError(switches.transfers.reason ?? `${chain.name} transfers are off on this server.`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new StockTransferRejectedError("Invalid transaction hash.");
    const transactionHash = input.transactionHash.toLowerCase() as Hex;
    const receipt = await this.options.transfers.transactionReceipt(input.network, transactionHash);
    if (receipt.status !== "success") throw new StockTransferRejectedError(`The deployment transaction reverted on ${chain.name}.`);
    if (getAddress(receipt.from) !== operator) throw new StockTransferRejectedError("The deployment was sent from another wallet.");
    if (!receipt.contractAddress) throw new StockTransferRejectedError("This transaction did not deploy a contract.");
    const escrow = getAddress(receipt.contractAddress);
    const client = await this.options.transfers.verifiedClient(input.network);
    await this.verifyEscrow(input.network, client, escrow, "funding", { fresh: true, fail: (message) => new StockTransferRejectedError(message) });
    await this.escrowFees(input.network, escrow, { fresh: true, fail: (message) => new StockTransferRejectedError(message) });
    await this.options.repository.saveEscrow({
      chainId: chain.id,
      escrow,
      deploymentTransactionHash: transactionHash,
      owner: operator,
      verifier: getAddress(config.attestor.address),
      blockNumber: receipt.blockNumber,
      registeredAt: new Date(this.now()).toISOString(),
    });
    this.activeEscrows.delete(chain.id);
    return this.deployment(input.network);
  }

  /** Approve and fund transactions for one claim link. Nothing is recorded until the funding receipt is verified. */
  async prepare(input: {
    network: StockNetworkId;
    payer: string;
    token: StockTokenListing;
    amount: string;
    platform: StockClaimPlatform;
    username: string;
    expiryHours: number;
    /** The reviewed lock: an X link waits for the name only when the review said so. */
    lock?: VaultLock;
  }) {
    const chain = STOCK_CHAINS[input.network];
    const availability = await this.availability(input.network);
    if (!availability.enabled || !availability.escrow) throw new StockTransferUnavailableError(availability.reason ?? `Vault links are off on ${chain.name}.`);
    const asset = transferAvailabilityFor(this.options.transfers.availability(input.network), input.token);
    if (!asset.enabled) throw new StockTransferUnavailableError(asset.reason ?? `${input.token.symbol} transfers are off on ${chain.name}.`);
    if (!isStockClaimPlatform(input.platform) || !(availability.platforms ?? []).includes(input.platform)) {
      throw new StockTransferUnavailableError("This server cannot look up accounts on that platform, so it cannot lock a vault link to one.");
    }
    const escrow = availability.escrow;
    const { min, max } = STOCK_CLAIM_WINDOW_HOURS;
    if (!Number.isInteger(input.expiryHours) || input.expiryHours < min || input.expiryHours > max) {
      throw new StockTransferRejectedError("The claim window must be between 24 hours and 30 days.");
    }
    const decimals = tokenDecimals(input.token);
    const amount = normalizeStockAmount(input.amount, decimals);
    if (!amount) throw new StockTransferRejectedError(`Enter a ${input.token.symbol} amount greater than zero with at most ${decimals} decimals.`);
    const units = parseUnits(amount, decimals);
    const identity = await this.recipient(input.platform, input.username, input.lock);
    const client = await this.options.transfers.verifiedClient(input.network, input.token);
    await this.verifyEscrow(input.network, client, escrow, "funding");
    const fees = availability.fees ?? await this.escrowFees(input.network, escrow);
    const payer = getAddress(input.payer);
    const quote = await quoteFee(client, fees, payer, units, chain.name);
    const total = units + quote.fee;

    // The escrow pulls the amount and the fee with transferFrom. A transfer of that total from the payer to the
    // escrow meets the same issuer pause, compliance-list and balance checks, so it is pre-flighted first.
    const probe = encodeFunctionData({ abi: stockTokenTransferAbi, functionName: "transfer", args: [escrow, total] });
    let result: { data?: Hex };
    try {
      result = await client.call({ account: payer, to: input.token.address, data: probe });
    } catch (error) {
      if (!isRevert(error)) throw new StockTransferUnavailableError(`${chain.name} is not reachable right now. Try again shortly.`);
      throw new StockTransferRejectedError(claimRejection(error, {
        symbol: input.token.symbol, wallet: payer, escrow, action: "fund", decimals, amount: formatUnits(total, decimals),
      }));
    }
    if (!returnedTrue(result.data)) throw new StockTransferRejectedError(`The ${input.token.symbol} contract did not accept this transfer.`);
    let balance: unknown;
    try {
      balance = await client.readContract({ address: input.token.address, abi: stockTokenTransferAbi, functionName: "balanceOf", args: [payer] });
    } catch {
      throw new StockTransferUnavailableError(`${chain.name} is not reachable right now. Try again shortly.`);
    }

    const paymentId = (this.options.randomBytes32?.() ?? `0x${randomBytes(32).toString("hex")}`).toLowerCase() as Hex;
    if (!/^0x[0-9a-f]{64}$/.test(paymentId)) throw new Error("Invalid payment ID source.");
    const expiry = BigInt(Math.floor(this.now() / 1000) + input.expiryHours * 60 * 60);
    return {
      networkId: input.network,
      chainId: chain.id,
      chainIdHex: `0x${chain.id.toString(16)}` as `0x${string}`,
      chainName: chain.name,
      // Public endpoint for the wallet's network entry; a configured provider URL stays on the server.
      rpcUrl: chain.rpcUrl,
      explorerUrl: chain.explorerUrl,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      escrow,
      token: { symbol: input.token.symbol, name: input.token.name, address: input.token.address, decimals },
      amount,
      units: units.toString(),
      balance: formatUnits(typeof balance === "bigint" ? balance : 0n, decimals),
      paymentId,
      recipient: { platform: identity.platform, username: identity.username },
      lock: identity.lock,
      expiry: expiry.toString(),
      expiresAt: new Date(Number(expiry) * 1000).toISOString(),
      claimPath: stockClaimPath(input.network, paymentId),
      fee: preparedFee(fees, quote, units, decimals),
      transactions: [
        // An approval left from an attempt whose second signature never came already covers this link.
        ...(await approvalCovers(client, input.token.address, payer, getAddress(escrow), total) ? [] : [{
          purpose: "approve" as const,
          from: payer,
          to: input.token.address,
          data: encodeFunctionData({ abi: stockTokenApproveAbi, functionName: "approve", args: [escrow, total] }),
          value: "0x0" as const,
        }]),
        {
          purpose: "fund" as const,
          from: payer,
          to: escrow,
          data: encodeFunctionData({
            abi: stockClaimEscrowAbi,
            functionName: "createPayment",
            args: [paymentId, input.token.address, stockClaimPlatformHash(identity.platform), keccak256(stringToHex(identity.providerUserId)), units, expiry],
          }),
          value: "0x0" as const,
        },
      ],
    };
  }

  /** Records a claim link after its receipt shows the exact PaymentCreated event from a registered escrow. */
  async confirmFunding(input: {
    network: StockNetworkId;
    escrow: string;
    paymentId: string;
    transactionHash: string;
    payer: string;
    token: StockTokenListing;
    amount: string;
    platform: StockClaimPlatform;
    username: string;
    /** The lock the prepared link carried: a link waiting for a name is checked without a lookup. */
    lock?: VaultLock;
    sourceIdentity?: { platform: Platform; username: string };
  }) {
    const chain = STOCK_CHAINS[input.network];
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new StockTransferRejectedError("Invalid transaction hash.");
    const paymentId = validPaymentId(input.paymentId);
    const transactionHash = input.transactionHash.toLowerCase() as Hex;
    let escrow: Address;
    try {
      escrow = getAddress(input.escrow);
    } catch {
      throw new StockTransferRejectedError("Invalid escrow address.");
    }
    if (!await this.options.repository.escrow(chain.id, escrow)) throw new StockTransferRejectedError(`This is not a registered ${chain.name} claim escrow.`);
    const payer = getAddress(input.payer);
    const decimals = tokenDecimals(input.token);
    const amount = normalizeStockAmount(input.amount, decimals);
    if (!amount) throw new StockTransferRejectedError("Invalid token amount.");
    const units = parseUnits(amount, decimals);
    const identity = await this.recipient(input.platform, input.username, input.lock);
    const identityKey = stockClaimIdentityKey(identity.platform, identity.providerUserId);
    const receipt = await this.options.transfers.transactionReceipt(input.network, transactionHash);
    if (receipt.status !== "success") throw new StockTransferRejectedError(`The ${chain.name} transaction reverted; nothing is held in escrow.`);
    if (getAddress(receipt.from) !== payer) throw new StockTransferRejectedError("The transaction sender does not match the wallet session.");

    let expiry: bigint | undefined;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== escrow) continue;
      let event;
      try {
        event = decodeEventLog({ abi: stockClaimEscrowAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      } catch {
        continue;
      }
      if (event.eventName !== "PaymentCreated") continue;
      const { args } = event;
      if (args.paymentId.toLowerCase() !== paymentId || getAddress(args.payer) !== payer || args.identityKey.toLowerCase() !== identityKey) continue;
      if (getAddress(args.token) !== input.token.address || args.amount !== units || args.fee > platformFee(units)) continue;
      expiry = args.expiry;
      break;
    }
    if (expiry === undefined) throw new StockTransferRejectedError("The receipt does not contain the reviewed escrow funding.");
    // A link whose window has closed is recorded too: its payer finds it under Claims and takes it back.

    const record = await this.options.repository.saveClaim({
      chainId: chain.id,
      paymentId,
      escrow,
      fundingTransactionHash: transactionHash,
      tokenAddress: input.token.address,
      tokenSymbol: input.token.symbol,
      payer,
      recipientPlatform: identity.platform,
      recipientUsername: identity.username,
      amount,
      units,
      expiry,
      blockNumber: receipt.blockNumber,
      confirmedAt: new Date(this.now()).toISOString(),
      sourcePlatform: input.sourceIdentity?.platform,
      sourceUsername: input.sourceIdentity?.username.trim().replace(/^@/, "").toLowerCase(),
    });
    return publicClaim(record, input.network);
  }

  /** The claim page's view: the escrow's current state, labelled with the funding record when there is one. */
  async details(network: StockNetworkId, paymentIdInput: string): Promise<StockClaimDetails> {
    const chain = STOCK_CHAINS[network];
    const paymentId = validPaymentId(paymentIdInput);
    const { record, escrow } = await this.claimEscrow(network, paymentId);
    const client = await this.options.transfers.verifiedClient(network);
    const payment = await this.readPayment(client, escrow, paymentId, chain.name);
    const labels = record ? {
      recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
      fundingTransactionHash: record.fundingTransactionHash,
      ...(record.sourcePlatform && record.sourceUsername ? { sourceIdentity: { platform: record.sourcePlatform, username: record.sourceUsername } } : {}),
    } : {};
    if (payment.payer === ZERO_ADDRESS) {
      if (!record) throw new StockClaimNotFoundError();
      const listed = robinhoodAsset(network, record.tokenAddress);
      // A settled link names nobody: its page only says it was claimed or refunded (audit, 2026-10-06).
      return {
        network, chainId: chain.id, paymentId, escrow, fundingTransactionHash: record.fundingTransactionHash,
        payer: record.payer,
        token: {
          symbol: record.tokenSymbol,
          name: listed?.name ?? record.tokenSymbol,
          address: record.tokenAddress,
          ...(listed ? { kind: listed.kind, decimals: tokenDecimals(listed) } : {}),
        },
        amount: record.amount,
        expiresAt: new Date(Number(record.expiry) * 1000).toISOString(),
        status: "settled",
      };
    }
    const token = robinhoodAsset(network, payment.token);
    if (!token) throw new StockClaimNotFoundError("This claim link does not hold a verified token.");
    const now = BigInt(Math.floor(this.now() / 1000));
    return {
      network, chainId: chain.id, paymentId, escrow, ...labels,
      ...(record ? { lock: lockOfLink({ platform: record.recipientPlatform, username: record.recipientUsername }, payment.identityKey, stockClaimIdentityKey) } : {}),
      payer: payment.payer,
      token: { symbol: token.symbol, name: token.name, address: token.address, kind: token.kind, decimals: tokenDecimals(token) },
      amount: formatUnits(payment.amount, tokenDecimals(token)),
      fee: formatUnits(payment.fee, tokenDecimals(token)),
      expiresAt: new Date(Number(payment.expiry) * 1000).toISOString(),
      status: now > payment.expiry ? "expired" : "claimable",
    };
  }

  /**
   * Signs one claim for the session wallet when a verified account matches the payment's locked identity. A mainnet
   * Stock Token claim also needs the recipient's eligibility statement; USDG does not.
   */
  async prepareClaim(input: { network: StockNetworkId; paymentId: string; wallet: string; accounts: VerifiedSocialAccount[]; eligibilityConfirmed?: boolean }) {
    const chain = STOCK_CHAINS[input.network];
    const attestor = this.options.config.networks[input.network].attestor;
    if (!attestor) throw new StockTransferUnavailableError(`Stock claim links are not set up on ${chain.name}.`);
    const paymentId = validPaymentId(input.paymentId);
    const wallet = getAddress(input.wallet);
    const { record, escrow } = await this.claimEscrow(input.network, paymentId);
    const client = await this.options.transfers.verifiedClient(input.network);
    await this.verifyEscrow(input.network, client, escrow, "claim");
    const payment = await this.readPayment(client, escrow, paymentId, chain.name);
    if (payment.payer === ZERO_ADDRESS) throw new StockTransferRejectedError("This claim link was already claimed or refunded.");
    const token = robinhoodAsset(input.network, payment.token);
    if (!token) throw new StockClaimNotFoundError("This claim link does not hold a verified token.");
    const asset = transferAvailabilityFor(this.options.transfers.availability(input.network), token);
    if (!asset.enabled) throw new StockTransferUnavailableError(asset.reason ?? `${token.symbol} transfers are off on ${chain.name}.`);
    if (!chain.testAssets && isStockToken(token) && input.eligibilityConfirmed !== true) {
      throw new StockTransferRejectedError("Confirm that you may hold Robinhood Stock Tokens before claiming on mainnet.");
    }
    await this.options.transfers.verifiedClient(input.network, token);
    const now = BigInt(Math.floor(this.now() / 1000));
    if (now > payment.expiry) throw new StockTransferRejectedError("The claim window has closed. The sender can take the tokens back.");
    // The account the link waits for, or on Discord, Telegram and X the name, held by an account older than the link.
    const matched = anyClaimsLink(input.accounts, payment.identityKey, stockClaimIdentityKey, linkMadeAt(record, payment.expiry, STOCK_CLAIM_MAX_WINDOW_SECONDS));
    if (!matched) {
      throw new StockTransferRejectedError(record && lockOfLink({ platform: record.recipientPlatform, username: record.recipientUsername }, payment.identityKey, stockClaimIdentityKey) === "name"
        ? notTheNameHolder(record.recipientPlatform, record.recipientUsername)
        : "None of your verified accounts is the one this claim is locked to. Connect it through its official provider first.");
    }
    const claimDeadline = now + CLAIM_SIGNATURE_SECONDS < payment.expiry ? now + CLAIM_SIGNATURE_SECONDS : payment.expiry;
    const attestation = keccak256(encodeAbiParameters(
      parseAbiParameters("uint256, address, bytes32, bytes32, address, address, uint256, uint256, uint256"),
      [BigInt(chain.id), escrow, paymentId, payment.identityKey, payment.token, wallet, payment.amount, payment.expiry, claimDeadline],
    ));
    const signature = await attestor.signMessage({ message: { raw: attestation } });
    const data = encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "claim", args: [paymentId, wallet, claimDeadline, signature] });
    await this.preflight(client, { wallet, escrow, data, symbol: token.symbol, chainName: chain.name, action: "claim", decimals: tokenDecimals(token) });
    return { ...actionResponse(input.network, escrow, paymentId, token, payment.amount, wallet, data), claimDeadline: claimDeadline.toString() };
  }

  /** The payer's refund after the claim window closes. No attestation is involved. */
  async prepareRefund(input: { network: StockNetworkId; paymentId: string; wallet: string }) {
    const chain = STOCK_CHAINS[input.network];
    const paymentId = validPaymentId(input.paymentId);
    const wallet = getAddress(input.wallet);
    const { escrow } = await this.claimEscrow(input.network, paymentId);
    const client = await this.options.transfers.verifiedClient(input.network);
    await this.verifyEscrow(input.network, client, escrow, "code");
    const payment = await this.readPayment(client, escrow, paymentId, chain.name);
    if (payment.payer === ZERO_ADDRESS) throw new StockTransferRejectedError("This claim link was already claimed or refunded.");
    if (payment.payer !== wallet) throw new StockTransferRejectedError("Only the wallet that funded this claim link can take it back.");
    const token = robinhoodAsset(input.network, payment.token);
    if (!token) throw new StockClaimNotFoundError("This claim link does not hold a verified token.");
    if (BigInt(Math.floor(this.now() / 1000)) <= payment.expiry) {
      throw new StockTransferRejectedError(`The tokens can be taken back after the claim window closes at ${new Date(Number(payment.expiry) * 1000).toISOString()}.`);
    }
    const data = encodeFunctionData({ abi: stockClaimEscrowAbi, functionName: "refund", args: [paymentId] });
    await this.preflight(client, { wallet, escrow, data, symbol: token.symbol, chainName: chain.name, action: "refund", decimals: tokenDecimals(token) });
    return actionResponse(input.network, escrow, paymentId, token, payment.amount, wallet, data);
  }

  /**
   * The vault links on this network the session wallet can act on, each read back from its escrow so nothing is
   * listed that the escrow no longer holds: links sent to one of its verified accounts, or to its name, whose
   * window is open, and links it funded that are still in the vault. Candidates come from the funding records by the
   * handle each link was sent to; one locked to another account (the handle changed hands) is left out, and so is a
   * token that is not on the network's list. An unreachable chain fails the whole network rather than guessing.
   */
  async pending(input: { network: StockNetworkId; wallet: string; accounts: VerifiedSocialAccount[]; limit?: number }) {
    const chain = STOCK_CHAINS[input.network];
    const wallet = getAddress(input.wallet);
    const limit = input.limit ?? PENDING_CLAIMS_LIMIT;
    const now = BigInt(Math.floor(this.now() / 1000));
    const vaultAccounts = input.accounts.filter((account): account is VerifiedSocialAccount & { platform: StockClaimPlatform } => isStockClaimPlatform(account.platform));
    const recipients = vaultAccounts.map(({ platform, username }) => ({ platform, username }));
    // The chain is read only once there is a record to read back.
    let client: Promise<Awaited<ReturnType<StockTransferService["verifiedClient"]>>> | undefined;
    const reads = new Map<string, Promise<EscrowPayment>>();
    const read = (record: StockClaimRecord) => {
      const key = `${record.escrow}:${record.paymentId}`;
      const known = reads.get(key);
      if (known) return known;
      client ??= this.options.transfers.verifiedClient(input.network);
      const payment = client.then((reader) => this.readPayment(reader, record.escrow, record.paymentId, chain.name));
      reads.set(key, payment);
      return payment;
    };
    const view = (record: StockClaimRecord, payment: EscrowPayment, status: PendingVaultLink["status"]): PendingVaultLink | undefined => {
      const token = robinhoodAsset(input.network, payment.token);
      if (!token || payment.amount === 0n) return undefined;
      const decimals = tokenDecimals(token);
      return {
        network: input.network,
        chainId: chain.id,
        chainName: chain.name,
        paymentId: record.paymentId,
        escrow: record.escrow,
        token: { symbol: token.symbol, name: token.name, address: token.address, kind: token.kind, decimals },
        amount: formatUnits(payment.amount, decimals),
        recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
        sender: { wallet: payment.payer, ...(record.sourcePlatform && record.sourceUsername ? { platform: record.sourcePlatform, username: record.sourceUsername } : {}) },
        expiresAt: new Date(Number(payment.expiry) * 1000).toISOString(),
        status,
        ...(status === "claimable" && !chain.testAssets && isStockToken(token) ? { statementRequired: true } : {}),
        claimPath: stockClaimPath(input.network, record.paymentId),
      };
    };
    return pagedPendingLinks({
      limit,
      waitingFor: (offset) => this.options.repository.waitingFor(chain.id, recipients, now, limit, offset),
      fundedBy: (offset) => this.options.repository.fundedBy(chain.id, wallet, limit, offset),
      check: async (waiting, funded) => ({
        incoming: (await Promise.all(waiting.map(async (record) => {
          const payment = await read(record);
          const open = payment.payer !== ZERO_ADDRESS && now <= payment.expiry;
          const mine = anyClaimsLink(vaultAccounts, payment.identityKey, stockClaimIdentityKey, linkMadeAt(record, payment.expiry, STOCK_CLAIM_MAX_WINDOW_SECONDS));
          return open && mine ? view(record, payment, "claimable") : undefined;
        }))).filter((link): link is PendingVaultLink => link !== undefined),
        outgoing: (await Promise.all(funded.map(async (record) => {
          const payment = await read(record);
          return payment.payer === wallet ? view(record, payment, now > payment.expiry ? "refundable" : "waiting") : undefined;
        }))).filter((link): link is PendingVaultLink => link !== undefined),
      }),
    });
  }

  private async activeEscrow(network: StockNetworkId) {
    const chainId = STOCK_CHAINS[network].id;
    const cached = this.activeEscrows.get(chainId);
    if (cached && this.now() - cached.readAt < this.cacheMs) return cached.record;
    const record = await this.options.repository.activeEscrow(chainId);
    this.activeEscrows.set(chainId, { record, readAt: this.now() });
    return record;
  }

  private async claimEscrow(network: StockNetworkId, paymentId: Hex) {
    const record = await this.options.repository.claim(STOCK_CHAINS[network].id, paymentId);
    const escrow = record?.escrow ?? (await this.activeEscrow(network))?.escrow;
    if (!escrow) throw new StockClaimNotFoundError();
    return { record, escrow };
  }

  /**
   * "code": the runtime code is the bundled StockClaimEscrow build at revision 2. "claim": also, the escrow's
   * verifier is this server's attestor. "funding": also, the operator still owns it, so new tokens go only to an
   * escrow whose verifier nobody else can replace.
   */
  private async verifyEscrow(
    network: StockNetworkId,
    client: StockChainClient,
    escrow: Address,
    check: EscrowCheck,
    options: { fresh?: boolean; fail?: (message: string) => Error } = {},
  ) {
    const chain = STOCK_CHAINS[network];
    const fail = options.fail ?? ((message: string) => new StockTransferUnavailableError(message));
    const key = `${chain.id}:${escrow}:${check}`;
    const verifiedAt = this.verifiedEscrows.get(key);
    if (!options.fresh && verifiedAt !== undefined && this.now() - verifiedAt < this.cacheMs) return;
    const unreachable = () => new StockTransferUnavailableError(`${chain.name} is not reachable right now. Try again shortly.`);
    let code: Hex | undefined;
    try {
      code = await client.getBytecode({ address: escrow });
    } catch {
      throw unreachable();
    }
    if (!code || code === "0x" || keccak256(code) !== STOCK_CLAIM_ESCROW_ARTIFACT.runtimeCodeHash) {
      throw fail(`The contract at ${escrow} on ${chain.name} is not the reviewed StockClaimEscrow build.`);
    }
    let revision: unknown, verifier: unknown, owner: unknown;
    try {
      [revision, verifier, owner] = await Promise.all([
        client.readContract({ address: escrow, abi: stockClaimEscrowAbi, functionName: "securityRevision" }),
        client.readContract({ address: escrow, abi: stockClaimEscrowAbi, functionName: "verifier" }),
        client.readContract({ address: escrow, abi: stockClaimEscrowAbi, functionName: "owner" }),
      ]);
    } catch {
      throw unreachable();
    }
    if (revision !== STOCK_CLAIM_ESCROW_REVISION) throw fail(`The ${chain.name} claim escrow must report security revision ${STOCK_CLAIM_ESCROW_REVISION}.`);
    const attestor = this.options.config.networks[network].attestor;
    if (check !== "code" && (typeof verifier !== "string" || !attestor || getAddress(verifier) !== getAddress(attestor.address))) {
      throw fail(`The ${chain.name} claim escrow's verifier is not this server's claim attestor.`);
    }
    if (check === "funding" && (typeof owner !== "string" || getAddress(owner) !== this.options.config.operator)) {
      throw fail(`The ${chain.name} claim escrow is not owned by the operator wallet set on this server.`);
    }
    this.verifiedEscrows.set(key, this.now());
  }

  /**
   * The escrow's fee router and burn vault, verified on chain by `verifyFeeContracts`: the bundled builds at their
   * reviewed revisions, a 1% fee split in half, both owned by the operator, and the operator as the treasury. Cached
   * like escrow checks.
   */
  private async escrowFees(
    network: StockNetworkId,
    escrow: Address,
    options: { fresh?: boolean; fail?: (message: string) => Error } = {},
  ): Promise<FeeSchedule> {
    const chain = STOCK_CHAINS[network];
    const fail = options.fail ?? ((message: string) => new StockTransferUnavailableError(message));
    const key = `${chain.id}:${escrow}`;
    const cached = this.verifiedFees.get(key);
    if (!options.fresh && cached && this.now() - cached.readAt < this.cacheMs) return cached.schedule;
    const operator = this.options.config.operator;
    if (!operator) throw fail(`This server needs its operator wallet before ${chain.name} payments can carry the fee.`);
    const client = await this.options.transfers.verifiedClient(network);
    const schedule = await verifyFeeContracts(client as FeeContractReader, {
      escrow,
      operator,
      sink: "burn_vault",
      chainName: chain.name,
      fail,
      unreachable: () => new StockTransferUnavailableError(`${chain.name} is not reachable right now. Try again shortly.`),
    });
    this.verifiedFees.set(key, { schedule, readAt: this.now() });
    return schedule;
  }

  /** For SP: how a recorded link ended and who claimed it, from its escrow and the receipts (`evmVaultSettlement`). */
  async settlement(network: StockNetworkId, record: StockClaimRecord, input: { claimTransaction?: Hex; candidates: readonly VaultClaimCandidate[] }): Promise<VaultSettlement> {
    const chain = STOCK_CHAINS[network];
    const client = await this.options.transfers.verifiedClient(network);
    const readReceipt = async (hash: Hex) => {
      if (this.options.transfers.readReceipt) return this.options.transfers.readReceipt(network, hash);
      return this.options.transfers.transactionReceipt(network, hash).catch(() => null);
    };
    return evmVaultSettlement({
      escrow: record.escrow,
      paymentId: record.paymentId,
      expiry: record.expiry,
      fundingTransaction: record.fundingTransactionHash,
      claimTransaction: input.claimTransaction,
      candidates: input.candidates,
      now: BigInt(Math.floor(this.now() / 1000)),
      readPayer: async () => (await this.readPayment(client, record.escrow, record.paymentId, chain.name)).payer,
      readReceipt,
      identityKeys: (account) => identityKeysOf(account, stockClaimIdentityKey),
    });
  }

  private async readPayment(client: StockChainClient, escrow: Address, paymentId: Hex, chainName: string): Promise<EscrowPayment> {
    let value: unknown;
    try {
      value = await client.readContract({ address: escrow, abi: stockClaimEscrowAbi, functionName: "payments", args: [paymentId] });
    } catch {
      throw new StockTransferUnavailableError(`${chainName} is not reachable right now. Try again shortly.`);
    }
    if (!Array.isArray(value) || value.length !== 6) throw new StockTransferUnavailableError(`${chainName} returned an unreadable claim.`);
    const [payer, token, identityKey, amount, fee, expiry] = value as [Address, Address, Hex, bigint, bigint, bigint];
    return { payer: getAddress(payer), token: getAddress(token), identityKey, amount, fee, expiry };
  }

  /** The account or name a link waits for (`vaultRecipient`); X's offer of a name lock reaches the slip as it is. */
  private async recipient(platform: StockClaimPlatform, username: string, lock?: VaultLock) {
    try {
      return await vaultRecipient(this.options.directory, platform, username, lock);
    } catch (error) {
      if (error instanceof VaultNameLockOffer) throw error;
      const message = error instanceof Error ? error.message : "The account could not be looked up.";
      // A missing or malformed handle is the sender's to fix; provider outages and missing lookup keys are not.
      if (/not found|invalid/i.test(message)) throw new StockTransferRejectedError(message);
      // The directory's own words for a refused, limited or unreachable lookup; anything else is never shown as it is.
      throw new StockTransferUnavailableError(error instanceof RecipientLookupUnavailableError ? message : "The account could not be looked up just now. Try again in a moment.");
    }
  }

  private async preflight(
    client: StockChainClient,
    input: { wallet: Address; escrow: Address; data: Hex; symbol: string; chainName: string; action: "claim" | "refund"; decimals: number },
  ) {
    try {
      await client.call({ account: input.wallet, to: input.escrow, data: input.data });
    } catch (error) {
      if (!isRevert(error)) throw new StockTransferUnavailableError(`${input.chainName} is not reachable right now. Try again shortly.`);
      throw new StockTransferRejectedError(claimRejection(error, {
        symbol: input.symbol, wallet: input.wallet, escrow: input.escrow, action: input.action, decimals: input.decimals,
      }));
    }
  }
}

/** keccak256(abi.encode(keccak256(platform), keccak256(providerUserId))), exactly as the escrow derives it. */
export function stockClaimIdentityKey(platform: StockClaimPlatform, providerUserId: string) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, bytes32"),
    [stockClaimPlatformHash(platform), keccak256(stringToHex(providerUserId))],
  )).toLowerCase() as Hex;
}

const claimRevertAbi = [...stockClaimEscrowAbi, ...stockTokenTransferAbi];

/** A readable reason for an escrow call or funding transfer the chain would reject. */
export function claimRejection(error: unknown, context: {
  symbol: string;
  wallet: Address;
  escrow: Address;
  action: "fund" | "claim" | "refund";
  decimals?: number;
  amount?: string;
}) {
  const { symbol, action } = context;
  const decimals = context.decimals ?? 18;
  const data = revertData(error);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: claimRevertAbi, data });
      switch (decoded.errorName) {
        case "IsPaused":
          return `${symbol} transfers are paused by the issuer right now, for example during a corporate action. Try again later.`;
        case "ContractPaused":
          return `${symbol} transfers are paused by the issuer right now. Try again later.`;
        case "AddressFrozen":
          return action === "fund"
            ? `The issuer has frozen ${symbol} for your wallet or for the claim escrow.`
            : `The issuer has frozen ${symbol} for your wallet or for the claim escrow, so the escrow cannot pay it out now.`;
        case "InsufficientFunds":
          return `Your wallet holds less than ${context.amount ? `${context.amount} ` : "the amount of "}${symbol} this vault link needs.`;
        case "Blocked": {
          const [account] = decoded.args as readonly [Address];
          if (getAddress(account) === getAddress(context.escrow)) return `The issuer's compliance list blocks ${symbol} transfers ${action === "fund" ? "to" : "from"} the claim escrow.`;
          if (getAddress(account) === getAddress(context.wallet)) return `The issuer's compliance list blocks ${symbol} transfers ${action === "fund" ? "from" : "to"} your wallet.`;
          return `The issuer's compliance list blocks this ${symbol} transfer.`;
        }
        case "ERC20InsufficientBalance": {
          const [, balance, needed] = decoded.args as readonly [Address, bigint, bigint];
          return `Your wallet holds ${formatUnits(balance, decimals)} ${symbol}; this claim link needs ${formatUnits(needed, decimals)} ${symbol}.`;
        }
        case "ClaimExpired":
          return "The claim window has closed. The sender can take the tokens back.";
        case "InvalidClaim":
          return "The claim authorization was not accepted. Reload the page and try again.";
        case "PaymentUnavailable":
          return "This claim link was already claimed or refunded.";
        case "RefundNotReady":
          return "The tokens can be taken back only after the claim window closes.";
        case "NotPayer":
          return "Only the wallet that funded this claim link can take it back.";
        case "TransferFailed":
        case "TransferAmountMismatch":
          return `The ${symbol} contract did not deliver the exact amount, so nothing moved.`;
      }
    } catch {
      // Unknown revert data falls through to the generic message.
    }
  }
  return action === "fund"
    ? `The ${symbol} contract would reject this transfer, so your wallet was not opened.`
    : `The escrow would reject this ${action}, so your wallet was not opened.`;
}

function validPaymentId(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new StockTransferRejectedError("Invalid claim payment ID.");
  return value.toLowerCase() as Hex;
}

function actionResponse(network: StockNetworkId, escrow: Address, paymentId: Hex, token: StockTokenListing, amount: bigint, wallet: Address, data: Hex) {
  const chain = STOCK_CHAINS[network];
  return {
    networkId: network,
    chainId: chain.id,
    chainIdHex: `0x${chain.id.toString(16)}` as `0x${string}`,
    chainName: chain.name,
    rpcUrl: chain.rpcUrl,
    explorerUrl: chain.explorerUrl,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    paymentId,
    escrow,
    token: { symbol: token.symbol, name: token.name, address: token.address },
    amount: formatUnits(amount, tokenDecimals(token)),
    transaction: { from: wallet, to: escrow, data, value: "0x0" as const },
  };
}

function publicClaim(record: StockClaimRecord, network: StockNetworkId) {
  return {
    status: "funded" as const,
    network,
    chainId: record.chainId,
    paymentId: record.paymentId,
    escrow: record.escrow,
    transactionHash: record.fundingTransactionHash,
    payer: record.payer,
    recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
    token: { symbol: record.tokenSymbol, address: record.tokenAddress },
    amount: record.amount,
    expiresAt: new Date(Number(record.expiry) * 1000).toISOString(),
    blockNumber: record.blockNumber.toString(),
    confirmedAt: record.confirmedAt,
    claimPath: stockClaimPath(network, record.paymentId),
    ...(record.sourcePlatform && record.sourceUsername ? { sourceIdentity: { platform: record.sourcePlatform, username: record.sourceUsername } } : {}),
  };
}

function timestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function rowToEscrow(row: Record<string, unknown>): StockClaimEscrowRecord {
  return {
    chainId: Number(row.chain_id),
    escrow: getAddress(String(row.escrow_address)),
    deploymentTransactionHash: String(row.deployment_transaction_hash) as Hex,
    owner: getAddress(String(row.owner_address)),
    verifier: getAddress(String(row.verifier_address)),
    blockNumber: BigInt(String(row.block_number)),
    registeredAt: timestamp(row.registered_at),
  };
}

function rowToClaim(row: Record<string, unknown>): StockClaimRecord {
  const record: StockClaimRecord = {
    chainId: Number(row.chain_id),
    paymentId: String(row.payment_id) as Hex,
    escrow: getAddress(String(row.escrow_address)),
    fundingTransactionHash: String(row.funding_transaction_hash) as Hex,
    tokenAddress: getAddress(String(row.token_address)),
    tokenSymbol: String(row.token_symbol),
    payer: getAddress(String(row.payer_address)),
    recipientPlatform: String(row.recipient_platform) as StockClaimPlatform,
    recipientUsername: String(row.recipient_username_normalized),
    amount: String(row.amount_text),
    units: BigInt(String(row.units_text)),
    expiry: BigInt(String(row.expiry)),
    blockNumber: BigInt(String(row.block_number)),
    confirmedAt: timestamp(row.confirmed_at),
  };
  if (row.source_platform && row.source_username_normalized) {
    record.sourcePlatform = String(row.source_platform) as Platform;
    record.sourceUsername = String(row.source_username_normalized);
  }
  return record;
}
