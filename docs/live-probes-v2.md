# Live probes and local baselines for v2

Status: **P0-1 (A1-A5) complete and merged; P0-2 local baselines measured; C-group Microsoft Graph probes NOT RUN.**

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

## 8. C-group prerequisite status (NOT STARTED)

The six Microsoft Graph probes (PROBE-01 ~ 05 plus the `$batch` probe) are
**not run**. No result table or design binding below is asserted.

Microsoft Personal Device Code authorization **is** now in place on the TEST
project, obtained without an Azure app registration or client secret:
`Setup.html:555`, `auth.gs:12-14`, `docs/e2e-validation.md:18`. The public
client id and consumers authority are `globals.gs:11-12`; the requested scope
is `Tasks.ReadWrite MailboxSettings.Read offline_access` (`globals.gs:13`).
Result: `status: authorized`, `verified: true`, `tokensPresent: true`,
`mode: personal_device`. `verified` is backed by a real Graph call to
`MS_TODO_BASE?$top=1&$select=id` with response-shape validation
(`auth.gs:108-140`), not a local flag.

`SYNC_LIST_PAIRS_JSON` is **not configured**. It is required by `syncAll()`
(`config.gs:206-230`, gated by `SYNC_GOOGLE_LIST_IDS` allowlist at
`config.gs:126-131`), but the C-group probes call Graph directly and do not
require it. A full `syncAll()` live run therefore remains out of scope until
list pairs are configured.

| Probe | Status |
| :--- | :--- |
| PROBE-01 recurring completion | NOT RUN |
| PROBE-02 `$expand=checklistItems` | NOT RUN |
| PROBE-03 delta / child bubbling | NOT RUN |
| PROBE-04 `#tag` -> `categories[]` | NOT RUN |
| PROBE-05 `linkedResources` / attachments | NOT RUN |
| `$batch` positioning | NOT RUN |

Until these complete and their results are written into this file, no C-group
behaviour may be used as a premise for product code.
