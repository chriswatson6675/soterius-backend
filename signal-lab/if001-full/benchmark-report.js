'use strict';

// Generic Cohort Benchmark Report Generator
// ============================================================================
//
// PURPOSE
//   The final analytical stage of the Observatory reporting pipeline:
//
//       Observatory → Collection Report → Analysis Report → Benchmark Report
//
//   The Analysis Report answers "what did one cohort look like?". The Benchmark
//   Report answers "how do two or more completed cohorts compare?". It derives every
//   figure from existing Analysis Reports — it does NOT query collectors, the database,
//   or rerun any analysis, and writes nothing to any database.
//
// ARCHITECTURAL PRINCIPLE
//   Each stage consumes only the previous stage's artefact; no stage knows about later
//   stages. This generator's sole input is a set of `<STEM>_ANALYSIS_REPORT.md` files;
//   it has no Supabase client and no knowledge of the Observatory internals.
//
// INPUTS
//   Two or more completed Analysis Reports (markdown). The comparison joins on signal
//   label and distribution category — both emitted identically for every population by
//   the Analysis Report generator — so there is no FCA/SRA/IF-specific code and future
//   populations (HE, Charities, NHS, Local Authorities, …) work with no modification.
//
// OUTPUT
//   `<CODE-A>_vs_<CODE-B>[_vs_<CODE-C>…]_BENCHMARK_REPORT.md`, written alongside the
//   input reports. The cohort code is the leading segment of the cohort id
//   (FCA-REG-001 → FCA, SRA-REG-001 → SRA, IF-001 → IF). Sections: Benchmark Summary,
//   Signal Comparison, Distribution Comparison, Benchmark Findings, Reconciliation.
//
// METHODOLOGY (deterministic; observation-only)
//   * Signal comparison: per signal, each cohort's adoption %, the spread (max − min),
//     and which cohort is highest / lowest. For exactly two cohorts the spread is the
//     absolute difference.
//   * Distribution comparison: each observable breakdown (DMARC policy, MTA-STS mode,
//     DNSSEC, security.txt file state, Security Headers maturity) shown category-by-
//     category as each cohort's share.
//   * Findings: highest / lowest observed adoption, largest / smallest difference —
//     all derived facts, no recommendations, no ranking of organisations, no scoring.
//   * Reconciliation: every figure is traced to its source Analysis Reports, and each
//     cohort's parsed adoption is re-checked against its own present ÷ observed (the
//     only consistency check possible without re-reading the database — which is
//     deliberately not done).
//
// USAGE
//   node benchmark-report.js <analysis-A.md> <analysis-B.md> [<analysis-C.md> …]
//
// ============================================================================

const fs   = require('node:fs');
const path = require('node:path');

// ── Parsing the Analysis Report (the previous pipeline stage's artefact) ─────────

