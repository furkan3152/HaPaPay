import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ElysiumMarket, ElysiumNetworkId, ElysiumNetworkView } from "../domain/elysium";
import type { Platform } from "../domain/payment-intent";
import { evmProvider, privyControls, setActiveEvmProvider, whenPrivyReady } from "../wallet/wallet-bridge";
import { api } from "./api";

const PrivyBridge = lazy(() => import("../wallet/PrivyBridge"));

export type LinkedAccount = { platform: Platform; username: string; verified: true };
export type Provider = { id: Platform; name: string; configured: boolean; method: string; botUsername?: string; botId?: string };

type SessionValue = {
  wallet?: string;
  status: "loading" | "anonymous" | "connecting" | "ready";
  accounts: LinkedAccount[];
  providers: Provider[];
  networks?: ElysiumNetworkView[];
  network?: ElysiumNetworkView;
  networkId: ElysiumNetworkId;
  setNetworkId(id: ElysiumNetworkId): void;
  paused?: string;
  hype?: ElysiumMarket;
  markets?: ElysiumMarket[];
  notice?: string;
  setNotice(text?: string): void;
  connect(): Promise<string | undefined>;
  disconnect(): Promise<void>;
  refreshProfile(): Promise<void>;
};

const Session = createContext<SessionValue | undefined>(undefined);
export const useSession = () => {
  const value = useContext(Session);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
};

