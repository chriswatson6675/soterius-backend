'use strict';

// OBS-101 guardrail: mechanical proof that WP-1 introduces zero behavioural
// change. No existing production file may reference this module or its table
// yet — reading/writing observation_states is reserved for future work
// packages (WP-2 onward) to wire in deliberately, one at a time.
//
// Mirrors the CT-1 structural guardrail already used in
// trust-intelligence/triggers/scheduled-regeneration.test.js.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const THIS_DIR = __dirname;

// Directories that never contain production consumers and would only add
// noise/false positives if walked (dependencies, coverage output, etc.).
// 'runs' specifically excludes the large preserved-evidence output trees
// under collection/sources/*/runs/ (real collection-run artefacts, tens of
// thousands of files, not source) — walking them added no coverage and cost
// several minutes.
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'coverage', 'runs']);

function listJsFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (fullPath === THIS_DIR) continue; // this module's own files reference themselves; not a "consumer"
      results = results.concat(listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('OBS-101 zero-consumers guardrail', () => {
  test('no existing production file references observation-state/ or observation_states', () => {
    const offenders = [];
    for (const file of listJsFiles(BACKEND_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/observation-state|observation_states/.test(src)) {
        offenders.push(path.relative(BACKEND_ROOT, file));
      }
    }
    assert.deepStrictEqual(offenders, [], `expected zero consumers of Observation State, found: ${offenders.join(', ')}`);
  });
});
