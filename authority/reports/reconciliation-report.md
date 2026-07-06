# Reconciliation Report — Canonical Organisation Dataset

Deterministic merge of every legacy organisation registry into one Repository Authority.
Reproduce: `node backend/authority/build.js`.

## Inputs → source records

| Source | Records in | Organisations contributed to |
|---|---:|---:|
| fca-registry | 6830 | 6830 |
| sra-registry | 25089 | 25086 |
| fca-investment-firms | 2395 | 2394 |
| if-001 | 1893 | 1893 |
| if-001-pilot | 100 | 100 |
| he-001 | 166 | 166 |
| pra-reference | 1194 | 1194 |
| gc1-manual | 50 | 50 |
| **Total source records** | **37717** | — |

## Merge outcome

- **Source records in:** 37717
- **Distinct organisations out:** 35752
- **Records merged away (duplicates collapsed):** 1965
- **Cross-regulator organisations (>1 regulator):** 23

## Identifier coverage

| Identifier | Organisations with it | Coverage |
|---|---:|---:|
| Companies House number | 15565 | 43.5% |
| FRN | 10388 | 29.1% |
| SRA number | 25086 | 70.2% |
| UKPRN | 166 | 0.5% |
| LEI | 1483 | 4.1% |
| Companies House profile attached | 1855 | 5.2% |
| SIC codes present | 8236 | 23.0% |

## Domain status

| Status | Organisations | Share |
|---|---:|---:|
| VERIFIED | 17057 | 47.7% |
| PENDING | 4607 | 12.9% |
| NO_DOMAIN | 14088 | 39.4% |

## Cross-check against SLG-039 (Observatory Population Census)

| Metric | SLG-039 | This build |
|---|---|---|
| Observed distinct domains | 4,867 | 4867 |
| Complete Trust Profiles | 1,893 | 1893 |
| Orphan observations | 954 | 0 |
