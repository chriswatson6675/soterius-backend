const dns = require('dns').promises;

async function getTxt(domain) {
  try { return await dns.resolveTxt(domain); }
  catch { return []; }
}

module.exports = async function emailSecurityCheck(domain) {
  const rootTxt  = (await getTxt(domain)).map(r => r.join(''));
  const spf      = rootTxt.find(r => r.startsWith('v=spf1'));

  const dmarcTxt   = (await getTxt(`_dmarc.${domain}`)).map(r => r.join(''));
  const dmarc      = dmarcTxt.find(r => r.startsWith('v=DMARC1'));
  const dmarcPolicy = dmarc?.match(/p=(\w+)/)?.[1]?.toLowerCase() ?? null;

  const DKIM_SELECTORS = [
    'google', 'selector1', 'selector2', 'default', 'mail',
    'k1', 'k2', 'dkim', 'smtp', 'mimecast',
  ];
  let dkimRecord = null;
  for (const sel of DKIM_SELECTORS) {
    const res = (await getTxt(`${sel}._domainkey.${domain}`)).map(r => r.join(''));
    const found = res.find(r => r.includes('p='));
    if (found) { dkimRecord = found; break; }
  }

  // SPF validity: +all or ?all are dangerously permissive
  const spfPermissive = spf && /[+?]all/.test(spf);

  return [
    {
      name:   'SPF record present and valid',
      status: !spf ? 'FAIL' : spfPermissive ? 'WARNING' : 'PASS',
      details: !spf
        ? 'No SPF record found — anyone can send email claiming to be from this domain'
        : spfPermissive
          ? `SPF record is too permissive: ${spf} — change to "~all" or "-all"`
          : `SPF record configured: ${spf}`,
      timeToFix: !spf ? '15 minutes' : spfPermissive ? '15 minutes' : null,
    },
    {
      name:   'DKIM configured',
      status: dkimRecord ? 'PASS' : 'FAIL',
      details: dkimRecord
        ? 'DKIM key found — outbound emails are cryptographically signed'
        : 'No DKIM record found (checked 10 common selectors) — emails cannot be verified by recipients',
      timeToFix: dkimRecord ? null : '30 minutes',
    },
    {
      name:   'DMARC policy enforced',
      status: !dmarc ? 'FAIL'
        : dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine' ? 'PASS'
        : 'WARNING',
      details: !dmarc
        ? 'No DMARC record found — spoofed emails from this domain will be delivered'
        : dmarcPolicy === 'reject'
          ? 'DMARC p=reject — spoofed emails are blocked outright'
          : dmarcPolicy === 'quarantine'
            ? 'DMARC p=quarantine — spoofed emails are sent to spam'
            : `DMARC p=none — monitoring only, spoofed emails are still delivered (change to p=quarantine or p=reject)`,
      timeToFix: !dmarc ? '15 minutes'
        : (dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine') ? null
        : '15 minutes',
    },
  ];
};
