'use strict';

// SECURITYHEADERS-QM-v1.0 unit tests.
// Model: SLG-116 (structure) / SLG-117 (calibration) / SLG-118 (validation) /
//        SLG-120 (freeze).
// Run: node --test backend/observatory/quality/securityheaders-quality.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreSecurityHeadersQuality, MODEL_ID, QUALITY_VERSION, DORMANT_HEADERS,
} = require('./securityheaders-quality');

// Build a signal_securityheaders_v1-shaped row from a list of present field names.
// Absent headers are emitted with present:false to mirror the real collector,
// which always emits all 25 fields (present:false when endpoint not observed or
// header not seen).
const ALL_FIELDS = [
  'strict_transport_security', 'content_security_policy', 'content_security_policy_report_only',
  'x_frame_options', 'x_content_type_options', 'referrer_policy', 'permissions_policy',
  'cross_origin_opener_policy', 'cross_origin_embedder_policy', 'cross_origin_resource_policy',
  'server', 'x_powered_by', ...DORMANT_HEADERS,
];

function facts(present = [], endpoint_state = 'RESPONSE_OBSERVED') {
  const inv = {};
  for (const f of ALL_FIELDS) {
    inv[f] = present.includes(f)
      ? { present: true, count: 1, values: ['x'], first_position: 1 }
      : { present: false, count: 0, values: [], first_position: null };
  }
  return { domain: 'example.test', endpoint_state, header_inventory: inv };
}

const scoreOf = (present, state) => scoreSecurityHeadersQuality(facts(present, state)).score;

describe('SECURITYHEADERS-QM-v1.0 — identity', () => {
  it('reports the frozen model id and version', () => {
    assert.equal(MODEL_ID, 'SECURITYHEADERS-QM-v1.0');
    assert.equal(QUALITY_VERSION, '1.0');
  });
});

// ── Ground truth: the five representative organisations traced digit-for-digit
//    in SLG-118 §3. These are the authoritative calibration acceptance tests. ──
describe('SLG-118 §3 — representative organisations (exact scores)', () => {
  it('Top 1% eurotunnel.com = 92 (all 6 candidates + COOP-only partial + full allowance)', () => {
    assert.equal(scoreOf([
      'strict_transport_security', 'content_security_policy', 'x_frame_options',
      'x_content_type_options', 'referrer_policy', 'permissions_policy',
      'cross_origin_opener_policy',
    ]), 92);
  });

  it('Top 10% latif-adams.co.uk = 71 (Tier1+Tier2, Server present)', () => {
    assert.equal(scoreOf([
      'strict_transport_security', 'content_security_policy',
      'x_frame_options', 'x_content_type_options', 'server',
    ]), 71);
  });

  it('Median mfa-ifa.co.uk = 19 (XCTO only, Server present)', () => {
    assert.equal(scoreOf(['x_content_type_options', 'server']), 19);
  });

  it('Bottom 10% milestonewealth.co.uk = 0 (no candidates, both disclosure headers)', () => {
    assert.equal(scoreOf(['server', 'x_powered_by']), 0);
  });

  it('Bottom 1% apexlawyersltd.com = 0 (identical tied-floor composition)', () => {
    assert.equal(scoreOf(['server', 'x_powered_by']), 0);
  });
});

// ── SLG-117 §4 — the three verified disclosure-allowance populations. ──────────
describe('SLG-117 §4 — disclosure-allowance verified populations', () => {
  it('zero candidates + both disclosure headers → 0 (allowance 10−3−7)', () => {
    assert.equal(scoreOf(['server', 'x_powered_by']), 0);
  });
  it('zero candidates + Server only → 7 (the 24.98% national mass)', () => {
    assert.equal(scoreOf(['server']), 7);
  });
  it('zero candidates + neither disclosure header → 10 (full allowance)', () => {
    assert.equal(scoreOf([]), 10);
  });
  it('X-Powered-By only → 3 (allowance 10−7)', () => {
    assert.equal(scoreOf(['x_powered_by']), 3);
  });
});

// ── Real observation captured during the Bain Capital scan (2026-07-10). ───────
describe('Live observation — baincapitalcredit.com', () => {
  it('XFO + XCTO + Server + X-Powered-By = 24', () => {
    assert.equal(scoreOf([
      'x_frame_options', 'x_content_type_options', 'server', 'x_powered_by',
    ]), 24);
  });
});

// ── Structural bounds. ─────────────────────────────────────────────────────────
describe('structural bounds', () => {
  it('maximum composition = 100 (candidates 80 + CSP-RO 2 + isolation 5 + CORP 3 + allowance 10)', () => {
    assert.equal(scoreOf([
      'strict_transport_security', 'content_security_policy', 'x_frame_options',
      'x_content_type_options', 'referrer_policy', 'permissions_policy',
      'content_security_policy_report_only', 'cross_origin_opener_policy',
      'cross_origin_embedder_policy', 'cross_origin_resource_policy',
    ]), 100);
  });
  it('score never exceeds 100 and never below 0', () => {
    for (const combo of [[], ['server', 'x_powered_by'], ALL_FIELDS]) {
      const s = scoreOf(combo);
      assert.ok(s >= 0 && s <= 100, `score ${s} out of range`);
    }
  });
});

