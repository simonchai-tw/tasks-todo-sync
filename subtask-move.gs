/* Phase 2 D4: move-journal resume executor.
 *
 * state.subtasks.moveJournal has been a declared ownership-reservation table
 * since v4 (state.gs moveJournal contract: fields phase/gChildId/msChecklistId/
 * nextMsChecklistId/gParentId, phases PREPARED/REMOTE_CREATED/REBIND_PERSISTED/
 * OLD_DELETE_PENDING/UNCERTAIN), but nothing ever read it back.  This module is
 * the missing consumer: it replays interrupted child moves and drives each row
 * to a terminal state (journal retired) or to UNCERTAIN (fail-closed park).
 *
 * Iron rules honoured here (frozen report §D4 :169-171, supplemental rulings
 * §2 S1-S9, option-a-superseded-ruling §6 R5):
 *  - The caller (reconcileSubtasks_ hook) runs this BEFORE deletion
 *    observation, so a vanished old checklist id is never misread as a user
 *    deletion and the two-round confirmation can never eat a new item (S9).
 *  - UNNEST (Google child became top-level) creates the new MS top-level task
 *    with createMsTask_ stamped with TASK_CREATE_EXTENSION_NAME and a
 *    deterministic correlationId ("subtask-move:"+gChildId).  A PREPARED row
 *    whose create outcome is ambiguous is resolved by an extension scan before
 *    any POST, so a crash between POST and persist can never double-create.
 *    The same-round snapshot's raw Google task (notes/due, [TTS-REC] header
 *    verbatim) is projected through msPayloadFromGoogle_ — never re-parsed.
 *  - REPARENT (Google child changed parent): a checklistItem POST has no
 *    idempotency primitive (providers.gs seams comment), so an ambiguous
 *    resume must never blindly repost.  Instead the PREPARED create leg is
 *    completed by exact-title correlation (2026-11-17 reparent ruling): on a
 *    COMPLETE observation of the NEW MS parent, 0 exact matches against the
 *    journal-recorded child title proves the POST never landed => safe to
 *    POST exactly once; >=1 match is ambiguous (our orphan vs a pre-existing
 *    user item — checklistItems carry no notes/extendedProperties, so no
 *    artifact stamp is possible) => park UNCERTAIN, never adopt, never POST,
 *    never delete.  The row must carry the journaled title (written at
 *    PREPARED write time; state.gs whitelist extension is lead-owned wiring);
 *    a row without it cannot correlate and parks UNCERTAIN as before.  A
 *    metadata-bearing child (non-empty notes OR due) is HELD with the loss
 *    list and zero remote writes (S5); a clean child completes create-then-
 *    delete from REMOTE_CREATED exactly once.
 *  - Demote is Preflight BLOCK only.  This executor implements no demotion and
 *    never writes subtask metadata into a parent's notes.
 *  - Every remote delete of the old checklist item is gated by the
 *    operator-wide deletion switch (subtaskDeletionsAllowed_), matching the
 *    2026-10-13 ruling that "allow deletions" must mean every deletion the
 *    engine can perform.  The delete itself is idempotent: a 404 on resume is
 *    the crash-safe success path.
 *  - The rebind (tombstone the old checklist id + release/rebind the checklist
 *    mapping) is persisted BEFORE the old-item delete, so the deletion can
 *    never be observed while the mapping still claims the item.
 *  - The journal row and its ordinary g2m key may never coexist (state.gs
 *    ownership cross-check), so the unnest finalize writes the new pairing in
 *    the SAME persist that retires the row.
 *  - UNCERTAIN rows are never consumed remotely and never dropped; they wait
 *    for observation/operator disambiguation (supplemental rulings §3).
 */

var SUBTASK_MOVE_PHASES_ = Object.freeze({
  PREPARED: 'PREPARED',
  REMOTE_CREATED: 'REMOTE_CREATED',
  REBIND_PERSISTED: 'REBIND_PERSISTED',
  OLD_DELETE_PENDING: 'OLD_DELETE_PENDING',
  UNCERTAIN: 'UNCERTAIN'
});
/* Deterministic create-correlation id derived from journal fields only — the
 * frozen 5-field moveJournal contract has no uuid column, so the extension
 * correlation must be re-derivable from gChildId alone. */
var SUBTASK_MOVE_CORRELATION_PREFIX_ = 'subtask-move:';

