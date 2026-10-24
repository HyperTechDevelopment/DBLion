import { createHash } from 'node:crypto'
import type { TableInfo } from '@shared/types'
import type { ColumnRef } from '../db/types'

/**
 * Per-connection metadata cache for the AI context builder.
 *
 * Why: a database with thousands of tables costs several metadata round trips
 * per chat message (list tables, then describe the matches). The index keeps
 * the table list and the column names in memory for a short window.
 *
 * Rules:
 * - memory only: never written to disk, never sent to the renderer;
 * - dropped on connect, disconnect and schema refresh, so a reload never reads
 *   a snapshot from a previous session;
 * - bounded: at most SCHEMA_INDEX_MAX_CONNECTIONS entries, least recently used
 *   evicted first.
 */
export interface SchemaIndexData {
  tables: TableInfo[]
  columns: ColumnRef[]
}

export interface SchemaIndexEntry extends SchemaIndexData {
  /** Stable id of the metadata snapshot, for logs and cache-busting. */
  fingerprint: string
  readAt: number
}

/** Metadata older than this is re-read: long enough to be useful, short enough to notice DDL. */
export const SCHEMA_INDEX_TTL_MS = 10 * 60_000
/** One entry per open connection; the least recently used is evicted past this. */
export const SCHEMA_INDEX_MAX_CONNECTIONS = 8

const entries = new Map<string, SchemaIndexEntry>()
/** Deduplicates concurrent reads (chat + context preview) for one connection. */
const inFlight = new Map<string, Promise<SchemaIndexEntry>>()

export function schemaIndexFingerprint(data: SchemaIndexData): string {
  const tables = data.tables.map((table) => `${table.schema ?? ''}.${table.name}`).sort()
  const columns = data.columns
    .map((column) => `${column.schema ?? ''}.${column.table}.${column.column}`)
    .sort()
  return createHash('sha256')
    .update(JSON.stringify({ tables, columns }))
    .digest('hex')
    .slice(0, 12)
}

function remember(connectionId: string, entry: SchemaIndexEntry): SchemaIndexEntry {
  entries.delete(connectionId)
  entries.set(connectionId, entry)
  while (entries.size > SCHEMA_INDEX_MAX_CONNECTIONS) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  return entry
}

/**
 * Returns the index for a connection, loading it through `loader` only when it
 * is missing or stale. `now` is injectable so the TTL is testable.
 */
export async function getSchemaIndex(
  connectionId: string,
  loader: () => Promise<SchemaIndexData>,
  now: number = Date.now()
): Promise<SchemaIndexEntry> {
  const cached = entries.get(connectionId)
  if (cached && now - cached.readAt < SCHEMA_INDEX_TTL_MS) {
    // Touch: the most recently used connection stays at the end of the map.
    entries.delete(connectionId)
    entries.set(connectionId, cached)
    return cached
  }
  const running = inFlight.get(connectionId)
  if (running) return running
  const pending = (async () => {
    const data = await loader()
    return remember(connectionId, {
      tables: data.tables,
      columns: data.columns,
      fingerprint: schemaIndexFingerprint(data),
      readAt: now
    })
  })()
  inFlight.set(connectionId, pending)
  try {
    return await pending
  } finally {
    inFlight.delete(connectionId)
  }
}

/** Drops the snapshot of one connection (connect, disconnect, schema refresh). */
export function invalidateSchemaIndex(connectionId: string): void {
  entries.delete(connectionId)
  inFlight.delete(connectionId)
}

/** Drops every snapshot. Only tests and shutdown need this. */
export function clearSchemaIndexes(): void {
  entries.clear()
  inFlight.clear()
}
