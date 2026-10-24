export type DbKind =
  | 'postgres'
  | 'mysql'
  | 'mssql'
  | 'firebird'
  | 'sqlite'
  | 'mongodb'
  | 'redis'

export interface SshConfig {
  host: string
  port?: number
  user: string
  password?: string
  privateKey?: string
  passphrase?: string
  hasPassword?: boolean
  hasPrivateKey?: boolean
}

/**
 * Per-connection access mode. New connections default to `read-only`; a
 * read-write connection is a separate profile with its own credential.
 */
export type ConnectionAccessMode = 'read-only' | 'read-write'

/**
 * Which layer enforces read-only for an engine:
 * - `database`: the session/connection itself refuses writes.
 * - `server-intent`: the client asks the server for a read-only replica
 *   (SQL Server ApplicationIntent=ReadOnly); enforcement depends on the server
 *   topology, so DBLion still blocks writes in the main process.
 * - `app`: DBLion only.
 */
export type ReadOnlyEnforcement = 'database' | 'server-intent' | 'app'

export interface ConnectionConfig {
  id: string
  name: string
  kind: DbKind
  /** Defaults to `read-only` when absent (legacy profiles are normalized). */
  accessMode?: ConnectionAccessMode
  host?: string
  port?: number
  database?: string
  /** Firebird connection character set (`lc_ctype`). Defaults to UTF8. */
  encoding?: string
  user?: string
  password?: string
  hasPassword?: boolean
  ssl?: boolean
  sslCa?: string
  sslCert?: string
  sslKey?: string
  file?: string
  connectionString?: string
  options?: Record<string, string>
  ssh?: SshConfig
  /**
   * Tables the user pinned from the schema explorer (`name` or `schema.name`).
   * Always included in the AI context, resolved against live metadata, so an
   * unknown or renamed name is dropped instead of being sent to the model.
   */
  pinnedTables?: string[]
}

export type TableFilterOp = 'eq' | 'like' | 'isNull' | 'isNotNull'

export interface TableFilter {
  column: string
  op: TableFilterOp
  value?: unknown
}

export interface TablePageRequest {
  connectionId: string
  schema?: string
  table: string
  tableType?: string
  limit: number
  offset: number
  orderBy?: { column: string; direction: 'asc' | 'desc' }
  filters?: TableFilter[]
}

export interface TablePage {
  columns: ColumnInfo[]
  primaryKey: string[]
  rows: Record<string, unknown>[]
  offset: number
  limit: number
  editable: boolean
  source: {
    schema?: string
    table: string
    primaryKey: string[]
  }
}

export interface RowUpdateRequest {
  connectionId: string
  schema?: string
  table: string
  identity: Record<string, unknown>
  changes: Record<string, unknown>
  expected: Record<string, unknown>
  allowWrites: boolean
}

export interface MutationPreview {
  sql: string
  params: unknown[]
  warnings: string[]
  destructive: boolean
  confirmationDetail: string
}

export type SessionKillMode = 'cancel' | 'terminate'

export interface SessionInfo {
  /** Identificador canônico: pid (pg), Id (mysql), session_id (mssql). */
  id: string
  pid?: number
  user?: string
  database?: string
  host?: string
  state?: string
  command?: string
  /** Texto da query em execução (truncado pelo adapter, nunca PII além do banco). */
  query?: string
  queryStart?: string
  durationMs?: number
  waitEvent?: string
  application?: string
  backendType?: string
}

export interface KillSessionRequest {
  connectionId: string
  sessionId: string
  mode?: SessionKillMode
}

export interface KillSessionPreview {
  detail: string
  warnings: string[]
  destructive: boolean
}

export interface CsvFile {
  name: string
  text: string
}

export interface CsvImportRequest {
  connectionId: string
  schema?: string
  table: string
  /** Raw CSV bytes as UTF-8 text (BOM tolerated, stripped server-side). */
  csvText: string
  /** Map of CSV header name -> target table column name. */
  mapping: Record<string, string>
  delimiter?: string
  nullValues?: string[]
  hasHeader?: boolean
  allowWrites: boolean
  schemaFingerprint?: string
}

