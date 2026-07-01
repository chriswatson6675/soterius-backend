'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTransferSafeguard } = require('./detect-transfersafeguard');
const { deriveEvidence } = require('./observation-writer');

function present(r) { assert.equal(r.state, 'present'); assert.equal(r.form, 'named_mechanism'); assert.ok(r.rawValue); }
function absent(r) { assert.equal(r.state, 'absent'); assert.equal(r.rawValue, null); assert.equal(r.form, null); }

test('present — named Art 46 mechanisms', () => {
  present(detectTransferSafeguard('Transfers are protected by Standard Contractual Clauses.'));
  present(detectTransferSafeguard('We rely on the EU SCCs and the UK Addendum.'));
  present(detectTransferSafeguard('Data is transferred under the International Data Transfer Agreement (IDTA).'));
  present(detectTransferSafeguard('We use Binding Corporate Rules (BCRs) for intra-group transfers.'));
  present(detectTransferSafeguard('Transfers rely on an adequacy decision of the UK government.'));
  present(detectTransferSafeguard('Our US providers are certified under the EU-US Data Privacy Framework.'));
});

test('absent — transfers/generic safeguards but NO named mechanism', () => {
  absent(detectTransferSafeguard('We may transfer your data outside the UK to our providers.'));
  absent(detectTransferSafeguard('We ensure appropriate safeguards are in place for any transfer.'));
  absent(detectTransferSafeguard('This notice explains what data we collect and your rights.'));
});

test('absent — empty / invalid', () => {
  for (const v of ['', '   ', null, undefined, 123, {}]) absent(detectTransferSafeguard(v));
});

test('determinism', () => {
  const s = 'Protected by Standard Contractual Clauses.';
  assert.deepEqual(detectTransferSafeguard(s), detectTransferSafeguard(s));
});

test('raw value verbatim', () => {
  const r = detectTransferSafeguard('…safeguarded by Standard Contractual Clauses approved by the ICO…');
  assert.match(r.rawValue, /Standard Contractual Clauses/i);
});

// EM-H-D1 routing (writer)
test('EM-H-D1 — non-located => null evidence', () => {
  for (const st of ['not_located', 'retrieval_failure', 'ambiguous']) {
    const e = deriveEvidence(st, null, null);
    assert.equal(e.evidence_state, null); assert.equal(e.transfer_raw_value, null); assert.equal(e.transfer_form, null);
  }
});
test('partial retrieval — located + empty => indeterminate', () => {
  const e = deriveEvidence('located', '', detectTransferSafeguard(''));
  assert.equal(e.evidence_state, 'indeterminate');
});
test('located + content => detector fact', () => {
  const e = deriveEvidence('located', 'Standard Contractual Clauses', detectTransferSafeguard('Standard Contractual Clauses'));
  assert.equal(e.evidence_state, 'present'); assert.equal(e.transfer_form, 'named_mechanism'); assert.ok(e.transfer_raw_value);
});
