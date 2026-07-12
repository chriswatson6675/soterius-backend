'use strict';

// migrate.js — deterministic, ledger-tracked migration runner.
//
// Supersedes the single-file `apply-migration.js` for full-schema work. It:
//   1. Reads the intended order from `db/migrations/manifest.json` (NOT a
//      filename sort) so the historical 038/039/040 number collisions and the
//      out-of-band 004a cohorts migration apply in one unambiguous sequence.
//   2. Tracks applied migrations in a `schema_migrations` ledger table
//      (version + sha256 checksum + applied_at), so re-runs are incremental and
//      the DB can be recreated from empty with no manual intervention.
//   3. Enforces a bijection between the manifest and the .sql files on disk, so
//      a forgotten manifest entry (or an orphan file) fails loudly instead of
//      silently being skipped.
//
// Two execution backends (same ordering/ledger logic on top of both):
//   - Supabase Management API (default): needs SUPABASE_ACCESS_TOKEN + SUPABASE_URL
//     in backend/.env. This is the mechanism the project already uses (read/write
//     DDL; the Supabase MCP is read-only and cannot run DDL).
//   - node-postgres (`pg`): used when DATABASE_URL is set (or --database-url is
//     passed). This is the unattended "recreate from an empty database" path —
//     point it at a fresh Postgres / a fresh Supabase project's direct connection
//     string and it builds the whole schema. Requires `npm i pg` (lazy-loaded).
//
// A fourth, complementary capability closes the gap the other three cannot:
//   4. `audit` independently verifies the LIVE DATABASE against what each
//      migration's own SQL declares it should have created — it does not take
//      the ledger's word for anything. `status`/`up`/`baseline` all trust
//      `schema_migrations`; `audit` is the check that catches the ledger being
//      wrong (a migration stamped "applied" whose objects were never actually
//      created — see db/migrations/README.md "Why db:audit exists").
//
// Usage:
//   node tooling/db/migrate.js verify           # manifest<->disk bijection + order sanity (no DB)
//   node tooling/db/migrate.js plan              # print the ordered plan (no DB)
//   node tooling/db/migrate.js status            # show applied vs pending (reads ledger; TRUSTS the ledger)
//   node tooling/db/migrate.js audit             # independently verify live schema vs each migration's own SQL (READ-ONLY, never trusts the ledger)
//   node tooling/db/migrate.js audit --verbose   # also print every passing check, not just warnings/failures
//   node tooling/db/migrate.js up                # apply all pending (default command)
//   node tooling/db/migrate.js up --dry-run      # show what WOULD apply, touch nothing
//   node tooling/db/migrate.js baseline          # mark every manifest migration as already-applied
//                                                #   (for an existing DB adopting the ledger — no DDL run)
//   node tooling/db/migrate.js unstamp <file>    # remove one migration's ledger stamp (repair a false "applied")
//   DATABASE_URL=postgres://... node tooling/db/migrate.js up   # unattended, against any Postgres

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { extractContract } = require('./contract-extractor');
const { checkContract } = require('./catalog-audit');

const MIGRATIONS_DIR = path.join(__dirname, '../../db/migrations');
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'manifest.json');

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// ── args ──────────────────────────────────────────────────────────────────────
const cmd = (process.argv[2] || 'up').toLowerCase();
const dryRun = process.argv.includes('--dry-run');
const dbUrlArg = argValue('--database-url') || process.env.DATABASE_URL;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

// ── manifest + disk ─────────────────────────────────────────────────────────
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) fail(`manifest not found: ${MANIFEST_PATH}`);
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const list = parsed.migrations;
  if (!Array.isArray(list) || list.length === 0) fail('manifest.migrations must be a non-empty array');
  return list;
}

function diskMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'));
}

