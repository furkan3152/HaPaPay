# Security policy

HaPaPay handles real assets, so security reports are taken seriously and handled privately.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. If that button is not available, open an issue that asks for
a private contact, without any details of the problem.

Include what you can:

- the component (desk, API, a contract, the Solana program, deployment configuration)
- the impact you expect and the conditions it needs
- steps to reproduce, a proof of concept, or the transaction hashes involved

Reports are acknowledged as soon as possible, and fixes for confirmed issues are prioritized by impact. There is no
bug bounty at this time.

## Scope

In scope:

- `contracts/` and `programs/hapapay-vault/`
- the API in `server/` and the shared rules in `src/domain/`
- the desk's transaction review and wallet handling
- the default deployment configuration (`vercel.json`, `Dockerfile`)

Out of scope: third-party platforms (social providers, wallet providers, RPC providers, the chains themselves),
denial-of-service through volume, and findings that require a compromised operator key or database.

## Before you deploy

The contracts and the Solana program have not had an independent audit. Read [docs/security.md](docs/security.md)
for the trust model and the known limitations before running HaPaPay with real funds.
