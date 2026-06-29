'use strict';

// rdap-parser.js — RDAP JSON field extraction and vCard parsing
//
// Parses a validated RDAP domain object (RFC 7483) into structured field objects.
// Pure functions only. No HTTP calls. No side effects.
//
// vCard format: jCard (RFC 7095) — arrays of [property, params, type, value]
//
// Entity selection rule (SOT-DOMAINREGISTRATION-001 §7.6):
//   When multiple entities share a role, the first in document order is selected.
//   A structured warning is generated and returned in the result.
//
// Authority: COL-DOMAINREGISTRATION-001 Part 5 — Parsing Architecture

// ── Constants ─────────────────────────────────────────────────────────────────

// eventAction strings that indicate creation date (registries vary)
const CREATION_ACTIONS  = new Set(['registration', 'created']);
// eventAction strings that indicate expiration date (§3.10 — registration term end).
// NOTE: RFC 7483 'deletion' is a distinct scheduled-deletion event, NOT the
// registration expiry, and is deliberately excluded (P0-1 / finding M1).
const EXPIRY_ACTIONS    = new Set(['expiration', 'expires', 'expiry']);
// eventAction strings that indicate last record modification (§3.11).
// NOTE: 'last update of rdap database' is the RDAP server's DB-refresh time, not
// a change to the domain record, and is deliberately excluded (P0-2 / finding M2).
const UPDATE_ACTIONS    = new Set(['last changed', 'updated']);

// ── Main parse function ───────────────────────────────────────────────────────

/**
 * Parses a validated RDAP domain JSON object into structured field groups.
 * Returns null for all groups if rdapJson is null (non-RDAP_RESPONSE_OBSERVED state).
 *
 * @param {Object|null} rdapJson - Parsed RDAP domain object
 * @param {string} domain - The queried domain (for warning context)
 * @returns {ParsedRdap}
 */
function parseRdapResponse(rdapJson, domain) {
  if (!rdapJson || typeof rdapJson !== 'object') {
    return _nullParsed();
  }

  const warnings = [];

  const registrationCore = _parseRegistrationCore(rdapJson);
  const rdapMetadata     = _parseRdapMetadata(rdapJson);
  const registrarEntity  = _parseEntityByRole(rdapJson.entities, 'registrar', domain, warnings);
  const registrantEntity = _parseEntityByRole(rdapJson.entities, 'registrant', domain, warnings);
  const adminEntity      = _parseEntityByRole(rdapJson.entities, 'admin', domain, warnings);
  const techEntity       = _parseEntityByRole(rdapJson.entities, 'technical', domain, warnings);

  return {
    registrationCore,
    rdapMetadata,
    registrarEntity,
    registrantEntity,
    adminEntity,
    techEntity,
    warnings,
  };
}

// ── Registration core ─────────────────────────────────────────────────────────

function _parseRegistrationCore(rdap) {
  const events = Array.isArray(rdap.events) ? rdap.events : [];

  return {
    registryDomainId: rdap.handle ?? null,
    domainNameLdh:    rdap.ldhName ?? null,
    domainNameUnicode: rdap.unicodeName ?? null,
    creationDate:     _findEventDate(events, CREATION_ACTIONS),
    expirationDate:   _findEventDate(events, EXPIRY_ACTIONS),
    lastUpdateDate:   _findEventDate(events, UPDATE_ACTIONS),
    nameservers:      _parseNameservers(rdap.nameservers),
    statusCodes:      Array.isArray(rdap.status) ? [...rdap.status] : null,
    eventHistory:     events.length > 0 ? events : null,
  };
}

function _findEventDate(events, actionSet) {
  const event = events.find(e => actionSet.has((e.eventAction ?? '').toLowerCase()));
  return event?.eventDate ?? null;
}

function _parseNameservers(nameserversArray) {
  if (!Array.isArray(nameserversArray) || nameserversArray.length === 0) return null;
  const hostnames = nameserversArray
    .map(ns => ns.ldhName ?? null)
    .filter(Boolean);
  return hostnames.length > 0 ? hostnames : null;
}

// ── RDAP metadata ─────────────────────────────────────────────────────────────

function _parseRdapMetadata(rdap) {
  const links = Array.isArray(rdap.links) ? rdap.links : [];

  return {
    rdapConformance:          Array.isArray(rdap.rdapConformance) ? rdap.rdapConformance : null,
    rdapRemarks:              Array.isArray(rdap.remarks) ? rdap.remarks : null,
    rdapNotices:              Array.isArray(rdap.notices) ? rdap.notices : null,
    rdapSelfLink:             _findLink(links, 'self'),
    rdapRegistrarReferralUrl: _findLink(links, 'related'),
  };
}

function _findLink(links, rel) {
  const link = links.find(l => l.rel === rel);
  return link?.href ?? null;
}

// ── Entity extraction ─────────────────────────────────────────────────────────

/**
 * Finds the first entity with the given role (document order per §7.6).
 * Generates a warning if multiple entities share the role.
 *
 * @param {Array|undefined} entities
 * @param {string} role - RDAP role string
 * @param {string} domain - For warning context
 * @param {Array} warnings - Mutated with any warnings
 * @returns {EntityFields|null}
 */
