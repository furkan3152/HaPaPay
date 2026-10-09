import { getWallets } from "@wallet-standard/app";
import { getBase58Decoder } from "@solana/kit";

/** Solana mainnet as Wallet Standard names it. */
export const SOLANA_WALLET_CHAIN = "solana:mainnet";

/**
 * A connected Solana wallet, wherever it comes from: Privy's (embedded, or an external wallet signed in through it)
 * or a browser wallet found through the Wallet Standard. The desk only signs a message to prove the address, and
 * signs and sends transactions it has already checked byte for byte; the wallet keeps its keys.
 */
export type SolanaWalletHandle = {
  address: string;
  name: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Signs and sends one prepared transaction (wire bytes) and returns its signature in base58. */
  signAndSend(transaction: Uint8Array): Promise<string>;
};

type StandardAccount = { address: string; chains: readonly string[] };
type StandardWallet = {
  name: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
};
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }> };
type SignMessageFeature = { signMessage(...inputs: Array<{ account: StandardAccount; message: Uint8Array }>): Promise<Array<{ signature: Uint8Array }>> };
type SignAndSendFeature = { signAndSendTransaction(...inputs: Array<{ account: StandardAccount; transaction: Uint8Array; chain: string }>): Promise<Array<{ signature: Uint8Array }>> };

const base58 = getBase58Decoder();

/** Browser wallets that can sign messages and send transactions on Solana mainnet (Phantom, Solflare, Backpack…). */
export function standardSolanaWallets(): StandardWallet[] {
  return (getWallets().get() as readonly StandardWallet[]).filter((wallet) => wallet.chains.includes(SOLANA_WALLET_CHAIN)
    && "standard:connect" in wallet.features && "solana:signMessage" in wallet.features && "solana:signAndSendTransaction" in wallet.features);
}

/** Asks a browser wallet for its Solana account and wraps it. */
export async function connectStandardSolanaWallet(wallet: StandardWallet): Promise<SolanaWalletHandle> {
  const { accounts } = await (wallet.features["standard:connect"] as ConnectFeature).connect();
  const account = accounts.find((entry) => entry.chains.includes(SOLANA_WALLET_CHAIN)) ?? accounts[0];
  if (!account) throw new Error(`${wallet.name} did not share a Solana account.`);
  return {
    address: account.address,
    name: wallet.name,
    async signMessage(message) {
      const [result] = await (wallet.features["solana:signMessage"] as SignMessageFeature).signMessage({ account, message });
      return result.signature;
    },
    async signAndSend(transaction) {
      const [result] = await (wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature).signAndSendTransaction({ account, transaction, chain: SOLANA_WALLET_CHAIN });
      return base58.decode(result.signature);
    },
  };
}

export function signatureText(signature: Uint8Array) {
  return base58.decode(signature);
}
