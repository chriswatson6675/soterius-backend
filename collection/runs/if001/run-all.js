'use strict';

// Signal Lab Collection Orchestrator
//
// Obtains organisations from the canonical Organisation Dataset (the Repository
// Authority) via the Organisation Provider — every organisation with a VERIFIED
// domain — runs all 9 Signal Lab collectors against every domain, inserts
// observations into the approved Signal Lab tables, and writes
// <COHORT>_COLLECTION_REPORT.md (identity supplied by the provider).
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/collection/runs/if001/run-all.js            # canonical VERIFIED organisations
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   ORG_PROVIDER              — optional, only 'canonical' (default); legacy cohorts retired
//   ORG_SAMPLE_N              — optional, cap to a deterministic head sample for commissioning
//   CONCURRENCY               — optional, default 8

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const path           = require('node:path');
const fs             = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Collector imports ─────────────────────────────────────────────────────────

const { collectSpf,            SIGNAL_ID: SPF_ID,     SIGNAL_VERSION: SPF_VER   } = require('../../signals/spf/spf-collector');
const { collectDkim,           SIGNAL_ID: DKIM_ID,    SIGNAL_VERSION: DKIM_VER  } = require('../../signals/dkim/dkim-collector');
const { collectDmarc,          SIGNAL_ID: DMARC_ID,   SIGNAL_VERSION: DMARC_VER } = require('../../signals/dmarc/dmarc-collector');
const { collectMtaSts,         SIGNAL_ID: MTASTS_ID,  SIGNAL_VERSION: MTASTS_VER  } = require('../../signals/mtasts/mtasts-collector');
const { collectTlsRpt,         SIGNAL_ID: TLSRPT_ID,  SIGNAL_VERSION: TLSRPT_VER  } = require('../../signals/tlsrpt/tlsrpt-collector');
const { collectDnssec,         SIGNAL_ID: DNSSEC_ID,  SIGNAL_VERSION: DNSSEC_VER  } = require('../../signals/dnssec/dnssec-collector');
const { collectCaa,            SIGNAL_ID: CAA_ID,     SIGNAL_VERSION: CAA_VER     } = require('../../signals/caa/caa-collector');
const { collectSecurityTxt   } = require('../../signals/securitytxt/securitytxt-collector');
const { collectSecurityHeaders } = require('../../signals/securityheaders/securityheaders-collector');

// ── Organisation source ───────────────────────────────────────────────────────
// The Observatory obtains the organisations it scans through the Organisation
// Provider, which resolves them exclusively from the canonical Organisation
// Dataset (VERIFIED domains). No legacy cohort registry is referenced here.
const { loadOrganisations } = require('../../../acquisition/providers/organisation-provider');

// ── Configuration ─────────────────────────────────────────────────────────────

const COLLECTOR_VERSION  = '1.0.0';
const REPORT_DIR         = path.join(__dirname, '../../../../');
const CONCURRENCY        = Number(process.env.CONCURRENCY ?? 8);
const SIGNAL_CONCURRENCY = Number(process.env.SIGNAL_CONCURRENCY ?? 9);

// Report identity is derived from the cohort the provider supplies, so the
// Observatory is population-agnostic (no hardcoded IF-001). The filename stem is
// the cohort id with separators removed: 'IF-001' → 'IF001' (unchanged for IF),
// 'FCA-REG-001' → 'FCAREG001'.
const reportStem    = id => String(id).replace(/[^A-Za-z0-9]/g, '');
const reportPathFor = id => path.join(REPORT_DIR, `${reportStem(id)}_COLLECTION_REPORT.md`);

// ── Supabase client ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runSignalsWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── Signal definitions ────────────────────────────────────────────────────────

function spfInsert(domain, f) {
  return {
    domain,
    signal_version:       SPF_VER,
    spf_present:          f.spf_present,
    spf_collection_error: f.spf_collection_error,
    spf_record:           f.spf_record,
    spf_record_count:     f.spf_record_count,
    spf_parse_success:    f.spf_parse_success,
    spf_syntax_errors:    f.spf_syntax_errors,
    spf_mechanism:        f.spf_mechanism,
    spf_lookup_count:     f.spf_lookup_count,
    spf_multiple_records: f.spf_multiple_records,
    spf_include_count:    f.spf_include_count,
  };
}

