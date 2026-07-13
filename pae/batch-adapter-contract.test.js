'use strict';

// batch-adapter-contract.test.js — tests the contract's orchestration itself
// (stage order, error propagation, conformance checks) against the in-memory
// fixture adapter. Does not test any real source (that is WP-2+).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  CANONICAL_RECORD_FIELDS,
  validateCanonicalRecord,
  assertIsBatchAdapter,
  runBatchAdapter,
} = require('./batch-adapter-contract');
const { createFixtureBatchAdapter } = require('./test-fixtures/fixture-batch-adapter');

// ── assertIsBatchAdapter (conformance) ──────────────────────────────────────

test('assertIsBatchAdapter accepts a conforming adapter', () => {
  assert.doesNotThrow(() => assertIsBatchAdapter(createFixtureBatchAdapter()));
});

test('assertIsBatchAdapter rejects a non-object', () => {
  assert.throws(() => assertIsBatchAdapter(null), TypeError);
  assert.throws(() => assertIsBatchAdapter('adapter'), TypeError);
});

test('assertIsBatchAdapter names every missing piece at once', () => {
  try {
    assertIsBatchAdapter({ sourceId: '' });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /sourceId must be a non-empty string/);
    assert.match(err.message, /parse must be a function/);
    assert.match(err.message, /validateStructure must be a function/);
    assert.match(err.message, /normalise must be a function/);
  }
});

// ── validateCanonicalRecord ──────────────────────────────────────────────────

test('validateCanonicalRecord accepts a fully-shaped record', () => {
  const record = {
    source: 's', regulator: null, name: 'X', namePriority: 1,
    frn: null, sraNumber: null, ukprn: null, companyNumber: null, lei: null, ifUuid: null,
    frcAudit: null, hmrcAml: null, pbsFirm: null,
    domainRaw: null, domainSource: null, domainPriority: null, noDomainAsserted: true,
    sourceDate: '2026-07-13', provenance: { file: 'f', key: 'k' },
  };
  assert.deepStrictEqual(validateCanonicalRecord(record, 0), []);
});

test('validateCanonicalRecord reports every missing field', () => {
  const errors = validateCanonicalRecord({ source: 's' }, 2);
  const missing = CANONICAL_RECORD_FIELDS.filter((f) => f !== 'source');
  for (const field of missing) {
    assert.ok(errors.some((e) => e.includes(`"${field}"`)), `expected an error mentioning ${field}`);
  }
});

test('validateCanonicalRecord rejects a malformed provenance', () => {
  const record = {
    source: 's', regulator: null, name: 'X', namePriority: 1,
    frn: null, sraNumber: null, ukprn: null, companyNumber: null, lei: null, ifUuid: null,
    domainRaw: null, domainSource: null, domainPriority: null, noDomainAsserted: true,
    sourceDate: '2026-07-13', provenance: { file: 'f' }, // missing key
  };
  const errors = validateCanonicalRecord(record, 0);
  assert.ok(errors.some((e) => e.includes('provenance')));
});

// ── runBatchAdapter — happy path ─────────────────────────────────────────────

test('runBatchAdapter runs parse → validateStructure → normalise → emit end to end', async () => {
  const adapter = createFixtureBatchAdapter();
  const input = [
    { id: '1', orgName: 'Acme Ltd', website: 'acme.example' },
    { id: '2', orgName: 'Beta Ltd' }, // no website — noDomainAsserted
  ];
  const result = await runBatchAdapter(adapter, input);

  assert.strictEqual(result.sourceId, 'fixture-source');
  assert.strictEqual(result.stage, 'complete');
  assert.strictEqual(result.fatalError, null);
  assert.strictEqual(result.rowsParsed, 2);
  assert.strictEqual(result.recordsEmitted, 2);
  assert.strictEqual(result.rowsRejected, 0);
  assert.strictEqual(result.records[0].name, 'Acme Ltd');
  assert.strictEqual(result.records[0].noDomainAsserted, false);
  assert.strictEqual(result.records[1].noDomainAsserted, true);
});

test('runBatchAdapter captures structural rejections without failing the run', async () => {
  const adapter = createFixtureBatchAdapter();
  const input = [
    { id: '1', orgName: 'Acme Ltd' },
    { id: '', orgName: 'No Id Ltd' }, // rejected: missing id
    { id: '3' }, // rejected: missing orgName
  ];
  const result = await runBatchAdapter(adapter, input);

  assert.strictEqual(result.fatalError, null);
  assert.strictEqual(result.rowsParsed, 3);
  assert.strictEqual(result.recordsEmitted, 1);
  assert.strictEqual(result.rowsRejected, 2);
  assert.ok(result.rejections.every((r) => r.stage === 'validateStructure'));
});

