'use strict';

// Full-population draining scheduler — OBS-103 (full-coverage transition).
//
// The bounded, unattended production path: one invocation drains DUE observation
// states page by page, up to an explicit work budget, then exits cleanly leaving
// any remaining work due for the next 15-minute Railway wake. It never performs
// an unbounded in-memory read of all ~80,835 states, and it reuses the existing
// atomic claim + per-signal observation primitives unchanged.
//
// Distinct from run-scheduler.js's --org/--limit path, which stays as the
// targeted tool for local testing, controlled cohorts, single-organisation
// diagnosis, and incident response. This module is the "process whatever is due"
// production mode.

const { findDuePage, DEFAULT_PAGE_SIZE } = require('./due-selection');
const { claimDueObservationStates } = require('./claim');
const { observeOrganisationDnsSignals } = require('../observation-state/observe-organisation');

function getClient() { return require('../../infra/database').getClient(); }

const DEFAULT_MAX_STATES_PER_RUN = 1500; // safely above the observed worst-case dense-slot load (~672)
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RUNTIME_BUDGET_MS = 12 * 60 * 1000; // comfortably below the 15-minute wake interval

/**
 * runPool(items, concurrency, worker) — bounded-concurrency map with no external
 * deps. At most `concurrency` workers run at once; each pulls the next index
 * until the list is exhausted. A worker that throws rejects the pool (callers
 * wrap per-item work so one item's failure never aborts the batch).
 */
async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const runners = new Array(lanes).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor; cursor += 1;
      // eslint-disable-next-line no-await-in-loop -- serial within a lane by design
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function emptySummary() {
  return {
    pagesFetched: 0, statesSeen: 0, orgsProcessed: 0,
    statesClaimed: 0, statesCompleted: 0, statesFailed: 0, statesSkipped: 0,
    stoppedReason: null, budgetExhausted: false,
  };
}

/**
 * drainDueStates(opts, deps) → summary
 *
 * opts:
 *   now             ISO string wall-clock for this invocation (defaults real clock)
 *   pageSize        rows fetched per due page (bounded memory)
 *   maxStatesPerRun soft cap on states CLAIMED this invocation (the work budget);
 *                   bounded overshoot of at most concurrency × maxTypesPerOrg,
 *                   since in-flight lanes pass their budget check before it trips
 *   concurrency     max organisations processed concurrently
 *   runtimeBudgetMs hard wall-clock cap; the invocation exits cleanly when reached
 *
 * Guarantees: bounded memory (never reads more than one page at a time); bounded
 * work (stops at the state budget or runtime budget); deterministic, oldest-due
 * -first ordering (no starvation); atomic per-row claims (safe under overlapping
 * wakes); remaining due work is simply left due for the next wake.
 */
