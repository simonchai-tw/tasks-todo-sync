# Tasks–To Do Sync

> **Release status — `0.1.0-rc.2`: first public release candidate, not stable or production-ready.** The `v0.1.0-rc.2` tag identifies this prerelease; it does not imply production readiness.

Tasks–To Do Sync bridges Google Tasks with Microsoft To Do. Microsoft To Do and iOS Reminders already work well together, but Google, Android, Gemini, and Gmail's default task ecosystem is less compatible with them. This Google Apps Script project provides a personal, single-operator bridge between Google Tasks and Microsoft To Do.

Start with the non-technical [quick start](docs/quick-start.md). Use the detailed [deployment guide](docs/deployment.md) before enabling the schedule. Read the [security policy](SECURITY.md), [changelog](CHANGELOG.md), and [MIT license](LICENSE) before using or sharing the code.

## What this RC is — and is not

- It is a Google Apps Script sync engine. GitHub stores the source; GitHub Pages, Cloudflare Pages, and a GitHub Release do not run the 15-minute sync.
- It is designed for **one operator, one private Apps Script project, and that operator's own Google and Microsoft accounts**. It is not a hosted multi-user service.
- Every user needs their **own** Microsoft Entra app registration and client secret. There is no login-only mode, shared secret, or one-click public Apps Script template yet.
- The three safety switches must remain `false` for this RC:
  - `SYNC_ALLOW_DELETIONS=false`
  - `SYNC_ALLOW_LIST_DELETIONS=false`
  - `SYNC_ALLOW_TASK_MOVES=false`
- Task-deletion and list-deletion code is implemented, but real-account destructive smoke testing has **not** been completed. Do not enable either deletion switch for important data.
- Cross-list task moves are unavailable in this RC. The move switch is deliberately blocked because there is no recoverable move journal.
- `dryRunReport()` is a read-only configuration/list report. It is **not** a per-task mutation plan and cannot prove every later create, update, or deletion is safe.

## Current evidence, with its boundary

Static validation and the current local test suite have passed. A staging Apps Script project has also been checked for matching Code and manifest, successfully run its 15-minute trigger on 2026-08-22, and returned a healthy status with zero reported issues. This is useful staging evidence, not proof of production readiness: destructive account testing, full field coverage, OAuth reauthorization, rollback drills, concurrency protection, and long-running/load validation remain incomplete. See [the audit](docs/audit.md).

## Safe first use

1. Make a separate Google Apps Script project for staging and follow the [quick start](docs/quick-start.md).
2. Set the project to **your own IANA time zone** before syncing. Google Tasks due dates are date-only; Microsoft due times are not preserved.
3. Run `initializeSafeDefaults()`, add your own Microsoft credentials to Script Properties, complete Microsoft OAuth, and run `setupStatus()` plus `dryRunReport()`.
4. Test two manual `syncAll()` runs with disposable tasks, then create the 15-minute trigger only after the results are understood.

The repository intentionally does not document or link private working notes. They are not part of this public RC.

## Local checks

Node.js 22 or later is required for the local checks and optional `clasp` workflow:

```bash
npm run check
npm test
```

The CI workflow runs the same checks on Node.js 22 and 24. Deployment and rollback details, including the distinction between restoring source and restoring sync state, are in the [deployment guide](docs/deployment.md).

## Authors

The first public version was created by Simon and ChatGPT.
