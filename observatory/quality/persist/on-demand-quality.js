'use strict';

// on-demand-quality.js — per-domain quality persistence for the On-Demand
// Observation Pipeline (ENG-007 §3.2, Phase 1).
//
// Reuses, unmodified, the exact score*Quality() function each national batch
// loader (backend/observatory/quality/nob-*/load.js) already imports and
// calls — this module never re-implements a Quality Model. Given ONE
// already-persisted signal_facts_<signal> row (read back by id after
// runResilientCollectionSession / runNationalTlsCertificate inserts it), it
// scores it and inserts ONE row into the matching signal_quality_<signal>
// table — the single-row equivalent of what nob-*/load.js does at
// population scale.
//
// No schema change: every column referenced below already exists (migrations
// 026-035). No Repository Authority read or write of any kind — this module
// is domain-keyed throughout, exactly as the tables it writes to are.

const { scoreSpfQuality } = require('../spf-quality');
const { scoreDkimQuality } = require('../dkim-quality');
const { scoreDmarcQuality } = require('../dmarc-quality');
const { scoreCaaQuality } = require('../caa-quality');
const { scoreDnssecQuality } = require('../dnssec-quality');
const { scoreMtaStsQuality } = require('../mtasts-quality');
const { scoreTlsQuality } = require('../tls-quality');
const { scoreCertificateQuality } = require('../certificate-quality');
const { scoreSecuritytxtQuality } = require('../securitytxt-quality');
const { scoreSecurityHeadersQuality } = require('../securityheaders-quality');

function getClient() { return require('../../../infra/database').getClient(); }

// Four signals score against a facts row produced by a separate Collection
// Run (TLS/Certificate/security.txt/Security Headers) — their tables record
// that lineage as source_run_id, distinct from this quality pass's own
// run_id. The other six score and collect in the same on-demand pass and
// carry only run_id/run_label.
const DMARC_POLICY_VALUES = new Set(['reject', 'quarantine', 'none']);

const ADAPTERS = {
  spf: {
    tableName: 'signal_quality_spf',
    scoreFn: (facts) => scoreSpfQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? 1,
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        final_score: result.score,
        multipliers_applied: result.applied ?? [],
        fatal: result.fatal ?? false,
      };
    },
  },

  dkim: {
    tableName: 'signal_quality_dkim',
    scoreFn: (facts) => scoreDkimQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? 1,
        probe_set_version: ctx.facts.probe_set_version ?? 1,
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        max_key_bits: result.maxBits ?? null,
        final_score: result.score,
        multipliers_applied: result.applied ?? [],
      };
    },
  },

  dmarc: {
    tableName: 'signal_quality_dmarc',
    scoreFn: (facts) => scoreDmarcQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? 1,
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        dmarc_policy: DMARC_POLICY_VALUES.has(result.primaryLabel) ? result.primaryLabel : null,
        final_score: result.score,
        multipliers_applied: result.applied ?? [],
      };
    },
  },

  // CAA — the one signal whose scoreFn takes a second argument (population,
  // for RFC 8659 §3 inheritance resolution). The caller (the on-demand
  // orchestrator, via caa-ancestor-lookup.js) supplies extra.population; a
  // missing population defaults to an empty Map, meaning inheritance simply
  // finds no ancestor — never a crash, never a fabricated ancestor.
  //
  // UNCALIBRATED_STATE_PROHIBITED (CR-3): the national batch loader HALTS the
  // whole run rather than persist this state as a null score. Halting an
  // entire ten-signal on-demand scan over one domain's CAA state would be
  // disproportionate — this adapter instead SKIPS the row (persisted:false),
  // which satisfies CR-3's actual requirement ("never persist it as a null
  // score") without adopting the batch loader's population-scale halt
  // semantics. The reason is preserved on the returned `result` either way.
  caa: {
    tableName: 'signal_quality_caa',
    scoreFn: (facts, extra = {}) => scoreCaaQuality(facts, extra.population ?? new Map()),
    buildRow(result, ctx) {
      const evidenceHash = require('node:crypto').createHash('sha256').update(JSON.stringify(ctx.facts)).digest('hex');
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        // No population-wide ndjson artefact exists for a single on-demand
        // domain (unlike the batch loaders' SHA-pinned baseline snapshot) —
        // this is the SHA-256 of the scored facts themselves, an honest
        // per-domain substitute preserving the same auditability intent.
        baseline_sha256: evidenceHash,
        // The "window" collapses to a single instant for one on-demand
        // observation, rather than a population collection date range.
        baseline_window_start: ctx.facts.collected_at,
        baseline_window_end: ctx.facts.collected_at,
        quality_version: 'CAA-QM-v1.0',
        signal_version: ctx.facts.signal_version ?? 1,
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        record_source: result.source,
        inherited_from: result.inheritedFrom ?? null,
        final_score: result.score,
        multipliers_applied: result.applied ?? [],
        m3_critical_unrecognised: (result.flags || []).includes('M3_CRITICAL_UNRECOGNISED_TAG'),
      };
    },
  },

  dnssec: {
    tableName: 'signal_quality_dnssec',
    scoreFn: (facts) => scoreDnssecQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        baseline_window_start: ctx.facts.collected_at,
        baseline_window_end: ctx.facts.collected_at,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? 1,
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        final_score: result.score,
        multipliers_applied: result.applied ?? [],
        legacy_dnskey_algorithm_flag: (result.flags || []).includes('UNCALIBRATED_LEGACY_DNSKEY_ALGORITHM'),
      };
    },
  },

  mtasts: {
    tableName: 'signal_quality_mtasts',
    scoreFn: (facts) => scoreMtaStsQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        baseline_window_start: ctx.facts.collected_at,
        baseline_window_end: ctx.facts.collected_at,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? 1,
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        final_score: result.score,
        multipliers_applied: result.applied ?? [],
        uncalibrated_flags: result.flags ?? [],
      };
    },
  },

  tls: {
    tableName: 'signal_quality_tls',
    scoreFn: (facts) => scoreTlsQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        source_run_id: ctx.sourceRunId,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? '1.0.0',
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        final_score: result.score,
        evidence_flags: result.flags ?? [],
      };
    },
  },

  certificate: {
    tableName: 'signal_quality_certificate',
    scoreFn: (facts) => scoreCertificateQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        source_run_id: ctx.sourceRunId,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? '1.0.0',
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        m1_key_strength: result.m1 ?? null,
        m2_wildcard: result.m2 ?? null,
        m3_lifetime: result.m3 ?? null,
        final_score: result.score,
        evidence: result.evidence ?? {},
      };
    },
  },

  securitytxt: {
    tableName: 'signal_quality_securitytxt',
    scoreFn: (facts) => scoreSecuritytxtQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        source_run_id: ctx.sourceRunId,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? '1.0.0',
        collected_at: ctx.facts.collected_at,
        primary_score: result.primary,
        primary_label: result.primaryLabel,
        final_score: result.score,
        evidence_flags: result.flags ?? [],
      };
    },
  },

  // No primary state — SECURITYHEADERS-QM-v1.0 is an additive checklist model
  // (its own header: "additive weighted checklist, NOT the single-gate-plus-
  // multiplier shape"); the table has no primary_score/primary_label columns.
  securityheaders: {
    tableName: 'signal_quality_securityheaders',
    scoreFn: (facts) => scoreSecurityHeadersQuality(facts),
    buildRow(result, ctx) {
      return {
        domain: ctx.domain,
        run_id: ctx.runId,
        run_label: ctx.runLabel,
        source_run_id: ctx.sourceRunId,
        quality_version: '1.0',
        signal_version: ctx.facts.signal_version ?? '1.0.0',
        collected_at: ctx.facts.collected_at,
        final_score: result.score,
        breakdown: result.breakdown ?? {},
        evidence: result.evidence ?? {},
        evidence_flags: result.flags ?? [],
      };
    },
  },
};

