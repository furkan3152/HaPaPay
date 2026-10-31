import { useEffect, useMemo, useState, type FormEvent } from "react";
import { encodeDeployData, encodeFunctionData, formatUnits, getAddress, isAddress, parseUnits, stringToHex, type Abi, type Address, type Hex } from "viem";
import { ELYSA_PASS_ARTIFACT, ELYSA_PAY_ROUTER_ARTIFACT, ELYSA_TOKEN_ARTIFACT } from "../domain/elysium-artifacts";
import { countdown, ELYSIUM_CONTRACT_KINDS, ELYSIUM_CONTRACT_LABELS, elysiumAddressUrl, elysiumTxUrl, type ElysiumContractKind, type ElysiumNetworkId, type ElysiumNetworkView, type ElysiumPaymentRecord } from "../domain/elysium";
import { elysiumApi, sendElysiumTransaction, switchToElysium, waitForServer, walletReader } from "../elysium-desk";
import { evmProvider } from "../wallet/wallet-bridge";
import { playCue } from "../sound";

type Change = (action: string, payload: Record<string, unknown>, done: string) => Promise<unknown>;
type Note = { tone: "ok" | "error"; text: string };
type Overview = { networks: ElysiumNetworkView[]; payments: ElysiumPaymentRecord[]; totals: Record<string, { payments: number; volume: number; fees: number; payers: number }> };
type Recorded = { status: "confirmed" | "failed"; hash: string; contractAddress: string | null; audit: string };

const short = (value: string | null | undefined) => !value ? "" : value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
const ARTIFACTS = { router: ELYSA_PAY_ROUTER_ARTIFACT, token: ELYSA_TOKEN_ARTIFACT, pass: ELYSA_PASS_ARTIFACT } as const;
const TIERS = [[1, "Genesis"], [2, "Builder"], [3, "Trader"], [4, "Community"]] as const;
const memo = (text: string) => {
  const hex = stringToHex(text.trim().slice(0, 31));
  return `0x${hex.slice(2).padEnd(64, "0")}` as Hex;
};

/**
 * Elysium in the admin panel: both networks side by side, the mainnet launch gate, and every contract an admin deploys
 * and runs from their own wallet (the payment router, the ELYSA token and the Elysian Pass), on testnet and mainnet.
 * Each deployment and mint opens the admin's wallet; the server only reads the receipt back and writes it to the audit
 * log. Registering a contract or switching a network is a signed admin change like the others.
 */
