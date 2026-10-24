# DBLion roadmap

DBLion is a dedicated AI + database IDE. The AI proposes, explains and diagnoses; a human reviews and runs. These are the open workstreams, in shipping order.

## 1. Firebird parity

- [x] Query timeout and cancel through `AbortSignal`/`op_cancel` (Firebird 2.5+), serialized per connection.
- [x] Estimated plan: native `EXPLAIN` on 6+, `isc_info_sql_get_plan` on 2.5–5 when the driver exposes it.
- [x] Table/column comments in the schema context.
- [x] Catalog: tables, views, indexes, triggers, procedures, functions, generators, domains.
- [x] DDL for views/procedures/triggers (verbatim) and tables/indexes (reconstructed, review-only).
- [x] Diff, migrations and table paging (`FIRST/SKIP`).
- [ ] Row editing and CSV import (need adapter transactions).

## 2. Schema discovery

- [x] Prompt ranking by table name, column name, comments and PT-BR synonyms.
- [x] Per-connection schema index with TTL and invalidation.
- [x] Column-name matching against the index for every SQL engine.
- [x] User-pinned tables that always enter the AI context.

## 3. Safe data access

- [x] Aggregate column profiling (count, nulls, min/max, distinct, hashed top values), per request.
- [x] Raw row sampling only with a per-request single-use approval, PII masking and exact egress preview.
- [x] `<untrusted-data>` block, audit entries and a 60-second token.

## 4. Open source baseline

- [x] MIT license, contributing, security and multi-database docs.
- [x] CI: typecheck, unit/security suites and build on Linux and Windows.
- [ ] Integration matrix with real PostgreSQL, MySQL, SQL Server, MongoDB and Redis.
- [ ] Firebird integration job (manual/nightly).
- [ ] Adapter contract test shared by every engine.

## Not planned

Embeddings/vector search, AI tool calling or MCP, AI-initiated execution, auto-applied migrations, cross-connection joins, plugin marketplace, telemetry.