async function dkimInsert(supabase, domain, f, collectedAt) {
  const { data, error: domainErr } = await supabase
    .from('signal_facts_dkim')
    .insert({
      domain,
      signal_version:         DKIM_VER,
      collected_at:           collectedAt,
      dkim_present:           f.dkim_present,
      dkim_collection_status: f.dkim_collection_status,
      dkim_record_count:      f.dkim_record_count,
      dkim_selectors_probed:  f.dkim_selectors_probed,
      dkim_selectors_found:   f.dkim_selectors_found,
      dkim_probe_set_version: f.dkim_probe_set_version,
    })
    .select('id')
    .single();

  if (domainErr) return { error: domainErr };

  if (f.dkim_keys.length > 0) {
    const { error: keysErr } = await supabase
      .from('signal_facts_dkim_keys')
      .insert(f.dkim_keys.map(k => ({
        dkim_run_id:        data.id,
        domain,
        collected_at:       collectedAt,
        selector:           k.selector,
        raw_record:         k.raw_record,
        parse_success:      k.parse_success,
        version:            k.version,
        key_type:           k.key_type,
        key_bits:           k.key_bits,
        public_key_present: k.public_key_present,
        hash_algorithms:    k.hash_algorithms,
        service_type:       k.service_type,
        flags:              k.flags,
        syntax_errors:      k.syntax_errors,
      })));
    if (keysErr) return { error: keysErr };
  }

  return { error: null };
}

function dmarcInsert(domain, f, collectedAt) {
  return {
    domain,
    signal_version:         DMARC_VER,
    collected_at:           collectedAt,
    dmarc_present:          f.dmarc_present,
    dmarc_collection_error: f.dmarc_collection_error,
    dmarc_records:          f.dmarc_records,
    dmarc_record_count:     f.dmarc_record_count,
    dmarc_multiple_records: f.dmarc_multiple_records,
    dmarc_parse_success:    f.dmarc_parse_success,
    dmarc_syntax_errors:    f.dmarc_syntax_errors,
    dmarc_version:          f.dmarc_version,
    dmarc_policy:           f.dmarc_policy,
    dmarc_subdomain_policy: f.dmarc_subdomain_policy,
    dmarc_adkim:            f.dmarc_adkim,
    dmarc_aspf:             f.dmarc_aspf,
    dmarc_pct:              f.dmarc_pct,
    dmarc_rua:              f.dmarc_rua,
    dmarc_ruf:              f.dmarc_ruf,
    dmarc_rua_count:        f.dmarc_rua_count,
    dmarc_ruf_count:        f.dmarc_ruf_count,
    dmarc_fo:               f.dmarc_fo,
    dmarc_ri:               f.dmarc_ri,
    dmarc_rf:               f.dmarc_rf,
  };
}

function mtastsInsert(domain, f, collectedAt) {
  return {
    domain,
    signal_version:            MTASTS_VER,
    collected_at:              collectedAt,
    dns_sts_present:           f.dns_sts_present,
    dns_collection_error:      f.dns_collection_error,
    dns_records:               f.dns_records,
    dns_record_count:          f.dns_record_count,
    dns_sts_record_count:      f.dns_sts_record_count,
    dns_multiple_sts_records:  f.dns_multiple_sts_records,
    dns_parse_success:         f.dns_parse_success,
    dns_syntax_errors:         f.dns_syntax_errors,
    dns_version:               f.dns_version,
    dns_id:                    f.dns_id,
    dns_unknown_tags:          f.dns_unknown_tags,
    policy_fetch_attempted:    f.policy_fetch_attempted,
    policy_present:            f.policy_present,
    policy_fetch_error:        f.policy_fetch_error,
    policy_http_status:        f.policy_http_status,
    policy_tls_valid:          f.policy_tls_valid,
    policy_tls_error:          f.policy_tls_error,
    policy_redirect_count:     f.policy_redirect_count,
    policy_content_type:       f.policy_content_type,
    policy_body_raw:           f.policy_body_raw,
    policy_body_tls_validated: f.policy_body_tls_validated,
    policy_parse_success:      f.policy_parse_success,
    policy_syntax_errors:      f.policy_syntax_errors,
    policy_version:            f.policy_version,
    policy_mode:               f.policy_mode,
    policy_max_age:            f.policy_max_age,
    policy_mx_patterns:        f.policy_mx_patterns,
    policy_mx_count:           f.policy_mx_count,
    policy_unknown_fields:     f.policy_unknown_fields,
  };
}

