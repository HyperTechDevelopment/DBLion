const PII_KEY =
  /(e-?mail|cpf|cnpj|phone|telefone|celular|address|endereco|card|cartao|token|secret|password|senha|ssn|passport)/i

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[redacted-cpf]'],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[redacted-cnpj]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[redacted-card]'],
  [/\b\(?\d{2}\)?[\s-]?\d{4,5}[-.\s]?\d{4}\b/g, '[redacted-phone]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]'],
  [/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [redacted]'],
  [
    /((?:password|passwd|pwd|secret|token|api[_-]?key|senha)\s*[:=]\s*['"]?)[^'"\s;,]+/gi,
    '$1[redacted]'
  ]
]

export function redactText(value: string): string {
  return VALUE_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  )
}

export function redactJson(value: unknown, key = ''): unknown {
  if (PII_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactJson(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactJson(entryValue, entryKey)
      ])
    )
  }
  return value
}
