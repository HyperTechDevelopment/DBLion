import { createHash } from 'node:crypto'
import type {
  ConnectionConfig,
  CsvImportPreview,
  CsvImportRequest,
  DbCapabilities,
  DbKind,
  ExplainResult,
  KillSessionRequest,
  QueryResult,
  SchemaCatalog,
  SchemaDdl,
  SchemaDiffResult,
  SchemaDiffRow,
  SchemaGraph,
  SchemaObjectRef,
  SchemaPayload,
  SessionInfo,
  TableDetails,
  TablePage,
  TablePageRequest,
  TableInfo,
  TestResult,
  MutationPreview,
  RowUpdateRequest
} from '@shared/types'
import type { DbAdapter, QueryOptions } from './types'
import { classifySql, getExplainBlockReason } from '@shared/sql'
import { isReadOnlyAccess } from '@shared/access'
import { assertQueryAllowed, assertWritePathAllowed } from './guard'
import { normalizePlan } from './explain'
import { openTunnel, type Tunnel } from './tunnel'
import {
  buildCsvInsertSql,
  buildRowUpdateSql,
  buildTablePageSql,
  csvContentHash,
  importCsvDetail,
  quoteIdent,
  rowUpdateDetail,
  sessionKillDetail
} from './sqlBuilder'
import { coerceCsvRows, parseCsvText } from './csvImport'

const runtimes = new Map<
  string,
  { config: ConnectionConfig; adapter: DbAdapter; tunnel: Tunnel }
>()

const NONE: DbCapabilities = {
  cancelQuery: false,
  transactions: false,
  tableBrowser: false,
  editRows: false,
  importCsv: false,
  explain: false,
  explainAnalyze: false,
  sessions: false,
  killSession: false,
  schemaCatalog: false,
  ddl: false,
  snapshot: false,
  diff: false,
  migrations: false
}

export function capabilitiesFor(kind: DbKind): DbCapabilities {
  switch (kind) {
    case 'postgres':
      return { ...NONE, cancelQuery: true, transactions: true, tableBrowser: true, editRows: true, importCsv: true, sessions: true, killSession: true, explain: true, explainAnalyze: true, schemaCatalog: true, ddl: true, diff: true, migrations: true }
    case 'mysql':
      return { ...NONE, cancelQuery: true, transactions: true, tableBrowser: true, editRows: true, importCsv: true, sessions: true, killSession: true, explain: true, explainAnalyze: true, schemaCatalog: true, ddl: true, diff: true, migrations: true }
    case 'sqlite':
      // SQLite só tem EXPLAIN QUERY PLAN (estimativa, sem execução): sem ANALYZE.
      return { ...NONE, transactions: true, tableBrowser: true, editRows: true, importCsv: true, explain: true, schemaCatalog: true, ddl: true, diff: true, migrations: true }
    case 'mssql':
      // No atomic bulk path on this adapter (no begin/commit/rollback), so the
      // main process refuses CSV import instead of risking a partial load.
      // EXPLAIN uses SET SHOWPLAN_TEXT on a transaction-pinned connection;
      // ANALYZE would execute the statement, so it is never offered.
      return { ...NONE, cancelQuery: true, tableBrowser: true, editRows: true, sessions: true, killSession: true, explain: true, schemaCatalog: true, ddl: true, diff: true, migrations: true }
    case 'firebird':
      // op_cancel needs Firebird 2.5+; EXPLAIN is native on 6+ and read through
      // isc_info_sql_get_plan on older versions when the driver exposes it.
      // Catalog/DDL come from RDB$; diff compares reconstructed DDL, so treat
      // its ALTER output as review material. Table paging uses FIRST/SKIP.
      return {
        ...NONE,
        cancelQuery: true,
        tableBrowser: true,
        explain: true,
        schemaCatalog: true,
        ddl: true,
        diff: true,
        migrations: true
      }
    default:
      return { ...NONE }
  }
}

