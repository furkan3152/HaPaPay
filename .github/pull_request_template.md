## What this changes

<!-- What the change does and why. Link the issue it closes, if there is one. -->

## How it was checked

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:forge` (when `contracts/` changed)
- [ ] The ES2021 check of `server.ts` from CONTRIBUTING.md (when server code changed)

## Before review

- [ ] Keeps every rule in `docs/invariants.md`, or updates it, `docs/security.md` and `docs/decisions.md` together
- [ ] Regenerated contract artifacts (`npm run generate:stock-escrow`) or the pinned Solana build
      (`npm run build:solana-vault`) when their sources changed
- [ ] Interface copy is English and follows `docs/design-system.md`
- [ ] No keys, tokens or connection strings in code, tests or logs
