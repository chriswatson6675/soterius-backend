'use strict';

// SOT-SECURITYTXT-001 — HE-001 Post-Collection Investigation
//
// Queries the stored cohort evidence in signal_securitytxt_v1.
// Three investigations:
//   A — HTML masquerading analysis
//   B — INDETERMINATE root cause analysis
//   C — Adoption intelligence
//
// Diagnostic only — no writes, no signal changes.
//
// Usage:
//   node backend/signal-lab/signals/securitytxt/investigate-he-001.js

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');

// ── Supabase ──────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const HR  = '═'.repeat(72);
const DIV = '─'.repeat(72);

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function truncate(s, max) {
  if (!s) return '(null)';
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function mimeCategory(contentType) {
  if (!contentType) return 'null';
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/plain'))          return 'text/plain';
  if (ct.startsWith('text/html'))           return 'text/html';
  if (ct.startsWith('application/json'))    return 'application/json';
  if (ct.startsWith('text/'))               return 'text/other';
  if (ct.startsWith('application/'))        return 'application/other';
  return 'other';
}

// ── Fetch latest run_id ───────────────────────────────────────────────────────

async function getLatestRunId(supabase) {
  const { data, error } = await supabase
    .from('signal_securitytxt_v1')
    .select('run_id, collected_at')
    .order('collected_at', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Cannot fetch run_id: ${error.message}`);
  if (!data?.length) throw new Error('No rows found in signal_securitytxt_v1');
  return data[0].run_id;
}

// ── Fetch all rows for a run ──────────────────────────────────────────────────

async function fetchRun(supabase, runId) {
  const { data, error } = await supabase
    .from('signal_securitytxt_v1')
    .select('domain, file_state, collected_at, canonical_fetch, legacy_fetch, canonical_parse, legacy_parse')
    .eq('run_id', runId)
    .order('domain', { ascending: true });

  if (error) throw new Error(`Cannot fetch run data: ${error.message}`);
  return data ?? [];
}

// ── INVESTIGATION A — HTML masquerading ───────────────────────────────────────

function investigateA(rows) {
  console.log(`\n${HR}`);
  console.log(' INVESTIGATION A — HTML MASQUERADING ANALYSIS');
  console.log(HR);

  const present = rows.filter(r =>
    ['PRESENT_CANONICAL', 'PRESENT_LEGACY_ONLY', 'PRESENT_BOTH'].includes(r.file_state),
  );

  console.log(`\n  PRESENT_* rows: ${present.length} (of ${rows.length} total)\n`);

  // Content type classification
  const byMime     = {};
  const byDomain   = [];

  for (const row of present) {
    // Preferred parse source for content analysis
    const parse = row.canonical_parse ?? row.legacy_parse;

    // Content type from the fetch that produced the parse (canonical preferred)
    const activeFetch = row.canonical_parse
      ? row.canonical_fetch
      : row.legacy_fetch;

    const contentType = activeFetch?.content_type ?? null;
    const mime        = mimeCategory(contentType);
    byMime[mime]      = (byMime[mime] ?? 0) + 1;

    const unkCount    = parse?.unknown_field_count ?? 0;
    const dirCount    = parse?.directive_count     ?? 0;
    const malCount    = parse?.malformed_line_count ?? 0;
    const rawBytes    = activeFetch?.raw_content_bytes ?? null;

    // HTML signal: high unknown count, or content_type is text/html
    const htmlSignal  =
      mime === 'text/html' ||
      (mime !== 'text/plain' && unkCount > 20) ||
      (unkCount > 50);

    byDomain.push({
      domain:      row.domain,
      file_state:  row.file_state,
      content_type: contentType,
      mime,
      dir_count:   dirCount,
      unk_count:   unkCount,
      mal_count:   malCount,
      raw_bytes:   rawBytes,
      html_signal: htmlSignal,
      parse,
      active_fetch: activeFetch,
    });
  }

  // 1. MIME type distribution
  console.log(`${DIV}`);
  console.log('\n A1. CONTENT-TYPE DISTRIBUTION  (PRESENT_* rows)\n');
  for (const [mime, count] of Object.entries(byMime).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${mime.padEnd(28)}: ${String(count).padStart(3)}   ${pct(count, present.length)}`);
  }

  // 2. HTML signal candidates
  const htmlCandidates = byDomain.filter(d => d.html_signal);
  const genuineAdopters = byDomain.filter(d => !d.html_signal);

  console.log(`\n${DIV}`);
  console.log('\n A2. HTML MASQUERADING CANDIDATES\n');
  console.log(`    HTML signal threshold : unknown_field_count > 50 OR content_type = text/html\n`);

  if (htmlCandidates.length === 0) {
    console.log('    None detected.\n');
  } else {
    console.log(`    ${String(htmlCandidates.length).padStart(2)} candidate(s):\n`);
    for (const d of htmlCandidates.sort((a, b) => b.unk_count - a.unk_count)) {
      console.log(`    ${d.domain}`);
      console.log(`      file_state    : ${d.file_state}`);
      console.log(`      content_type  : ${d.content_type ?? '(null)'}`);
      console.log(`      raw_bytes     : ${d.raw_bytes ?? '(null)'}`);
      console.log(`      dir_count     : ${d.dir_count}`);
      console.log(`      unk_count     : ${d.unk_count}`);
      console.log(`      mal_count     : ${d.mal_count}`);

      // Show redirect chain if any
      const chain = d.active_fetch?.redirect_chain ?? [];
      if (chain.length > 0) {
        console.log(`      redirect_chain: ${chain.length} hop(s) — first: ${chain[0]?.url ?? '?'} [${chain[0]?.status}]`);
      } else {
        console.log(`      redirect_chain: (none)`);
      }

      // Show top-5 unknown field names
      const unks = d.parse?.unknown_fields ?? [];
      if (unks.length > 0) {
        const sample = unks.slice(0, 5).map(u => u.field_name_raw).join(', ');
        const more   = unks.length > 5 ? ` +${unks.length - 5} more` : '';
        console.log(`      top unknown fields: ${sample}${more}`);
      }

      // Show first 120 chars of raw_content
      const raw = d.active_fetch?.raw_content;
      if (raw) {
        console.log(`      raw_content[:120]: ${truncate(raw, 120)}`);
      }
      console.log();
    }
  }

  // 3. Genuine adopters
  console.log(`${DIV}`);
  console.log(`\n A3. APPARENT GENUINE SECURITY.TXT ADOPTERS\n`);
  console.log(`    Remaining after HTML candidate removal: ${genuineAdopters.length}\n`);
  for (const d of genuineAdopters) {
    const cs = d.parse?.content_state ?? '?';
    console.log(`    ${d.domain.padEnd(40)} ${d.file_state.padEnd(22)} [${cs}]  dirs=${d.dir_count}  unk=${d.unk_count}`);
  }

  // 4. Adoption metric comparison
  console.log(`\n${DIV}`);
  console.log('\n A4. ADJUSTED ADOPTION METRICS\n');
  console.log(`    Raw adoption  (PRESENT_* / total)           : ${String(present.length).padStart(3)} / ${rows.length}   ${pct(present.length, rows.length)}`);
  console.log(`    HTML-adjusted (genuine / total)             : ${String(genuineAdopters.length).padStart(3)} / ${rows.length}   ${pct(genuineAdopters.length, rows.length)}`);
  console.log(`    HTML candidates removed                      : ${String(htmlCandidates.length).padStart(3)}`);
  console.log(`    Basis: unknown_field_count > 50 OR content_type != text/plain`);

  return { present, htmlCandidates, genuineAdopters, byDomain };
}

