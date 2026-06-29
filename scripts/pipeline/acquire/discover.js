'use strict';
/**
 * Website Discovery — finds firm websites via Google Custom Search.
 *
 * Given a firm record from an acquisition source (e.g. Companies House),
 * searches for the firm's website and assigns a discovery confidence score.
 *
 * Confidence scale (domain_confidence):
 *   80–85  High    — all name tokens matched in domain or title
 *   65–79  Medium  — most name tokens matched (≥60%)
 *   50–64  Low     — some tokens matched (≥30%), needs spot-check
 *   35–49  Weak    — few tokens matched, likely wrong site
 *      0   None    — no candidate found
 *
 * Required env vars:
 *   GOOGLE_SEARCH_API_KEY  — Google Cloud API key (Custom Search JSON API enabled)
 *   GOOGLE_SEARCH_CX       — Programmable Search Engine ID
 *   Free tier: 100 queries/day. Paid: $5/1,000 queries.
 */

const https = require('https');
const { normaliseDomain, normaliseFirmName } = require('../lib/domain');
const { log, warn }                          = require('../lib/log');

const GOOGLE_CSE_BASE    = 'https://www.googleapis.com/customsearch/v1';
const RESULTS_PER_QUERY  = 5;
const INTER_BATCH_PAUSE_MS = 500;
const DEFAULT_CONCURRENCY  = 2;

// ── Directory / aggregator blocklist ──────────────────────────────────────────
// These domains list many firms — never the firm's own site.

const EXCLUDED_DOMAINS = new Set([
  'yell.com', '192.com', 'linkedin.com', 'facebook.com', 'twitter.com',
  'instagram.com', 'google.com', 'google.co.uk', 'bing.com',
  'lawsociety.org.uk', 'solicitors.lawsociety.org.uk',
  'sra.org.uk', 'gov.uk', 'legislation.gov.uk',
  'find-and-update.company-information.service.gov.uk',
  'companies-house.gov.uk', 'beta.companieshouse.gov.uk',
  'thomsonlocal.com', 'cylex.co.uk', 'hotfrog.co.uk',
  'yelp.com', 'yelp.co.uk', 'checkatrade.com', 'bark.com',
  'trustpilot.com', 'freeindex.co.uk', 'rated.co.uk',
  'reviewsolicitors.co.uk', 'unbiased.co.uk', 'vouchedfor.co.uk',
  'brownbook.net', 'lacartes.com', 'n49.co.uk',
  'icaew.com', 'fca.org.uk', 'acca.global',
]);

function isExcluded(domain) {
  if (!domain) return true;
  for (const excl of EXCLUDED_DOMAINS) {
    if (domain === excl || domain.endsWith('.' + excl)) return true;
  }
  return false;
}

// ── Google CSE ────────────────────────────────────────────────────────────────

function getGoogleKeys() {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx  = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) {
    throw new Error(
      'GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX env vars are required for website discovery.\n' +
      '  GOOGLE_SEARCH_API_KEY: Google Cloud API key with Custom Search JSON API enabled\n' +
      '  GOOGLE_SEARCH_CX:      Programmable Search Engine ID (search.google.com/search-console)'
    );
  }
  console.log(`[Google] API key starts: ${key.slice(0, 8)}... CX: ${cx}`);
  return { key, cx };
}

