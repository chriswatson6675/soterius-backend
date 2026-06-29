'use strict';

// SOT-DNSSEC-001 — DNSSEC Signal Collector
//
// Signal Lab principles applied:
//   - Two independent collection points: DS records (parent zone) and DNSKEY records (domain zone)
//   - Three-state presence for each independently: true / false / null
//   - A failure in one query does not contaminate the result of the other
//   - All DS and DNSKEY records preserved verbatim in DNS return order
//   - No DNSSEC validation performed; no chain-of-trust verification
//   - No RRSIG or NSEC/NSEC3 collection (v1 scope)
//   - Key tags are Derived Observations computed per RFC 4034 Appendix B
//   - No scores, ratings, or assessments stored
//
// DNS transport:
//   Node.js dns.promises does not support DS (type 43) or DNSKEY (type 48).
//   Queries use DNS over HTTPS (DoH) via Cloudflare's JSON API (RFC 8484).
//   The dnsResolver parameter is injectable for testing.

const axios = require('axios');

const SIGNAL_ID      = 'dnssec';
const SIGNAL_VERSION = 1;

// DNS type numbers (IANA)
const DNS_TYPE_DS     = 43;
const DNS_TYPE_DNSKEY = 48;

// DoH endpoint
const DOH_URL        = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 10000;

// DoH response status codes (DNS RCODE values)
const DOH_NOERROR  = 0;
const DOH_SERVFAIL = 2;
const DOH_NXDOMAIN = 3;

// ── DoH resolver ──────────────────────────────────────────────────────────────

async function dohQuery(name, rrtype) {
  const { data } = await axios.get(DOH_URL, {
    params:  { name, type: rrtype },
    headers: { Accept: 'application/dns-json' },
    timeout: DOH_TIMEOUT_MS,
  });
  return data;
}

const defaultDnsResolver = {
  async queryDS(name)     { return dohQuery(name, DNS_TYPE_DS); },
  async queryDNSKEY(name) { return dohQuery(name, DNS_TYPE_DNSKEY); },
};

// ── Error classification ───────────────────────────────────────────────────────

function classifyDohError(err) {
  const code = err.code ?? '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'DNS_TIMEOUT';
  return 'DNS_FAILURE';
}

// ── Algorithm identifier resolver ────────────────────────────────────────────
//
// Cloudflare's DoH API returns algorithm identifiers as mnemonics
// (e.g. "ECDSAP256SHA256") rather than numeric IDs. This map converts them to
// IANA numeric algorithm numbers per the DNSSEC Algorithm Numbers registry.
// Numeric strings (e.g. "13") are also accepted directly.
// If a mnemonic is unrecognised, returns null; the record is still preserved.

const ALGORITHM_MNEMONIC_MAP = new Map([
  ['RSAMD5',              1],
  ['DH',                  2],
  ['DSA',                 3],
  ['RSASHA1',             5],
  ['DSA-NSEC3-SHA1',      6],
  ['NSEC3DSA',            6],
  ['RSASHA1-NSEC3-SHA1',  7],
  ['NSEC3RSASHA1',        7],
  ['RSASHA256',           8],
  ['RSASHA512',          10],
  ['ECC-GOST',           12],
  ['ECDSAP256SHA256',    13],
  ['ECDSAP384SHA384',    14],
  ['ED25519',            15],
  ['ED448',              16],
  ['INDIRECT',          252],
  ['PRIVATEDNS',        253],
  ['PRIVATEOID',        254],
]);

function parseAlgorithm(str) {
  const numeric = parseInt(str, 10);
  if (!isNaN(numeric)) return numeric;
  return ALGORITHM_MNEMONIC_MAP.get(str.toUpperCase()) ?? null;
}

// ── Key tag computation (RFC 4034 Appendix B) ─────────────────────────────────
//
// Computed from DNSKEY wire-format RDATA:
//   flags (2 bytes big-endian) + protocol (1 byte) + algorithm (1 byte) + public key bytes
//
// Algorithm 1 (RSA/MD5, deprecated) uses a special formula per RFC 4034 Appendix B §2.
// All other algorithms use the general checksum described in RFC 4034 Appendix B §1.

