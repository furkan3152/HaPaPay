import { randomBytes } from "node:crypto";
import { address, isAddress, isSignature, signature as toSignature, type Address as SolanaAddress, type Base64EncodedWireTransaction } from "@solana/kit";
import type { Address } from "viem";
import { REFERRAL_BATCH_PATTERN, REFERRAL_PAYOUT_MAX_ITEMS, REFERRAL_PAYOUT_MINIMUM_UNITS, formatUsdc, referralPayoutMemo } from "../src/domain/referrals.js";
import { buildReferralPayout, type PreparedReferralPayout, type ReferralPayoutPlan } from "../src/domain/referral-payout.js";
import { SOLANA_USDC } from "../src/domain/solana-assets.js";
import { SOLANA_MAX_COMPUTE_UNITS, SOLANA_TRANSACTION_MAX_BYTES } from "../src/domain/solana-transfers.js";
import type { SolanaRpc } from "./solana-network.js";
import type { Payout, PayoutBatch, ReferralStore } from "./referral-store.js";

export class ReferralPayoutError extends Error {}

/** At most this many transactions with a batch's memo are read when looking for it; more keeps the batch waiting. */
const MEMO_CANDIDATES = 50;

export type PayoutStatus = "paid" | "waiting" | "expired";
export type PayoutState = { batch: PayoutBatch; status: PayoutStatus; payouts: Payout[]; signature?: string; recorded?: number };

type Transaction = NonNullable<Awaited<ReturnType<ReferralPayouts["readTransaction"]>>>;

/**
 * Invite rewards paid in USDC on Solana. The server never holds a key: it prepares one
 * unsigned transaction paying everyone owed at least a dollar (up to eight people) from the wallet an admin connects,
 * with the batch's ID in its memo, and records the payouts only after reading that transaction back from Solana with
 * each person's exact amount. A new batch waits until the last one is paid or can no longer land, so a person is never
 * paid twice for the same rewards.
 */
export class ReferralPayouts {
  constructor(private readonly options: {
    store: ReferralStore;
    rpc: SolanaRpc;
    solana: { onMainnet(): Promise<void>; computePrice(accounts: readonly SolanaAddress[]): Promise<bigint> };
    solanaAddress(wallet: Address): Promise<string | undefined>;
    frozen(wallet: Address): Promise<boolean>;
    /**
     * Writes the payout to the admin audit log before it is recorded, so no payout is recorded without its audit row:
     * the admin whose action recorded it, the batch (with who prepared it) and the transaction.
     */
    audit?(entry: { admin: Address; batch: PayoutBatch; signature: string }): Promise<unknown>;
    confirmAttempts?: number;
    confirmRetryMs?: number;
  }) {}

  private unavailable(error: unknown): never {
    if (error instanceof ReferralPayoutError) throw error;
    throw new ReferralPayoutError("Solana could not be read just now. Try again in a moment.");
  }

  /**
   * Everyone owed at least the minimum, most first, with their Solana address and whether their SP is stopped. A
   * stop that cannot be read counts as stopped, so nobody stopped is ever paid (audit, 2026-10-06).
   */
  async owed(limit = 50, offset = 0) {
    const owed = await this.options.store.owed(REFERRAL_PAYOUT_MINIMUM_UNITS, limit, offset);
    return Promise.all(owed.map(async (entry) => ({
      referrer: entry.referrer,
      owed: entry.owed.toString(),
      address: (await this.options.solanaAddress(entry.referrer).catch(() => undefined)) ?? null,
      frozen: await this.options.frozen(entry.referrer).catch(() => true),
    })));
  }

  /**
   * The people a payout can pay now, most owed first: a Solana address, not stopped, not the paying wallet. The owed
   * list is read a page at a time until there are enough of them, so people owed more who cannot be paid never hold
   * back the ones who can (audit, 2026-10-06: only the 50 owed most were ever looked at).
   */
  private async payable(payer: string) {
    const found: Array<{ referrer: Address; address: string; units: string }> = [];
    for (let page = 0; page < 20 && found.length < REFERRAL_PAYOUT_MAX_ITEMS; page++) {
      const entries = await this.owed(50, page * 50);
      for (const entry of entries) {
        if (entry.address !== null && !entry.frozen && entry.address !== payer) found.push({ referrer: entry.referrer, address: entry.address, units: entry.owed });
      }
      if (entries.length < 50) break;
    }
    return found.slice(0, REFERRAL_PAYOUT_MAX_ITEMS);
  }

