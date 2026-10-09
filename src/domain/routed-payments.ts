import { decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, size, sliceHex, type Hex } from "viem";
import { ROUTER_PAY_CALL_BYTES, appendPaymentNote, readPaymentNote } from "./payment-note.js";
import { isPreparedFeeWithinSchedule, platformFee, payRouterAbi, type PreparedPlatformFee } from "./fees.js";

/** The most people one request pays: one signature each, plus at most one approval. */
export const PAYMENT_BATCH_MAX_RECIPIENTS = 10;

/**
 * How a request's amounts reach several people: one amount to each of them, one amount split between them, or an
 * amount written for each person (`listed`: "10 USDC to @a and 5 USDC to @b").
 */
export type AmountMode = "each" | "split" | "listed";

/** `total` base units split between `count` people as evenly as base units allow: the first ones get one unit more. */
export function splitUnits(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("A split needs at least one recipient.");
  const share = total / BigInt(count);
  const extra = total % BigInt(count);
  return Array.from({ length: count }, (_, index) => share + (BigInt(index) < extra ? 1n : 0n));
}

const approveAbi = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

/** One wallet call as the server prepares it. */
export type RoutedCall = { purpose: "approve" | "pay"; to: `0x${string}`; data: Hex; value: "0x0"; from?: `0x${string}` };

/** `approve(router, units)` on the token: the most the router may pull for the payments that follow. */
export function routedApproveCall(input: { token: string; router: string; units: bigint }): RoutedCall {
  return {
    purpose: "approve",
    to: getAddress(input.token),
    data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [getAddress(input.router), input.units] }),
    value: "0x0",
  };
}

/** `pay(token, recipient, units, paymentRef)` on the router, with the note after its arguments when there is one. */
export function routedPayCall(input: { token: string; router: string; recipient: string; units: bigint; paymentRef: Hex; note?: string }): RoutedCall {
  if (input.units <= 0n) throw new Error("Amount must be greater than zero.");
  return {
    purpose: "pay",
    to: getAddress(input.router),
    data: appendPaymentNote(encodeFunctionData({
      abi: payRouterAbi,
      functionName: "pay",
      args: [getAddress(input.token), getAddress(input.recipient), input.units, input.paymentRef],
    }), input.note),
    value: "0x0",
  };
}

/** A prepared call the browser may send for the session wallet: from it, with zero native value. */
function fromWallet(call: { from?: string; value: string } | undefined, wallet: `0x${string}`) {
  return Boolean(call?.from) && getAddress(call!.from!) === wallet && BigInt(call!.value) === 0n;
}

/**
 * Whether a prepared call is exactly the one the review describes: the same purpose, contract and calldata, byte for
 * byte, from the session wallet. A `pay` built for another recipient, amount or note, or with anything else after its
 * arguments, is a different call.
 */
export function matchesRoutedCall(
  call: { purpose?: string; to: string; data: string; value: string; from?: string } | undefined,
  expected: RoutedCall,
  wallet: string,
) {
  try {
    return Boolean(call)
      && call!.purpose === expected.purpose
      && fromWallet(call, getAddress(wallet))
      && getAddress(call!.to) === expected.to
      && call!.data.toLowerCase() === expected.data.toLowerCase();
  } catch {
    return false;
  }
}

/** One payment of a prepared batch, as the server returns it. */
export type PreparedBatchPayment = {
  recipient: { platform: string; username: string; address: `0x${string}` };
  amount: string;
  units: string;
  fee: PreparedPlatformFee;
  paymentRef: Hex;
  transaction: { purpose: "pay"; from: `0x${string}`; to: `0x${string}`; data: Hex; value: "0x0" };
};

/** What a batch prepare returns: the network, the note, at most one approval for everything, and one payment each. */
export type PreparedBatch = {
  networkId: string;
  chainId: number;
  note?: string;
  feeBps: number;
  totalUnits: string;
  totalAmount: string;
  approval?: { purpose: "approve"; from: `0x${string}`; to: `0x${string}`; data: Hex; value: "0x0" };
  payments: PreparedBatchPayment[];
};

