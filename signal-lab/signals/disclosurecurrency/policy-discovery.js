'use strict';

const { renderLinks } = require('./policy-retrieval');

const UA = 'SoteriusSignalLab/1.0 (+https://soterius.co.uk; Category H Disclosure Currency collector)';
const COMMON_PATHS = [
  '/privacy', '/privacy-policy', '/privacy-notice', '/privacy-cookies',
  '/data-protection', '/legal/privacy', '/legal/privacy-policy', '/about/privacy', '/en/privacy',
];
const PRIVACY_LINK_RE = /privacy|data[-_ ]?protection/i;
const MAX_REDIRECTS = 6;
const FETCH_TIMEOUT_MS = 15000;

function normalizeBase(domain) {
  const d = String(domain).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${d}`;
}
function stripTags(html) { return html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''; }
function looksThinHtml(html) { return !html || stripTags(html).length < 600; }
function looksLikePolicy(html) {
  if (!html) return false;
  const t = html.toLowerCase();
  const hits = (t.match(/personal data|data protection|privacy|gdpr|cookies?/g) || []).length;
  return t.length > 800 && hits >= 3;
}
function extractPrivacyLinks(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (PRIVACY_LINK_RE.test(href) || PRIVACY_LINK_RE.test(text)) {
      try { out.add(new URL(href, baseUrl).toString()); } catch (_) {}
    }
  }
  return [...out];
}
function pickBest(links) {
  if (!links || links.length === 0) return null;
  return [...links]
    .map((u) => ({ u, score: /privacy/i.test(u) ? 0 : 1 }))
    .sort((a, b) => a.score - b.score || a.u.length - b.u.length)[0].u;
}
function isHub(html, baseUrl) {
  return extractPrivacyLinks(html, baseUrl).length >= 2 && stripTags(html).length < 1500;
}

async function fetchWithChain(startUrl) {
  const chain = [];
  let current = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    let res;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: null, finalUrl: current, html: null, chain, error: String(err && err.message ? err.message : err) };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, status: res.status, finalUrl: current, html: null, chain, error: 'redirect without location' };
      let next;
      try { next = new URL(loc, current).toString(); } catch (_) {
        return { ok: false, status: res.status, finalUrl: current, html: null, chain, error: 'invalid redirect target' };
      }
      chain.push(next);
      current = next;
      continue;
    }
    const html = res.ok ? await res.text().catch(() => null) : null;
    return { ok: res.ok, status: res.status, finalUrl: res.url || current, html, chain, error: res.ok ? null : `HTTP ${res.status}` };
  }
  return { ok: false, status: null, finalUrl: current, html: null, chain, error: 'too many redirects' };
}

async function discoverPolicy(domain) {
  const base = normalizeBase(domain);
  const redirectChain = [];

  for (const path of COMMON_PATHS) {
    const r = await fetchWithChain(base + path);
    redirectChain.push(...r.chain);
    if (r.ok && r.html && looksLikePolicy(r.html)) {
      return { status: 'located', policyUrl: r.finalUrl, redirectChain };
    }
  }

  const home = await fetchWithChain(base);
  redirectChain.push(...home.chain);
  let links = home.ok && !looksThinHtml(home.html) ? extractPrivacyLinks(home.html, home.finalUrl) : [];
  if (links.length === 0) {
    const rendered = await renderLinks(base);
    links = rendered.links
      .filter((l) => PRIVACY_LINK_RE.test(l.href) || PRIVACY_LINK_RE.test(l.text || ''))
      .map((l) => l.href);
  }
  if (links.length === 0) return { status: 'not_located', policyUrl: null, redirectChain };

  const candidate = pickBest(links);
  const r = await fetchWithChain(candidate);
  redirectChain.push(...r.chain);
  if (!r.ok || !r.html) return { status: 'ambiguous', policyUrl: candidate, redirectChain };

  if (isHub(r.html, r.finalUrl)) {
    const primary = pickBest(extractPrivacyLinks(r.html, r.finalUrl)) || candidate;
    const sub = await fetchWithChain(primary);
    redirectChain.push(...sub.chain);
    if (sub.ok && sub.html && looksLikePolicy(sub.html)) {
      return { status: 'located', policyUrl: sub.finalUrl, redirectChain };
    }
    return { status: 'ambiguous', policyUrl: r.finalUrl, redirectChain };
  }
  if (looksLikePolicy(r.html)) return { status: 'located', policyUrl: r.finalUrl, redirectChain };
  return { status: 'ambiguous', policyUrl: r.finalUrl, redirectChain };
}

module.exports = { discoverPolicy, normalizeBase, extractPrivacyLinks, looksLikePolicy, isHub, pickBest };
