import { decodeFunctionData, getAddress, keccak256, parseUnits, stringToHex, type Hex } from "viem";
import { ARC_CHAINS, type ArcNetworkId } from "./arc-chains.js";
import { arcUsdcApproveAbi, erc20TransferAbi } from "./arc-transaction.js";
import { isPreparedFeeWithinSchedule, type PreparedPlatformFee } from "./fees.js";
import { matchesRoutedBatch, matchesRoutedCall, routedApproveCall, routedPayCall, type PreparedBatch } from "./routed-payments.js";
import { STOCK_CLAIM_MAX_WINDOW_SECONDS, stockClaimEscrowAbi } from "./stock-claims.js";

/** One wallet call as the server prepares it. */
export type ArcWalletCall = { purpose?: string; to: string; data: string; value: string; from?: string };

export function isArcNetworkId(value: unknown): value is ArcNetworkId {
  return value === "arc-testnet" || value === "arc-mainnet";
}

/** A call the browser may send: from the session wallet, with zero native value and hex calldata. */
function isSessionCall(call: ArcWalletCall | undefined, wallet: `0x${string}`): call is ArcWalletCall {
  return Boolean(call && call.from && getAddress(call.from) === wallet && /^0x[0-9a-fA-F]*$/.test(call.data) && BigInt(call.value) === 0n);
}

function onReviewedChain(prepared: { networkId?: unknown; chainId?: unknown }, network: ArcNetworkId) {
  return prepared.networkId === network && prepared.chainId === ARC_CHAINS[network].chainId;
}

/**
 * The browser opens the wallet for an Arc USDC payment only when it is exactly the reviewed one, on the bundled chain
 * and USDC: through the fee router, `approve(router, amount + fee)` on USDC and then `pay(USDC, recipient, amount,
 * paymentRef)` on that router with the reviewed note after its arguments and nothing else, with a fee of at most 1%
 * that adds up (the approval is left out when an earlier one already covers it, which can only make the payment fail,
 * never move more); without a fee router, which happens only on Arc Testnet, a single `transfer(recipient, amount)`
 * and no note. Arc Mainnet never accepts a payment without the fee.
 */
export function matchesArcPayment(
  prepared: { networkId?: unknown; chainId?: unknown; transaction?: ArcWalletCall; transactions?: ArcWalletCall[]; fee?: PreparedPlatformFee; paymentRef?: string },
  review: { network: ArcNetworkId; recipient: string; amount: string; wallet: string; note?: string },
) {
  try {
    if (!onReviewedChain(prepared, review.network)) return false;
    const usdc = getAddress(ARC_CHAINS[review.network].usdcAddress);
    const wallet = getAddress(review.wallet);
    const recipient = getAddress(review.recipient);
    const units = parseUnits(review.amount, 6);
    if (units <= 0n) return false;
    if (prepared.transactions) {
      const fee = prepared.fee;
      const calls = prepared.transactions;
      if (!fee || prepared.transaction || (calls.length !== 1 && calls.length !== 2) || !isPreparedFeeWithinSchedule(fee, units)) return false;
      if (!prepared.paymentRef || !/^0x[0-9a-fA-F]{64}$/.test(prepared.paymentRef)) return false;
      const approval = calls.length === 2 ? calls[0] : undefined;
      const router = getAddress(fee.router);
      if (approval && !matchesRoutedCall(approval, routedApproveCall({ token: usdc, router, units: BigInt(fee.totalUnits) }), wallet)) return false;
      return matchesRoutedCall(calls.at(-1), routedPayCall({ token: usdc, router, recipient, units, paymentRef: prepared.paymentRef as Hex, note: review.note }), wallet);
    }
    if (review.note || review.network === "arc-mainnet" || prepared.fee || !isSessionCall(prepared.transaction, wallet)) return false;
    if (getAddress(prepared.transaction.to) !== usdc) return false;
    const transfer = decodeFunctionData({ abi: erc20TransferAbi, data: prepared.transaction.data as Hex });
    return transfer.functionName === "transfer" && getAddress(transfer.args[0]) === recipient && transfer.args[1] === units;
  } catch {
    return false;
  }
}

