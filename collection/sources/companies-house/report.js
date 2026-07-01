'use strict';

// report.js — first Companies House collection report (CCS coverage → human report).
//
// Reads a preserved run directory (preserve.js layout) and produces the authoritative
// first-run report: attempted, collected, failures by category, evidence objects by
// type, document metadata/binaries, coverage %, and unexpected observations. Pure
// read of preserved evidence — it derives, it never mutates the corpus.

const fs = require('node:fs');
const path = require('node:path');

function _readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Build the report model + markdown from a preserved run directory.
 * @param {string} runDir
 * @returns {{model: Object, markdown: string}}
 */
function buildReport(runDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  const resolutions = _readNdjson(path.join(runDir, 'resolution.ndjson'));
  const coverage = _readNdjson(path.join(runDir, 'coverage.ndjson'));
  const absences = _readNdjson(path.join(runDir, 'observed-absences.ndjson'));
  const nonObs = _readNdjson(path.join(runDir, 'non-observations.ndjson'));
  const docIndex = _readNdjson(path.join(runDir, 'documents', 'index.ndjson'));

  const evidenceByType = {};
  let evidenceTotal = 0;
  for (const t of ['EO-01', 'EO-02', 'EO-03', 'EO-04', 'EO-05', 'EO-06', 'EO-07', 'EO-08', 'EO-09', 'EO-10']) {
    const n = t === 'EO-06' ? docIndex.length : _readNdjson(path.join(runDir, 'evidence', `${t}.ndjson`)).length;
    evidenceByType[t] = n;
    evidenceTotal += n;
  }

  // Resolution outcomes.
  const resByStatus = _countBy(resolutions, (r) => r.status);
  const resolved = resolutions.filter((r) => r.status === 'RESOLVED');

  // Companies attempted = firms we resolved an anchor for and ran observe() against.
  // A coverage record exists per observed firm; anchorObserved tells us if EO-01 landed.
  const attempted = coverage.length;
  const collected = coverage.filter((c) => c.anchorObserved === true).length;
  const anchorFailed = coverage.filter((c) => c.anchorObserved === false).length;

  // Failures by category: resolution failures + observation non-observations by reason.
  const resolutionFailures = {
    NOT_FOUND: resByStatus.NOT_FOUND ?? 0,
    AMBIGUOUS: resByStatus.AMBIGUOUS ?? 0,
    SEARCH_UNAVAILABLE: resByStatus.SEARCH_UNAVAILABLE ?? 0,
  };
  const nonObsByReason = _countBy(nonObs, (n) => n.reason);
  const nonObsByType = _countBy(nonObs, (n) => n.objectType);

  // Document binaries vs metadata.
  const docsWithBinary = docIndex.filter((d) => d.byteLength != null && d.byteLength > 0).length;
  const docBytes = docIndex.reduce((a, d) => a + (d.byteLength ?? 0), 0);

  // Coverage % over the cohort the run targeted.
  const cohortN = manifest.cohort?.n ?? manifest.targetCount ?? attempted;
  const pct = (n, d) => (d === 0 ? 0 : +((n / d) * 100).toFixed(1));

  // Unexpected observations — surfaced, not interpreted.
  const anomalies = [];
  const dissolvedResolved = resolved.filter((r) => r.matchedStatus && !['active', 'open'].includes(String(r.matchedStatus).toLowerCase()));
  if (dissolvedResolved.length) anomalies.push(`${dissolvedResolved.length} resolved anchor(s) are not 'active' (e.g. dissolved/liquidation) — recorded as observed.`);
  const mediumConf = resolved.filter((r) => r.confidence === 'medium').length;
  if (mediumConf) anomalies.push(`${mediumConf} anchor(s) resolved at 'medium' confidence (exact name, legal-form not corroborated).`);
  if (resolutionFailures.AMBIGUOUS) anomalies.push(`${resolutionFailures.AMBIGUOUS} firm(s) had multiple exact-name matches and were refused (not guessed).`);
  const truncated = nonObsByReason.LIST_TRUNCATED ?? 0;
  if (truncated) anomalies.push(`${truncated} list(s) could not be fully paginated (LIST_TRUNCATED) — remainder honestly recorded as non-observed.`);
  const rateLimited = nonObsByReason.RATE_LIMITED ?? 0;
  if (rateLimited) anomalies.push(`${rateLimited} object(s) hit the rate limiter (RATE_LIMITED) — resumable.`);
  const bigFilers = coverage
    .map((c) => ({ firm: c.firm, eo05: c.perObject?.['EO-05']?.count ?? 0 }))
    .filter((x) => x.eo05 >= 200)
    .sort((a, b) => b.eo05 - a.eo05).slice(0, 5);
  if (bigFilers.length) anomalies.push(`High filing-history volume: ${bigFilers.map((x) => `${x.firm?.firm_name ?? '?'} (${x.eo05})`).join(', ')}.`);

  const model = {
    manifest,
    cohort: { id: manifest.cohort?.id ?? null, size: cohortN, targeted: manifest.targetCount ?? attempted },
    resolution: { total: resolutions.length, byStatus: resByStatus, resolved: resolved.length, failures: resolutionFailures },
    companies: { attempted, collected, anchorFailed },
    evidence: { total: evidenceTotal, byType: evidenceByType },
    documents: { records: docIndex.length, withBinary: docsWithBinary, totalBytes: docBytes },
    observedAbsences: absences.length,
    nonObservations: { total: nonObs.length, byReason: nonObsByReason, byType: nonObsByType },
    coveragePct: {
      resolvedOfTargeted: pct(resolved.length, manifest.targetCount ?? attempted),
      collectedOfAttempted: pct(collected, attempted),
      collectedOfCohort: pct(collected, cohortN),
    },
    anomalies,
  };

  return { model, markdown: _markdown(model) };
}