function subtaskMoveCorrelationId_(gChildId) {
  return SUBTASK_MOVE_CORRELATION_PREFIX_ + String(gChildId || '');
}

/* Strict shape gate: the frozen 5-field contract plus an OPTIONAL journaled
 * title (wiring pending: state.gs moveJournal whitelist is lead-owned).  A
 * present-but-non-string title is malformed; anything else unknown is
 * reported as blocked and left byte-identical (fail-closed). */
function subtaskMoveRowValid_(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) {
    if (['phase', 'gChildId', 'msChecklistId', 'nextMsChecklistId', 'gParentId', 'title'].indexOf(keys[i]) < 0) return false;
  }
  var phases = Object.keys(SUBTASK_MOVE_PHASES_).map(function(k) { return SUBTASK_MOVE_PHASES_[k]; });
  if (phases.indexOf(row.phase) < 0) return false;
  var required = ['gChildId', 'msChecklistId', 'gParentId'];
  for (var j = 0; j < required.length; j++) {
    if (typeof row[required[j]] !== 'string' || !row[required[j]]) return false;
  }
  if (row.nextMsChecklistId !== undefined && (typeof row.nextMsChecklistId !== 'string' || !row.nextMsChecklistId)) return false;
  if (row.title !== undefined && typeof row.title !== 'string') return false;
  return true;
}

function subtaskMoveInventoryComplete_(snap) {
  if (typeof subtaskGoogleInventoryComplete_ === 'function') return subtaskGoogleInventoryComplete_(snap);
  return !!(snap && (snap.googleInventoryComplete === true || snap.inventoryComplete === true));
}

/* The old checklist item lives under the OLD parent's MS task, which is only
 * reachable through the ordinary pairing.  No pairing => the move cannot be
 * located; the row parks as UNCERTAIN rather than guessing an id. */
function subtaskMoveOldParentRec_(state, row) {
  var rec = state && state.g2m && state.g2m[row.gParentId];
  if (!rec || typeof rec !== 'object' || !rec.msId || !rec.msListId) return null;
  return rec;
}

/* Resolve where the Google child currently lives.  Only a COMPLETE Google
 * inventory may drive a remote transition; a blind round defers everything.
 * STALE (parent unchanged) defers too: a move the Google side does not show
 * must not be executed on faith. */
function subtaskMoveKind_(snap, row) {
  if (!subtaskMoveInventoryComplete_(snap)) return { kind: 'DEFER', reason: 'GOOGLE_INVENTORY_INCOMPLETE' };
  var g = snap && snap.gTasksById && snap.gTasksById[row.gChildId];
  if (!g) return { kind: 'MISSING_CHILD' };
  if (!g.parent) return { kind: 'UNNEST' };
  if (g.parent === row.gParentId) return { kind: 'STALE', reason: 'PARENT_UNCHANGED' };
  return { kind: 'REPARENT', newGParentId: g.parent };
}

function subtaskMoveParkUncertain_(state, row, options, result) {
  row.phase = SUBTASK_MOVE_PHASES_.UNCERTAIN;
  subtaskPersist_(state, options);
  result.uncertain += 1;
  return { parked: true };
}

/* Scan the target list for a task stamped with our deterministic create
 * correlation.  Read failure defers (zero writes); more than one match is
 * ambiguous and parks the row — never pick candidates[0] (supplemental §C1). */
function subtaskMoveScanCorrelatedTask_(listId, gChildId) {
  if (typeof getMsTasks_ !== 'function') return { ok: false };
  var expected = subtaskMoveCorrelationId_(gChildId);
  var tasks;
  try {
    tasks = getMsTasks_(listId, { includeTaskCreateExtension: true }) || [];
  } catch (error) {
    return { ok: false };
  }
  var matches = [];
  (Array.isArray(tasks) ? tasks : []).forEach(function(task) {
    if (!task || !task.id || !Array.isArray(task.extensions)) return;
    task.extensions.forEach(function(ext) {
      if (ext && ext.extensionName === TASK_CREATE_EXTENSION_NAME &&
          typeof TASK_CREATE_EXTENSION_IDS !== 'undefined' &&
          TASK_CREATE_EXTENSION_IDS.indexOf(ext.id) >= 0 &&
          ext.correlationId === expected) matches.push(task);
    });
  });
  if (matches.length > 1) return { ok: true, ambiguous: true };
  return { ok: true, task: matches[0] || null };
}

