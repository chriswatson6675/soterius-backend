'use strict';

// summarise.test.js — the canonical portfolio-list summary projection.
// resolve.reverse is injected, so these run with no Repository Authority
// dataset on disk.

const { test } = require('node:test');
const assert = require('node:assert');

const { summariseById } = require('./summarise');

const row = {
  organisationId: 'ORG-000038AF3025',
  organisationName: 'KALSI SOLICITORS LIMITED',
  canonicalName: 'KALSI SOLICITORS LIMITED',
  verifiedDomain: 'kalsisolicitors.co.uk',
};

test('summariseById — projects id, name and domain from the Repository Authority row', () => {
  const summary = summariseById('ORG-000038AF3025', { reverse: () => ({ ok: true, row }) });

  assert.deepStrictEqual(summary, {
    id: 'ORG-000038AF3025',
    name: 'KALSI SOLICITORS LIMITED',
    domain: 'kalsisolicitors.co.uk',
    primaryRegulatoryIdentifier: null,
    fullPostcode: null,
    sector: null,
    location: null,
    lastScannedAt: null,
  });
});

test('summariseById — falls back to canonicalName when organisationName is absent', () => {
  const summary = summariseById('ORG-1', {
    reverse: () => ({ ok: true, row: { organisationId: 'ORG-1', canonicalName: 'Fallback Name Ltd', verifiedDomain: null } }),
  });

  assert.strictEqual(summary.name, 'Fallback Name Ltd');
  assert.strictEqual(summary.domain, null);
  assert.strictEqual(summary.primaryRegulatoryIdentifier, null);
  assert.strictEqual(summary.fullPostcode, null);
});

test('summariseById — name is null (never fabricated) when the row carries no name', () => {
  const summary = summariseById('ORG-2', { reverse: () => ({ ok: true, row: { organisationId: 'ORG-2' } }) });

  assert.strictEqual(summary.name, null);
  assert.strictEqual(summary.domain, null);
});

test('summariseById — returns null for an id not in Repository Authority', () => {
  const summary = summariseById('ORG-UNKNOWN0000', { reverse: () => ({ ok: false, error: 'No organisation known' }) });

  assert.strictEqual(summary, null);
});
