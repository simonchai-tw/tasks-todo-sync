# v0.1.1 release notes

`v0.1.1` is a focused maintenance release for personal Google Tasks ↔ Microsoft To Do synchronization. It keeps the private Apps Script deployment model and the existing fresh-project defaults:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=true
SYNC_ALLOW_LIST_DELETIONS=true
SYNC_ALLOW_TASK_MOVES=false
```

## Highlights

- **CLI time-zone hotfix:** `init --timezone <IANA>` updates the manifest after parsing JSON, so non-`Asia/Taipei` zones work with pretty-printed manifests.
- **Round-fence baseline:** an incomplete run drops only its uncommitted proof and keeps the previous successful task/list-deletion baseline.
- **Successful-round restore:** restore uses a separately committed successful generation, not an intra-round checkpoint.
- **Rich body preservation:** Google title, date, and completion-only changes leave an existing Microsoft rich-text body untouched; a changed notes text projection updates it.
- **Bounded auth and errors:** refresh/retry behavior is bounded, and fatal alert emails are redacted to omit task/list content, provider IDs, secrets, and full provider responses.
- **Execution guards:** pagination, User Properties storage headroom, and privacy-bounded per-round metrics (`durationMs`, `urlFetchCalls`, `stateSaveCalls`) are guarded without persisting task/list content.

## Upgrade

1. Keep a private backup of the current source and state before updating.
2. Deploy the matching `Code.gs` and `appsscript.json`, then run `setupStatus()` and `dryRunReport()` before recreating the trigger.
3. Complete and verify at least one successful sync with `v0.1.1` before using `restorePreviousSyncState()`. Restore can select the current or previous successful generation only; it cannot recover an arbitrary checkpoint. Legacy state without a verifiable successful generation fails closed.
4. Confirm the 10-minute trigger. Ordinary changes normally appear within 0–10 minutes; two complete deletion-confirmation rounds normally settle within 10–20 minutes.

The CLI never accepts or stores Microsoft credentials. Authorize one Google account and one Microsoft account during setup, and keep the Microsoft client secret only in private Apps Script Script Properties.

## Verification

Before publishing the package, tag, and GitHub release, the maintainer should confirm:

- [x] `npm run check` and `npm test` pass locally, including round-fence, restore, rich-body, bounded-auth/error, pagination, storage, and metrics coverage.
- [x] A packed-tarball `init --timezone` validation passes for a non-`Asia/Taipei` time zone and preserves partial-resume behavior.
- [x] The final pagination page-token/page-count guards, aggregate User Properties headroom check, and content-free per-round metrics are implemented and exercised.
- [x] Fatal alert redaction and second-401/invalid-grant behavior are covered by the final tests.
- [x] The release documentation links pass the repository's Markdown/link checks and `git diff --check` is clean.

## Known boundary

This project is designed for one operator and that operator's own accounts. Task and list deletion are enabled for fresh projects and use two-round confirmation, live revalidation, journals, and tombstones. Cross-list task moves remain implemented but disabled by default while real-account validation continues.

The synchronizer does not persist page cursors, Graph delta tokens, or inventory shards. A consistently oversized inventory must be addressed architecturally; increasing the trigger interval is not a fix. Rich-body preservation applies to metadata-only Google edits; delete-and-recreate moves still rebuild only title, plain-text notes, date-only due date, and completion state, so provider-only metadata is not preserved.

Raw state exports, recovery operation JSON, preview tokens, and before-image receipts are sensitive operational data. Do not publish them or include provider IDs, task content, credentials, or private URLs in issue reports.
