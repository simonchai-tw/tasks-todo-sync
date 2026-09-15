/* Phase 2A.5: pure compatibility and candidate classification. */

var SUBTASK_CLASSIFICATION_CODES_ = Object.freeze({
  LEGACY_FLAT: 'LEGACY_FLAT',
  ELIGIBLE_GOOGLE_CHILD: 'ELIGIBLE_GOOGLE_CHILD',
  ELIGIBLE_MICROSOFT_CHECKLIST: 'ELIGIBLE_MICROSOFT_CHECKLIST',
  PARENT_NOT_READY: 'PARENT_NOT_READY',
  NON_CANDIDATE: 'NON_CANDIDATE',
  SUBTASK_REPARENT_PENDING: 'SUBTASK_REPARENT_PENDING',
  SUBTASK_UNNEST_PENDING: 'SUBTASK_UNNEST_PENDING',
  SUBTASK_CROSS_LIST_MOVE_PENDING: 'SUBTASK_CROSS_LIST_MOVE_PENDING'
});

function subtaskClassificationObject_(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function subtaskClassificationMap_(value) {
  return subtaskClassificationObject_(value) ? value : {};
}

function subtaskClassificationId_(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function subtaskClassificationFeatureEnabled_(snap, options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'enableSubtasks')) {
    return options.enableSubtasks === true;
  }
  return !!(snap && snap.safety && snap.safety.enableSubtasks === true);
}

function subtaskClassificationResult_(side, id, classification, reason, extra) {
  var result = {
    side: side,
    id: id,
    classification: classification,
    reason: reason || null,
    ordinaryExcluded: false
  };
  if (extra && typeof extra === 'object') Object.keys(extra).forEach(function(key) {
    result[key] = extra[key];
  });
  return result;
}

function subtaskClassificationOrdinaryMappingForGoogle_(state, gId) {
  var g2m = subtaskClassificationMap_(state && state.g2m);
  var record = g2m[gId];
  return record && typeof record.msId === 'string' && record.msId ? record : null;
}

function subtaskClassificationGoogleParentId_(task) {
  return subtaskClassificationId_(task && task.parent);
}

function subtaskClassificationIsAssigned_(task) {
  if (!task || typeof task !== 'object') return false;
  return task.assigned === true || task.isAssigned === true ||
    (task.assignmentInfo !== undefined && task.assignmentInfo !== null) ||
    (task.assignedTo !== undefined && task.assignedTo !== null) ||
    (task.assignment !== undefined && task.assignment !== null);
}

function subtaskClassificationReservedRecord_(state, side, id) {
  var sub = state && state.subtasks;
  if (!sub || !id) return null;
  var tables = ['mappings', 'createJournal', 'deletionJournal', 'moveJournal', 'conflicts'];
  for (var i = 0; i < tables.length; i += 1) {
    var table = subtaskClassificationMap_(sub[tables[i]]);
    var keys = Object.keys(table).sort();
    for (var j = 0; j < keys.length; j += 1) {
      var record = table[keys[j]];
      if (!subtaskClassificationObject_(record)) continue;
      if (side === 'g' && (keys[j] === id || record.gChildId === id)) {
        return { table: tables[i], key: keys[j], record: record };
      }
      if (side === 'ms' && (record.msChecklistId === id || record.nextMsChecklistId === id)) {
        return { table: tables[i], key: keys[j], record: record };
      }
    }
  }
  return null;
}

function subtaskClassificationParentState_(state, snap, parentId) {
  var gTasks = subtaskClassificationMap_(snap && snap.gTasksById);
  var msTasks = subtaskClassificationMap_(snap && snap.msTasksById);
  var parent = gTasks[parentId];
  var mapping = subtaskClassificationOrdinaryMappingForGoogle_(state, parentId);
  if (!parent || !mapping) return { ready: false, parent: parent || null, mapping: mapping || null };
  if (subtaskClassificationGoogleParentId_(parent)) {
    return { ready: false, parent: parent, mapping: mapping, deep: true };
  }
  if (!msTasks[mapping.msId]) return { ready: false, parent: parent, mapping: mapping };
  return { ready: true, parent: parent, mapping: mapping };
}

function subtaskClassificationManagedGoogle_(state, snap, gId, task) {
  var mappings = subtaskClassificationMap_(state && state.subtasks && state.subtasks.mappings);
  var mapping = mappings[gId];
  if (!mapping) return null;
  var currentList = subtaskClassificationMap_(snap && snap.gListByTask)[gId];
  var expectedList = mapping.gListId || (mapping.gParentId &&
    subtaskClassificationMap_(snap && snap.gListByTask)[mapping.gParentId]);
  if (expectedList && currentList && expectedList !== currentList) {
    return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.SUBTASK_CROSS_LIST_MOVE_PENDING,
      'CROSS_LIST_MOVE', { mapping: mapping, ordinaryExcluded: true });
  }
  var expectedParent = subtaskClassificationId_(mapping.gParentId);
  var actualParent = subtaskClassificationGoogleParentId_(task);
  if (expectedParent && !actualParent) {
    return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.SUBTASK_UNNEST_PENDING,
      'UNNEST', { mapping: mapping, ordinaryExcluded: true });
  }
  if (expectedParent && actualParent !== expectedParent) {
    return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.SUBTASK_REPARENT_PENDING,
      'REPARENT', { mapping: mapping, ordinaryExcluded: true });
  }
  return subtaskClassificationResult_('g', gId, 'MANAGED_SUBTASK', 'MANAGED_SUBTASK', {
    mapping: mapping, ordinaryExcluded: true
  });
}