// ── Unknown ≠ Absent (SLG-116 §2). ─────────────────────────────────────────────
describe('unknown-state exclusion', () => {
  for (const state of ['TIMEOUT', 'TLS_ERROR', 'CONNECTION_ERROR', 'REDIRECT_UNRESOLVED']) {
    it(`endpoint_state=${state} → not scored (OBSERVATION_INCOMPLETE), never floored`, () => {
      const r = scoreSecurityHeadersQuality(facts(['server'], state));
      assert.equal(r.scored, false);
      assert.equal(r.reason, 'OBSERVATION_INCOMPLETE');
      assert.equal(r.score, null);
    });
  }
  it('null / missing facts → not scored', () => {
    assert.equal(scoreSecurityHeadersQuality(null).scored, false);
    assert.equal(scoreSecurityHeadersQuality({}).scored, false);
  });
  it('a RESPONSE_OBSERVED row with no protective headers IS scored (Absent, not Unknown)', () => {
    const r = scoreSecurityHeadersQuality(facts([]));
    assert.equal(r.scored, true);
    assert.equal(r.score, 10);
  });
});

// ── Contextual absence never penalises (SLG-116 §4). ───────────────────────────
describe('contextual absence is neutral', () => {
  it('forcing COOP/COEP/CORP absent leaves a candidate-only score unchanged', () => {
    const base = ['x_content_type_options', 'server'];               // = 19
    assert.equal(scoreOf(base), 19);
    // no contextual headers present → identical; their absence subtracts nothing.
    assert.equal(scoreOf([...base]), 19);
  });
});

// ── Cross-origin isolation bundle vs partial (SLG-116 §4 / SLG-117 §1). ─────────
describe('cross-origin isolation bonus', () => {
  it('COOP + COEP both present → +5 bundle', () => {
    assert.equal(scoreOf(['cross_origin_opener_policy', 'cross_origin_embedder_policy']), 15); // 10 + 5
  });
  it('COOP only → +2 partial', () => {
    assert.equal(scoreOf(['cross_origin_opener_policy']), 12);
  });
  it('COEP only → +2 partial', () => {
    assert.equal(scoreOf(['cross_origin_embedder_policy']), 12);
  });
  it('neither → +0', () => {
    assert.equal(scoreOf([]), 10);
  });
});

// ── CSP-Report-Only micro-modifier is conditional on CSP (SLG-116 §3.1). ───────
describe('CSP-Report-Only conditional micro-modifier', () => {
  it('CSP + CSP-Report-Only → +2 over CSP alone', () => {
    assert.equal(scoreOf(['content_security_policy']), 30);                                  // 20 + 10
    assert.equal(scoreOf(['content_security_policy', 'content_security_policy_report_only']), 32);
  });
  it('CSP-Report-Only alone (no enforcing CSP) earns nothing', () => {
    assert.equal(scoreOf(['content_security_policy_report_only']), 10);                       // allowance only
  });
});

// ── Dormant headers contribute nothing (SLG-116 §6). ───────────────────────────
describe('dormant headers excluded', () => {
  it('adding all 13 dormant headers does not change the score', () => {
    const base = ['x_content_type_options', 'server'];
    assert.equal(scoreOf(base), 19);
    assert.equal(scoreOf([...base, ...DORMANT_HEADERS]), 19);
  });
  it('observed dormant headers are flagged for reporting only', () => {
    const r = scoreSecurityHeadersQuality(facts(['report_to', 'x_xss_protection']));
    assert.equal(r.score, 10);                                     // unchanged by dormant presence
    assert.ok(r.flags.includes('DORMANT_HEADERS_OBSERVED'));
    assert.deepEqual(r.evidence.dormantObserved.sort(), ['report_to', 'x_xss_protection']);
  });
});

// ── Per-header sensitivity reproduces SLG-117 §6 exactly. ──────────────────────
describe('SLG-117 §6 — per-header sensitivity (present − absent delta = assigned weight)', () => {
  const delta = (field, base = []) => scoreOf([...base, field]) - scoreOf(base);
  it('Content-Security-Policy = +20', () => assert.equal(delta('content_security_policy'), 20));
  it('Strict-Transport-Security = +20', () => assert.equal(delta('strict_transport_security'), 20));
  it('X-Frame-Options = +12', () => assert.equal(delta('x_frame_options'), 12));
  it('X-Content-Type-Options = +12', () => assert.equal(delta('x_content_type_options'), 12));
  it('Referrer-Policy = +8', () => assert.equal(delta('referrer_policy'), 8));
  it('Permissions-Policy = +8', () => assert.equal(delta('permissions_policy'), 8));
  it('CORP = +3', () => assert.equal(delta('cross_origin_resource_policy'), 3));
  it('COOP (partial) = +2', () => assert.equal(delta('cross_origin_opener_policy'), 2));
  it('COEP (partial) = +2', () => assert.equal(delta('cross_origin_embedder_policy'), 2));
  it('Server = −3', () => assert.equal(delta('server'), -3));
  it('X-Powered-By = −7', () => assert.equal(delta('x_powered_by'), -7));
  it('CSP-Report-Only (with CSP present) = +2', () => {
    assert.equal(delta('content_security_policy_report_only', ['content_security_policy']), 2);
  });
});

// ── Disclosure allowance floors at exactly 0, never compounds negative. ────────
describe('disclosure allowance floor', () => {
  it('a fully-loaded candidate domain loses exactly the 10-point allowance, no more', () => {
    const loaded = [
      'strict_transport_security', 'content_security_policy', 'x_frame_options',
      'x_content_type_options', 'referrer_policy', 'permissions_policy',
      'content_security_policy_report_only', 'cross_origin_opener_policy',
      'cross_origin_embedder_policy', 'cross_origin_resource_policy',
    ];
    assert.equal(scoreOf(loaded), 100);                            // allowance 10
    assert.equal(scoreOf([...loaded, 'server', 'x_powered_by']), 90); // allowance 0, exactly −10
  });
});
