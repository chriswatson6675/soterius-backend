'use strict';

const path = require('path');
const fs   = require('fs');
const dnsCheck = require('./api/legacy-scanner/dns-check');

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

const CSV_PATH = path.join(__dirname, 'test-results-dns-QA.csv');
const DIVIDER  = '─'.repeat(72);

function yesNo(val) { return val ? 'YES' : 'NO'; }

function escapeCsv(value) {
  const str = String(value ?? '');
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

async function main() {
  console.log('');
  console.log('  SecureVault — DNS QA  |  Conwy Solicitors');
  console.log(`  ${new Date().toLocaleString('en-GB')}`);
  console.log(DIVIDER);
  console.log('');

  const rows   = [];
  const totals = { spf: 0, dkim: 0, dmarc: 0, pass: 0 };
  const zeroAuth = [];

  for (const domain of DOMAINS) {
    process.stdout.write(`  Checking ${domain} ... `);

    let result;
    try {
      result = await dnsCheck(domain);
    } catch (err) {
      const msg = err.message ?? String(err);
      console.log(`ERROR — ${msg}`);
      rows.push({ domain, status: 'ERROR', spf: '-', dkim: '-', dmarc: '-', issues: msg });
      continue;
    }

    const { status, details, issues } = result;
    const spf   = details.spf.found;
    const dkim  = details.dkim.found;
    const dmarc = details.dmarc.found;

    if (spf)   totals.spf++;
    if (dkim)  totals.dkim++;
    if (dmarc) totals.dmarc++;
    if (status === 'pass') totals.pass++;
    if (!spf && !dkim && !dmarc) zeroAuth.push(domain);

    const statusColor = status === 'pass' ? '\x1b[32m' : status === 'warn' ? '\x1b[33m' : '\x1b[31m';
    const reset = '\x1b[0m';
    const label = status.toUpperCase().padEnd(4);
    console.log(`${statusColor}[${label}]${reset}  SPF:${yesNo(spf)}  DKIM:${yesNo(dkim)}  DMARC:${yesNo(dmarc)}`);
    if (issues.length) console.log(`    Issues  : ${issues.join(' | ')}`);

    rows.push({
      domain,
      status: status.toUpperCase(),
      spf:    yesNo(spf),
      dkim:   yesNo(dkim),
      dmarc:  yesNo(dmarc),
      issues: issues.join('; '),
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const tested = rows.length;
  const pct    = n => tested > 0 ? `${((n / tested) * 100).toFixed(0)}%` : '0%';

  console.log('');
  console.log(DIVIDER);
  console.log('');
  console.log('  Summary');
  console.log(`  Total tested  : ${tested}`);
  console.log(`  Pass rate     : ${pct(totals.pass)}  (${totals.pass}/${tested})`);
  console.log('');
  console.log(`  SPF present   : ${totals.spf}/${tested}  (${pct(totals.spf)})`);
  console.log(`  DKIM present  : ${totals.dkim}/${tested}  (${pct(totals.dkim)})`);
  console.log(`  DMARC present : ${totals.dmarc}/${tested}  (${pct(totals.dmarc)})`);
  console.log('');

  if (zeroAuth.length) {
    console.log('  Domains with zero email authentication (critical risk):');
    for (const d of zeroAuth) console.log(`    • ${d}`);
  } else {
    console.log('  All domains have at least one email authentication record.');
  }

  console.log('');

  // ── CSV export ─────────────────────────────────────────────────────────────

  const timestamp = new Date().toISOString();
  const csvLines  = [
    'Domain,Status,SPF,DKIM,DMARC,Issues,Timestamp',
    ...rows.map(r =>
      [r.domain, r.status, r.spf, r.dkim, r.dmarc, escapeCsv(r.issues), escapeCsv(timestamp)].join(',')
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
