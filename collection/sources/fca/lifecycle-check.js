'use strict';

// lifecycle-check.js — Phase 2 Collection Run verification harness (IMP-FCA-001 §2).
//
// Demonstrates the run lifecycle WITHOUT any network, preservation, or collection:
//   - a valid run reaches `ready` then seals to `completed` (empty run);
//   - an invalid-config run fails at preconditions;
//   - run ids are unique.
// Concise summary output only. No credential is printed.

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const { loadConfig } = require('./fca-client');
const { createRun } = require('./collection-run');

function line(label, value) { console.log('    ' + label.padEnd(14) + ': ' + value); }

console.log('\n  FCA Collection Run lifecycle check (Phase 2)');
console.log('  ────────────────────────────────────────────');

// 1. Valid run from real configuration → ready → completed (empty).
const good = createRun({ config: loadConfig() });
good.initialise();
const sealed = good.complete();
console.log('  [valid run]');
line('run id', sealed.runId);
line('states', good.history().map((h) => h.state).join(' → '));
line('sealed', String(Object.isFrozen(sealed)));
line('apiVersion', sealed.apiVersion);
line('auth', `email=${sealed.authContext.emailConfigured} key=${sealed.authContext.apiKeyConfigured}`);

// 2. Invalid config → failed at preconditions.
const bad = createRun({ config: { email: null, apiKey: null, baseUrl: 'https://register.fca.org.uk/services/V0.1', apiVersion: 'V0.1' } });
const r = bad.initialise();
console.log('  [invalid run]');
line('state', bad.state);
line('errors', r.errors.join('; '));

// 3. Uniqueness.
const ids = new Set([createRun({}).id, createRun({}).id, createRun({}).id]);
console.log('  [uniqueness]');
line('3 ids unique', String(ids.size === 3));

console.log('\n  Result        : ' + (sealed.state === 'completed' && bad.state === 'failed' && ids.size === 3 ? 'LIFECYCLE OK ✓' : 'FAILED ✗'));
console.log('');