export function ElysiumAdmin({ wallet, busy, change, setNote, refresh }: { wallet: string; busy: boolean; change: Change; setNote: (note: Note) => void; refresh: number }) {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState<string>();
  const [network, setNetwork] = useState<ElysiumNetworkId>("elysium-testnet");
  const [working, setWorking] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    elysiumApi<Overview>("/api/admin/elysium").then((value) => { if (!cancelled) { setOverview(value); setError(undefined); } }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Elysium could not be read."); });
    return () => { cancelled = true; };
  }, [refresh, reload]);

  const view = overview?.networks.find((entry) => entry.id === network);
  const signedChange: Change = async (action, payload, done) => {
    const result = await change(action, payload, done);
    setReload((value) => value + 1);
    return result;
  };

  /** One wallet transaction from the admin, then its receipt is read back and written to the audit log. */
  async function transact(label: string, call: { to?: string; data: Hex }): Promise<Recorded | undefined> {
    const provider = evmProvider();
    if (!provider || !view) {
      setNote({ tone: "error", text: "Open the admin wallet you signed in with, then try again." });
      return undefined;
    }
    setWorking(true);
    try {
      const hash = await sendElysiumTransaction(provider, wallet, view, call);
      setNote({ tone: "ok", text: `${label}: sent (${short(hash)}). Waiting for ${view.chainName}…` });
      const recorded = await waitForServer(() => elysiumApi<Recorded | { status: "pending" }>("/api/admin/elysium/record", { network, hash, label }));
      if (recorded.status === "failed") throw new Error(`${label} failed on chain. Nothing changed. Audit #${(recorded as Recorded).audit}.`);
      const done = recorded as Recorded;
      playCue("success");
      setNote({ tone: "ok", text: `${label}: confirmed${done.contractAddress ? ` at ${done.contractAddress}` : ""}. Recorded in the audit log as #${done.audit}.` });
      return done;
    } catch (reason) {
      playCue("error");
      setNote({ tone: "error", text: reason instanceof Error ? reason.message.split("\n")[0] : `${label} did not go through.` });
      return undefined;
    } finally {
      setWorking(false);
    }
  }

  if (error) return <p className="admin-empty" role="alert">{error}</p>;
  if (!overview || !view) return <p className="admin-loading">Reading Elysium…</p>;
  const locked = busy || working;
  return <div className="admin-stack elysium-admin">
    <div className="elysium-network-switch" role="radiogroup" aria-label="Elysium network">
      {overview.networks.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={network === entry.id} data-env={entry.environment} onClick={() => setNetwork(entry.id)}>
        <b>{entry.chainName}</b><small>chain {entry.chainId} · {entry.enabled ? "on" : "off"}</small>
      </button>)}
    </div>
    <div className="admin-grid">
      <NetworkCard view={view} totals={overview.totals[view.id]} locked={locked} change={signedChange} />
      {view.environment === "mainnet" ? <LaunchChecklist view={view} testnet={overview.networks[0]} /> : <TestnetCard view={view} />}
    </div>
    <DeployCard key={`deploy-${network}`} view={view} wallet={wallet} locked={locked} transact={transact} change={signedChange} />
    <div className="admin-grid">
      {view.contracts.token ? <TokenCard key={`token-${network}-${view.contracts.token}`} view={view} address={view.contracts.token} wallet={wallet} locked={locked} transact={transact} /> : null}
      {view.contracts.pass ? <PassCard key={`pass-${network}-${view.contracts.pass}`} view={view} address={view.contracts.pass} wallet={wallet} locked={locked} transact={transact} /> : null}
    </div>
    <PaymentsCard payments={overview.payments.filter((payment) => payment.network === network)} view={view} />
  </div>;
}

function NetworkCard({ view, totals, locked, change }: { view: ElysiumNetworkView; totals?: Overview["totals"][string]; locked: boolean; change: Change }) {
  const [rpcUrl, setRpcUrl] = useState(view.environment === "mainnet" ? view.rpcUrl ?? "" : "");
  const [explorerUrl, setExplorerUrl] = useState(view.environment === "mainnet" ? view.explorerUrl ?? "" : "");
  const toggle = (enabled: boolean) => void change("elysium.network", {
    network: view.id, enabled,
    ...(view.environment === "mainnet" ? { rpcUrl, explorerUrl } : {}),
  }, enabled ? `${view.chainName} is on.` : `${view.chainName} is off.`);
  return <section className="admin-card elysium-card" data-env={view.environment}>
    <h2>{view.chainName}</h2>
    <dl className="admin-stats">
      <div><dt>Status</dt><dd>{view.enabled ? "On" : "Off"}</dd></div>
      <div><dt>Chain ID</dt><dd>{view.chainId}</dd></div>
      <div><dt>Settles to</dt><dd>{view.parentChain.name}</dd></div>
      <div><dt>Payments</dt><dd>{totals?.payments ?? 0}</dd></div>
      <div><dt>Volume</dt><dd>{(totals?.volume ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} HYPE</dd></div>
      <div><dt>Fees</dt><dd>{(totals?.fees ?? 0).toLocaleString("en-US", { maximumFractionDigits: 6 })} HYPE</dd></div>
    </dl>
    {view.reason && <p className="elysium-reason">{view.reason}</p>}
    <ul className="admin-list">
      <li><small>RPC</small><span className="admin-mono">{view.rpcUrl ?? "not set"}</span></li>
      <li><small>Explorer</small><span className="admin-mono">{view.explorerUrl ?? "not set"}</span></li>
      {ELYSIUM_CONTRACT_KINDS.map((kind) => <li key={kind}><small>{ELYSIUM_CONTRACT_LABELS[kind]}</small>{view.contracts[kind] ? <a className="admin-mono" href={elysiumAddressUrl(view, view.contracts[kind]!) ?? undefined} target="_blank" rel="noreferrer">{short(view.contracts[kind])}</a> : <span className="admin-mono">not registered</span>}</li>)}
    </ul>
    {view.environment === "mainnet" && <div className="admin-form">
      <label>Official mainnet RPC (https) <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} placeholder="https://rpc.elysium…" /></label>
      <label>Official explorer (https) <input value={explorerUrl} onChange={(event) => setExplorerUrl(event.target.value)} placeholder="https://explorer.elysium…" /></label>
      <p className="admin-empty">The server switches mainnet on only when this RPC answers chain {view.chainId}. Kinetiq had not published it on Oct 31, 2026.</p>
    </div>}
    <div className="admin-actions">
      {view.rpcUrl && <button type="button" className="admin-small" disabled={locked} onClick={() => { const provider = evmProvider(); if (provider) void switchToElysium(provider, view).catch((reason) => window.alert(reason instanceof Error ? reason.message : "The wallet did not switch.")); }}>Switch my wallet here</button>}
      {view.environment === "mainnet" && <button type="button" className="admin-small" disabled={locked} onClick={() => toggle(false)}>Save without switching on</button>}
      <button type="button" disabled={locked} onClick={() => toggle(!view.enabled)}>{view.enabled ? "Switch off" : "Switch on"}</button>
    </div>
  </section>;
}

