# PRV-SRA-001

# SRA Organisation Provider
# Architecture & Implementation Record

**Document ID:** PRV-SRA-001
**Title:** SRA Organisation Provider
**Document Type:** Organisation-Provider record (source-scoped) — working identifier; formal class reserved to SLG-021
**Status:** Draft v1.0 — non-authoritative pending Founder Review (per SLG-019)
**Date:** 2026-06-30
**Maintained by:** Founder / Governance Architect

**Depends on:** POP-SRA-001 (SRA Organisation Registry) — the population it exposes; the existing Organisation Provider contract + factory (`if001-full/organisation-provider.js`). Mirrors the FCA Organisation Provider (`population-acquisition/fca-organisation-provider.js`).
**Precedes:** the first SRA Observatory Operational Pilot (separate task).
**Governed-by:** SLG-013; SLG-027 (Collection Platform); the unchanged Organisation Provider contract and Generic Observatory.

---

## 1. Purpose

The **SRA Organisation Provider** lets the existing Generic Observatory consume organisations from the SRA Organisation Registry through the existing Organisation Provider architecture — with no Observatory change. It is the SRA analogue of the FCA Organisation Provider and the next stage of the shared lifecycle:

```
External Source → Population Acquisition → Organisation Registry → Organisation Provider → Generic Observatory
                                                                    ▲ this component (SRA)
```

It is selected by configuration: `ORG_PROVIDER=sra`.

## 2. Relationship to the SRA Organisation Registry

The provider reads the canonical SRA Organisation Registry (`runs/sra-acquisition/registry.ndjson`, POP-SRA-001) and maps each record onto the organisation model the Observatory expects. By default it reads that registry; `SRA_REGISTRY_PATH` selects an immutable snapshot instead (parity with the FCA provider's `FCA_REGISTRY_PATH`), so continuous acquisition need not stop during a run. The registry already performed eligibility (only organisations with a valid scannable domain are present) and domain normalisation; the provider therefore does no re-gating — inclusion in the registry is the eligibility record.

**Mapping** (registry record → organisation):

| Organisation field | Registry source |
|---|---|
| `id` | `String(sraNumber)` (analogue of FCA `frn`) |
| `firm_name` | `firmName` |
| `domain` | `normaliseDomain(domain)` (idempotent; FCA-consistent rules) |
| `last_scanned` | `null` |

`selection_id` is deterministic, bound to the exact registry contents: `sra-registry-<sha256-12>` (with a `-sample<n>` suffix when `SRA_SAMPLE_N` caps the population). `cohort_id = SRA-REG-001`, `cohort_name = "SRA Organisation Registry"`.

## 3. Relationship to the Generic Observatory

The Observatory obtains organisations solely through `loadOrganisations()` and **remains unaware** of whether they originate from FCA, SRA, IF, or any future registry. The provider returns **exactly** the existing contract — no new fields, no missing fields:

```
{ cohort_id, cohort_name, selection_id, n,
  organisations: [ { id, firm_name, domain, last_scanned } ] }
```

The factory (`if001-full/organisation-provider.js`) was extended with one case (`ORG_PROVIDER=sra`); the scanning pipeline is untouched, and unknown providers fail exactly as before.

## 4. Provider responsibilities

- Resolve the registry source (default registry or `SRA_REGISTRY_PATH` snapshot).
- Load the registry and map each record onto the organisation contract.
- Preserve registry (derivation) order among records.
- Produce a deterministic, content-bound `selection_id`.
- Optionally cap to a deterministic head sample via `SRA_SAMPLE_N` (parity with `FCA_SAMPLE_N`; default off → full eligible population).

## 5. Provider boundaries (out of scope)

- No scanning, persistence, scoring, reporting, or benchmarking — those are the Observatory's and are unchanged.
- No re-collection or live acquisition — the registry (POP-SRA-001) and the Collection Package are the source.
- No re-gating of eligibility or authorisation — the registry decided admission.
- No change to the Organisation Provider contract, the factory architecture, the Population Acquisition Layer, or the Observatory.
- **Operational-pilot sampling** (e.g. a seeded random 1,000) is a separate task; the provider exposes the full eligible population (with the optional `SRA_SAMPLE_N` head-sample for parity).

## 6. Validation summary

All nine required checks pass (tests: `population-acquisition/sra-organisation-provider.test.js` 8/8, `if001-full/organisation-provider.test.js` 3/3):

1. Contract key-sets match the FCA provider exactly. 2. The real registry loads (n = 10,354). 3. Mapping correct (`id`/`firm_name`/`domain`/`last_scanned`). 4. Eligible count = registry line count. 5. Registry order preserved. 6. `selection_id` deterministic. 7. FCA provider unchanged (untouched; factory still resolves it). 8. IF provider unchanged (untouched). 9. Factory selection correct (sra/fca/if/default/unknown).

## 7. Location

- Provider: `backend/signal-lab/population-acquisition/sra-organisation-provider.js`
- Factory case: `backend/signal-lab/if001-full/organisation-provider.js` (`sra:` added)
- Tests: `…/sra-organisation-provider.test.js`, `…/if001-full/organisation-provider.test.js`
