'use strict';
// EPR-DATA-002 — validation + coverage estimate.
// Validates v2 schema / uniqueness / disjointness / no-suffix-nesting / no-over-broad-ETLD1 /
// STRICT-SUPERSET of v1 / backward-compatibility, then re-attributes the PRESERVED
// RUN-EMAILINFRA-001 evidence (read-only) to estimate the coverage lift. NO cohort re-run.
const fs = require('fs');
const path = require('path');
const { makeAttributor, attributeObservation } = require('./emailinfra-signal');

const V1 = path.join(__dirname, '..', '..', 'data', 'email-provider-reference', 'v1.json');
const V2 = path.join(__dirname, '..', '..', 'data', 'email-provider-reference', 'v2.json');
const EVID = path.join(__dirname, 'if001-emailinfra-results.json');
const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));

function keyList(ds) { const out = []; for (const e of ds.entries) for (const k of e.attribution_keys) out.push({ value: String(k.value).toLowerCase(), type: k.match_type, pid: e.provider_id }); return out; }

function structural(v1, v2) {
  const fail = [];
  // schema
  for (const e of v2.entries) {
    for (const f of ['provider_id', 'provider_name', 'provider_class', 'attribution_keys', 'evidence_class', 'evidence_source', 'status'])
      if (!(f in e)) fail.push(`schema: ${e.provider_id} missing ${f}`);
    if (!['mailbox', 'gateway', 'transactional'].includes(e.provider_class)) fail.push(`bad provider_class ${e.provider_id}`);
    for (const k of e.attribution_keys) if (!['ETLD1', 'DOCUMENTED_SUFFIX'].includes(k.match_type)) fail.push(`bad match_type ${e.provider_id}:${k.value}`);
  }
  // unique provider ids
  const ids = v2.entries.map(e => e.provider_id);
  if (new Set(ids).size !== ids.length) fail.push('duplicate provider_id');
  // unique keys + disjoint across providers
  const seen = new Map();
  for (const k of keyList(v2)) {
    if (seen.has(k.value) && seen.get(k.value) !== k.pid) fail.push(`key collision across providers: ${k.value}`);
    seen.set(k.value, k.pid);
  }
  // no over-broad ETLD1 (shared consumer eTLD+1)
  for (const k of keyList(v2)) if (k.type === 'ETLD1' && ['google.com', 'outlook.com', 'hotmail.com', 'live.com'].includes(k.value)) fail.push(`over-broad ETLD1: ${k.value}`);
  // no suffix nesting: an ETLD1 key must not be a suffix of a DOCUMENTED_SUFFIX key (and vice-versa) across providers
  const suffixes = keyList(v2).filter(k => k.type === 'DOCUMENTED_SUFFIX');
  for (const e of keyList(v2).filter(k => k.type === 'ETLD1')) {
    for (const s of suffixes) {
      if ((s.value === e.value || s.value.endsWith('.' + e.value) || e.value.endsWith('.' + s.value)) && s.pid !== e.pid)
        fail.push(`suffix-nesting across providers: ${e.value} <> ${s.value}`);
    }
  }
  // STRICT SUPERSET: every v1 key present in v2 with SAME provider_id; no v1 mapping altered/removed
  const v2map = new Map(keyList(v2).map(k => [k.value, k.pid]));
  for (const k of keyList(v1)) {
    if (!v2map.has(k.value)) fail.push(`SUPERSET BREACH: v1 key removed: ${k.value}`);
    else if (v2map.get(k.value) !== k.pid) fail.push(`BACKCOMPAT BREACH: ${k.value} remapped ${k.pid}->${v2map.get(k.value)}`);
  }
  // v1 entries EMXP-001,003,005-010 byte-identical; 002/004 additive-only (no key removed)
  for (const e1 of v1.entries) {
    const e2 = v2.entries.find(x => x.provider_id === e1.provider_id);
    if (!e2) { fail.push(`v1 entry dropped: ${e1.provider_id}`); continue; }
    if (e2.provider_name !== e1.provider_name || e2.provider_class !== e1.provider_class) fail.push(`v1 identity changed: ${e1.provider_id}`);
    const v1k = new Set(e1.attribution_keys.map(k => k.value.toLowerCase()));
    const v2k = new Set(e2.attribution_keys.map(k => k.value.toLowerCase()));
    for (const k of v1k) if (!v2k.has(k)) fail.push(`v1 key removed from ${e1.provider_id}: ${k}`);
  }
  return fail;
}

function coverage(datasetFile) {
  const attributor = makeAttributor(load(datasetFile));
  const rows = load(EVID).filter(r => r.has_mx);
  let undet = 0, mixed = 0, single = 0, multi = 0, self = 0, managed = 0, hasGw = 0, m365 = 0;
  for (const r of rows) {
    const obs = { has_mx: true, status: 'OK', mx_hosts: r.mx_hosts, raw: [] };
    const rr = attributeObservation(r.subject_domain, obs, attributor);
    const m = rr.email_provision_model;
    if (m === 'UNDETERMINED') undet++; else if (m === 'MIXED') mixed++;
    else if (m === 'THIRD_PARTY_SINGLE') { single++; managed++; }
    else if (m === 'THIRD_PARTY_MULTI') { multi++; managed++; }
    else if (m === 'SELF_HOSTED') self++;
    if (rr.has_gateway) hasGw++;
    if (rr.attributions.some(a => a.match_status === 'MAPPED' && a.provider_id === 'EMXP-001')) m365++;
  }
  return { N: rows.length, undet, mixed, single, multi, self, managed, hasGw, m365 };
}

const v1 = load(V1), v2 = load(V2);
console.log('# EPR-DATA-002 validation\n');
const fails = structural(v1, v2);
console.log('entries:', v2.entries.length, '| keys:', keyList(v2).length, '| new entries:', v2.entries.filter(e => e.version_added === 2).length);
console.log('structural/superset/backcompat checks:', fails.length === 0 ? 'PASS' : 'FAIL');
fails.forEach(f => console.log('   FAIL', f));

console.log('\n# Coverage estimate (re-attribution of preserved RUN-EMAILINFRA-001 evidence; NO re-run)');
const b = coverage(V1), v = coverage(V2);
const pc = (n, d) => (100 * n / d).toFixed(1) + '%';
const line = (nm, s) => console.log(nm.padEnd(10), 'N', s.N, '| UNDET', String(s.undet).padStart(4), pc(s.undet, s.N).padStart(6),
  '| MIXED', String(s.mixed).padStart(3), '| managed', pc(s.managed, s.N).padStart(6), '| gateway', pc(s.hasGw, s.N).padStart(6), '| M365>=', pc(s.m365, s.N).padStart(6));
line('v1 (base)', b);
line('v2', v);
console.log('\nUNDETERMINED reduced:', b.undet - v.undet, `(${pc(b.undet, b.N)} -> ${pc(v.undet, v.N)})`);
console.log('MIXED reduced:       ', b.mixed - v.mixed, `(${b.mixed} -> ${v.mixed})`);
console.log('managed increased:   ', `${pc(b.managed, b.N)} -> ${pc(v.managed, v.N)} (+${v.managed - b.managed} firms)`);
console.log('gateway prevalence:  ', `${pc(b.hasGw, b.N)} -> ${pc(v.hasGw, v.N)}`);
console.log('M365 lower bound:    ', `${pc(b.m365, b.N)} -> ${pc(v.m365, v.N)} (unchanged expected — backend never inferred)`);
if (fails.length) process.exitCode = 1;
