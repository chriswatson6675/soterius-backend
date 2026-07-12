'use strict';

/*
 * Benchmark & dynamic-cohort views over the Repository Authority.
 *
 * Cohorts are GENERATED VIEWS over the trust-profiles (which each carry their
 * organisation's authority attributes) — no separate cohort registry is created.
 * A cohort is just a predicate over organisation attributes.
 */

// ── Statistics helpers ────────────────────────────────────────────────────────

function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] !== undefined) return Math.round(sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]));
  return sortedAsc[base];
}

function scoreStats(profiles) {
  const scored = profiles.filter((p) => p.scoreLabel === 'SCORED').map((p) => p.trustScore).sort((a, b) => a - b);
  if (scored.length === 0) return { n: 0 };
  const sum = scored.reduce((a, b) => a + b, 0);
  return {
    n: scored.length,
    min: scored[0],
    max: scored[scored.length - 1],
    mean: Math.round(sum / scored.length),
    median: quantile(scored, 0.5),
    q1: quantile(scored, 0.25),
    q3: quantile(scored, 0.75),
    deciles: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((d) => quantile(scored, d)),
  };
}

function bandHistogram(profiles) {
  const order = ['Excellent', 'Good', 'Moderate', 'High', 'Critical', 'Insufficient'];
  const h = Object.fromEntries(order.map((b) => [b, 0]));
  for (const p of profiles) h[p.band] = (h[p.band] || 0) + 1;
  return { order, counts: h };
}

// ── Per-signal national benchmark (adoption over observed population) ──────────

function pctOf(n, d) { return d ? Number(((n / d) * 100).toFixed(1)) : 0; }

function signalBenchmarks(profiles) {
  const obs = (pred) => profiles.filter(pred).length;
  const n = profiles.length;

  // Observed-per-signal denominators (a signal is "observed" when its scorer resolved it).
  const observedFor = (id) => profiles.filter((p) => p.signals.find((s) => s.id === id && s.observed)).length;

  const spfObs = profiles.filter((p) => p.posture.spf_present !== undefined && p.signals.find((s) => s.id === 'SPF' && s.observed));
  const dmarcObs = profiles.filter((p) => p.signals.find((s) => s.id === 'DMARC' && s.observed));
  const webObs = profiles.filter((p) => p.posture.web_reachable);

  const spfMech = (m) => spfObs.filter((p) => p.posture.spf_mechanism === m).length;
  const dmarcPol = (pol) => dmarcObs.filter((p) => p.posture.dmarc_policy === pol).length;

  return {
    population: n,
    A_email: {
      SPF: {
        observed: spfObs.length,
        present: pctOf(spfObs.filter((p) => p.posture.spf_present).length, spfObs.length),
        hardfail_all: pctOf(spfMech('-all'), spfObs.length),
        softfail_all: pctOf(spfMech('~all'), spfObs.length),
        neutral_all: pctOf(spfMech('?all'), spfObs.length),
        pass_all: pctOf(spfMech('+all'), spfObs.length),
      },
      DMARC: {
        observed: dmarcObs.length,
        present: pctOf(dmarcObs.filter((p) => p.posture.dmarc_present).length, dmarcObs.length),
        reject: pctOf(dmarcPol('reject'), dmarcObs.length),
        quarantine: pctOf(dmarcPol('quarantine'), dmarcObs.length),
        none: pctOf(dmarcPol('none'), dmarcObs.length),
        enforcing: pctOf(dmarcPol('reject') + dmarcPol('quarantine'), dmarcObs.length),
      },
      DKIM: {
        observable: observedFor('DKIM'),
        detected_rate_over_scored: pctOf(profiles.filter((p) => p.posture.dkim_detected).length, n),
        note: 'DKIM absence is unprovable (unbounded selectors) → NON_OBSERVED, not a zero',
      },
    },
    B_domain: {
      DNSSEC: {
        observed: observedFor('DNSSEC'),
        anchored: pctOf(profiles.filter((p) => p.posture.dnssec === 'anchored').length, observedFor('DNSSEC')),
        island: pctOf(profiles.filter((p) => p.posture.dnssec === 'island').length, observedFor('DNSSEC')),
        unsigned: pctOf(profiles.filter((p) => p.posture.dnssec === 'unsigned').length, observedFor('DNSSEC')),
      },
      CAA: {
        observed: observedFor('CAA'),
        present: pctOf(profiles.filter((p) => p.posture.caa_present).length, observedFor('CAA')),
      },
    },
    C_transparency: {
      SECURITY_HEADERS: {
        web_reachable: webObs.length,
        web_reachable_rate: pctOf(webObs.length, n),
        mean_headers_present: webObs.length ? Number((webObs.reduce((a, p) => a + (p.posture.header_count || 0), 0) / webObs.length).toFixed(1)) : 0,
      },
      MTA_STS: {
        observed: observedFor('MTA_STS'),
        record_present: pctOf(profiles.filter((p) => p.posture.mtasts_present).length, observedFor('MTA_STS')),
        enforce: pctOf(profiles.filter((p) => p.posture.mtasts_mode === 'enforce').length, observedFor('MTA_STS')),
        testing: pctOf(profiles.filter((p) => p.posture.mtasts_mode === 'testing').length, observedFor('MTA_STS')),
      },
      SECURITY_TXT: {
        observed: observedFor('SECURITY_TXT'),
        present: pctOf(profiles.filter((p) => ['PRESENT_CANONICAL', 'PRESENT_BOTH', 'PRESENT_LEGACY_ONLY'].includes(p.posture.securitytxt_state)).length, observedFor('SECURITY_TXT')),
      },
      TLS_RPT: { note: 'DORMANT — collected but 0 scoring weight (SLG-036/037)' },
    },
  };
}