// Enforce manifest <-> disk bijection. Returns the ordered manifest on success.
function verifyManifest() {
  const manifest = loadManifest();
  const disk = diskMigrations();
  const manifestSet = new Set(manifest);
  const diskSet = new Set(disk);

  const problems = [];
  if (manifest.length !== manifestSet.size) {
    const dupes = manifest.filter((f, i) => manifest.indexOf(f) !== i);
    problems.push(`manifest lists duplicate entries: ${[...new Set(dupes)].join(', ')}`);
  }
  const missingOnDisk = manifest.filter((f) => !diskSet.has(f));
  if (missingOnDisk.length) problems.push(`in manifest but missing on disk: ${missingOnDisk.join(', ')}`);
  const missingInManifest = disk.filter((f) => !manifestSet.has(f));
  if (missingInManifest.length) problems.push(`on disk but missing from manifest: ${missingInManifest.join(', ')}`);

  if (problems.length) {
    console.error('✗ manifest verification FAILED:');
    problems.forEach((p) => console.error(`   - ${p}`));
    process.exit(1);
  }
  return manifest;
}

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS_DIR, file))).digest('hex');
}

// ── DB backend ────────────────────────────────────────────────────────────────
// runSql(sql) -> Promise<rows[]>. Chooses pg (if DATABASE_URL) or Management API.
function makeRunner() {
  if (dbUrlArg) return pgRunner(dbUrlArg);
  return managementApiRunner();
}

function pgRunner(connectionString) {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    fail('DATABASE_URL is set but the `pg` package is not installed. Run: cd backend && npm i pg');
  }
  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  let connected = false;
  return {
    label: `postgres (${redact(connectionString)})`,
    async run(sql) {
      if (!connected) { await client.connect(); connected = true; }
      const res = await client.query(sql);
      return Array.isArray(res) ? res.flatMap((r) => r.rows || []) : res.rows || [];
    },
    async close() { if (connected) await client.end(); },
  };
}

function sslFor(cs) {
  // Supabase / most hosted Postgres require TLS; localhost usually doesn't.
  return /localhost|127\.0\.0\.1/.test(cs) ? false : { rejectUnauthorized: false };
}

function managementApiRunner() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const url = process.env.SUPABASE_URL;
  if (!token || !url) {
    fail('No DATABASE_URL, and SUPABASE_ACCESS_TOKEN + SUPABASE_URL are required for the Management API backend — check backend/.env');
  }
  const projectRef = new URL(url).hostname.split('.')[0];
  return {
    label: `supabase management api (project ${projectRef})`,
    run(sql) {
      const body = JSON.stringify({ query: sql });
      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: 'api.supabase.com',
            path: `/v1/projects/${projectRef}/database/query`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let out = '';
            res.on('data', (d) => (out += d));
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try { resolve(out ? JSON.parse(out) : []); }
                catch { resolve([]); }
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 800)}`));
              }
            });
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    },
    async close() {},
  };
}

function redact(cs) {
  try { const u = new URL(cs); return `${u.protocol}//${u.hostname}:${u.port || ''}${u.pathname}`; }
  catch { return 'db'; }
}

// ── ledger ops ────────────────────────────────────────────────────────────────
async function ensureLedger(db) { await db.run(LEDGER_DDL); }

async function appliedVersions(db) {
  const rows = await db.run('SELECT version, checksum FROM schema_migrations;');
  const map = new Map();
  for (const r of rows) map.set(r.version, r.checksum);
  return map;
}

function ledgerUpsert(version, chk) {
  return `INSERT INTO schema_migrations (version, checksum) VALUES ('${version}', '${chk}')
    ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();`;
}

// Read-only ledger read for `audit` — deliberately does NOT call ensureLedger
// (which issues a CREATE TABLE IF NOT EXISTS). `audit` must never issue DDL,
// even an idempotent no-op one, so it tolerates the ledger table not existing
// yet rather than creating it.
async function readLedgerSafe(db) {
  try {
    const rows = await db.run('SELECT version FROM schema_migrations;');
    return new Set(rows.map((r) => r.version));
  } catch {
    return null; // ledger table doesn't exist — audit proceeds without it
  }
}

