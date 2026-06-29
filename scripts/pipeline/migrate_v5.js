'use strict';
/**
 * Migration V5 — Dataset Governance (DDL runner).
 *
 * Applies migrate_v5.sql to the Supabase database.
 *
 * With DATABASE_URL set: runs SQL directly via pg.
 * Without DATABASE_URL: prints SQL and a link to Supabase Dashboard.
 *
 * Usage:
 *   node scripts/pipeline/migrate_v5.js
 *
 * After DDL is applied, run the data backfill:
 *   node scripts/pipeline/migrate_v5_data.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs   = require('fs');
const path = require('path');

const SQL_FILE = path.join(__dirname, '../../db/migrations/migrate_v5.sql');
const SQL      = fs.readFileSync(SQL_FILE, 'utf8');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const projectRef   = SUPABASE_URL.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] || null;
const dashboardUrl = projectRef
  ? `https://supabase.com/dashboard/project/${projectRef}/sql/new`
  : 'Supabase Dashboard → SQL Editor';

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n' + '═'.repeat(72));
    console.log(' MIGRATION V5 — DDL REQUIRED');
    console.log('═'.repeat(72));
    console.log('\nDATABASE_URL is not set. Apply the SQL below manually:\n');
    console.log(`  Dashboard: ${dashboardUrl}\n`);
    console.log('─'.repeat(72));
    console.log(SQL);
    console.log('─'.repeat(72));
    console.log('\nAfter applying in the Dashboard, run:');
    console.log('  node scripts/pipeline/migrate_v5_data.js\n');
    return;
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('pg package not installed. Run: npm install pg');
    console.error(`Or apply ${SQL_FILE} manually via ${dashboardUrl}`);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('Applying migrate_v5.sql...');
    await client.connect();
    await client.query(SQL);
    await client.end();
    console.log('Migration V5 DDL applied successfully.');
    console.log('Now run: node scripts/pipeline/migrate_v5_data.js');
  } catch (err) {
    await client.end().catch(() => {});
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
})();
