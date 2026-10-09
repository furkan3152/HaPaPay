import { useEffect, useState } from "react";
import { encodeDeployData, encodeFunctionData, getAddress } from "viem";
import { ARC_MAINNET } from "../domain/arc-chains";
import { ARC_IDENTITY_REGISTRY_ARTIFACT } from "../domain/arc-identity-registry-artifact";
import { arcIdentityRegistryAbi } from "../domain/arc-identity-registry";
import { FEE_FORWARDER_ARTIFACT, PAY_ROUTER_ARTIFACT } from "../domain/fee-artifacts";
import { feeForwarderAbi, platformFeePercent, payRouterAbi, type FeeSchedule } from "../domain/fees";
import { STOCK_CLAIM_ESCROW_ARTIFACT } from "../domain/stock-claim-escrow-artifact";
import { stockClaimEscrowAbi } from "../domain/stock-claims";
import { waitForTransactionReceipt } from "../domain/transaction-receipt";
import { DotText } from "./DotText";
import { DotIcon } from "./DotIcon";
import { evmProvider } from "../wallet/wallet-bridge";

type ContractInfo = { name: string; securityRevision: string; runtimeCodeHash: string };
type ArcSetup = {
  chain: { chainId: number; chainName: string; explorerUrl: string; usdc: `0x${string}` };
  live: boolean;
  runningNetwork: string;
  operator: `0x${string}` | null;
  identityVerifier: `0x${string}` | null;
  claimVerifier: `0x${string}` | null;
  setup: string[];
  variables: { registry: string; identityAttestor: string; escrow: string; claimAttestor: string; operator: string };
  configured: { registry: string | null; escrow: string | null };
  problems: { identityRegistry?: string; claimEscrow?: string };
  fees: FeeSchedule | null;
  forwarder: { address: `0x${string}`; balance: string } | null;
  contracts: { registry: ContractInfo; escrow: ContractInfo; router: ContractInfo; forwarder: ContractInfo; feeBps: number };
};
type Deployed = { forwarder?: `0x${string}`; router?: `0x${string}`; registry?: `0x${string}`; escrow?: `0x${string}` };
type Checked = { variables: Record<string, string>; fees: FeeSchedule };
type DeployReceipt = { status: string; blockNumber: string; contractAddress?: string | null };

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const explorer = (path: string) => `${ARC_MAINNET.explorerUrl.replace(/\/$/, "")}/${path}`;
/** Contracts deployed in this browser, so a reload in the middle of the four signatures does not pay for them twice. */
const STORAGE_KEY = "hapapay-arc-mainnet-deployment";

function readDeployed(): Deployed {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const pick = (key: keyof Deployed) => typeof value[key] === "string" && /^0x[0-9a-fA-F]{40}$/.test(value[key] as string) ? getAddress(value[key] as string) : undefined;
    return { forwarder: pick("forwarder"), router: pick("router"), registry: pick("registry"), escrow: pick("escrow") };
  } catch {
    return {};
  }
}

function writeDeployed(deployed: Deployed) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(deployed));
  } catch {}
}

const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * A receipt as Arc Mainnet reports it, read by the server rather than the wallet: some wallets report a deployment's
 * receipt without its contract address. Null while the transaction is not mined, or while Arc cannot be read.
 */
async function readReceipt(hash: string) {
  const response = await fetch(`/api/arc/mainnet-setup/receipt/${hash}`, { cache: "no-store" });
  const result = await response.json().catch(() => ({})) as { receipt?: DeployReceipt | null; error?: string };
  if (response.status === 429 || response.status >= 500) return null;
  if (!response.ok) throw new Error(result.error ?? "The deployment receipt could not be read.");
  return result.receipt ?? null;
}

/**
 * Arc Mainnet on the operator page. The operator wallet deploys four reviewed builds on Arc Mainnet with its own
 * signatures (gas is paid in USDC): the fee forwarder, the fee router (1% on top, half to the forwarder, half to the
 * operator), the identity registry (this server's identity attestor) and the vault escrow (this server's claim
 * attestor and that router). The server checks the deployment read-only and names the variables that switch it on.
 */
