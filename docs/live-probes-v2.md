# Live probes and local baselines for v2

Status: **P0-1 (A1-A5) complete and merged; P0-2 local baselines measured; C-group Microsoft Graph probes executed on 2026-11-07 (C1/C2/C3/C5/C6 PASS, C4 PARTIAL) - see section 8.**

This document records every measurement taken on 2026-11-07 for the v2 work,
with its evidence boundary. It deliberately contains no unsupported capacity,
latency, or savings claim. Per the Evidence-Before-Premise Rule, the numbers
"65% savings", "2,500+ pairs", "0.8 s no-change round", "20 ms cached read",
and "30 s organization setup" are **not** valid external claims: no live
evidence supports them, and none of them appear in any product decision below.

## 1. Evidence boundary (read this first)

| Layer | Where it ran | What it proves | What it does NOT prove |
| :--- | :--- | :--- | :--- |
| Unit suite | Node 22/24, `node --test` | 563/563 tests pass on the merged `main` | Any Google/Microsoft runtime behaviour |
| Local VM shim | Node `vm` via `tests/gas-loader.mjs` | Real product `normalizeState_` / `saveState_` / `loadStateForInspection_` logic and real codec byte counts | Apps Script wall-clock timing, provider latency, User Properties quota contention |
| Synthetic model | `scripts/stress-600.mjs` | Bounded storage and scheduling invariants under fixed-cost assumptions | Real Apps Script wall-clock; the script itself sets `realAppsScriptBenchmarkRequired: true` and marks all elapsed values `synthetic-fixed-cost-not-a-GAS-benchmark` |
| Live GAS runtime (TEST) | Dedicated Apps Script project, `simon.tts.test@gmail.com`, `Asia/Taipei` | Real `Utilities.formatDate`, real Google Tasks notes round-trip, real state persistence, real OAuth scope set | Microsoft Graph behaviour, sync throughput, `syncAll()` end-to-end |

Never quote a VM-shim byte count or a synthetic elapsed value as a live
capacity claim. The decision output of `scripts/step2-baseline.mjs` remains
`ct05: INSUFFICIENT_EVIDENCE` / `budgetStatus: UNMEASURED` / `reason: no
accepted live evidence`; that is the correct state until a live CT-05 is run.

## 2. A-group verification (P0-1, merged)

| Check | Result |
| :--- | :--- |
| `npm test` | 563/563 PASS, 0 fail |
| `npm run check` | Static validation + Package dry-run (30 files) pass |
| `npm run docs:check` | OK (563/563, package version 1.0.0 at measurement time) |
| `git diff --check` | clean |
| GitHub | PR #10 merged as `c678910`; CI on Node 22 and 24, CodeQL, Analyze (actions / javascript-typescript) all pass |

A1 chose report option (ii): `rec.res.journal` stays in place with an allowlist
entry and `assertResourceJournalEntries_`, rather than relocating it to a
top-level table (which would have changed mapping-deletion and deletion
rollback semantics). A2 uses the existing `rec.rem.msAt` UTC echo; `rec.rem.ms`
is a legacy boolean ownership flag. A3/A3b unify the two leading headers and
refresh the same-round snapshot. A4 hashes the same normalized projection that
merge uses. A5 charges `opsCount` after a fingerprint miss and before the first
real `Calendar.Events` call, including failed attempts.

### B1 naming correction

All five retired names have **zero** occurrences across the 19 canonical
`.gs` files: `TTS_STATE_CHUNK_`, `STATE_OVERSIZED`, `saveStateChunked_`,
`rec.rj`, `lastConvergedRound`. The real symbols on merged `main` are:

| Concept | Real location |
| :--- | :--- |
| `STATE_STORE_LIMIT` preflight error | `state.gs:472` |
| `STATE_UNCOMPRESSED_LIMIT` preflight error | `state.gs:544` |
| `saveBlobAtomic_` / `getUserProperties()` | `state.gs:695-696` |
| `saveState_` | `state.gs:823` |
| `persistSyncState_` | `state.gs:1116` |
| `assertResourceJournalEntries_` | `state.gs:1994-2019` |
| `RESOURCE_JOURNAL_MAX_ = 50` | `field-merge.gs:15` |

## 3. BENCH-01 - single-scenario codec baseline

`npm run baseline:step2` (real product codec through the VM shim, steady
schema-3 fixtures, three consecutive saves). `roundTripPassed` and
`preflightPassed` are true for all three rows.

| Pairs | Stored property bytes | Raw UTF-8 bytes | Chunks | Peak generations | Round trip |
| ---: | ---: | ---: | ---: | ---: | :--- |
| 100 | 8,485 | 27,795 | 2 | 2 | true |
| 300 | 28,591 | 81,595 | 4 | 2 | true |
| 600 | 61,434 | 162,295 | 9 | 2 | true |

Timing from this script (`saveMs` 11.15 / 18.49 / 40.00, `loadMs` 5.13 / 6.87 /
15.04) is a **local Node measurement**, not an Apps Script measurement. Every
row carries `environment: node-vm-gas-shim` and
`actualAppsScriptRuntimeMeasured: false`.

## 4. BENCH-01 - three-scenario, four-layer byte table

