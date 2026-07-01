'use strict';
/**
 * Pipeline Stage 3 — Data Cleaning
 *
 * Runs against all 'valid' prospects and flags data quality issues:
 *   - Missing sector field
 *   - Missing location field
 *   - Duplicate domains (exact match, two records pointing to same site)
 *   - Near-duplicate firm names (Levenshtein ≤2 after normalisation)
 *
 * Does NOT delete records — flags them for human review.
 * A flagged prospect is transitioned to 'flagged'.
 *
 * Usage:
 *   node scripts/pipeline/clean.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { log, warn } = require('./lib/log');
const { normaliseFirmName, levenshtein } = require('./lib/domain');
const { updatePipelineStatus, appendFlag, getAllProspects } = require('./lib/db');
const { error } = require('./lib/log');

async function run({ dryRun = false } = {}) {
  const all = await getAllProspects();
  log(`Checking ${all.length} prospects for data quality issues${dryRun ? ' (dry-run)' : ''}`);

  const stats = { checked: all.length, flagged: 0, clean: 0 };

  // Build domain → ids map for exact duplicate detection
  const domainMap = {};
  for (const p of all) {
    const d = p.website.toLowerCase();
    if (!domainMap[d]) domainMap[d] = [];
    domainMap[d].push(p);
  }

  // Build normalised name list for fuzzy duplicate detection
  const nameIndex = all.map(p => ({ id: p.id, norm: normaliseFirmName(p.firm_name) }));

  for (const prospect of all) {
    const flags = [];

    // Missing sector
    if (!prospect.sector) {
      flags.push({ code: 'MISSING_SECTOR', detail: 'sector field is not set' });
    }

    // Missing location
    if (!prospect.location) {
      flags.push({ code: 'MISSING_LOCATION', detail: 'location field is not set' });
    }

    // Exact domain duplicate
    const dupes = domainMap[prospect.website.toLowerCase()] || [];
    if (dupes.length > 1) {
      const dupeIds = dupes.filter(d => d.id !== prospect.id).map(d => d.id);
      flags.push({ code: 'DUPLICATE_DOMAIN', detail: `Same domain shared with prospect(s): ${dupeIds.join(', ')}` });
    }

    // Near-duplicate firm name
    const normName   = normaliseFirmName(prospect.firm_name);
    const closeMatch = nameIndex.find(n =>
      n.id !== prospect.id &&
      n.norm.length > 3 &&
      levenshtein(normName, n.norm) <= 2
    );
    if (closeMatch) {
      flags.push({
        code:   'NEAR_DUPLICATE_NAME',
        detail: `Firm name "${prospect.firm_name}" is close to prospect ${closeMatch.id}`,
      });
    }

    if (flags.length === 0) {
      stats.clean++;
      continue;
    }

    warn(`Flagging ${prospect.website} (${prospect.id}) — ${flags.map(f => f.code).join(', ')}`);

    if (!dryRun) {
      await updatePipelineStatus(prospect.id, 'flagged');
      for (const f of flags) {
        await appendFlag(prospect.id, f);
      }
    }
    stats.flagged++;
  }

  log(`Clean complete — checked: ${stats.checked}, flagged: ${stats.flagged}, clean: ${stats.clean}`);
  return stats;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
