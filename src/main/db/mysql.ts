import mysql, { type Connection, type FieldPacket, type RowDataPacket } from 'mysql2/promise'
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
import { buildExplainSql } from './explain'
import {
  clipContext,
  compactColumns,
  ensureWritable,
  isReadOnlySql,
  limitedReadSql,
  makeResult,
  markTruncated
} from './common'

/**
 * Transaction-level fence for AI-originated reads. A writable session still
 * rejects every write inside this transaction, including a write performed
 * by a stored function called from a `SELECT`.
 */
export const AI_READ_ONLY_BEGIN_SQL = 'START TRANSACTION READ ONLY'

export class MysqlAdapter implements DbAdapter {
  readonly kind = 'mysql'
  private connection: Connection | null = null
  private config: ConnectionConfig | null = null
  private database = ''
  private transactionOpen = false
  /** Mirrors ConnectionConfig.accessMode; guards every statement. */
  private readOnly = false

  private requireConnection(): Connection {
    if (!this.connection) throw new Error('Not connected')
    return this.connection
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config
    this.database = config.database ?? ''
    this.connection = await mysql.createConnection({
      host: config.host,
      port: config.port ?? 3306,
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
      multipleStatements: false,
      connectTimeout: 15000
    })
    this.readOnly = isReadOnlyAccess(config)
    await this.connection.query('select 1')
    if (this.readOnly) await this.enableReadOnlySession()
  }