export interface CsvImportPreview {
  sql: string
  /** Params of the first row only, for dialog display. Never the full dataset. */
  paramsPreview: unknown[]
  columns: string[]
  rowCount: number
  contentHash: string
  warnings: string[]
  destructive: boolean
  confirmationDetail: string
}

export interface DbCapabilities {
  /** Effective access mode reported by the main process. */
  accessMode?: ConnectionAccessMode
  /** True when the connection is read-only and writes are rejected in main. */
  readOnly?: boolean
  /** Which layer enforces read-only for this engine. */
  readOnlyEnforcement?: ReadOnlyEnforcement
  cancelQuery: boolean
  transactions: boolean
  tableBrowser: boolean
  editRows: boolean
  importCsv: boolean
  explain: boolean
  explainAnalyze: boolean
  sessions: boolean
  killSession: boolean
  schemaCatalog: boolean
  ddl: boolean
  snapshot: boolean
  diff: boolean
  migrations: boolean
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  primaryKey?: boolean
  defaultValue?: string | null
  /** Native comment/description, when the engine exposes one. */
  comment?: string
}

export interface TableInfo {
  schema?: string
  name: string
  type?: string
  /** Native table/view comment, when the engine exposes one. */
  comment?: string
}

export interface ForeignKeyInfo {
  schema?: string
  table: string
  column: string
  refSchema?: string
  refTable: string
  refColumn: string
  constraintName?: string
}

export interface TableDetails {
  schema?: string
  table: string
  columns: ColumnInfo[]
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
}

export interface GraphNode {
  id: string
  label: string
  schema?: string
  columns: ColumnInfo[]
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
}

export interface SchemaGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  durationMs: number
  command?: string
  notice?: string
  truncated?: boolean
}

export interface PlanNode {
  id: string
  operation: string
  relation?: string
  index?: string
  costStart?: number
  costTotal?: number
  rows?: number
  width?: number
  actualRows?: number
  actualTimeMs?: number
  loops?: number
  warnings: string[]
  children: PlanNode[]
}

export interface ExplainResult {
  dialect: DbKind
  analyze: boolean
  roots: PlanNode[]
  warnings: string[]
  totalCost?: number
  planningMs?: number
  executionTimeMs?: number
}

export interface ExplainRequest {
  connectionId: string
  sql: string
  analyze?: boolean
  confirmationToken?: string
  source?: 'editor' | 'selection' | 'ai'
  schemaFingerprint?: string
}

export interface QueryHistoryEntry {
  id: string
  sql: string
  connectionId?: string
  connectionName?: string
  at: number
  durationMs?: number
  rowCount?: number
  error?: string
  source?: 'editor' | 'selection' | 'ai'
}

export interface TestResult {
  ok: boolean
  message: string
  serverVersion?: string
}

export type AIProviderId =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'openrouter'
  | 'custom'

export interface AIProfile {
  id: string
  name: string
  provider: AIProviderId
  baseUrl: string
  model: string
  modelOptions?: string[]
  apiKey?: string
  hasApiKey?: boolean
  contextWindow: number
  temperature: number
  maxTokens: number
  timeoutSec: number
  streaming: boolean
  customHeaders?: Record<string, string>
  systemPrompt?: string
  sendSchema: boolean
  /**
   * Redacts emails, CPF/CNPJ, card- and phone-like values from schema and skill
   * context before it leaves the machine. Default false so existing profiles
   * keep their current behaviour.
   */
  maskPII?: boolean
}

export type AIMode = 'read' | 'edit' | 'full'

export interface AppSettings {
  activeConnectionId?: string
  activeProfileId?: string
  theme: string
  readOnly: boolean
  confirmWrites: boolean
  aiAutocomplete: boolean
  showAiPanel: boolean
  /** When true, disconnecting skips the confirmation dialog. Deleting never skips it. */
  skipDisconnectConfirm?: boolean
  aiMode: AIMode
  enabledSkillIds: string[]
  autoSkills: boolean
  maxRows: number
  queryTimeoutMs: number
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  path: string
  root: string
  source: string
}

