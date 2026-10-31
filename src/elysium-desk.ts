import { createPublicClient, custom, type Hex } from "viem";
import { elysiumWalletChain, type ElysiumNetworkView } from "./domain/elysium";
import type { Eip1193Provider } from "./wallet/wallet-bridge";

/**
 * The browser's side of Elysium: switching the wallet to an Elysium network, sending a transaction the server prepared
 * or the admin console built, and reading contracts through the wallet's own RPC (the page itself never connects to an
 * Elysium RPC, so the content security policy stays as it is).
 */

const chainIdOf = async (provider: Eip1193Provider) => Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);

/** Moves the wallet to the network, adding it first when the wallet does not know it yet. */
export async function switchToElysium(provider: Eip1193Provider, view: ElysiumNetworkView) {
  if (await chainIdOf(provider) === view.chainId) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: view.chainIdHex }] });
  } catch (error) {
    const code = (error as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((error as Error).message))) throw error;
    if (!view.rpcUrl) throw new Error(`${view.chainName} has no public RPC yet, so the wallet cannot add it.`);
    await provider.request({ method: "wallet_addEthereumChain", params: [elysiumWalletChain(view)] });
  }
  if (await chainIdOf(provider) !== view.chainId) throw new Error(`Your wallet is not on ${view.chainName}. Switch it there and try again.`);
}

/** Opens the wallet for one transaction and returns its hash. Gas is left to the wallet unless the server estimated it. */
export async function sendElysiumTransaction(provider: Eip1193Provider, from: string, view: ElysiumNetworkView, call: { to?: string; data: Hex; value?: bigint; gas?: bigint }) {
  await switchToElysium(provider, view);
  const params: Record<string, string> = { from, data: call.data };
  if (call.to) params.to = call.to;
  if (call.value) params.value = `0x${call.value.toString(16)}`;
  if (call.gas) params.gas = `0x${call.gas.toString(16)}`;
  return await provider.request({ method: "eth_sendTransaction", params: [params] }) as Hex;
}

/** Reads through the wallet's RPC (the wallet must be on the network). */
export function walletReader(provider: Eip1193Provider) {
  return createPublicClient({ transport: custom(provider) });
}

/** Asks the server until it reads the transaction's receipt; Elysium blocks come every ~100 ms, so this is quick. */
export async function waitForServer<T extends { status: string }>(read: () => Promise<T>, tries = 40, pause = 1_500): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const result = await read();
    if (result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error("The transaction was sent but is not confirmed yet. It will appear once the chain confirms it.");
}

export async function elysiumApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `The request failed (${response.status}).`);
  return result;
}
