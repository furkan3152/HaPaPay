import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { getTransferCheckedInstruction as getTransferChecked2022Instruction } from "@solana-program/token-2022";
import { PAYMENT_NOTE_PREFIX } from "./payment-note.js";
import { SOLANA_TOKEN_PROGRAM_ADDRESSES, type SolanaAssetListing } from "./solana-assets.js";
import { solanaFee, SOLANA_FEE_BPS } from "./solana-amounts.js";
import { SOLANA_MAINNET } from "./solana-chains.js";

/**
 * Notes go through the memo package's program (`Memo4c2p…`, on mainnet and read back by RPCs as an SPL memo). The
 * older Memo v2 program checks UTF-8 so expensively that a 140-emoji note ran out of compute on a local validator.
 */
export { MEMO_PROGRAM_ADDRESS as SOLANA_MEMO_PROGRAM_ADDRESS } from "@solana-program/memo";

/** A Solana transaction's wire size limit (bytes). Bigger batches are split into several transactions. */
export const SOLANA_TRANSACTION_MAX_BYTES = 1232;
/** The most compute and the highest priority price the browser accepts, so a fee cannot be inflated unseen. */
export const SOLANA_MAX_COMPUTE_UNITS = 400_000;
export const SOLANA_MAX_COMPUTE_UNIT_PRICE = 2_000_000n;

export type SolanaTransferAsset = Pick<SolanaAssetListing, "mint" | "decimals" | "program">;

/** Everything a transfer transaction is built from. The fee is not an input: it is always 1% of each payment. */
export type SolanaTransferPlan = {
  sender: string;
  asset: SolanaTransferAsset;
  payments: ReadonlyArray<{ recipient: string; units: bigint }>;
  treasury: string;
  note?: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPrice: bigint;
};

export function solanaTransferFee(payments: ReadonlyArray<{ units: bigint }>) {
  return payments.reduce((sum, payment) => sum + solanaFee(payment.units), 0n);
}

async function tokenAccount(owner: string, mint: Address, tokenProgram: Address) {
  const [account] = await findAssociatedTokenPda({ owner: address(owner), mint, tokenProgram });
  return account;
}

/**
 * The instructions of one transfer, always in the same order: the compute limit and price; for a token, each
 * recipient's and the treasury's token account opened if it does not exist yet (idempotent, rent from the sender);
 * one transfer per payment; one transfer of the whole fee to the treasury; the note as a memo.
 */
export async function solanaTransferInstructions(plan: SolanaTransferPlan) {
  const sender = createNoopSigner(address(plan.sender));
  const fee = solanaTransferFee(plan.payments);
  const instructions: Instruction[] = [getSetComputeUnitLimitInstruction({ units: plan.computeUnitLimit })];
  if (plan.computeUnitPrice > 0n) instructions.push(getSetComputeUnitPriceInstruction({ microLamports: plan.computeUnitPrice }));
  if (!plan.asset.mint) {
    for (const payment of plan.payments) instructions.push(getTransferSolInstruction({ source: sender, destination: address(payment.recipient), amount: payment.units }));
    if (fee > 0n) instructions.push(getTransferSolInstruction({ source: sender, destination: address(plan.treasury), amount: fee }));
  } else {
    const mint = address(plan.asset.mint);
    const program = plan.asset.program ?? "token";
    const tokenProgram = address(SOLANA_TOKEN_PROGRAM_ADDRESSES[program]);
    const source = await tokenAccount(plan.sender, mint, tokenProgram);
    const owners = [...new Set([...plan.payments.map(({ recipient }) => recipient), ...(fee > 0n ? [plan.treasury] : [])])];
    const accounts = new Map(await Promise.all(owners.map(async (owner) => [owner, await tokenAccount(owner, mint, tokenProgram)] as const)));
    for (const owner of owners) {
      instructions.push(getCreateAssociatedTokenIdempotentInstruction({ payer: sender, ata: accounts.get(owner)!, owner: address(owner), mint, tokenProgram }));
    }
    const transfer = (destination: Address, amount: bigint) => program === "token-2022"
      ? getTransferChecked2022Instruction({ source, mint, destination, authority: sender, amount, decimals: plan.asset.decimals })
      : getTransferCheckedInstruction({ source, mint, destination, authority: sender, amount, decimals: plan.asset.decimals });
    for (const payment of plan.payments) instructions.push(transfer(accounts.get(payment.recipient)!, payment.units));
    if (fee > 0n) instructions.push(transfer(accounts.get(plan.treasury)!, fee));
  }
  if (plan.note) instructions.push(getAddMemoInstruction({ memo: `${PAYMENT_NOTE_PREFIX}${plan.note}` }));
  return instructions;
}

