import { normalizeAccessMode } from '@shared/access'
import type { ConnectionConfig } from '@shared/types'

/**
 * Normalization applied to every connection read from or written to disk.
 *
 * Profiles saved before per-connection access modes have no `accessMode`; they
 * become `read-only` so an upgrade can never widen what a saved connection is
 * allowed to do. Kept free of Electron imports so the read-only test can call
 * it directly.
 */
export function normalizeConnection(connection: ConnectionConfig): ConnectionConfig {
  return { ...connection, accessMode: normalizeAccessMode(connection.accessMode) }
}

export function normalizeConnections(
  connections: readonly ConnectionConfig[]
): ConnectionConfig[] {
  return connections.map(normalizeConnection)
}