function subtaskClassificationChecklistIndex_(snap) {
  var byId = {};
  var parentsById = {};
  function add(parentId, item) {
    if (!item || typeof item !== 'object') return;
    var id = subtaskClassificationId_(item.id || item.msChecklistId || item.checklistId);
    if (!id) return;
    var parent = subtaskClassificationId_(parentId || item.msParentId || item.parentId);
    if (!byId[id]) byId[id] = [];
    byId[id].push({ parentId: parent, item: item });
    if (!parentsById[id]) parentsById[id] = {};
    if (parent) parentsById[id][parent] = true;
  }
  var grouped = snap && (snap.msChecklistItemsByParentId || snap.itemsByMsParentId ||
    snap.checklistItemsByMsParentId || snap.checklistItemsByParentId);
  Object.keys(subtaskClassificationMap_(grouped)).sort().forEach(function(parentId) {
    var value = grouped[parentId];
    if (value && !Array.isArray(value) && Array.isArray(value.items)) value = value.items;
    if (Array.isArray(value)) value.forEach(function(item) { add(parentId, item); });
  });
  var flat = snap && (snap.msChecklistItems || snap.checklistItems);
  if (Array.isArray(flat)) flat.forEach(function(item) { add(null, item); });
  var existing = snap && (snap.msChecklistItemsById || snap.checklistItemsById);
  Object.keys(subtaskClassificationMap_(existing)).sort().forEach(function(id) {
    var value = existing[id];
    if (!Array.isArray(value)) value = [value];
    value.forEach(function(item) {
      var copy = item && Object.assign({}, item, { id: item.id || item.msChecklistId || id });
      add(item && (item.msParentId || item.parentId), copy);
    });
  });
  Object.keys(byId).forEach(function(id) {
    byId[id].sort(function(a, b) {
      var left = a.parentId || '', right = b.parentId || '';
      return left < right ? -1 : left > right ? 1 : 0;
    });
  });
  return { byId: byId, parentsById: parentsById };
}

function subtaskClassificationManagedMicrosoft_(state, msId) {
  var table = subtaskClassificationMap_(state && state.subtasks && state.subtasks.mappings);
  var ids = Object.keys(table).sort();
  for (var i = 0; i < ids.length; i += 1) {
    if (table[ids[i]] && table[ids[i]].msChecklistId === msId) {
      return { gChildId: ids[i], mapping: table[ids[i]] };
    }
  }
  return null;
}

function subtaskClassificationGoogle_(state, snap, gId, options) {
  var task = subtaskClassificationMap_(snap && snap.gTasksById)[gId];
  var ordinary = subtaskClassificationOrdinaryMappingForGoogle_(state, gId);
  if (ordinary) return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.LEGACY_FLAT,
    'ORDINARY_MAPPING', { mapping: ordinary, ordinaryExcluded: true });
  var managed = subtaskClassificationManagedGoogle_(state, snap, gId, task);
  if (managed) return managed;
  var parentId = subtaskClassificationGoogleParentId_(task);
  if (!parentId) return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE, 'TOP_LEVEL');
  var parent = subtaskClassificationParentState_(state, snap, parentId);
  if (!parent.parent) return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.PARENT_NOT_READY,
    'PARENT_NOT_IN_INVENTORY', { parentId: parentId, ordinaryExcluded: true });
  if (parent.deep) return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE,
    'DEEP_HIERARCHY');
  if (subtaskClassificationIsAssigned_(task)) return subtaskClassificationResult_('g', gId,
    SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE, 'ASSIGNED_TASK');
  if (!parent.ready) return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.PARENT_NOT_READY,
    'PARENT_MAPPING_NOT_READY', { parentId: parentId, ordinaryExcluded: true });
  if (!subtaskClassificationFeatureEnabled_(snap, options)) return subtaskClassificationResult_('g', gId,
    SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE, 'FEATURE_OFF');
  return subtaskClassificationResult_('g', gId, SUBTASK_CLASSIFICATION_CODES_.ELIGIBLE_GOOGLE_CHILD,
    'ONE_LEVEL_CHILD', { parentId: parentId, msParentId: parent.mapping.msId, ordinaryExcluded: true });
}

