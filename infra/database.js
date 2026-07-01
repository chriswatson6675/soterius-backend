const { createClient } = require('@supabase/supabase-js');
const logger = require('./utils/logger');

let supabase;

function getClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    supabase = createClient(url, key);
  }
  return supabase;
}

// ── Scan history (permanent per-scan records) ─────────────────────────────────

async function saveScan(domain, scoreObject, scanners, prospectId = null) {
  try {
    const { data, error } = await getClient()
      .from('scans')
      .insert([{
        domain,
        scanned_at:      scoreObject.timestamp      || new Date().toISOString(),
        scoring_version: scoreObject.scoringVersion  || 'v1.0',
        overall_score:   scoreObject.percentage      ?? null,
        risk_band:       scoreObject.riskBand        ?? null,
        score_object:    scoreObject,
        scanner_results: scanners,
        prospect_id:     prospectId                  ?? null,
      }])
      .select('id')
      .single();

    if (error) {
      logger.error('[SUPABASE-ERROR] saveScan failed:', { message: error.message, code: error.code });
      return { success: false, error: error.message };
    }
    return { success: true, id: data.id };
  } catch (err) {
    logger.error('[SUPABASE-ERROR] saveScan threw:', { message: err.message });
    return { success: false, error: err.message };
  }
}

async function getScanHistory(domain, limit = 100) {
  try {
    const { data, error } = await getClient()
      .from('scans')
      .select('id, domain, scanned_at, scoring_version, overall_score, risk_band, score_object, scanner_results')
      .eq('domain', domain.toLowerCase())
      .order('scanned_at', { ascending: false })
      .limit(limit);

    if (error) { logger.error(`getScanHistory failed: ${error.message}`); return []; }
    return data ?? [];
  } catch (err) {
    logger.error(`getScanHistory threw: ${err.message}`);
    return [];
  }
}

async function getScanById(id) {
  try {
    const { data, error } = await getClient()
      .from('scans')
      .select('*')
      .eq('id', id)
      .single();

    if (error) { logger.error(`getScanById failed: ${error.message}`); return null; }
    return data;
  } catch (err) {
    logger.error(`getScanById threw: ${err.message}`);
    return null;
  }
}

// ── Prospect management (benchmarking / market calibration) ──────────────────

