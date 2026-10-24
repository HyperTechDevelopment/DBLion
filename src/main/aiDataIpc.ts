import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendAudit } from './audit'
import { approveProfile, approveSample, type DataMode, type DataRequest } from './ai/dataAccess'
import { getRuntime } from './db'

interface ApproveRequest extends DataRequest {
  mode: DataMode
}

/**
 * Data approvals are issued by main only. The renderer chooses a table and a
 * mode; it never supplies SQL or a data payload. Both modes run under the
 * adapter's database-enforced read-only transaction.
 */
export function registerAiDataIpc(): void {
  ipcMain.handle('ai:data-approve', async (_event, request: ApproveRequest) => {
    if (request.mode !== 'profile' && request.mode !== 'rows') {
      throw new Error('Unknown data access mode.')
    }
    if (!Array.isArray(request.tables) || request.tables.some((table) => typeof table !== 'string')) {
      throw new Error('The table list is invalid.')
    }
    const normalized: DataRequest = {
      connectionId: String(request.connectionId ?? ''),
      schema: request.schema ? String(request.schema) : undefined,
      tables: request.tables.map((table) => table.trim()).filter(Boolean)
    }
    const kind = getRuntime(normalized.connectionId).config.kind
    if (!['postgres', 'mysql', 'mssql', 'firebird', 'sqlite'].includes(kind)) {
      throw new Error(`Data sampling is not available for ${kind} connections.`)
    }
    const started = Date.now()
    try {
      const approval =
        request.mode === 'profile'
          ? await approveProfile(normalized)
          : await approveSample(normalized)
      await appendAudit({
        id: randomUUID(),
        at: started,
        connectionId: normalized.connectionId,
        action: 'ai-data',
        source: 'ai',
        ok: true,
        durationMs: Date.now() - started,
        rowCount: approval.rows,
        detail: `${request.mode}; tables=${approval.tables.join(',')}; maskedCells=${approval.maskedCells}`
      })
      return approval
    } catch (error) {
      await appendAudit({
        id: randomUUID(),
        at: started,
        connectionId: normalized.connectionId,
        action: 'ai-data',
        source: 'ai',
        ok: false,
        durationMs: Date.now() - started,
        detail: `${request.mode}; tables=${normalized.tables.join(',')}`,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
}
