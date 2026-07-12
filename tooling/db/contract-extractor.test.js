'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { extractContract, extractQuotedLiterals, detectDynamicDdl } = require('./contract-extractor');

test('extracts columns, inline PK, and inline FK from CREATE TABLE', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS widgets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID REFERENCES owners(id) ON DELETE CASCADE,
      label TEXT NOT NULL
    );
  `;
  const contract = extractContract(sql);
  assert.strictEqual(contract.tables.length, 1);
  const t = contract.tables[0];
  assert.strictEqual(t.name, 'widgets');
  assert.deepStrictEqual(t.columns.map((c) => c.name), ['id', 'owner_id', 'label']);
  assert.strictEqual(t.columns[0].inlinePrimaryKey, true);
  assert.strictEqual(t.columns[1].references, 'owners');
});

test('extracts a named CHECK constraint from CREATE TABLE and its literals', () => {
  const sql = `
    CREATE TABLE t (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PENDING',
      CONSTRAINT t_status_values CHECK (status IN ('PENDING','RUNNING','DONE'))
    );
  `;
  const contract = extractContract(sql);
  const c = contract.addConstraints.find((x) => x.name === 't_status_values');
  assert.ok(c, 'named constraint should be captured');
  assert.strictEqual(c.kind, 'check');
  assert.deepStrictEqual(extractQuotedLiterals(c.raw).sort(), ['DONE', 'PENDING', 'RUNNING'].sort());
});

test('captures an inline unnamed column CHECK for soft matching', () => {
  const sql = `
    CREATE TABLE t (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FAILED'))
    );
  `;
  const contract = extractContract(sql);
  const cc = contract.tables[0].inlineColumnChecks[0];
  assert.strictEqual(cc.column, 'status');
  assert.deepStrictEqual(cc.literals.sort(), ['FAILED', 'PENDING'].sort());
});

test('handles multiple ADD COLUMN clauses in ONE ALTER TABLE statement', () => {
  // This is the exact shape that a naive "alter table X ... add column Y"
  // single-match regex would under-count — only the first of a comma list.
  const sql = `
    ALTER TABLE cohorts
      ADD COLUMN IF NOT EXISTS regulator TEXT,
      ADD COLUMN IF NOT EXISTS subsector TEXT,
      ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES datasets(id);
  `;
  const contract = extractContract(sql);
  const cols = contract.addColumns.filter((c) => c.table === 'cohorts').map((c) => c.column);
  assert.deepStrictEqual(cols.sort(), ['dataset_id', 'regulator', 'subsector'].sort());
});

test('extracts ADD CONSTRAINT from ALTER TABLE with its literal values', () => {
  const sql = `
    ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_values;
    ALTER TABLE runs ADD CONSTRAINT runs_status_values
      CHECK (status IN ('CREATED','QUEUED','PARTIAL','COMPLETED'));
  `;
  const contract = extractContract(sql);
  const c = contract.addConstraints.find((x) => x.name === 'runs_status_values');
  assert.ok(c);
  assert.strictEqual(c.table, 'runs');
  assert.deepStrictEqual(extractQuotedLiterals(c.raw).sort(), ['COMPLETED', 'CREATED', 'PARTIAL', 'QUEUED'].sort());
});

test('extracts CREATE INDEX name and target table', () => {
  const sql = `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);`;
  const contract = extractContract(sql);
  assert.deepStrictEqual(contract.indexes, [{ name: 'idx_runs_status', table: 'runs' }]);
});

test('extracts CREATE OR REPLACE FUNCTION name', () => {
  const sql = `CREATE OR REPLACE FUNCTION my_func() RETURNS INTEGER LANGUAGE sql AS $$ SELECT 1 $$;`;
  const contract = extractContract(sql);
  assert.deepStrictEqual(contract.functions, [{ name: 'my_func' }]);
});

test('detects ENABLE ROW LEVEL SECURITY', () => {
  const sql = `ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;`;
  const contract = extractContract(sql);
  assert.deepStrictEqual(contract.rlsEnables, [{ table: 'submissions' }]);
});

test('flags dynamic DDL inside a DO $$ / EXECUTE format block', () => {
  const sql = `
    DO $$
    DECLARE t text;
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD COLUMN organisation_id TEXT', t);
    END $$;
  `;
  const flagged = detectDynamicDdl(sql);
  assert.ok(flagged && flagged.present && flagged.looksLikeDdl);
});

test('does not flag ordinary migrations as dynamic DDL', () => {
  const sql = `CREATE TABLE IF NOT EXISTS t (id UUID PRIMARY KEY);`;
  assert.strictEqual(detectDynamicDdl(sql), null);
});

test('a migration with no structural statements yields an empty-but-valid contract', () => {
  const sql = `-- just a comment, no DDL`;
  const contract = extractContract(sql);
  assert.strictEqual(contract.tables.length, 0);
  assert.strictEqual(contract.addColumns.length, 0);
  assert.strictEqual(contract.addConstraints.length, 0);
});
