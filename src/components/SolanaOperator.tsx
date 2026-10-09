import { useEffect, useState } from "react";
import { address, getBase58Decoder, getBase58Encoder, type Rpc, type SolanaRpcApiMainnet } from "@solana/kit";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import { compileClose, compileFundDeployer, deploymentCost, deploymentKeys, readDeployedProgram, recoverVaultDeployment, runVaultDeployment, type DeploymentProgress } from "../domain/solana-program-deploy";
import { SOLANA_VAULT_ARTIFACT } from "../domain/solana-vault-artifact";
import { wireTransaction, type SolanaVaultStatus } from "../domain/solana-vault";
import { pageSolanaRpc, sendSolanaTransaction, short, solanaWalletFor } from "../solana-desk";
import { DotIcon } from "./DotIcon";
import { DotText } from "./DotText";

const SEED_KEY = "hapapay-vault-deployment";
const LAMPORTS = 1_000_000_000;
const sol = (lamports: bigint) => (Number(lamports) / LAMPORTS).toFixed(4);

/** The deployment key's seed, kept in this browser until the deployment is finished or its SOL is returned. */
function storedSeed(operator: string) {
  try {
    const value = window.localStorage.getItem(`${SEED_KEY}:${operator}`);
    return value ? new Uint8Array(getBase58Encoder().encode(value)) : undefined;
  } catch {
    return undefined;
  }
}

function storeSeed(operator: string, seed?: Uint8Array) {
  try {
    if (seed) window.localStorage.setItem(`${SEED_KEY}:${operator}`, getBase58Decoder().decode(seed));
    else window.localStorage.removeItem(`${SEED_KEY}:${operator}`);
  } catch {
    // Without storage an interrupted deployment cannot resume; its SOL is returned before the page says it is done.
  }
}

