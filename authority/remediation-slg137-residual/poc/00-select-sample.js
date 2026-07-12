'use strict';
// POC — select a stratified 25-org sample from the 734 REVIEW_REQUIRED cohort.

const fs = require('fs');
const path = require('path');

const IN = path.join(__dirname, '../rr-enriched.ndjson');
const OUT = path.join(__dirname, '01-sample.ndjson');

function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const picked = [];
  const pickedDomains = new Set();

  function take(pred, n) {
    let count = 0;
    for (const r of rows) {
      if (count >= n) break;
      if (pickedDomains.has(r.stored_domain)) continue;
      if (pred(r)) { picked.push(r); pickedDomains.add(r.stored_domain); count++; }
    }
  }

  // Both known-redirect (Group C) cases — good pipeline sanity check.
  take(r => r.group === 'C', 2);
  // NXDOMAIN, mix of regulators/status.
  take(r => r.dns_status === 'NXDOMAIN' && r.regulators.includes('FCA'), 3);
  take(r => r.dns_status === 'NXDOMAIN' && r.regulators.includes('SRA') && /revoked|ceased|intervention/.test(r.organisation_status), 3);
  take(r => r.dns_status === 'NXDOMAIN' && r.regulators.includes('SRA'), 3);
  // RESOLVES (registered, unreachable on 80/443 — parking/firewall candidates).
  take(r => r.dns_status === 'RESOLVES' && r.regulators.includes('FCA'), 3);
  take(r => r.dns_status === 'RESOLVES' && r.regulators.includes('SRA'), 4);
  // DNS_ERROR (SERVFAIL).
  take(r => r.dns_status === 'DNS_ERROR', 3);
  // HE institution — different org type/size for contrast.
  take(r => r.regulators.includes('HE'), 1);
  // Fill to 25 with anything unpicked, prioritising status diversity.
  take(() => true, 25 - picked.length);

  fs.writeFileSync(OUT, picked.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('selected', picked.length);
  for (const r of picked) console.log(` - ${r.organisation_name} | ${r.stored_domain} | dns=${r.dns_status} group=${r.group} regs=${r.regulators.join(',')} status=${r.organisation_status}`);
}

main();
