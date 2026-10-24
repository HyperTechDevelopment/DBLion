import { createHash } from 'node:crypto'
import type { ColumnInfo, DbKind, TableDetails } from '@shared/types'
import { describe, getRuntime, query } from '../db/index'
import { buildTablePageSql, quoteIdent } from '../db/sqlBuilder'
import { redactText } from './redact'

const PII_COLUMN =
  /(e-?mail|cpf|cnpj|phone|telefone|celular|address|endereco|card|cartao|token|secret|password|senha|ssn|passport|nome|name)/i

const MAX_PROFILE_COLUMNS = 12
const MAX_TOP_VALUE_COLUMNS = 3
const MAX_SAMPLE_ROWS = 25
const MAX_SAMPLE_CHARS = 8_000

export interface DataRequest {
  connectionId: string
  schema?: string
  tables: string[]
}

export interface ColumnProfile {
  name: string
  type: string
  nonNull: number
  nulls: number
  distinct: number
  min?: string
  max?: string
  top?: Array<{ hash: string; count: number }>
  redacted?: boolean
}

export interface TableProfile {
  schema?: string
  table: string
  totalRows: number
  columns: ColumnProfile[]
  warning?: string
}

export interface SampleResult {
  schema?: string
  table: string
  columns: string[]
  rows: Record<string, unknown>[]
  maskedCells: number
  truncated: boolean
}

function qualified(kind: DbKind, schema: string | undefined, table: string): string {
  return schema
    ? `${quoteIdent(kind, schema)}.${quoteIdent(kind, table)}`
    : quoteIdent(kind, table)
}

/** `schema.table` is accepted for engines that have schemas; Firebird/SQLite names may contain dots. */
function resolveTable(
  kind: DbKind,
  requestSchema: string | undefined,
  name: string
): { schema?: string; table: string } {
  if (requestSchema) return { schema: requestSchema, table: name }
  if (kind === 'firebird' || kind === 'sqlite') return { table: name }
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { table: name }
  return { schema: name.slice(0, dot), table: name.slice(dot + 1) }
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)
}

function safeText(value: unknown, column: string): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value)
  if (PII_COLUMN.test(column)) return '[redacted]'
  return redactText(text).slice(0, 120)
}

function isTextualType(type: string): boolean {
  const lowered = type.toLowerCase()
  return !/blob|binary|bytea|image|json|xml|geometry|array/.test(lowered)
}

function supportsMinMax(type: string): boolean {
  return isTextualType(type)
}

function buildTopValuesSql(kind: DbKind, details: TableDetails, column: string): string {
  const table = qualified(kind, details.schema, details.table)
  const col = quoteIdent(kind, column)
  const head = `${kind === 'mssql' ? 'select top 5' : 'select'} ${col} as value, count(*) as n from ${table} where ${col} is not null group by ${col} order by n desc`
  if (kind === 'mssql') return head
  if (kind === 'firebird') return `${head} rows 5`
  return `${head} limit 5`
}

