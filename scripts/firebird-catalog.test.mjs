// Unit tests for the Firebird catalog/DDL module.
//
// No live Firebird is involved: `loadFirebirdCatalog` and `loadFirebirdDdl`
// take an injected query function, so a fake that returns canned RDB$ rows
// exercises the real production module end to end.
//
// Run with: node scripts/firebird-catalog.test.mjs
// (Node strips the `import type` in the module, so the `@shared/*` alias is
// never resolved at runtime and no loader hook is needed.)

import assert from 'node:assert/strict'
import { loadFirebirdCatalog, loadFirebirdDdl } from '../src/main/db/firebirdCatalog.ts'

const TABLE_WARNING = 'Reconstructed from RDB$ metadata; review before applying.'

/** Statements that must never be sent by a metadata reader. */
const WRITE_SQL =
  /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|execute|commit|rollback)\b/i

const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error(`FAIL ${name}`)
    throw error
  }
}

/**
 * Fake query: the first route whose needles are all present in the SQL answers.
 * Unrouted SQL throws, which is deliberate — a silent [] would let a broken
 * query hide behind `optional()` in the module.
 */
function makeQuery(routes) {
  const calls = []
  const query = async (sql, params = []) => {
    calls.push({ sql, params })
    for (const route of routes) {
      const needles = Array.isArray(route.match) ? route.match : [route.match]
      if (needles.every((needle) => sql.includes(needle))) {
        if (route.error) throw route.error
        return typeof route.rows === 'function' ? route.rows(sql, params) : route.rows
      }
    }
    throw new Error(`fake query: no route for SQL:\n${sql}`)
  }
  return { query, calls }
}

