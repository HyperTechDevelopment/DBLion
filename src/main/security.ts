import { createHash, randomUUID } from 'node:crypto'
import { classifyRedis, classifySql, isSessionKillSql } from '@shared/sql'
import { isReadOnlyAccess } from '@shared/access'
import type { AIMode, CsvImportRequest, KillSessionRequest, PersistedState, RowUpdateRequest } from '@shared/types'
import { readOnlySqlViolation } from './db/guard'
import { importCsvDetail, rowUpdateDetail, sessionKillDetail } from './db/sqlBuilder'

type ConfirmationKind = 'sql-write' | 'row-update' | 'explain-analyze' | 'import-csv' | 'session-kill'

interface TokenRecord {
  kind: ConfirmationKind
  detailHash: string
  expiresAt: number
}

const tokens = new Map<string, TokenRecord>()
const TOKEN_TTL_MS = 120000

/**
 * Per-connection read-only gate. Runs before any token or AI-mode logic so a
 * read-only profile can never be escalated by a renderer-supplied toggle or a
 * stolen confirmation token.
 */
function assertConnectionAllowsSql(
  state: PersistedState,
  connectionId: string,
  sql: string
): void {
  const connection = state.connections.find((item) => item.id === connectionId)
  if (!connection) return
  const violation = readOnlySqlViolation(connection, sql)
  if (violation) throw new Error(violation)
}

function assertConnectionAllowsWrite(state: PersistedState, connectionId: string, action: string): void {
  const connection = state.connections.find((item) => item.id === connectionId)
  if (!connection || !isReadOnlyAccess(connection)) return
  throw new Error(
    `Connection “${connection.name}” is read-only. ${action} is blocked; connect a read-write profile with its own credential.`
  )
}

