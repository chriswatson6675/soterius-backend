'use strict';
// Stage 10 — final Repository Authority Remediation Ledger. One row per
// residual organisation with: name, stored domain, canonical domain (where
// evidenced), evidence, confidence, primary cause, recommended action.
// canonical_domain is populated ONLY where live evidence actually named it
// (redirect target); otherwise left null — never guessed.

const fs = require('fs');
const path = require('path');

const IN  = path.join(__dirname, '09-all-merged.ndjson');
const OUT = path.join(__dirname, 'ledger.ndjson');

function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const out = fs.createWriteStream(OUT);
  for (const r of rows) {
    out.write(JSON.stringify({
      organisation_id: r.organisationId,
      organisation_name: r.organisationName,
      regulators: r.regulators,
      stored_domain: r.domain,
      canonical_domain: r.candidate_target_domain || (r.recommended_action === 'KEEP' ? r.domain : null),
      primary_cause: r.primary_cause,
      confidence: r.confidence,
      recommended_action: r.recommended_action,
      evidence: r.evidence,
    }) + '\n');
  }
  out.end(() => console.log('ledger rows:', rows.length, '->', OUT));
}

main();
