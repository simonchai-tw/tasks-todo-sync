# v0.7.0 engineering audit

Audit scope: 0.7.0 — 2026-09-21

The canonical 18-file Apps Script runtime, Time Bridge v2.4 (due time and reminder synchronization with dedicated Google Calendar projection), modernized 3-step setup wizard, subtask and checklist synchronization engine, clean managed resource projection protocol, and formal scheduler invariants described below are included in this release. Their automated and real-account evidence is recorded here.

Supported environment: initial installation and source updates require a Windows, macOS, or Linux desktop/laptop with Node.js 22+, a terminal, and a modern browser. Chromebook Linux is best effort. npm installation is not supported on phones; the Microsoft connection wizard remains mobile-responsive for reauthorization. The [field compatibility matrix](field-compatibility.md) is the canonical source for field boundaries.

## Release decision

`v0.7.0` is a stable personal, single-operator synchronization release. It includes the canonical 18-file Apps Script runtime, Time Bridge v2.4 (due time and reminder synchronization with dedicated Google Calendar projection), a modernized 3-step setup wizard, bidirectional subtask and checklist synchronization with three-way field merge and conflict isolation, managed resource projection with clean tag labels, compressed and integrity-checked state, backward-compatible migration, guarded deletion with live absence probes, recovery journals, bounded task creates, tombstones, bounded diagnostics, destination-first cross-list moves, and both Personal Device Code and Advanced Entra Microsoft authorization modes. Fresh projects enable automatic list discovery, task deletion, list deletion, task moves, subtask synchronization, resource projection, and Time Bridge; existing explicit Script Properties are preserved.

The core implementation is covered by 427 automated tests (100% PASS), CI, and CodeQL. Recorded bidirectional real-account checks cover personal setup wizard onboarding, task deletion, list deletion, cross-list moves, subtask sync, resource projection, Time Bridge live end-to-end sync (splicing `[TTS-TIME:15:30]`, Microsoft To Do reminder setting, Google Calendar projection, and completion cleanup), and task creation in the maintainer's private deployment, culminating in clean 0-task-residue full reset verification. Local deterministic validation also exercises 600 tracked task pairs across synchronization, deletion, movement, recovery, pagination, and long-content scenarios. The deterministic 600-pair validation is provider-free; the separate bounded real-account observation below does not establish a universal provider or Apps Script runtime guarantee.

## Scope verification

- CLI time-zone handling parses and updates manifest JSON, so non-`Asia/Taipei` IANA zones do not depend on formatting.
- The 18-file Apps Script runtime is load-order safe: verified across canonical, reverse, and deterministic shuffled VM load orders without duplicate globals or order-dependent initialization bugs.
- An incomplete run discards only current-round proof and retains the previous successful task/list-deletion baseline.
- Restore reads a separately committed successful generation, never an intra-round checkpoint. An upgraded deployment needs one verified successful sync first; legacy state without verifiable evidence fails closed.
- Granular three-way field merge (`field-merge.gs`) isolates changes across `title`, `notes`, `due`, `status`, and `importance`. Metadata-only edits leave unrelated fields untouched, while concurrent opposing edits freeze safely into a conflict state (`TRUE_FIELD_CONFLICT`) rather than silently overwriting data.
- Single-pair mutation errors are contained (`isContainedPairMutationError_`), ensuring an isolated provider fault on one task pair does not abort the entire round.
- Managed resource projection strips block delimiters before hash calculation, guaranteeing zero ping-pong writes.
- Authorization refresh/retry and fatal alerts are bounded. Fatal alerts are redacted. Persisted health errors contain status and bounded internal/request codes rather than raw provider responses.
- New state generations use gzip+Base64, codec metadata, UTF-8 decoded-size checks, and SHA-256 integrity. At most three generations are transiently retained during promotion.
- New move journals use compact Base64 SHA-256 fingerprints. Legacy canonical raw JSON fingerprints remain readable only on exact match.

