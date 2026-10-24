import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildFirebirdUrl,
  normalizeFirebirdEncoding,
  parseFirebirdUrl
} from '../src/shared/firebird.ts'

import { buildTablePageSql } from '../src/main/db/sqlBuilder.ts'
const { normalizePlan } = await import('../src/main/db/explain.ts')
const { FirebirdAdapter } = await import('../src/main/db/firebird.ts')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

check('parses the Jaybird URL shape', () => {
  assert.deepEqual(parseFirebirdUrl('jdbc:firebirdsql://dbhost:3050/sample?encoding=ISO8859'), {
    host: 'dbhost',
    port: 3050,
    database: 'sample',
    encoding: 'ISO8859_1'
  })
})

check('defaults the port to 3050', () => {
  assert.deepEqual(parseFirebirdUrl('jdbc:firebirdsql://dbhost/sample'), {
    host: 'dbhost',
    port: 3050,
    database: 'sample',
    encoding: undefined
  })
})

check('ignores credentials in the authority', () => {
  const parts = parseFirebirdUrl('jdbc:firebirdsql://SYSDBA:masterkey@dbhost:3051/sample?charSet=WIN1252')
  assert.equal(parts?.host, 'dbhost')
  assert.equal(parts?.port, 3051)
  assert.equal(parts?.encoding, 'WIN1252')
})

check('keeps a Windows style database path', () => {
  const parts = parseFirebirdUrl('jdbc:firebirdsql://dbhost:3050/C:/data/sample.fdb?encoding=ISO8859')
  assert.equal(parts?.database, 'C:/data/sample.fdb')
  assert.equal(parts?.encoding, 'ISO8859_1')
})

check('accepts the short firebird scheme', () => {
  assert.equal(parseFirebirdUrl('firebird://dbhost:3050/sample')?.database, 'sample')
})

check('rejects input that is not a Firebird URL', () => {
  assert.equal(parseFirebirdUrl('postgres://dbhost/sample'), null)
  assert.equal(parseFirebirdUrl('jdbc:firebirdsql://dbhost:3050'), null)
  assert.equal(parseFirebirdUrl(''), null)
})

check('normalizes Jaybird charset aliases to Firebird names', () => {
  assert.equal(normalizeFirebirdEncoding('ISO8859'), 'ISO8859_1')
  assert.equal(normalizeFirebirdEncoding('ISO-8859-1'), 'ISO8859_1')
  assert.equal(normalizeFirebirdEncoding('latin1'), 'ISO8859_1')
  assert.equal(normalizeFirebirdEncoding('utf-8'), 'UTF8')
  assert.equal(normalizeFirebirdEncoding('cp1252'), 'WIN1252')
  assert.equal(normalizeFirebirdEncoding(undefined), undefined)
})

check('builds a URL that parses back to the same values', () => {
  const url = buildFirebirdUrl({ host: 'dbhost', port: 3050, database: 'sample', encoding: 'ISO8859_1' })
  assert.equal(url, 'jdbc:firebirdsql://dbhost:3050/sample?encoding=ISO8859_1')
  assert.deepEqual(parseFirebirdUrl(url), {
    host: 'dbhost',
    port: 3050,
    database: 'sample',
    encoding: 'ISO8859_1'
  })
})

check('the adapter passes the charset to the driver', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(adapter, /encoding: normalizeFirebirdEncoding\(config\.encoding\)/)
})

check('the connection wizard exposes the URL and encoding fields', () => {
  const modal = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'src', 'components', 'ConnectionModal.tsx'),
    'utf8'
  )
  assert.match(modal, /connection-jdbc/)
  assert.match(modal, /applyFirebirdUrl/)
  assert.match(modal, /connection-encoding/)
  assert.match(modal, /FIREBIRD_ENCODINGS/)
})

check('foreign keys join the referenced constraint by name', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(adapter, /refc\.rdb\$constraint_name = rc\.rdb\$constraint_name/)
  assert.match(adapter, /ref_rc\.rdb\$constraint_name = refc\.rdb\$const_name_uq/)
})

check('one unreadable table does not erase the schema context', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(adapter, /parts\.push\(table\.name\)/)
})

