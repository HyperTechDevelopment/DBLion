import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AIProfile,
  AiContextPreview,
  AppSettings,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ConnectionConfig,
  CsvImportRequest,
  ExplainRequest,
  KillSessionRequest,
  MigrationSaveRequest,
  PersistedState,
  QueryHistoryEntry,
  RowUpdateRequest,
  SchemaObjectRef,
  TableInfo,
  TablePageRequest
} from '@shared/types'
import { loadState, saveState, toPublicState } from './storage'
import { normalizeAccessMode, accessModeOf, readOnlyEnforcement } from '@shared/access'
import {
  buildSchemaContext,
  capabilitiesFor,
  cancelQuery,
  catalog,
  connect,
  describe,
  diffSchemas,
  disconnect,
  disconnectAll,
  explain,
  graph,
  getRuntime,
  killSession,
  objectDdl,
  listSessions,
  previewKillSession,
  query,
  schema,
  status,
  testConnection,
  tablePage,
  previewRowUpdate,
  applyRowUpdate,
  previewCsvImport,
  applyCsvImport,
  transaction
} from './db'
import type { ColumnRef } from './db/types'
import { classifyRedis, classifySql, getExplainBlockReason } from '@shared/sql'
import { appendAudit, readAudit, toErrorCode } from './audit'
import { listMigrations, readMigration, saveMigration } from './migrations'
import { listModels, streamChat } from './ai/providers'
import { buildAiContext, toContextPreview, type AiContext } from './ai/context'
import { selectSchemaTables } from './ai/schemaFocus'
import { getSchemaIndex, invalidateSchemaIndex, type SchemaIndexData } from './ai/schemaIndex'
import { consumeDataApproval, peekDataApproval, type DataApproval } from './ai/dataAccess'
import { registerAiDataIpc } from './aiDataIpc'
import { redactJson, redactText } from './ai/redact'
import { buildSkillsContext, listSkills, readSkill, searchSkills } from './skills'
import {
  authorizeCsvImport,
  authorizeExplainAnalyze,
  authorizeRowUpdate,
  authorizeSessionKill,
  authorizeSql,
  createConfirmationToken
} from './security'

const activeRequests = new Map<string, AbortController>()

/**
 * Completion fires while the user types, so the schema snapshot is cached for
 * a short window instead of re-reading metadata on every keystroke. It is read
 * from the live connection in main, never supplied by the renderer.
 */
const COMPLETION_SCHEMA_TTL_MS = 30_000
const COMPLETION_SCHEMA_MAX_CHARS = 12_000
const completionSchemaCache = new Map<string, { at: number; context: string }>()

async function completionSchema(connectionId: string): Promise<string> {
  const cached = completionSchemaCache.get(connectionId)
  if (cached && Date.now() - cached.at < COMPLETION_SCHEMA_TTL_MS) return cached.context
  const payload = await schema(connectionId)
  const context = payload.context.slice(0, COMPLETION_SCHEMA_MAX_CHARS)
  completionSchemaCache.set(connectionId, { at: Date.now(), context })
  return context
}

function state(): Promise<PersistedState> {
  return loadState()
}

function getProfile(current: PersistedState, id: string): AIProfile {
  const profile = current.profiles.find((item) => item.id === id)
  if (!profile) throw new Error(`AI profile not found: ${id}`)
  return profile
}

function getConnection(current: PersistedState, id: string): ConnectionConfig {
  const connection = current.connections.find((item) => item.id === id)
  if (!connection) throw new Error(`Connection not found: ${id}`)
  return connection
}

function sendChunk(event: IpcMainInvokeEvent, chunk: ChatChunk): void {
  if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', chunk)
}

interface AiContextRequest {
  messages: ChatMessage[]
  connectionId?: string
  skillIds?: string[]
  autoSkills?: boolean
}

const FOCUSED_TABLE_LIMIT = 20
const SCHEMA_CONTEXT_MAX_CHARS = 12_000

/**
 * One metadata read feeds the schema index: the table list plus the column
 * names, so ranking by column costs no describeTable per table.
 */
async function loadSchemaIndexData(connectionId: string): Promise<SchemaIndexData> {
  const adapter = getRuntime(connectionId).adapter
  const tables = await adapter.listTables()
  if (!adapter.columnsIndex) return { tables, columns: [] }
  try {
    return { tables, columns: await adapter.columnsIndex() }
  } catch {
    // Ranking by column is a bonus: a metadata gap must not remove the context.
    return { tables, columns: [] }
  }
}

/**
 * A database with thousands of tables cannot be described by an alphabetical
 * prefix: the table the user asked about may sit in the middle. Pick the names
 * that match the request — by table name, column name or comment — and describe
 * only those. Pinned tables always go in, up to the pinned limit.
 */
