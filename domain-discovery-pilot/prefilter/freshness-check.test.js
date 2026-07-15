'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkFreshness } = require('./freshness-check');

function fakeFetch(result) {
  return async () => result;
}

test('checkFreshness: CURRENT — resolves and name/postcode consistent', async () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const fetchUrl = fakeFetch({ success: true, body: 'Welcome to ACME WIDGETS LIMITED, SW1A 1AA' });
  const result = await checkFreshness(candidate, 'acme-widgets.com', { fetchUrl });
  assert.equal(result.resolves, true);
  assert.equal(result.verdict, 'CURRENT');
});

test('checkFreshness: STALE — fetch fails to resolve', async () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const fetchUrl = fakeFetch({ success: false, errorType: 'connection_error', error: 'ENOTFOUND' });
  const result = await checkFreshness(candidate, 'acme-widgets.com', { fetchUrl });
  assert.equal(result.resolves, false);
  assert.equal(result.verdict, 'STALE');
});

test('checkFreshness: CONTRADICTORY — resolves but page contradicts name/postcode', async () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: 'SW1A 1AA' };
  const fetchUrl = fakeFetch({ success: true, body: 'This is a completely unrelated business, EH1 1AA' });
  const result = await checkFreshness(candidate, 'acme-widgets.com', { fetchUrl });
  assert.equal(result.resolves, true);
  assert.equal(result.verdict, 'CONTRADICTORY');
});

test('checkFreshness: INCONCLUSIVE — resolves but evidence insufficient (empty page)', async () => {
  const candidate = { businessName: 'Acme Widgets Limited', postcode: '' };
  const fetchUrl = fakeFetch({ success: true, body: '' });
  const result = await checkFreshness(candidate, 'acme-widgets.com', { fetchUrl });
  assert.equal(result.resolves, true);
  assert.equal(result.verdict, 'INCONCLUSIVE');
});

test('checkFreshness: no extra retries beyond the bounded default (maxRetries: 0 passed through)', async () => {
  let seenOptions = null;
  const fetchUrl = async (url, options) => { seenOptions = options; return { success: true, body: 'ACME WIDGETS LIMITED' }; };
  await checkFreshness({ businessName: 'Acme Widgets Limited', postcode: '' }, 'acme-widgets.com', { fetchUrl });
  assert.equal(seenOptions.maxRetries, 0);
});
