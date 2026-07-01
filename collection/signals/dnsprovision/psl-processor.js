'use strict';
// SOT-DNSPROVISION-001 §4.3 — eTLD+1 extraction (Public Suffix List).
// Pinned PSL: the bundled snapshot of the `psl` library version, recorded per run.
const fs = require('fs');
const path = require('path');
const psl = require('psl');

const PSL_VERSION = (() => {
  try {
    const p = path.join(require.resolve('psl'), '..', 'package.json');
    return 'psl@' + JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch {
    try { return 'psl@' + JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'node_modules', 'psl', 'package.json'), 'utf8')).version; }
    catch { return 'psl@unknown'; }
  }
})();

// Registrable domain (eTLD+1). Deterministic given the pinned PSL. null if not extractable.
function etld1(hostname) {
  if (!hostname || typeof hostname !== 'string') return null;
  const h = hostname.toLowerCase().replace(/\.$/, '').trim();
  if (!h) return null;
  try {
    const d = psl.get(h);
    return d || null;
  } catch {
    return null;
  }
}

module.exports = { etld1, PSL_VERSION };
