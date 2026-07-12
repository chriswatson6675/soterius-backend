'use strict';

// integrity-report.js — Repository Authority Integrity Report generator.
//
// Commissioned by the Repository Authority Integrity Review. MEASUREMENT ONLY:
// it reads the published canonical dataset (organisations.ndjson) and emits an
// integrity report. It NEVER touches the identity algorithm, the merge logic,
// or the dataset itself — it observes Repository Authority, exactly as the
// review that commissioned it did, and makes that observation a standard
// artefact produced after every build.
//
// Runs two ways:
//   - automatically as the final step of authority/build.js (after every rebuild)
//   - standalone: `node backend/authority/integrity-report.js` (re-audit an
//     existing dataset without rebuilding)
//
// Outputs (authority/reports/):
//   integrity-report.json  — machine-readable metrics snapshot (also the
//                            "previous build" baseline for the next run's
//                            historical comparison)
//   integrity-report.md    — human-readable report
//
// The identity ALGORITHM VERSION is not a hand-maintained string (which can go
// stale). It is a behavioural fingerprint: canonicalOrgId run over a fixed probe
// vector covering every precedence tier, hashed. It changes if and only if the
// precedence or hashing changes — a self-verifying version that cannot silently
// drift from the code it describes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('node:readline');

const Identity = require('../organisation/identity');

const DEFAULT_DATASET = path.join(__dirname, 'dataset', 'organisations.ndjson');
const DEFAULT_REPORTS_DIR = path.join(__dirname, 'reports');

// ── Identity algorithm fingerprint ──────────────────────────────────────────
// A fixed probe covering every tier of the precedence. If the algorithm changes
// in any way that affects output, this hash changes — and the report's
// historical comparison will flag it as an identity-algorithm change, which for
// an immutable-identity authority is the single most important thing to notice.
const IDENTITY_PROBE = [
  { companiesHouseNumber: 'OC399969' },
  { frn: '302912' },
  { sraNumber: '624547' },
  { ukprn: '10007843' },
  { ifUuid: '073e446d-fd36-4464-b3ef-8e0e989d6f69' },
  { normalisedName: 'PROBE FIRM', domain: 'probe.example' },
  { normalisedName: 'PROBE FIRM', domain: null },
  {},
];

function identityAlgorithmFingerprint() {
  const outputs = IDENTITY_PROBE.map((p) => Identity.canonicalOrgId(p));
  return crypto.createHash('sha256').update(outputs.join('|')).digest('hex').slice(0, 16);
}

// ── Load ────────────────────────────────────────────────────────────────────

function loadRows(datasetPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(datasetPath)) {
      reject(new Error(`dataset not found at ${datasetPath}`));
      return;
    }
    const rows = [];
    const rl = readline.createInterface({ input: fs.createReadStream(datasetPath) });
    rl.on('line', (line) => { if (line.trim()) rows.push(JSON.parse(line)); });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
  });
}

function datasetSha(datasetPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(datasetPath)).digest('hex');
}

// ── Metrics (pure) ───────────────────────────────────────────────────────────

const STRONG_SCHEMES = [
  ['companiesHouseNumber', 'companies-house'],
  ['frn', 'fca'],
  ['sraIdentifier', 'sra'],
  ['ukprn', 'ukprn'],
];

function apparentTier(ids, domain) {
  // Which precedence tier WOULD determine the id from published fields alone.
  // (The true tier may be `ifUuid`, which the export omits — that divergence is
  // exactly what reconstructability measures.)
  if (ids.companiesHouseNumber) return 'cn';
  if (ids.frn) return 'frn';
  if (ids.sraIdentifier) return 'sra';
  if (ids.ukprn) return 'ukprn';
  if (domain) return 'nd-domain';
  return 'nd-nodomain';
}

function rowDomain(o) {
  return o.verifiedDomain
    || (o.candidateDomains && o.candidateDomains[0] && o.candidateDomains[0].domain)
    || null;
}