/* UNNEST PREPARED resume: adopt the correlated orphan, or create the top-level
 * MS task exactly once.  notes/due come from the SAME-ROUND snapshot's raw
 * Google task via msPayloadFromGoogle_ — the [TTS-REC] header is carried
 * verbatim, never re-parsed or rewritten (S3). */
function subtaskMoveCreateTopLevelTask_(state, snap, row, oldRec, options, result) {
  var gTask = snap && snap.gTasksById && snap.gTasksById[row.gChildId];
  if (!gTask) return subtaskMoveParkUncertain_(state, row, options, result);
  var scan = subtaskMoveScanCorrelatedTask_(oldRec.msListId, row.gChildId);
  if (!scan.ok) { result.deferred += 1; return { deferred: true }; }
  var created = scan.task;
  if (scan.ambiguous) return subtaskMoveParkUncertain_(state, row, options, result);
  if (!created) {
    var payload = msPayloadFromGoogle_(gTask, 'create');
    payload.extensions = [{
      '@odata.type': 'microsoft.graph.openTypeExtension',
      extensionName: TASK_CREATE_EXTENSION_NAME,
      correlationId: subtaskMoveCorrelationId_(row.gChildId)
    }];
    try {
      created = createMsTask_(oldRec.msListId, payload);
    } catch (error) {
      return subtaskMoveParkUncertain_(state, row, options, result);
    }
    if (!created || typeof created.id !== 'string' || !created.id) {
      return subtaskMoveParkUncertain_(state, row, options, result);
    }
    result.created += 1;
  }
  row.nextMsChecklistId = created.id;
  row.phase = SUBTASK_MOVE_PHASES_.REMOTE_CREATED;
  /* Same-round snapshot refresh (S6): register the new task so the ordinary
   * create/adoption machinery cannot double-create it later in this round.
   * The correlation scan is a fresh full read of the target list, so an
   * adopted orphan is registered on the same evidence basis (mirrors the
   * correlated recovery in sync.gs). */
  if (snap.msTasksById) snap.msTasksById[created.id] = created;
  if (snap.msListByTask) snap.msListByTask[created.id] = oldRec.msListId;
  subtaskPersist_(state, options);
  return { advanced: true };
}

/* REPARENT target observation: a COMPLETE checklist observation of the NEW MS
 * parent is the only evidence basis for the exact-title correlation scan.
 * No pairing for the new Google parent => the target cannot be located yet
 * (a later round may pair it); a blind round defers.  Both: zero writes. */
function subtaskMoveNewParentItems_(state, snap, kind, options, result) {
  var newRec = state.g2m && state.g2m[kind.newGParentId];
  if (!newRec || !newRec.msId) { result.deferred += 1; return { deferred: true }; }
  if (!subtaskObservationComplete_(state, snap, newRec.msId, options && options.roundId)) {
    result.deferred += 1;
    return { deferred: true };
  }
  return { items: subtaskObservationItems_(snap, newRec.msId) || [], newRec: newRec };
}

/* Exact-title match count over the NEW parent's observed checklistItems.
 * checklistItems carry no notes/extendedProperties (providers.gs seams
 * comment), so no artifact stamp is possible — the title is the only
 * correlation signal, and ANY match is ambiguous with a pre-existing user
 * item (supplemental §C1: never pick candidates[0]). */
function subtaskMoveCountTitleMatches_(items, title) {
  var matches = 0;
  (Array.isArray(items) ? items : []).forEach(function(item) {
    if (item && item.displayName === title) matches += 1;
  });
  return matches;
}

