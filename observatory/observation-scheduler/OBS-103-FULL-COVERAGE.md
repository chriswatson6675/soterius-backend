# OBS-103 — Full-Population Scheduling (Deterministic Fixed-UTC 15-Minute Shards)

Engineering governance record for the OBS-103 full-coverage transition. Co-located
with the code it governs. Formal registration of a peer governance artefact in the
parent repository's `DOCUMENT_REGISTER.md` is a follow-up (this branch does not
modify the parent governance repo); the supersession notes below are authoritative
for the code in this branch.

## Scheduling authority

- **UTC is the sole scheduling authority.** No `Europe/London`, no DST logic. All
  due times are computed with `Date.UTC` / `getUTC*` only.
- **Railway wake:** one cron, `*/15 * * * *` (00/15/30/45 each UTC hour). No second
  service, no second cron.
- **Daily signals** (SPF, DKIM, DMARC): due once per UTC calendar day, at the
  organisation's assigned 15-minute slot.
- **Weekly signals** (DNSSEC, CAA): due once per deterministic **seven-day UTC
  epoch cycle**, at the organisation's assigned weekly slot — *not* a named weekday.

## Deterministic shard assignment (`utc-shard-v1`)

`observation-state/shard-assignment.js`.

- Stable hash: **FNV-1a 32-bit** over the immutable canonical `organisation_id`
  (`Math.imul`, UTF-16 code units) — deterministic across Node versions/platforms;
  never `Math.random`, DB row order, insertion order, or mutable fields.
- `dailySlotIndex = fnv1a32(orgId + ':daily:v1') % 96` → one of 96 daily slots.
- `weeklySlotIndex = fnv1a32(orgId + ':weekly:v1') % 672` → one of 672 weekly slots
  (7 days × 96). DNSSEC and CAA share this slot (kept together per org).
- **Epoch anchor (immutable):** `2024-01-01T00:00:00.000Z` (a Monday). The weekly
  grid is `EPOCH + k·7d + slot·15min`.
- Fixed regression vectors for the five pilot orgs are locked in
  `shard-assignment.test.js`. Distribution over 16,167 fixtures: daily 147–198/slot
  (mean 168.4, no empty), weekly 13–39/slot (mean 24.1, no empty).
- Rebalancing is done by shipping a **new** version (`utc-shard-v2`), never by
  editing `utc-shard-v1` — existing `next_due_at` values are only recomputed at
  their next natural reschedule.

## Cadence policies (`cadence-policy.js`)

- Active: `daily-v4-utc-15m-shard`, `weekly-v4-utc-7d-15m-shard`.
- **Next-due = the next occurrence of the org's assigned slot strictly after the
  completion instant** — a point on an absolute grid, never `completion + interval`.
  A late run returns to its slot; a multi-day / multi-cycle outage collapses to a
  single execution (no catch-up storm); no completion drift; DST-independent.
- **Retry** (`computeRetryNextDueAt`): a temporary due-time at the next quarter-hour
  wake (grid-aligned, fast even for weekly signals) for the first
  `MAX_DAILY_RETRY_ATTEMPTS` (5); after that it falls back to the signal's own
  normal slot. A subsequent success always reschedules onto the normal slot, so
  failures/retries never permanently move the normal cadence.

### Superseded (retained for interpretation, not active)
- `daily-v1` / `weekly-v1` — plain fixed offset. **Superseded.**
- `daily-v2-0930-london` / `weekly-v2-0930-london` — 09:30 Europe/London anchor;
  dual-wake DST design. **Superseded** (DST drift, Friday-weekday drift).
- `daily-v3-0830-utc` / `weekly-v3-fri-0830-utc` — single 08:30 UTC batch, Friday
  weekly. **Superseded** (whole-population burst; Friday peak).
- Also superseded: the **dual-wake** `30 8,9 * * *` design, the single **08:30 UTC
  batch**, globally shared **Friday** weekly execution, and the **hourly**
  distributed-shard recommendation (replaced by 15-minute).

## Coverage & eligibility

- Target: every organisation with exactly one **verified, uncontested, resolvable**
  domain — 16,167 orgs / 16,167 domains → 80,835 states (daily 48,501, weekly
  32,334).
- The **890** contested/ambiguous mappings are excluded and never auto-scanned
  (`enumerateEligibleOrganisations` only accepts `resolveOrganisationByDomain →
  RESOLVED`).
