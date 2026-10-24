import type { DbKind, ExplainResult, PlanNode } from '@shared/types'
import { redactText } from '../ai/redact'

let nodeCounter = 0

function nextId(prefix: string): string {
  nodeCounter += 1
  return `${prefix}-${nodeCounter}`
}

function clean(value: unknown): string {
  return redactText(String(value ?? '').slice(0, 400))
}

function makeNode(
  operation: string,
  extra: Partial<PlanNode> = {},
  children: PlanNode[] = []
): PlanNode {
  const { operation: extraOperation, ...rest } = extra
  return {
    id: nextId('plan'),
    operation: clean(extraOperation ?? operation) || '(unknown)',
    warnings: [],
    children,
    ...rest
  }
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Avisos heurísticos compartilhados por todos os dialetos. */
export function warnForNode(node: PlanNode): string[] {
  const warnings: string[] = []
  const op = node.operation.toLowerCase()
  const rows = node.rows ?? 0
  const isSeqScan =
    op.includes('seq scan') || op.includes('table scan') || /(^|\s)scan\s+\w+/.test(op)
  const hasIndexHint =
    op.includes('index') || op.includes('seek') || op.includes('using')
  if (isSeqScan && !hasIndexHint && rows > 1000) {
    warnings.push(
      `Sequential scan over ~${Math.round(rows).toLocaleString()} estimated rows${node.relation ? ` on ${node.relation}` : ''}. Consider an index.`
    )
  }
  if (op.includes('nested loop') && rows > 10000) {
    warnings.push(
      `Nested loop over ~${Math.round(rows).toLocaleString()} rows can be slow; check join order and indexes.`
    )
  }
  if (op.includes('sort') && rows > 10000) {
    warnings.push(
      `Large sort of ~${Math.round(rows).toLocaleString()} rows; an index on the ORDER BY keys may help.`
    )
  }
  if (node.costTotal !== undefined && node.costTotal > 100000) {
    warnings.push(`High planner cost (${node.costTotal.toFixed(1)}). Review filters and join order.`)
  }
  if (
    node.actualRows !== undefined &&
    node.rows !== undefined &&
    node.rows > 0 &&
    node.actualRows > 0
  ) {
    const ratio = node.actualRows / node.rows
    if (ratio >= 10 || ratio <= 0.1) {
      warnings.push(
        `Row estimate off by ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x (estimated ${node.rows}, actual ${node.actualRows}). Statistics may be stale.`
      )
    }
  }
  return warnings
}

function attachWarnings(node: PlanNode): void {
  // Preserva avisos manuais do normalizador (ex. full scan do SQLite).
  node.warnings = [...node.warnings, ...warnForNode(node)]
  for (const child of node.children) attachWarnings(child)
}

function collectWarnings(roots: PlanNode[]): string[] {
  const out: string[] = []
  const visit = (node: PlanNode): void => {
    out.push(...node.warnings)
    for (const child of node.children) visit(child)
  }
  for (const root of roots) visit(root)
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// PostgreSQL — EXPLAIN (FORMAT JSON)
// ---------------------------------------------------------------------------

interface PgJsonNode {
  'Node Type'?: string
  'Relation Name'?: string
  'Index Name'?: string
  'Startup Cost'?: number
  'Total Cost'?: number
  'Plan Rows'?: number
  'Plan Width'?: number
  'Actual Rows'?: number
  'Actual Total Time'?: number
  'Actual Loops'?: number
  Plans?: PgJsonNode[]
  [key: string]: unknown
}

function normalizePgNode(raw: PgJsonNode): PlanNode {
  const children = (raw.Plans ?? []).map(normalizePgNode)
  const node = makeNode(String(raw['Node Type'] ?? 'Unknown'), {
    relation: raw['Relation Name'] !== undefined ? String(raw['Relation Name']) : undefined,
    index: raw['Index Name'] !== undefined ? String(raw['Index Name']) : undefined,
    costStart: num(raw['Startup Cost']),
    costTotal: num(raw['Total Cost']),
    rows: num(raw['Plan Rows']),
    width: num(raw['Plan Width']),
    actualRows: num(raw['Actual Rows']),
    actualTimeMs: num(raw['Actual Total Time']),
    loops: num(raw['Actual Loops'])
  }, children)
  return node
}

export function normalizePostgresPlan(raw: unknown): {
  roots: PlanNode[]
  planningMs?: number
  executionTimeMs?: number
} {
  let doc: unknown = raw
  // pg devolve { rows: [{ 'QUERY PLAN': [{ Plan, 'Planning Time', ... }] }] }
  const rows = (raw as { rows?: Record<string, unknown>[] })?.rows
  if (Array.isArray(rows) && rows.length > 0) {
    const first = rows[0]
    const planCol = first['QUERY PLAN'] ?? first['query plan'] ?? first[Object.keys(first)[0]]
    doc = planCol
  }
  if (typeof doc === 'string') {
    const text = doc
    try {
      doc = JSON.parse(text)
    } catch {
      return { roots: [makeNode(text.slice(0, 400))] }
    }
  }
  const plans = Array.isArray(doc) ? doc : [doc]
  const roots: PlanNode[] = []
  let planningMs: number | undefined
  let executionTimeMs: number | undefined
  for (const entry of plans) {
    const record = entry as Record<string, unknown>
    const plan = (record?.Plan ?? entry) as PgJsonNode
    if (plan && typeof plan === 'object' && 'Node Type' in plan) {
      roots.push(normalizePgNode(plan))
    }
    const planning = num(record?.['Planning Time'])
    const execution = num(record?.['Execution Time'])
    if (planning !== undefined) planningMs = planning
    if (execution !== undefined) executionTimeMs = execution
  }
  if (roots.length === 0) roots.push(makeNode('Empty plan'))
  return { roots, planningMs, executionTimeMs }
}

// ---------------------------------------------------------------------------
// MySQL — EXPLAIN FORMAT=JSON (objeto) ou EXPLAIN ANALYZE (árvore texto)
// ---------------------------------------------------------------------------

function normalizeMysqlJsonNode(value: unknown): PlanNode | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  // Nó de tabela: { table_name, access_type, key, rows, cost_info, ... }
  if (typeof record.table_name === 'string') {
    const access = String(record.access_type ?? 'access')
    const costInfo = (record.cost_info ?? {}) as Record<string, unknown>
    const node = makeNode(
      `${access} on ${String(record.table_name)}`,
      {
        relation: String(record.table_name),
        index: record.key !== undefined && record.key !== null ? String(record.key) : undefined,
        rows: num(record.rows_examined_per_scan) ?? num(record.rows),
        costTotal: num(costInfo.query_cost) ?? num((record as Record<string, unknown>).cost)
      }
    )
    return node
  }
  // Operações compostas: nested_loop, ordering_operation, grouping_operation, ...
  const opKey = ['nested_loop', 'ordering_operation', 'grouping_operation', 'table'].find(
    (key) => record[key] !== undefined
  )
  const children: PlanNode[] = []
  const pushChildren = (input: unknown): void => {
    if (Array.isArray(input)) {
      for (const item of input) {
        const child = normalizeMysqlJsonNode(item)
        if (child) children.push(child)
      }
    } else if (input && typeof input === 'object') {
      const child = normalizeMysqlJsonNode(input)
      if (child) children.push(child)
    }
  }
  if (opKey) {
    pushChildren(record[opKey])
    const label =
      opKey === 'nested_loop'
        ? 'Nested loop'
        : opKey === 'table'
          ? 'Table access'
          : opKey.replace(/_/g, ' ')
    // Wrapper transparente de um único filho não acrescenta informação.
    if (children.length === 1 && opKey === 'table') return children[0]
    return makeNode(label, {}, children)
  }
  // query_block ou envelope genérico: desce um nível
  const block = (record.query_block ?? record) as Record<string, unknown>
  if (block !== record) {
    const inner = normalizeMysqlJsonNode(block)
    if (inner) return inner
  }
  for (const key of ['nested_loop', 'table', 'ordering_operation', 'grouping_operation']) {
    if (record[key] !== undefined) {
      pushChildren(record[key])
    }
  }
  if (children.length === 1) return children[0]
  if (children.length > 0) return makeNode('MySQL query block', {}, children)
  return null
}

function normalizeMysqlAnalyzeText(text: string): PlanNode[] {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim())
  if (lines.length === 0) return [makeNode('Empty plan')]
  const root = makeNode('MySQL EXPLAIN ANALYZE')
  for (const line of lines) {
    const cleaned = line.replace(/^->\s*/, '').trim()
    if (!cleaned) continue
    const cost = /cost=([\d.]+)/i.exec(cleaned)?.[1]
    const rows = /rows=([\d.]+)/i.exec(cleaned)?.[1]
    const actual = /actual time=[\d.]+\.\.([\d.]+).*rows=([\d.]+)/i.exec(cleaned)
    const child = makeNode(cleaned, {
      costTotal: cost ? Number(cost) : undefined,
      rows: rows ? Number(rows) : undefined,
      actualTimeMs: actual ? Number(actual[1]) : undefined,
      actualRows: actual ? Number(actual[2]) : undefined
    })
    const scanMatch = /table scan on (\S+)/i.exec(cleaned)
    if (scanMatch) child.relation = scanMatch[1]
    root.children.push(child)
  }
  return [root]
}

