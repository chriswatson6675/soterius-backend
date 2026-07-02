const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/requireAuth');
const { attachTenant } = require('../middleware/attachTenant');

// GET /api/me
// Session bootstrap for the frontend: identity + role + tenant, if any.
// customer/membership are null for operations users (never tenant-scoped,
// ADR-SYS-007 §3.4) and for customer users not yet onboarded onto a tenant
// (no provisioning flow exists in this slice — a valid, expected state, not
// an error).
function getMe(req, res, next) {
  try {
    res.json({
      user:       { id: req.user.id, email: req.user.email },
      role:       req.user.role,
      customer:   req.tenant?.customer ?? null,
      membership: req.tenant ? { tenantRole: req.tenant.tenantRole } : null,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/', requireAuth, attachTenant, getMe);

module.exports = router;
module.exports.getMe = getMe;