function computeMetrics(rows) {
  const total = rows.length;
  const byId = new Map(rows.map((o) => [o.organisationId, o]));

  // 1. Summary — strong identifiers by provider.
  const idCounts = { companiesHouseNumber: 0, frn: 0, sraIdentifier: 0, ukprn: 0, lei: 0 };
  let verifiedDomains = 0;

  // 2. Identity integrity — collisions per scheme (must be zero).
  const byStrongId = new Map(); // "scheme:value" -> Set<orgId>
  const basisDistribution = { cn: 0, frn: 0, sra: 0, ukprn: 0, 'nd-domain': 0, 'nd-nodomain': 0 };

  // 3. Reconstructability.
  let reconstructable = 0;
  const nonReconstructable = [];

  // 4. Transparency — identity review groups (name+domain collisions).
  const byNameDomain = new Map(); // "name|domain" -> [orgId]

  for (const o of rows) {
    const ids = o.identifiers || {};
    for (const k of Object.keys(idCounts)) if (ids[k]) idCounts[k]++;
    if (o.verifiedDomain) verifiedDomains++;

    const domain = rowDomain(o);
    basisDistribution[apparentTier(ids, domain)]++;

    for (const [field, provider] of STRONG_SCHEMES) {
      if (ids[field]) {
        const key = `${provider}:${ids[field]}`;
        if (!byStrongId.has(key)) byStrongId.set(key, new Set());
        byStrongId.get(key).add(o.organisationId);
      }
    }

    // Reconstruct from published fields only (ifUuid unavailable by design).
    const reconstructed = Identity.canonicalOrgId({
      companiesHouseNumber: ids.companiesHouseNumber || null,
      frn: ids.frn || null,
      sraNumber: ids.sraIdentifier || null,
      ukprn: ids.ukprn || null,
      ifUuid: null,
      normalisedName: o.normalisedName || o.organisationName || null,
      domain,
    });
    const publishedBase = o.organisationId.replace(/-[0-9]+$/, '');
    if (reconstructed === o.organisationId || reconstructed === publishedBase) {
      reconstructable++;
    } else {
      const hasStrong = ids.companiesHouseNumber || ids.frn || ids.sraIdentifier || ids.ukprn;
      nonReconstructable.push({
        organisationId: o.organisationId,
        name: o.organisationName,
        reason: hasStrong ? 'strong-identifier-mismatch'
          : domain ? 'unexported-identity-input (ifUuid or pre-resolution domain)'
          : 'no-identifier-and-no-domain',
      });
    }

    if (domain) {
      const key = `${o.normalisedName || o.organisationName || ''}|${domain}`;
      if (!byNameDomain.has(key)) byNameDomain.set(key, []);
      byNameDomain.get(key).push(o.organisationId);
    }
  }

  // Strong-identifier collisions (one registry id held by >1 canonical org).
  const collisions = [...byStrongId.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([key, set]) => ({ identifier: key, organisationIds: [...set] }));

  // Identity review groups.
  const reviewGroups = [];
  for (const [key, orgIds] of byNameDomain.entries()) {
    if (orgIds.length < 2) continue;
    const strongHeld = orgIds.filter((id) => {
      const x = byId.get(id).identifiers || {};
      return x.companiesHouseNumber || x.frn || x.sraIdentifier || x.ukprn;
    }).length;
    reviewGroups.push({
      key,
      organisationIds: orgIds,
      pattern: strongHeld > 1 ? 'distinct-strong-identifiers'
        : strongHeld === 1 ? 'one-strong-rest-domain-only'
        : 'all-domain-only',
    });
  }
  const recordsUnderReview = reviewGroups.reduce((a, g) => a + g.organisationIds.length, 0);

  return {
    schemaVersion: 1,
    summary: {
      totalOrganisations: total,
      verifiedDomains,
      strongIdentifiersByProvider: {
        companiesHouse: idCounts.companiesHouseNumber,
        fca: idCounts.frn,
        sra: idCounts.sraIdentifier,
        ukprn: idCounts.ukprn,
        lei: idCounts.lei,
      },
    },
    identityIntegrity: {
      strongIdentifierCollisions: collisions.length,
      collisionDetail: collisions.slice(0, 20),
      identityAlgorithmFingerprint: identityAlgorithmFingerprint(),
      identityBasisDistribution: basisDistribution,
    },
    reconstructability: {
      total,
      reconstructable,
      nonReconstructable: nonReconstructable.length,
      reconstructablePercent: Number((100 * reconstructable / total).toFixed(4)),
      reasons: nonReconstructable.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
      records: nonReconstructable,
    },
    transparency: {
      identityReviewGroups: reviewGroups.length,
      recordsRequiringGovernedReview: recordsUnderReview,
      reviewGroupPatterns: reviewGroups.reduce((acc, g) => { acc[g.pattern] = (acc[g.pattern] || 0) + 1; return acc; }, {}),
      exportCompleteness: {
        // Fields the identity algorithm consumes that the export does NOT carry.
        unexportedIdentityInputs: ['ifUuid'],
        recordsAffectedByUnexportedInputs: nonReconstructable.filter((r) => r.reason.startsWith('unexported')).length,
      },
    },
  };
}

