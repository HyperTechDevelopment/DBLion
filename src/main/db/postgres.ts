import { Pool, type PoolClient } from 'pg'
import type {
  ConnectionConfig,
  ForeignKeyInfo,
  SchemaCatalog,
  SchemaDdl,
  SchemaGraph,
  SchemaObjectRef,
  SessionInfo,
  TableDetails,
  TableInfo
} from '@shared/types'
import type { ColumnRef, DbAdapter, ExplainRaw, QueryOptions } from './types'
import { isReadOnlyAccess } from '@shared/access'
import { quoteIdent } from './sqlBuilder'
import { buildExplainSql } from './explain'
import {
  clipContext,
  compactColumns,
  ensureWritable,
  limitedReadSql,
  makeResult,
  markTruncated
} from './common'

/** libpq startup option: every pooled connection starts read-only. */
export const READ_ONLY_STARTUP_OPTIONS = '-c default_transaction_read_only=on'

/**
 * Transaction-level fence for AI-originated reads. Even a session that is
 * otherwise writable rejects every write inside this transaction, including
 * one hidden inside a function called by a `SELECT`.
 */
export const AI_READ_ONLY_BEGIN_SQL = 'BEGIN TRANSACTION READ ONLY'

export class PostgresAdapter implements DbAdapter {
  readonly kind = 'postgres'
  private pool: Pool | null = null
  private config: ConnectionConfig | null = null
  private activeClient: PoolClient | null = null
  private transactionClient: PoolClient | null = null
  /** Mirrors ConnectionConfig.accessMode; guards every statement. */
  private readOnly = false

