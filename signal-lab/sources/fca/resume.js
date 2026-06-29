'use strict';

// resume.js — resumable collection from preserved state (no recreation).
//
// Reference Collector v0.1 — PHASE 7 (IMP-FCA-001 §7; CCS-FCA-001 §12).
//
// Inspects what a run has already preserved (from disk, NOT memory) and computes
// the remaining work, then observes only that — appending new pages. Completed
// endpoints are skipped; interrupted pagination is CONTINUED from the saved Next;
// never-succeeded endpoints are re-observed fresh (the prior failure stays
// preserved as evidence). Already-preserved observations are never overwritten and
// never duplicated [CR-FCA-03/09/12/14].
//
// Authority: CCS-FCA-001 §12; CCD-FCA-001 CR-FCA-03/09/12/14; IMP-FCA-001 §7.

const fs = require('node:fs');
const path = require('node:path');

const { rawDir } = require('./evidence-path');
const { orderFor, def, dependencyParent, dependencyIds } = require('./endpoint-map');
const { observeEndpoint } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');

/**
 * Read preserved per-endpoint, per-dependency state from a run's raw artefacts.
 * Returns: { endpointId: { groups: { [depKey]: { lineCount, successCount,
 *   lastTransport, resumeNext, complete, lastBody } } } }. depKey = dependencyId or '-'.
 */
function inspectRun(runDir) {
  const rDir = rawDir(runDir);
  const map = {};
  if (!fs.existsSync(rDir)) return map;
  for (const file of fs.readdirSync(rDir).filter((f) => f.endsWith('.ndjson'))) {
    const endpointId = file.replace(/\.ndjson$/, '');
    map[endpointId] = { groups: {} };
    for (const line of fs.readFileSync(path.join(rDir, file), 'utf8').split('\n').filter(Boolean)) {
      let ln; try { ln = JSON.parse(line); } catch { continue; }
      const depKey = ln.dependencyId ?? '-';
      const g = map[endpointId].groups[depKey] || (map[endpointId].groups[depKey] = {
        lineCount: 0, successCount: 0, lastTransport: null, resumeNext: null, lastBody: null,
      });
      g.lineCount++;
      g.lastTransport = ln.transport;
      if (ln.transport === 'NONE') {
        g.successCount++;
        g.lastBody = ln.rawBody;
        g.resumeNext = ln.fcaEnvelope && ln.fcaEnvelope.resultInfo ? (ln.fcaEnvelope.resultInfo.Next ?? null) : null;
      }
    }
    for (const depKey of Object.keys(map[endpointId].groups)) {
      const g = map[endpointId].groups[depKey];
      g.complete = g.successCount > 0 && !g.resumeNext;
    }
  }
  return map;
}

/** Compute the per-endpoint resume plan for a family + scope, from preserved state. */
function planResume(runDir, family, scope) {
  const state = inspectRun(runDir);
  const plan = [];
  for (const id of orderFor(family, scope)) {
    const dependsOn = dependencyParent(id);
    if (dependsOn) {
      const pg = state[dependsOn] && state[dependsOn].groups['-'];
      if (!pg || !pg.lastBody) { plan.push({ endpointId: id, action: 'skip-dependency-unavailable' }); continue; }
      let depIdList = [];
      try { depIdList = dependencyIds(id, JSON.parse(pg.lastBody)); } catch { depIdList = []; }
      for (const depId of depIdList) {
        const g = state[id] && state[id].groups[depId];
        if (g && g.complete) plan.push({ endpointId: id, dependencyId: depId, action: 'skip' });
        else if (g && g.resumeNext) plan.push({ endpointId: id, dependencyId: depId, action: 'continue', startUrl: g.resumeNext });
        else plan.push({ endpointId: id, dependencyId: depId, action: 'observe-fresh' });
      }
      continue;
    }
    const g = state[id] && state[id].groups['-'];
    if (!g) plan.push({ endpointId: id, action: 'observe-fresh' });
    else if (g.complete) plan.push({ endpointId: id, action: 'skip' });
    else if (g.resumeNext) plan.push({ endpointId: id, action: 'continue', startUrl: g.resumeNext });
    else plan.push({ endpointId: id, action: 'observe-fresh' });
  }
  return plan;
}

function itemKey(item) { return item.endpointId + (item.dependencyId ? `/${item.dependencyId}` : ''); }

/**
 * Resume a run: observe only the remaining work, appending new pages. Preserved
 * evidence is untouched. Returns a summary of skipped / continued / observed.
 *
 * @param {string} runDir
 * @param {Object} ctx - { family, anchor, scope, config, runId, retry, _fetch, _retryHelpers }
 */
async function resumeCollection(runDir, ctx) {
  const { family, anchor, scope, config, runId, retry, _fetch, _retryHelpers } = ctx;
  const state = inspectRun(runDir);               // preserved snapshot (from disk, not memory)
  const preserver = createPreserver(runDir, { runId });
  const summary = { skipped: [], continued: [], observed: [], newPages: 0 };
  const liveBodies = {}; // endpointId -> parent body (preserved OR freshly observed this pass)

  async function observe(d, depId, startUrl) {
    const { pages } = await observeEndpoint(d, anchor, depId ?? null, config, {
      _fetch, retry, _retryHelpers, ...(startUrl ? { startUrl } : {}),
    });
    preserver.preserveExecution({ family, anchor, executions: [{ endpointId: d._id, dependencyId: depId ?? null, status: 'executed', pages }] });
    summary.newPages += pages.length;
    return pages;
  }

  for (const id of orderFor(family, scope)) {
    const d = { ...def(id), _id: id };
    const dependsOn = dependencyParent(id);

    if (!dependsOn) {
      const g = state[id] && state[id].groups['-'];
      if (g && g.complete) {
        summary.skipped.push(id);
        if (g.lastBody) { try { liveBodies[id] = JSON.parse(g.lastBody); } catch { /* ignore */ } }
        continue;
      }
      const startUrl = g && g.resumeNext ? g.resumeNext : undefined;
      const pages = await observe(d, null, startUrl);
      (startUrl ? summary.continued : summary.observed).push(id);
      const succ = pages.find((p) => p.response.errorType === 'NONE' && p.response.body);
      if (succ) liveBodies[id] = succ.response.body;
      else if (g && g.lastBody) { try { liveBodies[id] = JSON.parse(g.lastBody); } catch { /* ignore */ } }
      continue;
    }

    // Grandchild: derive dependency ids from the parent body observed THIS pass
    // (or already preserved). This is what lets a one-pass resume complete fully.
    const parentBody = liveBodies[dependsOn];
    if (!parentBody) { summary.skipped.push(`${id} (dependency-unavailable)`); continue; }
    let depIdList = [];
    try { depIdList = dependencyIds(id, parentBody); } catch { depIdList = []; }
    for (const depId of depIdList) {
      const g = state[id] && state[id].groups[depId];
      if (g && g.complete) { summary.skipped.push(`${id}/${depId}`); continue; }
      const startUrl = g && g.resumeNext ? g.resumeNext : undefined;
      await observe(d, depId, startUrl);
      (startUrl ? summary.continued : summary.observed).push(`${id}/${depId}`);
    }
  }
  return summary;
}

module.exports = { inspectRun, planResume, resumeCollection, itemKey };
