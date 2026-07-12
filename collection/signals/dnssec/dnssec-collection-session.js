'use strict';

// DNSSEC Collection Session — now a thin adapter over the generic Collection
// Session framework (Sprint 8). All orchestration (open run → collect → build →
// persist → track → complete run) lives in the framework; this file supplies only
// the DNSSEC-specific pieces via an adapter:
//   collect            = collectDnssec              (dnssec-collector.js, unchanged)
//   buildObservation   = buildDnssecObservation     (dnssec-observation.js, unchanged;
//                                                     internally uses deriveCollectionOutcome)
//   tableName          = 'signal_facts_dnssec'
//   programme          = the standing National DNSSEC programme
//
// The public interface (runDnssecCollectionSession) is unchanged so the existing
// tests and run-observation-session.js are unaffected — this is a pure refactor.

const { collectDnssec } = require('./dnssec-collector');
const { buildDnssecObservation } = require('./dnssec-observation');
const { runCollectionSession } = require('../../../observatory/collection/collection-session');

const DEFAULT_PROGRAMME_KEY = 'national-dnssec';
const DEFAULT_PROGRAMME_NAME = 'National DNSSEC';

// The DNSSEC signal adapter — the entire DNSSEC-specific surface the generic
// framework needs. This is the template every remaining collector copies.
const dnssecAdapter = {
  signal: 'dnssec',
  tableName: 'signal_facts_dnssec',
  programme: { key: DEFAULT_PROGRAMME_KEY, name: DEFAULT_PROGRAMME_NAME, kind: 'NATIONAL', signal: 'dnssec' },
  collect: collectDnssec,
  buildObservation: buildDnssecObservation,
};

// runDnssecCollectionSession(opts) — unchanged signature. Delegates to the
// generic framework with the DNSSEC adapter.
async function runDnssecCollectionSession(opts = {}) {
  const { runLabel, domains, programmeKey, programmeName, deps = {} } = opts;

  // Allow the caller to override the programme key/name (used by tests / one-off
  // cohorts) without disturbing the rest of the adapter.
  const adapter = (programmeKey || programmeName)
    ? { ...dnssecAdapter, programme: {
        ...dnssecAdapter.programme,
        key: programmeKey ?? DEFAULT_PROGRAMME_KEY,
        name: programmeName ?? DEFAULT_PROGRAMME_NAME,
      } }
    : dnssecAdapter;

  return runCollectionSession({ runLabel, domains, adapter, deps });
}

module.exports = {
  runDnssecCollectionSession,
  dnssecAdapter,
  DEFAULT_PROGRAMME_KEY,
  DEFAULT_PROGRAMME_NAME,
};
