import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Code2,
  Copy,
  FileText,
  GitCompare,
  Layers,
  RefreshCw,
  Search,
  Table2,
  X
} from 'lucide-react'
import type {
  ConnectionConfig,
  MigrationInfo,
  SchemaDiffResult,
  SchemaDdl,
  SchemaObjectInfo,
  SchemaPayload
} from '@shared/types'
import { shortError } from '../utils'

type Tab = 'catalog' | 'diff' | 'migrations'

interface Props {
  activeConnection: ConnectionConfig
  connections: ConnectionConfig[]
  schema?: SchemaPayload | null
  /** Read-only connections still inspect catalog/DDL/diff, but cannot save migrations. */
  readOnlyConnection?: boolean
  onClose: () => void
  onToast: (message: string, error?: boolean) => void
  onOpenSql: (sql: string) => void
}

const TYPE_ORDER = [
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
  'index'
]

const TYPE_LABEL: Record<string, string> = {
  table: 'Tables',
  view: 'Views',
  materialized_view: 'Materialized views',
  function: 'Functions',
  procedure: 'Procedures',
  trigger: 'Triggers',
  index: 'Indexes'
}

function objectLabel(object: SchemaObjectInfo): string {
  const base = `${object.schema ? `${object.schema}.` : ''}${object.name}`
  return object.parent && (object.type === 'trigger' || object.type === 'index')
    ? `${base} on ${object.parent}`
    : base
}

