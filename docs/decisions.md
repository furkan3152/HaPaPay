# Design decisions

Short records of the decisions that shape HaPaPay: the context, what was decided, and what it costs. Newer decisions
can supersede older ones; superseded records say so.

---

### ADR-001 · The server never holds or uses user keys

**Context.** A payment product that can sign is a custodian, with everything that implies for security and
regulation.

**Decision.** The server prepares exact transactions, checks them (simulating them on Robinhood Chain and Solana) and
verifies receipts. Wallets sign and send.
The only server key that can move value is a claim attestor, which can authorize vault payouts and nothing else.

**Consequences.** Every flow needs a wallet signature, and a vault claim is a transaction the recipient sends and pays
gas for. In exchange, a compromise of the server cannot spend anyone's balance.

### ADR-002 · Identity comes only from official sign-ins

**Context.** A handle typed into a box proves nothing, and impersonation is the obvious attack on social payments.

**Decision.** Accounts are linked through each platform's official flow (OAuth, OAuth 2.0 with PKCE, HMAC, Sign in with
Farcaster). One provider identity maps to one wallet; one handle to one identity.

**Consequences.** Every platform needs its own app and credentials, and a platform that refuses the site's
credentials stops linking until the operator fixes them.

### ADR-003 · Links live in the database, not on chain

**Context.** An on-chain identity registry was built for Arc and later for Robinhood Chain. Writing records cost every
user a signature and gas, and the registry still depended on the same off-chain attestation.

**Decision.** Verified links live in PostgreSQL; the desk writes no identity record on chain. The Arc registry stays
deployed and verified as part of Arc's contract set but is not written to.

**Consequences.** Linking an account is free and instant. The database becomes part of the trust model (see
[security.md](security.md)).

### ADR-004 · A deterministic reader first, the model as an untrusted assistant

**Context.** A language model can misread an amount or invent a recipient, and a payment cannot be "mostly right".

**Decision.** Requests are read by deterministic rules in English and Turkish. A model is asked, with an eight-second
deadline, only when the rules find no recipient for a Stock Token or Solana request, or for a USDC request that states
one amount and the asset; its reading is kept only where every handle, platform, amount and asset it returns is
written in the message. Ambiguity becomes a question, never a guess.

**Consequences.** The reader is large and heavily tested (`tests/chat-*.test.ts`), and some phrasings get a question
where a model might have guessed right.

### ADR-005 · Pinned allowlists instead of live token data

**Context.** Registries and price feeds can change, fail or be spoofed.

**Decision.** Every asset is committed by address or mint and read back from chain by the sync scripts before it is
listed. Prices never feed payment amounts or authorization; besides the board, they value stock payments for SP and
invite rewards.

**Consequences.** New listings need a sync and a release; a feed outage shows no price instead of a stale one.

### ADR-006 · The asset picks the network, and holdings break ties

**Context.** Users think in assets and people, not chains. A network menu invited mistakes.

