import { createHash } from 'node:crypto'
import type {
  CsvImportRequest,
  DbKind,
  KillSessionRequest,
  RowUpdateRequest,
  TableDetails,
  TablePageRequest
} from '@shared/types'

export function quoteIdent(kind: DbKind, name: string): string {
  if (kind === 'mysql' || kind === 'sqlite') {
    return `\`${name.replace(/`/g, '``')}\``
  }
  if (kind === 'mssql') {
    return `[${name.replace(/]/g, ']]')}]`
  }
  return `"${name.replace(/"/g, '""')}"`
}

export function qualifiedTable(
  kind: DbKind,
  schema: string | undefined,
  table: string
): string {
  return schema
    ? `${quoteIdent(kind, schema)}.${quoteIdent(kind, table)}`
    : quoteIdent(kind, table)
}

function placeholder(kind: DbKind, index: number): string {
  return kind === 'postgres' ? `$${index}` : '?'
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)])
    )
  }
  return value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function validColumn(details: TableDetails, name: string): boolean {
  return details.columns.some((column) => column.name === name)
}

export function buildTablePageSql(
  kind: DbKind,
  details: TableDetails,
  request: TablePageRequest
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const columns = details.columns.map((column) => quoteIdent(kind, column.name))
  const select = columns.length > 0 ? columns.join(', ') : '*'
  const table = qualifiedTable(kind, details.schema ?? request.schema, details.table)
  const where: string[] = []

  for (const filter of request.filters ?? []) {
    if (!validColumn(details, filter.column)) continue
    const column = quoteIdent(kind, filter.column)
    if (filter.op === 'isNull') {
      where.push(`${column} IS NULL`)
    } else if (filter.op === 'isNotNull') {
      where.push(`${column} IS NOT NULL`)
    } else {
      where.push(`${column} ${filter.op === 'like' ? 'LIKE' : '='} ${placeholder(kind, params.length + 1)}`)
      params.push(filter.value)
    }
  }

  const order = request.orderBy
  const orderColumn =
    order && validColumn(details, order.column)
      ? quoteIdent(kind, order.column)
      : details.primaryKey[0]
        ? quoteIdent(kind, details.primaryKey[0])
        : null
  const orderSql = orderColumn
    ? `ORDER BY ${orderColumn} ${order?.direction === 'desc' ? 'DESC' : 'ASC'}`
    : kind === 'mssql'
      ? 'ORDER BY (SELECT NULL)'
      : ''

  const limit = Math.min(500, Math.max(1, Math.floor(request.limit)))
  const offset = Math.max(0, Math.floor(request.offset))
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  if (kind === 'mssql') {
    return {
      sql: `SELECT ${select} FROM ${table} ${whereSql} ${orderSql} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
      params
    }
  }

  if (kind === 'firebird') {
    // Firebird has no LIMIT/OFFSET. FIRST/SKIP is the dialect-native form.
    return {
      sql: `SELECT FIRST ${limit} SKIP ${offset} ${select} FROM ${table} ${whereSql} ${orderSql}`,
      params
    }
  }

  return {
    sql: `SELECT ${select} FROM ${table} ${whereSql} ${orderSql} LIMIT ${limit} OFFSET ${offset}`,
    params
  }
}

export function buildRowUpdateSql(
  kind: DbKind,
  details: TableDetails,
  request: RowUpdateRequest
): { sql: string; params: unknown[]; warnings: string[] } {
  if (details.primaryKey.length === 0) {
    throw new Error('This table has no primary key. Row editing is disabled.')
  }

  const changes = Object.entries(request.changes)
  if (changes.length === 0) throw new Error('No cell changes to apply.')
  for (const [column] of changes) {
    if (!validColumn(details, column)) throw new Error(`Unknown column: ${column}`)
    if (details.primaryKey.includes(column)) {
      throw new Error('Primary key columns cannot be edited in place.')
    }
  }
  for (const key of details.primaryKey) {
    if (!(key in request.identity)) throw new Error(`Missing primary key value: ${key}`)
  }

  const params: unknown[] = []
  const assignments = changes.map(([column, value]) => {
    params.push(value)
    return `${quoteIdent(kind, column)} = ${placeholder(kind, params.length)}`
  })

  const where: string[] = []
  for (const key of details.primaryKey) {
    if (request.identity[key] === null) {
      where.push(`${quoteIdent(kind, key)} IS NULL`)
    } else {
      params.push(request.identity[key])
      where.push(`${quoteIdent(kind, key)} = ${placeholder(kind, params.length)}`)
    }
  }

  for (const [column, oldValue] of Object.entries(request.expected ?? {})) {
    if (!validColumn(details, column)) continue
    if (oldValue === null) {
      where.push(`${quoteIdent(kind, column)} IS NULL`)
    } else {
      params.push(oldValue)
      where.push(`${quoteIdent(kind, column)} = ${placeholder(kind, params.length)}`)
    }
  }

  const table = qualifiedTable(kind, details.schema ?? request.schema, details.table)
  return {
    sql: `UPDATE ${table} SET ${assignments.join(', ')} WHERE ${where.join(' AND ')}`,
    params,
    warnings: []
  }
}

export function rowUpdateDetail(request: RowUpdateRequest): string {
  return [
    'row-update',
    request.connectionId,
    `${request.schema ?? ''}.${request.table}`,
    stableStringify(request.identity),
    stableStringify(request.changes),
    stableStringify(request.expected)
  ].join('|')
}

/**
 * Token canônico do kill (Corte 2 parte 3).
 * Mesmo padrão estável do rowUpdateDetail: mesma entrada gera sempre o
 * mesmo detailHash; qualquer troca de conexão/sessão/modo invalida o token.
 * Single-use + TTL ficam no mapa de tokens em security.ts.
 */
export function sessionKillDetail(request: KillSessionRequest): string {
  const mode = request.mode ?? 'terminate'
  return ['session-kill', request.connectionId, String(request.sessionId), mode].join('|')
}

/**
 * Canonical digest of the CSV payload. The token binds to the exact bytes
 * (BOM stripped), the column mapping and the target table, so a changed file,
 * a remapped column or a different table invalidates a previously issued
 * confirmation token.
 */
export function csvContentHash(
  csvText: string,
  mapping: Record<string, string>,
  schema: string | undefined,
  table: string,
  options: Pick<CsvImportRequest, 'delimiter' | 'nullValues' | 'hasHeader'> = {}
): string {
  const normalized = csvText.replace(/^﻿/, '')
  return createHash('sha256')
    .update(normalized, 'utf8')
    .update('|', 'utf8')
    .update(stableStringify(mapping), 'utf8')
    .update('|', 'utf8')
    .update(`${schema ?? ''}.${table}`, 'utf8')
    .update('|', 'utf8')
    .update(
      stableStringify({
        delimiter: options.delimiter ?? '',
        nullValues: options.nullValues ?? ['', 'NULL', '\\N'],
        hasHeader: options.hasHeader ?? true
      }),
      'utf8'
    )
    .digest('hex')
}

export function importCsvDetail(
  request: Pick<
    CsvImportRequest,
    'connectionId' | 'schema' | 'table' | 'mapping' | 'csvText' | 'delimiter' | 'nullValues' | 'hasHeader'
  >
): string {
  return [
    'import-csv',
    request.connectionId,
    `${request.schema ?? ''}.${request.table}`,
    stableStringify(request.mapping),
    csvContentHash(request.csvText, request.mapping, request.schema, request.table, request)
  ].join('|')
}

/**
 * Single-row parametrized INSERT reused for every row of the bulk load.
 * Data never touches the SQL string: values travel exclusively via params.
 */
export function buildCsvInsertSql(
  kind: DbKind,
  details: TableDetails,
  targetColumns: string[]
): { sql: string; warnings: string[] } {
  if (targetColumns.length === 0) throw new Error('No CSV columns mapped to table columns.')
  for (const column of targetColumns) {
    if (!validColumn(details, column)) throw new Error(`Unknown column: ${column}`)
  }
  const table = qualifiedTable(kind, details.schema, details.table)
  const columns = targetColumns.map((column) => quoteIdent(kind, column))
  const placeholders = targetColumns.map((_, index) => placeholder(kind, index + 1))
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    warnings: []
  }
}
