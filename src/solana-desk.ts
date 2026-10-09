import { address, createSolanaRpc, getBase58Decoder, getBase64Encoder, type Rpc, type SolanaRpcApiMainnet } from "@solana/kit";
import { getMintDecoder } from "@solana-program/token-2022";
import { effectiveMultiplier } from "./domain/solana-amounts";
import { SOLANA_MAINNET } from "./domain/solana-chains";
import { vaultAssetByMint } from "./domain/solana-stocks";
import { matchesVaultAction, type PreparedSolanaVaultAction } from "./domain/solana-vault";
import { solanaReceiptSource, waitForTransactionReceipt } from "./domain/transaction-receipt";
import { reportSpClaim } from "./sp-desk";
import { pageSolanaRpcUrl } from "./solana-rpc";
import { connectStandardSolanaWallet, standardSolanaWallets, type SolanaWalletHandle } from "./wallet/solana-wallet";
import { privyControls } from "./wallet/wallet-bridge";

/** How many one-second polls a Solana transaction gets before the desk says it is still pending. */
const SOLANA_RECEIPT_ATTEMPTS = 90;

export const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
export const solanaTransactionUrl = (signature: string) => `${SOLANA_MAINNET.explorerUrl}/tx/${signature}`;

let connected: SolanaWalletHandle | undefined;

/** A client for the page's Solana RPC (see `solana-rpc.ts`): a QuickNode endpoint the server names. */
export async function pageSolanaRpc() {
  return createSolanaRpc(await pageSolanaRpcUrl()) as unknown as Rpc<SolanaRpcApiMainnet>;
}

/**
 * The multiplier a scaled xStock's wallet balance shows, read by the browser itself through the page's Solana RPC (not
 * through the server), so the units the server prepares can be checked against the amount the review shows.
 */
export async function readScaledMultiplier(mint: string) {
  const info = await (await pageSolanaRpc()).getAccountInfo(address(mint), { encoding: "base64", commitment: "confirmed" }).send();
  if (!info.value) throw new Error("The token could not be read from Solana. Try again.");
  const decoded = getMintDecoder().decode(getBase64Encoder().encode(info.value.data[0]));
  const extensions = decoded.extensions.__option === "Some" ? decoded.extensions.value : [];
  const scaled = extensions.find((extension) => extension.__kind === "ScaledUiAmountConfig");
  if (!scaled || scaled.__kind !== "ScaledUiAmountConfig") return 1;
  return effectiveMultiplier({ multiplier: scaled.multiplier, newMultiplier: scaled.newMultiplier, newMultiplierEffectiveTimestamp: BigInt(scaled.newMultiplierEffectiveTimestamp) }, BigInt(Math.floor(Date.now() / 1000)));
}

/**
 * The Solana wallet that signs for this account: the one whose address the account proved. Privy's wallet when the
 * person signed in through Privy, else a browser wallet (Phantom, Solflare, Backpack…) that holds that address.
 */
export async function solanaWalletFor(address: string | undefined): Promise<SolanaWalletHandle> {
  if (!address) throw new Error("Add a Solana address to your wallet first, under Identities.");
  const privy = privyControls();
  const fromPrivy = privy?.authenticated ? privy.solana() : undefined;
  if (fromPrivy?.address === address) return fromPrivy;
  if (connected?.address === address) return connected;
  // A wallet that already shows this address is asked first; the others only when none does.
  const holds = (wallet: ReturnType<typeof standardSolanaWallets>[number]) => wallet.accounts.some((account) => account.address === address);
  const wallets = standardSolanaWallets();
  for (const wallet of [...wallets.filter(holds), ...wallets.filter((wallet) => !holds(wallet))]) {
    try {
      const handle = await connectStandardSolanaWallet(wallet);
      if (handle.address === address) return (connected = handle);
    } catch {
      // Declined or unavailable: the next wallet is asked.
    }
  }
  throw new Error(`Open the Solana wallet with the address ${short(address)}, the one added to your HaPaPay wallet, and try again.`);
}

/** A Solana wallet to add to the account: Privy's when signed in through it, else the first browser wallet found. */
export async function solanaWalletToAdd(): Promise<SolanaWalletHandle> {
  const privy = privyControls();
  const fromPrivy = privy?.authenticated ? privy.solana() : undefined;
  if (fromPrivy) return fromPrivy;
  const [wallet] = standardSolanaWallets();
  if (!wallet) throw new Error("No Solana wallet was found. Sign in with HaPaPay's one-step sign-in, or install a Solana wallet such as Phantom or Solflare.");
  return (connected = await connectStandardSolanaWallet(wallet));
}

