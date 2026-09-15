/* Phase 2A.6: crash-safe, one-level Google child/checklist sync.
 *
 * This module intentionally has no relationship to ordinary task payloads.
 * Checklist writes use their own no-retry provider seams and only the shared
 * title/completion fields are projected.  The feature is opt-in at the call
 * site; journals remain ownership reservations while it is disabled.
 */

var SUBTASK_CREATE_PHASES_ = Object.freeze({ PREPARED: 'PREPARED', REMOTE_CREATED: 'REMOTE_CREATED', UNCERTAIN: 'UNCERTAIN' });
var SUBTASK_UPDATE_PHASES_ = Object.freeze({ PREPARED: 'PREPARED', UNCERTAIN: 'UNCERTAIN' });
var SUBTASK_DELETE_PHASES_ = Object.freeze({ PREPARED: 'PREPARED', REMOTE_DELETED: 'REMOTE_DELETED', UNCERTAIN: 'UNCERTAIN' });
/* Deliberately conservative static per-round ceiling on checklist collection
 * reads. This is NOT the outcome of the CT-05 measurement lab: it is a safe
 * starting bound that keeps one round well inside the Apps Script time budget.
 * Spec §25 forbids presenting an unmeasured ceiling as measured, so the status
 * is reported honestly instead of claiming MEASURED. */
var SUBTASK_DISCOVERY_MAX_PARENTS_ = 10;
var SUBTASK_BOUNDED_REASONS_ = Object.freeze([
  'SUBTASK_STRUCTURAL_QUARANTINE', 'SUBTASK_BASE_INVALID', 'SUBTASK_TITLE_CONFLICT',
  'SUBTASK_COMPLETION_CONFLICT', 'SUBTASK_DELETE_EDIT_CONFLICT', 'SUBTASK_ABANDONED',
  'AMBIGUOUS_PARENT_LOSS_GOOGLE', 'AMBIGUOUS_PARENT_LOSS_MICROSOFT',
  'SUBTASK_REMOTE_PARENT_MISMATCH', 'SUBTASK_REMOTE_PROJECTION_MISMATCH'
]);

function subtaskDiscoveryPolicy_() {
  return {
    architecture: 'BOUNDED_DIRECT_GET',
    budgetStatus: 'STATIC_CONSERVATIVE',
    maxParents: SUBTASK_DISCOVERY_MAX_PARENTS_
  };
}

function subtaskCanonicalTitle_(value) {
  if (value === null || value === undefined) return null;
  var title = String(value).trim();
  return title ? title : null;
}

function subtaskCanonicalGoogle_(task) {
  var title = subtaskCanonicalTitle_(task && task.title);
  var status = task && task.status;
  if (!title || (status !== 'needsAction' && status !== 'completed')) return null;
  return { title: title, completed: status === 'completed' };
}

function subtaskCanonicalMicrosoft_(item) {
  var title = subtaskCanonicalTitle_(item && (item.displayName === undefined ? item.title : item.displayName));
  if (!title || !item || typeof item.isChecked !== 'boolean') return null;
  return { title: title, completed: item.isChecked === true };
}

function subtaskCanonicalField_(snapshot, field) {
  return field === 'title' ? snapshot.title : snapshot.completed;
}

function subtaskThreeWayField_(base, source, target) {
  var sourceChanged = source !== base, targetChanged = target !== base;
  if (!sourceChanged && !targetChanged) return { action: 'NOOP', value: base };
  if (sourceChanged && !targetChanged) return { action: 'ONE_SIDE', source: 'SOURCE', desired: source };
  if (!sourceChanged && targetChanged) return { action: 'ONE_SIDE', source: 'TARGET', desired: target };
  if (source === target) return { action: 'ADVANCE_BASE', value: source };
  return { action: 'CONFLICT', base: base, source: source, target: target };
}

function subtaskMappingBase_(mapping, googleTask, msItem) {
  if (mapping && mapping.base && typeof mapping.base === 'object' &&
      typeof mapping.base.title === 'string' && typeof mapping.base.completed === 'boolean') {
    return { title: mapping.base.title, completed: mapping.base.completed };
  }
  /* Read old development records without silently writing them as a new
   * mapping.  A caller can provide an explicit base when adopting one. */
  if (mapping && typeof mapping.baseTitleCanonicalHash === 'string' &&
      typeof mapping.baseCompleted === 'boolean') return null;
  return null;
}

function subtaskEnsureNamespace_(state) {
  if (!state || !state.subtasks || typeof state.subtasks !== 'object') throw new Error('SUBTASK_STATE_MISSING');
  ['mappings', 'parents', 'createJournal', 'pendingDeletions', 'deletionJournal', 'moveJournal', 'conflicts'].forEach(function(name) {
    if (!state.subtasks[name] || typeof state.subtasks[name] !== 'object' || Array.isArray(state.subtasks[name])) {
      state.subtasks[name] = {};
    }
  });
  if (!state.subtasks.tombstones || typeof state.subtasks.tombstones !== 'object' || Array.isArray(state.subtasks.tombstones)) {
    state.subtasks.tombstones = { g: {}, ms: {} };
  }
  if (!state.subtasks.tombstones.g || typeof state.subtasks.tombstones.g !== 'object') state.subtasks.tombstones.g = {};
  if (!state.subtasks.tombstones.ms || typeof state.subtasks.tombstones.ms !== 'object') state.subtasks.tombstones.ms = {};
  return state.subtasks;
}

/* The released v4 namespace is frozen.  Until a future schema revision can
 * add a named update table, per-field intents live in createJournal under a
 * distinct `u:` key; the strict record allowlist covers the same fields. */
function subtaskUpdateTable_(sub) { return sub.updateJournal || sub.createJournal; }

function subtaskPersist_(state, options) {
  if (options && typeof options.persist === 'function') return options.persist(state);
  if (typeof persistSyncState_ === 'function') return persistSyncState_(state);
  return null;
}

function subtaskJournalKey_(gChildId, field) { return 'u:' + String(gChildId) + ':' + String(field); }

function subtaskPrepareCreate_(state, details, options) {
  var sub = subtaskEnsureNamespace_(state);
  var key = details.key || details.gChildId || details.msChecklistId;
  if (!key) throw new Error('SUBTASK_CREATE_ID_REQUIRED');
  var intended = details.intended || {};
  if (!subtaskCanonicalTitle_(intended.title) || typeof intended.completed !== 'boolean') {
    throw new Error('SUBTASK_CANONICAL_EMPTY');
  }
  var row = {
    phase: SUBTASK_CREATE_PHASES_.PREPARED,
    gChildId: details.gChildId,
    msChecklistId: details.msChecklistId,
    gParentId: details.gParentId,
    parentMsId: details.parentMsId,
    parentMsListId: details.parentMsListId,
    intended: { title: subtaskCanonicalTitle_(intended.title), completed: intended.completed === true },
    at: details.at || new Date().toISOString()
  };
  sub.createJournal[key] = row;
  subtaskPersist_(state, options);
  return key;
}

function subtaskMarkCreateRemote_(state, key, remoteId, options) {
  if (typeof remoteId !== 'string' || !remoteId) throw new Error('SUBTASK_REMOTE_ID_INVALID');
  var row = subtaskEnsureNamespace_(state).createJournal[key];
  if (!row || row.phase !== SUBTASK_CREATE_PHASES_.PREPARED) throw new Error('SUBTASK_CREATE_JOURNAL_MISSING');
  row.phase = SUBTASK_CREATE_PHASES_.REMOTE_CREATED;
  if (!row.msChecklistId) row.msChecklistId = remoteId;
  if (!row.gChildId) row.gChildId = remoteId;
  subtaskPersist_(state, options);
  return row;
}

