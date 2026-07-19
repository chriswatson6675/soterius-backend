'use strict';

// Canonical National Collection runner (Sprint 12).
//
// Every national Observatory collection now flows through the canonical
// Collection Session: Collection Programme → Collection Run → Observation →
// Organisation resolution → Organisation History. This replaces the payload-only
// per-signal insert loops in collection/runs/if001/run-all.js for the migrated
// signals. Collectors, payloads, and Quality Models are unchanged — only the
// persistence/orchestration layer moves onto runCollectionSession().
//
// Usage:
//   node backend/collection/runs/national/run-national.js <signal> [--concurrency N] [--limit N]
//   signals: spf | dmarc | dnssec | mtasts | caa | dkim | securityheaders | securitytxt

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const dns = require('node:dns');
const { runCollectionSession } = require('../../../observatory/collection/collection-session');
const { runResilientCollectionSession } = require('../../../observatory/collection/resilient-collection-session');
const registry = require('../../../observatory/collection/registry');
const emitters = require('../../../observatory/events/emitters');
const logger = require('../../../infra/utils/logger');
const { resolveOrganisationByDomain } = require('../../../organisation/resolve');
const { collectCaa } = require('../../signals/caa/caa-collector');

const { spfAdapter } = require('../../signals/spf/spf-observation');
const { dmarcAdapter } = require('../../signals/dmarc/dmarc-observation');
const { dnssecAdapter } = require('../../signals/dnssec/dnssec-collection-session');
const { mtastsAdapter } = require('../../signals/mtasts/mtasts-observation');
const { caaAdapter } = require('../../signals/caa/caa-observation');
const { dkimAdapter } = require('../../signals/dkim/dkim-observation');
const { securityHeadersAdapter } = require('../../signals/securityheaders/securityheaders-observation');
const { securityTxtAdapter } = require('../../signals/securitytxt/securitytxt-observation');

// Category D — TLS & Certificate share ONE handshake (ADR-COL-003).
const { createRunContext, collectTLSSession } = require('../../signals/tls/tls-collection-layer');
const { extractTLSEvidence } = require('../../signals/tls/tls-extractor');
const { extractCertificateEvidence } = require('../../signals/tls/certificate-extractor');
const { tlsAdapter } = require('../../signals/tls/tls-observation');
const { certificateAdapter } = require('../../signals/tls/certificate-observation');