export default function ArcMainnetOperator({ wallet, walletVerifying, onConnect, switchArcChain, onMessage }: {
  wallet?: string;
  walletVerifying: boolean;
  onConnect: () => Promise<void>;
  switchArcChain: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [setup, setSetup] = useState<ArcSetup>();
  const [loadError, setLoadError] = useState<string>();
  const [deployed, setDeployed] = useState<Deployed>(() => readDeployed());
  const [checked, setChecked] = useState<Checked>();
  const [problems, setProblems] = useState<{ registry?: string; escrow?: string }>();
  const [working, setWorking] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [manual, setManual] = useState({ registry: "", escrow: "" });

  async function load() {
    try {
      const response = await fetch("/api/arc/mainnet-setup", { cache: "no-store" });
      const result = await response.json() as ArcSetup & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Arc Mainnet setup could not be loaded.");
      setSetup(result);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The Arc Mainnet setup could not be loaded.");
    }
  }

  useEffect(() => { void load(); }, []);

  function remember(next: Deployed) {
    setDeployed(next);
    writeDeployed(next);
  }

  /**
   * The contracts this operator already has on Arc Mainnet, found by the server on chain. They replace what this
   * browser remembered, so an interrupted deployment resumes where it stopped and nothing is deployed twice.
   */
  async function resume() {
    try {
      const response = await fetch("/api/arc/mainnet-setup/deployment", { cache: "no-store" });
      if (!response.ok) return undefined;
      const found = ((await response.json()) as { deployment?: Record<string, unknown> }).deployment ?? {};
      const next: Deployed = {
        ...(isAddress(found.forwarder) ? { forwarder: getAddress(found.forwarder) } : {}),
        ...(isAddress(found.router) ? { router: getAddress(found.router) } : {}),
        ...(isAddress(found.registry) ? { registry: getAddress(found.registry) } : {}),
        ...(isAddress(found.escrow) ? { escrow: getAddress(found.escrow) } : {}),
      };
      remember(next);
      return next;
    } catch {
      return undefined;
    }
  }

  const operatorWallet = Boolean(wallet && setup?.operator && wallet.toLowerCase() === setup.operator.toLowerCase());
  useEffect(() => {
    if (operatorWallet && setup && !setup.live) void resume();
  }, [operatorWallet, setup?.live]);

  /** Sends one creation transaction on Arc Mainnet and returns the new contract's address once its receipt lands. */
  async function create(data: `0x${string}`, what: string) {
    const ethereum = evmProvider();
    if (!ethereum) throw new Error("No EVM wallet is connected. Connect the operator wallet first.");
    const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: wallet, data, value: "0x0" }] }) as string;
    onMessage(`The ${what} deployment was submitted. Waiting for Arc Mainnet to confirm it.`);
    const receipt = await waitForTransactionReceipt(
      () => readReceipt(hash),
      { attempts: 90, revertedMessage: `The Arc Mainnet ${what} deployment reverted; nothing was created.` },
    );
    if (!receipt.contractAddress) throw new Error(`The ${what} deployment did not create a contract.`);
    return getAddress(receipt.contractAddress);
  }

  async function check(registry: string, escrow: string) {
    const response = await fetch("/api/arc/mainnet-setup/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registry, escrow }),
    });
    const result = await response.json().catch(() => ({})) as Partial<Checked> & { ok?: boolean; error?: string; problems?: { registry?: string; escrow?: string } };
    if (response.status === 422 && result.problems) {
      setProblems(result.problems);
      throw new Error("The Arc Mainnet deployment did not pass the server's checks. See the reasons below.");
    }
    if (!response.ok || !result.variables || !result.fees) throw new Error(result.error ?? "The Arc Mainnet deployment could not be checked.");
    setProblems(undefined);
    setChecked({ variables: result.variables, fees: result.fees });
    return result;
  }

  async function deploy() {
    const ethereum = evmProvider();
    if (!ethereum || !wallet || !setup?.operator || !setup.identityVerifier || !setup.claimVerifier || working) return;
    setWorking(true);
    try {
      await switchArcChain();
      // Start from what is already on chain, so a deployment interrupted in any browser goes on from there.
      let next = await resume() ?? { ...deployed };
      if (!next.forwarder) {
        onMessage("Signature 1 of 4: deploy the Arc fee forwarder. It takes the half of each fee the router sets aside and can only pass it on to your wallet. Gas is paid in USDC.");
        next = { ...next, forwarder: await create(encodeDeployData({ abi: feeForwarderAbi, bytecode: FEE_FORWARDER_ARTIFACT.bytecode, args: [setup.operator] }), "fee forwarder") };
        remember(next);
      }
      if (!next.router) {
        onMessage(`Signature 2 of 4: deploy the Arc fee router: ${platformFeePercent(setup.contracts.feeBps)} on top of each payment, half to the forwarder and half to ${short(setup.operator)}.`);
        next = { ...next, router: await create(encodeDeployData({ abi: payRouterAbi, bytecode: PAY_ROUTER_ARTIFACT.bytecode, args: [next.forwarder!, setup.operator] }), "fee router") };
        remember(next);
      }
      if (!next.registry) {
        onMessage("Signature 3 of 4: deploy the Arc identity registry, verified by this server's identity attestor.");
        next = { ...next, registry: await create(encodeDeployData({ abi: arcIdentityRegistryAbi, bytecode: ARC_IDENTITY_REGISTRY_ARTIFACT.bytecode, args: [setup.identityVerifier] }), "identity registry") };
        remember(next);
      }
      if (!next.escrow) {
        onMessage("Signature 4 of 4: deploy the Arc vault escrow, verified by this server's claim attestor and charging the router's fee.");
        next = { ...next, escrow: await create(encodeDeployData({ abi: stockClaimEscrowAbi, bytecode: STOCK_CLAIM_ESCROW_ARTIFACT.bytecode, args: [setup.claimVerifier, next.router!] }), "vault escrow") };
        remember(next);
      }
      await check(next.registry!, next.escrow!);
      onMessage("All four Arc Mainnet contracts are deployed and pass the server's checks. Set the three variables shown on this page, then redeploy the site to switch Arc to mainnet.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The Arc Mainnet contracts were not deployed.");
    } finally {
      setWorking(false);
    }
  }

  async function checkManual() {
    if (working) return;
    setWorking(true);
    try {
      await check(manual.registry.trim(), manual.escrow.trim());
      onMessage("Those Arc Mainnet contracts pass the server's checks. Set the three variables shown on this page, then redeploy the site.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The Arc Mainnet deployment could not be checked.");
    } finally {
      setWorking(false);
    }
  }

  async function forward() {
    const ethereum = evmProvider();
    if (!ethereum || !wallet || !setup?.forwarder || working) return;
    setWorking(true);
    try {
      await switchArcChain();
      const data = encodeFunctionData({ abi: feeForwarderAbi, functionName: "forward", args: [setup.chain.usdc] });
      const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: wallet, to: setup.forwarder.address, data, value: "0x0" }] }) as string;
      onMessage("The forward was submitted. Waiting for Arc Mainnet to confirm it.");
      await waitForTransactionReceipt(() => readReceipt(hash), { attempts: 60, revertedMessage: "The forward reverted; nothing moved." });
      onMessage(`The ${setup.forwarder.balance} USDC the forwarder held is now in ${short(setup.operator ?? wallet)}.`);
      await load();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The forward was not sent.");
    } finally {
      setWorking(false);
    }
  }

  if (!setup) {
    return <article className="payment-slip escrow-console" aria-busy={!loadError} aria-label="Arc Mainnet setup">
      <p className="escrow-console-note">{loadError ?? "Loading the Arc Mainnet setup…"}</p>
      {loadError && <button onClick={() => void load()}>Try again</button>}
    </article>;
  }

  const operatorConnected = operatorWallet;
  const keysMissing = [setup.variables.identityAttestor, setup.variables.claimAttestor].filter((name) => setup.setup.includes(name));
  const operatorMissing = !setup.operator;
  const ready = !operatorMissing && keysMissing.length === 0 && Boolean(setup.identityVerifier && setup.claimVerifier);
  const allDeployed = Boolean(deployed.forwarder && deployed.router && deployed.registry && deployed.escrow);
  const state = setup.live ? "Live" : checked ? "Ready to switch" : !ready ? "Setup needed" : "Ready to deploy";
  const label = working ? "Working…"
    : !wallet ? walletVerifying ? "Verifying…" : "Connect the operator wallet"
    : !operatorConnected ? `Connect ${setup.operator ? short(setup.operator) : "the operator wallet"} to deploy`
    : !ready ? "Server setup needed"
    : !acknowledged ? "Confirm the statement above"
    : allDeployed ? "Check the deployment again"
    : deployed.forwarder ? "Continue the deployment"
    : "Deploy the Arc Mainnet contracts";
  const lines = checked ? Object.entries(checked.variables).map(([name, value]) => `${name}=${value}`) : [];

  return <article className="payment-slip escrow-console" aria-label="Arc Mainnet contracts">
    <div className="slip-top">
      <div><small>{setup.chain.chainName} · chain ID {setup.chain.chainId} · gas in USDC</small><DotText as="strong" text="Arc · USDC vault and fee" /></div>
      <span className={`escrow-state ${setup.live ? "live" : ready ? "ready" : ""}`}>{state}</span>
    </div>
    <dl className="stock-facts">
      <div><dt>Owner</dt><dd>{setup.operator ? <a href={explorer(`address/${setup.operator}`)} target="_blank" rel="noreferrer">{short(setup.operator)} <DotIcon name="arrow-up-right" size={12} /></a> : "Not set on the server"}<small>The operator wallet: it deploys and owns the four contracts and receives the whole Arc fee</small></dd></div>
      <div><dt>Fee</dt><dd>{platformFeePercent(setup.contracts.feeBps)} on top of each payment<small>Half straight to the operator, half through the fee forwarder, which can only pass it on to the operator.</small></dd></div>
      <div><dt>Attestors</dt><dd>{setup.identityVerifier && setup.claimVerifier ? `Registry ${short(setup.identityVerifier)} · vault ${short(setup.claimVerifier)}` : "Not set on the server"}<small>Passed to the registry and the escrow as their verifiers; the server signs with these keys only</small></dd></div>
      <div><dt>Builds</dt><dd>{setup.contracts.forwarder.name} · {setup.contracts.router.name} · {setup.contracts.registry.name} · {setup.contracts.escrow.name}<small>The server accepts each only by its runtime code ({short(setup.contracts.forwarder.runtimeCodeHash)}, {short(setup.contracts.router.runtimeCodeHash)}, {short(setup.contracts.registry.runtimeCodeHash)}, {short(setup.contracts.escrow.runtimeCodeHash)})</small></dd></div>
      {setup.live && setup.configured.registry && setup.configured.escrow && <div><dt>Contracts</dt><dd>Registry <a href={explorer(`address/${setup.configured.registry}`)} target="_blank" rel="noreferrer">{short(setup.configured.registry)}</a> · vault <a href={explorer(`address/${setup.configured.escrow}`)} target="_blank" rel="noreferrer">{short(setup.configured.escrow)}</a><small>Verified at the last deployment of the site</small></dd></div>}
      {!setup.live && (deployed.forwarder || deployed.router || deployed.registry || deployed.escrow) && <div><dt>Deployed here</dt><dd>{(["forwarder", "router", "registry", "escrow"] as const).filter((key) => deployed[key]).map((key) => <span key={key}>{key} <a href={explorer(`address/${deployed[key]}`)} target="_blank" rel="noreferrer">{short(deployed[key]!)}</a> </span>)}<small>Remembered in this browser until the switch</small></dd></div>}
    </dl>
    {(operatorMissing || keysMissing.length > 0) && <div className="mainnet-lock"><DotIcon name="lock" size={16} /><span><b>Server setup needed.</b> Set {[...(operatorMissing ? [`${setup.variables.operator} or ROBINHOOD_OPERATOR_ADDRESS`] : []), ...keysMissing].join(" and ")} in the server's environment variables, then redeploy the site. Make each attestor key just for this: 0x and 64 hex characters, outside any chat, marked Sensitive. The server refuses a key it uses anywhere else.</span></div>}
    {(setup.problems.identityRegistry || setup.problems.claimEscrow) && <div className="mainnet-lock"><DotIcon name="lock" size={16} /><span><b>The configured Arc Mainnet contracts were refused.</b> {[setup.problems.identityRegistry, setup.problems.claimEscrow].filter(Boolean).join(" ")}</span></div>}
    {setup.live && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size={16} /><span><b>Arc Mainnet is live.</b> USDC payments and vault links on Arc carry the {platformFeePercent(setup.contracts.feeBps)} fee.</span></div>}
    {setup.live && setup.forwarder && <div className="escrow-register">
      <span>Fee forwarder holds <b>{setup.forwarder.balance} USDC</b></span>
      <button disabled={working || !operatorConnected || setup.forwarder.balance === "0"} onClick={() => void forward()}>{operatorConnected ? "Forward it to your wallet" : "Connect the operator wallet"}</button>
    </div>}
    {!setup.live && <>
      {operatorConnected && ready && !checked && <label className="stock-eligibility">
        <input type="checkbox" checked={acknowledged} disabled={working} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>I understand these contracts will hold and move real USDC on Arc Mainnet, and that each deployment costs gas in USDC from this wallet.</span>
      </label>}
      {!checked && <button disabled={working || walletVerifying || (Boolean(wallet) && (!operatorConnected || !ready || !acknowledged))} onClick={() => wallet ? void deploy() : void onConnect()}>{label}</button>}
      {problems && <div className="mainnet-lock"><DotIcon name="lock" size={16} /><span><b>Not accepted.</b> {[problems.registry, problems.escrow].filter(Boolean).join(" ")}</span></div>}
      {checked && <div className="escrow-variables" aria-label="Variables to set">
        <p className="escrow-console-note">The deployment passes every check the server runs. Set these in the server's Production environment variables, then redeploy the site; Arc then runs on mainnet with the {platformFeePercent(checked.fees.feeBps)} fee.</p>
        <pre><code>{lines.join("\n")}</code></pre>
        <button onClick={() => void navigator.clipboard.writeText(lines.join("\n")).then(() => onMessage("The three variables were copied."), () => onMessage("Copying was blocked; select the variables above instead."))}>Copy the variables</button>
      </div>}
      {operatorConnected && ready && !checked && <details className="escrow-recovery">
        <summary>Check contracts deployed earlier</summary>
        <div className="escrow-register">
          <input value={manual.registry} onChange={(event) => setManual((current) => ({ ...current, registry: event.target.value }))} placeholder="Registry address (0x…)" aria-label="Arc Mainnet registry address" spellCheck={false} />
          <input value={manual.escrow} onChange={(event) => setManual((current) => ({ ...current, escrow: event.target.value }))} placeholder="Vault escrow address (0x…)" aria-label="Arc Mainnet vault escrow address" spellCheck={false} />
          <button disabled={working || !/^0x[0-9a-fA-F]{40}$/.test(manual.registry.trim()) || !/^0x[0-9a-fA-F]{40}$/.test(manual.escrow.trim())} onClick={() => void checkManual()}>Check</button>
        </div>
      </details>}
    </>}
  </article>;
}
