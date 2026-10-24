# Contributing to DBLion

## Setup

```bash
npm ci
npm run dev
```

Requires Node 22+ and Windows, macOS or Linux. Electron and the database drivers ship as npm dependencies; no global tooling is required.

## Checks before a PR

```bash
npm run typecheck
npm run test:safety
npm run test:security
npm run test:firebird
npm run test:firebird-catalog
npm run test:multi-db
npm run test:ai-data
npm run test:read-only   # live engines are skipped unless DBLION_TEST_*_URL is set
npm run build
```

A change is ready when the same commands pass locally. Do not mark a skipped live test as a pass.

## Architecture rules

- The main process is the authority for SQL safety, schema context and secrets. The renderer never supplies schema text or claims a write is allowed.
- The AI never executes SQL, never calls tools and never runs shell commands. Only a human click reaches the database.
- Reads that originated from AI run inside a database-enforced read-only transaction where the engine supports one.
- Schema, comments, skill files and sampled data are untrusted input. Keep them inside the existing `<untrusted-*>` blocks and delimiter neutralization.
- New databases implement `DbAdapter` in `src/main/db/types.ts`; add a capability entry in `src/main/db/index.ts` and an adapter contract test.

## Commit style

Small, independently verifiable commits. State the behavior change and the command that proves it. Never commit credentials, state files or `.env` secrets.