Report B3 requires 100 / 300 / 600 pairs across *no journal*, *full journal
and tombstones*, and *after compaction*, with raw / gzip / base64 / 3-generation
peak bytes. The single-scenario script above does not produce this, so a
supplement was run on 2026-11-07. Raw evidence:
`.workbuddy/live-probe-2026-11-07/bench-01-three-scenarios.json`.

Scenario definitions (deterministic, reproducible):

- **no-journal**: canonical schema-4 steady state; no `rec.res`, no tombstones.
- **full-journal-and-tombstones**: every mapping carries `rec.res.journal` at
  `RESOURCE_JOURNAL_MAX_` (50) valid entries, one pending deletion, and one
  Google plus one Microsoft tombstone per pair.
- **compacted**: convergence pruning; one journal entry per mapping, tombstones
  and pending deletions removed.

Every state is passed through the real `normalizeState_` before measurement;
`normalizeOk` is true for all nine rows. `saveState_` is then called three
times and `loadStateForInspection_` verifies the round trip.

| Pairs | Scenario | Raw bytes | gzip bytes | base64 chars | 3-gen peak (KiB) | Hard ceiling | `saveState_` |
| ---: | :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| 100 | no-journal | 28,195 | 6,104 | 8,140 | 25.18 | pass | OK |
| 100 | full-journal-and-tombstones | 612,972 | 128,477 | 171,304 | 505.21 | **fail** | OK (172,779 stored bytes) |
| 100 | compacted | 49,895 | 13,105 | 17,476 | 52.62 | pass | OK |
| 300 | no-journal | 81,995 | 21,139 | 28,188 | 84.17 | pass | OK |
| 300 | full-journal-and-tombstones | 1,836,772 | 385,712 | 514,284 | 1,514.34 | **fail** | **refused: `STATE_STORE_LIMIT`** |
| 300 | compacted | 147,095 | 41,098 | 54,800 | 162.39 | pass | OK |
| 600 | no-journal | 162,695 | 45,639 | 60,852 | 180.21 | pass | OK |
| 600 | full-journal-and-tombstones | 3,672,472 | 769,617 | 1,026,156 | 3,020.52 | **fail** | **refused: `STATE_UNCOMPRESSED_LIMIT`** |
| 600 | compacted | 292,895 | 82,883 | 110,512 | 326.31 | pass | OK |

The hard-ceiling column is the conservative 3-generation peak model from
`scripts/stress-600.mjs`; the `saveState_` column is the real product preflight.
They are different guards, so the 100-pair full-journal row can pass the real
write while failing the conservative model. The two refusals are **fail-closed
by design**, not defects: they are the concrete evidence for deciding whether
P4 storage tiering is required. Compacted vs full at 600 pairs drops raw bytes
from 3,672,472 to 292,895, but this is a fixture-shape comparison, not a
product "savings" figure - journal occupancy depends on the link-pair ratio.

## 5. `stress-600` summary

`npm run stress:600`: 13/13 supported scenarios pass, 1/1 saturation probe
passes. `worstVirtualElapsedMs` is 315,000 under a **synthetic** fixed-cost
model; `syntheticModelExcludes` lists OAuth2 latency, Apps Script UserProperties
quota contention, round-fence writes, move receipt writes, unrelated properties,
and legacy migration overhead.

| Metric | Value | Meaning |
| :--- | :--- | :--- |
| Storage cliff (1,200 pairs) peak | 1,186.33 KiB | `hardCeilingPass: false`, `supported: false`; storage-only probe, not a provider-sync support claim |
| `targetMarginFailureCount` | 3 | `deletions-tombstones`, `moves-journals`, `storage-pressure` |
| `decision.ct05` | `INSUFFICIENT_EVIDENCE` | no accepted live CT-05 evidence; architecture stays `BOUNDED_DIRECT_GET` |
| `realAppsScriptBenchmarkRequired` | `true` | script explicitly refuses to stand in for a live benchmark |

## 6. BENCH-02 - complete `Calendar.*` read/write inventory

Static scan of all 19 canonical `.gs` files: **7 call sites, all in
`time-bridge.gs`**, one read and six writes. No other file touches the Calendar
advanced service.

| Line | Call | R/W | Enclosing function |
| ---: | :--- | :--- | :--- |
| 727 | `Calendar.Events.get(calendarId, deterministicId)` | read | `timeBridgeProjectCalendarEvent_` (695) |
| 729 | `Calendar.Events.patch(..., { status: 'confirmed' })` | write | same |
| 734 | `Calendar.Events.patch(eventResource, ...)` | write | same |
| 742 | `Calendar.Events.insert(eventResource, calendarId)` | write | same |
| 747 | `Calendar.Events.patch(..., { status: 'confirmed' })` | write | same |
| 755 | `Calendar.Events.patch(..., { status: 'confirmed' })` | write | same |
| 767 | `Calendar.Events.remove(calendarId, deterministicId)` | write | `timeBridgeDeleteCalendarEvent_` (764) |

A5 moved `opsCount` accounting to a `consumeOp` callback invoked after a
fingerprint miss and before the first real Calendar call; the preceding
fingerprint hit is free, and a failed API attempt still counts against the
round budget (`TIME_BRIDGE_OPS_MAX_PER_ROUND = 20`).

