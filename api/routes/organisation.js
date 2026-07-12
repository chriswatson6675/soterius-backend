'use strict';

// organisation.js — the Organisation read API, per ADR-SYS-010 §2.1.
// Thin: every handler delegates to organisation/resolve.js, assemble.js, and
// views/ — no logic lives here (ADR-SYS-010 §2.2, Experiences render only).
//
// AUTH: requireAuth + attachTenant — any authenticated user may read canonical
// Organisation data. This is the graduation from the X-Admin-Token dev gate
// used through Renewal v0.1 / Organisation Discovery, made for the first
// customer-facing Experience (Trust Profile). Organisation data is not
// tenant-scoped (it is canonical, shared, public-record-derived), so no
// per-tenant filtering is applied — attachTenant runs only to populate the
// standard req context, consistent with every other authed route.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { attachTenant } = require('../middleware/attachTenant');

const resolve = require('../../organisation/resolve');
const assemble = require('../../organisation/assemble');
const { profileView } = require('../../organisation/views/profile');
const { trustView } = require('../../organisation/views/trust');

router.use(requireAuth, attachTenant);

// GET /api/organisation/search?q=Mishcon  (or an SRA/CH/FRN number)
router.get('/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ success: false, error: 'q query param is required' });
  const result = resolve.search(q);
  if (!result.ok) return res.status(502).json({ success: false, error: result.error });
  res.json({ success: true, results: result.results });
});

// POST /api/organisation/resolve  { name?, domain?, companiesHouseNumber?, sraNumber?, frn? }
// Resolution generalised to multi-valued input (discovery review, Priority 3
// "Option A" — this IS resolve(), not a separate discovery service). Always
// returns exactly one of: an existing organisation, a newly assembled one
// (not yet in Repository Authority — see the isNew note in assemble.js), or
// an explicit conflict that the caller must resolve, never silently picked.
router.post('/resolve', async (req, res) => {
  const input = req.body || {};
  if (!input.name && !input.domain && !input.companiesHouseNumber && !input.sraNumber && !input.frn) {
    return res.status(400).json({ success: false, error: 'at least one identifier (name, domain, companiesHouseNumber, sraNumber, frn) is required' });
  }

  const identity = resolve.resolveIdentity(input);
  if (!identity.ok && identity.conflict) {
    return res.status(409).json({ success: false, conflict: true, candidates: identity.candidates });
  }
  if (!identity.ok) return res.status(502).json({ success: false, error: identity.error });

  const result = identity.isNew
    ? await assemble.assembleFromDiscovery(input, identity.organisationId)
    : await assemble.assembleById(identity.organisationId);
  if (!result.ok) return res.status(502).json({ success: false, error: result.error });

  res.json({ success: true, isNew: identity.isNew, unsupported: identity.unsupported, organisation: result.organisation });
});

// GET /api/organisation/ORG-XXXXXXXXXXXX
router.get('/:id', async (req, res) => {
  const result = await assemble.assembleById(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, organisation: result.organisation });
});

// GET /api/organisation/ORG-XXXXXXXXXXXX/profile
router.get('/:id/profile', async (req, res) => {
  const result = await assemble.assembleById(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, profile: profileView(result.organisation) });
});

// GET /api/organisation/ORG-XXXXXXXXXXXX/trust
router.get('/:id/trust', async (req, res) => {
  const result = await assemble.assembleById(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, trust: trustView(result.organisation) });
});

module.exports = router;
