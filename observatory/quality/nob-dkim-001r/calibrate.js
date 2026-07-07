'use strict';
// DKIM Quality Model — Stage 6 National Calibration scorer.
// Applies the SLG-052 (approved Stage-5) model STRUCTURE with candidate values to
// the validated NOB-DKIM-001R dataset (local NDJSON), and reports the resulting
// 0-100 distribution for governance review. Read-only; no DB writes.
//
// Model (SLG-052): Primary = strongest USABLE key (well-formed + live) graded by
// cryptographic strength; reduce-only multipliers M1/M2/M3. Values below are the
// Stage-6 calibration candidates (RFC 8301 strength tiers).
//
// Usage: node backend/observatory/quality/nob-dkim-001r/calibrate.js [primary1024] [multM1] [multM2] [multM3]

const fs = require('fs');
const path = require('path');
const DIR = __dirname;

// ── Calibration parameters (candidates; overridable via argv for sensitivity) ──
const P_STRONG = 100;                       // >= 2048-bit  (RFC 8301 recommended)
const P_MIN    = Number(process.argv[2] ?? 85);  // == 1024-bit (RFC 8301 minimum, below recommendation)
const P_WEAK   = 40;                         // < 1024-bit  (below RFC 8301 minimum, deprecated)
const P_NONE   = 0;                          // no usable key observed (bounded floor)
const M1 = Number(process.argv[3] ?? 0.95);  // malformed record present alongside usable key
const M2 = Number(process.argv[4] ?? 0.80);  // live <1024 key present alongside a >=1024 key (residual exposure)
const M3 = Number(process.argv[5] ?? 0.90);  // strongest usable key in testing mode (t=y)
const ADEQUACY_FLOOR = 1024;                 // RFC 8301 minimum modulus

function readNd(f) {
  return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const obs  = readNd('observations.ndjson');
const keys = readNd('keys.ndjson');
const keysByRun = new Map();
for (const k of keys) {
  if (!keysByRun.has(k.dkim_run_id)) keysByRun.set(k.dkim_run_id, []);
  keysByRun.get(k.dkim_run_id).push(k);
}

const NONOBS = new Set(['DNS_FAILURE', 'DNS_SERVFAIL', 'DNS_TIMEOUT']);
const scores = [];
let notScored = 0;
const fire = { M1: 0, M2: 0, M3: 0 };
const primaryBand = { strong: 0, minimum: 0, weak: 0, none_present: 0, none_notdetected: 0 };

for (const o of obs) {
  if (NONOBS.has(o.dkim_collection_status)) { notScored++; continue; } // unobserved -> not scored

  const kk = keysByRun.get(o.id) || [];
  const usable = kk.filter(k => k.parse_success && k.public_key_present === true && k.key_bits != null);
  let primary, band;
  if (usable.length === 0) {
    primary = P_NONE;
    band = (o.dkim_present === true) ? 'none_present' : 'none_notdetected';
  } else {
    const maxBits = Math.max(...usable.map(k => k.key_bits));
    if (maxBits >= 2048)      { primary = P_STRONG; band = 'strong'; }
    else if (maxBits === 1024){ primary = P_MIN;    band = 'minimum'; }
    else                      { primary = P_WEAK;   band = 'weak'; }

    // Multipliers (reduce-only)
    let m = 1;
    if (kk.some(k => k.parse_success === false)) { m *= M1; fire.M1++; }
    if (maxBits >= ADEQUACY_FLOOR && usable.some(k => k.key_bits < ADEQUACY_FLOOR)) { m *= M2; fire.M2++; }
    const strongest = usable.filter(k => k.key_bits === maxBits);
    if (strongest.some(k => Array.isArray(k.flags) && k.flags.includes('y'))) { m *= M3; fire.M3++; }
    primary = primary * m;
  }
  primaryBand[band]++;
  scores.push(Math.round(primary * 100) / 100);
}

scores.sort((a, b) => a - b);
const n = scores.length;
const sum = scores.reduce((s, v) => s + v, 0);
const mean = sum / n;
const pct = p => scores[Math.min(n - 1, Math.floor(p / 100 * n))];
const valCount = {};
for (const s of scores) valCount[s] = (valCount[s] || 0) + 1;

console.log(`\nDKIM Quality calibration over NOB-DKIM-001R`);
console.log(`params: P1024=${P_MIN}  M1=${M1}  M2=${M2}  M3=${M3}  (P2048=100, Pweak=40, Pnone=0)`);
console.log(`scored ${n}   not-scored(unobserved) ${notScored}`);
console.log(`mean ${mean.toFixed(2)}  median ${pct(50)}  Q1 ${pct(25)}  Q3 ${pct(75)}  min ${scores[0]}  max ${scores[n-1]}`);
console.log(`deciles ${[10,20,30,40,50,60,70,80,90].map(p=>pct(p)).join(' ')}`);
console.log(`primary bands:`, primaryBand);
console.log(`multiplier fires:`, fire);
console.log(`value counts:`);
for (const v of Object.keys(valCount).map(Number).sort((a,b)=>a-b)) {
  console.log(`  ${String(v).padStart(6)} : ${String(valCount[v]).padStart(6)}  (${(100*valCount[v]/n).toFixed(2)}%)`);
}
