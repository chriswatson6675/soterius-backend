'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const tables = [
    'signal_facts_spf',
    'signal_facts_dkim',
    'signal_facts_dkim_keys',
    'signal_facts_dmarc',
    'signal_facts_mtasts',
    'signal_facts_tlsrpt',
    'signal_facts_dnssec',
    'signal_facts_caa',
    'signal_securitytxt_v1',
    'signal_securityheaders_v1',
  ];

  for (const table of tables) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(table.padEnd(35), 'ERROR:', error.message.slice(0, 60));
    } else {
      console.log(table.padEnd(35), (count ?? 0) + ' rows');
    }
  }
}
main().catch(e => console.error(e.message));