async function focusedSchemaContext(
  connectionId: string,
  tables: TableInfo[],
  prompt: string,
  options: { columns?: ColumnRef[]; pinnedTables?: string[] } = {}
): Promise<{ context: string; withColumns: number }> {
  const picked = selectSchemaTables(tables, prompt, {
    limit: FOCUSED_TABLE_LIMIT,
    columns: options.columns,
    pinnedTables: options.pinnedTables
  })
  const lines: string[] = []
  let withColumns = 0
  for (const table of picked) {
    const comment = table.comment?.replace(/\s+/g, ' ').trim().slice(0, 120)
    const label = `${table.schema ? `${table.schema}.` : ''}${table.name}${comment ? ` -- ${comment}` : ''}`
    try {
      const details = await describe(connectionId, table.schema, table.name)
      const columns = details.columns
        .map((column) => `${column.name}:${column.type}`)
        .join(', ')
      if (columns) withColumns += 1
      lines.push(`${label}(${columns})`)
    } catch {
      lines.push(label)
    }
    if (lines.join('\n').length >= SCHEMA_CONTEXT_MAX_CHARS) break
  }
  return {
    context: `${tables.length} tables in this database. Showing ${lines.length} selected for this request:\n${lines.join('\n')}`.slice(
      0,
      SCHEMA_CONTEXT_MAX_CHARS
    ),
    withColumns
  }
}

/**
 * Resolves everything the model would receive, in the main process.
 *
 * The main process is the authority for schema and skill context: renderer-
 * supplied context is ignored so a compromised renderer cannot spoof the
 * model. `ai:chat`, `ai:complete` and `ai:context-preview` all go through this
 * builder, so a preview cannot drift from the real request.
 */
async function prepareAiContext(
  current: PersistedState,
  profile: AIProfile,
  request: AiContextRequest,
  dataApproval: DataApproval | null = null
): Promise<AiContext> {
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')?.content
  let schemaContext: string | undefined
  let schemaWarning: string | undefined
  if (request.connectionId && profile.sendSchema) {
    const connectionId = request.connectionId
    try {
      // Main reads the metadata from the live connection; the renderer never
      // supplies it. The index is per connection, memory only, 10 minutes.
      const index = await getSchemaIndex(connectionId, () => loadSchemaIndexData(connectionId))
      // Pins come from the saved connection profile and are resolved against
      // the live table list, so an unknown name is dropped, never echoed.
      const pinnedTables = current.connections.find((item) => item.id === connectionId)
        ?.pinnedTables
      if (index.tables.length > 60 && lastUser) {
        const focused = await focusedSchemaContext(connectionId, index.tables, lastUser, {
          columns: index.columns,
          pinnedTables
        })
        schemaContext = focused.context
        schemaWarning =
          focused.withColumns > 0
            ? undefined
            : 'Columns could not be read for the tables matched by this request.'
      } else {
        const built = await buildSchemaContext(connectionId, index.tables)
        schemaContext = built.context
        schemaWarning = built.warning
      }
    } catch (error) {
      // Never drop this silently: the model then tells the user it received no
      // schema, and the UI has no way to explain why.
      const message = error instanceof Error ? error.message : String(error)
      schemaWarning = `Schema could not be read: ${message}`
    }
  }
  const skillsContext = await buildSkillsContext(
    request.skillIds ?? [],
    request.autoSkills && lastUser ? lastUser : undefined
  )

  return buildAiContext({
    profile,
    messages: request.messages,
    schemaContext,
    schemaWarning,
    skillsContext,
    dataContext: dataApproval?.context,
    dataRows: dataApproval?.rows,
    dataMaskedCells: dataApproval?.maskedCells
  })
}

function assertHttpUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('The model endpoint must be a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The model endpoint must use http or https.')
  }
}

async function confirmSafetyChange(
  current: AppSettings,
  next: AppSettings
): Promise<void> {
  const removesReadOnly = current.readOnly && !next.readOnly
  const raisesMode = next.aiMode !== 'read' && next.aiMode !== current.aiMode
  if (!removesReadOnly && !raisesMode) return
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    title: 'Change DBLion safety mode?',
    message: removesReadOnly
      ? 'Global read-only mode will be disabled.'
      : `AI mode will change to “${next.aiMode}”.`,
    detail:
      'Writes will still require the toolbar write toggle and a native confirmation for each statement.',
    noLink: true
  })
  if (result.response !== 1) throw new Error('Operation canceled by user')
}

