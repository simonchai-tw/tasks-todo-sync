function reconcileMapped_(state, snap, startedAt, roundId, progress) {
  roundId = roundId || deletionRoundId_(startedAt);
  progress = progress || { invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} };
  progress.invalidatedCandidateTaskIds = progress.invalidatedCandidateTaskIds || {};
  progress.discardCandidateTaskIds = progress.discardCandidateTaskIds || {};
  ensureTaskDeletionState_(state);
  const allowDeletions = !!(snap.safety && snap.safety.allowDeletions);
  if (!allowDeletions) {
    pauseTaskDeletions_(state);
    // This is an operator safety switch, not an inventory decision.  A
    // prepared intent must not survive a disabled run merely because snapshot
    // collection later faults or times out.
    pausePreparedDeletionJournals_(state);
  }
  const mappedGIds = Object.keys(state.g2m);
  for (const gId of mappedGIds) {
    if (!remainingTimeOk_(startedAt, 45000)) throw new Error('TIME_BUDGET_RECONCILE');
    const rec = state.g2m[gId];
    if (!rec || !rec.msId) {
      delete state.g2m[gId];
      continue;
    }
    if (isListPairReserved_(snap, rec.gListId, rec.msListId)) {
      // A list lifecycle candidate owns this pair.  Ordinary task deletion
      // candidates are cleared so they cannot race a later list finalization;
      // durable task journals remain a hard block for list deletion.
      clearPendingTaskDeletion_(state, gId);
      continue;
    }
    const pairBlockReason = taskDeletionPairBlockReason_(state, snap, rec);
    if (pairBlockReason) {
      blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress);
      continue;
    }
    const msId = rec.msId;
    const gTask = snap.gTasksById[gId] || null;
    const msTask = snap.msTasksById[msId] || null;
    if (msTask && snap.msListByTask[msId] && snap.msListByTask[msId] !== rec.msListId) {
      blockTaskMove_(state, gId, rec, state.taskMoveJournal[gId] || null,
        'MOVE_MICROSOFT_SAME_ID_LIST_CHANGED');
      continue;
    }
    const currentGListId = gTask ? snap.gListByTask[gId] : rec.gListId;
    const targetMsListId = state.listMap[currentGListId];

    const moveJournal = state.taskMoveJournal && state.taskMoveJournal[gId];
    if (moveJournal && !gTask) {
      blockTaskMove_(state, gId, rec, moveJournal, 'MOVE_GOOGLE_SOURCE_MISSING');
      continue;
    }
    if (gTask && moveJournal) {
      resyncGoogleTaskMove_(
        state, snap, gId, gTask, rec, currentGListId,
        moveJournal.targetMsListId, progress, roundId
      );
      continue;
    }
    if (gTask && targetMsListId && targetMsListId !== rec.msListId) {
      resyncGoogleTaskMove_(
        state, snap, gId, gTask, rec, currentGListId, targetMsListId, progress, roundId
      );
      continue;
    }

    const missingSide = missingSide_(gTask, msTask);
    if (missingSide) {
      if (missingSide === 'google' && msTask) {
        if (state.listMap[rec.gListId] !== rec.msListId) {
          markListFault_(state, 'g', rec.gListId, {
            reason: 'GOOGLE_LIST_MAPPING_CHANGED',
            msListId: rec.msListId
          });
          blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress);
          continue;
        }
      }
      if (missingSide === 'microsoft' && gTask) {
        if (!targetMsListId || targetMsListId !== rec.msListId) {
          markListFault_(state, 'ms', rec.msListId, {
            reason: 'MS_TASK_MISSING_AFTER_LIST_CHANGE',
            gListId: currentGListId
          });
          blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress);
          continue;
        }
      }
      if (!allowDeletions) {
        if (missingSide === 'google') {
          console.warn('[DeleteBlocked] Google task is missing; SYNC_ALLOW_DELETIONS=false, retaining Microsoft task: ' + taskLabel_(msId, null));
        } else if (missingSide === 'microsoft') {
          console.warn('[DeleteBlocked] Microsoft task is missing; SYNC_ALLOW_DELETIONS=false, retaining Google task: ' + taskLabel_(gId, gTask.title));
        } else {
          console.warn('[DeleteBlocked] Both tasks are missing; SYNC_ALLOW_DELETIONS=false, retaining mapping and not creating a tombstone: ' + taskLabel_(gId, null));
        }
      } else {
        observeTaskDeletionCandidate_(state, rec, gId, missingSide, snap, roundId, progress);
      }
      continue;
    }
    // The previously missing task has returned. A stale candidate must never
    // survive a both-live round and make a later independent disappearance look
    // like a second confirmation. A prepared journal is quarantined as a changed
    // source scenario; ordinary candidates/conflicts are simply resolved.
    if (state.deletionJournal[gId]) {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      recordTaskDeletionConflict_(state, gId, rec, 'DELETE_SOURCE_REAPPEARED');
    } else {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      clearPendingTaskDeletion_(state, gId);
      clearTaskDeletionConflict_(state, gId);
    }
    const gChanged = epoch_(gTask.updated) > epoch_(rec.gUpdated);
    const mChanged = epoch_(msTask.lastModifiedDateTime) > epoch_(rec.msUpdated);
    if (gChanged && !mChanged) {
      const payload = msUpdatePayloadFromGoogle_(gTask, msTask);
      const updatedMs = Object.keys(payload).length
        ? updateMsTask_(rec.msListId, msId, payload)
        : msTask;
      putMapping_(state, gTask, currentGListId, updatedMs, rec.msListId);
    } else if (!gChanged && mChanged) {
      const payload = googleUpdatePayloadFromMs_(msTask, gTask);
      const updatedG = Object.keys(payload).length
        ? updateGTask_(rec.gListId, gId, payload)
        : gTask;
      putMapping_(state, updatedG, rec.gListId, msTask, rec.msListId);
    } else if (gChanged && mChanged) {
      if (epoch_(gTask.updated) >= epoch_(msTask.lastModifiedDateTime)) {
        const payload = msUpdatePayloadFromGoogle_(gTask, msTask);
        const updatedMs = Object.keys(payload).length
          ? updateMsTask_(rec.msListId, msId, payload)
          : msTask;
        putMapping_(state, gTask, currentGListId, updatedMs, rec.msListId);
        console.warn('[Conflict] LWW selected Google: ' + taskLabel_(gId, gTask.title));
      } else {
        const payload = googleUpdatePayloadFromMs_(msTask, gTask);
        const updatedG = Object.keys(payload).length
          ? updateGTask_(rec.gListId, gId, payload)
          : gTask;
        putMapping_(state, updatedG, rec.gListId, msTask, rec.msListId);
        console.warn('[Conflict] LWW selected Microsoft: ' + taskLabel_(msId, msTask.title));
      }
    } else {
      rec.gListId = currentGListId;
    }
  }
}

