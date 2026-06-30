'use strict';

// organisation-provider.test.js — provider factory selection tests.
// Confirms ORG_PROVIDER=sra selects the SRA provider, the existing if/fca/default
// selections are unchanged, and unknown providers fail exactly as before. Selection
// only — no provider is invoked (so no registry/Supabase access).

const { test } = require('node:test');
const assert = require('node:assert');

const { getProvider } = require('./organisation-provider');
const ifProvider  = require('./if-organisation-provider');
const fcaProvider = require('../population-acquisition/fca-organisation-provider');
const sraProvider = require('../population-acquisition/sra-organisation-provider');

function withProvider(v, fn) {
  const prev = process.env.ORG_PROVIDER;
  if (v === undefined) delete process.env.ORG_PROVIDER; else process.env.ORG_PROVIDER = v;
  try { return fn(); } finally { if (prev === undefined) delete process.env.ORG_PROVIDER; else process.env.ORG_PROVIDER = prev; }
}

test('ORG_PROVIDER=sra selects the SRA provider (case-insensitive)', () => {
  withProvider('sra', () => assert.strictEqual(getProvider(), sraProvider));
  withProvider('SRA', () => assert.strictEqual(getProvider(), sraProvider));
});

test('existing selections are unchanged (default/if/if-001 → IF; fca → FCA)', () => {
  withProvider(undefined, () => assert.strictEqual(getProvider(), ifProvider)); // default
  withProvider('if', () => assert.strictEqual(getProvider(), ifProvider));
  withProvider('if-001', () => assert.strictEqual(getProvider(), ifProvider));
  withProvider('fca', () => assert.strictEqual(getProvider(), fcaProvider));
});

test('unknown provider fails exactly as before', () => {
  withProvider('does-not-exist', () => {
    assert.throws(() => getProvider(), /Unknown ORG_PROVIDER 'does-not-exist'/);
  });
});
