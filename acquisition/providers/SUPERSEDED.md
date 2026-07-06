# SUPERSEDED — legacy cohort Organisation Providers

The concrete providers in this directory that resolve organisations from a
**legacy cohort registry** are **superseded** and **retired from the operational
execution path**:

- `if-organisation-provider.js`  — IF-001 investment-firms cohort manifest
- `fca-organisation-provider.js` — FCA Organisation Registry
- `sra-organisation-provider.js` — SRA Organisation Registry

**Superseded by:** `canonical-organisation-provider.js` →
`ORG-AUTHORITY-001 — Canonical Organisation Dataset (Repository Authority)`
(`backend/authority/dataset/organisations.ndjson`).

The Observatory now resolves organisations **exclusively** from the canonical
dataset (every organisation with a VERIFIED domain). The provider factory
(`organisation-provider.js`) no longer references these legacy providers and
**rejects** `ORG_PROVIDER=if|if-001|fca|sra`.

These files are retained **only for historical provenance** (and their existing
test coverage). They are no longer authoritative and must not be reintroduced
into any Observatory execution path. See `ORG-AUTHORITY-001` in
`docs/DOCUMENT_REGISTER.md`.
