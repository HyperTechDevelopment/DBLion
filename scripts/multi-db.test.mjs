import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilitiesFor } from '../src/main/db/index.ts'

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

const SQL_ENGINES = ['postgres', 'mysql', 'mssql', 'firebird', 'sqlite']

check('every SQL engine advertises catalog, DDL, diff, migrations and explain', () => {
  for (const kind of SQL_ENGINES) {
    const caps = capabilitiesFor(kind)
    assert.equal(caps.tableBrowser, true, `${kind} tableBrowser`)
    assert.equal(caps.explain, true, `${kind} explain`)
    assert.equal(caps.schemaCatalog, true, `${kind} schemaCatalog`)
    assert.equal(caps.ddl, true, `${kind} ddl`)
    assert.equal(caps.diff, true, `${kind} diff`)
    assert.equal(caps.migrations, true, `${kind} migrations`)
  }
})

check('no engine advertises EXPLAIN ANALYZE where it would execute or is unsupported', () => {
  assert.equal(capabilitiesFor('mssql').explainAnalyze, false)
  assert.equal(capabilitiesFor('sqlite').explainAnalyze, false)
  assert.equal(capabilitiesFor('firebird').explainAnalyze, false)
})

check('Firebird keeps only the write paths it can enforce', () => {
  const caps = capabilitiesFor('firebird')
  assert.equal(caps.editRows, false)
  assert.equal(caps.importCsv, false)
  assert.equal(caps.transactions, false)
  assert.equal(caps.sessions, false)
})

check('MongoDB and Redis do not pretend to be SQL catalogs', () => {
  for (const kind of ['mongodb', 'redis']) {
    const caps = capabilitiesFor(kind)
    assert.equal(caps.schemaCatalog, false)
    assert.equal(caps.ddl, false)
    assert.equal(caps.explain, false)
  }
})

check('SQL Server pins a connection for SHOWPLAN and always resets it', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/db/mssql.ts'), 'utf8')
  assert.match(source, /new mssql\.Transaction/)
  assert.match(source, /SET SHOWPLAN_TEXT ON/)
  assert.match(source, /SET SHOWPLAN_TEXT OFF/)
  assert.match(source, /await transaction\.rollback\(\)/)
})

check('Firebird serializes the attachment, exposes catalog and a column index', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/db/firebird.ts'), 'utf8')
  assert.match(source, /new SerialQueue\(\)/)
  assert.match(source, /loadFirebirdCatalog/)
  assert.match(source, /loadFirebirdDdl/)
  assert.match(source, /async columnsIndex\(\)/)
  assert.match(source, /select first 20000/)
})

check('Firebird paging uses FIRST/SKIP and the SQL engines keep their own dialect', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/db/sqlBuilder.ts'), 'utf8')
  assert.match(source, /SELECT FIRST \$\{limit\} SKIP \$\{offset\}/)
  assert.match(source, /OFFSET \$\{offset\} ROWS FETCH NEXT \$\{limit\}/)
  assert.match(source, /LIMIT \$\{limit\} OFFSET \$\{offset\}/)
})

check('the schema index is memory-only with a TTL and bounded LRU', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/ai/schemaIndex.ts'), 'utf8')
  assert.match(source, /10 \* 60_000/)
  assert.match(source, /MAX_CONNECTIONS|LRU|8/)
  assert.doesNotMatch(source, /from 'node:fs'|from 'electron'/)
})

if (failed > 0) {
  console.log(`\n${failed} multi-db check(s) failed`)
  process.exit(1)
}
console.log(`\n${passed}/${passed} multi-db checks passed`)
