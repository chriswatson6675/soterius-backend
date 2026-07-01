'use strict';
// ITA-DNSPROVISION-001 §6 / IMP-DNSPROVISION-001 §5 — test-population execution.
// Non-FCA validation population. LIVE domains selected by OBSERVED delegation (no asserted-from-memory
// provider claims beyond the live observation); FIXTURE cases for branches hard to source live and for
// divergence/ambiguity (deterministic). Validates against ITA gates G1/G2. NON-AUTHORITATIVE (DRAFT dataset).

const signal = require('./dnsprovision-signal');
const { buildIndex } = require('./dpr-attribution');
const V = require('./validate');

const NOW = '2026-06-23T00:00:00.000Z'; // fixed for reproducibility comparison

// Expected outcome per live domain, derived from prior live observation of its child-apex NS-zones.
const LIVE = [
  // cloudflare.com's NS are in the cloudflare.com zone == its own eTLD+1 -> SELF_OPERATED
  // (correct: the engine does not infer "org == provider"; that would need registrant = Category E).
  { domain: 'cloudflare.com', expect: { model: 'SELF_OPERATED', primary: null } },
  { domain: 'stackoverflow.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-001' } },
  { domain: 'amazon.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-002' } },
  { domain: 'reddit.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-002' } },
  { domain: 'microsoft.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-003' } },
  { domain: 'nasa.gov', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-005' } },
  { domain: 'adobe.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-005' } },
  { domain: 'wix.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-006' } },
  { domain: 'ibm.com', expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-006' } },
  { domain: 'facebook.com', expect: { model: 'SELF_OPERATED', primary: null } },
  { domain: 'apple.com', expect: { model: 'SELF_OPERATED', primary: null } },
  { domain: 'ford.com', expect: { model: 'SELF_OPERATED', primary: null } },
  { domain: 'shopify.com', expect: { model: 'UNDETERMINED', primary: null } },
  { domain: 'gov.uk', expect: { model: 'UNDETERMINED', primary: null } },
  { domain: 'verisign.com', expect: { model: 'UNDETERMINED', primary: null } },
  { domain: 'github.com', expect: { model: 'THIRD_PARTY_MULTI', primary: null } },
  { domain: 'airbnb.com', expect: { model: 'THIRD_PARTY_MULTI', primary: null } },
  { domain: 'walmart.com', expect: { model: 'MIXED', primary: null } },
  { domain: 'godaddy.com', expect: { model: 'MIXED', primary: null } },
];

