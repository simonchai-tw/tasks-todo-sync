function ensureExplicitListMappings_(state, gLists, msLists, activeGListIds) {
  const msById = {};
  msLists.forEach(function(x) { msById[x.id] = x; });
  const gById = {};
  gLists.forEach(function(x) { gById[x.id] = x; });
  const mappedMsIds = {};
  Object.keys(state.listMap).forEach(function(gId) {
    const id = state.listMap[gId];
    if (id) mappedMsIds[id] = true;
  });
  let stateChanged = false;

  gLists.forEach(function(gList) {
    if (isGListFaulted_(state, gList.id)) return;
    const msId = state.listMap[gList.id];
    if (!msId) {
      let target = null;
      if (ALLOW_NAME_PAIRING) {
        target = msLists.find(function(x) { return x.displayName === gList.title && !mappedMsIds[x.id]; }) || null;
      }
      if (!target) {
      target = createMsList_(gList.title || '(Untitled list)');
        msLists.push(target);
        msById[target.id] = target;
      console.log('[List] Create Microsoft list: ' + listLabel_(gList.id, gList.title));
      }
      state.listMap[gList.id] = target.id;
      mappedMsIds[target.id] = true;
      stateChanged = true;
      persistSyncState_(state);
      return;
    }
    if (msById[msId]) return;
    markListFault_(state, 'ms', msId, {
      reason: 'MS_LIST_MISSING',
      gListId: gList.id,
      gListTitle: gList.title || '(Untitled list)',
      msListTitle: '(Missing or unreadable)'
    });
    stateChanged = true;
    console.error('[ListFault] Microsoft list is missing or unreadable and has been isolated: ' + listLabel_(msId, null));
  });

  Object.keys(state.listMap).forEach(function(gListId) {
    if (activeGListIds && !activeGListIds[gListId]) return;
    if (isGListFaulted_(state, gListId)) return;
    if (gById[gListId]) return;
    const msListId = state.listMap[gListId];
    markListFault_(state, 'g', gListId, {
      reason: 'GOOGLE_LIST_MISSING',
      gListTitle: '(Missing or unreadable)',
      msListId: msListId,
      msListTitle: (msById[msListId] && msById[msListId].displayName) || ''
    });
    stateChanged = true;
    console.error('[ListFault] Google list is missing or unreadable and has been isolated: ' + listLabel_(gListId, null));
  });

  if (stateChanged) {
    persistSyncState_(state);
  }
}

function autoListMapById_(lists) {
  const byId = {};
  (lists || []).forEach(function(list) {
    if (list && list.id) byId[list.id] = list;
  });
  return byId;
}

function autoListTitleGroups_(lists, getTitle, excludedIds) {
  const groups = {};
  (lists || []).forEach(function(list) {
    if (!list || !list.id || (excludedIds && excludedIds[list.id])) return;
    const title = normalizeListName_(getTitle(list));
    if (!title) return;
    const key = 'title:' + title;
    groups[key] = groups[key] || [];
    groups[key].push(list);
  });
  return groups;
}

function planAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle) {
  state = normalizeState_(state);
  const activeGoogle = autoListMapById_(gLists);
  const allMicrosoft = autoListMapById_(allMsLists);
  const eligibleMicrosoftLists = (allMsLists || []).filter(function(list) {
    return isAutoEligibleMicrosoftList_(list, safety);
  });
  const eligibleMicrosoft = autoListMapById_(eligibleMicrosoftLists);
  const plan = {
    pairs: [],
    createMicrosoft: [],
    createGoogle: [],
    faults: [],
    eligibleMicrosoftLists: eligibleMicrosoftLists
  };
  const reservedGoogle = {};
  const reservedMicrosoft = {};
  const reservedNameKeys = (lifecycle && lifecycle.reservedNameKeys) || {};
  const faultedGoogle = {};
  const faultedMicrosoft = {};

  Object.keys((lifecycle && lifecycle.reservedGoogleIds) || {}).forEach(function(id) {
    reservedGoogle[id] = true;
  });
  Object.keys((lifecycle && lifecycle.reservedMicrosoftIds) || {}).forEach(function(id) {
    reservedMicrosoft[id] = true;
  });

  function nameReserved(name) {
    const key = listNameTombstoneKey_(name);
    return !!(key && reservedNameKeys[key]);
  }

  function reserve(google, microsoft, reason, existing) {
    if (!google || !microsoft || reservedGoogle[google.id] || reservedMicrosoft[microsoft.id]) return false;
    reservedGoogle[google.id] = true;
    reservedMicrosoft[microsoft.id] = true;
    plan.pairs.push({
      googleListId: google.id,
      googleListTitle: google.title || '(Untitled list)',
      microsoftListId: microsoft.id,
      microsoftListTitle: microsoft.displayName || '(Untitled list)',
      reason: reason,
      existing: !!existing
    });
    return true;
  }

  function fault(google, microsoft, reason) {
    const googleId = google && google.id;
    const microsoftId = microsoft && microsoft.id;
    const key = (googleId || '') + '|' + (microsoftId || '') + '|' + reason;
    if (plan.faults.some(function(item) { return item.key === key; })) return;
    if (googleId) {
      reservedGoogle[googleId] = true;
      faultedGoogle[googleId] = true;
    }
    if (microsoftId) {
      reservedMicrosoft[microsoftId] = true;
      faultedMicrosoft[microsoftId] = true;
    }
    plan.faults.push({
      key: key,
      googleListId: googleId || null,
      microsoftListId: microsoftId || null,
      googleListTitle: google ? (google.title || '(Untitled list)') : '',
      microsoftListTitle: microsoft ? (microsoft.displayName || '(Untitled list)') : '',
      reason: reason
    });
  }

  Object.keys(state.listMap).forEach(function(googleListId) {
    const microsoftListId = state.listMap[googleListId];
    const google = activeGoogle[googleListId] || null;
    if (!google) return;
    const microsoft = allMicrosoft[microsoftListId] || null;
    if (isGListFaulted_(state, googleListId) || isMsListFaulted_(state, microsoftListId)) {
      reservedGoogle[googleListId] = true;
      if (microsoftListId) reservedMicrosoft[microsoftListId] = true;
      return;
    }
    if (!microsoft) {
      // A complete top-level inventory can safely classify a formerly proven
      // custom pair as Microsoft-missing. It is a list-deletion lifecycle
      // observation, not an ordinary list-fetch fault: retain the exact map,
      // reserve it, and let buildSnapshot_ read only the Google survivor.
      if (isProvenAutoListDeletionMissingPair_(state, lifecycle, googleListId,
        microsoftListId, ['microsoft_missing'])) {
        reservedGoogle[googleListId] = true;
        reservedMicrosoft[microsoftListId] = true;
        return;
      }
      fault(google, { id: microsoftListId, displayName: '(Missing or unreadable)' }, 'MS_LIST_MISSING');
      return;
    }
    if (!eligibleMicrosoft[microsoftListId]) {
      fault(google, microsoft, 'MS_LIST_NOT_AUTO_ELIGIBLE');
      return;
    }
    // Existing stable ID mappings remain mapped even when lifecycle has
    // reserved the IDs for planner safety. Adopt this exact live mapping
    // before duplicate-reservation checks: default and other non-deletable
    // live pairs must keep their ordinary task-sync semantics.
    if (!plan.pairs.some(function(pair) {
      return pair.googleListId === google.id && pair.microsoftListId === microsoft.id;
    })) {
      plan.pairs.push({
        googleListId: google.id,
        googleListTitle: google.title || '(Untitled list)',
        microsoftListId: microsoft.id,
        microsoftListTitle: microsoft.displayName || '(Untitled list)',
        reason: 'EXISTING_ID_MAPPING',
        existing: true
      });
      reservedGoogle[google.id] = true;
      reservedMicrosoft[microsoft.id] = true;
    }
  });

  const defaultGoogle = gDefaultList && activeGoogle[gDefaultList.id] ? activeGoogle[gDefaultList.id] : null;
  const defaultMicrosoft = eligibleMicrosoftLists.filter(function(list) {
    return normalizeListName_(list.wellknownListName) === 'defaultlist';
  });
  if (defaultGoogle && !reservedGoogle[defaultGoogle.id]) {
    if (defaultMicrosoft.length !== 1) {
      fault(defaultGoogle, null, 'DEFAULT_LIST_UNRESOLVED');
    } else if (!reservedMicrosoft[defaultMicrosoft[0].id]) {
      reserve(defaultGoogle, defaultMicrosoft[0], 'DEFAULT_LIST_IDENTITY', false);
    } else {
      fault(defaultGoogle, defaultMicrosoft[0], 'DEFAULT_LIST_ALREADY_MAPPED');
    }
  } else if (defaultMicrosoft.length === 1 && !reservedMicrosoft[defaultMicrosoft[0].id]) {
    // The Google default list is excluded or already mapped elsewhere. Never create a second
    // Google list merely to mirror Microsoft’s built-in default list.
    fault(null, defaultMicrosoft[0], 'DEFAULT_LIST_GOOGLE_SIDE_UNAVAILABLE');
  }

  const googleGroups = autoListTitleGroups_(gLists, function(list) { return list.title; }, reservedGoogle);
  const microsoftGroups = autoListTitleGroups_(eligibleMicrosoftLists, function(list) {
    return list.displayName;
  }, reservedMicrosoft);
  Object.keys(googleGroups).forEach(function(key) {
    if (googleGroups[key].length < 2) return;
    googleGroups[key].forEach(function(google) {
      fault(google, null, 'AMBIGUOUS_GOOGLE_LIST_TITLE');
    });
    (microsoftGroups[key] || []).forEach(function(microsoft) {
      fault(null, microsoft, 'AMBIGUOUS_COUNTERPART_TITLE');
    });
  });
  Object.keys(microsoftGroups).forEach(function(key) {
    if (microsoftGroups[key].length < 2) return;
    microsoftGroups[key].forEach(function(microsoft) {
      fault(null, microsoft, 'AMBIGUOUS_MICROSOFT_LIST_TITLE');
    });
    (googleGroups[key] || []).forEach(function(google) {
      fault(google, null, 'AMBIGUOUS_COUNTERPART_TITLE');
    });
  });

  const uniqueGoogleGroups = autoListTitleGroups_(gLists, function(list) { return list.title; }, reservedGoogle);
  const uniqueMicrosoftGroups = autoListTitleGroups_(eligibleMicrosoftLists, function(list) {
    return list.displayName;
  }, reservedMicrosoft);
  Object.keys(uniqueGoogleGroups).forEach(function(key) {
    const googleMatches = uniqueGoogleGroups[key];
    const microsoftMatches = uniqueMicrosoftGroups[key] || [];
    if (googleMatches.length === 1 && microsoftMatches.length === 1) {
      reserve(googleMatches[0], microsoftMatches[0], 'UNIQUE_NORMALIZED_TITLE', false);
    }
  });

  (gLists || []).forEach(function(google) {
    if (!google || reservedGoogle[google.id] || faultedGoogle[google.id]) return;
    if (nameReserved(google.title)) return;
    plan.createMicrosoft.push(google);
  });
  eligibleMicrosoftLists.forEach(function(microsoft) {
    if (!microsoft || reservedMicrosoft[microsoft.id] || faultedMicrosoft[microsoft.id]) return;
    if (nameReserved(microsoft.displayName)) return;
    plan.createGoogle.push(microsoft);
  });
  return plan;
}

