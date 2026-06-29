'use strict';

// registrar-collector.js — Registrar Trust signal collector
//
// Implements SOT-REGISTRAR-001 v1.0 — Registrar Trust.
// Assessment unit: unique registrar IANA ID (not domain).
// Primary data source: IANA Registrar IDs XHTML dataset (Scope 1, ICANN contracted parties).
//
// Collection architecture (SOT-REGISTRAR-001 §5.2 + ITA-REGISTRAR-001):
//   1. Download IANA registrar IDs XHTML page once per run (batch dataset approach)
//   2. Parse HTML table into an in-memory lookup map (ianaId → {name, status})
//   3. Look up each unique registrar IANA ID from the upstream SOT-DR-001 run
//   4. Produce 16-field evidence blocks per SOT-REGISTRAR-001 §7.1
//   5. Persist one row per unique IANA ID to signal_registrar_v1
//
// Data source: https://www.iana.org/assignments/registrar-ids/registrar-ids.xhtml
//   Available fields: IANA ID, Registrar Name, Accreditation Status, RDAP URL
//   Not available in v1.0 (IANA page limitation):
//     country_code, country_name, accreditation_date, raa_version,
//     ssad_participant, abuse_email_published, abuse_telephone_published
//   Scope 3 fields (not collected in v1.0):
//     whois_policy_published, registration_agreement_published
//
// Amendment 1 enforcement: icann_query_outcome and registrar_accreditation_status
//   use separate vocabularies. Query-level outcomes are never stored in
//   registrar_accreditation_status. See SOT-REGISTRAR-001 §7.2.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Authority: SOT-REGISTRAR-001 v1.0, ITA-REGISTRAR-001, LCR-REGISTRAR-001

const https = require('node:https');
const http  = require('node:http');

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNAL_ID        = 'registrar';
const SIGNAL_VERSION   = '1.0';
const COLLECTOR_VERSION = '1.0.0';
const TABLE_NAME       = 'signal_registrar_v1';

const IANA_DATASET_URL = 'https://www.iana.org/assignments/registrar-ids/registrar-ids.xhtml';
const IANA_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_ATTEMPTS  = 2;
const DEFAULT_RETRY_DELAY_MS  = 3000;

// Four-state query outcome vocabulary (Amendment 1; SOT-REGISTRAR-001 §7.2)
const QUERY_OUTCOMES = Object.freeze({
  QUERY_SUCCESS:   'QUERY_SUCCESS',
  NOT_FOUND:       'NOT_FOUND',
  IANA_ID_ABSENT:  'IANA_ID_ABSENT',
  QUERY_ERROR:     'QUERY_ERROR',
});

// Three-state accreditation status vocabulary (Amendment 1; SOT-REGISTRAR-001 §7.2)
const ACCREDITATION_STATUS = Object.freeze({
  ACCREDITED:  'ACCREDITED',
  SUSPENDED:   'SUSPENDED',
  TERMINATED:  'TERMINATED',
});

// IANA page status string → accreditation status vocabulary
const IANA_STATUS_MAP = Object.freeze({
  'Accredited':  ACCREDITATION_STATUS.ACCREDITED,
  'Suspended':   ACCREDITATION_STATUS.SUSPENDED,
  'Terminated':  ACCREDITATION_STATUS.TERMINATED,
});

// ── IANA dataset download and parse ──────────────────────────────────────────

/**
 * Downloads and parses the IANA registrar IDs XHTML dataset.
 * Returns a Map<ianaId (string), {name, accreditationStatus}>.
 *
 * ianaId: string (e.g. '146')
 * name: string (registrar name from column 2)
 * accreditationStatus: ACCREDITED | SUSPENDED | TERMINATED | null (for Reserved)
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=30000]
 * @param {number} [options.retryAttempts=2]
 * @param {number} [options.retryDelayMs=3000]
 * @param {function} [options._fetchFn] - Injectable for testing
 * @returns {Promise<Map<string, {name: string, accreditationStatus: string|null}>>}
 */