// ── live catalog snapshot (read-only) ───────────────────────────────────────
// One batch of SELECT-only queries against information_schema/pg_catalog,
// turned into lookup structures. This is the independent source of truth
// `audit` checks contracts against — never the ledger.
async function fetchCatalogSnapshot(db) {
  const tables = await db.run(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';`
  );
  const columns = await db.run(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public';`
  );
  const constraints = await db.run(
    `SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public';`
  );
  const indexes = await db.run(
    `SELECT tablename AS table_name, indexname FROM pg_indexes WHERE schemaname='public';`
  );
  const functions = await db.run(
    `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public';`
  );
  const triggers = await db.run(
    `SELECT event_object_table AS table_name, trigger_name FROM information_schema.triggers WHERE trigger_schema='public';`
  );
  const views = await db.run(`SELECT table_name FROM information_schema.views WHERE table_schema='public';`);
  const rls = await db.run(
    `SELECT relname AS table_name, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';`
  );
  const extensions = await db.run(`SELECT extname FROM pg_extension;`);

  const columnsByTable = new Map();
  for (const r of columns) {
    if (!columnsByTable.has(r.table_name)) columnsByTable.set(r.table_name, new Set());
    columnsByTable.get(r.table_name).add(r.column_name);
  }
  const constraintsByTable = new Map();
  for (const r of constraints) {
    if (!constraintsByTable.has(r.table_name)) constraintsByTable.set(r.table_name, []);
    constraintsByTable.get(r.table_name).push({ name: r.conname, contype: r.contype, definition: r.definition });
  }
  const indexesByTable = new Map();
  for (const r of indexes) {
    if (!indexesByTable.has(r.table_name)) indexesByTable.set(r.table_name, new Set());
    indexesByTable.get(r.table_name).add(r.indexname);
  }
  const triggersByTable = new Map();
  for (const r of triggers) {
    if (!triggersByTable.has(r.table_name)) triggersByTable.set(r.table_name, new Set());
    triggersByTable.get(r.table_name).add(r.trigger_name);
  }
  const rlsByTable = new Map();
  for (const r of rls) rlsByTable.set(r.table_name, r.relrowsecurity === true || r.relrowsecurity === 't');

  return {
    tableSet: new Set(tables.map((r) => r.table_name)),
    columnsByTable,
    constraintsByTable,
    indexesByTable,
    functionSet: new Set(functions.map((r) => r.name)),
    triggersByTable,
    viewSet: new Set(views.map((r) => r.table_name)),
    rlsByTable,
    extensionSet: new Set(extensions.map((r) => r.extname)),
  };
}

// ── commands ──────────────────────────────────────────────────────────────────
async function cmdPlan() {
  const manifest = verifyManifest();
  console.log(`Migration plan (${manifest.length} migrations, in apply order):\n`);
  manifest.forEach((f, i) => console.log(`  ${String(i + 1).padStart(3, '0')}  ${f}`));
  console.log('\n✓ manifest ↔ disk bijection OK');
}

async function cmdVerify() {
  const manifest = verifyManifest();
  console.log(`✓ manifest ↔ disk bijection OK (${manifest.length} migrations)`);
  const warnings = forwardReferenceScan(manifest);
  if (warnings.length) {
    console.log('\n⚠ ordering warnings (a table is referenced before any migration creates it):');
    warnings.forEach((w) => console.log(`   - ${w}`));
    process.exit(1);
  }
  console.log('✓ no forward-reference ordering breaks detected');
}

async function cmdStatus() {
  const manifest = verifyManifest();
  const db = makeRunner();
  try {
    await ensureLedger(db);
    const applied = await appliedVersions(db);
    console.log(`backend : ${db.label}\n`);
    let pending = 0, drift = 0;
    for (const f of manifest) {
      if (applied.has(f)) {
        const changed = applied.get(f) !== checksum(f);
        if (changed) drift++;
        console.log(`  ${changed ? '±' : '✓'} ${f}${changed ? '   (checksum drift — file edited since applied)' : ''}`);
      } else {
        pending++;
        console.log(`  · ${f}   (pending)`);
      }
    }
    console.log(`\n${applied.size} applied · ${pending} pending · ${drift} drifted`);
  } finally {
    await db.close();
  }
}

