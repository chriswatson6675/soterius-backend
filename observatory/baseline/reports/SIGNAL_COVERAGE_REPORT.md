# Signal Coverage Report — NOB-001

**Baseline:** NOB-001 · window 2026-07-06T23:56:55.336Z → 2026-07-07T08:50:07.222Z

## 1. Per-signal coverage, failures & retry

| Signal | Table | Attempted | Completed | Coverage | Collector errors | DB errors | Retried | Retry recovered |
|---|---|---|---|---|---|---|---|---|
| SOT-SPF-001 | `signal_facts_spf` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-DMARC-001 | `signal_facts_dmarc` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-DKIM-001 | `signal_facts_dkim` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-DNSSEC-001 | `signal_facts_dnssec` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-CAA-001 | `signal_facts_caa` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-MTASTS-001 | `signal_facts_mtasts` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-SECURITYHEADERS-001 | `signal_securityheaders_v1` | 17,057 | 17,057 | 17,057 (100.0%) | 0 | 0 | 0 | 0 |
| SOT-SECURITYTXT-001 | `signal_securitytxt_v1` | 17,057 | 7,428 | 7,428 (43.5%) | 0 | 0 | 0 | 0 |

> Coverage = distinct VERIFIED domains with a persisted observation in the baseline window.
> The A/B/C collectors record transient DNS/HTTP failures as absence-of-row (a collector
> error), which is the existing pipeline behaviour. "Retried" reflects the single
> re-collection pass over transient failures; recovered = domains that succeeded on retry.

## 2. National signal benchmarks (adoption over observed population)

### Category A — Email Trust

| Signal | Observed | Key adoption |
|---|---|---|
| SPF | 13,968 | present 91.1% · `-all` 59.8% · `~all` 29.1% · `?all` 0.9% |
| DMARC | 17,028 | present 62.2% · enforcing (reject+quarantine) 35% · p=none 27.1% |
| DKIM | 7,497 | detected 44% of scored (absence unprovable → NON_OBSERVED) |

### Category B — Domain Trust

| Signal | Observed | Key adoption |
|---|---|---|
| DNSSEC | 17,057 | anchored 4% · island 1% · unsigned 95% |
| CAA | 16,971 | present 2.7% |

### Category C — Control Transparency

| Signal | Observed | Key adoption |
|---|---|---|
| Security Headers | 15,024 web-reachable | 88.1% reachable · mean 2.9 headers present |
| MTA-STS | 17,018 | record 3.8% · enforce 2.3% · testing 1.2% |
| security.txt | 6,432 | present 10% |
| TLS-RPT | — | DORMANT — collected but 0 scoring weight (SLG-036/037) |
