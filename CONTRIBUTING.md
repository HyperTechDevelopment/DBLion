# Contributing to DBLion

[English README](./README.md) · [README em português](./README.pt-BR.md) · [Roadmap](./ROADMAP.md)

DBLion is a pre-1.0 desktop database IDE with a deliberately conservative safety model. Contributions are welcome, especially adapter work, live-engine tests, documentation and UI polish.

Be direct and respectful. Critique the change, not the person; assume good faith and keep decisions grounded in behavior and evidence.

Before changing code, read the [README](./README.md), the [security invariants](./SECURITY.md) and the [roadmap](./ROADMAP.md). If a change touches execution, read-only enforcement, provider egress or secrets, explain the reasoning in the pull request.

## Requirements

- Node.js 22 or newer and npm.
- A desktop session for manual UI checks.
- Windows x64 for the packaged installer. Development works on Windows, macOS and Linux; other packaged targets are not release-tested yet.
- For live database checks, a dedicated test database and a least-privilege role. Never point the test suite at production.

## Setup

```bash
npm ci
npm run dev
```

Build the unpacked app:

```bash
npm run build
npm run dist
```

Build the Windows installer:

```bash
npx electron-builder --win nsis
```

Generated output lives in `out/` and `release/`. Both are ignored by Git. Do not commit them, the installer, local state, database files or secrets.

## Project layout

```text
src/main       Electron main: adapters, safety, AI context, storage
src/preload    Typed contextBridge surface
src/renderer   React UI, Monaco editor, schema explorer, AI panel
src/shared     Types, SQL classification, access policy, URL helpers
scripts        Automated suites and test helpers
docs           Capability matrix, engine notes and README assets
```

## Checks before a pull request

Run the complete set locally. A skipped live test is not a pass.

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | The TypeScript project compiles |
| `npm run test:safety` | SQL classification and execution gates |
| `npm run test:security` | Renderer boundary and navigation policy |
| `npm run test:firebird` | Firebird adapter, queue, plan and URL behavior |
| `npm run test:firebird-catalog` | Firebird catalog/DDL module against canned RDB$ rows |
| `npm run test:serial-queue` | Per-connection serialization and failure isolation |
| `npm run test:ai-data` | Profiling/sampling payloads, masking and approval tokens |
| `npm run test:multi-db` | Capability parity across SQL engines |
| `npm run test:read-only` | Database-enforced read-only fences and guard behavior |
| `node --import ./scripts/lib/ts-alias-register.mjs scripts/ai-safety.test.mjs` | Prompt framing, egress and AI safety |
| `npm run build` | Main, preload and renderer bundles |

Live checks are optional and read URLs from the environment:

```bash
DBLION_TEST_PG_URL=postgres://user:pass@host:5432/db
DBLION_TEST_MYSQL_URL=mysql://user:pass@host:3306/db
DBLION_TEST_MSSQL_URL=sqlserver://user:pass@host:1433/db
DBLION_TEST_FIREBIRD_URL=firebirdsql://user:pass@host:3050/path/to/db.fdb?encoding=UTF8
```

When a URL is absent, the suite reports `skipped`. The PostgreSQL, MySQL and SQL Server probes need a role that can create and drop their probe tables. The Firebird check reads metadata and requests an estimated plan; it does not create tables.

For UI changes, run the packaged or development app and exercise the affected flow. Screenshots or a short recording help reviewers. For adapter changes, add or update the relevant contract check and, when possible, run it against a live server.

## Architecture and invariants

These are product guarantees, not implementation details. A change that weakens one needs a design discussion.

- **The main process is the authority** for SQL safety, schema context and secrets. The renderer never supplies schema text or claims a write is allowed.
- **The AI never executes.** It has no tool calling, MCP or shell access. Proposed SQL runs only after a human action, through the same gates as typed SQL.
- **Writes require the write toggle, a non-read AI mode and a native confirmation.** The confirmation is bound to a short-lived, single-use token and the exact SQL or row identity.
- **Read-only profiles are enforced in the database where possible.** PostgreSQL, MySQL, SQLite and Firebird have database-level read-only modes; SQL Server uses `ApplicationIntent=ReadOnly` when available and still needs the app guard; MongoDB and Redis rely on the app guard.
- **AI-originated reads use the database fence** where the engine supports one. If an explicit transaction is already open on PostgreSQL or MySQL, refuse the run instead of dropping the fence.
- **Secrets stay in main.** OS encryption via Electron `safeStorage`; passwords, API keys and SSH private keys must never reach the renderer, logs or audit entries.
- **The renderer is isolated.** Keep `sandbox`, `contextIsolation`, no `nodeIntegration`, CSP, navigation policy and the external-link allowlist intact.
- **Schema, comments, skills and sampled data are untrusted.** Keep them inside `<untrusted-*>` blocks, neutralize delimiter spoofing and never let them reorder the security rules.
- **Provider egress is explicit.** Do not add attribution, telemetry or hidden headers. The Context panel must keep showing the exact payload.
- **Data sampling is opt-in.** It uses a per-request token, PII masking, row caps and an exact preview. Do not make it automatic.
- **Database grants are the final boundary.** Document least-privilege deployment; do not present the app as a replacement for database permissions.