/* REPARENT PREPARED resume (create-leg completion, 2026-11-17 ruling): the
 * crash window before/during the checklist POST is the most common one and
 * must not park forever.  Correlation signal: an EXACT title match against
 * the JOURNALED child title on a COMPLETE observation of the NEW MS parent.
 *  - 0 matches: existential proof the POST never landed (the journaled title
 *    is exactly what the writer's POST carried) => safe to POST exactly once.
 *    The POST reuses the journaled title, NOT the current Google title: a
 *    user rename between crash and recovery would otherwise break the
 *    correlation key and a second crash before the REMOTE_CREATED persist
 *    could re-POST a duplicate.  The ordinary title sync reconciles the
 *    rename; completed comes from the same-round Google child (reparent is
 *    title+completed on the MS side; Google notes are untouched).
 *  - >=1 matches: ambiguous (our orphan vs a pre-existing user item) => park
 *    UNCERTAIN: never adopt, never POST (a duplicate), never delete.
 *  - No journaled title: cannot correlate => park UNCERTAIN (wiring request:
 *    journal the title at PREPARED write time).
 * A thrown POST is an ambiguous outcome (it may have landed server-side) =>
 * park, never blind-retry.  REMOTE_CREATED is persisted (with the new id)
 * BEFORE any old-parent write, then the same-round snapshot refresh registers
 * the created item (S6) so the rebind/verify below and the ordinary M->G
 * adoption loop see it in this round. */
function subtaskMoveCompleteReparentCreate_(state, snap, row, oldRec, kind, options, result) {
  var title = typeof row.title === 'string' ? row.title : '';
  if (!title) return subtaskMoveParkUncertain_(state, row, options, result);
  var target = subtaskMoveNewParentItems_(state, snap, kind, options, result);
  if (target.deferred) return { deferred: true };
  if (subtaskMoveCountTitleMatches_(target.items, title) > 0) {
    return subtaskMoveParkUncertain_(state, row, options, result);
  }
  var gTask = snap.gTasksById && snap.gTasksById[row.gChildId];
  var completed = !!(gTask && gTask.status === 'completed');
  var created = null;
  try {
    created = createMsChecklistItemNoRetry_(target.newRec.msListId, target.newRec.msId, title, completed);
  } catch (error) {
    return subtaskMoveParkUncertain_(state, row, options, result);
  }
  if (!created || typeof created.id !== 'string' || !created.id) {
    return subtaskMoveParkUncertain_(state, row, options, result);
  }
  result.created += 1;
  row.nextMsChecklistId = created.id;
  row.phase = SUBTASK_MOVE_PHASES_.REMOTE_CREATED;
  /* Ordering invariant: the REMOTE_CREATED persist lands before anything
   * touches the old parent. */
  subtaskPersist_(state, options);
  if (snap.msChecklistItemsByParentId &&
      Array.isArray(snap.msChecklistItemsByParentId[target.newRec.msId])) {
    snap.msChecklistItemsByParentId[target.newRec.msId].push({
      id: created.id, displayName: title, isChecked: completed === true
    });
  }
  return { advanced: true };
}

/* Local rebind, persisted BEFORE any old-item delete (S9 ordering invariant):
 * tombstone the old checklist id (so its coming disappearance is never
 * misread as a user deletion and the M->G adoption loop cannot re-adopt it)
 * and release or rebind the checklist mapping.  Zero remote writes. */
function subtaskMoveRebind_(state, snap, row, oldRec, kind, options, result) {
  var sub = subtaskEnsureNamespace_(state);
  var mapping = sub.mappings[row.gChildId];
  if (mapping) {
    subtaskWriteTombstones_(state, {
      gChildId: null,
      msChecklistId: row.msChecklistId,
      gParentId: row.gParentId,
      parentMsId: oldRec.msId,
      parentMsListId: oldRec.msListId
    }, options && options.now);
    if (kind.kind === 'UNNEST') {
      delete sub.mappings[row.gChildId];
    } else {
      var newRec = state.g2m && state.g2m[kind.newGParentId];
      mapping.gParentId = kind.newGParentId;
      mapping.msChecklistId = row.nextMsChecklistId;
      mapping.parentMsId = newRec.msId;
      mapping.parentMsListId = newRec.msListId;
      /* base (title/completed) carries over unchanged: the checklist item
       * keeps projecting the same shared fields. */
    }
  }
  row.phase = SUBTASK_MOVE_PHASES_.REBIND_PERSISTED;
  subtaskPersist_(state, options);
  result.rebinds += 1;
  return { advanced: true };
}

/* Verify the new MS object actually exists before anything destructive.
 * UNNEST: the round snapshot's MS task inventory for the target list.
 * REPARENT: a COMPLETE checklist observation of the NEW MS parent.
 * ABSENT parks UNCERTAIN (never recreate, never dereference); UNKNOWN defers. */