check('normalizes a Firebird text plan', () => {
  const result = normalizePlan(
    'firebird',
    {
      rows: [
        {
          plan: 'PLAN (COLABORADOR NATURAL)\nPLAN (PESSOA INDEX (PK_PESSOA))'
        }
      ]
    },
    false
  )
  assert.equal(result.dialect, 'firebird')
  assert.equal(result.roots.length, 2)
  assert.match(result.roots[0].operation, /COLABORADOR/)
  assert.equal(result.roots[1].index, 'PK_PESSOA')
})

check('the adapter reads table and column comments', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(adapter, /cast\(r\.rdb\$description as varchar\(4000\)\) as comment/)
  assert.match(adapter, /cast\(rf\.rdb\$description as varchar\(4000\)\) as comment/)
  assert.match(adapter, /comment: row\.comment \? String\(row\.comment\)\.trim\(\) : undefined/)
})

check('the adapter wires timeout, cancel and plan paths', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(adapter, /withTimeout\(options/)
  assert.match(adapter, /async cancel\(\)/)
  assert.match(adapter, /async explain\(sql/)
  assert.match(adapter, /serverMajor >= 6/)
  assert.match(adapter, /isc_info_sql_get_plan/)

  const index = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'index.ts'), 'utf8')
  assert.match(
    index,
    /case 'firebird':[\s\S]{0,800}cancelQuery: true,[\s\S]{0,300}explain: true,[\s\S]{0,300}schemaCatalog: true,[\s\S]{0,300}ddl: true/
  )
})

check('Firebird paging uses FIRST/SKIP instead of LIMIT/OFFSET', () => {
  const { sql } = buildTablePageSql(
    'firebird',
    {
      table: 'CLIENTE',
      columns: [{ name: 'ID', type: 'INTEGER', nullable: false }],
      primaryKey: ['ID'],
      foreignKeys: []
    },
    { connectionId: 'x', table: 'CLIENTE', limit: 25, offset: 50 }
  )
  assert.match(sql, /FIRST 25 SKIP 50/)
  assert.doesNotMatch(sql, /LIMIT|OFFSET/)
})

check('the adapter exposes catalog, DDL and a one-query column index', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(adapter, /async catalog\(schema\?: string\)/)
  assert.match(adapter, /async ddl\(object: SchemaObjectRef\)/)
  assert.match(adapter, /async columnsIndex\(\)/)
  assert.match(adapter, /rdb\$relation_fields f/)
  assert.match(adapter, /loadFirebirdCatalog/)
  assert.match(adapter, /loadFirebirdDdl/)
})

// ---------------------------------------------------------------------------
// One attachment, one statement at a time.
//
// The checks below drive the real adapter against a fake attachment that
// records how many statements are on the wire at once, which statement an
// op_cancel landed on, and whether the driver's plan flag was set. No Firebird
// server is involved: the fake stands in for node-firebird's Database.
// ---------------------------------------------------------------------------

const FIREBIRD_CANCELLED = Object.assign(new Error('operation was cancelled'), {
  gdscode: 335544794
})

/**
 * Minimal stand-in for one attached Firebird database.
 *
 * `params[0]` chooses the timing: `fast` answers in 1 ms, `slow` in 15 ms,
 * `hang` only answers when something cancels it — like a statement the server
 * is still working on. `prepare` selects the plan API: `normal`, `hang`, or
 * `none` for a driver that does not expose it.
 */