  /**
   * The next payout: the people owed most who have a Solana address and are not stopped, each paid everything owed,
   * in one transaction from `payer`, simulated first so a short balance is said before the wallet opens.
   */
  async prepare(input: { payer: string; admin: Address }): Promise<PreparedReferralPayout> {
    if (!isAddress(input.payer)) throw new ReferralPayoutError("Connect the Solana wallet that pays.");
    await this.options.solana.onMainnet();
    const settled = await this.settleRecent(input.admin);
    const items = await this.payable(input.payer);
    if (!items.length) throw new ReferralPayoutError(`Nobody with a Solana address is owed ${formatUsdc(REFERRAL_PAYOUT_MINIMUM_UNITS)} or more right now.`);

    let blockhash: { blockhash: string; lastValidBlockHeight: bigint };
    try {
      blockhash = (await this.options.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    } catch (error) {
      this.unavailable(error);
    }
    const computeUnitPrice = await this.options.solana.computePrice([address(input.payer), ...items.map((item) => address(item.address))]);
    const batch = randomBytes(8).toString("hex");
    const plan = (count: number, computeUnitLimit: number): ReferralPayoutPlan => ({
      payer: input.payer, batch, items: items.slice(0, count).map((item) => ({ address: item.address, units: BigInt(item.units) })),
      blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, computeUnitLimit, computeUnitPrice,
    });
    // Fewer people when the transaction would not fit Solana's size limit (it fits eight with new accounts).
    let count = items.length;
    while (count > 1 && (await buildReferralPayout(plan(count, SOLANA_MAX_COMPUTE_UNITS))).size > SOLANA_TRANSACTION_MAX_BYTES) count--;
    const trial = await buildReferralPayout(plan(count, SOLANA_MAX_COMPUTE_UNITS));
    let simulation;
    try {
      simulation = (await this.options.rpc.simulateTransaction(trial.transaction as Base64EncodedWireTransaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }).send()).value;
    } catch (error) {
      this.unavailable(error);
    }
    const chosen = items.slice(0, count);
    const totalUnits = chosen.reduce((sum, item) => sum + BigInt(item.units), 0n);
    if (simulation.err) {
      const text = `${(simulation.logs ?? []).join("\n")}\n${JSON.stringify(simulation.err, (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`;
      if (/insufficient|InsufficientFunds|AccountNotFound|no record of a prior credit|InvalidAccountData/i.test(text)) {
        throw new ReferralPayoutError(`The paying wallet needs ${formatUsdc(totalUnits)} in USDC and a little SOL for the network fee and new token accounts.`);
      }
      throw new ReferralPayoutError("Solana would refuse this payout right now. Nothing was prepared.");
    }
    const consumed = Number(simulation.unitsConsumed ?? BigInt(SOLANA_MAX_COMPUTE_UNITS));
    const computeUnitLimit = Math.min(SOLANA_MAX_COMPUTE_UNITS, Math.ceil(consumed * 1.15) + 2_000);
    const built = await buildReferralPayout(plan(count, computeUnitLimit));
    const saved = await this.options.store.saveBatch({
      id: batch, payer: input.payer, items: chosen, totalUnits: totalUnits.toString(),
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(), createdBy: input.admin,
    });
    // Two admins preparing at once: of the unpaid batches written since the check above, only the earliest goes ahead.
    for (const other of await this.options.store.batches(20)) {
      if (other.id === saved.id || settled.has(other.id) || (await this.options.store.payoutsOf(other.id)).length) continue;
      if (other.createdAt < saved.createdAt || (other.createdAt === saved.createdAt && other.id < saved.id)) {
        throw new ReferralPayoutError("Another payout was prepared at the same moment. Pay that one, or wait a minute and prepare again.");
      }
    }
    return {
      batch, payer: input.payer, items: chosen, totalUnits: totalUnits.toString(), transaction: built.transaction, blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(), computeUnitLimit, computeUnitPrice: computeUnitPrice.toString(),
    };
  }

