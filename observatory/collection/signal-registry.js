'use strict';

// The Observatory-native signals and their canonical Observation (payload)
// tables. A single list so projections (Organisation History, and future
// read-models) can iterate signals WITHOUT importing collector modules (which
// pull in axios/dns/etc.). Table names match migrations 011/039 (DNSSEC) and 040
// (the remaining nine). Adding a signal = one entry here.

const OBSERVATORY_SIGNALS = Object.freeze([
  { collector: 'dnssec',          table: 'signal_facts_dnssec' },
  { collector: 'spf',             table: 'signal_facts_spf' },
  { collector: 'dmarc',           table: 'signal_facts_dmarc' },
  { collector: 'dkim',            table: 'signal_facts_dkim' },
  { collector: 'caa',             table: 'signal_facts_caa' },
  { collector: 'mtasts',          table: 'signal_facts_mtasts' },
  { collector: 'tls',             table: 'signal_tls_v1' },
  { collector: 'certificate',     table: 'signal_certificate_v1' },
  { collector: 'securityheaders', table: 'signal_securityheaders_v1' },
  { collector: 'securitytxt',     table: 'signal_securitytxt_v1' },
]);

module.exports = { OBSERVATORY_SIGNALS };