/**
 * The browser's check of a prepared batch against its review, before any wallet opens: the same people in the same
 * order with the same amounts in base units, each paid by its own `pay` on the reviewed token through the router
 * with the reviewed note, each fee at most 1% and adding up, distinct payment references, and at most one approval:
 * exactly the sum of every amount and fee, to the router (left out when an earlier approval already covers it).
 */
export function matchesRoutedBatch(
  prepared: PreparedBatch,
  review: { token: string; router: string; wallet: string; note?: string; payments: Array<{ recipient: string; units: string }> },
) {
  try {
    const wallet = getAddress(review.wallet);
    const router = getAddress(review.router);
    if (prepared.payments.length !== review.payments.length || review.payments.length < 1) return false;
    if ((prepared.note ?? undefined) !== (review.note ?? undefined)) return false;
    let total = 0n;
    const references = new Set<string>();
    for (const [index, payment] of prepared.payments.entries()) {
      const reviewed = review.payments[index];
      const units = BigInt(reviewed.units);
      if (units <= 0n || payment.units !== reviewed.units || getAddress(payment.recipient.address) !== getAddress(reviewed.recipient)) return false;
      if (!/^0x[0-9a-fA-F]{64}$/.test(payment.paymentRef) || references.has(payment.paymentRef.toLowerCase())) return false;
      references.add(payment.paymentRef.toLowerCase());
      if (getAddress(payment.fee.router) !== router || !isPreparedFeeWithinSchedule(payment.fee, units)) return false;
      if (BigInt(payment.fee.units) !== platformFee(units, BigInt(prepared.feeBps)) || payment.fee.feeBps !== prepared.feeBps) return false;
      const expected = routedPayCall({ token: review.token, router, recipient: reviewed.recipient, units, paymentRef: payment.paymentRef, note: review.note });
      if (!matchesRoutedCall(payment.transaction, expected, wallet)) return false;
      total += BigInt(payment.fee.totalUnits);
    }
    if (BigInt(prepared.totalUnits) !== total) return false;
    if (prepared.approval && !matchesRoutedCall(prepared.approval, routedApproveCall({ token: review.token, router, units: total }), wallet)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The note a confirmed payment's own transaction carries: read only from `pay` of this token, to this recipient, of
 * these units, so a note always belongs to the payment it is recorded with. Anything else carries none.
 */
/**
 * The fee HaPaPay's router took for one payment, read from its receipt: the router's own `Paid` event for this
 * payer, recipient, token and amount, never above the 1% schedule. Undefined when the payment did not go through the
 * router, so no fee was paid (a plain token transfer to the same person carries the same transfer log, but no `Paid`).
 */
export function routedPaymentFee(
  logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>,
  expected: { router: string; payer: string; recipient: string; token: string; units: bigint },
) {
  const router = getAddress(expected.router);
  for (const log of logs) {
    if (getAddress(log.address) !== router || !log.topics.length) continue;
    try {
      const { args } = decodeEventLog({ abi: payRouterAbi, eventName: "Paid", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (getAddress(args.payer) !== getAddress(expected.payer) || getAddress(args.recipient) !== getAddress(expected.recipient)) continue;
      if (getAddress(args.token) !== getAddress(expected.token) || args.amount !== expected.units) continue;
      if (args.fee > platformFee(expected.units) || args.burnShare + args.treasuryShare !== args.fee) continue;
      return args.fee;
    } catch {
      // Another event of the router (or not one at all).
    }
  }
  return undefined;
}

export function routedPaymentNote(input: Hex, expected: { token: string; recipient: string; units: bigint }) {
  try {
    if (size(input) <= ROUTER_PAY_CALL_BYTES) return undefined;
    const call = decodeFunctionData({ abi: payRouterAbi, data: sliceHex(input, 0, ROUTER_PAY_CALL_BYTES) });
    if (call.functionName !== "pay" || getAddress(call.args[0]) !== getAddress(expected.token)) return undefined;
    if (getAddress(call.args[1]) !== getAddress(expected.recipient) || call.args[2] !== expected.units) return undefined;
    return readPaymentNote(input);
  } catch {
    return undefined;
  }
}
