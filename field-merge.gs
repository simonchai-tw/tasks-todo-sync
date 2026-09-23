/* Step 3: ordinary-task per-field three-way merge.
 * Fingerprints are compact SHA-256 hex of canonical meaning, not raw values.
 * Unknown baseline + both-sides divergence is a bootstrap conflict, not LWW.
 */

var ORDINARY_SHARED_FIELDS_ = Object.freeze(['title', 'notes', 'completed', 'due']);
var ORDINARY_FP_VERSION_ = 1;

// Resource write journal: an independent, bounded log of managed-block writes per
// pair (separate from the rec.res fingerprints).  Records which side, which block
// fingerprint, when, and the outcome (WRITTEN / CONFIRMED / ABANDONED).  It is
// embedded in rec.res and therefore persisted with the sync state, so a restart
// can see what was last attempted/confirmed.  Bounded — oldest entries are
// evicted once it reaches RESOURCE_JOURNAL_MAX_.
var RESOURCE_JOURNAL_MAX_ = 50;

function resourceJournalNow_() {
  return Date.now();
}

function resourceJournalPush_(journal, entry) {
  if (!Array.isArray(journal)) journal = [];
  journal.push(entry);
  if (journal.length > RESOURCE_JOURNAL_MAX_) {
    journal.splice(0, journal.length - RESOURCE_JOURNAL_MAX_);
  }
  return journal;
}

function resourceNotesChanged_(current, baseline) {
  return String(current == null ? '' : current) !== String(baseline == null ? '' : baseline);
}

/* Re-read the current notes of the provider we are about to PATCH, so a user edit
 * made between our plan and the actual write can be detected and the write
 * abandoned (fail-closed on any read error: return { ok: false }).  The caller
 * overrides this in tests; in production it performs a fresh GET. */
function rereadProviderNotes_(side, rec, gTask, msTask) {
  try {
    if (side === 'google') {
      var freshG = getGTask_(rec.gListId, gTask.id);
      return { ok: true, notes: freshG && freshG.notes != null ? freshG.notes : '' };
    }
    var freshMs = getMsTask_(rec.msListId, rec.msId);
    return { ok: true, notes: microsoftNotesPlainTextProjection_(freshMs) };
  } catch (e) {
    return { ok: false, notes: null };
  }
}

function ordinaryFingerprintHex_(canonical) {
  var payload = 'tts-fp-v1:' + (canonical === null ? 'null' : String(canonical));
  if (typeof Utilities === 'undefined' || !Utilities || typeof Utilities.computeDigest !== 'function' ||
      !Utilities.DigestAlgorithm || !Utilities.DigestAlgorithm.SHA_256) {
    throw new Error('ORDINARY_FP_UNAVAILABLE: SHA-256 digest is required for field fingerprints.');
  }
  var charset = Utilities.Charset && Utilities.Charset.UTF_8;
  var digest = charset
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload, charset)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload);
  var hex = '';
  var i;
  for (i = 0; i < digest.length && hex.length < 32; i += 1) {
    var b = digest[i];
    if (b < 0) b += 256;
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex.slice(0, 32);
}

function ordinaryEmptyFp_() {
  return { v: ORDINARY_FP_VERSION_, title: null, notes: null, completed: null, due: null };
}

function ordinaryCanonicalTitle_(task) {
  /* Blank titles share one canonical placeholder so the Microsoft payload stays
   * valid and the Step 3 fingerprint matches what the provider will store. */
  return canonicalTaskTitle_(task);
}

function ordinaryCanonicalCompleted_(status) {
  return status === 'completed';
}

function ordinaryCanonicalDueFromGoogle_(gTask) {
  return googleDueDateOnly_(gTask && gTask.due);
}

