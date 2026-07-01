'use strict';

// emailinfra.test.js — SOT-EMAILINFRA-001 conformance test suite (H1).
//
// Establishes the previously-absent automated coverage for the second Category F
// signal. No live DNS, no database: a fake resolver and an inline fixture dataset
// drive the two-layer pipeline (Layer A collector → Layer B two-key attribution →
// Layer C composition).
//
// Run: node --test backend/signal-lab/signals/emailinfra/emailinfra.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildIndex, attributeHost } = require('./epr-attribution');
const { collectMx, classify } = require('./emailinfra-collector');
const { makeAttributor, attributeObservation } = require('./emailinfra-signal');
const { PSL_VERSION } = require('../dnsprovision/psl-processor');

const NOW = '2026-06-27T00:00:00.000Z';
const SUBJECT = 'acme.com';

const DATASET = {
  dataset_id: 'EPR-DATA-001', dataset_version: 1, governed_by: 'EPR-001 (test)',
  entries: [
    { provider_id: 'EMXP-001', provider_name: 'Google Workspace', provider_class: 'mailbox', status: 'ACTIVE',
      attribution_keys: [{ value: 'google.com', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-002', provider_name: 'Microsoft 365',   provider_class: 'mailbox', status: 'ACTIVE',
      attribution_keys: [{ value: 'outlook.com', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-003', provider_name: 'Mimecast',        provider_class: 'gateway', status: 'ACTIVE',
      attribution_keys: [{ value: 'mimecast.com', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-SUF', provider_name: 'SuffixCo',        provider_class: 'mailbox', status: 'ACTIVE',
      attribution_keys: [{ value: 'mail.protection.suffixco.net', match_type: 'DOCUMENTED_SUFFIX' }] },
    // suffix-vs-etld1 precedence pair: a host under mx.preccloud.net matches the
    // DOCUMENTED_SUFFIX (gateway) AND its eTLD+1 preccloud.net (mailbox) — suffix must win.
    { provider_id: 'EMXP-SUFP', provider_name: 'SuffixPrec',     provider_class: 'gateway', status: 'ACTIVE',
      attribution_keys: [{ value: 'mx.preccloud.net', match_type: 'DOCUMENTED_SUFFIX' }] },
    { provider_id: 'EMXP-ETP',  provider_name: 'EtldPrec',       provider_class: 'mailbox', status: 'ACTIVE',
      attribution_keys: [{ value: 'preccloud.net', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-OLD',  provider_name: 'Retired',        provider_class: 'mailbox', status: 'RETIRED',
      attribution_keys: [{ value: 'oldmail.com', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-DUPA', provider_name: 'Dup A',          provider_class: 'mailbox', status: 'ACTIVE',
      attribution_keys: [{ value: 'dupmail.com', match_type: 'ETLD1' }] },
    { provider_id: 'EMXP-DUPB', provider_name: 'Dup B',          provider_class: 'mailbox', status: 'ACTIVE',
      attribution_keys: [{ value: 'dupmail.com', match_type: 'ETLD1' }] },
  ],
};

const attributor = makeAttributor(DATASET);
const idx = buildIndex(DATASET);

const mx = (host, priority) => ({ host, priority });
function obs(mx_hosts, status = 'OK') {
  return { has_mx: mx_hosts.length > 0, mx_hosts, status };
}
function row(mx_hosts, status = 'OK', subject = SUBJECT) {
  return attributeObservation(subject, obs(mx_hosts, status), attributor, NOW);
}

// ── Layer B: index ────────────────────────────────────────────────────────────────

describe('epr-attribution — index build', () => {
  test('ignores non-ACTIVE entries', () => {
    assert.ok(idx.etld1Index.has('google.com'));
    assert.ok(!idx.etld1Index.has('oldmail.com'), 'RETIRED entry must not be indexed');
  });
  test('detects duplicate key values across providers', () => {
    assert.ok(idx.duplicates.has('dupmail.com'));
  });
});

// ── Layer B: two-key attribution (SOT §5 / EPR-001 §7) ────────────────────────────

describe('epr-attribution — attributeHost', () => {
  test('MAPPED via ETLD1', () => {
    const a = attributeHost('alt1.aspmx.l.google.com', 10, SUBJECT, idx);
    assert.equal(a.match_status, 'MAPPED');
    assert.equal(a.match_type, 'ETLD1');
    assert.equal(a.provider_id, 'EMXP-001');
    assert.equal(a.provider_class, 'mailbox');
  });
  test('MAPPED via DOCUMENTED_SUFFIX', () => {
    const a = attributeHost('acme-com.mail.protection.suffixco.net', 10, SUBJECT, idx);
    assert.equal(a.match_status, 'MAPPED');
    assert.equal(a.match_type, 'DOCUMENTED_SUFFIX');
    assert.equal(a.provider_id, 'EMXP-SUF');
  });
  test('precedence: DOCUMENTED_SUFFIX wins over ETLD1 when both match', () => {
    const a = attributeHost('a.mx.preccloud.net', 10, SUBJECT, idx);
    assert.equal(a.match_type, 'DOCUMENTED_SUFFIX');
    assert.equal(a.provider_id, 'EMXP-SUFP');
  });
  test('SELF_HOSTED when MX-host eTLD+1 equals subject eTLD+1', () => {
    const a = attributeHost('mail.acme.com', 10, SUBJECT, idx);
    assert.equal(a.match_status, 'SELF_HOSTED');
    assert.equal(a.provider_id, null);
  });
  test('UNMAPPED when no key matches and not self-hosted', () => {
    const a = attributeHost('mx.randomhost.xyz', 10, SUBJECT, idx);
    assert.equal(a.match_status, 'UNMAPPED');
  });
  test('ATTRIBUTION_AMBIGUOUS when matched key is duplicated across providers', () => {
    const a = attributeHost('mx.dupmail.com', 10, SUBJECT, idx);
    assert.equal(a.match_status, 'ATTRIBUTION_AMBIGUOUS');
    assert.equal(a.provider_id, null);
  });
});

// ── Layer C: provision-model derivation (SOT §5/§6) ───────────────────────────────

describe('signal — provision model & composition', () => {
  test('THIRD_PARTY_SINGLE: all MX one provider; primary by lowest priority', () => {
    const r = row([mx('alt1.aspmx.l.google.com', 10), mx('aspmx.l.google.com', 1)]);
    assert.equal(r.email_provision_model, 'THIRD_PARTY_SINGLE');
    assert.equal(r.email_provider_id, 'EMXP-001');
    assert.equal(r.primary_email_provider_id, 'EMXP-001');
    assert.equal(r.primary_provider_class, 'mailbox');
    assert.equal(r.multi_provider, false);
    assert.equal(r.distinct_email_operator_count, 1);
    assert.equal(r.has_gateway, false);
  });
  test('THIRD_PARTY_MULTI: two distinct providers; no single email_provider_id', () => {
    const r = row([mx('aspmx.l.google.com', 1), mx('acme.mail.outlook.com', 5)]);
    assert.equal(r.email_provision_model, 'THIRD_PARTY_MULTI');
    assert.equal(r.email_provider_id, null);
    assert.equal(r.distinct_email_operator_count, 2);
    assert.equal(r.multi_provider, true);
  });
  test('SELF_HOSTED', () => {
    assert.equal(row([mx('mail.acme.com', 10)]).email_provision_model, 'SELF_HOSTED');
  });
  test('MIXED: mapped + self-hosted', () => {
    assert.equal(row([mx('aspmx.l.google.com', 1), mx('mail.acme.com', 10)]).email_provision_model, 'MIXED');
  });
  test('UNDETERMINED: all unmapped (MX present)', () => {
    const r = row([mx('mx.randomhost.xyz', 10)]);
    assert.equal(r.email_provision_model, 'UNDETERMINED');
    assert.equal(r.collection_status, 'OK');
  });
});

// ── Backend never inferred (§5/§7) ────────────────────────────────────────────────

describe('signal — backend never inferred', () => {
  test('gateway MX is recorded as the observable provider; no backend inferred', () => {
    const r = row([mx('mx.mimecast.com', 5), mx('aspmx.l.google.com', 10)]);
    assert.equal(r.has_gateway, true);
    assert.equal(r.primary_email_provider_id, 'EMXP-003');  // lowest priority = gateway
    assert.equal(r.primary_provider_class, 'gateway');
    const gw = r.attributions.find(a => a.provider_id === 'EMXP-003');
    assert.equal(gw.provider_class, 'gateway');
    // no field anywhere implies a backend behind the gateway
    const keys = JSON.stringify(r).toLowerCase();
    assert.ok(!keys.includes('backend'), 'no backend may be inferred or stored');
  });
});

// ── M1: non-observation handling (NO_MAIL → null) ─────────────────────────────────

describe('signal — M1 non-observation handling', () => {
  test('NO_MX (observed absence): email_provision_model null; has_mx false; status preserved', () => {
    const r = row([], 'NO_MX');
    assert.equal(r.email_provision_model, null, 'must not assert an out-of-vocabulary NO_MAIL value');
    assert.equal(r.has_mx, false);
    assert.equal(r.collection_status, 'NO_MX');
  });
  test('MX_UNRESOLVED (non-observation): null model; distinguishable via collection_status', () => {
    const absence = row([], 'NO_MX');
    const failure = row([], 'MX_UNRESOLVED');
    assert.equal(absence.email_provision_model, null);
    assert.equal(failure.email_provision_model, null);
    assert.notEqual(absence.collection_status, failure.collection_status);
  });
});

// ── M2: mx_zones[] emitted (§6.1) ─────────────────────────────────────────────────

describe('signal — M2 mx_zones evidence field', () => {
  test('mx_zones is the deduped eTLD+1 set across MX hosts', () => {
    const r = row([mx('alt1.aspmx.l.google.com', 10), mx('aspmx.l.google.com', 1)]);
    assert.deepEqual(r.mx_zones, ['google.com']);
  });
  test('mx_zones spans multiple providers, sorted', () => {
    const r = row([mx('aspmx.l.google.com', 1), mx('acme.mail.outlook.com', 5)]);
    assert.deepEqual(r.mx_zones, ['google.com', 'outlook.com']);
  });
  test('mx_zones is empty when no MX observed', () => {
    assert.deepEqual(row([], 'NO_MX').mx_zones, []);
  });
});

// ── Reproducibility metadata (§6.1) ───────────────────────────────────────────────

describe('signal — reproducibility metadata', () => {
  test('records dataset version, PSL version, spec/collector versions, timestamp', () => {
    const r = row([mx('aspmx.l.google.com', 1)]);
    assert.equal(r.epr_dataset_version, 'EPR-DATA-001/v1');
    assert.equal(r.psl_version, PSL_VERSION);
    assert.ok(r.signal_version);
    assert.ok(r.collector_version);
    assert.equal(r.collection_timestamp, NOW);
  });
});

// ── Layer A: collector normalisation + classification ─────────────────────────────

describe('collector — Layer A', () => {
  test('MX deduped/lowercased/trailing-dot-stripped and sorted by priority', async () => {
    const resolver = { resolveMx: async () => [
      { exchange: 'ALT1.ASPMX.L.GOOGLE.COM.', priority: 10 },
      { exchange: 'aspmx.l.google.com', priority: 1 },
    ] };
    const out = await collectMx('ACME.com', resolver);
    assert.equal(out.has_mx, true);
    assert.equal(out.status, 'OK');
    assert.deepEqual(out.mx_hosts.map(m => m.host), ['aspmx.l.google.com', 'alt1.aspmx.l.google.com']);
  });
  test('null MX (RFC 7505 ".") yields NO_MX (no transport)', async () => {
    const resolver = { resolveMx: async () => [{ exchange: '.', priority: 0 }] };
    const out = await collectMx('acme.com', resolver);
    assert.equal(out.has_mx, false);
    assert.equal(out.status, 'NO_MX');
  });
  test('empty MX list yields NO_MX', async () => {
    const out = await collectMx('acme.com', { resolveMx: async () => [] });
    assert.equal(out.status, 'NO_MX');
  });
  test('classify maps DNS error codes', () => {
    assert.equal(classify({ code: 'ETIMEDOUT' }), 'DNS_TIMEOUT');
    assert.equal(classify({ code: 'ENODATA' }), 'ABSENT');
    assert.equal(classify({ code: 'ESERVFAIL' }), 'DNS_FAILURE');
  });
});
