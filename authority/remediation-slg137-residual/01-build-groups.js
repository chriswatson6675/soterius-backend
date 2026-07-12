'use strict';
// Repository Authority Remediation — Stage 1
// Joins the 1,345 SLG-137-residual domains (validation-slg136/results.ndjson,
// new_bucket in {CONNECTION_ERROR, NOT_OBSERVED}) to their organisation record
// in the Repository Authority (authority/dataset/organisations.ndjson), and
// splits them into evidence groups using ONLY fields already present in that
// validation output — no new network calls in this stage.
//
// Groups (derived from http_probe_state [port 80, single request] vs
// new_endpoint_state [https_fetch outcome, up to 10 redirects]):
//   A — http_probe RESPONSE_OBSERVED, https CONNECTION_ERROR  (port 443 refused/no listener)
//   B — http_probe RESPONSE_OBSERVED, https TIMEOUT           (port 443 hangs)
//   C — http_probe RESPONSE_OBSERVED, https REDIRECT_UNRESOLVED (>10 hops / loop)
//   D — http_probe NOT observed,      https CONNECTION_ERROR  (both ports dead)
//   E — http_probe NOT observed,      https TIMEOUT           (both ports dead)
//   F — http_probe NOT observed,      https REDIRECT_UNRESOLVED

const fs = require('fs');
const path = require('path');

const VALIDATION_RESULTS = path.join(__dirname, '../../collection/signals/securityheaders/validation-slg136/results.ndjson');
const ORGANISATIONS      = path.join(__dirname, '../dataset/organisations.ndjson');
const OUT                = path.join(__dirname, '01-groups.ndjson');

function group(r) {
  const httpOk = r.http_probe_state === 'RESPONSE_OBSERVED';
  if (httpOk && r.new_endpoint_state === 'CONNECTION_ERROR')    return 'A';
  if (httpOk && r.new_endpoint_state === 'TIMEOUT')             return 'B';
  if (httpOk && r.new_endpoint_state === 'REDIRECT_UNRESOLVED') return 'C';
  if (!httpOk && r.new_endpoint_state === 'CONNECTION_ERROR')   return 'D';
  if (!httpOk && r.new_endpoint_state === 'TIMEOUT')            return 'E';
  if (!httpOk && r.new_endpoint_state === 'REDIRECT_UNRESOLVED') return 'F';
  return 'Z';
}

function main() {
  const results = fs.readFileSync(VALIDATION_RESULTS, 'utf8').trim().split('\n').map(JSON.parse);
  const remaining = results.filter(r => r.new_bucket === 'CONNECTION_ERROR' || r.new_bucket === 'NOT_OBSERVED');

  const orgByDomain = new Map();
  for (const line of fs.readFileSync(ORGANISATIONS, 'utf8').trim().split('\n')) {
    const o = JSON.parse(line);
    if (o.verifiedDomain) orgByDomain.set(o.verifiedDomain, o);
  }

  const out = fs.createWriteStream(OUT);
  const counts = {};
  let unmatched = 0;
  for (const r of remaining) {
    const org = orgByDomain.get(r.domain);
    if (!org) { unmatched++; continue; }
    const g = group(r);
    counts[g] = (counts[g] || 0) + 1;
    out.write(JSON.stringify({
      domain: r.domain,
      group: g,
      new_endpoint_state: r.new_endpoint_state,
      http_probe_state: r.http_probe_state,
      redirect_hops: r.redirect_hops,
      organisationId: org.organisationId,
      organisationName: org.organisationName,
      regulators: org.regulators,
      companiesHouseNumber: org.identifiers.companiesHouseNumber,
      frn: org.identifiers.frn,
      sraIdentifier: org.identifiers.sraIdentifier,
    }) + '\n');
  }
  out.end(() => {
    console.log('remaining', remaining.length, 'unmatched', unmatched);
    console.log('groups', counts);
  });
}

main();
