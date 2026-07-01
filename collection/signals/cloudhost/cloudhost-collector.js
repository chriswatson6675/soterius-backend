'use strict';
// SOT-CLOUDHOST-001 §4 — Layer A (Observation) collector (cloud/hosting).
// Resolves the subject domain's primary endpoint A/AAAA set; enriches each IP to its AS number
// via the pinned IP→ASN source (Team Cymru DNS-TXT). Raw IPs + AS numbers preserved verbatim.
// In-model transports only (DNS + DNS-TXT). No certificate read, no port scan, no geolocation-as-id.
const dns = require('dns').promises;
const { lookupAsn, SOURCE } = require('./asn-enrichment');

const DEFAULT = { retries: 2, baseDelayMs: 150, timeoutMs: 5000 };
function classify(err) { const c = err && err.code ? err.code : ''; if (c === 'ETIMEDOUT' || c === 'ETIME') return 'DNS_TIMEOUT'; if (c === 'ENOTFOUND' || c === 'ENODATA' || c === 'NXDOMAIN') return 'ABSENT'; return 'DNS_FAILURE'; }
async function withTimeout(p, ms) { let t; const to = new Promise((_, r) => { t = setTimeout(() => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; r(e); }, ms); }); try { return await Promise.race([p, to]); } finally { clearTimeout(t); } }
async function withRetry(fn, opts = DEFAULT) { let last; for (let i = 0; i <= opts.retries; i++) { try { return await withTimeout(fn(), opts.timeoutMs); } catch (e) { last = e; if (classify(e) === 'ABSENT') throw e; if (i < opts.retries) await new Promise(r => setTimeout(r, opts.baseDelayMs * Math.pow(2, i))); } } throw last; }

async function resolveSet(domain, fn, opts) { try { const a = await withRetry(() => fn(domain), opts); return Array.isArray(a) ? a : []; } catch { return []; } }

// Collect resolved IPs + per-IP ASN. Returns { has_endpoint, resolved_ips:[{ip,version,asn,asns,bgp_prefix,cc,rir,asn_status}], status, ip_to_asn_source }
async function collect(domain, opts = DEFAULT) {
  const v4 = await resolveSet(domain, d => dns.resolve4(d), opts);
  const v6 = await resolveSet(domain, d => dns.resolve6(d), opts);
  const ips = [...v4.map(ip => ({ ip, version: 4 })), ...v6.map(ip => ({ ip, version: 6 }))];
  if (ips.length === 0) return { has_endpoint: false, resolved_ips: [], status: 'NO_ENDPOINT', ip_to_asn_source: SOURCE };
  const resolved_ips = [];
  for (const { ip, version } of ips) {
    const a = await lookupAsn(ip, undefined, opts);
    resolved_ips.push({ ip, version, asn: a.asn, asns: a.asns, multi_origin: a.multi_origin, bgp_prefix: a.bgp_prefix, cc: a.cc, rir: a.rir, asn_status: a.status });
  }
  return { has_endpoint: true, resolved_ips, status: 'OK', ip_to_asn_source: SOURCE };
}

module.exports = { collect, ipToAsnSource: SOURCE };
