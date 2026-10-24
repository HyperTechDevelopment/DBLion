import { useEffect, useState } from 'react'
import { Trash2, Unplug } from 'lucide-react'

export type ConfirmKind = 'disconnect' | 'delete'

interface Props {
  open: boolean
  kind: ConfirmKind
  connectionName: string
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}

/**
 * Themed confirmation for removing access to a database. Delete is always a
 * danger action; disconnect can remember the answer, but only after the user
 * confirms once.
 */
export default function ConfirmDialog({
  open,
  kind,
  connectionName,
  onCancel,
  onConfirm
}: Props) {
  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => {
    if (open) setDontAskAgain(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const isDelete = kind === 'delete'
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        className="modal modal--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-detail"
      >
        <div className="modal-header">
          <div className={`modal-icon ${isDelete ? 'modal-icon--danger' : ''}`}>
            {isDelete ? <Trash2 size={16} /> : <Unplug size={16} />}
          </div>
          <div>
            <div className="modal-title" id="confirm-title">
              {isDelete ? 'Delete this connection?' : 'Disconnect from the database?'}
            </div>
            <div className="modal-subtitle">{connectionName}</div>
          </div>
        </div>
        <div className="modal-body" id="confirm-detail">
          <p>
            {isDelete
              ? 'The saved configuration, credentials and SSH settings will be removed. The database itself is not touched.'
              : 'Open sessions on this connection will be closed. Saved configuration and credentials are kept.'}
          </p>
          {!isDelete ? (
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(event) => setDontAskAgain(event.target.checked)}
              />
              <span>Don't ask again for disconnects</span>
            </label>
          ) : null}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button
            className={`btn ${isDelete ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onConfirm(dontAskAgain)}
          >
            {isDelete ? 'Delete connection' : 'Disconnect'}
          </button>
        </div>
      </div>
    </div>
  )
}