function num(s) {
  if (s == null) return null;
  const m = String(s).replace(/[*%,]/g, '').trim().match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function shortCodeOf(cohortId) {
  return String(cohortId).split(/[-_\s]/)[0].toUpperCase();
}

// Split a markdown table row "| a | b | c |" into trimmed cells.
function cells(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
}
function isSeparatorRow(line) { return /^\s*\|[\s:\-|]+\|\s*$/.test(line); }

function sectionBetween(md, startRe, endRe) {
  const start = md.search(startRe);
  if (start === -1) return '';
  const rest = md.slice(start);
  const endRel = endRe ? rest.slice(1).search(endRe) : -1;
  return endRel === -1 ? rest : rest.slice(0, endRel + 1);
}

function parseAnalysisReport(md, sourcePath) {
  const cohortLine = md.match(/^\*\*Cohort:\*\*\s*(.+?)\s+—\s+(.+)$/m);
  if (!cohortLine) throw new Error(`Could not parse Cohort line${sourcePath ? ` in ${sourcePath}` : ''}`);
  const cohortId   = cohortLine[1].trim();
  const cohortName = cohortLine[2].trim();

  const cell = label => {
    const m = md.match(new RegExp(`\\|\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*(.+?)\\s*\\|`));
    return m ? m[1] : null;
  };

  const meta = {
    cohortId,
    cohortName,
    shortCode:      shortCodeOf(cohortId),
    selectionId:    (md.match(/^\*\*Selection ID:\*\*\s*(.+)$/m) || [])[1]?.trim() || null,
    organisations:  num(cell('Organisations scanned')),
    observations:   num(cell('Observations collected')),
    completionRate: num(cell('Completion rate')),
  };

  // §2 Signal Adoption — | Signal | Observed | Present | Absent | Retrieval failures | Adoption |
  const signals = {};
  const order = [];
  const sig = sectionBetween(md, /## 2\. Signal Adoption/, /\n## /);
  for (const line of sig.split('\n')) {
    if (!/^\s*\|/.test(line) || isSeparatorRow(line)) continue;
    const c = cells(line);
    if (c.length < 6 || c[0] === 'Signal') continue;
    const label = c[0];
    signals[label] = {
      observed:    num(c[1]),
      present:     num(c[2]),
      absent:      num(c[3]),
      failuresRaw: c[4],
      adoptionPct: num(c[5]),
    };
    order.push(label);
  }
  if (order.length === 0) throw new Error(`Could not parse Signal Adoption table${sourcePath ? ` in ${sourcePath}` : ''}`);

  // §3 Distribution — repeated "### <title>" then | Category | Count | Share |
  const distributions = {};
  const distOrder = [];
  const dist = sectionBetween(md, /## 3\. Distribution/, /\n## 4\./);
  let current = null;
  for (const line of dist.split('\n')) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) { current = h[1]; distributions[current] = []; distOrder.push(current); continue; }
    if (!current || !/^\s*\|/.test(line) || isSeparatorRow(line)) continue;
    const c = cells(line);
    if (c.length < 3 || c[0] === 'Category' || c[0] === 'Header') continue;
    distributions[current].push({ category: c[0], count: num(c[1]), share: num(c[2]) });
  }

  return { meta, signals, signalOrder: order, distributions, distOrder, sourcePath };
}

// ── Comparison (population-agnostic; joins on label / category) ──────────────────

function compareSignals(reports) {
  // Canonical order = the order signals appear in the first report, then any extras.
  const order = [...reports[0].signalOrder];
  for (const r of reports) for (const l of r.signalOrder) if (!order.includes(l)) order.push(l);

  return order.map(label => {
    const perCohort = reports.map(r => ({
      code: r.meta.shortCode,
      pct:  r.signals[label] ? r.signals[label].adoptionPct : null,
    }));
    const present = perCohort.filter(x => x.pct != null);
    const max = present.length ? Math.max(...present.map(x => x.pct)) : null;
    const min = present.length ? Math.min(...present.map(x => x.pct)) : null;
    const spread = max != null ? Number((max - min).toFixed(1)) : null;
    const highest = present.length ? present.find(x => x.pct === max).code : null;
    const lowest  = present.length ? present.find(x => x.pct === min).code : null;
    return { label, perCohort, spread, max, min, highest, lowest, tie: spread === 0 };
  });
}

function compareDistributions(reports) {
  // Only distributions present in EVERY report are compared (a strict join).
  const common = reports[0].distOrder.filter(t => reports.every(r => r.distributions[t]));
  return common.map(title => {
    // Category order = first report's, plus any extras seen later.
    const catOrder = [];
    for (const r of reports) for (const row of r.distributions[title]) if (!catOrder.includes(row.category)) catOrder.push(row.category);
    const rows = catOrder.map(category => ({
      category,
      perCohort: reports.map(r => {
        const found = r.distributions[title].find(x => x.category === category);
        return { code: r.meta.shortCode, share: found ? found.share : null };
      }),
    }));
    return { title, rows };
  });
}

// ── Findings (deterministic, observation-only) ──────────────────────────────────

function buildBenchmarkFindings(signalComparison) {
  const flat = [];
  for (const s of signalComparison) for (const c of s.perCohort) if (c.pct != null) flat.push({ label: s.label, code: c.code, pct: c.pct });

  // Stable extremes (ties resolved by canonical signal order, then report order).
  const highest = flat.reduce((a, b) => (b.pct > a.pct ? b : a), flat[0]);
  const lowest  = flat.reduce((a, b) => (b.pct < a.pct ? b : a), flat[0]);

  const withSpread = signalComparison.filter(s => s.spread != null);
  const largest = withSpread.reduce((a, b) => (b.spread > a.spread ? b : a), withSpread[0]);
  const smallest = withSpread.reduce((a, b) => (b.spread < a.spread ? b : a), withSpread[0]);

  const lines = [];
  lines.push(`- Highest observed adoption: **${highest.label} ${highest.pct}%** (${highest.code}).`);
  lines.push(`- Lowest observed adoption: **${lowest.label} ${lowest.pct}%** (${lowest.code}).`);
  lines.push(`- Largest difference between cohorts: **${largest.label}** (${largest.spread} pp spread; highest ${largest.highest}, lowest ${largest.lowest}).`);
  lines.push(`- Smallest difference between cohorts: **${smallest.label}** (${smallest.spread} pp spread${smallest.tie ? ' — identical across cohorts' : ''}).`);

  // Signals identical across all cohorts (spread 0) — observed fact.
  const identical = signalComparison.filter(s => s.spread === 0 && s.max != null).map(s => `${s.label} (${s.max}%)`);
  if (identical.length) lines.push(`- Signals observed identically across all cohorts: ${identical.join(', ')}.`);

  return lines;
}

// ── Rendering ───────────────────────────────────────────────────────────────────

function fmtPct(n) { return n == null ? '—' : `${n}%`; }

function renderBenchmark(reports, generatedAt) {
  const codes = reports.map(r => r.meta.shortCode);
  const signalComparison = compareSignals(reports);
  const distComparison   = compareDistributions(reports);
  const findings         = buildBenchmarkFindings(signalComparison);

  const L = [];
  const title = `${codes.join('_vs_')}_BENCHMARK_REPORT`;
  L.push(`# ${title}`);
  L.push('');
  L.push(`**Cohorts compared:** ${reports.map(r => `${r.meta.cohortId} (${r.meta.cohortName})`).join('  •  ')}`);
  L.push(`**Source Analysis Reports:** ${reports.map(r => path.basename(r.sourcePath || `${r.meta.shortCode}`)).join(', ')}`);
  L.push('');
  L.push('> Final stage of the reporting pipeline: Observatory → Collection Report → Analysis Report → **Benchmark Report**.');
  L.push('> Every figure is derived from the source Analysis Reports — no rescanning, no recollection, no database access.');
  L.push('');
  L.push('---');
  L.push('');

  // 1. Benchmark Summary
  L.push('## 1. Benchmark Summary');
  L.push('');
  L.push(`| Metric | ${codes.join(' | ')} |`);
  L.push(`|---|${codes.map(() => '---').join('|')}|`);
  L.push(`| Population | ${reports.map(r => r.meta.cohortName).join(' | ')} |`);
  L.push(`| Organisations | ${reports.map(r => fmtNum(r.meta.organisations)).join(' | ')} |`);
  L.push(`| Observations | ${reports.map(r => fmtNum(r.meta.observations)).join(' | ')} |`);
  L.push(`| Completion rate | ${reports.map(r => fmtPct(r.meta.completionRate)).join(' | ')} |`);
  L.push('');
  L.push('---');
  L.push('');

  // 2. Signal Comparison
  L.push('## 2. Signal Comparison');
  L.push('');
  L.push('Adoption % per cohort, with the spread (max − min) and the highest / lowest cohort.');
  L.push('');
  L.push(`| Signal | ${codes.join(' | ')} | Δ (max−min) | Higher | Lower |`);
  L.push(`|---|${codes.map(() => '---').join('|')}|---|---|---|`);
  for (const s of signalComparison) {
    const perCohort = s.perCohort.map(c => fmtPct(c.pct)).join(' | ');
    const delta = s.spread == null ? '—' : `${s.spread} pp`;
    const higher = s.tie ? '— (tie)' : (s.highest || '—');
    const lower  = s.tie ? '— (tie)' : (s.lowest || '—');
    L.push(`| ${s.label} | ${perCohort} | ${delta} | ${higher} | ${lower} |`);
  }
  L.push('');
  L.push('> "Higher" / "Lower" name the cohort with the greater / lesser observed adoption — a factual comparison, not a ranking or score.');
  L.push('');
  L.push('---');
  L.push('');

  // 3. Distribution Comparison
  L.push('## 3. Distribution Comparison');
  L.push('');
  L.push('Observable breakdowns compared category-by-category (share of each cohort).');
  L.push('');
  for (const d of distComparison) {
    L.push(`### ${d.title}`);
    L.push('');
    L.push(`| Category | ${codes.join(' | ')} |`);
    L.push(`|---|${codes.map(() => '---').join('|')}|`);
    for (const row of d.rows) {
      L.push(`| ${row.category} | ${row.perCohort.map(c => fmtPct(c.share)).join(' | ')} |`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');

  // 4. Benchmark Findings
  L.push('## 4. Benchmark Findings');
  L.push('');
  L.push('Observed facts only. No recommendations; no speculation; no ranking of organisations; no sector scoring.');
  L.push('');
  for (const line of findings) L.push(line);
  L.push('');
  L.push('---');
  L.push('');

  // 5. Reconciliation
  const recon = reconcile(reports);
  L.push('## 5. Reconciliation');
  L.push('');
  L.push('| Check | Result |');
  L.push('|---|---|');
  L.push(`| Source Analysis Reports | ${reports.length} (${reports.map(r => r.meta.shortCode).join(', ')}) |`);
  L.push(`| Signals compared | ${signalComparison.length} |`);
  L.push(`| Every figure traced to a source Analysis Report | ✓ (parsed directly; no other source) |`);
  L.push(`| Adoption internally consistent (present ÷ observed = stated adoption) | ${recon.consistent ? '✓ all' : `⚠ ${recon.mismatches.length} mismatch(es)`} |`);
  L.push(`| Calculations depend on Observatory output directly | ✗ none (Analysis Reports only) |`);
  L.push(`| Database accessed / rescanning performed | ✗ none |`);
  L.push('');
  if (!recon.consistent) {
    L.push('Mismatches (parsed adoption vs present÷observed):');
    for (const m of recon.mismatches) L.push(`- ${m.code} / ${m.label}: stated ${m.stated}%, computed ${m.computed}%`);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`*Generated: ${generatedAt}*`);
  L.push(`*Benchmark derived from Analysis Reports only; no rescanning, no recollection, no database writes.*`);

  return { markdown: L.join('\n'), title, signalComparison, distComparison, findings, reconcileOk: recon.consistent };
}

function fmtNum(n) { return n == null ? '—' : String(n); }

// Internal-consistency reconciliation: re-derive each adoption from the present/observed
// the Analysis Report itself carries. This uses ONLY the Analysis Reports (never the DB).
function reconcile(reports) {
  const mismatches = [];
  for (const r of reports) {
    for (const label of r.signalOrder) {
      const s = r.signals[label];
      if (s.observed == null || s.present == null || s.adoptionPct == null || s.observed === 0) continue;
      const computed = Number((s.present / s.observed * 100).toFixed(1));
      if (Math.abs(computed - s.adoptionPct) > 0.1) {
        mismatches.push({ code: r.meta.shortCode, label, stated: s.adoptionPct, computed });
      }
    }
  }
  return { consistent: mismatches.length === 0, mismatches };
}

// ── Orchestration ───────────────────────────────────────────────────────────────

function benchmark(reportPaths, { generatedAt } = {}) {
  if (!reportPaths || reportPaths.length < 2) throw new Error('At least two Analysis Reports are required.');
  const reports = reportPaths.map(p => parseAnalysisReport(fs.readFileSync(p, 'utf8'), p));
  const rendered = renderBenchmark(reports, generatedAt || new Date().toISOString());
  return { reports, rendered };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node benchmark-report.js <analysis-A.md> <analysis-B.md> [<analysis-C.md> …]');
    process.exit(1);
  }
  const abs = args.map(a => path.resolve(a));
  for (const p of abs) if (!fs.existsSync(p)) { console.error(`Analysis report not found: ${p}`); process.exit(1); }

  const { reports, rendered } = benchmark(abs);
  const outPath = path.join(path.dirname(abs[0]), `${rendered.title}.md`);
  fs.writeFileSync(outPath, rendered.markdown, 'utf8');

  console.log(`\n  Cohorts:   ${reports.map(r => `${r.meta.shortCode} (${r.meta.organisations} orgs)`).join('  vs  ')}`);
  console.log(`  Signals compared: ${rendered.signalComparison.length}`);
  console.log(`  Reconciliation:   ${rendered.reconcileOk ? 'OK (internally consistent)' : 'MISMATCH'}`);
  console.log(`  Benchmark report: ${outPath}\n`);
  if (!rendered.reconcileOk) process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseAnalysisReport,
  shortCodeOf,
  compareSignals,
  compareDistributions,
  buildBenchmarkFindings,
  reconcile,
  renderBenchmark,
  benchmark,
  num,
};