## 7. Live TEST-project evidence (real Apps Script runtime)

A dedicated project under `simon.tts.test@gmail.com` was used; the personal
account, `~/.clasprc.json`, `private-deployment/`, and production were never
touched. An isolated clasp credential (`-A .clasprc.test.json`) was used; the
personal credential hash was `da4ea8fd...` before and after. The 21 pushed
runtime files were sha256-matched file-by-file against `public/`.

| Probe | Result |
| :--- | :--- |
| P0 token | `email`, `calendar`, `script.external_request`, `script.scriptapp`, `script.send_mail`, `tasks`, `userinfo.email`; `p0_tokenError: null` |
| P1 timezone | Real `Utilities.formatDate` in Taipei / Tokyo / New York across winter and summer (3 cases) matches `timeBridgeFormatHhMmInTimeZone_`; wall-clock to UTC round trips restore `09:00` in all 3 cases. `scriptTimeZone = Asia/Taipei` |
| P2 Google Tasks notes | `[TTS-REC]` + `[TTS-TIME]` headers and fullwidth characters survive a write/read verbatim; `exact1`, `exact2`, `freshReadImmediate` all true |
| P3 state persistence | Three real `normalizeState_ -> saveState_ -> loadStateForSync_` rounds with a journal entry; `journalKept: true` in all three, no exception |

The first authorization attempt produced a token with no API scopes because
the unverified-app consent page has five scope checkboxes that all default to
**unchecked**. Re-running with `ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)`
and selecting all scopes fixed it. Any future manifest scope addition requires
re-consent with all boxes checked.

Cleanup: `remainingScriptProps: []`, `leftoverProbeTasks: []`. Raw evidence:
`.workbuddy/live-probe-2026-11-07/probe-result-2026-11-07.json`.

## 8. C-group prerequisite status (measured 2026-11-07)

Status: **all six C-group probes (PROBE-01 ~ 05 plus the `$batch` probe) were executed serially, once each, against the TEST Microsoft account: C1 PASS, C2 PASS, C3 PASS, C4 PARTIAL, C5 PASS, C6 PASS.** Every number below is a counted value from the probe envelopes, never an estimate, and C4 stays PARTIAL.

Per the Evidence-Before-Premise Rule, the numbers "65% savings", "2,500+ pairs", "0.8 s no-change round", "20 ms cached read", and "30 s organization setup" remain **invalid external claims**: nothing in this section supports them, and none of them appear in any product decision below.

### 8.1 Evidence boundary for the C group

| Layer | Where it ran | What it proves | What it does NOT prove |
| :--- | :--- | :--- | :--- |
| Live Microsoft Graph (TEST) | Dedicated TEST Apps Script project, Personal Device Code authorization, `Tasks.ReadWrite MailboxSettings.Read offline_access`; probes pushed from an isolated 28-file whitelist, project restored to its 21 production files afterwards (residue: none) | Real Microsoft Graph responses for the six C-group probes, each probe executed once with a bounded outcome written here | Apps Script end-to-end `syncAll()`, production-tenant behaviour, sync throughput, or any capacity / latency / savings figure |
| Local VM shim | Node `vm` via `tests/gas-loader.mjs` | Real product `normalizeState_` / `saveState_` / codec logic and real byte counts (BENCH-01 / 02) | Any Microsoft Graph behaviour; the C-group probes do not run through the VM shim |
| Synthetic model | `scripts/stress-600.mjs` | Bounded storage and scheduling invariants under fixed-cost assumptions | Real Graph behaviour, real Apps Script wall-clock, real provider throttling |

The Live Microsoft Graph layer now contains real C-group observations, but only the six bounded outcomes recorded here. `httpCalls` is a **counted** value incremented inside the harness request wrapper, one attempt per call, no retry. A VM-shim byte count or a synthetic elapsed value must never be quoted as live Graph evidence. Each probe records only the bounded outcome: no account addresses, OAuth responses, provider IDs, task content, raw state, or access tokens.

### 8.2 Prerequisites and execution constraints

Microsoft Personal Device Code authorization **is** in place on the TEST project, obtained without an Azure app registration or client secret (`Setup.html:555`, `auth.gs:12-14`, `docs/e2e-validation.md:18`). The public client id and consumers authority are `globals.gs:11-12`; the requested scope is `Tasks.ReadWrite MailboxSettings.Read offline_access` (`globals.gs:13`). Result: `status: authorized`, `verified: true`, `tokensPresent: true`, `mode: personal_device`. `verified` is backed by a real Graph call to `MS_TODO_BASE?$top=1&$select=id` with response-shape validation (`auth.gs:108-140`), not a local flag. This scope covers `/delta`, `$batch`, `categories`, `attachments`, `linkedResources`, and **reading** `masterCategories`. It does **not** cover creating an `outlookCategory`: `POST /me/outlook/masterCategories` requires the least-privileged delegated permission `MailboxSettings.ReadWrite` for a personal Microsoft account, while only `MailboxSettings.Read` is granted. C4 measured exactly that boundary (403, see 8.9); adding the scope would force every existing user to re-consent and is a product decision for a later release, not this measurement round.

