import type { CsvImportRequest, DbKind, TableDetails } from '@shared/types'

export const MAX_CSV_ROWS = 5000
export const MAX_CSV_BYTES = 5_000_000

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const

export interface ParsedCsv {
  headers: string[]
  rows: string[][]
  delimiter: string
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '')
}

function detectDelimiter(sampleLines: string[]): string {
  let best: string = ','
  let bestScore = -1
  for (const candidate of CANDIDATE_DELIMITERS) {
    let score = 0
    for (const line of sampleLines) {
      let count = 0
      let inQuotes = false
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i]
        if (char === '"') {
          if (line[i + 1] === '"') {
            i += 1
            continue
          }
          inQuotes = !inQuotes
          continue
        }
        if (!inQuotes && char === candidate) count += 1
      }
      score += count
    }
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** Minimal RFC-4180 reader: quotes, escaped "", CRLF/LF inside quotes. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let hasData = false
  const pushField = (): void => {
    record.push(field)
    field = ''
    hasData = true
  }
  const pushRecord = (): void => {
    if (hasData || record.length > 0) {
      records.push(record)
      record = []
      hasData = false
    }
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      pushField()
      continue
    }
    if (char === '\r') {
      if (text[i + 1] === '\n') i += 1
      pushField()
      pushRecord()
      continue
    }
    if (char === '\n') {
      pushField()
      pushRecord()
      continue
    }
    field += char
  }
  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field.')
  pushField()
  pushRecord()
  return records
}

export function parseCsvText(request: Pick<CsvImportRequest, 'csvText' | 'delimiter' | 'hasHeader'>): ParsedCsv {
  const raw = stripBom(request.csvText)
  if (!raw.trim()) throw new Error('The CSV file is empty.')
  if (Buffer.byteLength(raw, 'utf8') > MAX_CSV_BYTES) {
    throw new Error(
      `CSV exceeds the ${Math.floor(MAX_CSV_BYTES / 1_000_000)}MB limit. Split the file and import in batches.`
    )
  }
  const delimiter = request.delimiter ?? detectDelimiter(raw.split(/\r?\n/).slice(0, 5).filter((line) => line.trim()))
  if (delimiter.length !== 1 || !([...CANDIDATE_DELIMITERS] as string[]).includes(delimiter)) {
    throw new Error(`Unsupported delimiter "${request.delimiter}". Use one of , ; tab | .`)
  }
  const records = splitRecords(raw, delimiter)
  // Drop fully blank lines (whitespace-only cells) so trailing newlines don't count as rows.
  const nonBlank = records.filter((record) => record.some((cell) => cell.trim() !== ''))
  if (nonBlank.length === 0) throw new Error('The CSV file is empty.')
  const hasHeader = request.hasHeader ?? true
  let headers: string[]
  let body: string[][]
  if (hasHeader) {
    headers = nonBlank[0].map((cell) => cell.trim())
    body = nonBlank.slice(1)
    if (headers.some((header) => !header)) {
      throw new Error('CSV header has an empty column name. Rename it or map columns explicitly.')
    }
    const seen = new Set<string>()
    for (const header of headers) {
      if (seen.has(header)) throw new Error(`CSV header has a duplicated column: "${header}".`)
      seen.add(header)
    }
  } else {
    const width = nonBlank[0].length
    headers = Array.from({ length: width }, (_, index) => `c${index + 1}`)
    body = nonBlank
  }
  if (body.length === 0) throw new Error('The CSV has a header but no data rows.')
  if (body.length > MAX_CSV_ROWS) {
    throw new Error(
      `CSV has ${body.length} rows, above the limit of ${MAX_CSV_ROWS}. Split the file and import in batches.`
    )
  }
  const width = headers.length
  body.forEach((row, index) => {
    if (row.length !== width) {
      throw new Error(`Row ${index + (hasHeader ? 2 : 1)} has ${row.length} values, expected ${width}.`)
    }
  })
  return { headers, rows: body, delimiter }
}

// ---------------------------------------------------------------------------
// Type whitelist + coercion per dialect
// ---------------------------------------------------------------------------

const TYPE_ALIASES: Record<string, string> = {
  'character varying': 'varchar',
  character: 'char',
  'national character varying': 'nvarchar',
  'national character': 'nchar',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  'double precision': 'double',
  'bit varying': 'varbit',
  'character large object': 'text'
}

