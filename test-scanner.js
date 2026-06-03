/**
 * test-scanner.js — compares scan results across domains to confirm
 * the scanner is returning real per-domain data, not cached/hardcoded results.
 *
 * Usage:  node test-scanner.js
 * Requires: backend running on localhost:3001  (npm run dev)
 */

const http = require('http');

const DOMAINS = [
  'github.com',          // Well-secured: expect mostly PASS
  'example.com',         // Minimal site: expect mixed results
  'boneandpayne.co.uk',  // SME site: expect mostly FAIL/WARN
];

function post(domain) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ domain });
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/scan',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function summarise(result) {
  if (!result.success) return { error: result.error };
  const r = result.results || {};
  return {
    score:   result.overallScore,
    ssl:     r.ssl?.status,
    headers: r.headers?.status,
    dns:     r.dns?.status,
    ports:   r.ports?.status,
    tech:    r.tech?.status,
    gdpr:    r.gdpr?.status,
    totalIssues: Object.values(r).reduce((s, m) => s + (m.issues?.length || 0), 0),
    headerScore: r.headers?.details?.score,
    spf:     r.dns?.details?.spf?.found,
    dkim:    r.dns?.details?.dkim?.found,
    dmarc:   r.dns?.details?.dmarc?.found,
    privacyPolicy: r.gdpr?.details?.privacyPolicy,
    cookieConsent: r.gdpr?.details?.cookieConsent,
    trackers: r.gdpr?.details?.trackers,
    techDetected: r.tech?.details?.detected?.map(t => t.name),
  };
}

function allIdentical(summaries) {
  const keys = ['headers', 'dns', 'ssl', 'ports', 'tech', 'gdpr', 'headerScore', 'spf', 'dkim', 'dmarc'];
  for (const key of keys) {
    const vals = summaries.map(s => JSON.stringify(s[key]));
    if (new Set(vals).size > 1) return false;
  }
  return true;
}

async function run() {
  console.log('SecureVault Scanner — Cross-Domain Comparison Test');
  console.log('═'.repeat(60));
  console.log('Backend: http://localhost:3001');
  console.log('Domains:', DOMAINS.join(', '));
  console.log('═'.repeat(60));

  const summaries = [];

  for (const domain of DOMAINS) {
    process.stdout.write(`\nScanning ${domain} ... `);
    const start = Date.now();
    try {
      const result = await post(domain);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const s = summarise(result);
      summaries.push(s);
      console.log(`done (${elapsed}s)`);

      console.log(`  Score:   ${s.score ?? 'n/a'}/100`);
      console.log(`  SSL:     ${s.ssl}  | Headers: ${s.headers} (${s.headerScore})  | DNS: ${s.dns}`);
      console.log(`  SPF: ${s.spf}  DKIM: ${s.dkim}  DMARC: ${s.dmarc}`);
      console.log(`  Tech:    ${(s.techDetected || []).slice(0, 4).join(', ') || 'none detected'}`);
      console.log(`  GDPR:    ${s.gdpr}  | Privacy policy: ${s.privacyPolicy}  | Cookie consent: ${s.cookieConsent}`);
      console.log(`  Issues:  ${s.totalIssues}`);
    } catch (err) {
      summaries.push({ error: err.message });
      console.log(`ERROR — ${err.message}`);
      console.log('  (Is the backend running? cd backend && npm run dev)');
    }
  }

  const validSummaries = summaries.filter(s => !s.error);
  if (validSummaries.length < 2) {
    console.log('\n⚠  Not enough successful scans to compare.');
    return;
  }

  console.log('\n' + '═'.repeat(60));
  if (allIdentical(validSummaries)) {
    console.log('🔴 VERDICT: Results are IDENTICAL across domains.');
    console.log('   This suggests a caching or hardcoded-data bug.');
    console.log('   Check routes/scan.js for in-memory caching.');
  } else {
    console.log('✅ VERDICT: Results DIFFER across domains — scanners are working correctly.');
    console.log('   If different SME sites show similar issues, that is expected:');
    console.log('   small business sites genuinely share the same poor security posture.');
  }

  // Highlight specific differences
  const keys = ['headers', 'dns', 'ssl', 'ports', 'tech', 'gdpr', 'spf', 'dmarc'];
  console.log('\nKey differences:');
  for (const key of keys) {
    const vals = validSummaries.map((s, i) => `${DOMAINS[i]}: ${s[key]}`);
    const unique = new Set(vals.map(v => v.split(': ')[1]));
    const prefix = unique.size === 1 ? '  same   ' : '  DIFFER ';
    console.log(`${prefix} ${key.padEnd(10)} → ${vals.join('  |  ')}`);
  }
}

run().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
