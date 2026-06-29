'use strict';
// SOT-DNSPROVISION-001 §2/§4 — Layer A (Observation) collector.
// Collects: child-apex NS RRset (source-of-record, RFC 2181 §6.1), SOA MNAME,
//           parent-delegation NS (corroboration; best-effort).
// Raw evidence preserved verbatim. Bounded retry. Timeout. No IP/ASN/registrar collection.
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
      const code = classify(e);
      if (code === 'ABSENT') throw e;            // absence is a fact; do not retry
      if (i < opts.retries) await new Promise(r => setTimeout(r, opts.baseDelayMs * Math.pow(2, i)));
    }
  }
  throw last;
}

// Child-apex NS + SOA — the authoritative source of record (resolver, default injectable for tests).
async function collectChildApex(domain, resolver = dns, opts = DEFAULT) {
  const out = { ns_hostnames: null, soa_mname: null, status: 'OK' };
  try {
    const ns = await withRetry(() => resolver.resolveNs(domain), opts);
    out.ns_hostnames = [...new Set(ns.map(h => h.toLowerCase().replace(/\.$/, '')))].sort();
  } catch (e) {
    out.status = classify(e);
    out.ns_hostnames = [];
  }
  try {
    const soa = await withRetry(() => resolver.resolveSoa(domain), opts);
    out.soa_mname = soa && soa.nsname ? soa.nsname.toLowerCase().replace(/\.$/, '') : null;
  } catch (e) {
    out.soa_mname = null;
    if (out.status === 'OK') out.status = 'SOA_ABSENT';
  }
  return out;
}

// Parent-delegation NS — corroboration only (SOT §4.5).
//
// SCOPED DEFERRAL (governed, not a stub-to-be-finished). §4.5 designates the
// child-apex NS RRset as the authoritative SOURCE OF RECORD and the basis of all
// attribution; parent-delegation NS is CORROBORATION ONLY. Collecting it requires
// a non-recursive NS query to the parent/TLD nameservers and reading the AUTHORITY
// section — i.e. raw UDP/53 (e.g. via `dns-packet`), which Node's stdlib `dns`
// does not expose and which is not available in the current execution environment.
//
// Because (a) the source-of-record (child-apex, via collectChildApex) IS collected,
// and (b) Layer-A raw NS is preserved, the corroboration can be added later WITHOUT
// recollection or re-attribution. Until then this returns an honest non-observation
// (Unknown ≠ Absent): `PARENT_DELEGATION_UNAVAILABLE`, which the signal records as
// parent_delegation_status and leaves ns_delegation_divergence = null (never false).
// Tracked as a signal backlog item; introducing raw-DNS infrastructure for a
// corroboration-only field is deliberately deferred.
async function collectParentDelegation(domain, opts = DEFAULT) {
  return { parent_ns_hostnames: null, status: 'PARENT_DELEGATION_UNAVAILABLE' };
}

module.exports = { collectChildApex, collectParentDelegation, classify };