function fakeAttachment({ prepare = 'normal' } = {}) {
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    current: null,
    completed: [],
    cancels: 0,
    cancelTargets: [],
    transactions: 0,
    rollbacks: 0,
    preparedWithPlan: null
  }
  const pending = new Set()

  const enter = (label) => {
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    state.current = label
    return () => {
      state.inFlight -= 1
      if (state.inFlight === 0) state.current = null
    }
  }

  /** What the driver does when it sends op_cancel: the operation in flight fails. */
  const cancelNow = () => {
    state.cancels += 1
    state.cancelTargets.push(state.current)
    for (const fail of [...pending]) fail()
  }

  const startOperation = (sql, params, callback, options) => {
    const mode = String(params?.[0] ?? 'fast')
    const leave = enter(sql)
    let open = true
    const settle = (error, value) => {
      if (!open) return
      open = false
      pending.delete(fail)
      leave()
      if (!error) state.completed.push(sql)
      callback(error, value)
    }
    const fail = () => settle(FIREBIRD_CANCELLED)
    pending.add(fail)
    if (options?.signal) {
      // node-firebird hooks AbortSignal to an out-of-band op_cancel.
      options.signal.addEventListener('abort', cancelNow, { once: true })
    }
    if (mode === 'hang') return
    setTimeout(() => settle(null, [{ sql }]), mode === 'slow' ? 15 : 1)
  }

  const db = {
    state,
    query: (sql, params, callback, options) => startOperation(sql, params, callback, options),
    transaction(options, callback) {
      state.transactions += 1
      setTimeout(() => {
        callback(null, {
          query: (sql, params, cb, queryOptions) =>
            startOperation(sql, params, cb, queryOptions),
          rollback: (cb) => {
            state.rollbacks += 1
            setTimeout(() => cb?.(), 1)
          }
        })
      }, 1)
    },
    cancelAsync: () => {
      cancelNow()
      return Promise.resolve()
    }
  }

  if (prepare !== 'none') {
    db.connection = {
      prepare(transaction, sql, plan, callback) {
        state.preparedWithPlan = plan
        const leave = enter(sql)
        let open = true
        const settle = (error, statement) => {
          if (!open) return
          open = false
          pending.delete(fail)
          leave()
          callback(error, statement)
        }
        const fail = () => settle(FIREBIRD_CANCELLED)
        pending.add(fail)
        if (prepare === 'hang') return
        setTimeout(
          () => settle(null, { plan: 'PLAN (X NATURAL)', drop: (cb) => cb?.() }),
          1
        )
      }
    }
  }

  return db
}

function adapterFor(fake) {
  const adapter = new FirebirdAdapter()
  // The attachment is private state that connect() fills from Firebird.attach;
  // here the fake stands in for it.
  adapter.db = fake
  return adapter
}

