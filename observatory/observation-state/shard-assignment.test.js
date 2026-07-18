'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./shard-assignment');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

describe('shard-assignment — stable hashing and slot ranges', () => {
  test('fnv1a32 is deterministic and unsigned 32-bit', () => {
    assert.equal(s.fnv1a32('ORG-111BB396F405'), s.fnv1a32('ORG-111BB396F405'));
    assert.ok(s.fnv1a32('anything') >= 0 && s.fnv1a32('anything') <= 0xffffffff);
  });

  // Fixed regression vectors — lock the exact slots for the five production
  // pilot organisations so any change to the hash/salts/bucket-count is caught.
  test('fixed vectors for the five pilot organisations do not silently change', () => {
    const expected = {
      'ORG-111BB396F405': { daily: 70, weekly: 280 },
      'ORG-022966B7A563': { daily: 57, weekly: 81 },
      'ORG-008B5C6DDCA9': { daily: 39, weekly: 635 },
      'ORG-00A735D8BF71': { daily: 62, weekly: 416 },
      'ORG-FFE3D2E76F65': { daily: 23, weekly: 43 },
    };
    for (const [id, e] of Object.entries(expected)) {
      assert.equal(s.dailySlotIndex(id), e.daily, `${id} daily slot`);
      assert.equal(s.weeklySlotIndex(id), e.weekly, `${id} weekly slot`);
    }
  });

  test('daily slot is always an integer in [0, 96)', () => {
    for (let i = 0; i < 5000; i += 1) {
      const v = s.dailySlotIndex(`ORG-RANGE-${i}`);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 96);
    }
  });

  test('weekly slot is always an integer in [0, 672)', () => {
    for (let i = 0; i < 5000; i += 1) {
      const v = s.weeklySlotIndex(`ORG-RANGE-${i}`);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 672);
    }
  });

  test('assignment depends only on identity — adding organisations never moves an existing one', () => {
    const before = s.dailySlotIndex('ORG-STABLE');
    for (let i = 0; i < 1000; i += 1) s.dailySlotIndex(`ORG-NEW-${i}`); // "add" others
    assert.equal(s.dailySlotIndex('ORG-STABLE'), before);
  });

  test('epoch anchor is a Monday 00:00:00 UTC', () => {
    const d = new Date(s.EPOCH_ANCHOR_MS);
    assert.equal(d.getUTCDay(), 1); // Monday
    assert.equal(d.getUTCHours(), 0);
    assert.equal(d.getUTCMinutes(), 0);
  });
});

describe('shard-assignment — approximately uniform distribution (16,167 fixtures)', () => {
  const N = 16167;
  test('daily slots: no empty slot; max/mean within a sane bound', () => {
    const counts = new Array(96).fill(0);
    for (let i = 0; i < N; i += 1) counts[s.dailySlotIndex(`ORG-FIXTURE-${i}`)] += 1;
    const mean = N / 96;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    assert.ok(min > 0, 'no empty daily slot');
    assert.ok(max < mean * 1.5, `max daily slot ${max} within 1.5x mean ${mean.toFixed(1)}`);
  });
  test('weekly slots: no empty slot; max/mean within a sane bound', () => {
    const counts = new Array(672).fill(0);
    for (let i = 0; i < N; i += 1) counts[s.weeklySlotIndex(`ORG-FIXTURE-${i}`)] += 1;
    const mean = N / 672;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    assert.ok(min > 0, 'no empty weekly slot');
    assert.ok(max < mean * 2.2, `max weekly slot ${max} within 2.2x mean ${mean.toFixed(2)}`);
  });
});

