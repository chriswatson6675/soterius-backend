'use strict';

// Category D Runner — SOT-TLS-001 + SOT-CERTIFICATE-001
//
// Reads the HE-001 cohort CSV, establishes one TLS session per domain per run
// (ADR-COL-003 C-1 compliance), extracts both TLS and Certificate evidence
// from each session, writes results to signal_tls_v1 and signal_certificate_v1,
// and prints a combined Category D cohort summary.
//
// Architecture:
//   One RunContext is created at startup and shared across both signal pipelines.
//   For each domain: collectTLSSession() → one network call → two extractors →
//   two DB writes (one row in signal_tls_v1 and one row in signal_certificate_v1).
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/tls/run-category-d.js
//
// Prerequisites:
//   Migration 015_signal_lab_certificate.sql applied in Supabase Dashboard.
//   Migration 016_signal_lab_tls.sql applied in Supabase Dashboard.
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   CONCURRENCY               — optional, default 8
//   TLS_RUN_ID                — optional UUID; set to resume a failed TLS run
//   CERT_RUN_ID               — optional UUID; set to resume a failed Certificate run

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const fs             = require('node:fs');
const path           = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const { createRunContext, collectTLSSession } = require('./tls-collection-layer');
const { extractTLSEvidence,         promotedScalars: tlsScalars }  = require('./tls-extractor');
const { extractCertificateEvidence, promotedScalars: certScalars } = require('./certificate-extractor');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE       = 'HE-001';
const SIGNAL_VERSION    = '1.0.0';
const COLLECTOR_VERSION = '1.0.0';
const CSV_PATH          = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY       = Number(process.env.CONCURRENCY ?? 8);
const TLS_RUN_ID        = process.env.TLS_RUN_ID  ?? randomUUID();
const CERT_RUN_ID       = process.env.CERT_RUN_ID ?? randomUUID();

// ── Supabase client ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  }
  return createClient(url, key);
}

// ── CSV parsing (identical to other signal runners) ───────────────────────────

function splitCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function loadCohort() {
  const raw     = fs.readFileSync(CSV_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines   = raw.split('\n').filter(l => l.trim());
  const headers = splitCsvLine(lines[0]);

  const ukprnIdx    = headers.indexOf('UKPRN');
  const viewNameIdx = headers.indexOf('VIEW_NAME');
  const provNameIdx = headers.indexOf('PROVIDER_NAME');
  const urlIdx      = headers.indexOf('WEBSITE_URL');

  const institutions = [];
  const skipped      = [];

  for (const line of lines.slice(1)) {
    const f      = splitCsvLine(line);
    const rawUrl = f[urlIdx]?.trim();
    const name   = f[viewNameIdx]?.trim() || f[provNameIdx]?.trim() || '(unknown)';
    const ukprn  = f[ukprnIdx]?.trim() ?? '';

    if (!rawUrl) {
      skipped.push({ ukprn, name, reason: 'missing WEBSITE_URL' });
      continue;
    }

    let domain;
    try {
      domain = new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      skipped.push({ ukprn, name, reason: `unparseable URL: ${rawUrl}` });
      continue;
    }

    if (!domain) {
      skipped.push({ ukprn, name, reason: `no hostname in: ${rawUrl}` });
      continue;
    }

    institutions.push({ ukprn, name, domain });
  }

  return { institutions, skipped };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let   next    = 0;

  async function worker() {
    while (next < items.length) {
      const i    = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Supabase persistence ──────────────────────────────────────────────────────

async function insertTlsRecord(supabase, domain, tlsEvidence) {
  const scalars = tlsScalars(tlsEvidence);
  const { error } = await supabase.from('signal_tls_v1').insert({
    run_id:              TLS_RUN_ID,
    domain,
    collected_at:        tlsEvidence.collected_at,
    signal_version:      SIGNAL_VERSION,
    collector_version:   COLLECTOR_VERSION,
    endpoint_state:      scalars.endpoint_state,
    negotiated_version:  scalars.negotiated_version,
    cipher_suite_standard: scalars.cipher_suite_standard,
    forward_secrecy:     scalars.forward_secrecy,
    alpn_protocol:       scalars.alpn_protocol,
    http2_negotiated:    scalars.http2_negotiated,
    cipher_key_exchange: tlsEvidence.cipher_key_exchange,
    evidence:            tlsEvidence,
  });
  return error ?? null;
}

async function insertCertRecord(supabase, domain, certEvidence) {
  const scalars = certScalars(certEvidence);
  const { error } = await supabase.from('signal_certificate_v1').insert({
    run_id:                   CERT_RUN_ID,
    domain,
    collected_at:             certEvidence.collected_at,
    signal_version:           SIGNAL_VERSION,
    collector_version:        COLLECTOR_VERSION,
    endpoint_state:           scalars.endpoint_state,
    certificate_present:      scalars.certificate_present,
    tls_error_code:           scalars.tls_error_code,
    leaf_days_remaining:      scalars.leaf_days_remaining,
    leaf_issuer_cn:           scalars.leaf_issuer_cn,
    leaf_issuer_o:            scalars.leaf_issuer_o,
    leaf_subject_cn:          scalars.leaf_subject_cn,
    leaf_is_self_signed:      scalars.leaf_is_self_signed,
    leaf_is_wildcard:         scalars.leaf_is_wildcard,
    leaf_fingerprint_sha256:  scalars.leaf_fingerprint_sha256,
    evidence:                 certEvidence,
  });
  return error ?? null;
}

// ── Progress logging ──────────────────────────────────────────────────────────

function progressLine(domain, i, total, tlsEvid, certEvid) {
  const pct = String(Math.round(((i + 1) / total) * 100)).padStart(3);

  const es = tlsEvid.endpoint_state;
  const esTag = {
    RESPONSE_OBSERVED: 'RESP ',
    TLS_ERROR:         'TLS! ',
    CONNECTION_ERROR:  'CONN!',
  }[es] ?? es.slice(0, 5);

  // TLS fields
  const ver = tlsEvid.negotiated_version?.replace('TLSv', '') ?? '--';
  const fs  = tlsEvid.forward_secrecy === true  ? 'FS' :
              tlsEvid.forward_secrecy === false ? 'NO' : '??';
  const h2  = tlsEvid.http2_negotiated === true  ? 'h2' :
              tlsEvid.http2_negotiated === false ? 'h1' : '--';

  // Certificate fields
  const cp  = certEvid.certificate_present === 'CERTIFICATE_PRESENTED' ? 'CERT' :
              certEvid.certificate_present === 'NO_CERTIFICATE'        ? 'NONE' :
              certEvid.certificate_present === 'HANDSHAKE_INCOMPLETE'  ? 'INCM' :
              certEvid.certificate_present == null                     ? '----' : '?';

  const vr  = (certEvid.tls_verification_result ?? '').replace('CHAIN_VERIFIED', 'OK')
                                                        .replace('CERT_EXPIRED', 'EXP')
                                                        .replace('SELF_SIGNED', 'SS')
                                                        .replace('SELF_SIGNED_IN_CHAIN', 'SSC')
                                                        .replace('HOSTNAME_MISMATCH', 'HMM')
                                                        .replace('CHAIN_UNVERIFIABLE', 'UNV')
                                                        .replace('CERT_REVOKED', 'REV')
                                                        .replace('OTHER_TLS_ERROR', 'OTH')
                                                        .slice(0, 4) || '----';

  const days = certEvid.leaf_days_remaining != null
    ? String(certEvid.leaf_days_remaining).padStart(5)
    : '    -';

  return `  [${pct}%]  ${domain.padEnd(36)} [${esTag}] v${ver} ${fs} ${h2}  ${cp} ${vr} ${days}d`;
}

// ── Domain processing ─────────────────────────────────────────────────────────

async function processDomain(inst, i, total, supabase, runContext) {
  let tlsSession    = null;
  let extractError  = null;
  let tlsEvid       = null;
  let certEvid      = null;
  let tlsDbError    = null;
  let certDbError   = null;

  // One TLS session per domain — C-1 guaranteed by RunContext.
  // collectTLSSession never rejects.
  tlsSession = await collectTLSSession(inst.domain, runContext, { timeout: 30000 });

  try {
    tlsEvid  = extractTLSEvidence(tlsSession);
    certEvid = extractCertificateEvidence(tlsSession);
  } catch (err) {
    extractError = err.message ?? String(err);
  }

  if (tlsEvid) {
    try {
      tlsDbError = await insertTlsRecord(supabase, inst.domain, tlsEvid);
    } catch (err) {
      tlsDbError = { message: err.message ?? String(err) };
    }
  }

  if (certEvid) {
    try {
      certDbError = await insertCertRecord(supabase, inst.domain, certEvid);
    } catch (err) {
      certDbError = { message: err.message ?? String(err) };
    }
  }

  const line = tlsEvid && certEvid
    ? progressLine(inst.domain, i, total, tlsEvid, certEvid)
    : `  [${String(Math.round(((i + 1) / total) * 100)).padStart(3)}%]  ${inst.domain.padEnd(36)} [ERR!] extract: ${extractError}`;

  if (tlsDbError)  process.stdout.write(`${line}  [TLS-DB:${tlsDbError.message?.slice(0, 25)}]\n`);
  else if (certDbError) process.stdout.write(`${line}  [CERT-DB:${certDbError.message?.slice(0, 25)}]\n`);
  else             process.stdout.write(`${line}\n`);

  return { ...inst, tlsEvid, certEvid, tlsSession, extractError, tlsDbError, certDbError };
}

// ── Summary computation ───────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function dist(rows, accessor, label = null) {
  const counts = {};
  for (const r of rows) {
    const v = accessor(r);
    const k = v == null ? '(null)' : String(v);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function computeSummary(rows) {
  const total = rows.length;
  const observed = rows.filter(r => r.tlsEvid?.endpoint_state === 'RESPONSE_OBSERVED');
  const no = observed.length;

  // Outcome
  const byState     = {};
  const tlsDbErrors = rows.filter(r => r.tlsDbError).length;
  const certDbErrors = rows.filter(r => r.certDbError).length;
  const extractErrors = rows.filter(r => r.extractError).length;
  for (const r of rows) {
    const s = r.tlsEvid?.endpoint_state ?? 'EXTRACT_ERROR';
    byState[s] = (byState[s] ?? 0) + 1;
  }

  // TLS version distribution (RESPONSE_OBSERVED)
  const byVersion = {};
  for (const r of observed) {
    const v = r.tlsEvid.negotiated_version ?? '(null)';
    byVersion[v] = (byVersion[v] ?? 0) + 1;
  }

  // Forward secrecy (RESPONSE_OBSERVED, non-null)
  const fsRows  = observed.filter(r => r.tlsEvid.forward_secrecy !== null);
  const fsTrue  = fsRows.filter(r => r.tlsEvid.forward_secrecy === true).length;
  const fsFalse = fsRows.filter(r => r.tlsEvid.forward_secrecy === false).length;
  const fsNull  = observed.length - fsRows.length;

  // Cipher key exchange (RESPONSE_OBSERVED, non-null)
  const byCipher = {};
  for (const r of observed) {
    const k = r.tlsEvid.cipher_key_exchange ?? '(null)';
    byCipher[k] = (byCipher[k] ?? 0) + 1;
  }

  // ALPN (RESPONSE_OBSERVED)
  const byAlpn = {};
  for (const r of observed) {
    const k = r.tlsEvid.alpn_protocol ?? '(null — no ALPN)';
    byAlpn[k] = (byAlpn[k] ?? 0) + 1;
  }
  const h2Count = observed.filter(r => r.tlsEvid.http2_negotiated === true).length;

  // Certificate presence (all rows)
  const byCertPresent = {};
  for (const r of rows) {
    const k = r.certEvid?.certificate_present ?? '(null)';
    byCertPresent[k] = (byCertPresent[k] ?? 0) + 1;
  }

  // Verification result (RESPONSE_OBSERVED with cert)
  const certRows = observed.filter(r => r.certEvid?.certificate_present === 'CERTIFICATE_PRESENTED');
  const nc = certRows.length;
  const byVerif = {};
  for (const r of certRows) {
    const v = r.certEvid.tls_verification_result ?? '(null)';
    byVerif[v] = (byVerif[v] ?? 0) + 1;
  }

  // Days to expiry buckets (non-null, non-expired)
  const expiryRows = certRows.filter(r => r.certEvid.leaf_days_remaining != null);
  const expired    = expiryRows.filter(r => r.certEvid.leaf_days_remaining < 0).length;
  const under30    = expiryRows.filter(r => r.certEvid.leaf_days_remaining >= 0   && r.certEvid.leaf_days_remaining <   30).length;
  const under90    = expiryRows.filter(r => r.certEvid.leaf_days_remaining >= 30  && r.certEvid.leaf_days_remaining <   90).length;
  const under365   = expiryRows.filter(r => r.certEvid.leaf_days_remaining >= 90  && r.certEvid.leaf_days_remaining <  365).length;
  const over365    = expiryRows.filter(r => r.certEvid.leaf_days_remaining >= 365).length;

  // Wildcard (non-null san rows)
  const wildcardRows = certRows.filter(r => r.certEvid.leaf_is_wildcard !== null);
  const wildcardTrue = wildcardRows.filter(r => r.certEvid.leaf_is_wildcard === true).length;
  const wildcardNull = certRows.length - wildcardRows.length;

  // Self-signed
  const selfSignedRows = certRows.filter(r => r.certEvid.leaf_is_self_signed !== null);
  const selfSignedTrue = selfSignedRows.filter(r => r.certEvid.leaf_is_self_signed === true).length;

  // Top issuers (by CN)
  const byIssuerCn = {};
  for (const r of certRows) {
    const k = r.certEvid.leaf_issuer_cn ?? '(null)';
    byIssuerCn[k] = (byIssuerCn[k] ?? 0) + 1;
  }

  // Key type (RESPONSE_OBSERVED with cert)
  const byKeyType = {};
  for (const r of certRows) {
    const k = r.certEvid.leaf_key_type ?? '(null)';
    byKeyType[k] = (byKeyType[k] ?? 0) + 1;
  }

  // Cipher suite standard name — top 10 (RESPONSE_OBSERVED)
  const byCipherSuite = {};
  for (const r of observed) {
    const k = r.tlsEvid.cipher_suite_standard ?? '(null)';
    byCipherSuite[k] = (byCipherSuite[k] ?? 0) + 1;
  }

  return {
    total, no, nc,
    tlsDbErrors, certDbErrors, extractErrors,
    byState, byVersion, byAlpn, byCipher, byCipherSuite,
    fsTrue, fsFalse, fsNull, fsRows: fsRows.length, h2Count,
    byCertPresent, byVerif,
    expired, under30, under90, under365, over365, expiryRows: expiryRows.length,
    wildcardTrue, wildcardNull, wildcardRows: wildcardRows.length,
    selfSignedTrue, selfSignedRows: selfSignedRows.length,
    byIssuerCn, byKeyType,
  };
}

// ── Summary output ────────────────────────────────────────────────────────────

function printSummary(s, startedAt, skipped) {
  const HR  = '═'.repeat(76);
  const DIV = '─'.repeat(76);
  const { total, no, nc } = s;

  console.log(`\n${HR}`);
  console.log(` CATEGORY D — TLS & CERTIFICATE TRUST — HE-001 COHORT SUMMARY`);
  console.log(` Signals: SOT-TLS-001 v1.0 + SOT-CERTIFICATE-001 v1.0   Cohort: ${COHORT_CODE}   n=${total}`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(` TLS Run ID : ${TLS_RUN_ID}`);
  console.log(` Cert Run ID: ${CERT_RUN_ID}`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain`);
  }
  console.log(HR);

  // ── 1. Collection state ──────────────────────────────────────────────────────
  console.log(`\n 1. COLLECTION STATE  (all ${total} domains)\n`);
  const stateOrder = ['RESPONSE_OBSERVED', 'TLS_ERROR', 'CONNECTION_ERROR', 'EXTRACT_ERROR'];
  for (const state of stateOrder) {
    const n = s.byState[state] ?? 0;
    if (n > 0) console.log(`    ${state.padEnd(22)}: ${String(n).padStart(4)}   ${pct(n, total)}`);
  }
  console.log(`\n    Analysis base — RESPONSE_OBSERVED: ${no} domains`);
  console.log(`    Certificates presented: ${nc} of ${no} (${pct(nc, no)})`);
  if (s.tlsDbErrors + s.certDbErrors + s.extractErrors > 0) {
    console.log(`\n    WARNING — errors requiring investigation:`);
    if (s.extractErrors  > 0) console.log(`      Extractor exceptions : ${s.extractErrors}`);
    if (s.tlsDbErrors    > 0) console.log(`      TLS DB write failures : ${s.tlsDbErrors}  — retry with TLS_RUN_ID=${TLS_RUN_ID}`);
    if (s.certDbErrors   > 0) console.log(`      Cert DB write failures: ${s.certDbErrors}  — retry with CERT_RUN_ID=${CERT_RUN_ID}`);
  }

  // ── 2. TLS version ───────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 2. TLS VERSION DISTRIBUTION  (${no} RESPONSE_OBSERVED domains)\n`);
  const versionOrder = ['TLSv1.3', 'TLSv1.2', 'TLSv1.1', 'TLSv1', 'SSLv3', '(null)'];
  for (const v of versionOrder) {
    const n = s.byVersion[v] ?? 0;
    if (n > 0) {
      const bar = '█'.repeat(Math.round(n / no * 30));
      console.log(`    ${v.padEnd(10)}: ${String(n).padStart(4)}  ${pct(n, no)}  ${bar}`);
    }
  }

  // ── 3. Forward secrecy ───────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  const fsBase = s.fsRows;
  console.log(`\n 3. FORWARD SECRECY  (${fsBase} domains with identifiable cipher; ${s.fsNull} null — excluded)\n`);
  console.log(`    Forward secrecy: YES : ${String(s.fsTrue).padStart(4)}   ${pct(s.fsTrue, fsBase)}`);
  console.log(`    Forward secrecy: NO  : ${String(s.fsFalse).padStart(4)}   ${pct(s.fsFalse, fsBase)}`);
  console.log(`    Null (unrecognised)  : ${String(s.fsNull).padStart(4)}   ${pct(s.fsNull, no)}`);

  // ── 4. Cipher key exchange ───────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 4. CIPHER KEY EXCHANGE  (${no} RESPONSE_OBSERVED domains)\n`);
  for (const [k, n] of Object.entries(s.byCipher).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(10)}: ${String(n).padStart(4)}   ${pct(n, no)}`);
  }

  // ── 5. ALPN / HTTP2 ──────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 5. ALPN / HTTP/2  (${no} RESPONSE_OBSERVED domains)\n`);
  console.log(`    HTTP/2 negotiated (h2)   : ${String(s.h2Count).padStart(4)}   ${pct(s.h2Count, no)}`);
  for (const [k, n] of Object.entries(s.byAlpn).sort((a, b) => b[1] - a[1])) {
    console.log(`    ALPN=${k.padEnd(20)}: ${String(n).padStart(4)}   ${pct(n, no)}`);
  }

  // ── 6. Top cipher suites ─────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 6. TOP CIPHER SUITES  (${no} RESPONSE_OBSERVED domains)\n`);
  const topCiphers = Object.entries(s.byCipherSuite).sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [k, n] of topCiphers) {
    console.log(`    ${String(n).padStart(4)}   ${pct(n, no)}   ${k}`);
  }

  // ── 7. Certificate verification ──────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 7. TLS VERIFICATION  (${nc} domains with certificate)\n`);
  const verifOrder = ['CHAIN_VERIFIED', 'CERT_EXPIRED', 'SELF_SIGNED', 'SELF_SIGNED_IN_CHAIN',
                      'HOSTNAME_MISMATCH', 'CHAIN_UNVERIFIABLE', 'CERT_REVOKED', 'OTHER_TLS_ERROR', 'UNKNOWN'];
  for (const v of verifOrder) {
    const n = s.byVerif[v] ?? 0;
    if (n > 0) {
      const bar = '█'.repeat(Math.round(n / nc * 30));
      console.log(`    ${v.padEnd(22)}: ${String(n).padStart(4)}   ${pct(n, nc)}  ${bar}`);
    }
  }

  // ── 8. Certificate expiry ────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  const eb = s.expiryRows;
  console.log(`\n 8. CERTIFICATE EXPIRY  (${eb} domains with date info)\n`);
  console.log(`    Expired (< 0 days)  : ${String(s.expired).padStart(4)}   ${pct(s.expired, eb)}`);
  console.log(`    Expiring < 30 days  : ${String(s.under30).padStart(4)}   ${pct(s.under30, eb)}`);
  console.log(`    Expiring 30–90 days : ${String(s.under90).padStart(4)}   ${pct(s.under90, eb)}`);
  console.log(`    Expiring 90–365 days: ${String(s.under365).padStart(4)}   ${pct(s.under365, eb)}`);
  console.log(`    Expiring > 365 days : ${String(s.over365).padStart(4)}   ${pct(s.over365, eb)}`);

  // ── 9. Wildcard / self-signed ─────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n 9. CERTIFICATE PROPERTIES  (${nc} domains with certificate)\n`);
  const wb = s.wildcardRows;
  console.log(`    Wildcard SAN (base: ${wb} with SANs, ${s.wildcardNull} null — no SANs):`);
  console.log(`      Wildcard present : ${String(s.wildcardTrue).padStart(4)}   ${pct(s.wildcardTrue, wb)}`);
  console.log(`      Not wildcard     : ${String(wb - s.wildcardTrue).padStart(4)}   ${pct(wb - s.wildcardTrue, wb)}`);
  const sb = s.selfSignedRows;
  console.log(`\n    Self-signed (base: ${sb} with identifiable DNs):`);
  console.log(`      Self-signed      : ${String(s.selfSignedTrue).padStart(4)}   ${pct(s.selfSignedTrue, sb)}`);
  console.log(`      Not self-signed  : ${String(sb - s.selfSignedTrue).padStart(4)}   ${pct(sb - s.selfSignedTrue, sb)}`);

  // ── 10. Top issuers ───────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n10. TOP CERTIFICATE ISSUERS  (${nc} domains with certificate)\n`);
  const topIssuers = Object.entries(s.byIssuerCn).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [k, n] of topIssuers) {
    const label = k.length > 40 ? k.slice(0, 39) + '…' : k;
    console.log(`    ${String(n).padStart(4)}   ${pct(n, nc)}   ${label}`);
  }

  // ── 11. Key type ──────────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n11. PUBLIC KEY TYPE  (${nc} domains with certificate)\n`);
  for (const [k, n] of Object.entries(s.byKeyType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(10)}: ${String(n).padStart(4)}   ${pct(n, nc)}`);
  }

  // ── COP metrics ───────────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log(`\n12. COP-007 METRICS  (collection-observable proportions)\n`);
  console.log(`    These metrics are pre-computed from the collection run.`);
  console.log(`    COP-007 will formalise the COP document from this output.\n`);
  const fsBase2 = s.fsRows;
  const fsRate  = fsBase2 > 0 ? ((s.fsTrue / fsBase2) * 100).toFixed(1) : 'N/A';
  const tlsv13  = no > 0 ? (((s.byVersion['TLSv1.3'] ?? 0) / no) * 100).toFixed(1) : 'N/A';
  const h2Rate  = no > 0 ? ((s.h2Count / no) * 100).toFixed(1) : 'N/A';
  const chainOk = nc > 0 ? (((s.byVerif['CHAIN_VERIFIED'] ?? 0) / nc) * 100).toFixed(1) : 'N/A';
  const expiredRate = eb > 0 ? ((s.expired / eb) * 100).toFixed(1) : 'N/A';
  console.log(`    Forward secrecy rate          : ${fsRate}%  (${s.fsTrue}/${fsBase2} identifiable ciphers)`);
  console.log(`    TLS 1.3 adoption              : ${tlsv13}%  (${s.byVersion['TLSv1.3'] ?? 0}/${no} RESPONSE_OBSERVED)`);
  console.log(`    HTTP/2 negotiation rate        : ${h2Rate}%  (${s.h2Count}/${no} RESPONSE_OBSERVED)`);
  console.log(`    Certificate chain valid rate   : ${chainOk}%  (${s.byVerif['CHAIN_VERIFIED'] ?? 0}/${nc} certs)`);
  console.log(`    Expired certificate rate       : ${expiredRate}%  (${s.expired}/${eb} with date info)`);

  console.log(`\n${HR}\n`);
}

// ── Pre-flight checks ─────────────────────────────────────────────────────────

async function checkTable(supabase, tableName, migrationFile) {
  const { error } = await supabase.from(tableName).select('id').limit(1);
  if (error) {
    const missing = error.message?.includes('does not exist') || error.code === '42P01';
    if (missing) {
      console.error(`\n  ERROR: ${tableName} table not found.`);
      console.error(`  Apply backend/db/migrations/${migrationFile} in Supabase first.\n`);
    } else {
      console.error(`\n  ERROR: Supabase — ${tableName} — ${error.message}\n`);
    }
    return false;
  }
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(76);
  const startedAt = new Date();

  console.log(`\n${HR}`);
  console.log(` CATEGORY D — TLS & CERTIFICATE TRUST — HE-001 COHORT COLLECTION`);
  console.log(` SOT-TLS-001 v1.0 + SOT-CERTIFICATE-001 v1.0   ADR-COL-003 C-1`);
  console.log(` Started   : ${startedAt.toISOString()}`);
  console.log(` TLS Run ID : ${TLS_RUN_ID}`);
  console.log(` Cert Run ID: ${CERT_RUN_ID}`);
  console.log(` Concurrency: ${CONCURRENCY}`);
  console.log(HR);

  const { institutions, skipped } = loadCohort();
  console.log(`\n  Cohort: ${institutions.length} institutions loaded`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s):`);
    for (const sk of skipped) {
      console.log(`    • UKPRN ${sk.ukprn}  ${sk.name}  [${sk.reason}]`);
    }
  }

  const supabase = getClient();

  const tlsOk  = await checkTable(supabase, 'signal_tls_v1',         '016_signal_lab_tls.sql');
  const certOk = await checkTable(supabase, 'signal_certificate_v1', '015_signal_lab_certificate.sql');
  if (!tlsOk || !certOk) process.exit(1);

  console.log('  Supabase: signal_tls_v1 ✓  signal_certificate_v1 ✓\n');

  // One RunContext for all domains — C-1 compliance per ADR-COL-003.
  // A domain requested concurrently by both extractors shares one TLS session.
  const runContext = createRunContext();

  console.log(`${'─'.repeat(76)}`);
  console.log(` Collecting — ${institutions.length} institutions  concurrency: ${CONCURRENCY}`);
  console.log(` Columns: [endpoint] [TLS version] [FS] [ALPN] [CertPresent] [Verif] [DaysLeft]`);
  console.log(`${'─'.repeat(76)}\n`);

  const t0 = Date.now();

  const rows = await runWithConcurrency(
    institutions,
    (inst, i) => processDomain(inst, i, institutions.length, supabase, runContext),
    CONCURRENCY,
  );

  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
  const tlsErrs  = rows.filter(r => r.tlsDbError).length;
  const certErrs = rows.filter(r => r.certDbError).length;
  const extErrs  = rows.filter(r => r.extractError).length;

  console.log(`\n  Completed: ${institutions.length} institutions in ${elapsed}s`);
  if (tlsErrs  > 0) console.log(`  WARNING: ${tlsErrs} TLS DB write(s) failed`);
  if (certErrs > 0) console.log(`  WARNING: ${certErrs} Certificate DB write(s) failed`);
  if (extErrs  > 0) console.log(`  WARNING: ${extErrs} extractor exception(s)`);

  const summary = computeSummary(rows);
  printSummary(summary, startedAt, skipped);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