function authorizeRedis(
  state: PersistedState,
  connectionId: string,
  sql: string,
  allowWrites: boolean,
  confirmationToken?: string
): void {
  const command = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  const redisClass = classifyRedis(sql)
  if (redisClass === 'read') return
  if (state.settings.readOnly) {
    throw new Error('Global read-only mode is enabled. Redis writes are blocked.')
  }
  if (!allowWrites) {
    throw new Error('The write toggle is off. Enable “Allow writes” for this Redis command.')
  }
  if (state.settings.aiMode === 'read') {
    throw new Error('AI mode is “read”. Switch to “edit” or “full” to execute Redis writes.')
  }
  if (redisClass === 'destructive' && state.settings.aiMode !== 'full') {
    throw new Error(`Redis ${command} is destructive and requires AI mode “full”.`)
  }
  const detail = `${connectionId}|${sql}`
  if (!consumeConfirmationToken(confirmationToken, 'sql-write', detail)) {
    throw new Error('This Redis command needs an explicit confirmation. Approve the dialog and retry.')
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim()
}

export function createConfirmationToken(kind: ConfirmationKind, detail: string): string {
  const now = Date.now()
  for (const [token, record] of tokens) {
    if (record.expiresAt < now) tokens.delete(token)
  }
  const token = randomUUID()
  tokens.set(token, {
    kind,
    detailHash: hash(normalizeDetail(detail)),
    expiresAt: now + TOKEN_TTL_MS
  })
  return token
}

export function consumeConfirmationToken(
  token: string | undefined,
  kind: ConfirmationKind,
  detail: string
): boolean {
  if (!token) return false
  const record = tokens.get(token)
  if (!record) return false
  if (record.expiresAt < Date.now()) {
    tokens.delete(token)
    return false
  }
  if (record.kind !== kind || record.detailHash !== hash(normalizeDetail(detail))) {
    return false
  }
  tokens.delete(token)
  return true
}

export function authorizeSql(
  state: PersistedState,
  connectionId: string,
  sql: string,
  allowWrites: boolean,
  confirmationToken?: string
): void {
  // Kill NUNCA via db:query — nem com full + token genérico.
  if (isSessionKillSql(sql)) {
    throw new Error(
      'Session termination is blocked in free SQL. Use Sessions → Kill with confirmation (db:kill-session).'
    )
  }
  assertConnectionAllowsSql(state, connectionId, sql)
  const connection = state.connections.find((item) => item.id === connectionId)
  if (connection?.kind === 'redis') {
    authorizeRedis(state, connectionId, sql, allowWrites, confirmationToken)
    return
  }

  const sqlClass = classifySql(sql)
  if (sqlClass === 'read') return

  const mode: AIMode = state.settings.aiMode
  if (state.settings.readOnly) {
    throw new Error('Global read-only mode is enabled. Turn it off in Settings → Safety before writing.')
  }
  if (!allowWrites) {
    throw new Error('The write toggle is off. Enable “Allow writes” for this statement.')
  }
  if (mode === 'read') {
    throw new Error('AI mode is “read”. Switch to “edit” or “full” to execute writes.')
  }
  if (sqlClass === 'ddl' && mode !== 'full') {
    throw new Error('DDL statements require AI mode “full”.')
  }

  const detail = `${connectionId}|${sql}`
  if (!consumeConfirmationToken(confirmationToken, 'sql-write', detail)) {
    throw new Error(
      'This statement needs an explicit confirmation. Approve the confirmation dialog and retry.'
    )
  }
}

export function authorizeRowUpdate(
  state: PersistedState,
  request: RowUpdateRequest,
  confirmationToken?: string
): void {
  assertConnectionAllowsWrite(state, request.connectionId, 'Row editing')
  if (state.settings.readOnly) {
    throw new Error('Global read-only mode is enabled. Turn it off in Settings → Safety before editing rows.')
  }
  if (!request.allowWrites) {
    throw new Error('The write toggle is off. Enable “Writes” before editing a row.')
  }
  if (state.settings.aiMode === 'read') {
    throw new Error('AI mode is “read”. Switch to “edit” or “full” to edit rows.')
  }
  if (!consumeConfirmationToken(confirmationToken, 'row-update', rowUpdateDetail(request))) {
    throw new Error('This row update needs an explicit confirmation. Preview it and approve the dialog.')
  }
}

export function authorizeCsvImport(
  state: PersistedState,
  request: CsvImportRequest,
  hasPrimaryKey: boolean,
  confirmationToken?: string
): void {
  assertConnectionAllowsWrite(state, request.connectionId, 'CSV import')
  if (state.settings.readOnly) {
    throw new Error('Global read-only mode is enabled. Turn it off in Settings → Safety before importing CSV.')
  }
  if (!request.allowWrites) {
    throw new Error('The write toggle is off. Enable “Writes” before importing CSV.')
  }
  if (state.settings.aiMode === 'read') {
    throw new Error('AI mode is “read”. Switch to “edit” or “full” to import CSV.')
  }
  if (!hasPrimaryKey && state.settings.aiMode !== 'full') {
    throw new Error(
      'The target table has no primary key. CSV import into it requires AI mode “full” plus the write toggle.'
    )
  }
  if (!consumeConfirmationToken(confirmationToken, 'import-csv', importCsvDetail(request))) {
    throw new Error('This CSV import needs an explicit confirmation. Preview it and approve the dialog.')
  }
}

export function authorizeSessionKill(
  state: PersistedState,
  request: KillSessionRequest,
  confirmationToken?: string
): void {
  assertConnectionAllowsWrite(state, request.connectionId, 'Session termination')
  if (state.settings.readOnly) {
    throw new Error('Global read-only mode is enabled. Turn it off in Settings → Safety before killing sessions.')
  }
  if (state.settings.aiMode !== 'full') {
    throw new Error('Killing a session requires AI mode “full”.')
  }
  if (!consumeConfirmationToken(confirmationToken, 'session-kill', sessionKillDetail(request))) {
    throw new Error('Killing this session needs an explicit confirmation. Preview it and approve the dialog.')
  }
}

export function explainAnalyzeDetail(connectionId: string, sql: string): string {
  return `explain-analyze|${connectionId}|${normalizeDetail(sql)}`
}

export function authorizeExplainAnalyze(
  _state: PersistedState,
  connectionId: string,
  sql: string,
  confirmationToken?: string
): void {
  // ANALYZE executa o SELECT de verdade (mede tempo/linhas). O adapter roda
  // dentro de uma transação READ ONLY; este gate exige confirmação própria,
  // nunca reutilizando tokens de sql-write/row-update.
  if (
    !consumeConfirmationToken(
      confirmationToken,
      'explain-analyze',
      explainAnalyzeDetail(connectionId, sql)
    )
  ) {
    throw new Error(
      'EXPLAIN ANALYZE executes the query. Approve the confirmation dialog and retry.'
    )
  }
}
