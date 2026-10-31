import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ProviderIcon } from "../../components/ProviderIcon";
import { api, short } from "../api";
import { useSession, type Provider } from "../session";


/**
 * Identity: the wallet that signs, and the social accounts that point to it. Each account is linked only through its
 * platform's official sign-in (OAuth, Sign in with Farcaster, Log in with Telegram), and one account belongs to one
 * wallet at a time. A linked account is what lets people pay you by name.
 */
export function IdentityPage() {
  const session = useSession();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [farcaster, setFarcaster] = useState<{ requestId: string; url: string; qr: string }>();
  const polling = useRef(0);
  useEffect(() => () => window.clearTimeout(polling.current), []);

  const linked = (id: string) => session.accounts.find((account) => account.platform === id);

  async function connect(provider: Provider) {
    setError(undefined);
    setBusy(provider.id);
    try {
      if (provider.id === "telegram") return await telegram(provider);
      if (provider.id === "farcaster") {
        const started = await api<{ requestId: string; url: string }>("/api/oauth/farcaster/start", {});
        setFarcaster({ ...started, qr: await QRCode.toDataURL(started.url, { width: 220, margin: 1, color: { dark: "#0A1030", light: "#F4F7FF" } }) });
        const poll = async () => {
          try {
            const result = await api<{ state?: string }>("/api/oauth/farcaster/complete", { requestId: started.requestId });
            if (result.state === "pending") { polling.current = window.setTimeout(poll, 1500); return; }
            setFarcaster(undefined);
            setBusy(undefined);
            await session.refreshProfile();
            session.setNotice("Your Farcaster account is linked.");
          } catch (reason) {
            setFarcaster(undefined);
            setBusy(undefined);
            setError(reason instanceof Error ? reason.message : "Farcaster did not confirm the sign-in.");
          }
        };
        polling.current = window.setTimeout(poll, 1500);
        return;
      }
      const started = await api<{ authorizationUrl: string }>(`/api/oauth/${provider.id}/start?returnTo=${encodeURIComponent("/app/identity")}`);
      window.location.assign(started.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${provider.name} could not start.`);
      setBusy(undefined);
    }
  }

  async function telegram(provider: Provider) {
    if (!window.Telegram?.Login?.auth) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://telegram.org/js/telegram-widget.js?22";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Telegram's sign-in did not load."));
        document.head.append(script);
      });
    }
    window.Telegram!.Login!.auth({ bot_id: provider.botId!, request_access: false }, (user) => void (async () => {
      try {
        if (!user) throw new Error("Telegram sign-in was cancelled. Nothing was linked.");
        await api("/api/oauth/telegram/verify", user);
        await session.refreshProfile();
        session.setNotice("Your Telegram account is linked.");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Telegram did not verify the sign-in.");
      } finally {
        setBusy(undefined);
      }
    })());
  }

  async function unlink(id: string) {
    if (!window.confirm("Unlink this account? Payments by this handle will stop reaching your wallet.")) return;
    setBusy(id);
    try {
      await api(`/api/identity/${id}`, undefined, "DELETE");
      await session.refreshProfile();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "It could not be unlinked.");
    } finally {
      setBusy(undefined);
    }
  }

  return <div className="page-card">
    <header className="page-head">
      <p className="eyebrow">Identity</p>
      <h1>Your name <span className="aurora-text">is your address</span></h1>
      <p className="muted">Link the accounts people know you by. Each one is verified by the platform itself and points to the wallet below.</p>
    </header>
    <div className="glass wallet-card">
      <div><small className="muted">Wallet</small><b>{session.wallet ? short(session.wallet) : "Not connected"}</b></div>
      {session.wallet ? <span className="chip chip-live">signed in</span> : <button type="button" className="btn btn-aurora" onClick={() => void session.connect()} disabled={session.status === "connecting"}>{session.status === "connecting" ? "Connecting…" : "Connect wallet"}</button>}
    </div>
    {error && <p className="banner" role="alert">{error}</p>}
    {farcaster && <div className="glass farcaster-box">
      <img src={farcaster.qr} alt="Scan with Warpcast to sign in with Farcaster" width={200} height={200} />
      <div><b>Sign in with Farcaster</b><p className="muted">Scan with your phone, or <a href={farcaster.url} target="_blank" rel="noreferrer">open the link</a>. This page updates by itself.</p><button type="button" className="btn btn-glass" onClick={() => { window.clearTimeout(polling.current); setFarcaster(undefined); setBusy(undefined); }}>Cancel</button></div>
    </div>}
    <ul className="providers">
      {session.providers.map((provider, index) => {
        const account = linked(provider.id);
        return <li key={provider.id} className="glass" style={{ animationDelay: `${index * 50}ms` }}>
          <ProviderIcon provider={provider.id} />
          <div><b>{provider.name}</b><small className="muted">{account ? `@${account.username} · verified` : provider.configured ? provider.method : "Not set up on this server yet"}</small></div>
          {account
            ? <button type="button" className="btn btn-glass" disabled={busy === provider.id} onClick={() => void unlink(provider.id)}>Unlink</button>
            : <button type="button" className="btn btn-aurora" disabled={!session.wallet || !provider.configured || Boolean(busy)} onClick={() => void connect(provider)}>{busy === provider.id ? "Opening…" : "Connect"}</button>}
        </li>;
      })}
    </ul>
  </div>;
}