/**
 * The visitor's session: the wallet that signed the server's challenge, the social accounts linked to it, the Elysium
 * networks this server opens (and which one is chosen), and Hyperliquid's HYPE mid. Signing in uses Privy when the
 * server names a Privy app, else the browser's wallet; either way the session is that wallet's signature.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<string>();
  const [status, setStatus] = useState<SessionValue["status"]>("loading");
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [privyAppId, setPrivyAppId] = useState<string>();
  const [networks, setNetworks] = useState<ElysiumNetworkView[]>();
  const [paused, setPaused] = useState<string>();
  const [markets, setMarkets] = useState<ElysiumMarket[]>();
  const [notice, setNotice] = useState<string>();
  const [networkId, setNetworkIdState] = useState<ElysiumNetworkId>(() => (sessionStorage.getItem("elysa.network") as ElysiumNetworkId | null) ?? "elysium-testnet");
  const providersRequest = useRef<Promise<{ privyAppId: string | null }>>();

  const refreshProfile = useCallback(async () => {
    const profile = await api<{ accounts: LinkedAccount[] }>("/api/profile").catch(() => undefined);
    if (profile) setAccounts(profile.accounts ?? []);
  }, []);

  useEffect(() => {
    let stopped = false;
    // A cold server can refuse the very first reads for a moment: each is read again until it answers.
    const retry = <T,>(read: () => Promise<T>, attempt = 0): Promise<T> => read().catch((error) => {
      if (stopped || attempt >= 6) throw error;
      return new Promise<T>((resolve, reject) => setTimeout(() => retry(read, attempt + 1).then(resolve, reject), 1_500 * (attempt + 1)));
    });
    providersRequest.current = retry(() => api<{ providers: Provider[]; privyAppId: string | null }>("/api/providers")).then((value) => {
      setProviders(value.providers.filter((provider) => ["github", "x", "telegram", "discord", "farcaster"].includes(provider.id)));
      setPrivyAppId(value.privyAppId ?? undefined);
      return value;
    });
    providersRequest.current.catch(() => undefined);
    void retry(() => api<{ authenticated: boolean; address?: string }>("/api/me")).then(async (me) => {
      if (me.authenticated && me.address) {
        setWallet(me.address);
        setStatus("ready");
        await refreshProfile();
      } else setStatus("anonymous");
    }).catch(() => setStatus("anonymous"));
    const readNetworks = () => retry(() => api<{ networks: ElysiumNetworkView[]; paused: { message: string } | null }>("/api/elysium")).then((value) => {
      setNetworks(value.networks);
      setPaused(value.paused?.message);
      // Mainnet becomes the default the moment it is open, unless the visitor chose a network.
      if (value.networks.find((entry) => entry.id === "elysium-mainnet")?.enabled && !sessionStorage.getItem("elysa.network")) setNetworkIdState("elysium-mainnet");
    }).catch(() => undefined);
    const readMarkets = () => api<{ markets: ElysiumMarket[] }>("/api/elysium/markets").then((value) => setMarkets(value.markets)).catch(() => undefined);
    void readNetworks();
    void readMarkets();
    const timer = window.setInterval(readMarkets, 20_000);
    // An account linked through a provider's sign-in returns here with ?linked= or ?link_error=.
    const query = new URLSearchParams(window.location.search);
    if (query.get("linked")) setNotice(`Your ${query.get("linked")} account is linked.`);
    if (query.get("link_error")) setNotice(`${query.get("link_error")} was not linked (${query.get("reason") ?? "failed"}).`);
    if (query.get("linked") || query.get("link_error")) window.history.replaceState(null, "", window.location.pathname);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [refreshProfile]);

  const connect = useCallback(async () => {
    setNotice(undefined);
    setStatus("connecting");
    try {
      let privy = privyControls();
      const appId = privyAppId ?? (await providersRequest.current?.catch(() => undefined))?.privyAppId ?? undefined;
      if (!privy?.ready && appId) privy = await whenPrivyReady(window.ethereum ? 10_000 : 30_000);
      let provider: NonNullable<ReturnType<typeof evmProvider>>;
      let address: string;
      if (privy?.ready) {
        await privy.login();
        const evm = await privy.evm();
        if (!evm) throw new Error("The sign-in did not give a wallet. Try again.");
        provider = evm.provider;
        address = evm.address;
        setActiveEvmProvider(provider);
      } else if (window.ethereum) {
        provider = window.ethereum;
        address = ((await provider.request({ method: "eth_requestAccounts" })) as string[])[0];
        setActiveEvmProvider(undefined);
      } else {
        throw new Error("No wallet was found. Install a browser wallet such as Rabby or MetaMask, or open ElysaPay in your wallet app's browser.");
      }
      const challenge = await api<{ id: string; message: string }>("/api/auth/challenge", { address });
      const signature = await provider.request({ method: "personal_sign", params: [challenge.message, address] }) as string;
      const verified = await api<{ address: string }>("/api/auth/verify", { address, challengeId: challenge.id, signature });
      setWallet(verified.address);
      setStatus("ready");
      await refreshProfile();
      return verified.address;
    } catch (error) {
      setStatus(wallet ? "ready" : "anonymous");
      setNotice(error instanceof Error ? error.message.split("\n")[0] : "The wallet was not connected.");
      return undefined;
    }
  }, [privyAppId, refreshProfile, wallet]);

  const disconnect = useCallback(async () => {
    await api("/api/auth/logout", undefined, "POST").catch(() => undefined);
    await privyControls()?.logout().catch(() => undefined);
    setActiveEvmProvider(undefined);
    setWallet(undefined);
    setAccounts([]);
    setStatus("anonymous");
  }, []);

  const setNetworkId = useCallback((id: ElysiumNetworkId) => {
    sessionStorage.setItem("elysa.network", id);
    setNetworkIdState(id);
  }, []);

  const value = useMemo<SessionValue>(() => ({
    wallet, status, accounts, providers, networks, networkId, setNetworkId,
    network: networks?.find((entry) => entry.id === networkId),
    paused, markets, hype: markets?.find((market) => market.coin === "HYPE"),
    notice, setNotice, connect, disconnect, refreshProfile,
  }), [wallet, status, accounts, providers, networks, networkId, setNetworkId, paused, markets, notice, connect, disconnect, refreshProfile]);

  return <Session.Provider value={value}>
    {privyAppId && <Suspense fallback={null}><PrivyBridge appId={privyAppId} theme="dark" /></Suspense>}
    {children}
  </Session.Provider>;
}
