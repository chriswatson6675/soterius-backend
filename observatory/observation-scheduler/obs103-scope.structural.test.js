'use strict';

// OBS-103 scope guardrail — mirrors obs102-scope.structural.test.js. None of
// this work package's own files may reference Companies House/FCA/SRA
// collection, Trust Profile generation, or any cron/scheduler activation
// mechanism (Railway cronSchedule, node-cron, a persistent worker process).

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const THIS_DIR = __dirname;

const OBS103_FILES = fs.readdirSync(THIS_DIR)
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  .map((name) => path.join(THIS_DIR, name));

const FORBIDDEN_PATTERNS = [
  { name: 'Companies House', pattern: /companies-house|companiesHouse|companies_house/ },
  { name: 'FCA', pattern: /\bfca\b|\bFCA\b/ },
  { name: 'SRA', pattern: /collection\/sources\/sra|sraClient|sra-client/ },
  { name: 'Trust Profile generation', pattern: /generateTrustProfile|generate-trust-profile|trust-intelligence\/store/ },
  { name: 'cron/scheduler activation', pattern: /cronSchedule|railway\.[a-z-]*\.json|node-cron/ },
  { name: 'a queue framework', pattern: /bullmq|BullMQ|require\(['"]bull['"]\)|agenda|ioredis|require\(['"]redis['"]\)/ },
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('OBS-103 scope guardrail', () => {
  for (const file of OBS103_FILES) {
    const basename = path.basename(file);
    test(`${basename} references none of the OBS-103 excluded systems`, () => {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const offenders = FORBIDDEN_PATTERNS.filter((f) => f.pattern.test(src)).map((f) => f.name);
      assert.deepStrictEqual(offenders, [], `${basename} unexpectedly references: ${offenders.join(', ')}`);
    });
  }

  test('at least the expected OBS-103 files were actually checked', () => {
    const basenames = OBS103_FILES.map((f) => path.basename(f));
    for (const expected of ['due-selection.js', 'claim.js', 'run-scheduler.js', 'run-scheduler-cli.js']) {
      assert.ok(basenames.includes(expected), `expected ${expected} to be present and checked`);
    }
  });

  test('no MTA-STS/security-headers/security.txt/TLS/certificate/general-DNS-health signal is scheduled', () => {
    const { DNS_OBSERVATION_TYPES } = require('../observation-state/dns-signal-collection');
    assert.deepStrictEqual(DNS_OBSERVATION_TYPES, ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);
  });
});
