import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

// 2026-10-12 personal-production incident: a microsoft_to_google batch of 25
// items with every entry ACKED wedged forever on TASK_CREATE_FINALIZE_MISSING
// after the Microsoft source tasks were deleted mid-flight.  The finalize
// guard is correct fail-closed behaviour, but no operator exit existed for an
// ACKED-complete batch, so every trigger round rethrew the same fatal error.
// task-create-recovery.gs adds the evidence-gated release exit.  These tests
// pin the classification matrix and the guards that make it safe.

function load() {
  const values = {};
  const props = {
    getProperty(k) { return values[k] || null; },
    setProperty(k, v) { values[k] = String(v); },
    deleteProperty(k) { delete values[k]; }
  };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: { sleep() {}, getUuid: () => '00000000-0000-4000-8000-000000000000' }
  });
  runGasFilesInContext(c);
  // Top-level const declarations live in the context's shared global lexical
  // scope, not on the context object — re-read them explicitly for assertions.
  c.__CONFIRM = vm.runInContext('typeof TASK_CREATE_RELEASE_CONFIRMATION === "string" ? TASK_CREATE_RELEASE_CONFIRMATION : null', c);
  // Heavy infrastructure is stubbed; the unit under test is the recovery
  // classification and its guards, not the state codec or the lock service.
  c.initializeExecutionBudget_ = function () {};
  c.withGlobalLock_ = function (fn) { return fn(); };
  c.assertNoActiveSyncRoundFence_ = function () {};
  c.isNotFoundError_ = function (e) { return !!(e && e.__notFound); };
  c.normalizeState_ = function () {};
  let saved = null;
  c.saveState_ = function (state) { saved = JSON.parse(JSON.stringify(state)); };
  c.__saved = () => saved;
  let progressCleared = false;
  c.taskCreateProgressClear_ = function () { progressCleared = true; };
  c.__progressCleared = () => progressCleared;
  return c;
}

function batchState(c, { direction = 'microsoft_to_google', entries = 'acked', items = 1 } = {}) {
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  const batchItems = [];
  for (let i = 0; i < items; i++) {
    batchItems.push({
      sourceListId: direction === 'microsoft_to_google' ? 'msList' : 'gList',
      sourceTaskId: 'src' + i,
      destinationListId: direction === 'microsoft_to_google' ? 'gList' : 'msList',
      sentinel: '<<TTS-SENT-' + i + '>>',
      uuid: 'u' + i,
      direction
    });
  }
  state.taskCreateBatch = { batchId: 'b1', direction, phase: 'CLEANUP_PENDING', items: batchItems };
  const progress = { batchId: 'b1', boundary: null, entries: {} };
  for (let i = 0; i < items; i++) {
    progress.entries[i] = entries === 'acked'
      ? { status: 'ACKED', destinationId: 'dst' + i }
      : { status: 'HELD_ZERO' };
  }
  c.taskCreateProgressRead_ = function () { return JSON.parse(JSON.stringify(progress)); };
  c.loadStateForSync_ = function () { return state; };
  return { state, progress };
}

function stubProviders(c, { msSource, gDest } = {}) {
  // msSource/gDest: 'alive' | 'missing' | 'readfail'
  c.getMsTask_ = function (listId, id) {
    if (msSource === 'missing') { const e = new Error('404'); e.__notFound = true; throw e; }
    if (msSource === 'readfail') throw new Error('HTTP 503');
    return { id: id, title: 'ms' };
  };
  let gNotes = { dst0: 'body <<TTS-SENT-0>> tail' };
  c.getGTask_ = function (listId, id) {
    if (gDest === 'missing') { const e = new Error('404'); e.__notFound = true; throw e; }
    if (gDest === 'readfail') throw new Error('HTTP 503');
    return { id: id, notes: gNotes[id] == null ? 'plain' : gNotes[id] };
  };
  c.__gNotes = gNotes;
  c.updateGTask_ = function (listId, id, patch) {
    assert.equal(listId, 'gList');
    gNotes[id] = patch.notes;
    return { id: id };
  };
}

test('Release: SOURCE_LOST_DEST_ALIVE previews SAFE and apply clears the batch, strips sentinels, keeps tasks', () => {
  const c = load();
  const { state } = batchState(c, { items: 2 });
  stubProviders(c, { msSource: 'missing', gDest: 'alive' });
  const preview = c.previewTaskCreateBatchRelease();
  assert.equal(preview.active, true);
  assert.equal(preview.verdict, 'SAFE');
  assert.equal(preview.items[0].verdict, 'SOURCE_LOST_DEST_ALIVE');
  assert.equal(preview.items[1].verdict, 'SOURCE_LOST_DEST_ALIVE');

  const report = c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM });
  assert.equal(report.released, 2);
  assert.equal(state.taskCreateBatch, null);
  assert.equal(c.__progressCleared(), true);
  assert.ok(c.__saved(), 'state was saved');
  // Survivor G twins keep their content; only the engine sentinel is removed.
  assert.equal(c.__gNotes['dst0'], 'body  tail');
});

