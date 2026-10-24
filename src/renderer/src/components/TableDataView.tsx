import { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Upload,
  X
} from 'lucide-react'
import type {
  CsvFile,
  CsvImportPreview,
  CsvImportRequest,
  DbKind,
  MutationPreview,
  RowUpdateRequest,
  TablePage
} from '@shared/types'
import { shortError } from '../utils'

interface Props {
  connectionId: string
  kind: DbKind
  schema?: string
  table: string
  tableType?: string
  allowWrites: boolean
  canImport: boolean
  /** True when the connection itself is read-only, so editing is not offered at all. */
  readOnlyConnection?: boolean
  schemaFingerprint?: string
  onToast: (message: string, error?: boolean) => void
}

interface PendingEdit {
  rowIndex: number
  column: string
  oldValue: unknown
  newValue: string
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function quote(kind: DbKind, name: string): string {
  if (kind === 'mysql' || kind === 'sqlite') return `\`${name.replace(/`/g, '``')}\``
  if (kind === 'mssql') return `[${name.replace(/]/g, ']]')}]`
  return `"${name.replace(/"/g, '""')}"`
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? '' : formatCell(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export default function TableDataView({
  connectionId,
  kind,
  schema,
  table,
  tableType,
  allowWrites,
  canImport,
  readOnlyConnection = false,
  schemaFingerprint,
  onToast
}: Props): React.JSX.Element {
  const [page, setPage] = useState<TablePage | null>(null)
  const [offset, setOffset] = useState(0)
  const [filterColumn, setFilterColumn] = useState('')
  const [filterValue, setFilterValue] = useState('')
  const [appliedFilter, setAppliedFilter] = useState<{ column: string; value: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ rowIndex: number; column: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [pending, setPending] = useState<PendingEdit | null>(null)
  const [request, setRequest] = useState<RowUpdateRequest | null>(null)
  const [preview, setPreview] = useState<MutationPreview | null>(null)
  const [applying, setApplying] = useState(false)
  const [reload, setReload] = useState(0)
  const [importFile, setImportFile] = useState<CsvFile | null>(null)
  const [importRequest, setImportRequest] = useState<CsvImportRequest | null>(null)
  const [importPreview, setImportPreview] = useState<CsvImportPreview | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    setOffset(0)
    setPending(null)
    setPreview(null)
  }, [connectionId, schema, table])

  useEffect(() => {
    let canceled = false
    setLoading(true)
    setError(null)
    window.dblion
      .tablePage({
        connectionId,
        schema,
        table,
        tableType,
        limit: 100,
        offset,
        filters: appliedFilter
          ? [{ column: appliedFilter.column, op: 'like', value: `%${appliedFilter.value}%` }]
          : undefined
      })
      .then((next) => {
        if (!canceled) setPage(next)
      })
      .catch((cause) => {
        if (!canceled) setError(shortError(cause))
      })
      .finally(() => {
        if (!canceled) setLoading(false)
      })
    return () => {
      canceled = true
    }
  }, [connectionId, schema, table, tableType, offset, appliedFilter, reload])

  function startEdit(rowIndex: number, column: string, value: unknown): void {
    if (!allowWrites || !page?.editable) return
    setEditing({ rowIndex, column })
    setEditValue(value === null || value === undefined ? '' : String(value))
  }

  function commitEdit(): void {
    if (!editing || !page) return
    const row = page.rows[editing.rowIndex]
    if (!row) return
    const oldValue = row[editing.column]
    if (formatCell(oldValue) === editValue) {
      setEditing(null)
      return
    }
    setPending({
      rowIndex: editing.rowIndex,
      column: editing.column,
      oldValue,
      newValue: editValue
    })
    setPreview(null)
    setRequest(null)
    setEditing(null)
  }

  async function previewUpdate(): Promise<void> {
    if (!pending || !page) return
    const row = page.rows[pending.rowIndex]
    if (!row) return
    const identity = Object.fromEntries(
      page.primaryKey.map((column) => [column, row[column]])
    )
    const nextRequest: RowUpdateRequest = {
      connectionId,
      schema: page.source.schema,
      table: page.source.table,
      identity,
      changes: { [pending.column]: pending.newValue },
      expected: { [pending.column]: pending.oldValue },
      allowWrites
    }
    try {
      const next = await window.dblion.previewRowUpdate(nextRequest)
      setRequest(nextRequest)
      setPreview(next)
    } catch (cause) {
      onToast(shortError(cause), true)
    }
  }

  async function applyUpdate(): Promise<void> {
    if (!request || !preview) return
    setApplying(true)
    try {
      const token = await window.dblion.requestConfirmation({
        kind: 'row-update',
        title: 'Apply row update?',
        detail: preview.confirmationDetail
      })
      const result = await window.dblion.applyRowUpdate(request, token)
      if (result.rowCount !== 1) {
        throw new Error(
          'This row changed since it was loaded. Refresh the table and try again.'
        )
      }
      onToast('Row updated.')
      setPending(null)
      setPreview(null)
      setRequest(null)
      setOffset((value) => value)
      const next = await window.dblion.tablePage({
        connectionId,
        schema,
        table,
        tableType,
        limit: 100,
        offset,
        filters: appliedFilter
          ? [{ column: appliedFilter.column, op: 'like', value: `%${appliedFilter.value}%` }]
          : undefined
      })
      setPage(next)
    } catch (cause) {
      onToast(shortError(cause), true)
    } finally {
      setApplying(false)
    }
  }

  function applyFilter(): void {
    if (!filterColumn || !filterValue.trim()) {
      setAppliedFilter(null)
      return
    }
    setOffset(0)
    setAppliedFilter({ column: filterColumn, value: filterValue.trim() })
  }

  async function exportCsv(): Promise<void> {
    if (!page) return
    const csv = [
      page.columns.map((column) => csvValue(column.name)).join(','),
      ...page.rows.map((row) => page.columns.map((column) => csvValue(row[column.name])).join(','))
    ].join('\n')
    await window.dblion.saveTextFile(`${table}.csv`, csv)
  }

  async function copyInsert(): Promise<void> {
    if (!page) return
    const target = page.source.schema
      ? `${quote(kind, page.source.schema)}.${quote(kind, page.source.table)}`
      : quote(kind, page.source.table)
    const columns = page.columns.map((column) => quote(kind, column.name)).join(', ')
    const statements = page.rows.map(
      (row) =>
        `INSERT INTO ${target} (${columns}) VALUES (${page.columns
          .map((column) => literal(row[column.name]))
          .join(', ')});`
    )
    await navigator.clipboard.writeText(statements.join('\n'))
    onToast(`${statements.length} INSERT statement(s) copied.`)
  }

  async function openCsvImport(): Promise<void> {
    setImportError(null)
    try {
      const file = await window.dblion.pickCsvFile()
      if (!file) return
      const nextRequest: CsvImportRequest = {
        connectionId,
        schema: page?.source.schema ?? schema,
        table: page?.source.table ?? table,
        csvText: file.text,
        mapping: {},
        hasHeader: true,
        allowWrites,
        schemaFingerprint
      }
      const nextPreview = await window.dblion.previewCsvImport(nextRequest)
      setImportFile(file)
      setImportRequest(nextRequest)
      setImportPreview(nextPreview)
    } catch (cause) {
      onToast(shortError(cause), true)
    }
  }

  async function applyCsv(): Promise<void> {
    if (!importRequest || !importPreview) return
    setImporting(true)
    setImportError(null)
    try {
      const token = await window.dblion.requestConfirmation({
        kind: 'import-csv',
        title: `Import ${importPreview.rowCount} CSV row(s)?`,
        detail: importPreview.confirmationDetail
      })
      const result = await window.dblion.applyCsvImport(
        importRequest,
        token,
        schemaFingerprint
      )
      onToast(`${result.rowCount} row(s) imported.`)
      setImportFile(null)
      setImportRequest(null)
      setImportPreview(null)
      setReload((value) => value + 1)
    } catch (cause) {
      setImportError(shortError(cause))
    } finally {
      setImporting(false)
    }
  }

  const canEdit = Boolean(allowWrites && page?.editable)

  return (
    <div className="table-browser">
      <div className="table-browser__head">
        <div>
          <div className="eyebrow">Table data</div>
          <h3>
            {schema ? `${schema}.` : ''}
            {table}
          </h3>
          <p>
            {page ? `${page.rows.length} rows · page offset ${page.offset}` : 'Loading table…'}
            {page && !page.editable
              ? readOnlyConnection
                ? ' · this connection is read-only'
                : ' · read-only view or no primary key'
              : ''}
          </p>
        </div>
        <div className="table-browser__actions">
          <button className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button className="btn btn-sm" onClick={() => void exportCsv()} disabled={!page}>
            <Download size={13} /> CSV
          </button>
          <button className="btn btn-sm" onClick={() => void copyInsert()} disabled={!page}>
            <Copy size={13} /> Copy INSERT
          </button>
          {canImport ? (
            <button className="btn btn-sm" onClick={() => void openCsvImport()}>
              <Upload size={13} /> Import CSV
            </button>
          ) : null}
        </div>
      </div>

      <div className="table-browser__filters">
        <select
          className="input"
          value={filterColumn}
          onChange={(event) => setFilterColumn(event.target.value)}
          aria-label="Filter column"
        >
          <option value="">Filter column…</option>
          {page?.columns.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={filterValue}
          onChange={(event) => setFilterValue(event.target.value)}
          placeholder="contains…"
          aria-label="Filter value"
        />
        <button className="btn btn-sm" onClick={applyFilter} disabled={!filterColumn}>
          Apply
        </button>
        {appliedFilter ? (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setAppliedFilter(null)
              setFilterValue('')
            }}
          >
            <X size={12} /> Clear
          </button>
        ) : null}
        {!canEdit ? (
          <span
            className="chip chip--soft"
            title={
              readOnlyConnection
                ? 'This connection is read-only: cell editing and CSV import are disabled. Connect a read-write profile to change data.'
                : !page?.editable
                  ? 'Editing needs a primary key and a table (views are read-only).'
                  : 'Enable “Writes” in the SQL editor toolbar to edit cells.'
            }
          >
            <KeyRound size={11} /> Read-only
          </span>
        ) : null}
      </div>

      {error ? <div className="results-error">{error}</div> : null}
      {loading && !page ? (
        <div className="results-empty">
          <Loader2 size={18} className="spin" /> Loading…
        </div>
      ) : null}

      {page ? (
        <div className="table-browser__grid-wrap">
          <table className="data-grid">
            <thead>
              <tr>
                <th className="data-grid__row-number">#</th>
                {page.columns.map((column) => (
                  <th key={column.name} title={`${column.name}: ${column.type}`}>
                    {column.name}
                    {column.primaryKey ? <span className="data-grid__pk">PK</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="data-grid__row-number">{offset + rowIndex + 1}</td>
                  {page.columns.map((column) => {
                    const isEditing =
                      editing?.rowIndex === rowIndex && editing.column === column.name
                    const isPending =
                      pending?.rowIndex === rowIndex && pending.column === column.name
                    const value = isPending ? pending.newValue : row[column.name]
                    return (
                      <td
                        key={column.name}
                        className={isPending ? 'data-grid__cell is-dirty' : 'data-grid__cell'}
                        onDoubleClick={() => startEdit(rowIndex, column.name, row[column.name])}
                        title={canEdit ? 'Double-click to edit' : undefined}
                      >
                        {isEditing ? (
                          <input
                            className="data-grid__input"
                            autoFocus
                            value={editValue}
                            onChange={(event) => setEditValue(event.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') commitEdit()
                              if (event.key === 'Escape') setEditing(null)
                            }}
                          />
                        ) : value === null || value === undefined ? (
                          <span className="data-grid__null">NULL</span>
                        ) : (
                          formatCell(value)
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="table-browser__footer">
        <div className="table-browser__pager">
          <button
            className="btn btn-sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 100))}
          >
            <ChevronLeft size={13} /> Previous
          </button>
          <span>{offset + 1}–{offset + (page?.rows.length ?? 0)}</span>
          <button
            className="btn btn-sm"
            disabled={!page || page.rows.length < page.limit}
            onClick={() => setOffset(offset + 100)}
          >
            Next <ChevronRight size={13} />
          </button>
        </div>
      </div>

      {pending ? (
        <div className="row-change">
          <div>
            <strong>Pending change</strong>
            <span>
              {pending.column}: {formatCell(pending.oldValue)} → {pending.newValue || 'NULL'}
            </span>
          </div>
          <div className="row-change__actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>
              Discard
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void previewUpdate()}>
              Preview UPDATE
            </button>
          </div>
        </div>
      ) : null}

      {importPreview && importFile ? (
        <div className="row-preview row-preview--import">
          <div className="row-preview__head">
            <div>
              <span className="eyebrow">CSV import preview</span>
              <h4>{importFile.name}</h4>
            </div>
            <button
              className="icon-btn"
              onClick={() => {
                setImportFile(null)
                setImportPreview(null)
                setImportRequest(null)
              }}
              aria-label="Close import preview"
            >
              <X size={14} />
            </button>
          </div>
          <p className="field-hint">
            {importPreview.rowCount} row(s) · target columns: {importPreview.columns.join(', ')}
          </p>
          <pre>{importPreview.sql}</pre>
          {importPreview.warnings.length > 0 ? (
            <ul>
              {importPreview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {importError ? <div className="results-error">{importError}</div> : null}
          {!allowWrites ? (
            <div className="field-hint">Enable “Writes” before importing.</div>
          ) : null}
          <div className="row-preview__actions">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setImportFile(null)
                setImportPreview(null)
                setImportRequest(null)
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void applyCsv()}
              disabled={importing || !allowWrites}
            >
              {importing ? <Loader2 size={13} className="spin" /> : null} Import
            </button>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="row-preview">
          <div className="row-preview__head">
            <div>
              <span className="eyebrow">Preview</span>
              <h4>Generated UPDATE</h4>
            </div>
            <button className="icon-btn" onClick={() => setPreview(null)} aria-label="Close preview">
              <X size={14} />
            </button>
          </div>
          <pre>{preview.sql}</pre>
          {preview.warnings.length > 0 ? (
            <ul>
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <div className="row-preview__actions">
            <button className="btn btn-ghost" onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void applyUpdate()} disabled={applying}>
              {applying ? <Loader2 size={13} className="spin" /> : null} Apply update
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