`SYNC_LIST_PAIRS_JSON` is **not configured**. It is required by `syncAll()` (`config.gs:206-230`, gated by the `SYNC_GOOGLE_LIST_IDS` allowlist at `config.gs:126-131`), but the C-group probes call Graph directly and do not require it. A full `syncAll()` live run therefore remains out of scope until list pairs are configured.

All six probes shared the same TEST Microsoft account, the same Script Properties, and the same Apps Script project, and were **executed strictly serially** in the order C1 -> C6 so that delta tokens, task observations, and categories could not contaminate each other. Each probe created its own disposable list and deleted it in a `cleanup` step; `cleanup.residue` is empty for all six.

### 8.3 Status summary

| Probe | Status | `httpCalls` | `cleanup` |
| :--- | :--- | ---: | :--- |
| PROBE-01 recurring completion (C1) | PASS | 47 (29 + 18, two executions) | list deleted, 10 tasks deleted, residue none |
| PROBE-02 `$expand=checklistItems` (C2) | PASS | 123 | list deleted, 4 tasks, residue none |
| PROBE-03 delta / child bubbling (C3) | PASS | 19 | list + task deleted, residue none |
| PROBE-04 `#tag` -> `categories[]` (C4) | **PARTIAL** | 8 | list + task deleted, no category created |
| PROBE-05 `linkedResources` / attachments (C5) | PASS | 14 | list deleted, 2 tasks, residue none |
| `$batch` positioning (C6) | PASS | 16 | list deleted, 4 tasks, residue none |

A follow-up probe **C7** was run after the six C-group probes to close the open C4 questions. It is supporting evidence, not one of the six prerequisite probes, and it does not change any of the six statuses above. See 8.12.

### 8.4 Corrections this round establishes

Four measured results contradict assumptions that were previously written into this document or into product code. These are the load-bearing findings of the C group, not incidental detail.

1. **C1 - the recurrence rollover model is model A, and the advanced due is grid-anchored, not due-anchored.** In 5/5 series at all four time points, the **original task ID survives** and is re-opened to `notStarted` with its `dueDateTime` moved to the next occurrence, while a **separate `completed` history instance** is created carrying the completed occurrence's due. The advanced due is recomputed from the recurrence grid anchored at `range.startDate`, and **neither a `dueDateTime` supplied at creation nor one sent in the PATCH affects the advanced value.** Two controls prove it: the `endDatePast` series was created with an overdue due of 2026-11-04 yet rolled **backwards** to 2026-10-29 (grid position 1 = 2026-10-28 -> position 2), and the `control_due` series had `dueDateTime` PATCHed to 2026-11-15 yet still rolled to 2026-11-09. Each series produced exactly 1 `completed` history instance. **Reminders do not follow the rollover** (`rf: false` on 20/20 observations), so any reminder projection must be written per occurrence. Any implementation that predicts the next due from the current due will therefore be wrong on overdue and edited series.
2. **C5 - `$expand=linkedResources` is not "silently ignored"; it is unnecessary.** The premise recorded at `public/providers.gs:392-396` is **refuted**. A baseline `GET /tasks?$top=100` **without** `$expand` already returns the `linkedResources` collection (`baselineHostItemCount: 1`, `baselineHostPropPresent: true`), and adding `$expand=linkedResources` changes nothing (`expandChangesData: false`). The product must not treat a plain task listing as link-free, and the claim that the parameter is dropped by the service must be deleted from the code comment and from this document.
3. **C3 - the delta endpoint does not honour `$expand=checklistItems`, even though it accepts it.** `GET /tasks/delta?$expand=checklistItems` returned **200** with `expandFieldSeen: false` and `expandItemCount: 0`: the request is accepted, but the child collection is never returned, so **Hybrid Delta still requires per-child reconciliation** and cannot replace it with an expansion. The same probe also measured child bubbling: adding, checking, and deleting a `checklistItem` **all three** made the parent `todoTask` appear in the next `/delta` (`containsParent` 3/3) with a changed parent `lastModifiedDateTime` (`parentLmdtChangedFromInitial` 3/3).
4. **C4 / C7 - an unregistered category string is fully usable, so a master-category lookup table is not required.** The report's PROBE-04 premise ("cannot assume an arbitrary unregistered string can be written directly") is **refuted**. C7 placed a registered and an unregistered `categories[]` value on two side-by-side tasks: both PATCH 200, both read back 200 with `containsTarget: true`, and **both rendered as `taskItemInfo-category` chips in the real To Do web client**. The registered one inherited its Outlook colour (`rgb(252,233,234)` / `rgb(208,27,42)`); the unregistered one used the default grey swatch (`rgb(204,204,204)` / `rgb(0,0,0)`). The unregistered value also had a working remove control and appeared in the "Pick a category" menu alongside the 6 master categories. **The only difference is colour, not visibility or data integrity.** Consequently, `MailboxSettings.ReadWrite`, master-category creation, and a lookup/creation table are **not** prerequisites for the P1 tag-to-categories mapping. See 8.12.

### 8.5 Decision state and prohibited claims

