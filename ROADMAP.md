# DBLion roadmap

[English README](./README.md) · [README em português](./README.pt-BR.md) · [Contributing](./CONTRIBUTING.md)

**Status: 0.1.0, pre-1.0.** DBLion is a guarded AI database IDE: the AI proposes, explains and diagnoses; a human reviews and runs. This roadmap separates what is already implemented from the work that still blocks a 1.0 release.

How to read it:

- `[x]` is implemented and covered by automated tests, not necessarily validated against a live server.
- `[ ]` is open. Each P0 item has an acceptance criterion.
- “Live validation” means a real server of that engine, with the exact version recorded.

## P0 — release gates

These items block 1.0. They are ordered by risk.

### 1. Validate every engine against a live server

| Engine | Target versions | Required checks | Status |
| --- | --- | --- | --- |
| Firebird | 2.5, 3, 4, 5, 6 | connect, read-only refusal, query, timeout/cancel, estimated plan, catalog, DDL, diff, table paging | Pending |
| PostgreSQL | Current supported majors (14+) | read-only session, AI read fence, plan/`ANALYZE`, catalog/DDL, sessions, CSV import | Pending live |
| MySQL / MariaDB | MySQL 8+, MariaDB 10.6+ | read-only session, AI read fence, plan/`ANALYZE`, catalog/DDL, sessions, CSV import | Pending live |
| SQL Server | 2019+ | read-only intent, estimated plan, catalog/DDL, sessions, row-edit caveat | Pending live |
| SQLite | Bundled `sql.js` | read-only `PRAGMA query_only`, plan, catalog/DDL, row edit, CSV import | Covered by the in-process suite |
| MongoDB | — | document/collection browsing, app guard | Not SQL parity |
| Redis | — | command classification, app guard | Not SQL parity |

Acceptance: exact server versions and command output are recorded in the release notes or an issue; every failure is fixed or explicitly documented; no skipped check is counted as a pass.

### 2. CI integration matrix

- [ ] PostgreSQL, MySQL and SQL Server service containers run the live read-only suite on pull requests.
- [ ] Firebird runs in a manual or nightly job with a matrix of supported versions.
- [ ] The job uploads the exact versions and test output.

Acceptance: a pull request that breaks a live read-only fence fails CI, and the job does not depend on a developer machine.

### 3. Shared adapter contract test

- [ ] One fixture schema per SQL engine.
- [ ] The contract checks `listTables`, `describeTable`, `buildContext`, `catalog`, `ddl` and the read-only refusal.
- [ ] Engines that do not expose a capability report it as unsupported instead of returning a plausible empty result.

Acceptance: adding a new SQL adapter requires only the adapter, its capability entry and the fixture; the shared contract runs unchanged.

### 4. Packaged-app smoke test

- [ ] Install, launch, connect to a read-only profile and run a SELECT.
- [ ] Open the plan, schema tools, table browser and AI Context preview.
- [ ] Prepare a column profile and a masked row sample; confirm the token and the egress preview.
- [ ] Trigger a write refusal, then a confirmed write on a disposable database.
- [ ] Disconnect, reopen and verify that no writable session survives an access-mode change.

Acceptance: the checklist is performed on the installer, not only in `npm run dev`, and the result is attached to the release.

### 5. Security regression gate

- [ ] Typecheck, safety, renderer boundary, read-only, AI safety, Firebird, catalog, queue, data and multi-db suites are green.
- [ ] No new dependency is promoted without reviewing its license and runtime footprint.
- [ ] No secrets, local state, database dumps or machine paths are present in the repository.

Acceptance: the same commands in [CONTRIBUTING.md](./CONTRIBUTING.md) pass on a clean checkout.

## Shipped in 0.1.0

Implemented and covered by automated tests:

- [x] Read-only connection profiles, database-enforced read-only reads for AI, SQL classification and native confirmation tokens.
- [x] AI never executes SQL; no tool calling, MCP or shell access; renderer isolation and main-process authority over schema and secrets.
- [x] Context preview, PII masking, untrusted schema/skill/data blocks and delimiter neutralization.
- [x] Firebird serial queue per connection; timeout/cancel through `AbortSignal`/`op_cancel`; driver pinned for the Firebird <6 plan path.
- [x] Firebird estimated plan (native `EXPLAIN` on 6+, `isc_info_sql_get_plan` on 2.5–5), catalog, DDL, diff, migrations, comments and `FIRST/SKIP` table paging.
- [x] Per-connection schema index (TTL + LRU), ranking by table name, column name and comment, and user-pinned tables.
- [x] Aggregate column profiling and masked row sampling with a single-use 60-second token and exact egress preview.
- [x] Multi-engine adapters for PostgreSQL, MySQL/MariaDB, SQL Server, Firebird, SQLite, MongoDB and Redis.
- [x] SQL Server estimated plan through `SHOWPLAN_TEXT` on a transaction-pinned connection.
- [x] Table comments for PostgreSQL, MySQL, SQL Server and Firebird; column names available to the AI ranking for every SQL engine.
- [x] MIT license, README in English and Portuguese, contributing/security docs, capability matrix and unit-test CI.
- [x] Windows x64 installer with the project icon.