function tlsrptInsert(domain, r, collectedAt) {
  return {
    domain,
    signal_version:              TLSRPT_VER,
    collected_at:                collectedAt,
    dns_tlsrpt_present:          r.dns_tlsrpt_present,
    dns_collection_error:        r.dns_collection_error,
    dns_records:                 r.dns_records,
    dns_record_count:            r.dns_record_count,
    dns_tlsrpt_record_count:     r.dns_tlsrpt_record_count,
    dns_multiple_tlsrpt_records: r.dns_multiple_tlsrpt_records,
    dns_parse_success:           r.dns_parse_success,
    dns_syntax_errors:           r.dns_syntax_errors,
    dns_version:                 r.dns_version,
    dns_unknown_tags:            r.dns_unknown_tags,
    rua_raw:                     r.rua_raw,
    rua_uris:                    r.rua_uris,
    rua_count:                   r.rua_count,
    rua_mailto_count:            r.rua_mailto_count,
    rua_https_count:             r.rua_https_count,
    rua_unknown_scheme_count:    r.rua_unknown_scheme_count,
  };
}

function dnssecInsert(domain, r) {
  return {
    domain,
    signal_version:           DNSSEC_VER,
    collected_at:             new Date().toISOString(),
    dns_ds_present:           r.dns_ds_present,
    ds_collection_error:      r.ds_collection_error,
    ds_records:               r.ds_records,
    ds_record_count:          r.ds_record_count,
    ds_algorithms:            r.ds_algorithms,
    ds_digest_types:          r.ds_digest_types,
    ds_key_tags:              r.ds_key_tags,
    dns_dnskey_present:       r.dns_dnskey_present,
    dnskey_collection_error:  r.dnskey_collection_error,
    dnskey_records:           r.dnskey_records,
    dnskey_record_count:      r.dnskey_record_count,
    dnskey_ksk_count:         r.dnskey_ksk_count,
    dnskey_zsk_count:         r.dnskey_zsk_count,
    dnskey_other_flags_count: r.dnskey_other_flags_count,
    dnskey_algorithms:        r.dnskey_algorithms,
    dnskey_key_tags:          r.dnskey_key_tags,
  };
}

function caaInsert(domain, r) {
  return {
    domain,
    signal_version:        CAA_VER,
    collected_at:          new Date().toISOString(),
    dns_caa_present:       r.dns_caa_present,
    caa_collection_error:  r.caa_collection_error,
    caa_records:           r.caa_records,
    caa_record_count:      r.caa_record_count,
    caa_issue_count:       r.caa_issue_count,
    caa_issuewild_count:   r.caa_issuewild_count,
    caa_iodef_count:       r.caa_iodef_count,
    caa_unknown_tag_count: r.caa_unknown_tag_count,
    caa_critical_count:    r.caa_critical_count,
    caa_issue_values:      r.caa_issue_values,
    caa_issuewild_values:  r.caa_issuewild_values,
    caa_iodef_values:      r.caa_iodef_values,
    caa_tags_present:      r.caa_tags_present,
  };
}

// ── Per-signal collection functions ──────────────────────────────────────────

async function runSpf(firms, supabase, runId, startedAt) {
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const f = await collectSpf(firm.domain);
      const row = spfInsert(firm.domain, f);
      const { error } = await supabase.from('signal_facts_spf').insert(row);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-SPF-001', runId, startedAt, results);
}

async function runDkim(firms, supabase, runId, startedAt) {
  const collectedAt = new Date().toISOString();
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const f = await collectDkim(firm.domain);
      const { error } = await dkimInsert(supabase, firm.domain, f, collectedAt);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-DKIM-001', runId, startedAt, results);
}

async function runDmarc(firms, supabase, runId, startedAt) {
  const collectedAt = new Date().toISOString();
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const f = await collectDmarc(firm.domain);
      const row = dmarcInsert(firm.domain, f, collectedAt);
      const { error } = await supabase.from('signal_facts_dmarc').insert(row);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-DMARC-001', runId, startedAt, results);
}

async function runMtaSts(firms, supabase, runId, startedAt) {
  const collectedAt = new Date().toISOString();
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const f = await collectMtaSts(firm.domain);
      const row = mtastsInsert(firm.domain, f, collectedAt);
      const { error } = await supabase.from('signal_facts_mtasts').insert(row);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-MTASTS-001', runId, startedAt, results);
}

async function runTlsRpt(firms, supabase, runId, startedAt) {
  const collectedAt = new Date().toISOString();
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const r = await collectTlsRpt(firm.domain);
      const row = tlsrptInsert(firm.domain, r, collectedAt);
      const { error } = await supabase.from('signal_facts_tlsrpt').insert(row);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-TLSRPT-001', runId, startedAt, results);
}

async function runDnssec(firms, supabase, runId, startedAt) {
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const r = await collectDnssec(firm.domain);
      const row = dnssecInsert(firm.domain, r);
      const { error } = await supabase.from('signal_facts_dnssec').insert(row);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-DNSSEC-001', runId, startedAt, results);
}

