'use strict';

// Co-party identity canonicalisation — the fix for the real dry-run bug
// where two differently-labelled discoveries ("here", "published in June")
// both resolving to gov.uk caused a duplicate co-party follow-up and an
// early repeated-action stop.
//
// Key priority (highest first):
//   1. normalised explicit entity domain, where available;
//   2. normalised fetched final-URL registrable domain;
//   3. a known organisation identifier (e.g. a Companies House number),
//      where available;
//   4. normalised entity name only, as a last-resort fallback.
//
// Two genuinely different organisations that merely share a hosting
// platform (e.g. two different Squarespace/Wix sites) are NEVER merged —
// the key is always the registrable domain of the entity's OWN site, never
// a shared platform host. Social-media domains are rejected outright
// (never a valid co-party identity, per the existing SOCIAL_PLATFORM_DOMAINS
// convention already used elsewhere in the orchestrator).

const psl = require('psl');
const { normaliseName, normaliseDomain } = require('../../authority/lib/normalise');

const SOCIAL_PLATFORM_DOMAINS = Object.freeze(['linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com']);

// The public suffix list already treats many multi-tenant hosting
// platforms as "private" registrable units (github.io, herokuapp.com) —
// psl.parse() correctly gives each customer subdomain its own registrable
// domain for those. A handful of common platforms are NOT registered in
// the public suffix list at all (squarespace.com, wixsite.com, ...), so
// psl would otherwise collapse every customer site on that platform down
// to the one shared host — exactly the "same platform, different
// organisations" merge this module must not produce. This is a small,
// explicit supplement to PSL's own mechanism, not a workaround around it.
const KNOWN_MULTI_TENANT_HOSTS = Object.freeze(['squarespace.com', 'wixsite.com', 'weebly.com', 'wordpress.com', 'blogspot.com']);

function isSocialPlatform(domain) {
  return !!domain && SOCIAL_PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Registrable ("public suffix + 1") domain for a hostname or URL — the
 * same discipline url-policy.js already uses for same-site detection, so
 * two different paths (or subdomains) on one site always canonicalise to
 * one key, while two different platforms never collapse into each other.
 */
function registrableDomainOf(input) {
  if (!input) return null;
  let hostname = input;
  try {
    hostname = new URL(input.includes('://') ? input : `https://${input}`).hostname;
  } catch {
    return null;
  }
  const normalised = normaliseDomain(hostname);
  if (!normalised) return null;
  const parsed = psl.parse(normalised);
  const registrable = (parsed && parsed.domain) ? parsed.domain : normalised;
  if (parsed?.subdomain && KNOWN_MULTI_TENANT_HOSTS.includes(registrable)) {
    return `${parsed.subdomain}.${registrable}`;
  }
  return registrable;
}

/**
 * canonicalCoPartyKey({ domain, url, organisationIdentifier, name }) -> {
 *   key: string | null, basis: 'domain' | 'final_url_domain' | 'identifier' | 'name' | 'rejected_social_platform',
 *   rejected: boolean,
 * }
 */
function canonicalCoPartyKey({ domain, url, organisationIdentifier, name } = {}) {
  const explicitDomain = registrableDomainOf(domain);
  if (explicitDomain) {
    if (isSocialPlatform(explicitDomain)) return { key: null, basis: 'rejected_social_platform', rejected: true };
    return { key: explicitDomain, basis: 'domain', rejected: false };
  }

  const urlDomain = registrableDomainOf(url);
  if (urlDomain) {
    if (isSocialPlatform(urlDomain)) return { key: null, basis: 'rejected_social_platform', rejected: true };
    return { key: urlDomain, basis: 'final_url_domain', rejected: false };
  }

  if (organisationIdentifier) {
    return { key: `id:${String(organisationIdentifier).toUpperCase()}`, basis: 'identifier', rejected: false };
  }

  const normalisedName = name ? normaliseName(name) : null;
  if (normalisedName) return { key: `name:${normalisedName}`, basis: 'name', rejected: false };

  return { key: null, basis: null, rejected: true };
}

/**
 * mergeDiscoveriesByCanonicalKey(discoveries) -> [{ canonicalKey, basis,
 *   domain, primaryName, aliases: string[], sourceDiscoveries: [...] }]
 *
 * Groups raw discovery-like records ({ discoveredName, discoveredDomain,
 * discoveredDomainNormalised, discoveryReason }) by canonical co-party
 * identity. The FIRST name encountered for a key becomes `primaryName`;
 * every other label that resolved to the same key is preserved verbatim in
 * `aliases`, so no discovered label is ever silently lost.
 */
function mergeDiscoveriesByCanonicalKey(discoveries) {
  const groups = new Map();
  for (const d of discoveries || []) {
    const { key, basis, rejected } = canonicalCoPartyKey({
      domain: d.discoveredDomainNormalised || d.discoveredDomain,
      name: d.discoveredName,
    });
    if (rejected || !key) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        canonicalKey: key,
        basis,
        domain: d.discoveredDomainNormalised || registrableDomainOf(d.discoveredDomain) || null,
        primaryName: d.discoveredName,
        aliases: [],
        sourceDiscoveries: [],
      });
    }
    const group = groups.get(key);
    if (d.discoveredName !== group.primaryName && !group.aliases.includes(d.discoveredName)) {
      group.aliases.push(d.discoveredName);
    }
    group.sourceDiscoveries.push(d);
  }
  return [...groups.values()];
}

module.exports = { registrableDomainOf, canonicalCoPartyKey, mergeDiscoveriesByCanonicalKey, isSocialPlatform, SOCIAL_PLATFORM_DOMAINS };
