#!/usr/bin/env node
'use strict';

// Provider health check — runs one direct query through whichever search
// provider is currently configured (create-search-provider.js), independent
// of the Research Agent orchestration. Useful to verify credentials/
// configuration before trusting a full agent dry-run.
//
// Usage:
//   node commercial-observatory/run/check-search-provider.js
//   node commercial-observatory/run/check-search-provider.js --query="\"Compliance Office\" compliance consultancy"
//
// Never prints a secret value. Exits 0 on any successful provider request
// (including an honest zero-result response), non-zero otherwise.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { createSearchProvider } = require('../agent/search/create-search-provider');
const { BRAVE_ENDPOINT } = require('../agent/search/brave-search-provider');

const DEFAULT_QUERY = '"Compliance Office" compliance consultancy';

function parseQueryArg(argv) {
  const arg = argv.find((a) => a.startsWith('--query='));
  if (!arg) return DEFAULT_QUERY;
  const raw = arg.slice('--query='.length);
  // Strip one layer of surrounding quotes if the shell passed them through literally.
  return raw.replace(/^"(.*)"$/, '$1');
}

function endpointHostFor(providerName) {
  if (providerName === 'brave') return new URL(BRAVE_ENDPOINT).host;
  if (providerName === 'google_legacy') return 'www.googleapis.com';
  return null;
}

async function main() {
  const query = parseQueryArg(process.argv.slice(2));

  const configuredProviderName = process.env.COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER || null;
  const braveKeyPresent = !!process.env.BRAVE_SEARCH_API_KEY;
  const googleCredsPresent = !!(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX);

  const provider = createSearchProvider({});
  const effectiveProviderName = provider.name;

  process.stdout.write(`Configured provider (COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER): ${configuredProviderName || '(unset — auto-selecting)'}\n`);
  process.stdout.write(`Effective provider: ${effectiveProviderName || '(none — not configured)'}\n`);
  process.stdout.write(`BRAVE_SEARCH_API_KEY present: ${braveKeyPresent ? 'yes' : 'no'}\n`);
  process.stdout.write(`GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX present: ${googleCredsPresent ? 'yes' : 'no'} (legacy, never auto-selected)\n`);
  const endpointHost = endpointHostFor(effectiveProviderName);
  process.stdout.write(`Endpoint host: ${endpointHost || '(n/a)'}\n`);
  process.stdout.write(`Query: ${query}\n`);

  const start = Date.now();
  const result = await provider.search({ query });
  const latencyMs = Date.now() - start;

  process.stdout.write(`Latency: ${latencyMs}ms\n`);

  if (!result.success) {
    process.stdout.write(`Success: false\n`);
    process.stdout.write(`Error type: ${result.errorType}\n`);
    process.stdout.write(`Status: ${result.status ?? '(n/a)'}\n`);
    process.stdout.write(`Error: ${result.error}\n`);
    process.stdout.write(`Retryable: ${result.retryable}\n`);
    process.stdout.write(`Attempts: ${result.attempts ?? 1}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Success: true\n`);
  process.stdout.write(`Attempts: ${result.usage?.attempts ?? 1}\n`);
  process.stdout.write(`Result count: ${result.results.length}\n`);
  if (result.results.length === 0) {
    process.stdout.write(`(Provider returned zero results — a legitimate outcome, not a failure.)\n`);
  }
  for (const r of result.results) {
    process.stdout.write(`  [rank ${r.rank}] ${r.title || '(no title)'}\n`);
    process.stdout.write(`    ${r.url}\n`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exitCode = 1;
});