function ordinaryCanonicalDueFromMicrosoft_(msTask) {
  if (!msTask || !Object.prototype.hasOwnProperty.call(msTask, 'dueDateTime')) return null;
  if (msTask.dueDateTime === null || msTask.dueDateTime === undefined || msTask.dueDateTime === '') return null;
  var projected = googleDue_(msTask.dueDateTime);
  return projected ? googleDueDateOnly_(projected) : undefined;
}

/* v0.8.0: the merge unit for `due` is { date, time|null }.  `time` is the
 * canonical wall clock carried by rec.td (the Time Bridge record); when the
 * bridge is off, or the record is absent, the unit is date-only exactly like
 * v0.6.x.  A caller that passes no safety object is treated as "bridge on"
 * (SYNC_TIME_BRIDGE defaults to true), which is what the legacy callers and the
 * unit tests assume. */
function ordinaryTimeBridgeOn_(safety) {
  return safety === undefined || safety === null ? true : safety.enableTimeBridge !== false;
}

function ordinaryDueUnitFromGoogle_(gTask, rec, safety) {
  var time = null;
  if (ordinaryTimeBridgeOn_(safety) && rec && rec.td && rec.td.time) time = rec.td.time;
  return { date: ordinaryCanonicalDueFromGoogle_(gTask), time: time };
}

function ordinaryDueUnitFromMicrosoft_(msTask, rec, safety) {
  if (!msTask || !Object.prototype.hasOwnProperty.call(msTask, 'dueDateTime')) return null;
  if (msTask.dueDateTime === null || msTask.dueDateTime === undefined || msTask.dueDateTime === '') return null;
  var wall = timeBridgeMsDueWallClock_(msTask.dueDateTime, timeBridgeAuthoredTimeZone_(syncTimeZone_()));
  if (!wall) return undefined;
  // The time component belongs to rec.td (the Microsoft renderer adopts a
  // hand-set Microsoft time into it), never to the merge.  If the merge read the
  // provider's own time here, a newly created pair — Google carrying the time,
  // Microsoft still date-only — would look like a bootstrap conflict and the
  // time would never reach Microsoft at all.
  var time = (ordinaryTimeBridgeOn_(safety) && rec && rec.td && rec.td.time) ? rec.td.time : null;
  return { date: wall.date, time: time };
}

function ordinaryUserNotesFromGoogle_(gTask, rec) {
  var res = rec && rec.res;
  var parsed = parseManagedResourceBlock_(gTask && gTask.notes, res && res.gBlockFp, res && res.gBlockIntentFp);
  if (!notesWriteAllowed_(parsed.status) && parsed.status !== RESOURCE_BLOCK_STATUS_.REMOVED) {
    return { ok: false, notes: null, status: parsed.status };
  }
  return {
    ok: true,
    notes: googleNotesPlainTextProjection_(parsed.canonicalUserNotes),
    status: parsed.status
  };
}

function ordinaryUserNotesFromMicrosoft_(msTask, rec) {
  var res = rec && rec.res;
  var raw = microsoftNotesPlainTextProjection_(msTask);
  var parsed = parseManagedResourceBlock_(raw, res && res.msBlockFp, res && res.msBlockIntentFp);
  if (!notesWriteAllowed_(parsed.status) && parsed.status !== RESOURCE_BLOCK_STATUS_.REMOVED) {
    return { ok: false, notes: null, status: parsed.status };
  }
  return {
    ok: true,
    notes: googleNotesPlainTextProjection_(parsed.canonicalUserNotes),
    status: parsed.status
  };
}

function ordinaryProjectGoogle_(gTask, rec, safety) {
  var notes = ordinaryUserNotesFromGoogle_(gTask, rec);
  return {
    title: ordinaryCanonicalTitle_(gTask),
    notes: notes.ok ? notes.notes : null,
    notesOk: notes.ok,
    notesStatus: notes.status,
    completed: ordinaryCanonicalCompleted_(gTask && gTask.status),
    due: ordinaryDueUnitFromGoogle_(gTask, rec, safety),
    dueOk: true
  };
}

