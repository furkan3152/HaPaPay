import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import type { ArcNetworkId } from "../src/domain/arc-chains.js";
import { pagedPendingLinks, PENDING_CLAIMS_LIMIT, type PendingVaultLink } from "../src/domain/pending-claims.js";
import { isStockClaimPlatform, type StockClaimPlatform } from "../src/domain/stock-claims.js";
import type { ClaimFundingRecord, ClaimFundingRepository } from "./claim-funding-service.js";
import { StockClaimNotFoundError } from "./stock-claim-service.js";
import { StockTransferRejectedError, StockTransferUnavailableError } from "./stock-transfer-service.js";
import type { VerifiedSocialAccount } from "./verified-identity-service";
import { evmVaultSettlement, type SettlementReceipt, type VaultClaimCandidate, type VaultSettlement } from "./vault-settlement.js";
import { STOCK_CLAIM_MAX_WINDOW_SECONDS } from "../src/domain/stock-claims.js";
import { anyClaimsLink, identityKeysOf, linkMadeAt, lockOfLink, notTheNameHolder } from "./vault-recipient.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const claimActionsAbi = [
  {
    type: "function", name: "claim", stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }, { name: "recipient", type: "address" }, { name: "claimDeadline", type: "uint256" }, { name: "signature", type: "bytes" }], outputs: [],
  },
  {
    type: "function", name: "refund", stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }], outputs: [],
  },
] as const;

/** One vault link as the reviewed StockClaimEscrow stores it; on Arc its token is always USDC. */
type EscrowPayment = { payer: Address; token: Address; identityKey: Hex; amount: bigint; fee: bigint; expiry: bigint };

export class ClaimRedemptionService {
  private readonly escrow: Address;

  constructor(private readonly options: {
    chainId: number;
    escrow: Address;
    usdc: Address;
    attestor: LocalAccount;
    expectedVerifier?: Address;
    readPayment(paymentId: Hex): Promise<EscrowPayment>;
    /** A receipt with its logs, null while it is not mined: SP reads claims and fundings from them. */
    readReceipt?(hash: Hex): Promise<SettlementReceipt | null>;
    /** The funding records and the network name, for listing the links a wallet can act on. */
    records?: Pick<ClaimFundingRepository, "waitingFor" | "fundedBy"> & Partial<Pick<ClaimFundingRepository, "get">>;
    network?: { id: ArcNetworkId; name: string };
    now?: () => Date;
  }) {
    this.escrow = getAddress(options.escrow);
    if (options.expectedVerifier && getAddress(options.expectedVerifier) !== getAddress(options.attestor.address)) {
      throw new Error("Claim attestor does not match the escrow verifier.");
    }
  }

  /** The escrow's record of a link; an RPC that cannot answer is the network's, never the link's (no endpoint text). */
  private async read(paymentId: Hex) {
    try {
      return await this.options.readPayment(paymentId);
    } catch {
      throw new StockTransferUnavailableError(`${this.options.network?.name ?? "Arc"} could not be read just now. Try again in a moment.`);
    }
  }

