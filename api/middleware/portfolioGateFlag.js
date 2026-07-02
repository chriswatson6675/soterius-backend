/**
 * Single source of truth for whether the portfolio authorisation gate is
 * enforced. Defaults to false (unset/anything other than the string 'true')
 * — see requirePortfolio.js and api/routes/improvement-queue.js for exactly
 * what this controls and why: there is not yet a frontend workflow to
 * populate a customer's portfolio, so enforcing/scoping on it now would
 * lock every customer out of data they have no way to add themselves.
 *
 * Read at call time, not cached at module load, so flipping the env var and
 * restarting the process is enough — no code change required either way.
 */
function isPortfolioGateEnabled() {
  return process.env.ENABLE_PORTFOLIO_GATE === 'true';
}

module.exports = { isPortfolioGateEnabled };
