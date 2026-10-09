import { memo, useEffect, useMemo, useRef } from "react";
import { PrivyProvider, useExportWallet, useLogin, usePrivy, useWallets, type ConnectedWallet, type PrivyClientConfig, type User } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useExportWallet as useExportSolanaWallet, useWallets as useSolanaWallets, type ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions, type Rpc, type RpcSubscriptions, type SolanaRpcApi, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import { defineChain } from "viem";
import { ARC_MAINNET } from "../domain/arc-chains";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import { STOCK_CHAINS } from "../domain/stock-tokens";
import { SOLANA_WALLET_CHAIN, signatureText, type SolanaWalletHandle } from "./solana-wallet";
import { registerPrivy, type PrivyControls } from "./wallet-bridge";

const robinhood = STOCK_CHAINS["robinhood-mainnet"];
// The EVM chains an embedded wallet may sign for, from the bundled constants only.
const robinhoodChain = defineChain({
  id: robinhood.id,
  name: robinhood.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [robinhood.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: robinhood.explorerUrl } },
});
const arcChain = defineChain({
  id: ARC_MAINNET.chainId,
  name: ARC_MAINNET.chainName,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_MAINNET.rpcUrl] } },
  blockExplorers: { default: { name: "Arc", url: ARC_MAINNET.explorerUrl } },
});
// Where an embedded Solana wallet reads and sends: the page's RPC (a QuickNode endpoint the server names), over HTTPS
// and its websocket.
const solanaRpcs = (url: string) => ({
  [SOLANA_WALLET_CHAIN]: {
    rpc: createSolanaRpc(url) as unknown as Rpc<SolanaRpcApi>,
    rpcSubscriptions: createSolanaRpcSubscriptions(url.replace(/^https:/, "wss:")) as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>,
    blockExplorerUrl: SOLANA_MAINNET.explorerUrl,
  },
});

/** The wallet a person signed in with, else the embedded one Privy made for them. */
function evmWallet(wallets: ConnectedWallet[], user: User | null) {
  const signedInWith = user?.wallet?.chainType === "ethereum" ? user.wallet.address.toLowerCase() : undefined;
  return wallets.find((wallet) => wallet.address.toLowerCase() === signedInWith)
    ?? wallets.find((wallet) => wallet.walletClientType === "privy")
    ?? wallets[0];
}

