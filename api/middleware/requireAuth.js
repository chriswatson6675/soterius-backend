const { getUserFromToken } = require('../../infra/auth');
const logger = require('../../infra/utils/logger');

function parseBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/**
 * Backend JWT validation gate (Phase 3 Readiness Checklist B1 / Engineering
 * Plan WS1). Validates the Supabase access token on the Authorization header
 * and attaches { id, email, role } to req.user.
 *
 * Deliberately does not resolve tenancy here — see attachTenant, which
 * composes after this middleware. Splitting the two lets operations-role
 * requests skip tenant resolution entirely (ADR-SYS-007 §3.4) and keeps
 * identity validation independent of the tenancy data model.
 *
 * Exported as a ready-to-use middleware (default-wired dependencies) plus a
 * factory for tests to inject a fake getUserFromToken.
 */
function createRequireAuth(getUserFromTokenFn = getUserFromToken) {
  return async function requireAuth(req, res, next) {
    try {
      const token = parseBearerToken(req.headers['authorization']);
      const user = token ? await getUserFromTokenFn(token) : null;

      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

      req.user = user;
      next();
    } catch (err) {
      logger.error(`requireAuth threw: ${err.message}`);
      res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  };
}

module.exports = { requireAuth: createRequireAuth(), createRequireAuth, parseBearerToken };
