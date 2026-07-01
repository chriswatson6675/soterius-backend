'use strict';
/**
 * One-off cleanup — Cohort 001 anomalous prospects.
 * Deletes prospects (and their linked scan records) identified as
 * inactive domains, typos, or duplicate firm entries.
 * Run once from backend/: node scripts/cleanup-cohort-001.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REMOVE = [
  { domain: 'darwingray.co.uk',    reason: 'Inactive/parked — duplicate of darwingray.com' },
  { domain: 'tudotowne.co.uk',     reason: 'Typo — correct domain is tudurowen.co.uk' },
  { domain: 'tudorowen.co.uk',     reason: 'Inactive — active site is tudurowen.co.uk' },
  { domain: 'averprimelaw.co.uk',  reason: 'Likely typo or parked — cf. acerprimelaw.co.uk' },
  { domain: 'edwardhughes.co.uk',  reason: 'Inactive/parked — duplicate of edwardhugheslaw.co.uk' },
];

const norm = d => (d || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').split('/')[0];

(async () => {
  const { data: all, error } = await supabase.from('prospects').select('id, firm_name, website');
  if (error) { console.error('Load failed:', error.message); process.exit(1); }

  for (const { domain, reason } of REMOVE) {
    const match = all.find(p => norm(p.website) === domain);
    if (!match) {
      console.log(`  — Not found: ${domain}`);
      continue;
    }

    const { error: scanErr } = await supabase.from('scans').delete().eq('prospect_id', match.id);
    if (scanErr) { console.error(`  ✗ Could not delete scans for ${domain}:`, scanErr.message); continue; }

    const { error: prospectErr } = await supabase.from('prospects').delete().eq('id', match.id);
    if (prospectErr) { console.error(`  ✗ Could not delete prospect ${domain}:`, prospectErr.message); continue; }

    console.log(`  ✓ Deleted: ${match.firm_name} (${match.website}) — ${reason}`);
  }

  console.log('\nCleanup complete.');
})().catch(e => { console.error(e.message); process.exit(1); });
