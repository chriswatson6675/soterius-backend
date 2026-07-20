'use strict';

// loaders.test.js — unit coverage for loadPra()'s CSV parsing and repeated
// embedded section-header handling. The fixtures are backend-owned and
// synthetic so this suite remains valid in a standalone backend checkout.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { loadPra, loadHmrcAmlImport } = require('./loaders');
const PRA_FIXTURE_DIR = path.join(__dirname, 'test-fixtures', 'pra');
const loadFixturePra = () => loadPra({ praDataDir: PRA_FIXTURE_DIR });

test('loadPra() never emits a phantom "Firm Name" organisation from a repeated embedded section header', () => {
  const records = loadFixturePra();
  const phantoms = records.filter((r) => r.name === 'Firm Name');
  assert.deepStrictEqual(phantoms, [], 'no record should be named literally "Firm Name" (the header text)');
});

test('loadPra() never emits a record whose FRN is the literal header text "FRN"', () => {
  const records = loadFixturePra();
  const withLiteralFrnText = records.filter((r) => r.frn === 'FRN');
  assert.deepStrictEqual(withLiteralFrnText, []);
});

test('loadPra() never emits the ENG-031 artifact LEI value ("Head Office LEI" as a literal string)', () => {
  const records = loadFixturePra();
  const withArtifactLei = records.filter((r) => r.lei === 'Head Office LEI');
  assert.deepStrictEqual(withArtifactLei, []);
});

test('loadPra() emits organisations from every supported PRA category', () => {
  const records = loadFixturePra();
  const names = records.map((r) => r.name);
  assert.ok(names.includes('Northbridge Synthetic Bank'));
  assert.deepStrictEqual(
    new Set(records.map((r) => path.basename(r.provenance.file))),
    new Set([
      'pra-banks-2606.csv',
      'pra-building-societies-2606.csv',
      'pra-credit-unions-2606.csv',
      'pra-insurers-2606.csv',
      'pra-designated-firms.csv',
    ]),
  );
});

test('loadPra() extracts valid-format LEI values without normalising them', () => {
  const records = loadFixturePra();
  const withLei = records.filter((r) => r.lei);
  assert.ok(withLei.length > 0);
  assert.ok(withLei.some((r) => r.lei === '549300SYNTHETIC00045'));
});

// --- loadHmrcAmlImport() (ENG-024 WP-3) -------------------------------------
// Reads back the WP-2 adapter's canonical output for the most recent admin
// upload (backend/api/routes/population-imports.js writes this file). The
// fixed path is a real repository path (not injectable — every other loader
// in this file reads a fixed path too), so the "file exists" case creates
// and removes it around the assertion, guarding against clobbering a real
// pending import if one somehow already existed on disk.
const HMRC_AML_IMPORT_PATH = path.join(__dirname, 'inputs', 'hmrc-aml-import.ndjson');

test('loadHmrcAmlImport() returns [] when no import has ever been uploaded', () => {
  assert.ok(!fs.existsSync(HMRC_AML_IMPORT_PATH), 'precondition: no real import file should exist in a clean checkout');
  assert.deepStrictEqual(loadHmrcAmlImport(), []);
});

test('loadHmrcAmlImport() reads back exactly what was written, performing no re-parsing of its own', () => {
  assert.ok(!fs.existsSync(HMRC_AML_IMPORT_PATH), 'precondition: no real import file should exist in a clean checkout');
  const records = [
    { source: 'hmrc-aml', name: 'POST OFFICE LIMITED', hmrcAml: '12137104' },
  ];
  fs.writeFileSync(HMRC_AML_IMPORT_PATH, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    assert.deepStrictEqual(loadHmrcAmlImport(), records);
  } finally {
    fs.unlinkSync(HMRC_AML_IMPORT_PATH);
  }
});
