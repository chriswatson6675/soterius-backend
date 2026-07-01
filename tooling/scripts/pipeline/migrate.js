'use strict';
/**
 * Applies migrate.sql to the Supabase database.
 * Requires DATABASE_URL env var (Supabase direct PostgreSQL connection string).
 * If DATABASE_URL is not set, prints the SQL to run manually in Supabase Dashboard.
 *
 * Usage: node scripts/pipeline/migrate.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const fs   = require('fs');
const path = require('path');

const SQL = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const dashboardHint = SUPABASE_URL
  ? `${SUPABASE_URL.replace('https://', 'https://supabase.com/dashboard/project/').split('.')[0]} → SQL Editor`
  : 'Supabase Dashboard → SQL Editor';

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\nDATABASE_URL is not set.\n');
    console.log(`Apply the following SQL in your ${dashboardHint}:\n`);
    console.log('─'.repeat(72));
    console.log(SQL);
    console.log('─'.repeat(72));
    console.log('\nThen re-run the pipeline. The migration is idempotent (safe to run twice).\n');
    return;
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('pg package not installed. Run: npm install pg');
    console.error('Or apply migrate.sql manually via Supabase Dashboard → SQL Editor.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query(SQL);
    await client.end();
    console.log('Migration applied successfully.');
  } catch (err) {
    await client.end().catch(() => {});
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
})();