/** The unsigned transaction for a plan, compiled as a version 0 message with the sender paying the network fee. */
export async function compileSolanaTransfer(plan: SolanaTransferPlan) {
  const instructions = await solanaTransferInstructions(plan);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(plan.sender), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: plan.blockhash as Blockhash, lastValidBlockHeight: plan.lastValidBlockHeight }, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  return compileTransaction(message);
}

export async function buildSolanaTransfer(plan: SolanaTransferPlan) {
  const transaction = await compileSolanaTransfer(plan);
  const wire = getTransactionEncoder().encode(transaction);
  return { transaction: getBase64EncodedWireTransaction(transaction), messageBytes: new Uint8Array(transaction.messageBytes), size: wire.length };
}

/** One transaction of a prepared transfer: its wire bytes, lifetime, compute settings and which payments it carries. */
export type PreparedSolanaTransaction = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: string;
  computeUnitLimit: number;
  computeUnitPrice: string;
  payments: number[];
};

export type PreparedSolanaTransfer = {
  network: typeof SOLANA_MAINNET.id;
  asset: { symbol: string; mint?: string; decimals: number; program?: SolanaAssetListing["program"]; scaled?: boolean };
  sender: string;
  treasury: string;
  feeBps: number;
  payments: Array<{ recipient: string; units: string; amount: string }>;
  transactions: PreparedSolanaTransaction[];
  /** For a scaled token, the multiplier the server converted with; the browser reads its own from the mint. */
  multiplier?: number;
  /** Token accounts the transaction opens for people who have none yet, and their rent in lamports, from the sender. */
  newAccounts: number;
  rentLamports: string;
  /** The network fee estimate in lamports: base signature fees plus the priority price at the compute limit. */
  networkFeeLamports: string;
  totalUnits: string;
  feeUnits: string;
};

/** What the review fixed before the server prepared anything: who sends what to whom, the treasury and the note. */
export type SolanaTransferReview = {
  sender: string;
  treasury: string;
  asset: { symbol: string; mint?: string; decimals: number; program?: SolanaAssetListing["program"] };
  payments: ReadonlyArray<{ recipient: string; units: bigint }>;
  note?: string;
};

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The browser's check before the wallet opens: every prepared transaction must be byte for byte the message rebuilt
 * from the review and the server's lifetime and compute settings (within the caps), every payment must appear in
 * exactly one transaction in order, and the only signature asked for is the sender's. Anything else (another
 * recipient, a bigger fee, an extra instruction, another note) fails the comparison.
 */
export async function matchesSolanaTransfer(prepared: PreparedSolanaTransfer, review: SolanaTransferReview) {
  try {
    if (prepared.network !== SOLANA_MAINNET.id || prepared.sender !== review.sender || prepared.treasury !== review.treasury) return false;
    if (prepared.feeBps !== Number(SOLANA_FEE_BPS)) return false;
    const asset = review.asset;
    if (prepared.asset.symbol !== asset.symbol || prepared.asset.mint !== asset.mint || prepared.asset.decimals !== asset.decimals || (prepared.asset.program ?? undefined) !== (asset.program ?? undefined)) return false;
    if (prepared.payments.length !== review.payments.length || review.payments.length === 0) return false;
    if (!review.payments.every((payment, index) => prepared.payments[index].recipient === payment.recipient && prepared.payments[index].units === payment.units.toString())) return false;
    const covered = prepared.transactions.flatMap(({ payments }) => payments);
    if (covered.length !== review.payments.length || !covered.every((value, index) => value === index)) return false;
    for (const part of prepared.transactions) {
      const limit = part.computeUnitLimit;
      const price = BigInt(part.computeUnitPrice);
      if (!Number.isInteger(limit) || limit < 1 || limit > SOLANA_MAX_COMPUTE_UNITS || price < 0n || price > SOLANA_MAX_COMPUTE_UNIT_PRICE) return false;
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(part.transaction));
      const signers = Object.entries(decoded.signatures);
      if (signers.length !== 1 || signers[0][0] !== review.sender || signers[0][1] !== null) return false;
      const rebuilt = await compileSolanaTransfer({
        sender: review.sender,
        asset,
        payments: part.payments.map((index) => review.payments[index]),
        treasury: review.treasury,
        note: review.note,
        blockhash: part.blockhash,
        lastValidBlockHeight: BigInt(part.lastValidBlockHeight),
        computeUnitLimit: limit,
        computeUnitPrice: price,
      });
      if (!sameBytes(new Uint8Array(decoded.messageBytes), new Uint8Array(rebuilt.messageBytes))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
