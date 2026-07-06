'use strict';

// Report generators for the canonical Organisation Dataset. Pure functions of
// the build state — deterministic, no clocks.

const fs = require('fs');
const path = require('path');

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : '—'; }

function generate(state) {
  const { orgs, orphanDomains, observed, domainOwner, domainContest, domainRows, perSource, records, recovery, outDir } = state;

  const byStatus = (s) => orgs.filter((o) => o.domainStatus === s);
  const verified = byStatus('VERIFIED');
  const pending = byStatus('PENDING');
  const noDomain = byStatus('NO_DOMAIN');
  const withEvidence = orgs.filter((o) => o.observatory.observed);
  const complete = orgs.filter((o) => o.observatory.completeTrustProfile);

  // Regulator breakdown.
  const regs = ['FCA', 'SRA', 'HE', 'PRA'];
  const regRows = regs.map((r) => {
    const set = orgs.filter((o) => o.regulators.includes(r));
    return {
      reg: r, total: set.length,
      verified: set.filter((o) => o.domainStatus === 'VERIFIED').length,
      pending: set.filter((o) => o.domainStatus === 'PENDING').length,
      noDomain: set.filter((o) => o.domainStatus === 'NO_DOMAIN').length,
      observed: set.filter((o) => o.observatory.observed).length,
    };
  });
  const noReg = orgs.filter((o) => o.regulators.length === 0).length;

  // ── reconciliation-report.md ────────────────────────────────────────────────
  const srcOrder = ['fca-registry', 'sra-registry', 'fca-investment-firms', 'if-001', 'if-001-pilot', 'he-001', 'pra-reference', 'gc1-manual'];
  const srcContribution = {};
  for (const o of orgs) for (const s of o.provenance.sources) srcContribution[s] = (srcContribution[s] || new Set());
  for (const o of orgs) for (const s of o.provenance.sources) srcContribution[s].add(o.organisationId);

  let recon = `# Reconciliation Report — Canonical Organisation Dataset\n\n`;
  recon += `Deterministic merge of every legacy organisation registry into one Repository Authority.\n`;
  recon += `Reproduce: \`node backend/authority/build.js\`.\n\n`;
  recon += `## Inputs → source records\n\n| Source | Records in | Organisations contributed to |\n|---|---:|---:|\n`;
  for (const s of srcOrder) {
    if (!perSource[s]) continue;
    recon += `| ${s} | ${perSource[s].records} | ${(srcContribution[s] || new Set()).size} |\n`;
  }
  recon += `| **Total source records** | **${records.length}** | — |\n\n`;
  recon += `## Merge outcome\n\n`;
  recon += `- **Source records in:** ${records.length}\n`;
  recon += `- **Distinct organisations out:** ${orgs.length}\n`;
  recon += `- **Records merged away (duplicates collapsed):** ${records.length - orgs.length}\n`;
  recon += `- **Cross-regulator organisations (>1 regulator):** ${orgs.filter((o) => o.regulators.length > 1).length}\n\n`;
  recon += `## Identifier coverage\n\n| Identifier | Organisations with it | Coverage |\n|---|---:|---:|\n`;
  const withId = (f) => orgs.filter((o) => o.identifiers[f]).length;
  for (const [label, f] of [['Companies House number', 'companiesHouseNumber'], ['FRN', 'frn'], ['SRA number', 'sraIdentifier'], ['UKPRN', 'ukprn'], ['LEI', 'lei']]) {
    recon += `| ${label} | ${withId(f)} | ${pct(withId(f), orgs.length)} |\n`;
  }
  recon += `| Companies House profile attached | ${orgs.filter((o) => o.companiesHouse).length} | ${pct(orgs.filter((o) => o.companiesHouse).length, orgs.length)} |\n`;
  recon += `| SIC codes present | ${orgs.filter((o) => o.sicCodes.length).length} | ${pct(orgs.filter((o) => o.sicCodes.length).length, orgs.length)} |\n\n`;
  recon += `## Domain status\n\n| Status | Organisations | Share |\n|---|---:|---:|\n`;
  recon += `| VERIFIED | ${verified.length} | ${pct(verified.length, orgs.length)} |\n`;
  recon += `| PENDING | ${pending.length} | ${pct(pending.length, orgs.length)} |\n`;
  recon += `| NO_DOMAIN | ${noDomain.length} | ${pct(noDomain.length, orgs.length)} |\n\n`;
  recon += `## Cross-check against SLG-039 (Observatory Population Census)\n\n`;
  recon += `| Metric | SLG-039 | This build |\n|---|---|---|\n`;
  recon += `| Observed distinct domains | 4,867 | ${observed.size} |\n`;
  recon += `| Complete Trust Profiles | 1,893 | ${complete.length} |\n`;
  recon += `| Orphan observations | 954 | ${orphanDomains.length} |\n`;
  fs.writeFileSync(path.join(outDir, 'reconciliation-report.md'), recon);

  // ── duplicate-resolution-report.md ──────────────────────────────────────────
  const merged = orgs.filter((o) => o.provenance.recordCount > 1);
  const crossReg = orgs.filter((o) => o.regulators.length > 1);
  const contestedDomains = [...domainContest.entries()];
  let dup = `# Duplicate Resolution Report\n\n`;
  dup += `Every organisation appears exactly once. Merges use STRONG identifiers only\n`;
  dup += `(company number, FRN, SRA number, UKPRN, IF uuid) — never a shared domain,\n`;
  dup += `because distinct firms legitimately share a domain (group brands / shared hosting).\n\n`;
  dup += `## Merges\n\n`;
  dup += `- **Organisations built from >1 source record:** ${merged.length}\n`;
  dup += `- **Records collapsed:** ${records.length - orgs.length}\n`;
  dup += `- **Cross-regulator organisations (genuine multi-regulation):** ${crossReg.length}\n\n`;
  dup += `### Cross-regulator combinations\n\n| Regulators | Organisations |\n|---|---:|\n`;
  const comboCount = {};
  for (const o of crossReg) { const k = o.regulators.join(' + '); comboCount[k] = (comboCount[k] || 0) + 1; }
  for (const [k, v] of Object.entries(comboCount).sort((a, b) => b[1] - a[1])) dup += `| ${k} | ${v} |\n`;
  dup += `\n### Sample cross-regulator organisations\n\n`;
  for (const o of crossReg.slice(0, 15)) dup += `- \`${o.organisationId}\` **${o.organisationName}** — ${o.regulators.join(' + ')}${o.verifiedDomain ? ` — ${o.verifiedDomain}` : ''}\n`;
  dup += `\n## Contested domains (shared by >1 organisation)\n\n`;
  dup += `To satisfy "no duplicate verified domains", each domain is owned by exactly one\n`;
  dup += `organisation (best verification-source priority; ties broken by Organisation ID).\n`;
  dup += `The other claimants keep the domain only as an unverified candidate and move to PENDING.\n\n`;
  dup += `- **Distinct contested domains:** ${contestedDomains.length}\n`;
  dup += `- **Organisations demoted to candidate on a contested domain:** ${new Set(contestedDomains.flatMap(([, ids]) => ids)).size}\n\n`;
  dup += `### Sample contested domains\n\n| Domain | Owner | Other claimants |\n|---|---|---:|\n`;
  for (const [d, ids] of contestedDomains.slice(0, 20)) dup += `| ${d} | ${domainOwner.get(d)} | ${ids.length} |\n`;
  fs.writeFileSync(path.join(outDir, 'duplicate-resolution-report.md'), dup);

  // ── orphan-observations.md ──────────────────────────────────────────────────
  const tld = {};
  for (const d of orphanDomains) { const t = d.slice(d.indexOf('.')); tld[t] = (tld[t] || 0) + 1; }
  let orph = `# Orphan Observations\n\n`;
  orph += `An orphan is a domain the Observatory has evidence for that resolves to **no**\n`;
  orph += `organisation. SLG-039 §4 recorded **954** such orphans — FCA-regulated firm\n`;
  orph += `domains whose source \`prospects\` table is now empty (provenance loss).\n\n`;
  orph += `## Provenance recovery\n\n`;
  orph += `This reconstruction reclaims them by extracting identity the census never used —\n`;
  orph += `chiefly the FCA registry's PPOB \`Website Address\` field (ignored by SLG-039, which\n`;
  orph += `treated the FCA registry as domainless):\n\n`;
  orph += `| Step | Domains |\n|---|---:|\n`;
  orph += `| Orphans by census method (no FCA-registry websites) | ${recovery.censusOrphans} |\n`;
  orph += `| Recovered by FCA-registry website extraction | ${recovery.recoveredByFcaRegistry} |\n`;
  orph += `| Recovered by other cohorts (IF-001 pilot etc.) | ${recovery.recoveredByOther} |\n`;
  orph += `| **Remaining true orphans** | **${recovery.remainingOrphans}** |\n\n`;
  orph += `- **Orphan observed domains (final):** ${orphanDomains.length}\n`;
  orph += `- **Of total observed:** ${observed.size} (${pct(orphanDomains.length, observed.size)})\n\n`;
  if (orphanDomains.length === 0) {
    orph += `Every observed domain now resolves to exactly one organisation.\n`;
  } else {
    orph += `## By top-level suffix\n\n| Suffix | Domains |\n|---|---:|\n`;
    for (const [t, c] of Object.entries(tld).sort((a, b) => b[1] - a[1]).slice(0, 12)) orph += `| ${t} | ${c} |\n`;
    orph += `\n## Coverage tier of orphans\n\n| Tier | Domains |\n|---|---:|\n`;
    const otier = {};
    for (const d of orphanDomains) { const o = observed.get(d); const t = o.has_complete ? 'complete' : o.has_catd ? 'catD' : 'core'; otier[t] = (otier[t] || 0) + 1; }
    for (const [t, c] of Object.entries(otier)) orph += `| ${t} | ${c} |\n`;
    orph += `\n## Full orphan domain list\n\n`;
    orph += orphanDomains.map((d) => `- ${d}`).join('\n') + '\n';
  }
  fs.writeFileSync(path.join(outDir, 'orphan-observations.md'), orph);

  // ── coverage-report.md ──────────────────────────────────────────────────────
  const withDomain = orgs.filter((o) => o.domainStatus !== 'NO_DOMAIN' && o.candidateDomains.length > 0).length;
  let cov = `# Coverage Report — Canonical Organisation Dataset\n\n`;
  cov += `## Trust coverage funnel\n\n`;
  cov += '```\n';
  const bar = (n, max) => '█'.repeat(Math.max(1, Math.round((n / max) * 40)));
  const maxN = orgs.length;
  cov += `Known organisations        ${String(orgs.length).padStart(6)}   ${bar(orgs.length, maxN)}\n`;
  cov += `  with a domain candidate  ${String(withDomain).padStart(6)}   ${bar(withDomain, maxN)}\n`;
  cov += `  VERIFIED domain          ${String(verified.length).padStart(6)}   ${bar(verified.length, maxN)}\n`;
  cov += `  observed (any evidence)  ${String(withEvidence.length).padStart(6)}   ${bar(withEvidence.length, maxN)}\n`;
  cov += `  complete Trust Profile   ${String(complete.length).padStart(6)}   ${bar(complete.length, maxN)}\n`;
  cov += '```\n\n';
  cov += `## Domain status\n\n| Status | Organisations | Share |\n|---|---:|---:|\n`;
  cov += `| VERIFIED | ${verified.length} | ${pct(verified.length, orgs.length)} |\n`;
  cov += `| PENDING | ${pending.length} | ${pct(pending.length, orgs.length)} |\n`;
  cov += `| NO_DOMAIN | ${noDomain.length} | ${pct(noDomain.length, orgs.length)} |\n`;
  cov += `| **Total** | **${orgs.length}** | 100% |\n\n`;
  cov += `## By regulator\n\n| Regulator | Organisations | Verified | Pending | No-domain | Observed |\n|---|---:|---:|---:|---:|---:|\n`;
  for (const r of regRows) cov += `| ${r.reg} | ${r.total} | ${r.verified} | ${r.pending} | ${r.noDomain} | ${r.observed} |\n`;
  cov += `| (no regulator) | ${noReg} | — | — | — | — |\n\n`;
  cov += `## Observatory\n\n| Metric | Value |\n|---|---:|\n`;
  cov += `| Distinct domains observed | ${observed.size} |\n`;
  cov += `| Observed domains matched to an organisation | ${observed.size - orphanDomains.length} |\n`;
  cov += `| Orphan observed domains | ${orphanDomains.length} |\n`;
  cov += `| Organisations with any evidence | ${withEvidence.length} |\n`;
  cov += `| Organisations with a complete Trust Profile | ${complete.length} |\n`;
  cov += `| Distinct verified domains | ${domainRows.filter((d) => d.status === 'verified').length} |\n\n`;
  cov += `## Pending queue reasons\n\n| Reason | Organisations |\n|---|---:|\n`;
  const rc = {};
  for (const o of pending) for (const r of (o.pendingReasons || [])) rc[r] = (rc[r] || 0) + 1;
  for (const [k, v] of Object.entries(rc).sort((a, b) => b[1] - a[1])) cov += `| ${k} | ${v} |\n`;
  fs.writeFileSync(path.join(outDir, 'coverage-report.md'), cov);
}

module.exports = { generate };
