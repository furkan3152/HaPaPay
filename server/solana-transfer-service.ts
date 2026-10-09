import {
  address,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isAddress,
  isSignature,
  signature as toSignature,
  type Address as SolanaAddress,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { getMintDecoder } from "@solana-program/token-2022";
import type { Address } from "viem";
import { PAYMENT_NOTE_PREFIX } from "../src/domain/payment-note.js";
import { countedUiAmount, effectiveMultiplier, multiplierChangesSoon, recordedUiAmount, SOLANA_FEE_BPS, solanaFee, uiAmountToUnits, unitsToUiAmount, type ScaledUiAmount } from "../src/domain/solana-amounts.js";
import { NO_SOL_SENDING, isSolanaStock, SOLANA_SOL, SOLANA_TOKEN_PROGRAM_ADDRESSES, type SolanaAssetListing } from "../src/domain/solana-assets.js";
import { SOL_DECIMALS, SOLANA_MAINNET } from "../src/domain/solana-chains.js";
import { solanaAssetByMint } from "../src/domain/solana-stocks.js";
import { SOLANA_TRANSACTION_EXPIRED } from "../src/domain/transaction-receipt.js";
import {
  buildSolanaTransfer,
  solanaTransferFee,
  SOLANA_MAX_COMPUTE_UNIT_PRICE,
  SOLANA_MAX_COMPUTE_UNITS,
  SOLANA_TRANSACTION_MAX_BYTES,
  type PreparedSolanaTransaction,
  type PreparedSolanaTransfer,
  type SolanaTransferPlan,
} from "../src/domain/solana-transfers.js";
import type { SolanaConfig, SolanaRpc, SolanaSwitch } from "./solana-network.js";

type SqlResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type SqlPool = { query(text: string, values?: unknown[]): Promise<SqlResult> };

/** A refusal the person can act on (balance, pause, a scheduled multiplier change). Answered as 400 with its message. */
export class SolanaTransferError extends Error {}
/** Solana could not be read just now. Answered as 503; nothing was prepared or recorded. */
export class SolanaUnavailableError extends Error {}
export class DuplicateSolanaTransferError extends Error {}
/** The transaction's blockhash ran out before it landed, so it never will and nothing moved. Answered as 410. */
export class SolanaTransactionExpiredError extends Error {
  constructor() {
    super(SOLANA_TRANSACTION_EXPIRED);
  }
}

export type SolanaTransferRecord = {
  signature: string;
  paymentIndex: number;
  mint: string;
  tokenSymbol: string;
  senderWallet: Address;
  senderAddress: string;
  recipientWallet: Address;
  recipientAddress: string;
  platform: string;
  username: string;
  amount: string;
  units: string;
  feeUnits: string;
  note?: string;
  slot: bigint;
  confirmedAt: string;
  sourcePlatform?: string;
  sourceUsername?: string;
};

export interface SolanaTransferRepository {
  save(records: readonly SolanaTransferRecord[]): Promise<void>;
  list(wallet: Address): Promise<SolanaTransferRecord[]>;
}

/** The mint SOL is recorded under, so every row names what moved. */
export const NATIVE_SOL_MINT = "native";

export class MemorySolanaTransferRepository implements SolanaTransferRepository {
  private readonly records = new Map<string, SolanaTransferRecord>();

  async save(records: readonly SolanaTransferRecord[]) {
    if (records.some((record) => this.records.has(`${record.signature}:${record.paymentIndex}`))) {
      throw new DuplicateSolanaTransferError("This Solana transaction is already recorded.");
    }
    for (const record of records) this.records.set(`${record.signature}:${record.paymentIndex}`, record);
  }

  async list(wallet: Address) {
    return [...this.records.values()]
      .filter((record) => record.senderWallet === wallet || record.recipientWallet === wallet)
      .sort((left, right) => Number(right.slot - left.slot) || left.paymentIndex - right.paymentIndex);
  }
}

export class PostgresSolanaTransferRepository implements SolanaTransferRepository {
  constructor(private readonly pool: SqlPool) {}

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS solana_transfers (
        signature TEXT NOT NULL,
        payment_index INTEGER NOT NULL,
        mint TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        sender_wallet TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        recipient_wallet TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        platform TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        amount_text TEXT NOT NULL,
        units_text TEXT NOT NULL,
        fee_units_text TEXT NOT NULL,
        note TEXT,
        slot BIGINT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL,
        source_platform TEXT,
        source_username_normalized TEXT,
        PRIMARY KEY (signature, payment_index)
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS solana_transfers_sender_idx ON solana_transfers (sender_wallet, slot DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS solana_transfers_recipient_idx ON solana_transfers (recipient_wallet, slot DESC)");
  }

  async save(records: readonly SolanaTransferRecord[]) {
    if (records.length === 0) return;
    const values: unknown[] = [];
    const rows = records.map((record, index) => {
      values.push(
        record.signature, record.paymentIndex, record.mint, record.tokenSymbol, record.senderWallet, record.senderAddress,
        record.recipientWallet, record.recipientAddress, record.platform, record.username, record.amount, record.units,
        record.feeUnits, record.note ?? null, record.slot.toString(), record.confirmedAt, record.sourcePlatform ?? null, record.sourceUsername ?? null,
      );
      const base = index * 18;
      return `(${Array.from({ length: 18 }, (_, column) => `$${base + column + 1}`).join(", ")})`;
    });
    try {
      await this.pool.query(
        `INSERT INTO solana_transfers (signature, payment_index, mint, token_symbol, sender_wallet, sender_address, recipient_wallet,
           recipient_address, platform, username_normalized, amount_text, units_text, fee_units_text, note, slot, confirmed_at,
           source_platform, source_username_normalized)
         VALUES ${rows.join(", ")}`,
        values,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DuplicateSolanaTransferError("This Solana transaction is already recorded.");
      throw error;
    }
  }

  async list(wallet: Address) {
    const result = await this.pool.query(
      `SELECT * FROM solana_transfers WHERE sender_wallet = $1 OR recipient_wallet = $1 ORDER BY slot DESC, payment_index ASC LIMIT 200`,
      [wallet],
    );
    return result.rows.map((row) => ({
      signature: String(row.signature),
      paymentIndex: Number(row.payment_index),
      mint: String(row.mint),
      tokenSymbol: String(row.token_symbol),
      senderWallet: String(row.sender_wallet) as Address,
      senderAddress: String(row.sender_address),
      recipientWallet: String(row.recipient_wallet) as Address,
      recipientAddress: String(row.recipient_address),
      platform: String(row.platform),
      username: String(row.username_normalized),
      amount: String(row.amount_text),
      units: String(row.units_text),
      feeUnits: String(row.fee_units_text),
      note: row.note === null || row.note === undefined ? undefined : String(row.note),
      slot: BigInt(String(row.slot)),
      confirmedAt: new Date(String(row.confirmed_at)).toISOString(),
      sourcePlatform: row.source_platform ? String(row.source_platform) : undefined,
      sourceUsername: row.source_username_normalized ? String(row.source_username_normalized) : undefined,
    }));
  }
}

/** SOL and the listed assets a Solana address holds, as a wallet shows them. */
export type SolanaHoldings = { sol: string; tokens: Array<{ symbol: string; name: string; mint: string; amount: string }> };

/** What a mint says on chain right now: whether transfers are paused, a transfer fee, a hook, and the multiplier. */
export type SolanaMintState = { paused: boolean; transferFeeBps: number; hook: boolean; scaled?: ScaledUiAmount; decimals: number };

/** The payment as the review fixed it: the person, their Solana address, and the amount as a wallet shows it. */
/** One payment of a request: the recipient's Solana address, the amount, and how messages name them ("@nora"). */
export type SolanaPaymentInput = { recipient: string; amount: string; label?: string };

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** The priority price floor: low enough to cost a fraction of a cent, high enough to land when the network is busy. */
const MIN_COMPUTE_UNIT_PRICE = 1_000n;

/**
 * Solana transfers of USDC, USDG and xStocks, prepared from the review and verified from the chain. The server
 * builds unsigned transactions only; the person's wallet signs and sends them, and the browser checks every byte
 * before it opens the wallet. A transfer is recorded only after its confirmed transaction shows the exact amounts
 * at the reviewed addresses, the fee at the treasury and the reviewed note.
 */
export class SolanaTransferService {
  private readonly now: () => Date;

  constructor(private readonly options: {
    config: SolanaConfig;
    rpc: SolanaRpc;
    repository: SolanaTransferRepository;
    now?: () => Date;
    confirmAttempts?: number;
    confirmRetryMs?: number;
    /** The cluster the RPC must serve; Solana mainnet's genesis hash unless a test runs its own validator. */
    genesisHash?: string;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  private cluster?: Promise<string>;

  /**
   * Refuses to prepare or record anything through an RPC of another cluster (a devnet URL set by mistake), as the EVM
   * networks check their chain ID. A mainnet answer is kept; a failed read is asked again on the next request.
   */
  async onMainnet() {
    this.cluster ??= this.options.rpc.getGenesisHash().send().then(String, (error: unknown) => {
      this.cluster = undefined;
      throw error;
    });
    let hash: string;
    try {
      hash = await this.cluster;
    } catch (error) {
      this.unavailable(error);
    }
    if (hash !== (this.options.genesisHash ?? SOLANA_MAINNET.genesisHash)) {
      throw new SolanaUnavailableError("The Solana RPC set on this server is not Solana mainnet, so nothing was prepared or recorded.");
    }
  }

  get treasury() {
    return this.options.config.treasury;
  }

  /** Whether this asset can move on this server: USDC and USDG under one switch, xStocks under their own. */
  availability(asset: Pick<SolanaAssetListing, "kind">): SolanaSwitch {
    return isSolanaStock(asset) ? this.options.config.stocks : this.options.config.transfers;
  }

  private unavailable(error: unknown): never {
    if (error instanceof SolanaTransferError || error instanceof SolanaUnavailableError) throw error;
    throw new SolanaUnavailableError("Solana could not be read just now. Try again in a moment.");
  }

  /** Reads a mint and refuses one whose transfers would not move exactly what the review shows. */
  async mintState(asset: SolanaAssetListing): Promise<SolanaMintState> {
    if (!asset.mint) return { paused: false, transferFeeBps: 0, hook: false, decimals: SOL_DECIMALS };
    let account;
    try {
      account = await this.options.rpc.getAccountInfo(address(asset.mint), { encoding: "base64", commitment: "confirmed" }).send();
    } catch (error) {
      this.unavailable(error);
    }
    const value = account.value;
    if (!value || value.owner !== SOLANA_TOKEN_PROGRAM_ADDRESSES[asset.program ?? "token"]) {
      throw new SolanaTransferError(`${asset.symbol} is not the token HaPaPay lists on Solana right now, so nothing was prepared.`);
    }
    const mint = getMintDecoder().decode(getBase64Encoder().encode(value.data[0]));
    if (mint.decimals !== asset.decimals) throw new SolanaTransferError(`${asset.symbol} changed its decimals on chain, so nothing was prepared.`);
    const state: SolanaMintState = { paused: false, transferFeeBps: 0, hook: false, decimals: mint.decimals };
    const extensions = mint.extensions.__option === "Some" ? mint.extensions.value : [];
    for (const extension of extensions) {
      if (extension.__kind === "PausableConfig") state.paused = extension.paused;
      if (extension.__kind === "TransferFeeConfig") {
        state.transferFeeBps = Math.max(Number(extension.olderTransferFee.transferFeeBasisPoints), Number(extension.newerTransferFee.transferFeeBasisPoints));
      }
      if (extension.__kind === "TransferHook" && extension.programId !== SYSTEM_PROGRAM) state.hook = true;
      if (extension.__kind === "ScaledUiAmountConfig") {
        state.scaled = { multiplier: extension.multiplier, newMultiplier: extension.newMultiplier, newMultiplierEffectiveTimestamp: BigInt(extension.newMultiplierEffectiveTimestamp) };
      }
    }
    return state;
  }

  /** Refuses a paused mint, a transfer fee, a transfer hook, or a multiplier change due within ten minutes. */
  checkMint(asset: SolanaAssetListing, state: SolanaMintState, unixSeconds: bigint) {
    if (state.paused) throw new SolanaTransferError(`The issuer has paused ${asset.symbol} transfers on Solana. Nothing was prepared.`);
    if (state.transferFeeBps > 0) throw new SolanaTransferError(`${asset.symbol} now charges a transfer fee on Solana, so the recipient would not get the full amount. Nothing was prepared.`);
    if (state.hook) throw new SolanaTransferError(`${asset.symbol} now runs extra checks on every transfer, which HaPaPay does not support yet. Nothing was prepared.`);
    if (multiplierChangesSoon(state.scaled, unixSeconds)) {
      const at = new Date(Number(state.scaled!.newMultiplierEffectiveTimestamp) * 1000).toISOString().slice(11, 16);
      throw new SolanaTransferError(`${asset.symbol}'s balance multiplier changes at ${at} UTC, which would change the amount. Try again after that.`);
    }
  }

  /** The raw units for each payment, converted from what a wallet shows with the mint's effective multiplier. */
  units(asset: SolanaAssetListing, amount: string, state: SolanaMintState, unixSeconds: bigint) {
    const multiplier = asset.scaled ? effectiveMultiplier(state.scaled, unixSeconds) : 1;
    const units = uiAmountToUnits(amount, asset.decimals, multiplier);
    if (units <= 0n) throw new SolanaTransferError("The amount is too small to send.");
    return { units, multiplier };
  }

  private async tokenAccount(owner: string, asset: SolanaAssetListing) {
    const [account] = await findAssociatedTokenPda({ owner: address(owner), mint: address(asset.mint!), tokenProgram: address(SOLANA_TOKEN_PROGRAM_ADDRESSES[asset.program ?? "token"]) });
    return account;
  }

  /** The wallet's SOL (lamports) and its balance of the asset in raw units. */
  async balances(sender: string, asset: SolanaAssetListing) {
    try {
      const lamports = (await this.options.rpc.getBalance(address(sender), { commitment: "confirmed" }).send()).value;
      if (!asset.mint) return { lamports, units: lamports };
      const account = await this.tokenAccount(sender, asset);
      const info = await this.options.rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send();
      if (!info.value) return { lamports, units: 0n };
      const balance = await this.options.rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send();
      return { lamports, units: BigInt(balance.value.amount) };
    } catch (error) {
      this.unavailable(error);
    }
  }

  /**
   * How much of a listed asset a Solana address holds, as a wallet shows it (raw units × the mint's multiplier in
   * effect), for the chat's choice of network. Undefined when Solana cannot be read. It is
   * never a permission: preparation reads the balance again, and the wallet signs.
   */
  async holding(owner: string, asset: SolanaAssetListing): Promise<string | undefined> {
    try {
      await this.onMainnet();
      const unixSeconds = BigInt(Math.floor(this.now().getTime() / 1000));
      const [state, { units }] = await Promise.all([asset.scaled ? this.mintState(asset) : undefined, this.balances(owner, asset)]);
      return unitsToUiAmount(units, asset.decimals, asset.scaled ? effectiveMultiplier(state?.scaled, unixSeconds) : 1);
    } catch {
      return undefined;
    }
  }

  /**
   * What a Solana address holds of SOL and of every listed asset, as a wallet shows it, for an account's view of its
   * own Solana address. Mints HaPaPay
   * does not list are left out; a listed xStock whose multiplier cannot be read just now is shown at a multiplier
   * of 1 rather than left out, so an address holding it never reads as empty (audit, 2026-10-06: the desk then
   * replaced a funded address). Undefined when Solana cannot be read.
   */
  async holdings(owner: string): Promise<SolanaHoldings | undefined> {
    try {
      await this.onMainnet();
      const unixSeconds = BigInt(Math.floor(this.now().getTime() / 1000));
      const [balance, ...programs] = await Promise.all([
        this.options.rpc.getBalance(address(owner), { commitment: "confirmed" }).send(),
        ...[...new Set(Object.values(SOLANA_TOKEN_PROGRAM_ADDRESSES))].map((program) =>
          this.options.rpc.getTokenAccountsByOwner(address(owner), { programId: address(program) }, { encoding: "jsonParsed", commitment: "confirmed" }).send()),
      ]);
      const units = new Map<string, bigint>();
      for (const { account } of programs.flatMap((accounts) => accounts.value)) {
        const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info;
        if (!info?.mint || !info.tokenAmount?.amount) continue;
        units.set(info.mint, (units.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
      const listed = [...units].flatMap(([mint, held]) => {
        const asset = solanaAssetByMint(mint);
        return asset && held > 0n ? [{ asset, mint, held }] : [];
      });
      const tokens = await Promise.all(listed.map(async ({ asset, mint, held }) => {
        const state = asset.scaled ? await this.mintState(asset).catch(() => undefined) : undefined;
        return { symbol: asset.symbol, name: asset.name, mint, amount: unitsToUiAmount(held, asset.decimals, state ? effectiveMultiplier(state.scaled, unixSeconds) : 1) };
      }));
      return { sol: unitsToUiAmount(balance.value, SOL_DECIMALS, 1), tokens };
    } catch {
      return undefined;
    }
  }

  /** The priority price for transactions writing these accounts: the recent 75th percentile, within bounds. */
  async computePrice(accounts: readonly SolanaAddress[]) {
    try {
      const fees = await this.options.rpc.getRecentPrioritizationFees(accounts.slice(0, 128)).send();
      const values = fees.map(({ prioritizationFee }) => BigInt(prioritizationFee)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const p75 = values.length ? values[Math.floor(values.length * 0.75)] : 0n;
      const price = p75 < MIN_COMPUTE_UNIT_PRICE ? MIN_COMPUTE_UNIT_PRICE : p75;
      return price > SOLANA_MAX_COMPUTE_UNIT_PRICE / 2n ? SOLANA_MAX_COMPUTE_UNIT_PRICE / 2n : price;
    } catch {
      return MIN_COMPUTE_UNIT_PRICE;
    }
  }

  /** Splits the payments into as few transactions as fit Solana's size limit, in order. */
  private async chunks(plan: Omit<SolanaTransferPlan, "payments">, payments: SolanaTransferPlan["payments"]) {
    const groups: number[][] = [];
    let start = 0;
    while (start < payments.length) {
      let end = payments.length;
      while (end > start) {
        const built = await buildSolanaTransfer({ ...plan, payments: payments.slice(start, end) });
        if (built.size <= SOLANA_TRANSACTION_MAX_BYTES) break;
        end -= 1;
      }
      if (end === start) throw new SolanaTransferError("The note is too long to fit in a Solana transaction with this payment. Shorten it and review again.");
      groups.push(Array.from({ length: end - start }, (_, offset) => start + offset));
      start = end;
    }
    return groups;
  }

  private simulationError(asset: SolanaAssetListing, logs: readonly string[] | null | undefined, err: unknown) {
    const text = `${(logs ?? []).join("\n")}\n${JSON.stringify(err ?? "", (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`;
    // An account Solana would leave below its minimum balance: the sender's own (account 0), or a new wallet that SOL
    // would open (audit, 2026-10-06: the second was blamed on the sender, who could not fix it).
    if (/InsufficientFundsForRent/.test(text)) {
      const account = Number(/InsufficientFundsForRent[^0-9]*(\d+)/.exec(text)?.[1] ?? "0");
      if (account === 0) return new SolanaTransferError("These payments would leave your Solana wallet below the small balance Solana keeps in every wallet. Add a little SOL and review again.");
      if (!asset.mint) return new SolanaTransferError("A recipient's Solana wallet is new, and Solana opens a wallet only with at least its minimum balance (about 0.00089 SOL). Send at least that much.");
    }
    if (/insufficient funds|insufficient lamports|InsufficientFunds/i.test(text)) {
      return new SolanaTransferError(`Your wallet does not hold enough ${asset.mint ? `${asset.symbol} or SOL for the network fee` : "SOL"} for these payments.`);
    }
    if (/AccountNotFound|no record of a prior credit/i.test(text)) {
      return new SolanaTransferError("Your Solana wallet needs a little SOL for the network fee before it can send.");
    }
    return new SolanaTransferError(`Solana would refuse these ${asset.symbol} payments right now. Nothing was prepared.`);
  }

  /**
   * Prepares the transactions for one reviewed request: each payment's units, one fee of 1% per payment to the
   * treasury, the note as a memo, a simulation of every transaction from the sender, and the compute limit measured
   * from it. Refuses a short balance, a paused or changed mint, and an unavailable asset before the wallet opens.
   */
  async prepare(input: { sender: string; asset: SolanaAssetListing; payments: readonly SolanaPaymentInput[]; note?: string }): Promise<PreparedSolanaTransfer> {
    const { asset } = input;
    // HaPaPay does not send SOL; records of SOL sent before then are still read.
    if (asset.kind === "native") throw new SolanaTransferError(NO_SOL_SENDING);
    const switchState = this.availability(asset);
    if (!switchState.enabled) throw new SolanaTransferError(switchState.reason ?? "Solana transfers are not available on this server.");
    const treasury = this.options.config.treasury;
    if (!treasury) throw new SolanaTransferError("The Solana fee treasury is not set on this server.");
    if (!isAddress(input.sender)) throw new SolanaTransferError("Add a Solana address to your wallet before sending on Solana.");
    if (input.payments.length === 0) throw new SolanaTransferError("Name who receives it.");
    await this.onMainnet();
    const recipients = new Set<string>();
    for (const payment of input.payments) {
      if (!isAddress(payment.recipient)) throw new SolanaTransferError("A recipient has no Solana address.");
      if (payment.recipient === input.sender) throw new SolanaTransferError("You cannot pay your own Solana address.");
      if (payment.recipient === treasury) throw new SolanaTransferError("A recipient's Solana address is the fee treasury, which cannot be paid directly.");
      if (recipients.has(payment.recipient)) throw new SolanaTransferError("A Solana address appears twice in these payments. Review them again.");
      recipients.add(payment.recipient);
    }
    const unixSeconds = BigInt(Math.floor(this.now().getTime() / 1000));
    const state = await this.mintState(asset);
    this.checkMint(asset, state, unixSeconds);
    const converted = input.payments.map((payment) => ({ recipient: payment.recipient, ...this.units(asset, payment.amount, state, unixSeconds) }));
    const multiplier = converted[0]?.multiplier ?? 1;
    const payments = converted.map(({ recipient, units }) => ({ recipient, units }));
    const totalUnits = payments.reduce((sum, payment) => sum + payment.units, 0n);
    const feeUnits = solanaTransferFee(payments);
    const balance = await this.balances(input.sender, asset);
    if (balance.units < totalUnits + feeUnits) {
      const need = unitsToUiAmount(totalUnits + feeUnits, asset.decimals, multiplier);
      const have = unitsToUiAmount(balance.units, asset.decimals, multiplier);
      throw new SolanaTransferError(`Your Solana wallet holds ${have} ${asset.symbol}; these payments need ${need} ${asset.symbol}, the amounts plus the 1% fee.`);
    }
    const minimum = await this.minimumBalance();

    let blockhash: { blockhash: string; lastValidBlockHeight: bigint };
    try {
      blockhash = (await this.options.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    } catch (error) {
      this.unavailable(error);
    }
    const writable = [address(input.sender), ...payments.map(({ recipient }) => address(recipient)), address(treasury)];
    const computeUnitPrice = await this.computePrice(writable);
    const base = { sender: input.sender, asset, treasury, note: input.note, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS, computeUnitPrice };
    const groups = await this.chunks(base, payments);
    const transactions: PreparedSolanaTransaction[] = [];
    let networkFee = 0n;
    for (const group of groups) {
      const groupPayments = group.map((index) => payments[index]);
      const trial = await buildSolanaTransfer({ ...base, payments: groupPayments });
      let simulation;
      try {
        simulation = (await this.options.rpc.simulateTransaction(trial.transaction as Base64EncodedWireTransaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }).send()).value;
      } catch (error) {
        this.unavailable(error);
      }
      if (simulation.err) throw this.simulationError(asset, simulation.logs, simulation.err);
      const consumed = Number(simulation.unitsConsumed ?? BigInt(SOLANA_MAX_COMPUTE_UNITS));
      const limit = Math.min(SOLANA_MAX_COMPUTE_UNITS, Math.ceil(consumed * 1.15) + 2_000);
      const built = await buildSolanaTransfer({ ...base, payments: groupPayments, computeUnitLimit: limit });
      networkFee += SIGNATURE_FEE_LAMPORTS + (BigInt(limit) * computeUnitPrice + 999_999n) / 1_000_000n;
      transactions.push({
        transaction: built.transaction,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
        computeUnitLimit: limit,
        computeUnitPrice: computeUnitPrice.toString(),
        payments: group,
      });
    }

    const opened = await this.newAccounts(asset, [...payments.map(({ recipient }) => recipient), ...(feeUnits > 0n ? [treasury] : [])]);
    // Each transaction was simulated from the same starting balance, so the SOL the whole request spends is checked
    // once here: the network fees and the accounts it opens, leaving the sender either nothing or Solana's minimum
    // balance (audit, 2026-10-06: a request split in two was prepared although only the first could pay its rent, so
    // the second failed after the first had paid).
    const spent = networkFee + opened.rent;
    const left = balance.lamports - spent;
    if (left < 0n || (left > 0n && left < minimum)) {
      const parts = ["the network fee"];
      if (opened.count) parts.push(`${opened.count === 1 ? "an account" : `${opened.count} accounts`} for ${asset.symbol} it opens for people who hold none yet`);
      throw new SolanaTransferError(`Your Solana wallet holds ${unitsToUiAmount(balance.lamports, SOL_DECIMALS, 1)} SOL; ${transactions.length > 1 ? "these payments need" : "this needs"} about ${unitsToUiAmount(spent + minimum, SOL_DECIMALS, 1)} SOL: ${parts.join(", and ")}, and the small balance Solana keeps in every wallet.`);
    }
    return {
      network: SOLANA_MAINNET.id,
      asset: { symbol: asset.symbol, mint: asset.mint, decimals: asset.decimals, program: asset.program, scaled: asset.scaled },
      sender: input.sender,
      treasury,
      feeBps: Number(SOLANA_FEE_BPS),
      payments: payments.map((payment, index) => ({ recipient: payment.recipient, units: payment.units.toString(), amount: input.payments[index].amount })),
      transactions,
      ...(asset.scaled ? { multiplier } : {}),
      newAccounts: opened.count,
      rentLamports: opened.rent.toString(),
      networkFeeLamports: networkFee.toString(),
      totalUnits: totalUnits.toString(),
      feeUnits: feeUnits.toString(),
    };
  }

  /** The least SOL an account may hold without being emptied: Solana's minimum balance for an account with no data. */
  private async minimumBalance() {
    try {
      return BigInt(await this.options.rpc.getMinimumBalanceForRentExemption(0n).send());
    } catch (error) {
      this.unavailable(error);
    }
  }

  /** How many of these owners have no token account for the asset yet, and the rent the sender pays to open them. */
  private async newAccounts(asset: SolanaAssetListing, owners: readonly string[]) {
    try {
      const accounts = await Promise.all([...new Set(owners)].map((owner) => this.tokenAccount(owner, asset)));
      const found = await this.options.rpc.getMultipleAccounts(accounts, { encoding: "base64", commitment: "confirmed" }).send();
      const count = found.value.filter((account) => !account).length;
      if (count === 0) return { count, rent: 0n };
      const size = asset.program === "token-2022" ? 182n : 165n;
      const rent = await this.options.rpc.getMinimumBalanceForRentExemption(size).send();
      return { count, rent: BigInt(rent) * BigInt(count) };
    } catch {
      return { count: 0, rent: 0n };
    }
  }

  /**
   * Whether a signature has landed: "0x1" once confirmed without an error, "0x0" when it failed, undefined while it
   * is not seen yet. The browser's receipt wait reads this through the server, as for the other networks.
   */
  /**
   * Whether a transaction Solana has no status for can never land: every block its blockhash allowed is final without
   * it (audit, 2026-10-06: a dropped transaction kept its slip on "Verify again" for good). A read that fails says no.
   */
  async expired(signatureText: string, lastValidBlockHeight: bigint) {
    if (!isSignature(signatureText)) return false;
    try {
      await this.onMainnet();
      const statuses = await this.options.rpc.getSignatureStatuses([toSignature(signatureText)], { searchTransactionHistory: true }).send();
      if (statuses.value[0]) return false;
      return BigInt(await this.options.rpc.getBlockHeight({ commitment: "finalized" }).send()) > lastValidBlockHeight;
    } catch {
      return false;
    }
  }

  async status(signatureText: string) {
    if (!isSignature(signatureText)) return undefined;
    await this.onMainnet();
    try {
      const statuses = await this.options.rpc.getSignatureStatuses([toSignature(signatureText)], { searchTransactionHistory: true }).send();
      const status = statuses.value[0];
      if (!status || !status.confirmationStatus || status.confirmationStatus === "processed") return undefined;
      return { status: status.err ? "0x0" as const : "0x1" as const, slot: status.slot };
    } catch (error) {
      this.unavailable(error);
    }
  }

  /**
   * Records a confirmed transaction after reading it from chain: no error, the reviewed sender paid for it, every
   * reviewed address received exactly its units of the asset, the treasury received exactly the fee, and the memo is
   * exactly the reviewed note (or there is none). One row per payment; a transaction is recorded once.
   */
  async confirm(input: {
    signature: string;
    asset: SolanaAssetListing;
    sender: { wallet: Address; address: string };
    payments: ReadonlyArray<{ recipientWallet: Address; recipientAddress: string; platform: string; username: string; amount: string; units: string }>;
    note?: string;
    source?: { platform: string; username: string };
    /** The prepared transaction's, so one that can no longer land is told apart from one not confirmed yet. */
    lastValidBlockHeight?: bigint;
  }) {
    if (!isSignature(input.signature)) throw new SolanaTransferError("This is not a Solana transaction signature.");
    const treasury = this.options.config.treasury;
    if (!treasury) throw new SolanaTransferError("The Solana fee treasury is not set on this server.");
    await this.onMainnet();
    const transaction = await this.readTransaction(input.signature);
    if (!transaction) {
      if (input.lastValidBlockHeight !== undefined && await this.expired(input.signature, input.lastValidBlockHeight)) throw new SolanaTransactionExpiredError();
      throw new SolanaTransferError("Solana has not confirmed this transaction yet. Verify it again in a moment.");
    }
    if (transaction.meta?.err) throw new SolanaTransferError("This Solana transaction failed, so nothing was sent.");
    const keys = transaction.transaction.message.accountKeys.map((key) => String(typeof key === "string" ? key : key.pubkey));
    if (keys[0] !== input.sender.address) throw new SolanaTransferError("This transaction was not sent from your Solana address.");
    const units = input.payments.map((payment) => BigInt(payment.units));
    // A payment that moved nothing is no payment: it would record a row, and SP, for any transaction from this address.
    if (units.some((value) => value <= 0n)) throw new SolanaTransferError("Each payment must move more than zero.");
    const fee = solanaTransferFee(units.map((value) => ({ units: value })));
    const deltas = this.deltas(transaction, input.asset, keys);
    const owners = new Set(input.payments.map(({ recipientAddress }) => recipientAddress));
    if (owners.size !== input.payments.length) throw new SolanaTransferError("A Solana address appears twice in these payments.");
    input.payments.forEach((payment, index) => {
      if ((deltas.get(payment.recipientAddress) ?? 0n) !== units[index]) {
        throw new SolanaTransferError(`This transaction did not pay @${payment.username} exactly the reviewed amount.`);
      }
    });
    // Sent from the treasury's own wallet, the fee goes from the treasury to itself and never leaves it: nothing is
    // asked of it and no fee is recorded.
    const ownFee = input.sender.address === treasury;
    if (fee > 0n && !ownFee && (deltas.get(treasury) ?? 0n) !== fee) throw new SolanaTransferError("This transaction did not carry the 1% fee to HaPaPay.");
    const memos = this.memos(transaction);
    const expected = input.note ? `${PAYMENT_NOTE_PREFIX}${input.note}` : undefined;
    if (expected ? memos.length !== 1 || memos[0] !== expected : memos.length !== 0) {
      throw new SolanaTransferError("This transaction's note is not the reviewed note.");
    }
    const confirmedAt = transaction.blockTime ? new Date(Number(transaction.blockTime) * 1000).toISOString() : this.now().toISOString();
    // The recorded amount comes from the units the chain moved, at the multiplier in force when the transaction landed.
    const multiplier = input.asset.scaled
      ? effectiveMultiplier((await this.mintState(input.asset)).scaled, BigInt(Math.floor(new Date(confirmedAt).getTime() / 1000)))
      : 1;
    const records: SolanaTransferRecord[] = input.payments.map((payment, index) => ({
      signature: input.signature,
      paymentIndex: index,
      mint: input.asset.mint ?? NATIVE_SOL_MINT,
      tokenSymbol: input.asset.symbol,
      senderWallet: input.sender.wallet,
      senderAddress: input.sender.address,
      recipientWallet: payment.recipientWallet,
      recipientAddress: payment.recipientAddress,
      platform: payment.platform,
      username: payment.username.toLowerCase(),
      amount: recordedUiAmount(payment.amount, units[index], input.asset.decimals, multiplier),
      units: units[index].toString(),
      feeUnits: ownFee ? "0" : solanaFee(units[index]).toString(),
      note: input.note,
      slot: BigInt(transaction.slot),
      confirmedAt,
      sourcePlatform: input.source?.platform,
      sourceUsername: input.source?.username,
    }));
    await this.options.repository.save(records);
    return records;
  }

  private async readTransaction(signatureText: string) {
    const attempts = this.options.confirmAttempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      try {
        const transaction = await this.options.rpc.getTransaction(toSignature(signatureText), { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
        if (transaction || attempt >= attempts) return transaction;
      } catch (error) {
        if (attempt >= attempts) this.unavailable(error);
      }
      await new Promise((done) => setTimeout(done, this.options.confirmRetryMs ?? 1_000));
    }
  }

  /** How much of the asset each owner gained in this transaction (lamports for SOL, raw units for a token). */
  private deltas(transaction: NonNullable<Awaited<ReturnType<SolanaTransferService["readTransaction"]>>>, asset: SolanaAssetListing, keys: string[]) {
    const deltas = new Map<string, bigint>();
    const meta = transaction.meta;
    if (!meta) return deltas;
    if (!asset.mint) {
      keys.forEach((key, index) => deltas.set(key, BigInt(meta.postBalances[index]) - BigInt(meta.preBalances[index])));
      return deltas;
    }
    const add = (entries: typeof meta.preTokenBalances, sign: bigint) => {
      for (const entry of entries ?? []) {
        if (entry.mint !== asset.mint || !entry.owner) continue;
        deltas.set(entry.owner, (deltas.get(entry.owner) ?? 0n) + sign * BigInt(entry.uiTokenAmount.amount));
      }
    };
    add(meta.postTokenBalances, 1n);
    add(meta.preTokenBalances, -1n);
    return deltas;
  }

  private memos(transaction: NonNullable<Awaited<ReturnType<SolanaTransferService["readTransaction"]>>>) {
    // Any memo counts, so a note under another memo program cannot slip past the comparison.
    return transaction.transaction.message.instructions
      .filter((instruction) => "parsed" in instruction && (instruction as { program?: string }).program === "spl-memo")
      .map((instruction) => String((instruction as { parsed: unknown }).parsed));
  }

  async list(wallet: Address) {
    return (await this.options.repository.list(wallet))
      .filter((record) => /^\d+$/.test(record.units) && BigInt(record.units) > 0n)
      .map((record) => solanaHistoryEntry(record, wallet));
  }

  /** The signature of a signed wire transaction (base64), for a wallet that returned the signed bytes. */
  static signatureOf(signedBase64: string) {
    return getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(signedBase64)));
  }
}

/** One Solana transfer as the activity list shows it. */
export function solanaHistoryEntry(record: SolanaTransferRecord, wallet: Address) {
  const sent = record.senderWallet === wallet;
  const asset = record.mint === NATIVE_SOL_MINT ? SOLANA_SOL : solanaAssetByMint(record.mint);
  return {
    transactionHash: record.signature,
    direction: sent ? "sent" as const : "received" as const,
    counterparty: sent ? record.recipientAddress : record.senderAddress,
    platform: record.platform,
    username: record.username,
    amount: (asset && countedUiAmount(record, asset)) ?? record.amount,
    blockNumber: record.slot.toString(),
    confirmedAt: record.confirmedAt,
    ...(record.sourcePlatform && record.sourceUsername ? { sourceIdentity: { platform: record.sourcePlatform, username: record.sourceUsername } } : {}),
    asset: { type: "solana" as const, symbol: record.tokenSymbol, mint: record.mint, network: SOLANA_MAINNET.id },
    ...(record.note ? { note: record.note } : {}),
  };
}