  /**
   * `SET SESSION TRANSACTION READ ONLY` makes the server reject every write in
   * this session (autocommit statements included). The setting is read back so
   * the connection fails closed instead of silently staying writable.
   */
  private async enableReadOnlySession(): Promise<void> {
    const connection = this.requireConnection()
    const statements = [
      'SET SESSION TRANSACTION READ ONLY',
      // MariaDB before 11 and MySQL before 5.7.20 accept the legacy variable.
      'SET SESSION tx_read_only = 1'
    ]
    let applied = false
    let lastError: unknown = null
    for (const statement of statements) {
      try {
        await connection.query(statement)
        applied = true
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!applied) {
      await this.disconnect().catch(() => undefined)
      throw new Error(
        'MySQL refused to start a read-only session, so this read-only connection cannot be guaranteed: ' +
          (lastError instanceof Error ? lastError.message : String(lastError))
      )
    }
    if (!(await this.readBackReadOnly())) {
      await this.disconnect().catch(() => undefined)
      throw new Error(
        'MySQL accepted the read-only statement but reports the session as writable. Use a user without write grants for this connection.'
      )
    }
  }

  /** Reads back the session access mode; null when neither variable exists. */
  private async readBackReadOnly(): Promise<boolean> {
    const connection = this.requireConnection()
    for (const variable of ['@@session.transaction_read_only', '@@session.tx_read_only']) {
      try {
        const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${variable} AS ro`)
        return Number(rows[0]?.ro) === 1
      } catch {
        // Variable does not exist on this server; try the next spelling.
      }
    }
    return false
  }

  async disconnect(): Promise<void> {
    await this.connection?.end()
    this.connection = null
    this.readOnly = false
  }

  async serverVersion(): Promise<string> {
    const [rows] = await this.requireConnection().query<RowDataPacket[]>('select version() as version')
    return String(rows[0]?.version ?? 'MySQL')
  }

  async query(
    sql: string,
    params: unknown[] = [],
    allowWrites = false,
    options: QueryOptions = {}
  ) {
    ensureWritable(sql, allowWrites, this.readOnly)
    // Starting a read-only transaction inside an existing one would commit the
    // user's work or silently run the AI statement without the fence.
    if (options.readOnlyTransaction && this.transactionOpen) {
      throw new Error(
        'AI read blocked: commit or roll back the open transaction first, so the statement can run inside a read-only transaction.'
      )
    }
    const started = Date.now()
    const effectiveSql = limitedReadSql(sql, options.maxRows, 'mysql')
    if (isReadOnlySql(sql) && options.timeoutMs && options.timeoutMs > 0) {
      await this.requireConnection().query(
        `SET SESSION MAX_EXECUTION_TIME = ${Math.max(1000, Math.floor(options.timeoutMs))}`
      )
    }
    const connection = this.requireConnection()
    let fenced = false
    try {
      if (options.readOnlyTransaction) {
        await connection.query(AI_READ_ONLY_BEGIN_SQL)
        fenced = true
      }
      const [rows, fields] = (await connection.query(
        {
          sql: effectiveSql,
          timeout: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined
        },
        params
      )) as [RowDataPacket[] | RowDataPacket, FieldPacket[] | undefined]
      const arrayRows = Array.isArray(rows) ? rows : []
      const columns = fields?.map((field) => field.name) ?? []
      const output = makeResult(
        columns,
        arrayRows as Record<string, unknown>[],
        Date.now() - started,
        sql.trim().split(/\s+/)[0]?.toUpperCase()
      )
      if (!Array.isArray(rows) && 'affectedRows' in rows) {
        output.rowCount = Number(rows.affectedRows ?? 0)
      }
      return markTruncated(output, options.maxRows)
    } finally {
      // ROLLBACK closes the fence without committing anything a function wrote.
      if (fenced) await connection.query('ROLLBACK').catch(() => undefined)
    }
  }

  async cancel(): Promise<void> {
    const threadId = (this.connection as unknown as { threadId?: number } | null)?.threadId
    const config = this.config
    if (!threadId || !config) return
    const admin = await mysql.createConnection({
      host: config.host,
      port: config.port ?? 3306,
      user: config.user,
      password: config.password,
      ssl: config.ssl
        ? { rejectUnauthorized: true, ca: config.sslCa || undefined, cert: config.sslCert || undefined, key: config.sslKey || undefined }
        : undefined,
      connectTimeout: 10000
    })
    try {
      await admin.query(`KILL QUERY ${Number(threadId)}`)
    } finally {
      await admin.end().catch(() => undefined)
    }
  }

  async explain(sql: string, analyze: boolean, options: QueryOptions = {}): Promise<ExplainRaw> {
    const explainSql = buildExplainSql('mysql', sql, analyze)
    if (!explainSql) throw new Error('Explain is not supported for mysql connections.')
    const connection = this.requireConnection()
    if (analyze) {
      if (this.transactionOpen) {
        throw new Error('EXPLAIN ANALYZE cannot run inside an open transaction. Commit or roll back first.')
      }
      await connection.query('START TRANSACTION READ ONLY')
      try {
        const [rows, fields] = (await connection.query(
          {
            sql: explainSql,
            timeout: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined
          },
          []
        )) as [RowDataPacket[] | RowDataPacket, FieldPacket[] | undefined]
        const arrayRows = Array.isArray(rows) ? rows : [rows]
        return {
          columns: fields?.map((field) => field.name) ?? Object.keys(arrayRows[0] ?? {}),
          rows: arrayRows as Record<string, unknown>[]
        }
      } finally {
        await connection.query('ROLLBACK').catch(() => undefined)
      }
    }
    const [rows, fields] = (await connection.query(
      {
        sql: explainSql,
        timeout: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined
      },
      []
    )) as [RowDataPacket[] | RowDataPacket, FieldPacket[] | undefined]
    const arrayRows = Array.isArray(rows) ? rows : [rows]
    return {
      columns: fields?.map((field) => field.name) ?? Object.keys(arrayRows[0] ?? {}),
      rows: arrayRows as Record<string, unknown>[]
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const [rows] = await this.requireConnection().query<RowDataPacket[]>(
      `SELECT ID as id, USER as user, HOST as host, DB as db,
              COMMAND as command, TIME as time_sec, STATE as state, INFO as info
       FROM INFORMATION_SCHEMA.PROCESSLIST
       ORDER BY ID
       LIMIT 200`
    )
    return (rows as Record<string, unknown>[]).map((row) => {
      const id = Number(row.id)
      const timeSec = Number(row.time_sec)
      return {
        id: String(row.id),
        pid: Number.isFinite(id) ? id : undefined,
        user: row.user != null ? String(row.user) : undefined,
        host: row.host != null ? String(row.host) : undefined,
        database: row.db != null ? String(row.db) : undefined,
        command: row.command != null ? String(row.command) : undefined,
        state: row.state != null ? String(row.state) : undefined,
        query: row.info != null ? String(row.info).slice(0, 1000) : undefined,
        durationMs: Number.isFinite(timeSec) ? timeSec * 1000 : undefined
      } satisfies SessionInfo
    })
  }

  async killSession(sessionId: string, mode: 'cancel' | 'terminate' = 'terminate'): Promise<void> {
    const numericId = Number(sessionId)
    if (!Number.isInteger(numericId) || numericId <= 0) throw new Error('Invalid process id.')
    const sql = mode === 'cancel' ? `KILL QUERY ${numericId}` : `KILL ${numericId}`
    await this.requireConnection().query(sql)
  }

  async begin(): Promise<void> {
    await this.requireConnection().beginTransaction()
    this.transactionOpen = true
  }

  async commit(): Promise<void> {
    await this.requireConnection().commit()
    this.transactionOpen = false
  }

  async rollback(): Promise<void> {
    await this.requireConnection().rollback()
    this.transactionOpen = false
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const connection = this.requireConnection()
    const params: unknown[] = []
    let filter = "table_schema not in ('mysql','information_schema','performance_schema','sys')"
    if (schema) {
      params.push(schema)
      filter = `table_schema = ?`
    } else if (this.database) {
      params.push(this.database)
      filter = `table_schema = ?`
    }
    const [rows] = await connection.query<RowDataPacket[]>(
      `select table_schema as \`schema\`, table_name as name, table_type as type,
              table_comment as comment
       from information_schema.tables
       where ${filter}
       order by table_schema, table_name
       limit 500`,
      params
    )
    return rows.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: String(row.type),
      comment: row.comment ? String(row.comment).trim() || undefined : undefined
    }))
  }

  /**
   * Every column of the visible tables in one query. Used only to rank the
   * schema sent to the AI (never to build SQL and never sent to the renderer).
   */
  async columnsIndex(): Promise<ColumnRef[]> {
    const connection = this.requireConnection()
    const params: unknown[] = []
    let filter = "table_schema not in ('mysql','information_schema','performance_schema','sys')"
    if (this.database) {
      params.push(this.database)
      filter = 'table_schema = ?'
    }
    const [rows] = await connection.query<RowDataPacket[]>(
      `select table_schema as \`schema\`, table_name as \`table\`, column_name as \`column\`
       from information_schema.columns
       where ${filter}
       order by table_schema, table_name, ordinal_position
       limit 20000`,
      params
    )
    return rows as ColumnRef[]
  }

  async describeTable(schema: string | undefined, table: string): Promise<TableDetails> {
    const effectiveSchema = schema || this.database
    const connection = this.requireConnection()
    const [columns] = await connection.query<RowDataPacket[]>(
      `select column_name as name, column_type as type, is_nullable, column_default, column_key
       from information_schema.columns
       where table_schema = ? and table_name = ?
       order by ordinal_position`,
      [effectiveSchema, table]
    )
    const [fks] = await connection.query<RowDataPacket[]>(
      `select table_schema as \`schema\`, table_name as \`table\`, column_name as \`column\`,
              referenced_table_schema as ref_schema, referenced_table_name as ref_table,
              referenced_column_name as ref_column, constraint_name
       from information_schema.key_column_usage
       where referenced_table_name is not null and table_schema = ? and table_name = ?`,
      [effectiveSchema, table]
    )
    const primaryKey = columns
      .filter((row) => row.column_key === 'PRI')
      .map((row) => String(row.name))
    return {
      schema: effectiveSchema,
      table,
      columns: columns.map((row) => ({
        name: String(row.name),
        type: String(row.type),
        nullable: row.is_nullable === 'YES',
        primaryKey: row.column_key === 'PRI',
        defaultValue: (row.column_default as string | null) ?? null
      })),
      primaryKey,
      foreignKeys: fks.map((row) => ({
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

  async catalog(schema?: string): Promise<SchemaCatalog> {
    const effectiveSchema = schema || this.database
    if (!effectiveSchema) throw new Error('Select a database before browsing its catalog.')
    const [rows] = await this.requireConnection().query<RowDataPacket[]>(
      `select table_schema as \`schema\`, table_name as name,
              case table_type when 'VIEW' then 'view' else 'table' end as type,
              null as parent
         from information_schema.tables where table_schema = ?
       union all
       select routine_schema, routine_name, lower(routine_type), null
         from information_schema.routines where routine_schema = ?
       union all
       select trigger_schema, trigger_name, 'trigger', event_object_table
         from information_schema.triggers where trigger_schema = ?
       union all
       select table_schema, index_name, 'index', table_name
         from information_schema.statistics
        where table_schema = ? and index_name <> 'PRIMARY'
        group by table_schema, table_name, index_name
       order by type, name
       limit 1001`,
      [effectiveSchema, effectiveSchema, effectiveSchema, effectiveSchema]
    )
    const objects = (rows as Record<string, unknown>[]).slice(0, 1000).map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: String(row.type),
      parent: row.parent != null ? String(row.parent) : undefined
    }))
    return { objects, truncated: rows.length > 1000 }
  }

  async ddl(object: SchemaObjectRef): Promise<SchemaDdl> {
    const effectiveSchema = object.schema || this.database
    if (!effectiveSchema) throw new Error('Select a database before reading DDL.')
    const connection = this.requireConnection()
    const table = quoteIdent('mysql', object.name)
    const schema = quoteIdent('mysql', effectiveSchema)
    const warnings: string[] = []
    let rows: RowDataPacket[]
    if (object.type === 'table' || object.type === 'view') {
      const [result] = await connection.query<RowDataPacket[]>(
        `show create ${object.type === 'view' ? 'view' : 'table'} ${schema}.${table}`
      )
      rows = result
    } else if (object.type === 'procedure' || object.type === 'function') {
      const [result] = await connection.query<RowDataPacket[]>(
        `show create ${object.type} ${schema}.${table}`
      )
      rows = result
    } else if (object.type === 'trigger') {
      const [result] = await connection.query<RowDataPacket[]>(
        `show create trigger ${schema}.${table}`
      )
      rows = result
    } else if (object.type === 'index') {
      if (!object.parent) throw new Error('Index DDL requires its parent table.')
      const [columns] = await connection.query<RowDataPacket[]>(
        `select non_unique, index_type, column_name, sub_part, seq_in_index
           from information_schema.statistics
          where table_schema = ? and table_name = ? and index_name = ?
          order by seq_in_index`,
        [effectiveSchema, object.parent, object.name]
      )
      if (columns.length === 0) throw new Error('Index metadata not found.')
      const unique = Number(columns[0].non_unique) === 0 ? 'UNIQUE ' : ''
      const kind = String(columns[0].index_type || '').toUpperCase()
      const prefix = kind === 'FULLTEXT' ? 'FULLTEXT ' : kind === 'SPATIAL' ? 'SPATIAL ' : ''
      const parts = columns.map((row) => {
        const sub = row.sub_part == null ? '' : `(${Number(row.sub_part)})`
        return `${quoteIdent('mysql', String(row.column_name))}${sub}`
      })
      return {
        sql: `CREATE ${unique}${prefix}INDEX ${table} ON ${schema}.${quoteIdent('mysql', object.parent)} (${parts.join(', ')});`,
        warnings
      }
    } else {
      throw new Error(`MySQL DDL is not implemented for ${object.type}.`)
    }
    const record = rows[0] as Record<string, unknown> | undefined
    const sql =
      record && (Object.values(record).find((value) => typeof value === 'string' && /^create\s/i.test(value)) as string | undefined)
    if (!sql) throw new Error(`MySQL did not return DDL for ${object.type} "${object.name}".`)
    if (object.type === 'table') warnings.push('Indexes are listed separately in the catalog.')
    return { sql: sql.trim().replace(/;+\s*$/, '') + ';', warnings }
  }

  async graph(schema?: string): Promise<SchemaGraph> {
    const effectiveSchema = schema || this.database
    const connection = this.requireConnection()
    const [tables] = await connection.query<RowDataPacket[]>(
      `select table_name as name from information_schema.tables
       where table_schema = ? and table_type in ('BASE TABLE','VIEW')
       order by table_name limit 60`,
      [effectiveSchema]
    )
    const names = tables.map((row) => String(row.name))
    if (names.length === 0) return { nodes: [], edges: [] }
    const placeholders = names.map(() => '?').join(',')
    const [columns] = await connection.query<RowDataPacket[]>(
      `select table_name as \`table\`, column_name as name, column_type as type, is_nullable, column_default
       from information_schema.columns
       where table_schema = ? and table_name in (${placeholders})
       order by table_name, ordinal_position`,
      [effectiveSchema, ...names]
    )
    const byTable = new Map<string, TableDetails['columns']>()
    for (const row of columns) {
      const table = String(row.table)
      if (!byTable.has(table)) byTable.set(table, [])
      byTable.get(table)!.push({
        name: String(row.name),
        type: String(row.type),
        nullable: row.is_nullable === 'YES',
        defaultValue: (row.column_default as string | null) ?? null
      })
    }
    const [fks] = await connection.query<RowDataPacket[]>(
      `select table_name as \`table\`, column_name as \`column\`,
              referenced_table_name as ref_table, referenced_column_name as ref_column
       from information_schema.key_column_usage
       where referenced_table_name is not null and table_schema = ?`,
      [effectiveSchema]
    )
    return {
      nodes: names.map((name) => ({
        id: `${effectiveSchema}.${name}`,
        label: name,
        schema: effectiveSchema,
        columns: byTable.get(name) ?? []
      })),
      edges: fks.map((row, index) => ({
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
    return clipContext(`MySQL schema:\n${parts.join('\n')}`)
  }
}
