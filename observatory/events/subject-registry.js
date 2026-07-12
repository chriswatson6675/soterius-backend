'use strict';

// subject-registry.js — the governed registry of constitutional Event subjects.
//
// THE SINGLE DISPATCH POINT for subject_type. Nothing else in the codebase may
// switch on subject_type — validation, reader resolution, and projection
// support all route through here, so admitting a new constitutional subject is
// one governed change in one place (never scattered dispatch).
//
// The Event (observatory/events, OBS-CONST-001 §3) owns no domain semantics: it
// references a subject and nothing more. This registry is where a subject_type
// is turned back into the constitutional fact it names — the seam Organisation
// History projects through.
//
// Admitting a subject_type is a governed act (OBS-CONST-001 §7): a new
// constitutional object may not be casually introduced. The allow-list below is
// that governance surface.
//
// ObservationSession is deliberately ABSENT and must stay so. It is an
// operational execution mechanism (observatory/session), not a constitutional
// persistence subject; admitting it would mix the operational and persistence
// layers OBS-CONST-001 P-10 forbids. See rejectionReason().

// A subject reader knows how to resolve one subject_type's subject_id back into
// the referenced fact, for the Organisation History projection. Readers take a
// context so the registry stays decoupled from each subject store's specifics:
// the projection injects how to read (e.g. an observation resolver); absent
// that, the reader returns an honest reference (resolved:false + reason) rather
// than fabricating (Unknown != Absent).

const SUBJECTS = {
  // The atomic immutable unit of evidence (OBS-CONST-001 §3). Facts live in the
  // observation store; the reader resolves them when the projection injects a
  // resolver, else preserves the reference.
  Observation: {
    subjectType: 'Observation',
    async read(subjectId, ctx = {}) {
      if (typeof ctx.resolveObservation === 'function') {
        const subject = await ctx.resolveObservation(subjectId, ctx);
        return { subjectType: 'Observation', subjectId, resolved: subject != null, subject: subject ?? null };
      }
      return { subjectType: 'Observation', subjectId, resolved: false, reason: 'observation resolver not provided (observation-store concern); reference preserved' };
    },
  },

  // An Approval within Operational Processing (OBS-CONST-001 §3). Its persistence
  // store is governed by ADR-COL-010 / SLG-138–140 (proposed, not yet
  // implemented), so the reader honestly reports the store as pending.
  RepositoryDecision: {
    subjectType: 'RepositoryDecision',
    async read(subjectId, ctx = {}) {
      if (typeof ctx.resolveRepositoryDecision === 'function') {
        const subject = await ctx.resolveRepositoryDecision(subjectId, ctx);
        return { subjectType: 'RepositoryDecision', subjectId, resolved: subject != null, subject: subject ?? null };
      }
      return { subjectType: 'RepositoryDecision', subjectId, resolved: false, reason: 'decision store not yet materialised (ADR-COL-010/SLG-138–140); reference preserved' };
    },
  },

  // A change applied to Repository Authority — a merge, split, domain
  // reassignment, classification/lifecycle change (OBS-CONST-001 §3). References
  // a Repository Authority version / remediation-ledger entry.
  RepositoryChange: {
    subjectType: 'RepositoryChange',
    async read(subjectId, ctx = {}) {
      if (typeof ctx.resolveRepositoryChange === 'function') {
        const subject = await ctx.resolveRepositoryChange(subjectId, ctx);
        return { subjectType: 'RepositoryChange', subjectId, resolved: subject != null, subject: subject ?? null };
      }
      return { subjectType: 'RepositoryChange', subjectId, resolved: false, reason: 'change store not yet materialised (ADR-COL-010/SLG-138–140); reference preserved' };
    },
  },
};

// Frozen so a consumer cannot mutate the admitted set by accident (e.g. an
// in-place .sort()) — the allow-list is governance, not a scratch array.
const SUBJECT_TYPES = Object.freeze(Object.keys(SUBJECTS));

// Deliberately not admitted — surfaced with a reason rather than a silent miss,
// so an attempt to use one is diagnosable.
const REJECTED = {
  ObservationSession: 'ObservationSession is an operational execution mechanism (observatory/session), not a constitutional persistence subject. Admitting it would mix the operational and persistence layers (OBS-CONST-001 P-10). It is intentionally outside the Event model.',
};

function isValidSubjectType(subjectType) {
  return Object.prototype.hasOwnProperty.call(SUBJECTS, subjectType);
}

function rejectionReason(subjectType) {
  return REJECTED[subjectType] || null;
}

// Governed gate: throws on an unadmitted subject_type, naming the reason where
// the type is a known-but-rejected one.
function assertValidSubjectType(subjectType) {
  if (isValidSubjectType(subjectType)) return;
  const reason = rejectionReason(subjectType);
  throw new Error(
    reason
      ? `subject_type '${subjectType}' is not admitted: ${reason}`
      : `unknown subject_type '${subjectType}' (admitted: ${SUBJECT_TYPES.join(', ')})`
  );
}

function getReader(subjectType) {
  assertValidSubjectType(subjectType);
  return SUBJECTS[subjectType];
}

// Projection support: resolve one event's subject reference back into its fact
// (or an honest reference). Dispatches through the registry — the only place
// subject_type is switched on.
async function readSubject(subjectType, subjectId, ctx = {}) {
  return getReader(subjectType).read(subjectId, ctx);
}

module.exports = {
  SUBJECT_TYPES,
  isValidSubjectType,
  assertValidSubjectType,
  rejectionReason,
  getReader,
  readSubject,
};
