'use strict';

// renewal.js — the Renewal Experience's own API. Reads Organisation views for
// pre-fill (delegated to the frontend calling /api/organisation/* directly —
// this route never re-fetches Organisation data itself); owns nothing but
// renewal_submissions, per ADR-SYS-010 OC-7.
//
// AUTH: X-Admin-Token for v0.1 — same deviation as organisation.js, see the
// v0.1 implementation report.

const express = require('express');
const router = express.Router();

const submissions = require('../services/renewalSubmissions');

function requireAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdminToken);

// POST /api/renewal/submissions  { organisationId, cycleYear }
router.post('/submissions', async (req, res) => {
  const { organisationId, cycleYear } = req.body || {};
  if (!organisationId || !cycleYear) {
    return res.status(400).json({ success: false, error: 'organisationId and cycleYear are required' });
  }
  const result = await submissions.createSubmission(organisationId, cycleYear);
  if (!result.ok) return res.status(502).json({ success: false, error: result.error });
  res.json({ success: true, submission: result.submission });
});

// GET /api/renewal/submissions/:id
router.get('/submissions/:id', async (req, res) => {
  const result = await submissions.getSubmission(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, submission: result.submission });
});

// PATCH /api/renewal/submissions/:id  { feeIncomeLastCompleted, feeIncomeEstimate }
router.patch('/submissions/:id', async (req, res) => {
  const result = await submissions.updateAnswers(req.params.id, req.body || {});
  if (!result.ok) return res.status(502).json({ success: false, error: result.error });
  res.json({ success: true, submission: result.submission });
});

module.exports = router;