function taskCreateProgressRead_(batch) {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(TASK_CREATE_PROGRESS_KEY);
  if (!raw) return { batchId: batch ? batch.batchId : null, boundary: null, entries: {} };
  let progress;
  try { progress = JSON.parse(raw); } catch (e) { throw new Error('TASK_CREATE_PROGRESS_MALFORMED'); }
  if (!progress || typeof progress !== 'object' || progress.batchId !== (batch && batch.batchId) ||
      !progress.entries || typeof progress.entries !== 'object' || Array.isArray(progress.entries)) {
    if (!batch) { props.deleteProperty(TASK_CREATE_PROGRESS_KEY); return { batchId: null, boundary: null, entries: {} }; }
    throw new Error('TASK_CREATE_PROGRESS_MISMATCH');
  }
  const allowed = ['batchId', 'boundary', 'entries'];
  if (Object.keys(progress).some(function(key) { return allowed.indexOf(key) < 0; }) ||
      (progress.boundary !== undefined && progress.boundary !== null &&
       (!Number.isInteger(progress.boundary) || progress.boundary < 0 || progress.boundary >= batch.items.length))) {
    throw new Error('TASK_CREATE_PROGRESS_MALFORMED');
  }
  const destinationIds = {};
  Object.keys(progress.entries).forEach(function(key) {
    if (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= batch.items.length) throw new Error('TASK_CREATE_PROGRESS_MALFORMED');
    const entry = progress.entries[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(function(field) { return ['status', 'destinationId'].indexOf(field) < 0; }) ||
        ['ACKED', 'HELD_ZERO', 'HELD_MULTI', 'REPOST_ALLOWED'].indexOf(entry.status) < 0 ||
        (entry.status === 'ACKED' && (typeof entry.destinationId !== 'string' || !entry.destinationId)) ||
        (entry.status !== 'ACKED' && entry.destinationId !== undefined) ||
        entry.status === 'REPOST_ALLOWED' && progress.boundary !== undefined && progress.boundary !== null) {
      throw new Error('TASK_CREATE_PROGRESS_MALFORMED');
    }
    if (entry.status === 'ACKED') {
      if (destinationIds[entry.destinationId]) throw new Error('TASK_CREATE_PROGRESS_MALFORMED');
      destinationIds[entry.destinationId] = true;
    }
  });
  return progress;
}

