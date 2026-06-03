const tls = require('tls');

const TLS_VERSIONS = { TLSv1: 1, 'TLSv1.1': 2, 'TLSv1.2': 3, 'TLSv1.3': 4 };
const WEAK_CIPHERS = ['RC4', 'DES', '3DES', 'MD5', 'NULL', 'EXPORT', 'anon'];

function checkCipherStrength(cipher) {
  if (!cipher) return 'unknown';
  const name = cipher.name || '';
  if (WEAK_CIPHERS.some(w => name.includes(w))) return 'weak';
  if (name.includes('AES_256') || name.includes('CHACHA20')) return 'strong';
  return 'acceptable';
}

function sslCheck(domain) {
  return new Promise((resolve) => {
    const options = { host: domain, port: 443, servername: domain, rejectUnauthorized: false, timeout: 10000 };

    const socket = tls.connect(options, () => {
      try {
        const cert = socket.getPeerCertificate(true);
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();
        const authorized = socket.authorized;

        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const now = new Date();
        // Math.ceil avoids off-by-one when expiry time-of-day hasn't passed yet today
        const daysUntilExpiry = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));
        const isExpired = daysUntilExpiry <= 0;

        const tlsVersion = TLS_VERSIONS[protocol] || 0;
        const tlsOk = tlsVersion >= TLS_VERSIONS['TLSv1.2'];

        const issues = [];
        if (isExpired) issues.push('Certificate has expired');
        if (!authorized) issues.push('Certificate not trusted');
        if (!tlsOk) issues.push(`Weak TLS version: ${protocol}`);
        if (checkCipherStrength(cipher) === 'weak') issues.push(`Weak cipher: ${cipher?.name}`);

        socket.destroy();
        resolve({
          module: 'ssl',
          status: isExpired ? 'fail' : issues.length === 0 ? 'pass' : 'warn',
          details: {
            valid: !isExpired,
            authorized,
            validFrom: validFrom.toISOString(),
            validTo: validTo.toISOString(),
            daysUntilExpiry,
            subject: cert.subject,
            issuer: cert.issuer,
            protocol,
            tlsVersionOk: tlsOk,
            cipher: cipher?.name,
            cipherStrength: checkCipherStrength(cipher),
          },
          issues,
        });
      } catch (err) {
        socket.destroy();
        resolve({ module: 'ssl', status: 'error', error: err.message });
      }
    });

    socket.on('error', (err) => {
      resolve({ module: 'ssl', status: 'fail', issues: [`Cannot connect: ${err.message}`], details: {} });
    });

    socket.setTimeout(10000, () => {
      socket.destroy();
      resolve({ module: 'ssl', status: 'error', error: 'Connection timed out' });
    });
  });
}

module.exports = sslCheck;
