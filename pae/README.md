# Population Acquisition Engine (PAE)

Governed by `ENG-018` (Architecture Specification), `ENG-022` (Pre-Implementation
Architecture Challenge), and `ENG-024` (Implementation Programme). This directory
implements **WP-1 only**: the permanent Batch Adapter Contract every batch-based
population source will implement. No source adapter lives here yet (that is
WP-2+); no Repository Authority merge, Domain Discovery, or validation logic
lives here (those are separate subsystems downstream of this boundary — see
`ENG-018` §2/§3).

## What this contract is

A **batch adapter** is a plain object exposing three functions:

```
{ sourceId, parse(rawInput, context), validateStructure(rows, context), normalise(validRows, context) }
```

`runBatchAdapter(adapter, rawInput, context)` executes those three stages in
order, enforces that everything the adapter emits conforms to the canonical
Organisation source-record shape already defined in `backend/authority/loaders.js`,
and returns one uniform result — parsed/rejected/emitted counts, the emitted
records, and every rejection with a reason. It never calls into Repository
Authority, Domain Discovery, or the Observatory. It hands its result to
whatever calls it (a future import orchestrator, WP-3+) and stops.

## What a batch adapter must never do

Per `ENG-018` §3, enforced here structurally, not just by convention:

- Never write to Repository Authority directly.
- Never decide domain `VERIFIED` status.
- Never perform Domain Discovery.
- Never validate anything beyond the structural shape of its own source
  (a row missing a required column is a structural failure; whether a domain
  is live is not this layer's concern).
- Never assume synchronous request/response — `runBatchAdapter` is async and
  makes no assumption about how its caller is triggered (file upload today,
  a scheduled poll later for the Incremental profile, `ENG-024` WP-10).

## Files

- `batch-adapter-contract.js` — the contract: conformance assertion, canonical
  record validation, and the `runBatchAdapter` orchestrator.
- `batch-adapter-contract.test.js` — the contract's own test suite (stage
  ordering, error propagation, conformance checks) against a fixture adapter.
- `test-fixtures/fixture-batch-adapter.js` — a minimal, in-memory reference
  adapter used only by this contract's tests. It is not a real source adapter
  and must not be reused as one — HMRC AML (WP-2) is a separate, later package.

## Stability

This contract is scoped to the **Batch** adapter profile only — bounded,
discrete sources with a self-contained artifact to parse (CSV, Excel, ODS,
JSON, XML; government spreadsheets, commercial datasets, customer uploads).
Continuous/incremental sources (REST/GraphQL polling, streaming, webhook,
enterprise API integrations) are a deliberately separate **Incremental**
profile (`ENG-022` finding F-2, `ENG-024` WP-10) — out of scope here, and
expected to add adapter-side state (cursor/auth) this contract does not need.
Every future batch source (SRA, FCA, Companies House, international
registers, further commercial/customer sources) implements this same three-
function shape unchanged; only `parse`/`validateStructure`/`normalise`'s
internal logic differs per source.
