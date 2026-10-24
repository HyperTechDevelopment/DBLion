import Firebird, { type Database } from 'node-firebird'
import type {
  ConnectionConfig,
  SchemaCatalog,
  SchemaDdl,
  SchemaGraph,
  SchemaObjectRef,
  TableDetails,
  TableInfo
} from '@shared/types'
import { isReadOnlyAccess } from '@shared/access'
import { normalizeFirebirdEncoding } from '@shared/firebird'
import type { ColumnRef, DbAdapter, ExplainRaw, QueryOptions } from './types'
import { SerialQueue } from './serialQueue'
import { clipContext, compactColumns, ensureWritable, makeResult } from './common'
import { loadFirebirdCatalog, loadFirebirdDdl } from './firebirdCatalog'

/**
 * The library's transaction methods are present at runtime but missing from the
 * shipped default-export type, so the adapter states the shape it relies on.
 */
interface FirebirdTransaction {
  query(
    sql: string,
    params: unknown[],
    callback: (error: unknown, rows: Record<string, unknown>[]) => void,
    options?: { signal?: AbortSignal }
  ): void
  rollback(callback: () => void): void
}

type TransactionCapableDatabase = Database & {
  transaction(
    options: { isolation: number[]; readOnly: boolean },
    callback: (error: unknown, transaction: FirebirdTransaction) => void
  ): unknown
}

/**
 * Runtime constant from the driver's module exports; its shipped type omits
 * named constants, so the adapter states the shape it relies on.
 */
const READ_ONLY_ISOLATION = (
  Firebird as unknown as { ISOLATION_READ_COMMITTED_READ_ONLY: number[] }
).ISOLATION_READ_COMMITTED_READ_ONLY

/**
 * Firebird's `isc_tpb_read` transaction flag. A read-only transaction makes the
 * engine reject every write, including one performed by a stored procedure or
 * trigger reached from a `SELECT`. `ISOLATION_READ_COMMITTED_READ_ONLY` is the
 * driver constant for exactly this flag.
 */
export const FIREBIRD_READ_ONLY_TRANSACTION = {
  isolation: READ_ONLY_ISOLATION,
  readOnly: true
} as const

function query(
  db: Database,
  sql: string,
  params: unknown[] = [],
  options: { signal?: AbortSignal } = {}
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const connection = db as unknown as {
      query(
        sql: string,
        params: unknown[],
        callback: (error: unknown, rows: Record<string, unknown>[]) => void,
        options?: { signal?: AbortSignal }
      ): void
    }
    connection.query(
      sql,
      params,
      (error, rows) => {
        if (error) reject(error)
        else resolve(rows ?? [])
      },
      options
    )
  })
}

/**
 * Runs one statement inside a Firebird read-only transaction and rolls it back
 * immediately. Nothing a procedure writes can commit, because the engine
 * rejects the write while `isc_tpb_read` is set.
 */
function queryReadOnly(
  db: Database,
  sql: string,
  params: unknown[],
  options: { signal?: AbortSignal } = {}
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    ;(db as TransactionCapableDatabase).transaction(
      FIREBIRD_READ_ONLY_TRANSACTION,
      (startError, transaction) => {
        if (startError || !transaction) {
          reject(
            startError ??
              new Error('Firebird refused to start a read-only transaction for this statement.')
          )
          return
        }
        transaction.query(
          sql,
          params,
          (error, rows) => {
            transaction.rollback(() => {
              if (error) reject(error)
              else resolve((rows ?? []) as Record<string, unknown>[])
            })
          },
          options
        )
      }
    )
  })
}

/**
 * One statement on the attachment that is already holding the serial slot, so
 * a caller can never start a second statement by accident.
 */
type StatementRunner = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/**
 * Column metadata degrades in two steps. A server that rejects the BLOB default
 * or the domain join must not hide the column names themselves.
 */
