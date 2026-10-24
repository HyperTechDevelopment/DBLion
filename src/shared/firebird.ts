/**
 * Firebird connection helpers.
 *
 * Jaybird accepts `encoding=ISO8859` and maps it to the server character set
 * `ISO8859_1`. The Node driver sends `options.encoding` verbatim as
 * `isc_dpb_lc_ctype`, so aliases must be resolved before connecting.
 */

export const FIREBIRD_ENCODINGS: { id: string; label: string }[] = [
  { id: 'UTF8', label: 'UTF8 (recommended)' },
  { id: 'ISO8859_1', label: 'ISO8859_1 (Latin-1)' },
  { id: 'WIN1252', label: 'WIN1252 (Windows Latin-1)' },
  { id: 'WIN1251', label: 'WIN1251 (Cyrillic)' },
  { id: 'ASCII', label: 'ASCII' },
  { id: 'NONE', label: 'NONE (raw bytes)' }
]

const ENCODING_ALIASES: Record<string, string> = {
  UTF8: 'UTF8',
  UNICODEFSS: 'UTF8',
  ISO8859: 'ISO8859_1',
  ISO88591: 'ISO8859_1',
  LATIN1: 'ISO8859_1',
  LATIN: 'ISO8859_1',
  WIN1252: 'WIN1252',
  CP1252: 'WIN1252',
  WINDOWS1252: 'WIN1252',
  WIN1251: 'WIN1251',
  CP1251: 'WIN1251',
  WINDOWS1251: 'WIN1251',
  ASCII: 'ASCII',
  USASCII: 'ASCII',
  NONE: 'NONE'
}

/** Resolves Jaybird/Java charset aliases to a Firebird `lc_ctype` name. */
export function normalizeFirebirdEncoding(value?: string): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const key = raw.toUpperCase().replace(/[\s_-]/g, '')
  const alias = ENCODING_ALIASES[key]
  if (alias) return alias
  return /^[A-Z0-9_]+$/.test(raw.toUpperCase()) ? raw.toUpperCase() : undefined
}

export interface FirebirdUrlParts {
  host: string
  port: number
  database: string
  encoding?: string
}

/**
 * Parses `jdbc:firebirdsql://host:port/database?encoding=ISO8859` (and the
 * shorter `firebird://` form). Credentials in the authority are ignored.
 */
export function parseFirebirdUrl(input: string): FirebirdUrlParts | null {
  const match =
    /^(?:jdbc:)?firebirdsql:\/\/(.+)$/i.exec(input.trim()) ??
    /^firebird:\/\/(.+)$/i.exec(input.trim())
  if (!match) return null

  const rest = match[1]
  const queryStart = rest.indexOf('?')
  const target = queryStart >= 0 ? rest.slice(0, queryStart) : rest
  const query = queryStart >= 0 ? rest.slice(queryStart + 1) : ''
  const slash = target.indexOf('/')
  if (slash < 0) return null

  const authority = target.slice(0, slash)
  const database = decodeURIComponent(target.slice(slash + 1))
  if (!database) return null

  const at = authority.lastIndexOf('@')
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority
  const portMatch = /^(.*):(\d+)$/.exec(hostPort)
  const host = (portMatch ? portMatch[1] : hostPort) || 'localhost'
  const port = portMatch ? Number(portMatch[2]) : 3050

  let encoding: string | undefined
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=', 2)
    const key = decodeURIComponent(rawKey).toLowerCase()
    if (key === 'encoding' || key === 'charset') {
      encoding = normalizeFirebirdEncoding(decodeURIComponent(rawValue))
      break
    }
  }

  return { host, port, database, encoding }
}

/** Renders the same URL shape Jaybird uses, without credentials. */
export function buildFirebirdUrl(config: {
  host?: string
  port?: number
  database?: string
  encoding?: string
}): string {
  const host = config.host || 'localhost'
  const port = config.port ?? 3050
  const database = config.database || ''
  const encoding = normalizeFirebirdEncoding(config.encoding)
  return `jdbc:firebirdsql://${host}:${port}/${database}${encoding ? `?encoding=${encoding}` : ''}`
}
