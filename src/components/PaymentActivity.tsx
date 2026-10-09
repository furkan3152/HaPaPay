import { useState, type CSSProperties, type ReactNode } from "react";
import { paymentActivityPageSize, paymentAssetSymbol, paymentCounterparty, selectPaymentActivity, type PaymentActivityDirection, type PaymentHistoryItem } from "../domain/payment-activity";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import { stockChainById } from "../domain/stock-tokens";
import "./payment-activity.css";
import { DotIcon } from "./DotIcon";

type PaymentActivityProps = {
  payments: PaymentHistoryItem[];
  loading: boolean;
  error?: string;
  authenticated: boolean;
  /** Explorer and name of the Arc runtime chain, used for USDC receipts. */
  explorerUrl?: string;
  chainName?: string;
  /** The selected network, named in the heading before any receipt exists. */
  networkLabel?: string;
  onRefresh: () => void;
  emptyArtwork?: ReactNode;
};

function verifiedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(date);
}

export function PaymentActivity({ payments, loading, error, authenticated, explorerUrl, chainName, networkLabel, onRefresh, emptyArtwork }: PaymentActivityProps) {
  const [direction, setDirection] = useState<PaymentActivityDirection>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(paymentActivityPageSize);
  const activity = selectPaymentActivity(payments, { direction, query, limit });
  // Arc USDC payments use the runtime chain; stock-token transfers name their own Robinhood chain, Solana its own.
  const receiptChain = (payment: PaymentHistoryItem) => payment.asset?.type === "solana"
    ? { name: SOLANA_MAINNET.name, explorerUrl: SOLANA_MAINNET.explorerUrl }
    : payment.asset
      ? { name: stockChainById(payment.asset.chainId)?.name, explorerUrl: stockChainById(payment.asset.chainId)?.explorerUrl }
      : { name: chainName, explorerUrl };
  const chainNames = new Set(payments.map((payment) => receiptChain(payment).name));
  const heading = payments.length === 0 ? networkLabel ?? chainName : chainNames.size === 1 ? [...chainNames][0] : undefined;

  function clearFilters() {
    setDirection("all");
    setQuery("");
    setLimit(paymentActivityPageSize);
  }

  return <section className="payment-activity" aria-label="Verified payment activity" aria-busy={loading}>
    <div className="payment-activity-heading">
      <div><h2>Activity</h2><p>{heading ? `Verified on ${heading}` : "Receipt-confirmed transfers"}</p></div>
      {authenticated && <button type="button" className="activity-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh payment activity" title="Refresh payment activity"><DotIcon name="refresh" size={16} /></button>}
    </div>

    {!authenticated ? loading ? <p className="activity-loading" role="status">Checking wallet session…</p> : <div className="activity-message activity-message-empty">
      {emptyArtwork}<strong>Your receipt collection</strong><p>Verify your wallet to view its payment activity.</p>
    </div> : <>
      <div className="activity-directions" role="group" aria-label="Payment direction" style={{ "--segment": ["all", "sent", "received"].indexOf(direction) } as CSSProperties}>
        {(["all", "sent", "received"] as const).map((value) => <button type="button" key={value} aria-pressed={direction === value} onClick={() => { setDirection(value); setLimit(paymentActivityPageSize); }}>{value === "all" ? "All" : value === "sent" ? "Sent" : "Received"}</button>)}
      </div>
      <label className="activity-search"><span>Search receipts</span><div><DotIcon name="search" size={15} /><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(paymentActivityPageSize); }} placeholder="Handle, wallet, hash or note" /></div></label>

      {error && <div className="activity-load-error" role="alert"><p>Payment activity could not be refreshed.{payments.length > 0 ? " Previously loaded receipts are shown below." : " Try again to load your receipts."}</p><button type="button" onClick={onRefresh} disabled={loading}>Try again</button></div>}
      {loading && <p className="activity-loading" role="status">{payments.length > 0 ? "Refreshing receipts…" : "Loading receipts…"}</p>}

      {payments.length > 0 ? <>
        <p className="activity-result-count" role="status">{activity.total === 0 ? "No matching receipts" : `${activity.items.length} of ${activity.total} ${activity.total === 1 ? "receipt" : "receipts"}`}</p>
        {activity.items.length > 0 ? <div className="activity-receipts">
          {activity.items.map((payment) => {
            const counterparty = paymentCounterparty(payment);
            const label = counterparty.platform ? counterparty.label : `${counterparty.label.slice(0, 6)}…${counterparty.label.slice(-4)}`;
            const chain = receiptChain(payment);
            const key = payment.asset?.type === "solana" ? "solana" : payment.asset?.chainId ?? "arc";
            return <details className="activity-receipt" key={`${key}:${payment.transactionHash}:${payment.counterparty}`}>
              <summary>
                <span className={`activity-direction-icon ${payment.direction}`} aria-hidden="true">{payment.direction === "sent" ? <DotIcon name="arrow-up-right" size={16} /> : <DotIcon name="arrow-down-left" size={16} />}</span>
                <span className="activity-receipt-main"><strong>{payment.amount} <span>{paymentAssetSymbol(payment)}</span></strong><small title={counterparty.label}>{payment.direction === "sent" ? "To" : "From"} {label}{counterparty.platform ? ` · ${counterparty.platform}` : ""}</small><span className="activity-receipt-direction">{payment.direction === "sent" ? "Sent" : "Received"}</span>{payment.note && <span className="activity-receipt-note" title={payment.note}>{payment.note}</span>}</span>
                <DotIcon name="chevron-down" size={15} className="activity-receipt-chevron" />
              </summary>
              <div className="activity-receipt-detail">
                <dl>
                  <div><dt>{payment.direction === "sent" ? "Recipient wallet" : "Sender wallet"}</dt><dd>{payment.counterparty}</dd></div>
                  {payment.note && <div><dt>Note</dt><dd className="activity-note">{payment.note}</dd></div>}
                  {payment.asset?.type === "solana" ? <div><dt>Asset</dt><dd>{payment.asset.symbol}{payment.asset.mint !== "native" ? ` · ${payment.asset.mint}` : ""}</dd></div>
                    : payment.asset && <div><dt>Stock token</dt><dd>{payment.asset.symbol} · {payment.asset.address}</dd></div>}
                  {chain.name && <div><dt>Network</dt><dd>{chain.name}</dd></div>}
                  <div><dt>{payment.asset?.type === "solana" ? "Signature" : "Transaction hash"}</dt><dd>{payment.transactionHash}</dd></div>
                  <div><dt>{payment.asset?.type === "solana" ? "Slot" : "Block"}</dt><dd>{payment.blockNumber}</dd></div>
                  <div><dt>Verified at</dt><dd><time dateTime={payment.confirmedAt}>{verifiedTime(payment.confirmedAt)}</time></dd></div>
                </dl>
                <p>Recorded after receipt verification.</p>
                {chain.explorerUrl && <a href={`${chain.explorerUrl.replace(/\/$/, "")}/tx/${payment.transactionHash}`} target="_blank" rel="noopener noreferrer">View on explorer <DotIcon name="arrow-up-right" size={13} /></a>}
              </div>
            </details>;
          })}
        </div> : <div className="activity-message"><p>Try another search or payment direction.</p><button type="button" onClick={clearFilters}>Clear filters</button></div>}
        {activity.hasMore && <button type="button" className="activity-show-more" onClick={() => setLimit((current) => current + paymentActivityPageSize)}>Show more receipts</button>}
      </> : !loading && !error && <div className="activity-message activity-message-empty">
        {emptyArtwork}<strong>No verified payments yet</strong><p>Receipt-confirmed transfers will appear here. Pending transfers stay separate.</p>
      </div>}
    </>}
  </section>;
}
