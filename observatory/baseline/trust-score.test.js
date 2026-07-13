'use strict';

// Validation of the Trust Score engine against ENG-026's Acceptance Criteria.
// Run: node backend/observatory/baseline/trust-score.test.js
//
// Uses dependency injection (getSignalsForDomain / weightSet overrides) so
// these are true unit tests of computeTrustScore()'s pure-function behaviour
// (AC-2) — no live database dependency.

const assert = require('node:assert');
const test = require('node:test');
const TS = require('./trust-score');
const { computeTrustScore } = require('../aggregation/trust-score-aggregator');

// Appendix C (TSW-W-NOB) reference weight set — SLG-135, sums to 999.
const WEIGHT_SET = {
  weightSetId: 'TSW-W-NOB-TEST',
  methodVersion: 'TSW-METH-v1.0',
  weights: { dmarc: 154, spf: 111, dkim: 108, dnssec: 83, caa: 70, securityheaders: 143, securitytxt: 47, certificate: 124, tls: 94, mtasts: 65 },
};

const OBSERVED = (key, score, label = null) => ({ key, observed: true, score, label, collectedAt: '2026-07-01T00:00:00Z', qualityVersion: '1.0' });
const NON_OBSERVED = (key) => ({ key, observed: false });

const ALL_KEYS = ['spf', 'dkim', 'dmarc', 'dnssec', 'caa', 'securityheaders', 'securitytxt', 'tls', 'certificate', 'mtasts'];

function signalsFrom(scores) {
  // scores: { key: number|null } — null means NON_OBSERVED
  return ALL_KEYS.map((k) => (scores[k] == null ? NON_OBSERVED(k) : OBSERVED(k, scores[k])));
}

test('AC-2: computeTrustScore is a pure function — identical input yields identical output', async () => {
  const scores = { spf: 100, dkim: 62, dmarc: 100, dnssec: 85, caa: 65, securityheaders: 80, securitytxt: 35, tls: 90, certificate: 95, mtasts: 60 };
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const a = await computeTrustScore('example.test', deps);
  const b = await computeTrustScore('example.test', deps);
  assert.deepStrictEqual(a, b);
});

test('AC-3: an all-NON_OBSERVED category contributes (0,0), never (0, weights)', async () => {
  // Category D (tls/certificate/mtasts) entirely unobserved.
  const scores = { spf: 100, dkim: 62, dmarc: 100, dnssec: 85, caa: 65, securityheaders: 80, securitytxt: 35, tls: null, certificate: null, mtasts: null };
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const r = await computeTrustScore('example.test', deps);
  assert.strictEqual(r.categories.D.earned, 0);
  assert.strictEqual(r.categories.D.attainable, 0, 'a wholly-unobserved category must never carry its weight into attainable');
});

test('AC-6: MTA-STS contributes to Category D attainable, not Category A', async () => {
  const scores = { spf: null, dkim: null, dmarc: null, dnssec: null, caa: null, securityheaders: null, securitytxt: null, tls: null, certificate: null, mtasts: 60 };
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const r = await computeTrustScore('example.test', deps);
  assert.strictEqual(r.categories.A.attainable, 0);
  assert.strictEqual(r.categories.D.attainable, WEIGHT_SET.weights.mtasts);
});

test('FLOOR: attainable below 50% of the 999 weight universe yields INSUFFICIENT_OBSERVATION', async () => {
  // Only SPF+DKIM+DMARC observed = 111+108+154 = 373 < FLOOR (500).
  const scores = { spf: 100, dkim: 100, dmarc: 100, dnssec: null, caa: null, securityheaders: null, securitytxt: null, tls: null, certificate: null, mtasts: null };
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const r = await computeTrustScore('example.test', deps);
  assert.strictEqual(r.label, 'INSUFFICIENT_OBSERVATION');
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.attainable, 373);
});

test('full observation, best posture (all final_score 100) scores exactly 999', async () => {
  const scores = Object.fromEntries(ALL_KEYS.map((k) => [k, 100]));
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const r = await computeTrustScore('example.test', deps);
  assert.strictEqual(r.attainable, 999);
  assert.strictEqual(r.earned, 999);
  assert.strictEqual(r.score, 999);
  assert.strictEqual(r.label, 'SCORED');
});

test('mid-tier posture rounds correctly (round_half_up, clamp [1,999])', async () => {
  // earned = 500, attainable = 999 → raw = 500.4995..., round_half_up = 500.
  const scores = Object.fromEntries(ALL_KEYS.map((k) => [k, 50]));
  scores.dmarc = 50; // keep uniform for a predictable E
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const r = await computeTrustScore('example.test', deps);
  assert.strictEqual(r.attainable, 999);
  assert.strictEqual(r.earned, 499.5);
  assert.strictEqual(r.score, 500); // round_half_up(499.5/999*999) = round_half_up(499.5) = 500
});

test('scoreTrust(domain) preserves the pre-migration output shape (score/label/band, categories, signals)', async () => {
  const scores = Object.fromEntries(ALL_KEYS.map((k) => [k, 80]));
  const r = await TS.scoreTrust('example.test', { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET });
  assert.strictEqual(r.rubric, TS.RUBRIC);
  assert.strictEqual(typeof r.score, 'number');
  assert.ok(['SCORED', 'INSUFFICIENT_OBSERVATION'].includes(r.label));
  assert.strictEqual(typeof r.band, 'string');
  assert.ok(r.categories.A && r.categories.B && r.categories.C && r.categories.D);
  assert.ok(Array.isArray(r.signals) && r.signals.length === ALL_KEYS.length);
  assert.strictEqual(r.coreComplete, true);
});

test('NON_OBSERVED signals still appear in signals[] (full internal breakdown, per ENG-026 §8.1/§8.2)', async () => {
  const scores = { spf: 100, dkim: null, dmarc: 100, dnssec: 85, caa: 65, securityheaders: 80, securitytxt: 35, tls: 90, certificate: 95, mtasts: 60 };
  const r = await TS.scoreTrust('example.test', { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET });
  const dkimEntry = r.signals.find((s) => s.id === 'dkim');
  assert.ok(dkimEntry, 'NON_OBSERVED signal must still have an entry');
  assert.strictEqual(dkimEntry.status, 'NON_OBSERVED');
  assert.strictEqual(dkimEntry.earned, 0);
  assert.strictEqual(r.coreComplete, false);
});

test('determinism — TS.scoreTrust identical input yields identical output', async () => {
  const scores = Object.fromEntries(ALL_KEYS.map((k) => [k, 70]));
  const deps = { getSignalsForDomain: async () => signalsFrom(scores), weightSet: WEIGHT_SET };
  const a = await TS.scoreTrust('example.test', deps);
  const b = await TS.scoreTrust('example.test', deps);
  assert.deepStrictEqual(a, b);
});
