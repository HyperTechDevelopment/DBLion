import { useState } from 'react'
import {
  Code2,
  Cylinder,
  Database,
  Flame,
  HardDrive,
  Layers,
  Leaf,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Server,
  Star,
  Table2,
  Trash2,
  Zap
} from 'lucide-react'
import type { ConnectionConfig, DbKind, SchemaPayload, TableInfo } from '@shared/types'

interface Props {
  connections: ConnectionConfig[]
  activeId?: string
  connected: Record<string, boolean>
  onSelect: (id: string) => void
  onAdd: () => void
  onEdit: (connection: ConnectionConfig) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onDelete: (id: string) => void
  schema?: SchemaPayload | null
  schemaLoading?: boolean
  onRefreshSchema?: () => void
  onInsertTable?: (qualifiedName: string) => void
  onOpenTable?: (schema: string | undefined, table: string, type?: string) => void
  onOpenSchemaTools?: () => void
}

const KIND_ICON: Record<DbKind, typeof Database> = {
  postgres: Database,
  mysql: Cylinder,
  mssql: Server,
  firebird: Flame,
  sqlite: HardDrive,
  mongodb: Leaf,
  redis: Zap
}

const KIND_LABEL: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  firebird: 'Firebird',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  redis: 'Redis'
}

/** Mirrors PINNED_TABLE_LIMIT in src/main/ai/schemaFocus.ts. */
const PINNED_TABLE_LIMIT = 10

/** The name saved in ConnectionConfig.pinnedTables: `schema.name` when known. */
function pinnedRef(table: TableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name
}

