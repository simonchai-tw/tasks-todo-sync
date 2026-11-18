import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

// Rotation rebind: a recurring Microsoft task makes Google regenerate its copy
// under a fresh id every day.  The mapping must follow that id, or the create
// batch duplicates the Microsoft task and the Time Bridge inserts a second
// Calendar event.  These tests pin the identity fix and every fail-closed exit.

function load() {
  const values = {};
  const props = {
    getProperty(k) { return values[k] || null; },
    setProperty(k, v) { values[k] = String(v); },
    deleteProperty(k) { delete values[k]; }
  };
  const calls = { remote: 0 };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: { sleep() {}, getUuid: () => '00000000-0000-4000-8000-000000000000' },
    Calendar: {
      Events: {
        get() { calls.remote += 1; },
        insert() { calls.remote += 1; },
        patch() { calls.remote += 1; },
        remove() { calls.remote += 1; }
      }
    },
    UrlFetchApp: {
      fetch() { calls.remote += 1; return { getContentText() { return '{}'; } }; }
    }
  });
  runGasFilesInContext(c);
  return { c, calls };
}

const RECURRENCE = { pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd' } };
const STAMP = '2026-01-01T00:00:00Z';

function gTask(id, title, code) {
  return { id, title, updated: STAMP, notes: code ? '[TTS-REC:' + code + ']\nuser body' : 'user body' };
}
function msTask(id, title, withRecurrence = true) {
  return { id, title, lastModifiedDateTime: STAMP, recurrence: withRecurrence ? RECURRENCE : null };
}
function baseState(c) {
  const s = c.newState_();
  s.listMap['g-list'] = 'ms-list';
  return s;
}
function snapFor({ gTasks = [], msTasks = [], complete = true } = {}) {
  const snap = {
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    inventoryComplete: complete,
    safety: { allowDeletions: true, allowTaskMoves: false },
    gTasksById: {}, msTasksById: {}, gListByTask: {}, msListByTask: {}
  };
  gTasks.forEach((t) => { snap.gTasksById[t.id] = t; snap.gListByTask[t.id] = 'g-list'; });
  msTasks.forEach((t) => { snap.msTasksById[t.id] = t; snap.msListByTask[t.id] = 'ms-list'; });
  return snap;
}
function mappedOldPair(state, extra = {}) {
  state.g2m['g-old'] = Object.assign({
    msId: 'ms1', gListId: 'g-list', msListId: 'ms-list', recCode: 'AB12CD'
  }, extra);
  state.m2g['ms1'] = 'g-old';
}
function rotatedSnap() {
  return snapFor({ gTasks: [gTask('g-new', 'Task 1', 'AB12CD')], msTasks: [msTask('ms1', 'Task 1')] });
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('R1: a live pair captures the [TTS-REC] code into rec.recCode, upper-cased', () => {
  const { c } = load();
  const state = baseState(c);
  state.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list' };
  state.m2g['ms1'] = 'g1';
  const snap = snapFor({ gTasks: [gTask('g1', 'Task 1', 'ab12cd')], msTasks: [msTask('ms1', 'Task 1')] });
  const result = c.rotationRebind_(state, snap);
  assert.equal(state.g2m['g1'].recCode, 'AB12CD');
  assert.equal(result.codeCaptured, 1);
  assert.equal(result.rebound.length, 0);
  assert.equal(c.rotationRecCodeFromNotes_('no marker here'), null);
  assert.equal(c.rotationRecCodeFromNotes_('[TTS-REC:AB12CD]'), 'AB12CD');
  assert.equal(c.rotationRecCodeFromNotes_('[TTS-TIME:09:00]\n[TTS-REC:ab12cd]\nbody'), 'AB12CD');
});

test('R2: a rotated Google id is rebound and keeps the same Calendar event id', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state, { rem: { e: 'a'.repeat(32), eFp: 'b'.repeat(32) }, td: { date: '2026-01-01', time: '09:00', v: 1 } });
  const result = c.rotationRebind_(state, rotatedSnap());
  assert.equal(result.rebound.length, 1);
  assert.equal(result.rebound[0].from, 'g-old');
  assert.equal(result.rebound[0].to, 'g-new');
  assert.equal(result.rebound[0].keptCalendarEventId, true);
  assert.equal(state.g2m['g-old'], undefined);
  assert.equal(state.g2m['g-new'].rem.e, 'a'.repeat(32));
  assert.equal(state.g2m['g-new'].td.time, '09:00');
  assert.equal(state.g2m['g-new'].recCode, 'AB12CD');
  assert.equal(state.m2g['ms1'], 'g-new');
});