export default function SchemaToolsModal({
  activeConnection,
  connections,
  schema,
  readOnlyConnection = false,
  onClose,
  onToast,
  onOpenSql
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('catalog')
  const [schemaName, setSchemaName] = useState(schema?.tables[0]?.schema ?? '')
  const [catalog, setCatalog] = useState<SchemaObjectInfo[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<SchemaObjectInfo | null>(null)
  const [ddl, setDdl] = useState<SchemaDdl | null>(null)
  const [ddlLoading, setDdlLoading] = useState(false)
  const [rightId, setRightId] = useState('')
  const [diff, setDiff] = useState<SchemaDiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [migrationName, setMigrationName] = useState('')
  const [migrations, setMigrations] = useState<MigrationInfo[]>([])
  const [migrationsLoading, setMigrationsLoading] = useState(false)
  const [selectedMigration, setSelectedMigration] = useState<MigrationInfo | null>(null)

  const otherConnections = connections.filter((item) => item.id !== activeConnection.id)

  useEffect(() => {
    setRightId((current) => current || otherConnections[0]?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length, activeConnection.id])

  useEffect(() => {
    if (tab !== 'catalog') return
    void loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeConnection.id, schemaName])

  useEffect(() => {
    if (tab !== 'migrations') return
    void loadMigrations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function loadCatalog(): Promise<void> {
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const result = await window.dblion.schemaCatalog(activeConnection.id, schemaName || undefined)
      setCatalog(result.objects)
    } catch (cause) {
      setCatalogError(shortError(cause))
    } finally {
      setCatalogLoading(false)
    }
  }

  async function selectObject(object: SchemaObjectInfo): Promise<void> {
    setSelected(object)
    setDdl(null)
    setDdlLoading(true)
    try {
      setDdl(
        await window.dblion.objectDdl(activeConnection.id, {
          schema: object.schema,
          name: object.name,
          type: object.type,
          parent: object.parent
        })
      )
    } catch (cause) {
      onToast(shortError(cause), true)
    } finally {
      setDdlLoading(false)
    }
  }

  async function runDiff(): Promise<void> {
    if (!rightId) {
      setDiffError('Choose the right-side connection.')
      return
    }
    setDiffLoading(true)
    setDiffError(null)
    try {
      setDiff(await window.dblion.diffSchemas(activeConnection.id, rightId, schemaName || undefined))
      setMigrationName(`schema-diff-${new Date().toISOString().slice(0, 10)}`)
    } catch (cause) {
      setDiffError(shortError(cause))
    } finally {
      setDiffLoading(false)
    }
  }

  async function loadMigrations(): Promise<void> {
    setMigrationsLoading(true)
    try {
      setMigrations(await window.dblion.listMigrations())
    } catch (cause) {
      onToast(shortError(cause), true)
    } finally {
      setMigrationsLoading(false)
    }
  }

  async function saveDiffMigration(): Promise<void> {
    if (!diff) return
    try {
      const saved = await window.dblion.saveMigration({
        name: migrationName || 'schema-diff',
        sql: diff.migrationSql,
        dialect: diff.dialect,
        connectionId: activeConnection.id
      })
      onToast(`Migration saved: ${saved.name}`)
      await loadMigrations()
      setTab('migrations')
      setSelectedMigration(saved)
    } catch (cause) {
      onToast(shortError(cause), true)
    }
  }

  async function openMigration(migration: MigrationInfo): Promise<void> {
    try {
      setSelectedMigration((await window.dblion.readMigration(migration.id)) ?? migration)
    } catch (cause) {
      onToast(shortError(cause), true)
    }
  }

  async function copy(value: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    onToast('Copied to clipboard.')
  }

  const filtered = catalog.filter((object) =>
    `${object.schema ?? ''} ${object.name} ${object.type} ${object.parent ?? ''}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase())
  )
  const grouped = new Map<string, SchemaObjectInfo[]>()
  for (const object of filtered) {
    if (!grouped.has(object.type)) grouped.set(object.type, [])
    grouped.get(object.type)!.push(object)
  }
  const types = [...grouped.keys()].sort(
    (a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)
  )

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal modal--schema-tools"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schema-tools-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-icon">
            <Layers size={18} />
          </div>
          <div>
            <h2 className="modal-title" id="schema-tools-title">
              Schema tools
            </h2>
            <div className="modal-subtitle">{activeConnection.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close schema tools">
            <X size={15} />
          </button>
        </div>

        <div className="schema-tools">
          <div className="schema-tools__sidebar">
            <div className="schema-tools__tabs">
              <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
                <Layers size={14} /> Catalog
              </button>
              <button className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')}>
                <GitCompare size={14} /> Diff
              </button>
              <button
                className={tab === 'migrations' ? 'active' : ''}
                onClick={() => setTab('migrations')}
              >
                <FileText size={14} /> Migrations
              </button>
            </div>

            {tab !== 'migrations' ? (
              <label className="field">
                <span>Schema</span>
                <input
                  className="input"
                  value={schemaName}
                  onChange={(event) => setSchemaName(event.target.value)}
                  placeholder="default"
                />
              </label>
            ) : null}

            {tab === 'catalog' ? (
              <>
                <div className="schema-search">
                  <Search size={12} />
                  <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter objects"
                    aria-label="Filter schema objects"
                  />
                </div>
                <button className="btn btn-sm" onClick={() => void loadCatalog()}>
                  <RefreshCw size={13} className={catalogLoading ? 'spin' : ''} /> Refresh
                </button>
                <div className="schema-tools__object-list">
                  {catalogLoading ? <div className="schema-tools__empty">Loading catalog…</div> : null}
                  {catalogError ? <div className="results-error">{catalogError}</div> : null}
                  {!catalogLoading && !catalogError && filtered.length === 0 ? (
                    <div className="schema-tools__empty">No schema objects.</div>
                  ) : null}
                  {types.map((type) => (
                    <div key={type} className="schema-tools__type">
                      <div className="schema-tools__type-head">
                        <span>{TYPE_LABEL[type] ?? type}</span>
                        <span className="chip">{grouped.get(type)!.length}</span>
                      </div>
                      {grouped.get(type)!.map((object) => (
                        <button
                          key={`${object.type}:${object.schema ?? ''}:${object.name}:${object.parent ?? ''}`}
                          className={`schema-tools__object ${selected?.name === object.name && selected?.type === object.type ? 'active' : ''}`}
                          onClick={() => void selectObject(object)}
                        >
                          <Table2 size={12} />
                          <span>{objectLabel(object)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {tab === 'diff' ? (
              <>
                <div className="field">
                  <label htmlFor="diff-right">Compare with</label>
                  <select
                    id="diff-right"
                    className="select"
                    value={rightId}
                    onChange={(event) => setRightId(event.target.value)}
                  >
                    <option value="">Choose connection…</option>
                    {otherConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn btn-primary" onClick={() => void runDiff()} disabled={diffLoading}>
                  <GitCompare size={14} className={diffLoading ? 'spin' : ''} /> Compare
                </button>
                {diffError ? <div className="results-error">{diffError}</div> : null}
                {diff ? (
                  <div className="schema-tools__diff-list">
                    {diff.rows.length === 0 ? (
                      <div className="schema-tools__empty">No differences.</div>
                    ) : (
                      diff.rows.map((row) => (
                        <div className={`diff-row diff-row--${row.status}`} key={row.key}>
                          <span className="chip">{row.status}</span>
                          <span className="diff-row__name">
                            {row.schema ? `${row.schema}.` : ''}
                            {row.name}
                          </span>
                          <span className="diff-row__type">{row.type}</span>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === 'migrations' ? (
              <div className="schema-tools__object-list">
                <button className="btn btn-sm" onClick={() => void loadMigrations()}>
                  <RefreshCw size={13} className={migrationsLoading ? 'spin' : ''} /> Refresh
                </button>
                {migrations.length === 0 && !migrationsLoading ? (
                  <div className="schema-tools__empty">No saved migrations.</div>
                ) : null}
                {migrations.map((migration) => (
                  <button
                    key={migration.id}
                    className={`schema-tools__object ${selectedMigration?.id === migration.id ? 'active' : ''}`}
                    onClick={() => void openMigration(migration)}
                  >
                    <FileText size={12} />
                    <span>{migration.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="schema-tools__main">
            {tab === 'catalog' ? (
              selected ? (
                <>
                  <div className="schema-tools__main-head">
                    <div>
                      <span className="eyebrow">{selected.type}</span>
                      <h3>{objectLabel(selected)}</h3>
                    </div>
                    {ddl ? (
                      <div className="row">
                        <button className="btn btn-sm" onClick={() => void copy(ddl.sql)}>
                          <Copy size={13} /> Copy
                        </button>
                        <button className="btn btn-sm" onClick={() => onOpenSql(ddl.sql)}>
                          <ArrowRight size={13} /> Open in SQL
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {ddlLoading ? <div className="schema-tools__empty">Loading DDL…</div> : null}
                  {ddl ? (
                    <>
                      <pre className="schema-tools__code">{ddl.sql}</pre>
                      {ddl.warnings.map((warning) => (
                        <div className="schema-tools__warning" key={warning}>
                          {warning}
                        </div>
                      ))}
                    </>
                  ) : null}
                </>
              ) : (
                <div className="schema-tools__empty">Select an object to inspect its DDL.</div>
              )
            ) : null}

            {tab === 'diff' ? (
              diff ? (
                <>
                  <div className="schema-tools__main-head">
                    <div>
                      <span className="eyebrow">
                        {diff.leftLabel} <ArrowRight size={12} /> {diff.rightLabel}
                      </span>
                      <h3>{diff.rows.length} difference(s)</h3>
                    </div>
                    <div className="row">
                      <input
                        className="input"
                        value={migrationName}
                        onChange={(event) => setMigrationName(event.target.value)}
                        aria-label="Migration name"
                        placeholder="migration name"
                      />
                      <button className="btn btn-sm" onClick={() => void copy(diff.migrationSql)}>
                        <Copy size={13} /> Copy
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => void saveDiffMigration()}
                        disabled={readOnlyConnection}
                        title={
                          readOnlyConnection
                            ? 'This connection is read-only. Migrations are saved from a read-write profile.'
                            : 'Save the generated SQL as a local migration file'
                        }
                      >
                        <FileText size={13} /> Save migration
                      </button>
                    </div>
                  </div>
                  {readOnlyConnection ? (
                    <div className="schema-tools__warning">
                      This connection is read-only: the migration can be copied or opened in the SQL
                      editor, but saving is disabled.
                    </div>
                  ) : null}
                  {diff.destructive ? (
                    <div className="schema-tools__warning">
                      This diff includes destructive changes. Review every statement before applying.
                    </div>
                  ) : null}
                  {diff.truncated ? (
                    <div className="schema-tools__warning">
                      Catalog was truncated to keep the diff bounded.
                    </div>
                  ) : null}
                  <pre className="schema-tools__code">{diff.migrationSql}</pre>
                </>
              ) : (
                <div className="schema-tools__empty">
                  Choose a connection and run Compare. The generated SQL is saved, never executed.
                </div>
              )
            ) : null}

            {tab === 'migrations' ? (
              selectedMigration ? (
                <>
                  <div className="schema-tools__main-head">
                    <div>
                      <span className="eyebrow">{new Date(selectedMigration.createdAt).toLocaleString()}</span>
                      <h3>{selectedMigration.name}</h3>
                    </div>
                    <div className="row">
                      <button className="btn btn-sm" onClick={() => void copy(selectedMigration.sql)}>
                        <Copy size={13} /> Copy
                      </button>
                      <button className="btn btn-sm" onClick={() => onOpenSql(selectedMigration.sql)}>
                        <ArrowRight size={13} /> Open in SQL
                      </button>
                    </div>
                  </div>
                  <pre className="schema-tools__code">{selectedMigration.sql}</pre>
                </>
              ) : (
                <div className="schema-tools__empty">Select a saved migration.</div>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