// `audit` — independently verifies the LIVE DATABASE against what each
// migration's own SQL declares. It reads the ledger only to report a
// three-way cross-check (see classifyAudit below); it never trusts the
// ledger's claim that a migration is applied, and it issues ONLY SELECT
// statements — no DDL, not even an idempotent CREATE TABLE IF NOT EXISTS.
async function cmdAudit() {
  const manifest = verifyManifest();
  const verbose = process.argv.includes('--verbose');
  const db = makeRunner();
  try {
    const [ledgerVersions, catalog] = await Promise.all([readLedgerSafe(db), fetchCatalogSnapshot(db)]);
    console.log(`backend : ${db.label}`);
    console.log(
      ledgerVersions === null
        ? 'ledger  : NOT FOUND — cross-checking structure only, every migration reported as if pending\n'
        : `ledger  : ${ledgerVersions.size} version(s) recorded\n`
    );

    const results = manifest.map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const contract = extractContract(sql);
      const findings = checkContract(contract, catalog);
      const ledgerApplied = ledgerVersions === null ? null : ledgerVersions.has(file);
      const dynamicDdl = contract.dynamicDdl && contract.dynamicDdl.looksLikeDdl;
      return { file, findings, dynamicDdl, ...classifyAudit(findings, ledgerApplied) };
    });

    let pass = 0, warning = 0, failCount = 0;
    for (const r of results) {
      if (r.verdict === 'PASS') pass++;
      else if (r.verdict === 'WARNING') warning++;
      else failCount++;

      const icon = r.verdict === 'PASS' ? '✓' : r.verdict === 'WARNING' ? '⚠' : '✗';
      console.log(`  ${icon} ${r.verdict.padEnd(7)} ${r.file}${r.ledgerNote ? `   — ${r.ledgerNote}` : ''}`);

      const toShow = verbose ? r.findings : r.findings.filter((f) => f.status !== 'ok');
      for (const f of toShow) {
        const tag = f.status === 'ok' ? '   ' : f.status === 'warn' ? ' ⚠ ' : ' ✗ ';
        console.log(`      ${tag}${f.object} — ${f.message}`);
      }

      if (r.dynamicDdl) {
        console.log(
          '      ⓘ  this migration builds DDL dynamically (DO $$ / EXECUTE format) — objects created via string-' +
            'templated statements are NOT visible to this static parser and are not checked above. Verify manually if relevant.'
        );
      }
      if (r.verdict === 'FAIL') {
        console.log(
          '      ⓘ  before treating this as an unapplied migration: check whether a LATER migration intentionally ' +
            'dropped/renamed/retyped the same object (a documented supersession, not a defect) — this audit checks ' +
            "each migration's own declaration in isolation and does not track cross-migration supersession."
        );
      }
    }

    console.log(`\n${pass} PASS · ${warning} WARNING · ${failCount} FAIL`);
    if (failCount > 0) {
      console.log(
        '\nFAIL means: a migration the ledger records as applied has objects missing or not matching live — ' +
          'the database does not actually match what the repository declares. Investigate before trusting `db:status`.'
      );
      process.exit(1);
    }
  } finally {
    await db.close();
  }
}

