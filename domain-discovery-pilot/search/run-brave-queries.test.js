'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runBraveQueries } = require('./run-brave-queries');

function fakeHttpGet(rawData) {
  return async () => ({
    data: rawData,
    headers: { 'x-request-id': 'req-123' },
  });
}

test('runBraveQueries: captures the full raw Brave response for persistence', async () => {
  const rawData = { web: { results: [{ url: 'https://acme-widgets.com/', title: 'Acme', description: 'desc' }] } };
  const httpGet = fakeHttpGet(rawData);
  const results = await runBraveQueries([{ queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme"' }], { httpGet, apiKey: 'fake-key' });
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
  assert.deepEqual(results[0].rawResponse, rawData);
  assert.equal(results[0].requestId, 'req-123');
});

test('runBraveQueries: filters excluded domains out of usableResults but keeps them in allResults', async () => {
  const rawData = {
    web: {
      results: [
        { url: 'https://acme-widgets.com/', title: 'Acme', description: 'd' },
        { url: 'https://www.linkedin.com/company/acme', title: 'LinkedIn', description: 'd' },
      ],
    },
  };
  const httpGet = fakeHttpGet(rawData);
  const results = await runBraveQueries([{ queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme"' }], { httpGet, apiKey: 'fake-key' });
  assert.equal(results[0].allResults.length, 2);
  assert.equal(results[0].usableResults.length, 1);
  assert.equal(results[0].usableResults[0].normalisedDomain, 'acme-widgets.com');
});

test('runBraveQueries: applies normaliseDomain before exclusion matching', async () => {
  const rawData = { web: { results: [{ url: 'https://www.acme-widgets.com/about', title: 'Acme', description: 'd' }] } };
  const httpGet = fakeHttpGet(rawData);
  const results = await runBraveQueries([{ queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme"' }], { httpGet, apiKey: 'fake-key' });
  assert.equal(results[0].usableResults[0].normalisedDomain, 'acme-widgets.com');
});

test('runBraveQueries: runs multiple queries independently, each with its own captured raw response', async () => {
  let call = 0;
  const httpGet = async () => {
    call += 1;
    return { data: { web: { results: [{ url: `https://result${call}.example.com/`, title: 't', description: 'd' }] } }, headers: {} };
  };
  const results = await runBraveQueries([
    { queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme" SW1A 1AA' },
    { queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme" official website' },
  ], { httpGet, apiKey: 'fake-key' });
  assert.equal(results.length, 2);
  assert.equal(results[0].usableResults[0].normalisedDomain, 'result1.example.com');
  assert.equal(results[1].usableResults[0].normalisedDomain, 'result2.example.com');
});

test('runBraveQueries: surfaces provider failure without throwing', async () => {
  const results = await runBraveQueries([{ queryTemplateVersion: 'DDP-QT-v1.0', queryString: '"Acme"' }], { apiKey: undefined, httpGet: async () => { throw new Error('should not be called'); } });
  assert.equal(results[0].success, false);
  assert.equal(results[0].error.errorType, 'not_configured');
});
