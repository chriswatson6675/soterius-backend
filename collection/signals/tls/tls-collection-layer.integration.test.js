'use strict';

/**
 * Integration tests for tls-collection-layer.js.
 *
 * These tests create a locally-controlled TLS server to verify the Layer's
 * behaviour against real TLS sockets. Self-signed certificate generation
 * requires openssl on PATH; tests that need a TLS server are skipped if
 * openssl is unavailable.
 *
 * Run with: node --test tls-collection-layer.integration.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert   = require('node:assert/strict');
const tls      = require('tls');
const net      = require('net');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { execSync } = require('child_process');

const { createRunContext, collectTLSSession } = require('./tls-collection-layer');

// ── Certificate generation ────────────────────────────────────────────────────

let opensslAvailable = false;

try {
  execSync('openssl version', { stdio: 'ignore' });
  opensslAvailable = true;
} catch (_) {
  /* openssl not on PATH — TLS server tests will be skipped */
}

function generateSelfSignedCert(subject = '/CN=localhost/O=SignalLabTest') {
  const tmpDir  = os.tmpdir();
  const keyPath  = path.join(tmpDir, `sl-test-key-${process.pid}.pem`);
  const certPath = path.join(tmpDir, `sl-test-cert-${process.pid}.pem`);

  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}"` +
    ` -days 1 -nodes -subj "${subject}" -addext "subjectAltName=DNS:localhost"`,
    { stdio: 'ignore' }
  );

  const key  = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);

  fs.unlinkSync(keyPath);
  fs.unlinkSync(certPath);

  return { key, cert };
}

// ── Port helper ───────────────────────────────────────────────────────────────

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Shared TLS server lifecycle ───────────────────────────────────────────────

let tlsServer = null;
let tlsPort   = null;
let tlsCreds  = null;

// ── Integration test suites ───────────────────────────────────────────────────

describe('integration — CONNECTION_ERROR (no TLS server needed)', () => {
  test('ECONNREFUSED when nothing listens on the target port', async () => {
    // Find a port with nothing listening by binding and immediately closing it
    const port = await freePort();

    const ctx    = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, {
      timeout: 3000,
      port,                   // pass port through options for testing flexibility
    });

    // Layer must classify refused connections as CONNECTION_ERROR
    assert.equal(result.endpoint_state, 'CONNECTION_ERROR');
    assert.ok(
      result.connection_error_code === 'ECONNREFUSED' ||
      result.connection_error_code === 'ECONNRESET'   ||
      result.connection_error_code === 'ETIMEDOUT',
      `Unexpected error code: ${result.connection_error_code}`
    );
    assert.equal(result.negotiated_version, null);
    assert.equal(result.certificate_present, null);
  });

  test('all evidence keys present on CONNECTION_ERROR', async () => {
    const port = await freePort();
    const ctx  = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, { timeout: 3000, port });

    const REQUIRED = [
      'endpoint_state', 'collected_at', 'collection_hostname',
      'connection_error_code', 'connection_error_msg',
      'negotiated_version', 'cipher_suite_openssl', 'cipher_suite_standard',
      'cipher_key_exchange', 'cipher_symmetric_alg', 'cipher_mac_hash', 'forward_secrecy',
      'alpn_protocol', 'http2_negotiated',
      'certificate_present', 'tls_verification_result', 'tls_error_code',
      'leaf_fingerprint_sha256', 'leaf_san_entries', 'leaf_san_count',
      'leaf_aia_ocsp_urls', 'leaf_aia_ca_issuers_urls', 'leaf_policy_oids',
      'leaf_extension_parse_errors', 'chain_intermediates',
      'cert_chain_depth', 'cert_chain_complete',
      'session_ticket_issued', 'ocsp_stapling_present', 'key_share_group',
    ];
    for (const key of REQUIRED) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `Missing key: ${key}`);
    }
  });

  test('C-1: concurrent CONNECTION_ERROR calls share one connection attempt', async () => {
    const port = await freePort();
    const ctx  = createRunContext();

    const [r1, r2] = await Promise.all([
      collectTLSSession('127.0.0.1', ctx, { timeout: 3000, port }),
      collectTLSSession('127.0.0.1', ctx, { timeout: 3000, port }),
    ]);

    assert.strictEqual(r1, r2, 'Both results must be the same object (C-1 guarantee)');
  });
});