The decision output of `scripts/step2-baseline.mjs` remains `ct05: INSUFFICIENT_EVIDENCE` / `budgetStatus: UNMEASURED` / `reason: no accepted live evidence`. **This section does not change that.** A C-group probe result is not CT-05: CT-05 is a separate live measurement, and no C-group PASS may be used to flip `ct05`. The C-group probes also do not measure sync throughput, and C6 in particular must never be used to derive a "2,500 pairs" figure.

Per the report's design bindings, "0.8 s no-change round" is deleted by the Hybrid Delta decision (C3), the "2,500+ pairs" figure must not be derived from `$batch` (C6), "20 ms cached read" is removed by D1, "65% savings" is replaced by the BENCH-01 tables, and "30 s organization setup" is renamed to the administrator self-registration and consent script (D6). None of these are reinstated by any probe result in this section.

### 8.6 PROBE-01 (C1) - recurring completion

Status: **PASS**. Raw evidence: `C1.judged.json`, assembled from `C1.phase1.json` and `C1.phase2.json`, both kept verbatim.

| Field | Value |
| :--- | :--- |
| `status` | PASS |
| `at` / `scriptTimeZone` | 2026-11-07T10:53:45.090Z / Asia/Taipei |
| `httpCalls` | 47 (29 in execution 1, 18 in execution 2); counted, no retry |
| Recurrence variants (daily / weekly / numbered / expired endDate) plus `dueDateTime` control | 5 series, all `createCode` 201: `daily` = `{daily,1}` + `noEnd` from 2026-11-08; `weekly` = `{weekly,1,daysOfWeek:[sunday],firstDayOfWeek:sunday}` + `noEnd`; `numbered` = `{daily,1}` + `numberOfOccurrences: 2`; `endDatePast` = `{daily,1}` + `endDate` 2026-10-28 -> 2026-11-06, created overdue with due 2026-11-04; `control_due` = `{daily,1}` + `noEnd`, with `dueDateTime` PATCHed to 2026-11-15. Every completion PATCH was a single `{"status":"completed"}` and returned 200 |
| Snapshots (on response / +10s / +60s / next round): old ID retained, status, due | 4 time points: `immediate` (+0s), `plus10s`, `plus60s`, and `nextRound` from a **separate Apps Script execution** (`crossExecution: true`, `se: false`). All four returned code 200, 10 tasks in the list, 5 `completed`, 5 `notStarted`. The 5 `notStarted` are the **original IDs** (direct `GET /tasks/{id}` -> 200, `present: true`). Due per series after completion: `daily` 2026-11-09, `weekly` 2026-11-15, `numbered` 2026-11-09, `endDatePast` 2026-10-29, `control_due` 2026-11-09 |
| New ID born, with due / recurrence / createdDateTime | No new continuing ID: the original ID survives. One **`completed` history instance per series** is created, carrying the completed occurrence's due (`daily` / `weekly` / `numbered` 2026-11-08, `endDatePast` 2026-10-28, `control_due` 2026-11-15), each with the recurrence pattern and the range echoed |
| Reminder followed to the new instance | No. `rf: false` on 20/20 observations (5 series x 4 time points); `isReminderOn` stayed on the surviving task and the new occurrence did not inherit the completed occurrence's reminder time |
| Observed rollover model (a / b / c / indeterminate) | **A** - same ID re-opened to `notStarted` with the due advanced on the recurrence grid; a separate `completed` history instance holds the finished occurrence. Not "old ID stays completed + new ID continues" |
| Candidate recognition signals (pattern / range / projected next due / old completed) | Candidate count is exactly **1** per series at all four time points, so no identity ambiguity. Signals observed: recurrence pattern present, range present and anchored at `range.startDate`, projected next due derivable from that grid, and the old occurrence present as a `completed` instance. A title plus recent `createdDateTime` heuristic is explicitly not used and would have been wrong here |
| `cleanup` (listDeleted / tasksDeleted / residue) | `listDeleted: true`, `tasksDeleted: 10`, `residue: []`; cleanup deferred out of execution 1 into execution 2 and completed there |
| `error` | `null` |

### 8.7 PROBE-02 (C2) - `$expand=checklistItems`

Status: **PASS**.

| Field | Value |
| :--- | :--- |
| `status` | PASS |
| `at` / `scriptTimeZone` | 2026-11-07T10:55:00.461Z / Asia/Taipei |
| `httpCalls` | 123 (counted, single attempt per call) |
| Four count buckets (0 / 10 / 35 / 60 checklist items) | 105 items created in total across the four target buckets; every item create returned 201 (`createCodeHistogram` 10/35/60 all `201`, the 0 bucket created nothing). All four parent tasks created 201 |
| Expanded count vs direct per-parent count | Equal in all four groups: expanded 0 / 10 / 35 / 60 against direct 0 / 10 / 35 / 60, `countEqual: true` 4/4 |
| ID-set equality (bounded hash, never the raw ID set) | `idsEqual: true` 4/4, compared by a bounded hash of the sorted IDs; raw IDs are never emitted |
| `$expand` silently ignored | **False.** `expandPropSeenOnAnyTask: true`; the expanded collection is present on the 10 / 35 / 60 tasks. The 0-item task shows no `checklistItems` property at all, which is not negative evidence |
| `checklistItems@odata.nextLink` present and handled | Absent on every expanded task, including the 60-item group (`expandNavNextLink: false`, `directHasNextLink: false`); no pagination was needed on either path |
| `$select` returned HTTP 400 (prior finding at `providers.gs:392-394`) | Confirmed. `$select=id,title` -> 400 and `$select=id,title,checklistItems` -> 400; `$top=100` alone works. `$select` is effectively unusable on this endpoint |
| Direct per-parent fetch retained as fallback | Yes - the dedicated per-parent `GET /tasks/{id}/checklistItems` remains the reference read path; the probe compared against it, and it is retained |
| `cleanup` (listDeleted / tasksDeleted / residue) | `listDeleted: true`, `tasksDeleted: 4`, `residue: []` |
| `error` | `null` |