export function registerIpc(): void {
  registerAiDataIpc()
  ipcMain.handle('state:get', async () => toPublicState(await state()))

  ipcMain.handle('connection:save', async (_event, input: ConnectionConfig) => {
    const current = await state()
    const connection: ConnectionConfig = {
      ...input,
      id: input.id || randomUUID(),
      name: input.name?.trim() || input.kind,
      // New profiles are read-only unless the user explicitly chooses
      // read-write in the connection wizard.
      accessMode: normalizeAccessMode(input.accessMode)
    }
    const index = current.connections.findIndex((item) => item.id === connection.id)
    if (index >= 0) {
      const previous = current.connections[index]
      if (input.password === undefined) connection.password = previous.password
      // Pins belong to the explorer: a payload that carries none (older renderer,
      // duplicated profile) must not wipe the saved list.
      if (!Array.isArray(input.pinnedTables)) connection.pinnedTables = previous.pinnedTables
      if (connection.ssh && previous.ssh) {
        connection.ssh.password = connection.ssh.password ?? previous.ssh.password
        connection.ssh.privateKey = connection.ssh.privateKey ?? previous.ssh.privateKey
      }
      if (normalizeAccessMode(previous.accessMode) !== connection.accessMode) {
        // The policy is applied when the session is opened (session read-only,
        // pragma, isc_tpb_read). A live adapter keeps the old policy, so close
        // it and let the next connect apply the new one. DBeaver invalidates
        // the datasource for the same reason.
        await disconnect(connection.id)
        invalidateSchemaIndex(connection.id)
        await appendAudit({
          id: randomUUID(),
          at: Date.now(),
          connectionId: connection.id,
          action: 'safety-change',
          allowWrites: connection.accessMode === 'read-write',
          ok: true,
          detail: `accessMode=${connection.accessMode}; live connection closed`
        })
      }
      current.connections[index] = connection
    } else {
      current.connections.push(connection)
    }
    if (!current.settings.activeConnectionId) current.settings.activeConnectionId = connection.id
    return saveState(current)
  })

  ipcMain.handle('connection:delete', async (_event, id: string) => {
    const current = await state()
    await disconnect(id)
    invalidateSchemaIndex(id)
    current.connections = current.connections.filter((item) => item.id !== id)
    if (current.settings.activeConnectionId === id) {
      current.settings.activeConnectionId = current.connections[0]?.id
    }
    return saveState(current)
  })

  ipcMain.handle('connection:test', async (_event, connection: ConnectionConfig) => {
    const current = await state()
    const existing = current.connections.find((item) => item.id === connection.id)
    return testConnection({
      ...connection,
      password: connection.password ?? existing?.password,
      ssh:
        connection.ssh && existing?.ssh
          ? {
              ...connection.ssh,
              password: connection.ssh.password ?? existing.ssh.password,
              privateKey: connection.ssh.privateKey ?? existing.ssh.privateKey
            }
          : connection.ssh
    })
  })

  ipcMain.handle('connection:connect', async (_event, id: string) => {
    const current = await state()
    // A new session may expose different metadata; never reuse the old index.
    invalidateSchemaIndex(id)
    const result = await connect(getConnection(current, id))
    await appendAudit({
      id: randomUUID(),
      at: Date.now(),
      connectionId: id,
      action: 'connect',
      ok: result.ok,
      error: result.ok ? undefined : result.message
    })
    return result
  })

  ipcMain.handle('connection:disconnect', async (_event, id: string) => {
    await disconnect(id)
    completionSchemaCache.delete(id)
    invalidateSchemaIndex(id)
    await appendAudit({
      id: randomUUID(),
      at: Date.now(),
      connectionId: id,
      action: 'disconnect',
      ok: true
    })
  })

  ipcMain.handle('connection:status', () => status())
  ipcMain.handle('audit:list', async (_event, limit?: number) => readAudit(limit ?? 200))
  ipcMain.handle('db:capabilities', async (_event, id: string) => {
    const current = await state()
    const connection = getConnection(current, id)
    const accessMode = accessModeOf(connection)
    return {
      ...capabilitiesFor(connection.kind),
      // Main is the authority for the badge the renderer shows.
      accessMode,
      readOnly: accessMode === 'read-only',
      readOnlyEnforcement: readOnlyEnforcement(connection.kind)
    }
  })

  ipcMain.handle(
    'db:query',
    async (
      _event,
      payload: {
        id: string
        sql: string
        params?: unknown[]
        allowWrites?: boolean
        confirmationToken?: string
        source?: 'editor' | 'selection' | 'ai'
        schemaFingerprint?: string
      }
    ) => {
      const current = await state()
      authorizeSql(
        current,
        payload.id,
        payload.sql,
        payload.allowWrites ?? false,
        payload.confirmationToken
      )
      const connection = current.connections.find((item) => item.id === payload.id)
      const sqlClass =
        connection?.kind === 'redis' ? classifyRedis(payload.sql) : classifySql(payload.sql)
      const startedAt = Date.now()
      // source vem do renderer (App.tsx runSql); default 'editor' para callers antigos.
      const source =
        payload.source === 'ai' || payload.source === 'selection' ? payload.source : 'editor'
      const tokenUsed = Boolean(payload.confirmationToken)
      // PII: nunca persistir SQL bruto — redact antes de appendAudit.
      const redactedDetail = redactText(payload.sql.slice(0, 4000))
      try {
        // AI reads run inside a database-enforced read-only transaction. The
        // classifier cannot see a write hidden inside a function call, so the
        // engine becomes the boundary for AI-originated SELECT/WITH statements.
        const fenceAiRead = source === 'ai' && sqlClass === 'read'
        const result = await query(
          payload.id,
          payload.sql,
          payload.params ?? [],
          payload.allowWrites ?? false,
          {
            maxRows: current.settings.maxRows,
            timeoutMs: current.settings.queryTimeoutMs,
            readOnlyTransaction: fenceAiRead
          }
        )
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.id,
          action: 'query',
          source,
          sqlClass,
          schemaFingerprint: payload.schemaFingerprint,
          aiMode: current.settings.aiMode,
          allowWrites: payload.allowWrites ?? false,
          confirmationUsed: tokenUsed,
          tokenUsed,
          durationMs: Date.now() - startedAt,
          rowCount: result.rowCount,
          ok: true,
          detail: redactedDetail
        })
        return result
      } catch (error) {
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.id,
          action: 'query',
          source,
          sqlClass,
          schemaFingerprint: payload.schemaFingerprint,
          aiMode: current.settings.aiMode,
          allowWrites: payload.allowWrites ?? false,
          confirmationUsed: tokenUsed,
          tokenUsed,
          durationMs: Date.now() - startedAt,
          ok: false,
          errorCode: toErrorCode(error),
          error:
            error instanceof Error ? redactText(error.message) : redactText(String(error)),
          detail: redactedDetail
        })
        throw error
      }
    }
  )

  ipcMain.handle('db:cancel', async (_event, id: string) => cancelQuery(id))

  ipcMain.handle('db:explain', async (_event, request: ExplainRequest) => {
    const current = await state()
    const analyze = request.analyze === true
    // Gate 0 (rápido, sem I/O): só SELECT/WITH puros. Nunca executa DML aqui.
    const blocked = getExplainBlockReason(request.sql)
    if (blocked) throw new Error(`Explain rejected: ${blocked}`)
    if (classifySql(request.sql) !== 'read') {
      throw new Error('Explain rejected: only read-only SELECT/WITH queries are allowed.')
    }
    if (analyze) {
      authorizeExplainAnalyze(current, request.connectionId, request.sql, request.confirmationToken)
    }
    const startedAt = Date.now()
    const source =
      request.source === 'ai' || request.source === 'selection' ? request.source : 'editor'
    const tokenUsed = analyze && Boolean(request.confirmationToken)
    // PII: nunca persistir SQL bruto — redact antes de appendAudit.
    const redactedDetail = redactText(
      `analyze=${analyze}; ${request.sql.slice(0, 2000)}`
    )
    try {
      const result = await explain(request.connectionId, request.sql, analyze, {
        timeoutMs: current.settings.queryTimeoutMs
      })
      await appendAudit({
        id: randomUUID(),
        at: startedAt,
        connectionId: request.connectionId,
        action: 'explain',
        source,
        sqlClass: 'explain',
        schemaFingerprint: request.schemaFingerprint,
        aiMode: current.settings.aiMode,
        allowWrites: false,
        confirmationUsed: tokenUsed,
        tokenUsed,
        durationMs: Date.now() - startedAt,
        ok: true,
        detail: redactedDetail
      })
      // PII: plano normalizado pode conter literais em Filter/Condition —
      // redact antes de devolver ao renderer (display) e antes de auditar.
      return redactJson(result) as typeof result
    } catch (error) {
      await appendAudit({
        id: randomUUID(),
        at: startedAt,
        connectionId: request.connectionId,
        action: 'explain',
        source,
        sqlClass: 'explain',
        schemaFingerprint: request.schemaFingerprint,
        aiMode: current.settings.aiMode,
        allowWrites: false,
        confirmationUsed: tokenUsed,
        tokenUsed,
        durationMs: Date.now() - startedAt,
        ok: false,
        errorCode: toErrorCode(error),
        error: error instanceof Error ? redactText(error.message) : redactText(String(error)),
        detail: redactedDetail
      })
      throw error instanceof Error ? new Error(redactText(error.message)) : error
    }
  })

  ipcMain.handle(
    'db:transaction',
    async (_event, payload: { id: string; action: 'begin' | 'commit' | 'rollback' }) => {
      const startedAt = Date.now()
      try {
        await transaction(payload.id, payload.action)
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.id,
          action: 'transaction',
          ok: true,
          detail: payload.action
        })
      } catch (error) {
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.id,
          action: 'transaction',
          ok: false,
          detail: payload.action,
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    }
  )

  ipcMain.handle('db:schema', async (_event, id: string) => {
    // Explored as "refresh schema" in the renderer: drop the AI index with it so
    // the next AI request reads the new metadata instead of a stale snapshot.
    invalidateSchemaIndex(id)
    return schema(id)
  })
  ipcMain.handle('db:describe', async (_event, payload: { id: string; schema?: string; table: string }) =>
    describe(payload.id, payload.schema, payload.table)
  )

  ipcMain.handle('db:table-page', async (_event, request: TablePageRequest) =>
    tablePage(request)
  )

  ipcMain.handle('db:row-preview', async (_event, request: RowUpdateRequest) =>
    previewRowUpdate(request)
  )

  ipcMain.handle(
    'db:row-apply',
    async (_event, payload: { request: RowUpdateRequest; confirmationToken: string }) => {
      const current = await state()
      authorizeRowUpdate(current, payload.request, payload.confirmationToken)
      const startedAt = Date.now()
      const redactedTable = redactText(
        `${payload.request.schema ?? ''}.${payload.request.table}`.slice(0, 500)
      )
      try {
        const result = await applyRowUpdate(payload.request)
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.request.connectionId,
          action: 'query',
          source: 'table',
          sqlClass: 'row-update',
          aiMode: current.settings.aiMode,
          allowWrites: true,
          confirmationUsed: true,
          tokenUsed: true,
          durationMs: Date.now() - startedAt,
          rowCount: result.rowCount,
          ok: true,
          detail: redactedTable
        })
        return result
      } catch (error) {
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.request.connectionId,
          action: 'query',
          source: 'table',
          sqlClass: 'row-update',
          aiMode: current.settings.aiMode,
          allowWrites: true,
          confirmationUsed: true,
          tokenUsed: true,
          durationMs: Date.now() - startedAt,
          ok: false,
          errorCode: toErrorCode(error),
          error:
            error instanceof Error ? redactText(error.message) : redactText(String(error)),
          detail: redactedTable
        })
        throw error
      }
    }
  )
  ipcMain.handle('db:graph', async (_event, payload: { id: string; schema?: string }) =>
    graph(payload.id, payload.schema)
  )

  ipcMain.handle('db:catalog', async (_event, payload: { id: string; schema?: string }) =>
    catalog(payload.id, payload.schema)
  )

  ipcMain.handle(
    'db:ddl',
    async (_event, payload: { connectionId: string; object: SchemaObjectRef }) =>
      objectDdl(payload.connectionId, payload.object)
  )

  ipcMain.handle(
    'db:diff',
    async (
      _event,
      payload: { leftConnectionId: string; rightConnectionId: string; schema?: string }
    ) => diffSchemas(payload.leftConnectionId, payload.rightConnectionId, payload.schema)
  )

  ipcMain.handle('migrations:list', async () => listMigrations())
  ipcMain.handle('migrations:read', async (_event, id: string) => readMigration(id))
  ipcMain.handle('migrations:save', async (_event, request: MigrationSaveRequest) => {
    const saved = await saveMigration(request)
    await appendAudit({
      id: randomUUID(),
      at: Date.now(),
      action: 'migration',
      source: 'schema-diff',
      ok: true,
      detail: `${saved.name} (${saved.hash.slice(0, 12)})`
    })
    return saved
  })

  ipcMain.handle('db:sessions', async (_event, connectionId: string) =>
    listSessions(connectionId)
  )

  ipcMain.handle('db:kill-preview', async (_event, request: KillSessionRequest) =>
    previewKillSession(request)
  )

  ipcMain.handle(
    'db:kill-session',
    async (
      _event,
      payload: {
        request: KillSessionRequest
        confirmationToken: string
        source?: string
        schemaFingerprint?: string
      }
    ) => {
      const current = await state()
      const request: KillSessionRequest = {
        connectionId: payload.request.connectionId,
        sessionId: String(payload.request.sessionId),
        mode: payload.request.mode ?? 'terminate'
      }
      const source =
        typeof payload.source === 'string' && payload.source.length > 0
          ? payload.source.slice(0, 32)
          : 'editor'
      const tokenUsed = Boolean(payload.confirmationToken)
      const startedAt = Date.now()
      const redactedDetail = redactText(
        `session=${request.sessionId} mode=${request.mode ?? 'terminate'}`.slice(0, 500)
      )
      try {
        authorizeSessionKill(current, request, payload.confirmationToken)
        await killSession(request)
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: request.connectionId,
          action: 'session-kill',
          source,
          aiMode: current.settings.aiMode,
          allowWrites: true,
          confirmationUsed: true,
          tokenUsed: true,
          schemaFingerprint: payload.schemaFingerprint,
          durationMs: Date.now() - startedAt,
          ok: true,
          detail: redactedDetail
        })
        return { ok: true }
      } catch (error) {
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: request.connectionId,
          action: 'session-kill',
          source,
          aiMode: current.settings.aiMode,
          allowWrites: true,
          confirmationUsed: tokenUsed,
          tokenUsed,
          schemaFingerprint: payload.schemaFingerprint,
          durationMs: Date.now() - startedAt,
          ok: false,
          errorCode: toErrorCode(error),
          error:
            error instanceof Error ? redactText(error.message) : redactText(String(error)),
          detail: redactedDetail
        })
        throw error
      }
    }
  )

  ipcMain.handle('db:import-preview', async (_event, request: CsvImportRequest) =>
    previewCsvImport(request)
  )

  ipcMain.handle(
    'db:import-apply',
    async (
      _event,
      payload: { request: CsvImportRequest; confirmationToken: string; schemaFingerprint?: string }
    ) => {
      const current = await state()
      // Enforcement lives here in main (capability + token + PK rule), never only in the UI.
      const details = await describe(
        payload.request.connectionId,
        payload.request.schema,
        payload.request.table
      )
      authorizeCsvImport(
        current,
        payload.request,
        details.primaryKey.length > 0,
        payload.confirmationToken
      )
      const startedAt = Date.now()
      const tokenUsed = Boolean(payload.confirmationToken)
      const redactedTable = redactText(
        `${payload.request.schema ?? ''}.${payload.request.table}`.slice(0, 500)
      )
      const redactedMapping = redactText(
        Object.keys(payload.request.mapping ?? {})
          .sort()
          .map((key) => `${key}->${(payload.request.mapping as Record<string, string>)[key]}`)
          .join(', ')
          .slice(0, 1000)
      )
      try {
        const result = await applyCsvImport(payload.request, {
          maxRows: current.settings.maxRows,
          timeoutMs: current.settings.queryTimeoutMs
        })
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.request.connectionId,
          action: 'import',
          source: 'import',
          sqlClass: 'import',
          schemaFingerprint: payload.schemaFingerprint ?? payload.request.schemaFingerprint,
          aiMode: current.settings.aiMode,
          allowWrites: true,
          confirmationUsed: tokenUsed,
          tokenUsed,
          durationMs: Date.now() - startedAt,
          rowCount: result.rowCount,
          ok: true,
          detail: redactedTable
            ? `${redactedTable} mapping=[${redactedMapping}]`
            : `mapping=[${redactedMapping}]`
        })
        return result
      } catch (error) {
        await appendAudit({
          id: randomUUID(),
          at: startedAt,
          connectionId: payload.request.connectionId,
          action: 'import',
          source: 'import',
          sqlClass: 'import',
          schemaFingerprint: payload.schemaFingerprint ?? payload.request.schemaFingerprint,
          aiMode: current.settings.aiMode,
          allowWrites: true,
          confirmationUsed: tokenUsed,
          tokenUsed,
          durationMs: Date.now() - startedAt,
          ok: false,
          errorCode: toErrorCode(error),
          error:
            error instanceof Error ? redactText(error.message) : redactText(String(error)),
          detail: redactedTable
            ? `${redactedTable} mapping=[${redactedMapping}]`
            : `mapping=[${redactedMapping}]`
        })
        throw error
      }
    }
  )

  ipcMain.handle(
    'query:history:add',
    async (
      _event,
      input: Omit<QueryHistoryEntry, 'id' | 'at'> & { at?: number }
    ): Promise<PersistedState> => {
      const current = await state()
      const entry: QueryHistoryEntry = {
        ...input,
        id: randomUUID(),
        at: input.at ?? Date.now()
      }
      current.queryHistory = [entry, ...current.queryHistory].slice(0, 200)
      return saveState(current)
    }
  )

  ipcMain.handle('query:history:clear', async (): Promise<PersistedState> => {
    const current = await state()
    current.queryHistory = []
    return saveState(current)
  })

  ipcMain.handle(
    'file:save-text',
    async (_event, payload: { defaultName: string; content: string }): Promise<string | null> => {
      const extension = payload.defaultName.split('.').pop()?.toLowerCase() || 'txt'
      const result = await dialog.showSaveDialog({
        title: 'Export query result',
        defaultPath: path.join(app.getPath('documents'), payload.defaultName),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
      })
      if (result.canceled || !result.filePath) return null
      await fs.writeFile(result.filePath, payload.content, 'utf8')
      return result.filePath
    }
  )

  ipcMain.handle('profile:save', async (_event, input: AIProfile) => {
    const current = await state()
    const profile: AIProfile = {
      ...input,
      id: input.id || randomUUID(),
      name: input.name?.trim() || input.provider
    }
    const index = current.profiles.findIndex((item) => item.id === profile.id)
    if (index >= 0) {
      if (input.apiKey === undefined) profile.apiKey = current.profiles[index].apiKey
      current.profiles[index] = profile
    } else {
      current.profiles.push(profile)
    }
    if (!current.settings.activeProfileId) current.settings.activeProfileId = profile.id
    return saveState(current)
  })

  ipcMain.handle('profile:delete', async (_event, id: string) => {
    const current = await state()
    current.profiles = current.profiles.filter((item) => item.id !== id)
    if (current.settings.activeProfileId === id) {
      current.settings.activeProfileId = current.profiles[0]?.id
    }
    return saveState(current)
  })

  ipcMain.handle('ai:models', async (_event, profileId: string) => {
    const current = await state()
    return listModels(getProfile(current, profileId))
  })

  ipcMain.handle('ai:models-draft', async (_event, profile: AIProfile) => {
    const current = await state()
    const existing = current.profiles.find((item) => item.id === profile.id)
    const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '')
    // The renderer never holds the stored key (toPublicState strips it), so a
    // non-empty apiKey means the user retyped it during this session.
    const sessionKey =
      typeof profile.apiKey === 'string' && profile.apiKey.length > 0 ? profile.apiKey : ''

    if (!existing) {
      // New profile: only the session-typed key is ever used.
      const baseUrl = profile.baseUrl || ''
      if (!baseUrl) throw new Error('The model endpoint is required.')
      assertHttpUrl(baseUrl)
      return listModels({ ...profile, baseUrl, apiKey: sessionKey })
    }

    if (sessionKey) {
      // Key retyped in session: a new/edited endpoint may be tested, but only
      // with the session key — never the stored key plus a renderer URL.
      const baseUrl = profile.baseUrl || existing.baseUrl
      if (!baseUrl) throw new Error('The model endpoint is required.')
      assertHttpUrl(baseUrl)
      return listModels({ ...profile, baseUrl, apiKey: sessionKey })
    }

    // Existing profile without a retyped key: strictly use the persisted
    // endpoint and stored key. A differing renderer baseUrl is rejected — the
    // saved key is never sent to another URL, not even with one extra click.
    const draftBase = normalizeBaseUrl(profile.baseUrl || '')
    if (draftBase && draftBase !== normalizeBaseUrl(existing.baseUrl)) {
      throw new Error(
        'This profile has a saved API key. To test a different endpoint, type the API key again first.'
      )
    }
    if (!existing.baseUrl) throw new Error('The model endpoint is required.')
    assertHttpUrl(existing.baseUrl)
    return listModels(existing)
  })

  ipcMain.handle('ai:chat', async (event, request: ChatRequest) => {
    const requestId = request.requestId || randomUUID()
    const controller = new AbortController()
    activeRequests.set(requestId, controller)

    void (async () => {
      try {
        const current = await state()
        const profile = getProfile(current, request.profileId)
        const dataApproval = request.dataApprovalToken
          ? consumeDataApproval(
              request.dataApprovalToken,
              request.connectionId,
              request.dataMode
            )
          : null
        if (request.dataApprovalToken && !dataApproval) {
          throw new Error('The data approval expired or was already used. Prepare it again.')
        }
        const context = await prepareAiContext(
          current,
          profile,
          {
            messages: request.messages,
            connectionId: request.connectionId,
            skillIds: request.skillIds,
            autoSkills: request.autoSkills
          },
          dataApproval
        )
        sendChunk(event, { requestId, delta: '' })
        if (context.schemaWarning) {
          sendChunk(event, { requestId, warning: context.schemaWarning })
        }
        const result = await streamChat(
          profile,
          context.messages,
          (delta) => sendChunk(event, { requestId, delta }),
          controller.signal
        )
        sendChunk(event, { requestId, done: true, usage: result.usage })
      } catch (error) {
        const message =
          error instanceof Error && error.name === 'AbortError'
            ? 'Request canceled'
            : error instanceof Error
              ? error.message
              : String(error)
        sendChunk(event, { requestId, error: message, done: true })
      } finally {
        activeRequests.delete(requestId)
      }
    })()

    return { requestId }
  })

  /**
   * Returns exactly what `ai:chat` would send for the same request, without
   * calling the provider. Read-only: builds context, never executes SQL and
   * never returns the API key.
   */
  ipcMain.handle(
    'ai:context-preview',
    async (_event, request: ChatRequest): Promise<AiContextPreview> => {
      const current = await state()
      const profile = getProfile(current, request.profileId)
      const dataApproval = request.dataApprovalToken
        ? peekDataApproval(request.dataApprovalToken, request.connectionId, request.dataMode)
        : null
      if (request.dataApprovalToken && !dataApproval) {
        throw new Error('The data approval expired. Prepare the preview again.')
      }
      const context = await prepareAiContext(
        current,
        profile,
        {
          messages: Array.isArray(request.messages) ? request.messages : [],
          connectionId: request.connectionId,
          skillIds: request.skillIds,
          autoSkills: request.autoSkills
        },
        dataApproval
      )
      return toContextPreview(context, profile)
    }
  )

  ipcMain.handle(
    'ai:complete',
    async (
      _event,
      payload: { profileId: string; prompt: string; connectionId?: string; requestId?: string }
    ) => {
      const current = await state()
      // The toggle is a gate in main, not only a hidden UI control.
      if (!current.settings.aiAutocomplete) {
        throw new Error('AI autocomplete is disabled in Settings → Safety.')
      }
      const profile = getProfile(current, payload.profileId)
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.slice(0, 20_000) : ''
      if (!prompt.trim()) return ''
      if (!payload.connectionId) {
        throw new Error('AI autocomplete needs the connection the editor is using.')
      }
      const controller = new AbortController()
      const requestId = payload.requestId || randomUUID()
      activeRequests.set(requestId, controller)
      try {
        let output = ''
        // Same builder as ai:chat/ai:context-preview. The schema is resolved
        // here from the live connection, so the renderer cannot choose what
        // metadata reaches the provider. profile.sendSchema and PII masking
        // still apply inside the builder.
        const context = buildAiContext({
          profile,
          messages: [{ role: 'user', content: prompt }],
          schemaContext: await completionSchema(payload.connectionId)
        })
        await streamChat(
          profile,
          context.messages,
          (delta) => {
            output += delta
          },
          controller.signal
        )
        return output.trim()
      } finally {
        activeRequests.delete(requestId)
      }
    }
  )

  ipcMain.handle('ai:abort', async (_event, requestId: string) => {
    activeRequests.get(requestId)?.abort()
    activeRequests.delete(requestId)
  })

  ipcMain.handle('settings:save', async (_event, settings: AppSettings) => {
    const current = await state()
    const next = { ...current.settings, ...settings }
    await confirmSafetyChange(current.settings, next)
    if (current.settings.readOnly !== next.readOnly || current.settings.aiMode !== next.aiMode) {
      await appendAudit({
        id: randomUUID(),
        at: Date.now(),
        action: 'safety-change',
        aiMode: next.aiMode,
        allowWrites: !next.readOnly,
        ok: true,
        detail: `readOnly=${next.readOnly}; aiMode=${next.aiMode}`
      })
    }
    current.settings = next
    return saveState(current)
  })

  ipcMain.handle('settings:patch', async (_event, patch: Partial<AppSettings>) => {
    const current = await state()
    const next = { ...current.settings, ...patch }
    await confirmSafetyChange(current.settings, next)
    if (current.settings.readOnly !== next.readOnly || current.settings.aiMode !== next.aiMode) {
      await appendAudit({
        id: randomUUID(),
        at: Date.now(),
        action: 'safety-change',
        aiMode: next.aiMode,
        allowWrites: !next.readOnly,
        ok: true,
        detail: `readOnly=${next.readOnly}; aiMode=${next.aiMode}`
      })
    }
    current.settings = next
    return saveState(current)
  })

  ipcMain.handle('skills:list', async (_event, refresh?: boolean) => listSkills(Boolean(refresh)))
  ipcMain.handle('skills:read', async (_event, id: string) => readSkill(id))
  ipcMain.handle('skills:search', async (_event, query: string) => searchSkills(query, 6))

  ipcMain.handle(
    'security:confirm',
    async (
      _event,
      payload: {
        kind: 'sql-write' | 'row-update' | 'import-csv' | 'explain-analyze' | 'session-kill'
        title: string
        detail: string
      }
    ) => {
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        title: payload.title,
        message: payload.title,
        detail: payload.detail.slice(0, 1200),
        noLink: true
      })
      if (result.response !== 1) throw new Error('Operation canceled by user')
      return createConfirmationToken(payload.kind, payload.detail)
    }
  )

  ipcMain.handle('dialog:csv', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const stat = await fs.stat(filePath)
    if (stat.size > 5_000_000) {
      throw new Error('CSV exceeds the 5 MB limit. Split the file and import in batches.')
    }
    return {
      name: path.basename(filePath),
      text: await fs.readFile(filePath, 'utf8')
    }
  })

  ipcMain.handle('dialog:sqlite', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open SQLite database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform
  }))

  app.on('before-quit', () => {
    void disconnectAll()
  })
}