function googleSearch(query, key, cx) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      key, cx,
      q:   query,
      num: String(RESULTS_PER_QUERY),
    });
    const url = `${GOOGLE_CSE_BASE}?${params}`;
    https.get(url, { headers: { 'User-Agent': 'Soterius-Pipeline/1.0' } }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('Google Search API daily quota exceeded'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Google Search API ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(body).items || []); }
        catch (e) { reject(new Error(`Google Search JSON parse: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Confidence scoring ────────────────────────────────────────────────────────

/**
 * Score a candidate domain against the normalised firm name tokens.
 *
 * Strategy: check how many meaningful name tokens appear in the bare domain stem.
 * "Meaningful" = length > 2 (excludes "of", "at", initials etc).
 */
function scoreDomainMatch(domainStem, normName) {
  if (!domainStem || !normName) return 0;

  const tokens = normName.split(' ').filter(t => t.length > 2);
  if (!tokens.length) return 0;

  let matched = 0;
  for (const token of tokens) {
    if (domainStem.includes(token)) matched++;
  }

  const ratio = matched / tokens.length;
  if (ratio >= 1.0) return 80;
  if (ratio >= 0.6) return 65;
  if (ratio >= 0.3) return 50;
  return 35;
}

/**
 * Strip TLD and separators from a domain to get the bare stem for scoring.
 * e.g. "smith-jones.co.uk" → "smithjones"
 */
function domainStem(domain) {
  return domain
    .replace(/\.(co\.uk|org\.uk|me\.uk|net\.uk|com\.uk)$/, '')
    .replace(/\.(com|net|org|law|legal|uk|io)$/, '')
    .replace(/[-_.]/g, '');
}

// ── Pattern-based discovery (fallback — no API required) ─────────────────────

const axios = require('axios');

function buildDomainPatterns(normName) {
  const slug = normName.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (!slug) return [];
  // Specific patterns first — a live solicitor-specific domain is far more
  // trustworthy than the bare slug which may be an unrelated business.
  return [
    `${slug}solicitors.co.uk`,
    `${slug}law.co.uk`,
    `${slug}solicitors.com`,
    `${slug}.co.uk`,
    `${slug}.com`,
  ];
}

async function probeUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout:        5000,
      maxRedirects:   3,
      validateStatus: s => s < 500,
      headers: { 'User-Agent': 'Soterius-Pipeline/1.0' },
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function discoverByPattern(record) {
  const normName = normaliseFirmName(record._search_name || record.firm_name);
  const patterns = buildDomainPatterns(normName);

  for (const domain of patterns) {
    const live = await probeUrl(`https://${domain}`);
    if (live) {
      return { website: domain, domain_confidence: 55, discovery_method: 'pattern' };
    }
  }
  return null;
}

// ── Per-firm discovery ────────────────────────────────────────────────────────

async function discoverOne(record, key, cx) {
  const normName = normaliseFirmName(record._search_name || record.firm_name);
  const location = record._search_location || record.location || '';

  // ── Primary: Google Custom Search ────────────────────────────────────────────
  if (key && cx) {
    const query = `"${record.firm_name}" solicitors ${location}`.trim();
    let items;
    try {
      items = await googleSearch(query, key, cx);
    } catch (err) {
      if (!err.message.includes('403')) {
        warn(`Search failed for "${record.firm_name}": ${err.message}`);
      }
      items = null;
    }

    if (items && items.length) {
      let best = null;
      for (const item of items) {
        const domain = normaliseDomain(item.link);
        if (!domain || isExcluded(domain)) continue;

        const stem      = domainStem(domain);
        const baseScore = scoreDomainMatch(stem, normName);
        const titleLower = (item.title || '').toLowerCase();
        const firstToken = normName.split(' ')[0];
        const titleBonus = firstToken && titleLower.includes(firstToken) ? 5 : 0;
        const confidence = Math.min(85, baseScore + titleBonus);

        if (!best || confidence > best.confidence) best = { domain, confidence };
        if (best.confidence >= 80) break;
      }

      if (best) {
        return { website: best.domain, domain_confidence: best.confidence, discovery_method: 'google-search' };
      }
    }
  }

  // ── Fallback: domain pattern probing ─────────────────────────────────────────
  return discoverByPattern(record);
}

// ── Batch discovery ───────────────────────────────────────────────────────────

/**
 * Run website discovery across an array of firm records.
 * Mutates each record in-place: adds website, domain_confidence, _discovery_method.
 * Returns a stats object for metrics reporting.
 *
 * @param {object[]} records
 * @param {object}   opts
 * @param {number}   opts.concurrency  Parallel searches per batch (default 2)
 * @returns {Promise<object>}          Discovery stats
 */
async function discoverWebsites(records, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const key = process.env.GOOGLE_SEARCH_API_KEY || null;
  const cx  = process.env.GOOGLE_SEARCH_CX  || null;
  if (!key || !cx) warn('Google Search API not configured — using pattern probing only');

  const stats = {
    total:          records.length,
    discovered:     0,
    highConf:       0,  // ≥70
    medConf:        0,  // 50–69
    lowConf:        0,  // 35–49
    noMatch:        0,  // null / 0
    reviewRequired: 0,  // lowConf + noMatch
  };

  for (let i = 0; i < records.length; i += concurrency) {
    const batch = records.slice(i, i + concurrency);

    await Promise.all(batch.map(async (record) => {
      let result;
      try { result = await discoverOne(record, key, cx); }
      catch (err) { warn(`discoverOne failed for "${record.firm_name}": ${err.message}`); result = null; }

      if (result && result.website) {
        record.website            = result.website;
        record.domain_confidence  = result.domain_confidence;
        record._discovery_method  = result.discovery_method;
        stats.discovered++;

        if (result.domain_confidence >= 70)      stats.highConf++;
        else if (result.domain_confidence >= 50)  stats.medConf++;
        else                                      stats.lowConf++;

        log(`Discovered [${result.discovery_method}]: "${record.firm_name}" → ${result.website} (confidence: ${result.domain_confidence})`);
      } else {
        record.website            = null;
        record.domain_confidence  = 0;
        record._discovery_method  = 'none';
        stats.noMatch++;
        warn(`No website: "${record.firm_name}"`);
      }
    }));

    if (i + concurrency < records.length) {
      await new Promise(r => setTimeout(r, INTER_BATCH_PAUSE_MS));
    }
  }

  stats.reviewRequired = stats.lowConf + stats.noMatch;
  return stats;
}

module.exports = { discoverWebsites };