  private requirePool(): Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config
    this.readOnly = isReadOnlyAccess(config)
    this.pool = new Pool({
      host: config.host,
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl
        ? {
            rejectUnauthorized: true,
            ca: config.sslCa || undefined,
            cert: config.sslCert || undefined,
            key: config.sslKey || undefined
          }
        : undefined,
      connectionString: config.connectionString || undefined,
      // Read-only is decided by the server, in the startup packet, for every
      // connection the pool opens. Not a per-query SET, so there is no window
      // where a pooled client runs a statement outside the read-only default.
      options: this.readOnly ? READ_ONLY_STARTUP_OPTIONS : undefined,
      max: 4,
      connectionTimeoutMillis: 15000
    })
    await this.pool.query('select 1')
    if (this.readOnly) await this.verifyReadOnlySession()
  }

  /**
   * Proves the startup option took effect on a freshly created connection.
   * Fails closed: a read-only profile that cannot be enforced must not connect.
   */
  private async verifyReadOnlySession(): Promise<void> {
    const client = await this.requirePool().connect()
    let failure: Error | null = null
    try {
      const result = await client.query<{ ro: string }>('show transaction_read_only')
      const value = String(result.rows[0]?.ro ?? '').toLowerCase()
      if (value !== 'on') {
        failure = new Error(
          `PostgreSQL reports transaction_read_only=${value || 'unknown'} for this read-only profile. ` +
            'An “options” parameter inside the connection string replaces the read-only startup ' +
            'option; remove it, or connect with a role that has no write grants.'
        )
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    } finally {
      // Released before the pool is ended: pg-pool completes end() only once
      // every client is back, so ending it while this one is still checked out
      // would hang here instead of failing closed.
      client.release()
    }
    if (failure) {
      await this.disconnect().catch(() => undefined)
      throw failure
    }
  }

  async disconnect(): Promise<void> {
    if (this.transactionClient) {
      await this.transactionClient.query('ROLLBACK').catch(() => undefined)
      this.transactionClient.release()
      this.transactionClient = null
    }
    await this.pool?.end()
    this.pool = null
    this.readOnly = false
  }

  async serverVersion(): Promise<string> {
    const result = await this.requirePool().query<{ version: string }>('select version() as version')
    return result.rows[0]?.version ?? 'PostgreSQL'
  }

  async query(
    sql: string,
    params: unknown[] = [],
    allowWrites = false,
    options: QueryOptions = {}
  ) {
    ensureWritable(sql, allowWrites, this.readOnly)
    // A read-only transaction cannot be started inside an existing one, and
    // running the AI statement in the user's transaction would silently drop
    // the fence. Refuse instead of weakening the guarantee.
    if (options.readOnlyTransaction && this.transactionClient) {
      throw new Error(
        'AI read blocked: commit or roll back the open transaction first, so the statement can run inside a read-only transaction.'
      )
    }
    const started = Date.now()
    const effectiveSql = limitedReadSql(sql, options.maxRows, 'postgres')
    const client = this.transactionClient ?? (await this.requirePool().connect())
    const ownsClient = !this.transactionClient
    let fenced = false
    this.activeClient = client
    try {
      if (options.readOnlyTransaction) {
        await client.query(AI_READ_ONLY_BEGIN_SQL)
        fenced = true
      }
      if (options.timeoutMs && options.timeoutMs > 0) {
        const timeout = Math.max(1000, Math.floor(options.timeoutMs))
        await client.query(
          this.transactionClient || fenced
            ? `SET LOCAL statement_timeout = ${timeout}`
            : `SET statement_timeout = ${timeout}`
        )
      }
      const result = await client.query({ text: effectiveSql, values: params })
      const columns = result.fields?.map((field) => field.name) ?? []
      const rows = (result.rows ?? []) as Record<string, unknown>[]
      const output = makeResult(columns, rows, Date.now() - started, result.command)
      if (result.rowCount != null && columns.length === 0) output.rowCount = result.rowCount
      return markTruncated(output, options.maxRows)
    } finally {
      this.activeClient = null
      // ROLLBACK closes the fence without committing anything the statement
      // might have queued through a function.
      if (fenced) await client.query('ROLLBACK').catch(() => undefined)
      if (ownsClient) {
        await client.query('RESET statement_timeout').catch(() => undefined)
        client.release()
      }
    }
  }

  async cancel(): Promise<void> {
    const pid = (this.activeClient as unknown as { processID?: number } | null)?.processID
    if (!pid) return
    await this.requirePool().query('select pg_cancel_backend($1)', [pid])
  }

  async explain(sql: string, analyze: boolean, options: QueryOptions = {}): Promise<ExplainRaw> {
    const explainSql = buildExplainSql('postgres', sql, analyze)
    if (!explainSql) throw new Error('Explain is not supported for postgres connections.')
    if (analyze) {
      // ANALYZE executes the SELECT. Run it inside a PostgreSQL READ ONLY
      // transaction so volatile functions cannot write, even when they are not
      // in the SQL classifier's deny-list. Database grants remain the final
      // boundary.
      if (this.transactionClient) {
        throw new Error('EXPLAIN ANALYZE cannot run inside an open transaction. Commit or roll back first.')
      }
      const client = await this.requirePool().connect()
      try {
        await client.query('BEGIN TRANSACTION READ ONLY')
        if (options.timeoutMs && options.timeoutMs > 0) {
          const timeout = Math.max(1000, Math.floor(options.timeoutMs))
          await client.query(`SET LOCAL statement_timeout = ${timeout}`)
        }
        const result = await client.query(explainSql)
        await client.query('ROLLBACK')
        return {
          columns: result.fields?.map((field) => field.name) ?? [],
          rows: (result.rows ?? []) as Record<string, unknown>[]
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    const client = this.transactionClient ?? (await this.requirePool().connect())
    const ownsClient = !this.transactionClient
    try {
      if (options.timeoutMs && options.timeoutMs > 0) {
        const timeout = Math.max(1000, Math.floor(options.timeoutMs))
        await client.query(
          this.transactionClient ? `SET LOCAL statement_timeout = ${timeout}` : `SET statement_timeout = ${timeout}`
        )
      }
      const result = await client.query(explainSql)
      return {
        columns: result.fields?.map((field) => field.name) ?? [],
        rows: (result.rows ?? []) as Record<string, unknown>[]
      }
    } finally {
      if (ownsClient) {
        await client.query('RESET statement_timeout').catch(() => undefined)
        client.release()
      }
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = await this.requirePool().query(
      `select pid, usename, datname, client_addr::text as client_addr,
              application_name, backend_type, state, query,
              query_start, wait_event_type, wait_event
       from pg_stat_activity
       order by pid
       limit 200`
    )
    return (result.rows as Record<string, unknown>[]).map((row) => {
      const pid = Number(row.pid)
      const waitType = row.wait_event_type ? String(row.wait_event_type) : ''
      const waitEvent = row.wait_event ? String(row.wait_event) : ''
      const queryStart = row.query_start as Date | string | null
      return {
        id: String(row.pid),
        pid: Number.isFinite(pid) ? pid : undefined,
        user: row.usename != null ? String(row.usename) : undefined,
        database: row.datname != null ? String(row.datname) : undefined,
        host: row.client_addr != null ? String(row.client_addr) : undefined,
        state: row.state != null ? String(row.state) : undefined,
        query: row.query != null ? String(row.query).slice(0, 1000) : undefined,
        queryStart:
          queryStart instanceof Date
            ? queryStart.toISOString()
            : queryStart != null
              ? String(queryStart)
              : undefined,
        waitEvent: waitType || waitEvent ? `${waitType}:${waitEvent}` : undefined,
        application:
          row.application_name != null ? String(row.application_name) : undefined,
        backendType: row.backend_type != null ? String(row.backend_type) : undefined
      } satisfies SessionInfo
    })
  }

  async killSession(sessionId: string, mode: 'cancel' | 'terminate' = 'terminate'): Promise<void> {
    const pid = Number(sessionId)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid session pid.')
    const fn = mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'
    await this.requirePool().query(`select ${fn}($1::int)`, [pid])
  }

  async begin(): Promise<void> {
    if (this.transactionClient) throw new Error('A transaction is already active.')
    const client = await this.requirePool().connect()
    await client.query('BEGIN')
    this.transactionClient = client
  }

  async commit(): Promise<void> {
    const client = this.transactionClient
    if (!client) throw new Error('No active transaction.')
    try {
      await client.query('COMMIT')
    } finally {
      client.release()
      this.transactionClient = null
    }
  }

  async rollback(): Promise<void> {
    const client = this.transactionClient
    if (!client) throw new Error('No active transaction.')
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
      this.transactionClient = null
    }
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const params: unknown[] = []
    let filter = "table_schema not in ('pg_catalog','information_schema')"
    if (schema) {
      params.push(schema)
      filter = `table_schema = $${params.length}`
    }
    const result = await this.requirePool().query(
      `select t.table_schema as schema, t.table_name as name, t.table_type as type,
              obj_description(
                (quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass
              ) as comment
       from information_schema.tables t
       where ${filter}
       order by t.table_schema, t.table_name
       limit 500`,
      params
    )
    return result.rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type,
      comment: row.comment ? String(row.comment).trim() : undefined
    }))
  }

  /**
   * Every column of every user table in one query. Used only to rank the schema
   * sent to the AI; bounded so a huge catalog cannot stall the request.
   */
  async columnsIndex(): Promise<ColumnRef[]> {
    const result = await this.requirePool().query<ColumnRef>(
      `select table_schema as schema, table_name as "table", column_name as column
       from information_schema.columns
       where table_schema not in ('pg_catalog','information_schema')
       order by table_schema, table_name, ordinal_position
       limit 20000`
    )
    return result.rows
  }

  async describeTable(schema: string | undefined, table: string): Promise<TableDetails> {
    const effectiveSchema = schema || 'public'
    const pool = this.requirePool()
    const [columnsResult, pkResult, fkResult] = await Promise.all([
      pool.query(
        `select column_name as name, data_type as type, is_nullable, column_default
         from information_schema.columns
         where table_schema = $1 and table_name = $2
         order by ordinal_position`,
        [effectiveSchema, table]
      ),
      pool.query(
        `select kcu.column_name as name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
         where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1 and tc.table_name = $2`,
        [effectiveSchema, table]
      ),
      pool.query(
        `select tc.table_schema as schema, tc.table_name as table, kcu.column_name as column,
                ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_column,
                tc.constraint_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
         where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1 and tc.table_name = $2`,
        [effectiveSchema, table]
      )
    ])

    const primaryKey = new Set<string>(pkResult.rows.map((row: { name: string }) => row.name))
    return {
      schema: effectiveSchema,
      table,
      columns: columnsResult.rows.map((row: Record<string, unknown>) => ({
        name: String(row.name),
        type: String(row.type),
        nullable: row.is_nullable === 'YES',
        primaryKey: primaryKey.has(String(row.name)),
        defaultValue: (row.column_default as string | null) ?? null
      })),
      primaryKey: [...primaryKey],
      foreignKeys: (fkResult.rows as Record<string, unknown>[]).map((row) => ({
        schema: String(row.schema),
        table: String(row.table),
        column: String(row.column),
        refSchema: String(row.ref_schema),
        refTable: String(row.ref_table),
        refColumn: String(row.ref_column),
        constraintName: String(row.constraint_name)
      }))
    }
  }

  async graph(schema?: string): Promise<SchemaGraph> {
    const effectiveSchema = schema || 'public'
    const pool = this.requirePool()
    const tables = await pool.query(
      `select table_name as name from information_schema.tables
       where table_schema = $1 and table_type in ('BASE TABLE','VIEW')
       order by table_name limit 60`,
      [effectiveSchema]
    )
    const names: string[] = tables.rows.map((row: { name: string }) => row.name)
    if (names.length === 0) return { nodes: [], edges: [] }
    const columns = await pool.query(
      `select table_name as table, column_name as name, data_type as type, is_nullable, column_default
       from information_schema.columns
       where table_schema = $1 and table_name = any($2::text[])
       order by table_name, ordinal_position`,
      [effectiveSchema, names]
    )
    const byTable = new Map<string, TableDetails['columns']>()
    for (const row of columns.rows as Record<string, unknown>[]) {
      const table = String(row.table)
      if (!byTable.has(table)) byTable.set(table, [])
      byTable.get(table)!.push({
        name: String(row.name),
        type: String(row.type),
        nullable: row.is_nullable === 'YES',
        defaultValue: (row.column_default as string | null) ?? null
      })
    }
    const fks = await pool.query(
      `select tc.table_name as table, kcu.column_name as column,
              ccu.table_name as ref_table, ccu.column_name as ref_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
       where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1`,
      [effectiveSchema]
    )
    return {
      nodes: names.map((name) => ({
        id: `${effectiveSchema}.${name}`,
        label: name,
        schema: effectiveSchema,
        columns: byTable.get(name) ?? []
      })),
      edges: (fks.rows as Record<string, unknown>[]).map((row, index) => ({
        id: `fk-${index}-${row.table}-${row.column}-${row.ref_table}-${row.ref_column}`,
        source: `${effectiveSchema}.${row.table}`,
        target: `${effectiveSchema}.${row.ref_table}`,
        label: `${row.column} → ${row.ref_column}`
      }))
    }
  }

  async catalog(schema?: string): Promise<SchemaCatalog> {
    const effectiveSchema =
      schema ||
      String(
        (await this.requirePool().query<{ schema: string }>('select current_schema() as schema'))
          .rows[0]?.schema ?? 'public'
      )
    const [relations, routines, triggers, indexes] = await Promise.all([
      this.requirePool().query<Record<string, unknown>>(
        `select table_schema as schema, table_name as name,
                case table_type when 'VIEW' then 'view' else 'table' end as type,
                null as parent
           from information_schema.tables
          where table_schema = $1 and table_type in ('BASE TABLE','VIEW')
         union all
         select schemaname, matviewname, 'materialized_view', null
           from pg_matviews where schemaname = $1
          order by type, name`,
        [effectiveSchema]
      ),
      this.requirePool().query<Record<string, unknown>>(
        `select n.nspname as schema, p.proname as name,
                case p.prokind when 'p' then 'procedure' else 'function' end as type,
                pg_get_function_identity_arguments(p.oid) as parent
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = $1 and p.prokind in ('f','p')
          order by p.proname`,
        [effectiveSchema]
      ),
      this.requirePool().query<Record<string, unknown>>(
        `select n.nspname as schema, t.tgname as name, 'trigger' as type,
                c.relname as parent
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and not t.tgisinternal
          order by t.tgname`,
        [effectiveSchema]
      ),
      this.requirePool().query<Record<string, unknown>>(
        `select n.nspname as schema, i.relname as name, 'index' as type,
                c.relname as parent
           from pg_index x
           join pg_class i on i.oid = x.indexrelid
           join pg_class c on c.oid = x.indrelid
           join pg_namespace n on n.oid = i.relnamespace
          where n.nspname = $1
          order by i.relname`,
        [effectiveSchema]
      )
    ])
    const all = [
      ...relations.rows,
      ...routines.rows,
      ...triggers.rows,
      ...indexes.rows
    ]
    const objects = all.slice(0, 1000).map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: String(row.type),
      parent: row.parent != null ? String(row.parent) : undefined
    }))
    return { objects, truncated: all.length > 1000 }
  }

  async ddl(object: SchemaObjectRef): Promise<SchemaDdl> {
    const effectiveSchema =
      object.schema ||
      String(
        (await this.requirePool().query<{ schema: string }>('select current_schema() as schema'))
          .rows[0]?.schema ?? 'public'
      )
    const qualified = `${quoteIdent('postgres', effectiveSchema)}.${quoteIdent('postgres', object.name)}`
    const warnings: string[] = []
    if (object.type === 'table') {
      const [columns, constraints] = await Promise.all([
        this.requirePool().query<Record<string, unknown>>(
          `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                  a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default_value
             from pg_attribute a
             join pg_class c on c.oid = a.attrelid
             join pg_namespace n on n.oid = c.relnamespace
             left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
            order by a.attnum`,
          [effectiveSchema, object.name]
        ),
        this.requirePool().query<Record<string, unknown>>(
          `select conname, pg_get_constraintdef(oid) as definition
             from pg_constraint where conrelid = to_regclass($1)
            order by conname`,
          [qualified]
        )
      ])
      if (columns.rows.length === 0) throw new Error('Table columns not found.')
      const lines = columns.rows.map((column) => {
        const parts = [
          quoteIdent('postgres', String(column.name)),
          String(column.type),
          column.not_null ? 'NOT NULL' : '',
          column.default_value != null ? `DEFAULT ${String(column.default_value)}` : ''
        ].filter(Boolean)
        return `  ${parts.join(' ')}`
      })
      for (const constraint of constraints.rows) {
        lines.push(
          `  CONSTRAINT ${quoteIdent('postgres', String(constraint.conname))} ${String(constraint.definition)}`
        )
      }
      warnings.push('Indexes are listed separately in the catalog.')
      return { sql: `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`, warnings }
    }
    if (object.type === 'view' || object.type === 'materialized_view') {
      const result = await this.requirePool().query<{ definition: string | null }>(
        `select pg_get_viewdef(c.oid, true) as definition
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = $2`,
        [effectiveSchema, object.name]
      )
      const definition = result.rows[0]?.definition
      if (!definition) throw new Error('View definition not found.')
      const keyword = object.type === 'view' ? 'VIEW' : 'MATERIALIZED VIEW'
      return {
        sql: `CREATE OR REPLACE ${keyword} ${qualified} AS\n${definition.trim().replace(/;+\s*$/, '')};`,
        warnings
      }
    }
    if (object.type === 'function' || object.type === 'procedure') {
      const result = await this.requirePool().query<{ definition: string | null }>(
        `select pg_get_functiondef(p.oid) as definition
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = $1 and p.proname = $2
            and ($3::text is null or pg_get_function_identity_arguments(p.oid) = $3)
          order by p.oid limit 1`,
        [effectiveSchema, object.name, object.parent ?? null]
      )
      const definition = result.rows[0]?.definition
      if (!definition) throw new Error('Function definition not found.')
      return { sql: definition.trim().replace(/;+\s*$/, '') + ';', warnings }
    }
    if (object.type === 'trigger') {
      const result = await this.requirePool().query<{ definition: string | null }>(
        `select pg_get_triggerdef(t.oid) as definition
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and t.tgname = $2
            and ($3::text is null or c.relname = $3)`,
        [effectiveSchema, object.name, object.parent ?? null]
      )
      const definition = result.rows[0]?.definition
      if (!definition) throw new Error('Trigger definition not found.')
      return { sql: definition.trim().replace(/;+\s*$/, '') + ';', warnings }
    }
    if (object.type === 'index') {
      const result = await this.requirePool().query<{ definition: string | null }>(
        `select pg_get_indexdef(i.oid) as definition
           from pg_class i join pg_namespace n on n.oid = i.relnamespace
          where n.nspname = $1 and i.relname = $2`,
        [effectiveSchema, object.name]
      )
      const definition = result.rows[0]?.definition
      if (!definition) throw new Error('Index definition not found.')
      return { sql: definition.trim().replace(/;+\s*$/, '') + ';', warnings }
    }
    throw new Error(`PostgreSQL DDL is not implemented for ${object.type}.`)
  }

  async buildContext(): Promise<string> {
    const tables = await this.listTables()
    if (tables.length === 0) return 'No tables found.'
    const bySchema = new Map<string, string[]>()
    for (const table of tables) {
      const key = table.schema || 'public'
      if (!bySchema.has(key)) bySchema.set(key, [])
      bySchema.get(key)!.push(table.name)
    }
    const parts: string[] = []
    for (const [schema, names] of bySchema) {
      for (const name of names.slice(0, 80)) {
        const details = await this.describeTable(schema, name)
        parts.push(`${schema}.${name}(${compactColumns(details.columns)})`)
      }
    }
    return clipContext(`PostgreSQL schema:\n${parts.join('\n')}`)
  }
}