### 8.8 PROBE-03 (C3) - delta / child bubbling

Status: **PASS**.

| Field | Value |
| :--- | :--- |
| `status` | PASS |
| `at` / `scriptTimeZone` | 2026-11-07T10:55:28.367Z / Asia/Taipei |
| `httpCalls` | 19 |
| Initial `deltaLink` obtained (bounded flag only) | `gotDeltaLink: true`, 2 pages, `valueCount: 1`, `removedCount: 0`, `capped: false` |
| Child mutations (add / check / delete) and their codes | `POST checklistItem` -> 201, `PATCH isChecked` -> 200 (`isCheckedEcho: true`), `DELETE` -> 204 |
| Parent `todoTask` appeared in a subsequent `/delta` (child bubbling) | Yes, 3/3 (`containsParent: true` in `STAGE1_POST`, `STAGE2_PATCH_ISCHECKED`, `STAGE3_DELETE`). `initialDelta.containsParent` is a control observation only and is not counted as bubbling |
| Parent `lastModifiedDateTime` changed | Yes, 3/3 (`parentLmdtChangedFromInitial: true`; +1959 ms, +4151 ms, +5497 ms from the initial read) |
| `@removed` markers observed | None (`removedCount: 0` in the initial scan and in all three stages; the two operations are at `checklistItem` level and the parent task was never removed) |
| HTTP 410 expired token / full resync observed | None. `is410: false` on every delta call in all four stages and on `linkMutationTest`; no full resync was triggered |
| `delta?$expand=checklistItems` accepted | Accepted but not honoured. A fresh initial `GET /tasks/delta?$expand=checklistItems` returned 200 with `expandFieldSeen: false` and `expandItemCount: 0`. Adding `&$expand=...` to an existing `deltaLink` also returned 200, but that is a boundary test only (the docs advise against mutating delta query parameters) and is not evidence of support |
| `checklistItem` has no `lastModifiedDateTime` (documented assumption) | Confirmed: the parent `todoTask` carries `lastModifiedDateTime` (read code 200); the `checklistItem` resource does not expose one |
| `cleanup` (listDeleted / tasksDeleted / residue) | List delete 204, task delete 204, `residue: []` |
| `error` | `null` |

Token discipline: 5 `deltaLink` values obtained, 4 consumed, 1 deliberately discarded unconsumed. Each link was consumed exactly once and then replaced or dropped; no retry and no reuse.

### 8.9 PROBE-04 (C4) - `#tag` -> `categories[]`

Status: **PARTIAL**. The unregistered-string branch produced clean evidence; the registered-category and rename branches did not run.

| Field | Value |
| :--- | :--- |
| `status` | PARTIAL |
| `at` / `scriptTimeZone` | 2026-11-07T10:55:50.531Z / Asia/Taipei |
| `httpCalls` | 8 |
| Unregistered category PATCH: accepted / silently ignored / HTTP 400 | **Accepted.** `PATCH {categories:["TTS_Unregistered_Test"]}` -> 200; the patch response and the readback each carry exactly that one category (`containsTarget: true`, `exactlyOneTarget: true`) -> verdict `ACCEPTED` |
| Readback of `categories[]` after PATCH | Readback 200, `count: 1`, `containsTarget: true`, `exactlyOneTarget: true`; `settleMsBeforeReadback: 500` is a final-consistency wait, not a retry |
| `/me/outlook/masterCategories` lookup (count only, names never recorded) | `GET` -> 200, `existingCount: 6`. Category names were deliberately not dumped |
| Registered `displayName` comparison | `NOT_RUN_DEPENDENCY_BLOCKED` (`blockedBy: masterCategoryCreate`, `createCode: 403`); `comparison.difference: NOT_COMPARABLE_REGISTERED_BRANCH_BLOCKED`. No verdict is claimed for the registered branch |
| Rename not attempted (`displayName` is read-only per official docs) | `RENAME_NOT_ATTEMPTED`, `attempted: false`. `outlookCategory.displayName` is read-only and the update API only permits changing `color`, so a rename cannot be performed through the API at all; simulating an Outlook-client rename would mutate real mailbox state |
| Master-category lookup table required | **Not decided by this round.** The branch that would test it is `NOT_RUN_DEPENDENCY_BLOCKED`, so no evidence either way is claimed here |
| Last-written category name must be persisted | **Yes.** Because a rename is impossible via the API, a `#tag` that maps to an outdated category name cannot be repaired by renaming; the sync must keep the last-written category name to avoid resurrecting a stale tag |
| `cleanup` (listDeleted / tasksDeleted / residue) | List delete 204, task delete 204, `residue: []`; no category was created, so no category DELETE was attempted (`deleteAttempted: false`, reason `NO_CATEGORY_CREATED`) |
| `error` | `null` |

