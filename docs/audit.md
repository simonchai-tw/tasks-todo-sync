# v0.2.1 engineering audit

Audit scope: 0.2.1 — 2026-08-31

## Release decision

`v0.2.1` is a stable personal, single-operator synchronization release. It includes compressed and integrity-checked state, backward-compatible migration, guarded deletion, recovery journals, tombstones, bounded diagnostics, and destination-first cross-list moves. Fresh projects enable automatic list discovery, task deletion, list deletion, and task moves; existing explicit Script Properties are preserved.

The core implementation is covered by 229 automated tests, CI, and CodeQL. Recorded bidirectional real-account checks cover task deletion, list deletion, and cross-list moves in the maintainer's private deployment. Local deterministic validation also exercises 600 tracked task pairs across synchronization, deletion, movement, recovery, pagination, and long-content scenarios. The 600-pair validation is provider-free and does not establish a universal provider or Apps Script runtime guarantee.

## Scope verification

- CLI time-zone handling parses and updates manifest JSON, so non-`Asia/Taipei` IANA zones do not depend on formatting.
- An incomplete run discards only current-round proof and retains the previous successful task/list-deletion baseline.
- Restore reads a separately committed successful generation, never an intra-round checkpoint. An upgraded deployment needs one verified successful sync first; legacy state without verifiable evidence fails closed.
- Metadata-only Google edits leave an existing Microsoft rich-text body unchanged; a changed notes projection updates the body.
- Authorization refresh/retry and fatal alerts are bounded. Fatal alerts are redacted. Persisted health errors contain status and bounded internal/request codes rather than raw provider responses.
- New state generations use gzip+Base64, codec metadata, UTF-8 decoded-size checks, and SHA-256 integrity. At most three generations are transiently retained during promotion.
- New move journals use compact Base64 SHA-256 fingerprints. Legacy canonical raw JSON fingerprints remain readable only on exact match.

## Cross-list move boundary

Cross-list moves use a destination-first replacement: the new counterpart is created and verified under a durable recovery journal before the old counterpart is retired. Provider IDs change, and provider-only metadata without a cross-platform equivalent may not transfer.

Google-origin moves create the destination counterpart, read it back, verify the durable correlation marker and live source evidence, and only then retire the old Microsoft counterpart. Microsoft-origin moves create the new Google counterpart first; the old Google counterpart is retired through the ordinary two-round deletion confirmation and live-revalidation path. With task deletion disabled, that old counterpart remains. These are different provider paths, not one atomic cross-cloud transaction.

Automated coverage includes exact marker identity, journal recovery, source revalidation, conflict handling, duplicate prevention, and field conversion. `dryRunReport()` does not expand attachment, checklist, linked-resource, or unrelated extension relationships; those fields are uninspected rather than asserted absent.

## Scheduling and diagnostics boundary

The supported trigger cadence is 10 minutes. Apps Script permits at most six minutes per execution; the script budget is 5.25 minutes. Destructive paths reserve additional time before live reads, journal writes, or remote mutation. A time-budget exit starts a complete inventory on the next invocation: no page cursor, Graph delta token, or shard checkpoint is persisted. Page-token and page-count guards fail closed on repeated tokens, unreasonable counts, or insufficient execution time.

Per-round `durationMs`, `urlFetchCalls`, and `stateSaveCalls` are bounded, content-free values recorded only in the execution log. `sync_summary` is written only to the execution log; a 360 KiB threshold sends the storage-pressure email. `healthCheck()` does not display byte counts or these metrics.

## Storage capacity boundary

There is no fixed task-count limit. The 600-pair evidence combines a provider-free Node/zlib capacity model with separate `Code.gs` runs in a Node VM against fake providers; neither is a real Google Apps Script or provider wall-clock measurement. The observed Node-model projected peaks were:

| Scenario | Peak bytes |
| --- | ---: |
| Dense | 181,797 |
| Sparse | 196,672 |
| Steady-state / long Unicode | 183,669 |
| Deletions plus tombstones | 384,334 |

Six hundred simultaneous blocked move journals projected 475,030 bytes: 14,230 bytes above the 450 KiB preflight envelope, so the write fails closed before provider mutation. A separate 1,200-pair move-journal saturation probe reached 1,214,804 bytes; that is a storage cliff, not a support claim.

The measured model and implementation boundaries include an 8 KiB per-property value limit, a 450 KiB aggregate User Properties preflight envelope, a 360 KiB storage-pressure notification threshold, 7,000-character chunks, up to 100 chunks per generation, a 2 MiB uncompressed state limit, three retained generations at peak, 30-day tombstone retention, and the 5.25-minute execution budget. These limits fail closed and alert; they do not promise a fixed task-count envelope.

Normal fresh state does not store task titles, notes, or bodies in the mapping store. Long notes affect provider payload size and runtime, not the mapping store itself. Legacy journals and raw state exports can still contain sensitive material and must remain private.

## Evidence reviewed

- 229 automated tests, CI, CodeQL, static checks, package smoke validation, and the deterministic 600-pair VM/capacity run were recorded for the release worktree.
- Bidirectional real-account validation covered task deletion, list deletion, and cross-list movement. The observations were bounded and omitted private mappings, task/list counts, timestamps, project identifiers, credentials, and Apps Script version numbers.
- Release publication and deployment execution are separate from source inspection; this audit does not infer evidence that was not observed.

## Follow-up validation expansion

Automated coverage already includes 401 refresh/retry behavior, state-restore safeguards, and field conversion. The remaining expansion is real-account and operational rehearsal:

- provider consent revocation followed by reauthorization;
- deployed source rollback and deployed state rollback;
- a complete bidirectional field matrix;
- interrupted moves and concurrent-edit failure modes.

These are follow-up validation activities, not claims that the automated safeguards are absent. Provider APIs still do not provide one atomic cross-cloud move; current protection is durable journaling, fresh rereads, fail-closed conflict handling, and recoverable residue.
