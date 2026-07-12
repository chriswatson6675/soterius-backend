'use strict';
// Stage 3 — Group C (40 domains): http_probe alive, https ended in
// REDIRECT_UNRESOLVED (>10 hops in the production collector, MAX_REDIRECTS=10).
// Re-probe live, following up to 20 hops, recording every hop's host so we
// can see the actual destination (or confirm a genuine loop).

const fs   = require('fs');
const path = require('path');
const https = require('node:https');

const IN  = path.join(__dirname, '01-groups.ndjson');
const OUT = path.join(__dirname, '03-redirect-chain.ndjson');
const MAX_HOPS = 20;

function fetchOnce(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ error: 'BAD_URL' }); return; }
    const req = https.request({
      hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: 'GET',
      rejectUnauthorized: false, timeout: 10000,
      headers: { 'User-Agent': 'Soterius-RepoAuthority-Investigation/1.0' },
    }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || null }); });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}

async function traceChain(domain) {
  const chain = [];
  let url = `https://${domain}/`;
  const seen = new Set();
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (seen.has(url)) { chain.push({ url, note: 'LOOP_DETECTED' }); return { chain, outcome: 'LOOP' }; }
    seen.add(url);
    const r = await fetchOnce(url);
    if (r.error) { chain.push({ url, error: r.error }); return { chain, outcome: 'ERROR' }; }
    chain.push({ url, status: r.status, location: r.location });
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, url).toString();
      continue;
    }
    return { chain, outcome: r.status < 400 ? 'RESOLVED' : 'HTTP_ERROR_TERMINAL' };
  }
  return { chain, outcome: 'MAX_HOPS_EXCEEDED' };
}

async function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.group === 'C');
  console.log('group C:', rows.length);
  const out = fs.createWriteStream(OUT);
  let i = 0;
  for (const r of rows) {
    i++;
    const trace = await traceChain(r.domain);
    const finalHop = trace.chain[trace.chain.length - 1];
    const finalHost = finalHop && finalHop.url ? new URL(finalHop.url).hostname : null;
    out.write(JSON.stringify({ ...r, trace_outcome: trace.outcome, final_host: finalHost, chain: trace.chain }) + '\n');
    console.log(`  [${i}/${rows.length}] ${r.domain} -> ${trace.outcome} final_host=${finalHost}`);
  }
  out.end();
}

main();
