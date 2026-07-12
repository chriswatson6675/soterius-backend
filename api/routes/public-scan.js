'use strict';

// public-scan.js — the Public Scanner Experience (ENG-009 §5, ENG-013 WP2).
//
// Three routes, all unauthenticated by design (this IS the public surface
// ENG-009 specifies) — but genuinely NEW and separate from both the
// requireAuth-gated /api/organisation/* and the legacy /api/scan (ENG-009
// §5: "distinct from both... reusing either existing path's name or
// middleware chain would blur the boundary this specification exists to
// keep clean").
//
//   POST /api/public-scan               — trigger (WP1 protection mounted HERE ONLY)
//   GET  /api/public-scan/sessions/:id  — poll (no protection — cheap, no external I/O)
//   GET  /api/public-scan/trust         — read (no protection — cheap, no external I/O)
//
// Every handler below is orchestration/composition only, reusing existing,
// unmodified canonical components — no new orchestration, scoring, or
// assembly logic is introduced anywhere in this file:
//   - runOnDemandObservation (ENG-007) — the ONE on-demand orchestrator, the
//     exact same function the authenticated observation-sessions.js route
//     calls. Imported once, called once (below) — no duplicate orchestration.
//   - resolveOrganisationByDomain (organisation/resolve.js) — the ONE place
//     a domain becomes an Organisation.
//   - assembleById / assembleFromDiscovery (organisation/assemble.js) — the
//     ONE Organisation assembler.
//   - observation-session.js's getSession — the ONE session read.
// No Repository Authority write path is reachable from this file, under any
// resolution outcome — resolveOrganisationByDomain is read-only, and nothing
// below calls any Repository Authority write function.

const express = require('express');
const router = express.Router();
const { validateDomain } = require('../../infra/utils/validators');
const logger = require('../../infra/utils/logger');
const { publicScanProtection } = require('../middleware/publicScanProtection');
const { runOnDemandObservation } = require('../../observatory/on-demand/on-demand-observation');
const resolve = require('../../organisation/resolve');
const { canonicalOrgId } = require('../../organisation/identity');
const assemble = require('../../organisation/assemble');
const sessionModule = require('../../observatory/session/observation-session');
const { publicTrustView } = require('../../organisation/views/public-trust');

function normaliseDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  return trimmed || null;
}

// ── POST /api/public-scan  { domain } ────────────────────────────────────────
// Triggers the canonical on-demand pipeline for an anonymous caller. WP1's
// protection layer (per-IP rate limit + domain cooldown + concurrency guard)
// is mounted on THIS route only (ENG-010 §6) — never applied globally, never
// touching the existing authenticated trigger
// (backend/api/routes/observation-sessions.js), which this file does not
// import, reference, or modify.
function createTriggerHandler(runOnDemand = runOnDemandObservation) {
  return function postPublicScan(req, res) {
    const raw = req.body && req.body.domain;
    const domain = normaliseDomain(raw);
    if (!domain || !validateDomain(domain)) {
      return res.status(400).json({ success: false, error: `Invalid domain: ${raw}` });
    }

    let responded = false;

    runOnDemand(domain, {
      requestedBy: null,
      onSessionCreated: (createdSession) => {
        responded = true;
        res.status(202).json({ success: true, sessionId: createdSession.id, domain });
      },
    }).then((result) => {
      if (!responded) {
        logger.error(`public-scan: session creation failed for ${domain}: ${result.error}`);
        res.status(502).json({ success: false, error: result.error || 'observation failed to start' });
      }
    }).catch((err) => {
      logger.error(`public-scan: pipeline threw for ${domain}: ${err.message}`);
      if (!responded) res.status(502).json({ success: false, error: 'observation failed to start' });
    });
  };
}

router.post('/', ...publicScanProtection(), createTriggerHandler());

