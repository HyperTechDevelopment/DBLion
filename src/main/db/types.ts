import type {
  ConnectionConfig,
  QueryResult,
  SchemaCatalog,
  SchemaDdl,
  SchemaGraph,
  SchemaObjectRef,
  SessionInfo,
  TableDetails,
  TableInfo
} from '@shared/types'

export interface QueryOptions {
  maxRows?: number
  timeoutMs?: number
  /**
   * Runs the statement inside a database-enforced read-only transaction.
   * Set for AI-originated reads so a function with side effects cannot write
   * even though the statement classifies as `read`. Adapters that cannot open
   * such a transaction either refuse or report that the fence is unavailable.
   */
  readOnlyTransaction?: boolean
}

export interface ExplainRaw {
  rows: Record<string, unknown>[]
  columns: string[]
}

/** One table/column pair, as listed by a single engine metadata query. */
export interface ColumnRef {
  schema?: string
  table: string
  column: string
}

export interface DbAdapter {
  readonly kind: string
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): Promise<void>
  serverVersion(): Promise<string>
  query(
    sql: string,
    params?: unknown[],
    allowWrites?: boolean,
    options?: QueryOptions
  ): Promise<QueryResult>
  explain?(sql: string, analyze: boolean, options?: QueryOptions): Promise<ExplainRaw>
  listTables(schema?: string): Promise<TableInfo[]>
  describeTable(schema: string | undefined, table: string): Promise<TableDetails>
  /**
   * Optional: every column of every table in ONE metadata query, used to rank
   * schema suggestions by column name without a describeTable per table.
   * Engines that cannot answer it in one round trip may omit it.
   *
   * Not implemented by the Firebird adapter yet: it would be a single
   * `rdb$relation_fields` join `rdb$relations` read (system_flag = 0). Until
   * then Firebird ranking uses table names and comments only.
   */
  columnsIndex?(): Promise<ColumnRef[]>
  /** Optional: full catalog including routines, triggers and indexes. */
  catalog?(schema?: string): Promise<SchemaCatalog>
  /** Optional: DDL for one catalog object. */
  ddl?(object: SchemaObjectRef): Promise<SchemaDdl>
  graph(schema?: string): Promise<SchemaGraph>
  buildContext(tables?: TableInfo[]): Promise<string>
  cancel?(): Promise<void>
  begin?(): Promise<void>
  commit?(): Promise<void>
  rollback?(): Promise<void>
  /**
   * Somente leitura. Ausência = indisponível (capability sessions=false).
   * sqlite/mongo/redis não implementam por decisão de produto.
   */
  listSessions?(): Promise<SessionInfo[]>
  /**
   * NUNCA via db:query. Só via IPC dedicado `db:kill-session`
   * (aiMode full + token session-kill single-use + TTL).
   */
  killSession?(sessionId: string, mode?: 'cancel' | 'terminate'): Promise<void>
}
