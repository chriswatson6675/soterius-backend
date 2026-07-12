# Database migrations

The schema is defined by the numbered `*.sql` files in this directory, applied in
the order declared by **`manifest.json`** and tracked in a **`schema_migrations`**
ledger. This makes the database **reproducible from empty with no manual steps**.

## Order is defined by `manifest.json`, not by filename

Three historical number collisions exist (`038`, `039`, `040` each appear on two
files, from two parallel workstreams) plus one out-of-band file (`004a`). A plain
filename sort is therefore ambiguous. `manifest.json` is the single source of
truth for order and resolves the collisions explicitly, so **no file was renamed**
(no history rewrite). Key dependency edges the order preserves:

- `004a_create_cohorts` **before** `005_dataset_governance` (005 ALTERs `cohorts`).
- `038_collection_programmes_and_runs` **before** the two observation-envelope
  migrations (`039_..._dnssec`, `040_..._rollout`) that FK the collection tables.
- `039_..._dnssec` + `040_..._rollout` **before** `041_fix_organisation_id_type`.

## Four complementary capabilities

The migration system is deliberately split into four commands with different
trust models, so no single one is asked to do a job it structurally can't:

| Command | Touches the DB? | Trusts the ledger? | Answers |
|---|---|---|---|
| `db:verify` | No | n/a | Is the manifest internally consistent — no duplicates, nothing orphaned, no forward references? |
| `db:status` | Read | **Yes** | What does the ledger *say* is applied vs pending? |
| `db:migrate` | Write | Yes (uses it to pick what to apply) | Apply everything pending, in order. |
| `db:audit` | Read only | **No — independently verifies** | Does the *live schema* actually match what each migration's own SQL declares? |

`db:status` is only as honest as the ledger. A migration can be **stamped as
applied when its DDL never actually ran** (this happened for real — migration
042 was baselined from a false assumption and the ledger showed 0 drift while
the table's CHECK constraint and four columns were silently absent). `db:audit`
exists specifically to catch that class of bug: it parses each migration file's
own SQL to derive what it *declares* (tables, columns, constraints — including
comparing a named constraint's live definition against the values the migration
declared, not just checking the name exists — indexes, functions, triggers,
views, RLS, extensions), fetches the live catalog directly from
`information_schema`/`pg_catalog`, and compares the two. It never runs DDL, not
even an idempotent `CREATE TABLE IF NOT EXISTS` on the ledger table itself.

```bash
npm run db:verify     # manifest↔disk bijection + ordering sanity — NO DB, runs in CI/tests
npm run db:plan       # print the ordered apply plan — no DB
npm run db:status     # applied vs pending vs checksum-drift (reads the ledger; TRUSTS it)
npm run db:audit      # independently verify live schema vs each migration's own SQL (READ-ONLY; does not trust the ledger)
npm run db:audit -- --verbose   # also print every passing check, not just warnings/failures
npm run db:migrate    # apply all pending migrations, in order, recording each in the ledger
npm run db:baseline   # stamp every migration as already-applied (adopting the ledger on an EXISTING db)
node tooling/db/migrate.js unstamp <file>   # repair: remove a false ledger stamp so `db:migrate` will (re)apply it
```

### Reading `db:audit` output

Each migration gets one verdict:

- **PASS** — either the ledger says applied and every declared object matches
  live, or the ledger says pending and (correctly) nothing is live yet.
- **WARNING** — an unnamed/inline constraint (PK/FK/UNIQUE/CHECK with no
  `CONSTRAINT name`) couldn't be matched with certainty — these are checked on
  a best-effort basis and capped at WARNING rather than FAIL, since static
  parsing can't disambiguate them reliably — **or** live objects fully/partially
  match a migration the ledger does NOT record as applied (ledger drift in the
  other direction from the 042 bug; reconcile with `db:baseline`).
- **FAIL** — the ledger says applied, but a declared object is missing, or a
  *named* constraint exists but its live definition doesn't contain a value the
  migration declared (the exact 042 signature: a constraint name that collided
  with an earlier, narrower version and never actually got updated).

Two honest limitations, surfaced inline rather than hidden:
- Dynamic DDL (`DO $$ ... EXECUTE format(...) $$` blocks, used e.g. by `041` and
  `040_observation_envelope_rollout` to loop an ALTER across several tables) is
  invisible to the static parser. A migration built entirely from dynamic SQL
  reports "no structural objects declared" — a vacuous PASS, not a verified one
  — and the audit prints an explicit `ⓘ` note whenever it detects this, so it's
  never mistaken for a clean bill of health.
- A FAIL only means *this migration's own declaration* doesn't hold live — it
  does not track whether a **later** migration intentionally superseded the
  object (renamed an index, dropped and retyped a column). The audit prints a
  reminder to check later migrations before treating a FAIL as an unapplied
  migration. (Both real cases found during development were exactly this: a
  documented, later, intentional change — not a defect.)

Two execution backends, same ordering/ledger logic:

- **Supabase Management API** (default): needs `SUPABASE_ACCESS_TOKEN` +
  `SUPABASE_URL` in `backend/.env`. The Supabase MCP is read-only and cannot run
  DDL; this is the project's write path.
- **node-postgres** (`DATABASE_URL=postgres://…`, requires `npm i pg`): the
  unattended *recreate-from-empty* path. Point it at a fresh Postgres or a fresh
  Supabase project's direct connection string:
  ```bash
  DATABASE_URL=postgresql://… npm run db:migrate
  ```

## Adopting the ledger on the existing production database

The live database predates the ledger. Run **once** against it so already-applied
migrations are not re-executed:

```bash
npm run db:baseline
```

This only creates `schema_migrations` and stamps the current migration set. It
executes **no** DDL and touches no evidence. From then on, `npm run db:migrate`
applies only genuinely new migrations.

## Adding a new migration

1. Create `NNN_description.sql` here (idempotent: `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, etc.). Do **not** reuse an existing number. Prefer
   literal DDL over `DO $$ ... EXECUTE format(...) $$` where practical — dynamic
   DDL is invisible to `db:audit` (see above).
2. Append its filename to the end of `manifest.json`.
3. `npm run db:verify` (also enforced by `npm test`) — fails if the file is
   missing from the manifest, duplicated, or ordered before a table it needs.
4. `npm run db:migrate`.
5. `npm run db:audit` — confirm the new migration shows PASS, not just that
   `db:status` shows it applied. `db:status` only reflects the ledger; `db:audit`
   confirms the objects it claims to have created actually exist.

**Never edit an already-applied migration.** The ledger stores a checksum;
edits show as *drift* in `db:status` and are not re-applied. Change the schema
with a new migration instead.
