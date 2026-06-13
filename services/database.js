const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

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

async function saveScan(domain, scoreObject, scanners) {
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
      .select('id, domain, scanned_at, scoring_version, overall_score, risk_band, score_object')
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

module.exports = {
  saveScan, getScanHistory, getScanById,
  saveSubmission, getSubmissionByEmail, getAllSubmissions, getSubmissionById,
};
