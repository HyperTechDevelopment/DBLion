import { app } from 'electron'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'sql.js'
import type {
  ConnectionConfig,
  SchemaCatalog,
  SchemaDdl,
  SchemaGraph,
  SchemaObjectRef,
  TableDetails,
  TableInfo
} from '@shared/types'
import { isReadOnlyAccess } from '@shared/access'
import { splitStatements, stripSqlComments } from '@shared/sql'
import type { ColumnRef, DbAdapter, ExplainRaw, QueryOptions } from './types'
import { buildExplainSql } from './explain'
import { openSqliteDatabase, applySqliteQueryOnly, clearSqliteQueryOnly } from './sqliteSession'
import {
  clipContext,
  compactColumns,
  ensureWritable,
  isReadOnlySql,
  limitedReadSql,
  makeResult,
  markTruncated
} from './common'

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Upper bound on `pragma table_info` calls in one columnsIndex() read. */
const COLUMNS_INDEX_MAX_TABLES = 200

function locateSqlWasm(file: string): string {
  const candidates = [
    path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'sql.js',
      'dist',
      file
    ),
    path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', file)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export class SqliteAdapter implements DbAdapter {
  readonly kind = 'sqlite'
  private db: Database | null = null
  private file = ''
  private transactionOpen = false
  /** Mirrors ConnectionConfig.accessMode; guards every statement. */
  private readOnly = false

  private requireDb(): Database {
    if (!this.db) throw new Error('Not connected')
    return this.db
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.file = config.file ?? config.connectionString ?? ''
    if (!this.file) throw new Error('SQLite file path is required')
    const readOnly = isReadOnlyAccess(config)
    const opened = await openSqliteDatabase({
      file: this.file,
      readOnly,
      locateFile: locateSqlWasm
    })
    if (readOnly && !opened.readOnlyEnforced) {
      opened.db.close()
      throw new Error(
        'SQLite refused to enable PRAGMA query_only, so this read-only connection cannot be guaranteed. Open the file with a read-write connection or fix the database file.'
      )
    }
    this.db = opened.db
    this.readOnly = readOnly
    this.transactionOpen = false
  }

  async disconnect(): Promise<void> {
    this.db?.close()
    this.db = null
    this.readOnly = false
  }

  async begin(): Promise<void> {
    this.requireDb().exec('BEGIN')
    this.transactionOpen = true
  }

  async commit(): Promise<void> {
    this.requireDb().exec('COMMIT')
    this.transactionOpen = false
    await this.persist()
  }

  async rollback(): Promise<void> {
    this.requireDb().exec('ROLLBACK')
    this.transactionOpen = false
  }

  async serverVersion(): Promise<string> {
    const result = this.requireDb().exec('select sqlite_version() as version')
    return String(result[0]?.values?.[0]?.[0] ?? 'SQLite')
  }

  async explain(sql: string): Promise<ExplainRaw> {
    const explainSql = buildExplainSql('sqlite', sql, false)
    if (!explainSql) throw new Error('Explain is not supported for sqlite connections.')
    const db = this.requireDb()
    const results = db.exec(explainSql)
    const last = results[results.length - 1]
    const columns = last?.columns ?? []
    const rows = (last?.values ?? []).map((values) => {
      const row: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        row[column] = values[index]
      })
      return row
    })
    return { columns, rows }
  }

  private async persist(): Promise<void> {
    if (!this.db || !this.file) return
    // A read-only connection never writes the file back.
    if (this.readOnly) return
    const data = this.db.export()
    await fs.writeFile(this.file, Buffer.from(data))
  }

  async query(
    sql: string,
    params: unknown[] = [],
    allowWrites = false,
    options: QueryOptions = {}
  ) {
    ensureWritable(sql, allowWrites, this.readOnly)
    if (splitStatements(stripSqlComments(sql)).length > 1) {
      throw new Error('Multiple statements are not allowed in a single query.')
    }
    const started = Date.now()
    const db = this.requireDb()
    const effectiveSql = limitedReadSql(sql, options.maxRows, 'sqlite')
    // PRAGMA query_only is connection-wide, so the fence is only taken when the
    // connection is not already read-only. It is cleared in `finally`. A
    // concurrent write on this connection fails safe while the fence is held.
    const fence = options.readOnlyTransaction === true && !this.readOnly
    if (fence && !applySqliteQueryOnly(db)) {
      throw new Error(
        'AI read blocked: SQLite refused to enable PRAGMA query_only for this statement.'
      )
    }

    try {
      if (params.length > 0) {
        const statement = db.prepare(effectiveSql)
        statement.bind(params as never[])
        const rows: Record<string, unknown>[] = []
        const columns: string[] = []
        const hardStop = options.maxRows ? options.maxRows + 1 : Infinity
        while (rows.length < hardStop && statement.step()) {
          const row = statement.getAsObject() as Record<string, unknown>
          if (columns.length === 0) columns.push(...Object.keys(row))
          rows.push(row)
        }
        statement.free()
        const output = makeResult(columns, rows, Date.now() - started, sql.trim().split(/\s+/)[0]?.toUpperCase())
        if (columns.length === 0) output.rowCount = db.getRowsModified()
        if (!isReadOnlySql(sql) && !this.transactionOpen) await this.persist()
        return markTruncated(output, options.maxRows)
      }

      const results = db.exec(effectiveSql)
      const last = results[results.length - 1]
      const columns = last?.columns ?? []
      const rows = (last?.values ?? []).map((values) => {
        const row: Record<string, unknown> = {}
        columns.forEach((column, index) => {
          row[column] = values[index]
        })
        return row
      })
      const output = makeResult(columns, rows, Date.now() - started, sql.trim().split(/\s+/)[0]?.toUpperCase())
      if (columns.length === 0) output.rowCount = db.getRowsModified()
      if (!isReadOnlySql(sql) && !this.transactionOpen) await this.persist()
      return markTruncated(output, options.maxRows)
    } finally {
      if (fence) clearSqliteQueryOnly(db)
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = this.requireDb().exec(
      `select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name`
    )
    const rows = result[0]?.values ?? []
    return rows.map((row) => ({ name: String(row[0]), type: String(row[1]) }))
  }

  async describeTable(_schema: string | undefined, table: string): Promise<TableDetails> {
    const db = this.requireDb()
    const info = db.exec(`PRAGMA table_info(${quoteIdent(table)})`)
    const fk = db.exec(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
    const columns = (info[0]?.values ?? []).map((row) => ({
      name: String(row[1]),
      type: String(row[2] || ''),
      nullable: Number(row[3]) === 0,
      primaryKey: Number(row[5]) > 0,
      defaultValue: row[4] == null ? null : String(row[4])
    }))
    const foreignKeys = (fk[0]?.values ?? []).map((row) => ({
      table,
      column: String(row[3]),
      refTable: String(row[2]),
      refColumn: String(row[4]),
      constraintName: `fk_${row[0]}`
    }))
    return {
      table,
      columns,
      primaryKey: columns.filter((column) => column.primaryKey).map((column) => column.name),
      foreignKeys
    }
  }

  /**
   * Column names for the AI ranking. SQLite has no catalog-wide column table, so
   * this is one `pragma table_info` per table, bounded to keep it cheap.
   */
  async columnsIndex(): Promise<ColumnRef[]> {
    const db = this.requireDb()
    const tables = await this.listTables()
    const columns: ColumnRef[] = []
    for (const table of tables.slice(0, COLUMNS_INDEX_MAX_TABLES)) {
      const info = db.exec(`PRAGMA table_info(${quoteIdent(table.name)})`)
      for (const row of info[0]?.values ?? []) {
        columns.push({ schema: undefined, table: table.name, column: String(row[1]) })
      }
    }
    return columns
  }

  async catalog(): Promise<SchemaCatalog> {
    const result = this.requireDb().exec(
      `select type, name, tbl_name, sql from sqlite_master
       where type in ('table','view','index','trigger')
         and name not like 'sqlite_%'
       order by case type when 'table' then 0 when 'view' then 1 when 'index' then 2 else 3 end, name
       limit 1001`
    )
    const rows = result[0]?.values ?? []
    const objects = rows.slice(0, 1000).map((row) => ({
      name: String(row[1]),
      type: String(row[0]) as 'table' | 'view' | 'index' | 'trigger',
      parent: row[2] != null ? String(row[2]) : undefined
    }))
    return { objects, truncated: rows.length > 1000 }
  }

  async ddl(object: SchemaObjectRef): Promise<SchemaDdl> {
    const db = this.requireDb()
    const statement = db.prepare(
      `select sql from sqlite_master where name = ? and type = ? limit 1`
    )
    try {
      statement.bind([object.name, object.type])
      const row = statement.step() ? statement.getAsObject() : null
      const sql = row?.sql == null ? '' : String(row.sql)
      if (!sql.trim()) {
        throw new Error(`SQLite has no stored DDL for ${object.type} "${object.name}".`)
      }
      return {
        sql: `${sql.trim().replace(/;+\s*$/, '')};`,
        warnings:
          object.type === 'index'
            ? ['SQLite indexes are stored in sqlite_master; auto-generated indexes have no DDL.']
            : []
      }
    } finally {
      statement.free()
    }
  }

  async graph(): Promise<SchemaGraph> {
    const tables = (await this.listTables()).slice(0, 60)
    const nodes = []
    const edges: SchemaGraph['edges'] = []
    for (const table of tables) {
      const details = await this.describeTable(undefined, table.name)
      nodes.push({
        id: table.name,
        label: table.name,
        columns: details.columns
      })
      for (const foreignKey of details.foreignKeys) {
        edges.push({
          id: `fk-${table.name}-${foreignKey.column}-${foreignKey.refTable}-${foreignKey.refColumn}`,
          source: table.name,
          target: foreignKey.refTable,
          label: `${foreignKey.column} → ${foreignKey.refColumn}`
        })
      }
    }
    return { nodes, edges }
  }

  async buildContext(): Promise<string> {
    const tables = await this.listTables()
    const parts: string[] = []
    for (const table of tables.slice(0, 80)) {
      const details = await this.describeTable(undefined, table.name)
      parts.push(`${table.name}(${compactColumns(details.columns)})`)
    }
    return clipContext(`SQLite schema:\n${parts.join('\n')}`)
  }
}