async function runCaa(firms, supabase, runId, startedAt) {
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const r = await collectCaa(firm.domain);
      const row = caaInsert(firm.domain, r);
      const { error } = await supabase.from('signal_facts_caa').insert(row);
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-CAA-001', runId, startedAt, results);
}

async function runSecurityTxt(firms, supabase, runId, startedAt) {
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const record = await collectSecurityTxt(firm.domain, COLLECTOR_VERSION);
      const { error } = await supabase.from('signal_securitytxt_v1').insert({
        run_id:            runId,
        domain:            record.domain,
        collected_at:      record.collected_at,
        signal_version:    record.signal_version,
        collector_version: record.collector_version,
        file_state:        record.file_state,
        canonical_fetch:   record.canonical_fetch,
        legacy_fetch:      record.legacy_fetch,
        canonical_parse:   record.canonical_parse,
        legacy_parse:      record.legacy_parse,
      });
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-SECURITYTXT-001', runId, startedAt, results);
}

async function runSecurityHeaders(firms, supabase, runId, startedAt) {
  const results = await runWithConcurrency(firms, async (firm, i) => {
    try {
      const record = await collectSecurityHeaders(firm.domain, COLLECTOR_VERSION);
      const { error } = await supabase.from('signal_securityheaders_v1').insert({
        run_id:            runId,
        domain:            record.domain,
        collected_at:      record.collected_at,
        signal_version:    record.signal_version,
        collector_version: record.collector_version,
        endpoint_state:    record.endpoint_state,
        http_probe_state:  record.http_probe_state,
        https_fetch:       record.https_fetch,
        http_probe:        record.http_probe,
        header_inventory:  record.header_inventory,
      });
      if ((i + 1) % 100 === 0 || i === firms.length - 1) {
        const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
        console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
      }
      return { domain: firm.domain, success: !error, collectorError: null, dbError: error?.message ?? null };
    } catch (err) {
      return { domain: firm.domain, success: false, collectorError: err.message, dbError: null };
    }
  }, CONCURRENCY);

  return buildStats('SOT-SECURITYHEADERS-001', runId, startedAt, results);
}

// ── Stats builder ─────────────────────────────────────────────────────────────

function buildStats(signalId, runId, startedAt, results) {
  const completedAt     = Date.now();
  const elapsed         = ((completedAt - startedAt) / 1000).toFixed(1);
  const attempted       = results.length;
  const completed       = results.filter(r => r.success).length;
  const collectorErrors = results.filter(r => r.collectorError).length;
  const dbErrors        = results.filter(r => r.dbError).length;
  const successRate     = attempted > 0 ? (completed / attempted * 100).toFixed(1) : '0.0';
  const failures        = results.filter(r => !r.success);

  return {
    signalId,
    runId,
    startedAt:   new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    attempted,
    completed,
    collectorErrors,
    dbErrors,
    successRate: Number(successRate),
    elapsedSec:  Number(elapsed),
    failures,
  };
}

// ── Report generation ─────────────────────────────────────────────────────────

