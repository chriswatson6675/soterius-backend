'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');

const key = process.env.GOOGLE_SEARCH_API_KEY;
const cx  = process.env.GOOGLE_SEARCH_CX;

const params = new URLSearchParams({ key, cx, q: 'ABRAHAM SOLICITORS LTD solicitors LL11 1HR', num: '5' });
const url = 'https://www.googleapis.com/customsearch/v1?' + params;

console.log('URL:', url);

https.get(url, { headers: { 'User-Agent': 'Soterius-Pipeline/1.0' } }, (res) => {
  let body = '';
  res.on('data', c => { body += c; });
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    console.log('BODY:', body);
  });
}).on('error', e => console.error('ERROR:', e));