function taskCreateProgressWrite_(progress) {
  const props = PropertiesService.getUserProperties();
  const encoded = JSON.stringify(progress);
  props.setProperty(TASK_CREATE_PROGRESS_KEY, encoded);
  if (props.getProperty(TASK_CREATE_PROGRESS_KEY) !== encoded) throw new Error('TASK_CREATE_PROGRESS_WRITE_FAILED');
}

function taskCreateProgressClear_() {
  const props = PropertiesService.getUserProperties();
  props.deleteProperty(TASK_CREATE_PROGRESS_KEY);
  if (props.getProperty(TASK_CREATE_PROGRESS_KEY) !== null) throw new Error('TASK_CREATE_PROGRESS_DELETE_FAILED');
}

function taskCreateRequireTime_(startedAt) {
  if (!remainingTimeOk_(startedAt, 30000)) throw new Error('TIME_BUDGET_CREATE');
}

function parseTaskCreateOperation_(requirePreviewToken) {
  const raw = PropertiesService.getScriptProperties().getProperty(TASK_CREATE_OPERATION_PROPERTY);
  if (!raw) throw new Error('TASK_CREATE_OPERATION_MISSING: Set SYNC_TASK_CREATE_OPERATION_JSON.');
  let operation;
  try { operation = JSON.parse(raw); } catch (e) { throw new Error('TASK_CREATE_OPERATION_INVALID_JSON'); }
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('TASK_CREATE_OPERATION_INVALID');
  const allowed = ['action', 'batchId', 'index', 'destinationId', 'confirmation', 'previewToken'];
  if (Object.keys(operation).some(function(key) { return allowed.indexOf(key) < 0; }) ||
      ['RESOLVE_EXISTING', 'RELEASE_FOR_REPOST'].indexOf(operation.action) < 0 ||
      typeof operation.batchId !== 'string' || !operation.batchId || !Number.isInteger(operation.index) || operation.index < 0) {
    throw new Error('TASK_CREATE_OPERATION_INVALID: action, batchId, and index are required.');
  }
  if (operation.action === 'RESOLVE_EXISTING' && (typeof operation.destinationId !== 'string' || !operation.destinationId)) {
    throw new Error('TASK_CREATE_OPERATION_INVALID: RESOLVE_EXISTING requires destinationId.');
  }
  if (operation.action === 'RELEASE_FOR_REPOST' && operation.confirmation !== TASK_CREATE_RELEASE_CONFIRMATION) {
    throw new Error('TASK_CREATE_OPERATION_CONFIRMATION_REQUIRED: explicit duplicate-risk confirmation is required.');
  }
  if (requirePreviewToken && (typeof operation.previewToken !== 'string' || !operation.previewToken)) {
    throw new Error('TASK_CREATE_OPERATION_PREVIEW_TOKEN_REQUIRED: Preview first, then write previewToken back.');
  }
  return operation;
}

function taskCreateOperationEntry_(state, operation) {
  const batch = state.taskCreateBatch;
  if (!batch || batch.batchId !== operation.batchId) throw new Error('TASK_CREATE_OPERATION_BATCH_NOT_FOUND');
  if (operation.index >= batch.items.length) throw new Error('TASK_CREATE_OPERATION_INDEX_INVALID');
  return { batch: batch, item: batch.items[operation.index], index: operation.index };
}

function taskCreateOperationEvidence_(entry) {
  const batch = entry.batch, item = entry.item;
  let tasks;
  try {
    tasks = batch.direction === 'google_to_microsoft'
      ? getMsTasks_(item.destinationListId, { includeTaskCreateExtension: true })
      : getGTasks_(item.destinationListId);
  } catch (e) {
    throw new Error('TASK_CREATE_OPERATION_INVENTORY_INCOMPLETE');
  }
  const candidates = (tasks || []).filter(function(task) {
    if (batch.direction === 'google_to_microsoft') {
      return Array.isArray(task.extensions) && task.extensions.some(function(ext) {
        return ext && ext.extensionName === TASK_CREATE_EXTENSION_NAME && ext.correlationId === item.uuid &&
          TASK_CREATE_EXTENSION_IDS.indexOf(ext.id) >= 0;
      });
    }
    return String(task.notes || '').indexOf(item.sentinel) >= 0;
  });
  return { inventoryComplete: true, candidateIds: candidates.map(function(task) { return task.id; }).sort() };
}