function ordinaryProjectMicrosoft_(msTask, rec, safety) {
  var notes = ordinaryUserNotesFromMicrosoft_(msTask, rec);
  var due = ordinaryDueUnitFromMicrosoft_(msTask, rec, safety);
  return {
    title: ordinaryCanonicalTitle_(msTask),
    notes: notes.ok ? notes.notes : null,
    notesOk: notes.ok,
    notesStatus: notes.status,
    completed: ordinaryCanonicalCompleted_(msTask && msTask.status),
    due: due === undefined ? null : due,
    dueOk: due !== undefined
  };
}

function ordinaryFieldFp_(proj, field) {
  if (field === 'notes' && proj.notesOk === false) return null;
  if (field === 'due' && proj.dueOk === false) return null;
  var value = proj[field];
  if (field === 'completed') return ordinaryFingerprintHex_(value === true);
  // The merge compares/bookkeeps the due DATE; the time component lives in
  // rec.td and is rendered by the Microsoft renderer.  Fingerprinting the time
  // here would turn "Microsoft has not caught up yet" into a conflict.
  if (field === 'due') {
    if (value == null) return ordinaryFingerprintHex_(null);
    return ordinaryFingerprintHex_(String(value.date || ''));
  }
  return ordinaryFingerprintHex_(value == null ? '' : value);
}

function ordinaryMergeMappedFields_(baselineFp, googleProjection, microsoftProjection, rec) {
  var toGoogle = {};
  var toMicrosoft = {};
  var convergedFields = [];
  var conflicts = [];
  var bootstrapConflicts = [];
  var initializedFields = [];
  var skipped = [];
  var i;
  for (i = 0; i < ORDINARY_SHARED_FIELDS_.length; i += 1) {
    var field = ORDINARY_SHARED_FIELDS_[i];
    if (field === 'notes' && (googleProjection.notesOk === false || microsoftProjection.notesOk === false)) {
      skipped.push({ field: field, reason: 'NOTES_UNMERGEABLE' });
      continue;
    }
    // v0.8.0: `due` has a single owner again — the ordinary merge.  The former
    // Time Bridge ownership carve-out is gone; the time component travels with
    // the due unit instead.
    if (field === 'due' && (googleProjection.dueOk === false || microsoftProjection.dueOk === false)) {
      skipped.push({ field: field, reason: 'DUE_UNSAFE' });
      continue;
    }
    var g = ordinaryFieldFp_(googleProjection, field);
    var m = ordinaryFieldFp_(microsoftProjection, field);
    var base = baselineFp && Object.prototype.hasOwnProperty.call(baselineFp, field) ? baselineFp[field] : null;
    var unknown = base == null;
    if (unknown) {
      if (g === m) {
        initializedFields.push(field);
        convergedFields.push(field);
      } else {
        bootstrapConflicts.push({ field: field, kind: 'BOOTSTRAP_CONFLICT' });
      }
      continue;
    }
    var gChanged = g !== base;
    var mChanged = m !== base;
    if (!gChanged && !mChanged) continue;
    if (gChanged && !mChanged) {
      toMicrosoft[field] = googleProjection[field];
      continue;
    }
    if (!gChanged && mChanged) {
      toGoogle[field] = microsoftProjection[field];
      continue;
    }
    if (g === m) {
      convergedFields.push(field);
      continue;
    }
    conflicts.push({ field: field, kind: 'TRUE_FIELD_CONFLICT' });
  }
  return {
    toGoogle: toGoogle,
    toMicrosoft: toMicrosoft,
    convergedFields: convergedFields,
    conflicts: conflicts,
    bootstrapConflicts: bootstrapConflicts,
    initializedFields: initializedFields,
    skipped: skipped
  };
}