## Microsoft authorization & setup wizard boundary

The authorization layer supports two additive modes. Fresh installations without legacy Microsoft client properties resolve to Personal Device Code mode. Existing installations containing `MS_CLIENT_ID` or `MS_CLIENT_SECRET` resolve to Advanced self-managed Entra mode unless an explicit valid `MS_AUTH_MODE` says otherwise. Invalid explicit modes fail closed. There is no forced migration, and a failed Personal authorization attempt does not erase or replace existing Advanced credentials.

Personal mode uses a shared Microsoft public-client application ID restricted to personal Microsoft accounts. A public client ID identifies the application and is not a secret. Personal mode requires no client secret and no redirect URI. It requests delegated `Tasks.ReadWrite` and `offline_access`; provider tokens and the temporary Device Code Flow session are stored in the deploying user's Apps Script `UserProperties`.

### Modernized 3-step setup wizard

The private setup web app (`Setup.html`, `setup.gs`, and `Code.gs`) guides the operator through a clean 3-step setup:
1. **Google Tasks Authorization**: Prepares and validates Google Tasks permissions and inspects project properties.
2. **Microsoft To Do Connection**: Initiates the Microsoft Device Code flow with a 15-minute dynamic countdown, one-click code copy, and background polling.
3. **Trigger Activation & First Sync**: Verifies that Microsoft is fully connected before arming the 10-minute automatic trigger, performing dry-run preflight, and initiating the first baseline sync.

**Zero-Dynamic-HTML Security Contract**: In strict compliance with static security rules, `Setup.html` forbids any dynamic `innerHTML` or `outerHTML` string concatenation. All UI state mutations are driven strictly through native `document.getElementById`, `classList`, `textContent`, and predefined CSS state classes.

Real-account authorization completed through Microsoft's `https://www.microsoft.com/link` endpoint; the allowlist also accepts Microsoft's legacy `https://microsoft.com/devicelogin` and `https://www.microsoft.com/devicelogin` addresses. The UI does not return or log the OAuth `device_code`, access token, refresh token, raw provider response, or Microsoft password. The password is entered only on official Microsoft pages.

Device polling must honor Microsoft's returned interval; `authorization_pending` is normal, and `slow_down` increases the interval by five seconds for the rest of that session. Personal mode becomes active only after access and refresh tokens are durably stored. Refresh-token rotation replaces the old token when Microsoft returns a new one; a successful response without a new refresh token preserves the existing refresh token. Reauthorization-required failures clear Personal tokens, stop synchronization, and produce bounded instructions rather than raw OAuth content.

Real-account Device Code Flow and private setup-web-app validation completed in the maintainer's disposable deployment. Deliberate provider-consent revocation is not part of the release acceptance scope; ordinary authorization, refresh-token rotation, reconnection, and disconnection paths are covered.

## Subtask and checklist synchronization boundary

Google Tasks subtasks (parent-child hierarchical tasks) synchronize bidirectionally with Microsoft To Do checklist items (`checklistItems`).

- **Three-way field merge**: Subtask title and completion status are merged via `field-merge.gs`. Independent concurrent changes on both sides are detected; conflicting updates freeze the subtask pair (`TRUE_FIELD_CONFLICT`) to prevent silent overwrites.
- **Hierarchy mapping & safety**: Microsoft checklist items are flat list children within a parent task. Deeply nested Google Tasks subtasks beyond depth 1 are flattened or safely guarded to prevent hierarchy cycle corruption.
- **Empty-title guard & placeholder contract**: Subtasks with empty titles or provider anomalies fail closed with safe fallback to `'(Untitled)'` placeholder contracts, preventing silent provider rejection.
- **Time budget protection**: Subtask create batches respect `TIME_BUDGET_CREATE` checkpoints. If the execution time budget approaches its limit, subtask batch processing exits gracefully and resumes safely on the subsequent round.

## Managed resource projection boundary

