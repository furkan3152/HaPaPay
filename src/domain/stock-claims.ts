import { decodeFunctionData, getAddress, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { STOCK_CHAINS, type StockNetworkId, type StockTokenKind } from "./stock-tokens.js";
import { isPreparedFeeWithinSchedule, type PreparedPlatformFee, type FeeSchedule } from "./fees.js";
import type { VaultLock } from "./vault-lock.js";

/** The security revision the reviewed StockClaimEscrow reports (2: it charges the fee router's fee). Any other value is refused. */
export const STOCK_CLAIM_ESCROW_REVISION = 2n;
/**
 * Claim windows the server prepares, in hours: any sender may choose from 24 hours to 30 days, and a new link starts
 * at three days. The contract itself refuses windows over 31 days.
 */
export const STOCK_CLAIM_WINDOW_HOURS = { min: 24, max: 24 * 30, default: 72 } as const;
/** The windows a vault slip offers: three days, one week, two weeks and thirty days. */
export const STOCK_CLAIM_WINDOW_CHOICES = [72, 168, 336, 720] as const;
export const STOCK_CLAIM_MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;
export const STOCK_ESCROW_OPERATOR_PATH = "/operator/stock-escrow";

export const stockClaimEscrowAbi = parseAbi([
  "constructor(address initialVerifier, address initialFeeRouter)",
  "function owner() view returns (address)",
  "function verifier() view returns (address)",
  "function feeRouter() view returns (address)",
  "function securityRevision() pure returns (uint256)",
  "function MAX_CLAIM_WINDOW() view returns (uint256)",
  "function payments(bytes32 paymentId) view returns (address payer, address token, bytes32 identityKey, uint256 amount, uint256 fee, uint256 expiry)",
  "function createPayment(bytes32 paymentId, address token, bytes32 platformHash, bytes32 providerUserIdHash, uint256 amount, uint256 expiry)",
  "function claim(bytes32 paymentId, address recipient, uint256 claimDeadline, bytes signature)",
  "function refund(bytes32 paymentId)",
  "function setVerifier(address newVerifier)",
  "function transferOwnership(address newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier)",
  "event PaymentCreated(bytes32 indexed paymentId, address indexed payer, bytes32 indexed identityKey, address token, uint256 amount, uint256 fee, uint256 expiry)",
  "event PaymentClaimed(bytes32 indexed paymentId, address indexed recipient, address indexed token, uint256 amount, uint256 fee)",
  "event PaymentRefunded(bytes32 indexed paymentId, address indexed payer, address indexed token, uint256 amount, uint256 fee)",
  "error NotOwner()",
  "error InvalidAddress()",
  "error InvalidToken()",
  "error InvalidAmount()",
  "error InvalidExpiry()",
  "error PaymentAlreadyExists()",
  "error PaymentUnavailable()",
  "error ClaimExpired()",
  "error InvalidClaim()",
  "error NotPayer()",
  "error RefundNotReady()",
  "error TransferFailed()",
  "error TransferAmountMismatch()",
  "error ReentrantCall()",
]);

export const stockTokenApproveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/**
 * Platforms a vault link can wait on: GitHub, X and Farcaster, whose official directories resolve a handle to an
 * immutable account ID (GitHub and X user IDs, Farcaster FIDs from the fname registry), and Discord and Telegram, whose
 * links wait for the name instead (`vault-lock.ts`), as X's do while it refuses lookups.
 */
export type StockClaimPlatform = "github" | "x" | "farcaster" | "discord" | "telegram";
export const STOCK_CLAIM_PLATFORMS: readonly StockClaimPlatform[] = ["github", "x", "farcaster", "discord", "telegram"];
export function isStockClaimPlatform(platform: unknown): platform is StockClaimPlatform {
  return typeof platform === "string" && (STOCK_CLAIM_PLATFORMS as readonly string[]).includes(platform);
}
/**
 * Whether this server prepares vault (claim) links on a network, the escrow new links fund, the platforms links can
 * wait on, and which assets links may hold: `stockTokens` for Robinhood Stock Tokens, `tokens` for USDG.
 */
export type StockClaimAvailability = {
  enabled: boolean;
  reason?: string;
  escrow?: `0x${string}`;
  platforms?: StockClaimPlatform[];
  stockTokens?: boolean;
  tokens?: boolean;
  /** The fee contracts behind the escrow; direct payments on this network go through the same router. */
  fees?: FeeSchedule;
};

/** A refund needs the window closed, and a block's time is never this far ahead of the page's clock. */
const SETTLED_BEFORE_EXPIRY_MARGIN_MS = 15 * 60_000;

/**
 * What the claim page says about a link the vault no longer holds, instead of "Claimable payment is unavailable": the
 * sender can take a link back only after its window closes, so one settled before then was claimed; after it, claimed
 * or refunded look the same on chain.
 */
export function settledLink(expiresAt: string, now = Date.now()) {
  return now + SETTLED_BEFORE_EXPIRY_MARGIN_MS < Date.parse(expiresAt)
    ? {
      label: "Claimed",
      heading: "This vault link was claimed",
      intro: "The account it was made for has claimed it.",
      note: "This link was claimed on chain. Nothing is left in it to claim or take back.",
    }
    : {
      label: "Claimed or refunded",
      heading: "This vault link is closed",
      intro: "The account it was made for claimed it, or its sender took it back after the window closed.",
      note: "This link was claimed, or its sender took it back after the window closed. Nothing is left in it.",
    };
}

export function stockClaimPath(network: StockNetworkId, paymentId: string) {
  return `/claim/stock/${network}/${paymentId}`;
}

export function parseStockClaimPath(pathname: string): { network: StockNetworkId; paymentId: `0x${string}` } | undefined {
  const match = pathname.match(/^\/claim\/stock\/(robinhood-mainnet|robinhood-testnet)\/(0x[0-9a-fA-F]{64})$/);
  return match ? { network: match[1] as StockNetworkId, paymentId: match[2] as `0x${string}` } : undefined;
}

export function stockClaimPlatformHash(platform: StockClaimPlatform): Hex {
  return keccak256(stringToHex(platform));
}

type WalletTransaction = { from: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: string };

/** What `/api/stocks/claims/prepare` returns: the approve and fund transactions of one reviewed claim link (only the fund when an earlier approval covers it). The approval covers the amount plus the fee, which the escrow pays out only when the link is claimed. */
export type PreparedStockClaimFunding = {
  networkId: StockNetworkId;
  chainId: number;
  chainIdHex: `0x${string}`;
  chainName: string;
  escrow: `0x${string}`;
  token: { symbol: string; name: string; address: `0x${string}`; decimals: number };
  amount: string;
  units: string;
  balance: string;
  paymentId: `0x${string}`;
  recipient: { platform: StockClaimPlatform; username: string };
  /** Whether the link waits for the recipient's account or for their name (`vault-lock.ts`). */
  lock: VaultLock;
  expiry: string;
  expiresAt: string;
  claimPath: string;
  fee: PreparedPlatformFee;
  transactions: Array<WalletTransaction & { purpose: "approve" | "fund" }>;
};

/**
 * The browser opens the wallet only when the prepared calls are exactly the reviewed claim link: an approval of the
 * reviewed base units plus a fee of at most 1% to the escrow named in the review (left out when an earlier approval
 * covers it), then createPayment of the same token and units for the reviewed platform, with an expiry inside the
 * contract's window.
 */
export function matchesStockClaimFunding(
  prepared: PreparedStockClaimFunding,
  review: { network: StockNetworkId; token: string; payer: string; units: string; escrow: string; platform: StockClaimPlatform; nowSeconds: number },
) {
  const chain = STOCK_CHAINS[review.network];
  try {
    if (prepared.networkId !== review.network || prepared.chainId !== chain.id || prepared.chainIdHex !== `0x${chain.id.toString(16)}`) return false;
    if (prepared.units !== review.units || getAddress(prepared.escrow) !== getAddress(review.escrow)) return false;
    if (!/^0x[0-9a-fA-F]{64}$/.test(prepared.paymentId) || prepared.recipient.platform !== review.platform) return false;
    const calls = prepared.transactions;
    if (calls.length !== 1 && calls.length !== 2) return false;
    // The approval is left out when an earlier one already covers the link.
    const approve = calls.length === 2 ? calls[0] : undefined;
    const fund = calls.at(-1)!;
    if (fund.purpose !== "fund" || (approve && approve.purpose !== "approve")) return false;
    for (const transaction of calls) {
      if (getAddress(transaction.from) !== getAddress(review.payer) || BigInt(transaction.value) !== 0n) return false;
    }
    if (getAddress(fund.to) !== getAddress(review.escrow)) return false;
    if (!isPreparedFeeWithinSchedule(prepared.fee, BigInt(review.units))) return false;
    if (approve) {
      if (getAddress(approve.to) !== getAddress(review.token)) return false;
      const approval = decodeFunctionData({ abi: stockTokenApproveAbi, data: approve.data });
      if (getAddress(approval.args[0]) !== getAddress(review.escrow) || approval.args[1] !== BigInt(prepared.fee.totalUnits)) return false;
    }
    const funding = decodeFunctionData({ abi: stockClaimEscrowAbi, data: fund.data });
    if (funding.functionName !== "createPayment") return false;
    const [paymentId, token, platformHash, , amount, expiry] = funding.args;
    return paymentId.toLowerCase() === prepared.paymentId.toLowerCase()
      && getAddress(token) === getAddress(review.token)
      && platformHash === stockClaimPlatformHash(review.platform)
      && amount === BigInt(review.units)
      && expiry === BigInt(prepared.expiry)
      && expiry > BigInt(review.nowSeconds)
      && expiry <= BigInt(review.nowSeconds + STOCK_CLAIM_MAX_WINDOW_SECONDS);
  } catch {
    return false;
  }
}

/** What the claim and refund preparation routes return: one escrow call for the session wallet. */
export type PreparedStockClaimAction = {
  networkId: StockNetworkId;
  chainId: number;
  chainIdHex: `0x${string}`;
  paymentId: `0x${string}`;
  escrow: `0x${string}`;
  token: { symbol: string; name: string; address: `0x${string}` };
  amount: string;
  transaction: WalletTransaction;
};

/** A claim goes only to the session wallet, and both calls must target the escrow the claim page shows. */
export function matchesStockClaimAction(
  prepared: PreparedStockClaimAction,
  review: { network: StockNetworkId; escrow: string; wallet: string; paymentId: string; action: "claim" | "refund" },
) {
  const chain = STOCK_CHAINS[review.network];
  try {
    const { transaction } = prepared;
    if (prepared.networkId !== review.network || prepared.chainId !== chain.id || prepared.chainIdHex !== `0x${chain.id.toString(16)}`) return false;
    if (getAddress(prepared.escrow) !== getAddress(review.escrow) || getAddress(transaction.to) !== getAddress(review.escrow)) return false;
    if (getAddress(transaction.from) !== getAddress(review.wallet) || BigInt(transaction.value) !== 0n) return false;
    const call = decodeFunctionData({ abi: stockClaimEscrowAbi, data: transaction.data });
    if (call.functionName === "claim" && review.action === "claim") {
      return call.args[0].toLowerCase() === review.paymentId.toLowerCase() && getAddress(call.args[1]) === getAddress(review.wallet);
    }
    return call.functionName === "refund" && review.action === "refund" && call.args[0].toLowerCase() === review.paymentId.toLowerCase();
  } catch {
    return false;
  }
}

/** Public state of one stock claim link, read from the escrow and the funding record. */
export type StockClaimDetails = {
  network: StockNetworkId;
  chainId: number;
  paymentId: `0x${string}`;
  escrow: `0x${string}`;
  payer: `0x${string}`;
  token: { symbol: string; name: string; address: `0x${string}`; kind?: StockTokenKind; decimals?: number };
  amount: string;
  /** The fee the payer funded on top; paid out only on claim, returned with a refund. */
  fee?: string;
  expiresAt: string;
  /** "settled": the escrow no longer holds it, because it was claimed or refunded. */
  status: "claimable" | "expired" | "settled";
  recipient?: { platform: StockClaimPlatform; username: string };
  /** Whether an open link waits for the recipient's account or for their name. */
  lock?: VaultLock;
  sourceIdentity?: { platform: string; username: string };
  fundingTransactionHash?: `0x${string}`;
};

/** One network's escrow deployment state, for the operator page. Addresses only; no secret leaves the server. */
export type StockEscrowDeployment = {
  network: StockNetworkId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  /** Some listed asset can move on this network: Stock Tokens, or USDG. */
  transfersEnabled: boolean;
  stockTransfersEnabled?: boolean;
  tokenTransfersEnabled?: boolean;
  verifier?: `0x${string}`;
  operator?: `0x${string}`;
  escrow?: { address: `0x${string}`; deploymentTransactionHash: `0x${string}`; blockNumber: string; registeredAt: string };
  /** The fee contracts behind the registered escrow, once verified on chain. */
  fees?: FeeSchedule;
  claims: StockClaimAvailability;
  /** Server settings the operator still needs, by environment variable name. */
  setup: string[];
};