// ── GET /api/public-scan/sessions/:id ────────────────────────────────────────
// Poll target — a minimal, redacted view of the session (no internal event
// trail exposed publicly), reusing observation-session.js's own getSession()
// unmodified.
function createGetSessionHandler(getSessionFn = sessionModule.getSession) {
  return async function getPublicScanSession(req, res, next) {
    try {
      const result = await getSessionFn(req.params.id);
      if (!result.ok) return res.status(404).json({ success: false, error: result.error });

      const s = result.session;
      const meta = s.metadata || {};
      res.json({
        success: true,
        session: {
          id: s.id,
          status: s.status,
          domain: s.scope ? s.scope.domain : null,
          resolutionOutcome: meta.resolutionOutcome ?? null,
          organisationId: meta.organisationId ?? null,
          signalsObserved: meta.signalsObserved ?? null,
          signalsScored: meta.signalsScored ?? null,
          signalsFailed: meta.signalsFailed ?? null,
          signalsTotal: meta.signalsTotal ?? null,
          createdAt: s.created_at,
          startedAt: s.started_at,
          endedAt: s.ended_at,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

router.get('/sessions/:id', createGetSessionHandler());

// ── GET /api/public-scan/trust?domain=... ────────────────────────────────────
// The public read endpoint (ENG-009 §4 G-1). Resolves the domain the SAME
// way the on-demand pipeline itself does (resolveOrganisationByDomain — the
// one canonical resolution function, ENG-007 §4 step 5), then assembles the
// SAME canonical Organisation shape GET /api/organisation/:id returns —
// deliberately: it lets the frontend reuse the entire existing Trust Profile
// rendering path unmodified (ENG-009 §5), instead of inventing a second
// response shape. Never calls /api/organisation/:id's requireAuth-gated
// route, and never weakens that route's own gate — this is a wholly
// separate, deliberately public code path reusing the same underlying
// assembler functions.
function createGetTrustHandler(deps = {}) {
  const {
    resolveOrganisationByDomainFn = resolve.resolveOrganisationByDomain,
    assembleByIdFn = assemble.assembleById,
    assembleFromDiscoveryFn = assemble.assembleFromDiscovery,
  } = deps;

  return async function getPublicTrust(req, res, next) {
    try {
      const raw = req.query.domain;
      const domain = normaliseDomain(typeof raw === 'string' ? raw : '');
      if (!domain || !validateDomain(domain)) {
        return res.status(400).json({ success: false, error: `Invalid domain: ${raw}` });
      }

      const resolution = resolveOrganisationByDomainFn(domain);

      // AMBIGUOUS is a 200, not a 4xx: unlike POST /api/organisation/resolve's
      // 409 (a write-time conflict about which identity to adopt), this is a
      // read-only, honest disclosure of a resolution outcome — "more than one
      // organisation claims this domain" is a legitimate answer this endpoint
      // can give, not a client error or a request that failed. Candidates are
      // disclosed; none is ever picked silently (never calls an assembler).
      if (resolution.outcome === 'AMBIGUOUS') {
        return res.json({
          success: true,
          resolutionOutcome: 'AMBIGUOUS',
          candidates: resolution.candidates,
        });
      }

      if (resolution.outcome === 'RESOLVED') {
        const result = await assembleByIdFn(resolution.organisationId);
        if (!result.ok) return res.status(404).json({ success: false, error: result.error });
        // Redacted per ENG-008 §9 (canonical authority) — this endpoint is the
        // Public view, never the full Organisation the authenticated
        // GET /api/organisation/:id route returns. See public-trust.js.
        return res.json({ success: true, resolutionOutcome: 'RESOLVED', organisation: publicTrustView(result.organisation) });
      }

      // NOT_FOUND (INVALID is already excluded by validateDomain above) — an
      // ephemeral, non-persisted Organisation, computed with the SAME
      // deterministic id scheme resolve.js's own discovery path already uses
      // (identity.canonicalOrgId over normaliseFacts) — not a new id scheme,
      // and nothing here writes to Repository Authority.
      const ephemeralId = canonicalOrgId(resolve.normaliseFacts({ domain }));
      const result = await assembleFromDiscoveryFn({ domain }, ephemeralId);
      if (!result.ok) return res.status(404).json({ success: false, error: result.error });
      return res.json({ success: true, resolutionOutcome: 'NOT_FOUND', organisation: publicTrustView(result.organisation) });
    } catch (err) {
      next(err);
    }
  };
}

router.get('/trust', createGetTrustHandler());

module.exports = router;
module.exports.createTriggerHandler = createTriggerHandler;
module.exports.createGetSessionHandler = createGetSessionHandler;
module.exports.createGetTrustHandler = createGetTrustHandler;
