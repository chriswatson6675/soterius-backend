'use strict';
// DEV-CLOUDHOST-001 — non-FCA validation population (behaviour validation; NO FCA cohort, NO production run).
// Live public domains (selected by OBSERVED attribution) + synthetic fixtures for branches hard to source live
// (range+ASN corroboration, CONFLICT, multi-provider, IPv6-via-ASN, no-endpoint).
const fs = require('fs');
const path = require('path');
const { makeAttributor, attributeObservation, runDomain } = require('./cloudhost-signal');
const { collect } = require('./cloudhost-collector');
const { validateRow, reproducible } = require('./validate-cloudhost');

// ---- LIVE cases: {domain, expect:{provider_id?, model}} ----
const LIVE = [
  { domain: 'amazon.com',     expect: { provider_id: 'HCP-001', model: 'SINGLE_PROVIDER' } },
  { domain: 'netflix.com',    expect: { provider_id: 'HCP-001', model: 'SINGLE_PROVIDER' } },
  { domain: 'khanacademy.org',expect: { provider_id: 'HCP-001', model: 'SINGLE_PROVIDER' } },
  { domain: 'microsoft.com',  expect: { provider_id: 'HCP-002', model: 'SINGLE_PROVIDER' } },
  { domain: 'xbox.com',       expect: { provider_id: 'HCP-002', model: 'SINGLE_PROVIDER' } },
  { domain: 'spotify.com',    expect: { provider_id: 'HCP-003', model: 'SINGLE_PROVIDER' } },
  { domain: 'cloudflare.com', expect: { model: 'UNDETERMINED' } },   // CDN-fronted (Cloudflare AS13335) → UNMAPPED
  { domain: 'fastly.com',     expect: { model: 'UNDETERMINED' } },   // Fastly AS54113
  { domain: 'bbc.co.uk',      expect: { model: 'UNDETERMINED' } },   // CDN-fronted
  { domain: 'office.com',     expect: { model: 'UNDETERMINED' } },   // Microsoft AS8068 — not in minimal seed (coverage gap)
];

// ---- FIXTURES: synthetic observations (no network) ----
const obs = (has, ips, status) => ({ has_endpoint: has, status: status || (has ? 'OK' : 'NO_ENDPOINT'), resolved_ips: ips });
const FIX = [
  { name: 'range+ASN corroboration (AWS)', domain: 'fx-corrob.example',
    obs: obs(true, [{ ip: '54.79.1.2', version: 4, asn: 16509, bgp_prefix: '54.79.0.0/16', cc: 'AU', rir: 'apnic' }]),
    check: r => r.hosting_provision_model === 'SINGLE_PROVIDER' && r.primary_hosting_provider_id === 'HCP-001' && r.ip_attributions[0].via === 'range+asn' && r.ip_attributions[0].corroborated === true },
  { name: 'CONFLICT (AWS range + Azure ASN)', domain: 'fx-conflict.example',
    obs: obs(true, [{ ip: '3.40.1.1', version: 4, asn: 8075, bgp_prefix: '3.40.0.0/17', cc: 'KR', rir: 'apnic' }]),
    check: r => r.ip_attributions[0].match_status === 'CONFLICT' && r.hosting_provision_model === 'UNDETERMINED' && r.ip_attributions[0].provider_id === null },
  { name: 'MULTI_PROVIDER (AWS + GCP)', domain: 'fx-multi.example',
    obs: obs(true, [{ ip: '54.79.5.5', version: 4, asn: 16509, bgp_prefix: '54.79.0.0/16', cc: 'AU', rir: 'apnic' }, { ip: '8.8.4.4', version: 4, asn: 396982, bgp_prefix: '8.8.4.0/24', cc: 'US', rir: 'arin' }]),
    check: r => r.hosting_provision_model === 'MULTI_PROVIDER' && r.distinct_provider_count === 2 && r.multi_provider === true },
  { name: 'IPv6 via ASN (AWS)', domain: 'fx-v6.example',
    obs: obs(true, [{ ip: '2600:1f18:abcd:1::1', version: 6, asn: 14618, bgp_prefix: '2600:1f18::/36', cc: 'US', rir: 'arin' }]),
    check: r => r.ip_attributions[0].match_status === 'MAPPED' && r.primary_hosting_provider_id === 'HCP-001' && r.ip_attributions[0].via === 'asn' },
  { name: 'NO_ENDPOINT (no A/AAAA)', domain: 'fx-noendpoint.example',
    obs: obs(false, []),
    check: r => r.has_endpoint === false && r.hosting_provision_model === 'NO_ENDPOINT' },
];

