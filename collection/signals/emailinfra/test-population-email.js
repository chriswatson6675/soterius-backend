'use strict';
// DEV-EMAILINFRA-001 §5 — non-FCA validation test population.
// Live selection by OBSERVED MX (no FCA entities) + fixtures for branches hard to source live
// (multi-provider, ambiguity) and the backend-masking guardrail.
// Validates: SUFFIX matching, provider attribution, has_gateway, email_provision_model, backend guardrail.
const fs = require('fs');
const path = require('path');
const { makeAttributor, attributeObservation, runDomain } = require('./emailinfra-signal');
const { validateRow, reproducible } = require('./validate-email');

// ---- LIVE cases: {domain, expect:{provider_id?, match_type?, model?, has_gateway?, status?}} ----
const LIVE = [
  // MAPPED — Microsoft 365 (DOCUMENTED_SUFFIX)
  { domain: 'microsoft.com', expect: { provider_id: 'EMXP-001', match_type: 'DOCUMENTED_SUFFIX', class: 'mailbox' } },
  { domain: 'sap.com',       expect: { provider_id: 'EMXP-001', match_type: 'DOCUMENTED_SUFFIX' } },
  { domain: 'mit.edu',       expect: { provider_id: 'EMXP-001', match_type: 'DOCUMENTED_SUFFIX' } },
  // MAPPED — Google Workspace (DOCUMENTED_SUFFIX)
  { domain: 'airbnb.com',    expect: { provider_id: 'EMXP-002', match_type: 'DOCUMENTED_SUFFIX' } },
  { domain: 'shopify.com',   expect: { provider_id: 'EMXP-002', match_type: 'DOCUMENTED_SUFFIX' } },
  { domain: 'gitlab.com',    expect: { provider_id: 'EMXP-002', match_type: 'DOCUMENTED_SUFFIX' } },
  // MAPPED — Proofpoint (ETLD1, gateway)
  { domain: 'oracle.com',    expect: { provider_id: 'EMXP-003', match_type: 'ETLD1', has_gateway: true } },
  { domain: 'hsbc.com',      expect: { provider_id: 'EMXP-003', match_type: 'ETLD1', has_gateway: true } },
  // MAPPED — Mimecast (ETLD1, gateway)
  { domain: 'bdo.co.uk',     expect: { provider_id: 'EMXP-004', match_type: 'ETLD1', has_gateway: true } },
  { domain: 'rsmuk.com',     expect: { provider_id: 'EMXP-004', match_type: 'ETLD1', has_gateway: true } },
  // MAPPED — Cisco Secure Email (ETLD1, gateway)
  { domain: 'deloitte.com',  expect: { provider_id: 'EMXP-005', match_type: 'ETLD1', has_gateway: true } },
  // MAPPED — Fastmail (ETLD1, mailbox)
  { domain: 'fastmail.com',  expect: { provider_id: 'EMXP-006', match_type: 'ETLD1' } },
  // MAPPED — Proton (ETLD1, mailbox)
  { domain: 'proton.me',     expect: { provider_id: 'EMXP-007', match_type: 'ETLD1' } },
  // SELF_HOSTED (MX registrable domain == subject; branch precedes ETLD1, incl. zoho.com self-host)
  { domain: 'cisco.com',     expect: { model: 'SELF_HOSTED' } },
  { domain: 'zoho.com',      expect: { model: 'SELF_HOSTED' } },
  // UNMAPPED (provider not in seed -> UNDETERMINED)
  { domain: 'bbc.co.uk',     expect: { model: 'UNDETERMINED' } },
  { domain: 'ox.ac.uk',      expect: { model: 'UNDETERMINED' } },
  // NO-MX (absence-as-fact)
  { domain: 'office.com',    expect: { status: 'NO_MX', model: 'NO_MAIL' } },
];

