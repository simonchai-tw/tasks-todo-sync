# RC5 disposable-list validation

This runbook validates the release candidate against disposable data. It is deliberately separate from normal personal use: do not point it at valuable lists, and do not intentionally create a real Microsoft Graph 429. Fault-injection tests cover throttling and interrupted responses locally.

## Safety boundary

Use a separate Google account and Microsoft account when practical. If that is not possible, use uniquely named disposable lists and explicit list pairing. Keep these settings until the ordinary non-destructive checks are complete:

```properties
SYNC_ALLOW_DELETIONS=false
SYNC_ALLOW_LIST_DELETIONS=false
SYNC_ALLOW_TASK_MOVES=false
```

Only the Google-origin move scenario below enables `SYNC_ALLOW_TASK_MOVES=true`, and only for the disposable lists. Never enable list deletion for this runbook.

## Prepare disposable lists

1. Create two uniquely named lists on each service, for example:
   - `RC5-E2E-20260822-Move-Source`
   - `RC5-E2E-20260822-Move-Target`
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

1. Set `SYNC_ALLOW_TASK_MOVES=true` for the disposable staging project only. Leave both deletion switches `false`.
2. Run `syncAll()` once after the move. Inspect both services and the private mapping/state export.
3. Run `syncAll()` a second time. Expected result:
   - exactly one Microsoft counterpart exists in the target list;
   - the old Microsoft counterpart is retired as part of the move transaction;
   - the mapping points to the new Microsoft task ID;
   - the old Microsoft ID has a move tombstone;
   - the second run creates no duplicate;
   - no non-disposable list or task changed.
5. Run `dryRunReport()` again. It should not report the completed move as a fresh candidate.

## Blocked move

1. Set `SYNC_ALLOW_TASK_MOVES=false`.
2. Move a second disposable Google task across the two disposable lists.
3. Run `dryRunReport()` and `syncAll()`.
4. Confirm the candidate is reported as blocked, the old Microsoft task remains, and no destination Microsoft task is created.

## Microsoft-origin observation

The Microsoft-origin path is a separate, more destructive disposable-data check because its old Google counterpart is eventually handled by the ordinary task-deletion confirmation path. Do not perform it during a normal personal run. If explicitly approved for a disposable account, enable `SYNC_ALLOW_DELETIONS=true`, move one disposable Microsoft task, run two complete sync rounds, and verify the new Google counterpart plus the expected two-round old-task handling. Keep `SYNC_ALLOW_LIST_DELETIONS=false`.

## Failure and recovery coverage

Do not provoke real throttling. The local suite has deterministic offline coverage for these cases only:

- one `HTTP 429` followed by success honors `Retry-After` through a captured
  `Utilities.sleep` call, without a real wait;
- repeated `HTTP 429` responses make exactly `HTTP_MAX_RETRIES + 1` attempts,
  then throw without a real wait;
- an exhausted-429-shaped move-create error retains the old source, persists a
  `taskMoveJournal` in `creating` state, and does not immediately create a
  duplicate;
- one exact, time-bounded destination match can be adopted.

The offline suite does not simulate an Apps Script execution timeout, a real
provider throttle, or real network timing. Verify those boundaries only with
the disposable-list procedure above and record the outcome as RC evidence.

After the run, export the state privately, remove disposable data manually if desired, and leave all three destructive switches `false` until the evidence has been reviewed. Passing this runbook is RC evidence, not a stable-release claim.
