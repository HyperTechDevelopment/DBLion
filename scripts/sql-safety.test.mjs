import assert from 'node:assert/strict'
import {
  classifySql,
  getExplainBlockReason,
  isSessionKillSql,
  splitStatements,
  containsForbiddenCall
} from '../src/shared/sql.ts'

function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

check('plain reads stay read', () => {
  assert.equal(classifySql('select 1'), 'read')
  assert.equal(classifySql('with x as (select 1) select * from x'), 'read')
  assert.equal(classifySql('show search_path'), 'read')
  assert.equal(classifySql('pragma table_info(t)'), 'read')
})

check('string literals and comments do not trigger deny-lists', () => {
  assert.equal(classifySql("select 'kill(1)' as text"), 'read')
  assert.equal(classifySql('-- pg_terminate_backend(1)\nselect 1'), 'read')
  assert.equal(containsForbiddenCall("select 'pg_sleep(1)'"), false)
})

check('dangerous SELECT functions are not reads', () => {
  assert.equal(classifySql('select pg_terminate_backend(1)'), 'ddl')
  assert.equal(classifySql('select pg_cancel_backend(1)'), 'ddl')
  for (const sql of [
    'select pg_sleep(1)',
    'select nextval(\'s\')',
    'select setval(\'s\', 1)',
    'select load_extension(\'x\')',
    'select sleep(1)'
  ]) {
    assert.equal(classifySql(sql), 'other', sql)
  }
})

check('DML, DDL, SELECT INTO and row locks are writes', () => {
  assert.equal(classifySql('update t set x = 1'), 'dml')
  assert.equal(classifySql('insert into t values (1)'), 'dml')
  assert.equal(classifySql('delete from t'), 'dml')
  assert.equal(classifySql('create table t(id int)'), 'ddl')
  assert.equal(classifySql('select * into t2 from t'), 'ddl')
  assert.equal(classifySql('select * from t for update'), 'dml')
})

check('session kill syntax is never a read', () => {
  assert.equal(isSessionKillSql('select pg_terminate_backend(12)'), true)
  assert.equal(isSessionKillSql('kill 12'), true)
  assert.equal(isSessionKillSql('kill query 12'), true)
  assert.equal(classifySql('kill 12'), 'ddl')
  assert.equal(isSessionKillSql("select 'kill 12'"), false)
})

check('Explain gate blocks side effects and row locks', () => {
  assert.equal(getExplainBlockReason('select 1'), null)
  assert.notEqual(getExplainBlockReason('select pg_sleep(1)'), null)
  assert.notEqual(getExplainBlockReason('select nextval(\'s\')'), null)
  assert.notEqual(getExplainBlockReason('select * into t2 from t'), null)
  assert.notEqual(getExplainBlockReason('select * from t for update'), null)
  assert.notEqual(getExplainBlockReason('update t set x = 1'), null)
  assert.notEqual(getExplainBlockReason('select 1; select 2'), null)
})

check('statement splitting respects quoted semicolons', () => {
  assert.equal(splitStatements("select ';' as x; select 2").length, 2)
  assert.equal(splitStatements("select 'a;b' as x").length, 1)
})
