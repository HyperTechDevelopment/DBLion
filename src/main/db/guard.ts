import { classifyRedis, classifySql, stripSqlComments } from '@shared/sql'
import { isReadOnlyAccess, readOnlyEnforcement } from '@shared/access'
import type { ConnectionConfig, DbKind } from '@shared/types'

/**
 * Read-only enforcement for a live connection.
 *
 * This module is the single place that decides, from a `ConnectionConfig`,
 * whether a statement or a write-only action may proceed. It is called by the
 * runtime orchestration in `./index.ts` (before any adapter runs) and by
 * `../security.ts`, so a compromised renderer still hits it after the IPC
 * layer. Adapters carry their own guard as a third layer (`ensureWritable`).
 *
 * It has no Electron import on purpose: the automated test in
 * `scripts/read-only-enforcement.test.mjs` imports this file directly.
 */

function statementClass(kind: DbKind, sql: string): string {
  return kind === 'redis' ? classifyRedis(sql) : classifySql(sql)
}

/**
 * Statement text with identifier and string quoting removed.
 *
 * SQLite accepts every spelling of a pragma name — double quotes, single
 * quotes, brackets, backticks, and the schema-qualified `main.query_only` —
 * and each of them really does turn the guard off (verified against sql.js in
 * `scripts/read-only-enforcement.test.mjs`). Collapsing the quoting makes one
 * pattern cover all of them.
 */
function unquotedStatement(sql: string): string {
  return stripSqlComments(sql)
    .replace(/["'`[\]]/g, '')
    .replace(/\s*\.\s*/g, '.')
}

/**
 * Statements that look like reads to the classifier but would switch off the
 * database-level read-only guard, for example `PRAGMA query_only = OFF`.
 * They are refused on a read-only connection so the session guard cannot be
 * weakened from the SQL editor.
 */
export function isReadOnlyGuardBypass(sql: string): boolean {
  const text = stripSqlComments(sql)
  if (!text) return false
  const plain = unquotedStatement(sql)
  // Anchored to the statement start: PRAGMA is a statement keyword, so a
  // SELECT that merely mentions it in a literal is still a read.
  const pragmaQueryOnly = /(?:^|;)\s*pragma\s+(?:[a-z_]\w*\.)?query_only\b/i
  if (
    pragmaQueryOnly.test(plain) &&
    !/(?:^|;)\s*pragma\s+(?:[a-z_]\w*\.)?query_only\s*=\s*(?:on|1|true)\b/i.test(plain)
  ) {
    return true
  }
  // `SELECT set_config('default_transaction_read_only', 'off', false)` is
  // classified as a read, yet it flips the same session default that the
  // PostgreSQL startup option sets. Only the second argument matters: the third
  // one is `is_local` and is normally `false` even when the value is `'on'`.
  if (
    /\bset_config\s*\(\s*(?:default_transaction_read_only|transaction_read_only|tx_read_only)\s*,\s*(?:off|false|0)\b/i.test(
      plain
    )
  ) {
    return true
  }
  if (
    /\bset\s+(?:session\s+|local\s+)?(?:default_transaction_read_only|transaction_read_only|tx_read_only)\b/i.test(
      text
    ) &&
    /\b(?:off|false|0)\b/i.test(text)
  ) {
    return true
  }
  if (/\bset\s+(?:session\s+|local\s+)?transaction\s+read\s+write\b/i.test(text)) return true
  if (/\b(?:start|begin)\s+(?:transaction\s+)?read\s+write\b/i.test(text)) return true
  return false
}

/**
 * Returns the rejection message when `sql` is not a plain read statement, or
 * `null` when it may proceed. Engine-aware for Redis commands.
 */
export function readOnlyWriteViolation(kind: DbKind, sql: string): string | null {
  if (isReadOnlyGuardBypass(sql)) {
    return (
      `This connection is read-only (${readOnlyEnforcement(kind)} enforcement): ` +
      'the statement would disable the read-only session guard and was blocked.'
    )
  }
  const sqlClass = statementClass(kind, sql)
  if (sqlClass === 'read') return null
  return (
    `This connection is read-only (${readOnlyEnforcement(kind)} enforcement): ` +
    `the statement was classified as ${sqlClass.toUpperCase()} and was blocked before reaching the database.`
  )
}

/**
 * Returns the rejection message when `sql` is not a read statement on a
 * read-only connection, or `null` when the statement may proceed.
 */
export function readOnlySqlViolation(config: ConnectionConfig, sql: string): string | null {
  if (!isReadOnlyAccess(config)) return null
  const violation = readOnlyWriteViolation(config.kind, sql)
  if (!violation) return null
  return (
    `Connection “${config.name}” is read-only. ${violation} ` +
    'Use a read-write connection with a maintenance credential to change data.'
  )
}

/** Throws when a read-only connection would run a non-read statement. */
export function assertQueryAllowed(config: ConnectionConfig, sql: string): void {
  const violation = readOnlySqlViolation(config, sql)
  if (violation) throw new Error(violation)
}

/**
 * Throws for actions that are writes by construction (row update, CSV import,
 * session kill). They never carry a statement to classify.
 */
export function assertWritePathAllowed(config: ConnectionConfig, action: string): void {
  if (!isReadOnlyAccess(config)) return
  throw new Error(
    `Connection “${config.name}” is read-only. ${action} is blocked; ` +
      'connect a read-write profile with its own credential to perform maintenance.'
  )
}

/** True when the connection may execute writes (used to gate UI capabilities). */
export function isWritableConnection(config: ConnectionConfig | null | undefined): boolean {
  return Boolean(config) && !isReadOnlyAccess(config)
}
