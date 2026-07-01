const tls = require('tls');

const TLS_VERSIONS = { TLSv1: 1, 'TLSv1.1': 2, 'TLSv1.2': 3, 'TLSv1.3': 4 };

function failAll(msg) {
  return [
    { name: 'Certificate valid and trusted',  status: 'FAIL', details: msg, timeToFix: '15 minutes' },
    { name: 'Certificate not expired',         status: 'FAIL', details: msg, timeToFix: '15 minutes' },
    { name: 'TLS version 1.2 or higher',       status: 'FAIL', details: msg, timeToFix: '30 minutes' },
    { name: 'Certificate valid for 60+ days',  status: 'FAIL', details: msg, timeToFix: '15 minutes' },
  ];
}

module.exports = function sslCheck(domain) {
  return new Promise((resolve) => {
    const options = {
      host: domain, port: 443, servername: domain,
      rejectUnauthorized: false, timeout: 10000,
    };

    const socket = tls.connect(options, () => {
      try {
        const cert       = socket.getPeerCertificate(true);
        const protocol   = socket.getProtocol() || 'unknown';
        const authorized = socket.authorized;

        if (!cert || !cert.valid_to) {
          socket.destroy();
          return resolve(failAll('Invalid certificate data'));
        }

        const validTo          = new Date(cert.valid_to);
        if (isNaN(validTo.getTime())) {
          socket.destroy();
          return resolve(failAll('Invalid certificate data'));
        }

        const now              = new Date();
        const daysUntilExpiry  = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));
        const isExpired        = daysUntilExpiry <= 0;
        const tlsOk            = (TLS_VERSIONS[protocol] || 0) >= TLS_VERSIONS['TLSv1.2'];

        socket.destroy();
        resolve([
          {
            name:      'Certificate valid and trusted',
            status:    authorized ? 'PASS' : 'FAIL',
            details:   authorized
              ? 'Certificate is valid and trusted by a recognised CA'
              : 'Certificate is not trusted — browsers will show a security warning',
            timeToFix: authorized ? null : '15 minutes',
          },
          {
            name:      'Certificate not expired',
            status:    isExpired ? 'FAIL' : 'PASS',
            details:   isExpired
              ? `Certificate expired ${Math.abs(daysUntilExpiry)} day(s) ago`
              : `Valid until ${validTo.toDateString()} (${daysUntilExpiry} days remaining)`,
            timeToFix: isExpired ? '15 minutes' : null,
          },
          {
            name:      'TLS version 1.2 or higher',
            status:    tlsOk ? 'PASS' : 'FAIL',
            details:   `Using ${protocol}${!tlsOk ? ' — upgrade to TLS 1.2 or 1.3 in your server config' : ''}`,
            timeToFix: tlsOk ? null : '30 minutes',
          },
          {
            name:   'Certificate valid for 60+ days',
            status: daysUntilExpiry > 60 ? 'PASS' : daysUntilExpiry > 30 ? 'WARNING' : 'FAIL',
            details: isExpired
              ? 'Certificate has expired'
              : `${daysUntilExpiry} days until expiry`,
            timeToFix: daysUntilExpiry > 60 ? null : daysUntilExpiry > 30 ? '2 weeks' : '15 minutes',
          },
        ]);
      } catch (err) {
        socket.destroy();
        resolve(failAll(`SSL inspection failed: ${err.message}`));
      }
    });

    socket.once('error', (err) => resolve(failAll(`Cannot connect via HTTPS: ${err.message}`)));
    socket.setTimeout(10000, () => { socket.destroy(); resolve(failAll('Connection timed out')); });
  });
};