function applyAutoListFaults_(state, faults) {
  let changed = false;
  (faults || []).forEach(function(fault) {
    if (fault.googleListId && !isGListFaulted_(state, fault.googleListId)) {
      markListFault_(state, 'g', fault.googleListId, {
        reason: fault.reason,
        msListId: fault.microsoftListId || null,
        gListTitle: fault.googleListTitle,
        msListTitle: fault.microsoftListTitle
      });
      changed = true;
    }
    if (fault.microsoftListId && !isMsListFaulted_(state, fault.microsoftListId)) {
      markListFault_(state, 'ms', fault.microsoftListId, {
        reason: fault.reason,
        gListId: fault.googleListId || null,
        gListTitle: fault.googleListTitle,
        msListTitle: fault.microsoftListTitle
      });
      changed = true;
    }
  });
  return changed;
}

function assertAutoListCreateStillSafe_(state, side, planned, gLists, allMsLists, gDefaultList, safety) {
  const lifecycle = classifyListLifecycle_(state, gLists, allMsLists, gDefaultList, safety);
  const source = side === 'microsoft' ? autoListMapById_(gLists)[planned.id] :
    autoListMapById_(allMsLists)[planned.id];
  const sourceName = side === 'microsoft' ? source && source.title : source && source.displayName;
  const reservedIds = side === 'microsoft' ? lifecycle.reservedGoogleIds : lifecycle.reservedMicrosoftIds;
  const tombstoneSide = side === 'microsoft' ? 'g' : 'ms';
  const sourceEligible = side === 'microsoft'
    ? isAutoDeletableGoogleList_(source, gDefaultList, safety)
    : isAutoDeletableMicrosoftList_(source, safety);
  const nameKey = listNameTombstoneKey_(sourceName);
  const mapped = side === 'microsoft'
    ? !!state.listMap[planned.id]
    : Object.keys(state.listMap).some(function(gListId) { return state.listMap[gListId] === planned.id; });
  const exactFingerprint = side === 'microsoft'
    ? listMetadataFingerprint_('g', source) === listMetadataFingerprint_('g', planned)
    : listMetadataFingerprint_('ms', source) === listMetadataFingerprint_('ms', planned);
  if (!source || !exactFingerprint || !sourceEligible || mapped || reservedIds[planned.id] ||
      hasListTombstone_(state, tombstoneSide, planned.id, sourceName) ||
      (nameKey && lifecycle.reservedNameKeys[nameKey])) {
    throw new Error('AUTO_CREATE_STALE_PLAN_BLOCKED: List lifecycle reservation or source metadata changed; creating the counterpart list was refused.');
  }
}

function ensureAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle) {
  const plan = planAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle);
  let stateChanged = applyAutoListFaults_(state, plan.faults);
  plan.pairs.forEach(function(pair) {
    if (pair.existing || isGListFaulted_(state, pair.googleListId) || isMsListFaulted_(state, pair.microsoftListId)) {
      return;
    }
    state.listMap[pair.googleListId] = pair.microsoftListId;
    stateChanged = true;
    console.log('[List] Auto-pair: ' + pair.reason + ' (' +
      listLabel_(pair.googleListId, null) + ' ↔ ' + listLabel_(pair.microsoftListId, null) + ')');
  });
  if (stateChanged) persistSyncState_(state);

  plan.createMicrosoft.forEach(function(google) {
    if (isGListFaulted_(state, google.id) || state.listMap[google.id]) return;
    assertAutoListCreateStillSafe_(state, 'microsoft', google, gLists, allMsLists, gDefaultList, safety);
      const microsoft = createMsList_(google.title || '(Untitled list)');
    if (!microsoft || !microsoft.id) throw new Error('AUTO_CREATE_MICROSOFT_LIST_FAILED: New Microsoft list ID was not returned.');
    allMsLists.push(microsoft);
    state.listMap[google.id] = microsoft.id;
    persistSyncState_(state);
    console.log('[List] Google → Microsoft list created: ' + listLabel_(google.id, google.title));
  });
  plan.createGoogle.forEach(function(microsoft) {
    if (isMsListFaulted_(state, microsoft.id)) return;
    const alreadyMapped = Object.keys(state.listMap).some(function(googleListId) {
      return state.listMap[googleListId] === microsoft.id;
    });
    if (alreadyMapped) return;
    assertAutoListCreateStillSafe_(state, 'google', microsoft, gLists, allMsLists, gDefaultList, safety);
      const google = createGList_(microsoft.displayName || '(Untitled list)');
    if (!google || !google.id) throw new Error('AUTO_CREATE_GOOGLE_LIST_FAILED: New Google list ID was not returned.');
    gLists.push(google);
    state.listMap[google.id] = microsoft.id;
    persistSyncState_(state);
    console.log('[List] Microsoft → Google list created: ' + listLabel_(microsoft.id, microsoft.displayName));
  });
  return plan;
}

