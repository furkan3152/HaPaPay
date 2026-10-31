import { memo, useEffect, useMemo, useRef } from "react";
import { PrivyProvider, useExportWallet, useLogin, usePrivy, useWallets, type ConnectedWallet, type PrivyClientConfig, type User } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { ELYSIUM_TESTNET, HYPE } from "../domain/elysium";
import { registerPrivy, type PrivyControls } from "./wallet-bridge";

// The chain an embedded wallet signs for, from the bundled constants only. Mainnet joins once its RPC is published.
const elysiumTestnet = defineChain({
  id: ELYSIUM_TESTNET.chainId,
  name: ELYSIUM_TESTNET.chainName,
  nativeCurrency: HYPE,
  rpcUrls: { default: { http: [ELYSIUM_TESTNET.rpcUrl!] } },
  blockExplorers: { default: { name: "Elysium explorer", url: ELYSIUM_TESTNET.explorerUrl! } },
  testnet: true,
});

/** The wallet a person signed in with, else the embedded one Privy made for them. */
function evmWallet(wallets: ConnectedWallet[], user: User | null) {
  const signedInWith = user?.wallet?.chainType === "ethereum" ? user.wallet.address.toLowerCase() : undefined;
  return wallets.find((wallet) => wallet.address.toLowerCase() === signedInWith)
    ?? wallets.find((wallet) => wallet.walletClientType === "privy")
    ?? wallets[0];
}

const embeddedWallet = (wallets: ConnectedWallet[]) => wallets.find((wallet) => wallet.walletClientType === "privy")?.address;

function Bridge() {
  const { ready, authenticated, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const pending = useRef<{ resolve: () => void; reject: (error: Error) => void }>();
  const loginEvents = useMemo(() => ({
    onError: (error: unknown) => {
      pending.current?.reject(new Error(error === "exited_auth_flow" ? "Sign-in was closed, so nothing was connected." : "The sign-in did not finish. Try again."));
      pending.current = undefined;
    },
  }), []);
  const { login } = useLogin(loginEvents);
  const { exportWallet } = useExportWallet();
  const latest = useRef({ ready, authenticated, wallets, user, login, logout, exportWallet });
  latest.current = { ready, authenticated, wallets, user, login, logout, exportWallet };
  const evmAddress = evmWallet(wallets, user)?.address ?? "";
  const embedded = embeddedWallet(wallets);

  useEffect(() => {
    if (pending.current && authenticated && evmAddress) {
      pending.current.resolve();
      pending.current = undefined;
    }
  }, [authenticated, evmAddress]);

  const controls = useMemo<PrivyControls>(() => ({
    get ready() {
      return latest.current.ready;
    },
    get authenticated() {
      return latest.current.authenticated;
    },
    login: () => new Promise<void>((resolve, reject) => {
      const now = latest.current;
      if (now.authenticated && evmWallet(now.wallets, now.user)) return resolve();
      pending.current?.reject(new Error("A newer sign-in replaced this one."));
      pending.current = { resolve, reject };
      if (!now.authenticated) now.login();
    }),
    logout: async () => {
      pending.current = undefined;
      await latest.current.logout();
    },
    evm: async () => {
      const wallet = evmWallet(latest.current.wallets, latest.current.user);
      return wallet ? { address: wallet.address, provider: await wallet.getEthereumProvider() } : undefined;
    },
    solana: () => undefined,
    embedded: () => ({ evm: embeddedWallet(latest.current.wallets) }),
    exportKey: async (_family, address) => {
      const now = latest.current;
      if (!now.authenticated || embeddedWallet(now.wallets)?.toLowerCase() !== address.toLowerCase()) throw new Error("Only a wallet Privy made for this sign-in can be exported here.");
      await now.exportWallet({ address });
    },
  }), []);
  useEffect(() => registerPrivy(controls, `${ready}|${authenticated}|${evmAddress}|${embedded ?? ""}`), [controls, ready, authenticated, evmAddress, embedded]);
  useEffect(() => () => registerPrivy(undefined), []);
  return null;
}

/**
 * One sign-in for ElysaPay: email, social login or an existing wallet gives an EVM wallet (embedded, or the external one
 * the person connects) on Elysium. This chunk loads only when the server names a Privy app; without one the site uses
 * browser wallets. The config is made once per theme, so Privy does not start its work over on every render.
 */
function PrivyBridge({ appId, theme }: { appId: string; theme: "dark" | "light" }) {
  const config = useMemo<PrivyClientConfig>(() => ({
    appearance: {
      theme,
      accentColor: "#7CF2D4",
      walletChainType: "ethereum-only",
      landingHeader: "Sign in to ElysaPay",
      loginMessage: "Pay anyone on Elysium by their handle.",
    },
    embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
    supportedChains: [elysiumTestnet],
    defaultChain: elysiumTestnet,
  }), [theme]);
  return <PrivyProvider appId={appId} config={config}>
    <Bridge />
  </PrivyProvider>;
}

export default memo(PrivyBridge);