// ── Health assessment (objective thresholds only) ─────────────────────────────

function assessHealth(m) {
  const checks = [];

  checks.push({
    dimension: 'strong-identifier-uniqueness',
    metric: m.identityIntegrity.strongIdentifierCollisions,
    status: m.identityIntegrity.strongIdentifierCollisions === 0 ? 'PASS' : 'CRITICAL',
    basis: '0 collisions required; any collision is a constitutional identity failure',
  });

  const pct = m.reconstructability.reconstructablePercent;
  checks.push({
    dimension: 'external-reconstructability',
    metric: pct,
    status: pct === 100 ? 'PASS' : pct >= 99.5 ? 'GOOD' : pct >= 95 ? 'WATCH' : 'CONCERN',
    basis: '100% ideal; >=99.5% good; >=95% watch; <95% concern',
  });

  checks.push({
    dimension: 'transparency-review-backlog',
    metric: m.transparency.identityReviewGroups,
    status: 'INFO',
    basis: 'count reported for trend; health is directional (see historical comparison), not a fixed threshold',
  });

  // Overall: worst non-INFO status wins.
  const order = { CRITICAL: 0, CONCERN: 1, WATCH: 2, GOOD: 3, PASS: 4, INFO: 5 };
  const worst = checks.filter((c) => c.status !== 'INFO').sort((a, b) => order[a.status] - order[b.status])[0];
  return { overall: worst ? worst.status : 'INFO', checks };
}

// ── Historical comparison ─────────────────────────────────────────────────────

