'use strict';

// loaders.test.js — regression coverage for the loadPra() fix identified by
// ENG-031: repeated, embedded mid-file section-header rows in the real PRA
// CSVs (datasets/cohort data/pra/) were being parsed as phantom "Firm Name"
// organisations. Reads the real, committed source files (small — a few KB to
// ~110KB each) rather than synthetic fixtures, so this is a direct regression
// test against the exact data that produced the ENG-031 finding.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { loadPra, loadHmrcAmlImport } = require('./loaders');

test('loadPra() never emits a phantom "Firm Name" organisation from a repeated embedded section header', () => {
  const records = loadPra();
  const phantoms = records.filter((r) => r.name === 'Firm Name');
  assert.deepStrictEqual(phantoms, [], 'no record should be named literally "Firm Name" (the header text)');
});

test('loadPra() never emits a record whose FRN is the literal header text "FRN"', () => {
  const records = loadPra();
  const withLiteralFrnText = records.filter((r) => r.frn === 'FRN');
  assert.deepStrictEqual(withLiteralFrnText, []);
});

test('loadPra() never emits the ENG-031 artifact LEI value ("Head Office LEI" as a literal string)', () => {
  const records = loadPra();
  const withArtifactLei = records.filter((r) => r.lei === 'Head Office LEI');
  assert.deepStrictEqual(withArtifactLei, []);
});

test('loadPra() still emits real firms unaffected by the fix', () => {
  const records = loadPra();
  const names = records.map((r) => r.name);
  assert.ok(names.includes('ABN AMRO Bank NV'), 'a real bank from pra-banks-2606.csv must still be present');
  assert.ok(records.some((r) => r.source === 'pra-reference' && r.regulator === 'PRA'));
});

test('loadPra() still emits real LEI values (raw, unnormalised — loaders.js returns identifiers as found, per its own header comment)', () => {
  const records = loadPra();
  const withLei = records.filter((r) => r.lei);
  assert.ok(withLei.length > 0, 'sanity: at least one real record should carry a LEI');
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
