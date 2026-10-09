import { getAddress, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";

/** What the server reads of a transaction receipt: its outcome, block, sender and any contract it created. */
export type ChainReceipt = { status: "success" | "reverted"; blockNumber: bigint; from: Address; contractAddress?: Address | null };

/** A receipt reader over a viem client: null while the RPC has not seen the transaction mined. */
export function receiptReader<R extends ChainReceipt>(client: { getTransactionReceipt(input: { hash: Hex }): Promise<R> }) {
  return async ({ hash }: { hash: Hex }): Promise<R | null> => {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  };
}

/** A receipt as the browser polls it, in the wallet's own JSON-RPC shape: hex status and block, the created contract. */
export function receiptView(receipt: ChainReceipt | null) {
  return receipt && {
    status: receipt.status === "success" ? "0x1" as const : "0x0" as const,
    blockNumber: `0x${receipt.blockNumber.toString(16)}`,
    contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null,
  };
}

export const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
