'use strict';
// Build DPR-DATA-002 (v2) — first expansion release. STRICT SUPERSET of frozen v1:
// loads v1.json (DNSP-001..010, byte-identical) and appends 7 Priority-1 providers (DNSP-011..017).
// DPR-DATA-001 (v1.json) is NOT modified. Status: Dataset Freeze Candidate — DRAFT.
const fs = require('fs');
const path = require('path');

const v1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'v1.json'), 'utf8'));

const newEntries = [
  { provider_id: 'DNSP-011', provider_name: 'IONOS / 1&1', ns_zones: ['ui-dns.biz', 'ui-dns.com', 'ui-dns.de', 'ui-dns.org'], known_aliases: ['1&1', '1and1', 'IONOS SE', 'United Internet'],
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'IONOS docs (nscs.ui-dns.{com,de,org,biz}; ns-1and1.ui-dns.com; 1&1 merged into IONOS) + 57 IF-001 firms. Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
  { provider_id: 'DNSP-012', provider_name: 'Fasthosts', ns_zones: ['livedns.co.uk'], known_aliases: ['Fasthosts Internet Ltd'],
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'Fasthosts (ns1/ns2.livedns.co.uk) + 48 IF-001 firms. Distinct operable zone from IONOS (shared parent United Internet; attribute by zone, not parent). Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
  { provider_id: 'DNSP-013', provider_name: 'Network Solutions', ns_zones: ['worldnic.com'], known_aliases: ['Web.com', 'Newfold Digital'],
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'Network Solutions (ns##.worldnic.com) + 44 IF-001 firms. Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
  { provider_id: 'DNSP-014', provider_name: 'Wix', ns_zones: ['wixdns.net'], known_aliases: ['Wix.com Ltd'],
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'Wix (ns#.wixdns.net) + 40 IF-001 firms; live-observed wix.com. Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
  { provider_id: 'DNSP-015', provider_name: 'Microsoft 365 DNS', ns_zones: ['microsoftonline.com'], known_aliases: ['Office 365', 'Microsoft Online'],
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'Microsoft 365 managed DNS (ns#.bdm.microsoftonline.com) + 33 IF-001 firms. DISTINCT from Azure DNS (DNSP-003, azure-dns.*) — different Microsoft service/zone. Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
  { provider_id: 'DNSP-016', provider_name: 'DNS Made Easy', ns_zones: ['dnsmadeeasy.com'], known_aliases: ['Constellix', 'DigiCert'],
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'DNS Made Easy (ns##.dnsmadeeasy.com) + 29 IF-001 firms. Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
  { provider_id: 'DNSP-017', provider_name: 'UltraDNS / Vercara', ns_zones: ['ultradns.net', 'ultradns.org', 'ultradns.info', 'ultradns.co.uk', 'ultradns.biz', 'ultradns.com', 'ultradns2.com', 'ultradns2.org'], known_aliases: ['Neustar UltraDNS', 'UltraDNS', 'Vercara'], parent_provider_id: 'Vercara (DigiCert)',
    evidence_class: ['PROVIDER_DOCUMENTED', 'NS_ZONE_OBSERVED'], evidence_source: 'UltraDNS/Vercara (pdns1/2.ultradns.net, pdns3/4.ultradns.org, pdns5.ultradns.info, pdns6.ultradns.co.uk, ns100.ultradns2.{com,org}; ultradns.{com,biz} live-observed) + 36 IF-001 firms. Neustar→Vercara rebrand. Verified 2026-06-23.', version_added: 2, status: 'ACTIVE' },
];

const v2 = {
  dataset_id: 'DPR-DATA-002',
  dataset_version: 2,
  governed_by: 'DPR-001 (Foundation Freeze v1.0)',
  supersedes: 'DPR-DATA-001 (v1) — strict superset; v1 retained immutable for RUN-DNSPROVISION-001 reproducibility',
  status: 'DATASET_FREEZE_CANDIDATE_DRAFT',
  lineage: { from_version: 1, added_entries: newEntries.map(e => e.provider_id), unchanged_entries: v1.entries.map(e => e.provider_id), removed_entries: [], note: 'No v1 entry modified or removed; expansion only.' },
  freeze: v1.freeze ? { v1_freeze: v1.freeze } : undefined,
  entries: [...v1.entries, ...newEntries],
  deferred: v1.deferred,
};

const out = path.join(__dirname, 'v2.json');
fs.writeFileSync(out, JSON.stringify(v2, null, 2) + '\n');
const zones = v2.entries.reduce((a, e) => a + e.ns_zones.length, 0);
console.log(`Wrote ${out}: ${v2.entries.length} entries (v1 ${v1.entries.length} + new ${newEntries.length}), ${zones} ns_zones. v1.json untouched.`);
