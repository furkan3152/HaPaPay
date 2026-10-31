import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ELYSIUM_CHAINS, elysiumTxUrl, type ElysiumNetworkId, type ElysiumPaymentRecord } from "../../domain/elysium";
import { platformName } from "../../domain/payment-intent";
import { api, short, usd } from "../api";
import { linkProps } from "../router";
import { useSession } from "../session";
import { Mascot } from "../Mascot";

/**
 * A payment's receipt, shareable by link: who paid which handles how much, the note, the block, and, right after
 * sending, how long Elysium took from the signature to a confirmed receipt. A fresh receipt arrives with a comet
 * that lands on the name and a burst of light.
 */
export function ReceiptPage({ network, hash }: { network: ElysiumNetworkId; hash: string }) {
  const session = useSession();
  const [rows, setRows] = useState<ElysiumPaymentRecord[]>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const ms = Number(query.get("ms")) || undefined;
  const fresh = query.get("fresh") === "1";
  useEffect(() => {
    void api<{ payments: ElysiumPaymentRecord[] }>(`/api/elysium/receipts/${network}/${hash}`).then((value) => setRows(value.payments)).catch((reason) => setError(reason instanceof Error ? reason.message : "This receipt could not be read."));
    if (fresh) window.history.replaceState(null, "", `/r/${network}/${hash}${ms ? `?ms=${ms}` : ""}`);
  }, [network, hash]);
  const view = session.networks?.find((entry) => entry.id === network);
  const explorer = elysiumTxUrl(view ?? { explorerUrl: ELYSIUM_CHAINS[network].explorerUrl ?? null, explorerTxPath: ELYSIUM_CHAINS[network].explorerTxPath }, hash);
  const total = rows?.reduce((sum, row) => sum + Number(row.amount), 0) ?? 0;
  const first = rows?.[0];

  return <div className="page-narrow">
    <article className={`receipt glass ${fresh ? "is-fresh" : ""}`}>
      <div className="receipt-sky" aria-hidden="true">
        <svg viewBox="0 0 400 120" preserveAspectRatio="none"><path className="comet-path" d="M10 100 C 120 10, 260 10, 390 70" /></svg>
        <span className="comet" />
        <span className="burst">{Array.from({ length: 16 }, (_, index) => <i key={index} style={{ "--i": index } as CSSProperties} />)}</span>
      </div>
      {error ? <><h1>Receipt not found</h1><p className="muted">{error}</p></>
        : !rows || !first ? <p className="muted"><span className="spinner" /> Reading the receipt…</p>
        : <>
          <div className="receipt-ely"><Mascot size={110} mood={fresh ? "happy" : "idle"} line={fresh ? "Landed!" : undefined} /></div>
          <p className="eyebrow">Paid on {ELYSIUM_CHAINS[network].chainName}</p>
          <h1 className="receipt-amount"><span className="aurora-text">{total.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span> HYPE</h1>
          {session.hype && <p className="muted">≈ {usd(total * session.hype.mid)} at today's HYPE mid</p>}
          {ms && <p className="speed"><b>{(ms / 1000).toFixed(2)} s</b> from signature to confirmed on Elysium</p>}
          <ul className="receipt-to">
            {rows.map((row) => <li key={`${row.recipient}-${row.username}`}><ProviderIcon provider={row.platform} /><span>@{row.username}<small>{platformName(row.platform)} · {short(row.recipient)}</small></span><b>{row.amount} HYPE</b></li>)}
          </ul>
          <dl className="rows">
            <div><dt>From</dt><dd>{short(first.payer)}</dd></div>
            {first.note && <div><dt>Note</dt><dd>{first.note}</dd></div>}
            <div><dt>Fee</dt><dd>{rows.reduce((sum, row) => sum + Number(row.fee), 0).toLocaleString("en-US", { maximumFractionDigits: 8 })} HYPE</dd></div>
            <div><dt>Block</dt><dd>#{Number(first.blockNumber).toLocaleString("en-US")}</dd></div>
            <div><dt>When</dt><dd>{new Date(first.confirmedAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "medium" })}</dd></div>
            <div><dt>Transaction</dt><dd className="mono">{short(hash)}</dd></div>
          </dl>
          <div className="actions">
            {explorer && <a className="btn btn-glass" href={explorer} target="_blank" rel="noreferrer">View on the explorer</a>}
            <button type="button" className="btn btn-glass" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/r/${network}/${hash}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })}>{copied ? "Link copied" : "Copy receipt link"}</button>
            <a className="btn btn-aurora" {...linkProps("/app")}>New payment</a>
          </div>
        </>}
    </article>
  </div>;
}
