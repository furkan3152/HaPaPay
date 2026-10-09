import { randomBytes } from "node:crypto";
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { Platform } from "../src/domain/payment-intent";
import type { FeeSchedule } from "../src/domain/fees.js";
import { stockClaimEscrowAbi, stockTokenApproveAbi } from "../src/domain/stock-claims.js";
import { RecipientLookupUnavailableError, type DiscoveredRecipient } from "./recipient-discovery.js";
import { isStockClaimPlatform } from "../src/domain/stock-claims.js";
import type { VaultLock } from "../src/domain/vault-lock.js";
import { VaultNameLockOffer, vaultRecipient } from "./vault-recipient.js";
import { approvalCovers, preparedFee, quoteFee, StockTransferRejectedError, StockTransferUnavailableError, stockTokenTransferAbi, type StockChainClient } from "./stock-transfer-service.js";

type RecipientDirectory = {
  lookup(platform: Platform, username: string): Promise<DiscoveredRecipient>;
};

/**
 * The account or name a link waits for (`vaultRecipient`): a handle the platform does not know is the sender's to fix
 * (400); a platform that cannot answer now says so (503), in the directory's own words, which never carry a provider's
 * text, so a refusal never reaches the slip as a vague "could not be prepared"; X's offer of a name lock reaches the
 * slip as it is.
 */
async function recipientIdentity(directory: RecipientDirectory, platform: Platform, username: string, lock?: VaultLock) {
  if (!isStockClaimPlatform(platform)) throw new StockTransferRejectedError("Vault links go to GitHub, X, Farcaster, Discord or Telegram accounts.");
  try {
    return await vaultRecipient(directory, platform, username, lock);
  } catch (error) {
    if (error instanceof VaultNameLockOffer) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/was not found\.$|^Invalid (?:social|X|Farcaster|Discord|Telegram) username|\.eth names are ENS names|^Invite this person/.test(message)) throw new StockTransferRejectedError(message);
    if (error instanceof RecipientLookupUnavailableError) throw new StockTransferUnavailableError(message);
    throw new StockTransferUnavailableError("The account could not be looked up just now. Try again in a moment.");
  }
}

/**
 * Prepares an Arc vault link: USDC held in the reviewed StockClaimEscrow for someone who has not joined, waiting for
 * their account or their name (`vault-lock.ts`). The sender approves the amount plus the fee router's fee (read on chain
 * for this payer, never above 1%), then funds the link; the escrow pays the fee out only when the link is claimed and
 * returns it with a refund.
 */
export class ClaimablePaymentService {
  private readonly usdc: Address;
  private readonly escrow: Address;

  constructor(private readonly options: {
    usdc: Address;
    escrow: Address;
    fees: FeeSchedule;
    client: Pick<StockChainClient, "readContract">;
    chainName: string;
    directory: RecipientDirectory;
    /** The USDC (six decimals) the calls may spend on gas, which Arc takes from the same balance. */
    gasReserve?: (calls: { approvals: number; payments: number }) => Promise<bigint>;
    now?: () => Date;
    randomBytes32?: () => Hex;
  }) {
    this.usdc = getAddress(options.usdc);
    this.escrow = getAddress(options.escrow);
  }

  async prepare(input: {
    platform: Platform;
    username: string;
    amount: string;
    expiryHours: number;
    payer: Address;
    /** The reviewed lock: an X link waits for the name only when the review said so. */
    lock?: VaultLock;
  }) {
    if (!Number.isInteger(input.expiryHours) || input.expiryHours < 24 || input.expiryHours > 24 * 30) {
      throw new Error("Claim window must be between 24 hours and 30 days.");
    }
    if (!/^\d+(?:\.\d{1,6})?$/.test(input.amount)) throw new Error("Amount must use at most six decimal places.");
    const amount = parseUnits(input.amount, 6);
    if (amount <= 0n) throw new Error("Amount must be greater than zero.");

    const identity = await recipientIdentity(this.options.directory, input.platform, input.username, input.lock);
    const paymentId = this.options.randomBytes32?.() ?? `0x${randomBytes(32).toString("hex")}` as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(paymentId)) throw new Error("Invalid payment ID source.");
    const now = this.options.now?.() ?? new Date();
    const expiry = BigInt(Math.floor(now.getTime() / 1000) + input.expiryHours * 60 * 60);
    const platformHash = keccak256(stringToHex(identity.platform));
    const providerUserIdHash = keccak256(stringToHex(identity.providerUserId));
    const quote = await quoteFee(this.options.client as StockChainClient, this.options.fees, getAddress(input.payer), amount, this.options.chainName);
    // An approval left from an attempt whose second signature never came already covers this link.
    const approved = await approvalCovers(this.options.client, this.usdc, getAddress(input.payer), this.escrow, amount + quote.fee);
    // The wallet must hold the amount, the fee and the gas of both signatures, or the funding would revert after the
    // approval was paid for (audit, 2026-10-06).
    let balance: unknown;
    try {
      balance = await this.options.client.readContract({ address: this.usdc, abi: stockTokenTransferAbi, functionName: "balanceOf", args: [getAddress(input.payer)] });
    } catch {
      throw new StockTransferUnavailableError(`${this.options.chainName} is not reachable right now. Try again shortly.`);
    }
    const gas = await this.options.gasReserve?.({ approvals: approved ? 0 : 1, payments: 1 }).catch(() => 0n) ?? 0n;
    const needed = amount + quote.fee + gas;
    if (typeof balance !== "bigint" || balance < needed) {
      throw new StockTransferRejectedError(`Your wallet holds ${formatUnits(typeof balance === "bigint" ? balance : 0n, 6)} USDC; this link needs ${formatUnits(needed, 6)} USDC: the amount plus the fee${gas > 0n ? ` and about ${formatUnits(gas, 6)} USDC for gas, which Arc takes in USDC` : ""}.`);
    }

    return {
      paymentId,
      identity,
      amount: input.amount,
      expiresAt: new Date(Number(expiry) * 1000).toISOString(),
      claimPath: `/claim/${paymentId}`,
      escrow: this.escrow,
      fee: preparedFee(this.options.fees, quote, amount, 6),
      transactions: [
        ...(approved ? [] : [{
          purpose: "approve" as const,
          to: this.usdc,
          data: encodeFunctionData({ abi: stockTokenApproveAbi, functionName: "approve", args: [this.escrow, amount + quote.fee] }),
          value: "0x0" as const,
        }]),
        {
          purpose: "fund" as const,
          to: this.escrow,
          data: encodeFunctionData({
            abi: stockClaimEscrowAbi,
            functionName: "createPayment",
            args: [paymentId, this.usdc, platformHash, providerUserIdHash, amount, expiry],
          }),
          value: "0x0" as const,
        },
      ],
    };
  }
}
