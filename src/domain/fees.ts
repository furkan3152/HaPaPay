import { parseAbi } from "viem";

/**
 * The HaPaPay fee: 1% of every Robinhood Chain payment and vault link, paid by the
 * sender on top of the amount, so the recipient always receives exactly what was asked. Half of each fee goes to the
 * burn vault, which can only turn what it holds into the burn token the operator names and burn it; the other half
 * goes to the operator's treasury wallet. The fee router enforces this on chain; these constants let the browser bound what
 * the server prepares.
 */
export const PLATFORM_FEE_BPS = 100n;
export const PLATFORM_FEE_BURN_SHARE_BPS = 5_000n;
const BPS = 10_000n;

/** The security revisions the reviewed fee contracts report. Any other value is refused. */
export const PAY_ROUTER_REVISION = 1n;
export const BURN_VAULT_REVISION = 1n;
export const FEE_FORWARDER_REVISION = 1n;

/** The fee on `units` at the full rate, rounded down like the router. A holder rate is never higher. */
export function platformFee(units: bigint, bps: bigint = PLATFORM_FEE_BPS) {
  return units * bps / BPS;
}

/** The burn vault's half (rounded down) and the treasury's remainder, as the router splits them. */
export function splitPlatformFee(fee: bigint) {
  const burnShare = fee * PLATFORM_FEE_BURN_SHARE_BPS / BPS;
  return { burnShare, treasuryShare: fee - burnShare };
}

/** "1%" for 100 basis points, "0.5%" for 50. */
export function platformFeePercent(bps: number) {
  return `${bps / 100}%`;
}

/** A network's fee contracts, as the server verified them behind the registered vault escrow. Addresses only. */
export type FeeSchedule = {
  router: `0x${string}`;
  /** Where the router pays the burn half: the burn vault, or on Arc the fee forwarder (see `sink`). */
  burnVault: `0x${string}`;
  treasury: `0x${string}`;
  feeBps: number;
  burnShareBps: number;
  /** The burn vault's burn token, once the operator has set it; until then nothing leaves the vault. */
  burnToken?: `0x${string}`;
  /**
   * "forwarder" on Arc, where nothing is bought and burned on chain: the burn half goes to HaPaPayFeeForwarder,
   * which can only pass it on to the treasury, so the whole fee reaches the operator.
   */
  sink?: "forwarder";
};

/** The fee on one prepared payment: what the router will take on top of the amount, and where it goes. */
export type PreparedPlatformFee = {
  router: `0x${string}`;
  feeBps: number;
  units: string;
  amount: string;
  burnShare: string;
  treasuryShare: string;
  /** Amount plus fee, in base units: the most the sender's wallet is asked to approve and pay. */
  totalUnits: string;
  totalAmount: string;
};

/** The browser accepts a prepared fee only when it adds up and is no more than 1% of the amount. */
export function isPreparedFeeWithinSchedule(fee: PreparedPlatformFee, units: bigint) {
  try {
    const feeUnits = BigInt(fee.units);
    const { burnShare, treasuryShare } = splitPlatformFee(feeUnits);
    return feeUnits >= 0n
      && feeUnits <= platformFee(units)
      && BigInt(fee.totalUnits) === units + feeUnits
      && BigInt(fee.burnShare) === burnShare
      && BigInt(fee.treasuryShare) === treasuryShare
      && fee.feeBps >= 0 && fee.feeBps <= Number(PLATFORM_FEE_BPS);
  } catch {
    return false;
  }
}

export const payRouterAbi = parseAbi([
  "constructor(address initialBurnVault, address initialTreasury)",
  "function FEE_BPS() view returns (uint256)",
  "function BURN_SHARE_BPS() view returns (uint256)",
  "function owner() view returns (address)",
  "function burnVault() view returns (address)",
  "function treasury() view returns (address)",
  "function passToken() view returns (address)",
  "function passMinimum() view returns (uint256)",
  "function passFeeBps() view returns (uint256)",
  "function securityRevision() pure returns (uint256)",
  "function transferOwnership(address newOwner)",
  "function setPass(address token, uint256 minimum, uint256 feeBps)",
  "function feeBpsFor(address payer) view returns (uint256 bps)",
  "function feeFor(address payer, uint256 amount) view returns (uint256)",
  "function splitFee(uint256 fee) pure returns (uint256 burnShare, uint256 treasuryShare)",
  "function pay(address token, address recipient, uint256 amount, bytes32 paymentRef) returns (uint256 fee)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event PassUpdated(address indexed token, uint256 minimum, uint256 feeBps)",
  "event Paid(bytes32 indexed paymentRef, address indexed payer, address indexed recipient, address token, uint256 amount, uint256 fee, uint256 burnShare, uint256 treasuryShare)",
  "error NotOwner()",
  "error InvalidAddress()",
  "error InvalidToken()",
  "error InvalidAmount()",
  "error InvalidFee()",
  "error PassTokenFixed()",
  "error TransferFailed()",
  "error TransferAmountMismatch()",
  "error ReentrantCall()",
]);

export const feeForwarderAbi = parseAbi([
  "constructor(address initialTreasury)",
  "function treasury() view returns (address)",
  "function securityRevision() pure returns (uint256)",
  "function forward(address token) returns (uint256 amount)",
  "event Forwarded(address indexed token, address indexed treasury, uint256 amount)",
  "error InvalidAddress()",
  "error InvalidToken()",
  "error TransferFailed()",
  "error TransferAmountMismatch()",
  "error ReentrantCall()",
]);

export const burnVaultAbi = parseAbi([
  "constructor()",
  "function BURN_ADDRESS() view returns (address)",
  "function owner() view returns (address)",
  "function burnToken() view returns (address)",
  "function securityRevision() pure returns (uint256)",
  "function transferOwnership(address newOwner)",
  "function setBurnToken(address token)",
  "function buyAndBurn(address tokenIn, uint256 amountIn, address target, bytes data, uint256 minBurnTokenOut) returns (uint256 burned)",
  "function burn() returns (uint256 burned)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event BurnTokenSet(address indexed token)",
  "event Swapped(address indexed tokenIn, uint256 amountIn, address indexed target, uint256 burnTokenOut)",
  "event Burned(address indexed token, uint256 amount)",
  "error NotOwner()",
  "error InvalidAddress()",
  "error InvalidToken()",
  "error InvalidTarget()",
  "error InvalidAmount()",
  "error BurnTokenAlreadySet()",
  "error BurnTokenNotSet()",
  "error InsufficientBalance()",
  "error InsufficientOutput()",
  "error OverSpent()",
  "error TransferFailed()",
  "error TransferAmountMismatch()",
  "error ReentrantCall()",
]);