function assertReadOnlyCalls(calls, label) {
  assert.ok(calls.length > 0, `${label}: expected at least one statement`)
  for (const call of calls) {
    assert.match(call.sql.trimStart(), /^select\b/i, `${label}: not a SELECT:\n${call.sql}`)
    assert.doesNotMatch(call.sql, WRITE_SQL, `${label}: write keyword in:\n${call.sql}`)
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

await check('catalog lists tables, views, indexes, triggers, procedures, functions, generators and domains', async () => {
  const { query, calls } = makeQuery([
    {
      match: ['from rdb$relations r', 'case when r.rdb$view_blr'],
      rows: [
        { name: 'PESSOA    ', type: 'table' },
        { name: '  VW_PESSOA', type: 'view' }
      ]
    },
    { match: ['from rdb$indices i', 'i.rdb$relation_name is not null'], rows: [{ name: 'IDX_PESSOA_NOME', parent: 'PESSOA' }] },
    { match: 'from rdb$triggers t', rows: [{ name: 'TR_PESSOA_BI', parent: 'PESSOA' }] },
    { match: 'from rdb$procedures p', rows: [{ name: 'SP_ADD_PESSOA' }] },
    { match: 'from rdb$functions f', rows: [{ name: 'FN_IDADE' }] },
    { match: 'from rdb$generators g', rows: [{ name: 'GEN_PESSOA' }] },
    { match: 'from rdb$fields f', rows: [{ name: 'DOM_CPF' }] }
  ])

  const catalog = await loadFirebirdCatalog(query)

  assert.deepEqual(
    catalog.objects.map((object) => `${object.type}:${object.name}`),
    [
      'table:PESSOA',
      'view:VW_PESSOA',
      'index:IDX_PESSOA_NOME',
      'trigger:TR_PESSOA_BI',
      'procedure:SP_ADD_PESSOA',
      'function:FN_IDADE',
      'generator:GEN_PESSOA',
      'domain:DOM_CPF'
    ]
  )
  assert.equal(catalog.truncated, false)
  const index = catalog.objects.find((object) => object.type === 'index')
  assert.equal(index.parent, 'PESSOA')
  const trigger = catalog.objects.find((object) => object.type === 'trigger')
  assert.equal(trigger.parent, 'PESSOA')
  assertReadOnlyCalls(calls, 'catalog')
})

await check('a permission gap in one section does not blank the catalog', async () => {
  const denied = Object.assign(new Error('no SELECT privilege on RDB$FUNCTIONS'), { gdscode: 335544551 })
  const { query } = makeQuery([
    { match: ['from rdb$relations r'], rows: [{ name: 'PESSOA', type: 'table' }] },
    { match: ['from rdb$indices i'], rows: [{ name: 'IDX_PESSOA_NOME', parent: 'PESSOA' }] },
    { match: 'from rdb$triggers t', rows: [] },
    { match: 'from rdb$procedures p', rows: [{ name: 'SP_ADD_PESSOA' }] },
    { match: 'from rdb$functions f', error: denied },
    { match: 'from rdb$generators g', rows: [{ name: 'GEN_PESSOA' }] },
    { match: 'from rdb$fields f', error: denied }
  ])

  const catalog = await loadFirebirdCatalog(query)
  assert.deepEqual(
    catalog.objects.map((object) => object.type),
    ['table', 'index', 'procedure', 'generator']
  )
  assert.equal(catalog.truncated, false)
})

await check('catalog falls back to RDB$SEQUENCES when RDB$GENERATORS is unavailable', async () => {
  const { query } = makeQuery([
    { match: ['from rdb$relations r'], rows: [{ name: 'PESSOA', type: 'table' }] },
    { match: ['from rdb$indices i'], rows: [] },
    { match: 'from rdb$triggers t', rows: [] },
    { match: 'from rdb$procedures p', rows: [] },
    { match: 'from rdb$functions f', rows: [] },
    { match: 'from rdb$generators g', error: new Error('Dynamic SQL Error: Table unknown RDB$GENERATORS') },
    { match: 'from rdb$sequence', rows: [{ name: 'SEQ_PESSOA' }] },
    { match: 'from rdb$fields f', rows: [] }
  ])

  const catalog = await loadFirebirdCatalog(query)
  assert.deepEqual(
    catalog.objects.map((object) => `${object.type}:${object.name}`),
    ['table:PESSOA', 'generator:SEQ_PESSOA']
  )
})

await check('catalog is bounded to 1000 objects and reports truncation', async () => {
  const many = Array.from({ length: 1001 }, (_, position) => ({
    name: `T_${position}`,
    type: 'table'
  }))
  const { query } = makeQuery([
    { match: ['from rdb$relations r'], rows: many },
    { match: ['from rdb$indices i'], rows: [] },
    { match: 'from rdb$triggers t', rows: [] },
    { match: 'from rdb$procedures p', rows: [] },
    { match: 'from rdb$functions f', rows: [] },
    { match: 'from rdb$generators g', rows: [] },
    { match: 'from rdb$sequence', rows: [] },
    { match: 'from rdb$fields f', rows: [] }
  ])

  const catalog = await loadFirebirdCatalog(query)
  assert.equal(catalog.objects.length, 1000)
  assert.equal(catalog.truncated, true)
})

await check('catalog ignores the schema argument (Firebird has no schemas)', async () => {
  const { query, calls } = makeQuery([
    { match: ['from rdb$relations r'], rows: [] },
    { match: ['from rdb$indices i'], rows: [] },
    { match: 'from rdb$triggers t', rows: [] },
    { match: 'from rdb$procedures p', rows: [] },
    { match: 'from rdb$functions f', rows: [] },
    { match: 'from rdb$generators g', rows: [] },
    { match: 'from rdb$fields f', rows: [] }
  ])

  await loadFirebirdCatalog(query, 'PUBLIC')
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /PUBLIC/)
    assert.deepEqual(call.params, [])
  }
})

// ---------------------------------------------------------------------------
// View DDL — verbatim
// ---------------------------------------------------------------------------