function ordinaryGooglePatchFromPlan_(plan) {
  var payload = {};
  if (Object.prototype.hasOwnProperty.call(plan.toGoogle, 'title')) payload.title = plan.toGoogle.title;
  if (Object.prototype.hasOwnProperty.call(plan.toGoogle, 'notes')) payload.notes = plan.toGoogle.notes;
  if (Object.prototype.hasOwnProperty.call(plan.toGoogle, 'completed')) {
    payload.status = plan.toGoogle.completed ? 'completed' : 'needsAction';
  }
  if (Object.prototype.hasOwnProperty.call(plan.toGoogle, 'due')) {
    payload.due = plan.toGoogle.due ? plan.toGoogle.due.date + 'T00:00:00.000Z' : null;
  }
  return payload;
}

function ordinaryMicrosoftPatchFromPlan_(plan) {
  var payload = {};
  if (Object.prototype.hasOwnProperty.call(plan.toMicrosoft, 'title')) payload.title = plan.toMicrosoft.title;
  if (Object.prototype.hasOwnProperty.call(plan.toMicrosoft, 'notes')) {
    payload.body = {
      contentType: 'html',
      content: googleNotesAreBlank_(plan.toMicrosoft.notes) ? '' : textToHtml_(String(plan.toMicrosoft.notes))
    };
  }
  if (Object.prototype.hasOwnProperty.call(plan.toMicrosoft, 'completed')) {
    payload.status = plan.toMicrosoft.completed ? 'completed' : 'notStarted';
  }
  if (Object.prototype.hasOwnProperty.call(plan.toMicrosoft, 'due')) {
    // A timed due is written by the Microsoft renderer (due + reminder in one
    // payload) so the round never PATCHes the same field twice.
    if (!plan.toMicrosoft.due) {
      payload.dueDateTime = null;
    } else if (!plan.toMicrosoft.due.time) {
      payload.dueDateTime = msDue_(plan.toMicrosoft.due.date + 'T00:00:00.000Z');
    }
  }
  return payload;
}

function ordinaryStoreFieldConflicts_(rec, plan, gId) {
  var next = {};
  var all = (plan.conflicts || []).concat(plan.bootstrapConflicts || []);
  var i;
  for (i = 0; i < all.length; i += 1) {
    next[all[i].field] = { kind: all[i].kind };
  }
  if (Object.keys(next).length) rec.fc = next;
  else delete rec.fc;
  return next;
}

function ordinaryAdvanceFingerprints_(rec, googleProjection, microsoftProjection, plan) {
  rec.fp = rec.fp && rec.fp.v === ORDINARY_FP_VERSION_ ? rec.fp : ordinaryEmptyFp_();
  var i;
  var fields = (plan.convergedFields || []).concat(plan.initializedFields || []);
  for (i = 0; i < ORDINARY_SHARED_FIELDS_.length; i += 1) {
    var field = ORDINARY_SHARED_FIELDS_[i];
    var g = ordinaryFieldFp_(googleProjection, field);
    var m = ordinaryFieldFp_(microsoftProjection, field);
    if (g && m && g === m) rec.fp[field] = g;
  }
  rec.fp.v = ORDINARY_FP_VERSION_;
}

function ordinaryObservability_(state) {
  var count = 0;
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (rec && rec.fc && typeof rec.fc === 'object') count += Object.keys(rec.fc).length;
  });
  return { fieldConflicts: count };
}

function step2bRecurrenceClassification_() {
  return {
    microsoftOwner: 'INSUFFICIENT_EVIDENCE',
    googleOwner: 'INSUFFICIENT_EVIDENCE',
    implementRecurrenceEngine: false,
    implementSuccessorMatcher: false,
    implementRuleTranslator: false
  };
}