function ensureListMappings_(state, gLists, allMsLists, activeGListIds, safety, gDefaultList, lifecycle) {
  if (isAutoDiscoveryMode_(safety)) {
    return ensureAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle);
  }
  return ensureExplicitListMappings_(state, gLists, allMsLists, activeGListIds);
}

function buildSnapshot_(state, startedAt) {
  const safety = getSafetyConfig_();
  requireSyncAllowlist_(safety);
  requireConfiguredListPairsApplied_(state, safety);
  const allGLists = getGLists_();
  const gLists = allowedGoogleLists_(allGLists, safety);
  const activeGListIds = {};
  const msLists = getMsLists_();
  let gDefaultList = null;
  if (isAutoDiscoveryMode_(safety)) {
    try {
      gDefaultList = getGDefaultList_();
    } catch (e) {
      throw new Error('AUTO_DEFAULT_LIST_LOOKUP_FAILED: Could not confirm the Google default list; automatic pairing stopped. ' + e.message);
    }
    if (!gDefaultList || !gDefaultList.id || !allGLists.some(function(list) {
      return list.id === gDefaultList.id;
    })) {
      throw new Error('AUTO_DEFAULT_LIST_LOOKUP_FAILED: Google default list is not in this round\'s inventory; automatic pairing stopped.');
    }
  } else {
    safety.googleListIds.forEach(function(id) { activeGListIds[id] = true; });
  }
  // Classify the complete, unfiltered inventories before any automatic
  // pairing/create.  In particular, a filtered or ineligible list is not
  // treated as missing and cannot make its survivor eligible for recreation.
  let listLifecycle = classifyListLifecycle_(state, allGLists, msLists, gDefaultList, safety);
  const proofRevokedBeforePlanning = revokeAutoListPairMetaForObservedSafety_(state, listLifecycle, safety);
  if (proofRevokedBeforePlanning) {
    // This checkpoint is intentionally before pairing, create, task reads and
    // reconciliation.  If it cannot be stored, the round aborts with no later
    // remote mutation; if later saves fail, this durable absence still wins.
    persistSyncState_(state);
  }
  ensureListMappings_(state, gLists, msLists, activeGListIds, safety, gDefaultList, listLifecycle);
  if (isAutoDiscoveryMode_(safety)) {
    gLists.forEach(function(list) { activeGListIds[list.id] = true; });
  }
  // ensureAutoListMappings_ can append a newly created counterpart.  Refresh
  // the pure lifecycle view without another remote inventory call.
  listLifecycle = classifyListLifecycle_(
    state,
    allGLists.concat(gLists),
    msLists,
    gDefaultList,
    safety
  );
  // A revocation needs a distinct, later fully eligible both-live round before
  // it may establish fresh deletion provenance. Do not recreate proof in the
  // same round that just invalidated it.
  if (!proofRevokedBeforePlanning) recordAutoBothLivePairMeta_(state, listLifecycle, safety);
  alertListFaultsIfAny_(state);

  const gTasksById = {};
  const msTasksById = {};
  const gListByTask = {};
  const msListByTask = {};
  const gTaskInventoryListIds = {};
  const msTaskInventoryListIds = {};
  // This is separate from ordinary task inventory completion.  A correlated
  // recovery is allowed to use an expanded target only when this exact list
  // read completed successfully; all other lists keep their lean snapshot.
  const moveExtensionInventoryListIds = {};
  const unresolvedMoveTargets = unresolvedMoveExtensionTargetListIds_(state);
  const taskCreateExtensionTargets = {};
  if (state.taskCreateBatch && state.taskCreateBatch.direction === 'google_to_microsoft') {
    state.taskCreateBatch.items.forEach(function(item) { taskCreateExtensionTargets[item.destinationListId] = true; });
  }
  let inventoryComplete = true;

  for (const gList of gLists) {
    if (isGListFaulted_(state, gList.id)) continue;
    if (!remainingTimeOk_(startedAt, 90000)) throw new Error('TIME_BUDGET_SNAPSHOT');
    try {
      const tasks = getGTasks_(gList.id);
      gTaskInventoryListIds[gList.id] = true;
      tasks.forEach(function(task) {
        gTasksById[task.id] = task;
        gListByTask[task.id] = gList.id;
      });
    } catch (e) {
      if (isNotFoundError_(e)) {
        inventoryComplete = false;
        markListFault_(state, 'g', gList.id, {
          reason: 'HTTP_404_WHILE_FETCHING_TASKS',
          gListTitle: gList.title || '(Untitled list)',
          // Keep the exact mapped counterpart on the fault.  Repair needs this
          // historical pair to convert ordinary auto provenance into the
          // anti-recreation guard before it removes the mapping.
          msListId: state.listMap[gList.id] || null
        });
        console.error('[ListFault] Got 404 while fetching Google tasks; list isolated: ' + listLabel_(gList.id, gList.title));
        continue;
      }
      throw e;
    }
  }

  const mappedMsIds = Array.from(new Set(Object.keys(state.listMap).map(function(gId) {
    if (!activeGListIds[gId]) return null;
    if (isGListFaulted_(state, gId)) return null;
    const msId = state.listMap[gId];
    if (!msId || isMsListFaulted_(state, msId)) return null;
    // The top-level Microsoft inventory already proved this exact list absent.
    // Do not turn that lifecycle observation into a second, expected 404 from
    // getMsTasks_; only the Google survivor inventory is required this round.
    if (isProvenAutoListDeletionMissingPair_(state, listLifecycle, gId, msId,
      ['microsoft_missing', 'both_missing'])) return null;
    return msId;
  }).filter(Boolean).concat(listLifecycle.pairs.map(function(pair) {
    // A Google-missing custom pair needs the live Microsoft survivor's full
    // task inventory for lifecycle validation.  This is read-only and does
    // not make the absent Google list a normal sync target.
    if (pair.status === 'google_missing' && pair.msLive && pair.deletable) {
      return pair.msListId;
    }
    return null;
  }).filter(Boolean))));

  for (const msListId of mappedMsIds) {
    if (!remainingTimeOk_(startedAt, 90000)) throw new Error('TIME_BUDGET_SNAPSHOT');
    try {
      const includeMoveExtension = !!unresolvedMoveTargets[msListId];
      const includeTaskCreateExtension = !!taskCreateExtensionTargets[msListId];
      const tasks = getMsTasks_(msListId, { includeMoveExtension: includeMoveExtension, includeTaskCreateExtension: includeTaskCreateExtension });
      msTaskInventoryListIds[msListId] = true;
      if (includeMoveExtension) moveExtensionInventoryListIds[msListId] = true;
      tasks.forEach(function(task) {
        msTasksById[task.id] = task;
        msListByTask[task.id] = msListId;
      });
    } catch (e) {
      if (isNotFoundError_(e)) {
        inventoryComplete = false;
        const gListId = Object.keys(state.listMap).find(function(id) {
          return state.listMap[id] === msListId;
        }) || null;
        const gList = gLists.find(function(list) { return list.id === gListId; }) || null;
        markListFault_(state, 'ms', msListId, {
          reason: 'HTTP_404_WHILE_FETCHING_TASKS',
          gListId: gListId,
          gListTitle: gList ? (gList.title || '(Untitled list)') : ''
        });
        console.error('[ListFault] Got 404 while fetching Microsoft tasks; list isolated: ' + listLabel_(msListId, msList && msList.displayName));
        continue;
      }
      throw e;
    }
  }

  alertListFaultsIfAny_(state);
  if (Object.keys(state.listFaults.g).length || Object.keys(state.listFaults.ms).length) {
    inventoryComplete = false;
  }
  return {
    gLists: gLists,
    msLists: msLists,
    gTasksById: gTasksById,
    msTasksById: msTasksById,
    gListByTask: gListByTask,
    msListByTask: msListByTask,
    gTaskInventoryListIds: gTaskInventoryListIds,
    msTaskInventoryListIds: msTaskInventoryListIds,
    moveExtensionInventoryListIds: moveExtensionInventoryListIds,
    activeGListIds: activeGListIds,
    inventoryComplete: inventoryComplete,
    listInventoryComplete: true,
    allGLists: allGLists,
    googleDefaultList: gDefaultList,
    listLifecycle: listLifecycle,
    safety: safety
  };
}

