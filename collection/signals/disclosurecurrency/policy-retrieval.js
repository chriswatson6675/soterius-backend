'use strict';

const UA = 'SoteriusSignalLab/1.0 (+https://soterius.co.uk; Category H Disclosure Currency collector)';
const STATIC_TIMEOUT_MS = 20000;
const HEADLESS_TIMEOUT_MS = 30000;
const STATIC_MIN_CONTENT = 1200;

function visibleLength(text) {
  if (!text) return 0;
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
function isThin(text) { return visibleLength(text) < STATIC_MIN_CONTENT; }

async function staticFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(STATIC_TIMEOUT_MS),
    });
    const text = res.ok ? await res.text() : null;
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, text, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, finalUrl: url, text: null, error: String(err && err.message ? err.message : err) };
  }
}

let sharedBrowser = null;
async function getBrowser() {
  if (sharedBrowser) return sharedBrowser;
  const puppeteer = require('puppeteer');
  sharedBrowser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return sharedBrowser;
}
async function closeBrowser() {
  if (sharedBrowser) { try { await sharedBrowser.close(); } catch (_) {} sharedBrowser = null; }
}

async function renderUrl(url) {
  let page;
  try {
    page = await (await getBrowser()).newPage();
    await page.setUserAgent(UA);
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: HEADLESS_TIMEOUT_MS });
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return { ok: true, status: resp ? resp.status() : null, finalUrl: page.url(), text, error: null };
  } catch (err) {
    return { ok: false, status: null, finalUrl: url, text: null, error: String(err && err.message ? err.message : err) };
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

async function renderLinks(url) {
  let page;
  try {
    page = await (await getBrowser()).newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: HEADLESS_TIMEOUT_MS });
    const links = await page.$$eval('a[href]', (els) => els.map((a) => ({ href: a.href, text: a.textContent || '' })));
    return { ok: true, finalUrl: page.url(), links, error: null };
  } catch (err) {
    return { ok: false, finalUrl: url, links: [], error: String(err && err.message ? err.message : err) };
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

async function retrievePolicy(url) {
  const s = await staticFetch(url);
  if (s.ok && !isThin(s.text)) {
    return { ok: true, content: s.text, retrievalMethod: 'static', httpStatus: s.status, finalUrl: s.finalUrl, failureReason: null };
  }
  const h = await renderUrl(url);
  if (h.ok && !isThin(h.text)) {
    return { ok: true, content: h.text, retrievalMethod: 'headless', httpStatus: h.status, finalUrl: h.finalUrl, failureReason: null };
  }
  const status = s.status || h.status || null;
  return {
    ok: false,
    content: null,
    retrievalMethod: h.ok ? 'headless' : 'static',
    httpStatus: status,
    finalUrl: s.finalUrl || h.finalUrl || url,
    failureReason: s.error || h.error || `insufficient content (status ${status})`,
  };
}

module.exports = { retrievePolicy, renderUrl, renderLinks, getBrowser, closeBrowser, UA };
