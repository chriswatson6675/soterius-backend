'use strict';
// Stage 12 — final classification of the 735 MANUAL_REVIEW cohort using ONLY
// the official-source evidence gathered in Stage 11 (live FCA Register,
// SRA Register snapshot). Produces the per-org ledger fields requested and
// the summary tallies.

const fs   = require('fs');
const path = require('path');

const IN  = path.join(__dirname, '11-official-source-evidence.ndjson');
const OUT = path.join(__dirname, 'final-ledger.ndjson');

function normHost(s) {
  if (!s) return null;
  return s.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

const SRA_STATUS_LABEL = {
  YES: 'active (SRA AuthorisationStatus=YES)',
  CEASE: 'ceased (SRA AuthorisationStatus=CEASE)',
  REVOKE: 'authorisation revoked (SRA AuthorisationStatus=REVOKE)',
  INTERVENE: 'SRA intervention (AuthorisationStatus=INTERVENE)',
  CONDITION: 'authorised with conditions (SRA AuthorisationStatus=CONDITION)',
};

function main() {
  const rows = fs.readFileSync(IN, 'utf8').trim().split('\n').map(JSON.parse);
  const out = fs.createWriteStream(OUT);
  const tally = { UPDATE_DOMAIN: 0, GENUINE_NO_PUBLIC_WEBSITE: 0, REVIEW_REQUIRED: 0, DOMAIN_CONFIRMED_CORRECT: 0 };

  for (const r of rows) {
    const ev = r.official_evidence;
    const storedHost = normHost(r.stored_domain);

    // Gather candidate official website(s) + org status, from whichever
    // register(s) apply.
    let officialWebsite = null;
    let officialWebsiteSource = null;
    let orgStatus = null;
    let statusSource = null;
    let evidenceParts = [];

    if (ev.fca_lookup) {
      if (ev.fca_lookup.found) {
        if (ev.fca_lookup.website) {
          officialWebsite = ev.fca_lookup.website;
          officialWebsiteSource = 'FCA Register /Address (live)';
        }
        evidenceParts.push(`FCA Register /Address: ${ev.fca_lookup.website ? `Website Address="${ev.fca_lookup.website}"` : 'no Website Address on file'}`);
      } else {
        evidenceParts.push(`FCA Register /Address lookup failed (${ev.fca_lookup.error})`);
      }
    }
    if (ev.fca_status) {
      if (ev.fca_status.found && ev.fca_status.status) {
        orgStatus = `${/^authorised$/i.test(ev.fca_status.status) ? 'active' : ev.fca_status.status.toLowerCase()} (FCA Status="${ev.fca_status.status}")`;
        statusSource = 'FCA Register /Firm (live)';
        evidenceParts.push(`FCA Register /Firm: Status="${ev.fca_status.status}"`);
      } else {
        evidenceParts.push(`FCA Register /Firm lookup did not return a status (${ev.fca_status.error || 'no data'})`);
      }
    }

    if (ev.sra_record !== undefined && ev.sra_record !== null) {
      const sra = ev.sra_record;
      orgStatus = SRA_STATUS_LABEL[sra.authorisationStatus] || (sra.authorisationStatus == null ? 'not stated by SRA (common for freelance/unregulated basis)' : sra.authorisationStatus);
      statusSource = 'SRA Register (live-004 snapshot, collected 2026-07-06)';
      const sites = [...(sra.websites || []), ...(sra.officeWebsites || [])].filter(Boolean);
      const uniqueSites = [...new Set(sites)];
      if (uniqueSites.length && !officialWebsite) {
        officialWebsite = uniqueSites[0];
        officialWebsiteSource = 'SRA Register (Offices[].Website / Websites[])';
      }
      evidenceParts.push(`SRA Register: AuthorisationStatus=${sra.authorisationStatus ?? 'null'}; Website field(s)=${uniqueSites.length ? uniqueSites.join(', ') : 'none on file'}`);
    } else if (ev.sra_record === null) {
      evidenceParts.push('SRA number not found in SRA Register snapshot');
    }

    if (!ev.fca_lookup && ev.sra_record === undefined) {
      evidenceParts.push('no FCA FRN or SRA number on the Repository Authority record — no official register lookup possible');
    }

    // ── Classification ──────────────────────────────────────────────────────
    // IMPORTANT: a register's on-file "Website" field is DECLARED data, not a
    // live probe. When it matches the stored domain, that only proves the two
    // sources agree on what was submitted — it does NOT confirm the site is
    // currently reachable (we already independently confirmed via DNS/HTTP,
    // in the previous investigation, that this exact domain is dead). Treating
    // an on-file match as "confirmed correct" would overclaim, so it is kept
    // in REVIEW_REQUIRED: there is no evidence of a replacement domain, but
    // also no live evidence the on-file domain currently resolves to a site.
    let hasWebsite, canonicalDomain, classification, confidence;
    const officialHost = normHost(officialWebsite);
    const orgIsActive = orgStatus && /^active/.test(orgStatus);
    const orgIsCeased = orgStatus && /^(ceased|authorisation revoked|SRA intervention)/.test(orgStatus);

    if (officialHost && officialHost !== storedHost) {
      hasWebsite = 'YES';
      canonicalDomain = officialWebsite;
      classification = 'UPDATE_DOMAIN';
      confidence = 'HIGH';
      evidenceParts.push(`official register website (${officialWebsiteSource}) names a DIFFERENT domain than stored — positively evidenced replacement`);
    } else if (officialHost && officialHost === storedHost) {
      hasWebsite = 'UNKNOWN';
      canonicalDomain = null;
      classification = 'REVIEW_REQUIRED';
      confidence = 'LOW';
      evidenceParts.push(`register's on-file website matches the stored domain exactly, but that is DECLARED data (not a live probe) and this exact domain already failed independent DNS/HTTP verification — the register match does not confirm current reachability, it only shows no DIFFERENT domain is on file`);
    } else if (!officialWebsite && orgIsActive) {
      hasWebsite = 'NO';
      canonicalDomain = null;
      classification = 'GENUINE_NO_PUBLIC_WEBSITE';
      confidence = 'MEDIUM';
      evidenceParts.push('organisation confirmed active by its regulator but the register carries no website field on file');
    } else if (!officialWebsite && orgIsCeased) {
      hasWebsite = 'UNKNOWN';
      canonicalDomain = null;
      classification = 'REVIEW_REQUIRED';
      confidence = 'MEDIUM';
      evidenceParts.push('organisation is no longer authorised per its regulator (not "active"), so GENUINE_NO_PUBLIC_WEBSITE\'s active-organisation precondition does not hold; this is an organisational-status matter (see organisation_status), separate from the domain question this pass answers');
    } else {
      hasWebsite = 'UNKNOWN';
      canonicalDomain = null;
      classification = 'REVIEW_REQUIRED';
      confidence = 'LOW';
      if (!evidenceParts.length) evidenceParts.push('no official register evidence available');
    }

    tally[classification] = (tally[classification] || 0) + 1;

    out.write(JSON.stringify({
      organisation_name: r.organisation_name,
      stored_domain: r.stored_domain,
      organisation_status: orgStatus || 'UNKNOWN — no regulator status evidence gathered',
      status_source: statusSource || null,
      has_official_website: hasWebsite,
      canonical_domain: canonicalDomain,
      evidence: evidenceParts.join(' | '),
      confidence,
      classification,
      previous_primary_cause: r.primary_cause,
    }) + '\n');
  }
  out.end(() => {
    console.log('Final classification tally:', tally);
    console.log('Total:', rows.length);
  });
}

main();