function countAffectedMappings_(state, gListId, msListId) {
  return Object.keys(state.g2m).filter(function(gTaskId) {
    const rec = state.g2m[gTaskId];
    if (!rec) return false;
    if (gListId && rec.gListId === gListId) return true;
    if (msListId && rec.msListId === msListId) return true;
    return false;
  }).length;
}

function deletionJournalIdsForListPair_(state, gListId, msListId) {
  ensureTaskDeletionState_(state);
  ensureTaskMoveState_(state);
  const deleteIds = Object.keys(state.deletionJournal).filter(function(gTaskId) {
    const journal = state.deletionJournal[gTaskId];
    const mapping = state.g2m[gTaskId];
    return !!journal &&
      ((gListId && (journal.gListId === gListId || (mapping && mapping.gListId === gListId))) ||
      (msListId && (journal.msListId === msListId || (mapping && mapping.msListId === msListId))));
  });
  const moveIds = Object.keys(state.taskMoveJournal).filter(function(gTaskId) {
    const journal = state.taskMoveJournal[gTaskId];
    return !!journal && ((gListId && journal.gListId === gListId) ||
      (msListId && (journal.oldMsListId === msListId || journal.targetMsListId === msListId)));
  });
  return Array.from(new Set(deleteIds.concat(moveIds)));
}