Related resources from Microsoft To Do (e.g. linked email messages from Outlook, attachments metadata, checklist items) and Google Tasks (e.g. related email links from Gmail, Google Docs assignments) are projected into the counterpart's notes via a dedicated managed block.

- **Clean unversioned boundaries**: The managed block uses clean, non-versioned delimiters:
  ```text
  --- tasks-todo-sync ---
  [Gmail] Invoice #1042
  [Google Docs] Product Specification
  [Outlook] Meeting notes from Q3
  --- tasks-todo-sync end ---
  ```
- **Anti-ping-pong invariant**: Before computing notes fingerprints or performing three-way field merge, `field-merge.gs` calls `parseManagedResourceBlock_` to strip the managed block from the task notes. SHA-256 fingerprints are computed **strictly on user-authored notes**. Because both providers' pure user notes hashes remain identical, 0 remote updates are triggered, mathematically eliminating ping-pong synchronization loops.
- **Tag-based formatting & URL suppression**: Managed resources are categorized using clean source tags (`[Gmail]`, `[Google Docs]`, `[Google Chat]`, `[Outlook]`, `[File]`, `[Link]`). When a human-readable title or subject is present, long percent-encoded URLs are suppressed from the text representation to keep task notes readable.
- **In-place overwrite**: Future modifications to the managed block overwrite the existing block in-place during subsequent synchronization cycles without leaving historical duplicate fragments. Legacy `(v1)` blocks are treated as ordinary user notes and are not destructively deleted.

## Scheduler invariants and empirical runtime calibration

The synchronization engine enforces three formal scheduler invariants:

1. **R-Completeness**: The snapshot $R$ of both provider collections must be observed completely. If any pagination failure, timeout, page limit, or malformed page occurs during snapshot creation, the engine immediately fails closed: 0 state mutations, 0 deletion candidates promoted, and 0 remote writes executed.
2. **Two-Round Deletion with Absence Probe Soundness**: A missing task is never deleted on the counterpart in the same round. Round 1 records a candidate (`confirmations=1, lastRoundId=round1`). Round 2 requires `lastRoundId !== currentRoundId`, confirms absence, and executes `providerAbsenceProbe_` (direct GET by ID) to verify that the absence was not a list filter or search index artifact. If the probe confirms 404 Not Found, remote deletion proceeds; if the provider reports alive, the candidate is invalidated with `ABSENCE_WAS_FILTER_ARTIFACT`.
3. **Starvation-Free Rotating Observation Cursor**: For $N$ mapped pairs and per-round observation budget $B = 10$, `state.resourceObservationCursor` advances deterministically, guaranteeing that every mapped pair is inspected in at most $\lceil N / B \rceil$ rounds.

### Empirical runtime calibration (Benchmark Lab)

Measurements on live real-account Apps Script execution calibrated the timing budget envelope:
- $R_{\text{floor}} \approx 2.44\text{ s}$ baseline snapshot latency (Google Tasks: ~458 ms/page; Microsoft To Do: ~278 ms/page).
- $C_{\text{reconcile}} \approx 0.37\text{ s/pair}$ for in-memory three-way field merge.
- $V_{\text{inspect}} \approx 0.521\text{ s/pair}$ for direct checklist/linked-resource observation (checklist item GET: ~258 ms; linked resource GET: ~263 ms). A budget of $B=10$ pairs consumes ~5.21 s (11.6% of the 45 s safety reserve).
- $W_{\text{delete}} \approx 0.385\text{ s/item}$ with **S2 Deletion Journal Batching**: merging all pending deletion journal records into a single User Properties save before issuing remote REST calls reduced deletion latency from 1,700 ms/item to ~385 ms/item (**4.4x speedup**).
- Transient network errors (HTTP 429, 5xx) undergo exponential backoff and classify cleanly under `TIME_BUDGET_HTTP` for graceful exit.

## Cross-list move boundary

Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider IDs change, and provider-only metadata without a cross-platform equivalent may not transfer.