check('the adapter runs every statement through the serial queue', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(source, /import \{ SerialQueue \} from '\.\/serialQueue'/)
  assert.match(source, /private readonly queue = new SerialQueue\(\)/)
  // Every entry point that uses the attachment takes the slot.
  assert.match(source, /const rows = await this\.exclusive\(\(\) =>[\s\S]{0,200}this\.withTimeout\(/)
  assert.match(source, /const rows = await this\.exclusive\(\(\) =>[\s\S]{0,200}queryReadOnly\(/)
  assert.match(source, /return this\.exclusive\(\s*\(token\)/)
  assert.match(source, /private statement\([\s\S]{0,200}this\.exclusive\(\(\) => query\(/)
  // The catalog reads go through the queue instead of the raw attachment.
  assert.doesNotMatch(source, /await query\(\s*this\.requireDb\(\)/)
})

check('the timeout path cancels the statement that timed out, and cancel() never queues', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  const cancelStart = source.indexOf('async cancel()')
  assert.ok(cancelStart > 0, 'cancel() is present')
  const cancelBody = source.slice(cancelStart, source.indexOf('/**', cancelStart))
  assert.match(cancelBody, /if \(this\.activeToken === 0\) return/, 'idle cancel is a no-op')
  assert.doesNotMatch(cancelBody, /exclusive|queue\.run/, 'cancel() must not wait for a slot')
  // The plan timeout sends op_cancel through the token, not blindly.
  assert.match(source, /void this\.cancelActive\(token\)/)
  assert.match(source, /if \(token === 0 \|\| token !== this\.activeToken\) return/)
})

await checkAsync('two tabs never have statements on the attachment at once', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  const results = await Promise.all([
    adapter.query('select slow from a', ['slow']),
    adapter.query('select fast from a', ['fast']),
    adapter.query('select also_slow from a', ['slow'])
  ])
  assert.equal(results.length, 3)
  assert.equal(fake.state.maxInFlight, 1, 'only one statement was ever on the wire')
  assert.deepEqual(fake.state.completed, [
    'select slow from a',
    'select fast from a',
    'select also_slow from a'
  ])
})

await checkAsync('the read-only transaction path shares the same slot', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  const [plain, fenced] = await Promise.all([
    adapter.query('select slow from a', ['slow']),
    adapter.query('select fenced from a', ['fast'], false, { readOnlyTransaction: true })
  ])
  assert.equal(plain.rows.length, 1)
  assert.equal(fenced.rows.length, 1)
  assert.equal(fake.state.maxInFlight, 1, 'plain and fenced statements did not overlap')
  assert.equal(fake.state.transactions, 1, 'the fenced statement used one transaction')
  assert.equal(fake.state.rollbacks, 1, 'and rolled it back')
})

await checkAsync('a timeout cancels its own statement and the queue carries on', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  await assert.rejects(
    adapter.query('select hang from a', ['hang'], false, { timeoutMs: 20 }),
    /Query cancelled after 20 ms/
  )
  assert.equal(fake.state.cancels, 1)
  assert.deepEqual(fake.state.cancelTargets, ['select hang from a'], 'op_cancel hit the statement that timed out')

  const next = await adapter.query('select next from a', ['fast'])
  assert.equal(next.rows.length, 1, 'the connection is usable after a cancelled statement')
  assert.equal(fake.state.maxInFlight, 1)
})

await checkAsync('a timeout taken while waiting in the queue cannot cancel another statement', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  const running = adapter.query('select slow from a', ['slow'])
  const impatient = adapter.query('select hang from a', ['hang'], false, { timeoutMs: 5 })
  const [finished] = await Promise.all([
    running,
    assert.rejects(impatient, /Query cancelled after 5 ms/)
  ])
  assert.equal(finished.rows.length, 1, 'the statement that was running finished normally')
  assert.equal(fake.state.cancels, 1)
  assert.deepEqual(fake.state.cancelTargets, ['select hang from a'])
})

await checkAsync('cancel() with nothing running is a no-op', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  await adapter.cancel()
  assert.equal(fake.state.cancels, 0)
})

await checkAsync('cancel() stops the running statement and releases the queue', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  const running = adapter.query('select hang from a', ['hang'])
  await delay(10)
  await adapter.cancel()
  await assert.rejects(running, (error) => error?.gdscode === 335544794)
  assert.deepEqual(fake.state.cancelTargets, ['select hang from a'])

  const next = await adapter.query('select after from a', ['fast'])
  assert.equal(next.rows.length, 1, 'the queue continued after the cancelled statement')
})

await checkAsync('the plan prepare path takes the same slot as queries', async () => {
  const fake = fakeAttachment()
  const adapter = adapterFor(fake)
  const [plan, plain] = await Promise.all([
    adapter.explain('select * from x', false),
    adapter.query('select plain from a', ['fast'])
  ])
  assert.deepEqual(plan.columns, ['plan'])
  assert.match(plan.rows[0].plan, /PLAN \(X NATURAL\)/)
  assert.equal(plain.rows.length, 1)
  assert.equal(fake.state.maxInFlight, 1, 'the prepare never overlapped the query')
  assert.equal(fake.state.preparedWithPlan, true, 'the internal prepare asked for the plan')
})

await checkAsync('a plan timeout cancels the prepare it started', async () => {
  const fake = fakeAttachment({ prepare: 'hang' })
  const adapter = adapterFor(fake)
  await assert.rejects(
    adapter.explain('select hang from x', false, { timeoutMs: 20 }),
    /Plan request cancelled after 20 ms/
  )
  assert.deepEqual(fake.state.cancelTargets, ['select hang from x'])

  const next = await adapter.query('select after from a', ['fast'])
  assert.equal(next.rows.length, 1, 'the queue continued after the cancelled plan')
})

await checkAsync('without the internal prepare API the plan path reports the fallback', async () => {
  const fake = fakeAttachment({ prepare: 'none' })
  const adapter = adapterFor(fake)
  await assert.rejects(
    adapter.explain('select 1 from x', false),
    /needs Firebird 6\+ or a driver that exposes isc_info_sql_get_plan/
  )
})
