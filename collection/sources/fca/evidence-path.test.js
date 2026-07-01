'use strict';

// evidence-path.test.js — Phase 4 path-helper tests (IMP-FCA-001 §4).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ep = require('./evidence-path');

test('safeName keeps dotted endpoint ids and strips unsafe chars', () => {
  assert.strictEqual(ep.safeName('firm.requirements.investmentTypes'), 'firm.requirements.investmentTypes');
  assert.strictEqual(ep.safeName('a/b c'), 'a_b_c');
});

test('path builders compose the run layout', () => {
  const dir = ep.runDir('/runs', 'RID');
  assert.strictEqual(dir, path.join('/runs', 'RID'));
  assert.strictEqual(ep.rawDir(dir), path.join(dir, 'raw'));
  assert.strictEqual(ep.rawFileFor(dir, 'firm.names'), path.join(dir, 'raw', 'firm.names.ndjson'));
  assert.strictEqual(ep.manifestPath(dir), path.join(dir, 'manifest.json'));
});
