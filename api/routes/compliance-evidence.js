'use strict';

// compliance-evidence.js — Compliance Advisor MVP (Compliance Evidence
// architecture review, 2026-07-13). Thin: delegates entirely to
// backend/compliance-evidence/store.js — this file performs no computation
// of its own, mirroring trust-profile.js's own "no computation here" rule.
//
// Deliberately its own route file / table, not folded into trust-profile.js
// or the Observatory's constitutional events table (migration 040) — see
// migration 049's own header comment for why.
//
// No PATCH, no DELETE — nothing here is ever mutated once written (the
// database enforces this too, migration 049's triggers). No CRM, no case
// management, no workflow engine: recording a review carries no status,
// no assignment, no linkage to individual recommendations.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { attachTenant } = require('../middleware/attachTenant');
const { requireTenant } = require('../middleware/requireTenant');
const { createRequirePortfolio } = require('../middleware/requirePortfolio');
const { ValidationError } = require('../../infra/utils/errors');

const store = require('../../compliance-evidence/store');
const trustProfileStore = require('../../trust-intelligence/store');

const ALLOWED_TYPES = ['review_completed'];

// POST /api/compliance-evidence/:organisationId
// Body: { type?: 'review_completed', note?: string }. reviewedByUserId,
// reviewedAt, and trustProfileGeneratedAt are always server-derived —
// never accepted from the request body, so a review can never be recorded
// as though performed by someone else or against evidence that wasn't
// actually current at the time.
function createPostComplianceEvidence(deps = {}) {
  const recordEvent = deps.recordEvent || store.recordEvent;
  const getCurrent = deps.getCurrent || trustProfileStore.getCurrent;

  return async function postComplianceEvidence(req, res, next) {
    try {
      const organisationId = req.params.organisationId;
      const type = req.body?.type || 'review_completed';
      if (!ALLOWED_TYPES.includes(type)) {
        throw new ValidationError(`type must be one of: ${ALLOWED_TYPES.join(', ')}`);
      }
      const note = req.body?.note;
      if (note !== undefined && note !== null && typeof note !== 'string') {
        throw new ValidationError('note must be a string');
      }

      const current = await getCurrent(organisationId);

      const event = await recordEvent({
        organisationId,
        customerId: req.tenant.customer.id,
        reviewedByUserId: req.user.id,
        trustProfileGeneratedAt: current.exists ? current.generatedAt : null,
        type,
        note: note || null,
      });

      res.status(201).json({ success: true, event });
    } catch (err) {
      next(err);
    }
  };
}

// GET /api/compliance-evidence/:organisationId
// The full audit trail for one organisation, newest-first.
function createGetComplianceEvidence(deps = {}) {
  const getEvents = deps.getEvents || store.getEvents;

  return async function getComplianceEvidence(req, res, next) {
    try {
      const events = await getEvents(req.params.organisationId);
      res.status(200).json({ success: true, events });
    } catch (err) {
      next(err);
    }
  };
}

const requirePortfolio = createRequirePortfolio('organisationId');

router.use(requireAuth, attachTenant, requireTenant);
router.post('/:organisationId', requirePortfolio, createPostComplianceEvidence());
router.get('/:organisationId', requirePortfolio, createGetComplianceEvidence());

module.exports = router;
module.exports.createPostComplianceEvidence = createPostComplianceEvidence;
module.exports.createGetComplianceEvidence = createGetComplianceEvidence;