// ── INVESTIGATION B — INDETERMINATE root cause ────────────────────────────────

function investigateB(rows) {
  console.log(`\n\n${HR}`);
  console.log(' INVESTIGATION B — INDETERMINATE ROOT CAUSE ANALYSIS');
  console.log(HR);

  const indet = rows.filter(r => r.file_state === 'INDETERMINATE');
  console.log(`\n  INDETERMINATE rows: ${indet.length} (${pct(indet.length, rows.length).trim()} of cohort)\n`);

  // Classify the fetch errors for each indeterminate row
  const errorProfiles = [];

  for (const row of indet) {
    const cf = row.canonical_fetch;
    const lf = row.legacy_fetch;

    const cState = cf?.fetch_state ?? 'null';
    const lState = lf?.fetch_state ?? 'null';
    const cStatus = cf?.http_status ?? null;
    const lStatus = lf?.http_status ?? null;
    const cRedirects = (cf?.redirect_chain ?? []).length;
    const lRedirects = (lf?.redirect_chain ?? []).length;

    // Determine which fetch(es) triggered INDETERMINATE
    const blocking = new Set();
    for (const state of [cState, lState]) {
      if (['CONNECTION_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(state)) {
        blocking.add(state);
      }
    }

    errorProfiles.push({
      domain:       row.domain,
      canonical_state: cState,
      legacy_state:    lState,
      canonical_status: cStatus,
      legacy_status:    lStatus,
      canonical_redirects: cRedirects,
      legacy_redirects:    lRedirects,
      blocking_states:     [...blocking].sort().join('+'),
    });
  }

  // Error state distribution
  const byCombination = {};
  for (const p of errorProfiles) {
    const key = `can:${p.canonical_state}  leg:${p.legacy_state}`;
    byCombination[key] = (byCombination[key] ?? 0) + 1;
  }

  const byBlockingType = {};
  for (const p of errorProfiles) {
    byBlockingType[p.blocking_states] = (byBlockingType[p.blocking_states] ?? 0) + 1;
  }

  console.log(`${DIV}`);
  console.log('\n B1. FETCH STATE COMBINATION DISTRIBUTION\n');
  for (const [combo, count] of Object.entries(byCombination).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${combo.padEnd(44)}: ${String(count).padStart(3)}`);
  }

  console.log(`\n${DIV}`);
  console.log('\n B2. BLOCKING STATE TYPE DISTRIBUTION\n');
  for (const [type, count] of Object.entries(byBlockingType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(36)}: ${String(count).padStart(3)}   ${pct(count, indet.length)}`);
  }

  // Both-paths-same-error analysis (suggests domain-level block, not path-level)
  const bothSameError = errorProfiles.filter(p =>
    p.canonical_state === p.legacy_state &&
    ['CONNECTION_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(p.canonical_state),
  );
  const onlyOnePath = errorProfiles.filter(p => p.canonical_state !== p.legacy_state);

  console.log(`\n${DIV}`);
  console.log('\n B3. SYMMETRIC vs ASYMMETRIC FAILURES\n');
  console.log(`    Both paths same blocking state : ${String(bothSameError.length).padStart(3)}   ${pct(bothSameError.length, indet.length)}`);
  console.log(`      (consistent with domain-level block: WAF, CDN, DNS, TLS)`);
  console.log(`    Different states on each path  : ${String(onlyOnePath.length).padStart(3)}   ${pct(onlyOnePath.length, indet.length)}`);
  console.log(`      (consistent with path-specific routing or server-side rules)`);

  // SERVER_ERROR detail — these carry http_status
  const serverErrors = errorProfiles.filter(p =>
    p.canonical_state === 'SERVER_ERROR' || p.legacy_state === 'SERVER_ERROR',
  );

  if (serverErrors.length > 0) {
    console.log(`\n${DIV}`);
    console.log('\n B4. SERVER_ERROR DETAIL  (HTTP status available)\n');
    for (const p of serverErrors) {
      const cDetail = p.canonical_state === 'SERVER_ERROR' ? `${p.canonical_status}` : '-';
      const lDetail = p.legacy_state    === 'SERVER_ERROR' ? `${p.legacy_status}`    : '-';
      console.log(`    ${p.domain.padEnd(40)} canonical:${cDetail.padEnd(6)} legacy:${lDetail}`);
    }
  }

  // Full per-domain listing
  console.log(`\n${DIV}`);
  console.log('\n B5. PER-DOMAIN EVIDENCE\n');
  console.log(`    ${'Domain'.padEnd(40)} ${'Canonical'.padEnd(20)} ${'Legacy'.padEnd(20)}`);
  console.log(`    ${'─'.repeat(40)} ${'─'.repeat(20)} ${'─'.repeat(20)}`);
  for (const p of errorProfiles) {
    const cCol = p.canonical_status
      ? `${p.canonical_state}(${p.canonical_status})`
      : p.canonical_state;
    const lCol = p.legacy_status
      ? `${p.legacy_state}(${p.legacy_status})`
      : p.legacy_state;
    console.log(`    ${p.domain.padEnd(40)} ${cCol.padEnd(20)} ${lCol.padEnd(20)}`);
  }

  // Assessment
  const connCount   = errorProfiles.filter(p => p.blocking_states.includes('CONNECTION_ERROR')).length;
  const timeCount   = errorProfiles.filter(p => p.blocking_states.includes('TIMEOUT')).length;
  const servCount   = errorProfiles.filter(p => p.blocking_states.includes('SERVER_ERROR')).length;
  const bothSymm    = bothSameError.length;

  console.log(`\n${DIV}`);
  console.log('\n B6. ROOT CAUSE ASSESSMENT\n');
  console.log(`    CONNECTION_ERROR involvement : ${connCount}/${indet.length} (${pct(connCount, indet.length).trim()})`);
  console.log(`    TIMEOUT involvement          : ${timeCount}/${indet.length} (${pct(timeCount, indet.length).trim()})`);
  console.log(`    SERVER_ERROR involvement     : ${servCount}/${indet.length} (${pct(servCount, indet.length).trim()})`);
  console.log(`    Both-path symmetric failures : ${bothSymm}/${indet.length} (${pct(bothSymm, indet.length).trim()})`);
  console.log(`\n    Interpretation:`);
  console.log(`    High CONNECTION_ERROR count → likely WAF/CDN block or TLS rejection`);
  console.log(`    High symmetric rate       → domain-level (not path-level) cause`);
  console.log(`    SERVER_ERROR with 5xx     → institutional server handling issue`);
  console.log(`    TIMEOUT                   → slow response or threshold too tight`);

  return { indet, errorProfiles, bothSameError };
}

// ── INVESTIGATION C — Adoption intelligence ───────────────────────────────────

function investigateC(rows, genuineAdopters) {
  console.log(`\n\n${HR}`);
  console.log(' INVESTIGATION C — SECURITY.TXT ADOPTION INTELLIGENCE');
  console.log(HR);

  const n = genuineAdopters.length;
  if (n === 0) {
    console.log('\n  No genuine adopters to analyse.\n');
    return;
  }

  console.log(`\n  Analysing ${n} genuine adopters (HTML candidates excluded)\n`);

  // Collect parse facts for each adopter
  const profiles = [];
  for (const d of genuineAdopters) {
    const parse = d.parse;
    if (!parse) continue;

    profiles.push({
      domain:       d.domain,
      file_state:   d.file_state,
      content_state: parse.content_state,
      directive_count: parse.directive_count,
      total_lines:  parse.total_lines,
      contact:      parse.contact ?? [],
      expires:      parse.expires ?? [],
      encryption:   parse.encryption ?? [],
      acknowledgments: parse.acknowledgments ?? [],
      policy:       parse.policy ?? [],
      preferred_languages: parse.preferred_languages ?? [],
      hiring:       parse.hiring ?? [],
      canonical:    parse.canonical ?? [],
      unknown_fields: parse.unknown_fields ?? [],
      unknown_field_count: parse.unknown_field_count ?? 0,
      malformed_line_count: parse.malformed_line_count ?? 0,
      comment_line_count: parse.comment_line_count ?? 0,
    });
  }

  // 1. Field presence counts
  console.log(`${DIV}`);
  console.log(`\n C1. RFC 9116 FIELD PRESENCE  (${n} genuine adopters)\n`);
  const fieldDefs = [
    ['contact',             'Contact           '],
    ['expires',             'Expires           '],
    ['encryption',          'Encryption        '],
    ['acknowledgments',     'Acknowledgments   '],
    ['policy',              'Policy            '],
    ['preferred_languages', 'Preferred-Languages'],
    ['hiring',              'Hiring            '],
    ['canonical',           'Canonical         '],
  ];
  for (const [key, label] of fieldDefs) {
    const count = profiles.filter(p => p[key].length > 0).length;
    console.log(`    ${label}: ${String(count).padStart(3)} / ${n}   ${pct(count, n)}`);
  }

  // 2. Content state
  console.log(`\n${DIV}`);
  console.log(`\n C2. CONTENT STATE DISTRIBUTION\n`);
  const byCS = {};
  for (const p of profiles) { byCS[p.content_state] = (byCS[p.content_state] ?? 0) + 1; }
  for (const [cs, count] of Object.entries(byCS).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cs.padEnd(16)}: ${String(count).padStart(3)} / ${n}   ${pct(count, n)}`);
  }

  // 3. Unknown fields inventory
  const allUnkNames = {};
  for (const p of profiles) {
    for (const uf of p.unknown_fields) {
      const k = uf.field_name_raw;
      allUnkNames[k] = (allUnkNames[k] ?? 0) + 1;
    }
  }
  if (Object.keys(allUnkNames).length > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n C3. UNKNOWN FIELD NAMES  (vendor extensions)\n`);
    for (const [name, count] of Object.entries(allUnkNames).sort((a, b) => b[1] - a[1])) {
      const domains = profiles
        .filter(p => p.unknown_fields.some(u => u.field_name_raw === name))
        .map(p => p.domain)
        .join(', ');
      console.log(`    ${name.padEnd(28)}: ${count}  [${domains}]`);
    }
  }

  // 4. Contact URI host distribution
  console.log(`\n${DIV}`);
  console.log(`\n C4. CONTACT URI HOST DISTRIBUTION\n`);
  const contactHosts = {};
  for (const p of profiles) {
    for (const cv of p.contact) {
      const v = cv.trim();
      let host = '(other)';
      if (v.startsWith('mailto:')) {
        host = v.slice(7).split('@')[1]?.split('?')[0]?.split('>')[0] ?? '(email-parse-error)';
      } else if (v.startsWith('https://') || v.startsWith('http://')) {
        host = v.replace(/^https?:\/\//, '').split('/')[0];
      }
      contactHosts[host] = (contactHosts[host] ?? 0) + 1;
    }
  }
  for (const [host, count] of Object.entries(contactHosts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${host.padEnd(40)}: ${count}`);
  }

  // 5. Structural field profile — sub-group identification
  console.log(`\n${DIV}`);
  console.log(`\n C5. ADOPTER SUB-GROUP PROFILES  (by field combination)\n`);

  // Classify each adopter into a tier by field coverage
  const tier = (p) => {
    const hasContact    = p.contact.length > 0;
    const hasExpires    = p.expires.length > 0;
    const hasPolicy     = p.policy.length > 0;
    const hasSigned     = p.content_state === 'SIGNED';
    const hasEncryption = p.encryption.length > 0;
    const hasCanonical  = p.canonical.length > 0;

    if (hasSigned && hasEncryption && hasPolicy && hasCanonical) return 'Full RFC 9116 (signed+policy+encryption+canonical)';
    if (hasSigned && hasPolicy) return 'Signed + Policy';
    if (hasSigned)              return 'Signed only';
    if (hasPolicy && hasEncryption) return 'Policy + Encryption (unsigned)';
    if (hasPolicy)              return 'Policy present (unsigned)';
    if (hasContact && hasExpires && hasCanonical) return 'Contact + Expires + Canonical';
    if (hasContact && hasExpires) return 'Contact + Expires';
    if (hasContact)             return 'Contact only';
    return 'Other';
  };

  const tierCounts = {};
  const tierDomains = {};
  for (const p of profiles) {
    const t = tier(p);
    tierCounts[t]  = (tierCounts[t]  ?? 0) + 1;
    tierDomains[t] = (tierDomains[t] ?? []);
    tierDomains[t].push(p.domain);
  }

  for (const [t, count] of Object.entries(tierCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t}`);
    console.log(`      count: ${count}  (${pct(count, n).trim()})`);
    for (const d of tierDomains[t]) console.log(`        • ${d}`);
    console.log();
  }

  // 6. Full evidence per adopter
  console.log(`${DIV}`);
  console.log(`\n C6. FULL EVIDENCE PER GENUINE ADOPTER\n`);
  for (const p of profiles) {
    console.log(`  ── ${p.domain}  [${p.file_state}]  [${p.content_state}] ──`);
    console.log(`     dirs=${p.directive_count}  total_lines=${p.total_lines}  unk=${p.unknown_field_count}  mal=${p.malformed_line_count}`);
    if (p.contact.length)             console.log(`     Contact            : ${p.contact.map(v => v.trim()).join(' | ')}`);
    if (p.expires.length)             console.log(`     Expires            : ${p.expires.map(v => v.trim()).join(' | ')}`);
    if (p.encryption.length)          console.log(`     Encryption         : ${p.encryption.map(v => v.trim()).join(' | ')}`);
    if (p.acknowledgments.length)     console.log(`     Acknowledgments    : ${p.acknowledgments.map(v => v.trim()).join(' | ')}`);
    if (p.policy.length)              console.log(`     Policy             : ${p.policy.map(v => v.trim()).join(' | ')}`);
    if (p.preferred_languages.length) console.log(`     Preferred-Languages: ${p.preferred_languages.map(v => v.trim()).join(' | ')}`);
    if (p.hiring.length)              console.log(`     Hiring             : ${p.hiring.map(v => v.trim()).join(' | ')}`);
    if (p.canonical.length)           console.log(`     Canonical          : ${p.canonical.map(v => v.trim()).join(' | ')}`);
    if (p.unknown_field_count > 0)    console.log(`     Unknown fields     : ${p.unknown_fields.map(u => u.field_name_raw).join(', ')}`);
    if (p.malformed_line_count > 0)   console.log(`     Malformed lines    : ${p.malformed_line_count}`);
    console.log();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${HR}`);
  console.log(' SOT-SECURITYTXT-001 — HE-001 POST-COLLECTION INVESTIGATION');
  console.log(' Diagnostic only — no writes, no signal changes');
  console.log(HR);

  const supabase = getClient();
  const runId    = process.env.RUN_ID ?? await getLatestRunId(supabase);
  const rows     = await fetchRun(supabase, runId);

  console.log(`\n  Run ID       : ${runId}`);
  console.log(`  Total rows   : ${rows.length}`);
  console.log(`  Fetched at   : ${new Date().toISOString()}`);

  if (rows.length === 0) {
    console.log('\n  No data. Exiting.\n');
    process.exit(0);
  }

  // Distribution overview
  const byState = {};
  for (const r of rows) { byState[r.file_state] = (byState[r.file_state] ?? 0) + 1; }
  console.log('\n  File state distribution:');
  for (const [s, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(26)}: ${String(n).padStart(3)}   ${pct(n, rows.length)}`);
  }

  // ── Run investigations ────────────────────────────────────────────────────

  const { genuineAdopters } = investigateA(rows);
  investigateB(rows);
  investigateC(rows, genuineAdopters);

  console.log(`\n${HR}`);
  console.log(' Investigation complete');
  console.log(`${HR}\n`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
