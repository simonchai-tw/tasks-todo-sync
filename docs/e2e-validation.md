# Cross-list move E2E validation

This runbook validates cross-list moves with disposable Google Tasks and Microsoft To Do data. Run it against a private staging project, never valuable lists. Each scenario is repeatable: create fresh disposable lists and tasks, record only the bounded report outcome privately, and remove the disposable residue after the scenario.

## Preconditions

1. Complete the [quick start](quick-start.md) in a private staging project and confirm `SYNC_ALLOW_TASK_MOVES=true` with `setupStatus()`.
2. Create two eligible lists on each provider and let automatic pairing settle. Do not use shared, non-owned, excluded, or special lists.
3. Run `syncAll()` twice, then run `dryRunReport()`. Save the report privately; do not share provider IDs, task content, or raw state.
4. Create one disposable task in a paired Google list and one in a paired Microsoft list. Record their initial counterpart relationships privately.

## Google-origin move: create, verify, retire

1. Move the disposable Google task to the other Google list.
2. Run `dryRunReport()`. Observe one move candidate and its bounded `pendingMoves[]` evidence; the report is read-only.
3. Run one complete `syncAll()`.
4. Verify that the Microsoft counterpart now appears in the paired destination list, the old Microsoft counterpart is no longer in the source list, and no duplicate was created. Its provider ID is expected to change.
5. Run `syncAll()` again and confirm the result remains one mapped counterpart with no repeated create or delete.
6. If source evidence changed, inventory was incomplete, or marker evidence was ambiguous, confirm a fail-closed result and retained journal rather than a guessed retirement. Resolve only through the [move-journal operations runbook](deployment.md#move-journal-operations-runbook).

The live-account check validates convergence. Automated and fault-injection coverage verifies the internal order: durable journal → destination create → destination read-back and live verification → old counterpart retirement. Provider-only metadata without a cross-platform equivalent may not transfer.

## Microsoft-origin move: counterpart creation, then two-round retirement

1. Set `SYNC_ALLOW_DELETIONS=false` and move the disposable Microsoft task to the other Microsoft list.
2. Run one complete `syncAll()` and verify a new Google counterpart is created while the old Google counterpart remains. This residue is intentional when deletion is disabled.
3. Set `SYNC_ALLOW_DELETIONS=true` and run one complete `syncAll()`. Observe the first missing-old observation and retained deletion evidence.
4. Run a later complete `syncAll()` and verify the ordinary two-round deletion confirmation and live revalidation retire the old Google counterpart. Confirm the new counterpart remains mapped.
5. If the same Microsoft task ID is reported in another list, verify `MOVE_MICROSOFT_SAME_ID_LIST_CHANGED` and no silent remapping. Restore the intended setting after the scenario.

The Microsoft-origin order is: new Google counterpart creation → first missing-old observation → second complete confirmation round and live revalidation → old Google counterpart retirement.

## Blocked move

1. Set `SYNC_ALLOW_TASK_MOVES=false`.
2. Move a second disposable Google task between the two disposable Google lists.
3. Run `dryRunReport()` and `syncAll()`.
4. Verify the candidate is blocked, the old Microsoft task remains, and no destination Microsoft task is created.
5. Restore `SYNC_ALLOW_TASK_MOVES=true` before continuing.

## Fault-injection and recovery observations

The local fault-injection suite covers throttling-shaped failures, interrupted responses, duplicate prevention, exact marker identities, and journal recovery. It verifies that repeated HTTP 429 responses make exactly `HTTP_MAX_RETRIES + 1` attempts, that an exhausted move-create error retains the old source and persists a `creating` journal without an immediate duplicate, and that ambiguous or changed marker evidence is not adopted.

The local suite uses fake providers and a fake clock. It does not reproduce real provider throttling, Apps Script termination, or network timing. For a real-account interruption or concurrent edit, preserve the private journal, run `inspectTaskMoveJournals()`, and follow the deployment runbook; never clear the journal or edit provider IDs manually.

## Cleanup and record

After each scenario, run a final `dryRunReport()`, remove disposable tasks and lists manually where appropriate, and confirm a subsequent `syncAll()` has no unexpected candidates. Keep private notes of direction, observed ordering, whether deletion was enabled, and the bounded outcome. Do not publish raw state, task content, provider IDs, correlation UUIDs, or screenshots containing them.