// ── Dynamic cohorts (generated views; no registry) ────────────────────────────

const COHORT_DEFS = [
  { id: 'FCA', label: 'FCA-regulated', pred: (p) => p.regulators.includes('FCA') },
  { id: 'PRA', label: 'PRA-regulated', pred: (p) => p.regulators.includes('PRA') },
  { id: 'SRA', label: 'SRA-regulated', pred: (p) => p.regulators.includes('SRA') },
  { id: 'HE', label: 'Higher Education', pred: (p) => p.regulators.includes('HE') },
  { id: 'FCA+PRA', label: 'FCA & PRA (dual)', pred: (p) => p.regulators.includes('FCA') && p.regulators.includes('PRA') },
  { id: 'FCA+SRA', label: 'FCA & SRA (dual)', pred: (p) => p.regulators.includes('FCA') && p.regulators.includes('SRA') },
  { id: 'multi-regulated', label: 'Multi-regulated', pred: (p) => (p.regulators || []).length > 1 },
];

function cohortView(profiles, def) {
  const members = profiles.filter(def.pred);
  return {
    id: def.id,
    label: def.label,
    organisations: members.length,
    scored: members.filter((p) => p.scoreLabel === 'SCORED').length,
    insufficient: members.filter((p) => p.scoreLabel === 'INSUFFICIENT_OBSERVATION').length,
    coreComplete: members.filter((p) => p.coreComplete).length,
    score: scoreStats(members),
    bands: bandHistogram(members),
    adoption: {
      spf_present: pctOf(members.filter((p) => p.posture.spf_present).length, members.length),
      dmarc_enforcing: pctOf(members.filter((p) => ['reject', 'quarantine'].includes(p.posture.dmarc_policy)).length, members.length),
      dkim_detected: pctOf(members.filter((p) => p.posture.dkim_detected).length, members.length),
      dnssec_anchored: pctOf(members.filter((p) => p.posture.dnssec === 'anchored').length, members.length),
      caa_present: pctOf(members.filter((p) => p.posture.caa_present).length, members.length),
      mtasts_enforce: pctOf(members.filter((p) => p.posture.mtasts_mode === 'enforce').length, members.length),
      web_reachable: pctOf(members.filter((p) => p.posture.web_reachable).length, members.length),
      securitytxt_present: pctOf(members.filter((p) => ['PRESENT_CANONICAL', 'PRESENT_BOTH', 'PRESENT_LEGACY_ONLY'].includes(p.posture.securitytxt_state)).length, members.length),
    },
  };
}

// Trust-band cohorts (a cohort defined by Trust Score band).
function bandCohorts(profiles) {
  const bands = ['Excellent', 'Good', 'Moderate', 'High', 'Critical', 'Insufficient'];
  return bands.map((b) => ({ band: b, organisations: profiles.filter((p) => p.band === b).length }));
}

// SIC-section cohorts (only if SIC data present on profiles).
function sicCohorts(profiles) {
  const bySic = new Map();
  for (const p of profiles) {
    for (const sic of (p.sicCodes || [])) {
      const section = String(sic).slice(0, 2); // 2-digit SIC group
      if (!bySic.has(section)) bySic.set(section, []);
      bySic.get(section).push(p);
    }
  }
  return [...bySic.entries()]
    .map(([section, members]) => ({ section, organisations: members.length, score: scoreStats(members) }))
    .filter((c) => c.organisations >= 25) // suppress tiny groups
    .sort((a, b) => b.organisations - a.organisations)
    .slice(0, 20);
}

function buildBenchmarks(profiles) {
  return {
    national: {
      scored: profiles.filter((p) => p.scoreLabel === 'SCORED').length,
      insufficient: profiles.filter((p) => p.scoreLabel === 'INSUFFICIENT_OBSERVATION').length,
      coreComplete: profiles.filter((p) => p.coreComplete).length,
      score: scoreStats(profiles),
      bands: bandHistogram(profiles),
      signals: signalBenchmarks(profiles),
    },
    regulatorCohorts: COHORT_DEFS.map((d) => cohortView(profiles, d)).filter((c) => c.organisations > 0),
    bandCohorts: bandCohorts(profiles),
    sicCohorts: sicCohorts(profiles),
  };
}

module.exports = { buildBenchmarks, scoreStats, bandHistogram, signalBenchmarks, cohortView, COHORT_DEFS };
