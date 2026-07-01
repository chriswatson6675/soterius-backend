'use strict';

// connectivity-check.js — Phase 1 initial connectivity test (IMP-FCA-001 §1).
//
// A verification harness, NOT a collector: it loads + validates configuration and
// makes a SINGLE authenticated GET against a known firm to confirm authentication
// and transport. It preserves nothing, extracts nothing, paginates nothing, and
// makes no observation/evidence decision (those are later phases). It prints a
// short summary only — never a full JSON payload, never the credential.
//
// Usage:
//   node signal-lab/sources/fca/connectivity-check.js [FRN]
//   (defaults to FRN 122702 — Barclays Bank Plc)
//
// Required env (backend/.env): FCA_EMAIL, FCA_API_KEY.

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const { loadConfig, validateConfig, buildUrl, getJson } = require('./fca-client');

async function main() {
  const config = loadConfig();

  // Precondition: configuration must validate BEFORE any request (CCS-FCA-001 §3).
  const v = validateConfig(config);
  if (!v.ok) {
    console.error('\n  FCA connectivity check — CONFIG INVALID');
    for (const e of v.errors) console.error('    - ' + e);
    console.error('  Set FCA_EMAIL and FCA_API_KEY in backend/.env\n');
    process.exit(2);
  }

  const frn = process.argv[2] || '122702';
  const url = buildUrl(config.baseUrl, `/Firm/${encodeURIComponent(frn)}`);

  const res = await getJson(url, { email: config.email, apiKey: config.apiKey });

  const firm = res.body && Array.isArray(res.body.Data) ? res.body.Data[0] : null;
  const connected = res.errorType === 'NONE' && !!res.fsrStatus;

  console.log('\n  FCA connectivity check (Phase 1)');
  console.log('  ─────────────────────────────────');
  console.log('  API version  : ' + config.apiVersion);
  console.log('  Request URI  : ' + res.requestUri);
  console.log('  Transport    : ' + res.errorType + (res.errorMessage ? ` (${res.errorMessage})` : ''));
  console.log('  HTTP status  : ' + res.httpStatus);
  console.log('  FSR Status   : ' + (res.fsrStatus ?? '(none)'));
  console.log('  Message      : ' + (res.envelope ? res.envelope.message : '(none)'));
  console.log('  Firm         : ' + (firm ? `${firm['Organisation Name']} (FRN ${firm.FRN})` : '(no Data)'));
  console.log('  Result       : ' + (connected ? 'CONNECTED ✓' : 'FAILED ✗'));
  console.log('');

  process.exit(connected ? 0 : 1);
}

main();
