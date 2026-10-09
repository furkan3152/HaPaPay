import { useEffect, useState } from "react";
import { encodeDeployData, getAddress } from "viem";
import { BURN_VAULT_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../domain/fee-artifacts";
import { burnVaultAbi, platformFeePercent, payRouterAbi } from "../domain/fees";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../domain/stock-claim-escrow-artifact";
import { stockClaimEscrowAbi, type StockEscrowDeployment } from "../domain/stock-claims";
import { STOCK_CHAINS, type StockNetworkId } from "../domain/stock-tokens";
import { receiptSource, waitForTransactionReceipt } from "../domain/transaction-receipt";
import { DotText } from "./DotText";
import { DotIcon } from "./DotIcon";
import { evmProvider } from "../wallet/wallet-bridge";
import ArcMainnetOperator from "./ArcMainnetOperator";

type ContractInfo = { name: string; securityRevision: string; runtimeCodeHash: string };
type EscrowStatus = {
  contract: ContractInfo;
  feeContracts?: { router: ContractInfo; burnVault: ContractInfo; feeBps: number; burnShareBps: number };
  networks: StockEscrowDeployment[];
};
type DeployReceipt = { status: string; blockNumber: string; contractAddress?: string | null };
type Deployment = { hash: string; status: "pending" | "registering" | "registered" | "failed" };
type Provider = { id: string; name: string; configured: boolean };
type Health = {
  recipientLookup?: { github?: string; x?: string };
  solana?: { transfers?: string; stocks?: string };
  rpc?: { solana?: string; solanaBrowser?: string; arc?: string; robinhood?: string };
};

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
/** This site's own origin, which the OAuth apps, Privy and the browser RPC must allow. */
const ORIGIN = typeof window === "undefined" ? "https://your-domain.example" : window.location.origin;

/**
 * What the server still needs, by environment variable name, read from the public status endpoints. It shows
 * states and names only; values are set in the hosting provider's settings, never here.
 */
function SetupChecklist({ networks }: { networks: StockEscrowDeployment[] }) {
  const [providers, setProviders] = useState<Provider[]>();
  const [privy, setPrivy] = useState<boolean>();
  const [health, setHealth] = useState<Health>();
  const [solanaVault, setSolanaVault] = useState<{ enabled: boolean }>();
  useEffect(() => {
    void fetch("/api/solana/vault", { cache: "no-store" }).then((response) => response.ok ? response.json() : { enabled: false }).then((result: { enabled?: boolean }) => setSolanaVault({ enabled: Boolean(result.enabled) })).catch(() => setSolanaVault({ enabled: false }));
    void fetch("/api/providers", { cache: "no-store" }).then((response) => response.json()).then((result: { providers?: Provider[]; privyAppId?: string }) => {
      setProviders(result.providers ?? []);
      setPrivy(Boolean(result.privyAppId));
    }).catch(() => setProviders([]));
    void fetch("/api/health", { cache: "no-store" }).then((response) => response.json()).then(setHealth).catch(() => setHealth({}));
  }, []);
  const provider = (id: string) => providers?.find((entry) => entry.id === id);
  const mainnet = networks.find((entry) => entry.network === "robinhood-mainnet");
  // QuickNode for every network: one endpoint per network for the server, and a separate
  // Solana endpoint for pages that allows only this site.
  const serverRpcs = [["SOLANA_RPC_URL", health?.rpc?.solana], ["ARC_MAINNET_RPC_URL", health?.rpc?.arc], ["ROBINHOOD_MAINNET_RPC_URL", health?.rpc?.robinhood]] as const;
  const missingRpcs = serverRpcs.filter(([, state]) => state !== "provider").map(([name]) => name);
  const rows: Array<{ label: string; done: boolean | undefined; todo: string }> = [
    { label: "One sign-in for every network", done: privy, todo: `PRIVY_APP_ID from the Privy dashboard (App settings); allow ${ORIGIN} there and turn on email and wallet logins` },
    { label: "Solana payments", done: health ? health.solana?.transfers === "receipt_verified" : undefined, todo: "SOLANA_TREASURY_ADDRESS: the Solana address that receives the 1% fee" },
    { label: "Solana in the browser", done: health ? health.rpc?.solanaBrowser === "provider" : undefined, todo: `SOLANA_BROWSER_RPC_URL: a QuickNode Solana mainnet endpoint whose security allows only ${ORIGIN.replace("https://", "")} (Solana's public RPC refuses browsers, so xStocks, Privy's Solana wallets and the vault deployment need it)` },
    { label: "Server RPCs on QuickNode", done: health ? missingRpcs.length === 0 : undefined, todo: `${missingRpcs.join(", ")}: a QuickNode endpoint each, for the server only; each network falls back to its public RPC` },
    { label: "xStocks on Solana", done: health ? health.solana?.stocks === "receipt_verified" : undefined, todo: "SOLANA_STOCK_TRANSFERS=enabled, after your eligibility review" },
    { label: "Solana vault", done: solanaVault?.enabled, todo: "SOLANA_OPERATOR_ADDRESS and SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY (a new Solana key used for nothing else), then deploy the program in the card above" },
    { label: "GitHub login", done: provider("github")?.configured, todo: `GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; callback ${ORIGIN}/api/oauth/github/callback` },
    { label: "X login", done: provider("x")?.configured, todo: `X_CLIENT_ID and X_CLIENT_SECRET; callback ${ORIGIN}/api/oauth/x/callback` },
    { label: "Telegram login", done: provider("telegram")?.configured, todo: `TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME; /setdomain ${ORIGIN.replace("https://", "")} in BotFather` },
    { label: "Discord login", done: provider("discord")?.configured, todo: `DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET; callback ${ORIGIN}/api/oauth/discord/callback` },
    { label: "Farcaster login", done: provider("farcaster")?.configured, todo: "Sign in with Farcaster needs no key" },
    { label: "X vault links", done: health ? health.recipientLookup?.x === "configured" : undefined, todo: health?.recipientLookup?.x === "refused_by_x" ? "X_API_BEARER_TOKEN, which X refuses now: check the key, the project's credits and the app's access in the X developer console" : "X_API_BEARER_TOKEN from the X developer portal (Keys and tokens)" },
    { label: "GitHub vault lookups above the public rate limit", done: health ? health.recipientLookup?.github === "token" : undefined, todo: health?.recipientLookup?.github === "refused_by_github" ? "GITHUB_API_TOKEN, which GitHub refuses now: a new fine-grained token with no repository access" : "Optional: GITHUB_API_TOKEN, a read-only personal access token" },
    { label: "Operator wallet", done: mainnet ? Boolean(mainnet.operator) : undefined, todo: "ROBINHOOD_OPERATOR_ADDRESS: the wallet that deploys and owns the vault and fee contracts and receives the treasury half of each fee" },
    { label: "Mainnet vault attestor", done: mainnet ? !mainnet.setup.includes("ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY") : undefined, todo: "ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY: a new key used for nothing else, written as 0x and 64 hex characters, marked Sensitive" },
    { label: "Mainnet Stock Token transfers", done: mainnet?.stockTransfersEnabled, todo: "ROBINHOOD_MAINNET_STOCK_TRANSFERS=enabled, after your eligibility review" },
  ];
  return <article className="payment-slip escrow-console" aria-labelledby="setup-checklist-title">
    <div className="slip-top"><div><small>Environment variables · names only</small><DotText as="strong" id="setup-checklist-title" text="Server setup" /></div></div>
    <ul className="setup-checklist">
      {rows.map((row) => <li key={row.label} className={row.done ? "done" : row.done === false ? "todo" : ""}>
        {row.done ? <DotIcon name="check" size={14} /> : <DotIcon name="lock" size={14} />}
        <span><b>{row.label}</b>{row.done ? " · ready" : row.done === false ? ` · set ${row.todo}` : " · checking…"}</span>
      </li>)}
    </ul>
    <p className="escrow-console-note">Set values in the hosting provider's environment settings for Production, then redeploy. Never paste a key into a chat or a page.</p>
  </article>;
}

/**
 * The operator's escrow deployment, in three wallet signatures: the burn vault, the fee router (the burn vault and
 * the operator as treasury), then the escrow (the verifier the server reports and that router). Every creation code
 * is the bundled, test-verified build, and the server registers the escrow only after it reads the receipt, the
 * escrow and both fee contracts back from chain. The wallet signs; nothing here holds a key. Arc Mainnet follows in
 * its own card, with its own status endpoint.
 */
export default function StockEscrowOperator({ wallet, walletVerifying, onConnect, switchChain, switchArcChain, onMessage }: {
  wallet?: string;
  walletVerifying: boolean;
  onConnect: () => Promise<void>;
  switchChain: (network: StockNetworkId) => Promise<void>;
  /** Switches the wallet to Arc Mainnet from the bundled chain constants. */
  switchArcChain: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [status, setStatus] = useState<EscrowStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [deployments, setDeployments] = useState<Partial<Record<StockNetworkId, Deployment>>>({});
  const [working, setWorking] = useState<StockNetworkId>();
  const [mainnetAcknowledged, setMainnetAcknowledged] = useState(false);
  const [replacing, setReplacing] = useState<StockNetworkId>();
  const [recoveryHash, setRecoveryHash] = useState<Partial<Record<StockNetworkId, string>>>({});
  // Fee contracts deployed in this visit, so a retry after a failed escrow step reuses them instead of paying twice.
  const [feeContracts, setFeeContracts] = useState<Partial<Record<StockNetworkId, { burnVault?: `0x${string}`; router?: `0x${string}` }>>>({});

  async function load() {
    try {
      const response = await fetch("/api/stocks/escrow", { cache: "no-store" });
      const result = await response.json() as EscrowStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The claim escrow status could not be loaded.");
      setStatus(result);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The claim escrow status could not be loaded.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function register(network: StockNetworkId, hash: string) {
    setDeployments((current) => ({ ...current, [network]: { hash, status: "registering" } }));
    const response = await fetch("/api/stocks/escrow/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network, transactionHash: hash }),
    });
    const result = await response.json().catch(() => ({})) as StockEscrowDeployment & { error?: string };
    if (!response.ok || !result.escrow) {
      setDeployments((current) => ({ ...current, [network]: { hash, status: "failed" } }));
      throw new Error(result.error ?? "The escrow could not be registered.");
    }
    setDeployments((current) => ({ ...current, [network]: { hash, status: "registered" } }));
    setStatus((current) => current ? { ...current, networks: current.networks.map((entry) => entry.network === network ? result : entry) } : current);
    return result;
  }

  async function registerAgain(network: StockNetworkId, hash: string) {
    if (working) return;
    setWorking(network);
    try {
      const registered = await register(network, hash);
      onMessage(`The ${STOCK_CHAINS[network].name} claim escrow ${registered.escrow!.address} is verified and registered. Vault links are live.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The escrow could not be registered.");
    } finally {
      setWorking(undefined);
    }
  }

  /** Sends one creation transaction and returns its hash and the new contract's address once the receipt lands. */
  async function create(network: StockNetworkId, data: `0x${string}`, what: string) {
    const ethereum = evmProvider();
    if (!ethereum) throw new Error("No EVM wallet is connected. Connect the operator wallet first.");
    const chain = STOCK_CHAINS[network];
    const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: wallet, data, value: "0x0" }] }) as string;
    onMessage(`The ${what} deployment was submitted. Waiting for ${chain.name} to confirm it.`);
    const receipt = await waitForTransactionReceipt(
      receiptSource<DeployReceipt>(network, hash, ethereum),
      { attempts: 90, revertedMessage: `The ${chain.name} ${what} deployment reverted; nothing was created.` },
    );
    if (!receipt.contractAddress) throw new Error(`The ${what} deployment did not create a contract.`);
    return { hash, address: getAddress(receipt.contractAddress) };
  }

  async function deploy(entry: StockEscrowDeployment) {
    const ethereum = evmProvider();
    if (!ethereum || !wallet || !entry.verifier || !entry.operator || working) return;
    const chain = STOCK_CHAINS[entry.network];
    const gas = chain.testAssets ? "test ETH" : "ETH";
    setWorking(entry.network);
    setReplacing(undefined);
    let submitted: string | undefined;
    try {
      await switchChain(entry.network);
      let { burnVault, router } = feeContracts[entry.network] ?? {};
      if (!burnVault) {
        onMessage(`Signature 1 of 3: deploy the ${chain.name} burn vault, which can only turn its fee half into the burn token and burn it. It costs gas in ${gas}.`);
        burnVault = (await create(entry.network, encodeDeployData({ abi: burnVaultAbi, bytecode: BURN_VAULT_ARTIFACT.bytecode }), "burn vault")).address;
        const deployedVault = burnVault;
        setFeeContracts((current) => ({ ...current, [entry.network]: { burnVault: deployedVault } }));
      }
      if (!router) {
        onMessage(`Signature 2 of 3: deploy the ${chain.name} fee router: 1% on top of each payment, half to the burn vault, half to ${short(entry.operator)}.`);
        router = (await create(entry.network, encodeDeployData({ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT.bytecode, args: [burnVault, entry.operator] }), "fee router")).address;
        const deployedRouter = router;
        setFeeContracts((current) => ({ ...current, [entry.network]: { ...current[entry.network], router: deployedRouter } }));
      }
      const data = encodeDeployData({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [entry.verifier, router] });
      onMessage(`Signature 3 of 3: deploy the ${chain.name} vault escrow. It costs gas in ${gas}.`);
      const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: wallet, data, value: "0x0" }] }) as string;
      submitted = hash;
      setDeployments((current) => ({ ...current, [entry.network]: { hash, status: "pending" } }));
      onMessage(`The escrow deployment was submitted. Waiting for ${chain.name} to confirm it.`);
      await waitForTransactionReceipt(
        receiptSource(entry.network, hash, ethereum),
        { attempts: 90, revertedMessage: `The ${chain.name} deployment reverted; no escrow was created.` },
      );
      const registered = await register(entry.network, hash);
      setFeeContracts((current) => ({ ...current, [entry.network]: {} }));
      onMessage(`The ${chain.name} claim escrow ${registered.escrow!.address} and its fee contracts are verified and registered. Vault links are live, and every payment on ${chain.name} now carries the ${platformFeePercent(registered.fees?.feeBps ?? 100)} fee.`);
    } catch (error) {
      if (submitted) {
        const failedHash = submitted;
        setDeployments((current) => current[entry.network]?.hash === failedHash && current[entry.network]?.status === "pending"
          ? { ...current, [entry.network]: { hash: failedHash, status: "failed" } }
          : current);
      }
      onMessage(error instanceof Error ? error.message : "The escrow was not deployed.");
    } finally {
      setWorking(undefined);
    }
  }

  // Arc Mainnet has its own status endpoint, so its card shows even when the Robinhood status cannot load.
  const arc = <ArcMainnetOperator wallet={wallet} walletVerifying={walletVerifying} onConnect={onConnect} switchArcChain={switchArcChain} onMessage={onMessage} />;

  if (!status) {
    return <><article className="payment-slip escrow-console" aria-busy={!loadError}>
      <p className="escrow-console-note">{loadError ?? "Loading the claim escrow status…"}</p>
      {loadError && <button onClick={() => void load()}>Try again</button>}
    </article>{arc}</>;
  }

  return <><SetupChecklist networks={status.networks} />{status.networks.map((entry) => {
    const chain = STOCK_CHAINS[entry.network];
    const deployment = deployments[entry.network];
    const owner = Boolean(wallet && entry.operator && wallet.toLowerCase() === entry.operator.toLowerCase());
    const live = entry.claims.enabled && Boolean(entry.escrow);
    const ready = entry.setup.length === 0 && entry.transfersEnabled && Boolean(entry.verifier);
    // A live escrow is replaced only after a second click; mainnet deployments also need the operator's statement.
    const deploying = !live || replacing === entry.network;
    const statementMissing = deploying && !chain.testAssets && !mainnetAcknowledged;
    const state = live ? "Live" : !ready ? "Setup needed" : "Ready to deploy";
    const label = working === entry.network ? "Deploying…"
      : !wallet ? walletVerifying ? "Verifying…" : "Connect the operator wallet"
      : !owner ? `Connect ${entry.operator ? short(entry.operator) : "the operator wallet"} to deploy`
      : entry.setup.length ? "Server setup needed"
      : !entry.transfersEnabled ? `Turn on ${chain.testAssets ? "testnet" : "mainnet"} transfers first`
      : statementMissing ? "Confirm the statement above"
      : live ? deploying ? "Confirm: new links will use a new escrow" : "Deploy a replacement escrow"
      : feeContracts[entry.network]?.router ? "Deploy the escrow (3 of 3)"
      : "Deploy the vault and fee contracts";
    const disabled = Boolean(working) || walletVerifying || (Boolean(wallet) && (!owner || !ready || statementMissing));
    const act = () => {
      if (!wallet) return void onConnect();
      if (live && replacing !== entry.network) return void setReplacing(entry.network);
      void deploy(entry);
    };
    return <article className="payment-slip escrow-console" key={entry.network} aria-label={`${entry.chainName} claim escrow`}>
      <div className="slip-top">
        <div><small>{entry.chainName} · chain ID {entry.chainId}</small><DotText as="strong" text="Vault · claim escrow" /></div>
        <span className={`escrow-state ${live ? "live" : ready ? "ready" : ""}`}>{state}</span>
      </div>
      <dl className="stock-facts">
        <div><dt>Contract</dt><dd>{status.contract.name} · revision {status.contract.securityRevision}<small>Runtime code {short(status.contract.runtimeCodeHash)}, checked by the server before it accepts an escrow</small></dd></div>
        <div><dt>Verifier</dt><dd>{entry.verifier ? <a href={`${chain.explorerUrl}/address/${entry.verifier}`} target="_blank" rel="noreferrer">{short(entry.verifier)} <DotIcon name="arrow-up-right" size={12} /></a> : "Not set on the server"}<small>This server's claim attestor, passed to the constructor</small></dd></div>
        <div><dt>Owner</dt><dd>{entry.operator ? <a href={`${chain.explorerUrl}/address/${entry.operator}`} target="_blank" rel="noreferrer">{short(entry.operator)} <DotIcon name="arrow-up-right" size={12} /></a> : "Not set on the server"}<small>The operator wallet set on the server; it deploys and owns the escrow and the fee contracts, and receives the treasury half of each fee</small></dd></div>
        {status.feeContracts && <div><dt>Fee</dt><dd>{platformFeePercent(status.feeContracts.feeBps)} on top of each payment · half burned<small>{status.feeContracts.burnVault.name} and {status.feeContracts.router.name} are deployed first; the server checks both runtime codes ({short(status.feeContracts.burnVault.runtimeCodeHash)}, {short(status.feeContracts.router.runtimeCodeHash)})</small></dd></div>}
        {entry.fees && <div><dt>Fee contracts</dt><dd>Router <a href={`${chain.explorerUrl}/address/${entry.fees.router}`} target="_blank" rel="noreferrer">{short(entry.fees.router)} <DotIcon name="arrow-up-right" size={12} /></a> · burn vault <a href={`${chain.explorerUrl}/address/${entry.fees.burnVault}`} target="_blank" rel="noreferrer">{short(entry.fees.burnVault)} <DotIcon name="arrow-up-right" size={12} /></a><small>{entry.fees.burnToken ? `Burns ${short(entry.fees.burnToken)}` : "Holds its fee half until the operator names a burn token; nothing can leave before that"}</small></dd></div>}
        {entry.escrow && <div><dt>Escrow</dt><dd><a href={`${chain.explorerUrl}/address/${entry.escrow.address}`} target="_blank" rel="noreferrer">{entry.escrow.address} <DotIcon name="arrow-up-right" size={12} /></a><small>Registered {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.escrow.registeredAt))} · block {entry.escrow.blockNumber}</small></dd></div>}
        <div><dt>Transfers</dt><dd>Stock Tokens {entry.stockTransfersEnabled ?? entry.transfersEnabled ? "on" : "off"}{chain.testAssets ? "" : ` · USDG ${entry.tokenTransfersEnabled ? "on" : "off"}`}</dd></div>
      </dl>
      {entry.setup.length > 0 && <div className="mainnet-lock"><DotIcon name="lock" size={16} /><span><b>Server setup needed.</b> Set {entry.setup.join(" and ")} in the server's environment variables, then redeploy the site.{entry.setup.includes("ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY") ? " Use a new key made only for mainnet claims, written as 0x and 64 hex characters; the server refuses a key it already uses elsewhere." : ""}</span></div>}
      {live && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size={16} /><span><b>Vault links are live.</b> Tokens sent to someone on GitHub, X, Farcaster, Discord or Telegram who has not joined yet wait in this escrow.</span></div>}
      {!chain.testAssets && owner && ready && deploying && <label className="stock-eligibility">
        <input type="checkbox" checked={mainnetAcknowledged} disabled={Boolean(working)} onChange={(event) => setMainnetAcknowledged(event.target.checked)} />
        <span>I understand this vault will hold real tokens on {chain.name}: USDG{entry.stockTransfersEnabled ? ", and Robinhood Stock Tokens now that mainnet stock transfers are on and the eligibility review for them is done" : ""}.</span>
      </label>}
      <button className={live ? "stock-verify-again" : undefined} disabled={disabled} onClick={act}>{label}</button>
      {deployment && <a className={`transaction-link ${deployment.status === "registered" ? "confirmed" : deployment.status === "failed" ? "verification-failed" : ""}`} href={`${chain.explorerUrl}/tx/${deployment.hash}`} target="_blank" rel="noreferrer">
        {deployment.status === "registered" ? "Deployed and registered" : deployment.status === "failed" ? "Check in explorer" : deployment.status === "registering" ? "Verifying the contract" : "Deployment submitted"} · {deployment.hash.slice(0, 10)}…
      </a>}
      {deployment?.status === "failed" && <button className="stock-verify-again" disabled={Boolean(working)} onClick={() => void registerAgain(entry.network, deployment.hash)}>Register this deployment again</button>}
      {owner && ready && <details className="escrow-recovery">
        <summary>Register an escrow deployed earlier</summary>
        <div className="escrow-register">
          <input value={recoveryHash[entry.network] ?? ""} onChange={(event) => setRecoveryHash((current) => ({ ...current, [entry.network]: event.target.value.trim() }))} placeholder="Deployment transaction hash (0x…)" aria-label={`${entry.chainName} deployment transaction hash`} spellCheck={false} />
          <button disabled={Boolean(working) || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash[entry.network] ?? "")} onClick={() => void registerAgain(entry.network, recoveryHash[entry.network]!)}>Register</button>
        </div>
      </details>}
    </article>;
  })}{arc}</>;
}