test('R3: rebinding removes the fresh id from the create batch, so no duplicate Microsoft task', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const snap = rotatedSnap();
  const before = c.taskCreateBatchCandidates_(state, snap).map((row) => row.sourceTaskId);
  assert.ok(before.includes('g-new'), 'control: without rebinding the fresh id IS a create candidate');
  c.rotationRebind_(state, snap);
  const after = c.taskCreateBatchCandidates_(state, snap).map((row) => row.sourceTaskId);
  assert.ok(!after.includes('g-new'), 'after rebinding the fresh id is already mapped');
});

test('R4: with no candidate the old mapping is left exactly where it was', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const before = plain(state.g2m);
  const result = c.rotationRebind_(state, snapFor({ gTasks: [], msTasks: [msTask('ms1', 'Task 1')] }));
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'NO_CANDIDATE');
  assert.deepEqual(plain(state.g2m), before);
  assert.equal(state.m2g['ms1'], 'g-old');
});

test('R5: two candidates carrying the same code are ambiguous, never candidates[0]', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const before = plain(state.g2m);
  const snap = snapFor({
    gTasks: [gTask('g-new-a', 'Task 1', 'AB12CD'), gTask('g-new-b', 'Task 1', 'AB12CD')],
    msTasks: [msTask('ms1', 'Task 1')]
  });
  const result = c.rotationRebind_(state, snap);
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'AMBIGUOUS_CANDIDATES');
  assert.deepEqual(plain(state.g2m), before);
});

test('R6: a missing stored code fails closed instead of guessing by title', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  delete state.g2m['g-old'].recCode;
  const before = plain(state.g2m);
  const result = c.rotationRebind_(state, rotatedSnap());
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'NO_STORED_CODE');
  assert.deepEqual(plain(state.g2m), before);
});

test('R7: when the Microsoft task is also missing, the deletion path keeps ownership', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const before = plain(state.g2m);
  const result = c.rotationRebind_(state, snapFor({ gTasks: [gTask('g-new', 'Task 1', 'AB12CD')], msTasks: [] }));
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'MS_ALSO_MISSING');
  assert.deepEqual(plain(state.g2m), before);
});

test('R8: without Microsoft recurrence a disappearance is not treated as rotation', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const snap = snapFor({
    gTasks: [gTask('g-new', 'Task 1', 'AB12CD')],
    msTasks: [msTask('ms1', 'Task 1', false)]
  });
  const result = c.rotationRebind_(state, snap);
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'NO_MS_RECURRENCE');
  assert.ok(state.g2m['g-old']);
});

test('R9: a title mismatch defers the rebind and deletes nothing', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const snap = snapFor({
    gTasks: [gTask('g-new', 'A different title', 'AB12CD')],
    msTasks: [msTask('ms1', 'Task 1')]
  });
  const result = c.rotationRebind_(state, snap);
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'TITLE_MISMATCH');
  assert.ok(state.g2m['g-old']);
  assert.equal(state.m2g['ms1'], 'g-old');
});

test('R10: a prepared deletion journal is never rebound', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  state.deletionJournal['g-old'] = { msId: 'ms1', phase: 'PREPARED' };
  const result = c.rotationRebind_(state, rotatedSnap());
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'DELETION_JOURNAL_PRESENT');
  assert.ok(state.g2m['g-old']);
  assert.ok(state.deletionJournal['g-old']);
});

