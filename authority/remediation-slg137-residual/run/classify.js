'use strict';
// Stage 5 synthesis — deterministic classification from Stages 1-4 evidence,
// applied to every organisation in checkpoint.ndjson. Codifies exactly the
// reasoning used by hand in the 25-org POC: www/apex resolution, malformed-
// relative-redirect successor detection, MX-based "still controlled" evidence,
// regulator differential (never circular-match) evidence, CH dissolution.
//
// Produces one Repository Authority Exception Record per organisation and
// flags which ones still need Stage 6 (web search). No Repository Authority
// writes; recommendations only.

const fs   = require('fs');
const path = require('path');

const CHECKPOINT = path.join(__dirname, 'checkpoint.ndjson');
const GROUPS = path.join(__dirname, '../01-groups.ndjson');
const OUT = path.join(__dirname, 'exception-records-stage1-5.ndjson');

function normHost(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
function bareHostnameInLocation(loc) {
  if (!loc) return null;
  if (/^https?:\/\//i.test(loc)) return null;
  const m = loc.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i) || loc.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i);
  return m ? m[1].toLowerCase() : null;
}
const DISSOLVED_CH = new Set(['dissolved', 'liquidation', 'converted-closed', 'receivership']);
const SRA_ACTIVE = new Set(['YES']);
const SRA_CEASED = new Set(['CEASE', 'REVOKE', 'INTERVENE']);

function evaluateChain(trace, storedHost) {
  if (!trace) return null;
  const finalHop = trace.chain[trace.chain.length - 1];
  const finalHost = finalHop && finalHop.url ? normHost(new URL(finalHop.url).hostname) : null;
  let malformedTarget = null;
  for (const hop of trace.chain) {
    const bare = bareHostnameInLocation(hop.location);
    if (bare && normHost(bare) !== storedHost) { malformedTarget = bare.replace(/\/.*$/, ''); break; }
  }
  return { outcome: trace.outcome, finalHost, malformedTarget };
}