function subtaskMarkCreateUncertain_(state, key, options) {
  var row = subtaskEnsureNamespace_(state).createJournal[key];
  if (!row) return null;
  row.phase = SUBTASK_CREATE_PHASES_.UNCERTAIN;
  subtaskPersist_(state, options);
  return row;
}

function subtaskObservationItems_(snap, parentMsId) {
  var groups = snap && (snap.msChecklistItemsByParentId || snap.itemsByMsParentId ||
    snap.checklistItemsByMsParentId || snap.checklistItemsByParentId);
  if (!groups || !Object.prototype.hasOwnProperty.call(groups, parentMsId)) return null;
  var value = groups[parentMsId];
  if (value && !Array.isArray(value) && Array.isArray(value.items)) value = value.items;
  return Array.isArray(value) ? value : null;
}

function subtaskObservationComplete_(state, snap, parentMsId, roundId) {
  if (snap && snap.subtaskCompleteObservation === false) return false;
  var explicit = snap && (snap.checklistObservationCompleteByParentId || snap.completeChecklistParents);
  if (explicit && Object.prototype.hasOwnProperty.call(explicit, parentMsId) && explicit[parentMsId] !== true) return false;
  var items = subtaskObservationItems_(snap, parentMsId);
  if (!items) return false;
  if (roundId && state && state.subtasks && state.subtasks.parents && state.subtasks.parents[parentMsId]) {
    return state.subtasks.parents[parentMsId].lastObservedRoundId === roundId;
  }
  return true;
}

function subtaskFindChecklist_(items, id) {
  if (!Array.isArray(items)) return null;
  var hit = null;
  items.forEach(function(item) { if (item && item.id === id) hit = hit || item; });
  return hit;
}

function subtaskParentIdentityOk_(mapping, gChild, gListId, expectedGListId) {
  if (!mapping || !gChild || gChild.parent !== mapping.gParentId) return false;
  if (expectedGListId && gListId && expectedGListId !== gListId) return false;
  return true;
}

function subtaskQuarantine_(state, gChildId, mapping, reason, options) {
  var sub = subtaskEnsureNamespace_(state);
  sub.conflicts[gChildId] = {
    gChildId: gChildId,
    msChecklistId: mapping && mapping.msChecklistId || '',
    gParentId: mapping && mapping.gParentId || '',
    reason: reason || 'SUBTASK_STRUCTURAL_QUARANTINE'
  };
  if (options && options.persist) subtaskPersist_(state, options);
}

function subtaskCommitCreate_(state, key, remoteId, base, details, options) {
  var sub = subtaskEnsureNamespace_(state), row = sub.createJournal[key];
  if (!row || row.phase !== SUBTASK_CREATE_PHASES_.REMOTE_CREATED) throw new Error('SUBTASK_CREATE_NOT_REMOTE_CREATED');
  if (typeof remoteId !== 'string' || !remoteId || !base || !base.title) throw new Error('SUBTASK_CREATE_FINALIZE_INVALID');
  var priorMapping = sub.mappings[row.gChildId];
  var priorJournal = JSON.parse(JSON.stringify(row));
  sub.mappings[row.gChildId] = {
    gParentId: row.gParentId,
    msChecklistId: row.msChecklistId || remoteId,
    parentMsId: row.parentMsId || '',
    parentMsListId: row.parentMsListId || '',
    base: { title: subtaskCanonicalTitle_(base.title), completed: base.completed === true }
  };
  delete sub.createJournal[key];
  try {
    subtaskPersist_(state, options);
  } catch (error) {
    if (priorMapping === undefined) delete sub.mappings[row.gChildId];
    else sub.mappings[row.gChildId] = priorMapping;
    sub.createJournal[key] = priorJournal;
    throw error;
  }
  return sub.mappings[row.gChildId];
}

function subtaskCreateRemoteMismatch_(state, key, reason, options) {
  var sub = subtaskEnsureNamespace_(state), row = sub.createJournal[key];
  if (!row) return;
  sub.conflicts[key] = {
    gChildId: row.gChildId,
    msChecklistId: row.msChecklistId,
    gParentId: row.gParentId,
    reason: reason
  };
  subtaskPersist_(state, options);
}

function subtaskUpdateResponseMatches_(sourceGoogle, field, response, desired) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  var value;
  if (sourceGoogle) {
    if (field === 'title') {
      if (typeof response.displayName !== 'string') return false;
      value = subtaskCanonicalTitle_(response.displayName);
    } else {
      if (typeof response.isChecked !== 'boolean') return false;
      value = response.isChecked;
    }
  } else if (field === 'title') {
    if (typeof response.title !== 'string') return false;
    value = subtaskCanonicalTitle_(response.title);
  } else {
    if (response.status !== 'needsAction' && response.status !== 'completed') return false;
    value = response.status === 'completed';
  }
  return value === desired;
}

function subtaskRecoverCreateJournals_(state, snap, options) {
  var sub = subtaskEnsureNamespace_(state), result = { finalized: 0, uncertain: 0 };
  Object.keys(sub.createJournal).sort().forEach(function(key) {
    var row = sub.createJournal[key];
    if (!row || row.phase === SUBTASK_CREATE_PHASES_.UNCERTAIN) return;
    if (row.phase === SUBTASK_CREATE_PHASES_.PREPARED) {
      row.phase = SUBTASK_CREATE_PHASES_.UNCERTAIN;
      result.uncertain += 1;
      subtaskPersist_(state, options);
      return;
    }
    if (row.phase !== SUBTASK_CREATE_PHASES_.REMOTE_CREATED || !row.msChecklistId || !row.gChildId) return;
    var items = subtaskObservationItems_(snap, row.parentMsId);
    if (!subtaskObservationComplete_(state, snap, row.parentMsId, options && options.roundId)) return;
    var item = subtaskFindChecklist_(items, row.msChecklistId);
    var g = snap && snap.gTasksById && snap.gTasksById[row.gChildId];
    if (!item || !g || g.parent !== row.gParentId) return;
    var gb = subtaskCanonicalGoogle_(g), mb = subtaskCanonicalMicrosoft_(item);
    if (!gb || !mb || gb.title !== mb.title || gb.completed !== mb.completed) return;
    subtaskCommitCreate_(state, key, row.msChecklistId, gb, row, options);
    result.finalized += 1;
  });
  return result;
}

function subtaskUpdateIntent_(state, details, options) {
  var sub = subtaskEnsureNamespace_(state);
  var key = subtaskJournalKey_(details.gChildId, details.field);
  subtaskUpdateTable_(sub)[key] = {
    phase: SUBTASK_UPDATE_PHASES_.PREPARED,
    gChildId: details.gChildId,
    msChecklistId: details.msChecklistId,
    gParentId: details.gParentId,
    parentMsId: details.parentMsId,
    field: details.field,
    base: details.base,
    source: details.source,
    target: details.target,
    desired: details.desired,
    at: details.at || new Date().toISOString()
  };
  subtaskPersist_(state, options);
  return key;
}