  async details(paymentIdInput: string) {
    const paymentId = validPaymentId(paymentIdInput);
    const payment = await this.read(paymentId);
    ensurePayment(payment, getAddress(this.options.usdc));
    const now = BigInt(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000));
    // Whether the link waits for the account or for a name, from its record (`vault-lock.ts`).
    const record = await this.options.records?.get?.(this.options.chainId, paymentId.toLowerCase() as Hex).catch(() => undefined);
    return {
      paymentId,
      payer: getAddress(payment.payer),
      amount: formatUnits(payment.amount, 6),
      fee: formatUnits(payment.fee, 6),
      expiresAt: new Date(Number(payment.expiry) * 1000).toISOString(),
      status: now > payment.expiry ? "expired" as const : "claimable" as const,
      ...(record ? { lock: lockOfLink({ platform: record.recipientPlatform, username: record.recipientUsername }, payment.identityKey, keyFor) } : {}),
    };
  }

  async prepareClaim(inputWallet: string, accounts: VerifiedSocialAccount[], paymentIdInput: string) {
    const wallet = getAddress(inputWallet);
    const paymentId = validPaymentId(paymentIdInput);
    const payment = await this.read(paymentId);
    ensurePayment(payment, getAddress(this.options.usdc));
    const now = BigInt(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000));
    if (now > payment.expiry) throw new StockTransferRejectedError("Claim window has expired.");
    // The account the link waits for, or on Discord, Telegram and X the name, held by an account older than the link.
    const record = await this.options.records?.get?.(this.options.chainId, paymentId.toLowerCase() as Hex).catch(() => undefined);
    if (!anyClaimsLink(accounts, payment.identityKey, keyFor, linkMadeAt(record, payment.expiry, STOCK_CLAIM_MAX_WINDOW_SECONDS))) {
      throw new StockTransferRejectedError(record && lockOfLink({ platform: record.recipientPlatform, username: record.recipientUsername }, payment.identityKey, keyFor) === "name"
        ? notTheNameHolder(record.recipientPlatform, record.recipientUsername)
        : "Your OAuth-verified identities do not match this payment.");
    }
    const claimDeadline = now + 600n < payment.expiry ? now + 600n : payment.expiry;
    // The escrow's attestation: chain, escrow, payment, immutable identity, token, recipient wallet, amount, expiry
    // and a claim deadline at most ten minutes away.
    const attestation = keccak256(encodeAbiParameters(
      parseAbiParameters("uint256, address, bytes32, bytes32, address, address, uint256, uint256, uint256"),
      [BigInt(this.options.chainId), this.escrow, paymentId, payment.identityKey, payment.token, wallet, payment.amount, payment.expiry, claimDeadline],
    ));
    const signature = await this.options.attestor.signMessage({ message: { raw: attestation } });
    return {
      paymentId,
      claimDeadline: claimDeadline.toString(),
      transaction: {
        from: wallet,
        to: this.escrow,
        data: encodeFunctionData({ abi: claimActionsAbi, functionName: "claim", args: [paymentId, wallet, claimDeadline, signature] }),
        value: "0x0" as const,
      },
    };
  }

  /**
   * The Arc vault links this wallet can act on, each read back from the escrow so nothing is listed that it no
   * longer holds: links sent to one of its verified accounts, or to its name, whose window is open, and links
   * it funded that are still in the vault. A link locked to another account (the handle changed hands) or holding
   * anything but USDC is left out; an unreachable chain fails the whole list rather than guessing.
   */
  async pending(input: { wallet: string; accounts: VerifiedSocialAccount[]; limit?: number }): Promise<{ incoming: PendingVaultLink[]; outgoing: PendingVaultLink[] }> {
    const { records, network } = this.options;
    if (!records || !network) return { incoming: [], outgoing: [] };
    const wallet = getAddress(input.wallet);
    const usdc = getAddress(this.options.usdc);
    const limit = input.limit ?? PENDING_CLAIMS_LIMIT;
    const now = BigInt(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000));
    const vaultAccounts = input.accounts.filter((account): account is VerifiedSocialAccount & { platform: StockClaimPlatform } => isStockClaimPlatform(account.platform));
    const recipients = vaultAccounts.map(({ platform, username }) => ({ platform, username }));
    const reads = new Map<string, Promise<EscrowPayment>>();
    const read = (paymentId: Hex) => {
      const key = paymentId.toLowerCase();
      const known = reads.get(key);
      if (known) return known;
      const payment = this.options.readPayment(paymentId);
      reads.set(key, payment);
      return payment;
    };
    const holdsUsdc = (payment: EscrowPayment) => payment.payer.toLowerCase() !== ZERO_ADDRESS && payment.amount > 0n && getAddress(payment.token) === usdc;
    const view = (record: ClaimFundingRecord, payment: EscrowPayment, status: PendingVaultLink["status"]): PendingVaultLink => ({
      network: network.id,
      chainId: this.options.chainId,
      chainName: network.name,
      paymentId: record.paymentId,
      escrow: this.escrow,
      token: { symbol: "USDC", name: "USDC", address: usdc, decimals: 6 },
      amount: formatUnits(payment.amount, 6),
      recipient: { platform: record.recipientPlatform, username: record.recipientUsername },
      sender: { wallet: getAddress(payment.payer), ...(record.sourceIdentity ? { platform: record.sourceIdentity.platform, username: record.sourceIdentity.username } : {}) },
      expiresAt: new Date(Number(payment.expiry) * 1000).toISOString(),
      status,
      claimPath: `/claim/${record.paymentId}`,
    });
    return pagedPendingLinks({
      limit,
      waitingFor: (offset) => records.waitingFor(this.options.chainId, recipients, now, limit, offset),
      fundedBy: (offset) => records.fundedBy(this.options.chainId, wallet, limit, offset),
      check: async (waiting, funded) => ({
        incoming: (await Promise.all(waiting.map(async (record) => {
          const payment = await read(record.paymentId);
          const mine = anyClaimsLink(vaultAccounts, payment.identityKey, keyFor, linkMadeAt(record, payment.expiry, STOCK_CLAIM_MAX_WINDOW_SECONDS));
          return holdsUsdc(payment) && now <= payment.expiry && mine ? view(record, payment, "claimable") : undefined;
        }))).filter((link): link is PendingVaultLink => link !== undefined),
        outgoing: (await Promise.all(funded.map(async (record) => {
          const payment = await read(record.paymentId);
          return holdsUsdc(payment) && getAddress(payment.payer) === wallet ? view(record, payment, now > payment.expiry ? "refundable" : "waiting") : undefined;
        }))).filter((link): link is PendingVaultLink => link !== undefined),
      }),
    });
  }

  /** For SP: how a recorded link ended and who claimed it, from the escrow and the receipts (`evmVaultSettlement`). */
  async settlement(record: Pick<ClaimFundingRecord, "paymentId" | "expiry" | "transactionHash">, input: { claimTransaction?: Hex; candidates: readonly VaultClaimCandidate[] }): Promise<VaultSettlement> {
    const readReceipt = this.options.readReceipt;
    if (!readReceipt) return { state: "unknown" };
    return evmVaultSettlement({
      escrow: this.escrow,
      paymentId: record.paymentId,
      expiry: record.expiry,
      fundingTransaction: record.transactionHash,
      claimTransaction: input.claimTransaction,
      candidates: input.candidates,
      now: BigInt(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000)),
      readPayer: async () => getAddress((await this.options.readPayment(record.paymentId)).payer),
      readReceipt,
      identityKeys: (account) => identityKeysOf(account, keyFor),
    });
  }

  async prepareRefund(inputWallet: string, paymentIdInput: string) {
    const wallet = getAddress(inputWallet);
    const paymentId = validPaymentId(paymentIdInput);
    const payment = await this.read(paymentId);
    ensurePayment(payment, getAddress(this.options.usdc));
    if (getAddress(payment.payer) !== wallet) throw new StockTransferRejectedError("Only the payer can refund this payment.");
    const now = BigInt(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000));
    if (now <= payment.expiry) throw new StockTransferRejectedError("Refund is not available before the claim window expires.");
    return {
      paymentId,
      transaction: {
        from: wallet,
        to: this.escrow,
        data: encodeFunctionData({ abi: claimActionsAbi, functionName: "refund", args: [paymentId] }),
        value: "0x0" as const,
      },
    };
  }
}

/** A link's identity key as the escrow derives it, for a platform and a lock ID (an account ID, or a name). */
function keyFor(platform: StockClaimPlatform, lockId: string) {
  const platformHash = keccak256(stringToHex(platform.toLowerCase()));
  const providerUserIdHash = keccak256(stringToHex(lockId));
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [platformHash, providerUserIdHash])).toLowerCase();
}

function validPaymentId(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new StockTransferRejectedError("Invalid claim payment ID.");
  return value as Hex;
}

function ensurePayment(payment: EscrowPayment, usdc: Address) {
  if (payment.payer.toLowerCase() === ZERO_ADDRESS || payment.amount <= 0n) throw new StockClaimNotFoundError("Claimable payment is unavailable.");
  if (getAddress(payment.token) !== usdc) throw new StockClaimNotFoundError("Claimable payment is not an Arc USDC link.");
}