function taskCreateOperationDigest_(operation, entry, evidence) {
  return previewOpaqueId_('taskCreateOperation', JSON.stringify({
    action: operation.action, batchId: operation.batchId, index: operation.index,
    destinationId: operation.destinationId || null, confirmation: operation.confirmation || null,
    item: entry.item, evidence: evidence
  }));
}

function taskCreateBatchCandidates_(state, snap) {
  const result = [];
  Object.keys(snap.gTasksById || {}).sort().forEach(function(gId) {
    if (state.g2m[gId] || state.tombstones.g[gId] || state.deletionJournal[gId] || state.taskMoveJournal[gId]) return;
    const listId = snap.gListByTask[gId], destination = state.listMap[listId];
    if (listId && destination && !isGListFaulted_(state, listId) && !isMsListFaulted_(state, destination) &&
        !isListPairReserved_(snap, listId, destination)) {
      result.push({ sourceListId: listId, sourceTaskId: gId, destinationListId: destination,
        sourceTask: snap.gTasksById[gId], direction: 'google_to_microsoft' });
    }
  });
  Object.keys(snap.msTasksById || {}).sort().forEach(function(msId) {
    if (state.m2g[msId] || state.tombstones.m[msId] || hasDeletionJournalForMsTask_(state, msId) || hasMoveJournalForMsTask_(state, msId)) return;
    const msListId = snap.msListByTask[msId];
    const gListId = Object.keys(state.listMap).find(function(id) {
      return state.listMap[id] === msListId && (!snap.activeGListIds || !!snap.activeGListIds[id]) && !isGListFaulted_(state, id);
    });
    if (gListId && !isMsListFaulted_(state, msListId) && !isListPairReserved_(snap, gListId, msListId)) {
      result.push({ sourceListId: msListId, sourceTaskId: msId, destinationListId: gListId,
        sourceTask: snap.msTasksById[msId], direction: 'microsoft_to_google' });
    }
  });
  return result;
}

