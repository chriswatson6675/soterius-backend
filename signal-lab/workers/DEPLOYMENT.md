# SRA Snapshot Worker — Railway Deployment Runbook

Operational deployment of the **completed, frozen** SRA Collection Layer as a
continuously-operating Railway background worker. This document covers only the
deployment infrastructure — the collector code is unchanged.

The worker is a **separate Railway service** from the API. It shares the same repo
and Docker image but runs a different start command. The two services never share a
process.

---

## Architecture (smallest possible change)

```
Railway project
├── service: soterius-api      (existing)   start: node server.js          (Dockerfile CMD)
└── service: sra-worker        (new)        start: node signal-lab/workers/sra-worker.js
                                            volume: sra-data → /data
```

- Same repo, same Dockerfile/build, **different start command** (Railway lets each
  service override the start command; the API's `CMD ["node","server.js"]` is
  unchanged).
- The worker uses only Node built-ins + the in-repo collector modules — no extra
  dependencies, so the existing image runs it as-is.
- **Start node directly (not `npm run worker`)** so the worker process is PID 1 in the
  container: it receives SIGTERM itself, runs its graceful-shutdown handler, and exits
  0. Running it under npm makes npm the parent, which logs a misleading
  `npm error signal SIGTERM` on every redeploy even though the worker exits cleanly.
  Service root = `backend`; the `npm run worker` script remains for local use.

---

## Stage 1 — Create the Railway worker service

1. In the Railway project, **New → Service → GitHub repo** (same repo as the API).
2. **Settings → Service name:** `sra-worker`.
3. **Settings → Root Directory:** `backend` (same as the API service).
4. **Settings → Deploy → Start Command:** `node signal-lab/workers/sra-worker.js` (launch node directly — not `npm run worker` — so the worker is the container's main process, handles SIGTERM itself, and exits 0 without the npm wrapper's misleading `npm error signal SIGTERM` on redeploy). `railway.worker.json` already sets this.
5. Leave **Networking / public domain** OFF — a background worker needs no inbound
   HTTP. (Only enable a port if you set `HEALTH_PORT`; see Stage 4.)
6. Do **not** change the API service. The worker is fully independent.

## Stage 2 — Environment variables (on the `sra-worker` service)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SRA_SUBSCRIPTION_KEY` | ✅ | — | SRA Firm Data Web Service key (Azure APIM). |
| `SRA_BASE_URL` | ⬜ | built-in gateway | Confirm against the SRA Technical Document. |
| `RUN_ROOT` | ✅ | — | **Must be the volume mount path** (e.g. `/data/sra-runs`). |
| `CHECK_INTERVAL` | ⬜ | `3600` (s) | Poll interval in seconds. Suggested `21600` (6h). |
| `LOG_LEVEL` | ⬜ | `info` | `error \| warn \| info \| debug`. |
| `HEALTH_PORT` | ⬜ | unset | If set, serve operational health JSON on this port. |

Startup is **fail-fast**: the worker validates configuration before polling and
exits with code `2` if `SRA_SUBSCRIPTION_KEY`, a valid `SRA_BASE_URL`, `RUN_ROOT`,
or a positive `CHECK_INTERVAL` is missing/invalid (logged as `invalid configuration`).

## Stage 3 — Persistent volume

Collection Packages and the snapshot-comparison state live on disk under `RUN_ROOT`.
Railway container filesystems are ephemeral, so a volume is **required** for
continuity.

1. On the `sra-worker` service: **Settings → Volumes → New Volume**.
2. **Mount path:** `/data` (name e.g. `sra-data`).
3. Set `RUN_ROOT=/data/sra-runs` (a subdirectory of the mount; the worker creates it
   on startup with `mkdir -p` semantics).
4. Redeploy.

Why this is sufficient (no storage redesign):
- The collector already writes immutable, append-only Collection Packages under
  `RUN_ROOT` and seals them atomically.
- On startup the worker reads existing **sealed** packages (`listSealed`) and their
  manifest `snapshotProductionTimestamp` (`loadRunModel`) to compute the newest
  local snapshot — so after a restart it **reuses** existing packages and only
  collects when the live SRA production timestamp is strictly newer.
- Result: packages survive restarts/redeploys, are reused, and snapshot comparison
  continues correctly — purely by pointing `RUN_ROOT` at the volume.

## Stage 4 — Operational health

The worker maintains operational state (status, uptime, cycles, last successful
collection + its snapshot production timestamp, last skip reason, last error,
polling state) — **no evidence, no reports, no organisational data**.

- **Always:** a `worker-status.json` file is written under `RUN_ROOT` after every
  poll cycle (inspectable on the volume; ignored by package listing).
- **Optional:** set `HEALTH_PORT` to serve the same JSON over HTTP
  (`GET /` → operational snapshot). Enable a Railway port/domain only if you want
  this reachable.

## Stage 5 — Deployment order & operations

**Deployment order**
1. Merge code (worker + this runbook) to the deploy branch.
2. Create/confirm the **volume** on the `sra-worker` service (Stage 3).
3. Set **environment variables** (Stage 2).
4. Set the **start command** (Stage 1).
5. Deploy the `sra-worker` service. (The API service is untouched.)

**First startup (expected logs)**
- `sra-worker started` → `connectivity check` → first run has no local packages, so
  `newer snapshot available; collecting` → `collection sealed` → `worker-status.json`
  written → sleeps `CHECK_INTERVAL`.

**Restart behaviour**
- On SIGTERM/SIGINT (Railway redeploy/scale), the worker logs `shutdown requested`,
  finishes any in-flight collection (never interrupts it → never a partially sealed
  package), logs `sra-worker stopped cleanly`, and exits 0.
- On next boot it reads the volume, finds existing sealed packages, and resumes —
  collecting only if the live production timestamp is newer.

**Operational verification**
- Logs show the cycle (`connectivity check` → `no newer snapshot` or
  `collection sealed`).
- `RUN_ROOT/worker-status.json` (or `HEALTH_PORT`) shows `status`, `uptimeSeconds`,
  `lastCollectionRunId`, `lastSnapshotProductionTimestamp`, `lastError`.
- Sealed packages appear under `RUN_ROOT/<runId>/` each containing `SEALED`,
  `manifest.json`, `raw/`, `structured/`, `provenance/`, `reports/`.

**Recovery after redeployment**
- No action required: point at the same volume → existing packages are reused, no
  duplicate snapshot is created for an already-collected production timestamp, and
  polling resumes automatically.

---

## Remaining manual steps (cannot be done from code)
1. Confirm the registration-gated `snapshot-source.js` locators + `SRA_BASE_URL`
   against the SRA Technical Document, and obtain a real `SRA_SUBSCRIPTION_KEY`.
2. Create the Railway worker service, volume, and env vars (Stages 1–3).
3. (Optional) enable `HEALTH_PORT` + a Railway port if external health is wanted.