  /**
   * Records a batch once its transaction is on Solana: the given signature, or the payer's transaction with the
   * batch's memo that verifies as this payout. Paid when every person received exactly their amount; waiting while it
   * may still land, or while a transaction that may be it cannot be read yet; expired only once its blockhash is too
   * old for it ever to land and no transaction of it was found.
   */
  async confirm(input: { batch: string; signature?: string; admin: Address }): Promise<PayoutState> {
    if (!REFERRAL_BATCH_PATTERN.test(input.batch)) throw new ReferralPayoutError("That payout was not found.");
    const batch = await this.options.store.batch(input.batch);
    if (!batch) throw new ReferralPayoutError("That payout was not found.");
    const recorded = await this.options.store.payoutsOf(batch.id);
    if (recorded.length) return { batch, status: "paid", payouts: recorded, signature: recorded[0].signature, recorded: 0 };
    if (input.signature !== undefined && !isSignature(input.signature)) throw new ReferralPayoutError("This is not a Solana transaction signature.");
    await this.options.solana.onMainnet();
    if (input.signature !== undefined) {
      const transaction = await this.readTransaction(input.signature);
      // A signature Solana does not return yet may still be this payout: the batch waits, and never expires on it.
      if (!transaction) return { batch, status: "waiting", payouts: [] };
      this.verify(batch, transaction);
      return this.record(batch, input.signature, input.admin);
    }
    const found = await this.findOnChain(batch);
    if (found === "unreadable") return { batch, status: "waiting", payouts: [] };
    if (found) return this.record(batch, found, input.admin);
    return { batch, status: await this.expired(batch) ? "expired" : "waiting", payouts: [] };
  }

  /** A verified payout, recorded once per person: its audit row first, then the payouts. */
  private async record(batch: PayoutBatch, signature: string, admin: Address): Promise<PayoutState> {
    await this.options.audit?.({ admin, batch, signature });
    const written = await this.options.store.savePayouts(batch.items.map((item) => ({
      batch: batch.id, referrer: item.referrer, address: item.address, units: item.units, signature, paidBy: admin,
    })));
    return { batch, status: "paid", payouts: await this.options.store.payoutsOf(batch.id), signature, recorded: written };
  }

  /** Recent batches with what became of them, for the panel. */
  async recent(limit = 20) {
    const batches = await this.options.store.batches(limit);
    let height: bigint | undefined;
    try {
      height = await this.options.rpc.getBlockHeight({ commitment: "finalized" }).send();
    } catch {
      height = undefined;
    }
    return Promise.all(batches.map(async (batch) => {
      const payouts = await this.options.store.payoutsOf(batch.id);
      const status: PayoutStatus = payouts.length ? "paid" : height !== undefined && height > BigInt(batch.lastValidBlockHeight) ? "expired" : "waiting";
      return { ...batch, status, signature: payouts[0]?.signature ?? null };
    }));
  }

  /**
   * Before a new batch: every recent unpaid batch is looked for on chain and recorded when found. One that might
   * still land stops the new batch, since paying both would pay the same rewards twice. Returns the batches it settled
   * (paid or expired), so a batch written after this check is known to be another admin's.
   */
  private async settleRecent(admin: Address) {
    const settled = new Set<string>();
    for (const batch of await this.options.store.batches(20)) {
      settled.add(batch.id);
      if ((await this.options.store.payoutsOf(batch.id)).length) continue;
      const state = await this.confirm({ batch: batch.id, admin });
      if (state.status === "waiting") {
        throw new ReferralPayoutError("The last payout may still land on Solana. Wait a minute for its transaction to land or expire, then prepare again.");
      }
    }
    return settled;
  }