// CAA's dedicated c-ares channel (CR-CAA-001, SLG-067): CAA responses routinely
// exceed 512 bytes and need a TCP retry that failed when sharing the default
// resolver. Replicated here (not imported from run-all.js) so this runner does not
// pull in the whole legacy orchestrator.
function makeCaaResolver() {
  const resolver = new dns.promises.Resolver({
    timeout: Number(process.env.CAA_DNS_TIMEOUT_MS ?? 8000),
    tries: Number(process.env.CAA_DNS_TRIES ?? 3),
  });
  const servers = String(process.env.CAA_DNS_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (servers.length) resolver.setServers(servers);
  return { resolveCaa: (name) => resolver.resolveCaa(name) };
}

// The signals migrated onto the canonical Collection Session. TLS and Certificate
// are intentionally ABSENT: one TLS handshake writes two tables under two run_ids
// (ADR-COL-003), which the single-table generic session does not model — they need
// a dedicated dual-write runner (Sprint 12 report). DKIM IS present: its key
// fan-out runs via the adapter's persistChildren hook.
function nationalAdapters() {
  const caaResolver = makeCaaResolver();
  return {
    spf: spfAdapter,
    dmarc: dmarcAdapter,
    dnssec: dnssecAdapter,
    mtasts: mtastsAdapter,
    // CAA: the one per-signal deviation among the migrated set — a collect override
    // injecting the dedicated resolver. Everything else (adapter, buildObservation,
    // outcome, envelope, resolution) is the standard canonical path.
    caa: { ...caaAdapter, collect: (domain) => collectCaa(domain, { dnsResolver: caaResolver }) },
    dkim: dkimAdapter,
    securityheaders: securityHeadersAdapter,
    securitytxt: securityTxtAdapter,
  };
}

// runNationalSignal — run one signal's national collection through the canonical
// session. Returns runCollectionSession's { programme, run, observations, counts }.
async function runNationalSignal({ signal, domains, concurrency = 8, runLabel, adapters = nationalAdapters(), deps = {} }) {
  const adapter = adapters[signal];
  if (!adapter) {
    throw new Error(`no canonical national adapter for signal '${signal}' — TLS/Certificate use a dedicated dual-write runner (see Sprint 12 report)`);
  }
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('domains must be a non-empty array');
  const label = runLabel || `NOB-${signal.toUpperCase()}-${new Date().toISOString().slice(0, 10)}`;
  return runCollectionSession({ runLabel: label, domains, adapter, deps: { concurrency, ...deps } });
}

// runResilientNationalSignal — the PRODUCTION-HARDENED national path (Blockers
// 2–4). Same canonical adapters and Observations as runNationalSignal, wrapped by
// the resilient executor: transient-failure retry with backoff, a truthful
// failure-aware terminal state (COMPLETED / PARTIAL / FAILED / CANCELLED), and
// crash-safe resume via the collection_run_items ledger. Re-running with the SAME
// runLabel after an interruption RESUMES that run (completed organisations are
// never recollected; no duplicate Observations, no duplicate run).
async function runResilientNationalSignal({ signal, domains, concurrency = 8, runLabel, resume = true, maxAttempts, baseDelayMs, adapters = nationalAdapters(), deps = {} }) {
  const adapter = adapters[signal];
  if (!adapter) {
    throw new Error(`no canonical national adapter for signal '${signal}' — TLS/Certificate use a dedicated dual-write runner (see Sprint 12 report)`);
  }
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('domains must be a non-empty array');
  // A STABLE, signal+date run label is what makes resume work: a crashed run is
  // re-launched under the same label and continues rather than starting afresh.
  const label = runLabel || `NOB-${signal.toUpperCase()}-${new Date().toISOString().slice(0, 10)}`;
  return runResilientCollectionSession({
    runLabel: label, domains, adapter,
    deps, options: { concurrency, resume, maxAttempts, baseDelayMs },
  });
}

// runNationalTlsCertificate — the canonical path for the ADR-COL-003 shared
// collection domain: ONE TLS handshake per domain feeds TWO canonical
// Observations (signal_tls_v1 + signal_certificate_v1) under TWO Collection Runs.
// The single-table runCollectionSession cannot model one-collect-two-tables, so
// this dedicated runner is built from the IDENTICAL canonical primitives it uses —
// registry (programme/run/transition), the Organisation Resolver, and each
// signal's own buildObservation (envelope + payload). Every Observation it
// produces is therefore fully canonical (ownership, provenance, resolution,
// Organisation-History-eligible); nothing is a payload-only write. As of F4
// (OBS-CONST-001 §4), each persisted Observation also emits its own
// ObservationRecorded Event via the sanctioned emitter — see processDomain
// below — bringing this runner to full parity with the single-table session
// modules (collection-session.js / resilient-collection-session.js), which
// already emit for every other national signal.
async function runNationalTlsCertificate({ domains, concurrency = 8, runLabel, deps = {} }) {
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('domains must be a non-empty array');

  const {
    upsertProgramme = registry.upsertProgramme,
    openRun = registry.openRun,
    transitionRun = registry.transitionRun,
    resolveOrganisation = resolveOrganisationByDomain,
    collectSession,                 // injectable for tests: (domain, runContext) -> session
    extractTls = extractTLSEvidence,
    extractCert = extractCertificateEvidence,
    client = require('../../../infra/database').getClient(),
    now,
  } = deps;

  const stamp = () => (now ? now() : new Date().toISOString());
  const label = runLabel || `NOB-TLSCERT-${new Date().toISOString().slice(0, 10)}`;

  // Two standing programmes, two runs — both fed by one handshake per domain.
  const tlsProg = await upsertProgramme({ ...tlsAdapter.programme }, client);
  if (!tlsProg.success) throw new Error(`tls programme upsert failed: ${tlsProg.error}`);
  const certProg = await upsertProgramme({ ...certificateAdapter.programme }, client);
  if (!certProg.success) throw new Error(`certificate programme upsert failed: ${certProg.error}`);

  const tlsRunRes = await openRun({ programmeId: tlsProg.programme.id, runLabel: label, metadata: { domain_count: domains.length } }, client);
  if (!tlsRunRes.success) throw new Error(`tls run open failed: ${tlsRunRes.error}`);
  const certRunRes = await openRun({ programmeId: certProg.programme.id, runLabel: label, metadata: { domain_count: domains.length } }, client);
  if (!certRunRes.success) throw new Error(`certificate run open failed: ${certRunRes.error}`);
  const tlsRun = tlsRunRes.run;
  const certRun = certRunRes.run;

  const runContext = createRunContext();   // ADR-COL-003 C-1 single-session guarantee
  const collect = collectSession || ((domain) => collectTLSSession(domain, runContext, { timeout: 30000 }));

  let tlsPersisted = 0, certPersisted = 0, failed = 0, nextIndex = 0;
  const results = new Array(domains.length);

  async function processDomain(domain, i) {
    try {
      const session = await collect(domain, runContext);   // ONE handshake
      const tlsEvid = extractTls(session);
      const certEvid = extractCert(session);

      // Resolve the Organisation ONCE — the same organisation owns both writes.
      let organisationId = null, raRef = null;
      try {
        const res = resolveOrganisation(domain);
        if (res && res.outcome === 'RESOLVED') { organisationId = res.organisationId; raRef = `authority@${res.provenance?.authorityVersion ?? 'unknown'}`; }
      } catch { /* leave unlinked */ }

      const observedAt = stamp();
      const tlsRow = tlsAdapter.buildObservation({ domain, facts: tlsEvid, run: tlsRun, observedAt, organisationId, repositoryAuthorityRef: raRef });
      const certRow = certificateAdapter.buildObservation({ domain, facts: certEvid, run: certRun, observedAt, organisationId, repositoryAuthorityRef: raRef });

      const { data: tData, error: tErr } = await client.from(tlsAdapter.tableName).insert([tlsRow]).select('id').single();
      const { data: cData, error: cErr } = await client.from(certificateAdapter.tableName).insert([certRow]).select('id').single();

      // Constitutional Event (OBS-CONST-001 §4) — one ObservationRecorded per
      // Observation actually persisted, emitted immediately after that specific
      // INSERT succeeds (never batched, never before the write is confirmed) —
      // preserving Observation → Event ordering exactly as the single-table
      // session modules do. TLS and Certificate are independent Observations
      // under independent run IDs (ADR-COL-003), so each gets its OWN Event,
      // guarded independently: a Certificate failure does not suppress the TLS
      // Event, and vice versa. Best-effort and non-blocking — an Event-write
      // failure is logged and swallowed, never thrown, and never turns a
      // persisted Observation into a recorded failure (Evidence Preservation
      // outranks Event bookkeeping). No score, band, or Quality Model output is
      // attached (interpretation runs downstream, separately, never here);
      // organisationId may be null (Unknown ≠ Absent) — the Event still records
      // that persistence happened even when the Organisation is not yet known.
      if (!tErr) {
        tlsPersisted++;
        const tlsObservationId = tData?.id ?? null; // captured once, outside the try — never re-derived inside a catch
        try {
          const evRes = await emitters.emitObservationRecorded({
            organisationId, collectionRunId: tlsRun.id, occurredAt: observedAt,
            repositoryAuthorityVersion: raRef,
            metadata: { domain, observationId: tlsObservationId, signal: tlsAdapter.programme.signal },
          }, client);
          if (!evRes.ok) logger.warn(`Event emission failed for ${domain} TLS (observation ${tlsObservationId} still persisted): ${evRes.error}`);
        } catch (evErr) {
          logger.warn(`Event emission threw for ${domain} TLS (observation ${tlsObservationId} still persisted): ${evErr.message}`);
        }
      }
      if (!cErr) {
        certPersisted++;
        const certObservationId = cData?.id ?? null; // captured once, outside the try — never re-derived inside a catch
        try {
          const evRes = await emitters.emitObservationRecorded({
            organisationId, collectionRunId: certRun.id, occurredAt: observedAt,
            repositoryAuthorityVersion: raRef,
            metadata: { domain, observationId: certObservationId, signal: certificateAdapter.programme.signal },
          }, client);
          if (!evRes.ok) logger.warn(`Event emission failed for ${domain} Certificate (observation ${certObservationId} still persisted): ${evRes.error}`);
        } catch (evErr) {
          logger.warn(`Event emission threw for ${domain} Certificate (observation ${certObservationId} still persisted): ${evErr.message}`);
        }
      }
      if (tErr || cErr) failed++;
      results[i] = { domain, tlsError: tErr?.message ?? null, certError: cErr?.message ?? null };
    } catch (err) {
      failed++;
      results[i] = { domain, error: err.message };
    }
  }

  const workers = Math.max(1, Math.min(concurrency, domains.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (nextIndex < domains.length) { const i = nextIndex++; await processDomain(domains[i], i); }
  }));

  await transitionRun(tlsRun.id, 'RUNNING', 'COMPLETED', { metadata: { persisted: tlsPersisted, failed } }, client);
  await transitionRun(certRun.id, 'RUNNING', 'COMPLETED', { metadata: { persisted: certPersisted, failed } }, client);

  return {
    tls: { programme: tlsProg.programme, run: tlsRun, persisted: tlsPersisted },
    certificate: { programme: certProg.programme, run: certRun, persisted: certPersisted },
    counts: { total: domains.length, tlsPersisted, certPersisted, failed },
    results,
  };
}

