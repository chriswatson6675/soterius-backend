// Standalone Mailgun API test
// Usage (option 1 — add to .env then run):
//   node test-mailgun.js
//
// Usage (option 2 — inline env vars in PowerShell):
//   $env:MAILGUN_API_KEY="key-xxx"; $env:MAILGUN_DOMAIN="mg.yourdomain.com"; node test-mailgun.js

require('dotenv').config();
const Mailgun  = require('mailgun.js');
const FormData = require('form-data');

const API_KEY = process.env.MAILGUN_API_KEY;
const DOMAIN  = process.env.MAILGUN_DOMAIN;
const TO      = 'support@soterius.co.uk';

if (!API_KEY || !DOMAIN) {
  console.error('ERROR: MAILGUN_API_KEY and MAILGUN_DOMAIN must be set');
  console.error('  Add them to .env or pass inline:');
  console.error('  $env:MAILGUN_API_KEY="key-xxx"; $env:MAILGUN_DOMAIN="mg.yourdomain.com"; node test-mailgun.js');
  process.exit(1);
}

console.log('─── Mailgun Test ───────────────────────────────');
console.log('API key (first 8 chars):', API_KEY.substring(0, 8) + '...');
console.log('Domain:', DOMAIN);
console.log('Sending to:', TO);
console.log('────────────────────────────────────────────────');

const mailgun = new Mailgun(FormData);
const mg = mailgun.client({
  username: 'api',
  key: API_KEY,
  // Uncomment for EU region:
  // url: 'https://api.eu.mailgun.net',
});

async function run() {
  try {
    console.log('\nCalling Mailgun API...');
    const result = await mg.messages.create(DOMAIN, {
      from:    `Soterius Test <noreply@${DOMAIN}>`,
      to:      [TO],
      subject: 'Mailgun Direct Test',
      text:    'This is a direct Mailgun API test from test-mailgun.js. If you received this, it works.',
    });

    console.log('\n✓ SUCCESS');
    console.log('Message ID:', result.id);
    console.log('Response:  ', result.message);
    console.log('\nFull response object:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('\n✗ FAILED');
    console.error('Message:', err.message);
    console.error('Status: ', err.status);
    console.error('Details:', JSON.stringify(err.details || err.response || {}, null, 2));
  }

  process.exit(0);
}

run();
