'use strict';
/**
 * Rolls back any FCA firms that were partially enriched by fca-enrich.js.
 * Targets: regulator='FCA' AND pipeline_flags contains FCA_API_ENRICHED.
 * Resets: pipeline_status → pending_enrichment, clears all address/website fields,
 *         removes FCA_API_ENRICHED (and WEBSITE_CONFLICT) from pipeline_flags.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { getClient } = require('../pipeline/lib/db');
const { log, error } = require('../pipeline/lib/log');

async function run() {
  const supabase = getClient();

  // Fetch all FCA firms regardless of status — filter for FCA_API_ENRICHED in JS
  const { data, error: fetchErr } = await supabase
    .from('prospects')
    .select('id, firm_name, pipeline_status, pipeline_flags')
    .eq('regulator', 'FCA')
    .range(0, 9999);

  if (fetchErr) throw new Error(`Fetch failed: ${fetchErr.message}`);

  const targets = (data || []).filter(r => {
    const flags = Array.isArray(r.pipeline_flags) ? r.pipeline_flags : [];
    return flags.some(f => f.code === 'FCA_API_ENRICHED');
  });

  log(`Found ${targets.length} firms to roll back`);

  if (!targets.length) {
    log('Nothing to roll back');
    return;
  }

  let rolled = 0;
  let failed  = 0;

  for (const firm of targets) {
    const cleanedFlags = (firm.pipeline_flags || []).filter(
      f => f.code !== 'FCA_API_ENRICHED' && f.code !== 'WEBSITE_CONFLICT'
    );

    const { error: updateErr } = await supabase
      .from('prospects')
      .update({
        pipeline_status:     'pending_enrichment',
        website:             null,
        domain_confidence:   0,
        town:                null,
        county:              null,
        postcode:            null,
        postcode_source:     null,
        postcode_confidence: null,
        country:             null,
        pipeline_flags:      cleanedFlags,
        updated_at:          new Date().toISOString(),
      })
      .eq('id', firm.id);

    if (updateErr) {
      error(`Failed to roll back ${firm.firm_name}: ${updateErr.message}`);
      failed++;
    } else {
      log(`Rolled back: ${firm.firm_name} (was ${firm.pipeline_status})`);
      rolled++;
    }
  }

  console.log(`\nRollback complete — ${rolled} reset, ${failed} failed`);
}

run().catch(err => { error(err.message); process.exit(1); });