// Combine a migration's structural findings with its ledger status into one
// PASS/WARNING/FAIL verdict, per the three-way split:
//   ledger says applied  + structure matches   -> PASS
//   ledger says applied  + structure broken     -> FAIL  (stamped-but-absent/wrong — the 042 bug)
//   ledger says pending  + nothing live yet      -> PASS  (correctly not-yet-applied)
//   ledger says pending  + partially/fully live  -> WARNING (ledger drift the OTHER way — needs reconciliation)
function classifyAudit(findings, ledgerApplied) {
  const totalDeclared = findings.length;
  const totalPresent = findings.filter((f) => f.presence === 'present').length;

  if (ledgerApplied === true) {
    const hasFail = findings.some((f) => f.status === 'fail');
    const hasWarn = findings.some((f) => f.status === 'warn');
    return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARNING' : 'PASS', ledgerNote: null };
  }

  // ledgerApplied is false or null (ledger absent) — treat both as "not
  // confirmed applied" and reason from structure alone.
  if (totalDeclared === 0) {
    return { verdict: 'PASS', ledgerNote: 'no structural objects declared by this migration' };
  }
  if (totalPresent === 0) {
    return {
      verdict: 'PASS',
      ledgerNote: ledgerApplied === null ? 'pending — ledger not found' : 'correctly PENDING — not yet applied',
    };
  }
  if (totalPresent === totalDeclared) {
    return {
      verdict: 'WARNING',
      ledgerNote: 'live objects fully match this migration but it is NOT recorded as applied — reconcile with `db:baseline`',
    };
  }
  return {
    verdict: 'WARNING',
    ledgerNote: `only ${totalPresent}/${totalDeclared} declared objects exist live and it is NOT recorded as applied — partially applied outside the ledger, reconcile manually before running \`db:migrate\``,
  };
}

async function cmdBaseline() {
  const manifest = verifyManifest();
  // `--upto <file>` stamps only through that migration (inclusive) — for an
  // existing DB where the tail of the sequence is genuinely not yet applied.
  const upto = argValue('--upto');
  let toStamp = manifest;
  if (upto) {
    const idx = manifest.indexOf(upto);
    if (idx < 0) fail(`--upto "${upto}" is not in the manifest`);
    toStamp = manifest.slice(0, idx + 1);
  }
  const db = makeRunner();
  try {
    await ensureLedger(db);
    console.log(`Baselining ${toStamp.length}/${manifest.length} migrations as already-applied on ${db.label}`);
    if (upto) console.log(`(--upto ${upto}; the remaining ${manifest.length - toStamp.length} stay PENDING for db:migrate)`);
    console.log('(no DDL is executed — this only stamps the ledger for an existing database)\n');
    if (dryRun) { console.log('DRY RUN — nothing written.'); return; }
    for (const f of toStamp) {
      await db.run(ledgerUpsert(f, checksum(f)));
      console.log(`  stamped ${f}`);
    }
    console.log('\n✓ baseline complete');
  } finally {
    await db.close();
  }
}

// Repair: remove a ledger stamp so `up` will (re)apply that migration. For when a
// migration was baselined/stamped but its DDL is not actually present in the DB.
async function cmdUnstamp() {
  const version = process.argv[3];
  if (!version || version.startsWith('--')) fail('usage: migrate.js unstamp <migration-file.sql>');
  const manifest = verifyManifest();
  if (!manifest.includes(version)) fail(`"${version}" is not in the manifest`);
  const db = makeRunner();
  try {
    await ensureLedger(db);
    if (dryRun) { console.log(`DRY RUN — would remove ledger stamp for ${version}`); return; }
    await db.run(`DELETE FROM schema_migrations WHERE version = '${version}';`);
    console.log(`✓ un-stamped ${version} — it is now PENDING and will be applied by \`up\``);
  } finally {
    await db.close();
  }
}

async function cmdUp() {
  const manifest = verifyManifest();
  const db = makeRunner();
  try {
    await ensureLedger(db);
    const applied = await appliedVersions(db);
    const pending = manifest.filter((f) => !applied.has(f));

    console.log(`backend : ${db.label}`);
    console.log(`applied : ${applied.size}   pending : ${pending.length}\n`);

    const drifted = manifest.filter((f) => applied.has(f) && applied.get(f) !== checksum(f));
    if (drifted.length) {
      console.log('⚠ checksum drift on already-applied migrations (file edited after apply):');
      drifted.forEach((f) => console.log(`   - ${f}`));
      console.log('  These are NOT re-run. Migrations are meant to be immutable once applied.\n');
    }

    if (pending.length === 0) { console.log('✓ nothing to apply — schema is up to date'); return; }

    if (dryRun) {
      console.log('DRY RUN — would apply, in order:');
      pending.forEach((f) => console.log(`   + ${f}`));
      return;
    }

    for (const f of pending) {
      process.stdout.write(`applying ${f} … `);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      // Migration body then ledger upsert, sent together so the ledger only
      // records a version whose DDL actually executed. Normalise the terminator
      // so a file that doesn't end in `;` can't merge into the ledger insert.
      const body = `${sql.replace(/;?\s*$/, '')};`;
      await db.run(`${body}\n${ledgerUpsert(f, checksum(f))}`);
      console.log('ok');
    }
    console.log(`\n✓ applied ${pending.length} migration(s)`);
  } finally {
    await db.close();
  }
}

