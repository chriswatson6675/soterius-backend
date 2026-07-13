'use strict';

// trust-profile.js — the Trust Profile Read API, ENG-014 WP-7, directly
// against ENG-023 §11/§13/§14/§15 and ENG-008 §8/§9/§11. Thin: delegates
// entirely to generate-trust-profile.js/store.js/projections.js — this file
// performs no computation of its own (ENG-023 §15's own requirement).
//
// Three-outcome contract on GET /:id (ENG-008 §11):
//   (a) a current instance exists → its projection, 200
//   (b) none exists and ?generate is not set → explicit "not yet generated", 404
//   (c) none exists and ?generate=true → a synchronously-generated new
//       instance's projection, 201 (permitted, not required — implemented
//       here as the simpler of the two options)
// No fourth, undefined outcome.
//
// AUTH: GET /:id requires auth (Authenticated Projection, full instance +
// optional benchmark overlay). GET /:id/public is unauthenticated (Public
// Projection only) — ENG-008 §9 scopes this route as authenticated-first
// for Phase 2 (R-4); the public variant exists so a caller's role, not a
// field on the instance, decides which projection is served (ENG-023 §15).

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { attachTenant } = require('../middleware/attachTenant');

const store = require('../../trust-intelligence/store');
const { generateTrustProfile } = require('../../trust-intelligence/generate-trust-profile');
const { publicProjection, authenticatedProjection } = require('../../trust-intelligence/projections');
const { getBenchmarkOverlay } = require('../../trust-intelligence/benchmark-overlay');
const { computeChangeIndicator } = require('../../trust-intelligence/change-indicator');
const { generateTrustProfilePdf } = require('../services/trust-profile-pdf');
const resolve = require('../../organisation/resolve');

// Factories accept dependency overrides for testing without a live DB or
// Express server (mirrors createGetBenchmarks in benchmarks.js).
function createGetCurrentAuthenticated(deps = {}) {
  const getCurrent = deps.getCurrent || store.getCurrent;
  const generate = deps.generateTrustProfile || generateTrustProfile;
  const save = deps.save || store.save;
  const overlay = deps.getBenchmarkOverlay || getBenchmarkOverlay;
  const now = deps.now || (() => new Date().toISOString());

  return async function getCurrentAuthenticated(req, res, next) {
    try {
      const organisationId = req.params.id;
      const current = await getCurrent(organisationId);

      if (current.exists) {
        const benchmarkOverlay = await overlay(current.instance);
        return res.status(200).json({ success: true, generated: false, trustProfile: authenticatedProjection(current.instance, benchmarkOverlay) });
      }

      if (req.query.generate !== 'true') {
        return res.status(404).json({ success: false, generated: false, error: 'not yet generated' });
      }

      // Outcome (c) — synchronous generation, permitted not required (ENG-008 §11).
      const instance = await generate(organisationId, { trigger: 'on-demand', generatedAt: now() });
      await save(instance);
      const benchmarkOverlay = await overlay(instance);
      return res.status(201).json({ success: true, generated: true, trustProfile: authenticatedProjection(instance, benchmarkOverlay) });
    } catch (err) {
      next(err);
    }
  };
}

function createGetCurrentPublic(deps = {}) {
  const getCurrent = deps.getCurrent || store.getCurrent;

  return async function getCurrentPublic(req, res, next) {
    try {
      const current = await getCurrent(req.params.id);
      if (!current.exists) {
        return res.status(404).json({ success: false, generated: false, error: 'not yet generated' });
      }
      return res.status(200).json({ success: true, generated: false, trustProfile: publicProjection(current.instance) });
    } catch (err) {
      next(err);
    }
  };
}

function createGetHistory(deps = {}) {
  const getHistory = deps.getHistory || store.getHistory;

  return async function getHistoryHandler(req, res, next) {
    try {
      const history = await getHistory(req.params.id);
      res.status(200).json({
        success: true,
        history: history.map(({ generatedAt, instance }) => ({ generatedAt, trustProfile: authenticatedProjection(instance) })),
      });
    } catch (err) {
      next(err);
    }
  };
}

// GET /:id/change — ENG-014 Portfolio Management. Derives a simple
// current-vs-previous score comparison from the Organisation's own Trust
// Profile History (store.getHistory()) via computeChangeIndicator() — no
// new scoring, no new persistence, same auth as GET /:id/history.
function createGetChange(deps = {}) {
  const getHistory = deps.getHistory || store.getHistory;
  const computeChange = deps.computeChangeIndicator || computeChangeIndicator;

  return async function getChangeHandler(req, res, next) {
    try {
      const organisationId = req.params.id;
      const history = await getHistory(organisationId);
      res.status(200).json({
        success: true,
        organisationId,
        change: computeChange(history),
      });
    } catch (err) {
      next(err);
    }
  };
}

// GET /:id/report.pdf — Compliance Advisor MVP (ENG-047/ENG-048). Renders
// the exact same instance GET /:id already serves, as a branded PDF. Never
// recomputes a score — reads store.getCurrent() (or generates via the same
// on-demand path GET /:id itself uses, behind the same ?generate=true
// contract) and hands the raw instance to trust-profile-pdf.js verbatim.
function createGetReportPdf(deps = {}) {
  const getCurrent = deps.getCurrent || store.getCurrent;
  const generate = deps.generateTrustProfile || generateTrustProfile;
  const save = deps.save || store.save;
  const now = deps.now || (() => new Date().toISOString());
  const reverse = deps.reverse || resolve.reverse;
  const renderPdf = deps.generateTrustProfilePdf || generateTrustProfilePdf;

  return async function getReportPdf(req, res, next) {
    try {
      const organisationId = req.params.id;
      let current = await getCurrent(organisationId);

      if (!current.exists) {
        if (req.query.generate !== 'true') {
          return res.status(404).json({ success: false, error: 'not yet generated' });
        }
        const instance = await generate(organisationId, { trigger: 'on-demand', generatedAt: now() });
        await save(instance);
        current = { exists: true, instance };
      }

      const orgLookup = reverse(organisationId);
      const organisationName = orgLookup.ok
        ? (orgLookup.row.organisationName || orgLookup.row.canonicalName || organisationId)
        : organisationId;
      const consultancyName = req.tenant?.customer?.name || null;

      const pdf = await renderPdf({ instance: current.instance, organisationName, consultancyName });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="trust-profile-${organisationId}.pdf"`);
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  };
}

router.get('/:id/public', createGetCurrentPublic());
router.get('/:id/history', requireAuth, attachTenant, createGetHistory());
router.get('/:id/change', requireAuth, attachTenant, createGetChange());
router.get('/:id/report.pdf', requireAuth, attachTenant, createGetReportPdf());
router.get('/:id', requireAuth, attachTenant, createGetCurrentAuthenticated());

module.exports = router;
module.exports.createGetCurrentAuthenticated = createGetCurrentAuthenticated;
module.exports.createGetCurrentPublic = createGetCurrentPublic;
module.exports.createGetHistory = createGetHistory;
module.exports.createGetChange = createGetChange;
module.exports.createGetReportPdf = createGetReportPdf;