export function normalizeMysqlPlan(raw: unknown): { roots: PlanNode[] } {
  const rows = (raw as { rows?: Record<string, unknown>[] })?.rows ?? []
  if (rows.length === 0) return { roots: [makeNode('Empty plan')] }
  const first = rows[0]
  const keys = Object.keys(first)
  const explainValue = first.EXPLAIN ?? first.explain ?? first[keys[0]]
  // ANALYZE em texto: várias linhas, cada uma com a árvore
  if (rows.length > 1 || (typeof explainValue === 'string' && explainValue.includes('->'))) {
    const text = rows
      .map((row) => String(row.EXPLAIN ?? row.explain ?? Object.values(row)[0] ?? ''))
      .join('\n')
    return { roots: normalizeMysqlAnalyzeText(text) }
  }
  let doc: unknown = explainValue
  if (typeof doc === 'string') {
    const text = doc
    try {
      doc = JSON.parse(text)
    } catch {
      return { roots: normalizeMysqlAnalyzeText(text) }
    }
  }
  const node = normalizeMysqlJsonNode(doc)
  return { roots: [node ?? makeNode('MySQL query block')] }
}

// ---------------------------------------------------------------------------
// SQLite — EXPLAIN QUERY PLAN (id, parent, notused, detail)
// ---------------------------------------------------------------------------