// Every Observatory-native signal, in the order a full national collection runs
// them. Each name maps to a canonical runner; 'tls'/'certificate' resolve to the
// shared dual-write runner. Running signals as separate passes inherently isolates
// them from cross-signal resolver contention (the concern run-all.js's phasing
// addressed), and CAA keeps its dedicated resolver.
const ALL_SIGNALS = ['spf', 'dmarc', 'dnssec', 'mtasts', 'caa', 'dkim', 'securityheaders', 'securitytxt', 'tls-certificate'];

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node run-national.js <signal|tls-certificate|all> [--concurrency N] [--limit N] [--run-label L] [--legacy] [--no-resume]');
    console.error('signals: spf | dmarc | dnssec | mtasts | caa | dkim | securityheaders | securitytxt | tls-certificate | all');
    console.error('  default: production-hardened path (retry + truthful lifecycle + crash-safe resume).');
    console.error('  --legacy      : use the original non-resumable runCollectionSession path.');
    console.error('  --no-resume   : hardened path but start a fresh run instead of resuming an interrupted one.');
    console.error('  --run-label L : explicit run label (stable label = resumable). Default NOB-<SIGNAL>-<date>.');
    process.exit(1);
  }
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
  const concurrency = arg('--concurrency') ? Number(arg('--concurrency')) : 8;
  const limit = arg('--limit') ? Number(arg('--limit')) : null;
  const runLabel = arg('--run-label');
  const legacy = process.argv.includes('--legacy');
  const resume = !process.argv.includes('--no-resume');

  const { loadOrganisations } = require('../../../acquisition/providers/organisation-provider');
  const cohort = loadOrganisations();
  let domains = cohort.organisations.map((o) => o.domain).filter(Boolean);
  if (limit) domains = domains.slice(0, limit);

  const targets = target === 'all' ? ALL_SIGNALS : [target];
  console.log(`National collection: ${domains.length} domains, concurrency ${concurrency}, mode ${legacy ? 'LEGACY' : 'HARDENED' + (resume ? '+resume' : '')}, signals: ${targets.join(', ')}`);

  for (const sig of targets) {
    const t0 = Date.now();
    if (sig === 'tls-certificate' || sig === 'tls' || sig === 'certificate') {
      // TLS/Certificate keep their dedicated dual-write runner (ADR-COL-003).
      const r = await runNationalTlsCertificate({ domains, concurrency, runLabel });
      console.log(`tls-certificate: tlsRun=${r.tls.run.id} certRun=${r.certificate.run.id} counts=${JSON.stringify(r.counts)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else if (legacy) {
      const r = await runNationalSignal({ signal: sig, domains, concurrency, runLabel });
      console.log(`${sig}: programme=${r.programme.programme_key} run=${r.run.id} counts=${JSON.stringify(r.counts)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      const r = await runResilientNationalSignal({ signal: sig, domains, concurrency, runLabel, resume });
      const s = r.summary;
      console.log(`${sig}: run=${r.run.id} ${r.resumed ? '(RESUMED) ' : ''}status=${s.state} coverage=${s.coveragePct}% (${s.succeeded}/${s.intended}, failed ${s.failed}) failures=${JSON.stringify(s.byFailureClass)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }

  // Post-collection storage capacity telemetry (Blocker 1) — measures growth and
  // forecasts capacity after the run. Best-effort: a telemetry failure never fails
  // the collection.
  try {
    const { captureSnapshot } = require('../../../observatory/operations/storage-monitor');
    const snap = await captureSnapshot();
    console.log(`storage: ${snap.total_rows.toLocaleString()} rows${snap.total_bytes != null ? `, ${(snap.total_bytes / 1024 ** 3).toFixed(2)} GiB` : ''}${snap.warnings.length ? `, ${snap.warnings.length} warning(s)` : ''}`);
    for (const w of snap.warnings) console.log(`  [${w.level}] ${w.message}`);
  } catch (e) {
    console.log(`storage: telemetry skipped (${e.message})`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { runNationalSignal, runResilientNationalSignal, runNationalTlsCertificate, nationalAdapters, makeCaaResolver, ALL_SIGNALS };
