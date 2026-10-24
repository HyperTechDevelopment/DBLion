import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatProfileContext, formatSampleContext } from '../src/main/ai/profile.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

check('profile context carries stats and hashed top values, never raw values', () => {
  const text = formatProfileContext([
    {
      table: 'CLIENTE',
      totalRows: 10,
      columns: [
        {
          name: 'EMAIL',
          type: 'VARCHAR',
          nonNull: 9,
          nulls: 1,
          distinct: 9,
          min: '[redacted]',
          max: '[redacted]',
          redacted: true
        },
        {
          name: 'STATUS',
          type: 'INTEGER',
          nonNull: 10,
          nulls: 0,
          distinct: 2,
          min: '1',
          max: '2',
          top: [{ hash: 'abc123', count: 7 }]
        }
      ]
    }
  ])
  assert.match(text, /CLIENTE rows=10/)
  assert.match(text, /abc123:7/)
  assert.doesNotMatch(text, /maria@example\.com/)
  assert.match(text, /EMAIL: VARCHAR nulls=1 distinct=9 min=\[redacted\]/)
})

check('sample context renders only the masked payload it was given', () => {
  const text = formatSampleContext([
    {
      table: 'CLIENTE',
      columns: ['nome', 'cpf'],
      rows: [
        { nome: '[redacted]', cpf: '[redacted]' },
        { nome: 'Ana', cpf: '[redacted]' }
      ],
      maskedCells: 3,
      truncated: true
    }
  ])
  assert.match(text, /masked cells: 3/)
  assert.match(text, /\(truncated/)
  assert.doesNotMatch(text, /\d{3}\.\d{3}\.\d{3}-\d{2}/)
})

check('profile SQL runs read-only and masks PII-named columns', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ai/profile.ts'), 'utf8')
  assert.match(source, /readOnlyTransaction: true/)
  assert.match(source, /PII_COLUMN\.test\(column\)/)
  assert.match(source, /hashValue/)
  assert.match(source, /MAX_SAMPLE_ROWS = 25/)
})

check('approval tokens are single-use, short-lived and connection-bound', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ai/dataAccess.ts'), 'utf8')
  assert.match(source, /TTL_MS = 60_000/)
  assert.match(source, /approvals\.delete\(token\)/)
  assert.match(source, /approval\.connectionId !== connectionId/)
  assert.match(source, /approval\.mode !== mode/)
})

check('data context is an untrusted block and is masked before send', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ai/context.ts'), 'utf8')
  assert.match(source, /untrustedBlock\('data'/)
  assert.match(source, /const dataContext = data \? redactText\(data\) : ''/)
  assert.match(source, /dataIncluded: Boolean\(dataContext\)/)
})

check('chat consumes a single-use token and the preview only peeks', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8')
  assert.match(source, /consumeDataApproval\(/)
  assert.match(source, /peekDataApproval\(/)
  assert.match(source, /registerAiDataIpc\(\)/)
  assert.match(source, /dataContext: dataApproval\?\.context/)
})

check('Firebird sampling uses FIRST, not LIMIT', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ai/profile.ts'), 'utf8')
  assert.match(source, /select first \$\{MAX_SAMPLE_ROWS\}/)
  assert.doesNotMatch(source, /buildTablePageSql\(kind, details[\s\S]{0,200}firebird/)
})

if (failed > 0) {
  console.log(`\n${failed} ai-data check(s) failed`)
  process.exit(1)
}
console.log(`\n${passed}/${passed} ai-data checks passed`)
