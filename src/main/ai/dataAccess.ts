import { randomUUID } from 'node:crypto'
import {
  formatProfileContext,
  formatSampleContext,
  profileTable,
  sampleTable,
  type DataRequest,
  type SampleResult,
  type TableProfile
} from './profile'

export type { DataRequest } from './profile'

export type DataMode = 'profile' | 'rows'

export interface DataApproval {
  token: string
  expiresAt: number
  mode: DataMode
  tables: string[]
  context: string
  rows: number
  maskedCells: number
}

interface StoredApproval extends DataApproval {
  connectionId: string
}

const TTL_MS = 60_000
const MAX_TABLES = 5
const MAX_CONTEXT_CHARS = 12_000
const approvals = new Map<string, StoredApproval>()

function prune(): void {
  const now = Date.now()
  for (const [token, approval] of approvals) {
    if (approval.expiresAt < now) approvals.delete(token)
  }
}

function tableName(request: DataRequest, table: string): string {
  return request.schema ? `${request.schema}.${table}` : table
}

function store(
  request: DataRequest,
  mode: DataMode,
  context: string,
  rows: number,
  maskedCells: number
): DataApproval {
  prune()
  const token = randomUUID()
  const expiresAt = Date.now() + TTL_MS
  const clipped = context.slice(0, MAX_CONTEXT_CHARS)
  approvals.set(token, {
    token,
    connectionId: request.connectionId,
    mode,
    tables: request.tables.map((table) => tableName(request, table)),
    context: clipped,
    rows,
    maskedCells,
    expiresAt
  })
  return {
    token,
    expiresAt,
    mode,
    tables: request.tables.map((table) => tableName(request, table)),
    context: clipped,
    rows,
    maskedCells
  }
}

/**
 * Aggregate profiling. The provider receives counts and hashed top values,
 * never row values; min/max of PII-named columns are redacted in profile.ts.
 */
export async function approveProfile(request: DataRequest): Promise<DataApproval> {
  if (request.tables.length === 0) throw new Error('Select at least one table to profile.')
  if (request.tables.length > MAX_TABLES) {
    throw new Error(`Profile at most ${MAX_TABLES} tables per request.`)
  }
  const profiles: TableProfile[] = []
  for (const table of request.tables) {
    profiles.push(await profileTable(request, table))
  }
  return store(request, 'profile', formatProfileContext(profiles), 0, 0)
}

/**
 * Raw row sampling. Every cell is masked before it is stored, and the token is
 * single-use and bound to the connection. The renderer only ever sees the
 * preview returned here, never an unmasked row.
 */
export async function approveSample(request: DataRequest): Promise<DataApproval> {
  if (request.tables.length === 0) throw new Error('Select at least one table to sample.')
  if (request.tables.length > 1) {
    throw new Error('Sample one table per approval so the preview stays reviewable.')
  }
  const samples: SampleResult[] = []
  for (const table of request.tables) {
    samples.push(await sampleTable(request, table))
  }
  const context = formatSampleContext(samples)
  const maskedCells = samples.reduce((total, sample) => total + sample.maskedCells, 0)
  const rows = samples.reduce((total, sample) => total + sample.rows.length, 0)
  return store(request, 'rows', context, rows, maskedCells)
}

export function consumeDataApproval(
  token: string | undefined,
  connectionId: string | undefined,
  mode?: DataMode
): DataApproval | null {
  if (!token || !connectionId) return null
  prune()
  const approval = approvals.get(token)
  if (!approval) return null
  if (approval.expiresAt < Date.now()) {
    approvals.delete(token)
    return null
  }
  if (approval.connectionId !== connectionId) return null
  if (mode && approval.mode !== mode) return null
  approvals.delete(token)
  return {
    token: approval.token,
    expiresAt: approval.expiresAt,
    mode: approval.mode,
    tables: approval.tables,
    context: approval.context,
    rows: approval.rows,
    maskedCells: approval.maskedCells
  }
}

/** Preview path: returns the same payload without spending the token. */
export function peekDataApproval(
  token: string | undefined,
  connectionId: string | undefined,
  mode?: DataMode
): DataApproval | null {
  if (!token || !connectionId) return null
  prune()
  const approval = approvals.get(token)
  if (!approval) return null
  if (approval.expiresAt < Date.now()) {
    approvals.delete(token)
    return null
  }
  if (approval.connectionId !== connectionId) return null
  if (mode && approval.mode !== mode) return null
  return {
    token: approval.token,
    expiresAt: approval.expiresAt,
    mode: approval.mode,
    tables: approval.tables,
    context: approval.context,
    rows: approval.rows,
    maskedCells: approval.maskedCells
  }
}
