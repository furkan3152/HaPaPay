import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DESK_FEATURES, DESK_FEATURE_KEYS, DESK_NOTICE_MAX_LENGTH, PAUSE_MESSAGE_MAX_LENGTH, type DeskControlsView, type DeskFeature } from "../domain/desk-controls";
import { platformName } from "../domain/payment-intent";
import { formatUsdc } from "../domain/referrals";
import { matchesReferralPayout, type PreparedReferralPayout } from "../domain/referral-payout";
import { formatSp, formatSpBrief, isTenths, SP_ADJUST_LIMIT, SP_ENTRY_LABELS, validateSpRules, type SpEntryKind, type SpRules } from "../domain/sp";
import { sendSolanaTransaction, solanaTransactionUrl, solanaWalletToAdd } from "../solana-desk";
import type { SolanaWalletHandle } from "../wallet/solana-wallet";
import { evmProvider } from "../wallet/wallet-bridge";
import { DotIcon } from "./DotIcon";
import { SpMark } from "./SpMark";
import "./admin-page.css";

/**
 * The admin panel: SP, accounts,
 * activity on every network, the desk's pauses and notice, the audit log and exports. It reads with the admin's wallet
 * session; every change is shown in the wallet, signed for that change only, and written to the audit log first.
 */

type LedgerRow = {
  id: string;
  account: string;
  kind: SpEntryKind;
  amount: number;
  sourceKey: string;
  network: string | null;
  /** The verified fee's dollar value in millionths, on a payment row; a payment that earned no SP may still have given an inviter USDC. */
  feeUsdUnits?: number | null;
  usdCents: number | null;
  counterparty: string | null;
  detail: string;
  rulesVersion: number;
  actor: string | null;
  reason: string | null;
  createdAt: string;
};
type RulesVersion = { version: number; rules: SpRules; createdBy: string; note: string | null; createdAt: string };
type AuditEntry = { id: string; actor: string; action: string; target: string | null; details: Record<string, unknown>; createdAt: string };
type ActivityRow = { network: string; kind: string; id: string; sender: string; recipient: string | null; platform: string; username: string; amount: string; symbol: string; expiresAt: string | null; confirmedAt: string };
type Overview = {
  sp: { issued: number; taken: number; holders: number; today: number; entries: number };
  rules: RulesVersion;
  leaderboard: Array<{ account: string; balance: number }>;
  ledger: LedgerRow[];
  audit: AuditEntry[];
  controls: DeskControlsView;
  counts: null | { accounts: number; linkedAccounts: number; payments: Record<string, number>; vaultLinks: Record<string, number> };
  database: "postgres" | "memory";
  lastSync: null | { at: string; synced: number; awarded: number; next: string | null; by: string };
  dailySync: boolean;
};
type AccountView = {
  wallet: string;
  accounts: Array<{ platform: string; username: string; providerUserId: string; verifiedAt: string }>;
  solanaAddress: string | null;
  sp: { balance: number; today: number; dailyCap: number; frozen: boolean; rulesVersion: number };
  flags: { frozen: boolean; reason: string | null; updatedBy: string; updatedAt: string } | null;
  ledger: LedgerRow[];
  payments: Record<string, Array<{ transactionHash: string; direction: string; counterparty: string; amount: string; username: string; confirmedAt: string; asset?: { symbol: string } }>> | null;
  links: { incoming: Array<{ paymentId: string; amount: string; token: { symbol: string }; chainName: string }>; outgoing: Array<{ paymentId: string; amount: string; token: { symbol: string }; chainName: string }>; unavailable: string[] } | null;
  referral: null | {
    code: string; invited: number; joined: boolean; sp: number; fees: { earned: string; paid: string; owed: string };
    invitedBy: { wallet: string; since: string } | null; invitees: Array<{ wallet: string; since: string }>;
  };
};
type InvitesView = {
  totals: { invites: number; earned: string; paid: string; owed: string };
  owed: Array<{ referrer: string; owed: string; address: string | null; frozen: boolean }>;
  batches: Array<{ id: string; payer: string; items: Array<{ referrer: string; address: string; units: string }>; totalUnits: string; createdBy: string; createdAt: string; status: "paid" | "waiting" | "expired"; signature: string | null }>;
  rules: SpRules["referral"];
};
type Note = { tone: "ok" | "error"; text: string };
type Change = (action: string, payload: Record<string, unknown>, done: string) => Promise<unknown>;

const TABS = { overview: "Overview", accounts: "Accounts", ledger: "SP ledger", rules: "SP rules", invites: "Invites", activity: "Activity", controls: "Pauses and notice", audit: "Audit log", data: "Data" } as const;
type Tab = keyof typeof TABS;
const NETWORK_NAMES: Record<string, string> = { solana: "Solana", arc: "Arc", robinhood: "Robinhood Chain" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `The request failed (${response.status}).`);
  return result;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const short = (value: string | null | undefined) => !value ? "" : value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
const when = (value: string | null | undefined) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
};
const signed = (amount: number) => `${amount > 0 ? "+" : amount < 0 ? "-" : ""}${formatSp(Math.abs(amount))}`;
/** A count (holders, rows, payments): whole, with thousands separators. */
const count = (value: number) => Math.trunc(value).toLocaleString("en-US");