function createUnmappedBatch_(state, snap, startedAt) {
  if (!remainingTimeOk_(startedAt, TASK_CREATE_BATCH_START_RESERVE_MS)) throw new Error('TIME_BUDGET_CREATE');
  const existing = state.taskCreateBatch;
  let batch = existing;
  if (!batch) {
    const candidates = taskCreateBatchCandidates_(state, snap).slice(0, TASK_CREATE_BATCH_SIZE);
    if (!candidates.length) { taskCreateProgressRead_(null); return; }
    const direction = candidates[0].direction;
    const items = candidates.filter(function(candidate) { return candidate.direction === direction; }).slice(0, TASK_CREATE_BATCH_SIZE).map(function(candidate) {
      const uuid = newMoveCorrelationId_();
      const payload = candidate.direction === 'google_to_microsoft'
        ? msPayloadFromGoogle_(candidate.sourceTask, 'create')
        : googlePayloadFromMs_(candidate.sourceTask, 'create');
      const item = { uuid: uuid, sourceListId: candidate.sourceListId, sourceTaskId: candidate.sourceTaskId,
        destinationListId: candidate.destinationListId, sourceFingerprint: stateDigest_(JSON.stringify(payload)),
        payloadJson: '', sentinel: '', originalGoogleNotes: '' };
      if (candidate.direction === 'google_to_microsoft') {
        payload.extensions = [{ '@odata.type': 'microsoft.graph.openTypeExtension', extensionName: TASK_CREATE_EXTENSION_NAME, correlationId: uuid }];
      } else {
        item.sentinel = '\n\n<!-- tasks-todo-sync-create:' + uuid + ' -->';
        item.originalGoogleNotes = String(payload.notes == null ? '' : payload.notes);
        payload.notes = item.originalGoogleNotes + item.sentinel;
      }
      item.payloadJson = JSON.stringify(payload);
      return item;
    });
    batch = { batchId: newMoveCorrelationId_(), direction: direction, phase: 'PREPARED',
      items: items, preparedAt: new Date().toISOString() };
    state.taskCreateBatch = batch;
    persistSyncState_(state);
    taskCreateProgressClear_();
  }
  const progress = taskCreateProgressRead_(batch);
  const destinations = {};
  let cleanupPending = batch.phase === 'CLEANUP_PENDING';
  for (let index = 0; index < batch.items.length; index++) {
    const item = batch.items[index];
    let ack = progress.entries[index];
    if (ack && ack.status === 'REPOST_ALLOWED') {
      delete progress.entries[index];
      delete progress.boundary;
      taskCreateProgressWrite_(progress);
      ack = null;
    }
    if (ack && (ack.status === 'HELD_ZERO' || ack.status === 'HELD_MULTI')) {
      delete progress.entries[index];
      progress.boundary = index;
      taskCreateProgressWrite_(progress);
      ack = null;
    }
    if (!ack) {
      if (progress.boundary === index) {
        taskCreateRequireTime_(startedAt);
        const recoveryMsTasks = batch.direction === 'google_to_microsoft'
          ? getMsTasks_(item.destinationListId, { includeTaskCreateExtension: true }) : null;
        const recoveryMsById = recoveryMsTasks ? recoveryMsTasks.reduce(function(result, task) { result[task.id] = task; return result; }, {}) : snap.msTasksById;
        const recoveryMsListById = recoveryMsTasks ? recoveryMsTasks.reduce(function(result, task) { result[task.id] = item.destinationListId; return result; }, {}) : snap.msListByTask;
        const candidates = batch.direction === 'google_to_microsoft'
          ? Object.keys(recoveryMsById || {}).filter(function(id) {
            const task = recoveryMsById[id];
            return recoveryMsListById[id] === item.destinationListId && Array.isArray(task.extensions) && task.extensions.some(function(ext) {
              return ext && ext.extensionName === TASK_CREATE_EXTENSION_NAME && ext.correlationId === item.uuid &&
                TASK_CREATE_EXTENSION_IDS.indexOf(ext.id) >= 0;
            });
          })
          : Object.keys(snap.gTasksById || {}).filter(function(id) {
            const task = snap.gTasksById[id];
            return snap.gListByTask[id] === item.destinationListId && String(task.notes || '').indexOf(item.sentinel) >= 0;
          });
        if (candidates.length === 1) {
          const destinationId = candidates[0];
          progress.entries[index] = { status: 'ACKED', destinationId: destinationId };
          taskCreateProgressWrite_(progress);
          destinations[index] = batch.direction === 'google_to_microsoft'
            ? recoveryMsById[destinationId] : snap.gTasksById[destinationId];
          if (batch.direction === 'google_to_microsoft') {
            snap.msTasksById[destinationId] = destinations[index];
            snap.msListByTask[destinationId] = item.destinationListId;
          } else {
            snap.gTasksById[destinationId] = destinations[index];
            snap.gListByTask[destinationId] = item.destinationListId;
          }
          continue;
        }
        progress.entries[index] = { status: candidates.length ? 'HELD_MULTI' : 'HELD_ZERO' };
        taskCreateProgressWrite_(progress);
        return;
      }
      if (!remainingTimeOk_(startedAt, TASK_CREATE_BATCH_START_RESERVE_MS)) throw new Error('TIME_BUDGET_CREATE');
      progress.boundary = index;
      taskCreateProgressWrite_(progress);
      taskCreateRequireTime_(startedAt);
      let created;
      try { created = batch.direction === 'google_to_microsoft'
        ? createMsTask_(item.destinationListId, JSON.parse(item.payloadJson))
        : createGTask_(item.destinationListId, JSON.parse(item.payloadJson));
      } catch (e) { throw e; }
      if (!created || !created.id) return;
      progress.entries[index] = { status: 'ACKED', destinationId: created.id };
      delete progress.boundary;
      taskCreateProgressWrite_(progress);
      destinations[index] = created;
      if (batch.direction === 'google_to_microsoft') {
        snap.msTasksById[created.id] = created;
        snap.msListByTask[created.id] = item.destinationListId;
      } else {
        snap.gTasksById[created.id] = created;
        snap.gListByTask[created.id] = item.destinationListId;
      }
    } else if (ack.status === 'ACKED') {
      taskCreateRequireTime_(startedAt);
      destinations[index] = batch.direction === 'google_to_microsoft'
        ? (snap.msTasksById[ack.destinationId] || getMsTask_(item.destinationListId, ack.destinationId))
        : (snap.gTasksById[ack.destinationId] || getGTasks_(item.destinationListId).find(function(task) {
          return task.id === ack.destinationId;
        }));
      if (!destinations[index]) return;
    } else return;
  }
  if (batch.direction === 'microsoft_to_google' && !cleanupPending) {
    batch.phase = 'CLEANUP_PENDING';
    persistSyncState_(state);
    cleanupPending = true;
  }
  if (cleanupPending) {
    for (let index = 0; index < batch.items.length; index++) {
      const item = batch.items[index], ack = progress.entries[index];
      if (!ack || ack.status !== 'ACKED') return;
      taskCreateRequireTime_(startedAt);
      const task = getGTask_(item.destinationListId, ack.destinationId);
      if (!task) return;
      const notes = String(task.notes == null ? '' : task.notes);
      const first = notes.indexOf(item.sentinel), second = notes.indexOf(item.sentinel, first + item.sentinel.length);
      if (second >= 0) { progress.entries[index] = { status: 'HELD_MULTI' }; taskCreateProgressWrite_(progress); return; }
      if (first >= 0) {
        taskCreateRequireTime_(startedAt);
        updateGTask_(item.destinationListId, ack.destinationId, { notes: notes.slice(0, first) + notes.slice(first + item.sentinel.length) });
        taskCreateRequireTime_(startedAt);
        const verified = getGTask_(item.destinationListId, ack.destinationId);
        if (!verified || String(verified.notes || '').indexOf(item.sentinel) >= 0) return;
        snap.gTasksById[ack.destinationId] = verified;
        snap.gListByTask[ack.destinationId] = item.destinationListId;
      }
    }
  }
  batch.items.forEach(function(item, index) {
    const ack = progress.entries[index];
    let source = batch.direction === 'google_to_microsoft' ? snap.gTasksById[item.sourceTaskId] : snap.gTasksById[ack.destinationId];
    let destination = batch.direction === 'google_to_microsoft' ? destinations[index] : snap.msTasksById[item.sourceTaskId];
    if (!source || !destination) throw new Error('TASK_CREATE_FINALIZE_MISSING: source or destination disappeared; ownership preserved.');
    const gListId = batch.direction === 'google_to_microsoft' ? item.sourceListId : item.destinationListId;
    const msListId = batch.direction === 'google_to_microsoft' ? item.destinationListId : item.sourceListId;
    if (snap.gListByTask[source.id] !== gListId || snap.msListByTask[destination.id] !== msListId || state.listMap[gListId] !== msListId) {
      throw new Error('TASK_CREATE_FINALIZE_LIST_MISMATCH: source/destination list identity changed; ownership preserved.');
    }
    const currentFingerprint = stateDigest_(JSON.stringify(batch.direction === 'google_to_microsoft'
      ? msPayloadFromGoogle_(source, 'create') : googlePayloadFromMs_(destination, 'create')));
    if (currentFingerprint !== item.sourceFingerprint) {
      taskCreateRequireTime_(startedAt);
      const updated = batch.direction === 'google_to_microsoft'
        ? updateMsTask_(msListId, destination.id, msUpdatePayloadFromGoogle_(source, destination))
        : updateGTask_(gListId, source.id, googlePayloadFromMs_(destination, 'update'));
      taskCreateRequireTime_(startedAt);
      const verified = batch.direction === 'google_to_microsoft'
        ? getMsTask_(msListId, destination.id) : getGTask_(gListId, source.id);
      if (!updated || !verified) throw new Error('TASK_CREATE_FINALIZE_UPDATE_FAILED: known destination could not be verified.');
      if (batch.direction === 'google_to_microsoft') {
        destinations[index] = verified;
        snap.msTasksById[destination.id] = verified;
        destination = verified;
      } else {
        snap.gTasksById[source.id] = verified;
        source = verified;
      }
    }
    putMapping_(state, source, gListId, destination, msListId);
  });
  SYNC_TASK_CREATE_BATCH_PENDING_STATE_ = JSON.parse(JSON.stringify(batch));
  state.taskCreateBatch = null;
  SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_ = true;
}

function createUnmapped_(state, snap, startedAt) {
  if (SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_) return;
  return createUnmappedBatch_(state, snap, startedAt);
}