await check('view DDL reproduces the stored source verbatim and warns about nothing', async () => {
  const source = 'select p.id, p.nome\n  from pessoa p\n where p.ativo = 1'
  const { query, calls } = makeQuery([{ match: 'rdb$view_source', rows: [{ source: `${source}\n` }] }])

  const ddl = await loadFirebirdDdl(query, { name: 'VW_PESSOA_ATIVA', type: 'view' })

  assert.equal(ddl.sql, `create or replace view "VW_PESSOA_ATIVA" as\n${source};`)
  assert.deepEqual(ddl.warnings, [])
  assertReadOnlyCalls(calls, 'view ddl')
})

await check('view DDL refuses when Firebird stored no source', async () => {
  const { query } = makeQuery([{ match: 'rdb$view_source', rows: [{ source: null }] }])
  await assert.rejects(
    () => loadFirebirdDdl(query, { name: 'VW_MISSING', type: 'view' }),
    /stored no view source/
  )
})

// ---------------------------------------------------------------------------
// Procedure DDL — verbatim body, header rebuilt from RDB$PROCEDURE_PARAMETERS
// ---------------------------------------------------------------------------

const PROCEDURE_BODY = [
  'begin',
  '  insert into log_pessoa (pessoa_id, evento)',
  '    values (:p_id, \'INSERT\');',
  '  suspend;',
  'end'
].join('\n')

const procedureRoutes = (overrides = {}) => [
  {
    match: 'rdb$procedure_source',
    rows: [{ source: `${PROCEDURE_BODY}\n`, package_name: '   ' }],
    ...overrides.source
  },
  {
    match: 'rdb$procedure_parameters',
    rows: [
      { name: 'P_ID  ', parameter_type: 0, field_type: 8, field_length: 4, field_scale: 0, field_sub_type: 0 },
      { name: ' P_NOME', parameter_type: 0, field_type: 37, field_length: 240, field_scale: 0, field_sub_type: 0, character_length: 60 },
      { name: 'O_TOTAL', parameter_type: 1, field_type: 16, field_length: 8, field_scale: 0, field_sub_type: 0, field_precision: 18 }
    ],
    ...overrides.parameters
  }
]

await check('procedure DDL keeps the body verbatim and rebuilds the header', async () => {
  const { query, calls } = makeQuery(procedureRoutes())

  const ddl = await loadFirebirdDdl(query, { name: 'SP_LOG_PESSOA', type: 'procedure' })

  assert.equal(
    ddl.sql,
    [
      'create or alter procedure "SP_LOG_PESSOA" (',
      '  "P_ID" integer,',
      '  "P_NOME" varchar(60)',
      ')',
      'returns (',
      '  "O_TOTAL" bigint',
      ')',
      'as',
      `${PROCEDURE_BODY};`
    ].join('\n')
  )
  assert.ok(ddl.sql.includes(PROCEDURE_BODY), 'the stored body must appear unchanged')
  assert.deepEqual(ddl.warnings, [])
  assertReadOnlyCalls(calls, 'procedure ddl')
})

await check('a package procedure says so instead of claiming a complete header', async () => {
  const { query } = makeQuery([
    { match: 'rdb$procedure_source', rows: [{ source: PROCEDURE_BODY, package_name: 'PKG_PESSOA' }] },
    { match: 'rdb$procedure_parameters', rows: [] }
  ])

  const ddl = await loadFirebirdDdl(query, { name: 'SP_LOG_PESSOA', type: 'procedure' })
  assert.equal(ddl.warnings.length, 1)
  assert.match(ddl.warnings[0], /belongs to package "PKG_PESSOA"/)
})

// ---------------------------------------------------------------------------
// Trigger DDL
// ---------------------------------------------------------------------------

