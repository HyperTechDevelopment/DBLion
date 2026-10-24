import { createClient, type RedisClientType } from 'redis'
import type { ConnectionConfig, SchemaGraph, TableDetails, TableInfo } from '@shared/types'
import type { DbAdapter } from './types'
import { clipContext, compactColumns, makeResult } from './common'
import { classifyRedis } from '@shared/sql'
import { isReadOnlyAccess } from '@shared/access'

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && index + 1 < input.length) {
        index += 1
        current += input[index]
      } else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) tokens.push(current)
  return tokens
}

function normalizeRedisValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (Array.isArray(value)) return value.map(normalizeRedisValue)
  if (typeof value === 'object') return JSON.parse(JSON.stringify(value))
  return value
}

export class RedisAdapter implements DbAdapter {
  readonly kind = 'redis'
  private client: RedisClientType | null = null
  /** Mirrors ConnectionConfig.accessMode. Redis has no session read-only
   * mode, so writes are blocked in DBLion only. */
  private readOnly = false

  private requireClient(): RedisClientType {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.readOnly = isReadOnlyAccess(config)
    const credentials = config.password
      ? `:${encodeURIComponent(config.password)}@`
      : ''
    const url =
      config.connectionString ||
      `redis://${credentials}${config.host ?? 'localhost'}:${config.port ?? 6379}/${config.database ?? 0}`
    this.client = createClient({ url })
    this.client.on('error', () => undefined)
    await this.client.connect()
    await this.client.ping()
  }

  async disconnect(): Promise<void> {
    await this.client?.quit()
    this.client = null
    this.readOnly = false
  }

  async serverVersion(): Promise<string> {
    const info = (await this.requireClient().info('server')) as string
    const match = /redis_version:([^\r\n]+)/.exec(info)
    return `Redis ${match?.[1] ?? ''}`.trim()
  }

  async query(sql: string, _params: unknown[] = [], allowWrites = false) {
    if (classifyRedis(sql) !== 'read') {
      if (this.readOnly) {
        throw new Error(
          'This connection is read-only. Only read Redis commands are allowed; connect a read-write profile to write.'
        )
      }
      if (!allowWrites) {
        throw new Error('The write toggle is off. Enable “Allow writes” for this Redis command.')
      }
    }
    const started = Date.now()
    const tokens = tokenize(sql)
    if (tokens.length === 0) throw new Error('Empty Redis command')
    const [command, ...args] = tokens
    const value = await this.requireClient().sendCommand([
      command.toUpperCase(),
      ...args
    ])
    const normalized = normalizeRedisValue(value)
    const rows =
      Array.isArray(normalized)
        ? normalized.map((item) => ({ result: item }))
        : [{ result: normalized }]
    return makeResult(['result'], rows, Date.now() - started, command.toUpperCase())
  }

  async listTables(): Promise<TableInfo[]> {
    const client = this.requireClient()
    const keys = new Set<string>()
    let cursor = '0'
    do {
      const reply = (await client.scan(cursor, { MATCH: '*', COUNT: 200 })) as {
        cursor: string
        keys: string[]
      }
      for (const key of reply.keys) keys.add(key)
      cursor = reply.cursor
    } while (cursor !== '0' && keys.size < 300)
    return [...keys].slice(0, 300).map((key) => ({ name: key, type: 'key' }))
  }

  async describeTable(_schema: string | undefined, table: string): Promise<TableDetails> {
    const client = this.requireClient()
    const type = String(await client.type(table))
    const columns = [
      { name: 'key', type: 'string', nullable: false, primaryKey: true },
      { name: 'type', type: 'string', nullable: false, defaultValue: type }
    ]
    if (type === 'hash') {
      const values = (await client.hGetAll(table)) as Record<string, string>
      for (const field of Object.keys(values).slice(0, 50)) {
        columns.push({ name: field, type: 'string', nullable: true, defaultValue: values[field] })
      }
    }
    return { table, columns, primaryKey: ['key'], foreignKeys: [] }
  }

  async graph(): Promise<SchemaGraph> {
    const keys = (await this.listTables()).slice(0, 80)
    const groups = new Map<string, string[]>()
    for (const key of keys) {
      const prefix = key.name.includes(':') ? key.name.split(':')[0] : key.name
      if (!groups.has(prefix)) groups.set(prefix, [])
      groups.get(prefix)!.push(key.name)
    }
    return {
      nodes: [...groups.entries()].map(([prefix, names]) => ({
        id: prefix,
        label: `${prefix} (${names.length})`,
        columns: names.slice(0, 12).map((name) => ({
          name,
          type: 'key',
          nullable: false
        }))
      })),
      edges: []
    }
  }

  async buildContext(): Promise<string> {
    const keys = (await this.listTables()).slice(0, 120)
    return clipContext(
      `Redis keyspace (sample):\n${keys.map((key) => key.name).join('\n')}`
    )
  }
}
