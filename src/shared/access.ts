import type { ConnectionAccessMode, ConnectionConfig, DbKind, ReadOnlyEnforcement } from './types'

/** Every new connection starts read-only; writes need a separate profile. */
export const DEFAULT_ACCESS_MODE: ConnectionAccessMode = 'read-only'

/**
 * Legacy profiles have no `accessMode`. They are normalized to read-only so an
 * upgrade can never silently grant write access to a saved connection.
 */
export function normalizeAccessMode(value: unknown): ConnectionAccessMode {
  return value === 'read-write' ? 'read-write' : DEFAULT_ACCESS_MODE
}

export function accessModeOf(
  connection: Pick<ConnectionConfig, 'accessMode'> | null | undefined
): ConnectionAccessMode {
  return normalizeAccessMode(connection?.accessMode)
}

export function isReadOnlyAccess(
  connection: Pick<ConnectionConfig, 'accessMode'> | null | undefined
): boolean {
  return accessModeOf(connection) === 'read-only'
}

/**
 * Where read-only is enforced for each engine. Only engines with a real
 * session/connection level switch are reported as `database`.
 */
export function readOnlyEnforcement(kind: DbKind): ReadOnlyEnforcement {
  switch (kind) {
    case 'postgres':
      // Startup option -c default_transaction_read_only=on, verified with
      // SHOW transaction_read_only.
      return 'database'
    case 'mysql':
      // SET SESSION TRANSACTION READ ONLY, verified against
      // @@session.transaction_read_only.
      return 'database'
    case 'sqlite':
      // PRAGMA query_only=ON, verified by reading the pragma back.
      return 'database'
    case 'firebird':
      // Every statement runs in a transaction flagged isc_tpb_read, so the
      // engine rejects writes even when they come from a stored procedure.
      return 'database'
    case 'mssql':
      // ApplicationIntent=ReadOnly is sent in the login packet (tedious
      // readOnlyIntent). A readable secondary refuses writes; on a primary the
      // server enforces nothing, so DBLion keeps blocking writes in main.
      return 'server-intent'
    default:
      // mongodb, redis: no session-level read-only switch is used.
      return 'app'
  }
}

export function readOnlyEnforcementNote(kind: DbKind): string {
  switch (readOnlyEnforcement(kind)) {
    case 'database':
      return 'The database itself rejects writes for this connection, either at the session level or through a read-only transaction.'
    case 'server-intent':
      return 'DBLion sends ApplicationIntent=ReadOnly. A readable secondary rejects writes; on a primary the block is enforced by DBLion only.'
    default:
      return 'Writes are blocked by DBLion in the main process. Use a read-write connection with its own credential for maintenance.'
  }
}

export function accessModeLabel(mode: ConnectionAccessMode): string {
  return mode === 'read-write' ? 'read-write' : 'read-only'
}
