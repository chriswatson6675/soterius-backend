'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { calculateMaterialChange, businessFields } = require('./material-change');

describe('calculateMaterialChange', () => {
  test('returns null when there is no previous Evidence (first-ever observation)', () => {
    const result = calculateMaterialChange(null, { domain: 'example.com', spf_present: true });
    assert.equal(result, null);
  });

  test('returns false when only envelope/bookkeeping fields differ', () => {
    const previous = {
      id: 'aaa', collected_at: '2026-07-01T00:00:00.000Z', collection_run_id: 'run-1',
      collector_version: 'spf-collector@1.0.0', domain: 'example.com', spf_present: true, spf_record: 'v=spf1 -all',
    };
    const fresh = {
      id: 'bbb', collected_at: '2026-07-16T00:00:00.000Z', collection_run_id: 'run-2',
      collector_version: 'spf-collector@1.0.0', domain: 'example.com', spf_present: true, spf_record: 'v=spf1 -all',
    };
    assert.equal(calculateMaterialChange(previous, fresh), false);
  });

  test('returns true when a business field genuinely differs', () => {
    const previous = { id: 'aaa', collected_at: '2026-07-01T00:00:00.000Z', domain: 'example.com', spf_present: true, spf_record: 'v=spf1 -all' };
    const fresh = { id: 'bbb', collected_at: '2026-07-16T00:00:00.000Z', domain: 'example.com', spf_present: false, spf_record: null };
    assert.equal(calculateMaterialChange(previous, fresh), true);
  });

  test('businessFields strips every known envelope column', () => {
    const row = {
      id: '1', created_at: 'x', updated_at: 'x', collected_at: 'x', domain: 'x',
      collection_run_id: 'x', collection_programme_id: 'x', collector: 'x', collector_version: 'x',
      collection_method: 'x', collection_outcome: 'x', organisation_id: 'x', repository_authority_ref: 'x', run_id: 'x',
      dmarc_policy: 'reject',
    };
    assert.deepStrictEqual(businessFields(row), { dmarc_policy: 'reject' });
  });
});
