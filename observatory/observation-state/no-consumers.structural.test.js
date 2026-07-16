'use strict';

// Approved-consumers guardrail for Observation State — originally OBS-101's
// "zero consumers" proof (mechanical evidence that WP-1 introduced no
// behavioural change), now evolved as intended: OBS-102 (DNS collection
// integration, within this same directory) and OBS-103 (the scheduler,
// observatory/observation-scheduler/) are the approved, deliberate
// consumers. This guardrail's ongoing job is to catch any OTHER, unapproved
// file quietly starting to read/write observation_states outside that
// explicit allowlist — e.g. a future TLS/MTA-STS collector or a Trust
// Profile generator reaching in before it's meant to.
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

// Directories explicitly approved to consume Observation State. Adding a new
// entry here is itself the thing this guardrail should make deliberate —
// each addition should correspond to an approved work package (OBS-10x),
// not a silent expansion.
const APPROVED_CONSUMER_DIRS = [
  path.join(__dirname, '..', 'observation-scheduler'), // OBS-103
];

function listJsFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (fullPath === THIS_DIR) continue; // this module's own files reference themselves; not a "consumer"
      if (APPROVED_CONSUMER_DIRS.includes(fullPath)) continue;
      results = results.concat(listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Observation State — approved-consumers guardrail', () => {
  test('no file outside the approved consumer list references observation-state/ or observation_states', () => {
    const offenders = [];
    for (const file of listJsFiles(BACKEND_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/observation-state|observation_states/.test(src)) {
        offenders.push(path.relative(BACKEND_ROOT, file));
      }
    }
    assert.deepStrictEqual(offenders, [], `expected no unapproved consumers of Observation State, found: ${offenders.join(', ')}`);
  });

  test('the approved consumer list itself points at real, existing directories', () => {
    for (const dir of APPROVED_CONSUMER_DIRS) {
      assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `expected ${dir} to exist`);
    }
  });
});