function classify(r, httpProbeState) {
  const storedHost = normHost(r.domain);
  const rec = {
    organisation_id: r.organisationId, organisation_name: r.organisationName,
    regulators: r.regulators, identifiers: r.identifiers, stored_domain: r.domain,
    redirect_chain: { apex: r.stage1 && r.stage1.apex ? r.stage1.apex.chain : null, www: r.stage1 && r.stage1.www ? r.stage1.www.chain : null },
    dns_evidence: r.stage2 || null,
    regulator_evidence: r.stage3 || null,
    companies_house_evidence: r.stage4 || null,
    search_evidence: null, live_verification: null,
  };

  // ── Gather redirect evidence (apex first, then www) ──────────────────────
  const apexEval = r.stage1 ? evaluateChain(r.stage1.apex, storedHost) : null;
  const wwwEval = r.stage1 && r.stage1.www ? evaluateChain(r.stage1.www, storedHost) : null;

  // ── Gather regulator candidate domain (only if it DIFFERS from stored) ───
  let regulatorCandidate = null, regulatorCandidateSource = null;
  if (r.stage3 && r.stage3.fcaAddress && r.stage3.fcaAddress.found) {
    const w = (r.stage3.fcaAddress.records || []).map(x => x['Website Address']).find(x => x && x.trim());
    if (w && normHost(w) !== storedHost) { regulatorCandidate = w; regulatorCandidateSource = 'FCA Register /Address (live)'; }
  }
  if (!regulatorCandidate && r.stage3 && r.stage3.sra) {
    const sites = [...(r.stage3.sra.websites || []), ...(r.stage3.sra.officeWebsites || [])].filter(Boolean);
    const diff = sites.find(w => normHost(w) !== storedHost);
    if (diff) { regulatorCandidate = diff; regulatorCandidateSource = 'SRA Register (websites differ from stored)'; }
  }

  // ── Organisation status ────────────────────────────────────────────────────
  let orgStatus = 'UNKNOWN';
  if (r.stage4 && r.stage4.profile && r.stage4.profile.found) {
    orgStatus = `CH:${r.stage4.profile.body.company_status}`;
  }
  if (r.stage3 && r.stage3.sra && r.stage3.sra.authorisationStatus) {
    orgStatus += (orgStatus === 'UNKNOWN' ? '' : ' | ') + `SRA:${r.stage3.sra.authorisationStatus}`;
  }
  if (r.stage3 && r.stage3.fcaStatus && r.stage3.fcaStatus.found && r.stage3.fcaStatus.status) {
    orgStatus += (orgStatus === 'UNKNOWN' ? '' : ' | ') + `FCA:${r.stage3.fcaStatus.status}`;
  }
  rec.organisation_status = orgStatus;

  const chDissolved = r.stage4 && r.stage4.profile && r.stage4.profile.found && DISSOLVED_CH.has(r.stage4.profile.body.company_status);
  const chNotFound = r.stage4 && r.stage4.profile && r.stage4.profile.error === 'NOT_FOUND';
  const fcaNotFound = r.stage3 && r.stage3.fcaAddress && !r.stage3.fcaAddress.found;
  const dnsControl = r.stage2 ? r.stage2.controlState : 'UNKNOWN';

  // ── Decision cascade, mirroring the POC exactly ──────────────────────────
  let stage, canonical, confidence, cause, action, evidenceNote;

  // Malformed-relative-redirect successor pattern (Simpson Jones case).
  const malformed = (apexEval && apexEval.malformedTarget) || (wwwEval && wwwEval.malformedTarget);
  if (malformed) {
    stage = 1; canonical = malformed; confidence = 'HIGH';
    cause = 'MERGED_OR_ACQUIRED'; action = 'MANUAL_REVIEW';
    evidenceNote = `own server issued a malformed (schemeless) redirect literally naming "${malformed}" — self-looped instead of leaving the domain, but the literal target names a different organisation's domain`;
  }
  // Clean redirect to a genuinely different host, either apex or www.
  else if ((apexEval && apexEval.outcome === 'RESOLVED' && apexEval.finalHost && apexEval.finalHost !== storedHost) ||
           (wwwEval && wwwEval.outcome === 'RESOLVED' && wwwEval.finalHost && wwwEval.finalHost !== storedHost)) {
    const winner = (apexEval && apexEval.outcome === 'RESOLVED' && apexEval.finalHost !== storedHost) ? apexEval : wwwEval;
    stage = 1; canonical = winner.finalHost; confidence = 'HIGH';
    cause = 'DOMAIN_CHANGED'; action = 'UPDATE_DOMAIN';
    evidenceNote = `live redirect chain (${winner === wwwEval ? 'www variant' : 'apex'}) terminates cleanly on a different registrable domain`;
  }
  // Clean resolve on the SAME host (apex or www) — confirmed correct as-is.
  else if ((apexEval && apexEval.outcome === 'RESOLVED' && apexEval.finalHost === storedHost) ||
           (wwwEval && wwwEval.outcome === 'RESOLVED' && wwwEval.finalHost === storedHost)) {
    const neededWww = wwwEval && wwwEval.outcome === 'RESOLVED' && (!apexEval || apexEval.outcome !== 'RESOLVED');
    stage = 1; canonical = r.domain; confidence = 'HIGH';
    cause = 'NONE'; action = 'KEEP';
    evidenceNote = neededWww
      ? 'apex has no usable record; www variant resolves live and correctly — same registrable domain, methodology note only (needs www)'
      : 'domain resolves live and correctly on its own';
  }
  // Port 80 answers (proven by the SLG-137 collector's http_probe on this exact
  // domain, same collection date) but HTTPS never resolved on apex or www —
  // domain is live and correctly stored, it simply has no HTTPS service.
  else if (httpProbeState === 'RESPONSE_OBSERVED') {
    stage = 1; canonical = r.domain; confidence = 'HIGH';
    cause = 'GENUINE_NO_PUBLIC_HTTPS'; action = 'KEEP';
    evidenceNote = 'port 80 served a response (SLG-137 collector http_probe_state=RESPONSE_OBSERVED) on this exact domain; HTTPS unreachable on both apex and www — domain resolves and is live, it has no HTTPS service';
  }
  // CH confirms dissolution/liquidation and no live redirect contradicts it.
  else if (chDissolved) {
    stage = 4; canonical = null; confidence = 'HIGH';
    cause = 'DISSOLVED'; action = 'MARK_DISSOLVED';
    evidenceNote = `Companies House company_status=${r.stage4.profile.body.company_status}`;
  }
  // Our own stored identifier doesn't exist at the source — a different kind of defect.
  else if (chNotFound || fcaNotFound) {
    stage = 4; canonical = null; confidence = 'MEDIUM';
    cause = 'ACQUISITION_ERROR'; action = 'MANUAL_REVIEW';
    evidenceNote = chNotFound ? 'stored Companies House number not found at Companies House' : 'stored FRN not found at the live FCA Register';
  }
  // Regulator names a genuinely different website than stored.
  else if (regulatorCandidate) {
    stage = 3; canonical = regulatorCandidate; confidence = 'MEDIUM';
    cause = 'DOMAIN_CHANGED'; action = 'UPDATE_DOMAIN';
    evidenceNote = `${regulatorCandidateSource} — differs from stored domain (not a circular echo)`;
  }
  // Domain unreachable on web but DNS proves the org still controls it (mail/NS).
  else if (dnsControl === 'EMAIL_ONLY' || dnsControl === 'NS_ONLY') {
    stage = 2; canonical = r.domain; confidence = 'MEDIUM';
    cause = 'GENUINE_NO_PUBLIC_HTTPS'; action = 'MANUAL_REVIEW';
    evidenceNote = `no web response on apex or www, but ${dnsControl === 'EMAIL_ONLY' ? 'live MX records' : 'live NS delegation'} prove the organisation still controls this domain`;
  }
  // SRA/CH agree the organisation ceased, and DNS is abandoned too — consistent closure.
  else if ((r.stage3 && r.stage3.sra && SRA_CEASED.has(r.stage3.sra.authorisationStatus)) && dnsControl === 'ABANDONED') {
    stage = 3; canonical = null; confidence = 'MEDIUM';
    cause = 'DISSOLVED'; action = 'MARK_DISSOLVED';
    evidenceNote = `SRA AuthorisationStatus=${r.stage3.sra.authorisationStatus}, corroborated by a fully abandoned DNS footprint (no web, no mail, no NS evidence beyond registry defaults)`;
  }
  // Nothing deterministic found — needs Stage 6.
  else {
    stage = 5; canonical = null; confidence = 'LOW';
    cause = 'REVIEW_REQUIRED'; action = 'MANUAL_REVIEW';
    evidenceNote = 'no deterministic evidence source (redirect, DNS, regulator, Companies House) produced a definitive answer';
  }

  rec.resolution_stage = stage;
  rec.proposed_canonical_domain = canonical;
  rec.confidence = confidence;
  rec.root_cause = cause;
  rec.recommended_action = action;
  rec.evidence_note = evidenceNote;
  rec.needs_stage6 = (cause === 'REVIEW_REQUIRED');
  return rec;
}

