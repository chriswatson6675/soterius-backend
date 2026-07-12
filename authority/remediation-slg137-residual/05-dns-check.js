'use strict';
// Stage 5 — Groups D & E (773 domains): both HTTP and HTTPS were dead in the
// SLG-137 v2 run. Live DNS resolution splits this into:
//   NXDOMAIN        — the domain no longer exists at all (registry has no record)
//   RESOLVES        — the domain exists (has A/AAAA/CNAME) but nothing answers
//                      on 80/443 (server down / firewalled / never hosted)
//   DNS_ERROR       — SERVFAIL/timeout/other — inconclusive, needs retry/review

const fs  = require('fs');
const path = require('path');
const dns = require('node:dns').promises;

const IN  = path.join(__dirname, '01-groups.ndjson');
const OUT = path.join(__dirname, '05-dns-results.ndjson');
const CONCURRENCY = 40;

async function checkDomain(domain) {
  try {
    const addrs = await dns.resolve4(domain);
    return { dns_status: 'RESOLVES', record_type: 'A', addresses: addrs };
  } catch (e4) {
    if (e4.code !== 'ENOTFOUND' && e4.code !== 'ENODATA') {
      // transient DNS-level error on A lookup; still try others before giving up
    }
    try {
      const addrs = await dns.resolve6(domain);
      return { dns_status: 'RESOLVES', record_type: 'AAAA', addresses: addrs };
    } catch (e6) {
      try {
        const cname = await dns.resolveCname(domain);
        return { dns_status: 'RESOLVES', record_type: 'CNAME', addresses: cname };
      } catch (ec) {
        const code = ec.code || e4.code || 'UNKNOWN';
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
          return { dns_status: 'NXDOMAIN', record_type: null, addresses: [], code };
        }
        return { dns_status: 'DNS_ERROR', record_type: null, addresses: [], code };
      }
    }
  }
}

async function pool(items, worker, conc) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: conc }, run));
  return results;
}

async function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(r => r.group === 'D' || r.group === 'E');
  console.log('D+E total:', rows.length);

  let done = 0;
  const results = await pool(rows, async (r) => {
    const dnsRes = await checkDomain(r.domain);
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${rows.length}`);
    return { ...r, ...dnsRes };
  }, CONCURRENCY);

  const out = fs.createWriteStream(OUT);
  const summary = {};
  for (const r of results) {
    summary[r.dns_status] = (summary[r.dns_status] || 0) + 1;
    out.write(JSON.stringify(r) + '\n');
  }
  out.end(() => console.log('dns summary:', summary));
}

main();