function subtaskRecoverUpdateIntents_(state, snap, options) {
  var sub = subtaskEnsureNamespace_(state), updates = subtaskUpdateTable_(sub), result = { resolved: 0, uncertain: 0 };
  Object.keys(updates).filter(function(key) { return key.indexOf('u:') === 0; }).sort().forEach(function(key) {
    var row = updates[key];
    if (!row || row.phase !== SUBTASK_UPDATE_PHASES_.UNCERTAIN) return;
    if (!subtaskObservationComplete_(state, snap, row.parentMsId, options && options.roundId)) return;
    var g = snap && snap.gTasksById && snap.gTasksById[row.gChildId];
    var item = subtaskFindChecklist_(subtaskObservationItems_(snap, row.parentMsId), row.msChecklistId);
    var gs = subtaskCanonicalGoogle_(g), ms = subtaskCanonicalMicrosoft_(item);
    if (!gs || !ms) return;
    var source = row.source === 'GOOGLE' ? subtaskCanonicalField_(gs, row.field) : subtaskCanonicalField_(ms, row.field);
    var target = row.source === 'GOOGLE' ? subtaskCanonicalField_(ms, row.field) : subtaskCanonicalField_(gs, row.field);
    var desired = row.desired;
    var mapping = sub.mappings[row.gChildId];
    if (target === desired || source === target) {
      if (mapping && mapping.base) mapping.base[row.field] = target;
      delete updates[key];
      result.resolved += 1;
      subtaskPersist_(state, options);
    } else {
      row.phase = SUBTASK_UPDATE_PHASES_.UNCERTAIN;
      result.uncertain += 1;
    }
  });
  return result;
}

function subtaskCreateGoogleToMicrosoft_(state, snap, task, parent, options) {
  var gId = task.id, key = 'g:' + gId;
  var base = subtaskCanonicalGoogle_(task);
  if (!base) return { skipped: 'EMPTY_TITLE' };
  var row = subtaskEnsureNamespace_(state).createJournal[key];
  if (row) return { skipped: 'JOURNAL_RESERVED' };
  subtaskPrepareCreate_(state, { key: key, gChildId: gId, gParentId: parent.gParentId,
    parentMsId: parent.msParentId, parentMsListId: parent.msListId, intended: base }, options);
  try {
    var created = createMsChecklistItemNoRetry_(parent.msListId, parent.msParentId, base.title, base.completed);
    if (!created || typeof created.id !== 'string' || !created.id) throw new Error('SUBTASK_REMOTE_ID_INVALID');
    subtaskMarkCreateRemote_(state, key, created.id, options);
    if ((created.parentId && created.parentId !== parent.msParentId) ||
        (created.parent && created.parent !== parent.msParentId)) {
      subtaskCreateRemoteMismatch_(state, key, 'SUBTASK_REMOTE_PARENT_MISMATCH', options);
      return { skipped: 'SUBTASK_REMOTE_PARENT_MISMATCH' };
    }
    var projected = subtaskCanonicalMicrosoft_(created);
    if (!projected || projected.title !== base.title || projected.completed !== base.completed) {
      subtaskCreateRemoteMismatch_(state, key, 'SUBTASK_REMOTE_PROJECTION_MISMATCH', options);
      return { skipped: 'SUBTASK_REMOTE_PROJECTION_MISMATCH' };
    }
    subtaskCommitCreate_(state, key, created.id, projected, {}, options);
    return { created: true, id: created.id };
  } catch (error) {
    var current = subtaskEnsureNamespace_(state).createJournal[key];
    if (current && current.phase === SUBTASK_CREATE_PHASES_.PREPARED) subtaskMarkCreateUncertain_(state, key, options);
    return { skipped: String(error && error.message || error) };
  }
}

function subtaskCreateMicrosoftToGoogle_(state, snap, item, parent, options) {
  var base = subtaskCanonicalMicrosoft_(item);
  if (!base) return { skipped: 'EMPTY_TITLE' };
  var key = 'ms:' + item.id;
  if (subtaskEnsureNamespace_(state).createJournal[key]) return { skipped: 'JOURNAL_RESERVED' };
  subtaskPrepareCreate_(state, { key: key, msChecklistId: item.id, gParentId: parent.gParentId,
    parentMsId: parent.msParentId, parentMsListId: parent.msListId, intended: base }, options);
  try {
    var created = createGChecklistChildNoRetry_(parent.gListId, parent.gParentId, base.title,
      base.completed ? 'completed' : 'needsAction');
    if (!created || typeof created.id !== 'string' || !created.id) throw new Error('SUBTASK_REMOTE_ID_INVALID');
    subtaskEnsureNamespace_(state).createJournal[key].gChildId = created.id;
    subtaskMarkCreateRemote_(state, key, created.id, options);
    if (created.parent && created.parent !== parent.gParentId) {
      subtaskCreateRemoteMismatch_(state, key, 'SUBTASK_REMOTE_PARENT_MISMATCH', options);
      return { skipped: 'SUBTASK_REMOTE_PARENT_MISMATCH' };
    }
    var projected = subtaskCanonicalGoogle_(created);
    if (!projected || projected.title !== base.title || projected.completed !== base.completed) {
      subtaskCreateRemoteMismatch_(state, key, 'SUBTASK_REMOTE_PROJECTION_MISMATCH', options);
      return { skipped: 'SUBTASK_REMOTE_PROJECTION_MISMATCH' };
    }
    subtaskCommitCreate_(state, key, created.id, projected, {}, options);
    return { created: true, id: created.id };
  } catch (error) {
    var current = subtaskEnsureNamespace_(state).createJournal[key];
    if (current && current.phase === SUBTASK_CREATE_PHASES_.PREPARED) subtaskMarkCreateUncertain_(state, key, options);
    return { skipped: String(error && error.message || error) };
  }
}

function subtaskUpdateMapped_(state, snap, gId, mapping, gTask, msItem, parent, options) {
  if (!msItem) return { skipped: 'MISSING_COUNTERPART' };
  if (!subtaskParentIdentityOk_(mapping, gTask, snap.gListByTask && snap.gListByTask[gId], parent.gListId) ||
      (msItem.parentId && msItem.parentId !== parent.msParentId)) {
    subtaskQuarantine_(state, gId, mapping, 'SUBTASK_STRUCTURAL_QUARANTINE', options);
    return { quarantined: true };
  }
  var gb = subtaskCanonicalGoogle_(gTask), mb = subtaskCanonicalMicrosoft_(msItem), base = subtaskMappingBase_(mapping);
  if (!gb || !mb || !base) { subtaskQuarantine_(state, gId, mapping, 'SUBTASK_BASE_INVALID', options); return { quarantined: true }; }
  var result = { writes: 0, conflicts: 0, baseAdvanced: false, patchAttempted: false };
  ['title', 'completed'].forEach(function(field) {
    if (result.patchAttempted) return;
    var merge = subtaskThreeWayField_(subtaskCanonicalField_(base, field),
      subtaskCanonicalField_(gb, field), subtaskCanonicalField_(mb, field));
    if (merge.action === 'CONFLICT') {
      subtaskQuarantine_(state, gId, mapping, field === 'title' ? 'SUBTASK_TITLE_CONFLICT' : 'SUBTASK_COMPLETION_CONFLICT', options);
      result.conflicts += 1;
      return;
    }
    if (merge.action === 'ADVANCE_BASE') { mapping.base[field] = merge.value; result.baseAdvanced = true; return; }
    if (merge.action !== 'ONE_SIDE') return;
    var sourceGoogle = subtaskCanonicalField_(gb, field) !== subtaskCanonicalField_(base, field);
    var desired = merge.desired;
    var updateKey = subtaskUpdateIntent_(state, { gChildId: gId, msChecklistId: mapping.msChecklistId,
      gParentId: mapping.gParentId, parentMsId: parent.msParentId, field: field,
      base: subtaskCanonicalField_(base, field), source: sourceGoogle ? 'GOOGLE' : 'MICROSOFT',
      target: sourceGoogle ? subtaskCanonicalField_(mb, field) : subtaskCanonicalField_(gb, field), desired: desired }, options);
    try {
      var patch;
      if (sourceGoogle) patch = field === 'title' ? { displayName: desired } : { isChecked: desired === true };
      else patch = field === 'title' ? { title: desired } : { status: desired === true ? 'completed' : 'needsAction' };
      result.patchAttempted = true;
      var response = sourceGoogle
        ? updateMsChecklistItemNoRetry_(parent.msListId, parent.msParentId, mapping.msChecklistId, patch)
        : updateGChecklistChildNoRetry_(parent.gListId, gId, patch);
      if (!subtaskUpdateResponseMatches_(sourceGoogle, field, response, desired)) {
        subtaskUpdateTable_(state.subtasks)[updateKey].phase = SUBTASK_UPDATE_PHASES_.UNCERTAIN;
        try { subtaskPersist_(state, options); } catch (ignored) {}
        return;
      }
      mapping.base[field] = desired;
      delete subtaskUpdateTable_(state.subtasks)[updateKey];
      try {
        subtaskPersist_(state, options);
      } catch (persistError) {
        /* The remote PATCH was acknowledged but the final local commit was
         * not. Restore the old BASE and reconstruct the intent as UNCERTAIN;
         * the next fresh observation may resolve it without another write. */
        mapping.base[field] = subtaskCanonicalField_(base, field);
        subtaskUpdateTable_(state.subtasks)[updateKey] = {
          phase: SUBTASK_UPDATE_PHASES_.UNCERTAIN,
          gChildId: gId, msChecklistId: mapping.msChecklistId, gParentId: mapping.gParentId,
          parentMsId: parent.msParentId, field: field, base: mapping.base[field],
          source: sourceGoogle ? 'GOOGLE' : 'MICROSOFT',
          target: sourceGoogle ? subtaskCanonicalField_(mb, field) : subtaskCanonicalField_(gb, field),
          desired: desired, at: new Date().toISOString()
        };
        return;
      }
      result.writes += 1;
    } catch (error) {
      var intent = subtaskUpdateTable_(state.subtasks)[updateKey];
      if (intent) intent.phase = SUBTASK_UPDATE_PHASES_.UNCERTAIN;
      try { subtaskPersist_(state, options); } catch (ignored) {}
    }
  });
  if (result.baseAdvanced && !result.writes) subtaskPersist_(state, options);
  return result;
}