function baseType(columnType: string): string {
  const base = columnType.split('(')[0]?.trim().toLowerCase() ?? ''
  return TYPE_ALIASES[base] ?? base
}

const INT_BASES = new Set([
  'smallint', 'int2', 'integer', 'int', 'int4', 'mediumint', 'bigint', 'int8',
  'tinyint', 'serial', 'bigserial', 'year'
])
const FLOAT_BASES = new Set(['decimal', 'numeric', 'number', 'real', 'double', 'float', 'money'])
const BOOL_BASES = new Set(['boolean', 'bool', 'bit'])
const TEXT_BASES = new Set([
  'char', 'character', 'varchar', 'varying', 'nchar', 'nvarchar', 'ntext',
  'text', 'tinytext', 'mediumtext', 'longtext', 'citext', 'enum', 'set',
  'binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob', 'bytea', 'image'
])
const DATE_BASES = new Set([
  'date', 'time', 'timetz', 'datetime', 'timestamp', 'timestamptz', 'smalldatetime', 'datetime2'
])
const JSON_BASES = new Set(['json', 'jsonb'])
const UUID_BASES = new Set(['uuid', 'uniqueidentifier'])

const ALLOWED_BY_DIALECT: Record<DbKind, Set<string>> = {
  postgres: new Set([...INT_BASES, ...FLOAT_BASES, ...BOOL_BASES, ...TEXT_BASES, ...DATE_BASES, ...JSON_BASES, ...UUID_BASES]),
  mysql: new Set([...INT_BASES, ...FLOAT_BASES, ...BOOL_BASES, ...TEXT_BASES, ...DATE_BASES, ...JSON_BASES]),
  sqlite: new Set([...INT_BASES, ...FLOAT_BASES, ...BOOL_BASES, ...TEXT_BASES, ...DATE_BASES, ...JSON_BASES, ...UUID_BASES]),
  mssql: new Set([...INT_BASES, ...FLOAT_BASES, ...BOOL_BASES, ...TEXT_BASES, ...DATE_BASES, ...JSON_BASES, ...UUID_BASES]),
  firebird: new Set([...INT_BASES, ...FLOAT_BASES, ...BOOL_BASES, ...TEXT_BASES, ...DATE_BASES, ...JSON_BASES, ...UUID_BASES]),
  mongodb: new Set(),
  redis: new Set()
}

export function assertSupportedColumnTypes(
  kind: DbKind,
  details: TableDetails,
  targetColumns: string[]
): void {
  const allowed = ALLOWED_BY_DIALECT[kind]
  for (const name of targetColumns) {
    const column = details.columns.find((item) => item.name === name)
    if (!column) throw new Error(`Unknown column: ${name}`)
    if (!allowed.has(baseType(column.type))) {
      throw new Error(
        `Unsupported column type "${column.type}" on "${name}" for CSV import (${kind}).`
      )
    }
  }
}

const TRUE_TOKENS = new Set(['true', 't', '1', 'yes', 'y', 'sim', 's'])
const FALSE_TOKENS = new Set(['false', 'f', '0', 'no', 'n', 'nao', 'não'])

