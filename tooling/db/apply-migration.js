'use strict';

// apply-migration.js — apply ONE SQL migration from backend/db/migrations/ to the
// Supabase project via the Management API.
//
// NOTE (F3, 2026-07-12): For full-schema work prefer `migrate.js`, which applies
// the whole `manifest.json` sequence in deterministic order, tracks applied
// migrations in the `schema_migrations` ledger, and can recreate the DB from
// empty unattended. This single-file tool is retained for targeted one-off
// re-applies and ad-hoc use; it does NOT update the ledger, so after using it run
// `node tooling/db/migrate.js status` to reconcile.
//
// Why this exists: the Supabase MCP server is read-only and cannot execute DDL, and the
// PostgREST service-role client cannot either. CLAUDE.md's documented path is to paste the
// migration into the Supabase SQL Editor; this script is the scriptable equivalent, used
// previously for migrations 027 (DKIM) and 028 (DMARC).
//
// Requires SUPABASE_ACCESS_TOKEN (a personal access token) and SUPABASE_URL in backend/.env.
// Migrations are written to be idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS), so re-running is safe.
//
// Usage:
//   node backend/tooling/db/apply-migration.js 029_signal_quality_caa.sql --dry-run
//   node backend/tooling/db/apply-migration.js 029_signal_quality_caa.sql --confirm

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const confirm = process.argv.includes('--confirm');

if (!file) {
  console.error('usage: node backend/tooling/db/apply-migration.js <migration.sql> [--dry-run|--confirm]');
  process.exit(1);
}

const migrationPath = path.join(__dirname, '../../db/migrations', file);
if (!fs.existsSync(migrationPath)) {
  console.error(`migration not found: ${migrationPath}`);
  process.exit(1);
}
const sql = fs.readFileSync(migrationPath, 'utf8');

const token = process.env.SUPABASE_ACCESS_TOKEN;
const url = process.env.SUPABASE_URL;
if (!token || !url) {
  console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_URL required — check backend/.env');
  process.exit(1);
}
const projectRef = new URL(url).hostname.split('.')[0];

console.log(`migration : ${file}`);
console.log(`project   : ${projectRef}`);
console.log(`statements: ${sql.split(';').filter(s => s.trim()).length}`);

if (!confirm || dryRun) {
  console.log('\nDRY RUN — nothing applied. Pass --confirm to execute.\n');
  console.log(sql.split('\n').filter(l => !l.trim().startsWith('--') && l.trim()).slice(0, 8).join('\n') + '\n…');
  process.exit(0);
}

const body = JSON.stringify({ query: sql });
const req = https.request({
  host: 'api.supabase.com',
  path: `/v1/projects/${projectRef}/database/query`,
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
}, res => {
  let out = '';
  res.on('data', d => (out += d));
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`\nAPPLIED — HTTP ${res.statusCode}`);
      console.log(out.slice(0, 300) || '(no body)');
    } else {
      console.error(`\nFAILED — HTTP ${res.statusCode}`);
      console.error(out.slice(0, 800));
      process.exit(1);
    }
  });
});
req.on('error', e => { console.error('request error:', e.message); process.exit(1); });
req.write(body);
req.end();
