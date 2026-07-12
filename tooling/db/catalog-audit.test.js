'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { extractContract } = require('./contract-extractor');
const { checkContract } = require('./catalog-audit');

function emptyCatalog() {
  return {
    tableSet: new Set(),
    columnsByTable: new Map(),
    constraintsByTable: new Map(),
    indexesByTable: new Map(),
    functionSet: new Set(),
    triggersByTable: new Map(),
    viewSet: new Set(),
    rlsByTable: new Map(),
    extensionSet: new Set(),
  };
}

test('reports FAIL-level absence when a declared table does not exist live', () => {
  const contract = extractContract(`CREATE TABLE IF NOT EXISTS widgets (id UUID PRIMARY KEY);`);
  const findings = checkContract(contract, emptyCatalog());
  const tableFinding = findings.find((f) => f.object === 'table widgets');
  assert.strictEqual(tableFinding.presence, 'absent');
  assert.strictEqual(tableFinding.status, 'fail');
});

test('reports OK when the table and its columns exist live', () => {
  const contract = extractContract(`CREATE TABLE IF NOT EXISTS widgets (id UUID PRIMARY KEY, label TEXT);`);
  const catalog = emptyCatalog();
  catalog.tableSet.add('widgets');
  catalog.columnsByTable.set('widgets', new Set(['id', 'label']));
  catalog.constraintsByTable.set('widgets', [{ name: 'widgets_pkey', contype: 'p', definition: 'PRIMARY KEY (id)' }]);

  const findings = checkContract(contract, catalog);
  assert.ok(findings.every((f) => f.status === 'ok'), JSON.stringify(findings, null, 2));
});

test('a named constraint whose live definition is missing a declared literal is a strict FAIL', () => {
  // This is exactly the migration-042 shape: a CHECK constraint with a name
  // that already exists (from an earlier migration) but a narrower value set.
  const contract = extractContract(`
    ALTER TABLE runs ADD CONSTRAINT runs_status_values
      CHECK (status IN ('CREATED','QUEUED','PARTIAL','COMPLETED'));
  `);
  const catalog = emptyCatalog();
  catalog.tableSet.add('runs');
  catalog.constraintsByTable.set('runs', [
    { name: 'runs_status_values', contype: 'c', definition: "CHECK (status = ANY (ARRAY['PENDING','RUNNING','COMPLETED']))" },
  ]);

  const findings = checkContract(contract, catalog);
  const finding = findings.find((f) => f.object === 'runs.runs_status_values');
  assert.strictEqual(finding.status, 'fail');
  assert.match(finding.message, /CREATED/);
  assert.match(finding.message, /QUEUED/);
  assert.match(finding.message, /PARTIAL/);
});

test('a named constraint whose live definition matches is OK', () => {
  const contract = extractContract(`
    ALTER TABLE runs ADD CONSTRAINT runs_status_values CHECK (status IN ('CREATED','COMPLETED'));
  `);
  const catalog = emptyCatalog();
  catalog.tableSet.add('runs');
  catalog.constraintsByTable.set('runs', [
    { name: 'runs_status_values', contype: 'c', definition: "CHECK (status = ANY (ARRAY['CREATED','COMPLETED','FAILED']))" },
  ]);

  const findings = checkContract(contract, catalog);
  const finding = findings.find((f) => f.object === 'runs.runs_status_values');
  assert.strictEqual(finding.status, 'ok');
});

test('an unnamed inline FK reference that is absent live is capped at WARNING, never FAIL', () => {
  // Mirrors migration 025: an inline REFERENCES that a LATER migration may
  // deliberately drop. Ambiguous by construction — must not be a hard FAIL.
  const contract = extractContract(`
    CREATE TABLE IF NOT EXISTS items (
      id UUID PRIMARY KEY,
      owner_id UUID REFERENCES owners(id)
    );
  `);
  const catalog = emptyCatalog();
  catalog.tableSet.add('items');
  catalog.columnsByTable.set('items', new Set(['id', 'owner_id']));
  catalog.constraintsByTable.set('items', [{ name: 'items_pkey', contype: 'p', definition: 'PRIMARY KEY (id)' }]);

  const findings = checkContract(contract, catalog);
  const finding = findings.find((f) => f.object === 'items.owner_id (FK)');
  assert.strictEqual(finding.status, 'warn');
});

test('index declared by CREATE INDEX but missing live is FAIL', () => {
  const contract = extractContract(`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);`);
  const findings = checkContract(contract, emptyCatalog());
  const finding = findings.find((f) => f.object === 'runs.idx_runs_status');
  assert.strictEqual(finding.status, 'fail');
});
