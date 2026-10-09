# Invariants

These are the rules every change must keep. Tests enforce most of them; the rest are reviewed by hand. When a change
needs to break one, update this file, [decisions.md](decisions.md) and [security.md](security.md) in the same change.

## Custody and signing

- The server never holds, receives or derives user keys, never signs a user's transfer and never broadcasts one.
- The only keys the server signs anything for a chain with are the per-network claim attestors (the session secret
  signs wallet sessions, which never reach a chain); it also holds the Arc identity registry's attestor keys, only to
  derive that registry's verifier address. Each mainnet attestor has one role on one network: a
  mainnet key equal to another attestor's key counts as missing, and the Solana attestor must differ from the operator
  and the treasury.
- An LLM reading is untrusted input. Authorization, identity resolution, amount conversion, chain checks, signing,
  receipt verification and persistence stay deterministic.

## Review and preparation

- A draft is a description, never a transaction. Preparation resolves every recipient again and answers `409` when
  the destination changed since the review.
- The browser opens a wallet only when the prepared transaction equals, byte for byte, the call it rebuilds from the
  review: chain, token, sender, recipient, amount, fee (at most 1%, split as the contract splits it), note and, on
  Solana, the compute budget. An approval alone is never accepted.
- Wallet network entries come from bundled constants, never from a server response.
- A network preference that cannot be parsed is a `400`; an explicit network that is unavailable is a `503`, never a
  silent fallback.

## Records

- A payment is recorded only from a successful receipt sent by the session wallet that contains the exact transfer
  logs (and the router's `Paid` event where a router is used). A transaction hash alone is never proof.
- Every record is keyed by chain and transaction (or signature and index); a replay answers `409`.
- A vault link is recorded only from the exact `PaymentCreated` event or program account, and a funded link is never
  left unrecorded: the browser keeps the funding until the server accepts it.
- Recorded amounts are the units the chain moved, never text from the browser.

## Identity

- Ownership of a social account is proven only by the platform's official OAuth, signature or HMAC flow.
- One provider identity belongs to one wallet at a time; one handle to one provider identity.
- Links are removed only by a fresh sign-in that proves the handle moved, or by the wallet's own removal.
- An account's Solana address changes only with the wallet's consent.
- A link that waits for a name is claimable only by an account confirmed with that name after the link was made, and on
  platforms whose IDs carry a creation time, only by an account older than the link.

## Assets and networks

- Assets are committed allowlists pinned by address or mint and read back from chain by the sync scripts. Live data
  never adds an asset or changes an address.
- Stock amounts never pass through the six-decimal USDC paths, and USDC never reaches a stock path.
- Chain parameters are code constants. Environment values can only point the server at an RPC, which must report the
  expected chain ID or genesis hash before anything is prepared.
- HaPaPay sends stablecoins and stocks, not SOL; SOL is read only for network fees, rent and holdings.
- The intent engine never guesses: anything ambiguous or missing gets one question.

## Vaults and contracts

- A vault window is at most 31 days; claims are allowed through the expiry, refunds strictly after it and only to the
  payer. A funded payment ID can never be funded again.
- Claim attestations bind chain, vault, payment, identity key, token, recipient, amount, expiry and a deadline at most
  ten minutes away.
- Contracts keep no settings in `immutable`, so deployed code can be pinned by hash. The server accepts a contract or
  program only when its code matches the committed artifact and its owner, verifier, treasury and fee settings match.
- Changing a contract means regenerating its artifact (`npm run generate:stock-escrow`) in the same change; changing the
  program means rebuilding and pinning it (`npm run build:solana-vault`).

## Fees, points and admin

- The fee is 1% on top of the amount, rounded down, charged on chain where a router exists; the recipient receives
  exactly the reviewed amount.
- SP have no cash value. They come from activity verified on chain, small bonuses, invite shares and signed
  admin adjustments. The balance is the sum of ledger rows.
- The SP ledger, rule versions, admin audit log and invite tables only grow; corrections are new rows.
- Every admin change is signed by an admin wallet and written to the audit log before it runs.

## Runtime

- Production requires PostgreSQL and an explicit HTTPS origin. Requests never change the schema; migrations are
  explicit and the boot-time check refuses an incompatible schema.
- Secrets stay on the server: never in `VITE_` variables, responses, logs or committed files. Provider, database and RPC
  error text never reaches the browser.
- Server code type-checks under ES2021 as well as the project build:
  `npx tsc --noEmit --strict --module ESNext --moduleResolution Bundler --target ES2021 --skipLibCheck server.ts`.

## Presentation

- Public copy is English and names no availability the server did not report.
- The non-affiliation statements and the Stock Token and xStocks eligibility statements stay on the home page, the
  docs and the boards.
- Animations are never slowed or thinned to save work; they move off the main thread instead, and stop for reduced
  motion.