async function readColumns(
  run: StatementRunner,
  table: string
): Promise<Record<string, unknown>[]> {
  try {
    return await run(
      `select trim(rf.rdb$field_name) as name,
              trim(f.rdb$field_source) as type,
              rf.rdb$null_flag as not_null,
              rf.rdb$default_source as default_source,
              cast(rf.rdb$description as varchar(4000)) as comment
       from rdb$relation_fields rf
       join rdb$fields f on rf.rdb$field_source = f.rdb$field_name
       where rf.rdb$relation_name = ?
       order by rf.rdb$field_position`,
      [table]
    )
  } catch {
    const rows = await run(
      `select trim(rf.rdb$field_name) as name,
              trim(rf.rdb$field_source) as field_source,
              rf.rdb$null_flag as not_null,
              cast(rf.rdb$description as varchar(4000)) as comment
       from rdb$relation_fields rf
       where rf.rdb$relation_name = ?
       order by rf.rdb$field_position`,
      [table]
    )
    return rows.map((row) => ({
      name: row.name,
      type: row.field_source,
      not_null: row.not_null,
      default_source: null,
      comment: row.comment
    }))
  }
}

/** Keys and relationships are useful but never worth losing the columns for. */
async function optionalQuery(
  run: StatementRunner,
  sql: string,
  params: unknown[]
): Promise<Record<string, unknown>[]> {
  try {
    return await run(sql, params)
  } catch {
    return []
  }
}

const FIREBIRD_CANCELLED = 335544794

function isFirebirdCancelled(error: unknown): boolean {
  const code = (error as { gdscode?: number } | null)?.gdscode
  if (code === FIREBIRD_CANCELLED) return true
  return /isc_cancelled|operation was cancelled/i.test(String((error as Error)?.message ?? ''))
}

interface WireStatement {
  plan?: string
  drop?: (callback?: () => void) => void
}

interface WireConnection {
  prepare?: (
    transaction: FirebirdTransaction,
    sql: string,
    plan: boolean,
    callback: (error: unknown, statement?: WireStatement) => void
  ) => void
}

export class FirebirdAdapter implements DbAdapter {
  readonly kind = 'firebird'
  private db: Database | null = null
  /** Mirrors ConnectionConfig.accessMode. Firebird has no session-level
   * read-only switch here, so writes are blocked in DBLion only. */
  private readOnly = false
  /** Parsed from ENGINE_VERSION by serverVersion(). Gates the EXPLAIN path. */
  private serverMajor = 0
  /** Negotiated wire protocol: 12 = Firebird 2.5 (op_cancel support). */
  private protocol = 0
  /**
   * One attachment, one statement at a time. node-firebird matches every
   * response against a single FIFO queue per socket, and `op_cancel` cancels
   * whatever the attachment is running without naming it. A statement that
   * starts while another is in flight therefore interleaves packets with it,
   * and a timeout cannot pin its cancel to its own statement. Every path that
   * touches the attachment takes this queue.
   */
  private readonly queue = new SerialQueue()
  /** Identifies the statement holding the attachment; 0 when it is idle. */
  private activeToken = 0
  private tokenSeq = 0

  private requireDb(): Database {
    if (!this.db) throw new Error('Not connected')
    return this.db
  }

