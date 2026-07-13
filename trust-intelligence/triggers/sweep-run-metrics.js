'use strict';

// Sweep run metrics — Operational Deployment Sprint (ENG-044, 2026-07-13).
//
// Deployment/operational layer, not Trust Intelligence itself: records one
// summary row per invocation of the scheduled-sweep deployment entrypoint
// (run-scheduled-sweep-cli.js) into trust_intelligence_sweep_runs (migration
// 048). generateTrustProfile()/runScheduledSweep() (ENG-029/ENG-032) are
// unaware this module exists — it observes their result, never influences it.

function getClient() {
  return require('../../infra/database').getClient();
}

/**
 * recordCompletedRun({ startedAt, completedAt, policyThresholdMs, populationTotal, result }, deps)
 * result: runScheduledSweep()'s own return shape — { processed, skipped, failed }.
 * populationTotal: the full population size runScheduledSweep() enumerated
 * internally — NOT derivable from `result` alone, since an Organisation that
 * was already current (not stale) appears in none of processed/skipped/failed
 * (scheduled-regeneration.js's own "current — no action taken" branch). The
 * caller (run-scheduled-sweep-cli.js) supplies this from the same population
 * capability runScheduledSweep() itself reads, not a second independent count.
 */
async function recordCompletedRun({ startedAt, completedAt, policyThresholdMs, populationTotal, result }, deps = {}) {
  const client = deps.client || getClient();
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  const { error } = await client.from('trust_intelligence_sweep_runs').insert({
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    policy_threshold_ms: policyThresholdMs,
    population_total: populationTotal,
    processed_count: result.processed.length,
    skipped_count: result.skipped.length,
    failed_count: result.failed.length,
    failed_organisation_ids: result.failed.map((f) => f.organisationId),
    outcome: 'completed',
  });
  if (error) throw new Error(`trust_intelligence_sweep_runs insert failed: ${error.message}`);
}

/**
 * recordCrashedRun({ startedAt, crashedAt, policyThresholdMs, reason }, deps)
 * Used when the sweep invocation itself threw (e.g. SweepMalformedConfigError,
 * or population enumeration failed) before producing a processed/skipped/
 * failed result at all.
 */
async function recordCrashedRun({ startedAt, crashedAt, policyThresholdMs, reason }, deps = {}) {
  const client = deps.client || getClient();
  const durationMs = Date.parse(crashedAt) - Date.parse(startedAt);
  const { error } = await client.from('trust_intelligence_sweep_runs').insert({
    started_at: startedAt,
    completed_at: crashedAt,
    duration_ms: durationMs,
    policy_threshold_ms: policyThresholdMs,
    population_total: 0,
    processed_count: 0,
    skipped_count: 0,
    failed_count: 0,
    failed_organisation_ids: [],
    outcome: 'crashed',
    crash_reason: reason,
  });
  if (error) throw new Error(`trust_intelligence_sweep_runs insert failed: ${error.message}`);
}

/**
 * getRecentRuns(limit, deps) → Array<row>, newest-first. For operational
 * dashboards/monitoring queries (ENG-042 §9's recommended metrics).
 */
async function getRecentRuns(limit = 20, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('trust_intelligence_sweep_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`trust_intelligence_sweep_runs read failed: ${error.message}`);
  return data || [];
}

module.exports = { recordCompletedRun, recordCrashedRun, getRecentRuns };