Scope boundary measured: `POST /me/outlook/masterCategories` -> **403 `ErrorAccessDenied`**, `status: BLOCKED_MISSING_SCOPE`, `requiredScope: MailboxSettings.ReadWrite`, `grantedScope: MailboxSettings.Read` (`globals.gs:13`), `created: false`. This is valid boundary evidence, not a probe defect: no retry was made, no category was fabricated, and nothing was thrown to abort the probe. Because the registered and rename branches never ran, **this probe's** verdict remains **PARTIAL** and is not retroactively upgraded.

**Follow-up C7 closes the evidence gap without a scope change.** The registered branch was re-run by reusing one of the 6 already-existing master categories instead of creating a disposable one - the original dependency was self-imposed, not a real requirement. Both branches returned `ACCEPTED` with identical PATCH/readback behaviour, and the To Do web client rendered both. Renaming remains impossible through the API (`displayName` is read-only) and is still `RENAME_NOT_ATTEMPTED`; it has no product meaning because the sync never renames a user's category. **Design binding now closed:** no master-category lookup/creation table, no `MailboxSettings.ReadWrite`, and no re-consent are needed for tag-to-categories correctness. P1 as a whole is still **not** unlocked: its own requirements (opt-in toggle, dry-run preview, and the "no marker = leave alone" fingerprint rules) are not measured by any C-group probe.

Note on an earlier claim in this document: `MS_PERSONAL_SCOPE_` is a Microsoft Graph delegated scope used by the Device Code flow, **not** a Google scope in `appsscript.json`. Adding it would not change the Google consent page, and `msAuthoredTimeZone_()` at `providers.gs:765-790` already establishes the project's fail-soft pattern for tokens issued before a scope change ("pre-re-consent tokens ... yields null and callers fall back"). Any future incremental-consent work is a wizard capability decision, not a prerequisite for this feature.

### 8.10 PROBE-05 (C5) - `linkedResources` / attachments

Status: **PASS**, and it refutes the `$expand` premise recorded at `public/providers.gs:392-396`.

| Field | Value |
| :--- | :--- |
| `status` | PASS |
| `at` / `scriptTimeZone` | 2026-11-07T10:56:13.980Z / Asia/Taipei |
| `httpCalls` | 14 |
| `POST /linkedResources` (v1.0, delegated `Tasks.ReadWrite`) | 201, with a synthetic `externalId` and `applicationName ZZ_C5_Probe`; `idReturned: true` (length 36) |
| Dedicated `linkedResources` collection GET | 200, `collectionCount: 1`, `readbackExternalIdMatch: true`, `readbackApplicationNameMatch: true`, `webUrl` present, `readbackFieldCount: 5`; after `DELETE` 204 the collection count is 0 |
| `$expand=linkedResources` silently ignored (prior finding) | **Refuted.** The baseline `GET` without `$expand` already carries the collection (`baselineHostItemCount: 1`, `baselineHostPropPresent: true`), and `$expand` changes nothing (`expandChangesData: false`, `expandIgnored: false`). The parameter is not dropped; it is redundant. A plain task listing must not be assumed link-free |
| Single sub-3MB file POST to v1.0 `/attachments` | 201, no upload session. `contentBytes` sent as a base64 string in a JSON body with `@odata.type #microsoft.graph.taskFileAttachment`; 4129 raw bytes / 5508 base64 chars; `responseSize: 4395`; `DELETE` -> 204 |
| `externalId` (Drive file ID or Gmail message ID) defined | Yes. The probe sent a synthetic value and it round-tripped; the product mapping is the Drive file ID or the Gmail message ID |
| `applicationName` defined | Yes, sent and round-tripped in the readback |
| Read / write paths kept separate | Yes: write path is `POST /linkedResources` (`writePathPost: true`), read path is the dedicated collection `GET` (`readPathDedicatedCollectionGet: true`) |
| Upload Session used (design binding: must be false) | `false` (`uploadSessionUsed: false`); a sub-3 MB file needs a single POST |
| `cleanup` (listDeleted / tasksDeleted / residue) | `listDeleted: true`, `tasksDeleted: 2`, `linkResidue: false`, `residue: []` (the attachment was removed with the list) |
| `error` | `null` |

### 8.11 `$batch` positioning (C6)

Status: **PASS**. Every sub-request status was read from the batch payload, never inferred from the batch code.

