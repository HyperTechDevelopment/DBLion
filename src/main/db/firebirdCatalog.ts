import type { SchemaCatalog, SchemaDdl, SchemaObjectInfo, SchemaObjectRef } from '@shared/types'

/**
 * Firebird schema introspection.
 *
 * This module is a pure metadata layer: it owns no connection and no driver. It
 * receives a `query` function from the adapter, which is expected to run every
 * statement inside the adapter's read-only transaction. Only `select`
 * statements are ever issued here, and `readOnly()` re-checks that on every
 * call so a future edit cannot slip a write into the metadata path.
 *
 * Nothing in here is executed against a live server yet; the unit tests drive
 * it with a fake query that returns canned RDB$ rows.
 */

/**
 * Runs one statement through the adapter and returns raw rows.
 * Parameters use Firebird `?` placeholders.
 */
export type FirebirdQuery = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/** Catalog cap. Bounds the payload the renderer and the AI context can receive. */
const MAX_OBJECTS = 1000

/** Firebird's VARCHAR ceiling is 32765 bytes; 32000 leaves room for the cast. */
const SOURCE_CAP = 32000

/** The one warning any reconstructed DDL carries. */
const RECONSTRUCTED_WARNING = 'Reconstructed from RDB$ metadata; review before applying.'

/**
 * Statements this module must never issue. `rdb$delete_rule` and
 * `rdb$update_rule` do not match because `\b` sits between `$` and `delete`
 * but not between `delete` and `_`.
 */
const WRITE_SQL =
  /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|execute|commit|rollback|savepoint|reconnect)\b/i

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Firebird CHAR columns arrive space padded; every identifier goes through here. */
function text(value: unknown): string {
  return value == null ? '' : String(value).trim()
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Source text is a blob cast; only trailing whitespace is dropped. */
function sourceText(value: unknown): string {
  return value == null ? '' : String(value).replace(/\s+$/, '')
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;+\s*$/, '').replace(/\s+$/, '')
}

/**
 * Raised when a statement this module built is not a read. It is a programming
 * error, not a server condition, so the degrading helpers below re-throw it
 * instead of turning it into an empty section.
 */
class ReadOnlyViolation extends Error {}

function assertReadOnly(sql: string): void {
  if (!/^\s*select\s/i.test(sql) || WRITE_SQL.test(sql)) {
    throw new ReadOnlyViolation('Firebird catalog introspection only issues read-only SELECT statements.')
  }
}

/** Wraps the injected query so no statement can reach the server unvetted. */
function readOnly(query: FirebirdQuery): FirebirdQuery {
  return (sql, params) => {
    assertReadOnly(sql)
    return query(sql, params)
  }
}

/**
 * Permission gaps are per section: a user that cannot read RDB$FUNCTIONS still
 * gets tables, views and indexes instead of an empty catalog.
 */
async function optional(run: () => Promise<Row[]>): Promise<Row[]> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ReadOnlyViolation) throw error
    return []
  }
}

/** A source read at the cast cap may have been cut off; say so instead of guessing. */
function sourceWarnings(source: string): string[] {
  return source.length >= SOURCE_CAP
    ? [
        `The stored source is at least ${SOURCE_CAP} characters; it may have been truncated when read.`
      ]
    : []
}

// ---------------------------------------------------------------------------
// Type mapping (RDB$FIELDS / RDB$PROCEDURE_PARAMETERS -> SQL type text)
// ---------------------------------------------------------------------------

function charsetClause(charset: string): string {
  return charset ? ` character set ${charset}` : ''
}

function fallbackDigits(code: number): number {
  if (code === 7) return 4
  if (code === 16) return 18
  if (code === 26) return 38
  return 9
}

/**
 * Maps one RDB$ base type to Firebird SQL. Returns `null` for codes this
 * module does not know: a wrong type in a "review then apply" script is worse
 * than an explicit hole.
 */
