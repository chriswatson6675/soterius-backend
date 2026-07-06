# Canonical Organisation Dataset — Repository Authority

One record per real-world organisation known to Soterius, exactly once, with an
immutable Organisation ID, merged deterministically from every legacy registry.
This is the intended **sole operational source of truth**: every future platform
capability should resolve organisations through the Organisation ID here, never
through the IF / PRA / FCA / SRA / HE registries directly.

> **Status:** Built and validated, **pending Founder ratification**. Per the
> Repository Authority Rule (`CLAUDE.md` / `SLG-019`), this becomes the governed
> authority of record only once assigned a document identifier and registered in
> `DOCUMENT_REGISTER.md`. Until then it is a proposed authority: correct and
> reproducible, but not yet citable for conformance.

## How to build

```bash
cd backend
node authority/fetch-observed-domains.js   # 1. freeze the Observatory snapshot (needs Supabase env)
node authority/build.js                    # 2. deterministic build from repo files only
```

Step 1 reads the live Supabase `signal_*` tables (the only place observations
live — they are keyed by `domain`, never by an organisation id) and freezes the
observed universe to `inputs/observed-domains.ndjson`. Step 2 is pure and
offline: same inputs → byte-identical outputs (no clocks, no randomness, no
network). Re-running step 1 is only needed when new observations are collected.

## Outputs

`dataset/`
- **organisations.ndjson** — the Repository Authority. Every organisation, once.
- **pending.ndjson** — organisations whose domain cannot yet be verified, with reasons.
- **domains.ndjson** — one row per domain (single owner) + any orphan observations.
- **build-summary.json** — the headline counts.

`reports/`
- **reconciliation-report.md** — inputs → organisations, identifier & domain coverage, SLG-039 cross-check.
- **duplicate-resolution-report.md** — merges, cross-regulator entities, contested-domain resolution.
- **orphan-observations.md** — observed domains with no owning organisation (and how the census's 954 were recovered).
- **coverage-report.md** — the Trust coverage funnel, by regulator, and the pending queue.

## Design rules

- **Merge by strong identifiers only** — company number, FRN, SRA number, UKPRN,
  IF uuid (via the Companies House `firm.id` link). **Never by shared domain**:
  distinct firms legitimately share a domain (group brands, shared hosting), so
  domain-merging would wrongly collapse separate organisations.
- **Domain verification priority** (spec): FCA website → SRA website → HE website
  → Observatory-validated (IF-001). Unapproved manual input (gc1) is a candidate
  only, never authoritative. Search-derived domains never auto-verify.
- **One owner per domain** — to guarantee no duplicate verified domains, each
  domain is owned by its best-priority claimant; other claimants keep it as an
  unverified candidate and move to PENDING. Observatory evidence attaches to the
  owner only, so every observed domain counts for exactly one organisation.
- **Immutable IDs** — `ORG-<sha1(strongest-identifier)>`, stable across rebuilds
  and independent of input order.

## Legacy

The legacy registries under `backend/acquisition/runs/`, `datasets/`, and
`archive/` remain in place for historical provenance. Moving them to an
`archive/legacy` location, marking them superseded, and repointing the
Observatory scan provider at this dataset are **follow-on steps**, deliberately
not performed by the build (which only *establishes* the canonical dataset).
