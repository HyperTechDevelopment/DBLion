import fs from 'node:fs/promises'
import initSqlJs, { type Database } from 'sql.js'

/**
 * Opening logic for the SQLite adapter, kept free of Electron imports so the
 * automated read-only test can exercise the exact production path
 * (`scripts/read-only-enforcement.test.mjs`).
 */

export interface OpenSqliteOptions {
  file: string
  readOnly: boolean
  /** Resolves sql-wasm.wasm; the adapter supplies the Electron-aware lookup. */
  locateFile: (file: string) => string
}

export interface OpenedSqliteDatabase {
  db: Database
  readOnly: boolean
  /** True when `PRAGMA query_only` reads back as 1. */
  readOnlyEnforced: boolean
}

/** Reads `PRAGMA query_only`; 1 means the database rejects every write. */
export function sqliteQueryOnlyActive(db: Database): boolean {
  try {
    const result = db.exec('PRAGMA query_only')
    return Number(result[0]?.values?.[0]?.[0]) === 1
  } catch {
    return false
  }
}

/** Enables query_only and reports whether SQLite confirmed it. */
export function applySqliteQueryOnly(db: Database): boolean {
  try {
    db.exec('PRAGMA query_only = ON')
  } catch {
    return false
  }
  return sqliteQueryOnlyActive(db)
}

/** Clears the fence. Only a connection DBLion fenced itself may call this. */
export function clearSqliteQueryOnly(db: Database): void {
  db.exec('PRAGMA query_only = OFF')
}

export async function openSqliteDatabase(
  options: OpenSqliteOptions
): Promise<OpenedSqliteDatabase> {
  const SQL = await initSqlJs({ locateFile: options.locateFile })
  let data: Uint8Array | undefined
  try {
    data = new Uint8Array(await fs.readFile(options.file))
  } catch {
    data = undefined
  }
  const db = new SQL.Database(data)
  if (!options.readOnly) {
    return { db, readOnly: false, readOnlyEnforced: false }
  }
  const readOnlyEnforced = applySqliteQueryOnly(db)
  return { db, readOnly: true, readOnlyEnforced }
}
