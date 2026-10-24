import type { TableInfo } from '@shared/types'
import type { ColumnRef } from '../db/types'

/**
 * Tokens that describe the request rather than the data. Kept short on purpose:
 * words like "nome" or "cpf" are useful when they appear in table names.
 */
const STOPWORDS = new Set([
  'para', 'por', 'com', 'sem', 'que', 'uma', 'uns', 'umas', 'dos', 'das', 'nos', 'nas',
  'seu', 'sua', 'seus', 'suas', 'meu', 'minha', 'preciso', 'quero', 'gostaria', 'pode',
  'poderia', 'fornecer', 'forneca', 'fazer', 'faca', 'consulta', 'consultar', 'select',
  'tabela', 'tabelas', 'coluna', 'colunas', 'campo', 'campos', 'dados', 'informacao',
  'informacoes', 'registro', 'registros', 'onde', 'como', 'qual', 'quais', 'quando',
  'chamado', 'chamada', 'todos', 'todas', 'este', 'esta', 'isso', 'esse', 'essa',
  'the', 'and', 'for', 'with', 'from', 'table', 'where', 'please', 'give'
])

/**
 * Legacy Firebird schemas often name the same concept in different ways. These
 * expansions only affect ranking; they are never sent to the provider.
 */
const SYNONYMS: Record<string, string[]> = {
  colaborador: ['funcionario', 'empregado', 'pessoa', 'servidor'],
  colaboradores: ['funcionario', 'empregado', 'pessoa', 'servidor'],
  funcionario: ['colaborador', 'empregado', 'servidor'],
  funcionarios: ['colaborador', 'empregado', 'servidor'],
  empregado: ['colaborador', 'funcionario'],
  empregados: ['colaborador', 'funcionario'],
  pessoa: ['colaborador', 'funcionario'],
  pessoas: ['colaborador', 'funcionario'],
  cliente: ['comprador', 'tomador'],
  clientes: ['comprador', 'tomador']
}

/**
 * Evidence tiers, highest first: the table name wins, then a column name, then
 * the table comment. Values stay below the next tier so a strong comment can
 * never outrank a weak name match.
 */
const NAME_WEIGHT = { exact: 8, prefix: 5, includes: 3, partial: 2 } as const
const COLUMN_WEIGHT = { exact: 2.5, prefix: 2, includes: 1.5 } as const
const COMMENT_WEIGHT = 1

/** How many pinned tables can be forced into the AI context. */
export const PINNED_TABLE_LIMIT = 10

/** Lowercase, accent-free form used for every comparison. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Key used to join a table with its columns (case and accent insensitive). */
function tableKey(schema: string | undefined, table: string): string {
  return `${normalizeName(schema ?? '')}.${normalizeName(table)}`
}

/** Lowercase ASCII words with diacritics removed. */
export function promptTokens(prompt: string): string[] {
  return [
    ...new Set(
      prompt
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
    )
  ]
}

function expandedTokens(prompt: string): string[] {
  const tokens = promptTokens(prompt)
  const expanded = new Set(tokens)
  for (const token of tokens) {
    for (const synonym of SYNONYMS[token] ?? []) expanded.add(synonym)
  }
  return [...expanded]
}

function columnsByTable(columns: ColumnRef[] | undefined): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const column of columns ?? []) {
    const key = tableKey(column.schema, column.table)
    const normalized = normalizeName(column.column)
    const names = grouped.get(key)
    if (names) names.push(normalized)
    else grouped.set(key, [normalized])
  }
  return grouped
}

/** Best column match for one token, so a wide table does not win by volume. */
function columnScore(columns: string[], token: string, weight: number): number {
  let best = 0
  for (const column of columns) {
    const value =
      column === token
        ? COLUMN_WEIGHT.exact
        : column.startsWith(token)
          ? COLUMN_WEIGHT.prefix
          : column.includes(token)
            ? COLUMN_WEIGHT.includes
            : 0
    if (value > best) best = value
  }
  return best * weight
}

