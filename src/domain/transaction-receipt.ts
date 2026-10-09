type Receipt = { status: string; blockNumber: string };
/** The one wallet call a receipt source may fall back to. */
type ReceiptWallet = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };

/**
 * Polls for a receipt and returns it once it succeeded, with its status normalized to "confirmed". Every other field
 * the source returned is kept, so a deployment's `contractAddress` reaches the caller.
 */
export async function waitForTransactionReceipt<R extends Receipt>(
  getReceipt: () => Promise<R | null>,
  options: { attempts?: number; intervalMs?: number; revertedMessage?: string } = {},
): Promise<Omit<R, "status"> & { status: "confirmed"; blockNumber: string }> {
  const attempts = options.attempts ?? 30;
  const intervalMs = options.intervalMs ?? 1_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const receipt = await getReceipt();
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(options.revertedMessage ?? "Arc transaction reverted; payment was not completed.");
      return { ...receipt, status: "confirmed" as const, blockNumber: receipt.blockNumber };
    }
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("Transaction is still pending. Check the explorer before retrying.");
}

/**
 * A receipt source for `waitForTransactionReceipt` that asks this server's RPC first (`/api/receipts/{chain}/{hash}`,
 * which answers only for the session wallet's own transactions) and the wallet's RPC when the server has no receipt
 * yet or cannot answer. A wallet app that never reports receipts, or one whose RPC lags, cannot stall a payment, and a
 * read that fails counts as not mined yet, so the next poll asks again.
 */
export function receiptSource<R extends Receipt = Receipt & { contractAddress?: string | null }>(
  chain: string,
  hash: string,
  wallet?: ReceiptWallet,
  fetcher: typeof fetch = (...input) => fetch(...input),
) {
  return async (): Promise<R | null> => {
    try {
      const response = await fetcher(`/api/receipts/${chain}/${hash}`, { cache: "no-store" });
      if (response.ok) {
        const { receipt } = await response.json() as { receipt?: R | null };
        if (receipt) return receipt;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // The wallet's own RPC is asked below.
    }
    try {
      return (await wallet?.request({ method: "eth_getTransactionReceipt", params: [hash] }) as R | null | undefined) ?? null;
    } catch {
      return null;
    }
  };
}

/** A Solana transaction whose blockhash ran out before it landed: it never will, so nothing moved. */
export const SOLANA_TRANSACTION_EXPIRED = "The transaction expired before it reached Solana, so nothing moved.";

export class TransactionExpiredError extends Error {
  constructor() {
    super(SOLANA_TRANSACTION_EXPIRED);
    this.name = "TransactionExpiredError";
  }
}

/**
 * A receipt source for a Solana signature: this server's read of it, which also answers `expired` once the blocks the
 * transaction's blockhash allowed are final without it, and then throws `TransactionExpiredError` (audit, 2026-10-06:
 * a transaction the network dropped left its slip on "Verify again" for good). A read that fails counts as not landed
 * yet, so the next poll asks again.
 */
export function solanaReceiptSource(signature: string, lastValidBlockHeight?: string, fetcher: typeof fetch = (...input) => fetch(...input)) {
  const query = lastValidBlockHeight && /^\d{1,20}$/.test(lastValidBlockHeight) ? `?lastValidBlockHeight=${lastValidBlockHeight}` : "";
  return async (): Promise<Receipt | null> => {
    let answer: { receipt?: Receipt | null; expired?: boolean } | undefined;
    try {
      const response = await fetcher(`/api/receipts/solana/${signature}${query}`, { cache: "no-store" });
      if (response.ok) answer = await response.json() as typeof answer;
      else await response.body?.cancel();
    } catch {
      return null;
    }
    if (answer?.expired === true) throw new TransactionExpiredError();
    return answer?.receipt ?? null;
  };
}