function requireCapability(
  kind: DbKind,
  flag:
    | 'tableBrowser'
    | 'editRows'
    | 'importCsv'
    | 'sessions'
    | 'killSession'
    | 'explain'
    | 'explainAnalyze'
    | 'schemaCatalog'
    | 'ddl'
    | 'diff'
    | 'migrations'
): void {
  if (!capabilitiesFor(kind)[flag]) {
    throw new Error(
      flag === 'tableBrowser'
        ? `The table browser is not supported for ${kind} connections.`
        : flag === 'editRows'
          ? `Row editing is not supported for ${kind} connections.`
          : flag === 'importCsv'
            ? `CSV import is not supported for ${kind} connections.`
            : flag === 'sessions'
              ? `Session listing is not supported for ${kind} connections.`
              : flag === 'explain'
                ? `Explain is not supported for ${kind} connections.`
                : flag === 'explainAnalyze'
                  ? `EXPLAIN ANALYZE is not supported for ${kind} connections.`
                  : flag === 'schemaCatalog'
                    ? `Schema catalog is not supported for ${kind} connections.`
                    : flag === 'ddl'
                      ? `DDL inspection is not supported for ${kind} connections.`
                      : flag === 'diff'
                        ? `Schema diff is not supported for ${kind} connections.`
                        : flag === 'migrations'
                          ? `Migrations are not supported for ${kind} connections.`
                          : `Session kill is not supported for ${kind} connections.`
    )
  }
}

async function createAdapter(kind: DbKind): Promise<DbAdapter> {
  switch (kind) {
    case 'postgres': {
      const { PostgresAdapter } = await import('./postgres')
      return new PostgresAdapter()
    }
    case 'mysql': {
      const { MysqlAdapter } = await import('./mysql')
      return new MysqlAdapter()
    }
    case 'mssql': {
      const { MssqlAdapter } = await import('./mssql')
      return new MssqlAdapter()
    }
    case 'firebird': {
      const { FirebirdAdapter } = await import('./firebird')
      return new FirebirdAdapter()
    }
    case 'sqlite': {
      const { SqliteAdapter } = await import('./sqlite')
      return new SqliteAdapter()
    }
    case 'mongodb': {
      const { MongoAdapter } = await import('./mongodb')
      return new MongoAdapter()
    }
    case 'redis': {
      const { RedisAdapter } = await import('./redis')
      return new RedisAdapter()
    }
    default:
      throw new Error(`Unsupported database kind: ${kind}`)
  }
}

export async function testConnection(config: ConnectionConfig): Promise<TestResult> {
  const adapter = await createAdapter(config.kind)
  let tunnel: Tunnel | null = null
  try {
    tunnel = await openTunnel(config)
    await adapter.connect(tunnel.config)
    const serverVersion = await adapter.serverVersion()
    return { ok: true, message: `Connected: ${serverVersion}`, serverVersion }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await adapter.disconnect().catch(() => undefined)
    await tunnel?.close().catch(() => undefined)
  }
}

export async function connect(config: ConnectionConfig): Promise<TestResult> {
  await disconnect(config.id)
  const adapter = await createAdapter(config.kind)
  const tunnel = await openTunnel(config)
  try {
    await adapter.connect(tunnel.config)
    const serverVersion = await adapter.serverVersion()
    runtimes.set(config.id, { config, adapter, tunnel })
    return { ok: true, message: `Connected: ${serverVersion}`, serverVersion }
  } catch (error) {
    await adapter.disconnect().catch(() => undefined)
    await tunnel.close().catch(() => undefined)
    throw error
  }
}

export async function disconnect(id: string): Promise<void> {
  const runtime = runtimes.get(id)
  if (!runtime) return
  runtimes.delete(id)
  await runtime.adapter.disconnect().catch(() => undefined)
  await runtime.tunnel.close().catch(() => undefined)
}

export async function disconnectAll(): Promise<void> {
  const ids = [...runtimes.keys()]
  await Promise.all(ids.map((id) => disconnect(id)))
}

export function getRuntime(id: string): { config: ConnectionConfig; adapter: DbAdapter } {
  const runtime = runtimes.get(id)
  if (!runtime) throw new Error('Connection is not active. Connect first.')
  return runtime
}

export async function query(
  id: string,
  sql: string,
  params: unknown[] = [],
  allowWrites = false,
  options: QueryOptions = {}
): Promise<QueryResult> {
  const runtime = getRuntime(id)
  // Read-only connections accept only classifier `read` statements, whatever
  // the renderer sent (write toggle, token, AI mode). Adapters repeat the check.
  assertQueryAllowed(runtime.config, sql)
  return runtime.adapter.query(sql, params, allowWrites, options)
}