// FIXTURE cases (deterministic; inject observed child-apex / parent-delegation).
const FIXTURES = [
  { domain: 'fixture-gcp.example', label: 'Google Cloud DNS', observed: { childApex: { ns_hostnames: ['ns-cloud-a1.googledomains.com', 'ns-cloud-b1.googledomains.com'], soa_mname: 'ns-cloud-a1.googledomains.com', status: 'OK' } }, expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-004' } },
  { domain: 'fixture-godaddy.example', label: 'GoDaddy', observed: { childApex: { ns_hostnames: ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'], soa_mname: 'ns01.domaincontrol.com', status: 'OK' } }, expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-007' } },
  { domain: 'fixture-divergence.example', label: 'DIVERGENCE (parent != child)', observed: { childApex: { ns_hostnames: ['bob.ns.cloudflare.com', 'lily.ns.cloudflare.com'], soa_mname: 'bob.ns.cloudflare.com', status: 'OK' }, parentDelegation: { parent_ns_hostnames: ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'], status: 'OK' } }, expect: { model: 'THIRD_PARTY_SINGLE', primary: 'DNSP-001', divergence: true } },
];

function branchOf(row) { return { model: row.dns_provision_model, primary: row.primary_dns_provider_id }; }

async function run() {
  const runCtx = signal.prepareRun();
  console.log(`# DNS Provision Identity — Test Population Execution`);
  console.log(`# dataset=${runCtx.dataset.dataset_id} v${runCtx.dataset.dataset_version} (${runCtx.dataset.status})  psl=${require('./psl-processor').PSL_VERSION}`);
  console.log(`# dataset duplicate-zone defects: ${runCtx.duplicates.length}\n`);

  const results = [];
  let schemaFail = 0, boundaryViol = 0, reproFail = 0, attrFail = 0;

  async function check(name, domain, opts, expect, isFixture) {
    let row, row2;
    try {
      row = await signal.collectDomain(domain, runCtx, { ...opts, now: NOW });
      row2 = await signal.collectDomain(domain, runCtx, { ...opts, now: '2026-06-23T00:00:01.000Z' });
    } catch (e) {
      results.push({ name, domain, ok: false, note: 'collect error ' + e.code }); attrFail++; return;
    }
    const sErr = V.validateSchema(row); if (sErr.length) schemaFail++;
    const bViol = V.validateBoundary(row); if (bViol.length) boundaryViol += bViol.length;
    const repro = V.reproducible(row, row2); if (!repro) reproFail++;
    const got = branchOf(row);
    const attrOk = got.model === expect.model && (got.primary || null) === (expect.primary || null) &&
      (expect.divergence === undefined || row.ns_delegation_divergence === expect.divergence);
    if (!attrOk) attrFail++;
    results.push({
      name, domain, isFixture,
      zones: row.ns_zones.join('|') || '(none)',
      model: row.dns_provision_model, primary: row.primary_dns_provider_id || '-',
      distinct: row.distinct_dns_operator_count, multi: row.multi_provider,
      div: row.ns_delegation_divergence, parentStatus: row.parent_delegation_status,
      schema: sErr.length ? 'FAIL:' + sErr.join(';') : 'ok',
      boundary: bViol.length ? 'VIOL:' + bViol.join(';') : 'ok',
      repro: repro ? 'ok' : 'FAIL',
      attr: attrOk ? 'ok' : `FAIL(exp ${expect.model}/${expect.primary || '-'})`,
      ok: !sErr.length && !bViol.length && repro && attrOk,
    });
  }

  for (const c of LIVE) await check(c.domain, c.domain, {}, c.expect, false);
  for (const f of FIXTURES) await check(f.label, f.domain, { observed: f.observed }, f.expect, true);

  // AMBIGUITY fixture — a dataset defect (duplicate zone) must yield ATTRIBUTION_AMBIGUOUS.
  const dupDataset = { dataset_version: 99, status: 'TEST', entries: [
    { provider_id: 'DNSP-001', provider_name: 'Cloudflare, Inc.', ns_zones: ['ambig.test'], version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-002', provider_name: 'Amazon Route 53', ns_zones: ['ambig.test'], version_added: 1, status: 'ACTIVE' },
  ] };
  const di = buildIndex(dupDataset);
  const ambigCtx = { dataset: dupDataset, index: di.index, duplicates: di.duplicates };
  const ambigRow = await signal.collectDomain('fixture-ambig.example', ambigCtx, { observed: { childApex: { ns_hostnames: ['ns1.ambig.test'], soa_mname: 'ns1.ambig.test', status: 'OK' } }, now: NOW });
  const ambigOk = di.duplicates.includes('ambig.test') && ambigRow.attributions[0].match_status === 'ATTRIBUTION_AMBIGUOUS';
  results.push({ name: 'AMBIGUITY (dup zone)', domain: 'fixture-ambig.example', isFixture: true, zones: 'ambig.test', model: ambigRow.dns_provision_model, primary: '-', distinct: ambigRow.distinct_dns_operator_count, multi: ambigRow.multi_provider, div: ambigRow.ns_delegation_divergence, parentStatus: '-', schema: V.validateSchema(ambigRow).length ? 'FAIL' : 'ok', boundary: V.validateBoundary(ambigRow).length ? 'VIOL' : 'ok', repro: 'ok', attr: ambigOk ? 'ok' : 'FAIL', ok: ambigOk });
  if (!ambigOk) attrFail++;

  // Report
  console.log('CASE                      | NS-ZONES                              | MODEL              | PRIM     | DST M | DIV  | SCHEMA BND REPRO ATTR');
  console.log('-'.repeat(140));
  for (const r of results) {
    console.log(
      (r.name).padEnd(25) + ' | ' + String(r.zones).slice(0, 36).padEnd(37) + ' | ' +
      String(r.model).padEnd(18) + ' | ' + String(r.primary).padEnd(8) + ' | ' +
      String(r.distinct).padEnd(1) + ' ' + String(r.multi ? 'Y' : 'n') + ' | ' +
      String(r.div === null ? '-' : r.div ? 'Y' : 'n').padEnd(4) + ' | ' +
      (r.schema === 'ok' ? 'ok' : 'X').padEnd(6) + ' ' + (r.boundary === 'ok' ? 'ok' : 'X').padEnd(3) + ' ' +
      (r.repro === 'ok' ? 'ok' : 'X').padEnd(5) + ' ' + (r.attr === 'ok' ? 'ok' : r.attr));
  }

  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  console.log('\n# GATE SUMMARY (ITA G1/G2)');
  console.log(`  cases:                 ${total}  (live ${LIVE.length}, fixture ${total - LIVE.length})`);
  console.log(`  schema compliance:     ${total - schemaFail}/${total}  ${schemaFail === 0 ? 'PASS (100%)' : 'FAIL'}`);
  console.log(`  reproducibility:       ${total - reproFail}/${total}  ${reproFail === 0 ? 'PASS (100%)' : 'FAIL'}`);
  console.log(`  attribution correct:   ${total - attrFail}/${total}  ${attrFail === 0 ? 'PASS (100%)' : 'FAIL'}`);
  console.log(`  boundary violations:   ${boundaryViol}  ${boundaryViol === 0 ? 'PASS (0)' : 'FAIL'}`);
  console.log(`  multi-provider case:   ${results.find(r => r.name === 'github.com')?.model === 'THIRD_PARTY_MULTI' ? 'PASS' : 'CHECK'}`);
  console.log(`  divergence case:       ${results.find(r => /DIVERGENCE/.test(r.name))?.div === true ? 'PASS' : 'CHECK'}`);
  console.log(`  ambiguity case:        ${results.find(r => /AMBIGUITY/.test(r.name))?.attr === 'ok' ? 'PASS' : 'CHECK'}`);
  const allPass = schemaFail === 0 && reproFail === 0 && attrFail === 0 && boundaryViol === 0;
  console.log(`\n# OVERALL: ${passed}/${total} cases fully pass — G1/G2 ${allPass ? 'PASS' : 'NOT MET'}`);
  process.exit(allPass ? 0 : 1);
}

run().catch(e => { console.error('FATAL', e); process.exit(2); });
