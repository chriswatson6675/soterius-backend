'use strict';

// progress-ledger.js — production-hardening (Blocker 4): crash-safe resume.
//
// The ledger records, per Collection Run, the collection state of each intended
// organisation (by domain). It is the durable execution progress that makes a run
// resumable: after a crash, a restarted run reads the ledger, skips every
// organisation already COMPLETED, and re-collects only the outstanding ones.
//
// CONSTITUTIONAL POSITION — this is an OPERATIONAL object, exactly like
// collection_runs (migration 038): it holds execution bookkeeping, never
// evidence. It stores no score, no signal fact, no organisation-identity
// decision. It is mutable (an item moves PENDING → RUNNING → COMPLETED) precisely
// because it is NOT evidence. Observations and the Event log remain immutable and
// are never touched here. The ledger references an Observation's id once written
// (observation_id) purely so resume can prove an organisation is already
// collected — a pointer, never a copy of the evidence.
//
// Idempotency guarantees this ledger provides:
//   * initItems is ON CONFLICT DO NOTHING — re-initialising a resumed run never
//     duplicates or resets an item.
//   * markCompleted carries the observation_id, so resume can distinguish "done"
//     from "in flight" and never recollects a completed organisation.
//   * outstandingDomains excludes COMPLETED and PERMANENT items, so completed
//     organisations are never recollected and permanently-dead domains are not
//     retried forever.
//
// All functions take an injectable Supabase client (default: shared) so they are
// unit-testable without a live database, mirroring registry.js / infra/database.js.

const logger = require('../../infra/utils/logger');

function getClient() {
  return require('../../infra/database').getClient();
}

// Item lifecycle. PENDING (not yet attempted) → RUNNING (attempt in flight) →
// COMPLETED (observation written) | FAILED (transient/unexpected, eligible for
// re-collection on resume) | PERMANENT (definite failure — NXDOMAIN etc.; will
// not recover, excluded from resume).
const ITEM_STATUSES = Object.freeze(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PERMANENT']);

// Statuses that still need work (the resume set). COMPLETED and PERMANENT do not.
const OUTSTANDING_STATUSES = Object.freeze(['PENDING', 'RUNNING', 'FAILED']);

const TABLE = 'collection_run_items';

function nowIso() { return new Date().toISOString(); }

// initItems(runId, domains) — create one PENDING item per intended organisation.
// Idempotent: ON CONFLICT (collection_run_id, domain) DO NOTHING, so calling it
// again on a resumed run leaves existing items (and their progress) untouched and
// only fills any genuinely-missing rows.
async function initItems(runId, domains, client = getClient()) {
  if (!runId) throw new Error('runId is required');
  if (!Array.isArray(domains) || domains.length === 0) return { success: true, inserted: 0 };

  // De-duplicate defensively — one item per domain per run.
  const unique = [...new Set(domains.filter(Boolean))];

  // Batch the upsert. A national run initialises ~21k items; a single upsert of
  // that many rows risks the PostgREST request-size / statement-timeout limits, so
  // we chunk it. Idempotent per chunk (ON CONFLICT DO NOTHING), so a partial
  // failure mid-batch is safely re-run by the next resume.
  const CHUNK = Number(process.env.LEDGER_INIT_CHUNK ?? 1000);
  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = unique.slice(i, i + CHUNK).map((domain) => ({
      collection_run_id: runId,
      domain,
      status: 'PENDING',
      attempts: 0,
    }));
    const { error } = await client
      .from(TABLE)
      .upsert(rows, { onConflict: 'collection_run_id,domain', ignoreDuplicates: true });
    if (error) {
      logger.error('[ledger] initItems failed:', { message: error.message });
      return { success: false, error: error.message };
    }
  }
  return { success: true, inserted: unique.length };
}

// listItems(runId) — every item for a run.
async function listItems(runId, client = getClient()) {
  const items = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('collection_run_id', runId)
      .order('domain', { ascending: true })
      .range(from, from + 999);
    if (error) { logger.error(`[ledger] listItems failed: ${error.message}`); return items; }
    if (!data || data.length === 0) break;
    items.push(...data);
    if (data.length < 1000) break;
  }
  return items;
}

