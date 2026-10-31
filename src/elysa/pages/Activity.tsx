import { useEffect, useState } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { ElysiumPaymentRecord } from "../../domain/elysium";
import { platformName } from "../../domain/payment-intent";
import { api, short, usd } from "../api";
import { linkProps } from "../router";
import { useSession } from "../session";

/** Activity: every Elysium payment this wallet sent or received through ElysaPay, newest first, each opening its receipt. */
export function ActivityPage() {
  const session = useSession();
  const [rows, setRows] = useState<ElysiumPaymentRecord[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!session.wallet) return;
    void api<{ payments: ElysiumPaymentRecord[] }>("/api/elysium/payments").then((value) => setRows(value.payments)).catch((reason) => setError(reason instanceof Error ? reason.message : "Activity could not be read."));
  }, [session.wallet]);
  const mine = (address: string) => address.toLowerCase() === session.wallet?.toLowerCase();
  const sent = rows?.filter((row) => mine(row.payer)).reduce((sum, row) => sum + Number(row.amount), 0) ?? 0;
  const received = rows?.filter((row) => mine(row.recipient)).reduce((sum, row) => sum + Number(row.amount), 0) ?? 0;
  return <div className="page-card">
    <header className="page-head">
      <p className="eyebrow">Activity</p>
      <h1>Your <span className="aurora-text">Elysium</span> payments</h1>
    </header>
    {!session.wallet ? <div className="empty glass"><p>Connect your wallet to see what you sent and received.</p><button type="button" className="btn btn-aurora" onClick={() => void session.connect()}>Connect</button></div>
      : error ? <p className="banner">{error}</p>
      : !rows ? <p className="muted"><span className="spinner" /> Reading…</p>
      : <>
        <dl className="kpis">
          <div className="glass"><dt>Sent</dt><dd>{sent.toLocaleString("en-US", { maximumFractionDigits: 4 })} <small>HYPE</small></dd>{session.hype && <small>{usd(sent * session.hype.mid)}</small>}</div>
          <div className="glass"><dt>Received</dt><dd>{received.toLocaleString("en-US", { maximumFractionDigits: 4 })} <small>HYPE</small></dd>{session.hype && <small>{usd(received * session.hype.mid)}</small>}</div>
          <div className="glass"><dt>Payments</dt><dd>{rows.length}</dd></div>
        </dl>
        {!rows.length ? <div className="empty glass"><p>Nothing yet. Your first payment will show up here the moment Elysium confirms it.</p><a className="btn btn-aurora" {...linkProps("/app")}>Send HYPE</a></div>
          : <ul className="activity">
            {rows.map((row, index) => {
              const out = mine(row.payer);
              return <li key={`${row.hash}-${row.username}`} style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}>
                <a {...linkProps(`/r/${row.network}/${row.hash}`)}>
                  <span className={`dir ${out ? "out" : "in"}`} aria-hidden="true">{out ? "↗" : "↙"}</span>
                  <span className="who">{out ? <><ProviderIcon provider={row.platform} /> @{row.username}</> : <>From {short(row.payer)}</>}<small>{platformName(row.platform)} · {new Date(row.confirmedAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}{row.note ? ` · ${row.note}` : ""}</small></span>
                  <b className={out ? "" : "in"}>{out ? "−" : "+"}{row.amount} HYPE</b>
                </a>
              </li>;
            })}
          </ul>}
      </>}
  </div>;
}