## P1 — Firebird administration

Firebird is usable for queries, catalog and review today. These items close the administrative gap.

- [ ] **Adapter transactions**: implement `begin`/`commit`/`rollback` and advertise `transactions`.
  - Acceptance: a live write test commits and a forced failure rolls back; the capability is no longer false.
- [ ] **Row editing**: enable `editRows` only after transactions exist; keep the primary-key and preview/confirmation rules.
  - Acceptance: a live edit is atomic with its conflict check.
- [ ] **CSV import**: enable `importCsv` after transactions exist, keeping the 5 MB / 5,000 row limits and content-hash token.
  - Acceptance: a live import is all-or-nothing.
- [ ] **Function DDL**: reconstruct functions from `RDB$FUNCTIONS` and `RDB$FUNCTION_ARGUMENTS`; a function must not appear in the catalog if its DDL always throws.
  - Acceptance: every listed object opens a DDL view or carries a documented warning.
- [ ] **Routine signatures**: add procedure/function parameters and view columns to the catalog payload so the AI can reason about calls without one `ddl` request per object.
  - Acceptance: one catalog call answers “what does this procedure take?”.
- [ ] **Optional sessions**: read `MON$ATTACHMENTS`/`MON$STATEMENTS` when the role can see them.
  - Acceptance: read-only users see an empty or explained state, never a fabricated session list.

## P2 — Multi-database parity

- [ ] **SQL Server transactions**: implement `begin`/`commit`/`rollback`; then enable atomic CSV import and make row edits atomic with their read.
  - Acceptance: live rollback tests pass and the capability flags match behavior.
- [ ] **SQLite comments**: there is no native comment source. Document the absence instead of inventing one.
- [ ] **MongoDB and Redis scope**: keep them explicitly outside the SQL catalog/DDL/plan model and document what the AI can and cannot see.
- [ ] **`snapshot` capability**: remove the dead flag or implement it against a real use case. Do not leave a capability that is always false.
- [ ] **Per-engine integration docs**: one short page per engine with connection examples, required grants and known limits.

## P3 — Distribution and project operations

- [ ] **Code signing** for the Windows installer and application binaries.
- [ ] **Auto-update**: decide whether to ship it, the update channel and the signing/verification requirements.
- [ ] **macOS and Linux packaging**, with at least a smoke test on each target.
- [ ] **Release automation**: reproducible build command, artifact hashes, SBOM and license inventory.
- [ ] **Issue and pull-request templates** that ask for engine, version, reproduction and redacted logs.
- [ ] **Dependency policy**: review runtime dependencies, licenses and the Electron fuse configuration before 1.0.

## P4 — AI depth (optional, after P0/P1)

These are product improvements, not release gates. They must preserve the rule that the AI never executes and that every suggestion is reviewable.

- [ ] Routine-aware suggestions once the catalog carries signatures (`EXECUTE PROCEDURE`, parameter types, view columns).
- [ ] Index suggestions grounded in estimated plans and query history, always presented as reviewable SQL.
- [ ] Query-history analysis that stays local and never becomes telemetry.
- [ ] A persisted per-table allowlist for data sampling, on top of the current per-request approval.
- [ ] More engine-specific plan normalization and warnings, with tests per dialect.

## Not planned

- Embeddings or vector search over schema or data.
- AI tool calling, MCP or autonomous agents inside DBLion.
- AI-initiated execution of SQL, migrations or shell commands.
- Automatically applying migrations or destructive schema changes.
- Cross-connection joins.
- A plugin marketplace.
- Telemetry or usage analytics.
- Replacing database grants or a least-privilege database user.

## Definition of done for 1.0

DBLion can be called 1.0 when:

1. Every P0 item is complete and its acceptance evidence is linked from the release.
2. Firebird administration (transactions, row edit, CSV, function DDL and routine signatures) is complete or explicitly deferred with a documented product decision.
3. SQL Server has atomic write paths or a documented decision to keep them out of scope.
4. The README, capability matrix, security model and contributing guide match the shipped behavior.
5. A clean checkout can reproduce the installer and its hash.
6. There is no known P0/P1 security issue and every safety suite passes.

## How to pick work

Start with P0. For anything in P1–P4, open an issue describing the engine, the user problem and the acceptance check before sending a large pull request. Small, independently verifiable changes are easier to review and safer for a database tool.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for commands, invariants and the release checklist.
