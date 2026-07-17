'use strict';

// html-extract — turns raw retrieved HTML into structured, readable content
// (execution architecture design, §E "Extract Page"). Uses cheerio (the
// smallest suitable HTML parser; none existed in this backend before this
// task — see the final response's Dependencies section).
//
// Raw HTML is never itself dossier content — this module is the only place
// that touches it; everything downstream (page-selection, entity-detection,
// research-website) consumes only this module's structured output.

const cheerio = require('cheerio');

const HEADING_SELECTOR = 'h1, h2, h3';
const BOILERPLATE_SELECTOR = 'script, style, noscript, template, [hidden], [aria-hidden="true"]';

function cleanText(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveHref(href, pageUrl) {
  if (!href) return null;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * extractHtml(html, pageUrl) -> structured page content.
 *
 * `pageUrl` is the URL the HTML was retrieved from — used to resolve
 * relative links and to classify a link as internal (same hostname as
 * `pageUrl`) vs external. This is a lightweight, same-hostname split only;
 * page-selection.js applies the stricter same-registrable-domain policy
 * (via url-policy.js) when deciding what to actually fetch next.
 */
function extractHtml(html, pageUrl) {
  const $ = cheerio.load(html || '');

  // JSON-LD must be read BEFORE boilerplate removal strips <script> tags.
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object') jsonLd.push(candidate);
      }
    } catch {
      // Malformed JSON-LD is common on real sites — skip it, don't fail extraction.
    }
  });

  $(BOILERPLATE_SELECTOR).remove();

  const pageHost = hostnameOf(pageUrl);

  const title = cleanText($('title').first().text());
  const canonicalUrl = resolveHref($('link[rel="canonical"]').first().attr('href'), pageUrl);
  const metaDescription = cleanText($('meta[name="description"]').first().attr('content') || '');

  const headings = $(HEADING_SELECTOR)
    .map((_, el) => ({ level: el.tagName.toLowerCase(), text: cleanText($(el).text()) }))
    .get()
    .filter((h) => h.text.length > 0);

  const footerText = cleanText($('footer').text());

  const navigationLabels = Array.from(new Set(
    $('nav a, header a').map((_, el) => cleanText($(el).text())).get().filter(Boolean),
  ));

  const internalLinks = [];
  const externalLinks = [];
  const seenLinks = new Set();
  $('a[href]').each((_, el) => {
    const href = resolveHref($(el).attr('href'), pageUrl);
    if (!href) return;
    const text = cleanText($(el).text());
    const key = `${href}|${text}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    const target = { href, text };
    if (hostnameOf(href) === pageHost) internalLinks.push(target);
    else externalLinks.push(target);
  });

  // Body text excludes nav/footer/headings duplication only insofar as
  // boilerplate has already been stripped above; nav/footer text is still
  // present in visibleText (kept simple/whole-page for MVP-0) but is also
  // exposed separately for callers that want to treat it differently.
  const visibleText = cleanText($('body').text());

  return {
    title,
    canonicalUrl,
    metaDescription,
    visibleText,
    headings,
    internalLinks,
    externalLinks,
    jsonLd,
    footerText,
    navigationLabels,
  };
}

module.exports = { extractHtml, cleanText };
