'use strict';
// Gentle Supabase recovery waiter. One lightweight query (indexed id, limit 1,
// no scan) every 30s until the instance responds, so we can tell when the DB
// has recovered from overload WITHOUT adding heavy load. Exits 0 on recovery.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

(async () => {
  for (let i = 1; i <= 30; i++) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const t = Date.now();
    try {
      const { data, error } = await sb.from('signal_facts_spf').select('id').limit(1);
      if (!error && Array.isArray(data)) { console.log(`[${new Date().toISOString()}] RECOVERED after ${i} tries (${Date.now() - t}ms)`); process.exit(0); }
      console.log(`[${new Date().toISOString()}] try ${i}: ${error ? error.message : 'non-array'} (${Date.now() - t}ms)`);
    } catch (e) {
      console.log(`[${new Date().toISOString()}] try ${i}: threw ${e.message} (${Date.now() - t}ms)`);
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
  console.log('still not recovered after ~15 min'); process.exit(2);
})();