export function normalizeSqlitePlan(raw: unknown): { roots: PlanNode[] } {
  const rows = (raw as { rows?: Record<string, unknown>[] })?.rows ?? []
  if (rows.length === 0) return { roots: [makeNode('Empty plan')] }
  const byId = new Map<number, PlanNode>()
  const parentOf = new Map<number, number>()
  const order: number[] = []
  for (const row of rows) {
    const id = Number(row.id ?? row.ID ?? order.length)
    const parent = Number(row.parent ?? row.PARENT ?? 0)
    const detail = String(row.detail ?? row.DETAIL ?? Object.values(row)[3] ?? '')
    const scanTable = /SCAN\s+([^\s;]+)/i.exec(detail)?.[1]
    const searchTable = /SEARCH\s+([^\s;]+)/i.exec(detail)?.[1]
    const indexName = /USING\s+(?:\S+\s+)?INDEX\s+([^\s;)]+)/i.exec(detail)?.[1]
    const node = makeNode(detail, {
      relation: searchTable ?? scanTable,
      index: indexName
    })
    // detail de SCAN puro vira aviso via warnForNode (rows desconhecido não
    // dispara; então marca explicitamente quando não há índice).
    if (/SCAN/i.test(detail) && !/USING/i.test(detail) && !indexName) {
      node.warnings.push(
        `Full scan${scanTable ? ` on ${scanTable}` : ''}. Add an index or a selective filter.`
      )
    }
    byId.set(id, node)
    parentOf.set(id, parent)
    order.push(id)
  }
  const roots: PlanNode[] = []
  for (const id of order) {
    const node = byId.get(id)
    if (!node) continue
    const parent = parentOf.get(id) ?? 0
    if (parent === 0 || !byId.has(parent)) {
      roots.push(node)
    } else {
      byId.get(parent)?.children.push(node)
    }
  }
  return { roots: roots.length > 0 ? roots : [makeNode('Empty plan')] }
}

// ---------------------------------------------------------------------------
// SQL Server — SET SHOWPLAN_TEXT (linhas StmtText)
// ---------------------------------------------------------------------------