// Lightweight static ordering check. Catches two classes of reproducibility bug:
//   1. FORWARD REFERENCE — a table is ALTERed/FK'd before any migration CREATEs
//      it (e.g. cohorts altered at 005 but created at 004a — must be earlier).
//   2. MISSING FOUNDATIONAL MIGRATION — a table is ALTERed but NO migration ever
//      creates it (the actual original F3 bug: cohorts altered at 005, created
//      nowhere in the sequence). ALTER against a never-created table is treated
//      as an error; a bare FK REFERENCES to a never-created table is only noted,
//      since it may legitimately point at an external schema (e.g. auth.users).
function forwardReferenceScan(manifest) {
  const createdAt = new Map();   // table -> first index that CREATEs it
  const alteredAt = new Map();   // table -> first index that ALTERs it
  const fkRefAt = new Map();     // table -> first index that FK-REFERENCES it
  const strip = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  const note = (map, key, i) => { if (!map.has(key)) map.set(key, i); };

  manifest.forEach((f, i) => {
    const sql = strip(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').toLowerCase());
    for (const m of sql.matchAll(/create table (?:if not exists )?["']?([a-z0-9_]+)["']?/g)) note(createdAt, m[1], i);
    for (const m of sql.matchAll(/alter table (?:if exists )?["']?([a-z0-9_]+)["']?/g)) note(alteredAt, m[1], i);
    for (const m of sql.matchAll(/references ["']?([a-z0-9_]+)["']?\s*\(/g)) note(fkRefAt, m[1], i);
  });

  const warnings = [];
  // 2. ALTER against a table never created anywhere in the sequence.
  for (const [table, idx] of alteredAt) {
    if (!createdAt.has(table)) {
      warnings.push(`"${table}" is ALTERed by ${manifest[idx]} but no migration CREATEs it — missing foundational migration?`);
    } else if (createdAt.get(table) > idx) {
      warnings.push(`"${table}" is ALTERed by ${manifest[idx]} but not CREATEd until ${manifest[createdAt.get(table)]}`);
    }
  }
  // 1. FK reference before creation (only when the table IS created somewhere).
  for (const [table, idx] of fkRefAt) {
    if (createdAt.has(table) && createdAt.get(table) > idx) {
      warnings.push(`"${table}" is FK-referenced by ${manifest[idx]} but not CREATEd until ${manifest[createdAt.get(table)]}`);
    }
  }
  return warnings;
}

// ── dispatch ──────────────────────────────────────────────────────────────────
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

// Exported for the test suite (regression guard) — no DB access, pure file scan.
module.exports = { verifyManifest, forwardReferenceScan, loadManifest, diskMigrations };

if (require.main === module) {
  (async () => {
    try {
      switch (cmd) {
        case 'plan': await cmdPlan(); break;
        case 'verify': await cmdVerify(); break;
        case 'status': await cmdStatus(); break;
        case 'audit': await cmdAudit(); break;
        case 'baseline': await cmdBaseline(); break;
        case 'unstamp': await cmdUnstamp(); break;
        case 'up': await cmdUp(); break;
        default: fail(`unknown command "${cmd}" — use one of: verify | plan | status | audit | up | baseline | unstamp`);
      }
    } catch (e) {
      fail(e.message || String(e));
    }
  })();
}
