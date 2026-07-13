'use strict';

const path = require('path');
const fs   = require('fs');
const headersCheck = require('./api/legacy-compat/checks/headers-check');

const DOMAINS = [
  'amphlettslegal.co.uk',
  'setfords.co.uk',
  'howelljoneslaw.co.uk',
  'birdandco.co.uk',
  'psrsolicitors.co.uk',
  'lblaw.co.uk',
  'nelsonmyatt.co.uk',
  'jwhugheslaw.co.uk',
  'boneandpayne.co.uk',
  'livetech.co.uk',
];

const CSV_PATH = path.join(__dirname, 'test-results-headers-QA.csv');
const DIVIDER  = '─'.repeat(72);

// ── helpers ──────────────────────────────────────────────────────────────────

function statusLabel(status) {
  return { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }[status] ?? status.toUpperCase();
}

function escapeCsv(value) {
  const str = String(value ?? '');
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  SecureVault — Headers QA  |  Conwy Solicitors');
  console.log(`  ${new Date().toLocaleString('en-GB')}`);
  console.log(DIVIDER);
  console.log('');

  const rows    = [];
  const missing_tally = {};   // header label → count of domains missing it
  const attention = [];       // domains with any critical missing header

  for (const domain of DOMAINS) {
    process.stdout.write(`  Checking ${domain} ... `);

    let result;
    try {
      result = await headersCheck(domain);
    } catch (err) {
      const msg = err.message ?? String(err);
      console.log(`ERROR — ${msg}`);
      rows.push({ domain, status: 'error', missingCount: '', missingHeaders: msg });
      continue;
    }

    const { status, details } = result;
    const present      = details.present.map(h => h.name);
    const missing      = details.missing.map(h => h.name);
    const missingCount = missing.length;
    const label        = statusLabel(status);

    // Tally missing headers across all domains
    for (const h of missing) {
      missing_tally[h] = (missing_tally[h] ?? 0) + 1;
    }

    if (details.missing.some(h => h.critical)) {
      attention.push(domain);
    }

    // Console output
    const statusColor = status === 'pass' ? '\x1b[32m' : status === 'warn' ? '\x1b[33m' : '\x1b[31m';
    const reset       = '\x1b[0m';
    console.log(`${statusColor}[${label}]${reset}  score ${details.score}  missing: ${missingCount}`);

    if (present.length)  console.log(`    Found   : ${present.join(', ')}`);
    if (missing.length)  console.log(`    Missing : ${missing.join(', ')}`);

    rows.push({ domain, status: label, missingCount, missingHeaders: missing.join('; ') });
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('');
  console.log(DIVIDER);
  console.log('');

  const tested    = rows.length;
  const passCount = rows.filter(r => r.status === 'PASS').length;
  const passRate  = tested > 0 ? ((passCount / tested) * 100).toFixed(0) : 0;

  console.log('  Summary');
  console.log(`  Total tested  : ${tested}`);
  console.log(`  Pass rate     : ${passRate}%  (${passCount}/${tested})`);
  console.log('');

  const sorted = Object.entries(missing_tally).sort((a, b) => b[1] - a[1]);
  if (sorted.length) {
    console.log('  Most common missing headers:');
    for (const [header, count] of sorted) {
      console.log(`    ${String(count).padStart(2)}/${tested}  ${header}`);
    }
    console.log('');
  }

  if (attention.length) {
    console.log('  Domains needing immediate attention (critical headers missing):');
    for (const d of attention) console.log(`    • ${d}`);
  } else {
    console.log('  No domains have critical headers missing.');
  }

  console.log('');

  // ── CSV export ─────────────────────────────────────────────────────────────

  const timestamp = new Date().toISOString();
  const csvLines  = [
    'Domain,Status,Missing_Count,Missing_Headers,Timestamp',
    ...rows.map(r =>
      [
        escapeCsv(r.domain),
        escapeCsv(r.status),
        escapeCsv(r.missingCount),
        escapeCsv(r.missingHeaders),
        escapeCsv(timestamp),
      ].join(',')
    ),
  ];

  fs.writeFileSync(CSV_PATH, csvLines.join('\n'), 'utf8');
  console.log(`  Results saved to: ${CSV_PATH}`);
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
