import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { ProviderIcon } from "../../components/ProviderIcon";
import { platformName, type Platform } from "../../domain/payment-intent";
import { linkProps } from "../router";
import { useSession } from "../session";

/**
 * Request: a payment link (and its QR code) for one of your linked handles, with an amount and a note if you like.
 * Whoever opens it lands on Send with everything filled in and pays your verified wallet from theirs.
 */
export function RequestPage() {
  const session = useSession();
  const [index, setIndex] = useState(0);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);
  const account = session.accounts[index];
  const link = useMemo(() => {
    if (!account) return "";
    const query = new URLSearchParams();
    if (amount.trim()) query.set("amount", amount.trim());
    if (note.trim()) query.set("note", note.trim());
    return `${window.location.origin}/pay/${account.platform}/${encodeURIComponent(account.username)}${query.size ? `?${query}` : ""}`;
  }, [account, amount, note]);
  useEffect(() => {
    if (!link) return setQr(undefined);
    void QRCode.toDataURL(link, { width: 240, margin: 1, color: { dark: "#0A1030", light: "#F4F7FF" } }).then(setQr);
  }, [link]);

  return <div className="page-card">
    <header className="page-head">
      <p className="eyebrow">Request</p>
      <h1>Share a link, <span className="aurora-text">get paid</span></h1>
      <p className="muted">A link or QR code for your handle. The payer reviews it, signs it in their wallet, and the HYPE lands in yours.</p>
    </header>
    {!session.wallet ? <div className="empty glass"><p>Connect your wallet, then link an account to request payments with it.</p><button type="button" className="btn btn-aurora" onClick={() => void session.connect()}>Connect</button></div>
      : !session.accounts.length ? <div className="empty glass"><p>Link a GitHub, X, Farcaster, Telegram or Discord account first: the link pays the wallet that account verified.</p><a className="btn btn-aurora" {...linkProps("/app/identity")}>Link an account</a></div>
      : <div className="request-grid">
        <div className="form">
          <div className="platforms" role="radiogroup" aria-label="Your handle">
            {session.accounts.map((entry, at) => <button key={`${entry.platform}:${entry.username}`} type="button" role="radio" aria-checked={index === at} onClick={() => setIndex(at)}>
              <ProviderIcon provider={entry.platform} /><span>@{entry.username}</span>
            </button>)}
          </div>
          <label className="field"><span>Amount in HYPE <small className="muted">optional</small></span><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="5" /></label>
          <label className="field"><span>Note <small className="muted">optional</small></span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={140} placeholder="March rent" /></label>
          <div className="link-box"><code>{link}</code><button type="button" className="btn btn-glass" onClick={() => void navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })}>{copied ? "Copied" : "Copy"}</button></div>
          {typeof navigator.share === "function" && <button type="button" className="btn btn-aurora" onClick={() => void navigator.share({ title: "Pay me on ElysaPay", text: `Pay @${account.username} on ${platformName(account.platform as Platform)} with ElysaPay`, url: link }).catch(() => undefined)}>Share</button>}
        </div>
        <figure className="qr glass">
          {qr ? <img src={qr} alt={`QR code for ${link}`} width={240} height={240} /> : <span className="spinner" />}
          <figcaption><ProviderIcon provider={account.platform} /> @{account.username}{amount && <b> · {amount} HYPE</b>}</figcaption>
        </figure>
      </div>}
  </div>;
}