function compareToPrevious(current, currentSha, previous) {
  if (!previous) return { available: false, note: 'no previous integrity report — this is the first recorded build' };
  if (previous.datasetSha256 === currentSha) {
    return { available: false, note: 'dataset unchanged since previous report (same build re-audited) — no comparison' };
  }
  const p = previous.metrics;
  const delta = (a, b) => b - a;
  return {
    available: true,
    previousBuildAt: previous.generatedAt,
    changes: {
      totalOrganisations: delta(p.summary.totalOrganisations, current.summary.totalOrganisations),
      verifiedDomains: delta(p.summary.verifiedDomains, current.summary.verifiedDomains),
      strongIdentifierCollisions: delta(p.identityIntegrity.strongIdentifierCollisions, current.identityIntegrity.strongIdentifierCollisions),
      reconstructablePercent: Number((current.reconstructability.reconstructablePercent - p.reconstructability.reconstructablePercent).toFixed(4)),
      nonReconstructable: delta(p.reconstructability.nonReconstructable, current.reconstructability.nonReconstructable),
      identityReviewGroups: delta(p.transparency.identityReviewGroups, current.transparency.identityReviewGroups),
      identityAlgorithmChanged: p.identityIntegrity.identityAlgorithmFingerprint !== current.identityIntegrity.identityAlgorithmFingerprint,
    },
  };
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderMarkdown(snapshot) {
  const { metrics: m, health, comparison, generatedAt, datasetSha256 } = snapshot;
  const lines = [];
  const L = (s = '') => lines.push(s);

  L('# Repository Authority Integrity Report');
  L('');
  L(`**Generated:** ${generatedAt}`);
  L(`**Dataset SHA-256:** \`${datasetSha256}\``);
  L(`**Identity algorithm fingerprint:** \`${m.identityIntegrity.identityAlgorithmFingerprint}\``);
  L(`**Overall health:** **${health.overall}**`);
  L('');
  L('_Measurement-only artefact, produced after every Repository Authority build. It observes the published canonical dataset; it does not modify Repository Authority or the identity algorithm._');
  L('');

  L('## 1. Repository summary');
  L('');
  L('| Metric | Value |');
  L('|---|---:|');
  L(`| Total organisations | ${m.summary.totalOrganisations} |`);
  L(`| Verified domains | ${m.summary.verifiedDomains} |`);
  L(`| Strong id — Companies House | ${m.summary.strongIdentifiersByProvider.companiesHouse} |`);
  L(`| Strong id — FCA (FRN) | ${m.summary.strongIdentifiersByProvider.fca} |`);
  L(`| Strong id — SRA | ${m.summary.strongIdentifiersByProvider.sra} |`);
  L(`| Strong id — UKPRN | ${m.summary.strongIdentifiersByProvider.ukprn} |`);
  L(`| LEI (cross-jurisdiction anchor) | ${m.summary.strongIdentifiersByProvider.lei} |`);
  L('');

  L('## 2. Identity integrity');
  L('');
  L(`- **Strong-identifier collisions:** ${m.identityIntegrity.strongIdentifierCollisions} _(0 required — one registry identifier must map to exactly one canonical organisation)_`);
  L(`- **Identity algorithm fingerprint:** \`${m.identityIntegrity.identityAlgorithmFingerprint}\` _(changes iff the precedence or hashing changes)_`);
  L('- **Identity basis distribution (apparent, from published fields):**');
  for (const [tier, n] of Object.entries(m.identityIntegrity.identityBasisDistribution)) L(`  - ${tier}: ${n}`);
  if (m.identityIntegrity.collisionDetail.length) {
    L('- **Collision detail:**');
    for (const c of m.identityIntegrity.collisionDetail) L(`  - \`${c.identifier}\` → ${c.organisationIds.join(', ')}`);
  }
  L('');

  L('## 3. Reconstructability');
  L('');
  L(`- **Externally reconstructable:** ${m.reconstructability.reconstructable} / ${m.reconstructability.total} (**${m.reconstructability.reconstructablePercent}%**)`);
  L(`- **Non-reconstructable:** ${m.reconstructability.nonReconstructable}`);
  L('- **Reasons:**');
  for (const [reason, n] of Object.entries(m.reconstructability.reasons)) L(`  - ${reason}: ${n}`);
  if (m.reconstructability.records.length) {
    L('- **Non-reconstructable records:**');
    for (const r of m.reconstructability.records.slice(0, 50)) L(`  - \`${r.organisationId}\` ${r.name} — ${r.reason}`);
    if (m.reconstructability.records.length > 50) L(`  - …and ${m.reconstructability.records.length - 50} more (full list in integrity-report.json)`);
  }
  L('');

  L('## 4. Transparency');
  L('');
  L(`- **Identity review groups (same name+domain, distinct ids):** ${m.transparency.identityReviewGroups}`);
  L(`- **Records requiring governed review:** ${m.transparency.recordsRequiringGovernedReview}`);
  L('- **Review-group patterns:**');
  for (const [pattern, n] of Object.entries(m.transparency.reviewGroupPatterns)) L(`  - ${pattern}: ${n}`);
  L(`- **Export completeness:** identity inputs the algorithm uses but the export omits: ${m.transparency.exportCompleteness.unexportedIdentityInputs.map((s) => `\`${s}\``).join(', ')} _(affects ${m.transparency.exportCompleteness.recordsAffectedByUnexportedInputs} records)_`);
  L('');

  L('## 5. Historical comparison');
  L('');
  if (!comparison.available) {
    L(`_${comparison.note}_`);
  } else {
    L(`Compared against the previous build (${comparison.previousBuildAt}):`);
    L('');
    L('| Metric | Change |');
    L('|---|---:|');
    const c = comparison.changes;
    const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
    L(`| Total organisations | ${sign(c.totalOrganisations)} |`);
    L(`| Verified domains | ${sign(c.verifiedDomains)} |`);
    L(`| Strong-identifier collisions | ${sign(c.strongIdentifierCollisions)} |`);
    L(`| Reconstructable % | ${sign(c.reconstructablePercent)} |`);
    L(`| Non-reconstructable records | ${sign(c.nonReconstructable)} |`);
    L(`| Identity review groups | ${sign(c.identityReviewGroups)} |`);
    L(`| **Identity algorithm changed** | ${c.identityAlgorithmChanged ? '**YES — investigate**' : 'no'} |`);
  }
  L('');

  L('## 6. Overall Repository Authority health');
  L('');
  L(`**${health.overall}**`);
  L('');
  L('| Dimension | Metric | Status | Basis |');
  L('|---|---:|---|---|');
  for (const c of health.checks) L(`| ${c.dimension} | ${c.metric} | ${c.status} | ${c.basis} |`);
  L('');
  L('_Health is derived from objective metrics and fixed thresholds only. No subjective judgement is applied._');
  L('');

  return lines.join('\n') + '\n';
}

// ── Orchestrate ───────────────────────────────────────────────────────────────

async function generate({ datasetPath = DEFAULT_DATASET, reportsDir = DEFAULT_REPORTS_DIR, now } = {}) {
  const rows = await loadRows(datasetPath);
  const sha = datasetSha(datasetPath);
  const metrics = computeMetrics(rows);
  const health = assessHealth(metrics);

  const jsonPath = path.join(reportsDir, 'integrity-report.json');
  let previous = null;
  if (fs.existsSync(jsonPath)) {
    try { previous = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { previous = null; }
  }
  const comparison = compareToPrevious(metrics, sha, previous);

  // `now` is injectable so the batch build can pass a deterministic timestamp if
  // it ever needs byte-stable reports; standalone runs stamp wall-clock time.
  const generatedAt = now || new Date().toISOString();
  const snapshot = { generatedAt, datasetSha256: sha, metrics, health, comparison };

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2) + '\n');
  fs.writeFileSync(path.join(reportsDir, 'integrity-report.md'), renderMarkdown(snapshot));

  return snapshot;
}

module.exports = { generate, computeMetrics, assessHealth, identityAlgorithmFingerprint, renderMarkdown, compareToPrevious };

// CLI: standalone re-audit of an existing dataset.
if (require.main === module) {
  generate()
    .then((s) => {
      console.error(`Repository Authority Integrity Report — health: ${s.health.overall}`);
      console.error(`  reconstructable: ${s.metrics.reconstructability.reconstructablePercent}% | collisions: ${s.metrics.identityIntegrity.strongIdentifierCollisions} | review groups: ${s.metrics.transparency.identityReviewGroups}`);
      console.error(`  written to authority/reports/integrity-report.{json,md}`);
    })
    .catch((e) => { console.error('integrity report FAILED:', e.message); process.exit(1); });
}