function computeKeyTag(flags, protocol, algorithm, publicKeyBase64) {
  const pubKeyBytes = Buffer.from(publicKeyBase64.replace(/\s+/g, ''), 'base64');

  if (algorithm === 1) {
    const len = pubKeyBytes.length;
    if (len < 3) return 0;
    // Most significant 16 bits of least significant 24 bits of the public key modulus.
    // The modulus ends at the last byte of pubKeyBytes; bytes at [len-3] and [len-2]
    // are the 4th-to-last and 3rd-to-last octets regardless of exponent encoding.
    return ((pubKeyBytes[len - 3] << 8) | pubKeyBytes[len - 2]) & 0xFFFF;
  }

  const wire = Buffer.alloc(4 + pubKeyBytes.length);
  wire.writeUInt16BE(flags, 0);
  wire.writeUInt8(protocol, 2);
  wire.writeUInt8(algorithm, 3);
  pubKeyBytes.copy(wire, 4);

  let ac = 0;
  for (let i = 0; i < wire.length; i++) {
    ac += (i & 1) ? wire[i] : (wire[i] << 8);
  }
  ac += (ac >> 16) & 0xFFFF;
  return ac & 0xFFFF;
}

// ── DS record parsing ─────────────────────────────────────────────────────────
//
// Parses the DoH JSON `data` string for a DS record.
// RFC 8427 format: "<keytag> <algorithm> <digesttype> <digest>"
// digest is hex-encoded; stored verbatim as returned.

function parseDsRecord(dataStr) {
  const parts = dataStr.trim().split(/\s+/);
  return {
    key_tag:     parseInt(parts[0], 10),
    algorithm:   parseAlgorithm(parts[1]),
    digest_type: parseInt(parts[2], 10),
    digest:      parts.slice(3).join(''),
  };
}

// ── DNSKEY record parsing ─────────────────────────────────────────────────────
//
// Parses the DoH JSON `data` string for a DNSKEY record.
// RFC 8427 format: "<flags> <protocol> <algorithm> <base64-public-key>"
// flags: 256 = ZSK, 257 = KSK (SEP bit set). public_key stored verbatim.

function parseDnskeyRecord(dataStr) {
  const parts     = dataStr.trim().split(/\s+/);
  const flags     = parseInt(parts[0], 10);
  const protocol  = parseInt(parts[1], 10);
  const algorithm = parseAlgorithm(parts[2]);
  const publicKey = parts.slice(3).join('');
  return { flags, protocol, algorithm, public_key: publicKey };
}

// ── Result builders ────────────────────────────────────────────────────────────

function absentDsResult() {
  return {
    dns_ds_present:      false,
    ds_collection_error: null,
    ds_records:          [],
    ds_record_count:     0,
    ds_algorithms:       [],
    ds_digest_types:     [],
    ds_key_tags:         [],
  };
}

function uncertainDsResult(error) {
  return {
    dns_ds_present:      null,
    ds_collection_error: error,
    ds_records:          [],
    ds_record_count:     null,
    ds_algorithms:       [],
    ds_digest_types:     [],
    ds_key_tags:         [],
  };
}

function absentDnskeyResult() {
  return {
    dns_dnskey_present:       false,
    dnskey_collection_error:  null,
    dnskey_records:           [],
    dnskey_record_count:      0,
    dnskey_ksk_count:         0,
    dnskey_zsk_count:         0,
    dnskey_other_flags_count: 0,
    dnskey_algorithms:        [],
    dnskey_key_tags:          [],
  };
}

function uncertainDnskeyResult(error) {
  return {
    dns_dnskey_present:       null,
    dnskey_collection_error:  error,
    dnskey_records:           [],
    dnskey_record_count:      null,
    dnskey_ksk_count:         null,
    dnskey_zsk_count:         null,
    dnskey_other_flags_count: null,
    dnskey_algorithms:        [],
    dnskey_key_tags:          [],
  };
}

// ── DS collection ─────────────────────────────────────────────────────────────
//
// Queries the parent zone for DS records at <apex>.
// DS records are the primary DNSSEC presence indicator — their presence in the
// parent zone is required for DNSSEC to be verifiable from the root.