export async function cancelQuery(id: string): Promise<void> {
  const adapter = getRuntime(id).adapter
  if (!adapter.cancel) throw new Error('This adapter does not support query cancellation.')
  await adapter.cancel()
}

export async function transaction(
  id: string,
  action: 'begin' | 'commit' | 'rollback'
): Promise<void> {
  const adapter = getRuntime(id).adapter
  const method = adapter[action]
  if (!method) throw new Error(`This adapter does not support ${action}.`)
  await method.call(adapter)
}

export async function buildSchemaContext(
  id: string,
  tables: TableInfo[]
): Promise<{ context: string; warning?: string }> {
  const adapter = getRuntime(id).adapter
  try {
    return { context: await adapter.buildContext(tables) }
  } catch (error) {
    // Table names are still useful, and a silent drop made the model claim it
    // had no schema at all. Send the names and report the failure to the UI.
    const message = error instanceof Error ? error.message : String(error)
    const shown = tables.slice(0, 200)
    return {
      warning: `Columns could not be read (${message}). The AI received ${shown.length} of ${tables.length} table names.`,
      context: `Tables (columns unavailable, showing ${shown.length} of ${tables.length}):\n${shown
        .map((table) => table.name)
        .join(', ')}`.slice(0, 12_000)
    }
  }
}

export async function schema(
  id: string,
  options: { context?: boolean } = {}
): Promise<SchemaPayload> {
  const adapter = getRuntime(id).adapter
  // Sequential: one metadata read at a time on the same connection keeps
  // drivers that dislike overlapping statements predictable.
  const tables = await adapter.listTables()
  if (options.context === false) {
    return { tables, context: '' }
  }
  const { context, warning } = await buildSchemaContext(id, tables)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ tables, context }))
    .digest('hex')
    .slice(0, 12)
  return { tables, context, fingerprint, warning }
}

export async function describe(
  id: string,
  schemaName: string | undefined,
  table: string
): Promise<TableDetails> {
  return getRuntime(id).adapter.describeTable(schemaName, table)
}

export async function tablePage(request: TablePageRequest): Promise<TablePage> {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'tableBrowser')
  const details = await runtime.adapter.describeTable(request.schema, request.table)
  const limit = Math.min(500, Math.max(1, Math.floor(request.limit)))
  const offset = Math.max(0, Math.floor(request.offset))
  const { sql, params } = buildTablePageSql(runtime.config.kind, details, {
    ...request,
    limit,
    offset
  })
  const result = await runtime.adapter.query(sql, params, false, {
    maxRows: limit,
    timeoutMs: 30000
  })
  const view = request.tableType?.toLowerCase().includes('view') ?? false
  return {
    columns: details.columns,
    primaryKey: details.primaryKey,
    rows: result.rows,
    offset,
    limit,
    // A read-only connection never advertises row editing.
    editable:
      details.primaryKey.length > 0 && !view && !isReadOnlyAccess(runtime.config),
    source: {
      schema: details.schema ?? request.schema,
      table: details.table,
      primaryKey: details.primaryKey
    }
  }
}

export async function previewRowUpdate(request: RowUpdateRequest): Promise<MutationPreview> {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'editRows')
  assertWritePathAllowed(runtime.config, 'Row update preview')
  const details = await runtime.adapter.describeTable(request.schema, request.table)
  const { sql, params, warnings } = buildRowUpdateSql(runtime.config.kind, details, request)
  return {
    sql,
    params,
    warnings,
    destructive: false,
    confirmationDetail: rowUpdateDetail(request)
  }
}

export async function applyRowUpdate(
  request: RowUpdateRequest
): Promise<{ rowCount: number }> {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'editRows')
  assertWritePathAllowed(runtime.config, 'Row updates')
  const details = await runtime.adapter.describeTable(request.schema, request.table)
  const { sql, params } = buildRowUpdateSql(runtime.config.kind, details, request)
  const adapter = runtime.adapter
  const canTransact =
    typeof adapter.begin === 'function' &&
    typeof adapter.commit === 'function' &&
    typeof adapter.rollback === 'function'
  if (canTransact) await adapter.begin!()
  try {
    const result = await adapter.query(sql, params, true, { timeoutMs: 30000 })
    if (result.rowCount !== 1) {
      throw new Error(
        'This row changed since it was loaded. Refresh the table and try again.'
      )
    }
    if (canTransact) await adapter.commit!()
    return { rowCount: result.rowCount }
  } catch (error) {
    if (canTransact) await adapter.rollback!().catch(() => undefined)
    throw error
  }
}

