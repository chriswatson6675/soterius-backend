'use strict';
// Build the DPR-DATA-001 seed dataset v1.json from the governed record
// (docs/.../DPR-DATA-001 §3). Route 53 enumerated literally (DPR-001 §7.7: no wildcard/regex).
// Status: DATASET_FREEZE_CANDIDATE_DRAFT — non-authoritative; for ITA-authorised validation testing only.
const fs = require('fs');
const path = require('path');

const TLDS = ['com', 'net', 'org', 'co.uk'];
const route53Zones = [];
for (const tld of TLDS) {
  for (let n = 0; n <= 63; n++) {
    route53Zones.push(`awsdns-${String(n).padStart(2, '0')}.${tld}`);
  }
}

const dataset = {
  dataset_id: 'DPR-DATA-001',
  dataset_version: 1,
  governed_by: 'DPR-001 (Foundation Freeze v1.0)',
  status: 'DATASET_FREEZE_v1.0_FROZEN',
  freeze: {
    frozen: true,
    freeze_date: '2026-06-23',
    release_authority: 'Founder / Governance Architect',
    psl_version: 'psl@1.15.0',
    documentary_verification: 'Completed 2026-06-23 (live DNS observation across enterprise domains + provider/IANA documentation). 8/10 entries live-corroborated; GoDaddy + MarkMonitor documentary-confirmed.',
    amendments_at_freeze: [
      'DNSP-009 CSC: added cscdns.uk (live-observed starbucks.com, kelloggs.com).',
      'DNSP-010 MarkMonitor: added markmonitor.zone (nameserver listings ha2/ha4.markmonitor.zone).',
    ],
    known_limitations: [
      'DNSP-002 Route 53 enumerated awsdns-00..63 (256 zones) — corroborated by all live observations; AWS examples suggest awsdns-64+ may exist. Out-of-range zones resolve UNMAPPED (conservative); exact upper bound to be confirmed and added by version increment.',
      'v2 candidates observed but not in v1 (resolve UNMAPPED, conservative): UltraDNS/Vercara (ultradns.*), Com Laude (comlaude-dns.*), and other enterprise operators.',
    ],
  },
  entries: [
    { provider_id: 'DNSP-001', provider_name: 'Cloudflare, Inc.', ns_zones: ['cloudflare.com'], soa_mname_zones: ['cloudflare.com'], evidence_class: ['PROVIDER_SELF_DISCLOSED', 'NS_ZONE_OBSERVED'], evidence_source: 'Cloudflare DNS docs — *.ns.cloudflare.com (zone cloudflare.com). Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-002', provider_name: 'Amazon Route 53', ns_zones: route53Zones, evidence_class: ['PROVIDER_SELF_DISCLOSED', 'IANA_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'AWS Route 53 — awsdns-00..63.{com,net,org,co.uk} (256 zones, enumerated; no regex). Range 00..63 corroborated by all sampled live observations (netflix/booking/amazon/mcdonalds/reddit/cnn/etc.); AWS examples suggest awsdns-64+ may exist — upper bound monitored (freeze.known_limitations). Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-003', provider_name: 'Microsoft Azure DNS', ns_zones: ['azure-dns.com', 'azure-dns.net', 'azure-dns.org', 'azure-dns.info'], evidence_class: ['PROVIDER_SELF_DISCLOSED', 'NS_ZONE_OBSERVED'], evidence_source: 'Microsoft Azure DNS docs — ns{1-4}-##.azure-dns.{com,net,org,info}. Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-004', provider_name: 'Google Cloud DNS', ns_zones: ['googledomains.com'], evidence_class: ['PROVIDER_SELF_DISCLOSED', 'NS_ZONE_OBSERVED'], evidence_source: 'Google Cloud DNS docs — ns-cloud-{a..d}#.googledomains.com. DNS-operator role only (registrar = Category E). Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-005', provider_name: 'Akamai (Edge DNS)', ns_zones: ['akam.net'], evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'Akamai Edge DNS — a#-##.akam.net. akamaitech.net deferred. Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-006', provider_name: 'NS1 (IBM NS1 Connect)', ns_zones: ['nsone.net'], known_aliases: ['NS1', 'IBM NS1 Connect'], parent_provider_id: 'IBM', evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'NS1/IBM docs — dns#.p##.nsone.net. IBM parent (2023). Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-007', provider_name: 'GoDaddy', ns_zones: ['domaincontrol.com'], evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'GoDaddy docs + observation — ns##.domaincontrol.com. Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-008', provider_name: 'Namecheap', ns_zones: ['registrar-servers.com'], evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'Namecheap docs — BasicDNS dns#.registrar-servers.com. PremiumDNS deferred. Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-009', provider_name: 'CSC (Corporate Domains)', ns_zones: ['cscdns.net', 'cscdns.uk'], evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'CSC managed DNS under cscdns.net + cscdns.uk. Live-observed: fedex.com (cscdns.net), starbucks.com & kelloggs.com & heineken.com (cscdns.net+cscdns.uk). DNS-operator (DPR-Q4); no Category E import. Verified 2026-06-23.', version_added: 1, status: 'ACTIVE' },
    { provider_id: 'DNSP-010', provider_name: 'MarkMonitor', ns_zones: ['markmonitor.com', 'markmonitor.zone'], evidence_class: ['PROVIDER_DOCUMENTED', 'IANA_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'MarkMonitor — ns1..7.markmonitor.com + ha2/ha4.markmonitor.zone (nameserver listings/IANA). DNS-operator (DPR-Q4). Verified 2026-06-23 (documentary; not live-observed in sampled population).', version_added: 1, status: 'ACTIVE' },
  ],
  deferred: [{ candidate: 'Tucows / OpenSRS family', reason: 'E2 — multi-brand zone ambiguity; per-brand documentary evidence required' }],
};

const out = path.join(__dirname, 'v1.json');
fs.writeFileSync(out, JSON.stringify(dataset, null, 2) + '\n');
const zoneCount = dataset.entries.reduce((a, e) => a + e.ns_zones.length, 0);
console.log(`Wrote ${out}: ${dataset.entries.length} entries, ${zoneCount} ns_zones (Route 53 = ${route53Zones.length}).`);
