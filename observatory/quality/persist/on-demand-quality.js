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

  // DKIM DEVIATES differently from tls/certificate: dkim-observation.js
  // strips `dkim_keys` entirely from the domain-level signal_facts_dkim row
  // (`const { dkim_keys, ...domainFacts } = facts`) and fans it out to a
  // CHILD TABLE, signal_facts_dkim_keys, via the adapter's persistChildren
  // hook. A .select('*') on signal_facts_dkim never contains key evidence at
  // all — not even nested — so scoreDkimQuality's `facts.dkim_keys` would
  // silently default to [] (no usable key) for every domain, regardless of
  // its real key strength. reconstructFacts reads the child rows back and
  // re-attaches them, mirroring the batch loaders' own read-the-real-
  // evidence-before-scoring discipline; async because this reconstruction
  // genuinely requires a query the tls/certificate cases do not.
  //
  // TWO DEFECTS FOUND AND FIXED HERE (DKIM Quality Model boundary audit,
  // 2026-07-17, following the OBS-102 trial's child-persistence fix,
  // commit 99f66f0):
  //
  // 1. Wrong join column. signal_facts_dkim_keys.dkim_run_id is a FOREIGN
  //    KEY to signal_facts_dkim(id) — the PARENT ROW's own id (see
  //    dkim-observation.js's persistDkimKeys, fixed in 99f66f0) — not to
  //    collection_run_id. This function still filtered by
  //    `row.collection_run_id`, the SAME misunderstanding persistDkimKeys
  //    had, independently reintroduced here. Confirmed live in production:
  //    every DKIM quality row scored after 99f66f0 (once child persistence
  //    started actually succeeding) still read back zero keys and scored
  //    "no usable key (bounded)" / 0, regardless of real key strength,
  //    because this query was matching the wrong column the entire time.
  //    The national batch loader (nob-dkim-001r/load.js) never had this bug
  //    — it has always matched keys to observations by `o.id` correctly;
  //    only this on-demand/OBS-102 path (they share this one function) did.
  //
  // 2. No completeness check. Even with (1) fixed, a genuine PARTIAL or
  //    COMPLETE child-persistence failure (persistDkimKeys throwing, e.g. a
  //    transient DB error) is indistinguishable from a domain that
  //    genuinely has no DKIM keys — both read back zero (or fewer than
  //    expected) child rows, and scoreDkimQuality cannot tell the
  //    difference from inside the model (it only ever sees whatever
  //    dkim_keys array it's handed). The completeness check below compares
  //    the parent row's own dkim_selectors_found count (how many the
  //    collector actually discovered) against how many child rows were
  //    actually read back — if fewer, this is INCOMPLETE evidence, not a
  //    legitimate "none found" result, and must not be scored as a clean
  //    success (Unknown != Absent: this is Unknown, not Absent).
  dkim: {
    tableName: 'signal_quality_dkim',
    scoreFn: (facts) => {
      // Reuses the existing {scored:false, reason, score:null} vocabulary
      // shape scoreDkimQuality itself already uses for OBSERVATION_INCOMPLETE
      // — a distinct reason string, since this is a different cause (evidence
      // was discovered but did not fully persist, not a DNS-level
      // non-observation) that callers must be able to tell apart.
      if (facts.__dkimChildEvidenceIncomplete) {
        return { scored: false, reason: 'CHILD_EVIDENCE_INCOMPLETE', score: null };
      }
      return scoreDkimQuality(facts);
    },
    async reconstructFacts(row, client) {
      const { data, error } = await client
        .from('signal_facts_dkim_keys')
        .select('*')
        .eq('domain', row.domain)
        .eq('dkim_run_id', row.id); // FIX: was row.collection_run_id (defect 1 above)
      if (error) throw new Error(`dkim key read-back failed: ${error.message}`);
      const persistedKeys = data || [];

      // FIX: completeness gate (defect 2 above). dkim_selectors_found is the
      // collector's own record of how many selectors it actually discovered
      // (buildDkimObservation persists this on the parent row unmodified) —
      // comparing it against what was actually read back from the child
      // table is the only place a parent/child persistence mismatch is
      // checkable, since neither side alone can see both counts.
      const expectedCount = Array.isArray(row.dkim_selectors_found) ? row.dkim_selectors_found.length : 0;
      const incomplete = persistedKeys.length < expectedCount;

      return { ...row, dkim_keys: persistedKeys, __dkimChildEvidenceIncomplete: incomplete };
    },
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

  // TLS DEVIATES from the flat facts-spread pattern: signal_tls_v1 stores
  // only a subset of fields as promoted top-level columns (tls-extractor.js
  // promotedScalars()) plus the full extractor output nested under
  // `evidence`. scoreTlsQuality() needs cipher_key_exchange, which is a
  // derived field the extractor computes (tls-extractor.js:69) but
  // promotedScalars() does not surface at the top level (migration 016
  // comment: "informational index; not in §4.5 promoted list"). Every other
  // field the model reads IS already a promoted column. reconstructFacts
  // mirrors exactly what the national batch loader
  // (observatory/quality/nob-tls-001/load.js) already does before calling
  // this same scoreTlsQuality() — reused as an approach, not imported,
  // since load.js is a standalone script with its own execution entry
  // point, not a library module.
  tls: {
    tableName: 'signal_quality_tls',
    scoreFn: (facts) => scoreTlsQuality(facts),
    reconstructFacts(row) {
      return {
        endpoint_state: row.endpoint_state,
        negotiated_version: row.negotiated_version,
        cipher_suite_standard: row.cipher_suite_standard,
        cipher_key_exchange: row.evidence?.cipher_key_exchange,
        alpn_protocol: row.alpn_protocol,
        http2_negotiated: row.http2_negotiated,
      };
    },
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

  // CERTIFICATE has the same deviation as TLS (same shared collection
  // domain, ADR-COL-003; signal_certificate_v1 built the same way by
  // certificate-observation.js). scoreCertificateQuality()'s PRIMARY gate
  // (tls_verification_result) plus leaf_key_type/leaf_key_bits/
  // leaf_key_curve/leaf_lifetime_days all live only in `evidence` — none are
  // promoted columns (migration 015). reconstructFacts mirrors exactly what
  // observatory/quality/nob-certificate-001-v2/load.js already does before
  // calling this same scoreCertificateQuality() (same non-import rationale
  // as tls above).
  certificate: {
    tableName: 'signal_quality_certificate',
    scoreFn: (facts) => scoreCertificateQuality(facts),
    reconstructFacts(row) {
      return {
        endpoint_state: row.endpoint_state,
        certificate_present: row.certificate_present,
        tls_verification_result: row.evidence?.tls_verification_result,
        leaf_key_type: row.evidence?.leaf_key_type,
        leaf_key_bits: row.evidence?.leaf_key_bits,
        leaf_key_curve: row.evidence?.leaf_key_curve,
        leaf_is_wildcard: row.leaf_is_wildcard,
        leaf_is_self_signed: row.leaf_is_self_signed,
        leaf_lifetime_days: row.evidence?.leaf_lifetime_days,
      };
    },
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
 * row into the matching signal_quality_<signal> table. For tls/certificate,
 * `input.facts` is first passed through the adapter's reconstructFacts()
 * before scoring (see the ADAPTERS entries above) — every other signal's
 * row is already the flat shape score*Quality() expects.
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

  // Most signals' persisted rows are already the flat shape score*Quality()
  // expects (facts spread verbatim by makeObservationBuilder). TLS,
  // Certificate, and DKIM are not — reconstructFacts bridges the gap, exactly
  // as the national batch loaders already do, before the row ever reaches
  // the model (a plain object for tls/certificate; a genuine child-table
  // query for dkim — `await` resolves either immediately). scoringFacts is
  // used ONLY for the scoreFn call; buildRow below still receives the
  // ORIGINAL row (ctx.facts) for its own metadata needs (collected_at,
  // signal_version, the full evidence block for certificate's own evidence
  // column), unaffected by this reconstruction.
  const scoringFacts = adapter.reconstructFacts ? await adapter.reconstructFacts(facts, client) : facts;

  const result = scoreFn(scoringFacts, { population });

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