await check('trigger DDL decodes the event mask and keeps the body verbatim', async () => {
  const body = 'begin\n  new.criado_em = current_timestamp;\nend'
  const { query, calls } = makeQuery([
    {
      match: 'rdb$trigger_source',
      rows: [
        {
          name: 'TR_PESSOA_BIU',
          relation_name: 'PESSOA',
          trigger_type: 3,
          is_inactive: 0,
          trigger_sequence: 0,
          source: `${body}\n`
        }
      ]
    }
  ])

  const ddl = await loadFirebirdDdl(query, { name: 'TR_PESSOA_BIU', type: 'trigger', parent: 'PESSOA' })
  assert.equal(
    ddl.sql,
    `create or alter trigger "TR_PESSOA_BIU" for "PESSOA" active before insert or update\nas\n${body};`
  )
  assert.deepEqual(ddl.warnings, [])
  assertReadOnlyCalls(calls, 'trigger ddl')
})

await check('an undecodable trigger type fails loudly instead of guessing', async () => {
  const { query } = makeQuery([
    {
      match: 'rdb$trigger_source',
      rows: [
        {
          name: 'TR_WEIRD',
          relation_name: 'PESSOA',
          trigger_type: 4096,
          is_inactive: 0,
          trigger_sequence: 0,
          source: 'begin end'
        }
      ]
    }
  ])

  await assert.rejects(
    () => loadFirebirdDdl(query, { name: 'TR_WEIRD', type: 'trigger' }),
    /cannot decode into a trigger event/
  )
})

// ---------------------------------------------------------------------------
// Table DDL — reconstructed, always reviewed
// ---------------------------------------------------------------------------

const tableRoutes = (overrides = {}) => [
  {
    match: ['from rdb$relation_fields rf', 'join rdb$fields f'],
    rows: [
      {
        name: 'ID',
        field_type: 8,
        field_length: 4,
        field_scale: 0,
        field_sub_type: 0,
        not_null: 1,
        default_source: null,
        description: 'Chave primaria'
      },
      {
        name: 'NOME',
        field_type: 37,
        field_length: 240,
        field_scale: 0,
        field_sub_type: 0,
        character_length: 60,
        charset: 'UTF8',
        not_null: 1,
        default_source: null,
        description: null
      },
      {
        name: 'CIDADE_ID',
        field_type: 8,
        field_length: 4,
        field_scale: 0,
        field_sub_type: 0,
        not_null: 0,
        default_source: null,
        description: null
      },
      {
        name: 'SALDO',
        field_type: 16,
        field_length: 8,
        field_scale: -2,
        field_sub_type: 1,
        field_precision: 18,
        not_null: 0,
        default_source: 'DEFAULT 0',
        description: null
      }
    ],
    ...overrides.columns
  },
  {
    match: "constraint_type = 'PRIMARY KEY'",
    rows: [{ constraint_name: 'PK_PESSOA', column_name: 'ID' }],
    ...overrides.primaryKey
  },
  { match: "constraint_type = 'UNIQUE'", rows: [], ...overrides.unique },
  {
    match: "constraint_type = 'FOREIGN KEY'",
    rows: [
      {
        constraint_name: 'FK_PESSOA_CIDADE',
        ref_table: 'CIDADE',
        column_name: 'CIDADE_ID',
        ref_column: 'ID',
        delete_rule: 'CASCADE   ',
        update_rule: 'NO ACTION'
      }
    ],
    ...overrides.foreignKeys
  },
  {
    match: ['from rdb$indices i', 'not exists'],
    rows: [
      { name: 'IDX_PESSOA_NOME', parent: 'PESSOA', is_unique: 0, index_type: 0, column_name: 'NOME', field_position: 0 }
    ],
    ...overrides.indexes
  },
  { match: 'rdb$identity_type', rows: [], ...overrides.special },
  { match: 'select cast(r.rdb$description', rows: [{ description: 'Cadastro de pessoas' }], ...overrides.comment }
]