function assertNoDeletionJournalForListPair_(state, gListId, msListId) {
  const journalIds = deletionJournalIdsForListPair_(state, gListId, msListId);
  if (journalIds.length) {
    throw new Error('REPAIR_DELETION_JOURNAL_PENDING: Complete or manually inspect the deletion journal before resetting the pair. task=' + journalIds.join(','));
  }
}

function listLifecycleRecordsForPair_(state, gListId, msListId) {
  ensureListDeletionState_(state);
  const key = listPairKey_(gListId, msListId);
  const records = [];
  ['listPairMeta', 'pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts'].forEach(function(field) {
    if (state[field][key]) records.push(field);
  });
  const gTombstone = hasListTombstone_(state, 'g', gListId, null);
  const msTombstone = hasListTombstone_(state, 'ms', msListId, null);
  if (gTombstone || msTombstone) records.push('listTombstones');
  return records;
}

function assertNoListLifecycleForPair_(state, gListId, msListId) {
  // Auto both-live provenance alone is not an unresolved delete intent. A
  // fault repair may reset its mapping, but first turns that metadata into an
  // orphan reservation so the planner cannot recreate the historic survivor.
  const records = listLifecycleRecordsForPair_(state, gListId, msListId)
    .filter(function(record) { return record !== 'listPairMeta'; });
  if (records.length) {
    throw new Error('REPAIR_LIST_LIFECYCLE_PENDING: List-deletion provenance cannot be discarded: ' + records.join(','));
  }
}