export function coerceValue(raw: string | null, columnType: string, rowNumber: number, columnName: string): unknown {
  if (raw === null) return null
  const base = baseType(columnType)
  if (TEXT_BASES.has(base) && !JSON_BASES.has(base)) return raw
  const trimmed = raw.trim()
  if (INT_BASES.has(base)) {
    if (!/^[-+]?\d+$/.test(trimmed)) {
      throw new Error(`Row ${rowNumber}: column "${columnName}" is not a valid integer ("${raw}").`)
    }
    const value = Number(trimmed)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Row ${rowNumber}: column "${columnName}" integer out of range ("${raw}").`)
    }
    return value
  }
  if (FLOAT_BASES.has(base)) {
    if (trimmed === '') return null
    const value = Number(trimmed)
    if (Number.isNaN(value)) {
      throw new Error(`Row ${rowNumber}: column "${columnName}" is not a valid number ("${raw}").`)
    }
    return value
  }
  if (BOOL_BASES.has(base)) {
    const lower = trimmed.toLowerCase()
    if (TRUE_TOKENS.has(lower)) return true
    if (FALSE_TOKENS.has(lower)) return false
    throw new Error(`Row ${rowNumber}: column "${columnName}" is not a valid boolean ("${raw}").`)
  }
  if (JSON_BASES.has(base)) {
    try {
      JSON.parse(trimmed)
    } catch {
      throw new Error(`Row ${rowNumber}: column "${columnName}" is not valid JSON.`)
    }
    return trimmed
  }
  if (UUID_BASES.has(base)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
      throw new Error(`Row ${rowNumber}: column "${columnName}" is not a valid UUID ("${raw}").`)
    }
    return trimmed
  }
  // Dates, times and timestamps: pass through and let the database validate.
  return trimmed === '' ? null : trimmed
}

export interface CoercedCsv {
  targetColumns: string[]
  values: unknown[][]
  warnings: string[]
}

/**
 * Resolves the CSV->table mapping against the catalog and coerces every cell.
 * Empty strings and the configured null tokens become NULL.
 */
export function coerceCsvRows(
  kind: DbKind,
  details: TableDetails,
  request: Pick<CsvImportRequest, 'mapping' | 'nullValues' | 'hasHeader'>,
  parsed: ParsedCsv
): CoercedCsv {
  const requestedMapping = request.mapping ?? {}
  const mapping =
    Object.keys(requestedMapping).length > 0
      ? requestedMapping
      : Object.fromEntries(
          parsed.headers
            .map((header) => {
              const target = details.columns.find(
                (column) => column.name.toLowerCase() === header.trim().toLowerCase()
              )
              return target ? [header, target.name] : null
            })
            .filter((pair): pair is [string, string] => pair !== null)
        )
  const headerSet = new Set(parsed.headers)
  for (const key of Object.keys(mapping)) {
    if (!headerSet.has(key)) throw new Error(`Mapping refers to unknown CSV column: "${key}".`)
  }
  const warnings: string[] = []
  const unmapped = parsed.headers.filter((header) => !(header in mapping))
  if (unmapped.length > 0) {
    warnings.push(`Ignored CSV columns with no mapping: ${unmapped.join(', ')}.`)
  }
  // Deterministic column order: CSV header order.
  const headerIndex = new Map(parsed.headers.map((header, index) => [header, index] as const))
  const pairs = parsed.headers
    .filter((header) => header in mapping)
    .map((header) => ({ header, target: mapping[header] }))
  const targetColumns = pairs.map((pair) => pair.target)
  if (targetColumns.length === 0) {
    throw new Error('No CSV columns mapped. Map at least one CSV column to a table column.')
  }
  const seenTargets = new Set<string>()
  for (const target of targetColumns) {
    if (seenTargets.has(target)) {
      throw new Error(`Two CSV columns map to the same table column: "${target}".`)
    }
    seenTargets.add(target)
    if (!details.columns.some((column) => column.name === target)) {
      throw new Error(`Unknown column: ${target}`)
    }
  }
  assertSupportedColumnTypes(kind, details, targetColumns)

  const nullTokens = new Set(
    (request.nullValues ?? ['', 'NULL', '\\N']).map((token) => token.toLowerCase())
  )
  // Empty string always means NULL (documented); keeps NOT NULL violations loud at the DB.
  nullTokens.add('')
  const columnByName = new Map(details.columns.map((column) => [column.name, column] as const))
  const values: unknown[][] = parsed.rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + (request.hasHeader === false ? 1 : 2)
    return pairs.map(({ header, target }) => {
      const cell = row[headerIndex.get(header) as number] ?? ''
      const isNull = nullTokens.has(cell.toLowerCase())
      const column = columnByName.get(target)
      if (!column) throw new Error(`Unknown column: ${target}`)
      return coerceValue(isNull ? null : cell, column.type, rowNumber, target)
    })
  })

  const filledTargets = new Set(targetColumns)
  for (const column of details.columns) {
    if (filledTargets.has(column.name)) continue
    if (!column.nullable && column.defaultValue == null) {
      warnings.push(
        `Table column "${column.name}" has no mapping and no default; the database must supply it or the import fails.`
      )
    }
  }
  if (details.primaryKey.length === 0) {
    warnings.push('Target table has no primary key. Import requires allowWrites and AI mode “full”.')
  } else {
    warnings.push('Empty cells are imported as NULL.')
  }
  return { targetColumns, values, warnings }
}