function subtaskMoveNewObject_(state, snap, row, kind, options, result) {
  if (kind.kind === 'UNNEST') {
    var inventoried = snap && snap.msTaskInventoryListIds && snap.msTaskInventoryListIds[kind.msListId];
    if (!inventoried) { result.deferred += 1; return { deferred: true }; }
    if (snap.msTasksById && snap.msTasksById[row.nextMsChecklistId]) return { present: true };
    return { absent: true };
  }
  var newRec = state.g2m && state.g2m[kind.newGParentId];
  if (!newRec || !newRec.msId) return { absent: true };
  if (!subtaskObservationComplete_(state, snap, newRec.msId, options && options.roundId)) {
    result.deferred += 1;
    return { deferred: true };
  }
  if (subtaskFindChecklist_(subtaskObservationItems_(snap, newRec.msId), row.nextMsChecklistId)) return { present: true };
  return { absent: true };
}

/* Idempotent old-item delete.  A 404 is the crash-safe success path (the
 * delete already happened before a crash).  A non-404 failure leaves the phase
 * unchanged so the next round retries — a DELETE carries no create ambiguity.
 * Gated by the operator-wide deletion switch like every other deletion. */
function subtaskMoveDeleteOldItem_(state, snap, row, oldRec, options, result) {
  if (!subtaskDeletionsAllowed_(options, snap)) {
    result.paused += 1;
    return { paused: true };
  }
  try {
    deleteMsChecklistItemNoRetry_(oldRec.msListId, oldRec.msId, row.msChecklistId);
    result.deleted += 1;
  } catch (error) {
    if (!(typeof isNotFoundError_ === 'function' && isNotFoundError_(error))) {
      result.deferred += 1;
      return { deferred: true };
    }
    /* notFound: already gone — proceed. */
  }
  row.phase = SUBTASK_MOVE_PHASES_.OLD_DELETE_PENDING;
  subtaskPersist_(state, options);
  return { advanced: true };
}

/* OLD_DELETE_PENDING finalize.  Only a COMPLETE fresh observation of the old
 * MS parent may retire the row.  For an unnest the ordinary pairing is written
 * in the SAME persist that deletes the journal row: the row and its g2m key
 * may never coexist (state.gs ownership cross-check), and the row must be gone
 * before the ordinary engine can pair the (now top-level) Google task. */
function subtaskMoveFinalize_(state, snap, key, row, oldRec, kind, options, result) {
  if (!subtaskObservationComplete_(state, snap, oldRec.msId, options && options.roundId)) {
    result.deferred += 1;
    return { deferred: true };
  }
  if (subtaskFindChecklist_(subtaskObservationItems_(snap, oldRec.msId), row.msChecklistId)) {
    /* Still visible: re-issue the idempotent (gated) delete; finalize next
     * round once a fresh observation proves the absence. */
    subtaskMoveDeleteOldItem_(state, snap, row, oldRec, options, result);
    return { advanced: true };
  }
  if (kind.kind === 'UNNEST') {
    var gListId = snap && snap.gListByTask && snap.gListByTask[row.gChildId];
    if (!gListId || !row.nextMsChecklistId) { result.deferred += 1; return { deferred: true }; }
    /* Defensive rebind completion: a row that arrived at OLD_DELETE_PENDING
     * with the checklist mapping still present would otherwise collide with
     * the new g2m key in the SAME persist (state.gs ownership cross-check
     * refuses a subtask gChildId that overlaps ordinary g2m — the whole state
     * would fail its next normalize).  Release the mapping and reserve the
     * old checklist id first; the tombstone is idempotent. */
    if (state.subtasks.mappings[row.gChildId]) {
      subtaskMoveRebind_(state, snap, row, oldRec, kind, options, result);
    }
    state.g2m[row.gChildId] = { msId: row.nextMsChecklistId, gListId: gListId, msListId: oldRec.msListId };
  }
  delete state.subtasks.moveJournal[key];
  subtaskPersist_(state, options);
  result.finalized += 1;
  return { finalized: true };
}

function subtaskMoveHoldReparent_(state, row, result, gTask) {
  var lostFields = [];
  if (gTask.notes !== undefined && gTask.notes !== null && String(gTask.notes) !== '') lostFields.push('notes');
  if (gTask.due !== undefined && gTask.due !== null && String(gTask.due) !== '') lostFields.push('due');
  result.held += 1;
  lostFields.forEach(function(field) {
    if (result.heldFields.indexOf(field) < 0) result.heldFields.push(field);
  });
  return { held: true };
}

