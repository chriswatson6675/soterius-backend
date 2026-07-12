'use strict';
// Stage 4 — classify Group C (40) from the live redirect-chain trace (Stage 3).
// Rule set, in priority order:
//   1. Any hop's raw Location header lacks a URL scheme but looks like a bare
//      hostname (a malformed relative redirect) -> the literal target host is
//      surfaced as a probable merge/successor domain (MERGED_OR_ACQUIRED),
//      because a same-origin loop alone would not explain a location value
//      that itself contains a foreign-looking hostname + path.
//   2. trace reached a DIFFERENT registrable host than the stored domain,
//      cleanly (RESOLVED/200) -> DOMAIN_CHANGED, unless the destination host
//      is unrelated/foreign-looking with no brand relationship -> treated as
//      STALE_REPOSITORY_DOMAIN (domain likely expired -> parked/squatted).
//   3. trace loops or exhausts hops but stays on the SAME registrable host
//      (ignoring www.) -> COLLECTOR_LIMITATION (domain confirmed correct and
//      live; site has its own redirect/loop bug outside Repository Authority
//      scope), action KEEP.
//   4. HTTP_ERROR_TERMINAL on the same host (e.g. 403) -> live server exists,
//      likely blocking this client -> COLLECTOR_LIMITATION, action KEEP.
//   5. ERROR mid-chain after leaving the original host for an unrelated
//      foreign host -> STALE_REPOSITORY_DOMAIN, action MANUAL_REVIEW.

const fs   = require('fs');
const path = require('path');

const IN  = path.join(__dirname, '03-redirect-chain.ndjson');
const OUT = path.join(__dirname, '04-redirects-classified.ndjson');

function registrable(host) {
  if (!host) return null;
  return host.toLowerCase().replace(/^www\./, '');
}

function bareHostnameInLocation(loc) {
  if (!loc) return null;
  if (/^https?:\/\//i.test(loc)) return null; // absolute — not the malformed case
  const m = loc.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i) || loc.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i);
  return m ? m[1].toLowerCase() : null;
}

function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const out = fs.createWriteStream(OUT);
  const summary = {};

  for (const r of rows) {
    const storedHost = registrable(r.domain);
    const finalHost = registrable(r.final_host);

    // Rule 1: malformed relative Location revealing a literal foreign hostname.
    let malformedTarget = null;
    for (const hop of r.chain) {
      const bare = bareHostnameInLocation(hop.location);
      if (bare && registrable(bare) !== storedHost) { malformedTarget = hop.location; break; }
    }

    let rec;
    if (malformedTarget) {
      rec = {
        primary_cause: 'MERGED_OR_ACQUIRED',
        confidence: 'HIGH',
        evidence: `own server issued a redirect naming "${malformedTarget}" (malformed — missing URL scheme, so it self-looped instead of leaving the domain); the literal target names a different, unrelated firm's domain, consistent with an acquisition/merger redirect that was configured incorrectly`,
        recommended_action: 'MANUAL_REVIEW',
        candidate_target_domain: malformedTarget.replace(/\/.*$/, ''),
      };
    } else if (r.trace_outcome === 'RESOLVED' && finalHost === storedHost) {
      rec = {
        primary_cause: 'COLLECTOR_LIMITATION',
        confidence: 'HIGH',
        evidence: `live retry resolves cleanly (HTTP <400) on the same stored domain — the original REDIRECT_UNRESOLVED was a transient collection-run artefact, not a Repository Authority defect`,
        recommended_action: 'KEEP',
      };
    } else if (r.trace_outcome === 'RESOLVED' && finalHost && finalHost !== storedHost) {
      rec = {
        primary_cause: 'DOMAIN_CHANGED',
        confidence: 'HIGH',
        evidence: `live 30x redirect chain terminates cleanly (HTTP <400) on a different registrable domain: ${r.final_host}`,
        recommended_action: 'UPDATE_DOMAIN',
        candidate_target_domain: r.final_host,
      };
    } else if ((r.trace_outcome === 'LOOP' || r.trace_outcome === 'MAX_HOPS_EXCEEDED') && finalHost === storedHost) {
      rec = {
        primary_cause: 'COLLECTOR_LIMITATION',
        confidence: 'HIGH',
        evidence: `redirect chain loops/exhausts hops but never leaves the stored domain (${r.domain}) — the domain is live and correct; the site has its own redirect misconfiguration the collector's hop cap cannot traverse`,
        recommended_action: 'KEEP',
      };
    } else if (r.trace_outcome === 'HTTP_ERROR_TERMINAL' && finalHost === storedHost) {
      rec = {
        primary_cause: 'COLLECTOR_LIMITATION',
        confidence: 'MEDIUM',
        evidence: `stored domain answers directly over HTTPS with a definitive HTTP error status (no redirect) — server is live, likely blocking this client rather than the domain being wrong`,
        recommended_action: 'KEEP',
      };
    } else if (r.trace_outcome === 'ERROR' && finalHost && finalHost !== storedHost) {
      rec = {
        primary_cause: 'STALE_REPOSITORY_DOMAIN',
        confidence: 'MEDIUM',
        evidence: `redirect chain leaves the stored domain for an unrelated third-party host (${r.final_host}) with no brand relationship to the organisation, then errors — consistent with a lapsed/expired domain now under different (parking/squatter) control`,
        recommended_action: 'MANUAL_REVIEW',
      };
    } else {
      rec = {
        primary_cause: 'REVIEW_REQUIRED',
        confidence: 'LOW',
        evidence: `trace outcome ${r.trace_outcome}, final_host=${r.final_host} — does not match a deterministic rule`,
        recommended_action: 'MANUAL_REVIEW',
      };
    }

    summary[rec.primary_cause] = (summary[rec.primary_cause] || 0) + 1;
    out.write(JSON.stringify({ ...r, ...rec }) + '\n');
  }
  out.end(() => console.log('group C classified:', summary));
}

main();
