'use strict';
// Final assembly: merge Stage 1-5 deterministic results (1,047 orgs resolved
// without search) with Stage 6 results (298 orgs that needed search) into one
// Repository Authority Remediation Ledger covering all 1,345 organisations.
//
// Stage 6 provenance is three-tier, disclosed per row:
//   - 'stage6-disk'      : recovered from a batch agent's designated output file
//   - 'stage6-transcript': reconstructed from full JSON the agent reported
//                          directly in a completion message, after its
//                          designated-path file write failed/was overwritten
//   - 'stage6-lost'       : evidence genuinely unrecoverable (agent session-limit
//                          failure with no surviving output) — NOT fabricated;
//                          honestly flagged MANUAL_REVIEW with the gap disclosed

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const stage15 = fs.readFileSync(path.join(DIR, 'exception-records-stage1-5.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const disk = fs.readFileSync(path.join(DIR, 'stage6-recovered/on-disk-merged.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const recon = fs.readFileSync(path.join(DIR, 'stage6-recovered/reconstructed-from-transcript.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);

const diskById = new Map(disk.map(r => [r.organisation_id, r]));
const reconByName = new Map(recon.map(r => [r.organisation_name.toUpperCase().trim(), r]));

const OUT = path.join(DIR, 'FINAL-REMEDIATION-LEDGER.ndjson');
const out = fs.createWriteStream(OUT);

const tally = { byStage: {}, byCause: {}, byAction: {}, stage6Provenance: {} };
let total = 0;

for (const s of stage15) {
  total++;
  let rec;
  if (!s.needs_stage6) {
    // Resolved deterministically in Stages 1-5 — carry forward unchanged.
    rec = {
      organisation_id: s.organisation_id, organisation_name: s.organisation_name,
      stored_domain: s.stored_domain, resolution_stage: s.resolution_stage,
      canonical_domain: s.proposed_canonical_domain, confidence: s.confidence,
      root_cause: s.root_cause, recommended_action: s.recommended_action,
      evidence_note: s.evidence_note, stage6_provenance: null,
    };
  } else {
    const diskRec = diskById.get(s.organisation_id);
    const nameU = s.organisation_name.toUpperCase().trim();
    const reconRec = reconByName.get(nameU);
    if (diskRec) {
      rec = {
        organisation_id: s.organisation_id, organisation_name: s.organisation_name,
        stored_domain: s.stored_domain, resolution_stage: 6,
        canonical_domain: diskRec.proposed_canonical_domain, confidence: diskRec.confidence,
        root_cause: diskRec.root_cause, recommended_action: diskRec.recommended_action,
        evidence_note: diskRec.search_findings_summary || diskRec.live_verification || null,
        stage6_provenance: 'stage6-disk',
      };
    } else if (reconRec) {
      rec = {
        organisation_id: s.organisation_id, organisation_name: s.organisation_name,
        stored_domain: s.stored_domain, resolution_stage: 6,
        canonical_domain: reconRec.proposed_canonical_domain, confidence: reconRec.confidence,
        root_cause: reconRec.root_cause, recommended_action: reconRec.recommended_action,
        evidence_note: reconRec.evidence_note, stage6_provenance: 'stage6-transcript',
      };
    } else {
      rec = {
        organisation_id: s.organisation_id, organisation_name: s.organisation_name,
        stored_domain: s.stored_domain, resolution_stage: 6,
        canonical_domain: null, confidence: 'NONE',
        root_cause: 'REVIEW_REQUIRED', recommended_action: 'MANUAL_REVIEW',
        evidence_note: 'Stage 6 (web search + live verification) was attempted but the researching agent failed with a session/infrastructure error before reporting a result; no fabricated evidence has been substituted. Requires a fresh Stage 6 pass.',
        stage6_provenance: 'stage6-lost',
      };
    }
  }

  tally.byStage[rec.resolution_stage] = (tally.byStage[rec.resolution_stage] || 0) + 1;
  tally.byCause[rec.root_cause] = (tally.byCause[rec.root_cause] || 0) + 1;
  tally.byAction[rec.recommended_action] = (tally.byAction[rec.recommended_action] || 0) + 1;
  if (rec.stage6_provenance) tally.stage6Provenance[rec.stage6_provenance] = (tally.stage6Provenance[rec.stage6_provenance] || 0) + 1;

  out.write(JSON.stringify(rec) + '\n');
}

out.end(() => {
  console.log('TOTAL:', total);
  console.log('By stage:', tally.byStage);
  console.log('By cause:', tally.byCause);
  console.log('By action:', tally.byAction);
  console.log('Stage 6 provenance:', tally.stage6Provenance);
});
