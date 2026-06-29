'use strict';
// SOT-EMAILINFRA-001 §2/§4 — Layer A (Observation) collector (email).
// Collects: authoritative apex MX RRset (host names + priorities). MX is zone-apex only —
// no parent-delegation analogue (SOTE-Q3), so collection is unambiguous.
// Raw evidence preserved verbatim. Bounded retry. Timeout. Absence-as-fact.
// NO SPF / DKIM / DMARC / headers / mailbox access / message content (MX-only; Category A excluded).
// NO IP / ASN resolution.
const dns = require('dns').promises;

const DEFAULT = { retries: 2, baseDelayMs: 150, timeoutMs: 5000 };

function classify(err) {
  const c = err && err.code ? err.code : '';
  if (c === 'ETIMEDOUT' || c === 'ETIME') return 'DNS_TIMEOUT';
  if (c === 'ENOTFOUND' || c === 'ENODATA' || c === 'NXDOMAIN') return 'ABSENT';
  return 'DNS_FAILURE';
}

async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; rej(e); }, ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

async function withRetry(fn, opts = DEFAULT) {
  let last;
  for (let i = 0; i <= opts.retries; i++) {
    try { return await withTimeout(fn(), opts.timeoutMs); }
    catch (e) {
      last = e;
      if (classify(e) === 'ABSENT') throw e;       // absence is a fact; do not retry
      if (i < opts.retries) await new Promise(r => setTimeout(r, opts.baseDelayMs * Math.pow(2, i)));
    }
  }
  throw last;
}

// Collect the apex MX RRset. resolver injectable for tests/fixtures.
// Returns: { has_mx, mx_hosts:[{host,priority}], status, raw }
//   status OK            — MX present
//   status NO_MX         — domain resolves but has no MX (absence-as-fact; "no inbound mail-transport observed")
//   status MX_UNRESOLVED — persistent resolution failure (timeout/SERVFAIL after retries)
async function collectMx(domain, resolver = dns, opts = DEFAULT) {
  try {
    const mx = await withRetry(() => resolver.resolveMx(domain), opts);
    if (!Array.isArray(mx) || mx.length === 0) {
      return { has_mx: false, mx_hosts: [], status: 'NO_MX', raw: [] };
    }
    const mx_hosts = mx
      .map(r => ({ host: String(r.exchange).toLowerCase().replace(/\.$/, ''), priority: r.priority }))
      .filter(r => r.host)                                  // a single "." MX (null MX, RFC 7505) -> filtered to no transport
      .sort((a, b) => a.priority - b.priority || a.host.localeCompare(b.host));
    if (mx_hosts.length === 0) {
      return { has_mx: false, mx_hosts: [], status: 'NO_MX', raw: mx };
    }
    return { has_mx: true, mx_hosts, status: 'OK', raw: mx };
  } catch (e) {
    const code = classify(e);
    if (code === 'ABSENT') return { has_mx: false, mx_hosts: [], status: 'NO_MX', raw: [] };
    return { has_mx: false, mx_hosts: [], status: 'MX_UNRESOLVED', raw: [] };
  }
}

module.exports = { collectMx, classify };