  /**
   * Runs `work` with exclusive use of the attachment. The token names the
   * statement for as long as it holds the slot, so a late timeout can check
   * that the operation it timed out is still the one running.
   */
  private exclusive<T>(work: (token: number) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      const token = ++this.tokenSeq
      this.activeToken = token
      try {
        return await work(token)
      } finally {
        if (this.activeToken === token) this.activeToken = 0
      }
    })
  }

  /** One plain statement on the attachment, serialised, no timeout. */
  private statement(
    sql: string,
    params: unknown[] = []
  ): Promise<Record<string, unknown>[]> {
    const db = this.requireDb()
    return this.exclusive(() => query(db, sql, params))
  }

  /** Metadata reads keep the engine-enforced read-only transaction. */
  private readOnlyStatement(
    sql: string,
    params: unknown[] = []
  ): Promise<Record<string, unknown>[]> {
    const db = this.requireDb()
    return this.exclusive(() => queryReadOnly(db, sql, params))
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.readOnly = isReadOnlyAccess(config)
    const database = config.database || config.file || ''
    if (!database) throw new Error('Firebird database path or alias is required')
    this.db = await new Promise<Database>((resolve, reject) => {
      Firebird.attach(
        {
          host: config.host || 'localhost',
          port: config.port ?? 3050,
          database,
          user: config.user || 'SYSDBA',
          password: config.password || 'masterkey',
          encoding: normalizeFirebirdEncoding(config.encoding),
          lowercase_keys: true,
          pageSize: 4096,
          retryConnectionInterval: 2000
        },
        (error, db) => {
          if (error) reject(error)
          else resolve(db)
        }
      )
    })
    this.protocol = Number(
      (this.db as unknown as { connection?: { accept?: { protocolVersion?: number } } }).connection
        ?.accept?.protocolVersion ?? 0
    )
  }

  async disconnect(): Promise<void> {
    const db = this.db
    this.db = null
    this.readOnly = false
    this.serverMajor = 0
    this.protocol = 0
    if (!db) return
    await new Promise<void>((resolve) => db.detach(() => resolve()))
  }

  async serverVersion(): Promise<string> {
    const rows = await this.statement(
      `select rdb$get_context('SYSTEM', 'ENGINE_VERSION') as version from rdb$database`
    )
    const value = String(rows[0]?.version ?? '')
    const major = Number.parseInt(value, 10)
    if (Number.isFinite(major)) this.serverMajor = major
    return `Firebird ${value}`.trim()
  }

  private cancellationApi(): (() => Promise<void>) | null {
    const cancel = (this.db as unknown as { cancelAsync?: () => Promise<void> } | null)?.cancelAsync
    return typeof cancel === 'function' ? cancel.bind(this.db) : null
  }

  /**
   * Firebird has no statement timeout. The driver's AbortSignal path sends an
   * out-of-band op_cancel, so this cancels the server-side operation instead of
   * abandoning a query that keeps running.
   */
  private async withTimeout<T>(
    options: QueryOptions,
    work: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    const ms = options.timeoutMs ?? 0
    if (!ms || ms <= 0) return work(undefined)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await work(controller.signal)
    } catch (error) {
      if (isFirebirdCancelled(error) || controller.signal.aborted) {
        throw new Error(`Query cancelled after ${ms} ms.`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async query(
    sql: string,
    params: unknown[] = [],
    allowWrites = false,
    options: QueryOptions = {}
  ) {
    ensureWritable(sql, allowWrites, this.readOnly)
    const started = Date.now()
    // A read-only connection, and every AI-originated read, runs inside a
    // transaction flagged isc_tpb_read. The guard blocks writes first; the
    // engine is what makes the guarantee hold for writes hidden in procedures.
    const db = this.requireDb()
    // The queue slot starts the clock. A timeout that began while the statement
    // was still waiting its turn would send op_cancel for whatever operation
    // happens to be running, which is not this one.
    const rows = await this.exclusive(() =>
      this.withTimeout(options, (signal) =>
        this.readOnly || options.readOnlyTransaction
          ? queryReadOnly(db, sql, params, { signal })
          : query(db, sql, params, { signal })
      )
    )
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    return makeResult(columns, rows, Date.now() - started, sql.trim().split(/\s+/)[0]?.toUpperCase())
  }

  /**
   * Sends op_cancel for the operation `token` names, and only for that one. A
   * late timeout whose operation already finished leaves the connection alone,
   * so it cannot cancel the statement that replaced it.
   */
  private async cancelActive(token: number): Promise<void> {
    if (token === 0 || token !== this.activeToken) return
    const cancel = this.cancellationApi()
    if (!cancel) return
    try {
      await cancel()
    } catch {
      // The caller already reports the timeout; a refused cancel (old
      // protocol, closed socket) must not replace that error.
    }
  }

  /**
   * Cancels the statement that is executing right now. It bypasses the queue on
   * purpose: taking a slot would put the cancel behind the very statement it
   * has to stop. With nothing running there is nothing to cancel, so it
   * returns instead of waiting.
   */
  async cancel(): Promise<void> {
    const cancel = this.cancellationApi()
    if (!cancel) {
      throw new Error('This Firebird driver does not support cancelling the current operation.')
    }
    if (this.protocol > 0 && this.protocol < 12) {
      throw new Error('Cancelling a running query requires Firebird 2.5 or newer.')
    }
    if (this.activeToken === 0) return
    await cancel()
  }

  /**
   * Estimated plan only. Firebird 6+ has `EXPLAIN`; older versions expose the
   * plan through `isc_info_sql_get_plan`, which node-firebird keeps internal.
   */
  async explain(sql: string, analyze: boolean, options: QueryOptions = {}): Promise<ExplainRaw> {
    if (analyze) throw new Error('EXPLAIN ANALYZE is not supported for Firebird.')
    const statement = sql.trim().replace(/;+\s*$/, '')
    const db = this.requireDb()
    if (this.serverMajor >= 6) {
      const rows = await this.exclusive(() =>
        this.withTimeout(options, (signal) =>
          queryReadOnly(db, `EXPLAIN ${statement}`, [], { signal })
        )
      )
      return { rows, columns: rows.length > 0 ? Object.keys(rows[0]) : ['plan'] }
    }
    return this.planViaInfoItem(statement, options)
  }

  private async planViaInfoItem(sql: string, options: QueryOptions): Promise<ExplainRaw> {
    const db = this.requireDb()
    const prepare = (db as unknown as { connection?: WireConnection }).connection?.prepare
    if (typeof prepare !== 'function') {
      throw new Error(
        'Firebird plan inspection needs Firebird 6+ or a driver that exposes isc_info_sql_get_plan.'
      )
    }
    // The prepare runs on a bare transaction handle instead of going through
    // query(), but it uses the same attachment, so it takes the same slot.
    return this.exclusive(
      (token) =>
        new Promise<ExplainRaw>((resolve, reject) => {
          let settled = false
          let timedOut = false
          let timer: ReturnType<typeof setTimeout> | undefined
          const finish = (error: unknown, plan?: string): void => {
            if (settled) return
            settled = true
            if (timer) {
              clearTimeout(timer)
              timer = undefined
            }
            if (error) reject(error)
            else resolve({ rows: [{ plan: plan ?? '' }], columns: ['plan'] })
          }
          const ms = options.timeoutMs ?? 0
          const timeoutError = (): Error => new Error(`Plan request cancelled after ${ms} ms.`)
          if (ms > 0) {
            timer = setTimeout(() => {
              if (settled) return
              timedOut = true
              // This prepare is the only operation on the attachment, so
              // op_cancel reaches it and nothing else.
              void this.cancelActive(token)
              // The rejection is delivered when the driver answers the cancel,
              // which keeps the slot until the server has stopped the prepare.
              // The operation that is running is still this one, so `finish`
              // below still belongs to it.
            }, ms)
          }
          ;(db as TransactionCapableDatabase).transaction(
            FIREBIRD_READ_ONLY_TRANSACTION,
            (startError, transaction) => {
              if (settled) {
                // Already answered elsewhere; close what arrived instead of
                // preparing inside it.
                if (transaction) transaction.rollback(() => undefined)
                return
              }
              if (timedOut) {
                // The deadline passed while the transaction was opening: do not
                // start a prepare the caller already gave up on.
                if (transaction) transaction.rollback(() => undefined)
                finish(timeoutError())
                return
              }
              if (startError || !transaction) {
                finish(
                  startError ??
                    new Error('Firebird refused to start a read-only transaction for the plan.')
                )
                return
              }
              prepare(transaction, sql, true, (error, statement) => {
                // The prepare answered: stop the clock before the rollback, so
                // a late fire cannot cancel the rollback instead.
                if (timer) {
                  clearTimeout(timer)
                  timer = undefined
                }
                const plan = String(statement?.plan ?? '').trim()
                const afterDrop = (): void => {
                  transaction.rollback(() => {
                    if (timedOut) finish(timeoutError())
                    else if (error) finish(error)
                    else if (!plan) finish(new Error('Firebird returned an empty plan.'))
                    else finish(undefined, plan)
                  })
                }
                if (statement?.drop) statement.drop(afterDrop)
                else afterDrop()
              })
            }
          )
        })
    )
  }

  async catalog(schema?: string): Promise<SchemaCatalog> {
    return loadFirebirdCatalog(
      (sql, params = []) => this.readOnlyStatement(sql, params),
      schema
    )
  }

  async ddl(object: SchemaObjectRef): Promise<SchemaDdl> {
    return loadFirebirdDdl(
      (sql, params = []) => this.readOnlyStatement(sql, params),
      object
    )
  }

  async columnsIndex(): Promise<ColumnRef[]> {
    const rows = await this.readOnlyStatement(
      `select first 20000 trim(f.rdb$relation_name) as relation, trim(f.rdb$field_name) as field
       from rdb$relation_fields f
       join rdb$relations r on r.rdb$relation_name = f.rdb$relation_name
       where coalesce(r.rdb$system_flag, 0) = 0
       order by 1, f.rdb$field_position`
    )
    return rows.map((row) => ({
      schema: undefined,
      table: String(row.relation),
      column: String(row.field)
    }))
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.statement(
      `select trim(r.rdb$relation_name) as name,
              case when r.rdb$view_blr is null then 'TABLE' else 'VIEW' end as type,
              cast(r.rdb$description as varchar(4000)) as comment
       from rdb$relations r
       where coalesce(r.rdb$system_flag, 0) = 0
       order by 1`
    )
    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      comment: row.comment ? String(row.comment).trim() : undefined
    }))
  }

  async describeTable(_schema: string | undefined, table: string): Promise<TableDetails> {
    // Each statement takes its own turn on the attachment; the catalog reads
    // must not run beside a statement from another tab.
    const run: StatementRunner = (sql, params) => this.statement(sql, params)
    const columns = await readColumns(run, table)
    const pk = await optionalQuery(
      run,
      `select trim(seg.rdb$field_name) as name
       from rdb$relation_constraints rc
       join rdb$index_segments seg on rc.rdb$index_name = seg.rdb$index_name
       where rc.rdb$constraint_type = 'PRIMARY KEY' and rc.rdb$relation_name = ?`,
      [table]
    )
    const fks = await optionalQuery(
      run,
      `select trim(rc.rdb$relation_name) as "table",
              trim(src_seg.rdb$field_name) as "column",
              trim(ref_rc.rdb$relation_name) as ref_table,
              trim(ref_seg.rdb$field_name) as ref_column,
              trim(rc.rdb$constraint_name) as constraint_name
       from rdb$relation_constraints rc
       join rdb$ref_constraints refc on refc.rdb$constraint_name = rc.rdb$constraint_name
       join rdb$relation_constraints ref_rc on ref_rc.rdb$constraint_name = refc.rdb$const_name_uq
       join rdb$index_segments src_seg on rc.rdb$index_name = src_seg.rdb$index_name
       join rdb$index_segments ref_seg
         on ref_rc.rdb$index_name = ref_seg.rdb$index_name
        and src_seg.rdb$field_position = ref_seg.rdb$field_position
       where rc.rdb$constraint_type = 'FOREIGN KEY' and rc.rdb$relation_name = ?`,
      [table]
    )
    const primaryKey = new Set(pk.map((row) => String(row.name)))
    return {
      table,
      columns: columns.map((row) => ({
        name: String(row.name),
        type: String(row.type),
        nullable: row.not_null !== 1,
        primaryKey: primaryKey.has(String(row.name)),
        defaultValue: row.default_source ? String(row.default_source) : null,
        comment: row.comment ? String(row.comment).trim() : undefined
      })),
      primaryKey: [...primaryKey],
      foreignKeys: fks.map((row) => ({
        table: String(row.table),
        column: String(row.column),
        refTable: String(row.ref_table),
        refColumn: String(row.ref_column),
        constraintName: String(row.constraint_name)
      }))
    }
  }

  async graph(): Promise<SchemaGraph> {
    const tables = (await this.listTables()).slice(0, 60)
    const nodes = []
    const edges: SchemaGraph['edges'] = []
    for (const table of tables) {
      let details: TableDetails
      try {
        details = await this.describeTable(undefined, table.name)
      } catch {
        continue
      }
      nodes.push({ id: table.name, label: table.name, columns: details.columns })
      for (const foreignKey of details.foreignKeys) {
        edges.push({
          id: `fk-${table.name}-${foreignKey.column}-${foreignKey.refTable}-${foreignKey.refColumn}`,
          source: table.name,
          target: foreignKey.refTable,
          label: `${foreignKey.column} → ${foreignKey.refColumn}`
        })
      }
    }
    return { nodes, edges }
  }

  async buildContext(tables?: TableInfo[]): Promise<string> {
    const list = tables ?? (await this.listTables())
    const parts: string[] = []
    for (const table of list.slice(0, 80)) {
      try {
        const details = await this.describeTable(undefined, table.name)
        const comment = table.comment?.replace(/\s+/g, ' ').trim().slice(0, 120)
        parts.push(
          `${table.name}${comment ? ` -- ${comment}` : ''}(${compactColumns(details.columns)})`
        )
      } catch {
        // One view or permission gap must not erase every other table.
        parts.push(table.name)
      }
    }
    return clipContext(`Firebird schema:\n${parts.join('\n')}`)
  }
}
