import { AlertTriangle, Gauge } from 'lucide-react'
import type { ExplainResult, PlanNode } from '@shared/types'

// Espelho renderer-side do redact (display): mesma ordem do main. O plano já
// chega redigido do main; aqui é defense-in-depth antes de exibir.
function redactForDisplay(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[redacted-cpf]')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[redacted-cnpj]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[redacted-card]')
    .replace(/\b\(?\d{2}\)?[\s-]?\d{4,5}[-.\s]?\d{4}\b/g, '[redacted-phone]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [redacted]')
    .replace(
      /((?:password|passwd|pwd|secret|token|api[_-]?key|senha)\s*[:=]\s*['"]?)[^'"\s;,]+/gi,
      '$1[redacted]'
    )
}

function maxCost(roots: PlanNode[]): number {
  let max = 0
  const visit = (node: PlanNode): void => {
    if (node.costTotal !== undefined && node.costTotal > max) max = node.costTotal
    for (const child of node.children) visit(child)
  }
  for (const root of roots) visit(root)
  return max
}

function PlanTree({ node, depth, ceiling }: { node: PlanNode; depth: number; ceiling: number }) {
  const heat =
    node.costTotal !== undefined && ceiling > 0
      ? Math.min(0.35, (node.costTotal / ceiling) * 0.35)
      : 0
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 18 }}>
      <div
        className="mono"
        style={{
          padding: '6px 10px',
          borderLeft: depth === 0 ? 'none' : '2px solid var(--border)',
          background: `rgba(255, 120, 60, ${heat})`,
          borderRadius: 6,
          marginBottom: 4,
          fontSize: 12,
          lineHeight: 1.5
        }}
      >
        <div style={{ fontWeight: 600 }}>{redactForDisplay(node.operation)}</div>
        <div style={{ opacity: 0.85, fontSize: 11 }}>
          {node.relation ? <span> · {node.relation}</span> : null}
          {node.index ? <span> · idx {node.index}</span> : null}
          {node.costTotal !== undefined ? <span> · cost {node.costTotal.toFixed(2)}</span> : null}
          {node.rows !== undefined ? <span> · rows ~{Math.round(node.rows).toLocaleString()}</span> : null}
          {node.actualRows !== undefined ? <span> · actual {Math.round(node.actualRows).toLocaleString()}</span> : null}
          {node.actualTimeMs !== undefined ? <span> · {node.actualTimeMs.toFixed(2)} ms</span> : null}
        </div>
        {node.warnings.map((warning) => (
          <div key={warning} style={{ color: 'var(--amber, #f5a623)', fontSize: 11, marginTop: 2 }}>
            ⚠ {redactForDisplay(warning)}
          </div>
        ))}
      </div>
      {node.children.map((child) => (
        <PlanTree key={child.id} node={child} depth={depth + 1} ceiling={ceiling} />
      ))}
    </div>
  )
}

interface Props {
  plan: ExplainResult | null
  loading: boolean
  error: string | null
  analyze: boolean
  canAnalyze: boolean
  supported: boolean
  connected: boolean
  onToggleAnalyze: (value: boolean) => void
  onRun: () => void
}

export default function PlanView({
  plan,
  loading,
  error,
  analyze,
  canAnalyze,
  supported,
  connected,
  onToggleAnalyze,
  onRun
}: Props) {
  const ceiling = plan ? maxCost(plan.roots) : 0
  return (
    <section className="results">
      <div className="results-header">
        <div className="results-header__status">
          <Gauge size={13} />
          {loading ? (
            <span>Explaining query…</span>
          ) : error ? (
            <span style={{ color: 'var(--red)' }}>Explain failed</span>
          ) : plan ? (
            <>
              <span>
                {plan.roots.length} root{plan.roots.length === 1 ? '' : 's'}
              </span>
              {plan.totalCost !== undefined ? (
                <>
                  <span className="results-header__dot">·</span>
                  <span>cost {plan.totalCost.toFixed(2)}</span>
                </>
              ) : null}
              {plan.executionTimeMs !== undefined ? (
                <>
                  <span className="results-header__dot">·</span>
                  <span>{plan.executionTimeMs.toFixed(2)} ms</span>
                </>
              ) : null}
              {plan.warnings.length > 0 ? (
                <>
                  <span className="results-header__dot">·</span>
                  <span>{plan.warnings.length} warning{plan.warnings.length === 1 ? '' : 's'}</span>
                </>
              ) : (
                <>
                  <span className="results-header__dot">·</span>
                  <span>no warnings</span>
                </>
              )}
              {plan.analyze ? <span className="chip chip--soft">ANALYZE</span> : null}
            </>
          ) : (
            <span>Query plan</span>
          )}
        </div>
        <div className="results-header__actions">
          <label
            className="switch-row"
            title={
              canAnalyze
                ? 'EXPLAIN ANALYZE actually runs the SELECT to measure time/rows.'
                : 'This connection returns estimated plans only (no ANALYZE).'
            }
          >
            <span className={`switch ${analyze ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                role="switch"
                checked={analyze}
                disabled={!canAnalyze}
                onChange={(event) => onToggleAnalyze(event.target.checked)}
                aria-checked={analyze}
                aria-label="Run EXPLAIN ANALYZE (executes the query)"
              />
              <span className="switch__thumb" />
            </span>
            ANALYZE
          </label>
          <button className="btn btn-primary btn-sm" onClick={onRun} disabled={loading || !connected || !supported}>
            <Gauge size={13} /> Explain
          </button>
        </div>
      </div>

      {!supported ? (
        <div className="results-scroll">
          <div className="empty-state empty-state--compact">
            <div className="empty-state__icon">
              <Gauge size={18} />
            </div>
            <strong>Explain not supported</strong>
            <span>This connection does not expose a query plan.</span>
          </div>
        </div>
      ) : error ? (
        <div className="results-scroll">
          <div className="results-error">
            <div className="results-error__icon">
              <AlertTriangle size={20} />
            </div>
            <strong>Explain failed</strong>
            <pre>{redactForDisplay(error)}</pre>
          </div>
        </div>
      ) : plan ? (
        <div className="results-scroll" style={{ padding: 12 }}>
          {plan.warnings.length > 0 ? (
            <div className="results-limit" role="status" style={{ marginBottom: 10 }}>
              <AlertTriangle size={13} />
              <span>{plan.warnings[0]}</span>
            </div>
          ) : null}
          {plan.roots.map((root) => (
            <PlanTree key={root.id} node={root} depth={0} ceiling={ceiling} />
          ))}
          <div style={{ marginTop: 10, opacity: 0.7, fontSize: 11 }}>
              Local database plan ({plan.dialect}){plan.analyze ? ' with execution stats inside a READ ONLY transaction' : ' (estimated, query not executed)'}. Database grants remain the final boundary.
          </div>
        </div>
      ) : (
        <div className="results-scroll">
          <div className="empty-state empty-state--compact">
            <div className="empty-state__icon">
              <Gauge size={18} />
            </div>
            <strong>No plan yet</strong>
            <span>
              Write a SELECT/WITH query and press Explain. ANALYZE executes the query to
              measure real time and rows.
            </span>
          </div>
        </div>
      )}
    </section>
  )
}
