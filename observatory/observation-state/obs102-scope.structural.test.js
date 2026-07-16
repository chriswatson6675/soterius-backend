'use strict';

// OBS-102 scope guardrail: the task's explicit exclusions are enforced
// mechanically, not just by convention — none of this work package's own
// files may reference Companies House/FCA/SRA collection, Trust Profile
// generation, or any cron/scheduler activation mechanism.

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const THIS_DIR = __dirname;

const OBS102_FILES = fs.readdirSync(THIS_DIR)
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  .map((name) => path.join(THIS_DIR, name));

// Strip comments before scanning — this file's own (and other OBS-102
// files') explanatory prose legitimately names the excluded systems to
// document why they're absent; only actual code (require calls, identifiers)
// should trip the guardrail.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN_PATTERNS = [
  { name: 'Companies House', pattern: /companies-house|companiesHouse|companies_house/ },
  { name: 'FCA', pattern: /\bfca\b|\bFCA\b/ },
  { name: 'SRA', pattern: /collection\/sources\/sra|sraClient|sra-client/ },
  { name: 'Trust Profile generation', pattern: /generateTrustProfile|generate-trust-profile|trust-intelligence\/store/ },
  { name: 'cron/scheduler activation', pattern: /cronSchedule|railway\.[a-z-]*\.json|node-cron/ },
];

describe('OBS-102 scope guardrail', () => {
  for (const file of OBS102_FILES) {
    const basename = path.basename(file);
    test(`${basename} references none of the OBS-102 excluded systems`, () => {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const offenders = FORBIDDEN_PATTERNS.filter((f) => f.pattern.test(src)).map((f) => f.name);
      assert.deepStrictEqual(offenders, [], `${basename} unexpectedly references: ${offenders.join(', ')}`);
    });
  }

  test('at least the expected OBS-102 files were actually checked (guards against an empty/no-op sweep)', () => {
    const basenames = OBS102_FILES.map((f) => path.basename(f));
    for (const expected of ['dns-signal-collection.js', 'observe-organisation.js', 'run-dns-observation-cli.js', 'cadence-policy.js', 'material-change.js', 'cohort-selection.js']) {
      assert.ok(basenames.includes(expected), `expected ${expected} to be present and checked`);
    }
  });
});