const SIGNALS = Object.keys(ADAPTERS);

/**
 * Score one already-persisted Observation row and, if scoreable, insert one
 * row into the matching signal_quality_<signal> table.
 *
 * @param {Object} input
 * @param {string} input.signal        - one of SIGNALS
 * @param {Object} input.facts         - the persisted signal_facts_<signal> row (read back by id)
 * @param {string} input.runId         - this quality-scoring pass's own run identifier
 * @param {string} input.runLabel      - e.g. `ONDEMAND-QUALITY-<signal>-<domain>-<ts>`
 * @param {string} [input.sourceRunId] - the collection_runs.id that produced `facts` (tls/certificate/securitytxt/securityheaders only)
 * @param {Map}    [input.population]  - CAA only: domain -> facts, for RFC 8659 inheritance
 * @param {Object} [deps]              - { client } — injectable for tests
 * @returns {Promise<
 *   {ok: true, persisted: true, result: Object, row: Object} |
 *   {ok: true, persisted: false, result: Object} |
 *   {ok: false, error: string, result?: Object}
 * >}
 */
async function persistOnDemandQuality(input, deps = {}) {
  const { signal, facts, runId, runLabel, sourceRunId, population } = input;
  const adapter = ADAPTERS[signal];
  if (!adapter) return { ok: false, error: `no on-demand quality adapter for signal '${signal}'` };
  if (!facts || typeof facts !== 'object') return { ok: false, error: 'facts is required' };
  if (!runId) return { ok: false, error: 'runId is required' };
  if (!runLabel) return { ok: false, error: 'runLabel is required' };

  const client = deps.client || getClient();
  const scoreFn = deps.scoreFn || adapter.scoreFn;

  const result = scoreFn(facts, { population });

  // Unscored — Unknown ≠ Absent. No row is written; this is the intended,
  // honest outcome (matches every model's own P1 discipline), not a failure.
  if (!result.scored) {
    return { ok: true, persisted: false, result };
  }

  const ctx = { domain: facts.domain, runId, runLabel, sourceRunId, facts, population };
  const row = adapter.buildRow(result, ctx);

  const { data, error } = await client.from(adapter.tableName).insert([row]).select('id').single();
  if (error) return { ok: false, error: error.message, result };

  return { ok: true, persisted: true, result, row: { id: data.id, ...row } };
}

module.exports = { persistOnDemandQuality, ADAPTERS, SIGNALS };