export function normalizeMssqlPlan(raw: unknown): { roots: PlanNode[] } {
  const rows = (raw as { rows?: Record<string, unknown>[] })?.rows ?? []
  const lines = rows
    .map((row) => String(row.StmtText ?? row.stmttext ?? Object.values(row)[0] ?? '').trimEnd())
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { roots: [makeNode('Empty plan')] }
  const root = makeNode('SQL Server estimated plan')
  for (const line of lines) {
    // Pula o próprio texto do SET e o eco da query quando presentes.
    if (/^set\s+showplan_text/i.test(line)) continue
    const objectMatch = /OBJECT:\(\[?([^\]]+)\]?\)/i.exec(line)
    const child = makeNode(line.trim().slice(0, 400), {
      relation: objectMatch ? objectMatch[1].replace(/^\[|\]$/g, '') : undefined
    })
    if (/table scan/i.test(line)) {
      child.warnings.push('Table scan detected. Consider a supporting index.')
    }
    root.children.push(child)
  }
  if (root.children.length === 0) root.children.push(makeNode(lines[0].slice(0, 400)))
  return { roots: [root] }
}

// ---------------------------------------------------------------------------
// Firebird — text plan (EXPLAIN on 6+, isc_info_sql_get_plan before that)
// ---------------------------------------------------------------------------

export function normalizeFirebirdPlan(raw: unknown): { roots: PlanNode[] } {
  const rows = (raw as { rows?: Record<string, unknown>[] })?.rows ?? []
  const text = rows
    .map((row) => String(row.plan ?? row.PLAN ?? Object.values(row)[0] ?? ''))
    .join('\n')
    .trim()
  if (!text) return { roots: [makeNode('Empty plan')] }

  const roots: PlanNode[] = []
  const stack: { indent: number; node: PlanNode }[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const operation = line.trim().replace(/^->\s*/, '')
    const relation =
      /(?:^|[\s(])([A-Z0-9_$]+)\s+(?:NATURAL|INDEX|FULL|ORDER|SORT|VIEW)/i.exec(operation)?.[1] ??
      /(?:table|relation)\s+"?([\w$]+)"?/i.exec(operation)?.[1]
    const index = /\bINDEX\s*\(?([\w$]+)\)?/i.exec(operation)?.[1]
    const node = makeNode(operation, { relation, index })
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    if (stack.length > 0) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ indent, node })
  }
  return { roots: roots.length > 0 ? roots : [makeNode('Empty plan')] }
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export function normalizePlan(dialect: DbKind, raw: unknown, analyze: boolean): ExplainResult {
  nodeCounter = 0
  let roots: PlanNode[] = [makeNode('Explain is not supported for this database.')]
  let planningMs: number | undefined
  let executionTimeMs: number | undefined
  if (dialect === 'postgres') {
    const parsed = normalizePostgresPlan(raw)
    roots = parsed.roots
    planningMs = parsed.planningMs
    executionTimeMs = parsed.executionTimeMs
  } else if (dialect === 'mysql') {
    roots = normalizeMysqlPlan(raw).roots
  } else if (dialect === 'sqlite') {
    roots = normalizeSqlitePlan(raw).roots
  } else if (dialect === 'mssql') {
    roots = normalizeMssqlPlan(raw).roots
  } else if (dialect === 'firebird') {
    roots = normalizeFirebirdPlan(raw).roots
  }
  for (const root of roots) attachWarnings(root)
  // Preserva avisos manuais do SQLite (full scan) junto dos heurísticos.
  const warnings = collectWarnings(roots)
  const totalCost = roots.reduce<number | undefined>((acc, root) => {
    const cost = root.costTotal ?? root.children.reduce((sum, child) => sum + (child.costTotal ?? 0), 0)
    if (cost === undefined || cost === 0) return acc
    return (acc ?? 0) + cost
  }, undefined)
  return { dialect, analyze, roots, warnings, totalCost, planningMs, executionTimeMs }
}

export function buildExplainSql(kind: DbKind, sql: string, analyze: boolean): string | null {
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  if (kind === 'postgres') {
    // TIMING is only meaningful/accepted with ANALYZE. Sending TIMING FALSE
    // on an estimated plan makes PostgreSQL reject the statement.
    return analyze
      ? `EXPLAIN (FORMAT JSON, ANALYZE TRUE, COSTS TRUE, TIMING TRUE) ${trimmed}`
      : `EXPLAIN (FORMAT JSON, ANALYZE FALSE, COSTS TRUE) ${trimmed}`
  }
  if (kind === 'mysql') {
    if (analyze) return `EXPLAIN ANALYZE ${trimmed}`
    return `EXPLAIN FORMAT=JSON ${trimmed}`
  }
  if (kind === 'sqlite') {
    return `EXPLAIN QUERY PLAN ${trimmed}`
  }
  // mssql usa batch com SHOWPLAN_TEXT (ver adapter) — sem SQL único.
  return null
}