## Adding or changing a database adapter

1. Implement `DbAdapter` from `src/main/db/types.ts` in a new `src/main/db/<engine>.ts`.
2. Implement the required methods: `connect`, `disconnect`, `serverVersion`, `query`, `listTables`, `describeTable`, `graph` and `buildContext`.
3. Implement optional capabilities only when they are real: `catalog`, `ddl`, `explain`, `cancel`, `begin/commit/rollback`, `listSessions`, `killSession`, `columnsIndex`.
4. Add the capability entry in `src/main/db/index.ts`. Do not advertise `explainAnalyze` unless the statement runs inside a read-only transaction.
5. Declare the read-only enforcement layer in `src/shared/access.ts`; if the engine has no native mode, keep the app guard and say so in the docs.
6. Add a URL parser or connection helper in `src/shared` when the engine uses a URL format.
7. Extend the contract tests with `listTables`, `describeTable`, `buildContext`, catalog/DDL and the read-only refusal. Add a live test guarded by `DBLION_TEST_<ENGINE>_URL`.
8. Update the supported-database table in both READMEs (`README.md` and `README.pt-BR.md`).

Adapters must never bypass `ensureWritable`, the SQL classifier, the main-process confirmation flow or the read-only transaction used for AI reads.

## Test guidelines

- Import production modules through `scripts/lib/ts-alias-register.mjs`; do not copy implementation into tests.
- Prefer behavior tests with a fake connection or canned metadata. Firebird already has a fake attachment; the catalog module accepts an injected query function.
- Live tests must report `skipped` when no server is configured. Never turn a skip into a pass.
- Clean up probe tables and temporary files even when an assertion fails.
- Test read-only refusal at the database level, not only at the classifier.
- AI tests must assert the exact egress, the absence of tool/execution paths, delimiter neutralization and PII behavior.
- Do not add network calls to unit tests. Do not require a real model provider.

## Code style

- Match the surrounding TypeScript and React patterns. Keep changes focused and avoid unrelated refactors in a bug fix.
- Prefer explicit types at module boundaries and avoid `any` when a local interface can describe the shape.
- Comments should explain why a constraint exists, not restate the code.
- Do not add a dependency for a problem that a small local helper can solve. Justify any new runtime dependency.
- Keep main-process code free of renderer imports and keep the preload surface typed.

## Commit and pull request guidelines

- Work in a branch and keep one logical change per pull request.
- Use an imperative subject, for example `fix(firebird): serialize plan preparation with queries`.
- In the body, state what changed, why, which command proves it and any known limit.
- Include screenshots or a short clip for UI changes.
- Do not commit `node_modules/`, `out/`, `release/`, database files, `.env` files, local state or secrets.
- If a live test was skipped, say so explicitly in the pull request.
- Do not weaken the confirmation, read-only or egress rules to make a test pass.

A pull request is ready when the checks pass, the change is documented and the safety invariants above still hold.

## Release checklist

1. Update the version in `package.json` and `installer.iss`.
2. Run the full check suite and a manual smoke test on the packaged app.
3. Build the installer with `npx electron-builder --win nsis`.
4. Verify the version, icon and SHA-256 of the artifact.
5. Update `ROADMAP.md` and the README status when the release changes supported behavior.
6. Attach the installer to the release; do not commit `release/`.

## Reporting issues and security problems

For bugs, include the operating system, database engine and version, the smallest reproduction, expected versus actual behavior and redacted logs. Do not paste credentials, connection strings with passwords or customer data.

Do not open a public issue for a vulnerability. Follow [SECURITY.md](./SECURITY.md) and report it privately.

## License

By contributing, you agree that your contribution is licensed under the project's [MIT License](./LICENSE).
