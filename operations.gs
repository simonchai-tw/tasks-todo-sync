function previewOpaqueId_(kind, value) {
  const text = String(value == null ? '' : value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + i), 0x85ebca6b);
  }
  function hex(value) {
    return ('00000000' + (value >>> 0).toString(16)).slice(-8);
  }
  return String(kind || 'id') + '_' + hex(left) + hex(right);
}

function previewHasSnapshotValue_(task, field) {
  if (!task || typeof task !== 'object' ||
      !Object.prototype.hasOwnProperty.call(task, field)) return false;
  const value = task[field];
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== '' && value !== false;
}

// This deliberately looks only at the task object already loaded by dry-run.
// Do not add Graph calls here: relationship contents are reported as
// uninspected rather than guessed.

function moveMetadataLossPreview_(msTask) {
  const detected = [];
  if (msTask && typeof msTask === 'object') {
    if ((Object.prototype.hasOwnProperty.call(msTask, 'isReminderOn') &&
        msTask.isReminderOn === true) || previewHasSnapshotValue_(msTask, 'reminderDateTime')) {
      detected.push('reminder');
    }
    if (previewHasSnapshotValue_(msTask, 'recurrence')) detected.push('recurrence');
    if (previewHasSnapshotValue_(msTask, 'categories')) detected.push('categories');
    if (previewHasSnapshotValue_(msTask, 'startDateTime')) detected.push('startDateTime');
    if (previewHasSnapshotValue_(msTask, 'importance') &&
        String(msTask.importance).toLowerCase() !== 'normal') {
      detected.push('importance');
    }
    if (previewHasSnapshotValue_(msTask, 'status') &&
        ['notstarted', 'completed'].indexOf(String(msTask.status).toLowerCase()) < 0) {
      detected.push('statusDetail');
    }
    if (Object.prototype.hasOwnProperty.call(msTask, 'hasAttachments') &&
        msTask.hasAttachments === true) {
      detected.push('hasAttachments');
    }
    if (previewHasSnapshotValue_(msTask, 'completedDateTime')) {
      detected.push('completedDateTime');
    }
  }
  return {
    detectedNonPreserved: detected.sort(),
    // No relationship endpoint or $expand request is made by dryRunReport.
    uninspectedRelationships: ['attachmentDetails', 'checklistItems', 'linkedResources', 'extensions'],
    detectionScope: {
      source: 'CURRENT_MICROSOFT_TASK_SNAPSHOT_ONLY',
      microsoftTaskSnapshot: msTask ? 'PRESENT' : 'MISSING',
      extraMicrosoftRequests: false,
      valuesIncludedInReport: false,
      relationshipExpansion: false
    }
  };
}

function addPendingMovePreview_(pendingMoves, details) {
  const metadata = moveMetadataLossPreview_(details.msTask || null);
  pendingMoves.push({
    status: details.status,
    googleTaskId: previewOpaqueId_('gTask', details.gId),
    sourceGoogleListId: previewOpaqueId_('gList', details.sourceGoogleListId),
    targetGoogleListId: previewOpaqueId_('gList', details.targetGoogleListId),
    sourceMicrosoftTaskId: previewOpaqueId_('msTask', details.sourceMicrosoftTaskId),
    replacementMicrosoftTaskId: details.replacementMicrosoftTaskId
      ? previewOpaqueId_('msTask', details.replacementMicrosoftTaskId) : null,
    sourceMicrosoftListId: previewOpaqueId_('msList', details.sourceMicrosoftListId),
    targetMicrosoftListId: previewOpaqueId_('msList', details.targetMicrosoftListId),
    recoveryPhase: details.recoveryPhase || null,
    identityChanges: [
      'MICROSOFT_TASK_ID_RECREATED',
      'MICROSOFT_CREATED_DATETIME_REGENERATED',
      'MICROSOFT_LIST_MEMBERSHIP_CHANGED'
    ],
    metadataLoss: {
      detectedNonPreserved: metadata.detectedNonPreserved,
      uninspectedRelationships: metadata.uninspectedRelationships,
      detectionScope: metadata.detectionScope
    }
  });
}

