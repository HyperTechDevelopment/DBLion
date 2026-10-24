# DBLion — the guarded AI database IDE

DBLion is the guarded AI database IDE: schema-aware SQL, performance diagnosis and routines, with a human in control of every execution. It ships a desktop Electron app with a React UI, a provider registry for SQL and NoSQL databases, an AI profile system, schema-aware SQL autocomplete, an ER graph, skills and a strict permission model.

Status: 0.1.0, pre-1.0. The safety model and multi-engine adapters are unit-tested; live engine validation is described in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Run

```powershell
npm install
npm run dev
```

Build and package:

```powershell
npm run build
npm run dist
```

The packaged app is written to `release/win-unpacked/DBLion.exe`.

## Databases

- PostgreSQL
- MySQL / MariaDB
- SQL Server
- Firebird (`node-firebird`, default port 3050, database path or alias, connection charset via `lc_ctype`, query cancel/timeout, estimated plan, table and column comments)
- SQLite (`sql.js`)
- MongoDB
- Redis

Every connection goes through the same `DbAdapter` interface: connect, query, list tables, describe table, build a schema graph and build AI context. Adding a database means adding an adapter and a case in `src/main/db/index.ts`.

Firebird metadata is read from the `RDB$` system tables, including columns, primary keys and foreign keys. The connection wizard accepts a Jaybird URL such as `jdbc:firebirdsql://host:3050/sample?encoding=ISO8859` and fills host, port, database and encoding; `ISO8859` is normalized to `ISO8859_1` before being sent as `isc_dpb_lc_ctype`.

Estimated plans use `EXPLAIN` on Firebird 6+ and `isc_info_sql_get_plan` on 2.5–5 when the driver exposes the internal prepare path; `EXPLAIN ANALYZE` is never offered. Query timeout is a real server-side cancel (`op_cancel`, Firebird 2.5+) rather than an abandoned client promise. Table and column comments are included in the AI schema context as untrusted data.

See [ROADMAP.md](./ROADMAP.md) for the open workstreams, [docs/multi-db-matrix.md](./docs/multi-db-matrix.md) for the per-engine capability matrix, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the adapter contract and checks.

## Data for debugging

The AI panel's **Data** control attaches database evidence to one request, never automatically:

- **Column profile** sends row counts, null counts, distinct counts, min/max and the top five values as truncated hashes. Columns whose names look like PII are redacted.
- **Sample rows** sends at most 25 rows from one table, inside a database read-only transaction. PII-named columns become `[redacted]` and PII-shaped values are masked before the payload is stored.
- Both modes return the exact masked block for review, wrapped in `<untrusted-data>`, and issue a single-use 60-second token. The token is consumed by the next chat request; a preview does not spend it.
- MongoDB and Redis are excluded because they have no SQL catalog or column types.

## AI

Profiles support:

- OpenAI
- Anthropic
- Ollama
- OpenRouter
- Custom OpenAI-compatible endpoints

Each profile controls the base URL, model, API key, context window, temperature, max output tokens, timeout, streaming, schema sharing and custom instructions. API keys and connection passwords are encrypted with Electron `safeStorage` (Windows DPAPI) and are never written as plaintext.

AI features:

- Chat with streaming and SQL blocks that can be inserted or executed.
- Schema-aware autocomplete in Monaco (tables, columns, keywords).
- AI inline SQL completion (toggleable in Settings → Safety) uses the schema of the currently connected database, resolved in the main process from the live connection; the renderer cannot supply or alter the schema text sent to the provider. The toggle is enforced in main, not only hidden in the UI.
- Schema context trimming and token budgeting.
- ER graph built from primary/foreign keys (collections/keys for MongoDB and Redis).
- Skills with automatic context selection.

## Interface