describe('shard-assignment — next-slot instant math', () => {
  const ORG = 'ORG-SLOTMATH';

  test('nextDailySlotInstantAfter is strictly after ms and on the assigned slot', () => {
    const slot = s.dailySlotIndex(ORG);
    const ms = Date.parse('2026-03-10T00:00:00.000Z');
    const t = s.nextDailySlotInstantAfter(ORG, ms);
    assert.ok(t > ms);
    const d = new Date(t);
    assert.equal(d.getUTCHours() * 4 + d.getUTCMinutes() / 15, slot);
  });

  test('daily: completion after the slot rolls to tomorrow', () => {
    const slot = s.dailySlotIndex(ORG);
    const min = slot * 15;
    const atOrAfter = Date.UTC(2026, 2, 10, Math.floor(min / 60), min % 60, 0);
    const t = s.nextDailySlotInstantAfter(ORG, atOrAfter);
    assert.equal(new Date(t).getUTCDate(), 11);
  });

  test('weekly: instant sits on the epoch grid and is strictly after ms', () => {
    const slot = s.weeklySlotIndex(ORG);
    const ms = Date.parse('2026-03-10T00:00:00.000Z');
    const t = s.nextWeeklySlotInstantAfter(ORG, ms);
    assert.ok(t > ms);
    assert.equal((t - s.EPOCH_ANCHOR_MS) % WEEK_MS, slot * s.SLOT_MS);
  });

  test('weekly: multi-cycle-late completion still returns exactly one grid position ahead', () => {
    const ms = Date.parse('2026-01-01T00:00:00.000Z');
    const t = s.nextWeeklySlotInstantAfter(ORG, ms);
    assert.ok(t - ms <= WEEK_MS);
  });

  test('nextQuarterHourAfter returns the next :00/:15/:30/:45 boundary strictly after ms', () => {
    assert.equal(new Date(s.nextQuarterHourAfter(Date.parse('2026-03-10T12:07:00.000Z'))).toISOString(), '2026-03-10T12:15:00.000Z');
    assert.equal(new Date(s.nextQuarterHourAfter(Date.parse('2026-03-10T12:15:00.000Z'))).toISOString(), '2026-03-10T12:30:00.000Z');
  });

  test('grid tiles perfectly: 96 daily slots = 24h, 672 weekly slots = 7d', () => {
    assert.equal(s.DAILY_SLOTS * s.SLOT_MS, DAY_MS);
    assert.equal(s.WEEKLY_SLOTS * s.SLOT_MS, WEEK_MS);
  });
});

describe('cohortRank — deterministic provisioning rank (OBS-103)', () => {
  test('same organisation id always returns the same unsigned 32-bit rank', () => {
    assert.equal(s.cohortRank('ORG-111BB396F405'), s.cohortRank('ORG-111BB396F405'));
    const v = s.cohortRank('ORG-ANYTHING');
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  });

  // Fixed regression vectors — lock the exact cohort rank for the five pilots so
  // any change to the hash or the :cohort:v1 salt is caught.
  test('fixed cohort-rank vectors for the five pilot organisations do not silently change', () => {
    const expected = {
      'ORG-111BB396F405': 2386223014,
      'ORG-022966B7A563': 953460703,
      'ORG-008B5C6DDCA9': 1670045937,
      'ORG-00A735D8BF71': 2649440398,
      'ORG-FFE3D2E76F65': 1935211745,
    };
    for (const [id, r] of Object.entries(expected)) {
      assert.equal(s.cohortRank(id), r, `${id} cohort rank`);
    }
  });

  test('cohort rank is statistically independent of the scheduling salts (different salt → different value)', () => {
    // Not a claim of cryptographic independence; just proof the cohort salt is
    // actually applied and not accidentally reusing a scheduling salt output.
    const id = 'ORG-SALT-CHECK';
    assert.notEqual(s.cohortRank(id), s.fnv1a32(id + ':daily:v1'));
    assert.notEqual(s.cohortRank(id), s.fnv1a32(id + ':weekly:v1'));
    assert.notEqual(s.cohortRank(id), s.fnv1a32(id + ':retry:v1'));
    assert.equal(s.cohortRank(id), s.fnv1a32(id + s.COHORT_SALT));
  });

  test('adding cohortRank left daily/weekly/retry outputs unchanged (regression, 2000 ids)', () => {
    // Independent recomputation of the exact formulas the scheduler relies on —
    // catches any accidental cross-contamination from the new export.
    for (let i = 0; i < 2000; i += 1) {
      const id = `ORG-REG-${i}`;
      assert.equal(s.dailySlotIndex(id), s.fnv1a32(id + ':daily:v1') % s.DAILY_SLOTS);
      assert.equal(s.weeklySlotIndex(id), s.fnv1a32(id + ':weekly:v1') % s.WEEKLY_SLOTS);
      assert.equal(s.retrySpreadOffsetSlots(id), s.fnv1a32(id + ':retry:v1') % s.RETRY_SPREAD_BUCKETS);
    }
  });
});
