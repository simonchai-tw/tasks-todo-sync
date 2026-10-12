/* ---------------------------------------------------------------------------
 * Operator exit for a finalize-wedged taskCreateBatch (TASK_CREATE_FINALIZE_MISSING).
 *
 * Incident (2026-10-12, personal production): a microsoft_to_google batch of
 * 25 items reached CLEANUP_PENDING with every entry ACKED, then the Microsoft
 * source tasks were deleted mid-flight.  The finalize guard (sync.gs) refuses
 * to commit a mapping whose source vanished — correct fail-closed behaviour —
 * but there was NO exit: the batch stayed active, ordinary sync stayed fenced
 * (TASK_CREATE_RECOVERY_PENDING) and every trigger round rethrew the same
 * fatal error forever.
 *
 * The existing operator actions (RESOLVE_EXISTING / RELEASE_FOR_REPOST) only
 * serve HELD_* boundary entries, so they cannot unlock an ACKED-complete
 * batch.  This file adds the missing exit, gated on live evidence:
 *
 *   - For every item, BOTH sides are re-read live under the global lock.
 *   - Release is allowed only when every item is one of:
 *       SOURCE_LOST_DEST_ALIVE  (survivor destination reposts via normal flow)
 *       DEST_LOST_SOURCE_ALIVE  (survivor source reposts via normal flow)
 *       BOTH_LOST               (nothing exists anywhere; drop the batch)
 *   - ALIVE+ALIVE means the batch should finalize normally; if it still
 *     throws, a list is faulted or a mapping identity changed — that is a
 *     different incident and stays NOT_SAFE here.
 *   - Any provider read failure is READ_FAIL → NOT_SAFE (transient problems
 *     must never be promoted into an irreversible drop by this action).
 *   - Non-ACKED entries keep their own operator flows and block release.
 *
 * Clearing the batch hands every surviving task back to the ordinary
 * unmapped-create flow (taskCreateBatchCandidates_), which reposts it with
 * fresh dedup machinery.  Nothing is deleted by this action; no content is
 * lost.  The state mutation mirrors applyTaskMoveJournalOperation:
 * normalizeState_ + saveState_ under the lock.
 *
 * Confirmation reuses TASK_CREATE_RELEASE_CONFIRMATION (globals.gs) — the
 * same duplicate-risk acknowledgement RELEASE_FOR_REPOST already requires,
 * because both actions hand a surviving task back to the repost flow.
 * ------------------------------------------------------------------------- */

function taskCreateReleaseReadLive_(kind, listId, taskId) {
  // kind: 'ms' | 'g'.  Returns 'ALIVE' | 'MISSING' | 'READ_FAIL'.
  try {
    const task = kind === 'ms' ? getMsTask_(listId, taskId) : getGTask_(listId, taskId);
    return task && task.id ? 'ALIVE' : 'MISSING';
  } catch (e) {
    if (isNotFoundError_(e)) return 'MISSING';
    return 'READ_FAIL';
  }
}

function classifyTaskCreateBatchRelease_(state) {
  const batch = state.taskCreateBatch;
  const progress = taskCreateProgressRead_(batch);
  const mToG = batch.direction === 'microsoft_to_google';
  const items = [];
  const reasons = [];
  let safe = true;
  batch.items.forEach(function(item, index) {
    const ack = progress.entries[index];
    if (!ack || ack.status !== 'ACKED') {
      safe = false;
      reasons.push('item ' + index + ': entry is ' + (ack ? ack.status : 'missing') +
        '; held entries are owned by previewTaskCreateBatchOperation/applyTaskCreateBatchOperation.');
      items.push({ index: index, verdict: 'ENTRY_NOT_ACKED' });
      return;
    }
    const srcKind = mToG ? 'ms' : 'g';
    const dstKind = mToG ? 'g' : 'ms';
    const srcLive = taskCreateReleaseReadLive_(srcKind, item.sourceListId, item.sourceTaskId);
    const dstLive = taskCreateReleaseReadLive_(dstKind, item.destinationListId, ack.destinationId);
    let verdict;
    if (srcLive === 'READ_FAIL' || dstLive === 'READ_FAIL') {
      verdict = 'READ_FAIL';
      safe = false;
      reasons.push('item ' + index + ': a live read failed; transient provider trouble must not be released.');
    } else if (srcLive === 'ALIVE' && dstLive === 'ALIVE') {
      verdict = 'BOTH_ALIVE';
      safe = false;
      reasons.push('item ' + index + ': both sides alive; the batch should finalize normally. ' +
        'If syncAll still fails, investigate list faults / mapping identity instead of releasing.');
    } else if (srcLive === 'MISSING' && dstLive === 'MISSING') {
      verdict = 'BOTH_LOST';
    } else if (srcLive === 'MISSING') {
      verdict = 'SOURCE_LOST_DEST_ALIVE';
    } else {
      verdict = 'DEST_LOST_SOURCE_ALIVE';
    }
    items.push({ index: index, sourceKind: srcKind, sourceId: item.sourceTaskId,
      sourceLive: srcLive, destinationListId: item.destinationListId,
      destinationId: ack.destinationId, destinationLive: dstLive, verdict: verdict });
  });
  return { batchId: batch.batchId, direction: batch.direction, phase: batch.phase,
    itemCount: batch.items.length, verdict: safe ? 'SAFE' : 'NOT_SAFE',
    reasons: reasons, items: items };
}
