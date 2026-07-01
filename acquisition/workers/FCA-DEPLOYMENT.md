# FCA Observatory — Railway Deployment Runbook

Operational deployment of the **completed, frozen** FCA Observatory as the **second
production observatory** on the Soterius Collection Platform. This document covers only
the deployment infrastructure — the observatory code is unchanged. It is the FCA
equivalent of the SRA worker runbook (`acquisition/workers/DEPLOYMENT.md`) and follows
the same pattern.

The FCA worker is a **separate Railway service** from the API and from the SRA worker.
All three share the same repo and Docker image but run different start commands and
never share a process or a volume.

---

## How the FCA worker differs from the SRA worker (by design)

| | SRA worker | FCA worker |
|---|---|---|
| Execution | continuous **poll loop** (the SRA source is one atomic bulk snapshot) | **one collection cycle, then exit 0** (the FCA source is per-firm; the package is one cohort sweep) |
| Periodicity | in-process `CHECK_INTERVAL` | **Railway `cronSchedule`** (no in-process polling) |
| Package | one sealed snapshot package | one sealed **run-level** package (firms committed exactly-once into it) |
| Resume | reuse sealed packages; collect on change | **resume the in-progress (unsealed) package**; new package when none open |
| Health | optional `HEALTH_PORT` | none — outcome via exit code + on-disk package status |

The FCA worker therefore deploys as a **scheduled job**: each scheduled run performs one
complete cycle (resume-or-create → collect → verify → reports → SEAL) and exits.

```
Railway project
├── service: soterius-api    (existing)   start: node server.js                                   (Dockerfile CMD)
├── service: sra-worker      (existing)   start: node acquisition/workers/sra-worker.js            volume: sra-data → /data
└── service: fca-worker      (new)        start: node acquisition/workers/fca-observatory-worker.js
                                          volume: fca-data → /data   ·   cron: 0 2 * * *
```

- Same repo, same Dockerfile/build, **different start command** (`railway.fca.json`
  already sets it). The existing API `CMD` and the SRA worker are untouched.
- The worker uses only Node built-ins + in-repo modules — no extra dependencies.
- **Start node directly** (not `npm run worker:fca`) so the worker process is PID 1 in
  the container and exits 0 cleanly without an npm wrapper. (`npm run worker:fca`
  remains for local use.)

---

## Stage 1 — Create the Railway FCA worker service

1. In the Railway project, **New → Service → GitHub repo** (same repo as the API).
2. **Settings → Service name:** `fca-worker`.
3. **Settings → Root Directory:** `backend` (same as the API and SRA worker services).
4. **Settings → Deploy → Start Command:** `node acquisition/workers/fca-observatory-worker.js` (`railway.fca.json` already sets this; launch node directly so the worker is PID 1 and exits 0).
5. **Settings → Deploy → Cron Schedule:** `0 2 * * *` (daily 02:00 UTC; adjust as required). With a cron schedule each trigger runs exactly one cycle and the container exits. Omit the schedule to run the service manually / one-shot.
6. Leave **Networking / public domain** OFF — the worker needs no inbound HTTP.
7. Do **not** change the API or `sra-worker` services. The FCA worker is fully independent.

## Stage 2 — Environment variables (on the `fca-worker` service)

See `collection/sources/fca/.env.example`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `FCA_EMAIL` | ✅ | — | FCA FS Register API auth email (`X-Auth-Email`). |
| `FCA_API_KEY` | ✅ | — | FCA FS Register API key (`X-Auth-Key`). Never written into evidence. |
| `FCA_BASE_URL` | ⬜ | `https://register.fca.org.uk/services/V0.1` | Override only if the gateway changes. |
| `RUN_ROOT` | ✅ | — | **Must be the volume mount path** (e.g. `/data/fca-runs`). |

Startup is **fail-fast**: the worker exits `2` **before contacting the source** if
`RUN_ROOT` is unset, the FCA credentials are missing/invalid, or the cohort is empty
(logged as a single error line). There is no `CHECK_INTERVAL` and no `HEALTH_PORT`.

## Stage 3 — Persistent volume (required)

