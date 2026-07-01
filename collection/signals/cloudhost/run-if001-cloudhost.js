'use strict';
// RUN-CLOUDHOST-001 — first operational Cloud/Hosting Provider Identity collection across IF-001.
// Executes SOT-CLOUDHOST-001 (frozen HPR-DATA-001 v1.0). Layer A (A/AAAA + Cymru IP→ASN) → Layer B
// (HPR exact-match) → Layer C composition. Assessment-layer stats are descriptive only — NO scoring.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { makeAttributor, runDomain, attributeObservation } = require('./cloudhost-signal');
const { collect } = require('./cloudhost-collector');
const { validateRow, reproducible } = require('./validate-cloudhost');

const MANIFEST = path.join(__dirname, '..', '..', 'if001-full', 'cohort-manifest.json');
const OUT = path.join(__dirname, 'if001-cloudhost-results.json');
const CONCURRENCY = 20;

async function pool(items, n, worker) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; out[idx] = await worker(items[idx], idx); if (idx % 100 === 0) process.stderr.write(`  ..${idx}/${items.length}\r`); }
  }));
  return out;
}
const tally = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const sortDesc = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
const pc = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';

async function asnName(asn) {
  try { const t = await dns.resolveTxt(`AS${asn}.asn.cymru.com`); const f = t[0].join('').split('|').map(s => s.trim()); return f[4] || '?'; } catch { return '?'; }
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const firms = manifest.firms.filter(f => f.domain);
  const A = makeAttributor();
  const nameOf = id => { const e = A.ds.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };
  console.log(`# RUN-CLOUDHOST-001 — IF-001 Cloud/Hosting Provider Identity`);
  console.log(`# cohort=${manifest.cohort_id} firms=${firms.length} | dataset=${A.datasetVersion} (frozen=${A.frozen}) | source=Cymru DNS-TXT`);
  console.log(`# seed: Tier-1 hyperscale only (HCP-001 AWS, HCP-002 Azure, HCP-003 Google Cloud)\n`);

  const t0 = Date.now();
  const rows = await pool(firms, CONCURRENCY, async (f) => {
    try { return await runDomain(f.domain, A); }
    catch (e) { return { subject_domain: f.domain, collection_status: 'COLLECT_ERROR', has_endpoint: false, resolved_ips: [], ip_attributions: [], hosting_provision_model: 'UNDETERMINED', distinct_provider_count: 0, distinct_asn_count: 0, multi_provider: false }; }
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));

  // collection outcomes
  const status = new Map(); for (const r of rows) tally(status, r.collection_status || 'OK');
  const withEp = rows.filter(r => r.has_endpoint);
  const noEp = rows.filter(r => r.collection_status === 'NO_ENDPOINT').length;
  const errs = rows.filter(r => r.collection_status === 'COLLECT_ERROR').length;

  // validation
  let schemaFail = 0, boundary = 0; for (const r of rows) { const v = validateRow(r); if (v.errors.some(e => !e.includes('FORBIDDEN') && !e.includes('geolocation') && !e.includes('confidence'))) schemaFail++; boundary += v.errors.filter(e => e.includes('FORBIDDEN') || e.includes('geolocation') || e.includes('confidence')).length; }
  // reproducibility: re-attribute captured Layer-A for a sample (attribution determinism)
  let reproFail = 0; const sample = withEp.slice(0, 30);
  for (const r of sample) { const o = { has_endpoint: true, status: 'OK', resolved_ips: r.resolved_ips.map(x => ({ ip: x.ip, version: x.version, asn: x.asn, bgp_prefix: x.bgp_prefix, cc: null, rir: null })) }; const a = attributeObservation(r.subject_domain, o, A), b = attributeObservation(r.subject_domain, o, A); if (!reproducible(a, b)) reproFail++; }

  // composition + provider prevalence
  const model = new Map(), anyProvider = new Map(); let mappedAny = 0, multi = 0;
  const unmappedAsn = new Map();
  for (const r of withEp) {
    tally(model, r.hosting_provision_model);
    if (r.multi_provider) multi++;
    const provs = new Set();
    let hasMapped = false;
    for (const a of r.ip_attributions) {
      if (a.match_status === 'MAPPED') { provs.add(a.provider_id); hasMapped = true; }
      else if (a.match_status === 'UNMAPPED' && a.asn != null) tally(unmappedAsn, a.asn);
    }
    if (hasMapped) mappedAny++;
    for (const p of provs) tally(anyProvider, p);
  }

  console.log(`## D1/D2 — COLLECTION (${elapsed}s)`);
  console.log(`  firms processed:      ${rows.length}`);
  console.log(`  endpoint resolved:    ${withEp.length} (${pc(withEp.length, rows.length)})`);
  console.log(`  NO_ENDPOINT:          ${noEp} (${pc(noEp, rows.length)}) | errors: ${errs}`);
  console.log(`  schema: ${rows.length - schemaFail}/${rows.length} ${schemaFail === 0 ? 'PASS' : 'FAIL'} | boundary violations: ${boundary} ${boundary === 0 ? 'PASS' : 'FAIL'} | reproducibility(n=${sample.length}): ${sample.length - reproFail}/${sample.length} ${reproFail === 0 ? 'PASS' : 'FAIL'}`);

  console.log(`\n## D3 — PROVISION MODEL (of ${withEp.length} resolved)`);
  for (const [k, v] of sortDesc(model)) console.log(`  ${k.padEnd(18)} ${String(v).padStart(5)} ${pc(v, withEp.length)}`);

  console.log(`\n## D3 — HYPERSCALE PROVIDER PREVALENCE (appears anywhere)`);
  for (const [id, v] of sortDesc(anyProvider)) console.log(`  ${nameOf(id).padEnd(22)} ${String(v).padStart(5)} ${pc(v, withEp.length)}`);
  console.log(`  -- any known hyperscaler (mapped): ${mappedAny} (${pc(mappedAny, withEp.length)})`);
  console.log(`  -- multi-provider: ${multi} (${pc(multi, withEp.length)})`);

  console.log(`\n## D4 — UNMAPPED ANALYSIS — top UNMAPPED ASNs (HPR-DATA-002 candidates)`);
  const topUn = sortDesc(unmappedAsn).slice(0, 20);
  const names = {}; for (const [asn] of topUn) names[asn] = await asnName(asn);
  for (const [asn, v] of topUn) console.log(`  AS${String(asn).padEnd(7)} ${String(v).padStart(4)} IPs  ${names[asn]}`);
  console.log(`  (distinct UNMAPPED ASNs: ${unmappedAsn.size})`);

  console.log(`\n# rows preserved -> ${path.basename(OUT)} (${rows.length} rows; ${withEp.length} resolved)`);
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
