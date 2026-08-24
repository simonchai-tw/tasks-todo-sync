<div align="center">
  <img src="docs/assets/tasks-todo-sync-hero.svg" width="100%" alt="Tasks–To Do Sync connects Google Tasks with Microsoft To Do through a private Google Apps Script bridge">
</div>

<h1 align="center">Tasks–To Do Sync</h1>

<p align="center">
  <strong>Keep Google Task and Microsoft To Do in the same task loop.</strong><br>
  A private, self-hosted bridge for people who live in both ecosystems.
</p>

<p align="center">
  <a href="https://github.com/simonchai-tw/tasks-todo-sync/actions/workflows/ci.yml"><img src="https://github.com/simonchai-tw/tasks-todo-sync/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/simonchai-tw/tasks-todo-sync/actions/workflows/github-code-scanning/codeql"><img src="https://github.com/simonchai-tw/tasks-todo-sync/actions/workflows/github-code-scanning/codeql/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/simonchai-tw/tasks-todo-sync/releases"><img src="https://img.shields.io/github/v/release/simonchai-tw/tasks-todo-sync?include_prereleases&amp;sort=semver&amp;style=flat-square" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/simonchai-tw/tasks-todo-sync?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/runtime-Google%20Apps%20Script-4285F4?style=flat-square" alt="Google Apps Script">
</p>

<p align="center">
  <a href="#why-this-exists">Why</a> ·
  <a href="#what-syncs">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#safety-by-default">Safety</a> ·
  <a href="docs/deployment.md">Deploy</a> ·
  <a href="https://github.com/simonchai-tw/tasks-todo-sync/graphs/contributors">Contributors</a>
</p>

---

## Why this exists

Google Tasks and Microsoft To Do are both useful inside their own ecosystems, but they do not naturally stay in sync.

**Tasks–To Do Sync closes that gap.** It runs inside your own private Google Apps Script project, discovers eligible lists on both sides, and keeps task changes moving between Google Tasks and Microsoft To Do every 10 minutes.

No hosted middleman. No shared client secret. Your accounts, your script, your data.

## What syncs

| Capability | Direction | Release candidate status |
|---|:---:|---|
| Task creation and edits | Google ↔ Microsoft | Ready for personal use |
| Complete and reopen | Google ↔ Microsoft | Ready for personal use |
| Notes | Google ↔ Microsoft | Plain-text round trip |
| Due dates | Google ↔ Microsoft | Date only; Google Tasks has no time-of-day field |
| Eligible personal lists | Google ↔ Microsoft | Auto-discovery and counterpart creation |
| Task deletion | Google ↔ Microsoft | Implemented, **off by default**, destructive account test pending |
| List deletion | Google ↔ Microsoft | Implemented, **off by default**, destructive account test pending |
| Cross-list task moves | Google ↔ Microsoft | Google → Microsoft uses guarded create-then-delete; Microsoft → Google converges through new-task plus deletion handling; **off by default** |

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" width="100%" alt="Google Tasks synchronizes bidirectionally with Microsoft To Do through a private Google Apps Script project">
</p>

The script keeps an ID-based mapping between paired lists and tasks. Existing mappings survive list renames; unique custom-list names help with first pairing; ambiguous matches stop with a fault instead of guessing. A 10-minute Apps Script trigger handles normal synchronization after the initial manual checks.

Apps Script limits one execution to six minutes. The synchronizer uses a 5.25-minute budget and a global lock, leaving 45 seconds before the platform ceiling and preventing overlapping work from running concurrently. Destructive journal paths stop with an additional 45-second reserve inside that budget before live revalidation, durable journal writes, or remote deletion, leaving bounded room for catch-save and lock cleanup. Ten minutes is the first supported minute-trigger cadence above the six-minute ceiling. Ordinary changes are therefore normally observed in 0–10 minutes; a two-complete-round deletion or Microsoft-origin move cleanup normally needs about 10–20 minutes, and can take longer after throttling or a failed run.

