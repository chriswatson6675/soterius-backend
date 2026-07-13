const { queryTxt, presence, aggregatePresence, OUTCOME } = require('./dns-collect');

// Legacy email-security collector (SPF / DKIM / DMARC).
//
// Sprint 3 (ADR-SYS-009 programme): resolution now flows through the shared
// dns-collect layer, which distinguishes OBSERVED_PRESENT / OBSERVED_ABSENT /
// NOT_OBSERVED / COLLECTION_ERROR instead of collapsing every DNS failure into
// an empty array (SLG-141 finding; OBS-CONST-001 P-5, Unknown ≠ Absent).
//
// The check-level output contract is UNCHANGED: every `name` / `status` /
// `details` / `timeToFix` / `points` value is produced by exactly the same logic
// as before, so the legacy score (scanService.deriveTrustScore) is byte-for-byte
// identical. The only addition is a `collection` field on each check carrying the
// truthful collection outcome — additive evidence, read by nothing that scores
// today, available to the future Observation-persistence step. The legacy score
// still treats a NOT_OBSERVED lookup as FAIL exactly as it did before; correcting
// that derivation is downstream Quality-Model work (Phase 3), not this sprint —
// this sprint corrects the EVIDENCE so that later correction is possible at all.
//
// `deps.resolver` is injectable for tests only; production calls pass just the
// domain and get identical resolution behaviour to the old primitive.

module.exports = async function emailSecurityCheck(domain, deps = {}) {
  const { resolver } = deps;
  const q = (name) => queryTxt(name, resolver);

  // SPF, DMARC, and DKIM records are always published at the apex domain.
  // Querying www.example.com would find nothing even when records exist at example.com.
  const apex = domain.replace(/^www\./, '');

  // ── SPF ────────────────────────────────────────────────────────────────────
  const spfQuery = await q(apex);
  const spfPresence = presence(spfQuery, r => r.toLowerCase().startsWith('v=spf1'));
  const spf = spfPresence.matched[0];

  // ── DMARC ──────────────────────────────────────────────────────────────────
  const dmarcQuery = await q(`_dmarc.${apex}`);
  const dmarcPresence = presence(dmarcQuery, r => r.toLowerCase().startsWith('v=dmarc1'));
  const dmarc = dmarcPresence.matched[0];
  const dmarcPolicy = dmarc?.match(/p=(\w+)/)?.[1]?.toLowerCase() ?? null;

  // ── DKIM ───────────────────────────────────────────────────────────────────
  const DKIM_SELECTORS = [
    'google', 'selector1', 'selector2', 'default', 'mail',
    'k1', 'k2', 'dkim', 'smtp', 'mimecast',
  ];
  let dkimRecord = null;
  const dkimProbes = [];
  for (const sel of DKIM_SELECTORS) {
    const selQuery = await q(`${sel}._domainkey.${apex}`);
    const selPresence = presence(selQuery, r => r.toLowerCase().includes('p='));
    dkimProbes.push(selPresence);
    if (selPresence.outcome === OUTCOME.OBSERVED_PRESENT) {
      dkimRecord = selPresence.matched[0];
      break; // first-match-wins, unchanged from prior behaviour
    }
  }
  const dkimOutcome = aggregatePresence(dkimProbes);

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
      // Truthful collection evidence (additive; not read by scoring).
      collection: { outcome: spfPresence.outcome, errorCode: spfQuery.errorCode },
    },
    {
      name:   'DKIM configured',
      status: dkimRecord ? 'PASS' : 'FAIL',
      details: dkimRecord
        ? 'DKIM key found — outbound emails are cryptographically signed'
        : 'No DKIM record found (checked 10 common selectors) — emails cannot be verified by recipients',
      timeToFix: dkimRecord ? null : '30 minutes',
      // DKIM absence is probe-set-bounded; the outcome reflects whether every
      // selector probe actually completed (OBSERVED_ABSENT) or some failed
      // (NOT_OBSERVED / COLLECTION_ERROR), so a resolver failure is never
      // recorded as a confirmed "no DKIM."
      collection: { outcome: dkimOutcome, errorCode: null },
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
      collection: { outcome: dmarcPresence.outcome, errorCode: dmarcQuery.errorCode },
    },
  ];
};