function _parseEntityByRole(entities, role, domain, warnings) {
  if (!Array.isArray(entities)) return null;

  const matching = entities.filter(e => Array.isArray(e.roles) && e.roles.includes(role));

  if (matching.length === 0) return null;

  if (matching.length > 1) {
    warnings.push({
      code:    'MULTIPLE_SAME_ROLE_ENTITIES',
      domain,
      role,
      count:   matching.length,
      message: `${matching.length} entities with role '${role}' found; first in document order selected (§7.6)`,
    });
  }

  const entity = matching[0];
  return _extractEntityFields(entity, role);
}

function _extractEntityFields(entity, role) {
  const vCard = _parseVCard(entity.vcardArray);
  const links = Array.isArray(entity.links) ? entity.links : [];

  const base = {
    handle:      entity.handle ?? null,
    roles:       Array.isArray(entity.roles) ? entity.roles : null,
    statusCodes: Array.isArray(entity.status) ? entity.status : null,
    vCard,
    selfLink:    _findLink(links, 'self'),
  };

  if (role === 'registrar') {
    return {
      ...base,
      registrarIanaId:       _extractIanaId(entity),
      registrarAbuseEmail:   _extractAbuseField(entity, 'email'),
      registrarAbuseTel:     _extractAbuseField(entity, 'tel'),
    };
  }

  return base;
}

// ── IANA registrar ID extraction ──────────────────────────────────────────────

function _extractIanaId(entity) {
  // Preferred: publicIds array
  if (Array.isArray(entity.publicIds)) {
    const entry = entity.publicIds.find(p =>
      (p.type ?? '').toLowerCase().includes('iana registrar id')
    );
    if (entry?.identifier) return String(entry.identifier);
  }

  // Fallback: entity handle may be a numeric IANA ID
  if (entity.handle && /^\d+$/.test(entity.handle)) {
    return entity.handle;
  }

  return null;
}

// ── Abuse contact extraction ──────────────────────────────────────────────────

function _extractAbuseField(registrarEntity, field) {
  if (!Array.isArray(registrarEntity.entities)) return null;

  const abuseEntity = registrarEntity.entities.find(e =>
    Array.isArray(e.roles) && e.roles.includes('abuse')
  );
  if (!abuseEntity) return null;

  const vCard = _parseVCard(abuseEntity.vcardArray);
  return vCard[field] ?? null;
}

// ── vCard / jCard parsing ─────────────────────────────────────────────────────

/**
 * Parses a jCard (RFC 7095) vcardArray into a flat field object.
 * vCard format: ["vcard", [ [property, params, type, value], ... ]]
 *
 * Returns an object with string values for fn, org, email, tel, and
 * address component strings. All fields default to null.
 *
 * @param {Array|undefined} vcardArray
 * @returns {VCardFields}
 */
function _parseVCard(vcardArray) {
  const fields = {
    fn:      null,
    org:     null,
    email:   null,
    tel:     null,
    url:     null,
    street:  null,
    city:    null,
    state:   null,
    postal:  null,
    country: null,
  };

  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return fields;

  // vcardArray[0] = "vcard", vcardArray[1] = array of property arrays
  const properties = vcardArray[1];
  if (!Array.isArray(properties)) return fields;

  for (const prop of properties) {
    if (!Array.isArray(prop) || prop.length < 4) continue;
    const [name, , , value] = prop;
    const propName = (name ?? '').toLowerCase();

    switch (propName) {
      case 'fn':
        fields.fn = _vCardString(value);
        break;

      case 'org':
        // org value may be an array of strings or a plain string
        fields.org = Array.isArray(value) ? _vCardString(value[0]) : _vCardString(value);
        break;

      case 'email':
        if (fields.email === null) fields.email = _vCardString(value);
        break;

      case 'tel':
        if (fields.tel === null) {
          // tel may be URI format: "tel:+1.5555555555"
          const raw = _vCardString(value);
          fields.tel = raw?.replace(/^tel:/i, '') ?? null;
        }
        break;

      case 'url':
        // Registrar website URL (§3.20 / §5.2 — registrar entity `url` link).
        if (fields.url === null) fields.url = _vCardString(value);
        break;

      case 'adr': {
        // jCard adr value: ["text", [pobox, ext, street, locality, region, postal, country]]
        // or structured array directly as value
        const adr = Array.isArray(value) ? value : null;
        if (adr && adr.length >= 7) {
          fields.street  = _vCardString(adr[2]) || null;
          fields.city    = _vCardString(adr[3]) || null;
          fields.state   = _vCardString(adr[4]) || null;
          fields.postal  = _vCardString(adr[5]) || null;
          fields.country = _vCardString(adr[6]) || null;
        }
        break;
      }
    }
  }

  return fields;
}

function _vCardString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

// ── Null parsed result ────────────────────────────────────────────────────────

function _nullParsed() {
  return {
    registrationCore: null,
    rdapMetadata:     null,
    registrarEntity:  null,
    registrantEntity: null,
    adminEntity:      null,
    techEntity:       null,
    warnings:         [],
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { parseRdapResponse };

/**
 * @typedef {Object} ParsedRdap
 * @property {Object|null} registrationCore
 * @property {Object|null} rdapMetadata
 * @property {Object|null} registrarEntity
 * @property {Object|null} registrantEntity
 * @property {Object|null} adminEntity
 * @property {Object|null} techEntity
 * @property {Array} warnings
 */

/**
 * @typedef {Object} VCardFields
 * @property {string|null} fn
 * @property {string|null} org
 * @property {string|null} email
 * @property {string|null} tel
 * @property {string|null} street
 * @property {string|null} city
 * @property {string|null} state
 * @property {string|null} postal
 * @property {string|null} country
 */