/**
 * An Arc vault link opens the wallet only for `approve(escrow, amount + fee)` on the bundled USDC, with a fee of at
 * most 1% that adds up (left out when an earlier approval already covers it), and then `createPayment(paymentId, USDC,
 * keccak256(platform), …, amount, expiry)` on the escrow named in the review, with an expiry inside the escrow's 31-day
 * limit.
 */
export function matchesArcClaimFunding(
  prepared: { networkId?: unknown; chainId?: unknown; paymentId?: string; escrow?: string; fee?: PreparedPlatformFee; transactions?: ArcWalletCall[] },
  review: { network: ArcNetworkId; platform: string; amount: string; wallet: string; now: Date },
) {
  try {
    if (!onReviewedChain(prepared, review.network) || !prepared.escrow || !prepared.fee || !prepared.paymentId) return false;
    const usdc = getAddress(ARC_CHAINS[review.network].usdcAddress);
    const wallet = getAddress(review.wallet);
    const escrow = getAddress(prepared.escrow);
    const units = parseUnits(review.amount, 6);
    const calls = prepared.transactions ?? [];
    if (units <= 0n || !isPreparedFeeWithinSchedule(prepared.fee, units) || (calls.length !== 1 && calls.length !== 2)) return false;
    const approval = calls.length === 2 ? calls[0] : undefined;
    const funding = calls.at(-1);
    if (!isSessionCall(funding, wallet) || funding.purpose !== "fund" || getAddress(funding.to) !== escrow) return false;
    if (approval) {
      if (!isSessionCall(approval, wallet) || approval.purpose !== "approve" || getAddress(approval.to) !== usdc) return false;
      const approve = decodeFunctionData({ abi: arcUsdcApproveAbi, data: approval.data as Hex });
      if (approve.functionName !== "approve" || getAddress(approve.args[0]) !== escrow || approve.args[1] !== BigInt(prepared.fee.totalUnits)) return false;
    }
    const create = decodeFunctionData({ abi: stockClaimEscrowAbi, data: funding.data as Hex });
    if (create.functionName !== "createPayment") return false;
    const [paymentId, token, platformHash, , amount, expiry] = create.args;
    const now = BigInt(Math.floor(review.now.getTime() / 1000));
    return paymentId.toLowerCase() === prepared.paymentId.toLowerCase()
      && getAddress(token) === usdc
      && platformHash === keccak256(stringToHex(review.platform))
      && amount === units
      && expiry > now
      && expiry <= now + BigInt(STOCK_CLAIM_MAX_WINDOW_SECONDS);
  } catch {
    return false;
  }
}

/** A claim or refund opens the wallet only for that call on this link, from the session wallet; a claim pays it. */
export function matchesArcClaimAction(
  prepared: { transaction?: ArcWalletCall },
  review: { action: "claim" | "refund"; paymentId: string; wallet: string },
) {
  try {
    const wallet = getAddress(review.wallet);
    if (!isSessionCall(prepared.transaction, wallet)) return false;
    const call = decodeFunctionData({ abi: stockClaimEscrowAbi, data: prepared.transaction.data as Hex });
    if (call.functionName !== review.action) return false;
    if (call.functionName === "claim") return call.args[0].toLowerCase() === review.paymentId.toLowerCase() && getAddress(call.args[1]) === wallet;
    return call.functionName === "refund" && call.args[0].toLowerCase() === review.paymentId.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * An Arc USDC batch opens the wallet only when it is exactly the reviewed one, on the bundled chain and USDC, through
 * the router of the reviewed fee schedule: see `matchesRoutedBatch`. Arc has no batch without the fee router.
 */
export function matchesArcBatch(
  prepared: PreparedBatch & { networkId?: unknown; chainId?: unknown },
  review: { network: ArcNetworkId; router: string; wallet: string; note?: string; payments: Array<{ recipient: string; amount: string }> },
) {
  try {
    if (!onReviewedChain(prepared, review.network)) return false;
    return matchesRoutedBatch(prepared, {
      token: ARC_CHAINS[review.network].usdcAddress,
      router: review.router,
      wallet: review.wallet,
      note: review.note,
      payments: review.payments.map((payment) => ({ recipient: payment.recipient, units: parseUnits(payment.amount, 6).toString() })),
    });
  } catch {
    return false;
  }
}
