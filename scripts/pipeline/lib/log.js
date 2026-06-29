'use strict';

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const log   = (...a) => console.log(`[${ts()}] INFO   `, ...a);
const warn  = (...a) => console.warn(`[${ts()}] WARN   `, ...a);
const error = (...a) => console.error(`[${ts()}] ERROR  `, ...a);

module.exports = { log, warn, error };