test('Release: confirmation gate refuses anything but the exact release string', () => {
  const c = load();
  batchState(c, {});
  stubProviders(c, { msSource: 'missing', gDest: 'alive' });
  assert.throws(() => c.applyTaskCreateBatchRelease({}), /CONFIRMATION_REQUIRED/);
  assert.throws(() => c.applyTaskCreateBatchRelease({ confirmation: 'yes' }), /CONFIRMATION_REQUIRED/);
  assert.equal(c.__saved(), null, 'no state write happened');
});

test('Release: BOTH_ALIVE is NOT_SAFE (the batch should finalize, not release)', () => {
  const c = load();
  const { state } = batchState(c, {});
  stubProviders(c, { msSource: 'alive', gDest: 'alive' });
  const preview = c.previewTaskCreateBatchRelease();
  assert.equal(preview.verdict, 'NOT_SAFE');
  assert.match(preview.reasons.join(' '), /both sides alive/);
  assert.throws(() => c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM }),
    /NOT_SAFE/);
  assert.ok(state.taskCreateBatch, 'batch untouched');
});

test('Release: a failed provider read is READ_FAIL and blocks apply', () => {
  const c = load();
  const { state } = batchState(c, {});
  stubProviders(c, { msSource: 'readfail', gDest: 'alive' });
  const preview = c.previewTaskCreateBatchRelease();
  assert.equal(preview.verdict, 'NOT_SAFE');
  assert.equal(preview.items[0].verdict, 'READ_FAIL');
  assert.throws(() => c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM }),
    /NOT_SAFE/);
  assert.ok(state.taskCreateBatch, 'batch untouched');
});

test('Release: non-ACKED entries block release (they belong to the HELD_* operator flow)', () => {
  const c = load();
  const { state } = batchState(c, { entries: 'held' });
  stubProviders(c, { msSource: 'missing', gDest: 'alive' });
  const preview = c.previewTaskCreateBatchRelease();
  assert.equal(preview.verdict, 'NOT_SAFE');
  assert.throws(() => c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM }),
    /NOT_SAFE/);
  assert.ok(state.taskCreateBatch, 'batch untouched');
});

test('Release: DEST_LOST_SOURCE_ALIVE is SAFE (survivor source reposts; nothing is deleted)', () => {
  const c = load();
  const { state } = batchState(c, {});
  stubProviders(c, { msSource: 'alive', gDest: 'missing' });
  const preview = c.previewTaskCreateBatchRelease();
  assert.equal(preview.verdict, 'SAFE');
  assert.equal(preview.items[0].verdict, 'DEST_LOST_SOURCE_ALIVE');
  const report = c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM });
  assert.equal(report.released, 1);
  assert.equal(state.taskCreateBatch, null);
});

test('Release: BOTH_LOST is SAFE (nothing exists anywhere; drop the empty batch)', () => {
  const c = load();
  const { state } = batchState(c, {});
  stubProviders(c, { msSource: 'missing', gDest: 'missing' });
  const preview = c.previewTaskCreateBatchRelease();
  assert.equal(preview.verdict, 'SAFE');
  assert.equal(preview.items[0].verdict, 'BOTH_LOST');
  const report = c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM });
  assert.equal(report.released, 1);
  assert.equal(state.taskCreateBatch, null);
});

test('Release: apply re-verifies live evidence and refuses when the survivor vanished mid-apply', () => {
  const c = load();
  const { state } = batchState(c, {});
  stubProviders(c, { msSource: 'missing', gDest: 'alive' });
  // Survivor disappears between classification and the strip step.
  const realGetG = c.getGTask_;
  let calls = 0;
  c.getGTask_ = function (listId, id) {
    calls++;
    if (calls >= 2) { const e = new Error('404'); e.__notFound = true; throw e; }
    return realGetG(listId, id);
  };
  assert.throws(() => c.applyTaskCreateBatchRelease({ confirmation: c.__CONFIRM }),
    /EVIDENCE_CHANGED/);
  assert.ok(state.taskCreateBatch, 'batch untouched when evidence changed');
  assert.equal(c.__saved(), null);
});
