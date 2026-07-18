# OBS-103 — Deterministic Provisioning Cohorts

Operator guide for provisioning observation states to controlled rollout cohorts
with `provision-observation-states-cli.js`.

## Why `--limit` must NOT be used for a governed cohort

`--limit N` is **legacy (OBS-102)** and is left behaviourally unchanged only for
backward compatibility. It:

- considers the first `N` eligible organisations in **authority-enumeration
  order** (i.e. however Repository Authority happens to list them), then
- skips already-provisioned organisations **only after** that slice.

So `--limit 100` cannot guarantee 100 *new* organisations: if any of the slice
is already provisioned (e.g. a pilot org), fewer than 100 new orgs — and fewer
than 500 new states — are created. Authority-file order is also not a governed,
reproducible, or unbiased selection. **Do not use `--limit` for a rollout
cohort.**

## Canonical `:cohort:v1` ranking

`--cohort-size N` is the **governed** path. Every eligible organisation has a
deterministic global rank:

```
cohortRank(orgId) = fnv1a32( String(orgId) + ':cohort:v1' )   // unsigned 32-bit
```

Selection is a **total order**:

1. ascending unsigned `cohortRank`;
2. ascending `organisationId` as the deterministic tie-breaker.

The rank is a pure function of the immutable canonical organisation id, so it is
identical across machines, Node versions, authority-file order, and
database-return order. It reuses the single canonical `fnv1a32` in
`shard-assignment.js` (no second hash implementation) under a salt distinct from
the daily/weekly/retry scheduling salts — an org's rollout rank is independent of
its observation shard.

## Exclusion of already-provisioned organisations happens FIRST

`--cohort-size N`:

1. enumerates the complete eligible authority population (exactly one verified,
   uncontested, resolvable domain — ambiguous / contested / unresolved / domain-
   less organisations are excluded **before** ranking);
2. reads the already-provisioned organisation ids via the store abstraction
   (`store.listProvisionedOrganisationIds`) — this includes the five-org pilot;
3. **excludes** every already-provisioned organisation;
4. ranks the remainder by `cohortRank` (ascending, id tie-break);
5. selects the lowest-ranked `N` **new** organisations — exactly `N` when at
   least `N` remain, otherwise **all** remaining (reported as
   `sufficient: false`);
6. provisions only that selected set.

Because the rank is global, this is **cumulative**: selecting 100, provisioning
them, then selecting the next 900 yields exactly the same first 1,000 as a single
1,000-selection from the original baseline.

`store.listProvisionedOrganisationIds` retrieves the provisioned set **exhaustively
by explicit pagination** and cross-checks against the exact row count — it can
never silently truncate at the PostgREST 1000-row cap. A truncated or stalled
read fails loudly rather than returning a partial exclusion set.

## Governed rollout workflow (select → manifest → approve → provision)

Production provisioning **never regenerates** a cohort. It provisions only a
manifest that a human has reviewed and approved:

```
--cohort-size N   (selection, dry-run only)
      ↓ emits
reviewed manifest (JSON, carries an identity digest)
      ↓ human review + approval (note the cohortDigest)
--from-manifest <path> --production --confirm PROVISION-STATES --approve-digest <digest>
```

- **`--cohort-size N` is selection-only.** It never writes in production
  (`--cohort-size --production` is refused and points you here); it produces the
  manifest to review.
- **`--from-manifest <path>` is the only production write path.** It:
  1. loads and validates the manifest (schema + current `:cohort:v1` salt);
  2. **verifies identity** — recomputes the `cohortDigest` and each entry's rank;
     a tampered/edited manifest is refused;
  3. **reconciles against live state** and **refuses on drift** — if the current
     deterministic selection no longer matches the reviewed cohort (a manifest
     org lost eligibility, or a lower-ranked org would now displace it), it stops
     and asks for a fresh reviewed manifest;
  4. provisions **exactly** the manifest's organisation ids, idempotently.
- **The write can only ever complete or refuse — never expand.** The target is
  always the manifest's fixed id set, so a retry (or a concurrent run of the same
  manifest) cannot add organisations beyond the reviewed cohort.

Dry-run is still the default; `--from-manifest` without `--production --confirm`
validates + reconciles + reports the plan and writes nothing. A production write
additionally requires `--approve-digest <digest>` matching the manifest's
`cohortDigest`, so a swapped file cannot be provisioned even if internally
consistent. `--limit`, `--cohort-size`, and `--from-manifest` are mutually
exclusive.

## Manifest review

`--manifest <path>` writes a deterministic, credential-free, timestamp-free
manifest (`--manifest-format json|csv`, default `json`). It **refuses to
overwrite** an existing path unless `--force` is given (so a reviewed manifest is
never silently replaced). Without a path a JSON manifest is printed to stdout
between markers. Repeated selections over identical inputs produce
**byte-equivalent** manifests. Each entry carries: cohort position, global hash
rank, organisation id, organisation name (where available), domain, and
eligibility basis — and nothing mutable or secret. The `cohortDigest` is the
manifest identity to approve. CSV cells beginning with `= + - @` are prefixed
with `'` to neutralise spreadsheet formula injection from external organisation
names/domains.

## Recovery after a partial or failed provisioning run

Provisioning is idempotent per `(organisation, observation_type)`, and the
manifest write targets a fixed id set, so recovery is simply **re-running the
same `--from-manifest` command**:

- **Partial write** (some cohort orgs fully provisioned, one interrupted
  mid-way): re-run `--from-manifest <same file> --production --confirm
  PROVISION-STATES --approve-digest <same digest>`. Already-complete orgs are
  no-ops; the partially-provisioned org's missing states are filled; **no org
  outside the manifest is ever added**. The run completes only the reviewed 100.
- **Drift refusal on retry:** if the tool refuses with a drift message, the live
  population changed since the manifest was reviewed. Do **not** override — select
  again (`--cohort-size N --manifest new.json`), review the new manifest and
  digest, and provision that.
- **Manifest lost/corrupted:** re-select to regenerate it; the deterministic rank
  makes the cohort reproducible, and the digest confirms you have the same one.

Never use `--limit` or a fresh `--cohort-size` production attempt to "finish" a
partially provisioned cohort — only `--from-manifest` guarantees the cohort does
not expand.

## Expected counts

**Phase 1A** (`--cohort-size 100`):

| Metric | Value |
|---|---|
| new organisations | 100 |
| new observation states | 500 |
| daily states (spf/dkim/dmarc) | 300 |
| weekly states (dnssec/caa) | 200 |

The existing five-organisation pilot (25 states) is untouched.

**Phase 1B** (intended expansion) selects the **next 900** new organisations via
the same governed workflow — `--cohort-size 900 --manifest phase1b.json` after
Phase 1A is provisioned, then `--from-manifest phase1b.json …` — for a controlled
cohort total of **1,000 new organisations plus the separate five-org pilot**.

> This document describes tooling behaviour only. It does not assert that any
> production provisioning has been performed.