- **Connection wizard** inspired by DBeaver's multi-page connection dialog: Engine → General → Options → Review, with a step rail, engine summary, generated URL preview, test connection and a native save flow.
- **AI Providers master–detail screen**: profile cards, active profile, duplicate/delete/test actions, provider tiles with setup hints, grouped credentials, model/context presets, generation controls and custom instructions.
- **Chat**: markdown rendering, SQL code cards with Copy/Insert/Run, context chips, retry-friendly errors, streaming caret, jump-to-latest, prompt suggestions and a `/` skills picker with keyboard navigation.
- **Themes**: Dracula, Aura, Matrix, Neon, PyCharm, Tokyo Night, Nord, Catppuccin, Gruvbox, Rosé Pine, One Dark, Solarized Light, DBLion Dark and Light, all sharing the same token contract.
- **Typography**: bundled Inter Variable, Space Grotesk Variable and JetBrains Mono Variable (no remote font fetch).

## Query workspace

- Multiple query tabs with SQL persisted between sessions in the renderer.
- `Ctrl+Enter` runs the current selection, or the full editor when nothing is selected.
- Persistent query history (200 entries) with timestamp, connection, rows, duration and error; click an entry to restore its SQL.
- Results display the first 5,000 rows with a truncation warning; export saves CSV, JSON or SQL `INSERT` statements through a native save dialog.
- Schema explorer lists tables and views for the active connection, with filter, refresh and click-to-open.
- Table Browser opens a table with server-side pagination and filter, editable cells when the table has a primary key, a generated `UPDATE` preview, optimistic conflict check, and CSV/`INSERT` export for the visible page.
- Row edits require the write toggle, a non-read AI mode, and a native confirmation bound to the row identity and changed values. Tables without a primary key and views are read-only.
- Explain opens a local database plan tree with cost, rows, warnings and optional `ANALYZE`; `ANALYZE` executes the SELECT and requires its own native confirmation. No AI is involved.
- CSV import picks a local file, previews the mapped columns, coerces supported types, and applies every row in one transaction. Limits are 5 MB / 5,000 rows; the token binds to the file hash, mapping, delimiter and null settings.
- Sessions lists PostgreSQL/MySQL/SQL Server sessions. Cancelling a query or terminating a session requires `full` mode and a dedicated confirmation token; raw `KILL`/`pg_terminate_backend` SQL is blocked.

## Skills

DBLion discovers `SKILL.md` files recursively from:

- `~/.agents/skills`
- `~/.agents/.skills`
- `~/.commandcode/skills`
- `~/.claude/skills`
- `~/.config/opencode/skills`
- `~/.opencode/skills`
- project `.agents/skills` and `.claude/skills`

Selected skills are injected into the system prompt. With auto-select enabled, the last user message is matched against skill names and descriptions and the best matches are added automatically. Skill reads are restricted to the discovered roots.

## Schema catalog, DDL, diff and migrations

- The schema explorer exposes tables, views, materialized views, functions, procedures, triggers and indexes for PostgreSQL, MySQL, SQLite, SQL Server and Firebird (Firebird also lists generators and domains).
- Clicking an object loads its DDL. Tables with reconstructed DDL (SQL Server and Firebird) are marked with review warnings.
- **Diff** compares two connected schemas of the same database kind, shows added/removed/changed objects and generates a review-only migration. Table changes are intentionally not converted into destructive ALTERs automatically.
- Migrations are stored as versioned `.sql` files under `%APPDATA%\dblion\migrations` and listed in the Schema tools modal. Saving a migration never executes it.
- Catalog inspection is bounded to 1,000 objects and diff to 150 objects per side; the UI reports truncation.

## Security model

- Global **read-only** is on by default.
- A connection profile's access mode is applied when the session opens. Changing it closes the live connection (and audits the change), so a profile switched to read-only never keeps a writable session alive.
- The toolbar **Allow writes** toggle is required for any write.
- AI modes:
  - `read`: every write is blocked.
  - `edit`: DML allowed with confirmation; DDL blocked.
  - `full`: DDL allowed, always with a native confirmation.
