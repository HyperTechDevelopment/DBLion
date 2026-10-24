<p align="center">
  <img src="./docs/assets/hero.svg" width="100%" alt="DBLion — the guarded AI database IDE. The AI proposes. You execute." />
</p>

<div align="center">
  <p>
    <a href="README.md"><strong>English</strong></a> ·
    <a href="README.pt-BR.md">Português (BR)</a>
  </p>
  <p>
    <a href="./ROADMAP.md"><img src="https://img.shields.io/badge/version-0.1.0-6d28d9?style=flat-square" alt="Version 0.1.0" /></a>
    <a href="./ROADMAP.md"><img src="https://img.shields.io/badge/status-pre--1.0-f59e0b?style=flat-square" alt="Pre-1.0" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square" alt="MIT license" /></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-2563eb?style=flat-square" alt="Windows x64" />
    <img src="https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20TypeScript-0f172a?style=flat-square" alt="Electron, React and TypeScript" />
  </p>
</div>

<p align="center">
  <img src="./docs/assets/dblion-app.png" width="100%" alt="DBLion 0.1.0 maximized: workspace with SQL Editor, read-only badge, connections sidebar and guard toolbar" />
</p>

<p align="center"><sub>DBLion 0.1.0 fullscreen — SQL workspace, guarded execution, plans and schema tools. AI proposes, only you run.</sub></p>

---

> **Status: 0.1.0, pre-1.0.** The safety model, adapters and AI context pipeline are covered by automated tests. Live validation against each database engine is the remaining release gate. See [ROADMAP.md](./ROADMAP.md).

## Contents

