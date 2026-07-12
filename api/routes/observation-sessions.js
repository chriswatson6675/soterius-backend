'use strict';

// observation-sessions.js — Observation Sessions: monitoring, plus (ENG-007
// Phase 1) the one write action that triggers an on-demand session.
//
// Internal operational surface (the Ops console's Workers/Queues pages are its
// natural consumer). Not customer-facing, not tenant-scoped, and NOT the
// Public Scanner Experience (that is a later, public, unauthenticated phase —
// this route stays behind requireAuth). Every route below GET is read-only
// monitoring, as before. POST /on-demand is the ENG-007 §5 exception:
// sessions were previously created and transitioned only by execution paths
// (batch / on-demand / scheduled) called directly, never via HTTP; this is
// the first HTTP trigger for the 'on-demand' case specifically.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { validateDomain } = require('../../infra/utils/validators');
const { runOnDemandObservation } = require('../../observatory/on-demand/on-demand-observation');
const logger = require('../../infra/utils/logger');
const session = require('../../observatory/session/observation-session');

router.use(requireAuth);

// POST /api/observation-sessions/on-demand  { domain }
//
// Triggers the On-Demand Observation Pipeline (ENG-007) for one domain.
// Collection and scoring across up to 10 signals can take tens of seconds —
// this handler returns 202 with the Observation Session id as soon as the
// session exists (via the orchestrator's onSessionCreated hook), never
// blocking on the full pipeline. Poll GET /:id for completion; once
// `completed`, GET /api/organisation/:id/trust reads the result (unmodified
// — this route persists Observations and quality scores only).
//
// Factory, matching requireAuth.js's DI pattern (the one other handler in
// this codebase with real async I/O): createOnDemandHandler(fn) lets tests
// inject a fake orchestrator instead of invoking the real one.
function createOnDemandHandler(runOnDemand = runOnDemandObservation) {
  return function postOnDemand(req, res) {
    const raw = req.body && req.body.domain;
    if (!raw) return res.status(400).json({ success: false, error: 'domain is required' });

    const domain = String(raw).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
    if (!validateDomain(domain)) return res.status(400).json({ success: false, error: `Invalid domain: ${raw}` });

    let responded = false;

    runOnDemand(domain, {
      requestedBy: req.user ? req.user.id : null,
      onSessionCreated: (createdSession) => {
        responded = true;
        res.status(202).json({ success: true, sessionId: createdSession.id, domain });
      },
    })
      .then((result) => {
        // onSessionCreated already responded in the normal case. The only
        // way to reach here with responded === false is session creation
        // itself having failed (the orchestrator returns { ok: false }
        // without ever calling the hook) — not yet reported to the caller.
        if (!responded) {
          logger.error(`On-demand session creation failed for ${domain}: ${result.error}`);
          res.status(502).json({ success: false, error: result.error || 'on-demand observation failed to start' });
        }
      })
      .catch((err) => {
        logger.error(`On-demand observation pipeline threw for ${domain}: ${err.message}`);
        if (!responded) res.status(502).json({ success: false, error: 'on-demand observation failed to start' });
      });
  };
}

router.post('/on-demand', createOnDemandHandler());

// GET /api/observation-sessions?status=&trigger=&limit=  — monitoring list
router.get('/', async (req, res) => {
  const { status, trigger } = req.query;
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 50, 200) : 50;
  const result = await session.listSessions({ status, trigger, limit });
  if (!result.ok) return res.status(502).json({ success: false, error: result.error });
  res.json({ success: true, sessions: result.sessions });
});

// GET /api/observation-sessions/summary — status counts (monitoring dashboard)
router.get('/summary', async (req, res) => {
  const result = await session.statusCounts();
  if (!result.ok) return res.status(502).json({ success: false, error: result.error });
  res.json({ success: true, total: result.total, counts: result.counts });
});

// GET /api/observation-sessions/:id — full session incl. event trail (auditing)
router.get('/:id', async (req, res) => {
  const result = await session.getSession(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, session: result.session });
});

module.exports = router;
module.exports.createOnDemandHandler = createOnDemandHandler;
