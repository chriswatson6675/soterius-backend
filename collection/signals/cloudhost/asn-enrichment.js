'use strict';
// SOT-CLOUDHOST-001 §4 / ADR-COL-004 §D.1 — pinned IP→ASN source (Layer-A enrichment).
// Source: Team Cymru IP-to-ASN over DNS-TXT (in-model DNS transport; no raw-socket/BGP egress).
//   IPv4: <d.c.b.a>.origin.asn.cymru.com  TXT -> "ASN | BGP prefix | CC | RIR | date"
//   IPv6: <reversed-nibbles>.origin6.asn.cymru.com
// Deterministic: the resolved AS number(s) + announcing prefix are recorded raw (Layer A).
// No geolocation used for attribution (CC recorded as raw context only, never an attribution key).
const dns = require('dns').promises;

const SOURCE = 'team-cymru/origin.asn.cymru.com (DNS-TXT)';
const DEFAULT = { retries: 2, baseDelayMs: 150, timeoutMs: 5000 };

function classify(err) {
  const c = err && err.code ? err.code : '';
  if (c === 'ETIMEDOUT' || c === 'ETIME') return 'DNS_TIMEOUT';
  if (c === 'ENOTFOUND' || c === 'ENODATA' || c === 'NXDOMAIN') return 'NO_ASN';
  return 'ASN_LOOKUP_FAILURE';
}
async function withTimeout(p, ms) { let t; const to = new Promise((_, r) => { t = setTimeout(() => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; r(e); }, ms); }); try { return await Promise.race([p, to]); } finally { clearTimeout(t); } }
async function withRetry(fn, opts = DEFAULT) { let last; for (let i = 0; i <= opts.retries; i++) { try { return await withTimeout(fn(), opts.timeoutMs); } catch (e) { last = e; if (classify(e) === 'NO_ASN') throw e; if (i < opts.retries) await new Promise(r => setTimeout(r, opts.baseDelayMs * Math.pow(2, i))); } } throw last; }

function reverseV4(ip) { return ip.split('.').reverse().join('.'); }
function reverseV6Nibbles(ip) {
  // expand to full 32 hex nibbles, reverse, dot-join
  const parts = ip.split('::');
  let head = parts[0] ? parts[0].split(':') : [];
  let tail = parts[1] !== undefined ? (parts[1] ? parts[1].split(':') : []) : null;
  let groups;
  if (tail === null) groups = head;
  else { const miss = 8 - (head.length + tail.length); groups = [...head, ...Array(miss).fill('0'), ...tail]; }
  const full = groups.map(g => g.padStart(4, '0')).join('');
  return full.split('').reverse().join('.');
}

// Returns { asn: <int|null>, asns: [int], bgp_prefix, cc, rir, raw, status }
async function lookupAsn(ip, resolver = dns, opts = DEFAULT) {
  const v6 = ip.includes(':');
  const qname = (v6 ? reverseV6Nibbles(ip) + '.origin6.asn.cymru.com' : reverseV4(ip) + '.origin.asn.cymru.com');
  try {
    const txt = await withRetry(() => resolver.resolveTxt(qname), opts);
    const raw = txt.map(t => t.join('')).join(' ; ');
    // field 0 may carry multiple origin ASNs (MOAS), space-separated
    const fields = (txt[0] ? txt[0].join('') : '').split('|').map(s => s.trim());
    const asnList = (fields[0] || '').split(/\s+/).filter(Boolean).map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
    return {
      asn: asnList.length ? asnList[0] : null,    // primary origin AS (deterministic: first listed)
      asns: asnList,
      multi_origin: asnList.length > 1,
      bgp_prefix: fields[1] || null,
      cc: fields[2] || null,                       // raw context only — NEVER an attribution key
      rir: fields[3] || null,
      raw, status: 'OK',
    };
  } catch (e) {
    return { asn: null, asns: [], multi_origin: false, bgp_prefix: null, cc: null, rir: null, raw: null, status: classify(e) };
  }
}

module.exports = { lookupAsn, SOURCE };
