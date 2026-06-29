'use strict';
/**
 * Pipeline Stage 2 — Domain Validation
 *
 * For each prospect in 'pending_validate':
 *   1. HTTP reachability check (follows redirects, confirms 2xx/3xx)
 *   2. Parked domain detection (checks HTML for sale phrases + thin content)
 *   3. Domain typo check (Levenshtein ≤2 against all other prospect domains)
 *
 * Transitions:
 *   PASS  → valid
 *   FAIL  → invalid  (unreachable or clearly not a firm site)
 *   WARN  → valid    (reachable but flagged — e.g. parked suspicion, typo warning)
 *
 * Concurrency: 10 parallel validations (HTTP only, no headless browser).
 *
 * Usage:
 *   node scripts/pipeline/validate.js [--limit N]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const axios = require('axios');
const { log, warn, error } = require('./lib/log');
const { normaliseDomain, levenshtein, isParkedPage } = require('./lib/domain');
const { getClient, updatePipelineStatus, appendFlag, getProspectsByStatus, getAllProspects } = require('./lib/db');

const CONCURRENCY    = 10;
const REQUEST_TIMEOUT = 10_000;

// ── Domain reachability ───────────────────────────────────────────────────────

async function checkDomain(domain) {
  const urls = [`https://${domain}`, `http://${domain}`];
  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        timeout:          REQUEST_TIMEOUT,
        maxRedirects:     5,
        validateStatus:   s => s < 500,
        headers: { 'User-Agent': 'Soterius-Pipeline/1.0' },
      });
      return { reachable: true, status: resp.status, html: String(resp.data || '') };
    } catch {
      // try next scheme
    }
  }
  return { reachable: false, status: null, html: '' };
}

// ── Batch runner ─────────────────────────────────────────────────────────────

async function run({ limit = 0 } = {}) {
  const prospects = await getProspectsByStatus('pending_validate');
  const all       = await getAllProspects();

  if (!prospects.length) { log('No prospects pending validation'); return; }

  const allDomains = all.map(p => normaliseDomain(p.website)).filter(Boolean);

  const queue = limit > 0 ? prospects.slice(0, limit) : prospects;
  log(`Validating ${queue.length} prospect(s)`);

  const stats = { total: queue.length, valid: 0, invalid: 0, flagged: 0, errors: 0 };

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(p => validateOne(p, allDomains, stats)));
  }

  log(`Validation complete — valid: ${stats.valid}, invalid: ${stats.invalid}, flagged: ${stats.flagged}, errors: ${stats.errors}`);
  return stats;
}

async function validateOne(prospect, allDomains, stats) {
  const domain = normaliseDomain(prospect.website);
  const id     = prospect.id;

  try {
    const { reachable, status, html } = await checkDomain(domain);

    if (!reachable) {
      warn(`Unreachable: ${domain}`);
      await updatePipelineStatus(id, 'invalid', {
        validation_status:      'unreachable',
        validation_checked_at:  new Date().toISOString(),
        domain_confidence:      0,
        pipeline_notes:         `Domain did not respond to HTTP or HTTPS requests (${new Date().toISOString()})`,
      });
      stats.invalid++;
      return;
    }

    const flags = [];

    // Parked domain check
    if (isParkedPage(html)) {
      flags.push({ code: 'PARKED_DOMAIN', detail: `Homepage content suggests parked/for-sale domain (HTTP ${status})` });
    }

    // Typo domain check (Levenshtein ≤2 against other prospects)
    const otherDomains = allDomains.filter(d => d !== domain);
    const tooClose = otherDomains.find(d => levenshtein(domain, d) <= 2);
    if (tooClose) {
      flags.push({ code: 'TYPO_DOMAIN', detail: `Domain "${domain}" is within edit-distance 2 of existing domain "${tooClose}"` });
    }

    // Compute updated domain_confidence based on validation outcome
    const currentConf = typeof prospect.domain_confidence === 'number' ? prospect.domain_confidence : 90;
    let domainConf;
    if (flags.some(f => f.code === 'PARKED_DOMAIN')) {
      domainConf = 20;
    } else if (flags.some(f => f.code === 'TYPO_DOMAIN')) {
      domainConf = Math.min(currentConf, 60);
    } else {
      domainConf = Math.max(currentConf, 95); // HTTP-confirmed live domain
    }

    // Mark valid; append any flags
    await updatePipelineStatus(id, 'valid', {
      validation_status:      flags.length ? 'flagged' : 'ok',
      validation_checked_at:  new Date().toISOString(),
      domain_confidence:      domainConf,
    });

    for (const f of flags) {
      await appendFlag(id, f);
    }

    if (flags.length) {
      warn(`Valid (with flags): ${domain} — ${flags.map(f => f.code).join(', ')}`);
      stats.flagged++;
    } else {
      log(`Valid: ${domain}`);
    }
    stats.valid++;

  } catch (err) {
    error(`Error validating ${domain}: ${err.message}`);
    stats.errors++;
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args  = process.argv.slice(2);
  const limIdx = args.indexOf('--limit');
  const limit  = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : 0;

  run({ limit }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
