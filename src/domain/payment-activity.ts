import { platformName } from "./payment-intent.js";

export type PaymentHistoryItem = {
  transactionHash: string;
  direction: "sent" | "received";
  counterparty: string;
  platform: string;
  username: string;
  amount: string;
  blockNumber: string;
  confirmedAt: string;
  sourceIdentity?: { platform: string; username: string };
  /** Present on stock-token and Solana transfers; USDC payments on Arc carry no asset field. */
  asset?: { type: "stock-token"; symbol: string; address: string; chainId: number; network?: string } | { type: "solana"; symbol: string; mint: string; network: string };
  /** The note the payment carries on chain, as the server read it from the transaction. */
  note?: string;
};

/** The ticker shown next to an amount: the stock token's symbol, or USDC for Arc payments. */
export function paymentAssetSymbol(payment: PaymentHistoryItem) {
  return payment.asset?.symbol ?? "USDC";
}

export function paymentCounterparty(payment: PaymentHistoryItem): { label: string; platform?: string } {
  const identity = payment.direction === "sent" ? payment : payment.sourceIdentity;
  return identity
    ? { label: `@${identity.username.replace(/^@/, "")}`, platform: platformName(identity.platform) }
    : { label: payment.counterparty };
}

export type PaymentActivityDirection = "all" | PaymentHistoryItem["direction"];
export const paymentActivityPageSize = 5;

export function selectPaymentActivity(
  payments: readonly PaymentHistoryItem[],
  options: { direction?: PaymentActivityDirection; query?: string; limit?: number } = {},
) {
  const direction = options.direction ?? "all";
  const query = (options.query ?? "").trim().toLowerCase();
  const matches = payments.filter((payment) => {
    if (direction !== "all" && payment.direction !== direction) return false;
    const counterparty = paymentCounterparty(payment);
    return [counterparty.label, counterparty.platform ?? "", payment.counterparty, payment.transactionHash, paymentAssetSymbol(payment), payment.note ?? ""]
      .some((value) => value.toLowerCase().includes(query));
  });
  const items = matches.slice(0, options.limit ?? paymentActivityPageSize);
  return { items, total: matches.length, hasMore: items.length < matches.length };
}