const isPrivySolana = (wallet: ConnectedStandardSolanaWallet) => Boolean((wallet.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet);

function solanaWallet(wallets: ConnectedStandardSolanaWallet[], user: User | null) {
  const signedInWith = user?.wallet?.chainType === "solana" ? user.wallet.address : undefined;
  return wallets.find((wallet) => wallet.address === signedInWith)
    ?? wallets.find(isPrivySolana)
    ?? wallets[0];
}

/** The wallets Privy made for this sign-in, the only ones its window can export. */
function embeddedWallets(wallets: ConnectedWallet[], solanaWallets: ConnectedStandardSolanaWallet[]) {
  return { evm: wallets.find((wallet) => wallet.walletClientType === "privy")?.address, solana: solanaWallets.find(isPrivySolana)?.address };
}

function solanaHandle(wallet: ConnectedStandardSolanaWallet): SolanaWalletHandle {
  return {
    address: wallet.address,
    name: wallet.standardWallet.name,
    signMessage: async (message) => (await wallet.signMessage({ message })).signature,
    signAndSend: async (transaction) => signatureText((await wallet.signAndSendTransaction({ transaction, chain: SOLANA_WALLET_CHAIN })).signature),
  };
}

function Bridge() {
  const { ready, authenticated, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const pending = useRef<{ resolve: () => void; reject: (error: Error) => void }>();
  const loginEvents = useMemo(() => ({
    onError: (error: unknown) => {
      pending.current?.reject(new Error(error === "exited_auth_flow" ? "Sign-in was closed, so nothing was connected." : "The sign-in did not finish. Try again."));
      pending.current = undefined;
    },
  }), []);
  const { login } = useLogin(loginEvents);
  const { exportWallet: exportEvm } = useExportWallet();
  const { exportWallet: exportSolana } = useExportSolanaWallet();
  // Privy's hooks hand back new arrays and functions as it renders; the controls read the latest ones when called.
  const latest = useRef({ ready, authenticated, wallets, solanaWallets, user, login, logout, exportEvm, exportSolana });
  latest.current = { ready, authenticated, wallets, solanaWallets, user, login, logout, exportEvm, exportSolana };
  const evmAddress = evmWallet(wallets, user)?.address ?? "";
  const solanaAddress = solanaWallet(solanaWallets, user)?.address ?? "";
  const embedded = embeddedWallets(wallets, solanaWallets);

  // A sign-in resolves once Privy has an EVM wallet for the person (an embedded one is made on their first sign-in).
  useEffect(() => {
    if (pending.current && authenticated && evmAddress) {
      pending.current.resolve();
      pending.current = undefined;
    }
  }, [authenticated, evmAddress]);

  // One set of controls for the bridge's life. The desk is told about them again only when what they stand for
  // changes (ready, signed in, the wallets' addresses), never because Privy rendered.
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
    solana: () => {
      const wallet = solanaWallet(latest.current.solanaWallets, latest.current.user);
      return wallet ? solanaHandle(wallet) : undefined;
    },
    embedded: () => embeddedWallets(latest.current.wallets, latest.current.solanaWallets),
    exportKey: async (family, address) => {
      const now = latest.current;
      const made = embeddedWallets(now.wallets, now.solanaWallets);
      const own = family === "evm" ? made.evm?.toLowerCase() === address.toLowerCase() : made.solana === address;
      if (!now.authenticated || !own) throw new Error("Only a wallet Privy made for this sign-in can be exported here. Sign in the way you did when it was made.");
      await (family === "evm" ? now.exportEvm({ address }) : now.exportSolana({ address }));
    },
  }), []);
  useEffect(() => registerPrivy(controls, `${ready}|${authenticated}|${evmAddress}|${solanaAddress}|${embedded.evm ?? ""}|${embedded.solana ?? ""}`), [controls, ready, authenticated, evmAddress, solanaAddress, embedded.evm, embedded.solana]);
  useEffect(() => () => registerPrivy(undefined), []);
  return null;
}

/**
 * One sign-in for every network: Privy gives each person an EVM wallet and a Solana
 * wallet (embedded, or the external wallets they connect), and the desk proves both addresses with its own signed
 * challenges. This chunk loads only when the server names a Privy app; without one the desk uses browser wallets.
 * The config and the Solana wallet connectors are made once (again only for a new theme or RPC), and the component
 * renders only when its props change: a new config on every desk render made Privy start its work over each time.
 */
function PrivyBridge({ appId, theme, solanaRpcUrl }: { appId: string; theme: "dark" | "light"; solanaRpcUrl: string }) {
  const connectors = useMemo(() => toSolanaWalletConnectors(), []);
  const config = useMemo<PrivyClientConfig>(() => ({
    appearance: {
      theme,
      accentColor: "#CCFF00",
      walletChainType: "ethereum-and-solana",
      landingHeader: "Sign in to HaPaPay",
      loginMessage: "One sign-in for Robinhood Chain, Solana and Arc.",
    },
    embeddedWallets: { ethereum: { createOnLogin: "all-users" }, solana: { createOnLogin: "all-users" } },
    externalWallets: { solana: { connectors } },
    solana: { rpcs: solanaRpcs(solanaRpcUrl) },
    supportedChains: [robinhoodChain, arcChain],
    defaultChain: robinhoodChain,
  }), [theme, solanaRpcUrl, connectors]);
  return <PrivyProvider appId={appId} config={config}>
    <Bridge />
  </PrivyProvider>;
}

export default memo(PrivyBridge);
