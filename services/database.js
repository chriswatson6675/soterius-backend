const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

let supabase;

function getClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY env vars are required');
    supabase = createClient(url, key, { realtime: { transport: ws } });
  }
  return supabase;
}

async function saveSubmission(email, domain, scanScore, riskLevel, scannerResults, formData, rawScanResults) {
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
        scan_details:   JSON.stringify(rawScanResults ?? scannerResults ?? {}),
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
      console.error('[SUPABASE-ERROR] Insert failed:', {
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
    console.error('[SUPABASE-ERROR] saveSubmission failed:', {
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

    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

async function getAllSubmissions() {
  try {
    const { data, error } = await getClient()
      .from('submissions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return [];
    return data ?? [];
  } catch {
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

    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { saveSubmission, getSubmissionByEmail, getAllSubmissions, getSubmissionById };