export default function Sidebar({
  connections,
  activeId,
  connected,
  onSelect,
  onAdd,
  onEdit,
  onConnect,
  onDisconnect,
  onDelete,
  schema,
  schemaLoading,
  onRefreshSchema,
  onInsertTable,
  onOpenTable,
  onOpenSchemaTools
}: Props) {
  const [schemaFilter, setSchemaFilter] = useState('')
  // Pins are saved through the existing connection:save path; the local copy
  // keeps the star responsive without waiting for the write to come back.
  const [pinOverrides, setPinOverrides] = useState<Record<string, string[]>>({})
  const activeConnection = connections.find((connection) => connection.id === activeId)
  const pinnedTables = activeId
    ? pinOverrides[activeId] ?? activeConnection?.pinnedTables ?? []
    : []
  const filter = schemaFilter.trim().toLowerCase()
  const tables =
    schema?.tables.filter((table) =>
      `${table.schema ?? ''} ${table.name} ${table.type ?? ''}`.toLowerCase().includes(filter)
    ) ?? []
  const groups = new Map<string, typeof tables>()
  for (const table of tables.slice(0, 250)) {
    const key = table.schema || 'default'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(table)
  }

  /**
   * Pin/unpin a table for the AI context. Reads the freshest saved profile first
   * so a stale renderer state cannot drop pins, then persists through the
   * existing connection:save handler (no new IPC surface).
   */
  async function togglePin(table: TableInfo): Promise<void> {
    if (!activeId) return
    const connectionId = activeId
    const ref = pinnedRef(table)
    try {
      const latest = await window.dblion.getState()
      const connection = latest.connections.find((item) => item.id === connectionId)
      if (!connection) return
      const current = connection.pinnedTables ?? []
      const next = current.includes(ref)
        ? current.filter((item) => item !== ref)
        : [...current, ref].slice(0, PINNED_TABLE_LIMIT)
      setPinOverrides((previous) => ({ ...previous, [connectionId]: next }))
      await window.dblion.saveConnection({ ...connection, pinnedTables: next })
    } catch {
      // A failed pin write must not break the explorer; the star simply reverts.
      setPinOverrides((previous) => {
        const next = { ...previous }
        delete next[connectionId]
        return next
      })
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <span className="sidebar-title">Workspace</span>
          <span className="sidebar-subtitle">Connections</span>
        </div>
        <span className="count-pill">{connections.length}</span>
      </div>

      <div className="conn-list">
        {connections.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state__icon">
              <Database size={18} />
            </div>
            <strong>No connections</strong>
            <span>Add PostgreSQL, MySQL, SQL Server, Firebird, SQLite, MongoDB or Redis.</span>
            <button className="btn btn-primary" onClick={onAdd}>
              <Plus size={14} /> Add connection
            </button>
          </div>
        ) : (
          connections.map((connection) => {
            const live = Boolean(connected[connection.id])
            const Icon = KIND_ICON[connection.kind] ?? Database
            return (
              <div
                key={connection.id}
                className={`conn-item ${connection.id === activeId ? 'active' : ''} ${live ? 'is-live' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={connection.id === activeId}
                aria-label={`${connection.name}, ${KIND_LABEL[connection.kind]}, ${live ? 'connected' : 'offline'}`}
                onClick={() => onSelect(connection.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(connection.id)
                  }
                }}
              >
                <span className="conn-icon">
                  <Icon size={16} />
                </span>
                <div className="conn-item-body">
                  <div className="conn-name">{connection.name}</div>
                  <div className="conn-meta">
                    <span>{KIND_LABEL[connection.kind]}</span>
                    {connection.host ? <span>· {connection.host}</span> : null}
                    {connection.file ? (
                      <span>· {connection.file.split(/[\\/]/).pop()}</span>
                    ) : null}
                  </div>
                </div>
                <span className={`state-dot ${live ? 'is-on' : ''}`} aria-hidden="true" />
                <span className="sr-only">{live ? 'Connected' : 'Offline'}</span>
                <div className="conn-item__actions">
                  <button
                    className="icon-btn"
                    title={live ? 'Disconnect' : 'Connect'}
                    aria-label={live ? `Disconnect ${connection.name}` : `Connect ${connection.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (live) onDisconnect(connection.id)
                      else onConnect(connection.id)
                    }}
                  >
                    {live ? (
                      <PowerOff size={14} style={{ color: 'var(--green)' }} />
                    ) : (
                      <Power size={14} />
                    )}
                  </button>
                  <button
                    className="icon-btn"
                    title="Edit connection"
                    aria-label={`Edit ${connection.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onEdit(connection)
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="Delete connection"
                    aria-label={`Delete ${connection.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDelete(connection.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {activeId && schema ? (
        <section className="schema-explorer">
          <div className="schema-explorer__head">
            <div>
              <span className="sidebar-title">Schema</span>
              <span className="sidebar-subtitle">
                {schema.tables.length} object{schema.tables.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="row">
              <button
                className="icon-btn"
                onClick={onOpenSchemaTools}
                title="Schema tools: catalog, DDL, diff and migrations"
                aria-label="Open schema tools"
              >
                <Layers size={13} />
              </button>
              <button
                className="icon-btn"
                onClick={onRefreshSchema}
                title="Refresh schema"
                aria-label="Refresh schema"
                disabled={schemaLoading}
              >
                <RefreshCw size={13} className={schemaLoading ? 'spin' : ''} />
              </button>
            </div>
          </div>
          <div className="schema-search">
            <Search size={12} />
            <input
              value={schemaFilter}
              onChange={(event) => setSchemaFilter(event.target.value)}
              placeholder="Filter tables and views"
              aria-label="Filter schema objects"
            />
          </div>
          <div className="schema-explorer__list">
            {groups.size === 0 ? (
              <div className="schema-explorer__empty">
                {schemaLoading ? 'Loading schema…' : 'No matching objects.'}
              </div>
            ) : (
              [...groups.entries()].map(([schemaName, items]) => (
                <div className="schema-group" key={schemaName}>
                  <div className="schema-group__name">{schemaName}</div>
                  {items.map((table) => {
                    // The star keeps a pinned table visible; the other row action
                    // only appears on hover (see .schema-object__insert in the CSS).
                    const pinned = pinnedTables.includes(pinnedRef(table))
                    return (
                      <div className="schema-object-row" key={`${table.schema ?? ''}.${table.name}`}>
                        <button
                          className="schema-object"
                          onClick={() => onOpenTable?.(table.schema, table.name, table.type)}
                          title="Open table data"
                        >
                          <Table2 size={12} />
                          <span className="schema-object__name">{table.name}</span>
                          <span className="schema-object__kind">
                            {table.type?.toLowerCase().includes('view') ? 'view' : 'table'}
                          </span>
                        </button>
                        <button
                          className="icon-btn schema-object__insert"
                          onClick={() => void togglePin(table)}
                          style={{ opacity: pinned ? 1 : undefined }}
                          title={
                            pinned
                              ? 'Unpin: stop sending this table to the AI'
                              : 'Pin: always include this table in the AI context'
                          }
                          aria-label={pinned ? `Unpin ${table.name}` : `Pin ${table.name}`}
                          aria-pressed={pinned}
                        >
                          <Star
                            size={11}
                            fill={pinned ? 'currentColor' : 'none'}
                            style={pinned ? { color: 'var(--yellow)' } : undefined}
                          />
                        </button>
                        <button
                          className="icon-btn schema-object__insert"
                          onClick={() =>
                            onInsertTable?.(
                              table.schema ? `${table.schema}.${table.name}` : table.name
                            )
                          }
                          title="Insert name into the SQL editor"
                          aria-label={`Insert ${table.name}`}
                        >
                          <Code2 size={11} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      <div className="sidebar-footer">
        <button className="btn btn-primary btn-block" onClick={onAdd}>
          <Plus size={15} /> New connection
        </button>
      </div>
    </aside>
  )
}
