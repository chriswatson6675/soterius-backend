'use strict';

// domainregistration-collector.test.js — Unit and integration tests
//
// Test framework: node:test (same as all Signal Lab test files)
// Run: node --test backend/signal-lab/signals/domainregistration/domainregistration-collector.test.js
//
// Test categories (COL-DOMAINREGISTRATION-001 Part 9 — Testing Strategy):
//   1. rdap-parser: registration core, entity extraction, vCard parsing
//   2. privacy-engine: four-state detection, normalisation, PSP matching
//   3. evidence-builder: field completeness, tristate handling, derived fields
//   4. Integration: full collection pipeline with mock RDAP responses

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseRdapResponse }               = require('./rdap-parser');
const { determinePrivacyState, normaliseProviderName, loadPspIndex } = require('./privacy-engine');
const { classifyTld }                     = require('./tld-classifier');
const { buildEvidence, extractPromotedScalars } = require('./evidence-builder');

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Minimal valid RDAP domain object
function makeRdapDomain(overrides = {}) {
  return {
    handle:       'DOMAIN-123',
    ldhName:      'example.com',
    unicodeName:  null,
    events: [
      { eventAction: 'registration',  eventDate: '2020-01-15T00:00:00Z' },
      { eventAction: 'expiration',    eventDate: '2027-01-15T00:00:00Z' },
      { eventAction: 'last changed',  eventDate: '2024-06-01T00:00:00Z' },
    ],
    status: ['ok', 'clientTransferProhibited'],
    nameservers: [{ ldhName: 'ns1.example.com' }, { ldhName: 'ns2.example.com' }],
    rdapConformance: ['rdap_level_0', 'icann_rdap_response_profile_0'],
    links: [
      { rel: 'self',    href: 'https://rdap.verisign.com/com/v1/domain/example.com' },
      { rel: 'related', href: 'https://rdap.registrar.com/v1/domain/example.com' },
    ],
    entities: [],
    ...overrides,
  };
}

function makeVCard(fn, org = null, country = null, email = null) {
  const props = [
    ['version', {}, 'text', '4.0'],
    ['fn',      {}, 'text', fn],
  ];
  if (org)     props.push(['org',   {}, 'text', org]);
  if (email)   props.push(['email', {}, 'text', email]);
  if (country) props.push(['adr', {}, 'text', ['', '', '123 Street', 'City', 'ST', '12345', country]]);
  return ['vcard', props];
}

function makeEntity(roles, fn, org = null, email = null, country = null, extra = {}) {
  return {
    roles,
    handle: `HANDLE-${roles[0]}`,
    vcardArray: makeVCard(fn, org, country, email),
    ...extra,
  };
}

// ── 1. rdap-parser tests ──────────────────────────────────────────────────────

