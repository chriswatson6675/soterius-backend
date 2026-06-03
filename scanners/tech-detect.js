const axios = require('axios');

const SIGNATURES = [
  { name: 'WordPress',        pattern: /wp-content|wp-includes|wordpress/i,    category: 'CMS' },
  { name: 'Drupal',           pattern: /drupal|sites\/default/i,                category: 'CMS' },
  { name: 'Joomla',           pattern: /joomla|\/components\/com_/i,            category: 'CMS' },
  { name: 'Shopify',          pattern: /cdn\.shopify\.com|shopify/i,            category: 'E-Commerce' },
  { name: 'Wix',              pattern: /wix\.com|wixstatic/i,                   category: 'Website Builder' },
  { name: 'React',            pattern: /react\.production\.min\.js|__reactFiber|_reactRootContainer/i, category: 'Framework' },
  { name: 'Angular',          pattern: /ng-version|angular\.min\.js/i,          category: 'Framework' },
  { name: 'Vue.js',           pattern: /vue\.min\.js|__vue__|vue\.runtime/i,    category: 'Framework' },
  { name: 'Next.js',          pattern: /__NEXT_DATA__|_next\/static/i,           category: 'Framework' },
  { name: 'jQuery',           pattern: /jquery\.min\.js|jquery-\d/i,            category: 'Library' },
  { name: 'Bootstrap',        pattern: /bootstrap\.min\.css|bootstrap\.bundle/i, category: 'UI Library' },
  { name: 'Google Analytics', pattern: /google-analytics\.com\/analytics|gtag\('config'/i, category: 'Analytics' },
  { name: 'Google Tag Manager', pattern: /googletagmanager\.com\/gtm\.js/i,     category: 'Analytics' },
  { name: 'Cloudflare',       pattern: /cloudflare/i,                            category: 'CDN' },
];

async function techDetect(domain) {
  const url = `https://${domain}`;

  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': 'SecureVault-Scanner/1.0' },
  });

  const body = response.data?.toString() || '';
  const headers = response.headers;

  const detected = [];
  for (const sig of SIGNATURES) {
    if (sig.pattern.test(body)) {
      detected.push({ name: sig.name, category: sig.category, source: 'body' });
    }
  }

  // Server header
  if (headers['server']) {
    detected.push({ name: headers['server'], category: 'Server', source: 'header' });
  }
  // X-Powered-By header
  if (headers['x-powered-by']) {
    detected.push({ name: headers['x-powered-by'], category: 'Backend', source: 'header' });
  }

  const issues = [];
  if (detected.some(t => t.name === 'WordPress')) {
    issues.push('WordPress detected — ensure plugins are up to date');
  }
  if (headers['x-powered-by']) {
    issues.push(`Server technology disclosed via X-Powered-By: ${headers['x-powered-by']}`);
  }

  return {
    module: 'tech',
    status: issues.length > 0 ? 'warn' : 'pass',
    details: {
      detected,
      count: detected.length,
    },
    issues,
  };
}

module.exports = techDetect;
