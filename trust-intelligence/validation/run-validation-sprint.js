'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

// Trust Intelligence Validation Sprint — 2026-07-13.
//
// One-off validation tool (not a product entrypoint, not new architecture).
// Exercises the already-frozen ENG-023/ENG-025/ENG-026/ENG-029/ENG-032 stack
// end-to-end against real Repository Authority populations (SRA, FCA,
// Higher Education) by calling generateTrustProfile() — the exact same
// opaque capability runScheduledSweep() and the on-demand trigger already
// call — and persisting through the exact same store.save().
//
// Produces implementation statistics only. Never redesigns or reinterprets
// the frozen contract; a thrown error from generateTrustProfile() is
// recorded as a failure, not worked around here.

const path = require('path');
const fs = require('fs');
const readline = require('node:readline');

const { generateTrustProfile } = require('../generate-trust-profile');
const store = require('../store');
const { getBenchmarkOverlay } = require('../benchmark-overlay');

const DATASET_PATH = path.join(__dirname, '..', '..', 'authority', 'dataset', 'organisations.ndjson');
const SAMPLE_PER_SOURCE = Number(process.env.VALIDATION_SAMPLE_PER_SOURCE || 60);

async function loadPopulation() {
  const bySource = { SRA: [], FCA: [], HE: [] };
  const rl = readline.createInterface({ input: fs.createReadStream(DATASET_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const regs = row.regulators || [];
    for (const source of Object.keys(bySource)) {
      if (regs.includes(source)) bySource[source].push(row);
    }
  }
  return bySource;
}

// Stratified sample: half from organisations with observatory evidence
// (exercises the scored path), half without (exercises the
// INSUFFICIENT_OBSERVATION / no-domain path) — so the sample is
// representative of both regimes, not just the easy case.
function sample(rows, n) {
  const observed = rows.filter((r) => r.observatory && r.observatory.observed);
  const notObserved = rows.filter((r) => !(r.observatory && r.observatory.observed));
  const half = Math.ceil(n / 2);
  return [...observed.slice(0, half), ...notObserved.slice(0, n - Math.min(half, observed.length))];
}

function summarizeScore(instance) {
  const v = instance.trustScore.value;
  return typeof v === 'number' ? v : v; // 'INSUFFICIENT_OBSERVATION' or a number
}

async function runSource(sourceName, rows) {
  const results = {
    source: sourceName,
    populationTotal: rows.length,
    sampleSize: 0,
    successes: 0,
    failures: [],
    insufficientObservation: 0,
    scored: 0,
    scoreDistribution: [],
    benchmarkAvailable: 0,
    benchmarkUnavailable: 0,
    totalDurationMs: 0,
    perOrgDurationsMs: [],
  };

  const picked = sample(rows, SAMPLE_PER_SOURCE);
  results.sampleSize = picked.length;

  for (const row of picked) {
    const organisationId = row.organisationId;
    const generatedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const instance = await generateTrustProfile(organisationId, { trigger: 'scheduled', generatedAt });
      const durationMs = Date.now() - start;
      results.totalDurationMs += durationMs;
      results.perOrgDurationsMs.push(durationMs);
      results.successes += 1;

      const value = summarizeScore(instance);
      if (value === 'INSUFFICIENT_OBSERVATION') {
        results.insufficientObservation += 1;
      } else {
        results.scored += 1;
        results.scoreDistribution.push(value);
      }

      const overlay = await getBenchmarkOverlay(instance);
      if (overlay) results.benchmarkAvailable += 1; else results.benchmarkUnavailable += 1;

      await store.save(instance);
    } catch (cause) {
      const durationMs = Date.now() - start;
      results.totalDurationMs += durationMs;
      results.perOrgDurationsMs.push(durationMs);
      results.failures.push({
        organisationId,
        organisationName: row.organisationName || row.canonicalName || null,
        errorName: cause.name,
        errorMessage: cause.message,
      });
    }
  }

  return results;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function printSummary(results) {
  const sorted = [...results.perOrgDurationsMs].sort((a, b) => a - b);
  const scoreSorted = [...results.scoreDistribution].sort((a, b) => a - b);
  const throughputPerSec = results.totalDurationMs > 0 ? (results.sampleSize / (results.totalDurationMs / 1000)) : null;

  console.log(`\n=== ${results.source} ===`);
  console.log(`population total (in Repository Authority): ${results.populationTotal}`);
  console.log(`sample size: ${results.sampleSize}`);
  console.log(`successful generations: ${results.successes}`);
  console.log(`failures: ${results.failures.length}`);
  console.log(`  INSUFFICIENT_OBSERVATION: ${results.insufficientObservation}`);
  console.log(`  scored: ${results.scored}`);
  if (scoreSorted.length) {
    console.log(`  score distribution — min ${scoreSorted[0]}, p50 ${percentile(scoreSorted, 50)}, p90 ${percentile(scoreSorted, 90)}, max ${scoreSorted[scoreSorted.length - 1]}`);
  }
  console.log(`benchmark available: ${results.benchmarkAvailable} / unavailable: ${results.benchmarkUnavailable}`);
  console.log(`execution time — total ${results.totalDurationMs}ms, mean ${sorted.length ? Math.round(results.totalDurationMs / sorted.length) : 0}ms, p50 ${percentile(sorted, 50)}ms, p90 ${percentile(sorted, 90)}ms`);
  console.log(`throughput: ${throughputPerSec ? throughputPerSec.toFixed(2) : 'n/a'} generations/sec`);
  if (results.failures.length) {
    console.log('failure detail:');
    for (const f of results.failures.slice(0, 20)) {
      console.log(`  - ${f.organisationId} (${f.organisationName}): ${f.errorName}: ${f.errorMessage}`);
    }
    if (results.failures.length > 20) console.log(`  ... and ${results.failures.length - 20} more`);
  }
}

async function main() {
  console.log(`Trust Intelligence Validation Sprint — sample size ${SAMPLE_PER_SOURCE} per source`);
  const bySource = await loadPopulation();
  const allResults = [];
  for (const source of ['SRA', 'FCA', 'HE']) {
    const results = await runSource(source, bySource[source]);
    printSummary(results);
    allResults.push(results);
  }

  const outPath = path.join(__dirname, 'validation-sprint-results.json');
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nFull results written to ${outPath}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Validation sprint runner crashed:', err);
  process.exit(1);
});