function subtaskGoogleInventoryComplete_(snap) {
  if (!snap) return false;
  if (snap.googleInventoryComplete === false) return false;
  if (snap.inventoryComplete === true || snap.googleInventoryComplete === true) return true;
  return false;
}

function subtaskBoundedReason_(reason) {
  var code = String(reason || '');
  return SUBTASK_BOUNDED_REASONS_.indexOf(code) >= 0 ? code : 'OTHER';
}

function subtaskTombstoneMicrosoftKey_(parentMsId, msChecklistId) {
  return JSON.stringify({ msParentId: String(parentMsId || ''), msChecklistId: String(msChecklistId || '') });
}

function subtaskHasTombstone_(state, gChildId, parentMsId, msChecklistId) {
  var stones = state && state.subtasks && state.subtasks.tombstones;
  if (!stones) return false;
  if (gChildId && stones.g && stones.g[gChildId]) return true;
  if (msChecklistId && stones.ms && stones.ms[subtaskTombstoneMicrosoftKey_(parentMsId, msChecklistId)]) return true;
  return false;
}

function subtaskCleanupTombstones_(state, now) {
  if (typeof cleanupTombstones_ === 'function') {
    cleanupTombstones_(state, now);
    return;
  }
  var cutoff = (now === undefined ? Date.now() : now) - TOMBSTONE_TTL_MS;
  var stones = state && state.subtasks && state.subtasks.tombstones;
  if (!stones) return;
  ['g', 'ms'].forEach(function(side) {
    Object.keys(stones[side] || {}).forEach(function(id) {
      if ((stones[side][id] && stones[side][id].at || 0) <= cutoff) delete stones[side][id];
    });
  });
}

function subtaskWriteTombstones_(state, mapping, now) {
  var sub = subtaskEnsureNamespace_(state);
  var at = now === undefined ? Date.now() : now;
  if (mapping.gChildId) sub.tombstones.g[mapping.gChildId] = { at: at, source: 'subtask-delete' };
  sub.tombstones.ms[subtaskTombstoneMicrosoftKey_(mapping.parentMsId, mapping.msChecklistId)] =
    { at: at, source: 'subtask-delete' };
}

function subtaskSurvivorBaseline_(canonical) {
  if (!canonical || !canonical.title) return '';
  return JSON.stringify({ title: canonical.title, completed: canonical.completed === true });
}

function subtaskResetPendingDeletion_(state, gChildId) {
  delete subtaskEnsureNamespace_(state).pendingDeletions[gChildId];
}

function subtaskResetMissingOnConflictResolve_(state, gChildId) {
  subtaskResetPendingDeletion_(state, gChildId);
  if (state.subtasks && state.subtasks.conflicts) delete state.subtasks.conflicts[gChildId];
}

/* Spec §32 Conflict Diagnostics: if the two providers later converge to
 * identical canonical shared state, auto-resolve the conflict, advance the
 * baseline and clear the record.  This is the SUBTASK half of that contract —
 * the ordinary (Step 3) path already re-derives conflicts every round.
 *
 * Scope guards (fail-closed):
 *  - Only semantic title/completion conflicts heal. Structural quarantine,
 *    invalid base and operator ABANDON stay manual (an operator deliberately
 *    excluded that pair; the engine must not un-exclude it).
 *  - Only a COMPLETE fresh observation may prove convergence; unobserved is
 *    never treated as aligned.
 *  - The heal performs ZERO remote writes (spec §29: a conflict never picks a
 *    winner).  It only advances the baseline to the converged meaning and
 *    resets deletion evidence per §31, so the next round resumes normally. */
function subtaskAttemptConflictSelfHeal_(state, snap, gId, parent, options) {
  var sub = subtaskEnsureNamespace_(state);
  var conflict = sub.conflicts[gId];
  if (!conflict) return false;
  if (conflict.reason !== 'SUBTASK_TITLE_CONFLICT' && conflict.reason !== 'SUBTASK_COMPLETION_CONFLICT') return false;
  var mapping = sub.mappings[gId];
  if (!mapping || !mapping.base || mapping.msChecklistId !== conflict.msChecklistId) return false;
  if (!subtaskObservationComplete_(state, snap, parent.msParentId, options && options.roundId)) return false;
  var gTask = snap && snap.gTasksById ? snap.gTasksById[gId] : null;
  var item = subtaskFindChecklist_(subtaskObservationItems_(snap, parent.msParentId), mapping.msChecklistId);
  var gb = subtaskCanonicalGoogle_(gTask), mb = subtaskCanonicalMicrosoft_(item);
  if (!gb || !mb) return false;
  if (gb.title !== mb.title || gb.completed !== mb.completed) return false;
  mapping.base = { title: gb.title, completed: gb.completed };
  subtaskResetMissingOnConflictResolve_(state, gId);
  try { subtaskPersist_(state, options); } catch (ignored) {}
  console.log('[SubtaskConflict] self-healed by provider convergence: ' + gId);
  return true;
}

