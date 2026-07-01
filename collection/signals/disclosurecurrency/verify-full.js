'use strict';
const fs = require('fs');
const path = require('path');
const { detectCurrency } = require('./detect-currency');

function stripHtml(s) {
  if (!s) return s;
  return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const rows = fs.readFileSync(path.join(__dirname, 'out/he-001-full.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// 1. Integrity
const integrity = rows.filter((r) => r.located_state !== 'located' && r.evidence_state != null);

// 2. State counts
const ls = {}; const es = {}; const forms = {}; const rm = {};
for (const r of rows) {
  ls[r.located_state] = (ls[r.located_state] || 0) + 1;
  if (r.evidence_state) es[r.evidence_state] = (es[r.evidence_state] || 0) + 1;
  if (r.currency_form) forms[r.currency_form] = (forms[r.currency_form] || 0) + 1;
  if (r.located_state === 'located') rm[r.retrieval_method] = (rm[r.retrieval_method] || 0) + 1;
}

// 3. Re-derivation over stored raw_content
const located = rows.filter((r) => r.located_state === 'located');
let identical = 0; const mismatches = [];
for (const r of located) {
  const input = r.retrieval_method === 'static' ? stripHtml(r.raw_content) : r.raw_content;
  const d = detectCurrency(input || '');
  if (d.state === r.evidence_state && (d.form || null) === (r.currency_form || null) && (d.rawValue || null) === (r.currency_raw_value || null)) identical++;
  else mismatches.push({ domain: r.domain, stored: [r.evidence_state, r.currency_form, r.currency_raw_value], rederived: [d.state, d.form, d.rawValue] });
}

// 4. raw_content present on located rows (re-derivability precondition)
const locatedMissingContent = located.filter((r) => !r.raw_content).length;

console.log('=== INTEGRITY ===');
console.log('rows:', rows.length, '| violations (non-located with evidence):', integrity.length);

console.log('\n=== STATE DISTRIBUTION ===');
console.log('located_state:', JSON.stringify(ls));
console.log('evidence_state (located only):', JSON.stringify(es));
console.log('currency_form (present rows):', JSON.stringify(forms));
console.log('retrieval_method (located):', JSON.stringify(rm));
console.log('coverage (located/total):', (located.length / rows.length).toFixed(3));

console.log('\n=== RE-DERIVATION ===');
console.log('located rows:', located.length, '| identical:', identical, '| mismatches:', mismatches.length,
  '|', ((identical / located.length) * 100).toFixed(1) + '%');
console.log('located rows missing raw_content:', locatedMissingContent);
if (mismatches.length) console.log('mismatch sample:', JSON.stringify(mismatches.slice(0, 5), null, 2));

console.log('\n=== PRESENT EXAMPLES (first 12) ===');
for (const r of located.filter((r) => r.evidence_state === 'present').slice(0, 12)) {
  console.log('  ' + r.domain.padEnd(20) + (r.currency_form || '').padEnd(13) + '· ' + r.currency_raw_value);
}

console.log('\n=== NOT_LOCATED (' + (ls.not_located || 0) + ') ===');
console.log(rows.filter((r) => r.located_state === 'not_located').map((r) => r.domain).join(', '));
console.log('\n=== AMBIGUOUS (' + (ls.ambiguous || 0) + ') ===');
console.log(rows.filter((r) => r.located_state === 'ambiguous').map((r) => r.domain + (r.policy_url ? ' (' + r.policy_url.replace(/^https?:\/\/(www\.)?/, '') + ')' : '')).join('\n'));