function mapFieldType(row: Row): { type: string | null; warning?: string } {
  const code = num(row.field_type)
  const length = num(row.field_length) ?? 0
  const scale = num(row.field_scale) ?? 0
  const subType = num(row.field_sub_type) ?? 0
  const precision = num(row.field_precision)
  const chars = num(row.character_length)
  const charset = text(row.charset)

  if (code === undefined) {
    return { type: null, warning: 'RDB$FIELD_TYPE is missing; the type must be written by hand.' }
  }

  const exactNumeric = (): string => {
    const digits = precision ?? fallbackDigits(code)
    return `${subType === 2 ? 'decimal' : 'numeric'}(${digits}, ${-scale})`
  }

  switch (code) {
    case 7:
      return { type: scale === 0 ? 'smallint' : exactNumeric() }
    case 8:
      return { type: scale === 0 ? 'integer' : exactNumeric() }
    case 10:
    case 11:
      return { type: 'float' }
    case 12:
      return { type: 'date' }
    case 13:
      return { type: 'time' }
    case 14:
      return { type: `char(${chars ?? length})${charsetClause(charset)}` }
    case 16:
      return { type: scale === 0 ? 'bigint' : exactNumeric() }
    case 23:
      return { type: 'boolean' }
    case 24:
      return { type: precision === 34 ? 'decfloat(34)' : 'decfloat(16)' }
    case 26:
      return { type: scale === 0 ? 'int128' : exactNumeric() }
    case 27:
      return { type: 'double precision' }
    case 28:
      return { type: 'time with time zone' }
    case 29:
      return { type: 'timestamp with time zone' }
    case 35:
      return { type: 'timestamp' }
    case 37:
      return { type: `varchar(${chars ?? length})${charsetClause(charset)}` }
    case 261:
      if (subType === 1) return { type: `blob sub_type text${charsetClause(charset)}` }
      return { type: subType === 0 ? 'blob' : `blob sub_type ${subType}` }
    default:
      return {
        type: null,
        warning: `RDB$FIELD_TYPE ${code} is not mapped by this module; write that type by hand.`
      }
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Firebird has no schemas: every object lives in the database's single
 * namespace. `schema` is accepted for adapter symmetry and ignored.
 *
 * Sections are read one at a time and each failure is contained, so a missing
 * privilege on one RDB$ table degrades that section instead of the catalog.
 */
export async function loadFirebirdCatalog(
  query: FirebirdQuery,
  schema?: string
): Promise<SchemaCatalog> {
  void schema
  const read = readOnly(query)
  const objects: SchemaObjectInfo[] = []
  let truncated = false

  const add = (rows: Row[], map: (row: Row) => SchemaObjectInfo): void => {
    // A section that came back at the per-query cap (`rows 1001`) proves there
    // is more than the catalog can hold, even if the total still fits.
    if (rows.length > MAX_OBJECTS) truncated = true
    for (const row of rows) {
      if (objects.length >= MAX_OBJECTS) {
        truncated = true
        return
      }
      objects.push(map(row))
    }
  }

  const relations = await optional(() =>
    read(
      `select trim(r.rdb$relation_name) as name,
              case when r.rdb$view_blr is null then 'table' else 'view' end as type
         from rdb$relations r
        where coalesce(r.rdb$system_flag, 0) = 0
        order by 2, 1
        rows 1001`
    )
  )
  add(relations, (row) => ({
    name: text(row.name),
    type: text(row.type) === 'view' ? 'view' : 'table'
  }))

  const indexes = await optional(() =>
    read(
      `select trim(i.rdb$index_name) as name,
              trim(i.rdb$relation_name) as parent
         from rdb$indices i
        where coalesce(i.rdb$system_flag, 0) = 0
          and i.rdb$relation_name is not null
        order by 2, 1
        rows 1001`
    )
  )
  add(indexes, (row) => ({
    name: text(row.name),
    type: 'index',
    parent: text(row.parent) || undefined
  }))

  // Database-level triggers have no relation; `parent` stays undefined for them.
  const triggers = await optional(() =>
    read(
      `select trim(t.rdb$trigger_name) as name,
              trim(t.rdb$relation_name) as parent
         from rdb$triggers t
        where coalesce(t.rdb$system_flag, 0) = 0
        order by 1
        rows 1001`
    )
  )
  add(triggers, (row) => ({
    name: text(row.name),
    type: 'trigger',
    parent: text(row.parent) || undefined
  }))

  // Procedures inside packages are listed by name only; package membership is
  // not exposed here because RDB$PACKAGE_NAME does not exist before Firebird 3.
  const procedures = await optional(() =>
    read(
      `select trim(p.rdb$procedure_name) as name
         from rdb$procedures p
        where coalesce(p.rdb$system_flag, 0) = 0
        order by 1
        rows 1001`
    )
  )
  add(procedures, (row) => ({ name: text(row.name), type: 'procedure' }))

  // RDB$FUNCTIONS exists from Firebird 3 on; on 2.5 this section is empty.
  const functions = await optional(() =>
    read(
      `select trim(f.rdb$function_name) as name
         from rdb$functions f
        where coalesce(f.rdb$system_flag, 0) = 0
        order by 1
        rows 1001`
    )
  )
  add(functions, (row) => ({ name: text(row.name), type: 'function' }))

  // Generators: RDB$GENERATORS up to 3.0, RDB$SEQUENCES from 3.0 on. Firebird 4
  // keeps RDB$GENERATORS as a compatibility view, so the order matters only for
  // servers that dropped it.
  const generators = await optional(() =>
    read(
      `select trim(g.rdb$generator_name) as name
         from rdb$generators g
        where coalesce(g.rdb$system_flag, 0) = 0
        order by 1
        rows 1001`
    )
  )
  if (generators.length > 0) {
    add(generators, (row) => ({ name: text(row.name), type: 'generator' }))
  } else {
    const sequences = await optional(() =>
      read(
        `select trim(s.rdb$sequence_name) as name
           from rdb$sequences s
          where coalesce(s.rdb$system_flag, 0) = 0
          order by 1
          rows 1001`
      )
    )
    add(sequences, (row) => ({ name: text(row.name), type: 'generator' }))
  }

  // Domains are user-named RDB$FIELDS rows; the RDB$-prefixed ones are the
  // engine's own field definitions and are not user objects.
  const domains = await optional(() =>
    read(
      `select trim(f.rdb$field_name) as name
         from rdb$fields f
        where coalesce(f.rdb$system_flag, 0) = 0
          and f.rdb$field_name not like 'RDB$%'
        order by 1
        rows 1001`
    )
  )
  add(domains, (row) => ({ name: text(row.name), type: 'domain' }))

  return { objects, truncated }
}

// ---------------------------------------------------------------------------
// DDL — shared readers
// ---------------------------------------------------------------------------

/**
 * Column metadata degrades in two steps, mirroring the adapter's own reader: a
 * server that rejects the RDB$FIELDS join or the character set join must not
 * hide the column names, so the fallback reports the stored field/domain name.
 */
async function readColumns(read: FirebirdQuery, table: string): Promise<Row[]> {
  try {
    return await read(
      `select trim(rf.rdb$field_name) as name,
              f.rdb$field_type as field_type,
              f.rdb$field_length as field_length,
              f.rdb$field_scale as field_scale,
              f.rdb$field_sub_type as field_sub_type,
              f.rdb$field_precision as field_precision,
              f.rdb$character_length as character_length,
              trim(cs.rdb$character_set_name) as charset,
              rf.rdb$null_flag as not_null,
              cast(rf.rdb$default_source as varchar(4000)) as default_source,
              cast(rf.rdb$description as varchar(4000)) as description
         from rdb$relation_fields rf
         join rdb$fields f on rf.rdb$field_source = f.rdb$field_name
         left join rdb$character_sets cs on cs.rdb$character_set_id = f.rdb$character_set_id
        where rf.rdb$relation_name = ?
        order by rf.rdb$field_position`,
      [table]
    )
  } catch (error) {
    if (error instanceof ReadOnlyViolation) throw error
    return read(
      `select trim(rf.rdb$field_name) as name,
              trim(rf.rdb$field_source) as type_name,
              rf.rdb$null_flag as not_null,
              cast(rf.rdb$description as varchar(4000)) as description
         from rdb$relation_fields rf
        where rf.rdb$relation_name = ?
        order by rf.rdb$field_position`,
      [table]
    )
  }
}

/**
 * Identity (Firebird 3+) and computed columns cannot be re-expressed without
 * the original clauses. The probe only exists to warn, never to fabricate: if
 * neither column exists the probe returns empty and the table warning covers it.
 */
async function probeSpecialColumns(read: FirebirdQuery, table: string): Promise<Row[]> {
  try {
    return await read(
      `select trim(rf.rdb$field_name) as name,
              rf.rdb$identity_type as identity_type,
              rf.rdb$computed_blr as computed_blr
         from rdb$relation_fields rf
        where rf.rdb$relation_name = ?`,
      [table]
    )
  } catch (error) {
    if (error instanceof ReadOnlyViolation) throw error
    return optional(() =>
      read(
        `select trim(rf.rdb$field_name) as name,
                rf.rdb$computed_blr as computed_blr
           from rdb$relation_fields rf
          where rf.rdb$relation_name = ?`,
        [table]
      )
    )
  }
}

interface KeyConstraint {
  name: string
  columns: string[]
}

async function readKeyConstraint(
  read: FirebirdQuery,
  table: string,
  type: 'PRIMARY KEY' | 'UNIQUE'
): Promise<KeyConstraint[]> {
  const rows = await optional(() =>
    read(
      `select trim(rc.rdb$constraint_name) as constraint_name,
              trim(seg.rdb$field_name) as column_name
         from rdb$relation_constraints rc
         join rdb$index_segments seg on rc.rdb$index_name = seg.rdb$index_name
        where rc.rdb$constraint_type = '${type}'
          and rc.rdb$relation_name = ?
        order by rc.rdb$constraint_name, seg.rdb$field_position`,
      [table]
    )
  )
  const grouped = new Map<string, KeyConstraint>()
  for (const row of rows) {
    const name = text(row.constraint_name)
    if (!grouped.has(name)) grouped.set(name, { name, columns: [] })
    const column = text(row.column_name)
    if (column) grouped.get(name)!.columns.push(column)
  }
  return [...grouped.values()]
}

interface ForeignKeyConstraint extends KeyConstraint {
  refTable: string
  refColumns: string[]
  deleteRule: string
  updateRule: string
}

async function readForeignKeys(read: FirebirdQuery, table: string): Promise<ForeignKeyConstraint[]> {
  const rows = await optional(() =>
    read(
      `select trim(rc.rdb$constraint_name) as constraint_name,
              trim(ref_rc.rdb$relation_name) as ref_table,
              trim(src_seg.rdb$field_name) as column_name,
              trim(ref_seg.rdb$field_name) as ref_column,
              trim(refc.rdb$delete_rule) as delete_rule,
              trim(refc.rdb$update_rule) as update_rule
         from rdb$relation_constraints rc
         join rdb$ref_constraints refc on refc.rdb$constraint_name = rc.rdb$constraint_name
         join rdb$relation_constraints ref_rc on ref_rc.rdb$constraint_name = refc.rdb$const_name_uq
         join rdb$index_segments src_seg on rc.rdb$index_name = src_seg.rdb$index_name
         join rdb$index_segments ref_seg
           on ref_rc.rdb$index_name = ref_seg.rdb$index_name
          and src_seg.rdb$field_position = ref_seg.rdb$field_position
        where rc.rdb$constraint_type = 'FOREIGN KEY'
          and rc.rdb$relation_name = ?
        order by rc.rdb$constraint_name, src_seg.rdb$field_position`,
      [table]
    )
  )
  const grouped = new Map<string, ForeignKeyConstraint>()
  for (const row of rows) {
    const name = text(row.constraint_name)
    if (!grouped.has(name)) {
      grouped.set(name, {
        name,
        columns: [],
        refTable: text(row.ref_table),
        refColumns: [],
        deleteRule: text(row.delete_rule).toUpperCase(),
        updateRule: text(row.update_rule).toUpperCase()
      })
    }
    const constraint = grouped.get(name)!
    const column = text(row.column_name)
    const refColumn = text(row.ref_column)
    if (column) constraint.columns.push(column)
    if (refColumn) constraint.refColumns.push(refColumn)
  }
  return [...grouped.values()]
}

interface IndexDefinition {
  name: string
  parent: string
  unique: boolean
  descending: boolean
  columns: string[]
}

function groupIndexes(rows: Row[]): IndexDefinition[] {
  const grouped = new Map<string, IndexDefinition>()
  for (const row of rows) {
    const name = text(row.name)
    if (!name) continue
    if (!grouped.has(name)) {
      grouped.set(name, {
        name,
        parent: text(row.parent),
        unique: num(row.is_unique) === 1,
        descending: num(row.index_type) === 1,
        columns: []
      })
    }
    const column = text(row.column_name)
    if (column) grouped.get(name)!.columns.push(column)
  }
  return [...grouped.values()]
}

/** Indexes that are not owned by a PK/UNIQUE constraint; Firebird needs CREATE INDEX. */
async function readTableIndexes(read: FirebirdQuery, table: string): Promise<IndexDefinition[]> {
  const rows = await optional(() =>
    read(
      `select trim(i.rdb$index_name) as name,
              trim(i.rdb$relation_name) as parent,
              i.rdb$unique_flag as is_unique,
              i.rdb$index_type as index_type,
              trim(seg.rdb$field_name) as column_name,
              seg.rdb$field_position as field_position
         from rdb$indices i
         join rdb$index_segments seg on seg.rdb$index_name = i.rdb$index_name
        where i.rdb$relation_name = ?
          and coalesce(i.rdb$system_flag, 0) = 0
          and not exists (
                select 1
                  from rdb$relation_constraints rc
                 where rc.rdb$index_name = i.rdb$index_name
                   and rc.rdb$constraint_type in ('PRIMARY KEY', 'UNIQUE'))
        order by i.rdb$index_name, seg.rdb$field_position`,
      [table]
    )
  )
  return groupIndexes(rows)
}

function renderIndex(index: IndexDefinition): string {
  const keywords = ['create']
  if (index.unique) keywords.push('unique')
  if (index.descending) keywords.push('descending')
  const columns = index.columns.map(quoteIdent).join(', ')
  return `${keywords.join(' ')} index ${quoteIdent(index.name)} on ${quoteIdent(index.parent)} (${columns});`
}

// ---------------------------------------------------------------------------
// DDL — per object type
// ---------------------------------------------------------------------------

async function viewDdl(read: FirebirdQuery, name: string): Promise<SchemaDdl> {
  const rows = await read(
    `select cast(r.rdb$view_source as varchar(${SOURCE_CAP})) as source
       from rdb$relations r
      where r.rdb$relation_name = ?`,
    [name]
  )
  const source = sourceText(rows[0]?.source)
  if (!source) throw new Error(`Firebird stored no view source for "${name}".`)
  // Verbatim: the stored source is what the view was created with. Firebird
  // keeps no column alias list, so an explicit one cannot be reproduced.
  return {
    sql: `create or replace view ${quoteIdent(name)} as\n${stripTrailingSemicolon(source)};`,
    warnings: sourceWarnings(source)
  }
}

async function procedureDdl(read: FirebirdQuery, name: string): Promise<SchemaDdl> {
  const warnings = new Set<string>()

  let meta: Row | undefined
  try {
    const rows = await read(
      `select cast(p.rdb$procedure_source as varchar(${SOURCE_CAP})) as source,
              trim(p.rdb$package_name) as package_name
         from rdb$procedures p
        where p.rdb$procedure_name = ?`,
      [name]
    )
    meta = rows[0]
    const packageName = text(meta?.package_name)
    if (packageName) {
      warnings.add(
        `Procedure "${name}" belongs to package "${packageName}"; the package header is not reproduced.`
      )
    }
  } catch (error) {
    if (error instanceof ReadOnlyViolation) throw error
    // RDB$PACKAGE_NAME does not exist before Firebird 3.
    const rows = await optional(() =>
      read(
        `select cast(p.rdb$procedure_source as varchar(${SOURCE_CAP})) as source
           from rdb$procedures p
          where p.rdb$procedure_name = ?`,
        [name]
      )
    )
    meta = rows[0]
  }

  const source = sourceText(meta?.source)
  if (!source) throw new Error(`Firebird stored no procedure source for "${name}".`)
  for (const warning of sourceWarnings(source)) warnings.add(warning)

  // A procedure without parameters legitimately returns no rows here, so an
  // empty result is not a warning; only a failed read is.
  let parameters: Row[] = []
  try {
    parameters = await read(
      `select trim(pp.rdb$parameter_name) as name,
              pp.rdb$parameter_type as parameter_type,
              pp.rdb$field_type as field_type,
              pp.rdb$field_length as field_length,
              pp.rdb$field_scale as field_scale,
              pp.rdb$field_sub_type as field_sub_type,
              pp.rdb$field_precision as field_precision,
              pp.rdb$character_length as character_length
         from rdb$procedure_parameters pp
        where pp.rdb$procedure_name = ?
        order by pp.rdb$parameter_type, pp.rdb$parameter_number`,
      [name]
    )
  } catch {
    warnings.add(
      'The procedure parameter list could not be read; the parameter list must be written by hand.'
    )
  }

  const renderParameters = (rows: Row[]): string[] => {
    const lines: string[] = []
    for (const row of rows) {
      const parameter = text(row.name)
      const mapped = mapFieldType(row)
      if (!mapped.type) {
        if (mapped.warning) {
          warnings.add(`Parameter "${parameter}": ${mapped.warning}`)
        }
        continue
      }
      lines.push(`  ${quoteIdent(parameter)} ${mapped.type}`)
    }
    return lines
  }

  const inputs = renderParameters(parameters.filter((row) => num(row.parameter_type) === 0))
  const outputs = renderParameters(parameters.filter((row) => num(row.parameter_type) === 1))

  let header = `create or alter procedure ${quoteIdent(name)}`
  if (inputs.length > 0) header += ` (\n${inputs.join(',\n')}\n)`
  if (outputs.length > 0) header += `\nreturns (\n${outputs.join(',\n')}\n)`

  // The body is verbatim; only the header is rebuilt from parameter metadata.
  return { sql: `${header}\nas\n${stripTrailingSemicolon(source)};`, warnings: [...warnings] }
}

const TRIGGER_TYPES: Record<number, string> = {
  1: 'before insert',
  2: 'before update',
  3: 'before insert or update',
  4: 'before delete',
  5: 'before insert or delete',
  6: 'before update or delete',
  7: 'before insert or update or delete',
  8: 'after insert',
  9: 'after update',
  10: 'after insert or update',
  11: 'after delete',
  12: 'after insert or delete',
  13: 'after update or delete',
  14: 'after insert or update or delete'
}

async function triggerDdl(
  read: FirebirdQuery,
  name: string,
  parent?: string
): Promise<SchemaDdl> {
  const rows = await read(
    `select trim(t.rdb$trigger_name) as name,
            trim(t.rdb$relation_name) as relation_name,
            t.rdb$trigger_type as trigger_type,
            t.rdb$trigger_inactive as is_inactive,
            t.rdb$trigger_sequence as trigger_sequence,
            cast(t.rdb$trigger_source as varchar(${SOURCE_CAP})) as source
       from rdb$triggers t
      where t.rdb$trigger_name = ?
        and coalesce(t.rdb$system_flag, 0) = 0`,
    [name]
  )
  const row = rows[0]
  if (!row) throw new Error(`Firebird has no user trigger named "${name}".`)

  const warnings: string[] = []
  const source = sourceText(row.source)
  if (!source) throw new Error(`Firebird stored no trigger source for "${name}".`)
  for (const warning of sourceWarnings(source)) warnings.push(warning)

  const relation = text(row.relation_name)
  if (parent && relation && text(parent) !== relation) {
    warnings.push(
      `Trigger "${name}" is attached to "${relation}", not to the requested parent "${parent}".`
    )
  }
  if (!relation) throw new Error(`Trigger "${name}" is a database trigger and has no relation.`)

  const mask = num(row.trigger_type)
  const event = mask === undefined ? undefined : TRIGGER_TYPES[mask]
  if (!event) {
    throw new Error(
      `Trigger "${name}" has RDB$TRIGGER_TYPE ${mask ?? 'null'}, which this module cannot decode into a trigger event.`
    )
  }

  const sequence = num(row.trigger_sequence) ?? 0
  const state = num(row.is_inactive) === 1 ? 'inactive' : 'active'
  const position = sequence > 0 ? ` position ${sequence}` : ''
  const header = `create or alter trigger ${quoteIdent(name)} for ${quoteIdent(relation)} ${state} ${event}${position}`

  return { sql: `${header}\nas\n${stripTrailingSemicolon(source)};`, warnings }
}

async function tableDdl(read: FirebirdQuery, name: string): Promise<SchemaDdl> {
  const warnings = new Set<string>([RECONSTRUCTED_WARNING])
  const columns = await readColumns(read, name)
  if (columns.length === 0) {
    throw new Error(`Firebird returned no columns for table "${name}".`)
  }

  const lines: string[] = []
  const columnComments: string[] = []

  for (const row of columns) {
    const column = text(row.name)
    const storedField = text(row.type_name)
    let type: string | null
    if (storedField) {
      // Fallback path: the stored field/domain name is valid DDL only when it
      // is a user domain; engine-generated RDB$ fields are not usable types.
      if (storedField.startsWith('RDB$') || storedField.startsWith('rdb$')) {
        type = null
        warnings.add(
          `Column "${column}" uses engine field "${storedField}"; its type must be written by hand.`
        )
      } else {
        type = quoteIdent(storedField)
      }
    } else {
      const mapped = mapFieldType(row)
      type = mapped.type
      if (!type && mapped.warning) warnings.add(`Column "${column}": ${mapped.warning}`)
    }
    if (!type) {
      lines.push(`  /* ${column}: type unavailable from RDB$ metadata, write it by hand */`)
    } else {
      const parts = [quoteIdent(column), type]
      if (num(row.not_null) === 1) parts.push('not null')
      const defaultValue = text(row.default_source)
      if (defaultValue) {
        parts.push(/^default\b/i.test(defaultValue) ? defaultValue : `default ${defaultValue}`)
      }
      lines.push(`  ${parts.join(' ')}`)
    }
    const comment = text(row.description)
    if (comment) columnComments.push(`comment on column ${quoteIdent(name)} ${quoteIdent(column)} is ${literal(comment)};`)
  }

  const primaryKey = (await readKeyConstraint(read, name, 'PRIMARY KEY'))[0]
  if (primaryKey && primaryKey.columns.length > 0) {
    lines.push(
      `  constraint ${quoteIdent(primaryKey.name)} primary key (${primaryKey.columns.map(quoteIdent).join(', ')})`
    )
  }
  for (const unique of await readKeyConstraint(read, name, 'UNIQUE')) {
    if (unique.columns.length === 0) continue
    lines.push(
      `  constraint ${quoteIdent(unique.name)} unique (${unique.columns.map(quoteIdent).join(', ')})`
    )
  }
  for (const foreignKey of await readForeignKeys(read, name)) {
    if (foreignKey.columns.length === 0 || foreignKey.refColumns.length === 0) continue
    if (foreignKey.columns.length !== foreignKey.refColumns.length) {
      warnings.add(
        `Foreign key "${foreignKey.name}" has ${foreignKey.columns.length} local and ${foreignKey.refColumns.length} referenced columns; review it by hand.`
      )
      continue
    }
    const parts = [
      `  constraint ${quoteIdent(foreignKey.name)} foreign key (${foreignKey.columns.map(quoteIdent).join(', ')})`,
      `references ${quoteIdent(foreignKey.refTable)} (${foreignKey.refColumns.map(quoteIdent).join(', ')})`
    ]
    if (foreignKey.deleteRule && !['RESTRICT', 'NO ACTION', ''].includes(foreignKey.deleteRule)) {
      parts.push(`on delete ${foreignKey.deleteRule.toLowerCase()}`)
    }
    if (foreignKey.updateRule && !['RESTRICT', 'NO ACTION', ''].includes(foreignKey.updateRule)) {
      parts.push(`on update ${foreignKey.updateRule.toLowerCase()}`)
    }
    lines.push(parts.join(' '))
  }

  // Identity / computed columns cannot be rebuilt without their original
  // clauses; the probe exists so the reconstruction says so out loud.
  for (const row of await probeSpecialColumns(read, name)) {
    if (num(row.identity_type) != null) {
      warnings.add(
        `Column "${text(row.name)}" is an identity column; it is reconstructed as a plain column.`
      )
    } else if (row.computed_blr != null) {
      warnings.add(
        `Column "${text(row.name)}" is a computed column; the expression is not reconstructed and the column is emitted as a stored one.`
      )
    }
  }

  const statements = [`create table ${quoteIdent(name)} (\n${lines.join(',\n')}\n);`]
  for (const index of await readTableIndexes(read, name)) {
    if (index.columns.length === 0) {
      warnings.add(`Index "${index.name}" has no column segments (expression index) and is not reproduced.`)
      continue
    }
    statements.push(renderIndex(index))
  }

  const description = text(
    (await optional(() =>
      read(
        `select cast(r.rdb$description as varchar(4000)) as description
           from rdb$relations r
          where r.rdb$relation_name = ?`,
        [name]
      )
    ))[0]?.description
  )
  if (description) statements.push(`comment on table ${quoteIdent(name)} is ${literal(description)};`)
  statements.push(...columnComments)

  return { sql: statements.join('\n\n'), warnings: [...warnings] }
}

async function indexDdl(read: FirebirdQuery, name: string): Promise<SchemaDdl> {
  const rows = await read(
    `select trim(i.rdb$index_name) as name,
            trim(i.rdb$relation_name) as parent,
            i.rdb$unique_flag as is_unique,
            i.rdb$index_type as index_type,
            trim(seg.rdb$field_name) as column_name,
            seg.rdb$field_position as field_position
       from rdb$indices i
       join rdb$index_segments seg on seg.rdb$index_name = i.rdb$index_name
      where i.rdb$index_name = ?
      order by seg.rdb$field_position`,
    [name]
  )
  const [index] = groupIndexes(rows)
  if (!index) {
    throw new Error(
      `Firebird index "${name}" has no column segments (expression index or missing); it cannot be reconstructed from RDB$ metadata.`
    )
  }
  return { sql: renderIndex(index), warnings: [] }
}

function generatorDdl(name: string): SchemaDdl {
  return {
    // CREATE GENERATOR is valid from Firebird 2.5 through 4; Firebird 3+ also
    // accepts CREATE SEQUENCE for the same object.
    sql: `create generator ${quoteIdent(name)};`,
    warnings: ['Generator values are not stored in RDB$ metadata; only the name is reproduced.']
  }
}

async function domainDdl(read: FirebirdQuery, name: string): Promise<SchemaDdl> {
  const rows = await read(
    `select trim(f.rdb$field_name) as name,
            f.rdb$field_type as field_type,
            f.rdb$field_length as field_length,
            f.rdb$field_scale as field_scale,
            f.rdb$field_sub_type as field_sub_type,
            f.rdb$field_precision as field_precision,
            f.rdb$character_length as character_length,
            trim(cs.rdb$character_set_name) as charset,
            f.rdb$null_flag as not_null,
            cast(f.rdb$default_source as varchar(4000)) as default_source,
            cast(f.rdb$validation_source as varchar(4000)) as validation_source
       from rdb$fields f
       left join rdb$character_sets cs on cs.rdb$character_set_id = f.rdb$character_set_id
      where f.rdb$field_name = ?`,
    [name]
  )
  const row = rows[0]
  if (!row) throw new Error(`Firebird has no domain named "${name}".`)

  const warnings = [RECONSTRUCTED_WARNING]
  const mapped = mapFieldType(row)
  if (!mapped.type) {
    throw new Error(mapped.warning ?? `Firebird domain "${name}" has an unsupported base type.`)
  }
  const parts = [`create domain ${quoteIdent(text(row.name))} as ${mapped.type}`]
  const defaultValue = text(row.default_source)
  if (defaultValue) parts.push(/^default\b/i.test(defaultValue) ? defaultValue : `default ${defaultValue}`)
  if (num(row.not_null) === 1) parts.push('not null')
  const validation = text(row.validation_source)
  if (validation) parts.push(/^check\b/i.test(validation) ? validation : `check (${validation})`)

  return { sql: `${parts.join(' ')};`, warnings }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * DDL for one catalog object.
 *
 * Fidelity by design:
 * - view / procedure / trigger: the stored source is reproduced verbatim.
 * - table: reconstructed from columns, defaults, PK, UNIQUE, FK and the indexes
 *   that Firebird does not attach to a constraint, and always carries
 *   `Reconstructed from RDB$ metadata; review before applying.`
 * - index / generator / domain: straightforward reconstruction.
 * - function: not implemented (the argument and return header lives in
 *   RDB$FUNCTION_ARGUMENTS and is out of scope for this module).
 */
export async function loadFirebirdDdl(
  query: FirebirdQuery,
  object: SchemaObjectRef
): Promise<SchemaDdl> {
  const read = readOnly(query)
  const name = text(object.name)
  if (!name) throw new Error('A Firebird object name is required to read DDL.')
  const type = text(object.type).toLowerCase()

  switch (type) {
    case 'view':
    case 'materialized_view':
      return viewDdl(read, name)
    case 'procedure':
      return procedureDdl(read, name)
    case 'trigger':
      return triggerDdl(read, name, object.parent)
    case 'table':
      return tableDdl(read, name)
    case 'index':
      return indexDdl(read, name)
    case 'generator':
      return generatorDdl(name)
    case 'domain':
      return domainDdl(read, name)
    case 'function':
      throw new Error(
        'Firebird function DDL is not implemented: the argument and return header is stored in RDB$FUNCTION_ARGUMENTS. Read the body from RDB$FUNCTIONS.RDB$FUNCTION_SOURCE.'
      )
    default:
      throw new Error(`Firebird DDL is not implemented for "${object.type}".`)
  }
}
