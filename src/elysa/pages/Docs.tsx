import { ELYSIUM_MAINNET, ELYSIUM_TESTNET, MULTICALL3 } from "../../domain/elysium";
import { linkProps } from "../router";

const SECTIONS = [
  ["start", "Get started"],
  ["pay", "Send, split, request"],
  ["elysium", "Elysium"],
  ["security", "Security"],
  ["fees", "Fees"],
  ["faq", "Questions"],
] as const;

/** How ElysaPay works, on one page. */
export function DocsPage() {
  return <div className="docs">
    <nav className="docs-nav glass" aria-label="On this page">
      {SECTIONS.map(([id, title]) => <a key={id} href={`#${id}`}>{title}</a>)}
    </nav>
    <article className="docs-body">
      <header className="page-head"><p className="eyebrow">Docs</p><h1>How <span className="aurora-text">ElysaPay</span> works</h1><p className="muted">Payments by name on Elysium, from your own wallet.</p></header>

      <section id="start" className="glass">
        <h2>Get started</h2>
        <ol>
          <li><b>Connect a wallet.</b> Rabby, MetaMask or any EVM wallet; ElysaPay asks it to sign a short message that proves the address. Nothing moves.</li>
          <li><b>Link your accounts</b> under <a {...linkProps("/app/identity")}>Identity</a>: GitHub, X, Farcaster, Telegram or Discord, each through its official sign-in. From then on, a payment to that handle reaches your wallet.</li>
          <li><b>Get testnet HYPE</b> from <a href={ELYSIUM_TESTNET.faucetUrl} target="_blank" rel="noreferrer">Kinetiq's faucet</a> or the <a href={ELYSIUM_TESTNET.bridgeUrl} target="_blank" rel="noreferrer">bridge</a> from HyperEVM Testnet.</li>
        </ol>
      </section>

      <section id="pay" className="glass">
        <h2>Send, split, request</h2>
        <p><b>Send</b> pays one handle. Write the amount in HYPE, or in dollars at Hyperliquid's live HYPE mid; the review always shows the exact HYPE, the 1% fee and the total, and the wallet the handle resolves to now.</p>
        <p><b>Split</b> pays up to ten handles in one transaction: split a total evenly or give each person an amount. Every handle is checked before you sign; one without a verified wallet stops the split.</p>
        <p><b>Request</b> makes a link (and QR code) to one of your handles, with an amount and a note if you like: <code>elysapay.app/pay/x/alice?amount=5</code>. The payer lands on Send with it filled in.</p>
        <p>Every payment has a <b>receipt</b> at <code>/r/…</code> that anyone with the link can open: who was paid, how much, the note, the block, and how long Elysium took to confirm it.</p>
      </section>

      <section id="elysium" className="glass">
        <h2>Elysium</h2>
        <p>Elysium is Kinetiq's layer 2 for the Hyperliquid ecosystem: an Arbitrum Orbit chain that settles to HyperEVM, uses HYPE for gas and makes a block about every 100 ms. One sequencer orders transactions by priority fee; there is no public mempool.</p>
        <table>
          <thead><tr><th>Network</th><th>Chain ID</th><th>RPC</th><th>Explorer</th></tr></thead>
          <tbody>
            <tr><td>{ELYSIUM_TESTNET.chainName}</td><td>{ELYSIUM_TESTNET.chainId}</td><td><code>{ELYSIUM_TESTNET.rpcUrl}</code></td><td><a href={ELYSIUM_TESTNET.explorerUrl} target="_blank" rel="noreferrer">Explorer</a></td></tr>
            <tr><td>Elysium mainnet</td><td>{ELYSIUM_MAINNET.chainId} (expected)</td><td>at launch</td><td>at launch</td></tr>
          </tbody>
        </table>
        <p>Mainnet is planned for November 9, 2026. ElysaPay switches it on only when the official RPC answers chain {ELYSIUM_MAINNET.chainId}. Multicall3 is at <code>{MULTICALL3}</code>. A plain HYPE transfer costs about 21,140 gas there (the HyperEVM posting cost is added), so ElysaPay always lets the chain estimate gas.</p>
      </section>

      <section id="security" className="glass">
        <h2>Security</h2>
        <ul>
          <li><b>Non-custodial.</b> ElysaPay never holds keys or funds. It prepares the exact call; your wallet signs and sends it.</li>
          <li><b>Checked before you sign.</b> The handle is resolved again, your balance is read and the payment is simulated on Elysium before the wallet opens; the page checks the call goes to the router this network lists.</li>
          <li><b>Recorded from the chain.</b> A payment counts only once its receipt shows the router's <code>Paid</code> event to the wallet the handle resolves to.</li>
          <li><b>The router</b> has no owner and no upgrade path, never holds funds, refuses a direct HYPE transfer, and reverts the whole payment if a recipient refuses it.</li>
          <li><b>Not audited yet.</b> Start with small amounts.</li>
        </ul>
      </section>

      <section id="fees" className="glass">
        <h2>Fees</h2>
        <p>1% of each payment, rounded up and added on top: the recipient always receives exactly the amount written. Gas on Elysium is a fraction of a cent. The fee rate is a constant in the router; nobody can raise it.</p>
      </section>

      <section id="faq" className="glass">
        <h2>Questions</h2>
        <details><summary>Someone has not joined yet. Can I pay them?</summary><p>Not yet on Elysium: they link their account first, then you pay them. Share ElysaPay with them; it takes a minute.</p></details>
        <details><summary>Which wallet receives a payment?</summary><p>The one the handle's owner verified on ElysaPay, read again right before you sign. The review shows its address.</p></details>
        <details><summary>Can a payment be reversed?</summary><p>No. Like any on-chain transfer it is final once confirmed; check the review before you sign.</p></details>
        <details><summary>Where do prices come from?</summary><p>Hyperliquid's public market data. They are information, not advice, and never change the HYPE you sign for.</p></details>
      </section>
    </article>
  </div>;
}
