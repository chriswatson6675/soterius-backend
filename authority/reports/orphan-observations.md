# Orphan Observations

An orphan is a domain the Observatory has evidence for that resolves to **no**
organisation. SLG-039 §4 recorded **954** such orphans — FCA-regulated firm
domains whose source `prospects` table is now empty (provenance loss).

## Provenance recovery

This reconstruction reclaims them by extracting identity the census never used —
chiefly the FCA registry's PPOB `Website Address` field (ignored by SLG-039, which
treated the FCA registry as domainless):

| Step | Domains |
|---|---:|
| Orphans by census method (no FCA-registry websites) | 952 |
| Recovered by FCA-registry website extraction | 952 |
| Recovered by other cohorts (IF-001 pilot etc.) | 0 |
| **Remaining true orphans** | **0** |

- **Orphan observed domains (final):** 0
- **Of total observed:** 4867 (0.0%)

Every observed domain now resolves to exactly one organisation.
