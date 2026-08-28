# Cross-list move E2E validation

This runbook validates cross-list moves against disposable data. Fresh projects enable the feature after bounded two-direction real-account validation, but movement still uses guarded delete-and-recreate semantics and may not preserve Microsoft-only metadata. Keep this runbook separate from valuable personal data: do not point it at valuable lists, and do not intentionally create a real Microsoft Graph 429. Fault-injection tests cover throttling and interrupted responses locally.

## Safety boundary

Use a separate Google account and Microsoft account when practical. If that is not possible, use uniquely named disposable lists and explicit list pairing. Keep these settings until the ordinary non-destructive checks are complete:

```properties
SYNC_ALLOW_DELETIONS=false
SYNC_ALLOW_LIST_DELETIONS=false
SYNC_ALLOW_TASK_MOVES=true
```

Cross-list moves are enabled for fresh projects. Keep both deletion switches `false` while running this move-focused validation so ordinary deletion propagation cannot add noise. Never enable list deletion for this runbook.

## Prepare disposable lists

1. Create two uniquely named lists on each service, for example:
   - `E2E-20260826-Move-Source`
   - `E2E-20260826-Move-Target`
2. Pair only those lists through the normal explicit-pairing procedure, or confirm that auto discovery selected exactly those lists.
3. Run `setupStatus()` and `dryRunReport()`. The report must contain no unexpected lists, faults, or credentials. Record the disposable list IDs privately; do not put them in GitHub issues, screenshots, or this repository.

## Read-only preview

1. Add one disposable task to the Google source list with a title, notes, due date, and completion state.
2. Run `syncAll()` once while the task is still in the Google source list. Confirm that its Microsoft counterpart and mapping exist before adding provider-only metadata.
3. On that Microsoft counterpart, add representative provider fields when available: `importance`, `categories`, reminder fields, recurrence, and a start date. `hasAttachments` can indicate an attachment, but the current task inventory does not expand attachment relationships.
4. Run `syncAll()` again while the task is still mapped to the source list. This refreshes the mapping baseline after the Microsoft-side metadata edit.
5. Move the Google task from the disposable source list to the disposable target list, then run `dryRunReport()`.
6. Confirm the JSON contains a deterministic `pendingMoves` array. Check that each entry identifies the source/target lists, execution state, and metadata detection status. Check that unexpanded relationships are not claimed to be absent.
7. Confirm that the report does not create, update, or delete lists/tasks and that the persisted sync state is unchanged.

## Google-origin move

1. Confirm `SYNC_ALLOW_TASK_MOVES=true` for the disposable staging project. Leave both deletion switches `false`.
2. Run `syncAll()` once after the move. Inspect both services and the private mapping/state export.
3. Run `syncAll()` a second time. Expected result:
   - exactly one Microsoft counterpart exists in the target list;
   - the old Microsoft counterpart is retired as part of the move transaction;
   - the mapping points to the new Microsoft task ID;
   - the old Microsoft ID has a move tombstone;
   - the second run creates no duplicate;
   - no non-disposable list or task changed.
5. Run `dryRunReport()` again. It should not report the completed move as a fresh candidate.
6. In the private raw state, confirm the move journal used a UUID while it was active. Do not paste that UUID, provider IDs, or raw state into shared evidence. If fault injection left an unresolved correlated journal, that target-list Graph request should use the URL-encoded form of `$expand=extensions($filter=id eq 'com.tasksTodoSync.move')`; ordinary target lists should not expand extensions. Confirm local recovery accepts the exact `microsoft.graph.openTypeExtension.` and legacy `Microsoft.OutlookServices.OpenTypeExtension.` identities for the exact extension name, while rejecting bare names, suffix matches, and other prefixes.

## Blocked move

1. Set `SYNC_ALLOW_TASK_MOVES=false`.
2. Move a second disposable Google task across the two disposable lists.
3. Run `dryRunReport()` and `syncAll()`.
4. Confirm the candidate is reported as blocked, the old Microsoft task remains, and no destination Microsoft task is created.
5. Restore `SYNC_ALLOW_TASK_MOVES=true` before continuing or returning the fresh project to normal use.

## Microsoft-origin observation

The Microsoft-origin path is a separate, more destructive disposable-data check because Graph normally assigns a new task ID and the old Google counterpart is handled by the ordinary task-deletion confirmation path. Do not perform it during a normal personal run.

1. With `SYNC_ALLOW_DELETIONS=false`, move one disposable Microsoft task and run one complete sync. Verify the new Google counterpart appears and the old Google counterpart remains. This persistent two-task result is the intentional no-deletion behavior.
2. Remove the disposable residue manually, then repeat with `SYNC_ALLOW_DELETIONS=true`. After the first complete round, expect a temporary duplicate/new counterpart plus a first missing-old observation. After a later complete round, verify the old Google counterpart is retired.
3. If the same Microsoft task ID is ever reported in another list, expect `MOVE_MICROSOFT_SAME_ID_LIST_CHANGED` and no automatic rebinding.

Keep `SYNC_ALLOW_LIST_DELETIONS=false` throughout.

## Failure and recovery coverage

Do not provoke real throttling. The local suite has deterministic offline coverage for these cases only:

- one `HTTP 429` followed by success honors `Retry-After` through a captured
  `Utilities.sleep` call, without a real wait;
- repeated `HTTP 429` responses make exactly `HTTP_MAX_RETRIES + 1` attempts,
  then throw without a real wait;
- an exhausted-429-shaped move-create error retains the old source, persists a
  `taskMoveJournal` in `creating` state, and does not immediately create a
  duplicate;
- one exact destination with the intended list, either exact service-normalized
  Graph extension ID, exact extension name, valid matching correlation UUID, unmapped identity, and
  fingerprint can be adopted without a duplicate;
- a same-fingerprint task without the marker is not adopted, duplicate exact
  markers stop as ambiguous, and a marker whose content changed stops as a
  destination edit conflict;
- a legacy unresolved journal cannot auto-adopt or recreate a task.

If the journal remains blocked, follow the [move-journal operations runbook](deployment.md#move-journal-operations-runbook). Verify that inspect/preview output contains only opaque references and bounded evidence, that changing the action/candidate/confirmation invalidates the preview token, that apply requires an exact private before-image read-back, and that apply itself performs no provider mutation. Never clear the journal blindly.

The offline suite uses a fake clock to verify that task/list deletion recovery,
confirmed deletion apply, and completed-move deletion stop before the destructive
reserve with no remote delete and with durable journals retained. It does not
simulate a real provider throttle, Apps Script termination, or network timing;
verify those boundaries with the disposable-list procedure above and record the
outcome as private validation evidence.

After the run, export the state privately and remove test data manually if desired. Restore the deployment's chosen switch values after reviewing the evidence.
