'use strict';
/**
 * FCA Enrichment — populates website, address and pipeline_status for FCA firms.
 *
 * Processes records where:
 *   regulator = 'FCA'
 *   pipeline_status = 'pending_enrichment'
 *   pipeline_flags does NOT contain { code: 'FCA_API_ENRICHED' }
 *
 * Per firm (1 API call):
 *   GET /Firm/{FRN}/Address
 *   Writes: website, domain_confidence, town, county, postcode, postcode_source,
 *           postcode_confidence, country, pipeline_status, pipeline_flags
 *
 * Outcomes:
 *   Website found → pipeline_status = 'pending_validate'
 *   No website    → pipeline_status = 'pending_discovery'
 *   Both cases    → FCA_API_ENRICHED flag appended (prevents reprocessing on resume)
 *
 * Resumable: re-running skips any record already carrying the FCA_API_ENRICHED flag.
 *
 * Usage:
 *   node scripts/feeds/fca-enrich.js [--limit N] [--dry-run]
 *
 * Required env vars:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   FCA_EMAIL    + FCA_API_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { log, warn, error } = require('../pipeline/lib/log');
const { getClient, updatePipelineStatus } = require('../pipeline/lib/db');
const { createClient: createFcaClient }   = require('./fca-api');

const RATE_DELAY    = 650;              // ms between API calls — stays under 100/min
const RETRY_DELAYS  = [2000, 4000, 8000]; // backoff on 429 / 5xx

// ── Normalisers ───────────────────────────────────────────────────────────────

const UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s[0-9][A-Z]{2}$/;

function normalisePostcode(raw) {
  if (!raw) return null;
  const stripped = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (stripped.length < 5) return null;
  const normalised = stripped.slice(0, -3) + ' ' + stripped.slice(-3);
  return UK_POSTCODE_RE.test(normalised) ? normalised : null;
}

function normaliseDomain(raw) {
  if (!raw) return null;
  try {
    const url  = raw.startsWith('http') ? raw : `https://${raw}`;
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function withRetry(fn, frn) {
  for (let i = 0; i < RETRY_DELAYS.length + 1; i++) {
    try {
      return await fn();
    } catch (err) {
      const isAuth      = err.message.includes('auth failed');
      const isRateLimit = err.message.includes('rate limit') || err.message.includes('429');
      const isRetryable = isRateLimit || err.message.includes('5');

      if (isAuth) throw err; // credentials wrong — stop immediately

      if (i < RETRY_DELAYS.length && isRetryable) {
        warn(`FRN ${frn} — attempt ${i + 1} failed (${err.message.slice(0, 60)}), retrying in ${RETRY_DELAYS[i]}ms`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
        continue;
      }
      throw err;
    }
  }
}

// ── Load candidates ───────────────────────────────────────────────────────────

async function loadCandidates() {
  const supabase  = getClient();
  const PAGE_SIZE = 1000;
  let all  = [];
  let from = 0;

  while (true) {
    const { data, error: err } = await supabase
      .from('prospects')
      .select('id, firm_name, regulator_id, pipeline_flags')
      .eq('regulator', 'FCA')
      .eq('pipeline_status', 'pending_enrichment')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (err) throw new Error(`Failed to load candidates (page ${from}): ${err.message}`);
    if (!data || !data.length) break;

    all  = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // Filter in JS — excludes any record already carrying the FCA_API_ENRICHED flag
  return all.filter(r => {
    const flags = Array.isArray(r.pipeline_flags) ? r.pipeline_flags : [];
    return !flags.some(f => f.code === 'FCA_API_ENRICHED');
  });
}

// ── Enrich one firm ───────────────────────────────────────────────────────────

async function enrichOne(prospect, fca, dryRun) {
  const frn = prospect.regulator_id;

  const addrResp = await withRetry(() => fca.getFirmAddress(frn), frn);
  const addresses = (addrResp && addrResp.Data) || [];

  // Prefer address that has a website; fall back to first address entry
  const addr = addresses.find(a => a['Website Address']) || addresses[0] || {};

  const domain   = normaliseDomain(addr['Website Address'] || null);
  const town     = addr['Town']     || null;
  const county   = addr['County']   || null;
  const postcode = normalisePostcode(addr['Postcode'] || null);
  const country  = addr['Country']  || null;

  const newStatus    = domain ? 'pending_validate' : 'pending_discovery';
  const existingFlags = Array.isArray(prospect.pipeline_flags) ? prospect.pipeline_flags : [];
  const updatedFlags  = [...existingFlags, { code: 'FCA_API_ENRICHED', ts: new Date().toISOString() }];

  const fields = {
    website:             domain,
    domain_confidence:   domain ? 90 : 0,
    town,
    county,
    postcode,
    postcode_source:     postcode ? 'fca-api' : null,
    postcode_confidence: postcode ? 99         : null,
    country,
    pipeline_flags:      updatedFlags,
  };

  if (dryRun) {
    log(
      `[dry-run] ${prospect.firm_name} (${frn}) → ${newStatus}` +
      (domain    ? ` | website: ${domain}`     : ' | no website') +
      (postcode  ? ` | postcode: ${postcode}`  : '')
    );
  } else {
    try {
      await updatePipelineStatus(prospect.id, newStatus, fields);
    } catch (err) {
      if (err.message.includes('duplicate key') || err.message.includes('idx_prospects_website')) {
        // Domain already assigned to another prospect — save address fields only, no website
        const conflictFlags = [...updatedFlags, {
          code: 'WEBSITE_CONFLICT',
          detail: `Domain ${domain} already assigned to another prospect`,
          ts: new Date().toISOString(),
        }];
        await updatePipelineStatus(prospect.id, 'pending_discovery', {
          ...fields,
          website: null,
          domain_confidence: 0,
          pipeline_flags: conflictFlags,
        });
        return { domain: null, postcode };
      }
      throw err;
    }
  }

  return { domain, postcode };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run({ limit = 0, dryRun = false } = {}) {
  log(`FCA Enrichment${dryRun ? ' (dry-run)' : ''} — loading candidates`);

  const fca = createFcaClient();

  let candidates = await loadCandidates();
  log(`${candidates.length} FCA firms pending enrichment (no FCA_API_ENRICHED flag)`);

  if (!candidates.length) {
    log('Nothing to do — all FCA firms already enriched');
    return;
  }

  if (limit > 0) {
    candidates = candidates.slice(0, limit);
    log(`Limit applied — processing ${candidates.length}`);
  }

  const stats = {
    total:           candidates.length,
    processed:       0,
    withWebsite:     0,
    withPostcode:    0,
    pendingValidate:  0,
    pendingDiscovery: 0,
    errors:          0,
  };

  const startedAt = Date.now();

  for (const prospect of candidates) {
    try {
      const result = await enrichOne(prospect, fca, dryRun);

      if (result.domain)   { stats.withWebsite++;      stats.pendingValidate++;  }
      else                 { stats.pendingDiscovery++;                            }
      if (result.postcode)   stats.withPostcode++;

      stats.processed++;
    } catch (err) {
      error(`FRN ${prospect.regulator_id} (${prospect.firm_name}): ${err.message}`);
      stats.errors++;
      stats.processed++;
    }

    // Progress log every 25 firms
    if (stats.processed % 25 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate    = Math.round(stats.processed / elapsed * 60);
      const webPct  = Math.round(stats.withWebsite / stats.processed * 100);
      log(`Progress ${stats.processed}/${stats.total} — ${rate} firms/min — website: ${webPct}%`);
    }

    // Rate limiting — pause between every API call
    if (stats.processed < candidates.length) {
      await fca.sleep(RATE_DELAY);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const duration = Math.round((Date.now() - startedAt) / 1000);
  const rate     = stats.processed > 0 ? Math.round(stats.processed / duration * 60) : 0;
  const webPct   = stats.processed > 0 ? Math.round(stats.withWebsite  / stats.processed * 100) : 0;
  const pcPct    = stats.processed > 0 ? Math.round(stats.withPostcode / stats.processed * 100) : 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(` FCA ENRICHMENT${dryRun ? ' DRY-RUN' : ''} COMPLETE`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Processed         : ${stats.processed} / ${stats.total}`);
  console.log(`  Website found     : ${stats.withWebsite} (${webPct}%)`);
  console.log(`  Postcode found    : ${stats.withPostcode} (${pcPct}%)`);
  console.log(`  → pending_validate  : ${stats.pendingValidate}`);
  console.log(`  → pending_discovery : ${stats.pendingDiscovery}`);
  console.log(`  Errors            : ${stats.errors}`);
  console.log(`  Duration          : ${duration}s at ${rate} firms/min`);
  if (dryRun) {
    console.log(`\n  No database writes performed.`);
    console.log(`  Run without --dry-run to apply.`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  return stats;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args   = process.argv.slice(2);
  const get    = flag => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  const limit  = parseInt(get('--limit') || '0', 10);
  const dryRun = args.includes('--dry-run');

  run({ limit, dryRun }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
