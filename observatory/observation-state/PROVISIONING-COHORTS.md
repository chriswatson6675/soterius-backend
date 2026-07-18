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

## Production guard is unchanged

Dry-run is still the default. A real write still requires **both**
`--production` **and** `--confirm PROVISION-STATES`; `--production` alone refuses
and runs a dry-run. `--limit` and `--cohort-size` are **mutually exclusive** —
supplying both fails with a validation error.

## Manifest review

`--manifest <path>` writes a deterministic, credential-free, timestamp-free
manifest (`--manifest-format json|csv`, default `json`). Without a path a JSON
manifest is printed to stdout between markers. Repeated dry runs over identical
inputs produce **byte-equivalent** manifests. Each entry carries: cohort
position, global hash rank, organisation id, organisation name (where
available), domain, and eligibility basis — and nothing mutable or secret.

## Dry-run examples

```bash
# Governed Phase 1A dry-run (plan only, writes nothing) + manifest for review
node provision-observation-states-cli.js --cohort-size 100 --manifest phase1a.json

# Inspect the CSV form instead
node provision-observation-states-cli.js --cohort-size 100 --manifest phase1a.csv --manifest-format csv

# Governed production write (only after the dry-run + manifest are accepted)
node provision-observation-states-cli.js --cohort-size 100 --production --confirm PROVISION-STATES
```

## Expected counts

**Phase 1A** (`--cohort-size 100`):

| Metric | Value |
|---|---|
| new organisations | 100 |
| new observation states | 500 |
| daily states (spf/dkim/dmarc) | 300 |
| weekly states (dnssec/caa) | 200 |

The existing five-organisation pilot (25 states) is untouched.

**Phase 1B** (intended expansion) selects the **next 900** new organisations
(`--cohort-size 900` after Phase 1A is provisioned), for a controlled cohort
total of **1,000 new organisations plus the separate five-org pilot**.

> This document describes tooling behaviour only. It does not assert that any
> production provisioning has been performed.