async function downloadIanaDataset(options = {}) {
  const timeoutMs     = options.timeoutMs     ?? IANA_REQUEST_TIMEOUT_MS;
  const retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const retryDelayMs  = options.retryDelayMs  ?? DEFAULT_RETRY_DELAY_MS;
  const fetchFn       = options._fetchFn      ?? _httpGet;

  let lastError;
  for (let attempt = 0; attempt <= retryAttempts; attempt++) {
    if (attempt > 0) {
      await _sleep(retryDelayMs);
    }
    try {
      const html = await fetchFn(IANA_DATASET_URL, timeoutMs);
      return _parseIanaHtml(html);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Parses the IANA registrar IDs XHTML page into a lookup map.
 * Table columns: IANA ID | Registrar Name | Status | RDAP URL (optional)
 *
 * @param {string} html
 * @returns {Map<string, {name: string, accreditationStatus: string|null}>}
 */
function _parseIanaHtml(html) {
  const lookup = new Map();

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => _stripHtml(m[1]));

    if (cells.length < 2) continue;
    const ianaId = cells[0].trim();
    if (!/^\d+$/.test(ianaId)) continue;

    const name   = cells[1]?.trim() ?? '';
    const status = cells[2]?.trim() ?? '';

    lookup.set(ianaId, {
      name:                 name || null,
      accreditationStatus:  IANA_STATUS_MAP[status] ?? null,
    });
  }

  return lookup;
}

function _stripHtml(raw) {
  return (raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * HTTP(S) GET — returns response body as string.
 * Follows redirects (limited depth). Injectable in tests via options._fetchFn.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function _httpGet(url, timeoutMs, _depth = 0) {
  if (_depth > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? https : http;

    const req = mod.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'soterius-signal-lab/1.0 (Signal SOT-REGISTRAR-001)', 'Accept': 'text/html' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        resolve(_httpGet(next, timeoutMs, _depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`IANA dataset HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('IANA dataset request timed out'));
    });
    req.on('error', reject);
  });
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Per-registrar evidence collection ────────────────────────────────────────

/**
 * Assesses a single registrar IANA ID against the IANA lookup dataset.
 * Returns a 16-field evidence object per SOT-REGISTRAR-001 §7.1.
 *
 * Never rejects — errors are captured as QUERY_ERROR evidence.
 *
 * @param {string|null} ianaId - The registrar IANA ID from SOT-DOMAINREGISTRATION-001
 * @param {Map|null}    lookup - The IANA dataset lookup map (null triggers QUERY_ERROR)
 * @returns {EvidenceObject}
 */
function assessRegistrar(ianaId, lookup) {
  const timestamp = new Date().toISOString();

  if (ianaId === null || ianaId === undefined) {
    return _buildEvidence({
      ianaId: null,
      outcome: QUERY_OUTCOMES.IANA_ID_ABSENT,
      name:   null,
      status: null,
      timestamp,
    });
  }

  if (lookup === null) {
    return _buildEvidence({
      ianaId,
      outcome: QUERY_OUTCOMES.QUERY_ERROR,
      name:   null,
      status: null,
      timestamp,
    });
  }

  const entry = lookup.get(String(ianaId));

  if (!entry) {
    return _buildEvidence({
      ianaId,
      outcome: QUERY_OUTCOMES.NOT_FOUND,
      name:   null,
      status: null,
      timestamp,
    });
  }

  if (!entry.accreditationStatus) {
    // Entry exists (Reserved status) but has no ACCREDITED/SUSPENDED/TERMINATED state
    return _buildEvidence({
      ianaId,
      outcome: QUERY_OUTCOMES.NOT_FOUND,
      name:   entry.name,
      status: null,
      timestamp,
    });
  }

  return _buildEvidence({
    ianaId,
    outcome: QUERY_OUTCOMES.QUERY_SUCCESS,
    name:    entry.name,
    status:  entry.accreditationStatus,
    timestamp,
  });
}

/**
 * Builds a complete 16-field evidence block per SOT-REGISTRAR-001 §7.1.
 * All 16 fields are always present; inapplicable fields are null.
 *
 * @param {Object} params
 * @returns {EvidenceObject}
 */
function _buildEvidence({ ianaId, outcome, name, status, timestamp }) {
  const isSuccess = outcome === QUERY_OUTCOMES.QUERY_SUCCESS;

  return {
    // RD-01 — ICANN Accreditation Evidence
    icann_query_outcome:            outcome,
    registrar_accreditation_status: isSuccess ? status : null,
    registrar_iana_id:              outcome === QUERY_OUTCOMES.IANA_ID_ABSENT ? null : ianaId,
    registrar_name:                 isSuccess ? (name ?? null) : null,
    registrar_accreditation_date:   null,   // Not available from IANA dataset in v1.0
    registrar_raa_version:          null,   // Not available from IANA dataset in v1.0

    // RD-02 — Registrar Jurisdictional Identity
    registrar_country_code:                 null,   // Not available from IANA dataset in v1.0
    registrar_country_name:                 null,   // Derived from country_code; null in v1.0
    registrar_registrant_country_alignment: null,   // Requires country_code; null in v1.0

    // RD-03 — Registrar Governance Transparency (ICANN-sourced, all null in v1.0)
    registrar_ssad_participant:                 null,   // Not available from IANA dataset in v1.0
    registrar_abuse_email_published:            null,   // Not available from IANA dataset in v1.0
    registrar_abuse_telephone_published:        null,   // Not available from IANA dataset in v1.0
    // Scope 3 (website-sourced) — always null in v1.0
    registrar_whois_policy_published:           null,
    registrar_registration_agreement_published: null,

    // Collection context
    icann_query_timestamp: timestamp,
    icann_query_iana_id:   outcome === QUERY_OUTCOMES.IANA_ID_ABSENT ? null : ianaId,
  };
}

// ── Promoted scalar extraction ────────────────────────────────────────────────

/**
 * Extracts the 7 promoted scalar columns from an evidence object.
 * Used to populate scalar columns in signal_registrar_v1.
 *
 * @param {EvidenceObject} evidence
 * @returns {ScalarColumns}
 */
function extractPromotedScalars(evidence) {
  return {
    registrar_iana_id:              evidence.registrar_iana_id,
    icann_query_outcome:            evidence.icann_query_outcome,
    registrar_accreditation_status: evidence.registrar_accreditation_status,
    registrar_country_code:         evidence.registrar_country_code,
    registrar_raa_version:          evidence.registrar_raa_version,
    registrar_ssad_participant:     evidence.registrar_ssad_participant,
    icann_query_timestamp:          evidence.icann_query_timestamp,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Inserts a single registrar evidence record into signal_registrar_v1.
 * Only called for non-null IANA IDs (IANA_ID_ABSENT rows are not stored).
 *
 * @param {Object}    supabase
 * @param {string}    runId
 * @param {string}    upstreamRunId
 * @param {string}    ianaId
 * @param {EvidenceObject} evidence
 * @returns {Promise<{error: Object|null}>}
 */
async function persistObservation(supabase, runId, upstreamRunId, ianaId, evidence) {
  const scalars = extractPromotedScalars(evidence);

  const row = {
    run_id:            runId,
    upstream_run_id:   upstreamRunId,
    collected_at:      evidence.icann_query_timestamp,
    signal_version:    SIGNAL_VERSION,
    collector_version: COLLECTOR_VERSION,

    // 7 promoted scalar columns
    registrar_iana_id:              scalars.registrar_iana_id ?? ianaId,
    icann_query_outcome:            scalars.icann_query_outcome,
    registrar_accreditation_status: scalars.registrar_accreditation_status,
    registrar_country_code:         scalars.registrar_country_code,
    registrar_raa_version:          scalars.registrar_raa_version,
    registrar_ssad_participant:     scalars.registrar_ssad_participant,
    icann_query_timestamp:          scalars.icann_query_timestamp,

    evidence,
  };

  const { error } = await supabase.from(TABLE_NAME).insert(row);
  return { error: error ?? null };
}

// ── Full collection run orchestrator ─────────────────────────────────────────

/**
 * Runs the full registrar collection loop over a deduplicated IANA ID list.
 *
 * @param {Object}   params
 * @param {string[]} params.ianaIds - Deduplicated, non-null IANA ID list
 * @param {Object}   params.supabase
 * @param {string}   params.runId
 * @param {string}   params.upstreamRunId
 * @param {number}   [params.ianaIdAbsentCount=0] - Count of upstream null IANA IDs
 * @param {Object}   [params.datasetOptions] - Options forwarded to downloadIanaDataset()
 * @param {function} [params.onProgress] - Called after each registrar: (ianaId, i, total, result)
 * @returns {Promise<RunMetrics>}
 */
async function runCollector({
  ianaIds,
  supabase,
  runId,
  upstreamRunId,
  ianaIdAbsentCount = 0,
  datasetOptions    = {},
  onProgress,
}) {
  const total   = ianaIds.length;
  const metrics = _initMetrics(total, ianaIdAbsentCount);

  // Step 1: Download IANA dataset once for the run
  let lookup = null;
  let datasetError = null;

  try {
    lookup = await downloadIanaDataset(datasetOptions);
    metrics.ianaDatasetRowCount = lookup.size;
  } catch (err) {
    datasetError = err;
    metrics.datasetDownloadFailed = true;
    metrics.datasetDownloadError  = err.message ?? String(err);
  }

  // Step 2: Assess each unique IANA ID
  const results = [];

  for (let i = 0; i < total; i++) {
    const ianaId  = ianaIds[i];
    const evidence = assessRegistrar(ianaId, lookup);

    let dbError = null;
    try {
      const r = await persistObservation(supabase, runId, upstreamRunId, ianaId, evidence);
      dbError = r.error;
    } catch (err) {
      dbError = err;
    }

    _accumulateMetrics(metrics, evidence, dbError);

    const result = { ianaId, evidence, dbError };
    results.push(result);

    if (onProgress) onProgress(ianaId, i, total, result);
  }

  metrics.completedAt = new Date().toISOString();
  return { metrics, results };
}

// ── Metrics helpers ───────────────────────────────────────────────────────────

function _initMetrics(total, ianaIdAbsentCount) {
  return {
    total,
    ianaIdAbsentCount,
    successCount:       0,
    dbErrorCount:       0,
    dbErrorRegistrars:  [],
    ianaDatasetRowCount: 0,
    datasetDownloadFailed: false,
    datasetDownloadError:  null,
    outcomeCounts: Object.fromEntries(Object.values(QUERY_OUTCOMES).map(v => [v, 0])),
    accreditationStatusCounts: Object.fromEntries(
      Object.values(ACCREDITATION_STATUS).map(v => [v, 0]),
    ),
    startedAt:   new Date().toISOString(),
    completedAt: null,
  };
}

function _accumulateMetrics(metrics, evidence, dbError) {
  const outcome = evidence.icann_query_outcome;
  if (outcome in metrics.outcomeCounts) {
    metrics.outcomeCounts[outcome]++;
  }

  const status = evidence.registrar_accreditation_status;
  if (status && status in metrics.accreditationStatusCounts) {
    metrics.accreditationStatusCounts[status]++;
  }

  if (dbError) {
    metrics.dbErrorCount++;
    metrics.dbErrorRegistrars.push({
      ianaId: evidence.registrar_iana_id,
      error:  dbError.message ?? String(dbError),
    });
  } else {
    metrics.successCount++;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  assessRegistrar,
  runCollector,
  downloadIanaDataset,
  persistObservation,
  extractPromotedScalars,
  SIGNAL_ID,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  TABLE_NAME,
  QUERY_OUTCOMES,
  ACCREDITATION_STATUS,
  IANA_DATASET_URL,
  // Exported for testing
  _parseIanaHtml,
  _buildEvidence,
};

/**
 * @typedef {Object} EvidenceObject — 16-field block per SOT-REGISTRAR-001 §7.1
 * @property {string}       icann_query_outcome
 * @property {string|null}  registrar_accreditation_status
 * @property {string|null}  registrar_iana_id
 * @property {string|null}  registrar_name
 * @property {string|null}  registrar_accreditation_date
 * @property {string|null}  registrar_raa_version
 * @property {string|null}  registrar_country_code
 * @property {string|null}  registrar_country_name
 * @property {boolean|null} registrar_registrant_country_alignment
 * @property {boolean|null} registrar_ssad_participant
 * @property {boolean|null} registrar_abuse_email_published
 * @property {boolean|null} registrar_abuse_telephone_published
 * @property {boolean|null} registrar_whois_policy_published
 * @property {boolean|null} registrar_registration_agreement_published
 * @property {string}       icann_query_timestamp
 * @property {string|null}  icann_query_iana_id
 */

/**
 * @typedef {Object} RunMetrics
 * @property {number}   total
 * @property {number}   ianaIdAbsentCount
 * @property {number}   successCount
 * @property {number}   dbErrorCount
 * @property {Array}    dbErrorRegistrars
 * @property {number}   ianaDatasetRowCount
 * @property {boolean}  datasetDownloadFailed
 * @property {string|null} datasetDownloadError
 * @property {Object}   outcomeCounts
 * @property {Object}   accreditationStatusCounts
 * @property {string}   startedAt
 * @property {string|null} completedAt
 */