describe('integration — real TLS server (requires openssl)', () => {
  before(async () => {
    if (!opensslAvailable) return;

    try {
      tlsCreds = generateSelfSignedCert('/CN=localhost/O=SignalLabTest');
      tlsPort  = await freePort();

      await new Promise((resolve, reject) => {
        tlsServer = tls.createServer(
          { key: tlsCreds.key, cert: tlsCreds.cert },
          (socket) => socket.destroy()   // immediately close; we only need the handshake
        );
        tlsServer.listen(tlsPort, '127.0.0.1', () => resolve());
        tlsServer.on('error', reject);
      });
    } catch (err) {
      console.log(`[integration] TLS server setup failed: ${err.message} — real-server tests will be skipped`);
      opensslAvailable = false;
    }
  });

  after(async () => {
    if (tlsServer) {
      await new Promise((resolve) => tlsServer.close(resolve));
      tlsServer = null;
    }
  });

  test('RESPONSE_OBSERVED from real TLS server', async (t) => {
    if (!opensslAvailable) return t.skip('openssl not available');

    const ctx    = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort });

    assert.equal(result.endpoint_state,      'RESPONSE_OBSERVED');
    assert.equal(result.collection_hostname, '127.0.0.1');
    assert.ok(typeof result.collected_at === 'string');
    assert.ok(result.negotiated_version !== null, 'negotiated_version must be present');
    assert.ok(result.cipher_suite_openssl !== null, 'cipher_suite_openssl must be present');
    assert.equal(result.connection_error_code, null);
  });

  test('real server returns CERTIFICATE_PRESENTED', async (t) => {
    if (!opensslAvailable) return t.skip('openssl not available');

    const ctx    = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort });

    assert.equal(result.certificate_present, 'CERTIFICATE_PRESENTED');
    assert.ok(typeof result.leaf_fingerprint_sha256 === 'string');
    assert.ok(!/:/g.test(result.leaf_fingerprint_sha256), 'fingerprint must have no colons');
    assert.equal(result.leaf_fingerprint_sha256, result.leaf_fingerprint_sha256.toLowerCase());
  });

  test('self-signed cert detected as SELF_SIGNED or CHAIN_UNVERIFIABLE', async (t) => {
    if (!opensslAvailable) return t.skip('openssl not available');

    const ctx    = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort });

    // A fresh self-signed cert will be SELF_SIGNED or DEPTH_ZERO_SELF_SIGNED
    assert.ok(
      result.tls_verification_result === 'SELF_SIGNED' ||
      result.tls_verification_result === 'CHAIN_UNVERIFIABLE' ||
      result.tls_verification_result === 'HOSTNAME_MISMATCH',
      `Expected self-signed-related result, got: ${result.tls_verification_result}`
    );
    // endpoint_state must still be RESPONSE_OBSERVED (rejectUnauthorized: false)
    assert.equal(result.endpoint_state, 'RESPONSE_OBSERVED');
  });

  test('leaf_not_before and leaf_not_after are ISO 8601 UTC strings', async (t) => {
    if (!opensslAvailable) return t.skip('openssl not available');

    const ctx    = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort });

    assert.ok(result.leaf_not_before, 'leaf_not_before must be present');
    assert.ok(result.leaf_not_after,  'leaf_not_after must be present');
    // Must be parseable ISO 8601 dates
    assert.ok(!isNaN(new Date(result.leaf_not_before).getTime()), `Invalid leaf_not_before: ${result.leaf_not_before}`);
    assert.ok(!isNaN(new Date(result.leaf_not_after).getTime()),  `Invalid leaf_not_after: ${result.leaf_not_after}`);
    assert.ok(result.leaf_not_before.endsWith('Z'), 'must be UTC (Z suffix)');
    assert.ok(result.leaf_not_after.endsWith('Z'),  'must be UTC (Z suffix)');
  });

  test('C-1 holds on real server: two concurrent calls share one session', async (t) => {
    if (!opensslAvailable) return t.skip('openssl not available');

    const ctx = createRunContext();
    const [r1, r2] = await Promise.all([
      collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort }),
      collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort }),
    ]);

    assert.strictEqual(r1, r2, 'Both results must be the same object reference (C-1)');
    assert.equal(r1.endpoint_state, 'RESPONSE_OBSERVED');
  });

  test('forward_secrecy and cipher fields populated on real connection', async (t) => {
    if (!opensslAvailable) return t.skip('openssl not available');

    const ctx    = createRunContext();
    const result = await collectTLSSession('127.0.0.1', ctx, { timeout: 5000, port: tlsPort });

    assert.ok(result.negotiated_version !== null);
    assert.ok(result.cipher_key_exchange !== null, 'cipher_key_exchange must be derivable');
    assert.ok(typeof result.forward_secrecy === 'boolean', 'forward_secrecy must be a boolean for standard ciphers');
  });
});

// ── Port override ────────────────────────────────────────────────────────────
//
// The Layer accepts options.port to override the default port 443. This enables
// testing against local TLS servers on non-standard ports. In production, signal
// runners always use the default (443) and do not pass options.port.