  /**
   * The payer's successful transaction that carries the batch's memo and verifies as this payout, looked for back to a
   * few minutes before the batch. Anyone can send a transaction that mentions the payer with the same memo once a
   * payout's memo is public; those are read and skipped. "unreadable" when a transaction that may be this payout could
   * not be read (or too many carry the memo to read them all), so the batch waits instead of expiring.
   */
  private async findOnChain(batch: PayoutBatch): Promise<string | "unreadable" | undefined> {
    const memo = referralPayoutMemo(batch.id);
    const since = Date.parse(batch.createdAt) / 1000 - 600;
    let before: string | undefined;
    let unreadable = false;
    let read = 0;
    try {
      for (let page = 0; page < 20; page++) {
        const recent = await this.options.rpc.getSignaturesForAddress(address(batch.payer), { limit: 1000, before: before as never, commitment: "confirmed" }).send();
        for (const entry of recent) {
          if (entry.err || typeof entry.memo !== "string" || !entry.memo.includes(memo)) continue;
          if (++read > MEMO_CANDIDATES) return "unreadable";
          const transaction = await this.readTransaction(String(entry.signature));
          if (!transaction) {
            unreadable = true;
            continue;
          }
          try {
            this.verify(batch, transaction);
            return String(entry.signature);
          } catch {
            // Not this payout: another wallet's transaction with the same memo.
          }
        }
        const last = recent[recent.length - 1];
        if (recent.length < 1000 || !last || (last.blockTime !== null && Number(last.blockTime) < since)) return unreadable ? "unreadable" : undefined;
        before = String(last.signature);
      }
    } catch (error) {
      this.unavailable(error);
    }
    // The payer's history since the batch was longer than this looks back: the payout may be further down, so it waits.
    return "unreadable";
  }

  private async expired(batch: PayoutBatch) {
    try {
      return await this.options.rpc.getBlockHeight({ commitment: "finalized" }).send() > BigInt(batch.lastValidBlockHeight);
    } catch (error) {
      this.unavailable(error);
    }
  }

  private async readTransaction(signatureText: string) {
    const attempts = this.options.confirmAttempts ?? 6;
    for (let attempt = 1; ; attempt++) {
      try {
        const transaction = await this.options.rpc.getTransaction(toSignature(signatureText), { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
        if (transaction || attempt >= attempts) return transaction ?? undefined;
      } catch (error) {
        if (attempt >= attempts) this.unavailable(error);
      }
      await new Promise((done) => setTimeout(done, this.options.confirmRetryMs ?? 1_000));
    }
  }

  /** The transaction succeeded, was paid for by the batch's payer, carries the batch's memo only, and paid each person exactly. */
  private verify(batch: PayoutBatch, transaction: Transaction) {
    if (transaction.meta?.err) throw new ReferralPayoutError("This Solana transaction failed, so nobody was paid.");
    const keys = transaction.transaction.message.accountKeys.map((key) => String(typeof key === "string" ? key : key.pubkey));
    if (keys[0] !== batch.payer) throw new ReferralPayoutError("This transaction was not paid from the wallet the payout was prepared for.");
    const memos = transaction.transaction.message.instructions
      .filter((instruction) => "parsed" in instruction && (instruction as { program?: string }).program === "spl-memo")
      .map((instruction) => String((instruction as { parsed: unknown }).parsed));
    if (memos.length !== 1 || memos[0] !== referralPayoutMemo(batch.id)) throw new ReferralPayoutError("This transaction is not this payout.");
    const deltas = new Map<string, bigint>();
    const add = (entries: NonNullable<Transaction["meta"]>["preTokenBalances"], sign: bigint) => {
      for (const entry of entries ?? []) {
        if (entry.mint !== SOLANA_USDC.mint || !entry.owner) continue;
        deltas.set(entry.owner, (deltas.get(entry.owner) ?? 0n) + sign * BigInt(entry.uiTokenAmount.amount));
      }
    };
    add(transaction.meta?.postTokenBalances, 1n);
    add(transaction.meta?.preTokenBalances, -1n);
    for (const item of batch.items) {
      if ((deltas.get(item.address) ?? 0n) !== BigInt(item.units)) throw new ReferralPayoutError(`This transaction did not pay ${item.address} exactly ${formatUsdc(item.units)}.`);
    }
  }
}
