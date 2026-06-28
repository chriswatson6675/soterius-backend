'use strict';

// ch-client.test.js — transport regression tests.
//
// Focus: redirect handling must drop the Authorization header on a CROSS-ORIGIN
// redirect (CH Document API → S3 presigned URL) while retaining it on a
// SAME-ORIGIN redirect, preserving all other headers. Reproduces the EO-06
// "400 InvalidArgument — Only one auth mechanism allowed" defect at the transport
// layer so it can never regress.

const { test } = require('node:test');
const assert = require('node:assert');

const client = require('./ch-client');

const PDA = 'https://api.company-information.service.gov.uk';
const DOC = 'https://document-api.company-information.service.gov.uk';
const S3 = 'https://s3.eu-west-2.amazonaws.com/document-api-images-live.ch.gov.uk/docs/ABC?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';

/**
 * Build an injectable transport that scripts a sequence of responses by URL match
 * and records the headers seen on each hop. Mirrors the shape ch-client expects:
 * returns { statusCode, headers, bodyBuffer } (never throws).
 */
function scriptedFetch(routes) {
  const seen = [];
  const fetchFn = async (url, o) => {
    seen.push({ url, headers: { ...(o.headers || {}) } });
    const route = routes.find((r) => url.startsWith(r.prefix));
    if (!route) return { statusCode: 404, headers: {}, bodyBuffer: Buffer.from('') };
    const res = route.respond(url);
    return {
      statusCode: res.statusCode,
      headers: res.headers || {},
      bodyBuffer: res.bodyBuffer || Buffer.from(res.body || ''),
    };
  };
  return { fetchFn, seen };
}

test('same-origin redirect retains the Authorization header', async () => {
  const { fetchFn, seen } = scriptedFetch([
    { prefix: `${PDA}/a`, respond: () => ({ statusCode: 302, headers: { location: `${PDA}/b` } }) },
    { prefix: `${PDA}/b`, respond: () => ({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, bodyBuffer: Buffer.from('PDFBYTES') }) },
  ]);

  const res = await client.getBinary(`${PDA}/a`, { apiKey: 'k', _fetch: fetchFn });

  assert.strictEqual(res.errorType, 'NONE');
  assert.strictEqual(seen.length, 2, 'should make two hops');
  assert.ok(seen[0].headers.Authorization, 'first hop carries Authorization');
  assert.ok(seen[1].headers.Authorization, 'same-origin redirect MUST retain Authorization');
  assert.strictEqual(seen[0].headers.Authorization, seen[1].headers.Authorization);
});

test('cross-origin redirect removes Authorization but preserves other headers', async () => {
  const { fetchFn, seen } = scriptedFetch([
    { prefix: `${DOC}/document/`, respond: () => ({ statusCode: 302, headers: { location: S3 } }) },
    { prefix: 'https://s3.eu-west-2.amazonaws.com', respond: () => ({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, bodyBuffer: Buffer.from('REALPDF') }) },
  ]);

  const res = await client.getBinary(`${DOC}/document/ID/content`, { apiKey: 'k', accept: 'application/pdf', _fetch: fetchFn });

  assert.strictEqual(res.errorType, 'NONE');
  assert.ok(seen[0].headers.Authorization, 'first (document-api) hop carries Authorization');
  assert.strictEqual(seen[1].headers.Authorization, undefined, 'cross-origin S3 hop MUST NOT carry Authorization');
  // all other headers preserved unchanged on the cross-origin hop
  assert.strictEqual(seen[1].headers.Accept, 'application/pdf', 'Accept preserved');
  assert.strictEqual(seen[1].headers['User-Agent'], seen[0].headers['User-Agent'], 'User-Agent preserved');
});

test('EO-06 document retrieval succeeds through the S3 presigned URL', async () => {
  const realBytes = Buffer.from('%PDF-1.5\nthe actual filed document bytes\n%%EOF');
  const { fetchFn, seen } = scriptedFetch([
    // CH Document API issues the signed redirect to S3 (the real flow).
    { prefix: `${DOC}/document/`, respond: () => ({ statusCode: 302, headers: { location: S3 } }) },
    // S3 returns 200 + the binary ONLY when no Authorization header is present;
    // model the live behaviour: reject with 400 if Authorization is sent.
    {
      prefix: 'https://s3.eu-west-2.amazonaws.com',
      respond: () => null, // replaced below to inspect headers
    },
  ]);

  // Re-wire the S3 route to assert the live 400-vs-200 behaviour by header presence.
  const wrapped = async (url, o) => {
    if (url.startsWith('https://s3.eu-west-2.amazonaws.com')) {
      seen.push({ url, headers: { ...(o.headers || {}) } });
      if (o.headers && o.headers.Authorization) {
        return { statusCode: 400, headers: { 'content-type': 'application/xml' }, bodyBuffer: Buffer.from('<Error><Code>InvalidArgument</Code></Error>') };
      }
      return { statusCode: 200, headers: { 'content-type': 'application/pdf' }, bodyBuffer: realBytes };
    }
    return fetchFn(url, o);
  };

  const res = await client.getBinary(`${DOC}/document/KpTHX/content`, { apiKey: 'k', accept: 'application/pdf', _fetch: wrapped });

  assert.strictEqual(res.errorType, 'NONE', 'EO-06 binary should retrieve successfully');
  assert.strictEqual(res.httpStatus, 200);
  assert.strictEqual(res.contentType, 'application/pdf');
  assert.ok(res.bytes.equals(realBytes), 'returns the document bytes byte-for-byte');
});

test('_originOf distinguishes CH Document API from S3', () => {
  assert.strictEqual(client._originOf(`${DOC}/document/ID/content`), DOC);
  assert.notStrictEqual(client._originOf(S3), client._originOf(`${DOC}/x`));
  assert.strictEqual(client._originOf('not a url'), null);
});