/**
 * Picks the tables worth sending when a database has thousands of them. Name
 * matches win over column-name matches, which win over comment matches; without
 * any match the alphabetical prefix is still better than an empty context.
 *
 * `columns` comes from the schema index (`DbAdapter.columnsIndex`), so a table
 * whose *columns* name the request ("MATRICULA.CPF") is found without a
 * describeTable per table.
 */
export function rankSchemaTables<T extends TableInfo>(
  tables: T[],
  prompt: string,
  limit = 20,
  columns: ColumnRef[] = []
): T[] {
  if (limit <= 0) return []
  const primary = new Set(promptTokens(prompt))
  const tokens = expandedTokens(prompt)
  if (tokens.length === 0) return tables.slice(0, limit)

  const grouped = columnsByTable(columns)
  const scored = tables.map((table) => {
    const name = normalizeName(table.name)
    const comment = normalizeName(table.comment ?? '')
    const tableColumns = grouped.get(tableKey(table.schema, table.name)) ?? []
    let score = 0
    for (const token of tokens) {
      // Synonyms count, but less than a word the user actually wrote.
      const weight = primary.has(token) ? 1 : 0.6
      if (name === token) score += NAME_WEIGHT.exact * weight
      else if (name.startsWith(token)) score += NAME_WEIGHT.prefix * weight
      else if (name.includes(token)) score += NAME_WEIGHT.includes * weight
      else if (name.length >= 4 && token.startsWith(name)) score += NAME_WEIGHT.partial * weight
      if (comment.includes(token)) score += COMMENT_WEIGHT * weight
      score += columnScore(tableColumns, token, weight)
    }
    return { table, score }
  })

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.table.name.length - right.table.name.length ||
      compareNames(left.table, right.table)
  )
  const matches = scored.filter((entry) => entry.score > 0)
  return (matches.length > 0 ? matches : scored).slice(0, limit).map((entry) => entry.table)
}

/** Deterministic tie-break: plain comparison, never locale-dependent. */
function compareNames(left: TableInfo, right: TableInfo): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  const leftSchema = left.schema ?? ''
  const rightSchema = right.schema ?? ''
  if (leftSchema !== rightSchema) return leftSchema < rightSchema ? -1 : 1
  return 0
}

/**
 * Resolves saved pins against the live table list. A pin that no longer exists
 * (dropped table, typo, hostile renderer text) is dropped instead of being sent
 * to the model, so pinned names never carry renderer-supplied text.
 */
export function resolvePinnedTables<T extends TableInfo>(
  tables: T[],
  pinnedTables: string[] = []
): T[] {
  const resolved: T[] = []
  const seen = new Set<string>()
  for (const pin of pinnedTables) {
    const key = normalizeName(String(pin ?? '').trim())
    if (!key) continue
    const hit = tables.find((table) => {
      const name = normalizeName(table.name)
      return name === key || (table.schema ? `${normalizeName(table.schema)}.${name}` === key : false)
    })
    if (!hit) continue
    const identity = tableKey(hit.schema, hit.name)
    if (seen.has(identity)) continue
    seen.add(identity)
    resolved.push(hit)
    if (resolved.length >= PINNED_TABLE_LIMIT) break
  }
  return resolved
}

/**
 * Final pick for the AI context: pinned tables first (always present, even when
 * the prompt matches nothing else), then the ranked matches up to `limit`.
 */
export function selectSchemaTables<T extends TableInfo>(
  tables: T[],
  prompt: string,
  options: { limit?: number; columns?: ColumnRef[]; pinnedTables?: string[] } = {}
): T[] {
  const limit = options.limit ?? 20
  if (limit <= 0) return []
  const pinned = resolvePinnedTables(tables, options.pinnedTables ?? [])
  if (pinned.length === 0) return rankSchemaTables(tables, prompt, limit, options.columns)
  const pinnedKeys = new Set(pinned.map((table) => tableKey(table.schema, table.name)))
  const remaining = tables.filter(
    (table) => !pinnedKeys.has(tableKey(table.schema, table.name))
  )
  const ranked =
    remaining.length > 0 && limit > pinned.length
      ? rankSchemaTables(remaining, prompt, limit - pinned.length, options.columns)
      : []
  return [...pinned, ...ranked].slice(0, limit)
}
