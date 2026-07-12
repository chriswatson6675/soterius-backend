'use strict';
// Stage 8 — merge DNS (05) + CH status (06) + FCA status (07) evidence for
// groups D/E (773) and apply deterministic classification. Anything left
// genuinely undetermined is flagged needs_domain_discovery for Stage 9
// (only stage that would spend live Google Custom Search queries), rather
// than guessed here.

const fs   = require('fs');
const path = require('path');

const DNS = path.join(__dirname, '05-dns-results.ndjson');
const CH  = path.join(__dirname, '06-ch-status.ndjson');
const FCA = path.join(__dirname, '07-fca-status.ndjson');
const OUT = path.join(__dirname, '08-de-classified.ndjson');

const DISSOLVED_CH_STATUSES = new Set(['dissolved', 'liquidation', 'converted-closed', 'receivership']);

function main() {
  const dnsRows = fs.readFileSync(DNS, 'utf8').trim().split('\n').map(JSON.parse);
  const chByDomain = new Map(fs.readFileSync(CH, 'utf8').trim().split('\n').map(JSON.parse).map(r => [r.domain, r]));
  const fcaByDomain = new Map(fs.readFileSync(FCA, 'utf8').trim().split('\n').map(JSON.parse).map(r => [r.domain, r]));

  const out = fs.createWriteStream(OUT);
  const summary = {};

  for (const r of dnsRows) {
    const ch = chByDomain.get(r.domain);
    const fca = fcaByDomain.get(r.domain);
    let rec;

    // Special case: our own stored identifier is wrong (Repository Authority defect).
    if (ch && ch.ch_lookup_error === 'NOT_FOUND') {
      rec = {
        primary_cause: 'ACQUISITION_ERROR',
        confidence: 'HIGH',
        evidence: `Repository Authority's stored Companies House number (${r.companiesHouseNumber}) does not exist at Companies House — the identifier itself is wrong, independent of domain status`,
        recommended_action: 'MANUAL_REVIEW',
        needs_domain_discovery: true,
      };
    } else if (fca && fca.fca_status === 'NOT_IN_SNAPSHOT') {
      rec = {
        primary_cause: 'ACQUISITION_ERROR',
        confidence: 'MEDIUM',
        evidence: `Repository Authority's stored FRN (${r.frn}) is not present in the FCA registry snapshot — the identifier itself may be wrong`,
        recommended_action: 'MANUAL_REVIEW',
        needs_domain_discovery: true,
      };
    } else if (ch && DISSOLVED_CH_STATUSES.has(ch.ch_company_status)) {
      rec = {
        primary_cause: 'DISSOLVED',
        confidence: 'HIGH',
        evidence: `Companies House company_status=${ch.ch_company_status} (live lookup) for CH number ${r.companiesHouseNumber}; domain dns_status=${r.dns_status}`,
        recommended_action: 'MARK_DISSOLVED',
        needs_domain_discovery: false,
      };
    } else if (ch && ch.ch_company_status === 'administration') {
      rec = {
        primary_cause: 'REVIEW_REQUIRED',
        confidence: 'MEDIUM',
        evidence: `Companies House company_status=administration — an active insolvency event but not necessarily ceased trading; requires human judgement`,
        recommended_action: 'MANUAL_REVIEW',
        needs_domain_discovery: false,
      };
    } else if ((ch && ch.ch_company_status === 'active') || (fca && fca.fca_status === 'Authorised')) {
      // Org confirmed legally alive, but its stored domain is unreachable.
      rec = {
        primary_cause: r.dns_status === 'NXDOMAIN' ? 'DOMAIN_CHANGED' : 'STALE_REPOSITORY_DOMAIN',
        confidence: 'MEDIUM',
        evidence: `organisation confirmed active (${ch ? 'CH company_status=active' : 'FCA Status=Authorised'}) but stored domain ${r.domain} is ${r.dns_status === 'NXDOMAIN' ? 'NXDOMAIN (no longer registered)' : 'registered but unreachable on 80/443'} — org is alive, domain record is not; candidate cause pending canonical-domain discovery`,
        recommended_action: 'MANUAL_REVIEW',
        needs_domain_discovery: true,
      };
    } else if (r.dns_status === 'DNS_ERROR') {
      rec = {
        primary_cause: 'REVIEW_REQUIRED',
        confidence: 'LOW',
        evidence: `DNS resolution inconclusive (SERVFAIL, retried once) and no regulator-status evidence available`,
        recommended_action: 'MANUAL_REVIEW',
        needs_domain_discovery: true,
      };
    } else {
      // No CH/FCA evidence at all (typically SRA-only orgs without a company number).
      rec = {
        primary_cause: 'REVIEW_REQUIRED',
        confidence: 'LOW',
        evidence: `no Companies House or FCA status evidence available for this organisation (no linked identifier, or SRA-only with no locally-held live status source); domain dns_status=${r.dns_status}`,
        recommended_action: 'MANUAL_REVIEW',
        needs_domain_discovery: true,
      };
    }

    summary[rec.primary_cause] = (summary[rec.primary_cause] || 0) + 1;
    out.write(JSON.stringify({ ...r, ...rec }) + '\n');
  }
  out.end(() => {
    console.log('D/E classified:', summary);
    const all = fs.readFileSync(OUT, 'utf8').trim().split('\n').map(JSON.parse);
    console.log('needs_domain_discovery count:', all.filter(r => r.needs_domain_discovery).length);
  });
}

main();