/** Reads the build the page deploys and refuses one that is not the pinned vault program. */
async function readBuild() {
  const response = await fetch(SOLANA_VAULT_ARTIFACT.path, { cache: "no-store" });
  if (!response.ok) throw new Error("The vault program could not be downloaded. Reload the page and try again.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.length !== SOLANA_VAULT_ARTIFACT.size || digest !== SOLANA_VAULT_ARTIFACT.sha256) throw new Error("The downloaded program is not the pinned vault build. Nothing was deployed.");
  return bytes;
}

/** The priority price for the deployment: the recent 75th percentile, at least 20,000 and at most 1,000,000 micro-lamports. */
async function priorityPrice(rpc: Rpc<SolanaRpcApiMainnet>) {
  try {
    const fees = (await rpc.getRecentPrioritizationFees().send()).map(({ prioritizationFee }) => BigInt(prioritizationFee)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const p75 = fees.length ? fees[Math.floor(fees.length * 0.75)] : 0n;
    return p75 < 20_000n ? 20_000n : p75 > 1_000_000n ? 1_000_000n : p75;
  } catch {
    return 20_000n;
  }
}

/**
 * The operator page's Solana card: the vault program deployed from the operator's own Solana wallet with one
 * approval. The page makes a temporary deployment key, the wallet sends it the SOL the deployment needs, the key
 * writes the pinned build, deploys it, writes this server's settings and hands the upgrade authority to the
 * operator's wallet in one transaction, then sends what is left back. The server registers the program only after
 * reading all of it back. The operator can later stop new links and, once the program holds none, close it and get
 * its rent back.
 */
export default function SolanaOperator({ wallet, walletVerifying, solanaAddress, onConnect, onAddSolana, onMessage }: {
  wallet?: string;
  walletVerifying: boolean;
  solanaAddress?: string;
  onConnect: () => void;
  onAddSolana: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [status, setStatus] = useState<SolanaVaultStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<DeploymentProgress>();
  const [cost, setCost] = useState<{ fund: bigint; permanent: bigint; returnable: bigint }>();
  const [costUnread, setCostUnread] = useState(false);
  const [resumable, setResumable] = useState(false);
  const [recovery, setRecovery] = useState("");

  async function load() {
    try {
      const response = await fetch("/api/solana/vault", { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as SolanaVaultStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Solana vault status could not be loaded.");
      setStatus(result);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The Solana vault status could not be loaded.");
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!status?.operator) return;
    setResumable(Boolean(storedSeed(status.operator)));
    void pageSolanaRpc().then(async (rpc) => deploymentCost(rpc, SOLANA_VAULT_ARTIFACT.size, await priorityPrice(rpc))).then(setCost).catch(() => setCostUnread(true));
  }, [status?.operator]);

  const owner = Boolean(status?.operator && solanaAddress === status.operator);
  const ready = Boolean(status && status.setup.length === 0 && status.verifier && status.treasury);
  const program = status?.program;
  const live = Boolean(status?.enabled && program);
  const closed = Boolean(program?.closed);
  const retired = Boolean(program?.retiredAt && !closed);
  /** A registered program that still exists: deploying again makes a second one. */
  const standing = Boolean(program && !closed);

  async function register(programId: string) {
    const response = await fetch("/api/solana/vault/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ programId }) });
    const result = await response.json().catch(() => ({})) as SolanaVaultStatus & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "The vault program could not be registered.");
    setStatus(result);
    return result;
  }

  async function deploy() {
    if (!status?.operator || !status.verifier || !status.treasury || !solanaAddress) return;
    setWorking(true);
    try {
      const build = await readBuild();
      const rpc = await pageSolanaRpc();
      let seed = storedSeed(status.operator);
      if (!seed) {
        seed = crypto.getRandomValues(new Uint8Array(32));
        storeSeed(status.operator, seed);
        setResumable(true);
      }
      const keys = await deploymentKeys(seed);
      const price = await priorityPrice(rpc);
      const needed = await deploymentCost(rpc, build.length, price);
      setCost(needed);
      const already = await readDeployedProgram(rpc, keys.program.address);
      if (!already?.config) {
        const { value: held } = await rpc.getBalance(keys.deployer.address, { commitment: "confirmed" }).send();
        if (held < needed.fund && !already?.code) {
          const handle = await solanaWalletFor(solanaAddress);
          const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
          onMessage(`Approve one transfer of ${sol(needed.fund - held)} SOL to the temporary deployment key. About ${sol(needed.permanent)} SOL stays on chain as the program's rent and fees; the rest comes back when the deployment finishes.`);
          await sendSolanaTransaction(handle, wireTransaction(compileFundDeployer({ ...latest, operator: solanaAddress, deployer: keys.deployer.address, lamports: needed.fund - held })), { revertedMessage: "The funding transfer failed; nothing was deployed." });
        }
      }
      onMessage("Deploying the vault program. Keep this page open; it writes the program in about 120 small transactions without asking your wallet again.");
      const { programId } = await runVaultDeployment({
        rpc, keys, program: build, owner: status.operator, verifier: status.verifier, treasury: status.treasury, returnTo: solanaAddress, computeUnitPrice: price,
        onProgress: setProgress,
      });
      const registered = await register(programId);
      storeSeed(status.operator, undefined);
      setResumable(false);
      // A replacement would cost as much again, so it asks for the statement afresh.
      setAcknowledged(false);
      onMessage(`The Solana vault program ${short(programId)} is deployed and registered, with its upgrade key in your wallet${registered.enabled ? ". Solana vault links are live." : `, but links are not live yet: ${registered.reason ?? "check the server settings"}.`}`);
    } catch (error) {
      onMessage(`${error instanceof Error ? error.message : "The vault program was not deployed."} Press the button again to resume from where it stopped.`);
    } finally {
      setWorking(false);
      setProgress(undefined);
    }
  }

  async function recover() {
    if (!status?.operator || !solanaAddress) return;
    const seed = storedSeed(status.operator);
    if (!seed) return;
    setWorking(true);
    try {
      const rpc = await pageSolanaRpc();
      const returned = await recoverVaultDeployment({ rpc, keys: await deploymentKeys(seed), returnTo: solanaAddress });
      storeSeed(status.operator, undefined);
      setResumable(false);
      onMessage(`The unfinished deployment was closed and ${sol(returned)} SOL went back to your wallet.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The deployment's SOL could not be returned. Try again.");
    } finally {
      setWorking(false);
    }
  }

  /** The first step before closing: the server stops preparing new links; links already sent stay claimable. */
  async function stopNewLinks() {
    setWorking(true);
    try {
      const response = await fetch("/api/solana/vault/retire", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json().catch(() => ({})) as SolanaVaultStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "New vault links could not be stopped.");
      setStatus(result);
      onMessage("New vault links are stopped. Links already sent can still be claimed or taken back; the program can be closed once none is left.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "New vault links could not be stopped.");
    } finally {
      setWorking(false);
    }
  }

  async function resumeNewLinks() {
    if (!program) return;
    setWorking(true);
    try {
      await register(program.id);
      onMessage("New vault links are open again.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "New vault links could not be opened again.");
    } finally {
      setWorking(false);
    }
  }

  /**
   * Closes the program with the operator's wallet, its upgrade authority, and returns its code account's rent to it.
   * The server's count of open links is read again first: a program that still holds a link is never closed.
   */
  async function closeProgram() {
    if (!solanaAddress) return;
    setWorking(true);
    try {
      const response = await fetch("/api/solana/vault", { cache: "no-store" });
      const fresh = await response.json().catch(() => ({})) as SolanaVaultStatus & { error?: string };
      if (!response.ok) throw new Error(fresh.error ?? "The Solana vault status could not be loaded.");
      setStatus(fresh);
      const target = fresh.program;
      if (!target || target.closed) return void onMessage("The vault program is already closed.");
      const check = target.close;
      if (!target.retiredAt || !check?.ready) {
        throw new Error(check && check.openLinks > 0
          ? `The program still holds ${check.openLinks === 1 ? "a link" : `${check.openLinks} links`}, so it was not closed.`
          : "Closing is not open yet: new links have to be stopped for two minutes first.");
      }
      const rpc = await pageSolanaRpc();
      const deployed = await readDeployedProgram(rpc, target.id);
      if (!deployed?.code) {
        await load();
        return void onMessage("The vault program is already closed.");
      }
      if (deployed.authority !== solanaAddress) throw new Error("This wallet is not the program's upgrade authority, so it cannot close it.");
      const { value: held } = await rpc.getBalance(address(deployed.programData), { commitment: "confirmed" }).send();
      const handle = await solanaWalletFor(solanaAddress);
      const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      onMessage(`Approve closing the vault program in your wallet. About ${sol(held)} SOL comes back to it.`);
      await sendSolanaTransaction(handle, wireTransaction(compileClose({ ...latest, authority: solanaAddress, account: deployed.programData, recipient: solanaAddress, program: target.id })), { revertedMessage: "Solana refused to close the program, so nothing changed." });
      await load();
      onMessage(`The vault program is closed and ${sol(held)} SOL went back to your wallet.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The vault program was not closed.");
    } finally {
      setWorking(false);
    }
  }

  async function registerEarlier() {
    setWorking(true);
    try {
      const registered = await register(recovery);
      onMessage(`The Solana vault program ${short(recovery)} is verified and registered${registered.enabled ? ". Solana vault links are live." : "."}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The vault program could not be registered.");
    } finally {
      setWorking(false);
    }
  }

  if (!status) {
    return <article className="payment-slip escrow-console" data-network-theme="solana" aria-busy={!loadError}>
      <p className="escrow-console-note">{loadError ?? "Loading the Solana vault status…"}</p>
      {loadError && <button onClick={() => void load()}>Try again</button>}
    </article>;
  }

  const label = working ? progress ? progress.stage === "write" ? `Writing the program · ${progress.done} of ${progress.total}` : progress.stage === "buffer" ? "Opening the buffer…" : progress.stage === "deploy" ? "Deploying…" : progress.stage === "finalize" ? "Writing the settings…" : "Returning the rest…" : "Working…"
    : !wallet ? walletVerifying ? "Verifying…" : "Connect the operator wallet"
    : !solanaAddress ? "Add the operator's Solana address"
    : !owner ? `Connect ${status.operator ? short(status.operator) : "the operator's Solana wallet"} to deploy`
    : !ready ? "Server setup needed"
    : !acknowledged ? "Confirm the statement above"
    : resumable ? "Resume the deployment"
    : standing ? "Deploy a replacement vault program"
    : "Deploy the vault program";
  // A replacement costs as much as the first program, so it needs the statement too.
  const disabled = working || walletVerifying || (Boolean(wallet) && Boolean(solanaAddress) && (!owner || !ready || !acknowledged));
  const act = () => {
    if (!wallet) return void onConnect();
    if (!solanaAddress) return void onAddSolana();
    void deploy();
  };

  return <article className="payment-slip escrow-console" data-network-theme="solana" aria-label="Solana vault program">
    <div className="slip-top">
      <div><small>Solana mainnet · upgradeable loader</small><DotText as="strong" text="Vault · Solana program" /></div>
      <span className={`escrow-state ${live ? "live" : ready && !retired ? "ready" : ""}`}>{live ? "Live" : retired ? "New links stopped" : !ready ? "Setup needed" : closed ? "Closed" : "Ready to deploy"}</span>
    </div>
    <dl className="stock-facts">
      <div><dt>Program</dt><dd>hapapay_vault · revision {status.artifact.revision}<small>{status.artifact.size.toLocaleString("en")} bytes, SHA-256 {status.artifact.sha256.slice(0, 12)}…, checked by this page before deploying and by the server before it accepts a program</small></dd></div>
      <div><dt>Owner</dt><dd>{status.operator ? <a href={`${SOLANA_MAINNET.explorerUrl}/account/${status.operator}`} target="_blank" rel="noreferrer">{short(status.operator)} <DotIcon name="arrow-up-right" size={12} /></a> : "Not set on the server"}<small>SOLANA_OPERATOR_ADDRESS: deploys the program and may later replace its attestor, treasury or owner</small></dd></div>
      <div><dt>Attestor</dt><dd>{status.verifier ? short(status.verifier) : "Not set on the server"}<small>SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY's public key: signs one claim at a time for a verified account</small></dd></div>
      <div><dt>Treasury</dt><dd>{status.treasury ? <a href={`${SOLANA_MAINNET.explorerUrl}/account/${status.treasury}`} target="_blank" rel="noreferrer">{short(status.treasury)} <DotIcon name="arrow-up-right" size={12} /></a> : "Not set on the server"}<small>SOLANA_TREASURY_ADDRESS: receives the 1% fee of each claimed link</small></dd></div>
      {program && <div><dt>{closed ? "Closed" : "Registered"}</dt><dd><a href={`${SOLANA_MAINNET.explorerUrl}/account/${program.id}`} target="_blank" rel="noreferrer">{program.id} <DotIcon name="arrow-up-right" size={12} /></a><small>{closed
        ? "Its code account is closed and its rent went back to the operator's wallet; nothing runs at this address any more"
        : `Registered ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(program.registeredAt))}; the operator's wallet holds its upgrade key, so it can be closed once no link is open`}</small></dd></div>}
      <div><dt>Cost</dt><dd>{cost ? `About ${sol(cost.permanent)} SOL` : costUnread ? "Solana could not be read from this page (the server may need SOLANA_BROWSER_RPC_URL)" : "Reading the cost from Solana…"}<small>Rent for the program's code and settings plus about 125 transaction fees; the wallet sends {cost ? `${sol(cost.fund)} SOL` : "a little more"} and the rest comes back at once. {cost ? `About ${sol(cost.returnable)} SOL` : "The code's rent"} comes back when you close the program.</small></dd></div>
    </dl>
    {status.setup.length > 0 && <div className="mainnet-lock"><DotIcon name="lock" size={16} /><span><b>Server setup needed.</b> Set {status.setup.join(", ")} in the server's environment variables, then redeploy the site. The attestor must be a new Solana key used for nothing else.</span></div>}
    {status.reason && status.setup.length === 0 && !live && <div className="mainnet-lock"><DotIcon name="lock" size={16} /><span>{status.reason}</span></div>}
    {live && <div className="mainnet-lock mainnet-ready"><DotIcon name="shield" size={16} /><span><b>Solana vault links are live.</b> USDC, USDG and xStocks sent to someone on GitHub, X, Farcaster, Discord or Telegram who has not joined wait in this program.</span></div>}
    {owner && ready && <label className="stock-eligibility">
      <input type="checkbox" checked={acknowledged} disabled={working} onChange={(event) => setAcknowledged(event.target.checked)} />
      <span>{standing
        ? "I understand this deploys a second program on Solana mainnet that costs as much as the first. New links will use it; links already sent stay in the current one."
        : "I understand this deploys a program on Solana mainnet that will hold real tokens for people who have not joined yet. My operator wallet keeps its upgrade key: I can close it later to get its rent back, and whoever holds that key could also change its code."}</span>
    </label>}
    <button className={live ? "stock-verify-again" : undefined} disabled={disabled} onClick={act}>{label}</button>
    {owner && resumable && !working && <button className="stock-verify-again" onClick={() => void recover()}>Stop and return the deployment's SOL</button>}
    {owner && program && !closed && (retired ? <div className="escrow-recovery solana-close" role="group" aria-label="Close the vault program">
      <p><b>New links are stopped.</b> {program.close
        ? program.close.openLinks > 0
          ? `The program still holds ${program.close.openLinks === 1 ? "a link" : `${program.close.openLinks} links`}${program.close.lastExpiry ? `; the last window closes ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(program.close.lastExpiry))}` : ""}. Recipients can still claim and senders can take back after the window; the program can be closed once none is left.`
          : program.close.ready ? "The program holds no link, so it can be closed now." : `The program holds no link. Closing opens at ${new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(new Date(program.close.readyAt))}, once nothing prepared before the stop can still land.`
        : "The links the program still holds could not be read just now."}</p>
      <div className="escrow-register">
        <button disabled={working || !program.close?.ready} onClick={() => void closeProgram()}>{cost ? `Close the program · about ${sol(cost.returnable)} SOL back` : "Close the program"}</button>
        <button className="stock-verify-again" disabled={working} onClick={() => void load()}>Check again</button>
        <button className="stock-verify-again" disabled={working} onClick={() => void resumeNewLinks()}>Open new links again</button>
      </div>
    </div> : live && <details className="escrow-recovery">
      <summary>Close the program and get its rent back</summary>
      <p>Closing starts by stopping new links. Links already sent stay claimable, and senders can take theirs back after the window; once the program holds none, your wallet closes it and gets {cost ? `about ${sol(cost.returnable)} SOL` : "the code's rent"} back.</p>
      <button className="stock-verify-again" disabled={working} onClick={() => void stopNewLinks()}>Stop new vault links</button>
    </details>)}
    {owner && ready && <details className="escrow-recovery">
      <summary>Register a program deployed earlier</summary>
      <div className="escrow-register">
        <input value={recovery} onChange={(event) => setRecovery(event.target.value.trim())} placeholder="Program address" aria-label="Solana vault program address" spellCheck={false} />
        <button disabled={working || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recovery)} onClick={() => void registerEarlier()}>Register</button>
      </div>
    </details>}
  </article>;
}
