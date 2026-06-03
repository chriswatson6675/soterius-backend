const dns = require('dns').promises;

async function getTxtRecords(domain) {
  try {
    return await dns.resolveTxt(domain);
  } catch {
    return [];
  }
}

async function dnsCheck(domain) {
  const records = await getTxtRecords(domain);
  const flat = records.map(r => r.join(''));

  const spfRecord = flat.find(r => r.startsWith('v=spf1'));
  const dmarcRecord = (await getTxtRecords(`_dmarc.${domain}`)).map(r => r.join('')).find(r => r.startsWith('v=DMARC1'));

  // DKIM requires a selector — check common selectors across major providers
  // Google Workspace: google | Microsoft 365: selector1, selector2
  // Mailchimp/Mandrill: k1, k2 | Generic: default, mail, dkim, smtp, mimecast
  const dkimSelectors = [
    'google', 'selector1', 'selector2',
    'default', 'mail', 'k1', 'k2',
    'dkim', 'smtp', 'mimecast',
  ];
  let dkimRecord = null;
  for (const selector of dkimSelectors) {
    const res = await getTxtRecords(`${selector}._domainkey.${domain}`);
    const found = res.map(r => r.join('')).find(r => r.includes('p='));
    if (found) { dkimRecord = found; break; }
  }

  const dmarcPolicy = dmarcRecord?.match(/p=(\w+)/)?.[1]?.toLowerCase() ?? null;

  const issues = [];
  if (!spfRecord)  issues.push('No SPF record found');
  if (!dkimRecord) issues.push('No DKIM record found (checked common selectors)');

  // DMARC policy levels:
  //   reject / quarantine → actively blocks spoofed mail (PASS)
  //   none               → monitoring only, no enforcement (WARN)
  //   missing entirely   → no protection at all (FAIL)
  if (!dmarcRecord) {
    issues.push('No DMARC record found');
  } else if (dmarcPolicy === 'none' || !dmarcPolicy) {
    issues.push(`DMARC policy is "${dmarcPolicy ?? 'none'}" — monitoring only, spoofed emails are not blocked`);
  }

  const hasFail = !spfRecord || !dmarcRecord;
  const status  = issues.length === 0 ? 'pass' : hasFail ? 'fail' : 'warn';

  return {
    module: 'dns',
    status,
    details: {
      spf:   { found: !!spfRecord,   record: spfRecord  || null },
      dkim:  { found: !!dkimRecord,  record: dkimRecord ? '[key present]' : null },
      dmarc: { found: !!dmarcRecord, record: dmarcRecord || null, policy: dmarcPolicy },
    },
    issues,
  };
}

module.exports = dnsCheck;