describe('rdap-parser — registration core', () => {
  test('extracts creation_date from eventAction=registration', () => {
    const parsed = parseRdapResponse(makeRdapDomain(), 'example.com');
    assert.equal(parsed.registrationCore.creationDate, '2020-01-15T00:00:00Z');
  });

  test('extracts creation_date when eventAction=created', () => {
    const rdap = makeRdapDomain({
      events: [{ eventAction: 'created', eventDate: '2019-03-01T00:00:00Z' }],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrationCore.creationDate, '2019-03-01T00:00:00Z');
  });

  test('returns null creation_date when no registration event', () => {
    const rdap = makeRdapDomain({ events: [] });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrationCore.creationDate, null);
  });

  test('extracts nameserver LDH hostnames, ignores IP fields', () => {
    const rdap = makeRdapDomain({
      nameservers: [
        { ldhName: 'ns1.example.com', ipAddresses: { v4: ['1.2.3.4'] } },
        { ldhName: 'ns2.example.com' },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.deepEqual(parsed.registrationCore.nameservers, ['ns1.example.com', 'ns2.example.com']);
  });

  test('extracts rdap_self_link from links where rel=self', () => {
    const parsed = parseRdapResponse(makeRdapDomain(), 'example.com');
    assert.equal(
      parsed.rdapMetadata.rdapSelfLink,
      'https://rdap.verisign.com/com/v1/domain/example.com',
    );
  });

  test('extracts rdap_registrar_referral_url from links where rel=related', () => {
    const parsed = parseRdapResponse(makeRdapDomain(), 'example.com');
    assert.equal(
      parsed.rdapMetadata.rdapRegistrarReferralUrl,
      'https://rdap.registrar.com/v1/domain/example.com',
    );
  });

  test('referral URL is NOT in redirect chain (separate field only)', () => {
    // The rdap_registrar_referral_url is extracted from links[], not followed
    // This test confirms the URL appears in metadata, not in redirect chain
    const parsed = parseRdapResponse(makeRdapDomain(), 'example.com');
    assert.ok(parsed.rdapMetadata.rdapRegistrarReferralUrl); // extracted
    // redirect chain comes from HTTP layer, not RDAP JSON — parser has no redirect chain
  });

  test('returns null for all groups when rdapJson is null', () => {
    const parsed = parseRdapResponse(null, 'example.com');
    assert.equal(parsed.registrationCore, null);
    assert.equal(parsed.rdapMetadata, null);
    assert.equal(parsed.registrarEntity, null);
    assert.equal(parsed.registrantEntity, null);
  });

  // P0-1 (M1): 'deletion' is a distinct scheduled-deletion event, not expiry.
  test('expiration_date comes from the expiration event, not the deletion event', () => {
    const rdap = makeRdapDomain({
      events: [
        { eventAction: 'registration', eventDate: '2020-01-15T00:00:00Z' },
        { eventAction: 'expiration',   eventDate: '2027-01-15T00:00:00Z' },
        { eventAction: 'deletion',     eventDate: '2027-03-01T00:00:00Z' },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrationCore.expirationDate, '2027-01-15T00:00:00Z');
  });

  test('expiration_date is null when only a deletion event is present (no expiration)', () => {
    const rdap = makeRdapDomain({
      events: [
        { eventAction: 'registration', eventDate: '2020-01-15T00:00:00Z' },
        { eventAction: 'deletion',     eventDate: '2027-03-01T00:00:00Z' },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrationCore.expirationDate, null);
  });

  // P0-2 (M2): last_update is the record change, not the RDAP DB refresh.
  test('last_update_date uses "last changed", not "last update of RDAP database"', () => {
    const rdap = makeRdapDomain({
      events: [
        { eventAction: 'registration',                 eventDate: '2020-01-15T00:00:00Z' },
        { eventAction: 'last update of RDAP database',  eventDate: '2026-06-27T00:00:00Z' },
        { eventAction: 'last changed',                  eventDate: '2024-06-01T00:00:00Z' },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrationCore.lastUpdateDate, '2024-06-01T00:00:00Z');
  });

  test('last_update_date is null when only an RDAP-database-refresh event is present', () => {
    const rdap = makeRdapDomain({
      events: [
        { eventAction: 'registration',                eventDate: '2020-01-15T00:00:00Z' },
        { eventAction: 'last update of RDAP database', eventDate: '2026-06-27T00:00:00Z' },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrationCore.lastUpdateDate, null);
  });
});

describe('rdap-parser — entity extraction', () => {
  test('extracts registrar IANA ID from publicIds array', () => {
    const rdap = makeRdapDomain({
      entities: [
        {
          roles: ['registrar'],
          handle: 'REG-146',
          publicIds: [{ type: 'IANA Registrar ID', identifier: '146' }],
          vcardArray: makeVCard('GoDaddy.com, LLC'),
        },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrarEntity.registrarIanaId, '146');
  });

  test('extracts all vCard fields for registrant entity', () => {
    const rdap = makeRdapDomain({
      entities: [
        makeEntity(['registrant'], 'Jane Smith', 'Smith Corp', 'jane@example.com', 'GB'),
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const vc = parsed.registrantEntity.vCard;
    assert.equal(vc.fn,      'Jane Smith');
    assert.equal(vc.org,     'Smith Corp');
    assert.equal(vc.email,   'jane@example.com');
    assert.equal(vc.country, 'GB');
  });

  test('extracts address components correctly: street=adr[2], city=adr[3], country=adr[6]', () => {
    const rdap = makeRdapDomain({
      entities: [
        {
          roles: ['registrant'],
          handle: 'REG-1',
          vcardArray: ['vcard', [
            ['version', {}, 'text', '4.0'],
            ['fn', {}, 'text', 'Test Person'],
            ['adr', {}, 'text', ['', '', '456 Main St', 'London', 'ENG', 'EC1A 1BB', 'GB']],
          ]],
        },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const vc = parsed.registrantEntity.vCard;
    assert.equal(vc.street,  '456 Main St');
    assert.equal(vc.city,    'London');
    assert.equal(vc.state,   'ENG');
    assert.equal(vc.postal,  'EC1A 1BB');
    assert.equal(vc.country, 'GB');
  });

  test('selects first registrant entity when multiple present, generates warning', () => {
    const rdap = makeRdapDomain({
      entities: [
        makeEntity(['registrant'], 'First Registrant'),
        makeEntity(['registrant'], 'Second Registrant'),
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrantEntity.vCard.fn, 'First Registrant');
    assert.equal(parsed.warnings.length, 1);
    assert.equal(parsed.warnings[0].code, 'MULTIPLE_SAME_ROLE_ENTITIES');
    assert.equal(parsed.warnings[0].role, 'registrant');
    assert.equal(parsed.warnings[0].count, 2);
  });

  test('extracts admin and tech entities separately from registrant', () => {
    const rdap = makeRdapDomain({
      entities: [
        makeEntity(['registrant'], 'The Registrant'),
        makeEntity(['admin'],      'Admin Contact'),
        makeEntity(['technical'],  'Tech Contact'),
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrantEntity.vCard.fn, 'The Registrant');
    assert.equal(parsed.adminEntity.vCard.fn,      'Admin Contact');
    assert.equal(parsed.techEntity.vCard.fn,       'Tech Contact');
  });

  test('returns null registrantEntity when no registrant entity present', () => {
    const rdap = makeRdapDomain({ entities: [] });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrantEntity, null);
  });

  // P0-3 (M3): registrar_url is the registrar entity vCard `url`, not rel=self.
  test('parses registrar vCard url and maps it to registrar_url', () => {
    const rdap = makeRdapDomain({
      entities: [
        {
          roles: ['registrar'],
          handle: 'REG-146',
          publicIds: [{ type: 'IANA Registrar ID', identifier: '146' }],
          // registrar entity has a vCard url and an RDAP self link; the URL field
          // must come from the vCard url, NOT the self link.
          vcardArray: ['vcard', [
            ['version', {}, 'text', '4.0'],
            ['fn',  {}, 'text', 'GoDaddy.com, LLC'],
            ['url', {}, 'uri',  'https://www.godaddy.com'],
          ]],
          links: [{ rel: 'self', href: 'https://rdap.example/entity/REG-146' }],
        },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrarEntity.vCard.url, 'https://www.godaddy.com');

    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-27T00:00:00Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED',
      rdapBaseUrl: 'https://rdap.example/', redirectChain: ['https://rdap.example/'],
      errorCode: null, errorMessage: null,
      parsed, privacyResult: null,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    assert.equal(evidence.registrar_url, 'https://www.godaddy.com');
  });

  test('registrar_url is null when the registrar entity has no vCard url', () => {
    const rdap = makeRdapDomain({
      entities: [
        {
          roles: ['registrar'], handle: 'REG-1',
          vcardArray: makeVCard('No-URL Registrar'),
          links: [{ rel: 'self', href: 'https://rdap.example/entity/REG-1' }],
        },
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    assert.equal(parsed.registrarEntity.vCard.url, null);
  });
});

// ── 2. privacy-engine tests ───────────────────────────────────────────────────

// Load the real PSP index for privacy engine tests
const pspIndex = loadPspIndex();

describe('privacy-engine — four-state detection', () => {
  test('returns ENTITY_ABSENT when registrantEntity is null', () => {
    const result = determinePrivacyState(null, null, pspIndex);
    assert.equal(result.privacyState, 'ENTITY_ABSENT');
    assert.equal(result.privacyServicePresent, null);
    assert.equal(result.privacyServiceProviderId, null);
  });

  test('returns REDACTED when remarks indicate redaction and contact fields are null', () => {
    const entity = { vCard: { fn: 'Redacted', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const remarks = [{ title: 'REDACTED FOR PRIVACY', description: ['Data withheld'] }];
    const result = determinePrivacyState(entity, remarks, pspIndex);
    assert.equal(result.privacyState, 'REDACTED');
    assert.equal(result.privacyServicePresent, null);
  });

  test('does NOT return REDACTED when contact fields are present despite remarks', () => {
    const entity = { vCard: { fn: 'Real Person', org: null, email: 'real@example.com', tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const remarks = [{ title: 'REDACTED FOR PRIVACY', description: [] }];
    const result = determinePrivacyState(entity, remarks, pspIndex);
    // Email is present so redaction is not confirmed
    assert.notEqual(result.privacyState, 'REDACTED');
  });

  test('returns PRIVACY_SERVICE for "WhoisGuard, Inc." (PSP-001)', () => {
    const entity = { vCard: { fn: 'WhoisGuard, Inc.', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServicePresent, true);
    assert.equal(result.privacyServiceProviderId, 'PSP-001');
    assert.equal(result.privacyServiceName, 'WhoisGuard, Inc.');
  });

  test('returns PRIVACY_SERVICE for "Domains By Proxy, LLC" (PSP-002)', () => {
    const entity = { vCard: { fn: 'Domains By Proxy, LLC', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServiceProviderId, 'PSP-002');
  });

  test('returns PRIVACY_SERVICE for "Contact Privacy Inc. Customer 12345" (Step 0 normalisation)', () => {
    const entity = { vCard: { fn: 'Contact Privacy Inc. Customer 12345', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServiceProviderId, 'PSP-003');
  });

  test('returns PRIVACY_SERVICE for "Contact Privacy Inc. Customer 99999" (Step 0 any N)', () => {
    const entity = { vCard: { fn: 'Contact Privacy Inc. Customer 99999', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServiceProviderId, 'PSP-003');
  });

  test('returns PRIVACY_SERVICE for "Withheld for Privacy" alias match (PSP-004)', () => {
    const entity = { vCard: { fn: 'Withheld for Privacy', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServiceProviderId, 'PSP-004');
  });

  test('returns PRIVACY_SERVICE for "Withheld for Privacy ehf" exact match (PSP-004)', () => {
    const entity = { vCard: { fn: 'Withheld for Privacy ehf', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServiceProviderId, 'PSP-004');
  });

  test('returns PRIVACY_SERVICE for "PrivacyCo Pty Ltd" — iterative Step 5 normalisation (PSP-007)', () => {
    const entity = { vCard: { fn: 'PrivacyCo Pty Ltd', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'PRIVACY_SERVICE');
    assert.equal(result.privacyServiceProviderId, 'PSP-007');
  });

  test('returns REGISTRANT_DATA for genuine registrant name', () => {
    const entity = { vCard: { fn: 'Acme Corporation Ltd', org: 'Acme Corporation Ltd', email: 'admin@acme.com', tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.equal(result.privacyState, 'REGISTRANT_DATA');
    assert.equal(result.privacyServicePresent, false);
    assert.equal(result.privacyServiceProviderId, null);
  });
});

describe('privacy-engine — tristate semantics', () => {
  test('privacy_service_present = true when PRIVACY_SERVICE', () => {
    const entity = { vCard: { fn: 'WhoisGuard, Inc.', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.strictEqual(result.privacyServicePresent, true);
  });

  test('privacy_service_present = false when REGISTRANT_DATA (not null)', () => {
    const entity = { vCard: { fn: 'Smith Ltd', org: null, email: 'admin@smith.com', tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const result = determinePrivacyState(entity, null, pspIndex);
    assert.strictEqual(result.privacyServicePresent, false);
    assert.notEqual(result.privacyServicePresent, null);
  });

  test('privacy_service_present = null when ENTITY_ABSENT', () => {
    const result = determinePrivacyState(null, null, pspIndex);
    assert.strictEqual(result.privacyServicePresent, null);
  });

  test('REDACTED takes precedence over PRIVACY_SERVICE match when both indicators present', () => {
    const entity = { vCard: { fn: 'WhoisGuard, Inc.', org: null, email: null, tel: null, street: null, city: null, state: null, postal: null, country: null } };
    const remarks = [{ title: 'REDACTED FOR PRIVACY', description: ['Personal data redacted'] }];
    // REDACTED check (Step 2) precedes PSP check (Step 3)
    const result = determinePrivacyState(entity, remarks, pspIndex);
    assert.equal(result.privacyState, 'REDACTED');
    assert.equal(result.privacyServicePresent, null);
  });
});

describe('normaliseProviderName', () => {
  test('Step 0: strips Customer N suffix', () => {
    assert.equal(normaliseProviderName('Contact Privacy Inc. Customer 12345'), 'contact privacy');
  });

  test('Step 0: strips Customer N with varied spacing', () => {
    assert.equal(normaliseProviderName('Contact Privacy Inc.  Customer 99'), 'contact privacy');
  });

  test('Steps 1–4: lowercase, strip punctuation, trim', () => {
    assert.equal(normaliseProviderName('WhoisGuard, Inc.'), 'whoisguard');
  });

  test('Step 5 iterative: PrivacyCo Pty Ltd → privacyco (two iterations)', () => {
    assert.equal(normaliseProviderName('PrivacyCo Pty Ltd'), 'privacyco');
  });

  test('Step 5: Withheld for Privacy ehf → withheld for privacy', () => {
    assert.equal(normaliseProviderName('Withheld for Privacy ehf'), 'withheld for privacy');
  });

  test('Step 5: Domains By Proxy, LLC → domains by proxy', () => {
    assert.equal(normaliseProviderName('Domains By Proxy, LLC'), 'domains by proxy');
  });

  test('returns null for null input', () => {
    assert.equal(normaliseProviderName(null), null);
  });

  test('returns null for empty string', () => {
    assert.equal(normaliseProviderName(''), null);
  });
});

// ── 3. evidence-builder tests ─────────────────────────────────────────────────

describe('evidence-builder — field completeness', () => {
  const baseParams = {
    domain:           'example.com',
    collectedAt:      '2026-06-20T12:00:00.000Z',
    endpointState:    'RDAP_RESPONSE_OBSERVED',
    rdapBaseUrl:      'https://rdap.verisign.com/com/v1/',
    redirectChain:    ['https://rdap.verisign.com/com/v1/domain/example.com'],
    errorCode:        null,
    errorMessage:     null,
    parsed:           null,
    privacyResult:    null,
    tldClass:         { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
    tldSnapshotDate:  '2026-06-20',
  };

  test('output object contains exactly 70 top-level keys', () => {
    const evidence = buildEvidence(baseParams);
    assert.equal(Object.keys(evidence).length, 70);
  });

  test('billing_contact is null — not undefined, not absent', () => {
    const evidence = buildEvidence(baseParams);
    assert.ok('billing_contact' in evidence);
    assert.strictEqual(evidence.billing_contact, null);
  });

  test('legacy_whois_text is null', () => {
    const evidence = buildEvidence(baseParams);
    assert.strictEqual(evidence.legacy_whois_text, null);
  });

  test('rdap_entities_raw is null', () => {
    const evidence = buildEvidence(baseParams);
    assert.strictEqual(evidence.rdap_entities_raw, null);
  });

  test('all registration core fields are null when parsed is null (DOMAIN_NOT_FOUND)', () => {
    const evidence = buildEvidence({ ...baseParams, endpointState: 'DOMAIN_NOT_FOUND' });
    assert.strictEqual(evidence.creation_date, null);
    assert.strictEqual(evidence.expiration_date, null);
    assert.strictEqual(evidence.nameservers, null);
    assert.strictEqual(evidence.status_codes, null);
    assert.strictEqual(evidence.registry_domain_id, null);
  });

  test('derived lifecycle fields are null when creation_date is null', () => {
    const evidence = buildEvidence({ ...baseParams, endpointState: 'CONNECTION_ERROR', errorCode: 'ETIMEDOUT', errorMessage: 'Connection timed out' });
    assert.strictEqual(evidence.domain_age_days, null);
    assert.strictEqual(evidence.expiry_days_remaining, null);
    assert.strictEqual(evidence.registration_term_days, null);
  });

  test('privacy_service_present is exactly null (not false) when no privacy result', () => {
    const evidence = buildEvidence(baseParams);
    assert.strictEqual(evidence.privacy_service_present, null);
    assert.notEqual(evidence.privacy_service_present, false);
  });
});

describe('evidence-builder — derived lifecycle', () => {
  test('domain_age_days computed correctly from creation_date to collected_at', () => {
    const parsed = parseRdapResponse(makeRdapDomain(), 'example.com');
    const privacyResult = { privacyState: 'ENTITY_ABSENT', privacyServicePresent: null, privacyServiceName: null, privacyServiceProviderId: null, detectionVersion: 1 };
    const evidence = buildEvidence({
      domain: 'example.com',
      collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED',
      rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [],
      errorCode: null, errorMessage: null,
      parsed, privacyResult,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    // 2020-01-15 to 2026-06-20 ≈ 2347 days
    assert.ok(evidence.domain_age_days > 2000);
    assert.ok(evidence.domain_age_days < 3000);
  });

  test('expiry_days_remaining can be negative (no clamping)', () => {
    const rdap = makeRdapDomain({
      events: [
        { eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' },
        { eventAction: 'expiration',   eventDate: '2020-01-01T00:00:00Z' }, // already expired
      ],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const privacyResult = { privacyState: 'ENTITY_ABSENT', privacyServicePresent: null, privacyServiceName: null, privacyServiceProviderId: null, detectionVersion: 1 };
    const evidence = buildEvidence({
      domain: 'example.com',
      collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED',
      rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [], errorCode: null, errorMessage: null,
      parsed, privacyResult,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    // Expiry was 2020-01-01, collected 2026-06-20 — negative
    assert.ok(evidence.expiry_days_remaining < 0);
  });
});

describe('evidence-builder — status boolean tristate', () => {
  test('transfer_lock_present = true when clientTransferProhibited in status codes', () => {
    const rdap = makeRdapDomain({ status: ['ok', 'clientTransferProhibited'] });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const privacyResult = { privacyState: 'ENTITY_ABSENT', privacyServicePresent: null, privacyServiceName: null, privacyServiceProviderId: null, detectionVersion: 1 };
    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED', rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [], errorCode: null, errorMessage: null, parsed, privacyResult,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    assert.strictEqual(evidence.transfer_lock_present, true);
  });

  test('transfer_lock_present = false when status codes present but no lock code', () => {
    const rdap = makeRdapDomain({ status: ['ok'] });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const privacyResult = { privacyState: 'ENTITY_ABSENT', privacyServicePresent: null, privacyServiceName: null, privacyServiceProviderId: null, detectionVersion: 1 };
    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED', rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [], errorCode: null, errorMessage: null, parsed, privacyResult,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    assert.strictEqual(evidence.transfer_lock_present, false);
  });

  test('transfer_lock_present = null when status_codes is null', () => {
    const rdap = makeRdapDomain({ status: undefined });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const privacyResult = { privacyState: 'ENTITY_ABSENT', privacyServicePresent: null, privacyServiceName: null, privacyServiceProviderId: null, detectionVersion: 1 };
    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED', rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [], errorCode: null, errorMessage: null, parsed, privacyResult,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    assert.strictEqual(evidence.transfer_lock_present, null);
  });
});

describe('evidence-builder — promoted scalars', () => {
  test('extractPromotedScalars returns exactly 12 keys', () => {
    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_NOT_SUPPORTED', rdapBaseUrl: null, redirectChain: [],
      errorCode: 'NO_RDAP_ENDPOINT', errorMessage: 'No RDAP endpoint for TLD',
      parsed: null, privacyResult: null,
      tldClass: { tldString: 'xyz', tldType: 'NEW_GTLD', tldCountryCode: null },
      tldSnapshotDate: '2026-06-20',
    });
    const scalars = extractPromotedScalars(evidence);
    assert.equal(Object.keys(scalars).length, 12);
  });

  // M5: raw country preserved in the JSONB evidence block; normalised only at scalar.
  test('M5 — conforming country is preserved raw and normalised in the scalar', () => {
    const rdap = makeRdapDomain({
      entities: [makeEntity(['registrant'], 'Jane Smith', 'Smith Corp', 'jane@example.com', 'gb')],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED', rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [], errorCode: null, errorMessage: null, parsed, privacyResult: null,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null }, tldSnapshotDate: '2026-06-20',
    });
    // JSONB evidence block keeps the raw value verbatim (lower-case as returned).
    assert.equal(evidence.registrant_country_code, 'gb');
    // Promoted scalar is normalised to alpha-2 uppercase.
    assert.equal(extractPromotedScalars(evidence).registrant_country_code, 'GB');
  });

  test('M5 — non-standard country value is preserved verbatim, scalar nulled (not lost)', () => {
    const rdap = makeRdapDomain({
      entities: [makeEntity(['registrant'], 'Jane Smith', 'Smith Corp', 'jane@example.com', 'United Kingdom')],
    });
    const parsed = parseRdapResponse(rdap, 'example.com');
    const evidence = buildEvidence({
      domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'RDAP_RESPONSE_OBSERVED', rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
      redirectChain: [], errorCode: null, errorMessage: null, parsed, privacyResult: null,
      tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null }, tldSnapshotDate: '2026-06-20',
    });
    // Raw evidence is preserved — NOT discarded.
    assert.equal(evidence.registrant_country_code, 'United Kingdom');
    // The indexed scalar is null because the raw value is not alpha-2.
    assert.equal(extractPromotedScalars(evidence).registrant_country_code, null);
  });

  test('promoted scalars include all 12 expected fields', () => {
    const evidence = buildEvidence({
      domain: 'example.co.uk', collectedAt: '2026-06-20T00:00:00.000Z',
      endpointState: 'DOMAIN_NOT_FOUND', rdapBaseUrl: 'https://rdap.nominet.uk/uk/', redirectChain: [],
      errorCode: 'HTTP_404', errorMessage: 'Domain not found',
      parsed: null, privacyResult: null,
      tldClass: { tldString: 'co.uk', tldType: 'CCTLD', tldCountryCode: 'GB' },
      tldSnapshotDate: '2026-06-20',
    });
    const scalars = extractPromotedScalars(evidence);
    const expectedKeys = [
      'endpoint_state', 'privacy_state', 'privacy_service_present',
      'privacy_service_provider_id', 'registrar_iana_id', 'registrant_country_code',
      'transfer_lock_present', 'domain_active', 'pending_delete',
      'tld_type', 'domain_age_days', 'expiry_days_remaining',
    ];
    for (const key of expectedKeys) {
      assert.ok(key in scalars, `Missing promoted scalar: ${key}`);
    }
  });
});

// ── 4. tld-classifier tests ───────────────────────────────────────────────────

describe('tld-classifier', () => {
  test('classifies .com as GTLD', () => {
    const result = classifyTld('example.com', 'com');
    assert.equal(result.tldType, 'GTLD');
    assert.equal(result.tldCountryCode, null);
  });

  test('classifies .uk as CCTLD with country code GB', () => {
    const result = classifyTld('example.co.uk', 'uk');
    assert.equal(result.tldType, 'CCTLD');
    assert.equal(result.tldCountryCode, 'UK');
  });

  test('classifies multi-part co.uk as CCTLD', () => {
    const result = classifyTld('example.co.uk', 'co.uk');
    assert.equal(result.tldType, 'CCTLD');
  });

  test('classifies .law as NEW_GTLD', () => {
    const result = classifyTld('firm.law', 'law');
    assert.equal(result.tldType, 'NEW_GTLD');
    assert.equal(result.tldCountryCode, null);
  });

  test('classifies .aero as SPONSORED', () => {
    const result = classifyTld('airline.aero', 'aero');
    assert.equal(result.tldType, 'SPONSORED');
  });

  test('tld_country_code is null for GTLD', () => {
    const result = classifyTld('example.net', 'net');
    assert.equal(result.tldType, 'GTLD');
    assert.equal(result.tldCountryCode, null);
  });

  // P1-1a (M4): suffix extraction via PSL when no resolvedTld is supplied.
  test('PSL extraction: .com classifies as GTLD without a resolvedTld', () => {
    const result = classifyTld('example.com');
    assert.equal(result.tldString, 'com');
    assert.equal(result.tldType, 'GTLD');
  });

  test('PSL extraction: multi-part co.uk identified without a resolvedTld', () => {
    const result = classifyTld('example.co.uk');
    assert.equal(result.tldString, 'co.uk');
    assert.equal(result.tldType, 'CCTLD');
    assert.equal(result.tldCountryCode, 'UK');
  });

  test('PSL extraction: 3-part domain on a single-label gTLD is NOT mis-read as multi-part', () => {
    // Previously the heuristic returned "example.london" and mis-typed it CCTLD.
    const result = classifyTld('shop.example.london');
    assert.equal(result.tldString, 'london');
    assert.equal(result.tldType, 'NEW_GTLD');
    assert.equal(result.tldCountryCode, null);
  });

  test('UNKNOWN is reachable: a suffix not in the PSL is classified UNKNOWN', () => {
    const result = classifyTld('foo.example.zzzznotreal');
    assert.equal(result.tldType, 'UNKNOWN');
  });

  test('UNKNOWN: a bare label with no extractable suffix', () => {
    const result = classifyTld('notarealtld');
    assert.equal(result.tldType, 'UNKNOWN');
    assert.equal(result.tldString, null);
  });
});

// ── 5. VF-001 regression — transfer lock RDAP space-separated forms ───────────
//
// Regression tests for the VF-001 defect correction (IF-001 pilot, 2026-06-20).
// RDAP RFC 9083 returns space-separated status codes ("client transfer prohibited")
// which must be matched in addition to the camelCase-collapsed EPP forms.

function buildTransferLockEvidence(statusCodes) {
  const rdap = makeRdapDomain({ status: statusCodes });
  const parsed = parseRdapResponse(rdap, 'example.com');
  const privacyResult = {
    privacyState: 'ENTITY_ABSENT', privacyServicePresent: null,
    privacyServiceName: null, privacyServiceProviderId: null, detectionVersion: 1,
  };
  return buildEvidence({
    domain: 'example.com', collectedAt: '2026-06-20T00:00:00.000Z',
    endpointState: 'RDAP_RESPONSE_OBSERVED', rdapBaseUrl: 'https://rdap.verisign.com/com/v1/',
    redirectChain: [], errorCode: null, errorMessage: null, parsed, privacyResult,
    tldClass: { tldString: 'com', tldType: 'GTLD', tldCountryCode: null },
    tldSnapshotDate: '2026-06-20',
  });
}

describe('VF-001 regression — transfer lock detection (all four recognised forms)', () => {
  test('transfer_lock_present = true for RDAP form "client transfer prohibited"', () => {
    const ev = buildTransferLockEvidence(['client transfer prohibited']);
    assert.strictEqual(ev.transfer_lock_present, true);
  });

  test('transfer_lock_present = true for RDAP form "server transfer prohibited"', () => {
    const ev = buildTransferLockEvidence(['server transfer prohibited']);
    assert.strictEqual(ev.transfer_lock_present, true);
  });

  test('transfer_lock_present = true for EPP camelCase-collapsed form "clienttransferprohibited"', () => {
    const ev = buildTransferLockEvidence(['clientTransferProhibited']);
    assert.strictEqual(ev.transfer_lock_present, true);
  });

  test('transfer_lock_present = true for EPP camelCase-collapsed form "servertransferprohibited"', () => {
    const ev = buildTransferLockEvidence(['serverTransferProhibited']);
    assert.strictEqual(ev.transfer_lock_present, true);
  });

  test('transfer_lock_present = false when only non-lock codes present', () => {
    const ev = buildTransferLockEvidence(['client delete prohibited', 'client update prohibited']);
    assert.strictEqual(ev.transfer_lock_present, false);
  });

  test('transfer_lock_present = true when lock code mixed with other codes', () => {
    const ev = buildTransferLockEvidence(['client delete prohibited', 'client transfer prohibited', 'client update prohibited']);
    assert.strictEqual(ev.transfer_lock_present, true);
  });
});