function _countBy(arr, keyFn) {
  const out = {};
  for (const x of arr) { const k = keyFn(x) ?? 'UNKNOWN'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

function _markdown(m) {
  const L = [];
  const p = (s) => L.push(s);
  p(`# Companies House — First Collection Report`);
  p('');
  p(`**Source:** companies-house (CCS-COMPHOUSE-001 collector v${m.manifest.collectorVersion})`);
  p(`**Cohort:** ${m.cohort.id ?? 'n/a'} — targeted ${m.cohort.targeted} of ${m.cohort.size} firms`);
  p(`**Run ID:** ${m.manifest.runId}`);
  p(`**Observation window:** ${m.manifest.startedAt} → ${m.manifest.completedAt ?? '(in progress)'}`);
  p(`**Scope:** ${(m.manifest.scope?.objects ?? []).join(', ')}${m.manifest.scope?.includeDocuments ? ' (+ EO-06 documents)' : ''}`);
  p('');
  p(`## 1. Companies attempted & collected`);
  p('');
  p(`| Metric | Count |`);
  p(`|---|---:|`);
  p(`| Firms targeted | ${m.cohort.targeted} |`);
  p(`| Anchors resolved | ${m.resolution.resolved} |`);
  p(`| Companies attempted (observe run) | ${m.companies.attempted} |`);
  p(`| Companies collected (anchor observed) | ${m.companies.collected} |`);
  p(`| Companies attempted but anchor non-observed | ${m.companies.anchorFailed} |`);
  p('');
  p(`## 2. Failures by category`);
  p('');
  p(`**Resolution (firm → company_number):**`);
  p('');
  p(`| Category | Count |`);
  p(`|---|---:|`);
  p(`| NOT_FOUND (no exact-name match) | ${m.resolution.failures.NOT_FOUND} |`);
  p(`| AMBIGUOUS (multiple exact matches, refused) | ${m.resolution.failures.AMBIGUOUS} |`);
  p(`| SEARCH_UNAVAILABLE (surface error) | ${m.resolution.failures.SEARCH_UNAVAILABLE} |`);
  p('');
  p(`**Observation non-observations (could not consult the register):**`);
  p('');
  if (Object.keys(m.nonObservations.byReason).length === 0) {
    p(`_None recorded._`);
  } else {
    p(`| Reason | Count |`);
    p(`|---|---:|`);
    for (const [k, v] of Object.entries(m.nonObservations.byReason).sort((a, b) => b[1] - a[1])) p(`| ${k} | ${v} |`);
  }
  p('');
  p(`## 3. Evidence objects collected by type`);
  p('');
  p(`| Object | Name | Emitted |`);
  p(`|---|---|---:|`);
  const names = { 'EO-01': 'Company', 'EO-02': 'Officer Appointment', 'EO-03': 'PSC', 'EO-04': 'PSC Statement', 'EO-05': 'Filing Event', 'EO-06': 'Filed Document', 'EO-07': 'Charge', 'EO-08': 'Insolvency Case', 'EO-09': 'UK Establishment', 'EO-10': 'Disqualification' };
  for (const [t, n] of Object.entries(m.evidence.byType)) p(`| ${t} | ${names[t]} | ${n} |`);
  p(`| **Total** | | **${m.evidence.total}** |`);
  p('');
  p(`## 4. Documents`);
  p('');
  p(`| Metric | Count |`);
  p(`|---|---:|`);
  p(`| EO-06 document records (metadata) | ${m.documents.records} |`);
  p(`| Document binaries retrieved | ${m.documents.withBinary} |`);
  p(`| Total document bytes preserved | ${m.documents.totalBytes.toLocaleString()} |`);
  p('');
  p(`## 5. Coverage`);
  p('');
  p(`| Coverage | % |`);
  p(`|---|---:|`);
  p(`| Anchors resolved / firms targeted | ${m.coveragePct.resolvedOfTargeted}% |`);
  p(`| Companies collected / attempted | ${m.coveragePct.collectedOfAttempted}% |`);
  p(`| Companies collected / full cohort | ${m.coveragePct.collectedOfCohort}% |`);
  p(`| Observed absences recorded | ${m.observedAbsences} |`);
  p('');
  p(`## 6. Unexpected observations`);
  p('');
  if (m.anomalies.length === 0) p(`_None surfaced._`);
  else for (const a of m.anomalies) p(`- ${a}`);
  p('');
  p(`---`);
  p(`_Generated from preserved evidence at \`${m.manifest.runDir ?? ''}\`. Derivation only — the evidence asset is unchanged._`);
  return L.join('\n');
}

module.exports = { buildReport };
