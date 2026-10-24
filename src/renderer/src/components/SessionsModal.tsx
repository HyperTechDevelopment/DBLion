import { useEffect, useState } from 'react'
import { RefreshCw, Skull, TimerOff, X } from 'lucide-react'
import type { SessionInfo, SessionKillMode } from '@shared/types'
import { shortError } from '../utils'

interface Props {
  connectionId: string
  connectionName: string
  canKill: boolean
  onClose: () => void
  onToast: (message: string, error?: boolean) => void
}

function duration(value?: number): string {
  if (value === undefined) return '—'
  const seconds = Math.max(0, Math.round(value / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export default function SessionsModal({
  connectionId,
  connectionName,
  canKill,
  onClose,
  onToast
}: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setSessions(await window.dblion.listSessions(connectionId))
    } catch (cause) {
      setError(shortError(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function kill(session: SessionInfo, mode: SessionKillMode): Promise<void> {
    setBusyId(session.id)
    try {
      const request = { connectionId, sessionId: session.id, mode }
      const preview = await window.dblion.previewKillSession(request)
      const token = await window.dblion.requestConfirmation({
        kind: 'session-kill',
        title: mode === 'cancel' ? 'Cancel the running query?' : 'Terminate the session?',
        detail: preview.detail
      })
      await window.dblion.killSession(request, token)
      onToast(mode === 'cancel' ? 'Query cancellation requested.' : 'Session terminated.')
      await load()
    } catch (cause) {
      onToast(shortError(cause), true)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal modal--sessions"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessions-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-icon">
            <TimerOff size={18} />
          </div>
          <div>
            <h2 className="modal-title" id="sessions-title">
              Sessions
            </h2>
            <div className="modal-subtitle">{connectionName}</div>
          </div>
          <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close sessions">
            <X size={15} />
          </button>
        </div>

        <div className="sessions-body">
          {error ? <div className="results-error">{error}</div> : null}
          {!error && loading && sessions.length === 0 ? (
            <div className="sessions-empty">Loading sessions…</div>
          ) : null}
          {!error && !loading && sessions.length === 0 ? (
            <div className="sessions-empty">No sessions returned by the server.</div>
          ) : null}
          {!canKill ? (
            <div className="sessions-empty">
              Session termination is disabled for this connection. Killer actions need a
              read-write profile plus AI mode “full”.
            </div>
          ) : null}
          {sessions.length > 0 ? (
            <div className="sessions-table-wrap">
              <table className="data-grid sessions-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>User</th>
                    <th>Database</th>
                    <th>State</th>
                    <th>Duration</th>
                    <th>Query</th>
                    {canKill ? <th>Action</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td>{session.id}</td>
                      <td>{session.user ?? '—'}</td>
                      <td>{session.database ?? '—'}</td>
                      <td>{session.state ?? session.command ?? '—'}</td>
                      <td>{duration(session.durationMs)}</td>
                      <td className="sessions-table__query" title={session.query}>
                        {session.query ?? '—'}
                      </td>
                      {canKill ? (
                        <td>
                          <div className="sessions-actions">
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busyId === session.id}
                              onClick={() => void kill(session, 'cancel')}
                              title="Cancel the current query, keep the session"
                            >
                              Cancel query
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={busyId === session.id}
                              onClick={() => void kill(session, 'terminate')}
                              title="Terminate this session"
                            >
                              <Skull size={12} /> Kill
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