| Get started | Go deeper |
| --- | --- |
| [Quick start](#quick-start) · [Supported databases](#supported-databases) · [What you can do](#what-you-can-do) | [Safety model](#safety-model) · [AI](#ai) · [Architecture](#architecture) |
| [Development and tests](#development-and-tests) · [Project layout](#project-layout) | [Status and roadmap](#status-and-roadmap) · [Documentation](#documentation) |

## At a glance

| Principle | What it means |
| --- | --- |
| **Human in control** | The AI drafts SQL, explains plans and diagnoses; only a person runs a statement. |
| **Multi-engine** | PostgreSQL, MySQL/MariaDB, SQL Server, Firebird, SQLite, MongoDB and Redis behind one adapter contract. |
| **Guarded reads** | AI-originated reads use a database-enforced read-only mode or transaction where available. |
| **Inspectable egress** | The exact provider payload, schema blocks and sampled data are visible before they leave the machine. |

## Quick start

Requirements: Node.js 22 or newer, npm, and a desktop session. The packaged installer currently targets Windows x64.

1. Install and open the studio:
```bash
npm ci
npm run dev
```
2. Click **Add connection**, pick your engine, test and save.
3. Write SQL or ask the copilot, review the proposal, then press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run — nothing executes without you.

Build the unpacked app:

```bash
npm run build
npm run dist
```

Build the Windows installer:

```bash
npx electron-builder --win nsis
```

Artifacts are written to `release/`. The installer is `release/DBLion Setup <version>.exe`. That directory, `out/` and `node_modules/` are generated and ignored by Git.

## Supported databases

| Engine | Query | Table browser | Catalog / DDL | Estimated plan | Row edit | CSV import |
| --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL | Yes | Yes | Yes | Yes, plus `ANALYZE` | Yes | Yes |
| MySQL / MariaDB | Yes | Yes | Yes | Yes, plus `ANALYZE` | Yes | Yes |
| SQL Server | Yes | Yes | Yes | Yes, `SHOWPLAN_TEXT` | Yes | No |
| Firebird | Yes | Yes | Yes | Yes | No | No |
| SQLite | Yes | Yes | Yes | Yes, `EXPLAIN QUERY PLAN` | Yes | Yes |
| MongoDB | Documents | Collections | — | — | — | — |
| Redis | Commands | Keys | — | — | — | — |

Notes:

- **Firebird plans** use native `EXPLAIN` on 6+ and `isc_info_sql_get_plan` on 2.5–5 when the driver exposes it. `EXPLAIN ANALYZE` is never offered for Firebird.
- **SQL Server plans** use `SHOWPLAN_TEXT` on a transaction-pinned connection; `ANALYZE` would execute the query and is not offered.
- **Firebird row editing and CSV import** are disabled until the adapter has commit/rollback transactions. Ordinary queries, catalog, DDL, diff and migrations are enabled.
- **SQL Server CSV import** is disabled because the adapter has no atomic transaction path. Row edits are not atomic with the read they were based on.
- **Sessions** are available for PostgreSQL, MySQL and SQL Server. Session termination uses a dedicated IPC and token, never free SQL.
- **Read-only enforcement** is database-level for PostgreSQL, MySQL, SQLite and Firebird; SQL Server uses `ApplicationIntent=ReadOnly` when available; MongoDB and Redis rely on the app guard. Database grants remain the final boundary.

## Architecture

```mermaid
flowchart LR
  UI["React renderer"] -->|"typed IPC"| MAIN["Electron main"]
  MAIN --> GUARD["SQL guard + tokens"]
  GUARD --> ADAPTERS["Database adapters"]
  ADAPTERS --> DB[("PostgreSQL · MySQL · SQL Server<br/>Firebird · SQLite · MongoDB · Redis")]
  MAIN --> CTX["Schema + request context"]
  CTX --> AI["AI provider"]
  AI -.->|"proposal only"| UI
```

The AI receives context and returns text. It has no path to the database; the only way a statement reaches an engine is a human action through the guard.

## What you can do

### SQL workspace

- Multiple query tabs, `Ctrl+Enter` to run the selection or the whole editor, and a persistent 200-entry history.
- Results show the first 5,000 rows with a truncation warning; export saves CSV, JSON or SQL `INSERT` through a native dialog.
- Server-side pagination, filters and row editing in the Table Browser. Row updates are previewed, conflict-checked and confirmed natively.
- Estimated plan tree with cost, rows and warnings. `EXPLAIN ANALYZE` is available only where it can run inside a read-only transaction (PostgreSQL and MySQL).
- CSV import with column mapping, type coercion, a content hash and a single transaction. Limits: 5 MB / 5,000 rows.
- Schema explorer with tables, views, routines, triggers, indexes, generators and domains where the engine exposes them.

### Interface

- Step-based connection wizard (Engine → General → Options → Review) with a generated URL preview, test connection and native save flow.
- AI Providers master–detail screen with profile cards, provider setup hints, model/context presets and credential handling.
- SQL tabs, schema explorer, ER graph, plan tree, table browser and AI panel in one window.
- Bundled themes and fonts; no remote font fetch.

### Schema tools

- Catalog and DDL inspection for every SQL engine. Reconstructed table DDL is marked with a review warning.
- Schema diff between two connections of the same engine, producing a review-only migration.
- Migration files stored as versioned `.sql` documents. Saving never executes anything.

### AI copilot

- Chat with streaming, SQL blocks and a reviewable **Run manually** action.
- Schema-aware Monaco autocomplete and optional AI inline completion.
- Schema context trimmed to the request; table ranking uses names, column names and comments.
- ER graph, skills and context preview.

## Safety model

| Layer | Control |
| --- | --- |
| **Execution** | The AI never executes and has no tool calling, MCP or shell access. Proposed SQL runs only after a human action. |
| **Read-only** | Global read-only is on by default. Each profile has its own access mode, applied when the session opens. |
| **AI reads** | PostgreSQL, MySQL and Firebird use a read-only transaction; SQLite uses `PRAGMA query_only`. SQL Server falls back to the classifier and app guard. |
| **Writes** | The toolbar toggle, a non-read AI mode and a native confirmation are required. The token is single-use and bound to the exact SQL or row identity. |
| **Authority** | The main process resolves SQL safety, schema context and secrets. The renderer cannot supply schema text or claim a write is allowed. |
| **Secrets** | OS encryption via Electron `safeStorage`; passwords, API keys and SSH private keys never reach the renderer, logs or audit entries. |
| **Renderer** | `sandbox`, `contextIsolation`, no `nodeIntegration`, CSP, blocked navigation and an external-link allowlist for `http:`, `https:` and `mailto:`. |
| **Untrusted input** | Schema, comments, skills and sampled data stay inside `<untrusted-*>` blocks; delimiter spoofing is neutralized and security rules come first. |
| **Egress** | No attribution or telemetry headers. The Context panel shows the exact payload; PII masking is optional per profile. |
| **Data sampling** | Per-request approval, PII masking, row caps and a 60-second single-use token. |
| **Final boundary** | Database grants. Use a least-privilege database user for read-only work. |

Read [SECURITY.md](./SECURITY.md) for the full invariant list and the disclosure process.

## AI

Supported providers: OpenAI, Anthropic, Ollama, OpenRouter and custom OpenAI-compatible endpoints.

Each profile controls the base URL, model, API key, context window, temperature, output limit, timeout, streaming, schema sharing, PII masking and custom instructions. The AI panel exposes the exact system prompt and conversation through **Context**; the preview never contains the API key.

Autocomplete and inline completion resolve schema from the **live connection in the main process**. The renderer cannot choose or alter the schema sent to the provider, and the AI autocomplete toggle is enforced in main.

<details>
<summary><strong>Skills discovery paths</strong></summary>

DBLion discovers `SKILL.md` files recursively from:

- `~/.agents/skills`
- `~/.agents/.skills`
- `~/.commandcode/skills`
- `~/.claude/skills`
- `~/.config/opencode/skills`
- `~/.opencode/skills`
- project `.agents/skills` and `.claude/skills`

Selected skills are injected into the system prompt as untrusted context. With auto-select enabled, the last user message is matched against skill names and descriptions. Skill reads are restricted to the discovered roots.

</details>

## Data for debugging

The AI panel’s **Data** control attaches evidence to one request, never automatically:

| Mode | What the provider receives | Guardrails |
| --- | --- | --- |
| **Column profile** | Row counts, nulls, distinct counts, min/max and the top five values as truncated hashes | PII-named columns are redacted |
| **Sample rows** | At most 25 rows from one table | Read-only where available, PII masking and a 60-second single-use token |

Both modes show the exact masked block and issue a single-use token. A preview does not consume the token; the next chat request does. MongoDB and Redis are excluded because they have no SQL catalog or column types.

PostgreSQL, MySQL, SQLite and Firebird enforce read-only at the database layer. SQL Server has no transaction-level read-only switch, so the generated SELECT is still gated by the classifier and the app guard.

## Data location

The app stores runtime data in Electron's `userData` directory. On Windows that is `%APPDATA%\dblion`; on macOS and Linux, use the Electron `userData` path. It contains `dblion-state.json`, `dblion-secrets.json` (encrypted values), `dblion-audit.jsonl` and the `migrations/` directory. None of it is committed to the repository.

## Development and tests

| Area | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| SQL safety | `npm run test:safety` |
| Renderer boundary | `npm run test:security` |
| Firebird adapter | `npm run test:firebird` |
| Firebird catalog/DDL | `npm run test:firebird-catalog` |
| Serial queue | `npm run test:serial-queue` |
| Multi-database parity | `npm run test:multi-db` |
| Data safety | `npm run test:ai-data` |
| Read-only fences | `npm run test:read-only` |
| AI safety | `node --import ./scripts/lib/ts-alias-register.mjs scripts/ai-safety.test.mjs` |
| Build | `npm run build` |

Live engine checks are optional and read their URLs from the environment:

```bash
DBLION_TEST_PG_URL=postgres://user:pass@host:5432/db
DBLION_TEST_MYSQL_URL=mysql://user:pass@host:3306/db
DBLION_TEST_MSSQL_URL=sqlserver://user:pass@host:1433/db
DBLION_TEST_FIREBIRD_URL=firebirdsql://user:pass@host:3050/path/to/db.fdb?encoding=UTF8
```

When a URL is absent, the check reports `skipped` instead of passing. The SQL Server test expects a role that can create its probe tables; otherwise it reports why it skipped. Firebird live coverage includes connection, write refusal, catalog, column index and estimated plan.

## Project layout

```text
src/main       Electron main: adapters, safety gates, AI context, storage
src/preload    Typed contextBridge surface
src/renderer   React UI, Monaco editor, schema explorer, AI panel
src/shared     Types, SQL classification, access policy, Firebird URL helpers
scripts        Automated test suites and test-only helpers
docs           Capability matrix, Firebird notes and README assets
```

Every database implements `DbAdapter` in `src/main/db/types.ts`. Adding one means an adapter, a capability entry in `src/main/db/index.ts` and contract tests. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status and roadmap

DBLion is **0.1.0, pre-1.0**. The safety invariants and the multi-engine adapters are unit-tested; the remaining release gate is live validation on real servers, especially Firebird 2.5/3/4/5/6.

Current known limits:

- Firebird row editing and CSV import await adapter transactions.
- Firebird table DDL is reconstructed and marked review-only; function DDL is not generated.
- SQL Server CSV import is disabled, and its row edits are not atomic with their read.
- The installer is unsigned and there is no auto-update yet.
- The Windows installer is the packaged target; other desktop platforms are not release-tested.

See [ROADMAP.md](./ROADMAP.md) for the open workstreams and release gates.

## Documentation

| Document | What it covers |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | Open work, P0 release gates and the definition of done |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, checks, adapter contract, invariants and release checklist |
| [SECURITY.md](./SECURITY.md) | Safety invariants and private disclosure |
| [LICENSE](./LICENSE) | MIT license |

## Contributing

Issues and pull requests are welcome. Keep changes small, run the checks above, and do not weaken the execution gates without a design discussion. Do not commit local state, credentials or generated build output.

## License

MIT — `SPDX-License-Identifier: MIT`. See [LICENSE](./LICENSE).

Copyright (c) 2026 DBLion contributors. The license text is the canonical MIT text, unmodified. If you fork or redistribute, keep the copyright and permission notices in all copies or substantial portions.

<div align="center"><sub>DBLion 0.1.0 · guarded execution · multi-engine SQL</sub></div>