function TestnetCard({ view }: { view: ElysiumNetworkView }) {
  return <section className="admin-card">
    <h2>Testnet funds</h2>
    <p>Testnet HYPE comes from Kinetiq's faucet, or bridges 1:1 from HyperEVM Testnet. A plain HYPE transfer costs about 21,140 gas on Elysium (the parent-chain posting cost is added), so the desk never hard-codes 21,000.</p>
    <div className="admin-actions">
      {view.faucetUrl && <a className="button-link" href={view.faucetUrl} target="_blank" rel="noreferrer">Open the faucet</a>}
      {view.bridgeUrl && <a className="button-link" href={view.bridgeUrl} target="_blank" rel="noreferrer">Open the bridge</a>}
      {view.explorerUrl && <a className="button-link" href={view.explorerUrl} target="_blank" rel="noreferrer">Explorer</a>}
    </div>
  </section>;
}

function LaunchChecklist({ view, testnet }: { view: ElysiumNetworkView; testnet: ElysiumNetworkView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = countdown(view.launch ?? "", now);
  const steps: Array<[string, boolean]> = [
    ["Router deployed and registered on testnet, and a test payment made", Boolean(testnet.contracts.router)],
    ["Kinetiq published the mainnet RPC and explorer", Boolean(view.rpcUrl && view.explorerUrl)],
    ["Mainnet switched on (the server checked chain 99901)", view.enabled],
    ["Router deployed on mainnet from the admin wallet, with the treasury checked", Boolean(view.contracts.router)],
    ["ELYSA token deployed (optional)", Boolean(view.contracts.token)],
    ["Elysian Pass deployed (optional)", Boolean(view.contracts.pass)],
  ];
  return <section className="admin-card elysium-launch">
    <h2>Mainnet launch</h2>
    <p className="elysium-countdown" aria-live="off">{left.done ? "Launch day has come." : <><b>{left.days}</b>d <b>{String(left.hours).padStart(2, "0")}</b>h <b>{String(left.minutes).padStart(2, "0")}</b>m <b>{String(left.seconds).padStart(2, "0")}</b>s</>}<small>until Nov 9, 2026 (planned)</small></p>
    <ol className="elysium-steps">{steps.map(([label, done]) => <li key={label} data-done={done}>{label}</li>)}</ol>
  </section>;
}

function DeployCard({ view, wallet, locked, transact, change }: { view: ElysiumNetworkView; wallet: string; locked: boolean; transact: (label: string, call: { to?: string; data: Hex }) => Promise<Recorded | undefined>; change: Change }) {
  const [kind, setKind] = useState<ElysiumContractKind>("router");
  const [treasury, setTreasury] = useState(wallet);
  const [name, setName] = useState("Elysa");
  const [symbol, setSymbol] = useState("ELYSA");
  const [cap, setCap] = useState("1000000000");
  const [passName, setPassName] = useState("Elysian Pass");
  const [passSymbol, setPassSymbol] = useState("EPASS");
  const [passCap, setPassCap] = useState("10000");
  const [soulbound, setSoulbound] = useState(true);
  const [baseUri, setBaseUri] = useState("");
  const [address, setAddress] = useState("");
  const [inspected, setInspected] = useState<string>();
  const mainnet = view.environment === "mainnet";

  const deploy = async (event: FormEvent) => {
    event.preventDefault();
    if (mainnet && !window.confirm(`Deploy the ${ELYSIUM_CONTRACT_LABELS[kind]} on Elysium MAINNET from ${wallet}? This spends real HYPE.`)) return;
    let data: Hex;
    try {
      if (kind === "router") {
        if (!isAddress(treasury)) throw new Error("Enter the treasury address that will receive the 1% fee.");
        data = encodeDeployData({ abi: ARTIFACTS.router.abi as Abi, bytecode: ARTIFACTS.router.bytecode as Hex, args: [getAddress(treasury)] });
      } else if (kind === "token") {
        data = encodeDeployData({ abi: ARTIFACTS.token.abi as Abi, bytecode: ARTIFACTS.token.bytecode as Hex, args: [name.trim(), symbol.trim(), parseUnits(cap.trim(), 18), getAddress(wallet)] });
      } else {
        data = encodeDeployData({ abi: ARTIFACTS.pass.abi as Abi, bytecode: ARTIFACTS.pass.bytecode as Hex, args: [passName.trim(), passSymbol.trim(), BigInt(passCap.trim()), soulbound, baseUri.trim(), getAddress(wallet)] });
      }
    } catch (reason) {
      return void window.alert(reason instanceof Error ? reason.message : "Check the fields.");
    }
    const recorded = await transact(`Deploy ${ARTIFACTS[kind].contractName}`, { data });
    if (recorded?.contractAddress) setAddress(recorded.contractAddress);
  };

  const inspect = async () => {
    setInspected(undefined);
    try {
      const result = await elysiumApi<{ address: string; owner?: string; treasury?: string }>("/api/admin/elysium/inspect", { network: view.id, kind, address });
      setInspected(`${ARTIFACTS[kind].contractName} build confirmed at ${result.address}. ${result.owner ? `Owner: ${result.owner}.` : `Fees go to ${result.treasury}.`}`);
    } catch (reason) {
      setInspected(reason instanceof Error ? reason.message : "It could not be read.");
    }
  };

  return <section className="admin-card admin-card-wide elysium-deploy">
    <h2>Deploy from your wallet · {view.chainName}</h2>
    <div className="elysium-kinds" role="radiogroup" aria-label="Contract">
      {ELYSIUM_CONTRACT_KINDS.map((entry) => <button key={entry} type="button" role="radio" aria-checked={kind === entry} onClick={() => { setKind(entry); setInspected(undefined); }}>{ELYSIUM_CONTRACT_LABELS[entry]}</button>)}
    </div>
    <form className="admin-form elysium-deploy-form" onSubmit={deploy}>
      {kind === "router" && <>
        <label>Treasury (receives the 1% fee; fixed forever) <input value={treasury} onChange={(event) => setTreasury(event.target.value)} /></label>
        <p className="admin-empty">No owner and no upgrade: the fee is a constant and the treasury cannot change. Use a multisig for mainnet.</p>
      </>}
      {kind === "token" && <>
        <label>Name <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} /></label>
        <label>Symbol <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} maxLength={11} /></label>
        <label>Maximum supply (whole tokens) <input value={cap} onChange={(event) => setCap(event.target.value)} inputMode="decimal" /></label>
        <p className="admin-empty">Owned by {short(wallet)}: only this wallet mints. Minting can be paused or closed forever; holders can always move and burn their tokens.</p>
      </>}
      {kind === "pass" && <>
        <label>Name <input value={passName} onChange={(event) => setPassName(event.target.value)} maxLength={40} /></label>
        <label>Symbol <input value={passSymbol} onChange={(event) => setPassSymbol(event.target.value.toUpperCase())} maxLength={11} /></label>
        <label>Maximum passes <input value={passCap} onChange={(event) => setPassCap(event.target.value)} inputMode="numeric" /></label>
        <label>Metadata base URI <input value={baseUri} onChange={(event) => setBaseUri(event.target.value)} placeholder="https://…/pass/ or ipfs://…/" /></label>
        <label className="admin-check"><input type="checkbox" checked={soulbound} onChange={(event) => setSoulbound(event.target.checked)} /> Soulbound (a pass never moves after mint)</label>
      </>}
      <div className="admin-actions"><button type="submit" disabled={locked}>{mainnet ? "Deploy on mainnet" : "Deploy on testnet"}</button></div>
    </form>
    <div className="admin-form">
      <label>Register a deployed {ARTIFACTS[kind].contractName} <input value={address} onChange={(event) => { setAddress(event.target.value); setInspected(undefined); }} placeholder="0x…" /></label>
      {inspected && <p className="admin-empty" role="status">{inspected}</p>}
      <div className="admin-actions">
        <button type="button" className="admin-small" disabled={locked || !address} onClick={() => void inspect()}>Check on chain</button>
        <button type="button" disabled={locked || !isAddress(address)} onClick={() => void change("elysium.contract", { network: view.id, kind, address }, `${ARTIFACTS[kind].contractName} registered on ${view.chainName}.`)}>Register (signed)</button>
        {view.contracts[kind] && <button type="button" className="admin-small" disabled={locked} onClick={() => void change("elysium.contract", { network: view.id, kind, address: "" }, `${ARTIFACTS[kind].contractName} removed from ${view.chainName}.`)}>Remove registration</button>}
      </div>
    </div>
  </section>;
}

