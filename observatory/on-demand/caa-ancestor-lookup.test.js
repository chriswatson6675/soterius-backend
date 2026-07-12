'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { collectCaaAncestorPopulation, parentOf, MAX_ANCESTOR_LEVELS } = require('./caa-ancestor-lookup');

// ── parentOf ─────────────────────────────────────────────────────────────────

test('parentOf — strips one label at a time', () => {
  assert.strictEqual(parentOf('mail.eu.example.com'), 'eu.example.com');
  assert.strictEqual(parentOf('eu.example.com'), 'example.com');
});

test('parentOf — stops at two labels (no further parent)', () => {
  assert.strictEqual(parentOf('example.com'), null);
});

// ── The absence-only gate (mirrors resolveRelevantRRset exactly) ────────────

test('target has its own CAA record present — no ancestor lookups at all', async () => {
  const targetFacts = { domain: 'example.com', dns_caa_present: true, caa_records: [{ tag: 'issue', value: 'letsencrypt.org', flags: 0 }] };
  let collectCalls = 0;
  const collect = async () => { collectCalls++; return {}; };

  const population = await collectCaaAncestorPopulation('example.com', targetFacts, { collect });

  assert.strictEqual(collectCalls, 0);
  assert.deepStrictEqual([...population.keys()], ['example.com']);
});

test('target CAA unobserved (null) — no ancestor lookups (Unknown ≠ Absent — never treated as absence)', async () => {
  const targetFacts = { domain: 'example.com', dns_caa_present: null, caa_collection_error: 'DNS_TIMEOUT' };
  let collectCalls = 0;
  const collect = async () => { collectCalls++; return {}; };

  const population = await collectCaaAncestorPopulation('example.com', targetFacts, { collect });

  assert.strictEqual(collectCalls, 0);
  assert.deepStrictEqual([...population.keys()], ['example.com']);
});

// ── Climbing behaviour ───────────────────────────────────────────────────────

test('target absent, immediate parent present — climbs exactly one level and stops', async () => {
  const targetFacts = { domain: 'mail.example.com', dns_caa_present: false, caa_records: [] };
  const parentFacts = { domain: 'example.com', dns_caa_present: true, caa_records: [{ tag: 'issue', value: 'letsencrypt.org', flags: 0 }] };
  const collected = [];
  const collect = async (d) => { collected.push(d); return parentFacts; };

  const population = await collectCaaAncestorPopulation('mail.example.com', targetFacts, { collect });

  assert.deepStrictEqual(collected, ['example.com']);
  assert.deepStrictEqual([...population.keys()].sort(), ['example.com', 'mail.example.com']);
  assert.strictEqual(population.get('example.com').dns_caa_present, true);
});

test('target absent, parent absent, grandparent present — climbs two levels then stops', async () => {
  const targetFacts = { domain: 'a.b.example.com', dns_caa_present: false };
  const responses = {
    'b.example.com': { domain: 'b.example.com', dns_caa_present: false },
    'example.com': { domain: 'example.com', dns_caa_present: true, caa_records: [] },
  };
  const collected = [];
  const collect = async (d) => { collected.push(d); return responses[d]; };

  const population = await collectCaaAncestorPopulation('a.b.example.com', targetFacts, { collect });

  assert.deepStrictEqual(collected, ['b.example.com', 'example.com']);
  assert.strictEqual(population.size, 3);
});

test('no ancestor ever publishes CAA — climbs to the two-label floor and stops (no infinite loop)', async () => {
  const targetFacts = { domain: 'a.b.c.example.com', dns_caa_present: false };
  const collect = async (d) => ({ domain: d, dns_caa_present: false });

  const population = await collectCaaAncestorPopulation('a.b.c.example.com', targetFacts, { collect });

  // a.b.c.example.com -> b.c.example.com -> c.example.com -> example.com -> (parentOf = null, stop)
  assert.deepStrictEqual(
    [...population.keys()].sort(),
    ['a.b.c.example.com', 'b.c.example.com', 'c.example.com', 'example.com'].sort(),
  );
  for (const facts of population.values()) assert.strictEqual(facts.dns_caa_present === true, false);
});

test('a failed ancestor lookup does not abort the climb', async () => {
  const targetFacts = { domain: 'a.b.example.com', dns_caa_present: false };
  const collect = async (d) => {
    if (d === 'b.example.com') throw new Error('DNS timeout');
    return { domain: d, dns_caa_present: true, caa_records: [] };
  };

  const population = await collectCaaAncestorPopulation('a.b.example.com', targetFacts, { collect });

  // b.example.com's failure is swallowed and absent from the population;
  // climbing continues to example.com, which succeeds.
  assert.strictEqual(population.has('b.example.com'), false);
  assert.strictEqual(population.get('example.com').dns_caa_present, true);
});

test('MAX_ANCESTOR_LEVELS bounds a pathologically long, always-absent chain', async () => {
  const domain = Array.from({ length: MAX_ANCESTOR_LEVELS + 5 }, (_, i) => `l${i}`).join('.') + '.example.com';
  const targetFacts = { domain, dns_caa_present: false };
  let calls = 0;
  const collect = async (d) => { calls++; return { domain: d, dns_caa_present: false }; };

  await collectCaaAncestorPopulation(domain, targetFacts, { collect });

  assert.ok(calls <= MAX_ANCESTOR_LEVELS, `expected at most ${MAX_ANCESTOR_LEVELS} ancestor lookups, got ${calls}`);
});

test('default resolver/collector wiring is used when no deps are injected (does not throw on construction)', async () => {
  // Domain already has its own CAA present, so the default collect/resolver
  // path is never actually invoked — this only proves makeCaaResolver()
  // constructs cleanly when reused from run-national.js, with no network call.
  const targetFacts = { domain: 'example.com', dns_caa_present: true };
  const population = await collectCaaAncestorPopulation('example.com', targetFacts);
  assert.deepStrictEqual([...population.keys()], ['example.com']);
});