async function main() {
  const A = makeAttributor();
  if (!A.frozen) { console.log('WARN: dataset not frozen'); }
  const rows = [], fails = [];
  const pass = (c, m) => { if (!c) fails.push(m); };
  console.log('DEV-CLOUDHOST-001 — Behaviour Validation');
  console.log(`dataset ${A.datasetVersion} (frozen=${A.frozen}) | spec ${A.specVersion}\n`);

  console.log('## LIVE (selection by observed attribution; non-FCA public domains)');
  for (const t of LIVE) {
    const row = await runDomain(t.domain, A); rows.push(row);
    const v = validateRow(row); pass(v.ok, `[schema] ${t.domain}: ${v.errors.join('; ')}`);
    pass(row.hosting_provision_model === t.expect.model, `[model] ${t.domain}: ${row.hosting_provision_model} != ${t.expect.model}`);
    if (t.expect.provider_id) pass(row.primary_hosting_provider_id === t.expect.provider_id, `[provider] ${t.domain}: ${row.primary_hosting_provider_id} != ${t.expect.provider_id}`);
    const via = [...new Set(row.ip_attributions.map(a => a.via).filter(Boolean))].join(',') || '-';
    const p = row.primary_hosting_provider_id || row.ip_attributions.map(a => a.match_status)[0];
    console.log(`  ${t.domain.padEnd(17)} ${row.hosting_provision_model.padEnd(15)} ${String(p).padEnd(9)} via=${via}`);
  }

  console.log('\n## FIXTURES (synthetic; branches hard to source live)');
  for (const f of FIX) {
    const row = attributeObservation(f.domain, f.obs, A); rows.push(row);
    const v = validateRow(row); pass(v.ok, `[schema] ${f.name}: ${v.errors.join('; ')}`);
    pass(f.check(row), `[fixture] ${f.name}: assertion failed (${row.hosting_provision_model})`);
    console.log(`  ${f.name.padEnd(34)} ${row.hosting_provision_model.padEnd(15)} ${row.ip_attributions.map(a => a.match_status).join(',')}`);
  }

  console.log('\n## DETERMINISM / REPRODUCIBILITY (attribution of identical Layer-A — HPR-001 §8.2)');
  // The constitutional guarantee is ATTRIBUTION determinism: identical evidence + identical version
  // → identical attribution. (Live re-COLLECTION of A-records may differ due to DNS rotation — a
  // collection-layer fact handled by preserving raw evidence per run, NOT an attribution defect.)
  for (const d of ['amazon.com', 'spotify.com']) {
    const o = await collect(d);                                  // capture Layer-A once
    const a = attributeObservation(d, o, A), b = attributeObservation(d, o, A);
    pass(reproducible(a, b), `[repro] ${d}: re-attribution of identical evidence not identical`);
    console.log(`  ${d.padEnd(17)} re-attribution of identical Layer-A identical: ${reproducible(a, b)}`);
  }
  // collection-layer note (informational): re-collection may differ for rotating A-records
  {
    const c1 = await collect('amazon.com'), c2 = await collect('amazon.com');
    const sameIps = JSON.stringify(c1.resolved_ips.map(x => x.ip).sort()) === JSON.stringify(c2.resolved_ips.map(x => x.ip).sort());
    console.log(`  note: amazon.com re-collection IP-set stable across calls: ${sameIps} (DNS rotation is expected; raw evidence preserved per run)`);
  }

  // boundary sweep
  let boundary = 0; for (const r of rows) boundary += validateRow(r).errors.filter(e => e.includes('FORBIDDEN') || e.includes('geolocation') || e.includes('confidence')).length;
  pass(boundary === 0, `[boundary] ${boundary} violation(s)`);

  fs.writeFileSync(path.join(__dirname, 'cloudhost-validation-results.json'), JSON.stringify({ rows, fails }, null, 1));
  console.log('\n## SUMMARY');
  console.log(`  cases: ${rows.length} | boundary violations: ${boundary} | failures: ${fails.length}`);
  if (fails.length) { fails.forEach(f => console.log('  FAIL', f)); process.exitCode = 1; }
  else console.log('  ALL BEHAVIOUR CHECKS PASS.');
}
main().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
