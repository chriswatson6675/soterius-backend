'use strict';
// Stage 2 — Groups A & B (http_probe alive, https dead). Port 80 answered, so
// DNS resolves and the org's own server is live; port 443 either refused
// (A) or hung (B). Before calling B a settled GENUINE_NO_PUBLIC_HTTPS, give
// it a second live probe with a much longer timeout (30s vs the collector's
// 10s budget) to separate "genuinely no HTTPS service" from "collector
// timeout budget too short" (which would be a residual COLLECTOR_LIMITATION,
// not a Repository Authority defect).

const fs   = require('fs');
const path = require('path');
const https = require('node:https');

const IN  = path.join(__dirname, '01-groups.ndjson');
const OUT = path.join(__dirname, '02-http-alive-classified.ndjson');

function probeHttps443(domain, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: domain, port: 443, path: '/', method: 'GET',
      rejectUnauthorized: false, timeout: timeoutMs,
      headers: { 'User-Agent': 'Soterius-RepoAuthority-Investigation/1.0' },
    }, (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'TIMEOUT_30S' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
    req.end();
  });
}

async function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const A = rows.filter(r => r.group === 'A');
  const B = rows.filter(r => r.group === 'B');
  console.log('A (443 refused):', A.length, 'B (443 timeout):', B.length);

  const out = fs.createWriteStream(OUT);
  let bRecovered = 0;

  for (const r of A) {
    out.write(JSON.stringify({
      ...r,
      primary_cause: 'GENUINE_NO_PUBLIC_HTTPS',
      confidence: 'HIGH',
      evidence: `port 80 served a response (http_probe_state=RESPONSE_OBSERVED); port 443 connection refused/no listener (endpoint_state=CONNECTION_ERROR) in the SLG-137 v2 collector run (2026-07-10) — domain resolves and is live, it simply has no HTTPS service`,
      recommended_action: 'KEEP',
    }) + '\n');
  }

  // B: re-probe live with a 30s budget (3x the production collector's 10s).
  let i = 0;
  for (const r of B) {
    i++;
    const res = await probeHttps443(r.domain, 30000);
    if (res.ok) {
      bRecovered++;
      out.write(JSON.stringify({
        ...r,
        primary_cause: 'COLLECTOR_LIMITATION',
        confidence: 'HIGH',
        evidence: `443 answered (HTTP ${res.status}) under a 30s probe after timing out at the collector's 10s budget — the domain and org are fine; this is a slow-TLS-handshake host the production 10s timeout can't reach, not a Repository Authority defect`,
        recommended_action: 'KEEP',
      }) + '\n');
    } else {
      out.write(JSON.stringify({
        ...r,
        primary_cause: 'GENUINE_NO_PUBLIC_HTTPS',
        confidence: 'MEDIUM',
        evidence: `port 80 served a response; port 443 still unreachable (${res.reason}) even under an extended 30s probe — domain live, no usable HTTPS service`,
        recommended_action: 'KEEP',
      }) + '\n');
    }
    if (i % 10 === 0) console.log(`  B probed ${i}/${B.length}`);
  }
  out.end(() => {
    console.log('A classified GENUINE_NO_PUBLIC_HTTPS (HIGH):', A.length);
    console.log('B recovered under 30s probe -> COLLECTOR_LIMITATION:', bRecovered);
    console.log('B still dead at 30s -> GENUINE_NO_PUBLIC_HTTPS (MEDIUM):', B.length - bRecovered);
  });
}

main();