test('runBatchAdapter rejects (at emit) a record normalise() produced with a missing field, without failing the run', async () => {
  const adapter = createFixtureBatchAdapter({
    normalise(validRows) {
      return validRows.map((row) => ({ source: 'fixture-source', name: row.orgName })); // incomplete on purpose
    },
  });
  const result = await runBatchAdapter(adapter, [{ id: '1', orgName: 'Acme Ltd' }]);

  assert.strictEqual(result.fatalError, null);
  assert.strictEqual(result.recordsEmitted, 0);
  assert.strictEqual(result.rowsRejected, 1);
  assert.strictEqual(result.rejections[0].stage, 'emit');
});

// ── runBatchAdapter — fatal error propagation per stage ─────────────────────

test('runBatchAdapter reports a fatal error when parse() throws, without throwing itself', async () => {
  const adapter = createFixtureBatchAdapter({
    parse() { throw new Error('corrupt file'); },
  });
  const result = await runBatchAdapter(adapter, []);
  assert.strictEqual(result.stage, 'parse');
  assert.strictEqual(result.fatalError.stage, 'parse');
  assert.match(result.fatalError.message, /corrupt file/);
  assert.strictEqual(result.recordsEmitted, 0);
});

test('runBatchAdapter treats a non-array parse() return as fatal', async () => {
  const adapter = createFixtureBatchAdapter({ parse() { return { not: 'an array' }; } });
  const result = await runBatchAdapter(adapter, []);
  assert.strictEqual(result.stage, 'parse');
  assert.match(result.fatalError.message, /must return an array of rows/);
});

test('runBatchAdapter reports a fatal error when validateStructure() throws', async () => {
  const adapter = createFixtureBatchAdapter({
    validateStructure() { throw new Error('structure check exploded'); },
  });
  const result = await runBatchAdapter(adapter, [{ id: '1', orgName: 'X' }]);
  assert.strictEqual(result.stage, 'validateStructure');
  assert.match(result.fatalError.message, /structure check exploded/);
});

test('runBatchAdapter reports a fatal error when validateStructure() returns a malformed shape', async () => {
  const adapter = createFixtureBatchAdapter({ validateStructure() { return 'nonsense'; } });
  const result = await runBatchAdapter(adapter, [{ id: '1', orgName: 'X' }]);
  assert.strictEqual(result.stage, 'validateStructure');
  assert.match(result.fatalError.message, /must return either an array/);
});

test('runBatchAdapter reports a fatal error when normalise() throws', async () => {
  const adapter = createFixtureBatchAdapter({
    normalise() { throw new Error('normalise exploded'); },
  });
  const result = await runBatchAdapter(adapter, [{ id: '1', orgName: 'X' }]);
  assert.strictEqual(result.stage, 'normalise');
  assert.match(result.fatalError.message, /normalise exploded/);
});

test('runBatchAdapter treats a non-array normalise() return as fatal', async () => {
  const adapter = createFixtureBatchAdapter({ normalise() { return { not: 'an array' }; } });
  const result = await runBatchAdapter(adapter, [{ id: '1', orgName: 'X' }]);
  assert.strictEqual(result.stage, 'normalise');
  assert.match(result.fatalError.message, /must return an array of canonical records/);
});

// ── runBatchAdapter — refuses to run a non-conforming adapter ───────────────

test('runBatchAdapter refuses a non-conforming adapter before calling any stage', async () => {
  await assert.rejects(() => runBatchAdapter({ sourceId: 'x' }, []), TypeError);
});

// ── validateStructure() convenience shape: bare array of valid rows ─────────

test('runBatchAdapter accepts validateStructure() returning a bare array (no rejections)', async () => {
  const adapter = createFixtureBatchAdapter({
    validateStructure(rows) { return rows; }, // every row valid, no rejected[]
  });
  const result = await runBatchAdapter(adapter, [{ id: '1', orgName: 'Acme Ltd' }]);
  assert.strictEqual(result.fatalError, null);
  assert.strictEqual(result.recordsEmitted, 1);
  assert.strictEqual(result.rowsRejected, 0);
});
