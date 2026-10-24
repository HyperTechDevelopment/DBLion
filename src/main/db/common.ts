import { classifySql, isSessionKillSql } from '@shared/sql'
import { isReadOnlyGuardBypass } from './guard'
import type { ColumnInfo, QueryResult } from '@shared/types'

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
}

export function isReadOnlySql(sql: string): boolean {
  return classifySql(sql) === 'read'
}

export function ensureWritable(sql: string, allowWrites: boolean, readOnly = false): void {
  // Defesa em profundidade: kill nunca passa por db:query, mesmo com writes on.
  if (isSessionKillSql(sql)) {
    throw new Error(
      'Session termination is blocked in free SQL. Use Sessions → Kill with confirmation (db:kill-session).'
    )
  }
  // Conexão read-only: só o classificador `read` passa, independente do toggle
  // e dos tokens. Terceira camada, depois do gate em main/db/index.ts e do IPC.
  if (readOnly) {
    if (!isReadOnlySql(sql)) {
      throw new Error(
        'This connection is read-only. Only read statements are allowed; connect a read-write profile to write.'
      )
    }
    if (isReadOnlyGuardBypass(sql)) {
      throw new Error(
        'This connection is read-only. The statement would disable the read-only session guard and was blocked.'
      )
    }
  }
  if (!allowWrites && !isReadOnlySql(sql)) {
    throw new Error(
      'DBLion is in read-only mode. Enable writes for this connection or confirm the statement first.'
    )
  }
}

export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  if (Array.isArray(value)) return value.map(serializeValue)
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return String(value)
    }
  }
  return value
}

export function makeResult(
  columns: string[],
  rows: Record<string, unknown>[],
  durationMs: number,
  command?: string,
  notice?: string
): QueryResult {
  return {
    columns,
    rows: rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) out[key] = serializeValue(value)
      return out
    }),
    rowCount: rows.length,
    durationMs,
    command,
    notice
  }
}

export function limitedReadSql(
  sql: string,
  maxRows: number | undefined,
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'mssql'
): string {
  if (!maxRows || maxRows <= 0 || !isReadOnlySql(sql)) return sql
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  if (!/^(select|with)\b/i.test(trimmed)) return sql
  if (/\b(for\s+update|for\s+share|into\s+)\b/i.test(trimmed)) return sql
  const limit = Math.max(1, Math.floor(maxRows)) + 1
  if (dialect === 'mssql') {
    // A derived table cannot preserve a top-level ORDER BY without TOP/OFFSET.
    if (/\border\s+by\b/i.test(trimmed)) return sql
    return `SELECT TOP ${limit} * FROM (${trimmed}) AS __dblion_limit`
  }
  return `SELECT * FROM (${trimmed}) AS __dblion_limit LIMIT ${limit}`
}

export function markTruncated(
  result: QueryResult,
  maxRows: number | undefined
): QueryResult {
  if (!maxRows || result.rows.length <= maxRows) return result
  result.rows = result.rows.slice(0, maxRows)
  result.rowCount = result.rows.length
  result.truncated = true
  return result
}

export function compactColumns(columns: ColumnInfo[]): string {
  return columns
    .map((column) => {
      const comment = column.comment?.trim().replace(/\s+/g, ' ').slice(0, 80)
      return `${column.name}:${column.type}${column.primaryKey ? ' PK' : ''}${comment ? ` /* ${comment} */` : ''}`
    })
    .join(', ')
}

export function clipContext(text: string, max = 16000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... [schema context truncated]`
}