export async function graph(id: string, schemaName?: string): Promise<SchemaGraph> {
  return getRuntime(id).adapter.graph(schemaName)
}

export async function catalog(connectionId: string, schemaName?: string): Promise<SchemaCatalog> {
  const runtime = getRuntime(connectionId)
  requireCapability(runtime.config.kind, 'schemaCatalog')
  if (!runtime.adapter.catalog) {
    throw new Error(`Schema catalog is not supported for ${runtime.config.kind} connections.`)
  }
  return runtime.adapter.catalog(schemaName)
}

export async function objectDdl(
  connectionId: string,
  object: SchemaObjectRef
): Promise<SchemaDdl> {
  const runtime = getRuntime(connectionId)
  requireCapability(runtime.config.kind, 'ddl')
  if (!runtime.adapter.ddl) {
    throw new Error(`DDL inspection is not supported for ${runtime.config.kind} connections.`)
  }
  return runtime.adapter.ddl(object)
}

function normalizeDdl(sql: string): string {
  return sql
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

function qualifiedName(kind: DbKind, schemaName: string | undefined, name: string): string {
  return kind === 'sqlite' || !schemaName
    ? quoteIdent(kind, name)
    : `${quoteIdent(kind, schemaName)}.${quoteIdent(kind, name)}`
}

function dropStatement(kind: DbKind, object: SchemaObjectRef): string {
  const qualified = qualifiedName(kind, object.schema, object.name)
  if (object.type === 'table') return `DROP TABLE ${qualified};`
  if (object.type === 'view') return `DROP VIEW ${qualified};`
  if (object.type === 'materialized_view') return `DROP MATERIALIZED VIEW ${qualified};`
  if (object.type === 'procedure') return `DROP PROCEDURE ${qualified};`
  if (object.type === 'function') {
    const args = object.parent ? `(${object.parent})` : ''
    return `DROP FUNCTION ${qualified}${args};`
  }
  if (object.type === 'trigger') {
    return kind === 'postgres' && object.parent
      ? `DROP TRIGGER ${quoteIdent(kind, object.name)} ON ${qualifiedName(kind, object.schema, object.parent)};`
      : `DROP TRIGGER ${qualified};`
  }
  if (object.type === 'index') {
    return (kind === 'mysql' || kind === 'mssql') && object.parent
      ? `DROP INDEX ${quoteIdent(kind, object.name)} ON ${qualifiedName(kind, object.schema, object.parent)};`
      : `DROP INDEX ${qualified};`
  }
  return `-- No drop template for ${object.type} ${qualified}`
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return output
}

export async function diffSchemas(
  leftConnectionId: string,
  rightConnectionId: string,
  schemaName?: string
): Promise<SchemaDiffResult> {
  if (leftConnectionId === rightConnectionId) {
    throw new Error('Choose two different connections for a schema diff.')
  }
  const left = getRuntime(leftConnectionId)
  const right = getRuntime(rightConnectionId)
  if (left.config.kind !== right.config.kind) {
    throw new Error('Schema diff requires connections of the same database kind.')
  }
  requireCapability(left.config.kind, 'diff')
  requireCapability(left.config.kind, 'ddl')
  if (!left.adapter.catalog || !right.adapter.catalog) {
    throw new Error('Schema diff is not supported for these connections.')
  }
  const [leftCatalog, rightCatalog] = await Promise.all([
    left.adapter.catalog(schemaName),
    right.adapter.catalog(schemaName)
  ])
  const maxObjects = 150
  const leftObjects = leftCatalog.objects.slice(0, maxObjects)
  const rightObjects = rightCatalog.objects.slice(0, maxObjects)
  const keyOf = (object: SchemaObjectRef): string =>
    `${object.type}|${object.schema ?? ''}|${object.name}|${object.parent ?? ''}`
  const leftByKey = new Map(leftObjects.map((object) => [keyOf(object), object]))
  const rightByKey = new Map(rightObjects.map((object) => [keyOf(object), object]))
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])]

  const ddlFor = async (
    adapter: DbAdapter,
    object: SchemaObjectRef
  ): Promise<string | undefined> => {
    if (!adapter.ddl) return undefined
    try {
      return (await adapter.ddl(object)).sql
    } catch (error) {
      return `-- DDL unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const rows: SchemaDiffRow[] = []
  let destructive = false
  for (const key of keys) {
    const leftObject = leftByKey.get(key)
    const rightObject = rightByKey.get(key)
    const object = rightObject ?? leftObject
    if (!object) continue
    if (!leftObject) {
      const rightSql = await ddlFor(right.adapter, object)
      rows.push({
        key,
        schema: object.schema,
        name: object.name,
        type: object.type,
        status: 'added',
        rightSql,
        note: 'Object exists only on the right side.'
      })
      continue
    }
    if (!rightObject) {
      const leftSql = await ddlFor(left.adapter, object)
      rows.push({
        key,
        schema: object.schema,
        name: object.name,
        type: object.type,
        status: 'removed',
        leftSql,
        note: 'Object exists only on the left side.'
      })
      if (object.type === 'table') destructive = true
      continue
    }
    const [leftSql, rightSql] = await Promise.all([
      ddlFor(left.adapter, leftObject),
      ddlFor(right.adapter, rightObject)
    ])
    if (normalizeDdl(leftSql ?? '') !== normalizeDdl(rightSql ?? '')) {
      rows.push({
        key,
        schema: object.schema,
        name: object.name,
        type: object.type,
        status: 'changed',
        leftSql,
        rightSql,
        note:
          object.type === 'table'
            ? 'Table changes need a reviewed ALTER migration.'
            : 'Review the right-side DDL before applying.'
      })
      if (object.type === 'table') destructive = true
    }
  }

  const lines: string[] = [
    `-- DBLion schema migration`,
    `-- Left:  ${left.config.name}`,
    `-- Right: ${right.config.name}`,
    `-- Created: ${new Date().toISOString()}`,
    ''
  ]
  for (const row of rows) {
    const label = `${row.schema ? `${row.schema}.` : ''}${row.name}`
    if (row.status === 'added' && row.rightSql) {
      lines.push(`-- Added ${row.type}: ${label}`, row.rightSql, '')
    } else if (row.status === 'removed') {
      lines.push(
        `-- Removed ${row.type}: ${label}`,
        dropStatement(left.config.kind, {
          schema: row.schema,
          name: row.name,
          type: row.type,
          parent: leftByKey.get(row.key)?.parent
        }),
        ''
      )
    } else if (row.status === 'changed') {
      lines.push(`-- Changed ${row.type}: ${label}`, `-- ${row.note ?? 'Review manually.'}`)
      if (row.rightSql && ['view', 'materialized_view', 'function', 'procedure'].includes(row.type)) {
        lines.push(row.rightSql)
      } else {
        lines.push(
          '-- Right-side DDL (commented; review and convert to ALTER):',
          ...(row.rightSql ?? '-- unavailable').split('\n').map((line) => `-- ${line}`)
        )
      }
      lines.push('')
    }
  }
  if (rows.length === 0) lines.push('-- No schema differences found.')

  return {
    leftLabel: left.config.name,
    rightLabel: right.config.name,
    dialect: left.config.kind,
    schema: schemaName,
    rows,
    migrationSql: lines.join('\n'),
    destructive,
    truncated: leftCatalog.truncated || rightCatalog.truncated
      || leftCatalog.objects.length > maxObjects
      || rightCatalog.objects.length > maxObjects
  }
}

export async function explain(
  connectionId: string,
  sql: string,
  analyze = false,
  options: QueryOptions = {}
): Promise<ExplainResult> {
  const runtime = getRuntime(connectionId)
  const kind = runtime.config.kind
  requireCapability(kind, 'explain')
  if (analyze) requireCapability(kind, 'explainAnalyze')
  if (!runtime.adapter.explain) {
    throw new Error(`Explain is not supported for ${kind} connections.`)
  }
  // Gate 1: só SELECT/WITH puros (bloqueia DML, SELECT INTO, row locks e
  // terminate/cancel/kill). Defense-in-depth além do classifySql.
  const blocked = getExplainBlockReason(sql)
  if (blocked) throw new Error(`Explain rejected: ${blocked}`)
  if (classifySql(sql) !== 'read') {
    throw new Error('Explain rejected: only read-only SELECT/WITH queries are allowed.')
  }
  // Read-only connections: EXPLAIN (estimated) and EXPLAIN ANALYZE are reads.
  // ANALYZE runs inside the adapter's READ ONLY transaction (see each adapter),
  // so it can never write even through a volatile function.
  assertQueryAllowed(runtime.config, sql)
  return normalizePlan(
    kind,
    await runtime.adapter.explain(sql, analyze, { timeoutMs: options.timeoutMs }),
    analyze
  )
}

export async function previewCsvImport(request: CsvImportRequest): Promise<CsvImportPreview> {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'importCsv')
  assertWritePathAllowed(runtime.config, 'CSV import')
  const details = await runtime.adapter.describeTable(request.schema, request.table)
  const parsed = parseCsvText(request)
  const { targetColumns, values, warnings } = coerceCsvRows(
    runtime.config.kind,
    details,
    request,
    parsed
  )
  const { sql } = buildCsvInsertSql(runtime.config.kind, details, targetColumns)
  const allWarnings = [...warnings]
  if (details.primaryKey.length === 0) {
    allWarnings.unshift(
      'Target table has no primary key: preview only, apply requires allowWrites and AI mode “full”.'
    )
  }
  return {
    sql,
    paramsPreview: values[0] ?? [],
    columns: targetColumns,
    rowCount: values.length,
    contentHash: csvContentHash(
      request.csvText,
      request.mapping,
      request.schema,
      request.table,
      request
    ),
    warnings: allWarnings,
    destructive: false,
    confirmationDetail: importCsvDetail(request)
  }
}

export async function applyCsvImport(
  request: CsvImportRequest,
  options: QueryOptions = {}
): Promise<{ rowCount: number }> {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'importCsv')
  assertWritePathAllowed(runtime.config, 'CSV import')
  const details = await runtime.adapter.describeTable(request.schema, request.table)
  const parsed = parseCsvText(request)
  const { targetColumns, values } = coerceCsvRows(runtime.config.kind, details, request, parsed)
  const { sql } = buildCsvInsertSql(runtime.config.kind, details, targetColumns)
  const adapter = runtime.adapter
  const canTransact =
    typeof adapter.begin === 'function' &&
    typeof adapter.commit === 'function' &&
    typeof adapter.rollback === 'function'
  if (!canTransact) {
    throw new Error('CSV import requires transaction support. This adapter cannot import atomically.')
  }
  await adapter.begin!()
  try {
    let total = 0
    for (const rowParams of values) {
      const result = await adapter.query(sql, rowParams, true, { timeoutMs: options.timeoutMs })
      total += result.rowCount ?? 1
    }
    await adapter.commit!()
    return { rowCount: total }
  } catch (error) {
    await adapter.rollback!().catch(() => undefined)
    throw error
  }
}

export function status(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const id of runtimes.keys()) result[id] = true
  return result
}

export async function listSessions(connectionId: string): Promise<SessionInfo[]> {
  const runtime = getRuntime(connectionId)
  requireCapability(runtime.config.kind, 'sessions')
  if (!runtime.adapter.listSessions) {
    throw new Error(`Session listing is not supported for ${runtime.config.kind} connections.`)
  }
  return runtime.adapter.listSessions()
}

export function previewKillSession(request: KillSessionRequest): {
  detail: string
  warnings: string[]
  destructive: boolean
} {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'killSession')
  assertWritePathAllowed(runtime.config, 'Session termination')
  if (!request.sessionId || String(request.sessionId).trim() === '') {
    throw new Error('A session id is required.')
  }
  const mode = request.mode ?? 'terminate'
  return {
    detail: sessionKillDetail({ ...request, mode }),
    warnings:
      mode === 'cancel'
        ? ['Cancelling aborts the running query but keeps the session connected.']
        : ['Terminating disconnects the session and rolls back its open transaction.'],
    destructive: true
  }
}

export async function killSession(request: KillSessionRequest): Promise<void> {
  const runtime = getRuntime(request.connectionId)
  requireCapability(runtime.config.kind, 'killSession')
  assertWritePathAllowed(runtime.config, 'Session termination')
  if (!runtime.adapter.killSession) {
    throw new Error(`Session kill is not supported for ${runtime.config.kind} connections.`)
  }
  await runtime.adapter.killSession(String(request.sessionId), request.mode ?? 'terminate')
}
