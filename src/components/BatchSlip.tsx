import type { ReactNode } from "react";
import { formatUnits } from "viem";
import { platformName } from "../domain/payment-intent";
import { platformFee, platformFeePercent, type FeeSchedule } from "../domain/fees";
import { DotIcon } from "./DotIcon";
import { DotText } from "./DotText";
import { NoteField } from "./NoteField";
import { ProviderIcon } from "./ProviderIcon";
import { VerifiedMark } from "./StatusMarks";
import "./batch-slip.css";

/** One person in a reviewed batch: who, the wallet the review resolved, and what they receive. */
export type BatchRow = { recipient: { platform: string; username: string }; resolvedAddress: string; amount: string; units: string };
/** Where one payment of a batch stands. Only `waiting` and `failed` are signed again; a sent one never is. */
export type BatchRowState = { status: "waiting" | "signing" | "pending" | "confirmed" | "unverified" | "failed"; hash?: string };

const STATE_LABEL: Record<BatchRowState["status"], string> = {
  waiting: "",
  signing: "Sign in wallet",
  pending: "Pending",
  confirmed: "Verified",
  unverified: "Check",
  failed: "Not sent",
};

/**
 * The review of one request for several people: everyone's amount and wallet, the fee on each payment, the note
 * every payment carries, and how far signing has come. Signing happens in the desk; this only shows it.
 */
export function BatchSlip(props: {
  rows: BatchRow[];
  states: BatchRowState[];
  symbol: string;
  decimals: number;
  mode: "each" | "split" | "listed";
  amount: string;
  totalAmount: string;
  totalUnits: string;
  fees?: FeeSchedule | null;
  networkLabel: string;
  networkDetail?: string;
  explorerUrl?: string;
  theme?: "arc" | "robinhood";
  note: string;
  onNote: (value: string) => void;
  sourcePlatform?: string;
  ready: boolean;
  lockReason: string;
  busy: boolean;
  wallet?: string;
  canSign: boolean;
  onSign: () => void;
  onVerifyAgain: () => void;
  children?: ReactNode;
}) {
  const { rows, states, symbol, decimals } = props;
  const started = states.some(({ status }) => status !== "waiting");
  const confirmed = states.filter(({ status }) => status === "confirmed").length;
  const unverified = states.filter(({ status }) => status === "unverified").length;
  const remaining = rows.length - confirmed - unverified - states.filter(({ status }) => status === "pending" || status === "signing").length;
  const done = confirmed === rows.length;
  const fee = props.fees ? rows.reduce((sum, row) => sum + platformFee(BigInt(row.units)), 0n) : 0n;
  const explorer = props.explorerUrl?.replace(/\/$/, "");
  const label = !props.ready ? "Signing is not available right now"
    : !props.wallet ? "Verify your wallet first"
    : !started ? "Review and sign in wallet"
    : `Send the other ${remaining}`;
  return <article className="payment-slip batch-slip" data-state={done ? "confirmed" : states.some(({ status }) => status === "pending" || status === "signing") ? "pending" : undefined} data-network-theme={props.theme}>
    <div className="slip-top">
      <div><small>{rows.length} payments</small><strong><DotText text={props.totalAmount} /> <span className="slip-symbol">{symbol}</span></strong></div>
      {done && <VerifiedMark />}
    </div>
    <p className="batch-how">{props.mode === "listed" ? "Each gets the amount written for them" : props.mode === "each" ? `Each gets ${props.amount} ${symbol}` : `${props.amount} ${symbol} split between ${rows.length} people`}{props.sourcePlatform ? ` · from your ${platformName(props.sourcePlatform)} identity` : ""}</p>
    <ol className="batch-rows" aria-label="Payments">
      {rows.map((row, index) => {
        const state = states[index] ?? { status: "waiting" as const };
        const link = state.hash && explorer ? `${explorer}/tx/${state.hash}` : undefined;
        return <li key={`${row.recipient.platform}:${row.recipient.username}`} data-state={state.status}>
          <span className="batch-avatar"><ProviderIcon provider={row.recipient.platform} /></span>
          <span className="batch-person"><b>@{row.recipient.username}</b><small>{platformName(row.recipient.platform)} · {row.resolvedAddress.slice(0, 6)}…{row.resolvedAddress.slice(-4)}</small></span>
          <span className="batch-amount">{row.amount} <small>{symbol}</small></span>
          <span className="batch-state" aria-live="polite">{link ? <a href={link} target="_blank" rel="noreferrer">{STATE_LABEL[state.status]} <DotIcon name="arrow-up-right" size={11} /></a> : STATE_LABEL[state.status]}</span>
        </li>;
      })}
    </ol>
    <dl className="stock-facts">
      <div><dt>Network</dt><dd>{props.networkLabel}{props.networkDetail ? <small>{props.networkDetail}</small> : null}</dd></div>
      {props.fees && <div><dt>Fees</dt><dd>{formatUnits(fee, decimals)} {symbol} · {platformFeePercent(props.fees.feeBps)} of each<small>On top of each payment, so everyone receives exactly their amount</small></dd></div>}
      {props.fees && <div><dt>Total</dt><dd>{formatUnits(BigInt(props.totalUnits) + fee, decimals)} {symbol}<small>From your wallet</small></dd></div>}
      <div><dt>In your wallet</dt><dd>{rows.length + 1} steps at most<small>One approval of the total, then one payment for each person</small></dd></div>
    </dl>
    <NoteField id="batch-note" value={props.note} onChange={props.onNote} disabled={started || props.busy} />
    {props.children}
    <div className={`mainnet-lock ${props.ready ? "mainnet-ready" : ""}`}>{props.ready ? <DotIcon name="shield" size={16} /> : <DotIcon name="lock" size={16} />}<span>{props.ready
      ? <><b>Everyone is resolved again before your wallet opens.</b> A payment that went through stays sent if you stop; the rest can be sent afterwards.</>
      : <><b>Signing locked.</b> {props.lockReason}</>}</span></div>
    {!done && <button disabled={!props.canSign || props.busy || remaining === 0} onClick={props.onSign}>{label}</button>}
    {unverified > 0 && <button className="stock-verify-again" disabled={props.busy} onClick={props.onVerifyAgain}>Verify {unverified === 1 ? "the receipt" : `${unverified} receipts`} again</button>}
  </article>;
}