function subtaskClassificationMicrosoft_(state, snap, msId, options, index) {
  var ordinary = subtaskClassificationMap_(state && state.m2g)[msId];
  if (ordinary) return subtaskClassificationResult_('ms', msId, SUBTASK_CLASSIFICATION_CODES_.LEGACY_FLAT,
    'ORDINARY_MAPPING', { mapping: ordinary, ordinaryExcluded: true });
  var managed = subtaskClassificationManagedMicrosoft_(state, msId);
  var entries = index.byId[msId] || [];
  if (!entries.length && !managed) return subtaskClassificationResult_('ms', msId,
    SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE, 'TOP_LEVEL');
  if (managed) return subtaskClassificationResult_('ms', msId, 'MANAGED_SUBTASK', 'MANAGED_SUBTASK', {
    gChildId: managed.gChildId, mapping: managed.mapping, ordinaryExcluded: true
  });
  if (entries.length > 1) {
    return subtaskClassificationResult_('ms', msId, SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE,
      'DUPLICATE_CHECKLIST_IDENTITY', { ordinaryExcluded: true });
  }
  if (!subtaskClassificationFeatureEnabled_(snap, options)) return subtaskClassificationResult_('ms', msId,
    SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE, 'UNMANAGED_CHECKLIST_FEATURE_OFF', { ordinaryExcluded: true });
  var msParentId = entries[0].parentId;
  var g2m = subtaskClassificationMap_(state && state.g2m);
  var gParentId = null;
  Object.keys(g2m).sort().some(function(gId) {
    if (g2m[gId] && g2m[gId].msId === msParentId) { gParentId = gId; return true; }
    return false;
  });
  if (!gParentId || !subtaskClassificationMap_(snap && snap.gTasksById)[gParentId]) {
    return subtaskClassificationResult_('ms', msId, SUBTASK_CLASSIFICATION_CODES_.PARENT_NOT_READY,
      'PARENT_MAPPING_NOT_READY', { msParentId: msParentId, ordinaryExcluded: true });
  }
  return subtaskClassificationResult_('ms', msId, SUBTASK_CLASSIFICATION_CODES_.ELIGIBLE_MICROSOFT_CHECKLIST,
    'CHECKLIST_ID', { msParentId: msParentId, gParentId: gParentId, ordinaryExcluded: true });
}

function classifySubtaskCandidate_(state, snap, candidate, options) {
  var requestedSide = candidate && (candidate.side || candidate.provider);
  var side = requestedSide === 'g' || requestedSide === 'google' || requestedSide === 'google_tasks' ||
    candidate && candidate.direction === 'google_to_microsoft' ? 'g' : 'ms';
  var id = subtaskClassificationId_(candidate && (candidate.id || candidate.taskId || candidate.sourceTaskId));
  if (!id) return subtaskClassificationResult_(side, '', SUBTASK_CLASSIFICATION_CODES_.NON_CANDIDATE,
    'MALFORMED_ID', { ordinaryExcluded: true });
  return side === 'g'
    ? subtaskClassificationGoogle_(state || {}, snap || {}, id, options || {})
    : subtaskClassificationMicrosoft_(state || {}, snap || {}, id, options || {}, subtaskClassificationChecklistIndex_(snap || {}));
}

function classifySubtaskCandidates_(state, snap, options) {
  var result = [];
  var gTasks = subtaskClassificationMap_(snap && snap.gTasksById);
  Object.keys(gTasks).sort().forEach(function(id) {
    result.push(subtaskClassificationGoogle_(state || {}, snap || {}, id, options || {}));
  });
  var index = subtaskClassificationChecklistIndex_(snap || {});
  var ids = {};
  Object.keys(subtaskClassificationMap_(snap && snap.msTasksById)).forEach(function(id) { ids[id] = true; });
  Object.keys(index.byId).forEach(function(id) { ids[id] = true; });
  Object.keys(ids).sort().forEach(function(id) {
    result.push(subtaskClassificationMicrosoft_(state || {}, snap || {}, id, options || {}, index));
  });
  return result;
}

function subtaskClassificationReservations_(state, snap, options) {
  var result = typeof subtaskOwnershipReservations_ === 'function'
    ? subtaskOwnershipReservations_(state || {})
    : { reservedGoogleIds: {}, reservedMicrosoftIds: {}, quarantined: [] };
  result.reservedGoogleIds = result.reservedGoogleIds || {};
  result.reservedMicrosoftIds = result.reservedMicrosoftIds || {};
  classifySubtaskCandidates_(state || {}, snap || {}, options || {}).forEach(function(item) {
    if (!item.ordinaryExcluded) return;
    if (item.side === 'g' && item.id) result.reservedGoogleIds[item.id] = true;
    if (item.side === 'ms' && item.id) result.reservedMicrosoftIds[item.id] = true;
  });
  var index = subtaskClassificationChecklistIndex_(snap || {});
  Object.keys(index.byId).forEach(function(id) { result.reservedMicrosoftIds[id] = true; });
  return result;
}

function subtaskClassifyCandidate_(state, snap, candidate, options) {
  return classifySubtaskCandidate_(state, snap, candidate, options);
}

function subtaskClassifyCandidates_(state, snap, options) {
  return classifySubtaskCandidates_(state, snap, options);
}