The run-level Collection Package and the **commit ledger** live on disk under
`RUN_ROOT`. Railway container filesystems are ephemeral, so a volume is **required** —
without it, an interrupted package and its ledger are lost on redeploy and the
resume / exactly-once guarantees do not hold.

1. On the `fca-worker` service: **Settings → Volumes → New Volume**.
2. **Mount path:** `/data` (name e.g. `fca-data`). Use a **separate** volume from the
   SRA worker.
3. Set `RUN_ROOT=/data/fca-runs` (a subdirectory of the mount; the worker creates it on
   startup with `mkdir -p` semantics).
4. Redeploy.

Why this is sufficient (no storage redesign):
- The worker commits each firm into the package **exactly once** (atomic rename + an
  append-only `commit-log.ndjson`), so the package + ledger on the volume are always a
  consistent, append-only, duplicate-free record.
- On startup the worker **resumes** the in-progress (unsealed) package found on the
  volume, skips firms already in the ledger, and continues from the first uncommitted
  firm. A package is sealed only after every firm is committed, integrity verifies, and
  reports are generated.

## Stage 4 — Single-worker execution

`numReplicas: 1` (set in `railway.fca.json`). Run **one** FCA worker against a given
`RUN_ROOT`; do not run overlapping cycles against the same volume (the platform is
single-writer). The cron schedule should be longer than a worst-case cycle duration so
runs never overlap.

## Stage 5 — Deployment order & operations

**Deployment order**
1. Merge code (worker + `railway.fca.json` + this runbook) to the deploy branch.
2. Create the **volume** on the `fca-worker` service (Stage 3).
3. Set **environment variables** (Stage 2).
4. Set the **start command** + **cron schedule** (Stage 1).
5. Deploy the `fca-worker` service. (The API and `sra-worker` services are untouched.)

**First run (expected logs)**
- `FCA Observatory worker starting: RUN_ROOT=/data/fca-runs | cohort N firms | profile core`
- per-firm progress lines for committed firms
- `FCA Observatory cycle complete: package <id> | status sealed | committed N skipped 0 failed 0 | integrity X/X ok=true`
- container exits 0; sealed package present at `RUN_ROOT/<packageId>/` containing
  `SEALED`, `manifest.json`, `package.json` (`status: sealed`), `firms/<FRN>/…`,
  `reports/`, and `commit-log.ndjson`.

## Recovery procedure

- **Interrupted cycle (crash / redeploy / SIGKILL mid-sweep):** no action required.
  The committed firms and the ledger persist on the volume. The next run resolves the
  open package, skips committed firms, recollects only the remainder, then verifies +
  reports + seals. Exactly-once holds even if the interruption lands inside a firm's
  commit (the partial staging is discarded; an un-ledgered firm directory is treated as
  an orphan and recollected).
- **A firm fails (e.g. transient API error after retries):** it is left uncommitted and
  is retried on the next run; the package is **not sealed** until every firm is
  committed. Re-run until `failed 0` to obtain a sealed package.
- **An already-sealed package:** immutable. The worker never reprocesses or reseals it;
  a subsequent run starts a new package (a new observation).

## Operational verification

- Logs show one cycle ending `status sealed … ok=true`, then a clean exit 0.
- On the volume, `RUN_ROOT/<packageId>/` contains `SEALED`, `package.json`
  (`status: sealed`), `reports/{collection,coverage,health}-report.json`, and
  `commit-log.ndjson` with one line per committed firm.
- Restart test: interrupt a run, redeploy, confirm the next run resumes the same
  package (`status` was `collecting`), commits only the remaining firms with no
  duplicate evidence, and seals.

---

## Remaining manual (non-code) steps
1. Provision the FCA credentials and confirm the cohort source of record; validate that
   every cohort FRN currently resolves (so a complete sweep can reach `failed 0` and
   seal).
2. Create the Railway `fca-worker` service, volume, env vars, and cron schedule
   (Stages 1–4).
3. Register the FCA commissioning baseline in `docs/DOCUMENT_REGISTER.md` per the
   Repository Authority Rule before declaring the observatory commissioned.
