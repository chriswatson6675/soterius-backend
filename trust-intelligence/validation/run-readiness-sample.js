'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

// Implementation Readiness Sprint — 2026-07-13.
//
// Measures real per-Organisation timing and process memory footprint across a
// uniform sample of the FULL Repository Authority population (not stratified
// by source or by observatory evidence, unlike run-validation-sprint.js —
// this run's purpose is realistic extrapolation to a full 35,752-Organisation
// sweep, so the sample must reflect the true population mix of CH-bearing,
// domain-bearing, and evidence-bearing Organisations, not an oversampled
// "interesting cases" set).
//
// One-off measurement tool, not a product entrypoint. Calls generateTrustProfile()
// + store.save() directly — the same opaque capabilities runScheduledSweep()
// itself calls per-Organisation — so results characterise the real sweep.

const path = require('path');
const fs = require('fs');
const readline = require('node:readline');

const { generateTrustProfile } = require('../generate-trust-profile');
const store = require('../store');

const DATASET_PATH = path.join(__dirname, '..', '..', 'authority', 'dataset', 'organisations.ndjson');
const SAMPLE_SIZE = Number(process.env.READINESS_SAMPLE_SIZE || 300);
const MEMORY_SNAPSHOT_EVERY = Number(process.env.READINESS_MEMORY_SNAPSHOT_EVERY || 25);

async function loadFullPopulation() {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(DATASET_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

// Deterministic uniform sample: every Nth row, so the sample's composition
// (regulator mix, domain/CH-number presence, observatory evidence) tracks the
// real population's composition rather than an arbitrary prefix.
function uniformSample(rows, n) {
  if (n >= rows.length) return rows.slice();
  const stride = rows.length / n;
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(rows[Math.floor(i * stride)]);
  return picked;
}

function mb(bytes) { return Math.round((bytes / (1024 * 1024)) * 10) / 10; }

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log(`Implementation Readiness Sprint — uniform sample size ${SAMPLE_SIZE} across the full Repository Authority population`);

  const fullPopulation = await loadFullPopulation();
  console.log(`Repository Authority total: ${fullPopulation.length} Organisations`);

  const sampled = uniformSample(fullPopulation, SAMPLE_SIZE);
  const withChNumber = sampled.filter((r) => r.identifiers && r.identifiers.companiesHouseNumber).length;
  const withVerifiedDomain = sampled.filter((r) => r.verifiedDomain).length;
  const withObservatoryEvidence = sampled.filter((r) => r.observatory && r.observatory.observed).length;
  console.log(`sample composition — with CH number: ${withChNumber}/${sampled.length}, with verified domain: ${withVerifiedDomain}/${sampled.length}, with observatory evidence: ${withObservatoryEvidence}/${sampled.length}`);

  const memorySnapshots = [];
  const perOrgDurationsMs = [];
  const failures = [];
  let successes = 0;
  let insufficientObservation = 0;
  let scored = 0;

  if (global.gc) global.gc();
  const memBefore = process.memoryUsage();
  memorySnapshots.push({ at: 0, ...memBefore });

  const overallStart = Date.now();

  for (let i = 0; i < sampled.length; i++) {
    const row = sampled[i];
    const organisationId = row.organisationId;
    const generatedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const instance = await generateTrustProfile(organisationId, { trigger: 'scheduled', generatedAt });
      await store.save(instance);
      const durationMs = Date.now() - start;
      perOrgDurationsMs.push(durationMs);
      successes += 1;
      if (instance.trustScore.value === 'INSUFFICIENT_OBSERVATION') insufficientObservation += 1;
      else scored += 1;
    } catch (cause) {
      const durationMs = Date.now() - start;
      perOrgDurationsMs.push(durationMs);
      failures.push({ organisationId, errorName: cause.name, errorMessage: cause.message });
    }

    if ((i + 1) % MEMORY_SNAPSHOT_EVERY === 0) {
      const snap = process.memoryUsage();
      memorySnapshots.push({ at: i + 1, ...snap });
      console.log(`  progress ${i + 1}/${sampled.length} — heapUsed ${mb(snap.heapUsed)}MB, rss ${mb(snap.rss)}MB`);
    }
  }

  const overallDurationMs = Date.now() - overallStart;
  const memAfter = process.memoryUsage();
  memorySnapshots.push({ at: sampled.length, ...memAfter });

  const sortedDurations = [...perOrgDurationsMs].sort((a, b) => a - b);
  const meanMs = perOrgDurationsMs.reduce((a, b) => a + b, 0) / (perOrgDurationsMs.length || 1);
  const throughputPerSec = overallDurationMs > 0 ? (sampled.length / (overallDurationMs / 1000)) : null;

  const report = {
    sampleSize: sampled.length,
    repositoryAuthorityTotal: fullPopulation.length,
    sampleComposition: { withChNumber, withVerifiedDomain, withObservatoryEvidence },
    successes,
    failures: failures.length,
    failureDetail: failures.slice(0, 20),
    insufficientObservation,
    scored,
    timing: {
      overallDurationMs,
      meanMs: Math.round(meanMs),
      p50Ms: percentile(sortedDurations, 50),
      p90Ms: percentile(sortedDurations, 90),
      p99Ms: percentile(sortedDurations, 99),
      maxMs: sortedDurations[sortedDurations.length - 1] ?? null,
      throughputPerSec: throughputPerSec ? Number(throughputPerSec.toFixed(3)) : null,
    },
    memory: {
      rssBeforeMB: mb(memBefore.rss),
      rssAfterMB: mb(memAfter.rss),
      heapUsedBeforeMB: mb(memBefore.heapUsed),
      heapUsedAfterMB: mb(memAfter.heapUsed),
      heapUsedDeltaMB: mb(memAfter.heapUsed - memBefore.heapUsed),
      snapshots: memorySnapshots.map((s) => ({ at: s.at, rssMB: mb(s.rss), heapUsedMB: mb(s.heapUsed), externalMB: mb(s.external) })),
    },
    extrapolation: {
      estimatedFullSweepDurationHours: Number(((meanMs * fullPopulation.length) / 1000 / 3600).toFixed(2)),
      estimatedFullSweepThroughputPerHour: throughputPerSec ? Math.round(throughputPerSec * 3600) : null,
    },
  };

  console.log('\n=== Readiness sample summary ===');
  console.log(JSON.stringify(report, null, 2));

  const outPath = path.join(__dirname, 'readiness-sample-results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull results written to ${outPath}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Readiness sample runner crashed:', err);
  process.exit(1);
});