function pendingMoveSummary_(pendingMoves) {
  const byStatus = {
    READY: 0,
    BLOCKED_SWITCH_OFF: 0,
    RECOVERY: 0
  };
  const detected = {};
  let withDetectedNonPreserved = 0;
  let withUninspectedRelationships = 0;
  let microsoftTaskSnapshotsPresent = 0;
  pendingMoves.forEach(function(move) {
    if (Object.prototype.hasOwnProperty.call(byStatus, move.status)) {
      byStatus[move.status] += 1;
    }
    if (move.metadataLoss.detectedNonPreserved.length) withDetectedNonPreserved += 1;
    move.metadataLoss.detectedNonPreserved.forEach(function(field) { detected[field] = true; });
    if (move.metadataLoss.uninspectedRelationships.length) withUninspectedRelationships += 1;
    if (move.metadataLoss.detectionScope.microsoftTaskSnapshot === 'PRESENT') {
      microsoftTaskSnapshotsPresent += 1;
    }
  });
  return {
    total: pendingMoves.length,
    byStatus: byStatus,
    movesWithDetectedNonPreserved: withDetectedNonPreserved,
    detectedNonPreserved: Object.keys(detected).sort(),
    movesWithUninspectedRelationships: withUninspectedRelationships,
    microsoftTaskSnapshotsPresent: microsoftTaskSnapshotsPresent,
    microsoftTaskSnapshotsMissing: pendingMoves.length - microsoftTaskSnapshotsPresent,
    detectionScope: 'CURRENT_MICROSOFT_TASK_SNAPSHOT_ONLY_NO_EXTRA_GRAPH_REQUESTS'
  };
}

function sortPendingMovePreviews_(pendingMoves) {
  pendingMoves.sort(function(left, right) {
    const leftKey = left.googleTaskId + '\u0000' + left.sourceMicrosoftTaskId;
    const rightKey = right.googleTaskId + '\u0000' + right.sourceMicrosoftTaskId;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function finalizePendingMovePreview_(pendingMoves) {
  sortPendingMovePreviews_(pendingMoves);
  return pendingMoveSummary_(pendingMoves);
}

function appendTaskMovePreview_(state, inventory, safety, actions, warnings, pendingMoves) {
  pendingMoves = pendingMoves || [];
  const journals = state.taskMoveJournal || {};
  // A journal represents the same logical move as its mapping. Report it once
  // as recovery, never again as a new candidate.
  Object.keys(journals).sort().forEach(function(gId) {
    const journal = journals[gId];
    const rec = state.g2m[gId] || {};
    const sourceMsId = journal.oldMsId || rec.msId || '';
    const replacementMsId = journal.newMsId || null;
    // Recovery metadata belongs to the old/source task. The replacement can
    // show what was recreated, not what source-only metadata was at risk.
    const msTask = inventory.msTasksById[sourceMsId] || null;
    addPendingMovePreview_(pendingMoves, {
      status: 'RECOVERY',
      gId: gId,
      sourceGoogleListId: rec.gListId || journal.gListId || '',
      targetGoogleListId: journal.gListId || rec.gListId || '',
      sourceMicrosoftTaskId: sourceMsId,
      replacementMicrosoftTaskId: replacementMsId,
      sourceMicrosoftListId: journal.oldMsListId || rec.msListId || '',
      targetMicrosoftListId: journal.targetMsListId || rec.msListId || '',
      recoveryPhase: journal.phase || 'unknown',
      msTask: msTask
    });
    warnings.push('[WARNING] Cross-list move still awaiting recovery: ' + gId +
      ' phase=' + journal.phase + (journal.lastBlockedReason
        ? ' reason=' + journal.lastBlockedReason : ''));
  });
  Object.keys(state.g2m || {}).sort().forEach(function(gId) {
    if (journals[gId]) return;
    const rec = state.g2m[gId];
    const gTask = inventory.gTasksById[gId];
    const msTask = inventory.msTasksById[rec.msId];
    if (gTask) {
      const currentGListId = inventory.gListByTask[gId];
      const targetMsListId = state.listMap[currentGListId];
      if (targetMsListId && targetMsListId !== rec.msListId) {
        const label = taskLabel_(gId, gTask.title);
        addPendingMovePreview_(pendingMoves, {
          status: safety.allowTaskMoves ? 'READY' : 'BLOCKED_SWITCH_OFF',
          gId: gId,
          sourceGoogleListId: rec.gListId,
          targetGoogleListId: currentGListId,
          sourceMicrosoftTaskId: rec.msId,
          replacementMicrosoftTaskId: null,
          sourceMicrosoftListId: rec.msListId,
          targetMicrosoftListId: targetMsListId,
          recoveryPhase: null,
          msTask: msTask
        });
        if (safety.allowTaskMoves) {
          actions.push('[ACTION] Google cross-list move will recreate the Microsoft counterpart: ' + label +
            ' (' + rec.msListId + ' → ' + targetMsListId + ')');
        } else {
          warnings.push('[WARNING] Google cross-list move is currently blocked: ' + label);
        }
      }
    }
    if (msTask && inventory.msListByTask[rec.msId] &&
        inventory.msListByTask[rec.msId] !== rec.msListId) {
      warnings.push('[WARNING] Microsoft task with the same ID appears in different lists; the next round will fail closed: ' +
        taskLabel_(rec.msId, msTask.title));
    }
  });
  sortPendingMovePreviews_(pendingMoves);
  return pendingMoves;
}