// ---- FIXTURES: synthetic observations (no network) for branches hard to source live ----
function fixtureObs(has_mx, hosts, status) {
  return { has_mx, status: status || (has_mx ? 'OK' : 'NO_MX'), mx_hosts: hosts, raw: [] };
}
const FIXTURES = [
  { name: 'multi-provider', domain: 'fixture-multi.example',
    obs: fixtureObs(true, [
      { host: 'example-com.mail.protection.outlook.com', priority: 10 }, // M365
      { host: 'mx1.pphosted.com', priority: 20 },                        // Proofpoint
    ]),
    check: (r) => r.multi_provider === true && r.distinct_email_operator_count === 2 &&
                  (r.email_provision_model === 'THIRD_PARTY_MULTI') },
  { name: 'backend-masking', domain: 'fixture-gateway.example',
    obs: fixtureObs(true, [{ host: 'uk-smtp-inbound-1.mimecast.com', priority: 10 }]), // gateway only
    // gateway recorded + has_gateway true; backend NEVER inferred (no backend field anywhere)
    check: (r) => r.has_gateway === true && r.primary_provider_class === 'gateway' &&
                  JSON.stringify(r).toLowerCase().indexOf('backend') === -1 &&
                  r.attributions.every(a => !('backend' in a)) },
];
// AMBIGUITY uses a deliberately defective dataset (duplicate key under two providers).
const AMBIG_DATASET = {
  dataset_version: 0, governed_by: 'EPR-001 (fixture)',
  entries: [
    { provider_id: 'EMXP-X1', provider_name: 'ProvA', provider_class: 'gateway', status: 'ACTIVE',
      attribution_keys: [{ value: 'shared-gw.example', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-X2', provider_name: 'ProvB', provider_class: 'gateway', status: 'ACTIVE',
      attribution_keys: [{ value: 'shared-gw.example', match_type: 'ETLD1' }] },
  ],
};

async function main() {
  const attributor = makeAttributor();           // frozen EPR-DATA-001 v1
  const rows = [];
  const failures = [];
  const pass = (c, m) => { if (!c) failures.push(m); };

  console.log('DEV-EMAILINFRA-001 — Test Population Execution');
  console.log('Dataset:', attributor.datasetVersion, '| Spec:', attributor.specVersion, '\n');

  // ---- LIVE ----
  for (const t of LIVE) {
    const row = await runDomain(t.domain, attributor);
    rows.push(row);
    const v = validateRow(row);
    pass(v.ok, `[schema] ${t.domain}: ${v.errors.join('; ')}`);
    const e = t.expect;
    if (e.status) pass(row.collection_status === e.status, `[status] ${t.domain}: ${row.collection_status} != ${e.status}`);
    if (e.model)  pass(row.email_provision_model === e.model, `[model] ${t.domain}: ${row.email_provision_model} != ${e.model}`);
    if (e.provider_id) {
      const hit = row.attributions.find(a => a.provider_id === e.provider_id);
      pass(!!hit, `[attr] ${t.domain}: expected ${e.provider_id}, got ${row.attributions.map(a => a.provider_id || a.match_status).join(',')}`);
      if (hit && e.match_type) pass(hit.match_type === e.match_type, `[match_type] ${t.domain}: ${hit.match_type} != ${e.match_type}`);
    }
    if (e.class) pass(row.provider_class === e.class, `[class] ${t.domain}: ${row.provider_class} != ${e.class}`);
    if ('has_gateway' in e) pass(row.has_gateway === e.has_gateway, `[has_gateway] ${t.domain}: ${row.has_gateway} != ${e.has_gateway}`);

    const provIds = row.attributions.map(a => a.provider_id || a.match_status).join(',');
    console.log(`LIVE  ${t.domain.padEnd(18)} ${row.collection_status.padEnd(13)} ${String(row.email_provision_model).padEnd(18)} ${provIds}${row.has_gateway ? '  [gateway]' : ''}`);
  }

  // ---- reproducibility (re-run two live domains; identical modulo timestamp) ----
  for (const d of ['microsoft.com', 'bdo.co.uk']) {
    const a = await runDomain(d, attributor), b = await runDomain(d, attributor);
    pass(reproducible(a, b), `[reproducibility] ${d}: not identical on re-run`);
  }

  // ---- FIXTURES ----
  for (const f of FIXTURES) {
    const row = attributeObservation(f.domain, f.obs, attributor);
    rows.push(row);
    const v = validateRow(row);
    pass(v.ok, `[schema] ${f.name}: ${v.errors.join('; ')}`);
    pass(f.check(row), `[fixture] ${f.name}: assertion failed (${row.email_provision_model}, has_gateway=${row.has_gateway})`);
    console.log(`FIX   ${f.name.padEnd(18)} ${String(row.email_provision_model).padEnd(18)} has_gateway=${row.has_gateway}`);
  }

  // ---- AMBIGUITY (defective fixture dataset) ----
  {
    const ambAttr = makeAttributor(AMBIG_DATASET);
    const obs = fixtureObs(true, [{ host: 'mx.shared-gw.example', priority: 10 }]);
    const row = attributeObservation('fixture-ambig.example', obs, ambAttr);
    rows.push(row);
    const isAmb = row.attributions[0].match_status === 'ATTRIBUTION_AMBIGUOUS';
    pass(isAmb, `[ambiguity] expected ATTRIBUTION_AMBIGUOUS, got ${row.attributions[0].match_status}`);
    pass(row.attributions[0].provider_id === null, `[ambiguity] ambiguous host must carry no provider`);
    console.log(`FIX   ${'ambiguity'.padEnd(18)} ${row.attributions[0].match_status}`);
  }

  // ---- GLOBAL boundary sweep: no backend/Category-A/IP-ASN field in ANY row ----
  let boundaryViolations = 0;
  for (const r of rows) { const v = validateRow(r); boundaryViolations += v.errors.filter(e => e.includes('FORBIDDEN')).length; }
  pass(boundaryViolations === 0, `[boundary] ${boundaryViolations} forbidden-field reference(s)`);
  const backendRefs = rows.filter(r => JSON.stringify(r).toLowerCase().includes('backend')).length;
  pass(backendRefs === 0, `[backend-guardrail] ${backendRefs} row(s) contain a backend reference`);

  // ---- report ----
  const out = path.join(__dirname, 'test-population-results.json');
  fs.writeFileSync(out, JSON.stringify({ generated_for: 'DEV-EMAILINFRA-001', dataset: attributor.datasetVersion,
    total: rows.length, failures, rows }, null, 2));

  console.log('\n--- VALIDATION SUMMARY ---');
  console.log('cases (rows):', rows.length);
  console.log('boundary violations:', boundaryViolations, '| backend references:', backendRefs);
  console.log('failures:', failures.length);
  if (failures.length) { failures.forEach(f => console.log('  FAIL', f)); process.exitCode = 1; }
  else console.log('ALL CHECKS PASSED — G1 + G2 satisfied.');
  console.log('results ->', out);
}

main().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
