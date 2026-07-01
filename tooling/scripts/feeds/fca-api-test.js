'use strict';
/**
 * FCA Register API — authentication + data validation test.
 *
 * Before running, add to backend/.env:
 *   FCA_EMAIL=your-registered-email@example.com
 *   FCA_API_KEY=your-api-key-from-fca-developer-portal
 *
 * Run:
 *   node scripts/feeds/fca-api-test.js
 *
 * Tests:
 *   1. Auth  : GET /Firm/153705        (Aviva — well-known authorised firm)
 *   2. Address: GET /Firm/153705/Address (should include Website Address field)
 *   3. Search : GET /CommonSearch?q=aviva&type=firm
 *   4. Combined: getFirmWithAddress() — the call pattern used for enrichment
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { createClient } = require('./fca-api');

const TEST_FRN = '153705'; // Aviva plc — always authorised, stable test target

function pass(label) { console.log(`  ✓  ${label}`); }
function fail(label) { console.log(`  ✗  ${label}`); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`); }
function show(obj) { console.log(JSON.stringify(obj, null, 2).slice(0, 800)); }

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  FCA Register API — Integration Test');
  console.log('══════════════════════════════════════════════════════');

  let fca;
  try {
    fca = createClient();
    pass(`Credentials loaded (email: ${process.env.FCA_EMAIL.slice(0, 4)}****)`);
  } catch (err) {
    fail(`Credentials missing — ${err.message}`);
    process.exit(1);
  }

  // ── Test 1: Firm detail (auth test) ───────────────────────────────────────
  section('Test 1: Firm detail — auth check');
  let firmData;
  try {
    const resp = await fca.getFirm(TEST_FRN);
    firmData   = (resp && resp.Data && resp.Data[0]) || null;

    if (!firmData) {
      fail(`No Data in response`);
      show(resp);
    } else {
      pass(`HTTP 200 — authentication succeeded`);
      pass(`FRN: ${firmData.FRN}`);
      pass(`Name: ${firmData['Organisation Name']}`);
      pass(`Status: ${firmData.Status}`);
      pass(`Business Type: ${firmData['Business Type']}`);
      pass(`Status Effective: ${firmData['Status Effective Date']}`);
    }
  } catch (err) {
    fail(`Firm request failed: ${err.message}`);
    console.log('\n  ► If you see "auth failed", try swapping header values in fca-api.js:');
    console.log('     X-Auth-Email ← apiKey,  X-Auth-Key ← email');
    process.exit(1);
  }

  await fca.sleep(fca.RATE_DELAY);

  // ── Test 2: Firm address (website field) ──────────────────────────────────
  section('Test 2: Firm address — website field');
  try {
    const resp      = await fca.getFirmAddress(TEST_FRN);
    const addresses = (resp && resp.Data) || [];

    if (!addresses.length) {
      fail('No addresses returned');
    } else {
      pass(`${addresses.length} address record(s) returned`);
      const withWebsite = addresses.filter(a => a['Website Address']);
      pass(`${withWebsite.length} address(es) have Website Address field`);

      if (withWebsite.length) {
        pass(`Website: ${withWebsite[0]['Website Address']}`);
        pass(`Town: ${withWebsite[0].Town || '—'}`);
        pass(`Postcode: ${withWebsite[0].Postcode || '—'}`);
      } else {
        console.log('  ℹ  No website in address — Aviva may be an edge case; most SME IFAs have one');
        show(addresses[0]);
      }
    }
  } catch (err) {
    fail(`Address request failed: ${err.message}`);
  }

  await fca.sleep(fca.RATE_DELAY);

  // ── Test 3: CommonSearch ──────────────────────────────────────────────────
  section('Test 3: CommonSearch');
  try {
    const resp    = await fca.search('aviva', 'firm');
    const results = (resp && resp.Data) || [];
    const info    = (resp && resp.ResultInfo) || {};

    if (!results.length) {
      fail('No search results');
      show(resp);
    } else {
      pass(`${results.length} results returned`);
      pass(`Status: ${resp.Status} — ${resp.Message}`);
      if (info.total_count) pass(`Total matching firms: ${info.total_count}`);
      console.log('\n  First 3 results:');
      results.slice(0, 3).forEach((r, i) => {
        console.log(`    ${i + 1}. ${r.Name} (FRN: ${r['Reference Number']}) — ${r['Type of business or Individual']}`);
      });
    }
  } catch (err) {
    fail(`Search request failed: ${err.message}`);
  }

  await fca.sleep(fca.RATE_DELAY);

  // ── Test 4: getFirmWithAddress — the enrichment call ─────────────────────
  section('Test 4: getFirmWithAddress — enrichment pattern');
  try {
    const record = await fca.getFirmWithAddress(TEST_FRN);

    if (!record) {
      fail('No record returned');
    } else {
      pass(`Normalised record built`);
      console.log('\n  Normalised output (Soterius schema):');
      console.log(JSON.stringify({
        firm_name:        record.firm_name,
        regulator:        record.regulator,
        regulator_id:     record.regulator_id,
        status:           record.status,
        status_date:      record.status_date,
        website:          record.website,
        website_raw:      record.website_raw,
        town:             record.town,
        postcode:         record.postcode,
        country:          record.country,
        firm_confidence:  record.firm_confidence,
        domain_confidence: record.domain_confidence,
        source:           record.source,
        source_reference: record.source_reference,
      }, null, 2));
    }
  } catch (err) {
    fail(`getFirmWithAddress failed: ${err.message}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Done. If all tests passed:');
  console.log('  → fca-api.js is ready to use as the enrichment client');
  console.log('  → Next: import CSV via fca.js, then enrich via fca-api.js');
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
