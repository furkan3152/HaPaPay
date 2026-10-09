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
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getAddMemoInstruction } from "@solana-program/memo";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { SOLANA_TOKEN_PROGRAM_ADDRESSES, SOLANA_USDC } from "./solana-assets.js";
import { SOLANA_MAX_COMPUTE_UNITS, SOLANA_MAX_COMPUTE_UNIT_PRICE } from "./solana-transfers.js";
import { REFERRAL_BATCH_PATTERN, REFERRAL_PAYOUT_MAX_ITEMS, referralPayoutMemo } from "./referrals.js";

/**
 * An invite payout's Solana transaction: built by the server for an admin's wallet and
 * checked by `/admin` before that wallet signs it. Kept apart from `referrals.ts` so the desk's first chunk, which
 * needs only codes and links, does not carry Solana's transaction libraries.
 */

/** Everything a payout transaction is built from: who pays, the batch, and each person's address and USDC units. */
export type ReferralPayoutPlan = {
  payer: string;
  batch: string;
  items: ReadonlyArray<{ address: string; units: bigint }>;
  blockhash: string;
  lastValidBlockHeight: bigint;
  computeUnitLimit: number;
  computeUnitPrice: bigint;
};

const usdcMint = () => address(SOLANA_USDC.mint!);
const tokenProgram = () => address(SOLANA_TOKEN_PROGRAM_ADDRESSES.token);
const usdcAccount = async (owner: string) => (await findAssociatedTokenPda({ owner: address(owner), mint: usdcMint(), tokenProgram: tokenProgram() }))[0];

/**
 * The instructions of a payout, always in the same order: the compute limit and price; for each person, their USDC
 * account opened if it does not exist yet (idempotent, rent from the payer) and a checked transfer from the payer's
 * USDC account; then the batch's memo.
 */
export async function referralPayoutInstructions(plan: ReferralPayoutPlan) {
  const payer = createNoopSigner(address(plan.payer));
  const mint = usdcMint();
  const source = await usdcAccount(plan.payer);
  const instructions: Instruction[] = [getSetComputeUnitLimitInstruction({ units: plan.computeUnitLimit })];
  if (plan.computeUnitPrice > 0n) instructions.push(getSetComputeUnitPriceInstruction({ microLamports: plan.computeUnitPrice }));
  for (const item of plan.items) {
    const destination = await usdcAccount(item.address);
    instructions.push(getCreateAssociatedTokenIdempotentInstruction({ payer, ata: destination, owner: address(item.address), mint, tokenProgram: tokenProgram() }));
    instructions.push(getTransferCheckedInstruction({ source, mint, destination, authority: payer, amount: item.units, decimals: SOLANA_USDC.decimals }));
  }
  instructions.push(getAddMemoInstruction({ memo: referralPayoutMemo(plan.batch) }));
  return instructions;
}

export async function compileReferralPayout(plan: ReferralPayoutPlan) {
  const instructions = await referralPayoutInstructions(plan);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(plan.payer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: plan.blockhash as Blockhash, lastValidBlockHeight: plan.lastValidBlockHeight }, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  return compileTransaction(message);
}

export async function buildReferralPayout(plan: ReferralPayoutPlan) {
  const transaction = await compileReferralPayout(plan);
  return { transaction: getBase64EncodedWireTransaction(transaction), size: getTransactionEncoder().encode(transaction).length };
}

/** A payout the server prepared: the batch, who pays, each person, and the unsigned transaction. */
export type PreparedReferralPayout = {
  batch: string;
  payer: string;
  items: Array<{ referrer: string; address: string; units: string }>;
  totalUnits: string;
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: string;
  computeUnitLimit: number;
  computeUnitPrice: string;
};

const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * The admin page's check before the wallet opens: the transaction must be byte for byte the payout rebuilt from the
 * batch the page shows (the same people, addresses and amounts, from this payer, with this memo), within the compute
 * caps, and ask for the payer's signature only. Anything else fails.
 */
export async function matchesReferralPayout(prepared: PreparedReferralPayout, review: { payer: string; batch: string; items: ReadonlyArray<{ address: string; units: bigint }> }) {
  try {
    if (prepared.payer !== review.payer || prepared.batch !== review.batch || !REFERRAL_BATCH_PATTERN.test(review.batch)) return false;
    if (review.items.length === 0 || review.items.length > REFERRAL_PAYOUT_MAX_ITEMS || prepared.items.length !== review.items.length) return false;
    if (!review.items.every((item, index) => prepared.items[index].address === item.address && prepared.items[index].units === item.units.toString() && item.units > 0n)) return false;
    if (BigInt(prepared.totalUnits) !== review.items.reduce((sum, item) => sum + item.units, 0n)) return false;
    const limit = prepared.computeUnitLimit;
    const price = BigInt(prepared.computeUnitPrice);
    if (!Number.isInteger(limit) || limit < 1 || limit > SOLANA_MAX_COMPUTE_UNITS || price < 0n || price > SOLANA_MAX_COMPUTE_UNIT_PRICE) return false;
    const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
    const signers = Object.entries(decoded.signatures);
    if (signers.length !== 1 || signers[0][0] !== review.payer || signers[0][1] !== null) return false;
    const rebuilt = await compileReferralPayout({
      payer: review.payer, batch: review.batch, items: review.items, blockhash: prepared.blockhash,
      lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight), computeUnitLimit: limit, computeUnitPrice: price,
    });
    return sameBytes(new Uint8Array(decoded.messageBytes), new Uint8Array(rebuilt.messageBytes));
  } catch {
    return false;
  }
}