A time-budget exit does **not** preserve a Google or Graph page cursor. The next run starts a complete inventory again. If a single complete inventory always exceeds the 5.25-minute budget, increasing the trigger interval will not solve it; the future remedy is persistent pagination/delta state or workload sharding.

## Get started

> [!TIP]
> Start with the [non-technical quick start](docs/quick-start.md). The complete [deployment guide](docs/deployment.md) covers Microsoft Entra setup, rollback, explicit pairing, and optional `clasp` deployment.

1. Create a private standalone Google Apps Script project and copy in [`Code.gs`](Code.gs) plus [`appsscript.json`](appsscript.json).
2. Set your own IANA time zone, then run `initializeSafeDefaults()`.
3. Register your own Microsoft Entra application with delegated `Tasks.ReadWrite` permission and complete Microsoft authorization.
4. Run `setupStatus()` and `dryRunReport()`. Resolve every unexpected warning.
5. Test two manual `syncAll()` runs with disposable tasks. Only then run `createTrigger()` for the 10-minute schedule.

```javascript
initializeSafeDefaults(); // safe switches off, automatic list discovery on
setupStatus();            // configuration and authorization health
dryRunReport();           // read-only list/configuration report
syncAll();                // run twice before enabling the schedule
createTrigger();          // install the 10-minute trigger
```

## Proof, not promises

| Check | Verified result |
|---|---|
| Local regression suite | **168 / 168 passed** in the rc6 worktree |
| GitHub CI | `v0.1.0-rc.6`: **168 / 168 passed** |
| Real scheduled run | `v0.1.0-rc.6` personal Apps Script completed successfully; 67 mapped tasks, no mutations or conflicts observed |
| Deployed health check | `v0.1.0-rc.6` personal Apps Script: Healthy, **0 reported issues** |
| CodeQL | `v0.1.0-rc.6`: **0 alerts** |
| Dependabot | `v0.1.0-rc.4` baseline: **0 alerts** |
| Secret scanning | `v0.1.0-rc.4` baseline: **No secrets found** |

The rc6 regression, GitHub CI/CodeQL checks, and personal Apps Script sync/health checks were verified on 2026-08-24. The live run observed no creates, moves, deletes, or conflicts; this is a bounded smoke check, not a claim that destructive paths or every account configuration have been production-tested. The detailed boundary is recorded in the [engineering audit](docs/audit.md).

## Safety by default

The setup helper explicitly writes these release-candidate defaults:

```properties
SYNC_LIST_DISCOVERY_MODE=auto
SYNC_ALLOW_DELETIONS=false
SYNC_ALLOW_LIST_DELETIONS=false
SYNC_ALLOW_TASK_MOVES=false
```

> [!IMPORTANT]
> Keep all three destructive-feature switches set to `false` for important data until you complete a disposable-task smoke test. Task and list deletion use two-round confirmation and 30-day tombstones. Cross-list movement is independently controlled by `SYNC_ALLOW_TASK_MOVES`; it creates the destination counterpart before retiring the source and keeps a durable recovery journal across interrupted runs.

Cross-list movement uses two deliberately different paths. A Google-origin move is reproduced in Microsoft To Do with a guarded create-before-delete transaction. Before the destination POST, the script durably records a UUID; the same POST writes a `com.tasksTodoSync.move` open type extension. Graph To Do responses may normalize that marker to either exact service identity: `microsoft.graph.openTypeExtension.com.tasksTodoSync.move` or the legacy `Microsoft.OutlookServices.OpenTypeExtension.com.tasksTodoSync.move`. Only unresolved target lists request the documented `$expand=extensions($filter=id eq 'com.tasksTodoSync.move')` short-name filter; the response is then checked locally against that two-value ID allowlist plus the exact extension name, a valid matching UUID, unmapped identity, target list, and synchronized-field fingerprint. Bare names, suffix matches, and other prefixes are rejected. A same-content task without that marker is never adopted. Multiple markers, edited content, or an incomplete extension inventory stop safely. Pre-rc.6 unresolved journals have no UUID and therefore cannot auto-adopt or recreate a destination.

