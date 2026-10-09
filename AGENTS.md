# HaPaPay repository guidance

Before changing behavior, APIs, data models, contracts, or network handling, read:

- [`docs/invariants.md`](docs/invariants.md) for the rules every change must keep.
- [`docs/decisions.md`](docs/decisions.md) for accepted architecture and network decisions.
- [`docs/security.md`](docs/security.md) for trust boundaries, controls, and known limitations.
- [`docs/protocol.md`](docs/protocol.md) before touching `contracts/` or `programs/`.

Use the existing modules, package manager, tests, and naming. Do not create parallel implementations. Keep interface
copy in English, never commit or print secrets, and regenerate contract artifacts and the pinned Solana build whenever
their sources change.
