'use strict';

// Collection Programme / Collection Run registry — the operational ownership
// chain above an Observation (OBS-CONST-001 §3; migration 038).
//
// Sprint 5 of the ADR-SYS-009 implementation programme. This module is the ONLY
// place Collection Programmes and Runs are created and lifecycled, so the
// identity-immutability guarantee lives in one auditable place: the lifecycle
// functions here touch a run's status / completed_at / metadata ONLY — never its
// id, programme_id, run_label, or started_at once written.
//
// No orchestration, no scheduling — this module records identity and lifecycle;
// it does not run collectors. It writes no Observations.
//
// Persistence functions take an injectable `client` (defaulting to the shared
// Supabase client) purely so they are unit-testable without a live database,
// mirroring the pattern in infra/database.js. Pure helpers take no client and
// are fully deterministic.

const logger = require('../../infra/utils/logger');

// ── Vocabulary (mirrors migration 038 CHECK constraints exactly) ─────────────

const PROGRAMME_KINDS = Object.freeze([
  'NATIONAL', 'PUBLIC_SCAN', 'ENGINEERING_VALIDATION', 'RETRY', 'RESIDUAL', 'TARGETED',
]);

const PROGRAMME_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'RETIRED']);

// Run lifecycle vocabulary. Extended in the production-hardening sprint
// (Blocker 3) with truthful failure-aware states — CREATED / QUEUED (staged
// before execution), PARTIAL (finished but some organisations failed after
// retries), CANCELLED (intentionally stopped). The legacy states PENDING and
// ABANDONED are retained unchanged for backward compatibility with runs and code
// that predate the extension; QUEUED is the going-forward synonym of PENDING and
// CANCELLED of ABANDONED. Migration 042 widens the DB CHECK to this same union.
//
// These are OPERATIONAL states, not evidence: only the run's status/completed_at/
// summary columns move; identity (id / programme_id / run_label / started_at) is
// immutable, exactly as migration 038 guarantees.
const RUN_STATUSES = Object.freeze([
  'CREATED', 'QUEUED', 'PENDING', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED',
]);
const RUN_TERMINAL_STATUSES = Object.freeze(['PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED']);

// Legal run lifecycle transitions. A run reaches exactly one terminal state and
// then never changes again (its identity and its outcome are both fixed once
// terminal). CREATED → QUEUED → RUNNING is the staged path a scheduler/queue
// uses; a runner that starts immediately opens directly in RUNNING. A RUNNING run
// finishes as COMPLETED (all intended organisations succeeded), PARTIAL (some
// remained failed after retries), FAILED (execution could not continue), or
// CANCELLED (intentionally stopped).
const RUN_TRANSITIONS = Object.freeze({
  CREATED:   ['QUEUED', 'RUNNING', 'CANCELLED'],
  QUEUED:    ['RUNNING', 'CANCELLED'],
  PENDING:   ['RUNNING', 'CANCELLED', 'ABANDONED'],
  RUNNING:   ['PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED'],
  PARTIAL:   [],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
  ABANDONED: [],
});

function isValidRunTransition(from, to) {
  return Array.isArray(RUN_TRANSITIONS[from]) && RUN_TRANSITIONS[from].includes(to);
}

function isTerminalRunStatus(status) {
  return RUN_TERMINAL_STATUSES.includes(status);
}

// Whether Observations produced under a programme of this kind contribute to
// Organisation History. Engineering-Validation runs test collector code, not
// organisational truth, so they never do (Sprint 1 finding; P-1). This is a pure
// mirror of the seeded contributes_to_history default and exists so callers can
// reason about it without a DB round-trip.
function kindContributesToHistory(kind) {
  return kind !== 'ENGINEERING_VALIDATION';
}

// ── Pure row builders (no client; deterministic given `now`) ─────────────────

function buildProgrammeRow(input) {
  const { key, name, kind } = input;
  if (!key || typeof key !== 'string') throw new Error('programme key is required');
  if (!name || typeof name !== 'string') throw new Error('programme name is required');
  if (!PROGRAMME_KINDS.includes(kind)) throw new Error(`invalid programme kind: ${kind}`);

  const status = input.status ?? 'ACTIVE';
  if (!PROGRAMME_STATUSES.includes(status)) throw new Error(`invalid programme status: ${status}`);

  return {
    programme_key: key,
    name,
    kind,
    signal: input.signal ?? null,
    description: input.description ?? null,
    // Default follows the kind unless explicitly overridden.
    contributes_to_history: input.contributesToHistory ?? kindContributesToHistory(kind),
    status,
  };
}

function buildRunRow(input, now = new Date().toISOString()) {
  const { programmeId, runLabel } = input;
  if (!programmeId) throw new Error('programmeId is required to open a run');
  if (!runLabel || typeof runLabel !== 'string') throw new Error('runLabel is required');

  const status = input.status ?? 'RUNNING';
  if (!RUN_STATUSES.includes(status)) throw new Error(`invalid run status: ${status}`);
  if (isTerminalRunStatus(status)) throw new Error('a run may not be opened directly in a terminal state');

  return {
    programme_id: programmeId,
    run_label: runLabel,
    status,
    started_at: input.startedAt ?? now,
    completed_at: null,
    metadata: input.metadata ?? {},
  };
}