Google-origin moves create the destination counterpart, read it back, verify the durable correlation marker and live source evidence, and only then retire the old Microsoft counterpart. Microsoft-origin moves create the new Google counterpart first; the old Google counterpart is retired through the ordinary two-round deletion confirmation and live-revalidation path. With task deletion disabled, that old counterpart remains. These are different provider paths, not one atomic cross-cloud transaction.

Automated coverage includes exact marker identity, journal recovery, source revalidation, conflict handling, duplicate prevention, and field conversion. `dryRunReport()` does not expand attachment, checklist, linked-resource, or unrelated extension relationships; those fields are uninspected rather than asserted absent.

## Task-create recovery boundary

Ordinary unmapped task creates are processed in same-direction batches of at most 25 items. The User Property `SYNC_TASK_CREATE_PROGRESS_V1` records per-item progress, and completed batches are checkpointed while the round fence remains open. This bounds provider work and lets a later run continue after a time-budget exit without reposting completed creates.

The create protocol is provider-specific because neither provider documents POST idempotency. Google→Microsoft creates carry the dedicated extension identity `com.tasksTodoSync.create`; recovery accepts only one exact supported normalized extension ID with the matching UUID in the intended destination list. Microsoft→Google creates append the temporary sentinel `<!-- tasks-todo-sync-create:<uuid> -->` to Google notes; cleanup removes it only after the update and a positive GET verification. Zero or multiple exact candidates fail closed, with no automatic repost of an uncertain create.

Blocked batches have a private operator surface: `inspectTaskCreateBatch()`, `previewTaskCreateBatchOperation()`, and `applyTaskCreateBatchOperation()`, driven by the Script Property `SYNC_TASK_CREATE_OPERATION_JSON`. `RESOLVE_EXISTING` requires one exact verified destination. `RELEASE_FOR_REPOST` requires the literal confirmation `I_UNDERSTAND_DUPLICATE_RISK_RELEASE_FOR_REPOST` and intentionally accepts duplicate risk. Operators must pause triggers, back up state, preview, round-trip the preview token, and apply; the helpers update only the private sidecar, while the next `syncAll()` performs provider recovery. Provider IDs and secrets are not part of published evidence.

## Scheduling and diagnostics boundary

The supported trigger cadence is 10 minutes. Apps Script permits at most six minutes per execution; the script budget is 5.25 minutes. Destructive paths reserve additional time before live reads, journal writes, or remote mutation. A time-budget exit starts a complete inventory on the next invocation: no page cursor, Graph delta token, or shard checkpoint is persisted. Page-token and page-count guards fail closed on repeated tokens, unreasonable counts, or insufficient execution time.

Per-round `durationMs`, `urlFetchCalls`, and `stateSaveCalls` are bounded, content-free values recorded only in the execution log. `sync_summary` is written only to the execution log; a 360 KiB threshold sends the storage-pressure email. `healthCheck()` does not display byte counts or these metrics.

## Storage capacity boundary

There is no fixed task-count limit. For routine unattended use, approximately 300 tracked task pairs is the conservative recommended operating envelope. Six hundred pairs is an observed stress boundary, not a support promise; accounts above the recommended envelope should be judged from their own completed-run duration and storage-pressure evidence. Provider-free Node/zlib modeling covers the capacity corners below. A separate real-account Apps Script observation seeded 600 tasks: the initial create round saved safely at the internal time budget after 286,307 ms and 551 URL fetches, the next round completed the remaining creates in 53,659 ms and 78 fetches, and two subsequent steady rounds completed in 28,768 ms and 19,199 ms with 18 fetches each. This demonstrates safe multi-round convergence in that deployment, not a universal provider-runtime guarantee.

| Scenario | Peak bytes |
| --- | ---: |
| Dense | 181,797 |
| Sparse | 196,672 |
| Steady-state / long Unicode | 183,669 |
| Deletions plus tombstones | 384,334 |

