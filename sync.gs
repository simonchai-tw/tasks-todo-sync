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

function createUnmapped_(state, snap, startedAt) {
  for (const gId of Object.keys(snap.gTasksById)) {
    if (!remainingTimeOk_(startedAt, 30000)) throw new Error('TIME_BUDGET_CREATE');
    if (state.g2m[gId] || state.tombstones.g[gId] || state.deletionJournal[gId] ||
        (state.taskMoveJournal && state.taskMoveJournal[gId])) continue;
    const gTask = snap.gTasksById[gId];
    const gListId = snap.gListByTask[gId];
    if (isGListFaulted_(state, gListId)) continue;
    const msListId = state.listMap[gListId];
    if (!msListId || isMsListFaulted_(state, msListId)) continue;
    if (isListPairReserved_(snap, gListId, msListId)) continue;
    const msTask = createMsTask_(msListId, msPayloadFromGoogle_(gTask, 'create'));
    putMapping_(state, gTask, gListId, msTask, msListId);
    snap.msTasksById[msTask.id] = msTask;
    snap.msListByTask[msTask.id] = msListId;
    console.log('[Create] Google → MS: ' + taskLabel_(gId, gTask.title));
  }
  for (const msId of Object.keys(snap.msTasksById)) {
    if (!remainingTimeOk_(startedAt, 30000)) throw new Error('TIME_BUDGET_CREATE');
    if (state.m2g[msId] || state.tombstones.m[msId] ||
        hasDeletionJournalForMsTask_(state, msId) || hasMoveJournalForMsTask_(state, msId)) continue;
    const msTask = snap.msTasksById[msId];
    const msListId = snap.msListByTask[msId];
    if (isMsListFaulted_(state, msListId)) continue;
    const gListId = Object.keys(state.listMap).find(function(id) {
      return state.listMap[id] === msListId &&
        (!snap.activeGListIds || !!snap.activeGListIds[id]) &&
        !isGListFaulted_(state, id);
    });
    if (!gListId) continue;
    if (isListPairReserved_(snap, gListId, msListId)) continue;
    const gTask = createGTask_(gListId, googlePayloadFromMs_(msTask, 'create'));
    putMapping_(state, gTask, gListId, msTask, msListId);
    console.log('[Create] MS → Google: ' + taskLabel_(msId, msTask.title));
  }
}