type ContractState = Record<string, unknown>;

function useContractState(view: ElysiumNetworkView, address: string, abi: Abi, fields: string[], tick: number) {
  const [state, setState] = useState<ContractState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const provider = evmProvider();
    if (!provider) return void setError("Open the admin wallet to read this contract.");
    let cancelled = false;
    void (async () => {
      try {
        const chainId = Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
        if (chainId !== view.chainId) throw new Error(`Switch the wallet to ${view.chainName} to read this contract.`);
        const reader = walletReader(provider);
        const values = await Promise.all(fields.map((functionName) => reader.readContract({ address: address as Address, abi, functionName })));
        if (!cancelled) {
          setState(Object.fromEntries(fields.map((field, index) => [field, values[index]])));
          setError(undefined);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message.split("\n")[0] : "The contract could not be read.");
      }
    })();
    return () => { cancelled = true; };
  }, [view.chainId, address, tick]);
  return { state, error };
}

/** Recipients written one per line as `address` or `address,amount` (`@handle` lines resolve to verified wallets). */
async function readRecipients(text: string, withAmount: boolean) {
  const rows: Array<{ address: Address; amount?: string }> = [];
  for (const line of text.split(/\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const [target, amount] = line.split(/[,;\s]+/);
    let address: string | undefined = target;
    const handle = target.match(/^(github|x|telegram|discord|farcaster):@?([A-Za-z0-9_.-]{1,64})$/i);
    if (handle) address = (await elysiumApi<{ address: string }>(`/api/resolve/${handle[1].toLowerCase()}/${encodeURIComponent(handle[2])}`).catch(() => undefined))?.address;
    if (!address || !isAddress(address)) throw new Error(`"${target}" is not an address or a verified platform:@handle.`);
    if (withAmount && !(amount && /^\d+(\.\d{1,18})?$/.test(amount))) throw new Error(`Give an amount for ${target}.`);
    rows.push({ address: getAddress(address), amount });
  }
  return rows;
}

function TokenCard({ view, address, wallet, locked, transact }: { view: ElysiumNetworkView; address: string; wallet: string; locked: boolean; transact: (label: string, call: { to?: string; data: Hex }) => Promise<Recorded | undefined> }) {
  const [tick, setTick] = useState(0);
  const { state, error } = useContractState(view, address, ELYSA_TOKEN_ARTIFACT.abi as Abi, ["name", "symbol", "totalSupply", "cap", "owner", "pendingOwner", "mintingPaused", "mintingClosed"], tick);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [batch, setBatch] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const abi = ELYSA_TOKEN_ARTIFACT.abi as Abi;
  const call = async (label: string, functionName: string, args: unknown[]) => {
    const done = await transact(label, { to: address, data: encodeFunctionData({ abi, functionName, args }) });
    if (done) setTick((value) => value + 1);
  };
  const isOwner = state && String(state.owner).toLowerCase() === wallet.toLowerCase();
  const confirmMainnet = (what: string) => view.environment !== "mainnet" || window.confirm(`${what} on Elysium MAINNET?`);

  return <section className="admin-card elysium-token">
    <h2>{state ? `${state.symbol} token` : "ELYSA token"}</h2>
    {error && <p className="admin-empty">{error} <button type="button" className="admin-small" onClick={() => setTick((value) => value + 1)}>Read again</button></p>}
    {state && <dl className="admin-stats">
      <div><dt>Supply</dt><dd>{Number(formatUnits(state.totalSupply as bigint, 18)).toLocaleString("en-US")}</dd></div>
      <div><dt>Cap</dt><dd>{Number(formatUnits(state.cap as bigint, 18)).toLocaleString("en-US")}</dd></div>
      <div><dt>Minting</dt><dd>{state.mintingClosed ? "closed" : state.mintingPaused ? "paused" : "open"}</dd></div>
      <div><dt>Owner</dt><dd className="admin-mono">{short(String(state.owner))}</dd></div>
    </dl>}
    {state && !isOwner && <p className="admin-note admin-note-error">This wallet is not the token's owner, so mints from it will fail.</p>}
    <form className="admin-form" onSubmit={async (event) => {
      event.preventDefault();
      try {
        const [row] = await readRecipients(to, false);
        if (!row || !/^\d+(\.\d{1,18})?$/.test(amount)) throw new Error("Enter a recipient and an amount.");
        if (!confirmMainnet(`Mint ${amount} to ${row.address}`)) return;
        await call(`Mint ${amount} ${String(state?.symbol ?? "ELYSA")}`, "mint", [row.address, parseUnits(amount, 18), memo(note)]);
      } catch (reason) {
        window.alert(reason instanceof Error ? reason.message : "Check the fields.");
      }
    }}>
      <label>Recipient (address or x:@handle) <input value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <label>Amount <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /></label>
      <label>Memo (on chain, up to 31 characters) <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={31} /></label>
      <div className="admin-actions"><button type="submit" disabled={locked || !isOwner}>Mint</button></div>
    </form>
    <form className="admin-form" onSubmit={async (event) => {
      event.preventDefault();
      try {
        const rows = await readRecipients(batch, true);
        if (!rows.length || rows.length > 200) throw new Error("Write 1 to 200 lines.");
        if (!confirmMainnet(`Airdrop to ${rows.length} wallets`)) return;
        await call(`Airdrop to ${rows.length} wallets`, "mintBatch", [rows.map((row) => row.address), rows.map((row) => parseUnits(row.amount!, 18)), memo(note || "airdrop")]);
      } catch (reason) {
        window.alert(reason instanceof Error ? reason.message : "Check the list.");
      }
    }}>
      <label>Airdrop (one per line: address,amount or x:@handle,amount; up to 200) <textarea rows={4} value={batch} onChange={(event) => setBatch(event.target.value)} /></label>
      <div className="admin-actions"><button type="submit" disabled={locked || !isOwner}>Airdrop</button></div>
    </form>
    <div className="admin-actions">
      <button type="button" className="admin-small" disabled={locked || !isOwner || Boolean(state?.mintingClosed)} onClick={() => void call(state?.mintingPaused ? "Resume minting" : "Pause minting", "setMintingPaused", [!state?.mintingPaused])}>{state?.mintingPaused ? "Resume minting" : "Pause minting"}</button>
      <button type="button" className="admin-small" disabled={locked || !isOwner || Boolean(state?.mintingClosed)} onClick={() => window.prompt("This closes minting FOREVER. Type CLOSE to confirm.") === "CLOSE" && void call("Close minting forever", "closeMinting", [])}>Close minting forever</button>
    </div>
    <OwnershipControls state={state} wallet={wallet} locked={locked} newOwner={newOwner} setNewOwner={setNewOwner} call={call} />
  </section>;
}

function PassCard({ view, address, wallet, locked, transact }: { view: ElysiumNetworkView; address: string; wallet: string; locked: boolean; transact: (label: string, call: { to?: string; data: Hex }) => Promise<Recorded | undefined> }) {
  const [tick, setTick] = useState(0);
  const { state, error } = useContractState(view, address, ELYSA_PASS_ARTIFACT.abi as Abi, ["name", "symbol", "totalMinted", "totalSupply", "maxSupply", "soulbound", "owner", "pendingOwner", "mintingPaused", "mintingClosed", "metadataFrozen"], tick);
  const [list, setList] = useState("");
  const [tier, setTier] = useState(1);
  const [uri, setUri] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const abi = ELYSA_PASS_ARTIFACT.abi as Abi;
  const call = async (label: string, functionName: string, args: unknown[]) => {
    const done = await transact(label, { to: address, data: encodeFunctionData({ abi, functionName, args }) });
    if (done) setTick((value) => value + 1);
  };
  const isOwner = state && String(state.owner).toLowerCase() === wallet.toLowerCase();
  const tierName = useMemo(() => TIERS.find(([value]) => value === tier)?.[1] ?? "", [tier]);
  return <section className="admin-card elysium-pass">
    <h2>{state ? String(state.name) : "Elysian Pass"}</h2>
    {error && <p className="admin-empty">{error} <button type="button" className="admin-small" onClick={() => setTick((value) => value + 1)}>Read again</button></p>}
    {state && <dl className="admin-stats">
      <div><dt>Minted</dt><dd>{String(state.totalMinted)} / {String(state.maxSupply)}</dd></div>
      <div><dt>Held</dt><dd>{String(state.totalSupply)}</dd></div>
      <div><dt>Kind</dt><dd>{state.soulbound ? "soulbound" : "transferable"}</dd></div>
      <div><dt>Minting</dt><dd>{state.mintingClosed ? "closed" : state.mintingPaused ? "paused" : "open"}</dd></div>
    </dl>}
    {state && !isOwner && <p className="admin-note admin-note-error">This wallet is not the pass's owner, so mints from it will fail.</p>}
    <form className="admin-form" onSubmit={async (event) => {
      event.preventDefault();
      try {
        const rows = await readRecipients(list, false);
        if (!rows.length || rows.length > 100) throw new Error("Write 1 to 100 lines.");
        if (view.environment === "mainnet" && !window.confirm(`Mint ${rows.length} ${tierName} passes on Elysium MAINNET?`)) return;
        if (rows.length === 1) await call(`Mint a ${tierName} pass`, "mint", [rows[0].address, tier]);
        else await call(`Mint ${rows.length} ${tierName} passes`, "mintBatch", [rows.map((row) => row.address), tier]);
      } catch (reason) {
        window.alert(reason instanceof Error ? reason.message : "Check the list.");
      }
    }}>
      <label>Tier <select value={tier} onChange={(event) => setTier(Number(event.target.value))}>{TIERS.map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}</select></label>
      <label>Holders (one per line: address or x:@handle; up to 100) <textarea rows={4} value={list} onChange={(event) => setList(event.target.value)} /></label>
      <div className="admin-actions"><button type="submit" disabled={locked || !isOwner}>Mint passes</button></div>
    </form>
    <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void call("Set the metadata URI", "setBaseURI", [uri.trim()]); }}>
      <label>Metadata base URI <input value={uri} onChange={(event) => setUri(event.target.value)} placeholder="ipfs://…/" disabled={Boolean(state?.metadataFrozen)} /></label>
      <div className="admin-actions">
        <button type="submit" className="admin-small" disabled={locked || !isOwner || Boolean(state?.metadataFrozen) || !uri.trim()}>Set URI</button>
        <button type="button" className="admin-small" disabled={locked || !isOwner || Boolean(state?.metadataFrozen)} onClick={() => window.prompt("This freezes the metadata FOREVER. Type FREEZE to confirm.") === "FREEZE" && void call("Freeze metadata", "freezeMetadata", [])}>Freeze metadata</button>
      </div>
    </form>
    <div className="admin-actions">
      <button type="button" className="admin-small" disabled={locked || !isOwner || Boolean(state?.mintingClosed)} onClick={() => void call(state?.mintingPaused ? "Resume minting" : "Pause minting", "setMintingPaused", [!state?.mintingPaused])}>{state?.mintingPaused ? "Resume minting" : "Pause minting"}</button>
      <button type="button" className="admin-small" disabled={locked || !isOwner || Boolean(state?.mintingClosed)} onClick={() => window.prompt("This closes minting FOREVER. Type CLOSE to confirm.") === "CLOSE" && void call("Close minting forever", "closeMinting", [])}>Close minting forever</button>
    </div>
    <OwnershipControls state={state} wallet={wallet} locked={locked} newOwner={newOwner} setNewOwner={setNewOwner} call={call} />
  </section>;
}

function OwnershipControls({ state, wallet, locked, newOwner, setNewOwner, call }: { state?: ContractState; wallet: string; locked: boolean; newOwner: string; setNewOwner: (value: string) => void; call: (label: string, functionName: string, args: unknown[]) => Promise<void> }) {
  if (!state) return null;
  const isOwner = String(state.owner).toLowerCase() === wallet.toLowerCase();
  const pending = String(state.pendingOwner);
  const isPending = pending.toLowerCase() === wallet.toLowerCase();
  return <details className="elysium-ownership">
    <summary>Ownership</summary>
    <p className="admin-empty">Two steps: the owner names the next owner, who accepts from their own wallet. {pending !== "0x0000000000000000000000000000000000000000" ? `Waiting for ${short(pending)} to accept.` : ""}</p>
    <div className="admin-search"><div>
      <input value={newOwner} onChange={(event) => setNewOwner(event.target.value)} placeholder="New owner (a multisig is best)" />
      <button type="button" className="admin-small" disabled={locked || !isOwner || !isAddress(newOwner)} onClick={() => void call("Start an ownership transfer", "transferOwnership", [getAddress(newOwner)])}>Name</button>
    </div></div>
    {isPending && <button type="button" className="admin-small" disabled={locked} onClick={() => void call("Accept ownership", "acceptOwnership", [])}>Accept ownership</button>}
  </details>;
}

function PaymentsCard({ payments, view }: { payments: ElysiumPaymentRecord[]; view: ElysiumNetworkView }) {
  return <section className="admin-card admin-card-wide">
    <h2>HYPE payments · {view.chainName}</h2>
    {!payments.length ? <p className="admin-empty">No payments on this network yet.</p> : <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>When</th><th>From</th><th>To</th><th className="num">Amount</th><th className="num">Fee</th><th>Note</th></tr></thead>
      <tbody>{payments.map((payment) => <tr key={payment.hash}>
        <td><a href={elysiumTxUrl(view, payment.hash) ?? undefined} target="_blank" rel="noreferrer">{new Date(payment.confirmedAt).toLocaleString("en")}</a></td>
        <td className="admin-mono">{short(payment.payer)}</td>
        <td>@{payment.username} <small>{payment.platform}</small></td>
        <td className="num">{payment.amount} HYPE</td>
        <td className="num">{payment.fee}</td>
        <td>{payment.note}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
