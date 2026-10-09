# Contributing

Thanks for taking the time to improve HaPaPay. This guide covers the workflow and the conventions the codebase relies
on.

## Setup

```bash
npm ci
cp .env.example .env
npm run dev
```

Node.js 24 is the supported runtime. Forge and Anvil come with `npm ci`, so the test suite and the contract tests need
nothing else (Forge downloads solc 0.8.28 on its first run). The Agave (Solana) tool suite is optional, for the program
build and the validator tests. The pinned build was made with Agave 4.3.0 (its `cargo-build-sbf` reports 4.4.0, with
platform-tools v1.57 and rustc 1.95.0), and `npm run build:solana-vault` refuses any other toolchain.
`npm run test:slither` needs pipx with access to PyPI.

## Before you open a pull request

Run the checks that cover your change:

```bash
npm run check            # TypeScript project check
npm test                 # the Node test suite
npm run build            # production build of the desk
npm run test:forge       # if you touched contracts/
```

Server code is also type-checked under ES2021 by the serverless builder:

```bash
npx tsc --noEmit --strict --module ESNext --moduleResolution Bundler --target ES2021 --skipLibCheck server.ts
```

## Conventions

- **Read the rules first.** [docs/invariants.md](docs/invariants.md) lists what every change must keep;
  [docs/security.md](docs/security.md) explains why. A change that has to break an invariant updates both, and
  [docs/decisions.md](docs/decisions.md), in the same pull request.
- **Shared logic lives in `src/domain/`.** Anything both the browser and the server need (parsing, fees, allowlists,
  transaction matching) belongs there, without browser or Node-only APIs.
- **Contracts and artifacts move together.** After editing `contracts/`, run `npm run generate:stock-escrow` and commit
  the regenerated artifacts. After editing `programs/hapapay-vault/`, run `npm run build:solana-vault` and commit the
  new build and its pinned hash.
- **Allowlists are generated.** Use `npm run sync:stock-tokens` and `npm run sync:solana-stocks`; never edit the token
  lists by hand.
- **Interface copy is English**, plain and specific, and follows [docs/design-system.md](docs/design-system.md). The
  request reader also understands Turkish, so tests for it may contain Turkish text.
- **No secrets anywhere.** Never commit keys, tokens or connection strings, and never print them in logs or tests.
  `.env.example` lists names, with values only for non-secret defaults and placeholders that production refuses.
- **Tests come with behavior.** New rules get tests next to the existing ones; flows that move money get a lifecycle
  test.

## Commit messages

Write the subject as what the change does, in the imperative and in plain words ("Refuse a second asset in one
request"), and use the body for the why.
