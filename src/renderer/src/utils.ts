export { isWriteSql } from '@shared/sql'

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export interface SqlBlock {
  type: 'text' | 'sql'
  content: string
}

export function splitSqlBlocks(content: string): SqlBlock[] {
  const blocks: SqlBlock[] = []
  const regex = /```(?:sql)?\s*\n?([\s\S]*?)```/gi
  let cursor = 0
  for (const match of content.matchAll(regex)) {
    const index = match.index ?? 0
    if (index > cursor) blocks.push({ type: 'text', content: content.slice(cursor, index) })
    blocks.push({ type: 'sql', content: match[1].trim() })
    cursor = index + match[0].length
  }
  if (cursor < content.length) blocks.push({ type: 'text', content: content.slice(cursor) })
  return blocks.filter((block) => block.content.length > 0)
}

export function shortError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
