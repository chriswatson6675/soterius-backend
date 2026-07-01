'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

async function run() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const tables = [
    ['signal_facts_spf','spf'],['signal_facts_dkim','dkim'],['signal_facts_dmarc','dmarc'],
    ['signal_facts_mtasts','mtasts'],['signal_facts_tlsrpt','tlsrpt'],['signal_facts_dnssec','dnssec'],
    ['signal_facts_caa','caa'],['signal_securitytxt_v1','securitytxt'],['signal_securityheaders_v1','securityheaders']
  ];
  for (const [table, label] of tables) {
    const r = await db.from(table).select('count', { count: 'exact', head: true });
    console.log(label + ': ' + (r.count !== undefined ? r.count : 'error: ' + r.error?.message));
  }
}
run().catch(e => console.error(e.message));