Six hundred simultaneous blocked move journals projected 475,030 bytes: 14,230 bytes above the 450 KiB preflight envelope, so the write fails closed before provider mutation. A separate 1,200-pair move-journal saturation probe reached 1,214,804 bytes; that is a storage cliff, not a support claim.

The measured model and implementation boundaries include an 8 KiB per-property value limit, a 450 KiB aggregate User Properties preflight envelope, a 360 KiB storage-pressure notification threshold, 7,000-character chunks, up to 100 chunks per generation, a 2 MiB uncompressed state limit, three retained generations at peak, 30-day tombstone retention, and the 5.25-minute execution budget. These limits fail closed and alert; they do not promise a fixed task-count envelope.

Normal fresh state does not store task titles, notes, or bodies in the mapping store. Long notes affect provider payload size and runtime, not the mapping store itself. Legacy journals and raw state exports can still contain sensitive material and must remain private.

## Time Bridge and Google Calendar projection boundary

Google Tasks natively supports due dates without a time-of-day component. Time Bridge v2.4 bridges this architectural gap:

1. **Google Tasks Notes Marker Splicing**: Tasks authored with a strict `[TTS-TIME:HH:mm]` marker on the first line of notes (Spec §2.1) are parsed, mapped to Microsoft To Do reminders, and projected to Google Calendar. Synchronizer runs atomically splice out the marker line and trailing blank line, keeping notes clean.
2. **Dedicated Secondary Google Calendar Projection**: Timed tasks are projected as 30-minute events (`start.dateTime`) onto a dedicated secondary Google Calendar (`Tasks-ToDo-Sync`). The primary personal calendar remains unpolluted.
3. **Deterministic Event IDs**: SHA-256 digests mapped into 32-character lowercase hex guarantee idempotent writes and collision-free lifecycle management without negative-byte corruption.
4. **Automated Completion Cleanup**: When a task is marked complete or deleted, its projected Google Calendar event is immediately deleted, and the state reference is cleared.
5. **Fail-Closed Safety Knobs**: `SYNC_TIME_BRIDGE` (default `true`) and `SYNC_CALENDAR_PROJECTION` (default `true`) allow complete disablement or calendar-only suppression without code modification.
6. **Empirical Verification**: Empirical probe on live Google account confirmed that Google Tasks UI overlay does not project tasks as standard `vevent` objects in the Calendar API (`Calendar.CalendarList` contains no Tasks calendar, and `Calendar.Events.list('primary')` contains 0 matching tasks). This confirms that dedicated secondary calendar projection is the only robust, standard-compliant projection mechanism.

## Evidence reviewed

- **427 automated tests** (100% PASS), CI, CodeQL, static checks (`scripts/validate.mjs`), package dry-run validation (`scripts/validate-package.mjs`), and the deterministic 600-pair VM/capacity run were recorded for the release worktree. CodeQL uses GitHub Default setup, so no repository-owned CodeQL workflow file is expected.
- Bidirectional real-account validation covered Personal Device Code authorization, modernized 3-step setup wizard onboarding, supported task fields, subtasks/checklists, managed resource projection, task deletion, list deletion, cross-list movement, state rollback, live absence probes, and 0-task-residue total reset verification. The published observations omit private mappings, provider IDs, task contents, project identifiers, credentials, and Apps Script version numbers.
- Release publication and deployment execution are separate from source inspection; this audit does not infer evidence that was not observed.

## Validation boundary

Automated coverage includes 401 refresh/retry behavior, state-restore safeguards, field conversion, three-way merge conflict isolation, subtask classification and sync, managed resource projection, interrupted operations, and move-journal recovery. Real-account testing supplements those checks without attempting to recreate every provider-account or platform-failure permutation. Provider APIs still do not provide one atomic cross-cloud move; current protection is durable journaling, fresh rereads, fail-closed conflict handling, and recoverable residue.