function preserveListPairMetaForRepair_(state, gListId, msListId) {
  ensureListDeletionState_(state);
  const key = listPairKey_(gListId, msListId);
  const meta = state.listPairMeta[key];
  if (!meta) return false;
  // This is deliberately a non-delete conflict/guard, not a tombstone: the
  // operator is repairing a fault, not declaring either list deleted. The
  // lifecycle classifier reserves its exact IDs and normalized names even
  // after listMap is removed, preventing an unsafe auto-create on resync.
  state.listDeletionConflicts[key] = {
    at: new Date().toISOString(),
    reason: 'LIST_REPAIR_HISTORIC_PAIR_GUARD',
    gListId: gListId,
    msListId: msListId,
    gTitle: meta.gTitle || '',
    msTitle: meta.msTitle || ''
  };
  delete state.listPairMeta[key];
  return true;
}

function assertNoAnyDeletionJournals_(state, code) {
  ensureTaskDeletionState_(state);
  ensureTaskMoveState_(state);
  ensureListDeletionState_(state);
  if (Object.keys(state.deletionJournal).length || Object.keys(state.taskMoveJournal).length ||
      Object.keys(state.listDeletionJournal).length) {
    throw new Error((code || 'STATE_CHANGE') +
      '_DELETION_JOURNAL_PENDING: A task-deletion, task-move, or list-deletion journal exists; overwrite refused.');
  }
}

function resetListPairing_(state, gListId, msListId) {
  assertNoDeletionJournalForListPair_(state, gListId, msListId);
  assertNoListLifecycleForPair_(state, gListId, msListId);
  preserveListPairMetaForRepair_(state, gListId, msListId);
  Object.keys(state.g2m).forEach(function(gTaskId) {
    const rec = state.g2m[gTaskId];
    if (!rec) return;
    const matchG = gListId && rec.gListId === gListId;
    const matchMs = msListId && rec.msListId === msListId;
    if (matchG || matchMs) {
      removeMapping_(state, gTaskId, rec.msId);
    }
  });
  if (gListId) {
    delete state.listMap[gListId];
    delete state.listFaults.g[gListId];
  }
  if (msListId) {
    Object.keys(state.listMap).forEach(function(id) {
      if (state.listMap[id] === msListId) delete state.listMap[id];
    });
    delete state.listFaults.ms[msListId];
  }
}

function resolveFaultedGoogleListPair_(state, gListId, fault) {
  ensureListDeletionState_(state);
  const candidates = {};
  function add(msListId) {
    if (typeof msListId === 'string' && msListId) candidates[msListId] = true;
  }
  add(fault && fault.msListId);
  add(state.listMap && state.listMap[gListId]);
  Object.keys(state.listPairMeta || {}).forEach(function(key) {
    const meta = state.listPairMeta[key];
    if (meta && meta.gListId === gListId) add(meta.msListId);
  });
  Object.keys(state.listFaults.ms || {}).forEach(function(msListId) {
    const msFault = state.listFaults.ms[msListId];
    if (msFault && msFault.gListId === gListId) add(msListId);
  });
  const ids = Object.keys(candidates).sort();
  if (ids.length > 1) {
    throw new Error('REPAIR_LIST_PAIR_AMBIGUOUS: Google list ' + gListId +
      ' maps to multiple historical Microsoft lists; change refused.');
  }
  return ids.length === 1 ? ids[0] : null;
}
