'use strict';

// observation-session.js — the Observation Session execution lifecycle.
//
// Internal execution mechanism within the Observation layer (ADR-SYS-010
// unchanged). A session is the stateful, auditable unit of observation
// execution over the existing immutable run concept:
//
//   Trigger -> Observation Session -> Run -> Observations -> Organisation -> Experiences
//
// It is NOT customer-facing and NOT a constitutional abstraction. The three
// initial triggers (batch, on-demand, scheduled) are the same mechanism with
// different entry points; adding 'event' later is a one-line change to
// TRIGGERS, no redesign.
//
// v1 scope: creation, lifecycle state, run linkage (run_id/run_label),
// execution metadata, append-only event trail (auditing), queryable status
// (monitoring). No queue/worker/scheduler — those layer onto this record later.
//
// The pure helpers (STATUSES/TRIGGERS/TRANSITIONS/isValidTransition) carry the
// state-machine rules and are unit-tested without a database. DB functions take
// an injectable client so route/service tests can run without Supabase, the
// same pattern as infra/database.js.

const { getClient } = require('../../infra/database');

// ── State machine (pure) ─────────────────────────────────────────────────────

const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const TERMINAL = ['completed', 'failed', 'cancelled'];

// Extensible: append 'event' (or others) here — no migration, no redesign.
const TRIGGERS = ['batch', 'on-demand', 'scheduled'];

// A session may be created already running (a synchronous on-demand scan that
// starts work immediately) or queued (deferred execution, once a queue exists).
const INITIAL_STATUSES = ['queued', 'running'];

const TRANSITIONS = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

function isTerminal(status) {
  return TERMINAL.includes(status);
}

function isValidTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// ── DB access ────────────────────────────────────────────────────────────────

/**
 * Create a session. Returns { ok, session } | { ok: false, error }.
 * @param {Object} input
 * @param {string} input.trigger               - one of TRIGGERS
 * @param {Object} [input.scope]               - what is being observed
 * @param {Object} [input.metadata]            - execution metadata
 * @param {string} [input.status='queued']     - initial status (queued|running)
 * @param {string} [input.runLabel]            - if the run is known at creation
 * @param {string} [input.runId]
 */
async function createSession(input, client = getClient()) {
  if (!TRIGGERS.includes(input.trigger)) {
    return { ok: false, error: `unknown trigger '${input.trigger}' (allowed: ${TRIGGERS.join(', ')})` };
  }
  const status = input.status || 'queued';
  if (!INITIAL_STATUSES.includes(status)) {
    return { ok: false, error: `invalid initial status '${status}' (allowed: ${INITIAL_STATUSES.join(', ')})` };
  }

  const now = new Date().toISOString();
  const row = {
    trigger: input.trigger,
    status,
    scope: input.scope || {},
    run_id: input.runId || null,
    run_label: input.runLabel || null,
    metadata: input.metadata || {},
    events: [{ from: null, to: status, at: now, note: 'created' }],
    started_at: status === 'running' ? now : null,
  };

  const { data, error } = await client
    .from('observation_sessions')
    .insert([row])
    .select('*')
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, session: data };
}

/**
 * Transition a session to a new lifecycle state, appending an audit event and
 * setting started_at/ended_at as appropriate. Optionally attach the run and
 * merge execution metadata in the same step.
 * @param {string} id
 * @param {string} toStatus
 * @param {Object} [opts]
 * @param {string} [opts.note]
 * @param {Object} [opts.metadata]   - merged into existing metadata
 * @param {string} [opts.runId]
 * @param {string} [opts.runLabel]
 */
async function transition(id, toStatus, opts = {}, client = getClient()) {
  if (!STATUSES.includes(toStatus)) {
    return { ok: false, error: `unknown status '${toStatus}'` };
  }

  const { data: current, error: readErr } = await client
    .from('observation_sessions')
    .select('*')
    .eq('id', id)
    .single();
  if (readErr) return { ok: false, error: readErr.message };
  if (!current) return { ok: false, error: `session ${id} not found` };

  if (!isValidTransition(current.status, toStatus)) {
    return { ok: false, error: `illegal transition ${current.status} -> ${toStatus}` };
  }

  const now = new Date().toISOString();
  const patch = {
    status: toStatus,
    events: [...(current.events || []), { from: current.status, to: toStatus, at: now, note: opts.note || null }],
    metadata: opts.metadata ? { ...(current.metadata || {}), ...opts.metadata } : current.metadata,
    updated_at: now,
  };
  if (toStatus === 'running' && !current.started_at) patch.started_at = now;
  if (isTerminal(toStatus)) patch.ended_at = now;
  if (opts.runId !== undefined) patch.run_id = opts.runId;
  if (opts.runLabel !== undefined) patch.run_label = opts.runLabel;

  const { data, error } = await client
    .from('observation_sessions')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, session: data };
}

/**
 * Assign the run a session owns, without changing status. Kept distinct so a
 * session created 'queued' can adopt its run_label the moment the run is minted,
 * before it starts running. UNIQUE(run_label) enforces one-session-per-run.
 */
async function attachRun(id, { runId = null, runLabel }, client = getClient()) {
  if (!runLabel) return { ok: false, error: 'runLabel is required' };
  const { data, error } = await client
    .from('observation_sessions')
    .update({ run_id: runId, run_label: runLabel, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, session: data };
}

async function getSession(id, client = getClient()) {
  const { data, error } = await client
    .from('observation_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: `session ${id} not found` };
  return { ok: true, session: data };
}

// ── Monitoring ────────────────────────────────────────────────────────────────

async function listSessions({ status, trigger, limit = 50 } = {}, client = getClient()) {
  let q = client
    .from('observation_sessions')
    .select('id, trigger, status, scope, run_label, created_at, started_at, ended_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  if (trigger) q = q.eq('trigger', trigger);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, sessions: data ?? [] };
}

async function statusCounts(client = getClient()) {
  const { data, error } = await client
    .from('observation_sessions')
    .select('status');
  if (error) return { ok: false, error: error.message };
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of data ?? []) counts[row.status] = (counts[row.status] || 0) + 1;
  return { ok: true, counts, total: (data ?? []).length };
}

module.exports = {
  // pure state machine
  STATUSES, TRIGGERS, TERMINAL, TRANSITIONS, INITIAL_STATUSES,
  isTerminal, isValidTransition,
  // lifecycle
  createSession, transition, attachRun, getSession,
  // monitoring
  listSessions, statusCounts,
};