async function drainDueStates({
  now = null,
  pageSize = DEFAULT_PAGE_SIZE,
  maxStatesPerRun = DEFAULT_MAX_STATES_PER_RUN,
  concurrency = DEFAULT_CONCURRENCY,
  runtimeBudgetMs = DEFAULT_RUNTIME_BUDGET_MS,
} = {}, deps = {}) {
  const log = deps.log || (() => {});
  const client = deps.client || getClient();
  // Wall clock for every persisted timestamp and due comparison. Precedence:
  // an explicit injected clock (deps.now) → the fixed `now` option (a supplied
  // invocation instant) → the real clock. The `now` option lets a caller/test
  // pin the invocation time deterministically.
  const nowFn = deps.now || (now ? () => now : () => new Date().toISOString());
  // Monotonic clock for the runtime budget only (injectable for tests). Never
  // used for any persisted timestamp — those come from nowFn / the DB.
  const monotonic = deps.monotonic || (() => Date.now());
  const findPage = deps.findDuePage || findDuePage;
  const claim = deps.claimDueObservationStates || claimDueObservationStates;
  const observe = deps.observeOrganisationDnsSignals || observeOrganisationDnsSignals;

  const startedAt = monotonic();
  const summary = emptySummary();
  const budgetReached = () => summary.statesClaimed >= maxStatesPerRun;
  const timeReached = () => (monotonic() - startedAt) >= runtimeBudgetMs;

  log(`OBS-103 drain: start — pageSize=${pageSize} maxStatesPerRun=${maxStatesPerRun} concurrency=${concurrency} runtimeBudgetMs=${runtimeBudgetMs}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (budgetReached()) { summary.stoppedReason = 'work-budget'; summary.budgetExhausted = true; break; }
    if (timeReached()) { summary.stoppedReason = 'runtime-budget'; summary.budgetExhausted = true; break; }

    const nowIso = nowFn();
    // eslint-disable-next-line no-await-in-loop
    const page = await findPage({ now: nowIso, pageSize }, { client });
    summary.pagesFetched += 1;
    if (page.length === 0) { summary.stoppedReason = summary.stoppedReason || 'drained'; break; }
    summary.statesSeen += page.length;

    // Group the page by organisation (stable order), collecting each org's due
    // types so domain resolution happens once per org and only genuinely-due
    // signals are claimed/collected.
    const order = [];
    const dueTypesByOrg = new Map();
    for (const c of page) {
      if (!dueTypesByOrg.has(c.organisationId)) { dueTypesByOrg.set(c.organisationId, []); order.push(c.organisationId); }
      dueTypesByOrg.get(c.organisationId).push(c.observationType);
    }

    const claimedBefore = summary.statesClaimed;
    let stoppedMidPage = false;

    // eslint-disable-next-line no-await-in-loop
    await runPool(order, concurrency, async (organisationId) => {
      if (budgetReached() || timeReached()) { stoppedMidPage = true; return; }
      const types = dueTypesByOrg.get(organisationId);
      let claimRes;
      try {
        claimRes = await claim(organisationId, types, { client, now: nowFn });
      } catch (err) {
        summary.statesFailed += types.length;
        log(`  ${organisationId}: claim error — ${err.message}`);
        return;
      }
      summary.statesClaimed += claimRes.claimedTypes.length;
      summary.statesSkipped += claimRes.skippedTypes.length;
      if (!claimRes.claimed) return;
      summary.orgsProcessed += 1;
      let obs;
      try {
        obs = await observe(organisationId, { ...(deps.observeDeps || {}), signalTypes: claimRes.claimedTypes });
      } catch (err) {
        summary.statesFailed += claimRes.claimedTypes.length;
        log(`  ${organisationId}: observation error — ${err.message}`);
        return;
      }
      if (!obs.ok) {
        summary.statesFailed += claimRes.claimedTypes.length;
        log(`  ${organisationId}: no observation attempted — ${obs.error}`);
        return;
      }
      for (const r of obs.results) {
        if (r.ok) summary.statesCompleted += 1; else summary.statesFailed += 1;
      }
    });

    if (stoppedMidPage) {
      summary.stoppedReason = budgetReached() ? 'work-budget' : 'runtime-budget';
      summary.budgetExhausted = true;
      break;
    }
    // Progress guard: if a full page yielded no new claims, everything on it was
    // raced away (now 'running' elsewhere) and will have left the due set — stop
    // rather than spin; the next wake picks up whatever is genuinely still due.
    if (summary.statesClaimed === claimedBefore) {
      summary.stoppedReason = 'contended-no-progress';
      break;
    }
    log(`OBS-103 drain: page ${summary.pagesFetched} — seen ${page.length}, claimed-so-far ${summary.statesClaimed}, completed ${summary.statesCompleted}, failed ${summary.statesFailed}`);
  }

  log(`OBS-103 drain: done — reason=${summary.stoppedReason} pages=${summary.pagesFetched} seen=${summary.statesSeen} orgs=${summary.orgsProcessed} claimed=${summary.statesClaimed} completed=${summary.statesCompleted} failed=${summary.statesFailed} skipped=${summary.statesSkipped}`);
  return summary;
}

module.exports = {
  drainDueStates,
  runPool,
  DEFAULT_MAX_STATES_PER_RUN,
  DEFAULT_CONCURRENCY,
  DEFAULT_RUNTIME_BUDGET_MS,
};
