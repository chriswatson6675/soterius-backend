'use strict';

// backfill.js — ADR-SYS-010 Platform Convergence: re-key every
// organisation_portfolio_items row from a legacy prospect id to a canonical
// ORG-* id, resolving through the canonical Organisation resolver.
//
// Runs AFTER migration 038 (which re-typed organisation_id uuid -> text).
//
// GOVERNANCE (ADR-COL-010): a mapping is only applied when the resolver returns
// exactly one existing canonical Organisation. Anything else — a conflict
// (multiple candidates) or no confident existing match (isNew) — is NOT decided
// silently. It is written to an append-only Remediation Ledger
// (ledger.ndjson, recommendation-only) with full evidence, and the un-re-keyable
// portfolio row is removed (recorded there, recoverable from it) rather than
// left holding a broken legacy id. Nothing here mutates Repository Authority.
//
// Run: node backend/authority/portfolio-rekey/backfill.js [--confirm]
//   (dry-run by default; --confirm writes DB changes + the ledger)

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const resolve = require('../../organisation/resolve');

const CONFIRM = process.argv.includes('--confirm');
const LEDGER = path.join(__dirname, 'ledger.ndjson');

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Build the canonical resolver input from a legacy prospect record.
function prospectToIdentity(p) {
  const input = { name: p.firm_name || null, domain: p.website || null };
  // Legacy prospects carry at most one strong identifier, in source_reference,
  // discriminated by source. Map it onto the canonical identifier space.
  if (p.source_reference) {
    if (p.source === 'fca-registry') input.frn = p.source_reference;
    else if (p.source === 'sra-registry') input.sraNumber = p.source_reference;
    else if (p.source === 'companies-house') input.companiesHouseNumber = p.source_reference;
  }
  return input;
}

function ledgerRow(item, prospect, outcome) {
  return {
    ledger: 'portfolio-rekey',
    at_run: 'ADR-SYS-010-convergence',
    portfolio_item_id: item.id,
    customer_id: item.customer_id,
    legacy_prospect_id: item.organisation_id,
    prospect: prospect
      ? { firm_name: prospect.firm_name, website: prospect.website, source: prospect.source, source_reference: prospect.source_reference }
      : null,
    primary_cause: outcome.cause,
    candidates: outcome.candidates || null,
    confidence: outcome.confidence,
    recommended_action: outcome.recommendedAction,
    action_taken: CONFIRM ? outcome.actionTaken : 'DRY-RUN (no change)',
    evidence: outcome.evidence,
  };
}

async function main() {
  const client = sb();
  const ledgerRows = [];
  let rekeyed = 0;
  let routed = 0;

  const { data: items, error } = await client
    .from('organisation_portfolio_items')
    .select('id, customer_id, organisation_id, is_home');
  if (error) { console.error('failed to read portfolio:', error.message); process.exit(1); }

  console.error(`portfolio rows: ${items.length}  (${CONFIRM ? 'CONFIRM — applying' : 'DRY RUN'})\n`);

  for (const item of items) {
    // An already-canonical id (ORG-*) is idempotent — skip.
    if (/^ORG-[0-9A-F]{12}/.test(item.organisation_id)) {
      console.error(`  ${item.id.slice(0, 8)} already canonical (${item.organisation_id}) — skip`);
      continue;
    }

    // Load the legacy prospect this row pointed at.
    const { data: prospect } = await client
      .from('prospects')
      .select('id, firm_name, website, source, source_reference')
      .eq('id', item.organisation_id)
      .maybeSingle();

    if (!prospect) {
      const outcome = { cause: 'legacy-prospect-not-found', confidence: 'none', recommendedAction: 'REMOVE (orphan)', actionTaken: 'row removed', evidence: { note: 'organisation_id did not match any prospects row' } };
      ledgerRows.push(ledgerRow(item, null, outcome));
      routed++;
      if (CONFIRM) await client.from('organisation_portfolio_items').delete().eq('id', item.id);
      console.error(`  ${item.id.slice(0, 8)} -> LEDGER (orphan prospect)`);
      continue;
    }

    const identity = resolve.resolveIdentity(prospectToIdentity(prospect));

    if (!identity.ok && identity.conflict) {
      const outcome = { cause: 'ambiguous-multiple-canonical-candidates', candidates: identity.candidates.map(c => c.id), confidence: 'ambiguous', recommendedAction: 'MANUAL — choose the correct canonical Organisation', actionTaken: 'row removed pending manual re-add', evidence: { candidates: identity.candidates } };
      ledgerRows.push(ledgerRow(item, prospect, outcome));
      routed++;
      if (CONFIRM) await client.from('organisation_portfolio_items').delete().eq('id', item.id);
      console.error(`  ${item.id.slice(0, 8)} -> LEDGER (ambiguous: ${identity.candidates.length} candidates)`);
      continue;
    }

    if (identity.ok && !identity.isNew) {
      // Exactly one existing canonical Organisation — the only case we apply.
      if (CONFIRM) {
        await client.from('organisation_portfolio_items')
          .update({ organisation_id: identity.organisationId })
          .eq('id', item.id);
      }
      rekeyed++;
      console.error(`  ${item.id.slice(0, 8)} -> ${identity.organisationId} (re-keyed)`);
      continue;
    }

    // isNew — resolver computed an id but it is NOT in Repository Authority.
    // Not a confident mapping; do not silently create/assign.
    const outcome = { cause: 'no-confident-canonical-match (prospect not in Repository Authority)', candidates: [identity.organisationId], confidence: 'low', recommendedAction: 'INVESTIGATE — prospect may be synthetic/dev, or a genuine Repository Authority gap', actionTaken: 'row removed pending investigation', evidence: { computedIdIfCreated: identity.organisationId, note: 'resolver produced an id via the name+domain fallback tier but no matching Repository Authority record exists' } };
    ledgerRows.push(ledgerRow(item, prospect, outcome));
    routed++;
    if (CONFIRM) await client.from('organisation_portfolio_items').delete().eq('id', item.id);
    console.error(`  ${item.id.slice(0, 8)} -> LEDGER (no confident match)`);
  }

  console.error(`\nsummary: ${rekeyed} re-keyed, ${routed} routed to Remediation Ledger`);

  if (ledgerRows.length && CONFIRM) {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, ledgerRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    console.error(`ledger: ${ledgerRows.length} rows appended -> ${LEDGER}`);
  } else if (ledgerRows.length) {
    console.error(`ledger (DRY RUN — would append ${ledgerRows.length} rows):`);
    ledgerRows.forEach(r => console.error('  ' + JSON.stringify(r)));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
