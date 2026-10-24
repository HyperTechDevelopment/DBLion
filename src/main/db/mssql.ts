import mssql from 'mssql'
import type {
  ConnectionConfig,
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
import {
  clipContext,
  compactColumns,
  ensureWritable,
  limitedReadSql,
  makeResult,
  markTruncated
} from './common'

export class MssqlAdapter implements DbAdapter {
  readonly kind = 'mssql'
  private pool: mssql.ConnectionPool | null = null
  private activeRequest: mssql.Request | null = null
  /** Mirrors ConnectionConfig.accessMode; guards every statement. */
  private readOnly = false

  private requirePool(): mssql.ConnectionPool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.readOnly = isReadOnlyAccess(config)
    this.pool = new mssql.ConnectionPool({
      server: config.host ?? 'localhost',
      port: config.port ?? 1433,
      database: config.database,
      user: config.user,
      password: config.password,
      options: {
        encrypt: config.ssl ?? true,
        trustServerCertificate: false,
        enableArithAbort: true,
        // ApplicationIntent=ReadOnly in the login packet (tedious
        // readOnlyIntent). SQL Server has no session-level read-only
        // transaction mode, so this is the only native lever: an availability
        // group routes the session to a readable secondary, which rejects
        // writes. On a standalone primary the server does not enforce it, and
        // DBLion's own gate remains the boundary.
        readOnlyIntent: this.readOnly ? true : undefined,
        cryptoCredentialsDetails: config.ssl
          ? {
              ca: config.sslCa || undefined,
              cert: config.sslCert || undefined,
              key: config.sslKey || undefined
            }
          : undefined
      },
      connectionTimeout: 15000,
      requestTimeout: 30000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
    })
    await this.pool.connect()
  }

  async disconnect(): Promise<void> {
    await this.pool?.close()
    this.pool = null
    this.readOnly = false
  }

  async serverVersion(): Promise<string> {
    const result = await this.requirePool().request().query<{ version: string }>(
      'select @@version as version'
    )
    return String(result.recordset[0]?.version ?? 'SQL Server')
  }

  private bind(request: mssql.Request, sql: string, params: unknown[]): { text: string } {
    let index = 0
    const text = params.length ? sql.replace(/\?/g, () => `@p${index++}`) : sql
    params.forEach((value, paramIndex) => {
      request.input(`p${paramIndex}`, value as never)
    })
    return { text }
  }

  async query(
    sql: string,
    params: unknown[] = [],
    allowWrites = false,
    options: QueryOptions = {}
  ) {
    ensureWritable(sql, allowWrites, this.readOnly)
    const started = Date.now()
    const request = this.requirePool().request()
    const effectiveSql = limitedReadSql(sql, options.maxRows, 'mssql')
    const { text } = this.bind(request, effectiveSql, params)
    if (options.timeoutMs && options.timeoutMs > 0) {
      ;(request as unknown as { timeout: number }).timeout = options.timeoutMs
    }
    this.activeRequest = request
    try {
      const result = await request.query(text)
      const rows = (result.recordset ?? []) as Record<string, unknown>[]
      const columns =
        Object.keys(result.recordset?.columns ?? {}) ||
        (rows.length > 0 ? Object.keys(rows[0]) : [])
      const output = makeResult(
        columns,
        rows,
        Date.now() - started,
        sql.trim().split(/\s+/)[0]?.toUpperCase()
      )
      if (result.rowsAffected?.length) output.rowCount = result.rowsAffected[0]
      return markTruncated(output, options.maxRows)
    } finally {
      this.activeRequest = null
    }
  }

  async cancel(): Promise<void> {
    this.activeRequest?.cancel()
  }

  async explain(sql: string, _analyze: boolean, options: QueryOptions = {}): Promise<ExplainRaw> {
    // SET SHOWPLAN_TEXT must be the only statement in its batch. A transaction
    // pins one pool connection, so ON, the statement and OFF share a session.
    const trimmed = sql.trim().replace(/;+\s*$/, '')
    const transaction = new mssql.Transaction(this.requirePool())
    await transaction.begin()
    try {
      const request = new mssql.Request(transaction)
      if (options.timeoutMs && options.timeoutMs > 0) {
        ;(request as unknown as { timeout: number }).timeout = options.timeoutMs
      }
      await request.batch('SET SHOWPLAN_TEXT ON')
      const result = (await request.batch(trimmed)) as unknown as {
        recordsets?: Record<string, unknown>[][]
        recordset?: Record<string, unknown>[]
      }
      const sets = result.recordsets ?? (result.recordset ? [result.recordset] : [])
      const rows: Record<string, unknown>[] = []
      for (const set of sets) {
        for (const row of set ?? []) {
          if (row && typeof row === 'object' && ('StmtText' in row || 'stmttext' in row)) {
            rows.push(row as Record<string, unknown>)
          }
        }
      }
      return { columns: ['StmtText'], rows }
    } finally {
      // Leaving SHOWPLAN on would make the next pooled query return a plan.
      try {
        await new mssql.Request(transaction).batch('SET SHOWPLAN_TEXT OFF')
      } catch {
        // Rollback still runs; the pool discards a connection that cannot reset.
      }
      await transaction.rollback().catch(() => undefined)
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = await this.requirePool().request().query<Record<string, unknown>>(
      `SELECT TOP 200 session_id, login_name, host_name, program_name, status,
              cpu_time, reads, writes, login_time, last_request_start_time,
              DB_NAME(database_id) as db_name
       FROM sys.dm_exec_sessions
       WHERE is_user_process = 1
       ORDER BY session_id`
    )
    return (result.recordset as Record<string, unknown>[]).map((row) => {
      const sessionId = Number(row.session_id)
      const lastStart = row.last_request_start_time as Date | string | null
      return {
        id: String(row.session_id),
        pid: Number.isFinite(sessionId) ? sessionId : undefined,
        user: row.login_name != null ? String(row.login_name) : undefined,
        host: row.host_name != null ? String(row.host_name) : undefined,
        application: row.program_name != null ? String(row.program_name) : undefined,
        state: row.status != null ? String(row.status) : undefined,
        database: row.db_name != null ? String(row.db_name) : undefined,
        queryStart:
          lastStart instanceof Date
            ? lastStart.toISOString()
            : lastStart != null
              ? String(lastStart)
              : undefined
      } satisfies SessionInfo
    })
  }

  async killSession(sessionId: string): Promise<void> {
    const numericId = Number(sessionId)
    if (!Number.isInteger(numericId) || numericId <= 0) throw new Error('Invalid session id.')
    if (numericId < 51) throw new Error('Refusing to kill a system session (id < 51).')
    await this.requirePool().request().query(`KILL ${numericId}`)
  }

  async catalog(schema?: string): Promise<SchemaCatalog> {
    const effectiveSchema = schema ?? 'dbo'
    const request = this.requirePool().request()
    request.input('schema', effectiveSchema)
    const result = await request.query<Record<string, unknown>>(
      `select s.name as [schema], o.name, 
              case o.type when 'U' then 'table' when 'V' then 'view'
                when 'P' then 'procedure' else 'function' end as type,
              null as parent
         from sys.objects o join sys.schemas s on s.schema_id = o.schema_id
        where s.name = @schema and o.is_ms_shipped = 0
          and o.type in ('U','V','P','FN','IF','TF')
       union all
       select s.name, tr.name, 'trigger', OBJECT_NAME(tr.parent_id)
         from sys.triggers tr
         join sys.objects o on o.object_id = tr.parent_id
         join sys.schemas s on s.schema_id = o.schema_id
        where s.name = @schema and tr.is_ms_shipped = 0
       union all
       select s.name, i.name, 'index', o.name
         from sys.indexes i
         join sys.objects o on o.object_id = i.object_id
         join sys.schemas s on s.schema_id = o.schema_id
        where s.name = @schema and o.is_ms_shipped = 0 and i.name is not null
          and i.is_primary_key = 0 and i.is_unique_constraint = 0
       order by type, name`
    )
    const all = result.recordset ?? []
    return {
      objects: all.slice(0, 1000).map((row) => ({
        schema: String(row.schema),
        name: String(row.name),
        type: String(row.type),
        parent: row.parent != null ? String(row.parent) : undefined
      })),
      truncated: all.length > 1000
    }
  }

  private mssqlType(row: Record<string, unknown>): string {
    const type = String(row.type ?? '')
    const maxLength = Number(row.max_length)
    const length =
      maxLength < 0 ? 'max' : ['nvarchar', 'nchar'].includes(type) ? maxLength / 2 : maxLength
    if (['varchar', 'char', 'nvarchar', 'nchar', 'varbinary', 'binary'].includes(type)) {
      return `${type}(${length})`
    }
    if (['decimal', 'numeric'].includes(type)) {
      return `${type}(${Number(row.precision)},${Number(row.scale)})`
    }
    if (['datetime2', 'time', 'datetimeoffset'].includes(type)) {
      return `${type}(${Number(row.scale)})`
    }
    if (type === 'float' && Number(row.precision) !== 53) return `float(${Number(row.precision)})`
    return type
  }

  async ddl(object: SchemaObjectRef): Promise<SchemaDdl> {
    const effectiveSchema = object.schema ?? 'dbo'
    const qualified = `${quoteIdent('mssql', effectiveSchema)}.${quoteIdent('mssql', object.name)}`
    const warnings: string[] = []
    if (object.type === 'table') {
      const columnsRequest = this.requirePool().request()
      columnsRequest.input('objectName', qualified)
      const columns = await columnsRequest.query<Record<string, unknown>>(
        `select c.name, t.name as type, c.max_length, c.precision, c.scale,
                c.is_nullable, c.is_identity, dc.definition as default_value
           from sys.columns c
           join sys.types t on t.user_type_id = c.user_type_id
           left join sys.default_constraints dc
             on dc.parent_object_id = c.object_id and dc.parent_column_id = c.column_id
          where c.object_id = OBJECT_ID(@objectName)
          order by c.column_id`
      )
      if (columns.recordset.length === 0) throw new Error('Table columns not found.')
      const pkRequest = this.requirePool().request()
      pkRequest.input('objectName', qualified)
      const pk = await pkRequest.query<{ name: string }>(
        `select col.name
           from sys.indexes i
           join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
           join sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id
          where i.object_id = OBJECT_ID(@objectName) and i.is_primary_key = 1
          order by ic.key_ordinal`
      )
      const lines = columns.recordset.map((column) => {
        const parts = [
          quoteIdent('mssql', String(column.name)),
          this.mssqlType(column),
          column.is_identity ? 'IDENTITY(1,1)' : '',
          column.is_nullable ? 'NULL' : 'NOT NULL',
          column.default_value != null ? `DEFAULT ${String(column.default_value)}` : ''
        ].filter(Boolean)
        return `  ${parts.join(' ')}`
      })
      if (pk.recordset.length > 0) {
        lines.push(
          `  CONSTRAINT ${quoteIdent('mssql', `PK_${object.name}`)} PRIMARY KEY (${pk.recordset
            .map((row) => quoteIdent('mssql', row.name))
            .join(', ')})`
        )
        warnings.push('Primary key name is reconstructed; review before applying.')
      }
      warnings.push('Indexes and foreign keys are listed separately or need manual review.')
      return { sql: `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`, warnings }
    }
    if (object.type === 'index') {
      if (!object.parent) throw new Error('Index DDL requires its parent table.')
      const request = this.requirePool().request()
      request.input('schema', effectiveSchema)
      request.input('table', object.parent)
      request.input('index', object.name)
      const result = await request.query<Record<string, unknown>>(
        `select i.is_unique, i.type_desc, col.name, ic.is_descending_key
           from sys.indexes i
           join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
           join sys.columns col on col.object_id = ic.object_id and col.column_id = ic.column_id
           join sys.objects o on o.object_id = i.object_id
           join sys.schemas s on s.schema_id = o.schema_id
          where s.name = @schema and o.name = @table and i.name = @index
          order by ic.key_ordinal`
      )
      if (result.recordset.length === 0) throw new Error('Index metadata not found.')
      const unique = result.recordset[0].is_unique ? 'UNIQUE ' : ''
      const kind = String(result.recordset[0].type_desc ?? '').includes('CLUSTERED')
        ? 'CLUSTERED '
        : 'NONCLUSTERED '
      const columns = result.recordset
        .map(
          (row) =>
            `${quoteIdent('mssql', String(row.name))}${row.is_descending_key ? ' DESC' : ' ASC'}`
        )
        .join(', ')
      return {
        sql: `CREATE ${unique}${kind}INDEX ${quoteIdent('mssql', object.name)} ON ${qualified} (${columns});`,
        warnings
      }
    }
    if (['view', 'procedure', 'function', 'trigger'].includes(object.type)) {
      const request = this.requirePool().request()
      request.input('objectName', qualified)
      const result = await request.query<{ definition: string | null }>(
        `select OBJECT_DEFINITION(OBJECT_ID(@objectName)) as definition`
      )
      const definition = result.recordset[0]?.definition
      if (!definition) throw new Error('Object definition not found or not readable.')
      return { sql: definition.trim().replace(/;+\s*$/, '') + ';', warnings }
    }
    throw new Error(`SQL Server DDL is not implemented for ${object.type}.`)
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const request = this.requirePool().request()
    const effectiveSchema = schema ?? 'dbo'
    request.input('schema', effectiveSchema)
    const result = await request.query<TableInfo>(
      `select top 500 t.TABLE_SCHEMA as [schema], t.TABLE_NAME as name, t.TABLE_TYPE as type,
              cast(ep.value as nvarchar(4000)) as comment
       from INFORMATION_SCHEMA.TABLES t
       left join sys.extended_properties ep
         on ep.major_id = OBJECT_ID(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME))
        and ep.minor_id = 0
        and ep.name = 'MS_Description'
       where t.TABLE_SCHEMA = @schema
       order by t.TABLE_NAME`
    )
    return result.recordset.map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type,
      comment: row.comment ? String(row.comment).trim() : undefined
    }))
  }

  /**
   * Every column of every user table/view in one query (sys.columns covers all
   * schemas, unlike listTables which stays on the selected one). Used only to
   * rank the schema sent to the AI.
   */
  async columnsIndex(): Promise<ColumnRef[]> {
    const result = await this.requirePool().request().query<ColumnRef>(
      `select top 20000 s.name as [schema], o.name as [table], c.name as [column]
       from sys.columns c
       join sys.objects o on o.object_id = c.object_id
       join sys.schemas s on s.schema_id = o.schema_id
       where o.type in ('U','V') and o.is_ms_shipped = 0
       order by s.name, o.name, c.column_id`
    )
    return result.recordset
  }

  async describeTable(schema: string | undefined, table: string): Promise<TableDetails> {
    const effectiveSchema = schema ?? 'dbo'
    const pool = this.requirePool()
    const columnsRequest = pool.request()
    columnsRequest.input('schema', effectiveSchema)
    columnsRequest.input('table', table)
    const columns = await columnsRequest.query<Record<string, unknown>>(
      `select COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default
       from INFORMATION_SCHEMA.COLUMNS
       where TABLE_SCHEMA = @schema and TABLE_NAME = @table
       order by ORDINAL_POSITION`
    )
    const pkRequest = pool.request()
    pkRequest.input('schema', effectiveSchema)
    pkRequest.input('table', table)
    const pk = await pkRequest.query<{ name: string }>(
      `select kcu.COLUMN_NAME as name
       from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         on tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME and tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       where tc.CONSTRAINT_TYPE = 'PRIMARY KEY' and tc.TABLE_SCHEMA = @schema and tc.TABLE_NAME = @table`
    )
    const fkRequest = pool.request()
    fkRequest.input('schema', effectiveSchema)
    fkRequest.input('table', table)
    const fks = await fkRequest.query<Record<string, unknown>>(
      `select tc.TABLE_SCHEMA as [schema], tc.TABLE_NAME as [table], kcu.COLUMN_NAME as [column],
              ccu.TABLE_SCHEMA as ref_schema, ccu.TABLE_NAME as ref_table, ccu.COLUMN_NAME as ref_column,
              tc.CONSTRAINT_NAME as constraint_name
       from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         on tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME and tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       join INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
         on ccu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME and ccu.TABLE_SCHEMA = tc.TABLE_SCHEMA
       where tc.CONSTRAINT_TYPE = 'FOREIGN KEY' and tc.TABLE_SCHEMA = @schema and tc.TABLE_NAME = @table`
    )
    const primaryKey = new Set(pk.recordset.map((row: { name: string }) => String(row.name)))
    return {
      schema: effectiveSchema,
      table,
      columns: columns.recordset.map((row: Record<string, unknown>) => ({
        name: String(row.name),
        type: String(row.type),
        nullable: row.is_nullable === 'YES',
        primaryKey: primaryKey.has(String(row.name)),
        defaultValue: (row.column_default as string | null) ?? null
      })),
      primaryKey: [...primaryKey],
      foreignKeys: fks.recordset.map((row: Record<string, unknown>) => ({
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
    const effectiveSchema = schema ?? 'dbo'
    const tables = await this.listTables(effectiveSchema)
    const names = tables.slice(0, 60).map((table) => table.name)
    if (names.length === 0) return { nodes: [], edges: [] }
    const byTable = new Map<string, TableDetails['columns']>()
    for (const name of names) {
      const details = await this.describeTable(effectiveSchema, name)
      byTable.set(name, details.columns)
    }
    const fkRequest = this.requirePool().request()
    fkRequest.input('schema', effectiveSchema)
    const fks = await fkRequest.query<Record<string, unknown>>(
      `select tc.TABLE_NAME as [table], kcu.COLUMN_NAME as [column],
              ccu.TABLE_NAME as ref_table, ccu.COLUMN_NAME as ref_column
       from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         on tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME and tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       join INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
         on ccu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME and ccu.TABLE_SCHEMA = tc.TABLE_SCHEMA
       where tc.CONSTRAINT_TYPE = 'FOREIGN KEY' and tc.TABLE_SCHEMA = @schema`
    )
    const nameSet = new Set(names)
    return {
      nodes: names.map((name) => ({
        id: `${effectiveSchema}.${name}`,
        label: name,
        schema: effectiveSchema,
        columns: byTable.get(name) ?? []
      })),
      edges: fks.recordset
        .filter(
          (row: Record<string, unknown>) =>
            nameSet.has(String(row.table)) && nameSet.has(String(row.ref_table))
        )
        .map((row: Record<string, unknown>, index: number) => ({
          id: `fk-${index}-${row.table}-${row.column}-${row.ref_table}-${row.ref_column}`,
          source: `${effectiveSchema}.${row.table}`,
          target: `${effectiveSchema}.${row.ref_table}`,
          label: `${row.column} → ${row.ref_column}`
        }))
    }
  }

  async buildContext(): Promise<string> {
    const tables = await this.listTables()
    const parts: string[] = []
    for (const table of tables.slice(0, 80)) {
      const details = await this.describeTable(table.schema, table.name)
      parts.push(`${table.schema}.${table.name}(${compactColumns(details.columns)})`)
    }
    return clipContext(`SQL Server schema:\n${parts.join('\n')}`)
  }
}