function subtaskRecordMissingObservation_(state, details, options) {
  var sub = subtaskEnsureNamespace_(state);
  var gId = details.gChildId;
  if (!gId || !sub.mappings[gId]) return { unchanged: true, reason: 'no-mapping' };
  if (sub.conflicts[gId]) return { frozen: true, reason: 'active-conflict' };
  if (details.observationComplete !== true) return { unchanged: true, reason: 'incomplete-observation' };
  var mapping = sub.mappings[gId];
  var survivor = details.missingSide === 'MICROSOFT' ? subtaskCanonicalGoogle_(details.googleChild) :
    details.missingSide === 'GOOGLE' ? subtaskCanonicalMicrosoft_(details.msItem) : null;
  var baseline = survivor ? subtaskSurvivorBaseline_(survivor) :
    (mapping.base ? subtaskSurvivorBaseline_(mapping.base) : '');
  var cand = sub.pendingDeletions[gId];
  if (cand && cand.survivorSemanticBaseline && baseline && cand.survivorSemanticBaseline !== baseline &&
      ((details.missingSide === 'GOOGLE' && details.msItem) ||
       (details.missingSide === 'MICROSOFT' && details.googleChild))) {
    sub.conflicts[gId] = {
      gChildId: gId, msChecklistId: mapping.msChecklistId, gParentId: mapping.gParentId,
      reason: 'SUBTASK_DELETE_EDIT_CONFLICT'
    };
    subtaskPersist_(state, options);
    return { frozen: true, reason: 'SUBTASK_DELETE_EDIT_CONFLICT' };
  }
  if (!cand) {
    var pending = {
      gChildId: gId,
      msChecklistId: mapping.msChecklistId,
      gParentId: mapping.gParentId,
      missingSide: details.missingSide,
      missingStreak: 1,
      lastMissingObservationRound: details.roundId,
      firstMissingAt: details.at || new Date().toISOString(),
      survivorSemanticBaseline: baseline
    };
    if (mapping.parentMsId) pending.parentMsId = mapping.parentMsId;
    if (mapping.parentMsListId) pending.parentMsListId = mapping.parentMsListId;
    sub.pendingDeletions[gId] = pending;
    subtaskPersist_(state, options);
    return { missingStreak: 1 };
  }
  if (cand.lastMissingObservationRound === details.roundId) return { unchanged: true, reason: 'same-round' };
  cand.missingStreak = Number(cand.missingStreak || 0) + 1;
  cand.lastMissingObservationRound = details.roundId;
  cand.missingSide = details.missingSide;
  if (baseline) cand.survivorSemanticBaseline = baseline;
  subtaskPersist_(state, options);
  return { missingStreak: cand.missingStreak };
}

function subtaskHandleParentLoss_(state, gParentId, missingSide, options) {
  var sub = subtaskEnsureNamespace_(state);
  var reason = missingSide === 'MICROSOFT' ? 'AMBIGUOUS_PARENT_LOSS_MICROSOFT' : 'AMBIGUOUS_PARENT_LOSS_GOOGLE';
  Object.keys(sub.mappings).forEach(function(gId) {
    var mapping = sub.mappings[gId];
    if (!mapping || mapping.gParentId !== gParentId) return;
    sub.conflicts[gId] = {
      gChildId: gId, msChecklistId: mapping.msChecklistId, gParentId: gParentId, reason: reason
    };
    subtaskResetPendingDeletion_(state, gId);
  });
  subtaskPersist_(state, options);
  return { terminal: 'AMBIGUOUS_PARENT_LOSS', missingSide: missingSide, automaticCascade: false };
}

function subtaskObserveDeletionEvidence_(state, snap, options) {
  var sub = subtaskEnsureNamespace_(state);
  var roundId = options && options.roundId || '';
  var gTasks = snap && snap.gTasksById || {};
  var googleComplete = subtaskGoogleInventoryComplete_(snap);
  var msNotFound = snap && snap.msParentNotFound || {};
  /* Index once (O(children)) instead of a per-parent linear rescan (§13.6.1). */
  var parentsWithChildren = {};
  Object.keys(sub.mappings).forEach(function(gId) {
    var mapping = sub.mappings[gId];
    if (mapping && mapping.gParentId) parentsWithChildren[mapping.gParentId] = true;
  });
  Object.keys(state.g2m || {}).forEach(function(gParentId) {
    var rec = state.g2m[gParentId];
    if (!rec) return;
    if (!parentsWithChildren[gParentId]) return;
    if (googleComplete && !gTasks[gParentId]) {
      subtaskHandleParentLoss_(state, gParentId, 'GOOGLE', options);
    } else if (rec.msId && msNotFound[rec.msId]) {
      subtaskHandleParentLoss_(state, gParentId, 'MICROSOFT', options);
    }
  });
  Object.keys(sub.mappings).sort().forEach(function(gId) {
    var mapping = sub.mappings[gId];
    if (!mapping || sub.conflicts[gId]) return;
    var parentMsId = mapping.parentMsId;
    var gTask = gTasks[gId];
    var msComplete = subtaskObservationComplete_(state, snap, parentMsId, roundId);
    var items = msComplete ? subtaskObservationItems_(snap, parentMsId) : null;
    var msItem = items ? subtaskFindChecklist_(items, mapping.msChecklistId) : null;
    var googleMissing = googleComplete && !gTask;
    var msMissing = msComplete && !msItem;
    if (googleComplete && gTask) {
      var googleCand = sub.pendingDeletions[gId];
      if (googleCand && googleCand.missingSide === 'GOOGLE') subtaskResetPendingDeletion_(state, gId);
    }
    if (msComplete && msItem) {
      var msCand = sub.pendingDeletions[gId];
      if (msCand && msCand.missingSide === 'MICROSOFT') subtaskResetPendingDeletion_(state, gId);
    }
    if (googleMissing && msMissing) {
      subtaskRecordMissingObservation_(state, {
        gChildId: gId, missingSide: 'BOTH', roundId: roundId, observationComplete: true,
        googleChild: null, msItem: null
      }, options);
    } else if (googleMissing) {
      subtaskRecordMissingObservation_(state, {
        gChildId: gId, missingSide: 'GOOGLE', roundId: roundId, observationComplete: true,
        googleChild: null, msItem: msItem
      }, options);
    } else if (msMissing) {
      subtaskRecordMissingObservation_(state, {
        gChildId: gId, missingSide: 'MICROSOFT', roundId: roundId, observationComplete: true,
        googleChild: gTask, msItem: null
      }, options);
    }
  });
}

function subtaskFinalizeLocalDelete_(state, key, row, options) {
  var sub = subtaskEnsureNamespace_(state);
  var mapping = sub.mappings[row.gChildId] || {
    gChildId: row.gChildId, msChecklistId: row.msChecklistId, gParentId: row.gParentId,
    parentMsId: row.parentMsId, parentMsListId: row.parentMsListId
  };
  mapping.gChildId = row.gChildId;
  mapping.msChecklistId = row.msChecklistId;
  mapping.parentMsId = row.parentMsId || mapping.parentMsId;
  subtaskWriteTombstones_(state, mapping, options && options.now);
  delete sub.mappings[row.gChildId];
  delete sub.pendingDeletions[row.gChildId];
  delete sub.deletionJournal[key];
  delete sub.conflicts[row.gChildId];
  subtaskPersist_(state, options);
}

