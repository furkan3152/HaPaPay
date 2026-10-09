import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { ARC_MAINNET } from "../domain/arc-chains";
import { ROBINHOOD_ASSET_ALLOWLISTS, ROBINHOOD_USDG } from "../domain/robinhood-assets";
import { STOCK_CLAIM_WINDOW_HOURS, type StockEscrowDeployment } from "../domain/stock-claims";
import { STOCK_CHAINS } from "../domain/stock-tokens";
import { PAYMENT_NOTE_MAX_CHARACTERS } from "../domain/payment-note";
import { PAYMENT_BATCH_MAX_RECIPIENTS } from "../domain/routed-payments";
import { SOLANA_USDC, SOLANA_USDG } from "../domain/solana-assets";
import { SOLANA_MAINNET } from "../domain/solana-chains";
import { SOLANA_XSTOCK_COUNT } from "../domain/solana-stock-count";
import { formatSpBrief, type SpRules } from "../domain/sp";
import { DotText } from "./DotText";
import { SpMark } from "./SpMark";
import "./docs-page.css";
import { DotIcon } from "./DotIcon";

type Health = {
  network?: string;
  stockTransfers?: Record<string, string>;
  tokenTransfers?: Record<string, string>;
  stockClaims?: Record<string, string>;
  claimablePayments?: string;
  paymentHistory?: string;
  recipientLookup?: { github?: string; x?: string; farcaster?: string };
  solana?: { transfers?: string; stocks?: string };
};
type SolanaVaultStatus = { enabled?: boolean; program?: { id: string } };
type Provider = { id: string; name: string; configured: boolean; method: string };
type EscrowStatus = { networks: StockEscrowDeployment[] };

const explorerOf = (chain: { explorerUrl: string }) => chain.explorerUrl.replace(/\/$/, "");
const rpcOf = (chain: { rpcUrl: string }) => chain.rpcUrl.replace(/\/$/, "");
/** This site's own origin, shown in links and in the callbacks an operator registers. */
const APP_ORIGIN = typeof window === "undefined" ? "https://your-domain.example" : window.location.origin;

const sections = [
  { id: "overview", title: "What HaPaPay is" },
  { id: "quick-start", title: "Quick start" },
  { id: "accounts", title: "Connect your accounts" },
  { id: "sending", title: "Send money and tokens" },
  { id: "vault", title: "The vault: send to anyone" },
  { id: "claiming", title: "Claim what was sent to you" },
  { id: "sp", title: "SP points" },
  { id: "networks", title: "Networks, assets and contracts" },
  { id: "security", title: "Security model" },
  { id: "fees", title: "Fees" },
  { id: "faq", title: "Questions and fixes" },
  { id: "operators", title: "Operator guide" },
  { id: "legal", title: "Legal notes" },
] as const;

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

function External({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children} <DotIcon name="arrow-up-right" size={12} /></a>;
}

function Address({ value, explorer }: { value: string; explorer: string }) {
  return <a className="docs-address" href={`${explorer}/address/${value}`} target="_blank" rel="noreferrer"><code>{value}</code> <DotIcon name="arrow-up-right" size={12} /></a>;
}

function State({ on, children }: { on: boolean | undefined; children: ReactNode }) {
  return <span className={`docs-state ${on ? "on" : on === false ? "off" : ""}`}>{on ? <DotIcon name="check" size={12} /> : <DotIcon name="lock" size={12} />} {children}</span>;
}

/** The SP rules in force on this server, read from it, so the page never states a number the server does not use. */
function SpRulesLive() {
  const [rules, setRules] = useState<SpRules | null>();
  useEffect(() => {
    void fetch("/api/sp/rules", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
      .then((data: { rules?: SpRules } | null) => setRules(data?.rules ?? null)).catch(() => setRules(null));
  }, []);
  if (rules === undefined) return <p>Reading the SP rules…</p>;
  if (rules === null) return <p>The SP rules could not be read right now.</p>;
  return <table className="docs-table" tabIndex={0}>
    <thead><tr><th>You earn</th><th>SP (rules in force now)</th></tr></thead>
    <tbody>
      {!rules.earning && <tr><td colSpan={2}>Earning is paused for everyone right now.</td></tr>}
      <tr><td>Each payment you send of ${rules.minUsd} or more</td><td>{rules.perDollar} a dollar{rules.perPayment > 0 ? ` + ${formatSpBrief(rules.perPayment)}` : ""}</td></tr>
      <tr><td>Each vault link you claim</td><td>{rules.claimPerDollar} a dollar</td></tr>
      <tr><td>A vault link you sent is claimed</td><td>The payment's SP + {formatSpBrief(rules.bonuses.inviteClaimed)} (up to {rules.inviteMonthlyLimit} a month)</td></tr>
      <tr><td>Your first payment, your first claim</td><td>{formatSpBrief(rules.bonuses.firstPayment)}, {formatSpBrief(rules.bonuses.firstClaim)}</td></tr>
      <tr><td>Each linked account, your Solana address</td><td>{formatSpBrief(rules.bonuses.linkedAccount)}, {formatSpBrief(rules.bonuses.solanaAddress)} (once each)</td></tr>
      <tr><td>Limits</td><td>{formatSpBrief(rules.dailyCap)} a day (UTC) from payments and claims; {rules.pairDailyLimit} rewarded payments a day to the same person</td></tr>
      <tr><td>Someone joins with your invite link</td><td>{Math.round(rules.referral.pointsShare * 1000) / 10}% of the SP they earn (up to {formatSpBrief(rules.referral.dailyCap)} a day){rules.referral.feeShareBps > 0 ? `, and ${rules.referral.feeShareBps}% of the 1% fee on each payment they send, in USDC` : ""}</td></tr>
    </tbody>
  </table>;
}

/** Reads the public status endpoints, so the page reports this server as it runs now. */
function LiveStatus() {
  const [health, setHealth] = useState<Health>();
  const [providers, setProviders] = useState<Provider[]>();
  const [escrow, setEscrow] = useState<EscrowStatus>();
  const [solanaVault, setSolanaVault] = useState<SolanaVaultStatus>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const read = async <T,>(path: string) => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(path);
      return response.json() as Promise<T>;
    };
    void read<Health>("/api/health").then(setHealth).catch(() => setFailed(true));
    void read<{ providers: Provider[] }>("/api/providers").then((result) => setProviders(result.providers)).catch(() => setFailed(true));
    void read<EscrowStatus>("/api/stocks/escrow").then(setEscrow).catch(() => undefined);
    void read<SolanaVaultStatus>("/api/solana/vault").then(setSolanaVault).catch(() => setSolanaVault({ enabled: false }));
  }, []);
  const vault = escrow?.networks.find((entry) => entry.network === "robinhood-mainnet");
  return <div className="docs-live" aria-live="polite">
    <h3>Live status of this server</h3>
    {failed && <p>The status endpoints could not be read right now.</p>}
    <div className="docs-live-grid">
      <div>
        <b>Accounts</b>
        {(providers ?? []).map((provider) => <State key={provider.id} on={provider.configured}>{provider.name}{provider.configured ? "" : " · setup required"}</State>)}
        {!providers && !failed && <span className="docs-state">Loading…</span>}
      </div>
      <div>
        <b>{STOCK_CHAINS["robinhood-mainnet"].name}</b>
        <State on={health ? health.stockTransfers?.["robinhood-mainnet"] === "receipt_verified" : undefined}>Stock Tokens</State>
        <State on={health ? health.tokenTransfers?.["robinhood-mainnet"] === "receipt_verified" : undefined}>USDG</State>
        <State on={health ? health.stockClaims?.["robinhood-mainnet"] === "escrow_verified" : undefined}>Vault {vault?.escrow ? short(vault.escrow.address) : "not deployed yet"}</State>
      </div>
      <div>
        <b>{SOLANA_MAINNET.name}</b>
        <State on={health ? health.solana?.transfers === "receipt_verified" : undefined}>USDC and USDG</State>
        <State on={health ? health.solana?.stocks === "receipt_verified" : undefined}>xStocks</State>
        <State on={solanaVault ? Boolean(solanaVault.enabled) : undefined}>Vault {solanaVault?.program ? short(solanaVault.program.id) : "not deployed yet"}</State>
      </div>
      <div>
        <b>{health?.network === "mainnet" ? "Arc Mainnet" : "Arc Testnet"}</b>
        <State on={health ? health.paymentHistory === "receipt_verified" : undefined}>USDC payments</State>
        <State on={health ? health.claimablePayments === "configured" : undefined}>USDC vault</State>
      </div>
      <div>
        <b>Vault lookups</b>
        {/* "refused_by_…": the platform refused this server's lookups in the last ten minutes, so its vault links wait. */}
        <State on={health ? health.recipientLookup?.github !== "refused_by_github" : undefined}>GitHub{health?.recipientLookup?.github === "refused_by_github" ? " · refusing this server's lookups" : health?.recipientLookup?.github === "token" ? "" : " · public rate limit"}</State>
        <State on={health ? health.recipientLookup?.x === "configured" : undefined}>X{health?.recipientLookup?.x === "refused_by_x" ? " · refusing this server's lookups" : health && health.recipientLookup?.x !== "configured" ? " · needs an API bearer token" : ""}</State>
        <State on={health ? health.recipientLookup?.farcaster === "fname_registry" : undefined}>Farcaster</State>
      </div>
    </div>
  </div>;
}

