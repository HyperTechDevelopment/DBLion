import { AlertTriangle, Braces, Clock, Copy, Table2 } from 'lucide-react'
import type { QueryResult } from '@shared/types'
import { formatCell } from '../utils'

interface Props {
  result: QueryResult | null
  error: string | null
  running: boolean
  onAskAi?: (error: string) => void
  onExport?: (content: string, filename: string) => void
}

const MAX_ROWS = 5000

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`
  return [
    columns.map(escape).join(','),
    ...rows.map((row) => columns.map((column) => escape(formatCell(row[column]))).join(','))
  ].join('\r\n')
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return value.toString()
  return `'${String(value).replace(/'/g, "''")}'`
}

function identifier(value: string): string {
  return /^[a-z_][a-z0-9_]*$/i.test(value) ? value : `"${value.replace(/"/g, '""')}"`
}

function toSqlInsert(columns: string[], rows: Record<string, unknown>[]): string {
  if (columns.length === 0) return ''
  const names = columns.map(identifier).join(', ')
  return rows
    .map(
      (row) =>
        `INSERT INTO query_result (${names}) VALUES (${columns
          .map((column) => sqlLiteral(row[column]))
          .join(', ')});`
    )
    .join('\n')
}

export default function ResultsGrid({ result, error, running, onAskAi, onExport }: Props) {
  const rows = result?.rows.slice(0, MAX_ROWS) ?? []
  const truncated = Boolean(result && (result.truncated || result.rows.length > MAX_ROWS))

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // clipboard can be unavailable in hardened environments
    }
  }

  function exportFile(content: string, filename: string): void {
    if (onExport) onExport(content, filename)
    else void copy(content)
  }

  return (
    <section className="results">
      <div className="results-header">
        <div className="results-header__status">
          {running ? (
            <>
              <span className="spinner" />
              <span>Running query…</span>
            </>
          ) : error ? (
            <>
              <AlertTriangle size={13} style={{ color: 'var(--red)' }} />
              <span style={{ color: 'var(--red)' }}>Query error</span>
            </>
          ) : result ? (
            <>
              <Table2 size={13} />
              <span>
                {truncated ? `showing ${rows.length} of ${result.rows.length}` : `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`}
              </span>
              <span className="results-header__dot">·</span>
              <Clock size={12} />
              <span>{Math.round(result.durationMs)} ms</span>
              {result.command ? (
                <>
                  <span className="results-header__dot">·</span>
                  <span className="mono">{result.command}</span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Table2 size={13} />
              <span>Results</span>
            </>
          )}
        </div>

        {result && result.columns.length > 0 ? (
          <div className="results-header__actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => exportFile(toCsv(result.columns, rows), 'query-result.csv')}
              title={onExport ? 'Save as CSV' : 'Copy as CSV'}
            >
              <Copy size={13} /> CSV
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                exportFile(JSON.stringify(rows, null, 2), 'query-result.json')
              }
              title={onExport ? 'Save as JSON' : 'Copy as JSON'}
            >
              <Braces size={13} /> JSON
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                exportFile(toSqlInsert(result.columns, rows), 'query-result.sql')
              }
              title={onExport ? 'Save as SQL INSERT' : 'Copy as SQL INSERT'}
            >
              <Braces size={13} /> SQL
            </button>
          </div>
        ) : null}
      </div>

      {truncated && result ? (
        <div className="results-limit" role="status">
          <AlertTriangle size={13} />
          <span>
            {result.truncated
              ? `The server returned the ${rows.length.toLocaleString()}-row limit. Add a LIMIT or filter to narrow the result.`
              : `Showing the first ${rows.length.toLocaleString()} of ${result.rows.length.toLocaleString()} rows. Add a LIMIT or filter to narrow the result.`}
          </span>
        </div>
      ) : null}

      <div className="results-scroll">
        {error ? (
          <div className="results-error">
            <div className="results-error__icon">
              <AlertTriangle size={20} />
            </div>
            <strong>Query failed</strong>
            <pre>{error}</pre>
            {onAskAi ? (
              <button className="btn btn-primary" onClick={() => onAskAi(error)}>
                Ask AI to fix
              </button>
            ) : null}
          </div>
        ) : result && result.columns.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th className="row-number">#</th>
                {result.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="row-number">{rowIndex + 1}</td>
                  {result.columns.map((column) => {
                    const value = row[column]
                    return (
                      <td
                        key={column}
                        className={value === null ? 'null' : ''}
                        title={`${formatCell(value)} — click to copy`}
                        onClick={() => void copy(formatCell(value))}
                      >
                        {formatCell(value)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : result ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state__icon">
              <Table2 size={18} />
            </div>
            <strong>Statement executed</strong>
            <span>{result.rowCount} row(s) affected</span>
          </div>
        ) : (
          <div className="empty-state empty-state--compact">
            <div className="empty-state__icon">
              <Table2 size={18} />
            </div>
            <strong>No results yet</strong>
            <span>
              Run a query with <span className="kbd">Ctrl</span> <span className="kbd">↵</span>.
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