function subtaskMoveProcessRow_(state, snap, key, row, options, result) {
  if (row.phase === SUBTASK_MOVE_PHASES_.UNCERTAIN) {
    /* Fail-closed park: zero POST/PATCH/DELETE, row preserved (supplemental
     * rulings §3); resolution needs observation/operator disambiguation. */
    result.uncertain += 1;
    return;
  }
  var kind = subtaskMoveKind_(snap, row);
  if (kind.kind === 'DEFER') { result.deferred += 1; return; }
  if (kind.kind === 'STALE') { result.deferred += 1; return; }
  if (kind.kind === 'MISSING_CHILD') {
    /* Never fabricate deletion evidence and never dereference the missing id
     * (S4): park the row untouched-remotely. */
    subtaskMoveParkUncertain_(state, row, options, result);
    return;
  }
  var oldRec = subtaskMoveOldParentRec_(state, row);
  if (!oldRec) {
    subtaskMoveParkUncertain_(state, row, options, result);
    return;
  }
  kind.msListId = oldRec.msListId;
  if (row.phase === SUBTASK_MOVE_PHASES_.PREPARED) {
    if (kind.kind === 'UNNEST') {
      var step = subtaskMoveCreateTopLevelTask_(state, snap, row, oldRec, options, result);
      if (!step.advanced) return;
    } else {
      /* REPARENT PREPARED: metadata gate first (S5).  A clean child then
       * completes the create leg by exact-title correlation: 0 exact matches
       * on a COMPLETE new-parent observation proves the POST never landed, so
       * it is re-issued exactly once; any match is ambiguous and parks
       * fail-closed (2026-11-17 reparent ruling, supplemental §C1). */
      var gTask = snap.gTasksById && snap.gTasksById[row.gChildId];
      var notesEmpty = !gTask || gTask.notes === undefined || gTask.notes === null || String(gTask.notes) === '';
      var dueEmpty = !gTask || gTask.due === undefined || gTask.due === null || String(gTask.due) === '';
      if (!notesEmpty || !dueEmpty) {
        subtaskMoveHoldReparent_(state, row, result, gTask);
        return;
      }
      var step = subtaskMoveCompleteReparentCreate_(state, snap, row, oldRec, kind, options, result);
      if (!step.advanced) return;
    }
  }
  if (row.phase === SUBTASK_MOVE_PHASES_.REMOTE_CREATED) {
    if (!row.nextMsChecklistId) {
      subtaskMoveParkUncertain_(state, row, options, result);
      return;
    }
    var observed = subtaskMoveNewObject_(state, snap, row, kind, options, result);
    if (!observed.present) return;
    subtaskMoveRebind_(state, snap, row, oldRec, kind, options, result);
  }
  if (row.phase === SUBTASK_MOVE_PHASES_.REBIND_PERSISTED) {
    var del = subtaskMoveDeleteOldItem_(state, snap, row, oldRec, options, result);
    if (!del.advanced) return;
  }
  if (row.phase === SUBTASK_MOVE_PHASES_.OLD_DELETE_PENDING) {
    subtaskMoveFinalize_(state, snap, key, row, oldRec, kind, options, result);
  }
}

/* Entry seam.  Called at the very front of reconcileSubtasks_, before
 * tombstone cleanup and every other journal recovery, and above all before
 * deletion observation (S9).  Returns a bounded stats record. */
function subtaskMoveRecovery_(state, snap, options) {
  options = options || {};
  var sub = subtaskEnsureNamespace_(state);
  var result = { total: 0, created: 0, rebinds: 0, deleted: 0, finalized: 0, uncertain: 0, held: 0, deferred: 0, paused: 0, blocked: 0, heldFields: [] };
  var keys = Object.keys(sub.moveJournal || {}).sort();
  keys.forEach(function(key) {
    var row = sub.moveJournal[key];
    if (!row) return;
    result.total += 1;
    if (!subtaskMoveRowValid_(row)) { result.blocked += 1; return; }
    subtaskMoveProcessRow_(state, snap, key, row, options, result);
  });
  if (result.total) {
    console.log('[SubtaskMove] recovery: ' + JSON.stringify(result));
  }
  return result;
}
