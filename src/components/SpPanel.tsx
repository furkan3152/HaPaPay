import { useState } from "react";
import { formatUsdc, referralLink } from "../domain/referrals";
import { boostAt, formatSp, formatSpBrief, SP_ENTRY_LABELS, type SpEntry, type SpNetwork, type SpRules } from "../domain/sp";
import type { ReferralSummary } from "../referral-desk";
import { DotIcon } from "./DotIcon";
import { DotText } from "./DotText";
import { SpMark } from "./SpMark";
import "./sp.css";

/** An account's SP as the server reports it after awarding anything that had not earned yet. */
export type SpSummary = {
  balance: number;
  today: number;
  dailyCap: number;
  frozen: boolean;
  rulesVersion: number;
  entries: SpEntry[];
  next: string | null;
};

type SpPanelProps = {
  summary?: SpSummary;
  rules?: SpRules;
  referral?: ReferralSummary;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
  authenticated: boolean;
  onRefresh: () => void;
  onMore: () => void;
  onConnect: () => void;
};

const NETWORK_NAMES: Record<SpNetwork, string> = { solana: "Solana", arc: "Arc", robinhood: "Robinhood Chain" };

function when(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

const signed = (amount: number) => `${amount > 0 ? "+" : amount < 0 ? "-" : ""}${formatSp(Math.abs(amount))}`;

/** How SP are earned, from the rules in force, so the page never states a number the server does not use. */
function EarnRules({ rules }: { rules: SpRules }) {
  const boost = boostAt(rules, new Date());
  const multipliers = (Object.entries(rules.networks) as Array<[SpNetwork, number]>).filter(([, value]) => value !== 1);
  return <ul className="sp-rules-list">
    {!rules.earning && <li className="sp-rule-paused">Earning is paused for everyone right now. Payments made now earn no SP.</li>}
    {boost > 1 && rules.boost && <li className="sp-rule-boost">{boost}x SP on payments and claims until {when(rules.boost.endsAt)}.</li>}
    <li><b>Payments you send</b><span>{rules.perDollar} SP for each dollar{rules.perPayment > 0 ? ` and ${formatSpBrief(rules.perPayment)} SP for each payment` : ""}, for payments of ${rules.minUsd} or more on Solana, Arc and Robinhood Chain. SP count to one decimal, rounded down.</span></li>
    <li><b>Vault links you claim</b><span>{rules.claimPerDollar} SP for each dollar.</span></li>
    <li><b>Your vault link is claimed</b><span>The payment's SP when it is delivered, and {formatSpBrief(rules.bonuses.inviteClaimed)} SP (up to {rules.inviteMonthlyLimit} a month). A link taken back earns nothing.</span></li>
    <li><b>Firsts</b><span>{formatSpBrief(rules.bonuses.firstPayment)} SP for your first payment, {formatSpBrief(rules.bonuses.firstClaim)} SP for your first claim.</span></li>
    <li><b>Your account</b><span>{formatSpBrief(rules.bonuses.linkedAccount)} SP for each linked account and {formatSpBrief(rules.bonuses.solanaAddress)} SP for your Solana address, once each.</span></li>
    {multipliers.length > 0 && <li><b>Networks</b><span>{multipliers.map(([network, value]) => `${value}x on ${NETWORK_NAMES[network]}`).join(", ")}.</span></li>}
    <li><b>Limits</b><span>Up to {formatSpBrief(rules.dailyCap)} SP a day (UTC) from payments and claims, and {rules.pairDailyLimit} rewarded payments a day to the same person. Payments to yourself earn nothing.</span></li>
  </ul>;
}

const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

/**
 * Invites: the account's link, and what the people who joined with it earned it, in SP and
 * in USDC that HaPaPay pays on Solana. The shares are the rules in force, read from the server.
 */
function InviteCard({ referral }: { referral: ReferralSummary }) {
  const [copied, setCopied] = useState(false);
  const link = referralLink(window.location.origin, referral.code);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  const { pointsShare, feeShareBps } = referral.rules;
  // A reversed payment's reward that was already paid is set against the next rewards, so nothing is waiting then.
  const owed = BigInt(referral.fees.owed) > 0n ? referral.fees.owed : "0";
  return <section className="sp-invite" aria-labelledby="sp-invite-title">
    <h3 id="sp-invite-title">Invite</h3>
    <p>People who join with your link earn you {percent(pointsShare)} of the SP they earn{feeShareBps > 0 ? <>, and {feeShareBps}% of the 1% fee on every payment they send, paid in USDC on Solana</> : null}.</p>
    <div className="sp-invite-link">
      <input readOnly value={link} aria-label="Your invite link" onFocus={(event) => event.currentTarget.select()} />
      <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
    </div>
    <dl className="sp-invite-stats">
      <div><dt>Joined</dt><dd>{referral.invited.toLocaleString("en-US")}</dd></div>
      <div><dt>SP from invites</dt><dd>{formatSp(referral.sp)}</dd></div>
      <div><dt>USDC earned</dt><dd>{formatUsdc(referral.fees.earned)}</dd></div>
      <div><dt>Paid to you</dt><dd>{formatUsdc(referral.fees.paid)}</dd></div>
    </dl>
    <p className="sp-invite-note">{referral.solanaAddress
      ? `Waiting to be paid: ${formatUsdc(owed)}. HaPaPay pays from ${formatUsdc(referral.minimumPayout)} to your Solana address ${referral.solanaAddress.slice(0, 4)}…${referral.solanaAddress.slice(-4)}.`
      : `Waiting to be paid: ${formatUsdc(owed)}. Add a Solana address under Identities to receive USDC.`}</p>
    {referral.joined && <p className="sp-invite-note">You joined with someone's invite.</p>}
  </section>;
}

/**
 * SP, HaPaPay's social points: one balance for every network, the history of what earned it,
 * and how SP are earned. The server awards SP when it reads the balance, so this panel only shows what the ledger says.
 */
export function SpPanel({ summary, rules, referral, loading, loadingMore, error, authenticated, onRefresh, onMore, onConnect }: SpPanelProps) {
  const share = summary && summary.dailyCap > 0 ? Math.min(100, Math.round((summary.today / summary.dailyCap) * 100)) : 0;
  return <section className="sp-panel" aria-labelledby="sp-title" aria-busy={loading}>
    <div className="sp-heading">
      <h2 id="sp-title"><SpMark size={22} /> SP</h2>
      {authenticated && <button type="button" className="sp-refresh" onClick={onRefresh} disabled={loading} aria-label="Check SP again"><DotIcon name="refresh" size={16} /></button>}
    </div>
    {!authenticated ? <div className="sp-message">
      <p>SP are social points for paying through HaPaPay. Connect your wallet to see your balance; one balance counts every network.</p>
      <button type="button" onClick={onConnect}>Connect wallet</button>
    </div> : error && !summary ? <div className="sp-error" role="alert">
      <p>{error}</p>
      <button type="button" onClick={onRefresh}>Try again</button>
    </div> : !summary ? <p className="sp-loading">Reading your SP…</p> : <>
      <div className="sp-balance">
        <SpMark size={44} className="sp-balance-mark" />
        <div>
          <strong><DotText text={formatSp(summary.balance)} /> <span>SP</span></strong>
          <small>One balance on Solana, Arc and Robinhood Chain</small>
        </div>
      </div>
      <div className="sp-today">
        <div><span>Today from payments and claims</span><b>{formatSp(summary.today)} / {formatSpBrief(summary.dailyCap)}</b></div>
        <span className="sp-meter" role="progressbar" aria-label="SP earned today" aria-valuemin={0} aria-valuemax={summary.dailyCap} aria-valuenow={summary.today}><i style={{ width: `${share}%` }} /></span>
      </div>
      {summary.frozen && <p className="sp-frozen" role="status">Earning is stopped for this account while HaPaPay reviews it. Your balance stays as it is.</p>}
      {referral && <InviteCard referral={referral} />}
      {error && <p className="sp-error-inline" role="status">{error}</p>}
      <div className="sp-history">
        <h3>History</h3>
        {summary.entries.length === 0 ? <p className="sp-empty">No SP yet. Send a payment on any network, link an account or claim a vault link to earn your first SP.</p>
          : <ul>
            {summary.entries.map((entry) => <li key={entry.id} className={entry.amount < 0 ? "sp-entry sp-entry-out" : "sp-entry"}>
              <div>
                <strong>{SP_ENTRY_LABELS[entry.kind]}</strong>
                <small>{entry.detail}{entry.network ? ` · ${NETWORK_NAMES[entry.network]}` : ""}</small>
                <time dateTime={entry.createdAt}>{when(entry.createdAt)}</time>
              </div>
              <b>{signed(entry.amount)}</b>
            </li>)}
          </ul>}
        {summary.next && <button type="button" className="sp-more" onClick={onMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show earlier"}</button>}
      </div>
    </>}
    {rules && <details className="sp-how">
      <summary>How SP are earned</summary>
      <EarnRules rules={rules} />
    </details>}
    <p className="sp-legal">SP are HaPaPay's social points. They have no cash value and cannot be bought, sold or sent. HaPaPay may change how SP are earned; each change is recorded and applies from then on.</p>
  </section>;
}
