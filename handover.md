# Step 2 Production Handover

## Current state

- Production repository: `C:\Users\simon\Code\GitHub\Tasks-ToDo-Sync\public`
- Baseline HEAD: `88fa48f98f354c750a789f5905d441467793a6e3` (`v0.4.0`)
- Working tree at Step 2 start: clean
- Current release: `0.4.0`

## Completed work items

- Step 2A.0 baseline review: the current full test suite passes.
- The required Microsoft-to-Google semantic no-op cases already exist and pass: timestamp-only changes, unsupported-field-only changes with baseline advancement, equivalent notes, unsafe due projection, and a Microsoft LWW winner whose shared semantics already match.
- Phase 2A.1/2A.2 hermetic baseline: missing, malformed, or simulated CT-05 evidence deterministically selects `BOUNDED_DIRECT_GET`; only sanitized live evidence can select an `$expand` architecture. The actual production state writer/reader is exercised at 100, 300, and 600 ordinary mappings with zero provider calls.
- Phase 2A.3 schema-v4 foundation: strict source validation and lossless `2 -> 3 -> 4` / `3 -> 4` migration; the full eight-container namespace; empty-only future tables; strict ownership records; default-OFF configuration; and unconditional mapping/journal/conflict ID reservation at ordinary-create gates.
- Phase 2A.4 read-only relationship discovery: strict direct checklist pagination with complete-only observations, fail-closed error classes, durable fair parent-attempt scheduling, and separate request metrics. Production remains inert while the relationship budget is `UNMEASURED`.
- Phase 2A.5 compatibility and candidate classification: legacy-flat precedence, one-level child eligibility, parent-not-ready deferral, checklist-ID-only identity, feature-off ownership reservation, and reservation-only pending reparent/unnest/cross-list classifications. Ordinary create consumes only ephemeral reservations; classification performs no provider calls or state writes.

## In progress

- Phase 2A.6 one-level create/update is design-mapped but STOP-gated by missing live provider contracts and the still-unmeasured relationship budget. No provider writes are enabled yet.

## Verification completed

- `npm test -- --test-reporter=dot` — passed at baseline HEAD.
- Repository identity and cleanliness verified with `git rev-parse HEAD` and `git status --short`.
- `node --test tests/step2-baseline.test.mjs` — 5/5 passed.
- `npm run baseline:step2 -- --compact` — passed; `providerCalls=0`, accepted CT-05 live evidence absent, architecture `BOUNDED_DIRECT_GET`, budget `UNMEASURED`.
- Production-codec VM preflight passed at 100/300/600 mappings (persisted property bytes: 8,485 / 28,591 / 61,434). This is explicitly not Apps Script wall-clock evidence.
- `npm run stress:600`, `npm run check`, full `npm test -- --test-reporter=dot`, and `git diff --check` — passed after the baseline harness change.
- Schema-v4/reservation targeted tests, `tests/sync.test.mjs`, `tests/step2-baseline.test.mjs`, full `npm test -- --test-reporter=dot`, `npm run stress:600`, `npm run check`, and `git diff --check` — passed after Phase 2A.3.
- `node --test tests/relationship-discovery.test.mjs tests/sync.test.mjs` and `git diff --check` — passed after Phase 2A.4.
- `node --test tests/subtask-classification.test.mjs tests/relationship-discovery.test.mjs tests/step2-baseline.test.mjs` and `git diff --check` — passed after the independent Phase 2A.5 review fixes.
- Full `npm test -- --test-reporter=dot`, `npm run smoke:package`, `npm run baseline:step2 -- --compact`, `npm run check`, and `git diff --check` — passed after both new GAS modules were added to the deployment allowlists.

## Provider facts

- Grok's CT-01 through CT-11 results are simulator evidence only; the live labels remain `INSUFFICIENT_EVIDENCE`.
- The CT-05 follow-up made zero Graph calls. `$expand=checklistItems` is not accepted as an authoritative contract.
- Until accepted sanitized live CT-05 evidence exists, discovery must conservatively use bounded per-parent direct GET and must keep the request budget `UNMEASURED`.

## Unresolved issues / STOP gates

- Child/checklist production writes remain gated by the relevant live provider contract probes.
- Child deletion and optional reparent remain gated by successful CRUD evidence plus their dedicated contract probes and recovery tests.
- Both recurrence-owner directions remain `INSUFFICIENT_EVIDENCE`; no recurrence-specific production machinery is justified.
- No local artifact proves which staging Apps Script project is currently owned by the disposable Google account. `private-deployment` is personal by purpose; `e2e-device-flow-fresh`, `e2e-staging`, and `e2e-staging-test` remain account-identity `UNKNOWN`. Do not run live probes or `clasp push` until a human verifies the active Google account in the Apps Script editor and confirms the paired Microsoft authorization is also disposable.
- The built-in browser was initially unavailable; after the user opened it, the schema-shape consultation completed. It independently selected the full eight-container v4 namespace, empty-only future tables, strict source-before-migration validation, unconditional ownership reservation, and a frozen contract after public release. The local record is `.codex/consultations/20260908-schema-v4-contract.md`.

## Phase 2A.6 completion

- Sanitized live evidence: relationship reads 458/358/342 ms; cleanup verification `google=true`, `microsoft=true`; Google `previous` behavior remains unstable; Microsoft checklist CRUD is stable, including title edge cases. Credentials, task names, and provider IDs are not retained.
- Implemented disabled-by-default one-level Google child ↔ Microsoft checklist create/update with exact field payloads, durable create/update intents, complete-observation gating, structural quarantine, and no-retry provider seams. No deletion, reparent, unnest, cross-list, recurrence, attachment, or ordering behavior was added.
- Direct checklist discovery is wired to exactly 10 parent collection-read attempts per run with fair attempt-epoch rotation.

## Next action

- Phase 2A.6 implementation and hermetic verification are complete. Keep `SYNC_ENABLE_SUBTASKS` off until a human explicitly enables the separately recorded disposable-account evidence gate.

## Latest release checkpoint

- `v0.4.0` at `88fa48f98f354c750a789f5905d441467793a6e3` (pre-Step-2 baseline).
- Per user direction, there will be no intermediate GitHub releases. The next commit/push/release checkpoint is after the complete Step 2 final gate passes.

## Grok / review disposition

- Adopted as design evidence only: default-OFF/pause-reserve semantics, direct per-parent observation as the conservative fallback, three-way shared-field merge, and two-independent-observation deletion philosophy.
- Rejected as production-ready: every prototype package. Reviews found unresolved reservation, starvation, ambiguous-create, restart, reparent, and deletion-evidence defects; PKG-06 includes a duplicate-create P0.
- PKG-09 supports only the decision to add no recurrence machinery before live lifecycle evidence.
- Prototype code is implementation reference only and is not copied into production as a patch.
- PKG-02/PKG-04 reservation findings were adopted and repaired: conflicts, every active journal ID, and committed mappings reserve ownership even while OFF; parent IDs themselves remain ordinary so a parent can still obtain its required mapping.
