export type SqlClass = 'read' | 'dml' | 'ddl' | 'other'

const READ_PREFIXES = [
  'select',
  'with',
  'show',
  'explain',
  'describe',
  'desc',
  'pragma',
  'values',
  'table'
]

const DDL_PATTERN =
  /\b(create|alter|drop|truncate|grant|revoke|comment|rename|reindex|vacuum|attach|detach)\b/i
const DML_PATTERN = /\b(insert|update|delete|merge|replace|upsert)\b/i
export const WRITE_KEYWORDS = new RegExp(`${DDL_PATTERN.source}|${DML_PATTERN.source}`, 'i')
export const SELECT_INTO_PATTERN = /\binto\b/i
export const ROW_LOCK_PATTERN = /\b(for\s+update|for\s+share|lock\s+in\s+share\s+mode)\b/i

// Corte 2 — deny-list de chamadas que derrubam/cancelam sessões mas são
// classificadas como `read` por começarem com SELECT (ex. verificado:
// `SELECT pg_terminate_backend(12345)`). O padrão exige `(` após o nome para
// não bloquear colunas legítimas como `killer` ou `cancelled_at`.
const FORBIDDEN_CALL_PATTERN =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|cancel_backend|cancel_query|terminate|kill|cancel)\s*\(/i

// SELECT can still mutate or block through functions. These are not a full
// parser, but they close the dangerous half of the gap until a dialect parser
// is available. Database grants remain the authoritative boundary.
const DANGEROUS_CALL_PATTERN =
  /\b(pg_sleep|pg_sleep_for|pg_sleep_until|nextval|setval|lo_import|lo_export|pg_read_file|pg_write_file|pg_ls_dir|dblink|dblink_exec|pg_stat_reset|pg_switch_wal|pg_create_restore_point|sleep|benchmark|get_lock|release_lock|load_file|sys_exec|sys_eval|load_extension|writefile|readfile)\s*\(/i

export function containsForbiddenCall(sql: string): boolean {
  const noComments = stripSqlComments(sql)
  const structural = stripStringLiterals(noComments)
  return FORBIDDEN_CALL_PATTERN.test(structural) || DANGEROUS_CALL_PATTERN.test(structural)
}

export function containsDangerousCall(sql: string): boolean {
  const noComments = stripSqlComments(sql)
  const structural = stripStringLiterals(noComments)
  return DANGEROUS_CALL_PATTERN.test(structural)
}

export function containsWriteKeywords(sql: string): boolean {
  return WRITE_KEYWORDS.test(stripStringLiterals(stripSqlComments(sql)))
}

export function containsSelectInto(sql: string): boolean {
  return SELECT_INTO_PATTERN.test(stripStringLiterals(stripSqlComments(sql)))
}

export function containsRowLock(sql: string): boolean {
  return ROW_LOCK_PATTERN.test(stripStringLiterals(stripSqlComments(sql)))
}

/**
 * Gate do Explain: só SELECT/WITH puros. Retorna o motivo do bloqueio ou null.
 * Testes mentais:
 * - `SELECT pg_terminate_backend(1)` → bloqueado (forbidden call)
 * - `SELECT 'kill('` → permitido (literal, sem call real)
 * - `-- kill()\nSELECT 1` → permitido (comentário ignorado)
 * - `SELECT killer FROM t` → permitido (sem parêntese, não casa)
 * - `SELECT * FROM t FOR UPDATE` → bloqueado (row lock)
 * - `SELECT * INTO t2 FROM t` → bloqueado (select into)
 * - `KILL QUERY 1` → bloqueado (não é select/with)
 */
export function getExplainBlockReason(sql: string): string | null {
  const cleaned = stripSqlComments(sql).trim()
  if (!cleaned) return 'Empty query.'
  if (splitStatements(cleaned).length !== 1) {
    return 'Explain accepts a single SELECT/WITH statement.'
  }
  const first = cleaned.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (first !== 'select' && first !== 'with') {
    return 'Explain only supports SELECT/WITH queries.'
  }
  if (containsForbiddenCall(sql)) {
    return 'Session-control or side-effect functions are blocked in Explain.'
  }
  if (containsSelectInto(sql)) {
    return 'SELECT INTO is not allowed in Explain.'
  }
  if (containsRowLock(sql)) {
    return 'Row locks (FOR UPDATE/SHARE) are not allowed in Explain.'
  }
  if (containsWriteKeywords(sql)) {
    return 'Write keywords are not allowed in Explain.'
  }
  return null
}

/**
 * Session-kill deny-list (Corte 2 parte 3).
 * Kill NUNCA via db:query — só via IPC dedicado `db:kill-session`.
 * Cobre:
 * - Postgres: pg_terminate_backend(...), pg_cancel_backend(...)
 * - MySQL/MSSQL: KILL <id>, KILL QUERY|CONNECTION <id>, KILL '<id>'
 * - Redis: CLIENT KILL (via db:query também bloqueado; sem kill dedicado)
 * Testado contra a forma sem strings (structural) para não bloquear
 * literais como SELECT 'KILL 123' ou SELECT 'pg_terminate_backend(1)'.
 */
export function isSessionKillSql(sql: string): boolean {
  const cleaned = stripSqlComments(sql)
  if (!cleaned) return false
  const structural = stripStringLiterals(cleaned)
  if (/pg_(terminate|cancel)_backend\s*\(/i.test(structural)) return true
  if (/\bkill\s+(query\s+|connection\s+)?\d+/i.test(structural)) return true
  // KILL '<id>' (T-SQL permite spid entre aspas): fora das strings sobra
  // apenas `KILL`, então checa o KILL estrutural + aspas no texto original.
  if (/\bkill\b/i.test(structural) && /\bkill\s+['"]/i.test(cleaned)) return true
  if (/\bclient\s+kill\b/i.test(structural)) return true
  return false
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
}

function stripStringLiterals(sql: string): string {
  let output = ''
  let quote: string | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) {
        if (sql[index + 1] === quote) {
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      output += ' '
      continue
    }
    output += char
  }
  return output
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) {
      current += char
      if (char === '\\') {
        index += 1
        current += sql[index] ?? ''
        continue
      }
      if (char === quote) {
        if (sql[index + 1] === quote) {
          index += 1
          current += sql[index] ?? ''
          continue
        }
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

export function classifySql(sql: string): SqlClass {
  const cleaned = stripSqlComments(sql)
  if (!cleaned) return 'read'
  // Sessões: kill nunca é leitura e nunca passa como token genérico.
  // authorizeSql/common.ensureWritable recusam com rota dedicada.
  if (isSessionKillSql(sql)) return 'ddl'
  const statements = splitStatements(cleaned)
  if (statements.length === 0) return 'read'

  let sawDml = false
  for (const statement of statements) {
    const first = statement.split(/\s+/)[0]?.toLowerCase() ?? ''
    const structural = stripStringLiterals(statement)
    // Sessões e funções com efeito colateral: `SELECT pg_terminate_backend()`
    // parece leitura mas derruba conexões; `nextval`, `setval`, sleeps e
    // equivalentes também não são leituras seguras. Nunca default para `read`.
    if (FORBIDDEN_CALL_PATTERN.test(structural) || DANGEROUS_CALL_PATTERN.test(structural)) {
      return 'other'
    }
    if (['show', 'describe', 'desc', 'pragma', 'values', 'table'].includes(first)) continue
    if (DDL_PATTERN.test(structural)) return 'ddl'
    if (DML_PATTERN.test(structural)) sawDml = true
    if (!READ_PREFIXES.includes(first)) {
      if (DDL_PATTERN.test(structural) || DML_PATTERN.test(structural)) continue
      return 'other'
    }
    if (['select', 'with'].includes(first)) {
      // SELECT ... INTO creates a table/file; treat it as DDL, never as a read.
      if (SELECT_INTO_PATTERN.test(structural)) return 'ddl'
      // Row locks are writes for authorization purposes even though they return rows.
      if (ROW_LOCK_PATTERN.test(structural)) sawDml = true
    }
    if (['select', 'with', 'explain'].includes(first) && WRITE_KEYWORDS.test(structural)) {
      sawDml = true
    }
  }
  return sawDml ? 'dml' : 'read'
}

export function isWriteSql(sql: string): boolean {
  return classifySql(sql) !== 'read'
}

const REDIS_READ = new Set([
  'GET',
  'MGET',
  'EXISTS',
  'KEYS',
  'SCAN',
  'TTL',
  'PTTL',
  'TYPE',
  'STRLEN',
  'HGET',
  'HGETALL',
  'HMGET',
  'HKEYS',
  'HVALS',
  'HLEN',
  'LRANGE',
  'LLEN',
  'SMEMBERS',
  'SCARD',
  'ZRANGE',
  'ZCARD',
  'INFO',
  'DBSIZE',
  'PING',
  'ECHO',
  'TIME',
  'COMMAND',
  'SELECT'
])

const REDIS_DESTRUCTIVE = new Set([
  'FLUSHALL',
  'FLUSHDB',
  'SHUTDOWN',
  'CONFIG',
  'DEBUG',
  'SCRIPT',
  'EVAL',
  'EVALSHA',
  'EVAL_RO',
  'FCALL',
  'FCALL_RO',
  'FUNCTION',
  'MODULE',
  'ACL',
  'MIGRATE',
  'RESTORE',
  'REPLICAOF',
  'SLAVEOF',
  'CLUSTER',
  'FAILOVER',
  'CLIENT',
  'DEL',
  'UNLINK',
  'HDEL',
  'LPOP',
  'RPOP',
  'SREM',
  'ZREM',
  'RENAME',
  'MOVE',
  'EXPIRE',
  'PERSIST'
])

export function classifyRedis(sql: string): 'read' | 'write' | 'destructive' {
  const command = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  if (REDIS_READ.has(command)) return 'read'
  if (REDIS_DESTRUCTIVE.has(command)) return 'destructive'
  return 'write'
}
