'use strict';

// providers.js — the Organisation Provider capability registry (ADR-SYS-010
// extension, discovery review §5). Declarative data, not a service: which
// providers exist, what identifier scheme each one owns, and which
// capabilities each one actually contributes. Nothing downstream may assume
// a provider supports a capability it doesn't declare here.

const PROVIDERS = [
  {
    id: 'companies-house',
    jurisdiction: 'uk',
    identifierScheme: 'uk.companieshouse.number',
    capabilities: ['identity', 'classification'],
  },
  {
    id: 'sra',
    jurisdiction: 'uk',
    identifierScheme: 'uk.sra.number',
    capabilities: ['identity', 'regulatory-status'],
  },
  {
    id: 'fca',
    jurisdiction: 'uk',
    identifierScheme: 'uk.fca.frn',
    capabilities: ['identity', 'regulatory-status'],
    // Present in the Repository Authority dataset (batch-merged already);
    // no live adapter in organisation/adapters/ yet — identity lookups
    // against Repository Authority still see FCA-sourced organisations,
    // but there is no on-demand FCA fetch path today.
    liveAdapter: false,
  },
  {
    id: 'soterius-observatory',
    jurisdiction: 'global',
    identifierScheme: null, // domain-keyed, not identity-keyed
    capabilities: ['observations'],
  },
  // Future, not yet implemented — declared so callers get an explicit
  // "not supported yet" rather than a silent no-op (Unknown != Absent
  // applies to capability gaps, not just missing data):
  // { id: 'sec', jurisdiction: 'us', identifierScheme: 'us.sec.cik', capabilities: ['identity', 'regulatory-status'] }
  // { id: 'people-observatory', jurisdiction: 'global', identifierScheme: null, capabilities: ['relationships'] }
];

function byIdentifierScheme(scheme) {
  return PROVIDERS.find((p) => p.identifierScheme === scheme) || null;
}

function byId(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function supporting(capability) {
  return PROVIDERS.filter((p) => p.capabilities.includes(capability));
}

module.exports = { PROVIDERS, byIdentifierScheme, byId, supporting };