- State key unchanged: `(organisation_id, observation_type)` — valid because the
  authority population is one resolvable domain per org.

## Provisioning (`provision-observation-states-cli.js`)

Idempotent, batched, restartable. Dry-run is the default; real writes require
`--production --confirm PROVISION-STATES`. Creates only missing `(org,type)` rows —
never deletes/duplicates, never disturbs the pilot rows or their evidence. Initial
`next_due_at` is the org's next assigned slot (daily within 24h, weekly within the
current 7-day cycle), so newcomers enter smoothly, not all at once.

## Scheduler (`run-drain-cli.js` → `drain.js`)

Bounded draining: pages due states oldest-first (`findDuePage`, deterministic,
starvation-free, replaces the old 500 ceiling), claims atomically, observes only
due signals, and stops at `--max-states-per-run` (soft, overshoot ≤ concurrency×5),
`--runtime-budget-ms`, or when drained — leaving remaining work due for the next
wake. Bounded memory (one page at a time). `run-scheduler-cli.js --org` is retained
for local testing / controlled cohorts / incident response.

## Capacity (measured pilot ≈ 2–3.4 s/obs; extrapolated)

Steady state: ~53,120 obs/day (48,501 daily + 32,334/7 weekly), ~0.6 obs/s. Per
15-min wake ≈ 553 obs avg (504 daily + 48 weekly); worst observed dense slot ≈ 198
daily orgs → ~594+ obs. Runtime at concurrency 8 ≈ 2–4 min/wake (≈ 4 min worst) —
comfortably under 15 min. Recommended defaults: page 250, max-states-per-run 1500,
concurrency 8, runtime budget 12 min.

## Intended production config (NOT applied to live Railway)

`railway.observation-scheduler.json` (this branch):
- cron `*/15 * * * *`
- `node observatory/observation-scheduler/run-drain-cli.js --production --max-states-per-run 1500 --page-size 250 --concurrency 8 --runtime-budget-ms 720000`
- 1 replica, `ON_FAILURE`/10, single service.

## Rollout (staged; execute under separate authorisation)

- **Phase 0 — code only.** Deploy fixed-UTC drain + provisioning + migration 053.
  Keep the 5 pilot orgs running (they migrate to their slots on next completion).
  Confirm 15-min cron fires, invocation duration, claims.
- **Phase 1 — small cohort.** `provision --production --confirm --limit 200`
  (≈1,000 states). Watch a full daily cycle: failure rate <5%, no persistent
  backlog, evidence persists. Reconciliation gate before proceeding.
- **Phase 2 — larger cohorts.** Provision in bounded batches (e.g. +2,000 then
  +5,000). Go/no-go each batch: backlog drains within a wake or two; failure rate
  stable; oldest-due age bounded.
- **Phase 3 — full population.** Provision the remaining eligible orgs (→80,835
  states). Drain command already unbounded-by-cohort. Monitor first full daily
  cycle and first full seven-day cycle; verify slot distribution matches design.
- **Phase 4 — acceptance.** Accept only when every eligible domain has successful
  SPF+DKIM+DMARC+DNSSEC+CAA evidence, no unexplained persistent backlog, and the
  890 ambiguous mappings remain excluded (see `monitoring/coverage-reconciliation.sql`).

## Rollback

- Provisioning is additive; to pause, stop provisioning — existing states drain
  normally. Migration 053 is additive (indexes only) and safe to keep.
- To revert scheduling to the pilot, restore the previous
  `railway.observation-scheduler.json` start command/cron. Evidence is append-only
  and is never deleted on rollback.

## Reconciliation & monitoring

`monitoring/coverage-reconciliation.sql` — provisioned orgs/states, backlog, oldest
-due age, retry/failed, stale claims, slot distribution (hot-shard detection),
domains missing a signal, and the acceptance gate (all-five successful evidence per
eligible domain). Headline fields: ELIGIBLE ORGANISATIONS/DOMAINS, PROVISIONED
ORGANISATIONS/STATES, DOMAINS SUCCESSFULLY OBSERVED / NEVER OBSERVED, DAILY/WEEKLY
BACKLOG, OLDEST DUE AGE, FAILED STATES, AMBIGUOUS DOMAINS EXCLUDED.