**Decision.** No network menu: Stock Tokens and USDG go to Robinhood Chain, xStocks to Solana, USDC to Solana or Arc.
When an asset lives in two places and the request names no network, the sender's own balances decide between the
networks that can pay everyone the request names (the README's routing chart has every condition), and the review says
which network it uses and, when holdings decided it, how to ask for the other.

**Consequences.** The server reads the sender's balances (and only theirs) to choose; preparation reads them again.

### ADR-007 · Vault links for people who have not joined

**Context.** Social payments are only useful if the person on the other end can be paid before they sign up.

**Decision.** A vault (an escrow contract, or a Solana program) holds the amount and the fee for an identity key until
a verified recipient claims it with a short-lived attestation, or the payer refunds it after its window (the desk
offers 3, 7, 14 or 30 days; the API accepts 24 hours to 30 days). Funded payment IDs are tombstoned forever.

**Consequences.** The attestor is a privileged key, and claims cost the recipient gas on the vault's network.

### ADR-008 · Links that wait for a name

**Context.** Discord and Telegram cannot look an account up by its name, and X's lookups depend on API access, so links
to those platforms could not be made at all.

**Decision.** Such a link waits for the name instead of the account ID (`name:<handle>`, hashed into the same identity
key, so no contract changed). It is claimable only by an account whose platform confirmed that name after the link was
made, and where IDs carry a creation time (Discord, X), only by an account older than the link.

**Consequences.** A name its holder gives up during the window can be claimed by another existing account. The review
says so before funding.

### ADR-009 · A 1% fee on top, enforced by contracts

**Context.** The service needs revenue, and users need to know exactly what they pay.

**Decision.** 1% of the amount, added on top and shown before signing, charged in the same transaction by
`HaPaPayRouter` and by the escrow on claim. On Robinhood Chain half goes to a burn vault and half to the treasury; Arc
routes its burn half through a forwarder to the treasury; Solana pays the whole fee to the treasury in the payment
transaction.

**Consequences.** Fee constants are code: changing them means new contracts and a new release.

### ADR-010 · A burn vault for any token, named once

**Context.** The burn half of fees was meant to buy back and burn a project token, which may not exist at deploy time.

**Decision.** `HaPaPayBurnVault` holds fees until its owner names a burn token once (`setBurnToken`). After that it can
only swap into that token through a call the owner chooses, with a minimum output, and burn everything it holds.

**Consequences.** Until a token is named, the burn half simply accumulates. Swap quality depends on the owner.

### ADR-011 · Contracts pinned by runtime code, deployed by the operator's wallet

**Context.** Addresses in environment variables can be mistyped or swapped; deployment scripts with private keys are
a liability.

**Decision.** Contracts keep no `immutable` settings, so every deployment has the same runtime code. The operator
deploys the committed artifacts from a page in the app with their own wallet, and the server registers a contract only
after checking its code hash, revision, owner, verifier and fee settings on chain.

**Consequences.** Every contract change regenerates its artifact. Arc's two addresses stay configuration, verified the
same way.

### ADR-012 · The Solana program stays closable

**Context.** A deployed program's code account holds a significant rent deposit, and a program that can never be
closed locks it forever.

**Decision.** The operator keeps the upgrade authority. New links can be stopped, and once no link is open the program
can be closed and its rent recovered. Because the authority could replace the code, the server re-reads the deployed
code before every vault action and refuses any difference from the pinned build.

**Consequences.** Users trust the operator not to upgrade between those reads.

### ADR-013 · Stablecoins and stocks only

**Context.** Native SOL needs wrapping for the vault, complicates fee accounting, and was rarely the point of a
social payment.

**Decision.** HaPaPay sends USDC, USDG, Stock Tokens and xStocks. SOL is read for network fees, rent and holdings only;
a request to send SOL gets an explanation and alternatives.

**Consequences.** Users still need a little SOL for Solana network fees.

### ADR-014 · Explicit migrations and append-only ledgers

**Context.** A serverless request that changes a schema can break a running release, and points and audit records must
not be rewritten.

**Decision.** In production, migrations run only through `npm run migrate:database`, and the server checks the schema
read-only at boot; only a development server applies them itself. Ledgers and logs are protected by triggers that refuse
updates, deletes and truncation; corrections are new rows.

**Consequences.** Releases that change the schema need an explicit migration step before traffic.

### ADR-015 · Stateless 30-day wallet sessions

**Context.** Re-signing on every visit is tiring, but a session store adds a stateful dependency.

**Decision.** A session is a signed, HttpOnly cookie valid for 30 days from the wallet's signature, never extended.
Sensitive changes (such as the account's Solana address) need a fresh wallet signature.

**Consequences.** Sessions cannot be revoked one by one; rotating the secret signs everyone out.

### ADR-016 · Points with no cash value, earned from verified activity

**Context.** Points invite farming, and anything that looks like a financial return invites regulation.

**Decision.** SP are earned from payments and claims verified on chain and from small bonuses (once each for a first
payment, a first claim, each linked account and a Solana address, and, up to a monthly limit, when a vault link the
account sent is claimed), under versioned rules with daily caps and per-person limits. The only other entries are invite
shares and signed, logged admin adjustments. SP cannot be bought, sold or sent. Invite rewards are a share of fees
HaPaPay verified on chain, paid in USDC by an admin.

**Consequences.** The 1% fee is the cost of farming payment SP; the bonuses are limited to once per account, address
or claimed link, and daily caps bound the rest.

### ADR-017 · Admin actions are signed and logged first

**Context.** An admin panel is a powerful target, and support actions must be accountable.

**Decision.** Reading needs an admin wallet session; every change needs that wallet's signature over a one-time message
naming the change and the hash of its payload, and is written to the append-only audit log before it runs.

**Consequences.** Admin work is slower by one signature, and every change has a permanent record.

### ADR-018 · A dot-matrix interface, dark first

**Context.** Payment apps tend to look alike, and AI-made interfaces even more so.

**Decision.** One visual language: dots everywhere, a dot-matrix face for short labels, plain faces for reading, dark by
default with a light theme. Animations are never slowed to save work; they run in a worker instead.

**Consequences.** Custom drawing code (the hero engine, the bursts, the mark) needs its own tests and care for reduced
motion and accessibility. See [design-system.md](design-system.md).

### ADR-019 · Robinhood Chain as the main network for stocks

**Context.** The product supports three networks, and the default matters for requests that name none.

**Decision.** Robinhood Chain is the main network: bare tickers and USDG go there whenever it lists the asset and can
pay everyone the request names, unless the request can also go on Solana (Solana on, the sender and every recipient
with a Solana address, or one recipient who can wait in the Solana vault) and the wallet holds enough for the payment
and its fee only there. Solana and Arc sit alongside for xStocks and USDC.

**Consequences.** The desk wears Robinhood Chain's accent by default; Solana and Arc slips keep their own colors.
