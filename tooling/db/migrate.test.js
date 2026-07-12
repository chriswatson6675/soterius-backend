'use strict';

// Regression guard for migration reproducibility (F3). Runs with zero infra as
// part of `npm test`, so a future migration that (a) is forgotten from the
// manifest, (b) duplicates a manifest entry, (c) is ALTERed before/without being
// created, or (d) is FK-referenced before it is created, fails CI immediately
// instead of only surfacing during a from-empty rebuild.

const { test } = require('node:test');
const assert = require('node:assert');
const { verifyManifest, forwardReferenceScan } = require('./migrate.js');

test('migration manifest is a bijection with the .sql files on disk', () => {
  // verifyManifest() prints and hard-exits on drift; on success it returns the
  // ordered list, which is what we assert here.
  const manifest = verifyManifest();
  assert.ok(Array.isArray(manifest) && manifest.length > 0, 'manifest should be a non-empty ordered list');
});

test('no forward-reference or missing-foundational ordering breaks', () => {
  const manifest = verifyManifest();
  const warnings = forwardReferenceScan(manifest);
  assert.deepStrictEqual(warnings, [], `ordering problems:\n${warnings.join('\n')}`);
});