export interface SkillContent extends SkillInfo {
  content: string
}

export interface PersistedState {
  connections: ConnectionConfig[]
  profiles: AIProfile[]
  settings: AppSettings
  queryHistory: QueryHistoryEntry[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AiDataMode = 'profile' | 'rows'

export interface AiDataRequest {
  connectionId: string
  schema?: string
  tables: string[]
  mode: AiDataMode
}

export interface AiDataApproval {
  token: string
  expiresAt: number
  mode: AiDataMode
  tables: string[]
  /** Exact masked block that would be added to the system prompt. */
  context: string
  rows: number
  maskedCells: number
}

export interface ChatRequest {
  requestId?: string
  profileId: string
  messages: ChatMessage[]
  connectionId?: string
  skillIds?: string[]
  autoSkills?: boolean
  /** Single-use approval issued by ai:data-approve. Main resolves the payload. */
  dataApprovalToken?: string
  dataMode?: AiDataMode
}

export interface ChatChunk {
  requestId: string
  delta?: string
  done?: boolean
  warning?: string
  error?: string
  usage?: { input?: number; output?: number }
}

/**
 * Exactly what the provider would receive for a chat request, as resolved by
 * the main process. Contains no API key or other secret: only the system
 * prompt, the conversation that would be sent, and context-size facts.
 */
export interface AiContextPreview {
  provider: AIProviderId
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  schemaIncluded: boolean
  schemaWarning?: string
  skillsIncluded: boolean
  schemaChars: number
  skillsChars: number
  systemPromptChars: number
  estimatedInputTokens: number
  /** True when PII masking (profile.maskPII) redacted the context blocks. */
  masked: boolean
  /** True when an approved profile/sample block is part of this request. */
  dataIncluded: boolean
  dataRows: number
  dataMaskedCells: number
}

export interface AiModelInfo {
  id: string
  label?: string
}

export interface SchemaPayload {
  tables: TableInfo[]
  context: string
  fingerprint?: string
  /** Present when the full column context failed and a partial payload was sent. */
  warning?: string
}

export type SchemaObjectType =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'index'

export interface SchemaObjectInfo {
  schema?: string
  name: string
  type: SchemaObjectType | string
  /** Parent table/view for triggers and indexes. */
  parent?: string
}

export interface SchemaCatalog {
  objects: SchemaObjectInfo[]
  truncated: boolean
}

export interface SchemaObjectRef {
  schema?: string
  name: string
  type: SchemaObjectType | string
  parent?: string
}

export interface SchemaDdl {
  sql: string
  warnings: string[]
}

export type SchemaDiffStatus = 'added' | 'removed' | 'changed'

export interface SchemaDiffRow {
  key: string
  schema?: string
  name: string
  type: string
  status: SchemaDiffStatus
  leftSql?: string
  rightSql?: string
  note?: string
}

export interface SchemaDiffResult {
  leftLabel: string
  rightLabel: string
  dialect: DbKind
  schema?: string
  rows: SchemaDiffRow[]
  migrationSql: string
  destructive: boolean
  truncated: boolean
}

export interface MigrationInfo {
  id: string
  name: string
  createdAt: number
  dialect?: string
  hash: string
  sql: string
}

export interface MigrationSaveRequest {
  name: string
  sql: string
  dialect?: string
  connectionId?: string
}

export interface DblionApi {
  getState(): Promise<PersistedState>
  saveConnection(connection: ConnectionConfig): Promise<PersistedState>
  deleteConnection(id: string): Promise<PersistedState>
  testConnection(connection: ConnectionConfig): Promise<TestResult>
  connect(id: string): Promise<TestResult>
  disconnect(id: string): Promise<void>
  query(
    id: string,
    sql: string,
    params?: unknown[],
    allowWrites?: boolean,
    confirmationToken?: string,
    opts?: { source?: 'editor' | 'selection' | 'ai'; schemaFingerprint?: string }
  ): Promise<QueryResult>
  explain(request: ExplainRequest): Promise<ExplainResult>
  cancelQuery(id: string): Promise<void>
  transaction(id: string, action: 'begin' | 'commit' | 'rollback'): Promise<void>
  schema(id: string): Promise<SchemaPayload>
  schemaCatalog(id: string, schema?: string): Promise<SchemaCatalog>
  objectDdl(connectionId: string, object: SchemaObjectRef): Promise<SchemaDdl>
  diffSchemas(
    leftConnectionId: string,
    rightConnectionId: string,
    schema?: string
  ): Promise<SchemaDiffResult>
  listMigrations(): Promise<MigrationInfo[]>
  saveMigration(request: MigrationSaveRequest): Promise<MigrationInfo>
  readMigration(id: string): Promise<MigrationInfo | null>
  describe(id: string, schema: string | undefined, table: string): Promise<TableDetails>
  tablePage(request: TablePageRequest): Promise<TablePage>
  previewRowUpdate(request: RowUpdateRequest): Promise<MutationPreview>
  applyRowUpdate(
    request: RowUpdateRequest,
    confirmationToken: string
  ): Promise<{ rowCount: number }>
  listSessions(connectionId: string): Promise<SessionInfo[]>
  previewKillSession(request: KillSessionRequest): Promise<KillSessionPreview>
  killSession(
    request: KillSessionRequest,
    confirmationToken: string,
    opts?: { source?: string; schemaFingerprint?: string }
  ): Promise<{ ok: boolean }>
  previewCsvImport(request: CsvImportRequest): Promise<CsvImportPreview>
  applyCsvImport(
    request: CsvImportRequest,
    confirmationToken: string,
    schemaFingerprint?: string
  ): Promise<{ rowCount: number }>
  graph(id: string, schema?: string): Promise<SchemaGraph>
  connectionStatus(): Promise<Record<string, boolean>>
  capabilities(connectionId: string): Promise<DbCapabilities>
  auditList(limit?: number): Promise<unknown[]>
  addQueryHistory(
    entry: Omit<QueryHistoryEntry, 'id' | 'at'> & { at?: number }
  ): Promise<PersistedState>
  clearQueryHistory(): Promise<PersistedState>
  saveTextFile(defaultName: string, content: string): Promise<string | null>
  saveProfile(profile: AIProfile): Promise<PersistedState>
  deleteProfile(id: string): Promise<PersistedState>
  listModels(profileId: string): Promise<AiModelInfo[]>
  listModelsDraft(profile: AIProfile): Promise<AiModelInfo[]>
  chat(request: ChatRequest): Promise<{ requestId: string }>
  contextPreview(request: ChatRequest): Promise<AiContextPreview>
  approveData(request: AiDataRequest): Promise<AiDataApproval>
  complete(
    profileId: string,
    prompt: string,
    connectionId?: string,
    requestId?: string
  ): Promise<string>
  abort(requestId: string): Promise<void>
  onChatChunk(callback: (chunk: ChatChunk) => void): () => void
  onCloseRequested(callback: () => void): () => void
  respondToClose(confirmed: boolean): void
  saveSettings(settings: AppSettings): Promise<PersistedState>
  patchSettings(patch: Partial<AppSettings>): Promise<PersistedState>
  pickSqliteFile(): Promise<string | null>
  pickCsvFile(): Promise<CsvFile | null>
  appInfo(): Promise<{ version: string; platform: string }>
  listSkills(refresh?: boolean): Promise<SkillInfo[]>
  readSkill(id: string): Promise<SkillContent>
  searchSkills(query: string): Promise<SkillInfo[]>
  requestConfirmation(payload: {
    kind: 'sql-write' | 'row-update' | 'import-csv' | 'session-kill' | 'explain-analyze'
    title: string
    detail: string
  }): Promise<string>
}