function subtaskRecoverDeletionJournals_(state, snap, options) {
  var sub = subtaskEnsureNamespace_(state);
  var result = { finalized: 0, retried: 0, uncertain: 0 };
  Object.keys(sub.deletionJournal).sort().forEach(function(key) {
    var row = sub.deletionJournal[key];
    if (!row) return;
    var msComplete = subtaskObservationComplete_(state, snap, row.parentMsId, options && options.roundId);
    var googleComplete = subtaskGoogleInventoryComplete_(snap);
    var gTask = snap && snap.gTasksById && snap.gTasksById[row.gChildId];
    var item = msComplete ? subtaskFindChecklist_(subtaskObservationItems_(snap, row.parentMsId), row.msChecklistId) : null;
    var remoteGone = (row.missingSide === 'GOOGLE' && msComplete && !item) ||
      (row.missingSide === 'MICROSOFT' && googleComplete && !gTask) ||
      (row.missingSide === 'BOTH' && googleComplete && msComplete && !gTask && !item);
    if (row.phase === SUBTASK_DELETE_PHASES_.REMOTE_DELETED && remoteGone) {
      subtaskFinalizeLocalDelete_(state, key, row, options);
      result.finalized += 1;
      return;
    }
    if (row.phase === SUBTASK_DELETE_PHASES_.PREPARED || row.phase === SUBTASK_DELETE_PHASES_.UNCERTAIN) {
      if (remoteGone) {
        subtaskFinalizeLocalDelete_(state, key, row, options);
        result.finalized += 1;
        return;
      }
      if ((row.missingSide === 'GOOGLE' && msComplete && item) ||
          (row.missingSide === 'MICROSOFT' && googleComplete && gTask)) {
        var exec = subtaskRemoteDeleteOnce_(row);
        if (exec.ok) {
          row.phase = SUBTASK_DELETE_PHASES_.REMOTE_DELETED;
          subtaskPersist_(state, options);
          subtaskFinalizeLocalDelete_(state, key, row, options);
          result.retried += 1;
        } else if (exec.notFound) {
          subtaskFinalizeLocalDelete_(state, key, row, options);
          result.finalized += 1;
        } else {
          row.phase = SUBTASK_DELETE_PHASES_.UNCERTAIN;
          result.uncertain += 1;
          subtaskPersist_(state, options);
        }
      }
    }
  });
  return result;
}

function subtaskRemoteDeleteOnce_(row) {
  try {
    if (row.missingSide === 'BOTH') return { ok: true };
    if (row.missingSide === 'GOOGLE') {
      deleteMsChecklistItemNoRetry_(row.parentMsListId, row.parentMsId, row.msChecklistId);
    } else {
      var rec = null;
      /* Google list id is recovered from ordinary parent mapping when present. */
      deleteGChecklistChildNoRetry_(row.gListId || row.parentMsListId, row.gChildId);
    }
    return { ok: true };
  } catch (error) {
    if (typeof isNotFoundError_ === 'function' && isNotFoundError_(error)) return { ok: true, notFound: true };
    return { ok: false, error: String(error && error.message || error) };
  }
}

function subtaskExecuteEligibleDeletes_(state, snap, options) {
  var sub = subtaskEnsureNamespace_(state);
  var result = { deleted: 0, writes: 0, skipped: 0 };
  var gLists = snap && snap.gListByTask || {};
  Object.keys(sub.pendingDeletions).sort().forEach(function(gId) {
    var cand = sub.pendingDeletions[gId];
    if (!cand || Number(cand.missingStreak) < 2) { result.skipped += 1; return; }
    if (sub.conflicts[gId]) { result.skipped += 1; return; }
    if (sub.deletionJournal[gId]) { result.skipped += 1; return; }
    var mapping = sub.mappings[gId];
    if (!mapping) { result.skipped += 1; return; }
    var parentRec = state.g2m && state.g2m[mapping.gParentId];
    var row = {
      phase: SUBTASK_DELETE_PHASES_.PREPARED,
      gChildId: gId,
      msChecklistId: mapping.msChecklistId,
      gParentId: mapping.gParentId,
      parentMsId: mapping.parentMsId || (parentRec && parentRec.msId) || '',
      parentMsListId: mapping.parentMsListId || (parentRec && parentRec.msListId) || '',
      missingSide: cand.missingSide,
      gListId: parentRec && parentRec.gListId || gLists[gId] || '',
      at: new Date().toISOString(),
      preparedAt: new Date().toISOString()
    };
    /* gListId is operational only; schema allowlist excludes it, so keep it off the persisted row. */
    var persisted = {
      phase: row.phase, gChildId: row.gChildId, msChecklistId: row.msChecklistId, gParentId: row.gParentId,
      missingSide: row.missingSide, at: row.at, preparedAt: row.preparedAt
    };
    if (row.parentMsId) persisted.parentMsId = row.parentMsId;
    if (row.parentMsListId) persisted.parentMsListId = row.parentMsListId;
    sub.deletionJournal[gId] = persisted;
    subtaskPersist_(state, options);
    var exec = subtaskRemoteDeleteOnce_({
      missingSide: row.missingSide, parentMsListId: row.parentMsListId, parentMsId: row.parentMsId,
      msChecklistId: row.msChecklistId, gChildId: row.gChildId,
      gListId: row.gListId || (parentRec && parentRec.gListId)
    });
    if (!exec.ok && !exec.notFound) {
      persisted.phase = SUBTASK_DELETE_PHASES_.UNCERTAIN;
      subtaskPersist_(state, options);
      result.skipped += 1;
      return;
    }
    persisted.phase = SUBTASK_DELETE_PHASES_.REMOTE_DELETED;
    try { subtaskPersist_(state, options); } catch (ignored) {}
    try {
      subtaskFinalizeLocalDelete_(state, gId, persisted, options);
      result.deleted += 1;
      result.writes += row.missingSide === 'BOTH' ? 0 : 1;
    } catch (error) {
      persisted.phase = SUBTASK_DELETE_PHASES_.REMOTE_DELETED;
      result.skipped += 1;
    }
  });
  return result;
}

/* Main seam. `snap` may carry complete direct observations under
 * msChecklistItemsByParentId; no mapping is merged without one. */
