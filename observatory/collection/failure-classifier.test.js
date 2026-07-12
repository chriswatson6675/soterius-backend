'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CLASS, classifyFailure, isRetryable, classifyHttpStatus } = require('./failure-classifier');

const err = (props) => Object.assign(new Error(props.message || 'x'), props);

describe('classifyFailure — retryable transient conditions', () => {
  test('DNS timeout is retryable', () => {
    assert.equal(classifyFailure(err({ code: 'DNS_TIMEOUT' })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ code: 'ETIMEDOUT' })).class, CLASS.RETRYABLE);
  });
  test('transient resolver failure (EAI_AGAIN / SERVFAIL / REFUSED) is retryable', () => {
    assert.equal(classifyFailure(err({ code: 'EAI_AGAIN' })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ code: 'ESERVFAIL' })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ code: 'EREFUSED' })).class, CLASS.RETRYABLE);
  });
  test('connection reset / temporary network errors are retryable', () => {
    assert.equal(classifyFailure(err({ code: 'ECONNRESET' })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ code: 'EHOSTUNREACH' })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ code: 'ENETUNREACH' })).class, CLASS.RETRYABLE);
  });
  test('temporary TLS failure (EPROTO / handshake) is retryable', () => {
    assert.equal(classifyFailure(err({ code: 'EPROTO' })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ message: 'TLS handshake failed' })).class, CLASS.RETRYABLE);
  });
  test('HTTP timeout / rate limiting is retryable', () => {
    assert.equal(classifyFailure(err({ statusCode: 429 })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ status: 503 })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ status: 408 })).class, CLASS.RETRYABLE);
    assert.equal(classifyFailure(err({ message: 'Rate limit exceeded' })).class, CLASS.RETRYABLE);
    // nested axios-style response
    assert.equal(classifyFailure(err({ response: { status: 429 } })).class, CLASS.RETRYABLE);
  });
  test('isRetryable reflects the class', () => {
    assert.equal(isRetryable(classifyFailure(err({ code: 'ECONNRESET' }))), true);
    assert.equal(isRetryable(classifyFailure(err({ code: 'ENOTFOUND' }))), false);
  });
});

describe('classifyFailure — permanent conditions', () => {
  test('NXDOMAIN / ENOTFOUND is permanent', () => {
    assert.equal(classifyFailure(err({ code: 'ENOTFOUND' })).class, CLASS.PERMANENT);
    assert.equal(classifyFailure(err({ code: 'NXDOMAIN' })).class, CLASS.PERMANENT);
    assert.equal(classifyFailure(err({ code: 'ENODATA' })).class, CLASS.PERMANENT);
  });
  test('malformed domain / unsupported protocol is permanent', () => {
    assert.equal(classifyFailure(err({ code: 'EBADNAME' })).class, CLASS.PERMANENT);
    assert.equal(classifyFailure(err({ code: 'ERR_INVALID_URL' })).class, CLASS.PERMANENT);
    assert.equal(classifyFailure(err({ message: 'unsupported protocol gopher://' })).class, CLASS.PERMANENT);
    assert.equal(classifyFailure(err({ message: 'malformed domain name' })).class, CLASS.PERMANENT);
  });
  test('4xx client/config errors are permanent', () => {
    assert.equal(classifyFailure(err({ status: 404 })).class, CLASS.PERMANENT);
    assert.equal(classifyFailure(err({ status: 400 })).class, CLASS.PERMANENT);
  });
  test('permanent message beats transient message', () => {
    // "no such host" contains no transient token but must resolve permanent
    assert.equal(classifyFailure(err({ message: 'no such host' })).class, CLASS.PERMANENT);
  });
});

describe('classifyFailure — unexpected conditions', () => {
  test('programming errors are UNEXPECTED and never retryable', () => {
    assert.equal(classifyFailure(new TypeError('cannot read x')).class, CLASS.UNEXPECTED);
    assert.equal(classifyFailure(new ReferenceError('y is not defined')).class, CLASS.UNEXPECTED);
    assert.equal(isRetryable(classifyFailure(new TypeError('boom'))), false);
  });
  test('a programming error wins even with a retryable-looking message', () => {
    const e = new TypeError('connection reset while reading');
    assert.equal(classifyFailure(e).class, CLASS.UNEXPECTED);
  });
  test('unrecognised failures are UNEXPECTED (surfaced, not silently retried)', () => {
    assert.equal(classifyFailure(err({ message: 'weird collector explosion' })).class, CLASS.UNEXPECTED);
    assert.equal(classifyFailure(err({ code: 'ESOMETHINGNEW' })).class, CLASS.UNEXPECTED);
  });
});

describe('classifyHttpStatus', () => {
  test('maps status families correctly', () => {
    assert.equal(classifyHttpStatus(429), CLASS.RETRYABLE);
    assert.equal(classifyHttpStatus(502), CLASS.RETRYABLE);
    assert.equal(classifyHttpStatus(403), CLASS.PERMANENT);
    assert.equal(classifyHttpStatus(200), null);
  });
});
