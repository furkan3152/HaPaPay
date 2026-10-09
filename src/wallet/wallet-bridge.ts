import type { SolanaWalletHandle } from "./solana-wallet";

/** An EIP-1193 provider: Privy's (embedded or external) or the browser's own `window.ethereum`. */
export type Eip1193Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/**
 * What the Privy layer (src/wallet/PrivyBridge.tsx, loaded only when the server names a Privy app) hands the desk:
 * one sign-in for an EVM and a Solana wallet, and the wallets it signed in with.
 */
export type PrivyControls = {
  ready: boolean;
  authenticated: boolean;
  /** Opens Privy's sign-in and resolves once the person is signed in and an EVM wallet is ready. */
  login(): Promise<void>;
  logout(): Promise<void>;
  /** The EVM wallet the person signed in with (an external one if they chose it, else the embedded one). */
  evm(): Promise<{ address: string; provider: Eip1193Provider } | undefined>;
  /** Their Solana wallet, external or embedded, once Privy has it. */
  solana(): SolanaWalletHandle | undefined;
  /** The wallets Privy made for this sign-in (embedded), which only Privy's own window can export. */
  embedded(): { evm?: string; solana?: string };
  /**
   * Opens Privy's window that shows an embedded wallet's private key, so the person can take the wallet to Phantom
   * or MetaMask. The key loads in a frame
   * on Privy's own domain; the desk never sees it. Resolves when the window closes.
   */
  exportKey(family: "evm" | "solana", address: string): Promise<void>;
};

let privy: PrivyControls | undefined;
/** What the listeners last heard about: whether the layer is there, ready, signed in, and with which wallets. */
let heard = "";
let activeEvm: Eip1193Provider | undefined;
const listeners = new Set<() => void>();

/**
 * The Privy layer registers its controls, and `state` says what they stand for (ready, signed in, the wallets'
 * addresses). Listeners hear only when that changes: each one re-renders the desk, and a desk re-render renders the
 * Privy layer again, so calling them on every registration kept the desk rendering without end.
 */
export function registerPrivy(controls: PrivyControls | undefined, state = "") {
  privy = controls;
  const next = controls ? `loaded|${state}` : "";
  if (next === heard) return;
  heard = next;
  for (const listener of listeners) listener();
}

export function privyControls() {
  return privy;
}

/** Calls back whenever the Privy layer's state changes (loaded, ready, signed in, wallets). */
export function onPrivyChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The Privy layer once it has loaded and is ready to sign someone in, so a Connect pressed while it is still loading
 * opens the sign-in as soon as it can instead of asking for another press. Undefined if it is not ready in `timeout`
 * milliseconds.
 */
export function whenPrivyReady(timeout: number): Promise<PrivyControls | undefined> {
  if (privy?.ready) return Promise.resolve(privy);
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      stop();
      resolve(privy?.ready ? privy : undefined);
    };
    const stop = onPrivyChange(() => {
      if (privy?.ready) finish();
    });
    const timer = window.setTimeout(finish, timeout);
  });
}

/** The provider of the wallet the session was verified with, so every later signature comes from that wallet. */
export function setActiveEvmProvider(provider: Eip1193Provider | undefined) {
  activeEvm = provider;
}

/** The EVM provider the desk signs with: the wallet the person signed in with through Privy, else the browser's. */
export function evmProvider(): Eip1193Provider | undefined {
  return activeEvm ?? window.ethereum;
}
