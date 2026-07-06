'use strict';

// organisation-provider.test.js — provider factory selection tests.
// The Observatory now sources organisations EXCLUSIVELY from the canonical
// Organisation Dataset. This confirms the default and explicit 'canonical'
// selection resolve to the canonical provider, the retired legacy cohort
// registries (if / fca / sra) are rejected, and unknown values fail. Selection
// only — no provider is invoked (so no dataset/Supabase access).

const { test } = require('node:test');
const assert = require('node:assert');

const { getProvider } = require('./organisation-provider');
const canonicalProvider = require('./canonical-organisation-provider');

function withProvider(v, fn) {
  const prev = process.env.ORG_PROVIDER;
  if (v === undefined) delete process.env.ORG_PROVIDER; else process.env.ORG_PROVIDER = v;
  try { return fn(); } finally { if (prev === undefined) delete process.env.ORG_PROVIDER; else process.env.ORG_PROVIDER = prev; }
}

test('default and explicit canonical select the canonical provider (case-insensitive)', () => {
  withProvider(undefined, () => assert.strictEqual(getProvider(), canonicalProvider)); // default
  withProvider('canonical', () => assert.strictEqual(getProvider(), canonicalProvider));
  withProvider('CANONICAL', () => assert.strictEqual(getProvider(), canonicalProvider));
  withProvider('authority', () => assert.strictEqual(getProvider(), canonicalProvider));
});

test('retired legacy cohort registries are rejected', () => {
  for (const key of ['if', 'if-001', 'fca', 'sra']) {
    withProvider(key, () => assert.throws(() => getProvider(), /retired legacy cohort registry/));
  }
});

test('unknown provider fails', () => {
  withProvider('does-not-exist', () => {
    assert.throws(() => getProvider(), /Unknown ORG_PROVIDER 'does-not-exist'/);
  });
});