function main() {
  const rows = fs.readFileSync(CHECKPOINT, 'utf8').trim().split('\n').map(JSON.parse);
  const probeByDomain = new Map(
    fs.readFileSync(GROUPS, 'utf8').trim().split('\n').map(JSON.parse).map(g => [g.domain, g.http_probe_state])
  );
  const out = fs.createWriteStream(OUT);
  const summary = { byStage: {}, byCause: {}, byAction: {}, needsStage6: 0 };
  for (const r of rows) {
    if (r.error) {
      const rec = { organisation_id: r.organisationId, organisation_name: r.organisationName, stored_domain: r.domain,
        resolution_stage: 0, proposed_canonical_domain: null, confidence: 'NONE', root_cause: 'PIPELINE_ERROR',
        recommended_action: 'MANUAL_REVIEW', evidence_note: r.error, needs_stage6: true };
      out.write(JSON.stringify(rec) + '\n');
      summary.needsStage6++;
      continue;
    }
    const rec = classify(r, probeByDomain.get(r.domain));
    out.write(JSON.stringify(rec) + '\n');
    summary.byStage[rec.resolution_stage] = (summary.byStage[rec.resolution_stage] || 0) + 1;
    summary.byCause[rec.root_cause] = (summary.byCause[rec.root_cause] || 0) + 1;
    summary.byAction[rec.recommended_action] = (summary.byAction[rec.recommended_action] || 0) + 1;
    if (rec.needs_stage6) summary.needsStage6++;
  }
  out.end(() => {
    console.log('Total classified:', rows.length);
    console.log('By stage:', summary.byStage);
    console.log('By cause:', summary.byCause);
    console.log('By action:', summary.byAction);
    console.log('Needs Stage 6:', summary.needsStage6);
  });
}

main();