test('R11: an incomplete inventory blocks the whole pass, including code capture', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  const before = plain(state.g2m);
  const snap = rotatedSnap();
  snap.inventoryComplete = false;
  const result = c.rotationRebind_(state, snap);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'INCOMPLETE_INVENTORY');
  assert.deepEqual(plain(state.g2m), before);
});

test('R12: recCode round-trips through normalizeState_ and malformed values are refused', () => {
  const { c } = load();
  const state = baseState(c);
  state.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list', recCode: 'AB12CD' };
  state.m2g['ms1'] = 'g1';
  const normalized = c.normalizeState_(state);
  assert.equal(normalized.g2m['g1'].recCode, 'AB12CD');
  state.g2m['g1'].recCode = 'ab12cd';
  assert.throws(() => c.normalizeState_(state), /recCode/);
  state.g2m['g1'].recCode = 'NOTHEX';
  assert.throws(() => c.normalizeState_(state), /recCode/);
  state.g2m['g1'].recCode = 'AB12CD';
  assert.doesNotThrow(() => c.normalizeState_(state));
});

test('R13: putMapping_ preserves recCode across a mapping rebuild', () => {
  const { c } = load();
  const state = baseState(c);
  state.g2m['g1'] = {
    msId: 'ms1', gListId: 'g-list', msListId: 'ms-list',
    recCode: 'AB12CD', rem: { e: 'a'.repeat(32) }
  };
  state.m2g['ms1'] = 'g1';
  c.putMapping_(state, { id: 'g1', updated: '2026-01-02T00:00:00Z' }, 'g-list',
    { id: 'ms1', lastModifiedDateTime: '2026-01-02T00:00:00Z' }, 'ms-list');
  assert.equal(state.g2m['g1'].recCode, 'AB12CD');
  assert.equal(state.g2m['g1'].rem.e, 'a'.repeat(32));
});

test('R14: the whole pass performs zero provider or Calendar writes', () => {
  const { c, calls } = load();
  const state = baseState(c);
  mappedOldPair(state, { rem: { e: 'a'.repeat(32) } });
  const result = c.rotationRebind_(state, rotatedSnap());
  assert.equal(result.rebound.length, 1);
  assert.equal(calls.remote, 0);
});

test('R15: a pending deletion candidate is dropped so the live Microsoft task survives', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  state.pendingTaskDeletions['g-old'] = { confirmations: 1, missingSide: 'google' };
  state.taskDeletionConflicts['g-old'] = { reason: 'BOTH_SIDES_RECURRENCE' };
  const result = c.rotationRebind_(state, rotatedSnap());
  assert.equal(result.rebound.length, 1);
  assert.equal(state.pendingTaskDeletions['g-old'], undefined);
  assert.equal(state.taskDeletionConflicts['g-old'], undefined);
  assert.equal(state.g2m['g-new'].msId, 'ms1');
});

test('R16: a reverse index owned by another pair is never stolen', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  state.g2m['g-other'] = { msId: 'ms9', gListId: 'g-list', msListId: 'ms-list' };
  state.m2g['ms1'] = 'g-other';
  const result = c.rotationRebind_(state, rotatedSnap());
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'REVERSE_INDEX_CONFLICT');
  assert.ok(state.g2m['g-old']);
  assert.equal(state.m2g['ms1'], 'g-other');
});

test('R17: a candidate already mapped, tombstoned or journaled is not eligible', () => {
  const { c } = load();
  const state = baseState(c);
  mappedOldPair(state);
  state.g2m['g-taken'] = { msId: 'ms7', gListId: 'g-list', msListId: 'ms-list' };
  state.m2g['ms7'] = 'g-taken';
  state.tombstones.g['g-dead'] = { at: 1 };
  const snap = snapFor({
    gTasks: [gTask('g-taken', 'Task 1', 'AB12CD'), gTask('g-dead', 'Task 1', 'AB12CD')],
    msTasks: [msTask('ms1', 'Task 1'), msTask('ms7', 'Other', false)]
  });
  const result = c.rotationRebind_(state, snap);
  assert.equal(result.rebound.length, 0);
  assert.equal(result.skipped[0].reason, 'NO_CANDIDATE');
  assert.ok(state.g2m['g-old']);
});
