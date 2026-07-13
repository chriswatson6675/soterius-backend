'use strict';

// Regression tests for BUG-2 (Implementation Readiness Sprint, 2026-07-13):
// this adapter called chClient.getJson() with no rateManager at all, so a
// full Repository Authority sweep (~30,000+ live Companies House lookups)
// would blow through CH's 600-requests/5-minutes budget almost immediately
// and then get rate-limited for the rest of the run, with no backoff.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = process.env.COMPANIES_HOUSE_API_KEY;

describe('BUG-2 regression — Companies House rate manager wiring', () => {
  beforeEach(() => {
    process.env.COMPANIES_HOUSE_API_KEY = 'test-key';
  });

  test('getCompanyProfile always passes a rateManager to chClient.getJson', async () => {
    delete require.cache[require.resolve('./companiesHouse')];
    const companiesHouse = require('./companiesHouse');
    companiesHouse._resetRateManagerForTests();

    const chClient = require('../../collection/sources/companies-house/ch-client');
    const originalGetJson = chClient.getJson;
    let capturedRateManager;
    chClient.getJson = async (url, opts) => {
      capturedRateManager = opts.rateManager;
      return { errorType: 'NONE', httpStatus: 200, body: { company_number: '00000001', company_name: 'Test Ltd' } };
    };

    try {
      await companiesHouse.getCompanyProfile('00000001');
      assert.ok(capturedRateManager, 'a rateManager must be supplied by default');
      assert.strictEqual(typeof capturedRateManager.waitForSlot, 'function');
      assert.strictEqual(typeof capturedRateManager.record429, 'function');
    } finally {
      chClient.getJson = originalGetJson;
    }
  });

  test('searchCompanies always passes a rateManager to chClient.getJson', async () => {
    delete require.cache[require.resolve('./companiesHouse')];
    const companiesHouse = require('./companiesHouse');
    companiesHouse._resetRateManagerForTests();

    const chClient = require('../../collection/sources/companies-house/ch-client');
    const originalGetJson = chClient.getJson;
    let capturedRateManager;
    chClient.getJson = async (url, opts) => {
      capturedRateManager = opts.rateManager;
      return { errorType: 'NONE', httpStatus: 200, body: { items: [] } };
    };

    try {
      await companiesHouse.searchCompanies('test query');
      assert.ok(capturedRateManager, 'a rateManager must be supplied by default');
    } finally {
      chClient.getJson = originalGetJson;
    }
  });

  test('the SAME rateManager instance is reused across repeated calls (not recreated per-request)', async () => {
    delete require.cache[require.resolve('./companiesHouse')];
    const companiesHouse = require('./companiesHouse');
    companiesHouse._resetRateManagerForTests();

    const chClient = require('../../collection/sources/companies-house/ch-client');
    const originalGetJson = chClient.getJson;
    const captured = [];
    chClient.getJson = async (url, opts) => {
      captured.push(opts.rateManager);
      return { errorType: 'NONE', httpStatus: 200, body: { company_number: '00000001' } };
    };

    try {
      await companiesHouse.getCompanyProfile('00000001');
      await companiesHouse.getCompanyProfile('00000002');
      await companiesHouse.getCompanyProfile('00000003');
      assert.strictEqual(captured[0], captured[1], 'rate limiting state must be shared, not reset, between requests');
      assert.strictEqual(captured[1], captured[2]);
    } finally {
      chClient.getJson = originalGetJson;
    }
  });

  test('an injected deps.rateManager overrides the shared singleton (test seam works)', async () => {
    delete require.cache[require.resolve('./companiesHouse')];
    const companiesHouse = require('./companiesHouse');
    companiesHouse._resetRateManagerForTests();

    const chClient = require('../../collection/sources/companies-house/ch-client');
    const originalGetJson = chClient.getJson;
    let capturedRateManager;
    chClient.getJson = async (url, opts) => {
      capturedRateManager = opts.rateManager;
      return { errorType: 'NONE', httpStatus: 200, body: {} };
    };
    const fakeRateManager = { waitForSlot: async () => {}, record429: () => {} };

    try {
      await companiesHouse.getCompanyProfile('00000001', { rateManager: fakeRateManager });
      assert.strictEqual(capturedRateManager, fakeRateManager);
    } finally {
      chClient.getJson = originalGetJson;
    }
  });
});

process.env.COMPANIES_HOUSE_API_KEY = ORIGINAL_ENV;