/**
 * HaPaPay documentation at /docs, with one deep link per section (/docs/vault, /docs/sending, …). The page reads
 * the same public status endpoints as the desk and never asks for or shows a secret.
 */
export default function DocsPage() {
  const [active, setActive] = useState<string>(() => window.location.pathname.split("/")[2] ?? "overview");

  useEffect(() => {
    const slug = window.location.pathname.split("/")[2];
    if (slug) window.requestAnimationFrame(() => document.getElementById(slug)?.scrollIntoView({ block: "start" }));
    const onPop = () => {
      const next = window.location.pathname.split("/")[2] ?? "overview";
      setActive(next);
      document.getElementById(next)?.scrollIntoView({ block: "start" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function go(event: MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    window.history.pushState({}, "", `/docs/${id}`);
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  const mainnet = STOCK_CHAINS["robinhood-mainnet"];
  const stockCount = ROBINHOOD_ASSET_ALLOWLISTS["robinhood-mainnet"].tokens.filter((token) => token.kind === "stock" || token.kind === "etf").length;

  return <section className="docs-page" aria-labelledby="docs-title">
    <nav className="docs-toc" aria-label="Documentation sections">
      <DotText as="p" className="docs-toc-title" text="HaPaPay docs" />
      <ol>
        {sections.map((section) => <li key={section.id}>
          <a href={`/docs/${section.id}`} aria-current={active === section.id ? "true" : undefined} onClick={(event) => go(event, section.id)}>{section.title}</a>
        </li>)}
      </ol>
      <a className="docs-back" href="/app">Open the payment desk</a>
    </nav>

    <article className="docs-body">
      <header className="docs-hero">
        <div>
          <p className="docs-kicker">Documentation</p>
          <DotText as="h1" id="docs-title" text="How HaPaPay works" />
          <p>HaPaPay turns a social handle into a payment address. You name a GitHub, X, Telegram, Discord or Farcaster account, review the transfer, and your own wallet signs it. Robinhood Chain is the main network; Solana and Arc run beside it. If the person has not joined yet, the payment waits for them in the vault.</p>
        </div>
      </header>

      <section id="overview" className="docs-section">
        <h2>What HaPaPay is</h2>
        <p>HaPaPay is a payment desk for sending tokens to people by their social accounts instead of by wallet addresses. People link their accounts through each platform's official login, and every linked account points to one HaPaPay account: an EVM wallet with a Solana address beside it.</p>
        <ul>
          <li><b>Robinhood Chain, the main network:</b> send Robinhood Stock Tokens ({stockCount} companies and funds) and USDG dollars.</li>
          <li><b>Solana:</b> send USDC, USDG and xStocks ({SOLANA_XSTOCK_COUNT} companies and funds), to one person or to several in one transaction. HaPaPay does not send SOL; your wallet keeps a little for the network fee.</li>
          <li><b>Arc Mainnet:</b> send USDC. Gas on Arc is paid in USDC too.</li>
          <li><b>The vault:</b> send to someone on GitHub, X, Farcaster, Discord or Telegram who has not joined yet. The tokens wait in a contract on Robinhood Chain and Arc, or a program on Solana, until they connect that account and claim them, and you take them back if nobody claims them.</li>
        </ul>
        <p><b>Non-custodial by design.</b> HaPaPay never holds your keys, never signs a transfer for you, and never holds your tokens. The server prepares exact transactions, checks them on chain, and verifies receipts. The only thing it signs for the chain is a one-time claim authorization for the vault.</p>
      </section>

      <section id="quick-start" className="docs-section">
        <h2>Quick start</h2>
        <ol className="docs-steps">
          <li><b>Open the desk.</b> The desk is at <code>/app</code>; the home page links to it.</li>
          <li><b>Sign in once.</b> Press <em>Connect wallet</em> and sign in with your email, a social login or a wallet you already have (Phantom, MetaMask, Rabby, Coinbase Wallet and others). The sign-in gives you one wallet for Solana and one for the EVM networks if you have none, and adds your Solana address to your account. Then sign the session message. Signing a message costs nothing and moves no funds.</li>
          <li><b>Connect your accounts.</b> In <em>Identities</em>, connect GitHub, X, Telegram, Discord or Farcaster. Each one is verified by its official provider.</li>
          <li><b>Write what to send.</b> For example <code>Send 25 USDC to @toly on X</code>, <code>Send 10 USDG to @carol on Telegram</code> or <code>Send 2 TSLAx to @alice on GitHub</code>. There is no network to pick: the request decides it (see Which network below). The slip names the network; review it, then sign in your wallet.</li>
        </ol>
      </section>

      <section id="accounts" className="docs-section">
        <h2>Connect your accounts</h2>
        <p>A typed username never proves ownership. Each platform proves it through its own official flow:</p>
        <table className="docs-table" tabIndex={0}>
          <thead><tr><th>Platform</th><th>How it is verified</th><th>Vault for people who have not joined</th></tr></thead>
          <tbody>
            <tr><td>GitHub</td><td>GitHub OAuth</td><td>Yes: the handle resolves to GitHub's numeric user ID</td></tr>
            <tr><td>X</td><td>X OAuth 2.0 with PKCE</td><td>Yes, when the server has an X API bearer token: the handle resolves to X's user ID</td></tr>
            <tr><td>Farcaster</td><td>Sign in with Farcaster (SIWF)</td><td>Yes: the name resolves to its FID through Farcaster's fname registry</td></tr>
            <tr><td>Telegram</td><td>Log in with Telegram, a popup (HMAC)</td><td>No: Telegram offers no public way to resolve a handle to a fixed account</td></tr>
            <tr><td>Discord</td><td>Discord OAuth (identify)</td><td>No: Discord offers no public way to resolve a username to a fixed account</td></tr>
          </tbody>
        </table>
        <ul>
          <li>HaPaPay stores only the provider's immutable user ID and current username. OAuth access tokens are not stored.</li>
          <li>One account can belong to one wallet at a time, and all your accounts resolve to the same wallet.</li>
          <li>Your HaPaPay account also holds one Solana address, so the same handles receive on Solana. The one-step sign-in adds it for you; with your own Solana wallet, press <em>Add your Solana address</em> in <em>Identities</em> and sign the message it shows. It moves nothing, and you can replace or remove the address there.</li>
          <li><em>Identities</em> shows what your Solana address holds. A sign-in keeps an address that holds something, so nothing paid to it is left behind; replacing it by hand asks first. When the sign-in made the wallet for you, <em>Export key</em> opens the sign-in provider's own window with its private key, so you can use the wallet in Phantom or MetaMask too. HaPaPay never sees the key, and anyone who has it controls the wallet.</li>
          <li>A verified account receives on Arc and on Robinhood Chain right away, and on Solana once it has a Solana address. HaPaPay keeps the link on its own servers; nothing about it is written on chain, so linking or removing an account asks your wallet for nothing.</li>
          <li>Share <code>{APP_ORIGIN}/pay/github/your-name</code> (or <code>/pay/x/…</code>, <code>/pay/farcaster/…</code>) as your payment link. The copy button next to a linked account builds it for you.</li>
        </ul>
      </section>

      <section id="sending" className="docs-section">
        <h2>Send money and tokens</h2>
        <p>Every transfer follows the same four steps:</p>
        <ol className="docs-steps">
          <li><b>Draft.</b> Your request is read by a deterministic parser; an AI model may help with wording the rules miss, but it can only produce a draft, and the server keeps a part of it only when your own words state it: each handle, its platform, the amount, the asset and the note. Tickers are checked against a verified allowlist, never guessed. If something is missing or could mean two things, the desk asks one question at a time, and you can tap the complete request it offers or just type the answer.</li>
          <li><b>Review.</b> The slip shows the network, the token, the exact amount, the recipient's verified address, the 1% HaPaPay fee where it applies and the total your wallet pays, and what the network fee is paid in.</li>
          <li><b>Sign.</b> The server re-resolves the recipient, prepares the exact transaction and checks your balance (and, where the payment goes through HaPaPay's fee contracts, your allowance); on Robinhood Chain and Solana it also simulates the transaction, so a short balance, an issuer pause or a compliance block is explained before your wallet opens. Your browser rebuilds the transaction from your review and opens the wallet only when every byte matches.</li>
          <li><b>Verify.</b> The desk follows your transaction through the server's own connection to the chain, so a wallet app that never reports back cannot leave it hanging. After it is mined, the server records it only if the receipt contains the exact token transfer you reviewed. Your activity list shows only verified receipts.</li>
        </ol>
        <h3>What you can send</h3>
        <table className="docs-table" tabIndex={0}>
          <thead><tr><th>Asset</th><th>Network</th><th>Decimals</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>xStocks</td><td>Solana</td><td>8</td><td>{SOLANA_XSTOCK_COUNT} tokens that track US shares and funds, written with an x: <code>TSLAx</code>, <code>NVDAx</code>, <code>SPYx</code>. Amounts are what wallets show. Each transfer needs an eligibility statement (see Legal notes).</td></tr>
            <tr><td>USDC</td><td>Solana, or Arc Mainnet ({ARC_MAINNET.chainId})</td><td>6</td><td>Circle's USDC. Gas on Arc is paid in USDC.</td></tr>
            <tr><td>USDG (Global Dollar)</td><td>Solana, or Robinhood Chain ({mainnet.id})</td><td>6</td><td>A dollar stablecoin issued by Paxos. No eligibility statement is needed.</td></tr>
            <tr><td>Robinhood Stock Tokens</td><td>Robinhood Chain ({mainnet.id})</td><td>18</td><td>Token units, not shares; the slip shows the share equivalent. Each transfer needs an eligibility statement (see Legal notes).</td></tr>
          </tbody>
        </table>
        <p>HaPaPay sends stablecoins and stocks only; it does not send SOL. Your wallet pays the network fee: SOL on Solana (with a little rent the first time someone receives a token), ETH on Robinhood Chain, USDC on Arc. Send one asset per request. Examples: <code>Send 2 TSLA to @toly on X</code>, <code>Send 10 USDG to @carol on Telegram</code>, <code>Send 25 USDC to @octocat on GitHub</code>, <code>Send 1.5 TSLAx to @toly on X</code>.</p>
        <h3>Which network</h3>
        <ul>
          <li><b>xStocks</b> live on Solana, so they always go there.</li>
          <li><b>Name a network</b> in the request itself, with any note or reason last, to send an asset it carries there: <code>on Solana</code>, <code>on Arc</code>, <code>on Robinhood Chain</code>, and in Turkish <code>Solana'da</code> or <code>Arc üzerinden</code>. Every draft is built for a network that carries its asset, and the review names that network, so check it before you sign.</li>
          <li><b>USDG or a ticker without a network</b> (<code>10 USDG</code>, <code>2 TSLA</code>) go on Robinhood Chain, the main network, when it lists the stock and can pay everyone now (through its vault for someone who has not joined). They go on Solana as USDG or the xStock instead when the request can go there (you have a Solana address, and either everyone you pay has one too or the one person you pay has not joined and the Solana vault can hold it for them) and either Robinhood Chain cannot pay everyone now or, once your wallet is verified, it holds less than the payment and its 1% fee there while Solana holds enough (<code>2 NVDA</code> goes on Solana as NVDAx when that is where your NVDA is). A ticker Robinhood Chain does not list goes on Solana as its xStock, and one Solana does not list stays on Robinhood Chain.</li>
          <li><b>USDC</b>, which Robinhood Chain does not carry, goes on Solana when you have a Solana address and either everyone you pay has one too or the one person you pay has not joined and the Solana vault can hold it for them; otherwise it goes on Arc. If Solana holds less than the payment and its 1% fee while Arc holds enough and can pay everyone now (through its vault for someone who has not joined), it goes on Arc instead. The review says which network it uses and, when your holdings decided it, how to ask for the other.</li>
        </ul>
        <p>Write it the way you would say it, in English or Turkish: <code>pay octocat $5 on GitHub</code>, <code>send twenty dollars to carol on Discord</code>, <code>octocat githubda 5 usdc</code> and <code>toly'ye x'te 25 dolar gönder</code> all read as payments. Dollars mean USDC; name the platform the person is on, and <code>from my GitHub account</code> names your own account, not theirs. Amounts read as you write them: <code>.5 USDC</code>, <code>half a TSLAx</code>, <code>5 thousand USDC</code>, <code>10k USDC</code>, <code>twenty-five dollars</code> or <code>5 bin usdc</code>, and a profile link such as <code>github.com/octocat</code> is that handle.</p>
        <h3>Several people in one request</h3>
        <p>Name everyone with the same amount: <code>Send 1 NVDA each to @alice, @toly and @carol on X</code> gives each of them 1 NVDA, and <code>Split 10 USDC between @alice and @toly on X</code> divides 10 USDC between them (to the smallest unit; the first people get any remainder). Turkish works too: <code>@alice ve @toly'ye x'te 5'er usdc gönder</code>. If the request does not say which, the desk asks whether everyone gets that amount or shares it. To give each person their own amount, write it next to them: <code>Send 10 USDC to @alice and 5 USDC to @toly on X</code>, or <code>@alice 10, @toly 5 USDC on X</code>. One request pays up to {PAYMENT_BATCH_MAX_RECIPIENTS} people with one asset; a second asset is its own request.</p>
        <p>The review lists every person, their address and what they receive, the 1% fee on each payment and the total. On Solana everyone is paid in one transaction when they fit, and in as few as possible when they do not. On Robinhood Chain and Arc your wallet asks for one approval of the total and one payment for each person. If you stop halfway, what went through stays sent, and the button sends only the rest; nobody is paid twice. Someone without a verified account is named before anything is signed, and can get their part in the vault with a request of their own.</p>
        <h3>Notes</h3>
        <p>A payment can carry a short note of up to {PAYMENT_NOTE_MAX_CHARACTERS} characters: <code>Send 5 USDC to @toly on X note: thanks for dinner</code>, a note in quotes, or a closing phrase such as <code>for dinner</code> or <code>yemek için</code>. The review shows it and you can change or clear it before signing. The note is written on chain with the payment (on Solana as a memo, elsewhere after the fee router's own arguments), so <b>anyone can read it and it cannot be removed</b>; HaPaPay also keeps it with the verified payment, and your activity shows it. In a payment to several people every payment carries the same note. Vault links carry no note.</p>
        <h3>When the desk asks back</h3>
        <ul>
          <li><b>An amount that reads two ways.</b> <code>1,000</code> is a thousand in English and one in Turkish, so the desk asks which you meant instead of guessing. Write <code>1000</code> or <code>1.5</code>.</li>
          <li><b>A company name or shares.</b> Stocks go by their ticker, in the amounts wallets show: <code>3 apple</code> and <code>3 apple shares</code> are offered back as <code>Send 3 AAPL …</code> on Robinhood Chain, or as the xStock on Solana for a stock Robinhood Chain does not list.</li>
          <li><b>A handle without a platform.</b> The desk offers the platforms where that handle has a verified HaPaPay account; for several people, the ones where all of them do.</li>
          <li><b>Several people and one amount.</b> Each or split, when the request says neither (<code>each</code>, <code>her birine</code>, <code>1'er</code> or <code>split</code>, <code>between</code>, <code>toplam</code> answer it in advance). An amount written next to each person needs no answer.</li>
          <li><b>Someone who cannot be paid directly.</b> No verified account on that platform, or your own wallet: the desk names them and offers the rest.</li>
          <li><b>Two amounts or two assets.</b> <code>10 USDC to @alice and @toly, 5 each</code>, <code>$100 of TSLA</code> (write it in TSLA) or <code>5 USDC and NVDA</code>: the desk asks for one. A value in brackets after an amount, as in <code>2 TSLAx ($500)</code>, is only what it is worth.</li>
          <li><b>A part of an amount.</b> <code>half of 10 USDC</code>, <code>50% of</code> or <code>5x2</code>: write the amount to send as one number. The 1% fee is added on top, so the person always gets what you write; <code>minus fees</code> is asked too.</li>
          <li><b>Things it never drafts.</b> Asking someone for money, a request that says not to send, the same payment repeated, payments for later or on a schedule, a network HaPaPay does not run, and a wallet address instead of a handle. HaPaPay sends now, from your own wallet, to verified accounts. Someone a request says not to pay (<code>not @alice</code>) is left out.</li>
        </ul>
      </section>

      <section id="vault" className="docs-section">
        <h2>The vault: send to anyone</h2>
        <p>If the person you name has not joined HaPaPay, you can still send to them. The tokens go into the vault on the same network, locked to their account's immutable ID, or on Discord and Telegram to their name: the HaPaPay vault program on Solana, a claim escrow contract on Robinhood Chain and Arc. They claim once they connect that account; if they do not, you take the tokens back.</p>
        <ol className="docs-steps">
          <li><b>Lookup.</b> The server resolves the handle through the official source: GitHub's user API, X's user lookup, or Farcaster's fname registry. The payment is locked to the numeric account ID, so a renamed or look-alike account cannot claim it. A GitHub or Farcaster handle that does not exist is caught before the desk offers a link. Discord and Telegram cannot be looked up by name, so a link to them waits for the name instead (see <em>Links that wait for a name</em> below); so does an X link while X is not answering lookups, if you agree to it on the slip.</li>
          <li><b>Fund.</b> On Solana your wallet signs one transaction that moves the amount plus the 1% fee into the link's own account in the vault. On Robinhood Chain and Arc it signs two: an approval of exactly the amount plus the fee, then the deposit. Nothing is unlimited and nothing is pulled later. The fee is paid only when the link is claimed; a refund returns it.</li>
          <li><b>Share the claim link.</b> After the deposit is verified on chain, the slip shows a link like <code>{APP_ORIGIN}/claim/solana/0x…</code> (or <code>/claim/stock/robinhood-mainnet/0x…</code>). Send it to the person. They do not even need it: the moment they connect that account on HaPaPay, the payment waits for them under <em>Claims</em>.</li>
          <li><b>Claim or take back.</b> They claim within the window. After the window closes, only your wallet can take the tokens back, from <em>Claims</em> or from the link. Once a link has been claimed or taken back, its page says so, offers nothing more and no longer names who it was for.</li>
        </ol>
        <ul>
          <li><b>Windows.</b> You choose how long a link stays open: {STOCK_CLAIM_WINDOW_HOURS.default} hours, 7, 14 or 30 days. The contract refuses anything over 31 days.</li>
          <li><b>Across platforms.</b> Someone whose wallet already has a GitHub account linked can be paid on their X or Farcaster account too. The payment waits for that account, and it shows up under their <em>Claims</em> as soon as they link it to the same wallet.</li>
          <li><b>Assets.</b> USDC, USDG and xStocks on Solana (not SOL); Robinhood Stock Tokens and USDG on Robinhood Chain; USDC on Arc.</li>
          <li><b>Platforms.</b> GitHub, X, Farcaster, Discord and Telegram. GitHub and Farcaster links wait for the account; Discord and Telegram links wait for the name; X links wait for the account, or for the name while X is not answering lookups.</li>
          <li><b>Links that wait for a name.</b> Whoever connects Discord, Telegram or X to HaPaPay with that name after the link was made claims it, through that platform's own sign-in. On Discord and X the account must also be older than the link (its ID says when it was made), so nobody can open a new account with the name and take it. Check the spelling before you send: a link waits for exactly that name, and if its holder gives the name up inside the window, whoever has it next can claim it. Nobody claims it in time? You take it back.</li>
          <li><b>Exact amounts.</b> The vault checks the exact balance change on every deposit, claim and refund. A token that delivers less than it should makes the transaction fail instead of leaving a shortfall.</li>
          <li><b>No admin power over funds.</b> On Robinhood Chain and Arc the vault owner can rotate the claim verifier but cannot move anyone's tokens or change the fee. On Solana the operator's wallet keeps the program's upgrade key so the program can be closed and its rent returned once it holds no link; HaPaPay checks the program's code against the reviewed build before it prepares any vault transaction, and stops vault links if it ever changes.</li>
          <li><b>Rent on Solana.</b> A link's accounts cost about 0.003 SOL of rent. The token account's rent comes back to you when the link is claimed or taken back; about 0.0015 SOL stays with the link's record for good, so the same link can never be funded twice.</li>
        </ul>
      </section>

      <section id="claiming" className="docs-section">
        <h2>Claim what was sent to you</h2>
        <p>Everything sent to your accounts waits under <em>Claims</em> on the desk: verify your wallet and connect your GitHub, X, Farcaster, Discord or Telegram account, and every vault link waiting for that account or its name appears there, with its amount, sender and deadline. Claim it right there, or open its link.</p>
        <ol className="docs-steps">
          <li>Open the claim link, or <em>Claims</em> on the desk, with a wallet (a wallet app's browser on a phone).</li>
          <li>Verify your wallet, then connect the account the link names: GitHub, X, Farcaster, Discord or Telegram.</li>
          <li>Press <em>Claim with my identity</em>, or <em>Claim</em> in the list. The server checks that one of your verified accounts is the account or the name the link waits for, signs a one-time authorization that expires in ten minutes and, on Robinhood Chain and Solana, simulates the claim first.</li>
          <li>Your wallet sends the claim and pays the gas. The tokens go straight to your wallet.</li>
        </ol>
        <p>A Stock Token or xStock claim also asks for your eligibility statement; USDC and USDG claims do not. Your wallet pays the network fee: about 0.002 SOL on Solana (a claim there goes to your account's Solana address, so add one first), a little ETH on Robinhood Chain, or a little USDC on Arc.</p>
        <p>The list is read from the vault contracts every time, so it never shows a payment that was already claimed or taken back. It finds a payment by the handle it was sent to; if you renamed the account in between, the claim link still works for a link that waits for the account. A link that waits for a name needs that name on the account you connect, so connect again after you rename back to it.</p>
      </section>

      <section id="sp" className="docs-section">
        <h2><SpMark size={26} /> SP points</h2>
        <p>SP, social points, are HaPaPay's points. You earn them by paying people through HaPaPay, by claiming vault links and when a vault link you sent is claimed, on Solana, Arc and Robinhood Chain alike: one balance counts every network. Your balance, its history and how SP are earned are under <em>SP</em> on the desk; the coin at the top of the desk shows your balance once your wallet is verified.</p>
        <SpRulesLive />
        <h3>How SP are counted</h3>
        <ul>
          <li>Payments and claims earn SP only once HaPaPay has verified them on chain, each one once; the bonuses above, invite shares and signed, logged admin adjustments are the only other entries. Testnets earn nothing.</li>
          <li>A payment's dollar value is its amount for USDC and USDG, and the desk's own price for stock tokens at the time SP are awarded. An asset with no price earns nothing.</li>
          <li>SP count to one decimal and are rounded down: at 1 SP a dollar, a 12.75 USDC payment earns 12.7 SP.</li>
          <li>A vault link earns when it is claimed: the claimer earns for claiming, and the sender earns the payment's SP and a bonus. A link taken back after its window earns nothing.</li>
          <li>Payments to yourself earn nothing, and there are daily limits per account and per person paid. A payment that earns nothing is still recorded in HaPaPay's ledger, with the reason.</li>
          <li>HaPaPay may change the rules from its admin panel. Each change is a new version, kept for good, and applies only to activity from then on; past SP stay as they were awarded. HaPaPay can also correct a balance (for example after a mistake or abuse), always with a recorded reason.</li>
        </ul>
        <p>SP have no cash value. They cannot be bought, sold, sent to someone else or exchanged for money or tokens on HaPaPay.</p>
        <h3>Invites</h3>
        <ul>
          <li>Your invite link is under <em>SP</em> on the desk. Someone who opens it and then verifies a new wallet (one that has not yet paid anyone or funded a vault link through HaPaPay) joins with your invite, once and for good.</li>
          <li>From then on you earn a share of the SP they earn, and a share of HaPaPay's 1% fee on each payment they send, in USDC (with the starting rules, half of the fee: 0.5% of the payment). Only a fee HaPaPay verified on chain counts: a transfer that did not go through HaPaPay's fee, and for now a vault link on Arc or Robinhood Chain, earns you SP but no USDC. A payment between the two of you, or to themselves, earns neither.</li>
          <li>HaPaPay pays the USDC to your Solana address on Solana once you are owed at least $1.00; add the address under <em>Identities</em>. Each payout is recorded from its transaction on Solana, and the SP tab shows what you earned, what was paid and what is waiting.</li>
          <li>Invite rewards come out of HaPaPay's share of the fee, never a payment's amount or a vault link's funds. HaPaPay may change the shares from its admin panel (each change is a new version, from then on) and does not pay rewards to accounts it has stopped for review. When HaPaPay reverses a payment's SP (for example a payment made only to farm rewards), its rewards go with it: a reward not paid yet is never paid, and one already paid is taken from your next rewards.</li>
        </ul>
      </section>

      <section id="networks" className="docs-section">
        <h2>Networks, assets and contracts</h2>
        <LiveStatus />
        <table className="docs-table" tabIndex={0}>
          <thead><tr><th>Network</th><th>Chain ID</th><th>Public RPC</th><th>Explorer</th><th>Gas</th></tr></thead>
          <tbody>
            <tr><td>{SOLANA_MAINNET.name} mainnet</td><td>None (genesis <code>{SOLANA_MAINNET.genesisHash.slice(0, 8)}…</code>)</td><td><code>{SOLANA_MAINNET.rpcUrl}</code> (servers only: it refuses browsers, so pages use the operator's QuickNode endpoint)</td><td><External href={SOLANA_MAINNET.explorerUrl}>Solscan</External></td><td>SOL</td></tr>
            <tr><td>{mainnet.name}</td><td>{mainnet.id}</td><td><code>{mainnet.rpcUrl}</code></td><td><External href={mainnet.explorerUrl}>Blockscout</External></td><td>ETH</td></tr>
            <tr><td>{ARC_MAINNET.chainName}</td><td>{ARC_MAINNET.chainId}</td><td><code>{rpcOf(ARC_MAINNET)}</code></td><td><External href={explorerOf(ARC_MAINNET)}>Explorer</External></td><td>USDC</td></tr>
          </tbody>
        </table>
        <h3>Contracts</h3>
        <dl className="docs-contracts">
          <div><dt>USDC · Solana</dt><dd><a className="docs-address" href={`${SOLANA_MAINNET.explorerUrl}/token/${SOLANA_USDC.mint}`} target="_blank" rel="noreferrer"><code>{SOLANA_USDC.mint}</code> <DotIcon name="arrow-up-right" size={12} /></a><small>Circle's USDC mint on Solana: 6 decimals.</small></dd></div>
          <div><dt>USDG · Solana</dt><dd><a className="docs-address" href={`${SOLANA_MAINNET.explorerUrl}/token/${SOLANA_USDG.mint}`} target="_blank" rel="noreferrer"><code>{SOLANA_USDG.mint}</code> <DotIcon name="arrow-up-right" size={12} /></a><small>Global Dollar on Solana: 6 decimals; a transfer fee is refused.</small></dd></div>
          <div><dt>xStocks · Solana</dt><dd><span>{SOLANA_XSTOCK_COUNT} from the xStocks list. Every mint is read back from Solana before it is listed: the token program, 8 decimals, its own symbol, no transfer hook and no transfer fee.</span><small><External href="https://xstocks.fi">xStocks</External></small></dd></div>
          <div><dt>Solana vault program</dt><dd><span>Deployed once by the operator from the pinned build, with its upgrade key in the operator's wallet so it can be closed once it holds no link, and registered only after the server checks its code and settings on chain; the server reads the code again before every vault action. The live status above shows its address.</span></dd></div>
          <div><dt>USDG · {mainnet.name}</dt><dd><Address value={ROBINHOOD_USDG.address} explorer={mainnet.explorerUrl} /><small>From Robinhood Chain's official contracts page, read back on chain: 6 decimals, symbol USDG.</small></dd></div>
          <div><dt>Stock Tokens</dt><dd><span>{stockCount} from the official registry. Every address is checked on chain before it is listed.</span><small><External href="https://docs.robinhood.com/chain/contracts/">Robinhood Chain contracts</External></small></dd></div>
          <div><dt>Vault (StockClaimEscrow)</dt><dd><span>Deployed per network by the operator and registered only after the server checks its code, owner, verifier and fee router on chain. The live status above shows the current address.</span></dd></div>
          <div><dt>Fee router (HaPaPayRouter)</dt><dd><span>Takes the 1% fee in the same transaction as each payment and vault claim: half to the burn vault (on Arc, the fee forwarder), half to the operator. The fee and the split are constants in its code.</span></dd></div>
          <div><dt>Burn vault (HaPaPayBurnVault)</dt><dd><span>Holds the burn half of the fees on Robinhood Chain. Nothing can leave it before the operator names a burn token once; after that it can only swap into that token and burn it.</span></dd></div>
          <div><dt>Fee forwarder (HaPaPayFeeForwarder)</dt><dd><span>Takes that half on Arc and can only pass it on to the operator.</span></dd></div>
          <div><dt>Arc contracts</dt><dd><span>The identity registry, the vault, the fee router and the fee forwarder, deployed on Arc Mainnet by the operator from the same reviewed builds and accepted only after the server checks their code, owner, verifiers and fee settings on chain.</span></dd></div>
          <div><dt>Arc USDC</dt><dd><Address value={ARC_MAINNET.usdcAddress} explorer={explorerOf(ARC_MAINNET)} /><small>Circle's six-decimal USDC interface on Arc Mainnet, chain ID {ARC_MAINNET.chainId}.</small></dd></div>
        </dl>
      </section>

      <section id="security" className="docs-section">
        <h2>Security model</h2>
        <ul>
          <li><b>Your wallet signs everything that moves value.</b> The server cannot sign or broadcast a transfer, and it never holds tokens.</li>
          <li><b>One sign-in.</b> The sign-in provider (Privy) creates and keeps the wallets of people who sign in with email or a social login; HaPaPay never sees their keys, and <em>Export key</em> shows a key only in the provider's own window. HaPaPay still asks the wallet itself to sign: once for your session, and once to add your Solana address.</li>
          <li><b>What the server signs.</b> Vault claim authorizations, bound to the chain, the vault, the payment, the locked account, the token, the recipient wallet, the amount and a deadline at most ten minutes away.</li>
          <li><b>Exact review matching.</b> Your browser compares every prepared transaction with what you reviewed (network, token, sender, recipient, amount, fee, note) and refuses to open the wallet on any difference. On Solana it also caps the compute and the priority fee a transaction may ask for.</li>
          <li><b>Receipt verification.</b> History is built only from receipts that contain the exact reviewed transfer log. A transaction hash alone is never proof.</li>
          <li><b>Verified allowlists.</b> Tokens are pinned by contract address and read back from chain. Live price or registry data never adds a token or changes an address.</li>
          <li><b>The fee.</b> The fee router moves the amount to the recipient and the fee to the burn vault (on Arc, the fee forwarder) and the treasury in one transaction, each leg checked for the exact amount. The burn vault's owner chooses which swaps turn its holdings into the burn token, and every swap must deliver a minimum of it that is burned at once.</li>
          <li><b>Audits.</b> The contracts are covered by fuzz, invariant and mutation tests and by Slither, but they have not had an independent audit. Start with small amounts.</li>
        </ul>
      </section>

      <section id="fees" className="docs-section">
        <h2>Fees</h2>
        <p>Every payment on Solana and Arc Mainnet, and on Robinhood Chain once its fee contracts are registered, carries a 1% HaPaPay fee, paid on top of the amount: the recipient receives exactly what you send, and the slip shows the fee and the total before you sign.</p>
        <ul>
          <li><b>On Solana.</b> The fee moves in the same transaction as the payment, all of it to the HaPaPay treasury. There is no burn on Solana.</li>
          <li><b>On Robinhood Chain and Arc, once their fee contracts are registered.</b> Your wallet signs an approval of exactly the amount plus the fee, then the payment. On Robinhood Chain, half goes to the burn vault, which can only buy and burn the token the operator names for it, and half goes to the HaPaPay operator. Nothing is burned on Arc, so the whole Arc fee goes to the operator, half of it through the fee forwarder.</li>
          <li><b>Vault links.</b> The fee is held in the vault with the amount and paid only when the person claims it. If you take the tokens back, the fee comes back too.</li>
          <li><b>Small amounts.</b> The fee rounds down, so a payment of a few base units can carry none.</li>
          <li><b>Where it applies.</b> On every payment and vault link on Solana and Arc Mainnet, and on Robinhood Chain once its escrow and fee contracts are registered. On Robinhood Chain and Arc it runs through the fee contracts the network status above shows: until they are registered, Robinhood Chain and Arc Testnet send plain transfers without a fee, and Arc Mainnet waits for them.</li>
        </ul>
        <p>You also pay the network fee: SOL on Solana, ETH on Robinhood Chain and USDC on Arc.</p>
      </section>

      <section id="faq" className="docs-section">
        <h2>Questions and fixes</h2>
        <details><summary>Connect wallet does nothing on my phone</summary><p>Sign in with your email or a social login; that needs no wallet app. If this server has no one-step sign-in, open this site's /app inside your wallet app's browser (Phantom, MetaMask, Coinbase Wallet or Rabby), then connect.</p></details>
        <details><summary>Solana says my wallet needs a little SOL</summary><p>Every Solana transaction pays a small network fee in SOL, and the first time someone receives a token their token account costs a little rent. Keep about 0.01 SOL in your Solana wallet.</p></details>
        <details><summary>Someone has no Solana address yet</summary><p>The desk tells you and offers the same payment on Arc or Robinhood Chain when the asset lives there too. They add an address by signing in again, or with <em>Add your Solana address</em> in <em>Identities</em>.</p></details>
        <details><summary>GitHub or X shows an error after I press Connect</summary><p>Try again from the desk. If the provider reports a redirect or callback mismatch, the operator must register <code>{APP_ORIGIN}/api/oauth/github/callback</code> or <code>{APP_ORIGIN}/api/oauth/x/callback</code> in that provider's developer settings.</p></details>
        <details><summary>Discord says "Setup required"</summary><p>This server has no Discord client secret yet. The other platforms work without it.</p></details>
        <details><summary>The desk offers no vault link for someone</summary><p>Vault links need a deployed vault on the asset's network and a handle the platform allows: a GitHub or Farcaster account that exists, an X handle, or a Discord or Telegram name. While GitHub refuses this server's lookups, the desk says so and offers no link for GitHub; while X does, X links wait for the name instead of the account. The Live status panel above shows which of these are ready.</p></details>
        <details><summary>I pressed a button on a slip and nothing seemed to happen</summary><p>The answer appears right under the slip: what went wrong and what to do. A claim or a refund from <em>Claims</em> shows it on that link, and its button stays so you can try again.</p></details>
        <details><summary>My wallet is on the wrong network</summary><p>The desk asks your wallet to switch or add the right network from built-in chain settings before it opens a transaction. Approve the switch, then sign.</p></details>
        <details><summary>The transfer went through but the slip says "Check in explorer"</summary><p>The server's node can lag behind your wallet by a block. Press <em>Verify the receipt again</em> after a few seconds; nothing is lost.</p></details>
        <details><summary>Nobody claimed my vault link</summary><p>After the window closes, open the same claim link with the wallet that funded it and press <em>Take back after expiry</em>.</p></details>
      </section>

      <section id="operators" className="docs-section">
        <h2>Operator guide</h2>
        <p>Everything below is configured as server environment variables (on Vercel: Project Settings → Environment Variables → Production), followed by a redeploy. Secrets never go into a <code>VITE_</code> variable, the browser, or a chat.</p>
        <h3>Social login apps</h3>
        <table className="docs-table" tabIndex={0}>
          <thead><tr><th>Provider</th><th>Variables</th><th>Callback URL to register</th></tr></thead>
          <tbody>
            <tr><td>GitHub</td><td><code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code>; optional <code>GITHUB_API_TOKEN</code> for vault lookups above the public rate limit</td><td><code>{APP_ORIGIN}/api/oauth/github/callback</code></td></tr>
            <tr><td>X</td><td><code>X_CLIENT_ID</code>, <code>X_CLIENT_SECRET</code>; <code>X_API_BEARER_TOKEN</code> for X vault links</td><td><code>{APP_ORIGIN}/api/oauth/x/callback</code></td></tr>
            <tr><td>Discord</td><td><code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code></td><td><code>{APP_ORIGIN}/api/oauth/discord/callback</code></td></tr>
            <tr><td>Telegram</td><td><code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_BOT_USERNAME</code></td><td>Set the bot's domain to <code>{APP_ORIGIN.replace("https://", "")}</code> with BotFather's <code>/setdomain</code></td></tr>
            <tr><td>Farcaster</td><td><code>FARCASTER_OPTIMISM_RPC_URL</code> (required in production)</td><td>None</td></tr>
          </tbody>
        </table>
        <h3>One sign-in (Privy)</h3>
        <ul>
          <li>Create an app in Privy's dashboard, allow <code>{APP_ORIGIN}</code> as an origin, and turn on the logins you want (email, social logins and wallets). Set its app ID as <code>PRIVY_APP_ID</code>; the ID is public, so it is not a secret.</li>
          <li>Keep wallet export allowed for embedded wallets in Privy's dashboard, so <em>Export key</em> can open Privy's window for people whose wallet Privy made.</li>
          <li>Without it the desk keeps working with the browser's own wallets.</li>
        </ul>
        <h3>Solana</h3>
        <ul>
          <li><code>SOLANA_TREASURY_ADDRESS</code>: the Solana address that receives the whole 1% fee. Solana payments stay off without it.</li>
          <li><code>SOLANA_BROWSER_RPC_URL</code>: a QuickNode Solana mainnet endpoint for the pages (<code>https://&lt;name&gt;.solana-mainnet.quiknode.pro/&lt;token&gt;/</code>). Solana's public RPC refuses requests from browsers, so xStocks, Privy's Solana wallets and the vault deployment need it. Its token reaches every visitor, so in QuickNode's endpoint security allow only <code>{APP_ORIGIN.replace("https://", "")}</code> as a referrer, and use a different endpoint for the server.</li>
          <li><code>SOLANA_RPC_URL</code>: the server's own Solana endpoint (QuickNode; recommended, the public one is rate-limited). It must serve Solana mainnet and stays on the server; the server falls back to the public RPC when it fails.</li>
          <li><code>SOLANA_TRANSFERS</code> controls USDC and USDG; they run unless it is set to <code>disabled</code>. <code>SOLANA_STOCK_TRANSFERS=enabled</code> turns on xStocks; leave it off until your eligibility review is done.</li>
        </ul>
        <h3>Deploy the Solana vault</h3>
        <ol className="docs-steps">
          <li>Create a new key used for nothing else, outside any chat or shared document (<code>npm run init:solana-attestor</code> writes one to a local folder without printing it), and set it as <code>SOLANA_CLAIM_ATTESTOR_PRIVATE_KEY</code> (Sensitive, Production). The server refuses the operator's or the treasury's key.</li>
          <li>Set <code>SOLANA_OPERATOR_ADDRESS</code> to the Solana address that will deploy the program and own its settings, and redeploy. Sign in to the desk with that wallet once so the address is on its HaPaPay account.</li>
          <li>Open <a href="/operator/stock-escrow">/operator/stock-escrow</a>, find the Solana vault card and press its deploy button with about 0.6 SOL in that wallet. The wallet asks once to fund a temporary deployment key in your browser; that key writes the program, hands its upgrade key to your wallet, and sends what is left back to you. The program's rent, about 0.57 SOL at today's rate, stays with it while it runs; the card reads the exact amount from Solana before the wallet opens.</li>
          <li>The server reads the program back (its code, your wallet as its upgrade key, the operator, the claim key, the treasury and the 1% fee) and turns Solana vault links on without a redeploy. If the deployment stops part way, the same card continues it, or closes it and returns its SOL.</li>
          <li>To close the program later and get its rent back, press <em>Stop new vault links</em> on the same card. Links already sent stay claimable, and senders can take theirs back after the window. Once the program holds no link and two minutes have passed, <em>Close the program</em> asks your wallet once and returns about 0.57 SOL. A program that still holds a link is never closed, because the tokens in it could not be paid out any more. Your wallet's upgrade key could also change the program's code, so keep that wallet safe.</li>
        </ol>
        <h3>Robinhood Chain switches</h3>
        <ul>
          <li><code>ROBINHOOD_MAINNET_STOCK_TRANSFERS=enabled</code> turns on mainnet Stock Token transfers and Stock Token vault links. Leave it off until your eligibility review is done.</li>
          <li><code>ROBINHOOD_MAINNET_TOKEN_TRANSFERS</code> controls USDG. It runs unless this is set to <code>disabled</code>.</li>
          <li><code>ROBINHOOD_MAINNET_RPC_URL</code> optionally points the server at a QuickNode Robinhood Chain endpoint; it falls back to the public RPC, which stays in the wallet.</li>
        </ul>
        <h3>Deploy the vault</h3>
        <ol className="docs-steps">
          <li>Create a new key used for nothing else, outside any chat or shared document, and set it as <code>ROBINHOOD_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY</code> (Sensitive, Production): <code>0x</code> followed by 64 hex characters, so add the <code>0x</code> to a key a wallet exports without it. The server refuses a key it already uses elsewhere, and the value takes effect with the next deployment.</li>
          <li>Set <code>ROBINHOOD_OPERATOR_ADDRESS</code> to the wallet that will deploy and own the vault and the fee contracts; it also receives the treasury half of each fee. Without it the server uses <code>CONTRACT_OWNER_ADDRESS</code>.</li>
          <li>Open <a href="/operator/stock-escrow">/operator/stock-escrow</a> with that wallet, holding a little ETH on that network.</li>
          <li>Press <em>Deploy the vault and fee contracts</em> and confirm three times in the wallet: the burn vault, the fee router (1%, half to the burn vault, half to you), then the escrow. The server checks the receipts, the runtime code of all three, the owner, the treasury and the verifier, then turns vault links and the fee on without a redeploy.</li>
        </ol>
        <h3>Open Arc Mainnet</h3>
        <ol className="docs-steps">
          <li>Create two new keys used for nothing else, outside any chat or shared document (<code>npm run init:arc-mainnet</code> writes them to a local folder), and set them as <code>ARC_MAINNET_IDENTITY_ATTESTOR_PRIVATE_KEY</code> and <code>ARC_MAINNET_CLAIM_ATTESTOR_PRIVATE_KEY</code> (Sensitive, Production), each written as <code>0x</code> and 64 hex characters. The operator is <code>ARC_MAINNET_OPERATOR_ADDRESS</code>, or <code>ROBINHOOD_OPERATOR_ADDRESS</code> when that is unset. Redeploy.</li>
          <li>Open <a href="/operator/stock-escrow">/operator/stock-escrow</a> with the operator wallet, holding a little USDC on Arc Mainnet for gas, and find the Arc Mainnet card at the end of the page.</li>
          <li>Confirm the statement and press <em>Deploy the Arc Mainnet contracts</em>. The wallet asks four times: the fee forwarder, the fee router (1%, half to the forwarder, half to you), the identity registry and the vault escrow. The server then checks all four. If it stops part way, press the button again: the card continues from the contracts already on Arc Mainnet and never deploys one twice.</li>
          <li>Set the three variables the card shows (<code>ARC_MAINNET_IDENTITY_REGISTRY_ADDRESS</code>, <code>ARC_MAINNET_CLAIM_ESCROW_ADDRESS</code> and <code>ARC_NETWORK_MODE=mainnet</code>) and redeploy. Arc then runs on mainnet with the 1% fee, and the card shows what the fee forwarder holds, with a button that sends it to the operator.</li>
        </ol>
        <p>Optionally, <code>ARC_MAINNET_RPC_URL</code> names a QuickNode Arc Mainnet endpoint for the server's own reads. It must report chain ID {ARC_MAINNET.chainId}; the official endpoints take over when it fails, and wallets keep the official RPC.</p>
        <h3>Admin panel</h3>
        <ul>
          <li>Open <a href="/admin">/admin</a> with an admin wallet: one named in <code>ADMIN_WALLET_ADDRESSES</code> (wallet addresses separated by commas), or the operator wallet (<code>ROBINHOOD_OPERATOR_ADDRESS</code> or <code>ARC_MAINNET_OPERATOR_ADDRESS</code>).</li>
          <li>It shows SP totals, every account (by wallet, <code>github:handle</code> or Solana address) with its linked accounts, payments, open vault links and SP history, the SP ledger, payments and vault links on every network, and the audit log.</li>
          <li>Every change asks the admin wallet to sign that one change: SP rules (saved as a new version), adding or taking SP, reversing an SP entry, stopping an account's SP, awarding missing SP, pausing a feature and the desk notice. The change is written to the audit log, with the signature, before it runs. Pauses stop new payments or new vault links of one kind; claims, refunds and confirming a payment already signed are never paused.</li>
          <li><em>Invites</em> shows who joined with an invite, the USDC inviters earned and who is owed $1.00 or more. To pay them, connect the Solana wallet that pays (it needs the USDC and a little SOL), prepare a payout, check the people and amounts, and sign it: up to eight people in one transaction. HaPaPay records it once Solana shows each amount, and nothing is ever paid automatically.</li>
          <li>Set <code>CRON_SECRET</code> (any long random value) to let Vercel run a daily check that awards missing SP for every account. Without it, SP are still awarded whenever someone opens the desk or an admin runs the check.</li>
          <li>The SP ledger, the rule versions and the audit log only grow: the database refuses changes and deletions to their rows. Export them from the panel's <em>Data</em> section regularly, and use a database plan whose restore window covers the time you need (Neon's Free plan keeps 6 hours).</li>
        </ul>
        <p>Health and configuration can be checked any time at <a href="/api/health">/api/health</a> and <a href="/api/providers">/api/providers</a>.</p>
      </section>

      <section id="legal" className="docs-section">
        <h2>Legal notes</h2>
        <ul>
          <li>HaPaPay is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc., Paxos, Circle or Arc, Solana, the xStocks issuer, or Privy.</li>
          <li>xStocks are tokens that track shares and funds and give economic exposure, not ownership of the underlying shares. They are not for U.S. persons, and other regional restrictions apply. xStocks transfers and claims ask for your statement that you and the recipient are eligible; this is a self-attestation, not a legal review. Their issuer can pause transfers and move or burn balances. <External href="https://xstocks.fi">xStocks</External></li>
          <li>Robinhood Stock Tokens are tokenised debt securities that give economic exposure, not legal ownership of the underlying shares. They may not be offered, sold or delivered in the United States or to U.S. persons, and other regional restrictions apply. Mainnet Stock Token transfers and claims ask for your statement that you and the recipient are eligible; this is a self-attestation, not a legal review. <External href="https://docs.robinhood.com/chain/stock-tokens/">Stock Tokens</External></li>
          <li>USDG is issued by Paxos and USDC by Circle. Their issuers can pause transfers and freeze addresses.</li>
          <li>SP are loyalty points with no cash value. They cannot be bought, sold, transferred or exchanged for money, tokens or anything else, and HaPaPay may change or end them.</li>
          <li>Invite rewards in USDC are a share of HaPaPay's fee on payments by people who joined with your link, paid by HaPaPay at the rate in force when each payment was made. HaPaPay may change or end them for future payments. They are not a return on any token and not an investment.</li>
          <li>Nothing on HaPaPay is investment, legal or tax advice. Blockchain transfers are final.</li>
        </ul>
      </section>
    </article>
  </section>;
}
