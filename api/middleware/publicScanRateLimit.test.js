'use strict';

// publicScanRateLimit.test.js — T1.2 (ENG-013 WP1). DI/fake req-res style,
// matching observation-sessions.test.js (no HTTP server, no supertest).
//
// express-rate-limit is configured via module-load-time env vars, so each
// scenario below sets its own env vars and re-requires the module with a
// cleared require cache — the same pattern needed to exercise more than one
// configuration in a single test file.

const { test } = require('node:test');
const assert = require('node:assert');

const MODULE_PATH = require.resolve('./publicScanRateLimit');

function loadWithEnv(env) {
  const prev = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    process.env[key] = String(env[key]);
  }
  delete require.cache[MODULE_PATH];
  const mod = require(MODULE_PATH);
  return {
    mod,
    restore() {
      for (const key of Object.keys(env)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      delete require.cache[MODULE_PATH];
    },
  };
}

function fakeReq(ip) {
  return { ip, headers: {}, method: 'POST', url: '/', app: { get: () => false } };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    body: null,
    headers: {},
  };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.getHeader = (name) => res.headers[name];
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.writableEnded = true; return res; };
  res.send = (body) => { res.body = body; res.writableEnded = true; return res; };
  return res;
}

// Resolves however the chain actually terminates: either every middleware
// calls next() (the request proceeds — `{ completed: true }`), or one of
// them ends the response directly without calling next() (a true rejection
// — `{ ended: true }`, e.g. the hard rate-limit ceiling's handler). A prior
// version of this helper only resolved via next(), which hung forever on a
// rejected request — express-rate-limit's handler ends the response and
// deliberately does not call next().
function runChain(middlewares, req, res) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    res.json = (body) => { const r = origJson(body); settle({ ended: true }); return r; };
    res.send = (body) => { const r = origSend(body); settle({ ended: true }); return r; };

    let i = 0;
    function next(err) {
      if (err) return settle({ error: err });
      if (i >= middlewares.length) return settle({ completed: true });
      const mw = middlewares[i++];
      mw(req, res, next);
    }
    next();
  });
}

test('requests under the ceiling reach next() synchronously, no soft delay', async () => {
  const { mod, restore } = loadWithEnv({
    PUBLIC_SCAN_RATE_WINDOW_MS: 60_000,
    PUBLIC_SCAN_RATE_MAX: 10,
    PUBLIC_SCAN_RATE_SOFT_RATIO: 0.9, // high threshold — this test stays well under it
    PUBLIC_SCAN_RATE_SOFT_DELAY_MS: 5000,
  });
  try {
    const mw = mod.createPublicScanRateLimit();
    const req = fakeReq('10.0.0.1');
    const res = fakeRes();

    const start = Date.now();
    const result = await runChain(mw, req, res);
    const elapsed = Date.now() - start;

    assert.strictEqual(result.completed, true);
    assert.ok(elapsed < 200, `expected no soft delay, took ${elapsed}ms`);
    assert.strictEqual(res.writableEnded, false);
  } finally {
    restore();
  }
});

test('hard cap: exceeding max within the window rejects with 429 + Retry-After, no partial processing', async () => {
  const { mod, restore } = loadWithEnv({
    PUBLIC_SCAN_RATE_WINDOW_MS: 60_000,
    PUBLIC_SCAN_RATE_MAX: 3,
    PUBLIC_SCAN_RATE_SOFT_RATIO: 0.99,
    PUBLIC_SCAN_RATE_SOFT_DELAY_MS: 1,
  });
  try {
    const req = fakeReq('10.0.0.2');
    // Created once, matching real usage — the middleware array is built one
    // time at route-registration and reused across requests, so its counter
    // state (keyed by IP) persists across calls, as it must in production.
    const mw = mod.createPublicScanRateLimit();

    // Same IP, 3 allowed requests then a 4th that must be rejected.
    for (let i = 0; i < 3; i++) {
      const res = fakeRes();
      const result = await runChain(mw, req, res);
      assert.strictEqual(result.completed, true, `request ${i + 1} should have been allowed`);
    }

    const res = fakeRes();
    const result = await runChain(mw, req, res);

    assert.strictEqual(result.ended, true, 'the 4th request must end the response directly, never reach next()');
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.headers['Retry-After'], 'Retry-After header must be present on rejection');
  } finally {
    restore();
  }
});

test('soft throttle: past the ratio threshold but under the ceiling, next() is delayed, not rejected', async () => {
  const { mod, restore } = loadWithEnv({
    PUBLIC_SCAN_RATE_WINDOW_MS: 60_000,
    PUBLIC_SCAN_RATE_MAX: 10,
    PUBLIC_SCAN_RATE_SOFT_RATIO: 0.5, // throttle once 5+/10 used
    PUBLIC_SCAN_RATE_SOFT_DELAY_MS: 50,
  });
  try {
    const req = fakeReq('10.0.0.3');
    const mw = mod.createPublicScanRateLimit(); // created once — see hard-cap test's comment above

    // First 5 requests stay under the 0.5 ratio (used/limit < 0.5 while used <= 4).
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      await runChain(mw, req, res);
    }

    // 6th request: used becomes 6/10 = 0.6 >= 0.5 threshold — must be delayed, not rejected.
    const res = fakeRes();
    const start = Date.now();
    const result = await runChain(mw, req, res);
    const elapsed = Date.now() - start;

    assert.strictEqual(result.completed, true, 'soft-throttled requests still complete, never rejected');
    assert.ok(elapsed >= 45, `expected a soft delay of ~50ms, measured ${elapsed}ms`);
  } finally {
    restore();
  }
});

test('different IPs are counted independently', async () => {
  const { mod, restore } = loadWithEnv({
    PUBLIC_SCAN_RATE_WINDOW_MS: 60_000,
    PUBLIC_SCAN_RATE_MAX: 1,
    PUBLIC_SCAN_RATE_SOFT_RATIO: 0.99,
    PUBLIC_SCAN_RATE_SOFT_DELAY_MS: 1,
  });
  try {
    const mw = mod.createPublicScanRateLimit();

    const resA = fakeRes();
    const resultA = await runChain(mw, fakeReq('10.0.0.10'), resA);
    assert.strictEqual(resultA.completed, true);

    const resB = fakeRes();
    const resultB = await runChain(mw, fakeReq('10.0.0.11'), resB);
    assert.strictEqual(resultB.completed, true, 'a different IP must not be affected by another IP exhausting its own ceiling');
  } finally {
    restore();
  }
});