function reconcileSubtasks_(state, snap, options) {
  options = options || {};
  var enabled = Object.prototype.hasOwnProperty.call(options, 'enableSubtasks') ? options.enableSubtasks === true :
    !!(snap && snap.safety && snap.safety.enableSubtasks === true);
  if (!enabled) return { writes: 0, scheduled: 0, skipped: 'FEATURE_OFF' };
  var sub = subtaskEnsureNamespace_(state);
  var result = { writes: 0, creates: 0, updates: 0, conflicts: 0, quarantined: 0, deletes: 0 };
  subtaskCleanupTombstones_(state, options.now);
  subtaskRecoverCreateJournals_(state, snap, options);
  subtaskRecoverUpdateIntents_(state, snap, options);
  subtaskRecoverDeletionJournals_(state, snap, options);
  subtaskObserveDeletionEvidence_(state, snap, options);
  var deleted = subtaskExecuteEligibleDeletes_(state, snap, options);
  result.deletes += deleted.deleted || 0;
  result.writes += deleted.writes || 0;
  var gTasks = snap && snap.gTasksById || {}, gLists = snap && snap.gListByTask || {}, msLists = snap && snap.msListByTask || {};
  var parents = {};
  Object.keys(state.g2m || {}).forEach(function(gParentId) {
    var rec = state.g2m[gParentId], parentTask = gTasks[gParentId];
    if (rec && rec.msId && parentTask && !parentTask.parent) parents[rec.msId] = {
      gParentId: gParentId, msParentId: rec.msId, msListId: rec.msListId || msLists[rec.msId],
      gListId: gLists[gParentId]
    };
  });
  Object.keys(gTasks).sort().forEach(function(gId) {
    var task = gTasks[gId], parentId = task && task.parent, pRec = parentId && state.g2m && state.g2m[parentId];
    if (!parentId || !pRec || !parents[pRec.msId]) return;
    var parent = parents[pRec.msId];
    // Spec §32: a conflicted child is still OBSERVED each round so a provider
    // convergence (both sides re-aligned by hand) can auto-resolve the record.
    // Writes stay frozen while the conflict exists (§31): the healer itself
    // performs zero remote writes, it only clears state.
    if (sub.conflicts[gId]) {
      subtaskAttemptConflictSelfHeal_(state, snap, gId, parent, options);
      return;
    }
    if (sub.deletionJournal[gId] || sub.pendingDeletions[gId] ||
        subtaskHasTombstone_(state, gId, parent.msParentId, sub.mappings[gId] && sub.mappings[gId].msChecklistId)) return;
    if (sub.mappings[gId]) {
      if (!subtaskObservationComplete_(state, snap, parent.msParentId, options.roundId)) return;
      var item = subtaskFindChecklist_(subtaskObservationItems_(snap, parent.msParentId), sub.mappings[gId].msChecklistId);
      var u = subtaskUpdateMapped_(state, snap, gId, sub.mappings[gId], task, item, parent, options);
      result.updates += u.writes || 0; result.writes += u.writes || 0; result.conflicts += u.conflicts || 0; result.quarantined += u.quarantined ? 1 : 0;
    } else if (typeof subtaskClassifyCandidate_ === 'function' &&
        subtaskClassifyCandidate_(state, snap, { side: 'g', id: gId }, options).classification === 'ELIGIBLE_GOOGLE_CHILD') {
      if (subtaskHasTombstone_(state, gId, parent.msParentId, null)) return;
      var c = subtaskCreateGoogleToMicrosoft_(state, snap, task, { gParentId: parentId, msParentId: pRec.msId,
        msListId: parent.msListId, gListId: parent.gListId }, options);
      if (c.created) { result.creates += 1; result.writes += 1; }
    }
  });
  var groups = snap && (snap.msChecklistItemsByParentId || snap.itemsByMsParentId || {});
  /* Index once (O(children)) instead of a per-item linear rescan (§13.6.1). */
  var mappedChecklistIds = {};
  Object.keys(sub.mappings).forEach(function(gId) {
    var mapping = sub.mappings[gId];
    if (mapping && mapping.msChecklistId) mappedChecklistIds[mapping.msChecklistId] = true;
  });
  Object.keys(groups).sort().forEach(function(msParentId) {
    var parent = parents[msParentId], items = subtaskObservationItems_(snap, msParentId);
    if (!parent || !subtaskObservationComplete_(state, snap, msParentId, options.roundId)) return;
    (items || []).slice().sort(function(a, b) { return String(a.id).localeCompare(String(b.id)); }).forEach(function(item) {
      if (!item || !item.id || mappedChecklistIds[item.id]) {
        return;
      }
      if (subtaskHasTombstone_(state, null, msParentId, item.id)) return;
      if (subtaskClassifyCandidate_(state, snap, { side: 'ms', id: item.id }, options).classification !== 'ELIGIBLE_MICROSOFT_CHECKLIST') return;
      var created = subtaskCreateMicrosoftToGoogle_(state, snap, item, parent, options);
      if (created.created) { result.creates += 1; result.writes += 1; }
    });
  });
  return result;
}

function discoverSubtaskRelationships_(state, snap, startedAt, roundId, nowMs) {
  if (!snap || !snap.safety || snap.safety.enableSubtasks !== true) {
    return { scheduled: 0, attempted: 0, observed: 0, itemsByMsParentId: {} };
  }
  var candidates = [];
  Object.keys(state.g2m || {}).sort().forEach(function(gParentId) {
    var rec = state.g2m[gParentId];
    if (!rec || !rec.msId || !snap.gTasksById || !snap.gTasksById[gParentId]) return;
    candidates.push({ gParentId: gParentId, msParentId: rec.msId,
      msListId: rec.msListId || (snap.msListByTask && snap.msListByTask[rec.msId]) });
  });
  var result = discoverRelationshipsReadOnly_(state, candidates, subtaskDiscoveryPolicy_(), startedAt, roundId, nowMs || Date.now());
  snap.msChecklistItemsByParentId = result.itemsByMsParentId || {};
  snap.msParentNotFound = snap.msParentNotFound || {};
  (result.notFoundParentIds || []).forEach(function(id) { snap.msParentNotFound[id] = true; });
  return result;
}

function subtaskOperationRef_(kind, key) {
  return previewOpaqueId_('subtaskOp', String(kind) + ':' + String(key));
}

function subtaskOperationRevision_(record) {
  return previewOpaqueId_('subtaskRev', JSON.stringify({
    phase: record && record.phase || null,
    reason: record && record.reason || null,
    field: record && record.field || null,
    missingSide: record && record.missingSide || null,
    missingStreak: record && record.missingStreak || null,
    at: record && (record.at || record.preparedAt || record.firstMissingAt) || null
  }));
}

function subtaskInspectEntries_(state) {
  var sub = subtaskEnsureNamespace_(state);
  var entries = [];
  function push(kind, key, record, nextSafeAction) {
    entries.push({
      kind: kind,
      key: key,
      record: record,
      operationRef: subtaskOperationRef_(kind, key),
      revision: subtaskOperationRevision_(record),
      nextSafeAction: nextSafeAction
    });
  }
  Object.keys(sub.createJournal).sort().forEach(function(key) {
    var row = sub.createJournal[key];
    if (!row) return;
    if (key.indexOf('u:') === 0) {
      push('UPDATE', key, row, row.phase === 'UNCERTAIN' ? 'ABANDON' : 'WAIT');
      return;
    }
    var next = row.phase === 'REMOTE_CREATED' ? 'RESOLVE' : (row.phase === 'UNCERTAIN' || row.phase === 'PREPARED' ? 'ABANDON' : 'WAIT');
    push('CREATE', key, row, next);
  });
  Object.keys(sub.deletionJournal).sort().forEach(function(key) {
    var row = sub.deletionJournal[key];
    if (!row) return;
    var next = row.phase === 'REMOTE_DELETED' ? 'RESOLVE' : 'ABANDON';
    push('DELETE', key, row, next);
  });
  Object.keys(sub.pendingDeletions).sort().forEach(function(key) {
    push('PENDING_DELETE', key, sub.pendingDeletions[key], 'ABANDON');
  });
  Object.keys(sub.conflicts).sort().forEach(function(key) {
    var row = sub.conflicts[key];
    var parentLoss = row && String(row.reason || '').indexOf('AMBIGUOUS_PARENT_LOSS') === 0;
    push(parentLoss ? 'PARENT_LOSS' : 'CONFLICT', key, row, 'ABANDON');
  });
  return entries.sort(function(a, b) {
    return a.operationRef < b.operationRef ? -1 : a.operationRef > b.operationRef ? 1 : 0;
  });
}

function subtaskInspectPublic_(entry) {
  var record = entry.record || {};
  return {
    operationRef: entry.operationRef,
    revision: entry.revision,
    kind: entry.kind,
    phase: record.phase || null,
    reason: record.reason ? subtaskBoundedReason_(record.reason) : null,
    missingSide: record.missingSide || null,
    missingStreak: Number.isInteger(Number(record.missingStreak)) ? Number(record.missingStreak) : null,
    field: record.field || null,
    nextSafeAction: entry.nextSafeAction,
    evidence: {
      mappingPresent: !!(record.gChildId || record.msChecklistId),
      remoteIdRecorded: !!(record.msChecklistId && record.gChildId && entry.kind === 'CREATE' && record.phase === 'REMOTE_CREATED'),
      parentLoss: entry.kind === 'PARENT_LOSS'
    }
  };
}

