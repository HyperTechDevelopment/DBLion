/**
 * Read-only enforcement test.
 *
 * Proves that a read-only connection is blocked by the database session itself
 * (SQLite `PRAGMA query_only`, PostgreSQL startup option, MySQL session
 * transaction mode), by the adapter guard every write path calls, and by the
 * main-process runtime gate — not by a disabled UI button.
 *
 * Live servers are optional. Each engine's integration check reads a URL from
 * the environment and prints `skipped: no server configured` when it is absent,
 * so the suite never reports a pass it did not observe:
 *   DBLION_TEST_PG_URL     postgres://user:pass@host:5432/dbname
 *   DBLION_TEST_MYSQL_URL  mysql://user:pass@host:3306/dbname
 *   DBLION_TEST_MSSQL_URL  sqlserver://user:pass@host:1433/dbname
 *   DBLION_TEST_FIREBIRD_URL firebirdsql://user:pass@host:3050/path/to/db.fdb?encoding=UTF8
 * The configured role needs CREATE TABLE so the test can build its own probe
 * tables; without it the check skips and says so.
 *
 * Run with `npm run test:read-only`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const locateFile = (name) => path.join(projectRoot, 'node_modules', 'sql.js', 'dist', name)

// The aliases are registered by --import (scripts/lib/ts-alias-register.mjs),
// so the production modules below load with their real '@shared/*' imports.
const {
  openSqliteDatabase,
  applySqliteQueryOnly,
  clearSqliteQueryOnly,
  sqliteQueryOnlyActive
} = await import('../src/main/db/sqliteSession.ts')
const { ensureWritable, isReadOnlySql } = await import('../src/main/db/common.ts')
const {
  readOnlySqlViolation,
  assertQueryAllowed,
  assertWritePathAllowed,
  isReadOnlyGuardBypass
} = await import('../src/main/db/guard.ts')
const { normalizeAccessMode, readOnlyEnforcement } = await import('../src/shared/access.ts')

const results = []

function check(name, fn) {
  results.push({ name, run: fn })
}

/** Raised when a configured server cannot run the probe for an environmental reason. */
class Skipped extends Error {}

/**
 * Registers a check that needs a live server. With no URL in the environment
 * the check is reported as skipped instead of passing.
 */
function liveCheck(name, envName, fn) {
  const url = process.env[envName]
  if (!url) {
    results.push({
      name,
      skip: `skipped: no server configured (set ${envName} to run it against a live server)`
    })
    return
  }
  results.push({ name, run: () => fn(url) })
}

async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const WRITE_STATEMENTS = [
  ["INSERT INTO items (id, name) VALUES (2, 'beta')", /readonly/i],
  ["UPDATE items SET name = 'hacked' WHERE id = 1", /readonly/i],
  ['DELETE FROM items WHERE id = 1', /readonly/i],
  ['DROP TABLE items', /readonly/i],
  ['ALTER TABLE items ADD COLUMN extra TEXT', /readonly/i],
  ['CREATE TABLE evil (id INTEGER)', /readonly/i],
  ['CREATE INDEX idx_items_name ON items (name)', /readonly/i]
]

const readOnlyPostgres = {
  id: 'c-ro',
  name: 'Reporting',
  kind: 'postgres',
  accessMode: 'read-only'
}
const readWritePostgres = { ...readOnlyPostgres, id: 'c-rw', accessMode: 'read-write' }

/** Creates a fresh on-disk SQLite database with one seeded row. */
async function seedSqlite() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dblion-ro-'))
  const file = path.join(dir, 'app.db')
  const writer = await openSqliteDatabase({ file, readOnly: false, locateFile })
  writer.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  writer.db.exec("INSERT INTO items (id, name) VALUES (1, 'alpha')")
  await fs.writeFile(file, Buffer.from(writer.db.export()))
  writer.db.close()
  return { dir, file }
}

// ---------------------------------------------------------------------------
// 1. SQLite: the database session refuses every write.
// ---------------------------------------------------------------------------

