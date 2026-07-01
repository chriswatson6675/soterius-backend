'use strict';

// sra-organisation-provider.test.js — SRA Organisation Provider tests.
// Validates the unchanged Organisation Provider contract, registry loading, mapping,
// eligibility/ordering, deterministic selection_id, FCA-contract parity, and the
// real generated registry. No Observatory execution; no live scanning.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sra = require('./sra-organisation-provider');
const fca = require('./fca-organisation-provider');

const REC = (sraNumber, firmName, domain, companyNumber = null) => ({
  sraNumber, companyNumber, firmName, website: `https://www.${domain}/x`, domain, last_scanned: null, persistedAt: '2026-06-29T00:00:00Z',
});

function fixtureRegistry(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sra-prov-'));
  const file = path.join(dir, 'registry.ndjson');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
function withRegistry(file, fn) {
  const prev = process.env.SRA_REGISTRY_PATH;
  process.env.SRA_REGISTRY_PATH = file;
  try { return fn(); } finally { if (prev === undefined) delete process.env.SRA_REGISTRY_PATH; else process.env.SRA_REGISTRY_PATH = prev; }
}

test('output is exactly the Organisation Provider contract (no extra/missing fields)', () => {
  const file = fixtureRegistry([REC(1, 'A Ltd', 'a.example'), REC(2, 'B', 'b.example')]);
  const out = withRegistry(file, () => sra.loadOrganisations());
  assert.deepStrictEqual(Object.keys(out).sort(), ['cohort_id', 'cohort_name', 'n', 'organisations', 'selection_id']);
  for (const o of out.organisations) {
    assert.deepStrictEqual(Object.keys(o).sort(), ['domain', 'firm_name', 'id', 'last_scanned']);
  }
});

test('contract key-sets match the FCA provider exactly (1)', () => {
  const file = fixtureRegistry([REC(1, 'A', 'a.example')]);
  const sraOut = withRegistry(file, () => sra.loadOrganisations());
  const fcaOut = fca.loadOrganisations(); // reads the real FCA registry (file-based)
  assert.deepStrictEqual(Object.keys(sraOut).sort(), Object.keys(fcaOut).sort(), 'top-level contract matches FCA');
  assert.deepStrictEqual(Object.keys(sraOut.organisations[0]).sort(), Object.keys(fcaOut.organisations[0]).sort(), 'organisation shape matches FCA');
});

test('mapping is correct: id=String(sraNumber), firm_name, normalised domain, last_scanned null', () => {
  const file = fixtureRegistry([REC(667279, 'Marcus Lindsey Hirst', 'andreaslaws.wordpress.com')]);
  const out = withRegistry(file, () => sra.loadOrganisations());
  assert.deepStrictEqual(out.organisations[0], { id: '667279', firm_name: 'Marcus Lindsey Hirst', domain: 'andreaslaws.wordpress.com', last_scanned: null });
  assert.strictEqual(out.cohort_id, 'SRA-REG-001');
  assert.strictEqual(out.cohort_name, 'SRA Organisation Registry');
});

test('eligible count matches the registry; ordering is preserved', () => {
  const file = fixtureRegistry([REC(3, 'C', 'c.example'), REC(1, 'A', 'a.example'), REC(2, 'B', 'b.example')]);
  const out = withRegistry(file, () => sra.loadOrganisations());
  assert.strictEqual(out.n, 3);
  assert.strictEqual(out.organisations.length, 3);
  assert.deepStrictEqual(out.organisations.map((o) => o.id), ['3', '1', '2']); // registry order, not re-sorted
});

test('selection_id is deterministic and bound to registry contents', () => {
  const file = fixtureRegistry([REC(1, 'A', 'a.example')]);
  const a = withRegistry(file, () => sra.loadOrganisations()).selection_id;
  const b = withRegistry(file, () => sra.loadOrganisations()).selection_id;
  assert.strictEqual(a, b);
  assert.match(a, /^sra-registry-[0-9a-f]{12}$/);
});

test('SRA_SAMPLE_N caps to a deterministic head sample (parity with FCA_SAMPLE_N)', () => {
  const file = fixtureRegistry([REC(1, 'A', 'a.example'), REC(2, 'B', 'b.example'), REC(3, 'C', 'c.example')]);
  const out = withRegistry(file, () => {
    process.env.SRA_SAMPLE_N = '2';
    try { return sra.loadOrganisations(); } finally { delete process.env.SRA_SAMPLE_N; }
  });
  assert.strictEqual(out.n, 2);
  assert.deepStrictEqual(out.organisations.map((o) => o.id), ['1', '2']);
  assert.match(out.selection_id, /-sample2$/);
});

test('missing registry throws SRA_REGISTRY_NOT_FOUND', () => {
  withRegistry(path.join(os.tmpdir(), 'no-such-dir-xyz', 'registry.ndjson'), () => {
    assert.throws(() => sra.loadOrganisations(), /SRA Organisation Registry not found/);
  });
});

test('the real generated SRA registry loads as the full eligible population', () => {
  const out = sra.loadOrganisations(); // default path = runs/sra-acquisition/registry.ndjson
  const lines = fs.readFileSync(sra.REGISTRY_PATH, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
  assert.strictEqual(out.n, lines, 'n equals registry line count');
  assert.ok(out.n > 0);
  assert.strictEqual(out.cohort_id, 'SRA-REG-001');
  assert.match(out.selection_id, /^sra-registry-[0-9a-f]{12}$/);
  for (const o of out.organisations.slice(0, 50)) {
    assert.ok(o.domain && o.domain.length > 0);
    assert.strictEqual(o.last_scanned, null);
    assert.strictEqual(typeof o.id, 'string');
  }
});
