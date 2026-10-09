import { SOLANA_MAINNET, parseSolanaBrowserRpcUrl } from "./domain/solana-chains";

let choose: ((url: string) => void) | undefined;
const chosen = new Promise<string>((resolve) => { choose = resolve; });

/**
 * The desk hands over what `/api/providers` names as `solanaRpcUrl` (once, on load). A QuickNode Solana mainnet
 * endpoint is used; anything else, or nothing, leaves the public endpoint, which refuses requests from browsers.
 * Kept free of Solana's libraries so the desk's first chunk stays small.
 */
export function setPageSolanaRpc(value: unknown) {
  choose?.(parseSolanaBrowserRpcUrl(value) ?? SOLANA_MAINNET.rpcUrl);
  choose = undefined;
}

/** The Solana RPC this page reads and sends through, once the desk knows it. */
export function pageSolanaRpcUrl() {
  return chosen;
}