check('SQLite read-only open enables PRAGMA query_only and verifies it', async () => {
  const { dir, file } = await seedSqlite()
  const opened = await openSqliteDatabase({ file, readOnly: true, locateFile })
  assert.equal(opened.readOnly, true, 'connection is flagged read-only')
  assert.equal(opened.readOnlyEnforced, true, 'open path verified PRAGMA query_only')
  assert.equal(sqliteQueryOnlyActive(opened.db), true, 'pragma reads back as 1')
  opened.db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

check('SQLite read-only connection rejects INSERT/UPDATE/DELETE/DROP/ALTER/CREATE at the engine', async () => {
  const { dir, file } = await seedSqlite()
  const before = await fs.readFile(file)
  const opened = await openSqliteDatabase({ file, readOnly: true, locateFile })

  for (const [sql, pattern] of WRITE_STATEMENTS) {
    assert.throws(
      () => opened.db.exec(sql),
      (error) => pattern.test(String(error?.message ?? '')),
      `expected a database-level refusal for: ${sql}`
    )
  }

  // Reads still work.
  const read = opened.db.exec('SELECT name FROM items WHERE id = 1')
  assert.equal(read[0]?.values?.[0]?.[0], 'alpha', 'SELECT still returns data')

  // Nothing reached the file.
  assert.deepEqual(
    await fs.readFile(file),
    before,
    'the read-only connection never wrote the database file'
  )
  opened.db.close()

  // A fresh read-write open confirms the data is untouched.
  const verifier = await openSqliteDatabase({ file, readOnly: false, locateFile })
  const rows = verifier.db.exec('SELECT id, name FROM items ORDER BY id')
  assert.deepEqual(rows[0]?.values, [[1, 'alpha']], 'rows unchanged after failed writes')
  verifier.db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

check('SELECT ... FOR UPDATE: SQLite has no row locks, so the engine rejects it and the guard refuses it as a write', async () => {
  const { dir, file } = await seedSqlite()
  const opened = await openSqliteDatabase({ file, readOnly: true, locateFile })

  // Limitation, stated where it can be read: SQLite's parser rejects the
  // clause outright, so the database-level rejection is a syntax error rather
  // than a read-only violation. The classifier and guard must still refuse it,
  // which is what makes the same statement safe on the engines that do support
  // it (PostgreSQL, MySQL — see the live checks below).
  assert.throws(
    () => opened.db.exec('SELECT * FROM items FOR UPDATE'),
    /syntax error/i,
    'sql.js rejects FOR UPDATE as syntax: no row-lock support'
  )
  assert.equal(isReadOnlySql('SELECT * FROM items FOR UPDATE'), false, 'classifier treats it as a write')
  assert.throws(() => ensureWritable('SELECT * FROM items FOR UPDATE', true, true), /read-only/i)
  assert.match(readOnlySqlViolation(readOnlyPostgres, 'SELECT * FROM items FOR UPDATE') ?? '', /read-only/i)

  opened.db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

check('SQLite query_only (not the UI) is what blocks the write', async () => {
  const { dir, file } = await seedSqlite()
  const opened = await openSqliteDatabase({ file, readOnly: true, locateFile })
  assert.equal(applySqliteQueryOnly(opened.db), true, 'guard is active')
  assert.throws(() => opened.db.exec("INSERT INTO items (id, name) VALUES (1, 'x')"), /readonly/i)

  // With the guard off, the very same statement succeeds. That shows the
  // refusal above came from SQLite's query_only switch. DBLion blocks the
  // statement that would turn it off (see the guard checks below).
  opened.db.exec('PRAGMA query_only = OFF')
  assert.equal(sqliteQueryOnlyActive(opened.db), false, 'pragma is off after tampering')
  opened.db.exec("INSERT INTO items (id, name) VALUES (2, 'x')")
  const rows = opened.db.exec('SELECT COUNT(*) FROM items')
  assert.equal(rows[0]?.values?.[0]?.[0], 2, 'write succeeded once the guard was disabled')
  opened.db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Every spelling below disables the guard on the real engine, so the guard has
 * to recognise all of them. The quoting and the schema qualifier are what a
 * text-only pattern misses.
 */
const QUERY_ONLY_OFF_SPELLINGS = [
  'PRAGMA query_only = OFF',
  'PRAGMA "query_only" = OFF',
  "PRAGMA 'query_only' = OFF",
  'PRAGMA [query_only] = OFF',
  'PRAGMA `query_only` = OFF',
  'PRAGMA main.query_only = OFF',
  'PRAGMA query_only = 0',
  'pragma QUERY_ONLY = off'
]

check('every spelling of PRAGMA query_only = OFF really disables the engine guard and is refused by ours', async () => {
  for (const sql of QUERY_ONLY_OFF_SPELLINGS) {
    // Real engine: build a throwaway database, turn the guard on, apply the
    // spelling, and confirm the write gets through. If a spelling stopped
    // working on this SQLite the expectation below would fail, which keeps the
    // guard's pattern honest instead of aspirational.
    const { dir, file } = await seedSqlite()
    const opened = await openSqliteDatabase({ file, readOnly: false, locateFile })
    opened.db.exec('PRAGMA query_only = ON')
    opened.db.exec(sql)
    assert.equal(
      sqliteQueryOnlyActive(opened.db),
      false,
      `the engine accepted “${sql}” and left query_only=${sqliteQueryOnlyActive(opened.db) ? 1 : 0}`
    )
    assert.doesNotThrow(
      () => opened.db.exec("INSERT INTO items (id, name) VALUES (2, 'leak')"),
      `“${sql}” left the database writable, so the guard must block it`
    )
    opened.db.close()
    await fs.rm(dir, { recursive: true, force: true })

    // Our layers.
    assert.equal(isReadOnlyGuardBypass(sql), true, `“${sql}” must be treated as a guard bypass`)
    assert.throws(() => ensureWritable(sql, true, true), /read-only/i, `ensureWritable must refuse ${sql}`)
    assert.match(readOnlySqlViolation(readOnlyPostgres, sql) ?? '', /read-only/i)
  }

  // Turning the guard on stays allowed.
  assert.equal(isReadOnlyGuardBypass('PRAGMA query_only = ON'), false)
  assert.equal(isReadOnlyGuardBypass('PRAGMA "query_only" = ON'), false)
})

// ---------------------------------------------------------------------------
// 2. Adapter guard: every adapter calls ensureWritable(sql, allowWrites, readOnly).
// ---------------------------------------------------------------------------

check('adapter guard rejects write SQL on a read-only connection', async () => {
  for (const [sql] of WRITE_STATEMENTS) {
    assert.equal(isReadOnlySql(sql), false, `${sql} is classified as a write`)
    assert.throws(
      () => ensureWritable(sql, true, true),
      /read-only/i,
      `ensureWritable must refuse ${sql} even with the write toggle on`
    )
  }
  assert.throws(() => ensureWritable('SELECT * FROM items FOR UPDATE', true, true), /read-only/i)
  assert.throws(
    () => ensureWritable('PRAGMA query_only = OFF', true, true),
    /read-only/i,
    'the pragma that disables the SQLite guard is refused'
  )
})

check('adapter guard keeps reads and existing writable behaviour', async () => {
  for (const sql of [
    'SELECT * FROM items',
    'WITH x AS (SELECT 1 AS n) SELECT * FROM x',
    'PRAGMA table_info(items)',
    'SHOW search_path'
  ]) {
    assert.doesNotThrow(() => ensureWritable(sql, false, true), `${sql} is a read`)
  }
  // Writable connection: unchanged behaviour (toggle still required).
  assert.throws(() => ensureWritable("INSERT INTO items VALUES (1, 'a')", false, false), /read-only mode/i)
  assert.doesNotThrow(() => ensureWritable("INSERT INTO items VALUES (1, 'a')", true, false))
})

// ---------------------------------------------------------------------------
// 3. Runtime gate used by main/db/index.ts and main/security.ts.
// ---------------------------------------------------------------------------

check('runtime gate rejects writes on a read-only connection', async () => {
  assert.equal(readOnlySqlViolation(readOnlyPostgres, 'SELECT 1'), null)
  for (const sql of [
    "INSERT INTO t VALUES (1)",
    'UPDATE t SET x = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'ALTER TABLE t ADD c int',
    'CREATE TABLE t (id int)',
    'SELECT * FROM t FOR UPDATE',
    'EXPLAIN ANALYZE UPDATE t SET x = 1'
  ]) {
    assert.match(
      readOnlySqlViolation(readOnlyPostgres, sql) ?? '',
      /read-only/i,
      `runtime gate must reject ${sql}`
    )
  }
  assert.throws(() => assertQueryAllowed(readOnlyPostgres, 'DELETE FROM t'), /read-only/i)
  // EXPLAIN ANALYZE of a read statement stays allowed.
  assert.doesNotThrow(() => assertQueryAllowed(readOnlyPostgres, 'EXPLAIN ANALYZE SELECT 1'))
})

check('runtime gate allows writes on a read-write connection', async () => {
  assert.equal(readOnlySqlViolation(readWritePostgres, 'DELETE FROM t'), null)
  assert.doesNotThrow(() => assertQueryAllowed(readWritePostgres, 'DELETE FROM t'))
})

check('write-only paths (row update, CSV import, kill) are refused when read-only', async () => {
  assert.throws(() => assertWritePathAllowed(readOnlyPostgres, 'Row updates'), /read-only/i)
  assert.throws(() => assertWritePathAllowed(readOnlyPostgres, 'CSV import'), /read-only/i)
  assert.throws(() => assertWritePathAllowed(readOnlyPostgres, 'Session termination'), /read-only/i)
  assert.doesNotThrow(() => assertWritePathAllowed(readWritePostgres, 'Row updates'))
})

check('Redis commands are classified before the read-only gate', async () => {
  const redisRead = { id: 'r1', name: 'Cache', kind: 'redis', accessMode: 'read-only' }
  assert.equal(readOnlySqlViolation(redisRead, 'GET session:1'), null)
  assert.equal(readOnlySqlViolation(redisRead, 'SCAN 0'), null)
  assert.match(readOnlySqlViolation(redisRead, 'SET session:1 x') ?? '', /read-only/i)
  assert.match(readOnlySqlViolation(redisRead, 'FLUSHALL') ?? '', /read-only/i)
})

check('statements that disable the read-only guard are refused', async () => {
  for (const sql of [
    'PRAGMA query_only = OFF',
    'PRAGMA query_only = 0',
    'PRAGMA "query_only" = OFF',
    'PRAGMA [query_only] = 0',
    'SET SESSION TRANSACTION READ WRITE',
    'SET default_transaction_read_only = off',
    'SET SESSION tx_read_only = 0',
    'START TRANSACTION READ WRITE',
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    "SELECT set_config('transaction_read_only','0',false)"
  ]) {
    assert.equal(isReadOnlyGuardBypass(sql), true, `${sql} must be treated as a bypass`)
    assert.match(readOnlySqlViolation(readOnlyPostgres, sql) ?? '', /read-only/i)
  }
  // Turning the guard ON is fine.
  assert.equal(isReadOnlyGuardBypass('PRAGMA query_only = ON'), false)
  assert.equal(isReadOnlyGuardBypass('SELECT read_only FROM settings'), false)
  assert.equal(isReadOnlyGuardBypass("SELECT set_config('default_transaction_read_only','on',false)"), false)
  assert.equal(isReadOnlyGuardBypass('SELECT * FROM t'), false)
  // A literal that merely mentions the pragma is still a read.
  assert.equal(isReadOnlyGuardBypass("SELECT 'PRAGMA query_only = OFF' AS note"), false)
  // A second statement in the same string is still caught.
  assert.equal(isReadOnlyGuardBypass('SELECT 1; PRAGMA query_only = OFF'), true)
})

check('legacy profiles without accessMode are read-only', async () => {
  const legacy = { id: 'legacy', name: 'Old profile', kind: 'mysql' }
  assert.equal(normalizeAccessMode(legacy.accessMode), 'read-only')
  assert.equal(normalizeAccessMode('read-write'), 'read-write')
  assert.equal(normalizeAccessMode('READ-WRITE'), 'read-only')
  assert.equal(normalizeAccessMode(undefined), 'read-only')
  assert.equal(normalizeAccessMode(null), 'read-only')
  assert.match(readOnlySqlViolation(legacy, 'DELETE FROM t') ?? '', /read-only/i)
})

check('enforcement level per engine is reported honestly', async () => {
  assert.equal(readOnlyEnforcement('postgres'), 'database')
  assert.equal(readOnlyEnforcement('mysql'), 'database')
  assert.equal(readOnlyEnforcement('sqlite'), 'database')
  assert.equal(readOnlyEnforcement('mssql'), 'server-intent')
  assert.equal(readOnlyEnforcement('firebird'), 'database')
  assert.equal(readOnlyEnforcement('mongodb'), 'app')
  assert.equal(readOnlyEnforcement('redis'), 'app')
})

// ---------------------------------------------------------------------------
// 4. Live servers: the engine, not DBLion, has to refuse the write.
//
// Each check drives the real adapter (app layer) and a raw session that uses
// the exact same read-only lever the adapter uses (database layer), so a
// regression in either one fails here.
// ---------------------------------------------------------------------------

const PG_PROBE = 'dblion_readonly_probe'
const PG_DROP_PROBE = 'dblion_readonly_drop_probe'
const PG_ALTER_PROBE = 'dblion_readonly_alter_probe'

liveCheck(
  'PostgreSQL: read-only session rejects INSERT/UPDATE/DELETE/DROP/ALTER/SELECT FOR UPDATE',
  'DBLION_TEST_PG_URL',
  async (url) => {
    const { Client } = await import('pg')
    const { PostgresAdapter, READ_ONLY_STARTUP_OPTIONS } = await import(
      '../src/main/db/postgres.ts'
    )

    const setup = new Client({ connectionString: url })
    await withTimeout(setup.connect(), 15000, 'postgres setup connect')
    const writes = [
      ['INSERT', `insert into ${PG_PROBE} (id, v) values (99, 'x')`],
      ['UPDATE', `update ${PG_PROBE} set v = 'x' where id = 1`],
      ['DELETE', `delete from ${PG_PROBE} where id = 1`],
      ['DROP', `drop table ${PG_DROP_PROBE}`],
      ['ALTER', `alter table ${PG_ALTER_PROBE} add column extra text`],
      ['SELECT ... FOR UPDATE', `select * from ${PG_PROBE} for update`]
    ]

    try {
      try {
        for (const table of [PG_PROBE, PG_DROP_PROBE, PG_ALTER_PROBE]) {
          await setup.query(`create table if not exists ${table} (id int primary key, v text)`)
        }
        await setup.query(
          `insert into ${PG_PROBE} (id, v) values (1, 'a') on conflict (id) do nothing`
        )
      } catch (error) {
        throw new Skipped(`the test role cannot create the probe tables: ${error.message}`)
      }

      // Database layer: the same startup option the adapter sends.
      const session = new Client({ connectionString: url, options: READ_ONLY_STARTUP_OPTIONS })
      await withTimeout(session.connect(), 15000, 'postgres read-only connect')
      try {
        const state = await session.query('show transaction_read_only')
        assert.equal(state.rows[0]?.ro, 'on', 'startup option left the session read-only')
        for (const [label, sql] of writes) {
          let refused = null
          try {
            await session.query(sql)
          } catch (error) {
            refused = error
          }
          assert.ok(refused, `PostgreSQL accepted ${label} in a read-only transaction`)
          assert.equal(
            refused.code,
            '25006',
            `${label}: expected SQLSTATE 25006 (read_only_sql_transaction), got ${refused.code}: ${refused.message}`
          )
        }
      } finally {
        await session.end().catch(() => undefined)
      }

      // App layer: the real adapter, with the write toggle forced on.
      const adapter = new PostgresAdapter()
      await adapter.connect({
        id: 'test-pg-ro',
        name: 'read-only test',
        kind: 'postgres',
        accessMode: 'read-only',
        connectionString: url
      })
      try {
        const read = await adapter.query('select 1 as n')
        assert.equal(Number(read.rows[0]?.n), 1, 'reads still work on the read-only connection')
        for (const [label, sql] of writes) {
          await assert.rejects(
            () => adapter.query(sql, [], true),
            /read-only/i,
            `the adapter must refuse ${label}`
          )
        }
      } finally {
        await adapter.disconnect().catch(() => undefined)
      }
    } finally {
      for (const table of [PG_PROBE, PG_DROP_PROBE, PG_ALTER_PROBE]) {
        await setup.query(`drop table if exists ${table}`).catch(() => undefined)
      }
      await setup.end().catch(() => undefined)
    }
  }
)

liveCheck(
  'MySQL: read-only session rejects INSERT/UPDATE/DELETE/DROP/ALTER/SELECT FOR UPDATE',
  'DBLION_TEST_MYSQL_URL',
  async (url) => {
    const mysql = await import('mysql2/promise')
    const { MysqlAdapter } = await import('../src/main/db/mysql.ts')
    const parsed = new URL(url)
    const settings = {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || undefined
    }

    const setup = await mysql.createConnection({ ...settings, multipleStatements: false })
    const probe = 'dblion_readonly_probe'
    const dropProbe = 'dblion_readonly_drop_probe'
    const alterProbe = 'dblion_readonly_alter_probe'
    const writes = [
      ['INSERT', `insert into ${probe} (id, v) values (99, 'x')`],
      ['UPDATE', `update ${probe} set v = 'x' where id = 1`],
      ['DELETE', `delete from ${probe} where id = 1`],
      ['DROP', `drop table ${dropProbe}`],
      ['ALTER', `alter table ${alterProbe} add column extra varchar(10)`],
      ['SELECT ... FOR UPDATE', `select * from ${probe} for update`]
    ]

    try {
      try {
        for (const table of [probe, dropProbe, alterProbe]) {
          await setup.query(
            `create table if not exists ${table} (id int primary key, v varchar(32))`
          )
        }
        await setup.query(`insert ignore into ${probe} (id, v) values (1, 'a')`)
      } catch (error) {
        throw new Skipped(`the test role cannot create the probe tables: ${error.message}`)
      }

      // Database layer.
      const session = await mysql.createConnection({ ...settings, multipleStatements: false })
      try {
        await session.query('SET SESSION TRANSACTION READ ONLY')
        const [rows] = await session.query('SELECT @@session.transaction_read_only AS ro')
        assert.equal(Number(rows[0]?.ro), 1, 'session did not become read-only')
        for (const [label, sql] of writes) {
          let refused = null
          try {
            await session.query(sql)
          } catch (error) {
            refused = error
          }
          assert.ok(refused, `MySQL accepted ${label} in a read-only session`)
          assert.equal(
            refused.code,
            'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
            `${label}: expected ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION, got ${refused.code}: ${refused.message}`
          )
        }
      } finally {
        await session.end().catch(() => undefined)
      }

      // App layer.
      const adapter = new MysqlAdapter()
      await adapter.connect({
        id: 'test-mysql-ro',
        name: 'read-only test',
        kind: 'mysql',
        accessMode: 'read-only',
        ...settings
      })
      try {
        const read = await adapter.query('select 1 as n')
        assert.equal(Number(read.rows[0]?.n), 1, 'reads still work on the read-only connection')
        for (const [label, sql] of writes) {
          await assert.rejects(
            () => adapter.query(sql, [], true),
            /read-only/i,
            `the adapter must refuse ${label}`
          )
        }
      } finally {
        await adapter.disconnect().catch(() => undefined)
      }
    } finally {
      for (const table of [probe, dropProbe, alterProbe]) {
        await setup.query(`drop table if exists ${table}`).catch(() => undefined)
      }
      await setup.end().catch(() => undefined)
    }
  }
)

liveCheck(
  'Firebird: read-only connection refuses writes; catalog, column index and plan are readable',
  'DBLION_TEST_FIREBIRD_URL',
  async (url) => {
    const { FirebirdAdapter } = await import('../src/main/db/firebird.ts')
    const { parseFirebirdUrl } = await import('../src/shared/firebird.ts')
    const adapter = new FirebirdAdapter()
    await adapter.connect({
      id: 'test-firebird-ro',
      name: 'read-only test',
      kind: 'firebird',
      accessMode: 'read-only',
      ...parseFirebirdUrl(url)
    })
    try {
      const read = await adapter.query('select 1 as n from rdb$database')
      assert.equal(Number(read.rows[0]?.n), 1, 'reads still work on the read-only connection')

      await assert.rejects(
        () => adapter.query('insert into dblion_should_not_exist (id) values (1)', [], true),
        /read-only/i,
        'the adapter must refuse a write even with the toggle on'
      )

      const catalog = await adapter.catalog()
      assert.ok(Array.isArray(catalog.objects), 'catalog returns an object list')
      assert.equal(typeof catalog.truncated, 'boolean')

      const columns = await adapter.columnsIndex()
      assert.ok(Array.isArray(columns), 'column index returns a list')

      const plan = await adapter.explain('select rdb$relation_name from rdb$relations', false)
      assert.ok(plan.rows.length > 0, 'estimated plan returned at least one row')
    } finally {
      await adapter.disconnect().catch(() => undefined)
    }
  }
)

liveCheck(
  'SQL Server: ApplicationIntent=ReadOnly is refused by DBLion and reported honestly when the server cannot enforce it',
  'DBLION_TEST_MSSQL_URL',
  async (url) => {
    const mssql = await import('mssql')
    const { MssqlAdapter } = await import('../src/main/db/mssql.ts')
    const parsed = new URL(url)
    const settings = {
      server: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 1433,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || undefined
    }

    const setup = await new mssql.ConnectionPool({
      ...settings,
      // The adapter defaults to encrypted with a verified certificate; the test
      // talks to whatever server the operator points it at, so TLS is left to
      // the adapter check below and disabled here.
      options: { encrypt: false, trustServerCertificate: true }
    }).connect()
    const probe = 'dblion_readonly_probe'
    const dropProbe = 'dblion_readonly_drop_probe'
    const alterProbe = 'dblion_readonly_alter_probe'
    // T-SQL has no `FOR UPDATE`; UPDLOCK is its equivalent row-lock hint.
    const writes = [
      ['INSERT', `insert into ${probe} (id, v) values (99, 'x')`],
      ['UPDATE', `update ${probe} set v = 'x' where id = 1`],
      ['DELETE', `delete from ${probe} where id = 1`],
      ['DROP', `drop table ${dropProbe}`],
      ['ALTER', `alter table ${alterProbe} add extra nvarchar(10) null`],
      ['row lock (WITH UPDLOCK)', `select * from ${probe} with (updlock, rowlock)`]
    ]

    try {
      try {
        for (const table of [probe, dropProbe, alterProbe]) {
          await setup
            .request()
            .query(
              `if object_id('${table}', 'U') is null create table ${table} (id int primary key, v nvarchar(32))`
            )
        }
        await setup
          .request()
          .query(`if not exists (select 1 from ${probe} where id = 1) insert into ${probe} (id, v) values (1, 'a')`)
      } catch (error) {
        throw new Skipped(`the test role cannot create the probe tables: ${error.message}`)
      }

      // App layer: DBLion must refuse every write even with the toggle on.
      const adapter = new MssqlAdapter()
      await adapter.connect({
        id: 'test-mssql-ro',
        name: 'read-only test',
        kind: 'mssql',
        accessMode: 'read-only',
        ssl: false,
        ...settings
      })
      try {
        const read = await adapter.query('select 1 as n')
        assert.equal(Number(read.rows[0]?.n), 1, 'reads still work on the read-only connection')
        for (const [label, sql] of writes) {
          await assert.rejects(
            () => adapter.query(sql, [], true),
            /read-only/i,
            `the adapter must refuse ${label}`
          )
        }
      } finally {
        await adapter.disconnect().catch(() => undefined)
      }

      // Server layer: recorded, never claimed. A readable secondary refuses the
      // writes; a primary accepts them because ApplicationIntent=ReadOnly is a
      // routing hint, not a permission. Both outcomes are reported as observed.
      const server = await new mssql.ConnectionPool({
        ...settings,
        options: { encrypt: false, trustServerCertificate: true, readOnlyIntent: true }
      }).connect()
      try {
        const accepted = []
        for (const [label, sql] of writes) {
          try {
            await server.request().query(sql)
            accepted.push(label)
          } catch {
            // Refused: this login landed on a read-only replica.
          }
        }
        if (accepted.length === 0) {
          console.log(
            '     observed: the server refused every write with ApplicationIntent=ReadOnly (readable secondary).'
          )
        } else {
          console.log(
            `     observed: the server accepted ${accepted.join(', ')} with ApplicationIntent=ReadOnly.`
          )
          console.log(
            '     A primary SQL Server does not enforce read-only at the session level; only credentials/grants'
          )
          console.log(
            '     can, so DBLion’s own gate (asserted above) is the boundary here, not the database.'
          )
        }
      } finally {
        await server.close().catch(() => undefined)
      }
    } finally {
      for (const table of [probe, dropProbe, alterProbe]) {
        await setup.request().query(`drop table if exists ${table}`).catch(() => undefined)
      }
      await setup.close().catch(() => undefined)
    }
  }
)

// ---------------------------------------------------------------------------
// 5. AI-originated reads: a database-enforced read-only transaction.
// ---------------------------------------------------------------------------

const { AI_READ_ONLY_BEGIN_SQL: PG_AI_READ_ONLY_BEGIN } = await import('../src/main/db/postgres.ts')
const { AI_READ_ONLY_BEGIN_SQL: MYSQL_AI_READ_ONLY_BEGIN } = await import('../src/main/db/mysql.ts')
const { FIREBIRD_READ_ONLY_TRANSACTION } = await import('../src/main/db/firebird.ts')

check('AI reads ask for a database-enforced read-only transaction', async () => {
  // The classifier cannot see a write hidden inside a function called by a
  // SELECT, so AI-originated reads are fenced by the engine itself.
  assert.equal(PG_AI_READ_ONLY_BEGIN, 'BEGIN TRANSACTION READ ONLY')
  assert.equal(MYSQL_AI_READ_ONLY_BEGIN, 'START TRANSACTION READ ONLY')

  const ipc = await fs.readFile(path.join(projectRoot, 'src', 'main', 'ipc.ts'), 'utf8')
  assert.match(
    ipc,
    /source === 'ai' && sqlClass === 'read'/,
    'the fence is requested for AI reads only'
  )
  assert.match(ipc, /readOnlyTransaction: fenceAiRead/, 'the flag reaches the adapter')

  const pg = await fs.readFile(path.join(projectRoot, 'src', 'main', 'db', 'postgres.ts'), 'utf8')
  assert.match(pg, /client\.query\(AI_READ_ONLY_BEGIN_SQL\)/, 'PostgreSQL opens the fence')
  assert.match(pg, /if \(fenced\) await client\.query\('ROLLBACK'\)/, 'PostgreSQL closes it without committing')

  const mysql = await fs.readFile(path.join(projectRoot, 'src', 'main', 'db', 'mysql.ts'), 'utf8')
  assert.match(mysql, /connection\.query\(AI_READ_ONLY_BEGIN_SQL\)/, 'MySQL opens the fence')
  assert.match(mysql, /if \(fenced\) await connection\.query\('ROLLBACK'\)/, 'MySQL closes it without committing')

  const sqlite = await fs.readFile(path.join(projectRoot, 'src', 'main', 'db', 'sqlite.ts'), 'utf8')
  assert.match(sqlite, /applySqliteQueryOnly\(db\)/, 'SQLite enables query_only for the AI read')
  assert.match(sqlite, /if \(fence\) clearSqliteQueryOnly\(db\)/, 'SQLite restores it in finally')
})

check('the SQLite fence blocks writes while held and is restorable afterwards', async () => {
  const { dir, file } = await seedSqlite()
  const opened = await openSqliteDatabase({ file, readOnly: false, locateFile })
  assert.equal(applySqliteQueryOnly(opened.db), true, 'fence engaged')
  assert.throws(
    () => opened.db.exec("INSERT INTO items (id, name) VALUES (99, 'ai')"),
    /readonly/i,
    'a write inside the fence fails at the engine'
  )
  clearSqliteQueryOnly(opened.db)
  assert.equal(sqliteQueryOnlyActive(opened.db), false, 'fence released')
  assert.doesNotThrow(() => opened.db.exec("INSERT INTO items (id, name) VALUES (100, 'human')"))
  opened.db.close()
  await fs.rm(dir, { recursive: true, force: true })
})

check('Firebird read-only connections and AI reads use an isc_tpb_read transaction', async () => {
  // Firebird has no session-level switch, but it does have a read-only
  // transaction flag. The driver maps ISOLATION_READ_COMMITTED_READ_ONLY to
  // isc_tpb_read, and the adapter uses it for read-only profiles and AI reads.
  assert.equal(FIREBIRD_READ_ONLY_TRANSACTION.readOnly, true)
  assert.ok(Array.isArray(FIREBIRD_READ_ONLY_TRANSACTION.isolation))

  const firebird = await fs.readFile(path.join(projectRoot, 'src', 'main', 'db', 'firebird.ts'), 'utf8')
  assert.match(firebird, /this\.readOnly \|\| options\.readOnlyTransaction/, 'both paths are fenced')
  assert.match(firebird, /\.transaction\(\s*FIREBIRD_READ_ONLY_TRANSACTION/, 'the read-only transaction is requested')
  assert.match(firebird, /transaction\.rollback\(/, 'it is rolled back, never committed')
  assert.equal(readOnlyEnforcement('firebird'), 'database', 'enforcement is reported as database-level')
})

check('changing a profile access mode closes the live connection', async () => {
  // The new policy only takes effect when a session is opened, so a live
  // adapter must be closed. Otherwise a profile switched to read-only would
  // keep a writable session.
  const ipc = await fs.readFile(path.join(projectRoot, 'src', 'main', 'ipc.ts'), 'utf8')
  assert.match(ipc, /normalizeAccessMode\(previous\.accessMode\) !== connection\.accessMode/)
  assert.match(ipc, /await disconnect\(connection\.id\)/)
  assert.match(ipc, /live connection closed/, 'the audit entry states the session was closed')
})

// ---------------------------------------------------------------------------

let failed = 0
let skipped = 0
let passed = 0
for (const { name, run, skip } of results) {
  if (skip) {
    skipped += 1
    console.log(`skip ${name}`)
    console.log(`     ${skip}`)
    continue
  }
  try {
    await run()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    if (error instanceof Skipped) {
      skipped += 1
      console.log(`skip ${name}`)
      console.log(`     skipped: ${error.message}`)
      continue
    }
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

console.log(`\n${passed}/${passed + failed} read-only checks passed (${skipped} skipped)`)
if (failed > 0) process.exitCode = 1