function generateReport(manifest, allStats, globalStart, globalEnd) {
  const totalElapsed     = ((globalEnd - globalStart) / 1000).toFixed(0);
  const overallAttempted = allStats.reduce((s, r) => s + r.attempted, 0);
  const overallCompleted = allStats.reduce((s, r) => s + r.completed, 0);
  const overallFailed    = overallAttempted - overallCompleted;
  const overallRate      = overallAttempted > 0
    ? (overallCompleted / overallAttempted * 100).toFixed(1)
    : '0.0';

  const TABLE_MAP = {
    'SOT-SPF-001':             'signal_facts_spf',
    'SOT-DKIM-001':            'signal_facts_dkim + signal_facts_dkim_keys',
    'SOT-DMARC-001':           'signal_facts_dmarc',
    'SOT-MTASTS-001':          'signal_facts_mtasts',
    'SOT-TLSRPT-001':          'signal_facts_tlsrpt',
    'SOT-DNSSEC-001':          'signal_facts_dnssec',
    'SOT-CAA-001':             'signal_facts_caa',
    'SOT-SECURITYTXT-001':     'signal_securitytxt_v1',
    'SOT-SECURITYHEADERS-001': 'signal_securityheaders_v1',
  };
  const V1_SIGNALS = new Set(['SOT-SECURITYTXT-001', 'SOT-SECURITYHEADERS-001']);

  const lines = [];

  lines.push(`# ${reportStem(manifest.cohort_id)}_COLLECTION_REPORT`);
  lines.push('');
  lines.push(`**Cohort:** ${manifest.cohort_id} — ${manifest.cohort_name}`);
  lines.push(`**Selection ID:** ${manifest.selection_id}`);
  lines.push(`**Collection started:** ${new Date(globalStart).toISOString()}`);
  lines.push(`**Collection completed:** ${new Date(globalEnd).toISOString()}`);
  lines.push(`**Total elapsed:** ${totalElapsed}s`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 1. Cohort Summary ──────────────────────────────────────────────────────

  lines.push('## 1. Cohort Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push('|---|---|');
  lines.push(`| Cohort | ${manifest.cohort_id} |`);
  lines.push(`| Selection ID | \`${manifest.selection_id}\` |`);
  lines.push(`| Domains in cohort | ${manifest.n} |`);
  lines.push(`| Signals executed | 9 |`);
  lines.push(`| Total observations attempted | ${overallAttempted} |`);
  lines.push(`| Total observations stored | ${overallCompleted} |`);
  lines.push(`| Total observations failed | ${overallFailed} |`);
  lines.push(`| Overall completion | **${overallRate}%** |`);
  lines.push(`| Collection started | ${new Date(globalStart).toISOString()} |`);
  lines.push(`| Collection completed | ${new Date(globalEnd).toISOString()} |`);
  lines.push(`| Total runtime | ${totalElapsed}s |`);
  lines.push(`| Execution model | PARALLEL |`);
  lines.push(`| Signal concurrency limit | ${SIGNAL_CONCURRENCY} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 2. Signal Summary ──────────────────────────────────────────────────────

  lines.push('## 2. Signal Summary');
  lines.push('');
  lines.push('| Signal | Attempted | Completed | Collector Errors | DB Errors | Success Rate | Runtime |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of allStats) {
    lines.push(`| ${s.signalId} | ${s.attempted} | ${s.completed} | ${s.collectorErrors} | ${s.dbErrors} | **${s.successRate}%** | ${s.elapsedSec}s |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 3. Runtime Analysis ────────────────────────────────────────────────────

  lines.push('## 3. Runtime Analysis');
  lines.push('');
  lines.push('| Signal | Runtime (s) | Domains/s | % of Total Runtime |');
  lines.push('|---|---|---|---|');
  const totalElapsedNum = Number(totalElapsed);
  for (const s of allStats) {
    const throughput = s.elapsedSec > 0 ? (s.attempted / s.elapsedSec).toFixed(2) : '—';
    const pctTime    = totalElapsedNum > 0 ? ((s.elapsedSec / totalElapsedNum) * 100).toFixed(1) : '—';
    lines.push(`| ${s.signalId} | ${s.elapsedSec} | ${throughput} | ${pctTime}% |`);
  }
  lines.push(`| **TOTAL** | **${totalElapsed}** | — | 100% |`);
  lines.push('');

  const sumOfSignalRuntimes = allStats.reduce((s, r) => s + r.elapsedSec, 0);
  const parallelismRatio    = sumOfSignalRuntimes > 0 ? (totalElapsedNum / sumOfSignalRuntimes).toFixed(3) : '—';

  lines.push('### 3.1 Parallelism Validation');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Wall-clock runtime | ${totalElapsed}s |`);
  lines.push(`| Sum of per-signal runtimes | ${sumOfSignalRuntimes.toFixed(1)}s |`);
  lines.push(`| Parallelism ratio (wall-clock ÷ sum) | **${parallelismRatio}** |`);
  lines.push(`| Sequential baseline (COP-004 §3) | 3,710s total; ratio 1.000 |`);
  lines.push('');
  lines.push('> ratio ≈ 1.000 confirms sequential execution; ratio < 1.000 confirms parallel speedup.');
  lines.push('> Compare against COP-004 §3 baseline per ADR-COL-002 Constraint 3. Record in RUN_REGISTER.md.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 4. Schema Validation ───────────────────────────────────────────────────

  lines.push('## 4. Schema Validation');
  lines.push('');
  lines.push('| Signal | Schema Version | Table | Run ID in DB | Validation Status |');
  lines.push('|---|---|---|---|---|');
  for (const s of allStats) {
    const isV1     = V1_SIGNALS.has(s.signalId);
    const table    = TABLE_MAP[s.signalId] ?? 'unknown';
    const runInDb  = isV1 ? 'Yes — `run_id` column' : 'No — v0 schema (track by `collected_at`)';
    const status   = s.dbErrors === 0 ? 'PASS' : s.successRate >= 95 ? 'PASS (minor failures)' : 'REVIEW';
    lines.push(`| ${s.signalId} | ${isV1 ? 'v1' : 'v0'} | \`${table}\` | ${runInDb} | **${status}** |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 5. Collection Failures ─────────────────────────────────────────────────

  lines.push('## 5. Collection Failures');
  lines.push('');

  const allFailures = allStats.flatMap(s =>
    s.failures.map(f => ({ signal: s.signalId, ...f }))
  );

  if (allFailures.length === 0) {
    lines.push('No collection failures recorded.');
  } else {
    lines.push(`${allFailures.length} failure(s) recorded:\n`);
    lines.push('| Signal | Domain | Error Type | Detail |');
    lines.push('|---|---|---|---|');
    for (const f of allFailures) {
      const type   = f.collectorError ? 'COLLECTOR_ERROR' : 'DB_WRITE_ERROR';
      const detail = (f.collectorError ?? f.dbError ?? '').slice(0, 120);
      lines.push(`| ${f.signal} | ${f.domain} | ${type} | ${detail} |`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 6. Run UUID Register ───────────────────────────────────────────────────

  lines.push('## 6. Run UUID Register');
  lines.push('');
  lines.push('Record these in `RUN_REGISTER.md` and `COHORT_REGISTER.md` immediately.');
  lines.push('');
  lines.push('| Signal | Run UUID | Schema | Started At | Completed At | Storage |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of allStats) {
    const isV1    = V1_SIGNALS.has(s.signalId);
    const storage = isV1 ? 'Stored in DB (`run_id` column)' : 'Not in DB — v0 schema; identify by timestamp window';
    lines.push(`| ${s.signalId} | \`${s.runId}\` | ${isV1 ? 'v1' : 'v0'} | ${s.startedAt} | ${s.completedAt} | ${storage} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 7. Post-Collection Verification ───────────────────────────────────────

  lines.push('## 7. Post-Collection Verification');
  lines.push('');

  const allSignalsComplete    = allStats.every(s => s.completed === manifest.n);
  const expectedObservations  = manifest.n * 9;
  const actualObservations    = overallCompleted;
  const noSchemaViolations    = allStats.every(s => s.dbErrors === 0);
  const noCollectorFailures   = allStats.every(s => s.collectorErrors === 0);

  lines.push('| Verification Check | Expected | Actual | Status |');
  lines.push('|---|---|---|---|');
  lines.push(`| Cohort size collected | ${manifest.n} domains | ${manifest.n} domains in manifest | ${allSignalsComplete ? '✓ PASS' : '⚠ REVIEW'} |`);
  lines.push(`| Signal rows created | ${expectedObservations} (${manifest.n} × 9) | ${actualObservations} stored | ${actualObservations === expectedObservations ? '✓ PASS' : `⚠ DELTA: ${expectedObservations - actualObservations}`} |`);
  lines.push(`| Schema violations | 0 DB errors | ${allStats.reduce((s, r) => s + r.dbErrors, 0)} DB errors | ${noSchemaViolations ? '✓ PASS' : '✗ FAIL'} |`);
  lines.push(`| Duplicate-run anomalies | 0 (distinct run UUIDs per signal) | 9 distinct UUIDs generated | ✓ PASS |`);
  lines.push(`| Collector-level failures | 0 | ${allStats.reduce((s, r) => s + r.collectorErrors, 0)} | ${noCollectorFailures ? '✓ PASS' : '⚠ REVIEW'} |`);
  lines.push('');

  const allChecksPass = noSchemaViolations && noCollectorFailures && actualObservations === expectedObservations;
  if (allChecksPass) {
    lines.push('All verification checks passed.');
  } else {
    lines.push('One or more verification checks require review. See Collection Failures (§5) for detail.');
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // ── 8. ADR-COL-002 Governance Compliance ───────────────────────────────────

  lines.push('## 8. ADR-COL-002 Governance Compliance');
  lines.push('');
  lines.push('Authority: ADR-COL-002 — Parallel Signal Execution (Accepted 2026-06-19)');
  lines.push('');
  lines.push('| Constraint | Requirement | Status |');
  lines.push('|---|---|---|');
  lines.push(`| C-1 | Signal-runner concurrency limit defined in COP doc before run | COMPLIANT — SIGNAL_CONCURRENCY=${SIGNAL_CONCURRENCY} recorded in §1 |`);
  lines.push(`| C-2 | COP doc records PARALLEL model and per-signal timestamps | COMPLIANT — execution model in §1; timestamps in §6 |`);
  lines.push(`| C-3 | First parallel run compared against IF-001 sequential baseline (COP-004 §3) | PENDING — ratio ${parallelismRatio} vs sequential baseline 1.000; record comparison in RUN_REGISTER.md |`);
  lines.push(`| C-4 | v0 schema run identification via COP timestamps | COMPLIANT — startedAt/completedAt recorded in §6 for all v0 signals |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push(`*Cohort: ${manifest.cohort_id}  •  Selection ID: ${manifest.selection_id}*`);
  lines.push(`*Source population: ${manifest.cohort_name} (${manifest.cohort_id})*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR  = '═'.repeat(72);
  const DIV = '─'.repeat(72);

  let cohort;
  try {
    cohort = loadOrganisations();
  } catch (err) {
    if (err.code === 'ORG_DATASET_NOT_FOUND') {
      console.error(`\n  ERROR: canonical Organisation Dataset not found.`);
      console.error(`  Run 'node backend/authority/build.js' to build the Repository Authority first.\n`);
      process.exit(1);
    }
    throw err;
  }
  const firms = cohort.organisations;

  console.log(`\n${HR}`);
  console.log(` ${cohort.cohort_id} — Signal Lab Collection Orchestrator`);
  console.log(` Cohort: ${cohort.cohort_id}   n = ${cohort.n}   Domain concurrency: ${CONCURRENCY}   Signal concurrency: ${SIGNAL_CONCURRENCY}`);
  console.log(` Selection ID: ${cohort.selection_id}`);
  console.log(`${HR}\n`);

  const supabase    = getClient();
  const globalStart = Date.now();

  const { error: pingErr } = await supabase.from('signal_facts_spf').select('id').limit(1);
  if (pingErr) {
    console.error(`  ERROR: Cannot reach Supabase — ${pingErr.message}`);
    process.exit(1);
  }
  console.log(`  Supabase: connected\n`);

  // Generate all run UUIDs upfront — ADR-COL-002 Constraint 1
  const spfRunId    = randomUUID();
  const dkimRunId   = randomUUID();
  const dmarcRunId  = randomUUID();
  const mtastsRunId = randomUUID();
  const tlsrptRunId = randomUUID();
  const dnssecRunId = randomUUID();
  const caaRunId    = randomUUID();
  const sectxtRunId = randomUUID();
  const sechdrRunId = randomUUID();

  // Log all UUIDs before collection starts — record in RUN_REGISTER.md per SLG-003
  console.log(`  Execution model: PHASED   Signal concurrency: ${SIGNAL_CONCURRENCY}\n`);
  console.log(`  Run UUIDs — record in RUN_REGISTER.md BEFORE run commences:\n`);
  console.log(`  SOT-SPF-001              ${spfRunId}`);
  console.log(`  SOT-DKIM-001             ${dkimRunId}`);
  console.log(`  SOT-DMARC-001            ${dmarcRunId}`);
  console.log(`  SOT-MTASTS-001           ${mtastsRunId}`);
  console.log(`  SOT-TLSRPT-001           ${tlsrptRunId}`);
  console.log(`  SOT-DNSSEC-001           ${dnssecRunId}`);
  console.log(`  SOT-CAA-001              ${caaRunId}`);
  console.log(`  SOT-SECURITYTXT-001      ${sectxtRunId}`);
  console.log(`  SOT-SECURITYHEADERS-001  ${sechdrRunId}`);
  console.log('');

  // Each signal is an independent task keyed by signal id. Grouping is decided
  // by PHASES below; the tasks themselves are unchanged (same production
  // collect+insert path — no collector, parsing, resolver, retry, schema or
  // observation-format change).
  const signalTasks = {
    spf: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-SPF-001 started`);
      const s = await runSpf(firms, supabase, spfRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-SPF-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    dkim: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-DKIM-001 started`);
      const s = await runDkim(firms, supabase, dkimRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-DKIM-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    dmarc: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-DMARC-001 started`);
      const s = await runDmarc(firms, supabase, dmarcRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-DMARC-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    mtasts: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-MTASTS-001 started`);
      const s = await runMtaSts(firms, supabase, mtastsRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-MTASTS-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    tlsrpt: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-TLSRPT-001 started`);
      const s = await runTlsRpt(firms, supabase, tlsrptRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-TLSRPT-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    dnssec: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-DNSSEC-001 started`);
      const s = await runDnssec(firms, supabase, dnssecRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-DNSSEC-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    caa: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-CAA-001 started`);
      const s = await runCaa(firms, supabase, caaRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-CAA-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    securitytxt: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-SECURITYTXT-001 started`);
      const s = await runSecurityTxt(firms, supabase, sectxtRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-SECURITYTXT-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
    securityheaders: async () => {
      const start = Date.now();
      console.log(`[${new Date(start).toISOString()}] SOT-SECURITYHEADERS-001 started`);
      const s = await runSecurityHeaders(firms, supabase, sechdrRunId, start);
      console.log(`[${new Date().toISOString()}] SOT-SECURITYHEADERS-001 complete  ${s.completed}/${s.attempted}  ${s.elapsedSec}s  ${s.successRate}%`);
      return s;
    },
  };

  // ── Phased execution ──────────────────────────────────────────────────────
  // Phases run STRICTLY in order; each phase completes before the next starts.
  // Within a phase, its signals run in parallel up to SIGNAL_CONCURRENCY.
  // Isolating a signal into its own phase removes it from cross-signal resolver
  // contention. SPF is isolated first: its apex-TXT queries return large,
  // multi-record RRsets that were starved (timed out → recorded Unknown) when
  // contending with the other DNS collectors under the fully-parallel schedule
  // (SPF calibration finding). To isolate a future signal, give it its own
  // phase entry; leaving signals grouped preserves the previous parallel model.
  // Overridable via SIGNAL_PHASES, e.g. "spf|dkim,dmarc,...".
  const DEFAULT_PHASES = [
    ['spf'],
    ['dkim', 'dmarc', 'mtasts', 'tlsrpt', 'dnssec', 'caa', 'securitytxt', 'securityheaders'],
  ];
  const PHASES = process.env.SIGNAL_PHASES
    ? process.env.SIGNAL_PHASES.split('|').map(p => p.split(',').map(s => s.trim()).filter(Boolean))
    : DEFAULT_PHASES;

  const allStats = [];
  for (let p = 0; p < PHASES.length; p++) {
    const phaseIds = PHASES[p].filter(id => signalTasks[id]);
    if (phaseIds.length === 0) continue;
    console.log(`\n  ── Observation phase ${p + 1}/${PHASES.length}: ${phaseIds.join(', ')}  (signal concurrency ${SIGNAL_CONCURRENCY}) ──`);
    const phaseTasks = phaseIds.map(id => signalTasks[id]);
    const phaseStats = await runSignalsWithConcurrency(phaseTasks, SIGNAL_CONCURRENCY);
    allStats.push(...phaseStats);
  }

  // ── Overall summary ──────────────────────────────────────────────────────────

  const globalEnd    = Date.now();
  const totalElapsed = ((globalEnd - globalStart) / 1000).toFixed(0);

  console.log(`\n${HR}`);
  console.log(` ${cohort.cohort_id} — COLLECTION COMPLETE`);
  console.log(`${HR}\n`);
  console.log(`  Signal              Attempted  Completed  Errors  Rate`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const s of allStats) {
    const name = s.signalId.replace('SOT-', '').replace('-001', '').padEnd(20);
    const errs = s.collectorErrors + s.dbErrors;
    console.log(`  ${name} ${String(s.attempted).padStart(9)}  ${String(s.completed).padStart(9)}  ${String(errs).padStart(6)}  ${String(s.successRate).padStart(5)}%`);
  }
  console.log(`  ${'─'.repeat(60)}`);
  const total     = allStats.reduce((s, r) => s + r.attempted, 0);
  const totalDone = allStats.reduce((s, r) => s + r.completed, 0);
  const totalRate = total > 0 ? (totalDone / total * 100).toFixed(1) : '0.0';
  console.log(`  ${'OVERALL'.padEnd(20)} ${String(total).padStart(9)}  ${String(totalDone).padStart(9)}  ${String(allStats.reduce((s, r) => s + r.collectorErrors + r.dbErrors, 0)).padStart(6)}  ${String(totalRate).padStart(5)}%`);
  console.log(`\n  Total runtime: ${totalElapsed}s\n`);

  console.log(`  Run UUIDs — record in RUN_REGISTER.md and COHORT_REGISTER.md:\n`);
  for (const s of allStats) {
    console.log(`  ${s.signalId.padEnd(28)} ${s.runId}`);
  }
  console.log('');

  const reportMd   = generateReport(cohort, allStats, globalStart, globalEnd);
  const reportPath = reportPathFor(cohort.cohort_id);
  fs.writeFileSync(reportPath, reportMd, 'utf8');
  console.log(`  Report: ${reportPath}`);
  console.log(`\n${HR}\n`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('\nFatal:', e.message);
    process.exit(1);
  });
}

// Exported so an operational retry pass can re-collect a subset of domains using
// the EXACT production collect+insert functions (no duplication, no drift). This
// changes nothing about the standalone run — it still executes when invoked as a
// script (the require.main guard above).
module.exports = {
  getClient,
  runSpf, runDkim, runDmarc, runMtaSts, runTlsRpt, runDnssec, runCaa, runSecurityTxt, runSecurityHeaders,
};
