# Capped SIC codes — advanced-search ~10k limit (bulk top-up needed)

The first acquisition pass uses Companies House **advanced-search by SIC code**, which
returns at most **~10,000 results per query**. Any approved SIC code with more than
~10,000 *active* companies therefore has its tail dropped on this pass (logged, never
silent). These codes need a later **bulk Free Company Data Product** top-up pass to
recover the companies the API could not page to.

Because the Processing Ledger enforces exactly-once, a later bulk pass re-runs the same
pipeline and **only adds net-new firms** — already-acquired/processed companies are
skipped. So the top-up is additive and safe.

## Capped codes observed

> Status: **FINAL** — the API pass completed 2026-06-30 over all 17 approved SIC codes.
> Only the two codes below exceeded the ~10k advanced-search cap; the other 15 fit
> entirely under the cap and are fully covered by the API pass.

| SIC code | Activity | Total active | Retrieved (cap) | Dropped (need bulk) |
|---|---|---|---|---|
| 64999 | Financial intermediation n.e.c. | 35,643 | ~10,000 | **25,643** |
| 66190 | Activities auxiliary to financial intermediation n.e.c. | 10,238 | ~10,000 | **238** |
| **Total dropped** | | | | **25,881** |

At the observed ~8% acquisition yield, the ~25.9k un-retrieved companies represent on
the order of **~2,000 additional authorised firms** recoverable by the bulk top-up.

## Top-up plan (later)

1. Obtain the dated Companies House **Free Company Data Product** bulk snapshot CSV.
2. Re-run against it: `npm run acquire:fca -- --snapshot <BasicCompanyData.csv>`
   (point ledger/registry at the same `runs/fca-acquisition/` files so exactly-once
   applies across both passes).
3. The bulk pass streams the whole register, filters by the approved SIC set, skips
   everything already in the ledger, and acquires only the dropped tails — closing the
   gap on the capped codes above.