export default function AdminPage({ wallet, walletVerifying, message, onConnect }: { wallet?: string; walletVerifying: boolean; message?: string; onConnect: () => void }) {
  const [me, setMe] = useState<{ configured: boolean; admin: boolean }>();
  const [tab, setTab] = useState<Tab>("overview");
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMe(undefined);
    void api<{ configured: boolean; admin: boolean }>("/api/admin/me").then((value) => { if (!cancelled) setMe(value); }).catch(() => { if (!cancelled) setMe({ configured: false, admin: false }); });
    return () => { cancelled = true; };
  }, [wallet]);

  /** One change: the server writes the message, the wallet shows and signs it, the server checks it and runs it once. */
  const change: Change = async (action, payload, done) => {
    if (!wallet) return void onConnect();
    setBusy(true);
    setNote(undefined);
    try {
      const challenge = await api<{ id: string; message: string; payload: Record<string, unknown> }>("/api/admin/challenge", post({ action, payload }));
      const provider = evmProvider();
      if (!provider) throw new Error("Open the wallet you signed in with, then approve the change again.");
      const signature = await provider.request({ method: "personal_sign", params: [challenge.message, wallet] }) as string;
      const result = await api<{ audit: string; result: unknown }>("/api/admin/actions", post({ action, payload: challenge.payload, challengeId: challenge.id, signature }));
      setNote({ tone: "ok", text: `${done} Recorded in the audit log as #${result.audit}.` });
      setRefresh((value) => value + 1);
      return result.result;
    } catch (error) {
      setNote({ tone: "error", text: error instanceof Error ? error.message : "The change was not made." });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const openAccount = (wallet: string) => {
    setAccount(wallet);
    setTab("accounts");
  };

  if (!wallet) {
    return <section className="admin-page"><div className="admin-gate">
      <h1>Admin</h1>
      <p>Connect the admin wallet. Reading needs its session; every change also asks the wallet to sign that change.</p>
      {message && <p role="status">{message}</p>}
      <button type="button" onClick={onConnect} disabled={walletVerifying}>{walletVerifying ? "Verifying…" : "Connect wallet"}</button>
    </div></section>;
  }
  if (!me) return <section className="admin-page"><p className="admin-loading">Checking this wallet…</p></section>;
  if (!me.configured || !me.admin) {
    return <section className="admin-page"><div className="admin-gate">
      <h1>Admin</h1>
      <p>{!me.configured ? "No admin wallet is set on this server. Add the wallet addresses to ADMIN_WALLET_ADDRESSES (separated by commas) and redeploy." : `${short(wallet)} is not an admin of HaPaPay. Connect an admin wallet.`}</p>
    </div></section>;
  }

  return <section className="admin-page" aria-labelledby="admin-title">
    <div className="admin-head">
      <h1 id="admin-title"><SpMark size={24} /> Admin</h1>
      <span>{short(wallet)} · every change is signed and recorded</span>
    </div>
    <nav className="admin-tabs" aria-label="Admin sections">
      {(Object.keys(TABS) as Tab[]).map((key) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{TABS[key]}</button>)}
    </nav>
    {note && <p className={`admin-note admin-note-${note.tone}`} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p>}
    {tab === "overview" && <OverviewTab refresh={refresh} onAccount={openAccount} />}
    {tab === "accounts" && <AccountsTab key={account} initial={account} refresh={refresh} busy={busy} change={change} />}
    {tab === "ledger" && <LedgerTab refresh={refresh} busy={busy} change={change} onAccount={openAccount} />}
    {tab === "rules" && <RulesTab refresh={refresh} busy={busy} change={change} />}
    {tab === "invites" && <InvitesTab refresh={refresh} onAccount={openAccount} />}
    {tab === "activity" && <ActivityTab onAccount={openAccount} />}
    {tab === "controls" && <ControlsTab refresh={refresh} busy={busy} change={change} />}
    {tab === "audit" && <AuditTab refresh={refresh} />}
    {tab === "data" && <DataTab busy={busy} change={change} setNote={setNote} />}
  </section>;
}

function useLoad<T>(path: string | undefined, deps: unknown[]) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const shown = useRef<string>();
  useEffect(() => {
    // Another path is another thing: what the last one showed goes, so a read that fails never leaves it on screen
    // (audit, 2026-10-06: a failed account search kept the previous account's controls). A refresh keeps it.
    if (shown.current !== path) {
      shown.current = path;
      setValue(undefined);
    }
    if (!path) return;
    let cancelled = false;
    setError(undefined);
    void api<T>(path).then((result) => { if (!cancelled) setValue(result); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not read this."); });
    return () => { cancelled = true; };
  }, [path, ...deps]);
  return { value, error, setValue };
}

function Card({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return <section className={wide ? "admin-card admin-card-wide" : "admin-card"}><h2>{title}</h2>{children}</section>;
}

function LedgerTable({ rows, onReverse, onAccount, busy }: { rows: LedgerRow[]; onReverse?: (row: LedgerRow) => void; onAccount?: (wallet: string) => void; busy?: boolean }) {
  if (!rows.length) return <p className="admin-empty">No SP rows.</p>;
  return <div className="admin-table-wrap"><table className="admin-table">
    <thead><tr><th>#</th><th>When</th><th>Account</th><th>Kind</th><th>Detail</th><th className="num">SP</th>{onReverse && <th />}</tr></thead>
    <tbody>{rows.map((row) => <tr key={row.id} className={row.amount === 0 ? "admin-row-zero" : undefined}>
      <td>{row.id}</td>
      <td>{when(row.createdAt)}</td>
      <td>{onAccount ? <button type="button" className="admin-link" onClick={() => onAccount(row.account)}>{short(row.account)}</button> : short(row.account)}</td>
      <td>{SP_ENTRY_LABELS[row.kind] ?? row.kind}{row.network ? ` · ${NETWORK_NAMES[row.network] ?? row.network}` : ""}</td>
      <td>{row.detail}{row.reason ? <small>{row.reason}</small> : null}{row.actor ? <small>by {short(row.actor)}</small> : null}</td>
      <td className={`num ${row.amount < 0 ? "admin-out" : row.amount > 0 ? "admin-in" : ""}`}>{signed(row.amount)}</td>
      {onReverse && <td>{row.kind !== "reversal" && (row.amount !== 0 || (row.kind === "payment" && (row.feeUsdUnits ?? 0) > 0)) && <button type="button" className="admin-small" disabled={busy} onClick={() => onReverse(row)}>Reverse</button>}</td>}
    </tr>)}</tbody>
  </table></div>;
}

function OverviewTab({ refresh, onAccount }: { refresh: number; onAccount: (wallet: string) => void }) {
  const { value, error } = useLoad<Overview>("/api/admin/overview", [refresh]);
  if (error) return <p className="admin-note admin-note-error" role="alert">{error}</p>;
  if (!value) return <p className="admin-loading">Reading…</p>;
  const paused = Object.keys(value.controls.paused) as DeskFeature[];
  return <div className="admin-grid">
    {value.database === "memory" && <p className="admin-note admin-note-error admin-card-wide" role="alert">This server keeps records in memory: they are lost when it restarts. Set DATABASE_URL.</p>}
    <Card title="SP">
      <dl className="admin-stats">
        <div><dt>Issued</dt><dd>{formatSp(value.sp.issued)}</dd></div>
        <div><dt>Taken back</dt><dd>{formatSp(value.sp.taken)}</dd></div>
        <div><dt>Holders</dt><dd>{count(value.sp.holders)}</dd></div>
        <div><dt>Issued today (UTC)</dt><dd>{formatSp(value.sp.today)}</dd></div>
        <div><dt>Ledger rows</dt><dd>{count(value.sp.entries)}</dd></div>
        <div><dt>Rules</dt><dd>v{value.rules.version}{value.rules.rules.earning ? "" : " · earning off"}</dd></div>
      </dl>
    </Card>
    <Card title="Accounts and activity">
      {value.counts ? <dl className="admin-stats">
        <div><dt>Accounts with a linked handle</dt><dd>{count(value.counts.accounts)}</dd></div>
        <div><dt>Linked handles</dt><dd>{count(value.counts.linkedAccounts)}</dd></div>
        {Object.entries(value.counts.payments).map(([network, total]) => <div key={`p-${network}`}><dt>Payments on {NETWORK_NAMES[network] ?? network}</dt><dd>{count(total)}</dd></div>)}
        {Object.entries(value.counts.vaultLinks).map(([network, total]) => <div key={`v-${network}`}><dt>Vault links on {NETWORK_NAMES[network] ?? network}</dt><dd>{count(total)}</dd></div>)}
      </dl> : <p className="admin-empty">Counts are read from the database.</p>}
    </Card>
    <Card title="Desk">
      <p>{paused.length ? `Paused: ${paused.map((feature) => DESK_FEATURES[feature]).join(", ")}.` : "Nothing is paused."}</p>
      <p>{value.controls.notice ? `Notice: ${value.controls.notice.text}` : "No notice on the desk."}</p>
      <p>{value.lastSync ? `Last check for missing SP: ${when(value.lastSync.at)} by ${value.lastSync.by === "cron" ? "the daily run" : short(value.lastSync.by)}, ${count(value.lastSync.synced)} accounts, ${formatSp(value.lastSync.awarded)} SP awarded${value.lastSync.next ? ", more to go" : ""}.` : "No check for missing SP yet."} {value.dailySync ? "A check runs every day at 03:17 UTC." : "The daily check is off: set CRON_SECRET in Vercel to turn it on."}</p>
    </Card>
    <Card title="Top balances">
      {value.leaderboard.length ? <ol className="admin-list">{value.leaderboard.map((entry) => <li key={entry.account}><button type="button" className="admin-link" onClick={() => onAccount(entry.account)}>{short(entry.account)}</button><b>{formatSp(entry.balance)} SP</b></li>)}</ol> : <p className="admin-empty">No SP yet.</p>}
    </Card>
    <Card title="Latest SP rows" wide><LedgerTable rows={value.ledger} onAccount={onAccount} /></Card>
    <Card title="Latest changes" wide>
      {value.audit.length ? <ul className="admin-audit">{value.audit.map((entry) => <li key={entry.id}><b>#{entry.id} {entry.action}</b><span>{short(entry.actor)}{entry.target ? ` → ${short(entry.target)}` : ""} · {when(entry.createdAt)}</span></li>)}</ul> : <p className="admin-empty">No admin changes yet.</p>}
    </Card>
  </div>;
}

function AccountsTab({ initial, refresh, busy, change }: { initial?: string; refresh: number; busy: boolean; change: Change }) {
  const [query, setQuery] = useState(initial ?? "");
  const [search, setSearch] = useState(initial);
  const { value, error } = useLoad<AccountView>(search ? `/api/admin/accounts/${encodeURIComponent(search)}` : undefined, [refresh]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(query.trim() || undefined);
  };
  const needsReason = reason.trim().length < 3;
  return <div className="admin-stack">
    <form className="admin-search" onSubmit={submit}>
      <label htmlFor="admin-account-query">Wallet, platform:handle (github:alice) or Solana address</label>
      <div><input id="admin-account-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="0x… or github:alice" autoComplete="off" spellCheck={false} /><button type="submit"><DotIcon name="search" size={15} /> Find</button></div>
    </form>
    {error && <p className="admin-note admin-note-error" role="alert">{error}</p>}
    {value && <div className="admin-grid">
      <Card title="Account">
        <p className="admin-mono">{value.wallet}</p>
        <ul className="admin-list">
          {value.accounts.map((linked) => <li key={linked.platform}><span>{platformName(linked.platform)} @{linked.username}</span><small>ID {linked.providerUserId} · linked {when(linked.verifiedAt)}</small></li>)}
          {!value.accounts.length && <li><span>No linked handle</span></li>}
          <li><span>Solana</span><small className="admin-mono">{value.solanaAddress ?? "No address"}</small></li>
        </ul>
      </Card>
      <Card title="SP">
        <dl className="admin-stats">
          <div><dt>Balance</dt><dd>{formatSp(value.sp.balance)}</dd></div>
          <div><dt>Today</dt><dd>{formatSp(value.sp.today)} / {formatSpBrief(value.sp.dailyCap)}</dd></div>
          <div><dt>Earning</dt><dd>{value.sp.frozen ? "Stopped" : "On"}</dd></div>
        </dl>
        {value.flags && <p className="admin-empty">{value.flags.frozen ? "Stopped" : "Restarted"} by {short(value.flags.updatedBy)} on {when(value.flags.updatedAt)}: {value.flags.reason}</p>}
      </Card>
      {value.referral && <Card title="Invites">
        <ul className="admin-list">
          <li><span>Invite code</span><b>{value.referral.code}</b></li>
          <li><span>Invited by</span>{value.referral.invitedBy ? <button type="button" className="admin-link" onClick={() => { setQuery(value.referral!.invitedBy!.wallet); setSearch(value.referral!.invitedBy!.wallet); }}>{short(value.referral.invitedBy.wallet)}</button> : <small>Nobody</small>}</li>
          <li><span>Joined with this account's link</span><b>{count(value.referral.invited)}</b></li>
          <li><span>SP from invites</span><b>{formatSp(value.referral.sp)}</b></li>
          <li><span>USDC earned · paid · owed</span><b>{formatUsdc(value.referral.fees.earned)} · {formatUsdc(value.referral.fees.paid)} · {formatUsdc(value.referral.fees.owed)}</b></li>
        </ul>
        {value.referral.invitees.length > 0 && <ul className="admin-list">{value.referral.invitees.map((invitee) => <li key={invitee.wallet}><button type="button" className="admin-link" onClick={() => { setQuery(invitee.wallet); setSearch(invitee.wallet); }}>{short(invitee.wallet)}</button><small>joined {when(invitee.since)}</small></li>)}</ul>}
      </Card>}
      <Card title="Change this account">
        <div className="admin-form">
          <label>SP to add, up to one decimal (negative takes SP)<input type="number" step={0.1} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="50 or -12.5" /></label>
          <label>Reason (kept in the ledger and the audit log)<input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="Why" /></label>
          <div className="admin-actions">
            <button type="button" disabled={busy || needsReason || !isTenths(Number(amount)) || Number(amount) === 0 || Math.abs(Number(amount)) > SP_ADJUST_LIMIT} onClick={() => void change("sp.adjust", { account: value.wallet, amount: Number(amount), reason }, `${signed(Number(amount))} SP for ${short(value.wallet)}.`).then(() => setAmount(""))}>Adjust SP</button>
            <button type="button" disabled={busy || needsReason} onClick={() => void change("sp.freeze", { account: value.wallet, frozen: !value.sp.frozen, reason }, value.sp.frozen ? "Earning restarted." : "Earning stopped.")}>{value.sp.frozen ? "Restart earning" : "Stop earning"}</button>
            <button type="button" disabled={busy} onClick={() => void change("sp.sync", { account: value.wallet }, "Missing SP awarded for this account.")}>Award missing SP</button>
          </div>
        </div>
      </Card>
      <Card title="SP history" wide><LedgerTable rows={value.ledger} busy={busy} onReverse={(row) => {
        const why = window.prompt(`Reverse #${row.id} (${signed(row.amount)} SP)? Give a reason:`);
        if (why) void change("sp.reverse", { entryId: row.id, reason: why }, `Row #${row.id} reversed.`);
      }} /></Card>
      <Card title="Payments" wide>
        {!value.payments ? <p className="admin-empty">Payments could not be read.</p> : Object.entries(value.payments).map(([network, rows]) => <div key={network} className="admin-sub">
          <h3>{NETWORK_NAMES[network] ?? network} · {rows.length}</h3>
          {rows.length ? <ul className="admin-list">{rows.slice(0, 10).map((row) => <li key={`${row.transactionHash}-${row.username}`}><span>{row.direction === "sent" ? `Sent ${row.amount} ${row.asset?.symbol ?? "USDC"} to @${row.username}` : `Received ${row.amount} ${row.asset?.symbol ?? "USDC"} from ${short(row.counterparty)}`}</span><small>{when(row.confirmedAt)} · {short(row.transactionHash)}</small></li>)}</ul> : <p className="admin-empty">None.</p>}
        </div>)}
      </Card>
      <Card title="Vault links open now" wide>
        {!value.links ? <p className="admin-empty">Vault links could not be read.</p> : <>
          <p>Waiting for this account: {value.links.incoming.length} · Sent and not claimed: {value.links.outgoing.length}{value.links.unavailable.length ? ` · Not read: ${value.links.unavailable.join(", ")}` : ""}</p>
          <ul className="admin-list">{[...value.links.incoming, ...value.links.outgoing].map((link) => <li key={link.paymentId}><span>{link.amount} {link.token.symbol} on {link.chainName}</span><small className="admin-mono">{short(link.paymentId)}</small></li>)}</ul>
        </>}
      </Card>
    </div>}
  </div>;
}

function LedgerTab({ refresh, busy, change, onAccount }: { refresh: number; busy: boolean; change: Change; onAccount: (wallet: string) => void }) {
  const [kind, setKind] = useState("");
  const [account, setAccount] = useState("");
  const [zero, setZero] = useState(false);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const query = (before?: string) => `/api/admin/sp/ledger?limit=100${kind ? `&kind=${kind}` : ""}${account.trim() ? `&account=${encodeURIComponent(account.trim())}` : ""}${zero ? "&zero=1" : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const load = async (before?: string) => {
    try {
      const page = await api<{ rows: LedgerRow[]; next: string | null }>(query(before));
      setRows((current) => before ? [...current, ...page.rows] : page.rows);
      setNext(page.next);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the ledger.");
    }
  };
  useEffect(() => { void load(); }, [kind, zero, refresh]);
  return <div className="admin-stack">
    <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>Kind<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All</option>{(Object.keys(SP_ENTRY_LABELS) as SpEntryKind[]).map((key) => <option key={key} value={key}>{SP_ENTRY_LABELS[key]}</option>)}</select></label>
      <label>Account<input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="0x…" spellCheck={false} /></label>
      <label className="admin-check"><input type="checkbox" checked={zero} onChange={(event) => setZero(event.target.checked)} /> Rows that earned nothing</label>
      <button type="submit">Filter</button>
    </form>
    {error && <p className="admin-note admin-note-error" role="alert">{error}</p>}
    <LedgerTable rows={rows} busy={busy} onAccount={onAccount} onReverse={(row) => {
      const why = window.prompt(`Reverse #${row.id} (${signed(row.amount)} SP)? Give a reason:`);
      if (why) void change("sp.reverse", { entryId: row.id, reason: why }, `Row #${row.id} reversed.`);
    }} />
    {next && <button type="button" onClick={() => void load(next)}>Show more</button>}
  </div>;
}

const NUMBER_FIELDS: Array<[keyof SpRules, string, number]> = [
  ["perDollar", "SP per dollar sent", 0.01],
  ["perPayment", "SP per payment", 0.1],
  ["claimPerDollar", "SP per dollar claimed", 0.01],
  ["minUsd", "Minimum payment (USD)", 0.01],
  ["dailyCap", "Daily cap per account (SP)", 0.1],
  ["pairDailyLimit", "Rewarded payments a day to one person", 1],
  ["inviteMonthlyLimit", "Invite bonuses a month", 1],
];
const BONUS_FIELDS: Array<[keyof SpRules["bonuses"], string]> = [
  ["firstPayment", "First payment"], ["firstClaim", "First claim"], ["inviteClaimed", "A sent link is claimed"], ["linkedAccount", "Each linked account"], ["solanaAddress", "Solana address"],
];
const toLocal = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function RulesTab({ refresh, busy, change }: { refresh: number; busy: boolean; change: Change }) {
  const { value, error } = useLoad<{ current: RulesVersion; history: RulesVersion[] }>("/api/admin/sp/rules", [refresh]);
  const [draft, setDraft] = useState<SpRules>();
  const [noteText, setNoteText] = useState("");
  useEffect(() => { if (value) setDraft(structuredClone(value.current.rules)); }, [value]);
  if (error) return <p className="admin-note admin-note-error" role="alert">{error}</p>;
  if (!value || !draft) return <p className="admin-loading">Reading…</p>;
  const checked = validateSpRules(draft);
  const set = (patch: Partial<SpRules>) => setDraft({ ...draft, ...patch });
  return <div className="admin-grid">
    <Card title={`Rules · now v${value.current.version}`} wide>
      <div className="admin-form admin-rules">
        <label className="admin-check"><input type="checkbox" checked={draft.earning} onChange={(event) => set({ earning: event.target.checked })} /> Earning on for everyone</label>
        {NUMBER_FIELDS.map(([key, label, step]) => <label key={key}>{label}<input type="number" step={step} min={0} value={String(draft[key] as number)} onChange={(event) => set({ [key]: Number(event.target.value) } as Partial<SpRules>)} /></label>)}
        <fieldset><legend>Bonuses (SP)</legend>{BONUS_FIELDS.map(([key, label]) => <label key={key}>{label}<input type="number" step={0.1} min={0} value={String(draft.bonuses[key])} onChange={(event) => set({ bonuses: { ...draft.bonuses, [key]: Number(event.target.value) } })} /></label>)}</fieldset>
        <fieldset><legend>Network multipliers</legend>{(["solana", "arc", "robinhood"] as const).map((key) => <label key={key}>{NETWORK_NAMES[key]}<input type="number" step={0.1} min={0} max={10} value={String(draft.networks[key])} onChange={(event) => set({ networks: { ...draft.networks, [key]: Number(event.target.value) } })} /></label>)}</fieldset>
        <fieldset><legend>Invites</legend>
          <label>Inviter's share of the SP an invite earns (%)<input type="number" step={0.1} min={0} max={100} value={String(Math.round(draft.referral.pointsShare * 1000) / 10)} onChange={(event) => set({ referral: { ...draft.referral, pointsShare: Number(event.target.value) / 100 } })} /></label>
          <label>Inviter's share of the 1% fee on each payment, in USDC (percent of the fee; 50 is half, 0.5% of the payment)<input type="number" step={1} min={0} max={100} value={String(draft.referral.feeShareBps)} onChange={(event) => set({ referral: { ...draft.referral, feeShareBps: Number(event.target.value) } })} /></label>
          <label>Daily cap on SP from invites, per inviter<input type="number" step={0.1} min={0} value={String(draft.referral.dailyCap)} onChange={(event) => set({ referral: { ...draft.referral, dailyCap: Number(event.target.value) } })} /></label>
        </fieldset>
        <fieldset><legend>Asset multipliers</legend>{(["stable", "crypto", "stock"] as const).map((key) => <label key={key}>{key === "stable" ? "Stablecoins" : key === "crypto" ? "SOL and other crypto" : "Stock tokens"}<input type="number" step={0.1} min={0} max={10} value={String(draft.assets[key])} onChange={(event) => set({ assets: { ...draft.assets, [key]: Number(event.target.value) } })} /></label>)}</fieldset>
        <fieldset><legend>Boost (a time-boxed multiplier, up to 31 days)</legend>
          <label className="admin-check"><input type="checkbox" checked={Boolean(draft.boost)} onChange={(event) => set({ boost: event.target.checked ? { multiplier: 2, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() } : null })} /> Boost on</label>
          {draft.boost && <>
            <label>Multiplier<input type="number" step={0.1} min={1} max={10} value={String(draft.boost.multiplier)} onChange={(event) => set({ boost: { ...draft.boost!, multiplier: Number(event.target.value) } })} /></label>
            <label>Starts (your time)<input type="datetime-local" value={toLocal(draft.boost.startsAt)} onChange={(event) => set({ boost: { ...draft.boost!, startsAt: new Date(event.target.value).toISOString() } })} /></label>
            <label>Ends (your time)<input type="datetime-local" value={toLocal(draft.boost.endsAt)} onChange={(event) => set({ boost: { ...draft.boost!, endsAt: new Date(event.target.value).toISOString() } })} /></label>
          </>}
        </fieldset>
        <label>Note for the history<input value={noteText} maxLength={300} onChange={(event) => setNoteText(event.target.value)} placeholder="What changed and why" /></label>
        {"error" in checked && <p className="admin-note admin-note-error" role="alert">{checked.error}</p>}
        <div className="admin-actions">
          <button type="button" disabled={busy || "error" in checked} onClick={() => void change("sp.rules", { rules: draft, note: noteText }, `Rules saved as v${value.current.version + 1}. They apply to activity from now on.`)}>Save as v{value.current.version + 1}</button>
          <button type="button" disabled={busy} onClick={() => setDraft(structuredClone(value.current.rules))}>Discard changes</button>
        </div>
      </div>
    </Card>
    <Card title="History" wide>
      <ul className="admin-audit">{value.history.map((version) => <li key={version.version}><b>v{version.version}</b><span>{when(version.createdAt)} · {version.createdBy === "system" ? "starting rules" : short(version.createdBy)}{version.note ? ` · ${version.note}` : ""}</span></li>)}</ul>
    </Card>
  </div>;
}

/**
 * Invites: what inviters earned and were paid, who is owed, and payouts in USDC on Solana.
 * The server prepares a payout for the Solana wallet connected here; the page checks every byte against the people it
 * lists as owed before the wallet opens, and the payout is recorded only from its transaction on Solana.
 */
function InvitesTab({ refresh, onAccount }: { refresh: number; onAccount: (wallet: string) => void }) {
  const [tick, setTick] = useState(0);
  const { value, error } = useLoad<InvitesView>("/api/admin/referrals", [refresh, tick]);
  const [payer, setPayer] = useState<SolanaWalletHandle>();
  const [prepared, setPrepared] = useState<PreparedReferralPayout>();
  /** The transaction each payout was sent in, so "Check again" can name it even before Solana lists it for the payer. */
  const [sent, setSent] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note>();
  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    setNote(undefined);
    try {
      await work();
    } catch (reason) {
      setNote({ tone: "error", text: reason instanceof Error ? reason.message : "That did not work. Nothing was paid." });
    } finally {
      setWorking(false);
    }
  };
  const confirm = async (batch: string, signature?: string) => {
    const result = await api<{ status: "paid" | "waiting" | "expired" }>(`/api/admin/referrals/payouts/${batch}`, post(signature ? { signature } : {}));
    setTick((value) => value + 1);
    return result.status;
  };
  const prepare = () => run(async () => {
    if (!payer || !value) return;
    const next = await api<PreparedReferralPayout>("/api/admin/referrals/payouts", post({ payer: payer.address }));
    // Every person must be one this page lists as owed, at the same address and for exactly what they are owed.
    const owed = new Map(value.owed.map((entry) => [entry.referrer.toLowerCase(), entry]));
    const listed = next.items.every((item) => {
      const entry = owed.get(item.referrer.toLowerCase());
      return entry !== undefined && entry.address === item.address && entry.owed === item.units && !entry.frozen;
    });
    // Each person once: the same person (or address) twice would be paid twice what they are owed.
    const once = new Set(next.items.map((item) => item.referrer.toLowerCase())).size === next.items.length
      && new Set(next.items.map((item) => item.address)).size === next.items.length;
    const review = { payer: payer.address, batch: next.batch, items: next.items.map((item) => ({ address: item.address, units: BigInt(item.units) })) };
    if (!listed || !once || !await matchesReferralPayout(next, review)) throw new Error("The prepared payout does not match the people owed. Nothing was signed; read the page again.");
    setPrepared(next);
  });
  const pay = () => run(async () => {
    if (!payer || !prepared) return;
    let submitted: string | undefined;
    try {
      await sendSolanaTransaction(payer, prepared.transaction, {
        onSubmitted: (signature) => {
          submitted = signature;
          setSent((current) => ({ ...current, [prepared.batch]: signature }));
        },
        revertedMessage: "The payout failed on Solana. Nobody was paid.",
      });
    } catch (reason) {
      if (!submitted) throw reason;
    }
    const status = await confirm(prepared.batch, submitted);
    setPrepared(undefined);
    setNote(status === "paid"
      ? { tone: "ok", text: `Paid ${prepared.items.length} ${prepared.items.length === 1 ? "person" : "people"} ${formatUsdc(prepared.totalUnits)} in USDC. Recorded from the transaction.` }
      : { tone: "error", text: "The payout is not on Solana yet. Check it again below in a minute; it is never paid twice." });
  });
  const check = (batch: string) => run(async () => {
    const status = await confirm(batch, sent[batch]);
    setNote(status === "paid" ? { tone: "ok", text: "That payout is on Solana and recorded." }
      : status === "expired" ? { tone: "error", text: "That payout never landed and can no longer land. Prepare a new one." }
        : { tone: "error", text: "That payout is not on Solana yet." });
  });
  if (error) return <p className="admin-note admin-note-error" role="alert">{error}</p>;
  if (!value) return <p className="admin-loading">Reading…</p>;
  return <div className="admin-grid">
    <Card title="Invites">
      <dl className="admin-stats">
        <div><dt>Joined with an invite</dt><dd>{count(value.totals.invites)}</dd></div>
        <div><dt>USDC earned by inviters</dt><dd>{formatUsdc(value.totals.earned)}</dd></div>
        <div><dt>Paid</dt><dd>{formatUsdc(value.totals.paid)}</dd></div>
        <div><dt>Owed</dt><dd>{formatUsdc(value.totals.owed)}</dd></div>
      </dl>
      <p>Inviters earn {Math.round(value.rules.pointsShare * 1000) / 10}% of the SP the people they invited earn, and {value.rules.feeShareBps}% of the fee HaPaPay verified on each payment those people send, in USDC. A transfer that paid no fee earns nothing. Change the shares under SP rules.</p>
    </Card>
    <Card title="Pay what is owed">
      <p>Everyone owed $1.00 or more with a Solana address is paid in USDC on Solana from the wallet connected here, up to eight people per transaction. The server only prepares it; the payout counts once Solana shows each amount.</p>
      {payer ? <p className="admin-mono">Paying from {payer.address}</p> : <div className="admin-actions"><button type="button" disabled={working} onClick={() => void run(async () => setPayer(await solanaWalletToAdd()))}>Connect the paying Solana wallet</button></div>}
      {payer && !prepared && <div className="admin-actions"><button type="button" disabled={working} onClick={() => void prepare()}>Prepare a payout</button></div>}
      {prepared && <>
        <ul className="admin-list">{prepared.items.map((item) => <li key={item.referrer}><span>{short(item.referrer)} → <span className="admin-mono">{short(item.address)}</span></span><b>{formatUsdc(item.units)}</b></li>)}</ul>
        <div className="admin-actions">
          <button type="button" disabled={working} onClick={() => void pay()}>Sign and pay {formatUsdc(prepared.totalUnits)}</button>
          <button type="button" disabled={working} onClick={() => setPrepared(undefined)}>Cancel</button>
        </div>
      </>}
      {note && <p className={`admin-note admin-note-${note.tone}`} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p>}
    </Card>
    <Card title="Owed" wide>
      {value.owed.length ? <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Inviter</th><th>Solana address</th><th className="num">Owed</th></tr></thead>
        <tbody>{value.owed.map((entry) => <tr key={entry.referrer}>
          <td><button type="button" className="admin-link" onClick={() => onAccount(entry.referrer)}>{short(entry.referrer)}</button>{entry.frozen ? <small>SP stopped: not paid until restarted</small> : null}</td>
          <td>{entry.address ? <span className="admin-mono">{short(entry.address)}</span> : <small>No Solana address yet</small>}</td>
          <td className="num">{formatUsdc(entry.owed)}</td>
        </tr>)}</tbody>
      </table></div> : <p className="admin-empty">Nobody is owed $1.00 or more.</p>}
    </Card>
    <Card title="Payouts" wide>
      {value.batches.length ? <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Prepared</th><th>People</th><th className="num">USDC</th><th>Status</th></tr></thead>
        <tbody>{value.batches.map((batch) => <tr key={batch.id}>
          <td>{when(batch.createdAt)}<small>by {short(batch.createdBy)} from {short(batch.payer)}</small></td>
          <td>{batch.items.length}</td>
          <td className="num">{formatUsdc(batch.totalUnits)}</td>
          <td>{batch.status === "paid" && batch.signature ? <a href={solanaTransactionUrl(batch.signature)} target="_blank" rel="noreferrer">Paid</a>
            : batch.status === "expired" ? "Never landed" : <button type="button" className="admin-small" disabled={working} onClick={() => void check(batch.id)}>Check again</button>}</td>
        </tr>)}</tbody>
      </table></div> : <p className="admin-empty">No payouts yet.</p>}
    </Card>
  </div>;
}

function ActivityTab({ onAccount }: { onAccount: (wallet: string) => void }) {
  const [kind, setKind] = useState<"payment" | "vault_link">("payment");
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const load = async (before?: string) => {
    try {
      const page = await api<{ rows: ActivityRow[]; next: string | null }>(`/api/admin/activity?kind=${kind}&limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      setRows((current) => before ? [...current, ...page.rows] : page.rows);
      setNext(page.rows.length === 100 ? page.next : null);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read activity.");
    }
  };
  useEffect(() => { void load(); }, [kind]);
  return <div className="admin-stack">
    <div className="admin-filters">
      <button type="button" aria-pressed={kind === "payment"} onClick={() => setKind("payment")}>Payments</button>
      <button type="button" aria-pressed={kind === "vault_link"} onClick={() => setKind("vault_link")}>Vault links</button>
    </div>
    {error && <p className="admin-note admin-note-error" role="alert">{error}</p>}
    {!rows.length ? <p className="admin-empty">Nothing yet.</p> : <div className="admin-table-wrap"><table className="admin-table">
      <thead><tr><th>When</th><th>Network</th><th>From</th><th>To</th><th className="num">Amount</th><th>{kind === "payment" ? "Transaction" : "Window ends"}</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.network}-${row.id}`}>
        <td>{when(row.confirmedAt)}</td>
        <td>{NETWORK_NAMES[row.network] ?? row.network}</td>
        <td><button type="button" className="admin-link" onClick={() => onAccount(row.sender)}>{short(row.sender)}</button></td>
        <td>@{row.username} on {platformName(row.platform)}{row.recipient ? <small>{short(row.recipient)}</small> : null}</td>
        <td className="num">{row.amount} {row.symbol}</td>
        <td className="admin-mono">{kind === "payment" ? short(row.id) : when(row.expiresAt)}</td>
      </tr>)}</tbody>
    </table></div>}
    {next && <button type="button" onClick={() => void load(next)}>Show more</button>}
  </div>;
}

function ControlsTab({ refresh, busy, change }: { refresh: number; busy: boolean; change: Change }) {
  const { value, error } = useLoad<Overview>("/api/admin/overview", [refresh]);
  const [messages, setMessages] = useState<Partial<Record<DeskFeature, string>>>({});
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "warning" }>();
  useEffect(() => { if (value) setNotice({ text: value.controls.notice?.text ?? "", tone: value.controls.notice?.tone ?? "info" }); }, [value]);
  if (error) return <p className="admin-note admin-note-error" role="alert">{error}</p>;
  if (!value || !notice) return <p className="admin-loading">Reading…</p>;
  return <div className="admin-grid">
    <Card title="Pauses" wide>
      <p className="admin-empty">A pause stops new payments or new vault links of one kind. Confirming a payment already signed, claiming and refunding never pause.</p>
      <ul className="admin-switches">{DESK_FEATURE_KEYS.map((feature) => {
        const pause = value.controls.paused[feature];
        return <li key={feature} data-paused={Boolean(pause)}>
          <div><b>{DESK_FEATURES[feature]}</b><small>{pause ? `Paused since ${when(pause.since)}: ${pause.message}` : "Running"}</small></div>
          {!pause && <input value={messages[feature] ?? ""} maxLength={PAUSE_MESSAGE_MAX_LENGTH} onChange={(event) => setMessages({ ...messages, [feature]: event.target.value })} placeholder="Message people see (optional)" aria-label={`Pause message for ${DESK_FEATURES[feature]}`} />}
          <button type="button" disabled={busy} onClick={() => void change("switches.set", { key: feature, paused: !pause, message: messages[feature] ?? "" }, pause ? `${DESK_FEATURES[feature]} running again.` : `${DESK_FEATURES[feature]} paused.`)}>{pause ? "Resume" : "Pause"}</button>
        </li>;
      })}</ul>
    </Card>
    <Card title="Desk notice" wide>
      <div className="admin-form">
        <label>Text (plain, up to {DESK_NOTICE_MAX_LENGTH} characters)<textarea value={notice.text} maxLength={DESK_NOTICE_MAX_LENGTH} rows={3} onChange={(event) => setNotice({ ...notice, text: event.target.value })} /></label>
        <label>Tone<select value={notice.tone} onChange={(event) => setNotice({ ...notice, tone: event.target.value === "warning" ? "warning" : "info" })}><option value="info">Information</option><option value="warning">Warning</option></select></label>
        <div className="admin-actions">
          <button type="button" disabled={busy || !notice.text.trim()} onClick={() => void change("notice.set", { text: notice.text, tone: notice.tone }, "The desk shows the notice.")}>Show on the desk</button>
          <button type="button" disabled={busy || !value.controls.notice} onClick={() => void change("notice.set", { text: "", tone: "info" }, "The notice was cleared.")}>Clear</button>
        </div>
      </div>
    </Card>
  </div>;
}

function AuditTab({ refresh }: { refresh: number }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const load = async (before?: string) => {
    try {
      const page = await api<{ entries: AuditEntry[]; next: string | null }>(`/api/admin/audit${before ? `?before=${before}` : ""}`);
      setEntries((current) => before ? [...current, ...page.entries] : page.entries);
      setNext(page.next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the audit log.");
    }
  };
  useEffect(() => { void load(); }, [refresh]);
  return <div className="admin-stack">
    <p className="admin-empty">Every change, who signed it and the signed message. The log only grows: the database refuses edits and deletions.</p>
    {error && <p className="admin-note admin-note-error" role="alert">{error}</p>}
    <ul className="admin-audit admin-audit-full">{entries.map((entry) => <li key={entry.id}>
      <b>#{entry.id} {entry.action}</b>
      <span>{short(entry.actor)}{entry.target ? ` → ${entry.target}` : ""} · {when(entry.createdAt)}</span>
      <details><summary>Details</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>
    </li>)}</ul>
    {!entries.length && !error && <p className="admin-empty">No admin changes yet.</p>}
    {next && <button type="button" onClick={() => void load(next)}>Show more</button>}
  </div>;
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function DataTab({ busy, change, setNote }: { busy: boolean; change: Change; setNote: (note: Note) => void }) {
  const [exporting, setExporting] = useState<string>();
  const [after, setAfter] = useState<string | null>(null);
  const exportTable = async (table: "sp-ledger" | "sp-rules" | "audit", format: "json" | "csv") => {
    setExporting(`${table}.${format}`);
    try {
      const rows: Array<Record<string, unknown>> = [];
      let before: string | null | undefined;
      do {
        const page = await api<{ rows: Array<Record<string, unknown>>; next: string | null }>(`/api/admin/export/${table}${before ? `?before=${encodeURIComponent(before)}` : ""}`);
        rows.push(...page.rows);
        before = page.next;
      } while (before);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      if (format === "json") download(`hapapay-${table}-${stamp}.json`, "application/json", JSON.stringify(rows, null, 2));
      else {
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        download(`hapapay-${table}-${stamp}.csv`, "text/csv", [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n"));
      }
      setNote({ tone: "ok", text: `${rows.length} rows exported.` });
    } catch (error) {
      setNote({ tone: "error", text: error instanceof Error ? error.message : "The export failed." });
    } finally {
      setExporting(undefined);
    }
  };
  return <div className="admin-grid">
    <Card title="Exports">
      <p className="admin-empty">A copy of the SP ledger, the rule versions and the audit log, read a page at a time.</p>
      <div className="admin-actions">
        <button type="button" disabled={Boolean(exporting)} onClick={() => void exportTable("sp-ledger", "csv")}>SP ledger (CSV)</button>
        <button type="button" disabled={Boolean(exporting)} onClick={() => void exportTable("sp-ledger", "json")}>SP ledger (JSON)</button>
        <button type="button" disabled={Boolean(exporting)} onClick={() => void exportTable("sp-rules", "json")}>Rules (JSON)</button>
        <button type="button" disabled={Boolean(exporting)} onClick={() => void exportTable("audit", "csv")}>Audit log (CSV)</button>
      </div>
      {exporting && <p className="admin-loading">Exporting {exporting}…</p>}
    </Card>
    <Card title="Award missing SP">
      <p className="admin-empty">Reads every account's payments, vault links and linked accounts and awards what has no SP yet, by the rules in force when it happened. Running it again never awards twice.</p>
      <div className="admin-actions">
        <button type="button" disabled={busy} onClick={() => void change("sp.sync", after ? { after } : {}, after ? "The next accounts were checked." : "Every account was checked.").then((result) => {
          const next = (result as { next?: string | null } | undefined)?.next ?? null;
          setAfter(next);
        })}>{after ? "Continue with the next accounts" : "Award missing SP for everyone"}</button>
      </div>
    </Card>
    <Card title="Backups" wide>
      <ul className="admin-list">
        <li><span>The SP ledger, the rule versions and the audit log only grow: the database refuses UPDATE, DELETE and TRUNCATE on them.</span></li>
        <li><span>Neon keeps a restore window for the whole database: 6 hours on the Free plan, up to 7 days on Launch and 30 days on Scale. A longer window lets you restore to any moment in it.</span></li>
        <li><span>Export the ledger and the audit log here regularly and keep the files somewhere safe as a second copy.</span></li>
      </ul>
    </Card>
  </div>;
}