function subtaskObservability_(state) {
  var sub = state && state.subtasks;
  if (!sub) {
    return {
      mappings: 0, createUncertain: 0, updateUncertain: 0, deletionJournals: 0,
      pendingDeletions: 0, conflicts: 0, parentLoss: 0, tombstones: 0
    };
  }
  var createUncertain = 0, updateUncertain = 0, parentLoss = 0;
  Object.keys(sub.createJournal || {}).forEach(function(key) {
    var row = sub.createJournal[key];
    if (!row || row.phase !== 'UNCERTAIN') return;
    if (key.indexOf('u:') === 0) updateUncertain += 1;
    else createUncertain += 1;
  });
  Object.keys(sub.conflicts || {}).forEach(function(key) {
    if (String(sub.conflicts[key] && sub.conflicts[key].reason || '').indexOf('AMBIGUOUS_PARENT_LOSS') === 0) {
      parentLoss += 1;
    }
  });
  return {
    mappings: Object.keys(sub.mappings || {}).length,
    createUncertain: createUncertain,
    updateUncertain: updateUncertain,
    deletionJournals: Object.keys(sub.deletionJournal || {}).length,
    pendingDeletions: Object.keys(sub.pendingDeletions || {}).length,
    conflicts: Object.keys(sub.conflicts || {}).length,
    parentLoss: parentLoss,
    tombstones: Object.keys((sub.tombstones && sub.tombstones.g) || {}).length +
      Object.keys((sub.tombstones && sub.tombstones.ms) || {}).length
  };
}

function subtaskResolveInspectEntry_(state, operationRef) {
  var matches = subtaskInspectEntries_(state).filter(function(entry) {
    return entry.operationRef === operationRef;
  });
  if (matches.length !== 1) {
    throw new Error(matches.length > 1
      ? 'SUBTASK_OPERATION_REF_COLLISION: operationRef is not unique; selection refused.'
      : 'SUBTASK_OPERATION_NOT_FOUND: operationRef not found.');
  }
  return matches[0];
}

function parseSubtaskOperation_(requirePreviewToken) {
  var raw = PropertiesService.getScriptProperties().getProperty(SUBTASK_OPERATION_PROPERTY);
  if (!raw) throw new Error('SUBTASK_OPERATION_MISSING: Set SYNC_SUBTASK_OPERATION_JSON.');
  var operation;
  try { operation = JSON.parse(raw); }
  catch (e) { throw new Error('SUBTASK_OPERATION_INVALID_JSON: SYNC_SUBTASK_OPERATION_JSON is not valid JSON.'); }
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('SUBTASK_OPERATION_INVALID: Operation must be a JSON object.');
  }
  Object.keys(operation).forEach(function(key) {
    if (['action', 'operationRef', 'revision', 'previewToken'].indexOf(key) < 0) {
      throw new Error('SUBTASK_OPERATION_INVALID: Unknown field is not accepted: ' + key + '.');
    }
  });
  if (['ABANDON', 'RESOLVE'].indexOf(operation.action) < 0 ||
      typeof operation.operationRef !== 'string' || !operation.operationRef ||
      typeof operation.revision !== 'string' || !operation.revision) {
    throw new Error('SUBTASK_OPERATION_INVALID: action, operationRef, and revision must be valid.');
  }
  if (requirePreviewToken && (typeof operation.previewToken !== 'string' || !operation.previewToken)) {
    throw new Error('SUBTASK_OPERATION_PREVIEW_TOKEN_REQUIRED: Preview first, then write previewToken back to the operation JSON.');
  }
  return operation;
}

function subtaskOperationDigest_(operation, entry) {
  return previewOpaqueId_('subtaskPreview', JSON.stringify({
    action: operation.action,
    operationRef: entry.operationRef,
    revision: entry.revision,
    kind: entry.kind,
    phase: entry.record && entry.record.phase || null,
    reason: entry.record && entry.record.reason || null
  }));
}

function subtaskOperationPlan_(operation, entry) {
  if (entry.revision !== operation.revision) {
    return { ok: false, code: 'SUBTASK_OPERATION_STALE_REVISION' };
  }
  if (operation.action === 'ABANDON') {
    if (entry.nextSafeAction !== 'ABANDON' && entry.kind !== 'CONFLICT' && entry.kind !== 'PARENT_LOSS' &&
        entry.kind !== 'PENDING_DELETE' && entry.kind !== 'CREATE' && entry.kind !== 'UPDATE' &&
        entry.kind !== 'DELETE') {
      return { ok: false, code: 'SUBTASK_OPERATION_NOT_SAFE' };
    }
    if (entry.kind === 'CREATE' && entry.record && entry.record.phase === 'REMOTE_CREATED' && operation.action === 'ABANDON') {
      /* Clearing REMOTE_CREATED without a tombstone can hide a real remote object.
       * Keep it visible unless RESOLVE can prove identity. */
      return { ok: false, code: 'SUBTASK_OPERATION_ABANDON_REMOTE_CREATED' };
    }
    if (entry.kind === 'DELETE' && entry.record && entry.record.phase === 'REMOTE_DELETED') {
      return { ok: false, code: 'SUBTASK_OPERATION_ABANDON_REMOTE_DELETED' };
    }
    return { ok: true, code: 'READY' };
  }
  if (operation.action === 'RESOLVE') {
    if (entry.nextSafeAction !== 'RESOLVE') return { ok: false, code: 'SUBTASK_OPERATION_NOT_SAFE' };
    return { ok: true, code: 'READY' };
  }
  return { ok: false, code: 'SUBTASK_OPERATION_NOT_SAFE' };
}

function subtaskApplyLocalOperation_(state, operation, entry, options) {
  var sub = subtaskEnsureNamespace_(state);
  var key = entry.key;
  if (operation.action === 'ABANDON') {
    if (entry.kind === 'CREATE' || entry.kind === 'UPDATE') {
      var row = sub.createJournal[key];
      if (row) {
        sub.conflicts[row.gChildId || key] = {
          gChildId: row.gChildId, msChecklistId: row.msChecklistId, gParentId: row.gParentId,
          reason: 'SUBTASK_ABANDONED'
        };
      }
      delete sub.createJournal[key];
    } else if (entry.kind === 'DELETE') {
      var del = sub.deletionJournal[key];
      if (del) {
        sub.conflicts[del.gChildId] = {
          gChildId: del.gChildId, msChecklistId: del.msChecklistId, gParentId: del.gParentId,
          reason: 'SUBTASK_ABANDONED'
        };
      }
      delete sub.deletionJournal[key];
    } else if (entry.kind === 'PENDING_DELETE') {
      delete sub.pendingDeletions[key];
    } else if (entry.kind === 'CONFLICT' || entry.kind === 'PARENT_LOSS') {
      subtaskResetMissingOnConflictResolve_(state, key);
    }
    subtaskPersist_(state, options);
    return;
  }
  if (operation.action === 'RESOLVE' && entry.kind === 'CREATE') {
    var create = sub.createJournal[key];
    if (!create || create.phase !== 'REMOTE_CREATED' || !create.gChildId || !create.msChecklistId) {
      throw new Error('SUBTASK_OPERATION_NOT_SAFE: RESOLVE requires a conclusive REMOTE_CREATED identity.');
    }
    subtaskCommitCreate_(state, key, create.msChecklistId, create.intended || (sub.mappings[create.gChildId] && sub.mappings[create.gChildId].base), create, options);
    return;
  }
  if (operation.action === 'RESOLVE' && entry.kind === 'DELETE') {
    var journal = sub.deletionJournal[key];
    if (!journal || journal.phase !== 'REMOTE_DELETED') {
      throw new Error('SUBTASK_OPERATION_NOT_SAFE: RESOLVE requires REMOTE_DELETED evidence.');
    }
    subtaskFinalizeLocalDelete_(state, key, journal, options);
  }
}

/* Friendly aliases used by hermetic tests and future lifecycle integration. */
function processSubtasks_(state, snap, options) { return reconcileSubtasks_(state, snap, options); }
function syncSubtasks_(state, snap, options) { return reconcileSubtasks_(state, snap, options); }
