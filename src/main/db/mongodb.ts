import { MongoClient, type Db } from 'mongodb'
import type { ConnectionConfig, SchemaGraph, TableDetails, TableInfo } from '@shared/types'
import type { DbAdapter } from './types'
import { isReadOnlyAccess } from '@shared/access'
import { clipContext, compactColumns, makeResult } from './common'

interface MongoQuery {
  collection: string
  filter?: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  limit?: number
  operation?: 'find' | 'aggregate' | 'insertOne' | 'updateMany' | 'deleteMany'
  pipeline?: Record<string, unknown>[]
  document?: Record<string, unknown>
  update?: Record<string, unknown>
}

export class MongoAdapter implements DbAdapter {
  readonly kind = 'mongodb'
  private client: MongoClient | null = null
  private db: Db | null = null
  /** Mirrors ConnectionConfig.accessMode. MongoDB has no session read-only
   * mode here, so writes are blocked in DBLion only. */
  private readOnly = false

  private requireDb(): Db {
    if (!this.db) throw new Error('Not connected')
    return this.db
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.readOnly = isReadOnlyAccess(config)
    const credentials =
      config.user && config.password
        ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@`
        : ''
    const uri =
      config.connectionString ||
      `mongodb://${credentials}${config.host ?? 'localhost'}:${config.port ?? 27017}/?authSource=admin`
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 })
    await this.client.connect()
    this.db = this.client.db(config.database)
    await this.db.command({ ping: 1 })
  }

  async disconnect(): Promise<void> {
    await this.client?.close()
    this.client = null
    this.db = null
    this.readOnly = false
  }

  async serverVersion(): Promise<string> {
    const info = await this.requireDb().admin().buildInfo()
    return `MongoDB ${info.version}`
  }

  private parseQuery(sql: string): MongoQuery {
    const trimmed = sql.trim()
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed) as MongoQuery
    }
    return { collection: trimmed, operation: 'find', limit: 100 }
  }

  async query(sql: string, _params: unknown[] = [], allowWrites = false) {
    const started = Date.now()
    const query = this.parseQuery(sql)
    const db = this.requireDb()
    const collection = db.collection(query.collection)
    const operation = query.operation ?? 'find'

    if (operation !== 'find' && operation !== 'aggregate' && !allowWrites) {
      throw new Error('DBLion is in read-only mode. Enable writes to modify MongoDB data.')
    }
    if (this.readOnly) {
      if (operation !== 'find' && operation !== 'aggregate') {
        throw new Error(
          'This connection is read-only. Only find/aggregate reads are allowed; connect a read-write profile to write.'
        )
      }
      const writesThroughAggregate = (query.pipeline ?? []).some(
        (stage) => '$out' in stage || '$merge' in stage
      )
      if (writesThroughAggregate) {
        throw new Error('This connection is read-only. $out and $merge are blocked.')
      }
    }

    let rows: Record<string, unknown>[] = []
    if (operation === 'find') {
      rows = (await collection
        .find(query.filter ?? {}, { projection: query.projection })
        .sort((query.sort ?? {}) as Record<string, 1 | -1>)
        .limit(Math.min(query.limit ?? 100, 1000))
        .toArray()) as Record<string, unknown>[]
    } else if (operation === 'aggregate') {
      rows = (await collection
        .aggregate(query.pipeline ?? [])
        .limit(Math.min(query.limit ?? 100, 1000))
        .toArray()) as Record<string, unknown>[]
    } else if (operation === 'insertOne') {
      const result = await collection.insertOne(query.document ?? {})
      rows = [{ insertedId: result.insertedId }]
    } else if (operation === 'updateMany') {
      const result = await collection.updateMany(query.filter ?? {}, query.update ?? {})
      rows = [{ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }]
    } else if (operation === 'deleteMany') {
      const result = await collection.deleteMany(query.filter ?? {})
      rows = [{ deletedCount: result.deletedCount }]
    }

    const columnSet = new Set<string>()
    for (const row of rows) for (const key of Object.keys(row)) columnSet.add(key)
    return makeResult([...columnSet], rows, Date.now() - started, operation.toUpperCase())
  }

  async listTables(): Promise<TableInfo[]> {
    const collections = await this.requireDb().listCollections().toArray()
    return collections.map((collection) => ({
      name: collection.name,
      type: collection.type ?? 'collection'
    }))
  }

  async describeTable(_schema: string | undefined, table: string): Promise<TableDetails> {
    const samples = (await this.requireDb()
      .collection(table)
      .find({})
      .limit(20)
      .toArray()) as Record<string, unknown>[]
    const columnMap = new Map<string, { type: string; nullable: boolean }>()
    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample)) {
        if (!columnMap.has(key)) {
          columnMap.set(key, {
            type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
            nullable: value === null
          })
        }
      }
    }
    return {
      table,
      columns: [...columnMap.entries()].map(([name, info]) => ({
        name,
        type: info.type,
        nullable: info.nullable
      })),
      primaryKey: columnMap.has('_id') ? ['_id'] : [],
      foreignKeys: []
    }
  }

  async graph(): Promise<SchemaGraph> {
    const tables = (await this.listTables()).slice(0, 60)
    const nodes = []
    for (const table of tables) {
      const details = await this.describeTable(undefined, table.name)
      nodes.push({ id: table.name, label: table.name, columns: details.columns })
    }
    return { nodes, edges: [] }
  }

  async buildContext(): Promise<string> {
    const tables = (await this.listTables()).slice(0, 80)
    const parts: string[] = []
    for (const table of tables) {
      const details = await this.describeTable(undefined, table.name)
      parts.push(`${table.name}{${compactColumns(details.columns)}}`)
    }
    return clipContext(`MongoDB collections (inferred fields from samples):\n${parts.join('\n')}`)
  }
}
