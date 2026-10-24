import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface AuditEntry {
  id: string
  at: number
  connectionId?: string
  action:
    | 'query'
    | 'explain'
    | 'transaction'
    | 'import'
    | 'session-kill'
    | 'migration'
    | 'ai-data'
    | 'safety-change'
    | 'connect'
    | 'disconnect'
  // Origem da operação: 'editor' | 'selection' | 'ai' para db:query,
  // 'table' para row-update via TableDataView, 'system' para eventos internos.
  source?: string
  sqlClass?: string
  aiMode?: string
  allowWrites?: boolean
  confirmationUsed?: boolean
  // Alias canônico da spec (Corte 0 §4.4). Mantido junto de confirmationUsed
  // por compatibilidade com leitores antigos.
  tokenUsed?: boolean
  schemaFingerprint?: string
  errorCode?: string
  durationMs?: number
  rowCount?: number
  ok: boolean
  error?: string
  detail?: string
}

// Rotação simples por tamanho: mantém append-only no caminho normal e
// trunca para as últimas N linhas apenas quando o arquivo passa do limite.
export const MAX_AUDIT_LINES = 5000
export const ROTATE_SIZE_BYTES = 2_000_000
const READ_TAIL_BYTES = 512 * 1024

function auditPath(): string {
  return path.join(app.getPath('userData'), 'dblion-audit.jsonl')
}

export function toErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  if (lower.includes('canceled') || lower.includes('cancel')) return 'CANCELED'
  if (lower.includes('read-only') || lower.includes('read only')) return 'READ_ONLY_BLOCK'
  if (lower.includes('confirmation') || lower.includes('approve the confirmation')) {
    return 'CONFIRM_REQUIRED'
  }
  if (lower.includes('explain')) return 'EXPLAIN_REJECTED'
  if (lower.includes('not supported')) return 'UNSUPPORTED'
  if (lower.includes('ai mode')) return 'AI_MODE_BLOCK'
  if (lower.includes('not active') || lower.includes('connect first')) return 'NOT_CONNECTED'
  if (lower.includes('requires ai mode')) return 'AI_MODE_BLOCK'
  return 'QUERY_FAILED'
}

async function maybeRotate(file: string): Promise<void> {
  try {
    const stat = await fs.stat(file)
    if (stat.size <= ROTATE_SIZE_BYTES) return
    const content = await fs.readFile(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    if (lines.length <= MAX_AUDIT_LINES) return
    const kept = lines.slice(-MAX_AUDIT_LINES).join('\n') + '\n'
    await fs.writeFile(file, kept, 'utf8')
  } catch {
    // best-effort: nunca quebrar a query por causa de rotação
  }
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  try {
    const file = auditPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
    // Fire-and-forget com await best-effort (não propaga erro).
    await maybeRotate(file)
  } catch (error) {
    console.error('[audit]', error)
  }
}

function parseLines(content: string, limit: number): AuditEntry[] {
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(1, limit))
    .map((line) => {
      try {
        return JSON.parse(line) as AuditEntry
      } catch {
        return null
      }
    })
    .filter((entry): entry is AuditEntry => entry !== null)
    .reverse()
}

export async function readAudit(limit = 200): Promise<AuditEntry[]> {
  try {
    const file = auditPath()
    const stat = await fs.stat(file)
    const safeLimit = Math.max(1, Math.min(limit, MAX_AUDIT_LINES))
    if (stat.size <= READ_TAIL_BYTES) {
      const content = await fs.readFile(file, 'utf8')
      return parseLines(content, safeLimit)
    }
    // Arquivo grande: lê apenas a janela final para não carregar tudo em memória.
    const tailSize = Math.min(stat.size, Math.max(READ_TAIL_BYTES, safeLimit * 1024))
    const start = stat.size - tailSize
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(tailSize)
      await handle.read(buffer, 0, tailSize, start)
      const chunk = buffer.toString('utf8')
      // Descarta a primeira linha (pode estar cortada no meio).
      const firstNewline = chunk.indexOf('\n')
      const usable = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : chunk
      return parseLines(usable, safeLimit)
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}
