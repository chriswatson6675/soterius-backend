const dns = require('dns').promises;

async function getTxt(domain) {
  try { return await dns.resolveTxt(domain); }
  catch { return []; }
}

module.exports = async function emailSecurityCheck(domain) {
  // SPF, DMARC, and DKIM records are always published at the apex domain.
  // Querying www.example.com would find nothing even when records exist at example.com.
  const apex = domain.replace(/^www\./, '');

  const rootTxt  = (await getTxt(apex)).map(r => r.join(''));
  const spf      = rootTxt.find(r => r.toLowerCase().startsWith('v=spf1'));

  const dmarcTxt   = (await getTxt(`_dmarc.${apex}`)).map(r => r.join(''));
  const dmarc      = dmarcTxt.find(r => r.toLowerCase().startsWith('v=dmarc1'));
  const dmarcPolicy = dmarc?.match(/p=(\w+)/)?.[1]?.toLowerCase() ?? null;

  const DKIM_SELECTORS = [
    'google', 'selector1', 'selector2', 'default', 'mail',
    'k1', 'k2', 'dkim', 'smtp', 'mimecast',
  ];
  let dkimRecord = null;
  for (const sel of DKIM_SELECTORS) {
    const res = (await getTxt(`${sel}._domainkey.${apex}`)).map(r => r.join(''));
    const found = res.find(r => r.toLowerCase().includes('p='));
    if (found) { dkimRecord = found; break; }
  }

  // SPF validity: +all or ?all are dangerously permissive
  const spfPermissive = spf && /(\s|^)[+?]all\b/i.test(spf);

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
        : dmarcPolicy === 'reject' ? 'PASS'
        : 'WARNING',
      points: !dmarc ? 0
        : dmarcPolicy === 'reject' ? 40
        : dmarcPolicy === 'quarantine' ? 30
        : 20,
      details: !dmarc
        ? 'No Protection — no DMARC record found; spoofed emails from this domain will be delivered'
        : dmarcPolicy === 'reject'
          ? 'Full Protection — DMARC p=reject; spoofed emails are blocked outright'
          : dmarcPolicy === 'quarantine'
            ? 'Partial Protection — DMARC p=quarantine; spoofed emails are sent to spam but not fully blocked'
            : 'Monitoring Only — DMARC p=none; no enforcement, spoofed emails are still delivered (change to p=quarantine or p=reject)',
      timeToFix: !dmarc ? '15 minutes'
        : dmarcPolicy === 'reject' ? null
        : '15 minutes',
    },
  ];
};