async function findOrCreateProspect(data) {
  try {
    const website = data.website.toLowerCase();

    const { data: existing, error: fetchError } = await getClient()
      .from('prospects')
      .select('*')
      .eq('website', website)
      .maybeSingle();

    if (fetchError) {
      logger.error(`findOrCreateProspect fetch failed: ${fetchError.message}`);
      return { success: false, error: fetchError.message };
    }

    if (existing) return { success: true, prospect: existing, created: false };

    const result = await createProspect({ ...data, website, firm_name: data.firm_name || website });
    return { ...result, created: true };
  } catch (err) {
    logger.error(`findOrCreateProspect threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function createProspect(data) {
  try {
    const { data: row, error } = await getClient()
      .from('prospects')
      .insert([{
        firm_name:           data.firm_name,
        website:             data.website.toLowerCase(),
        sector:              data.sector              ?? null,
        location:            data.location            ?? null,
        source:              data.source              ?? 'manual',
        source_date:         data.source_date         ?? null,
        source_reference:    data.source_reference    ?? null,
        firm_confidence:     data.firm_confidence     ?? 90,
        domain_confidence:   data.domain_confidence   ?? 90,
        postcode:            data.postcode            ?? null,
        postcode_source:     data.postcode_source     ?? null,
        postcode_confidence: data.postcode_confidence ?? null,
        notes:               data.notes               ?? null,
      }])
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return { success: false, error: `Website already exists: ${data.website}` };
      }
      logger.error(`createProspect failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    return { success: true, prospect: row };
  } catch (err) {
    logger.error(`createProspect threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getProspects(filters = {}) {
  try {
    let query = getClient()
      .from('prospects')
      .select('*')
      .order('last_scanned', { ascending: true, nullsFirst: true });

    if (filters.sector)   query = query.eq('sector', filters.sector);
    if (filters.location) query = query.eq('location', filters.location);
    if (filters.source)   query = query.eq('source', filters.source);

    const { data, error } = await query;
    if (error) { logger.error(`getProspects failed: ${error.message}`); return []; }
    return data ?? [];
  } catch (err) {
    logger.error(`getProspects threw: ${err.message}`);
    return [];
  }
}

async function getProspectById(id) {
  try {
    const { data, error } = await getClient()
      .from('prospects')
      .select('*')
      .eq('id', id)
      .single();

    if (error) { logger.error(`getProspectById failed: ${error.message}`); return null; }
    return data;
  } catch (err) {
    logger.error(`getProspectById threw: ${err.message}`);
    return null;
  }
}

async function updateProspect(id, updates) {
  try {
    const { data, error } = await getClient()
      .from('prospects')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      logger.error(`updateProspect failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    if (!data) return { success: false, error: 'Prospect not found' };
    return { success: true, prospect: data };
  } catch (err) {
    logger.error(`updateProspect threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function deleteProspect(id) {
  try {
    // Delete linked scans first, then the prospect
    const { error: scanError } = await getClient()
      .from('scans')
      .delete()
      .eq('prospect_id', id);
    if (scanError) {
      logger.error(`deleteProspect: failed to delete scans for ${id}: ${scanError.message}`);
      return { success: false, error: scanError.message };
    }
    const { error } = await getClient()
      .from('prospects')
      .delete()
      .eq('id', id);
    if (error) {
      logger.error(`deleteProspect failed: ${error.message}`);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    logger.error(`deleteProspect threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function updateProspectLastScanned(id) {
  try {
    const now = new Date().toISOString();
    const { error } = await getClient()
      .from('prospects')
      .update({ last_scanned: now, updated_at: now })
      .eq('id', id);

    if (error) logger.error(`updateProspectLastScanned failed: ${error.message}`);
  } catch (err) {
    logger.error(`updateProspectLastScanned threw: ${err.message}`);
  }
}

async function getBenchmarkData() {
  try {
    const { data, error } = await getClient()
      .from('scans')
      .select('id, overall_score, risk_band, scoring_version, scanner_results, scanned_at, prospect_id, prospects(id, firm_name, sector, location)')
      .not('prospect_id', 'is', null)
      .order('scanned_at', { ascending: false });

    if (error) { logger.error(`getBenchmarkData failed: ${error.message}`); return []; }
    return data ?? [];
  } catch (err) {
    logger.error(`getBenchmarkData threw: ${err.message}`);
    return [];
  }
}

// ── Gate submissions (lead capture + scan linkage) ────────────────────────────

async function saveSubmission(email, domain, scanScore, riskLevel, scannerResults, formData, rawScanResults, scoreObject, scanId) {
  try {
    const { data, error } = await getClient()
      .from('submissions')
      .insert([{
        email,
        domain,
        score:          scanScore                  ?? null,
        scan_score:     scanScore                  ?? null,
        risk_level:     riskLevel                  ?? null,
        ssl:            scannerResults?.ssl        ?? null,
        headers:        scannerResults?.headers    ?? null,
        email_sec:      scannerResults?.email_sec  ?? null,
        vuln_comp:      scannerResults?.vulnComp   ?? null,
        gdpr:           scannerResults?.gdpr       ?? null,
        scan_details:   JSON.stringify({ results: rawScanResults ?? scannerResults ?? {}, scoreObject: scoreObject ?? null }),
        scan_id:        scanId                     ?? null,
        name:           formData?.name             || null,
        firm_name:      formData?.firmName         || null,
        main_concern:   formData?.mainConcern      || null,
        it_management:  formData?.itManagement     || null,
        data_incidents: formData?.dataIncidents    ?? null,
        confidence:     formData?.confidence       ?? null,
      }])
      .select('id')
      .single();

    if (error) {
      logger.error('[SUPABASE-ERROR] Insert failed:', {
        message: error.message,
        code:    error.code,
        details: error.details,
        hint:    error.hint,
        fullError: error,
      });
      return { success: false, error: error.message };
    }
    return { success: true, id: data.id };
  } catch (err) {
    logger.error('[SUPABASE-ERROR] saveSubmission failed:', {
      message: err.message,
      code:    err.code,
      details: err.details,
      hint:    err.hint,
      fullError: err,
    });
    return { success: false, error: err.message };
  }
}

async function getSubmissionByEmail(email) {
  try {
    const { data, error } = await getClient()
      .from('submissions')
      .select('*')
      .eq('email', email)
      .order('created_at', { ascending: false });

    if (error) { logger.error(`getSubmissionByEmail failed: ${error.message}`); return []; }
    return data ?? [];
  } catch (err) {
    logger.error(`getSubmissionByEmail threw: ${err.message}`);
    return [];
  }
}

async function getAllSubmissions() {
  try {
    const { data, error } = await getClient()
      .from('submissions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) { logger.error(`getAllSubmissions failed: ${error.message}`); return []; }
    return data ?? [];
  } catch (err) {
    logger.error(`getAllSubmissions threw: ${err.message}`);
    return [];
  }
}

async function getSubmissionById(id) {
  try {
    const { data, error } = await getClient()
      .from('submissions')
      .select('*')
      .eq('id', id)
      .single();

    if (error) { logger.error(`getSubmissionById failed: ${error.message}`); return null; }
    return data;
  } catch (err) {
    logger.error(`getSubmissionById threw: ${err.message}`);
    return null;
  }
}

// ── Customer-facing scan queries ──────────────────────────────────────────────

/**
 * List scans, optionally filtered. Joins with prospects to surface org name.
 * Returns ScanRecordDTO-shaped objects (organisation_id, organisation_name added).
 * @param {object} filter - { domain?, riskBand?, since?, limit? }
 */
async function getScans(filter = {}) {
  try {
    let query = getClient()
      .from('scans')
      .select('id, domain, scanned_at, scoring_version, overall_score, risk_band, score_object, scanner_results, prospect_id, prospects(id, firm_name)')
      .order('scanned_at', { ascending: false })
      .limit(filter.limit ?? 200);

    if (filter.domain)   query = query.eq('domain', filter.domain.toLowerCase());
    if (filter.riskBand) query = query.eq('risk_band', filter.riskBand);
    if (filter.since)    query = query.gte('scanned_at', filter.since);

    const { data, error } = await query;
    if (error) { logger.error(`getScans failed: ${error.message}`); return []; }

    return (data ?? []).map(row => ({
      id:                row.id,
      domain:            row.domain,
      organisation_id:   row.prospect_id ?? null,
      organisation_name: row.prospects?.firm_name ?? null,
      scanned_at:        row.scanned_at,
      scoring_version:   row.scoring_version,
      overall_score:     row.overall_score,
      risk_band:         row.risk_band,
      score_object:      row.score_object ?? null,
      scanner_results:   row.scanner_results ?? [],
    }));
  } catch (err) {
    logger.error(`getScans threw: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a single scan by ID, joined with its prospect (if any).
 */
async function getScanWithOrg(id) {
  try {
    const { data, error } = await getClient()
      .from('scans')
      .select('*, prospects(id, firm_name)')
      .eq('id', id)
      .single();

    if (error) { logger.error(`getScanWithOrg failed: ${error.message}`); return null; }
    if (!data) return null;

    return {
      id:                data.id,
      domain:            data.domain,
      organisation_id:   data.prospect_id ?? null,
      organisation_name: data.prospects?.firm_name ?? null,
      scanned_at:        data.scanned_at,
      scoring_version:   data.scoring_version,
      overall_score:     data.overall_score,
      risk_band:         data.risk_band,
      score_object:      data.score_object ?? null,
      scanner_results:   data.scanner_results ?? [],
    };
  } catch (err) {
    logger.error(`getScanWithOrg threw: ${err.message}`);
    return null;
  }
}

/**
 * For a list of domains, return the most recent scan per domain.
 * Used by the organisation search endpoint to show the current risk band.
 * @returns {Record<string, {overall_score, risk_band, scanned_at}>}
 */
async function getLatestScansByDomains(domains) {
  if (!domains.length) return {};
  try {
    const { data, error } = await getClient()
      .from('scans')
      .select('domain, overall_score, risk_band, scanned_at')
      .in('domain', domains.map(d => d.toLowerCase()))
      .order('scanned_at', { ascending: false });

    if (error) { logger.error(`getLatestScansByDomains failed: ${error.message}`); return {}; }

    const latest = {};
    for (const row of (data ?? [])) {
      if (!latest[row.domain]) latest[row.domain] = row;
    }
    return latest;
  } catch (err) {
    logger.error(`getLatestScansByDomains threw: ${err.message}`);
    return {};
  }
}

module.exports = {
  saveScan, getScanHistory, getScanById,
  getScans, getScanWithOrg, getLatestScansByDomains,
  saveSubmission, getSubmissionByEmail, getAllSubmissions, getSubmissionById,
  findOrCreateProspect, createProspect, getProspects, getProspectById,
  updateProspect, updateProspectLastScanned, deleteProspect, getBenchmarkData,
};