await check('table DDL is reconstructed and always carries the review warning', async () => {
  const { query, calls } = makeQuery(tableRoutes())

  const ddl = await loadFirebirdDdl(query, { name: 'PESSOA', type: 'table' })

  assert.deepEqual(ddl.warnings, [TABLE_WARNING])
  assert.match(ddl.sql, /^create table "PESSOA" \(/)
  assert.match(ddl.sql, /\n {2}"ID" integer not null,/)
  assert.match(ddl.sql, /\n {2}"NOME" varchar\(60\) character set UTF8 not null,/)
  assert.match(ddl.sql, /\n {2}"SALDO" numeric\(18, 2\) DEFAULT 0,/)
  assert.match(ddl.sql, /constraint "PK_PESSOA" primary key \("ID"\)/)
  assert.match(
    ddl.sql,
    /constraint "FK_PESSOA_CIDADE" foreign key \("CIDADE_ID"\) references "CIDADE" \("ID"\) on delete cascade/
  )
  assert.match(ddl.sql, /create index "IDX_PESSOA_NOME" on "PESSOA" \("NOME"\);/)
  assert.match(ddl.sql, /comment on table "PESSOA" is 'Cadastro de pessoas';/)
  assert.match(ddl.sql, /comment on column "PESSOA" "ID" is 'Chave primaria';/)
  assertReadOnlyCalls(calls, 'table ddl')
})

await check('table DDL warns about identity columns it cannot rebuild', async () => {
  const { query } = makeQuery(
    tableRoutes({
      special: {
        rows: [{ name: 'ID', identity_type: 1, computed_blr: null }]
      }
    })
  )

  const ddl = await loadFirebirdDdl(query, { name: 'PESSOA', type: 'table' })
  assert.ok(ddl.warnings.includes(TABLE_WARNING))
  assert.ok(ddl.warnings.some((warning) => /identity column/.test(warning)))
})

await check('an unmapped column type leaves a visible hole instead of a wrong type', async () => {
  const { query } = makeQuery(
    tableRoutes({
      columns: {
        rows: [
          {
            name: 'MYSTERY',
            field_type: 999,
            field_length: 8,
            field_scale: 0,
            field_sub_type: 0,
            not_null: 0,
            default_source: null,
            description: null
          }
        ]
      }
    })
  )

  const ddl = await loadFirebirdDdl(query, { name: 'PESSOA', type: 'table' })
  assert.match(ddl.sql, /\/\* MYSTERY: type unavailable from RDB\$ metadata, write it by hand \*\//)
  assert.ok(ddl.warnings.some((warning) => /RDB\$FIELD_TYPE 999 is not mapped/.test(warning)))
})

// ---------------------------------------------------------------------------
// Index, generator, domain
// ---------------------------------------------------------------------------

await check('index DDL quotes identifiers and keeps uniqueness and direction', async () => {
  const { query, calls } = makeQuery([
    {
      match: 'where i.rdb$index_name = ?',
      rows: [
        { name: 'IDX_ZONA', parent: 'PESSOA', is_unique: 1, index_type: 1, column_name: 'Zona', field_position: 0 },
        { name: 'IDX_ZONA', parent: 'PESSOA', is_unique: 1, index_type: 1, column_name: 'Bloco', field_position: 1 }
      ]
    }
  ])

  const ddl = await loadFirebirdDdl(query, { name: 'IDX_ZONA', type: 'index' })
  assert.equal(ddl.sql, 'create unique descending index "IDX_ZONA" on "PESSOA" ("Zona", "Bloco");')
  assert.deepEqual(ddl.warnings, [])
  assertReadOnlyCalls(calls, 'index ddl')
})

await check('generator DDL states that the value is not reproduced', async () => {
  const { query, calls } = makeQuery([])
  const ddl = await loadFirebirdDdl(query, { name: 'GEN_PESSOA', type: 'generator' })
  assert.equal(ddl.sql, 'create generator "GEN_PESSOA";')
  assert.equal(ddl.warnings.length, 1)
  assert.match(ddl.warnings[0], /not stored in RDB\$ metadata/)
  assert.equal(calls.length, 0, 'a generator needs no metadata query')
})

await check('domain DDL is reconstructed with its check and default', async () => {
  const { query, calls } = makeQuery([
    {
      match: 'from rdb$fields f',
      rows: [
        {
          name: 'DOM_CPF',
          field_type: 14,
          field_length: 11,
          field_scale: 0,
          field_sub_type: 0,
          character_length: 11,
          charset: 'ASCII',
          not_null: 0,
          default_source: null,
          validation_source: 'CHECK (VALUE similar to \'[0-9]{11}\')'
        }
      ]
    }
  ])

  const ddl = await loadFirebirdDdl(query, { name: 'DOM_CPF', type: 'domain' })
  assert.equal(
    ddl.sql,
    `create domain "DOM_CPF" as char(11) character set ASCII CHECK (VALUE similar to '[0-9]{11}');`
  )
  assertReadOnlyCalls(calls, 'domain ddl')
})

await check('function DDL is refused with an explicit reason', async () => {
  const { query } = makeQuery([])
  await assert.rejects(
    () => loadFirebirdDdl(query, { name: 'FN_IDADE', type: 'function' }),
    /function DDL is not implemented/
  )
})

// ---------------------------------------------------------------------------
// Identifier escaping and the read-only guarantee
// ---------------------------------------------------------------------------

await check('identifiers with quotes are escaped by doubling them', async () => {
  const { query } = makeQuery([{ match: 'rdb$view_source', rows: [{ source: 'select 1 from rdb$database' }] }])

  const ddl = await loadFirebirdDdl(query, { name: 'Weird "Name"', type: 'view' })
  assert.match(ddl.sql, /^create or replace view "Weird ""Name""" as\nselect 1 from rdb\$database;/)
})

await check('index identifiers are escaped too', async () => {
  const { query } = makeQuery([
    {
      match: 'where i.rdb$index_name = ?',
      rows: [{ name: 'IDX "X"', parent: 'A "B"', is_unique: 0, index_type: 0, column_name: 'C "D"', field_position: 0 }]
    }
  ])

  const ddl = await loadFirebirdDdl(query, { name: 'IDX "X"', type: 'index' })
  assert.equal(ddl.sql, 'create index "IDX ""X""" on "A ""B""" ("C ""D""");')
})

await check('no catalog or DDL path ever issues a writing statement', async () => {
  const catalogQuery = makeQuery([
    { match: ['from rdb$relations r'], rows: [{ name: 'PESSOA', type: 'table' }] },
    { match: ['from rdb$indices i'], rows: [] },
    { match: 'from rdb$triggers t', rows: [] },
    { match: 'from rdb$procedures p', rows: [] },
    { match: 'from rdb$functions f', rows: [] },
    { match: 'from rdb$generators g', rows: [] },
    { match: 'from rdb$fields f', rows: [] }
  ])
  await loadFirebirdCatalog(catalogQuery.query)
  assertReadOnlyCalls(catalogQuery.calls, 'catalog sweep')

  const ddlQuery = makeQuery(tableRoutes())
  await loadFirebirdDdl(ddlQuery.query, { name: 'PESSOA', type: 'table' })
  assertReadOnlyCalls(ddlQuery.calls, 'table ddl sweep')
  assert.ok(
    ddlQuery.calls.some((call) => call.sql.includes('rdb$relation_fields')),
    'the table path must actually read RDB$ metadata'
  )
})

await check('a module-level guard refuses anything that is not a SELECT', async () => {
  // The guard is private, so it is exercised through a route that would make
  // the module emit a non-SELECT: it cannot, which is the point. Instead assert
  // the injected query only ever sees SELECTs even when the fake would accept
  // anything.
  const seen = []
  const query = async (sql) => {
    seen.push(sql.trimStart().split(/\s+/)[0].toUpperCase())
    return []
  }
  await loadFirebirdCatalog(query)
  assert.ok(seen.length > 0)
  assert.deepEqual([...new Set(seen)], ['SELECT'])
})

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