function aggregateSql(kind: DbKind, details: TableDetails, columns: ColumnInfo[]): string {
  const table = qualified(kind, details.schema, details.table)
  const parts = ['count(*) as total']
  columns.forEach((column, index) => {
    const col = quoteIdent(kind, column.name)
    parts.push(`count(${col}) as c${index}_nn`)
    if (supportsMinMax(column.type)) {
      parts.push(`count(distinct ${col}) as c${index}_d`)
    }
    if (supportsMinMax(column.type)) {
      parts.push(`min(${col}) as c${index}_min`)
      parts.push(`max(${col}) as c${index}_max`)
    }
  })
  return `${kind === 'mssql' ? 'select top 1' : 'select'} ${parts.join(', ')} from ${table}`
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function profileTable(request: DataRequest, table: string): Promise<TableProfile> {
  const runtime = getRuntime(request.connectionId)
  const kind = runtime.config.kind
  const target = resolveTable(kind, request.schema, table)
  const details = await describe(request.connectionId, target.schema, target.table)
  const columns = details.columns.slice(0, MAX_PROFILE_COLUMNS)
  let rows: Record<string, unknown>[]
  try {
    const result = await query(
      request.connectionId,
      aggregateSql(kind, { ...details, schema: target.schema, table: target.table }, columns),
      [],
      false,
      { readOnlyTransaction: true, timeoutMs: 15000, maxRows: 1 }
    )
    rows = result.rows
  } catch (error) {
    const fallback = await query(
      request.connectionId,
      `select count(*) as total from ${qualified(kind, target.schema, target.table)}`,
      [],
      false,
      { readOnlyTransaction: true, timeoutMs: 15000, maxRows: 1 }
    )
    return {
      schema: target.schema,
      table: target.table,
      totalRows: number(fallback.rows[0]?.total),
      columns: [],
      warning: `Column statistics were unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  const total = number(rows[0]?.total)
  const profiles: ColumnProfile[] = columns.map((column, index) => {
    const nonNull = number(rows[0]?.[`c${index}_nn`])
    const min = safeText(rows[0]?.[`c${index}_min`], column.name)
    const max = safeText(rows[0]?.[`c${index}_max`], column.name)
    return {
      name: column.name,
      type: column.type,
      nonNull,
      nulls: Math.max(0, total - nonNull),
      distinct: number(rows[0]?.[`c${index}_d`]),
      min,
      max,
      redacted: PII_COLUMN.test(column.name)
    }
  })

  const topCandidates = profiles
    .filter((profile) => !profile.redacted && isTextualType(profile.type))
    .slice(0, MAX_TOP_VALUE_COLUMNS)
  for (const profile of topCandidates) {
    try {
      const top = await query(
        request.connectionId,
        buildTopValuesSql(
          kind,
          { ...details, schema: target.schema, table: target.table },
          profile.name
        ),
        [],
        false,
        { readOnlyTransaction: true, timeoutMs: 15000, maxRows: 5 }
      )
      profile.top = top.rows.map((row) => ({
        hash: hashValue(row.value),
        count: number(row.n)
      }))
    } catch {
      // Min/max and counts are still useful; top values are optional.
    }
  }

  return {
    schema: target.schema,
    table: target.table,
    totalRows: total,
    columns: profiles
  }
}

function maskCell(column: string, value: unknown): { value: unknown; masked: boolean } {
  if (value === null || value === undefined) return { value, masked: false }
  if (PII_COLUMN.test(column)) return { value: '[redacted]', masked: true }
  if (typeof value === 'string') {
    const masked = redactText(value)
    return { value: masked, masked: masked !== value }
  }
  return { value, masked: false }
}

export async function sampleTable(request: DataRequest, table: string): Promise<SampleResult> {
  const runtime = getRuntime(request.connectionId)
  const kind = runtime.config.kind
  const target = resolveTable(kind, request.schema, table)
  const details = await describe(request.connectionId, target.schema, target.table)
  let sql: string
  let params: unknown[] = []
  if (kind === 'firebird') {
    // buildTablePageSql emits LIMIT/OFFSET, which Firebird's dialect rejects.
    const columns = details.columns
      .map((column) => quoteIdent(kind, column.name))
      .join(', ')
    const order = details.primaryKey.length
      ? ` order by ${details.primaryKey.map((column) => quoteIdent(kind, column)).join(', ')}`
      : ''
    sql = `select first ${MAX_SAMPLE_ROWS} ${columns} from ${qualified(
      kind,
      target.schema,
      target.table
    )}${order}`
  } else {
    const page = buildTablePageSql(kind, details, {
      connectionId: request.connectionId,
      schema: target.schema,
      table: target.table,
      tableType: undefined,
      limit: MAX_SAMPLE_ROWS,
      offset: 0
    })
    sql = page.sql
    params = page.params
  }
  const result = await query(request.connectionId, sql, params, false, {
    readOnlyTransaction: true,
    timeoutMs: 15000,
    maxRows: MAX_SAMPLE_ROWS
  })

  let maskedCells = 0
  const names = Object.keys(result.rows[0] ?? {})
  const rows: Record<string, unknown>[] = []
  for (const row of result.rows) {
    const masked: Record<string, unknown> = {}
    for (const name of names) {
      const cell = maskCell(name, row[name])
      masked[name] = cell.value
      if (cell.masked) maskedCells += 1
    }
    rows.push(masked)
  }

  let serialized = JSON.stringify({ table, columns: names, rows })
  let truncated = false
  while (serialized.length > MAX_SAMPLE_CHARS && rows.length > 1) {
    rows.pop()
    truncated = true
    serialized = JSON.stringify({ table, columns: names, rows })
  }

  return {
    schema: target.schema,
    table: target.table,
    columns: names,
    rows,
    maskedCells,
    truncated
  }
}

export function formatProfileContext(profiles: TableProfile[]): string {
  return profiles
    .map((profile) => {
      const lines = [
        `table ${profile.schema ? `${profile.schema}.` : ''}${profile.table} rows=${profile.totalRows}`
      ]
      if (profile.warning) lines.push(`  warning: ${profile.warning}`)
      for (const column of profile.columns) {
        const top = column.top?.length
          ? ` top=${column.top.map((entry) => `${entry.hash}:${entry.count}`).join(',')}`
          : ''
        lines.push(
          `  ${column.name}: ${column.type} nulls=${column.nulls} distinct=${column.distinct}` +
            (column.min !== undefined ? ` min=${column.min}` : '') +
            (column.max !== undefined ? ` max=${column.max}` : '') +
            top
        )
      }
      return lines.join('\n')
    })
    .join('\n')
}

export function formatSampleContext(samples: SampleResult[]): string {
  return samples
    .map((sample) => {
      const lines = [
        `table ${sample.schema ? `${sample.schema}.` : ''}${sample.table} (${sample.rows.length} rows, masked cells: ${sample.maskedCells})`
      ]
      for (const row of sample.rows) {
        lines.push(
          Object.entries(row)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(' | ')
        )
      }
      if (sample.truncated) lines.push('(truncated to fit the context budget)')
      return lines.join('\n')
    })
    .join('\n')
}