// ── Persistence (injectable client) ──────────────────────────────────────────

function getClient() {
  // Lazily require infra/database's client factory only when actually persisting,
  // so pure helpers and tests never touch Supabase env vars.
  return require('../../infra/database').getClient();
}

// Idempotent create-or-return by programme_key. Re-running never duplicates a
// standing programme.
async function upsertProgramme(input, client = getClient()) {
  try {
    const row = buildProgrammeRow(input);
    const { data, error } = await client
      .from('collection_programmes')
      .upsert([row], { onConflict: 'programme_key' })
      .select()
      .single();
    if (error) {
      logger.error('[registry] upsertProgramme failed:', { message: error.message });
      return { success: false, error: error.message };
    }
    return { success: true, programme: data };
  } catch (err) {
    logger.error('[registry] upsertProgramme threw:', { message: err.message });
    return { success: false, error: err.message };
  }
}

async function getProgrammeByKey(key, client = getClient()) {
  const { data, error } = await client
    .from('collection_programmes')
    .select('*')
    .eq('programme_key', key)
    .maybeSingle();
  if (error) { logger.error(`[registry] getProgrammeByKey failed: ${error.message}`); return null; }
  return data;
}

// Open a new run under a programme. Each call mints a fresh, immutable run
// identity (the DB assigns the UUID). Returns the persisted row including its id.
async function openRun(input, client = getClient()) {
  try {
    const row = buildRunRow(input);
    const { data, error } = await client
      .from('collection_runs')
      .insert([row])
      .select()
      .single();
    if (error) {
      logger.error('[registry] openRun failed:', { message: error.message });
      return { success: false, error: error.message };
    }
    return { success: true, run: data };
  } catch (err) {
    logger.error('[registry] openRun threw:', { message: err.message });
    return { success: false, error: err.message };
  }
}

// Transition a run's lifecycle. Touches status / completed_at / metadata ONLY —
// never identity fields. Validates the transition against RUN_TRANSITIONS and
// requires the caller to pass the run's current status so an illegal or
// out-of-date transition is rejected rather than silently applied.
async function transitionRun(runId, fromStatus, toStatus, opts = {}, client = getClient()) {
  try {
    if (!runId) throw new Error('runId is required');
    if (!isValidRunTransition(fromStatus, toStatus)) {
      throw new Error(`illegal run transition: ${fromStatus} → ${toStatus}`);
    }

    const patch = { status: toStatus };
    if (isTerminalRunStatus(toStatus)) {
      patch.completed_at = opts.completedAt ?? new Date().toISOString();
    }
    if (opts.metadata !== undefined) patch.metadata = opts.metadata;

    // Optional completion-summary columns (migration 042). Written only when the
    // caller supplies them, so runs and callers predating the columns are
    // untouched. These are operational telemetry, not evidence.
    if (opts.summary) {
      const s = opts.summary;
      if (s.intended != null) patch.intended_count = s.intended;
      if (s.succeeded != null) patch.succeeded_count = s.succeeded;
      if (s.failed != null) patch.failed_count = s.failed;
      if (s.coveragePct != null) patch.coverage_pct = s.coveragePct;
    }

    const { data, error } = await client
      .from('collection_runs')
      .update(patch)
      .eq('id', runId)
      .eq('status', fromStatus) // optimistic guard: only transition from the expected state
      .select()
      .single();
    if (error) {
      logger.error('[registry] transitionRun failed:', { message: error.message });
      return { success: false, error: error.message };
    }
    return { success: true, run: data };
  } catch (err) {
    logger.error('[registry] transitionRun threw:', { message: err.message });
    return { success: false, error: err.message };
  }
}

async function getRun(runId, client = getClient()) {
  const { data, error } = await client
    .from('collection_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (error) { logger.error(`[registry] getRun failed: ${error.message}`); return null; }
  return data;
}

async function listRunsForProgramme(programmeId, client = getClient()) {
  const { data, error } = await client
    .from('collection_runs')
    .select('*')
    .eq('programme_id', programmeId)
    .order('started_at', { ascending: false });
  if (error) { logger.error(`[registry] listRunsForProgramme failed: ${error.message}`); return []; }
  return data ?? [];
}

module.exports = {
  // vocabulary
  PROGRAMME_KINDS, PROGRAMME_STATUSES, RUN_STATUSES, RUN_TERMINAL_STATUSES, RUN_TRANSITIONS,
  // pure helpers
  isValidRunTransition, isTerminalRunStatus, kindContributesToHistory,
  buildProgrammeRow, buildRunRow,
  // persistence
  upsertProgramme, getProgrammeByKey, openRun, transitionRun, getRun, listRunsForProgramme,
};