| Field | Value |
| :--- | :--- |
| `status` | PASS |
| `at` / `scriptTimeZone` | 2026-11-07T10:56:36.364Z / Asia/Taipei |
| `httpCalls` | 16 |
| `POST /$batch` code and batch size (limit 20) | Independent pair -> batch 200 with `responseCount: 2`; `dependsOn` pair -> batch 200 with `responseCount: 2`; 21 sub-requests -> top-level **400** with `responseCount: 0`. The documented 20-item cap holds |
| Per-sub-request status recorded individually (batch 200 is not child success) | Yes. Independent pair: **200 / 200**. `dependsOn` pair: **200 / 200**. Failed dependency: batch **200** while the sub-statuses are **400** and **424** - proving a batch 200 is neither a transaction nor a success proxy |
| Lone sub-request HTTP 429 and `Retry-After` backoff | 429 was deliberately **not** induced (`THROTTLE_NOT_INDUCED: true`, `natural429Observed: false`, no retries enabled). Per-sub-response `Retry-After` readability was verified (`retryAfterReadable: true`), but no backoff was observed |
| `dependsOn` ordering and dependency-failure HTTP 424 | Order exactly `g2a -> g2b`, both 200 (`orderAsExpected: true`); a failed dependency produced **400** then **424** for the dependent request |
| Treated as a transaction (design binding: must be false) | `false`. The 400/424 pair inside a 200 batch is the proof |
| Upload Session PUT excluded from the batch | Yes (design binding). No upload session exists in this round, so the rule is asserted from the design, not re-measured |
| Journal-first and per-ID status checks retained | Yes; the round confirms they are mandatory, since the batch code alone carries no per-item outcome |
| `cleanup` (listDeleted / tasksDeleted / residue) | `listDeleted: true`, `tasksDeleted: 4`, 1 checklist item deleted, `residue: []` |
| `error` | `null` |

The `$batch` probe saves round-trips only. It must never be treated as a transaction and must never be used to derive a "2,500 pairs" claim.

### 8.12 Follow-up (C7) - registered vs unregistered categories and client visibility

C7 is a supporting follow-up to C4, not one of the six prerequisite probes. It was added after the C1-C6 run specifically to answer two questions C4 left open: whether a **registered** `categories[]` value behaves differently from an unregistered one, and whether an unregistered value is actually visible to a user in Microsoft To Do. It ran on the same TEST Microsoft account, in two separate Apps Script executions, serially after all six probes were complete.

Design: one disposable list, two tasks. `ZZ_C7_UNREG` received `categories:["TTS_Unregistered_Test"]` (absent from `/me/outlook/masterCategories`); `ZZ_C7_REG` received `categories:[<an existing masterCategory displayName>]`, chosen from the 6 real entries returned by the read-only `GET`. **No `POST`, `PATCH`, or `DELETE` was issued to master categories**, so no new scope, no re-consent, and no mailbox-settings mutation were involved. Execution 1 deliberately left both tasks alive for one browser observation; execution 2 deleted both tasks and the list (all 204) and cleared its pending state. Real category names and Graph IDs were never emitted; only counts, bounded hashes, status codes, and booleans.

| Field | Value |
| :--- | :--- |
| Execution 1 `httpCalls` / phase | 8 / `awaitingUiCheck`, `cleanup.deferred: true` |
| Master categories read | `GET` 200, `existingCount: 6`, `reusableNameAvailable: true` |
| Unregistered task (`ZZ_C7_UNREG`) | create 201, PATCH 200, readback 200, `count: 1`, `containsTarget: true`, verdict `ACCEPTED` |
| Registered task (`ZZ_C7_REG`) | create 201, PATCH 200, readback 200, `count: 1`, `containsTarget: true`, verdict `ACCEPTED` |
| API-level difference | `NO_DIFFERENCE_AT_API_LEVEL` |
| To Do web list view | Both chips visible, both rendered as `taskItemInfo-category`. Registered swatch `rgb(252,233,234)` / border `rgb(208,27,42)` (red). Unregistered swatch `rgb(204,204,204)` / border `rgb(0,0,0)` (default grey) |
| To Do web task detail | Unregistered chip visible, with a working remove control (`Remove ...` and the localised delete-category button) |
| "Pick a category" menu | 6 master categories plus the unregistered string as an option |
| Execution 2 cleanup | `taskA.deleted: true`, `taskB.deleted: true`, `list.deleted: true`, all 204; `pendingCleared: true`; the list also disappeared from the To Do sidebar after a reload |
| Remote project state after C7 | Restored to 21 formal files, no `zz_c*` residue; personal clasp credential hash unchanged |

**Conclusion - no functional gap.** An unregistered `categories[]` value is written, read back, rendered, removable, and selectable in the real To Do web client. Registering a category adds **colour only**. Therefore the P1 tag-to-categories mapping does **not** require `MailboxSettings.ReadWrite`, does **not** require master-category creation, and does **not** require a lookup/creation table for correctness. C4's 403 remains valid permission-boundary evidence, but it is **not a blocker** for this feature.

Limits: the observation covers the To Do **web** client only; desktop and mobile clients were not inspected. Colour is cosmetic, not a data-integrity difference, and no claim is made about Outlook Mail rendering. C7 does not measure sync throughput and must not be used to change `decision.ct05`, which stays `INSUFFICIENT_EVIDENCE`. Raw evidence: `results/C7.phase1.json`, `results/C7.phase2.json`, and the browser observation record `results/C7.ui.json`.