/**
 * Adds a Solana address to the session's account: the server writes a one-time message naming the account and the
 * address, this wallet signs it, and the server checks the signature. Nothing moves.
 */
/**
 * Adds a Solana address to the account: its wallet signs the server's message, and so does the account's own wallet
 * (`signWithWallet`) when the server asks, as it does once the sign-in is more than ten minutes old.
 */
export async function proveSolanaAddress(handle: SolanaWalletHandle, signWithWallet?: (message: string) => Promise<string>) {
  const challengeResponse = await fetch("/api/auth/solana/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: handle.address }) });
  const challenge = await challengeResponse.json().catch(() => ({})) as { id?: string; message?: string; error?: string; walletSignature?: boolean };
  if (!challengeResponse.ok || !challenge.id || !challenge.message) throw new Error(challenge.error ?? "The Solana address could not be checked. Try again.");
  const signature = await handle.signMessage(new TextEncoder().encode(challenge.message));
  if (challenge.walletSignature && !signWithWallet) throw new Error("Sign in again with your wallet, then add the Solana address.");
  const walletSignature = challenge.walletSignature ? await signWithWallet!(challenge.message) : undefined;
  const verifyResponse = await fetch("/api/auth/solana/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.id, signature: getBase58Decoder().decode(signature), ...(walletSignature ? { walletSignature } : {}) }),
  });
  const verified = await verifyResponse.json().catch(() => ({})) as { address?: string; error?: string };
  if (!verifyResponse.ok || verified.address !== handle.address) throw new Error(verified.error ?? "The Solana signature was not accepted. Try again.");
  return verified.address;
}

/** Signs and sends one prepared transaction (base64) with this wallet, then waits for Solana to confirm it. */
/**
 * Has the wallet sign and send one prepared transaction and waits for Solana to confirm it. With the prepared
 * `lastValidBlockHeight`, a transaction the network dropped ends the wait with `TransactionExpiredError` once it can
 * no longer land, so the caller can offer to sign it again.
 */
export async function sendSolanaTransaction(handle: SolanaWalletHandle, transaction: string, options: { onSubmitted?: (signature: string) => void; revertedMessage: string; lastValidBlockHeight?: string }) {
  const signature = await handle.signAndSend(new Uint8Array(getBase64Encoder().encode(transaction)));
  options.onSubmitted?.(signature);
  const receipt = await waitForTransactionReceipt(solanaReceiptSource(signature, options.lastValidBlockHeight), { attempts: SOLANA_RECEIPT_ATTEMPTS, revertedMessage: options.revertedMessage });
  return { signature, slot: BigInt(receipt.blockNumber) };
}

/**
 * Claims a Solana vault link for the session's account or takes one back: the server prepares the transaction (a
 * claim carries the attestor's signature), the browser rebuilds it from the link and the bundled asset list and opens
 * the wallet only when every byte matches.
 */
export async function signSolanaVaultAction(input: {
  paymentId: string;
  programId: string;
  mint: string;
  action: "claim" | "refund";
  solanaAddress?: string;
  eligibilityConfirmed?: boolean;
  onSubmitted?: (signature: string) => void;
}) {
  const asset = vaultAssetByMint(input.mint);
  if (!asset) throw new Error("This link does not hold a token on HaPaPay's Solana list. Nothing was signed.");
  const handle = await solanaWalletFor(input.solanaAddress);
  const response = await fetch(`/api/solana/claims/${input.paymentId}/prepare-${input.action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.action === "claim" ? { eligibilityConfirmed: input.eligibilityConfirmed === true } : {}),
  });
  const prepared = await response.json().catch(() => ({})) as PreparedSolanaVaultAction & { error?: string };
  if (!response.ok) throw new Error(prepared.error ?? `The ${input.action} could not be prepared. Try again.`);
  const matches = prepared.programId === input.programId && prepared.paymentId === input.paymentId && await matchesVaultAction(prepared, {
    programId: input.programId,
    wallet: handle.address,
    paymentId: input.paymentId,
    asset,
    payer: prepared.payer,
    treasury: prepared.treasury,
    action: input.action,
  });
  if (!matches) throw new Error(`The prepared ${input.action} does not match this link and your Solana address. Nothing was signed.`);
  const sent = await sendSolanaTransaction(handle, prepared.transaction, {
    onSubmitted: input.onSubmitted,
    revertedMessage: input.action === "claim" ? "The claim failed on Solana; the tokens are still in the vault." : "The refund failed on Solana; the tokens are still in the vault.",
  });
  // A claimed link earns SP for the claimer and its sender; the server reads the claim back from the program.
  if (input.action === "claim") void reportSpClaim({ network: "solana", paymentId: input.paymentId });
  return sent;
}