A Microsoft-origin move normally appears as a new Microsoft task ID and a missing old ID. With `SYNC_ALLOW_DELETIONS=false`, the new Google counterpart is created but the old Google counterpart is intentionally retained, so two tasks can remain indefinitely. With `SYNC_ALLOW_DELETIONS=true`, the new counterpart is created in one complete round and the old one is normally removed after a later complete confirmation round, producing a temporary duplicate before convergence. A provider observation that keeps the same Microsoft ID while changing lists remains `MOVE_MICROSOFT_SAME_ID_LIST_CHANGED` and fails closed.

Both paths rebuild only the bridge's common fields—title, plain-text notes, date-only due date, and completion state—so the provider task ID changes and Microsoft-only metadata such as reminders, importance, categories, recurrence, start dates, creation date, and completion history is not preserved. `dryRunReport()` exposes structured `pendingMoves[]` entries with point-in-time metadata-loss information. Its normal inventory does not expand attachment, checklist, linked-resource, or extension relationships; only an unresolved correlated recovery target receives the selective extension expansion during `syncAll()`.

Additional guardrails:

- The bridge is designed for **one operator and that operator's own accounts**.
- Microsoft credentials stay in private Apps Script Properties and are never part of this repository.
- Auto-discovery ignores shared, non-owned, unknown, excluded, and special Microsoft lists.
- `dryRunReport()` is read-only and now previews detected Google-origin cross-list moves through both human-readable messages and structured `pendingMoves[]` entries. Metadata reporting is point-in-time and inventory-bounded—not a promise about every later mutation or unexpanded relationship.
- Missing or ambiguous identities stop safely instead of being paired by guesswork.
- `healthCheck()` reports blocked and legacy move-journal counts as issues. `inspectTaskMoveJournals()` provides opaque references; guarded `previewTaskMoveJournalOperation()` / `applyTaskMoveJournalOperation()` workflows can resume, cancel, or reconcile one journal without directly mutating either provider. A preview token is bound to the exact action, journal revision, candidate reference, confirmation, and live evidence; changing any effect-bearing field requires another preview.

`pendingMoves[]` reports `hasAttachments=true` when that scalar is present in the Microsoft task snapshot. It does not fetch or inspect attachment relationship contents; `checklistItems`, `linkedResources`, and `extensions` remain unexpanded and must not be interpreted as absent.

## Is it for you?

| A good fit | Not yet a fit |
|---|---|
| You use Google Tasks and Microsoft To Do every day | You need a hosted multi-user SaaS |
| You want the same task changes reflected on both sides | You need a one-click login-only setup |
| You are comfortable owning a private Apps Script project | You need zero-configuration deployment |
| You want transparent, auditable synchronization | You need destructive features enabled without first testing disposable data |

## Documentation

| Guide | Use it for |
|---|---|
| [Quick start](docs/quick-start.md) | The shortest safe personal setup path |
| [Deployment guide](docs/deployment.md) | Entra registration, Apps Script, OAuth, validation, rollback |
| [Engineering audit](docs/audit.md) | Verified behavior, limitations, and deferred risks |
| [Security policy](SECURITY.md) | Reporting a vulnerability privately |
| [Changelog](CHANGELOG.md) | Release history and scope |

## Local verification

Node.js 22 or later is required only for repository checks and the optional `clasp` workflow:

```bash
npm run check
npm test
```

GitHub stores the source and release history; the actual synchronization runs in **your private Google Apps Script project**. Start with the current [prerelease](https://github.com/simonchai-tw/tasks-todo-sync/releases/tag/v0.1.0-rc.6), use disposable tasks first, and keep the safety switches off until destructive testing is explicitly completed.