async function collectDs(apex, dnsResolver) {
  let response;
  try {
    response = await dnsResolver.queryDS(apex);
  } catch (err) {
    return uncertainDsResult(classifyDohError(err));
  }

  const { Status, Answer = [] } = response;

  if (Status === DOH_NXDOMAIN) return absentDsResult();
  if (Status === DOH_SERVFAIL) return uncertainDsResult('DNS_SERVFAIL');
  if (Status !== DOH_NOERROR)  return uncertainDsResult('DNS_FAILURE');

  const dsAnswers = Answer.filter(r => r.type === DNS_TYPE_DS);
  if (dsAnswers.length === 0) return absentDsResult();

  const records = dsAnswers.map(r => parseDsRecord(r.data));

  return {
    dns_ds_present:      true,
    ds_collection_error: null,
    ds_records:          records,
    ds_record_count:     records.length,
    ds_algorithms:       [...new Set(records.map(r => r.algorithm).filter(a => a !== null))].sort((a, b) => a - b),
    ds_digest_types:     [...new Set(records.map(r => r.digest_type))].sort((a, b) => a - b),
    ds_key_tags:         records.map(r => r.key_tag),
  };
}

// ── DNSKEY collection ─────────────────────────────────────────────────────────
//
// Queries the domain zone for DNSKEY records at <apex>.
// DNSKEY records are corroborating evidence — they contain the public key material
// referenced by DS records in the parent zone.
// KSK (flags=257) and ZSK (flags=256) are counted separately.

async function collectDnskey(apex, dnsResolver) {
  let response;
  try {
    response = await dnsResolver.queryDNSKEY(apex);
  } catch (err) {
    return uncertainDnskeyResult(classifyDohError(err));
  }

  const { Status, Answer = [] } = response;

  if (Status === DOH_NXDOMAIN) return absentDnskeyResult();
  if (Status === DOH_SERVFAIL) return uncertainDnskeyResult('DNS_SERVFAIL');
  if (Status !== DOH_NOERROR)  return uncertainDnskeyResult('DNS_FAILURE');

  const dnskeyAnswers = Answer.filter(r => r.type === DNS_TYPE_DNSKEY);
  if (dnskeyAnswers.length === 0) return absentDnskeyResult();

  const records = dnskeyAnswers.map(r => parseDnskeyRecord(r.data));

  let kskCount = 0, zskCount = 0, otherCount = 0;
  for (const rec of records) {
    if      (rec.flags === 257) kskCount++;
    else if (rec.flags === 256) zskCount++;
    else                        otherCount++;
  }

  return {
    dns_dnskey_present:       true,
    dnskey_collection_error:  null,
    dnskey_records:           records,
    dnskey_record_count:      records.length,
    dnskey_ksk_count:         kskCount,
    dnskey_zsk_count:         zskCount,
    dnskey_other_flags_count: otherCount,
    dnskey_algorithms:        [...new Set(records.map(r => r.algorithm).filter(a => a !== null))].sort((a, b) => a - b),
    dnskey_key_tags:          records.map(r => computeKeyTag(r.flags, r.protocol, r.algorithm, r.public_key)),
  };
}

// ── DNSSEC collector ──────────────────────────────────────────────────────────
//
// Collects DNSSEC evidence from two independent DNS sources.
// The two queries run concurrently; their results are combined into a flat object.
// A failure in one query does not affect the result of the other.
//
// dns_ds_present:
//   true  — one or more DS records found in parent zone
//   false — DNS resolved; no DS records at <apex>
//   null  — DNS query failed; presence unknown
//
// dns_dnskey_present:
//   true  — one or more DNSKEY records found in domain zone
//   false — DNS resolved; no DNSKEY records at <apex>
//   null  — DNS query failed; presence unknown

async function collectDnssec(domain, { dnsResolver = defaultDnsResolver } = {}) {
  const apex = domain.replace(/^www\./i, '').toLowerCase().trim();

  const [dsResult, dnskeyResult] = await Promise.all([
    collectDs(apex, dnsResolver),
    collectDnskey(apex, dnsResolver),
  ]);

  return { ...dsResult, ...dnskeyResult };
}

module.exports = {
  collectDnssec,
  parseDsRecord,
  parseDnskeyRecord,
  computeKeyTag,
  SIGNAL_ID,
  SIGNAL_VERSION,
};