function ordinaryReconcileMappedPair_(state, rec, gTask, msTask, currentGListId, safety) {
  var gProj = ordinaryProjectGoogle_(gTask, rec, safety);
  var mProj = ordinaryProjectMicrosoft_(msTask, rec, safety);
  var plan = ordinaryMergeMappedFields_(rec.fp, gProj, mProj, rec);
  var gId = gTask && gTask.id;
  ordinaryStoreFieldConflicts_(rec, plan, gId);
  var gPayload = ordinaryGooglePatchFromPlan_(plan);
  var msPayload = ordinaryMicrosoftPatchFromPlan_(plan);

  var userNotesG = Object.prototype.hasOwnProperty.call(plan.toGoogle, 'notes') ? plan.toGoogle.notes : gProj.notes;
  var userNotesM = Object.prototype.hasOwnProperty.call(plan.toMicrosoft, 'notes')
    ? plan.toMicrosoft.notes : mProj.notes;
  var resources = planResourceProjection_(gTask, msTask, rec, safety, userNotesG, userNotesM,
    (typeof msLinkedObservationForPair_ === 'function' && rec)
      ? msLinkedObservationForPair_(rec, msTask) : undefined);
  // Bounded resource write journal, seeded from any prior entries so a restart can
  // still see what was last attempted/confirmed (req 2).
  var resJournal = (rec.res && Array.isArray(rec.res.journal)) ? rec.res.journal.slice() : [];
  if ((Object.prototype.hasOwnProperty.call(gPayload, 'notes') || resources.writeGoogle) &&
      notesWriteAllowed_(resources.gParseStatus) && !googleNotesWriteBlocked_(gTask)) {
    gPayload.notes = composeManagedNotes_(userNotesG, resources.googleBlock);
  }
  if ((Object.prototype.hasOwnProperty.call(msPayload, 'body') || resources.writeMicrosoft) &&
      notesWriteAllowed_(resources.msParseStatus) && resources.microsoftBody) {
    msPayload.body = {
      contentType: resources.microsoftBody.contentType,
      content: resources.microsoftBody.contentType === 'html'
        ? textToHtml_(composeManagedNotes_(userNotesM, resources.microsoftBlock))
        : composeManagedNotes_(userNotesM, resources.microsoftBlock)
    };
  }
  if (resources.nativeCreate) {
    throw new Error('NATIVE_LINKED_RESOURCE_CREATE_FORBIDDEN');
  }

  // W1c — do not repeat an intent the provider already refused.  The hold is
  // durable, so it survives restarts and does not alert every round; a changed
  // payload releases it because the fingerprint no longer matches.  This check
  // runs BEFORE the W4 intent checkpoint so a held pair never leaves a stale
  // intent marker for a write that is not going to happen.
  var gId = gTask.id;
  var mutationFp = mutationPayloadFingerprint_(gPayload, msPayload);
  if (mutationJournalHoldsPayload_(state, gId, mutationFp)) {
    return {
      plan: plan,
      googleWrites: 0,
      microsoftWrites: 0,
      resourceDiagnostic: resources.diagnostic,
      mutationHeld: true
    };
  }

  // W4 — persist the write intent BEFORE any provider call.  Without a stored
  // intent, a crash between the PATCH and the round's final commit leaves a
  // managed block this engine cannot recognise as its own: parseManagedResourceBlock_
  // matches on priorFp/intentFp only, so the block would read as UNOWNED or
  // AMBIGUOUS and notesWriteAllowed_ would refuse every later projection until a
  // human intervened.  The intent is deliberately NOT a confirmed fingerprint.
  var blockIntent = resources.blockIntent || { google: null, microsoft: null };
  if (blockIntent.google || blockIntent.microsoft) {
    var priorRes = rec.res || {};
    var intentRes = {};
    if (priorRes.gBlockFp) intentRes.gBlockFp = priorRes.gBlockFp;
    if (priorRes.msBlockFp) intentRes.msBlockFp = priorRes.msBlockFp;
    if (priorRes.journal) intentRes.journal = priorRes.journal;
    if (blockIntent.google) intentRes.gBlockIntentFp = blockIntent.google;
    if (blockIntent.microsoft) intentRes.msBlockIntentFp = blockIntent.microsoft;
    rec.res = intentRes;
    // Mid-round durable checkpoint; persistSyncState_ is round-fence aware, so
    // this cannot leak volatile deletion proof into the saved state.
    persistSyncState_(state);
  }

  var gAfter = gTask;
  var msAfter = msTask;
  var gWrites = 0;
  var msWrites = 0;
  var gPending = Object.keys(gPayload).length > 0;
  var msPending = Object.keys(msPayload).length > 0;

  // W4 — pre-PATCH re-read of the target side's notes.  If the user edited notes
  // between our plan and the actual PATCH, abandon THIS round's notes write on that
  // side instead of clobbering their edit; record NOTES_REREAD_USER_EDIT.  A read
  // failure is fail-closed: also abandon, no retry, no guess, with
  // NOTES_REREAD_FAILED.  Only a side that is genuinely about to write notes pays
  // for the extra read (req 1a).  This must not change promotion semantics — if we
  // do not write (gWrites/msWrites stay 0) the write intent is not confirmed (req
  // 1c), because the readback check below is then skipped.
  if (gPending && Object.prototype.hasOwnProperty.call(gPayload, 'notes')) {
    var gReread = rereadProviderNotes_('google', rec, gTask, msTask);
    if (!gReread.ok || resourceNotesChanged_(gReread.notes, gTask.notes)) {
      delete gPayload.notes;
      resources.diagnostic.push(gReread.ok ? 'NOTES_REREAD_USER_EDIT' : 'NOTES_REREAD_FAILED');
      if (blockIntent.google) {
        resourceJournalPush_(resJournal, {
          side: 'google', blockFp: blockIntent.google, at: resourceJournalNow_(), result: 'ABANDONED'
        });
      }
    }
  }
  if (msPending && Object.prototype.hasOwnProperty.call(msPayload, 'body')) {
    var msReread = rereadProviderNotes_('microsoft', rec, gTask, msTask);
    if (!msReread.ok || resourceNotesChanged_(msReread.notes, microsoftNotesPlainTextProjection_(msTask))) {
      delete msPayload.body;
      resources.diagnostic.push(msReread.ok ? 'NOTES_REREAD_USER_EDIT' : 'NOTES_REREAD_FAILED');
      if (blockIntent.microsoft) {
        resourceJournalPush_(resJournal, {
          side: 'microsoft', blockFp: blockIntent.microsoft, at: resourceJournalNow_(), result: 'ABANDONED'
        });
      }
    }
  }
  gPending = Object.keys(gPayload).length > 0;
  msPending = Object.keys(msPayload).length > 0;

  try {
    if (gPending) {
      gAfter = updateGTask_(rec.gListId, gTask.id, gPayload);
      gWrites = 1;
    }
    if (msPending) {
      msAfter = updateMsTask_(rec.msListId, rec.msId, msPayload);
      msWrites = 1;
    }
  } catch (e) {
    // Record the refused intent durably (including a one-sided partial success),
    // then re-throw so the round-level containment in reconcileMapped_ still
    // decides the blast radius.
    recordPairMutationFailure_(state, gId, rec, mutationFp, e,
      gWrites && msPending ? 'google-applied'
        : (msWrites && gPending ? 'microsoft-applied' : null));
    throw e;
  }
  if (gWrites || msWrites) clearPairMutationJournal_(state, gId);

  if (gWrites && blockIntent.google) {
    resourceJournalPush_(resJournal, {
      side: 'google', blockFp: blockIntent.google, at: resourceJournalNow_(), result: 'WRITTEN'
    });
  }
  if (msWrites && blockIntent.microsoft) {
    resourceJournalPush_(resJournal, {
      side: 'microsoft', blockFp: blockIntent.microsoft, at: resourceJournalNow_(), result: 'WRITTEN'
    });
  }

  if (blockIntent.google || blockIntent.microsoft) {
    // W4 — promote the intent to a confirmed fingerprint ONLY when the provider's
    // own readback shows the exact block we intended to write.  A mismatch, or a
    // write that never happened, keeps the intent marker and must NOT advance the
    // baseline, so a later round re-derives the plan from fresh observation
    // instead of trusting an unverified write.
    var gConfirmed = null;
    var msConfirmed = null;
    if (blockIntent.google) {
      var gObserved = gWrites ? observedManagedBlockFingerprint_(gAfter && gAfter.notes) : null;
      gConfirmed = gObserved === blockIntent.google ? blockIntent.google : null;
    }
    if (blockIntent.microsoft) {
      var msObserved = msWrites
        ? observedManagedBlockFingerprint_(microsoftNotesPlainTextProjection_(msAfter))
        : null;
      msConfirmed = msObserved === blockIntent.microsoft ? blockIntent.microsoft : null;
    }
    if (gConfirmed) {
      resourceJournalPush_(resJournal, {
        side: 'google', blockFp: gConfirmed, at: resourceJournalNow_(), result: 'CONFIRMED'
      });
    }
    if (msConfirmed) {
      resourceJournalPush_(resJournal, {
        side: 'microsoft', blockFp: msConfirmed, at: resourceJournalNow_(), result: 'CONFIRMED'
      });
    }
    var carried = rec.res || {};
    var settledRes = {};
    var gFinal = blockIntent.google ? gConfirmed : (carried.gBlockFp || null);
    var msFinal = blockIntent.microsoft ? msConfirmed : (carried.msBlockFp || null);
    if (gFinal) settledRes.gBlockFp = gFinal;
    if (msFinal) settledRes.msBlockFp = msFinal;
    if (blockIntent.google && !gConfirmed) settledRes.gBlockIntentFp = blockIntent.google;
    if (blockIntent.microsoft && !msConfirmed) settledRes.msBlockIntentFp = blockIntent.microsoft;
    if (settledRes.gBlockFp || settledRes.msBlockFp ||
        settledRes.gBlockIntentFp || settledRes.msBlockIntentFp) {
      rec.res = settledRes;
    } else {
      delete rec.res;
    }
  } else if (resources.nextRes && (resources.nextRes.gBlockFp || resources.nextRes.msBlockFp)) {
    rec.res = resources.nextRes;
  } else if (resources.nextRes === null) delete rec.res;

  if (resJournal.length) {
    if (!rec.res) rec.res = {};
    rec.res.journal = resJournal;
  }

  var gNow = ordinaryProjectGoogle_(gAfter, rec, safety);
  var mNow = ordinaryProjectMicrosoft_(msAfter, rec, safety);
  ordinaryAdvanceFingerprints_(rec, gNow, mNow, plan);

  // v0.8.0 §3.6: the merge owns the DATE while the Microsoft renderer owns the
  // TIME.  Whatever date the merge converged on becomes rec.td.date, so the next
  // round's renderer cannot write a stale date back over the user's edit; a
  // cleared date clears the time with it.  A pair with an unresolved due
  // conflict is left alone (fail-closed) until one side changes again.
  if (rec.td && !(rec.fc && rec.fc.due)) {
    var convergedDate = (mNow.due && mNow.due.date) || (gNow.due && gNow.due.date) || null;
    if (!convergedDate) delete rec.td;
    else if (rec.td.date !== convergedDate) rec.td.date = convergedDate;
  }

  putMapping_(state, gAfter, currentGListId || rec.gListId, msAfter, rec.msListId);
  var saved = state.g2m[gAfter.id];
  if (saved) {
    if (rec.fp) saved.fp = rec.fp;
    if (rec.res) saved.res = rec.res;
    else delete saved.res;
    if (rec.fc) saved.fc = rec.fc;
    else delete saved.fc;
    if (rec.td) saved.td = rec.td;
    else delete saved.td;
  }
  return {
    plan: plan,
    googleWrites: gWrites,
    microsoftWrites: msWrites,
    resourceDiagnostic: resources.diagnostic
  };
}