// outstandingDomains(runId) — the domains a (re)started run must still collect:
// everything not COMPLETED and not PERMANENT. This is the resume work-list.
async function outstandingDomains(runId, client = getClient()) {
  const domains = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from(TABLE)
      .select('domain, status')
      .eq('collection_run_id', runId)
      .in('status', OUTSTANDING_STATUSES)
      .order('domain', { ascending: true })
      .range(from, from + 999);
    if (error) { logger.error(`[ledger] outstandingDomains failed: ${error.message}`); return domains; }
    if (!data || data.length === 0) break;
    for (const r of data) domains.push(r.domain);
    if (data.length < 1000) break;
  }
  return domains;
}

// markRunning(runId, domain, attempt) — record that an attempt is in flight.
async function markRunning(runId, domain, attempt, client = getClient()) {
  const patch = { status: 'RUNNING', updated_at: nowIso() };
  if (attempt != null) patch.attempts = attempt;
  const { error } = await client.from(TABLE).update(patch)
    .eq('collection_run_id', runId).eq('domain', domain);
  if (error) { logger.error(`[ledger] markRunning failed: ${error.message}`); return { success: false, error: error.message }; }
  return { success: true };
}

// markCompleted(runId, domain, { observationId, attempts }) — the organisation is
// collected. Records the Observation id so resume can prove completeness without
// re-reading the evidence table.
async function markCompleted(runId, domain, { observationId = null, attempts = null } = {}, client = getClient()) {
  const patch = { status: 'COMPLETED', observation_id: observationId, completed_at: nowIso(), updated_at: nowIso(), last_error: null };
  if (attempts != null) patch.attempts = attempts;
  const { error } = await client.from(TABLE).update(patch)
    .eq('collection_run_id', runId).eq('domain', domain);
  if (error) { logger.error(`[ledger] markCompleted failed: ${error.message}`); return { success: false, error: error.message }; }
  return { success: true };
}

// markFailed(runId, domain, { failureClass, error, attempts, permanent }) —
// record a failed attempt with the classifier's verdict. `permanent` (a
// PERMANENT/UNEXPECTED classification the executor chose not to keep retrying)
// parks the item as PERMANENT so resume does not re-collect it forever; a
// transient failure stays FAILED and IS re-collected on resume.
async function markFailed(runId, domain, { failureClass = null, error = null, attempts = null, permanent = false } = {}, client = getClient()) {
  const patch = {
    status: permanent ? 'PERMANENT' : 'FAILED',
    last_failure_class: failureClass,
    last_error: error ? String(error).slice(0, 500) : null,
    updated_at: nowIso(),
  };
  if (attempts != null) patch.attempts = attempts;
  const { error: dbErr } = await client.from(TABLE).update(patch)
    .eq('collection_run_id', runId).eq('domain', domain);
  if (dbErr) { logger.error(`[ledger] markFailed failed: ${dbErr.message}`); return { success: false, error: dbErr.message }; }
  return { success: true };
}

// counts(runId) — status tally used to build the run completion summary and to
// derive the truthful terminal state.
async function counts(runId, client = getClient()) {
  const items = await listItems(runId, client);
  const tally = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0]));
  const byFailureClass = {};
  for (const it of items) {
    tally[it.status] = (tally[it.status] || 0) + 1;
    if ((it.status === 'FAILED' || it.status === 'PERMANENT') && it.last_failure_class) {
      byFailureClass[it.last_failure_class] = (byFailureClass[it.last_failure_class] || 0) + 1;
    }
  }
  return {
    total: items.length,
    completed: tally.COMPLETED,
    failed: tally.FAILED,
    permanent: tally.PERMANENT,
    running: tally.RUNNING,
    pending: tally.PENDING,
    // For the run summary: everything that did not succeed and will not be
    // retried within this run counts as a failure of coverage.
    failedTotal: tally.FAILED + tally.PERMANENT,
    byFailureClass,
  };
}

module.exports = {
  TABLE, ITEM_STATUSES, OUTSTANDING_STATUSES,
  initItems, listItems, outstandingDomains,
  markRunning, markCompleted, markFailed, counts,
};
