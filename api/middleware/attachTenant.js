const { getMembershipByUserId } = require('../../infra/database');
const logger = require('../../infra/utils/logger');

/**
 * Resolves customer_id via memberships (ADR-SYS-007 §3.1) and attaches
 * req.tenant. Must run after requireAuth — reads req.user.
 *
 * operations is platform-wide by design (ADR-SYS-007 §3.4) and is never
 * tenant-scoped; req.tenant is left null for it without a lookup.
 *
 * A customer-role user with no membership yet is a valid, expected
 * pre-onboarding state (no provisioning flow exists in this slice) —
 * req.tenant is null in that case too, never a 403/404.
 */
function createAttachTenant(getMembershipByUserIdFn = getMembershipByUserId) {
  return async function attachTenant(req, res, next) {
    try {
      if (!req.user || req.user.role !== 'customer') {
        req.tenant = null;
        return next();
      }

      req.tenant = await getMembershipByUserIdFn(req.user.id);
      next();
    } catch (err) {
      logger.error(`attachTenant threw: ${err.message}`);
      next(err);
    }
  };
}

module.exports = { attachTenant: createAttachTenant(), createAttachTenant };
