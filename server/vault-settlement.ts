import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { stockClaimEscrowAbi } from "../src/domain/stock-claims.js";
import type { VerifiedSocialAccount } from "./verified-identity-service";

/**
 * How a vault link this server recorded ended, read from its chain, so SP is awarded once a link is claimed. Claims
 * and refunds are not recorded anywhere else: the escrow and the Solana program are the record. `claimer` is the
 * account (EVM wallet) that claimed, when the chain shows it; null when it cannot be told.
 */
export type VaultSettlement =
  | { state: "open" }
  | { state: "claimed"; claimer: Address | null }
  | { state: "refunded" }
  | { state: "unknown" };

/** A wallet that may have claimed a link, with the verified accounts a link can be locked to. */
export type VaultClaimCandidate = { wallet: Address; accounts: readonly VerifiedSocialAccount[] };

/**
 * A link the escrow no longer holds at least this long before its expiry was claimed: a refund needs the window
 * closed, and a block's time is never this far ahead of the server's clock.
 */
export const SETTLED_BEFORE_EXPIRY_MARGIN_SECONDS = 900n;

type ReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex };
export type SettlementReceipt = { status: "success" | "reverted"; from: Address; logs?: readonly ReceiptLog[] };

/** The escrow's event of this name for this payment in a receipt, if it is there. */
export function escrowEvent(receipt: SettlementReceipt, escrow: Address, paymentId: Hex, name: "PaymentCreated" | "PaymentClaimed") {
  for (const log of receipt.logs ?? []) {
    if (getAddress(log.address) !== getAddress(escrow)) continue;
    let event;
    try {
      event = decodeEventLog({ abi: stockClaimEscrowAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (event.eventName === name && event.args.paymentId.toLowerCase() === paymentId.toLowerCase()) return event;
  }
  return undefined;
}

/**
 * A link in the reviewed StockClaimEscrow (Arc and Robinhood Chain). The claim transaction, when the claimer reports
 * it, names the claimer in its PaymentClaimed event. Without one, a link the escrow no longer holds while its window
 * is open was claimed, and its funding transaction names the account it was locked to; whichever candidate holds that
 * account claimed it. After the window, claimed and refunded look the same in the escrow, so the answer is unknown.
 */
export async function evmVaultSettlement(input: {
  escrow: Address;
  paymentId: Hex;
  expiry: bigint;
  fundingTransaction: Hex;
  claimTransaction?: Hex;
  candidates: readonly VaultClaimCandidate[];
  now: bigint;
  readPayer(): Promise<Address>;
  readReceipt(hash: Hex): Promise<SettlementReceipt | null>;
  /** Every identity key a link to this account can carry: its account's, and its name's where links wait for names. */
  identityKeys(account: VerifiedSocialAccount): string[];
}): Promise<VaultSettlement> {
  if (input.claimTransaction) {
    const receipt = await input.readReceipt(input.claimTransaction);
    if (receipt?.status === "success") {
      const claimed = escrowEvent(receipt, input.escrow, input.paymentId, "PaymentClaimed");
      if (claimed?.eventName === "PaymentClaimed") return { state: "claimed", claimer: getAddress(claimed.args.recipient) };
    }
  }
  const payer = await input.readPayer();
  if (payer !== "0x0000000000000000000000000000000000000000") return { state: "open" };
  if (input.now + SETTLED_BEFORE_EXPIRY_MARGIN_SECONDS >= input.expiry) return { state: "unknown" };
  const funding = await input.readReceipt(input.fundingTransaction);
  const created = funding?.status === "success" ? escrowEvent(funding, input.escrow, input.paymentId, "PaymentCreated") : undefined;
  // Not funded in this escrow (the network's escrow changed since): nothing can be told from it.
  if (created?.eventName !== "PaymentCreated") return { state: "unknown" };
  const key = created.args.identityKey.toLowerCase();
  const claimer = input.candidates.find((candidate) => candidate.accounts.some((account) => input.identityKeys(account).some((candidateKey) => candidateKey.toLowerCase() === key)));
  return { state: "claimed", claimer: claimer?.wallet ?? null };
}