- Every SQL write asks for an OS-native confirmation and receives a short-lived, single-use token bound to the connection and exact SQL.
- Row updates, CSV imports, `EXPLAIN ANALYZE` and session kills use dedicated token kinds; their details bind table/row identity, file hash, SQL or session/mode. Session kill is never accepted through free SQL.
- Renderer isolation: `sandbox: true`, `contextIsolation`, no `nodeIntegration`, CSP, navigation blocked, permission requests denied.
- The window may only navigate to its own document (including redirects). External links open in the OS browser only for `http:`, `https:` and `mailto:`; `file:` and custom schemes are denied, so a local document cannot inherit the preload bridge.
- `state:get` returns a public projection: passwords, API keys, SSH passwords and private keys never cross into the renderer. Existing secrets are preserved on profile/connection patches and can be replaced explicitly.
- Secrets are stored with OS encryption; plaintext fallback is disabled.
- Redis commands are classified: reads bypass the write switch, writes require `edit` plus confirmation, and destructive commands (`FLUSHALL`, `FLUSHDB`, `CONFIG`, `SCRIPT`, `EVAL`, etc.) require `full`.
- TLS verifies server certificates (`rejectUnauthorized: true`) and supports a CA plus client certificate/key. SSH tunnels forward TCP through a bastion and keep SSH secrets out of state.
- Read queries can be limited server-side and receive a statement/query timeout. PostgreSQL, MySQL, SQL Server and Firebird support cancellation; PostgreSQL, MySQL and SQLite support explicit begin/commit/rollback.
- `EXPLAIN ANALYZE` runs inside a PostgreSQL `READ ONLY` transaction or MySQL `START TRANSACTION READ ONLY` and is blocked inside an existing transaction. Side-effect functions such as `pg_sleep`, `nextval`, `setval`, `dblink` and `load_file` are denied by the classifier. Database grants remain the final boundary; use a least-privilege database user.
- AI calls run in the main process, never in the renderer. Schema context is resolved in main; a renderer-supplied `schemaContext` is ignored, so the UI cannot spoof the model's view of the database.
- AI egress sends only authentication and protocol headers. No `HTTP-Referer`, `X-Title` or any other attribution/telemetry metadata is attached to provider requests.
- Schema metadata and skill files are untrusted input: the system prompt puts the security rules first, then wraps schema/skill text in `<untrusted-schema>` / `<untrusted-skill>` blocks and states that instructions found inside names, comments, defaults, skill files or tool output are data. Spoofed closing tags inside that text are neutralized.
- Large databases are not sent as an alphabetical prefix: main ranks table names against the user's request (with a small PT-BR synonym set) and describes only the matches. If column metadata still cannot be read, the warning reaches the UI and the model receives table names instead of nothing.
- AI never executes SQL and has no tool calling, MCP or shell access. Proposed SQL renders as a reviewable block; it runs only when a human clicks **Run manually** (AI panel) or Run (editor), through the same write-toggle, AI-mode and native-confirmation gates as typed SQL.
- SQL that originated from AI and classifies as a read runs inside a database-enforced read-only transaction (PostgreSQL `BEGIN TRANSACTION READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite `PRAGMA query_only`, Firebird `isc_tpb_read`), so a function or stored procedure with side effects cannot write even though the statement looks like a `SELECT`. If an explicit transaction is already open on PostgreSQL or MySQL, the run is refused instead of silently dropping the fence. SQL Server, MongoDB and Redis have no transaction-level read-only switch; there the classifier and guard remain the boundary.
- The AI panel's **Context** control asks main for `ai:context-preview`: the exact system prompt and conversation the provider would receive, whether schema/skills are included, their sizes, and whether PII masking applied. It never contains the API key.
- Optional per-profile **Mask emails, CPF/CNPJ, cards and phone numbers in context** redacts PII-shaped values from schema and skill context before sending. It is off by default (compatibility) and can also redact identifiers or defaults that merely look like PII, which may reduce SQL accuracy. Schema metadata still leaves the machine when "Send schema context" is enabled — masking reduces, but does not remove, that egress.
- AI safety regression suite: `node --import ./scripts/lib/ts-alias-register.mjs scripts/ai-safety.test.mjs`.

## Data location

Electron stores app data under `%APPDATA%\dblion`, with `dblion-state.json` and `dblion-secrets.json` (encrypted values).

## License

MIT. See [LICENSE](./LICENSE).
