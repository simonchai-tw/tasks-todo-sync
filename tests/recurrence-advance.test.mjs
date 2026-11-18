import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

// Recurrence advancement: Microsoft To Do native recurring tasks advance on
// their own recurrence grid when an occurrence is completed, and the Google
// copy must follow without duplicating the series.  Every path below is
// fail-closed: ambiguous or missing identity evidence holds instead of
// guessing, and nothing is written more than once per decision.

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
  // Writes are recorded instead of hitting the provider stub: the sweep must
  // issue exactly one call per decision and never retry.
  c.gWrites_ = [];
  c.updateGTask_ = function (listId, taskId, payload) {
    c.gWrites_.push({ listId: listId, taskId: taskId, payload: payload });
    const fixture = c.gTaskFixtures_[listId + '/' + taskId];
    if (fixture) Object.assign(fixture, payload);
    return { id: taskId };
  };
  c.getGTask_ = function (listId, taskId) {
    return c.gTaskFixtures_[listId + '/' + taskId] || null;
  };
  c.gTaskFixtures_ = {};
  c.alerts_ = [];
  c.sendMailAlert_ = function (subject, body) {
    c.alerts_.push({ subject: subject, body: body });
    return true;
  };
  return c;
}

const DAILY = { pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd', startDate: '2026-01-01' } };
const DAILY_ENDED = { pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', startDate: '2026-01-01', endDate: '2026-01-03' } };
const WEEKLY = { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['sunday'], firstDayOfWeek: 'sunday' }, range: { type: 'noEnd', startDate: '2026-01-01' } };

function msDue(date) {
  return { dateTime: date + 'T00:00:00.0000000', timeZone: 'UTC' };
}

function msRecurring(id, title, { due, status, recurrence } = {}) {
  return {
    id: id,
    title: title,
    lastModifiedDateTime: '2026-01-01T00:00:00Z',
    status: status || 'notStarted',
    recurrence: recurrence || DAILY,
    dueDateTime: due ? msDue(due) : null
  };
}

function gTask(id, title, { due, notes, status } = {}) {
  return {
    id: id,
    title: title,
    updated: '2026-01-01T00:00:00Z',
    status: status || 'needsAction',
    due: due || null,
    notes: notes == null ? 'user body' : notes
  };
}

function baseState(c) {
  const s = c.newState_();
  s.listMap['g-list'] = 'ms-list';
  return s;
}

function snapFor({ gTasks = [], msTasks = [], complete = true } = {}) {
  const snap = {
    inventoryComplete: complete,
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    safety: { allowDeletions: true },
    gTasksById: {}, msTasksById: {}, gListByTask: {}, msListByTask: {}
  };
  gTasks.forEach((t) => { snap.gTasksById[t.id] = t; snap.gListByTask[t.id] = 'g-list'; });
  msTasks.forEach((t) => { snap.msTasksById[t.id] = t; snap.msListByTask[t.id] = 'ms-list'; });
  return snap;
}

function mappedPair(state, gId, msId) {
  state.g2m[gId] = { msId: msId, gListId: 'g-list', msListId: 'ms-list' };
  state.m2g[msId] = gId;
}

function bindNewMsId(state, gId, msId) {
  // Simulates a mapping that was finalized and persisted by an earlier round.
  state.g2m[gId] = { msId: msId, gListId: 'g-list', msListId: 'ms-list' };
  state.m2g[msId] = gId;
}

function sweep(c, state, snap, { roundId = 'r1', enabled = true } = {}) {
  return c.recurrenceAdvanceSweep_(state, snap, {
    advanceEnabled: enabled,
    nowMs: Date.parse('2026-01-02T00:00:00Z'),
    syncTimeZone: 'UTC',
    roundId: roundId
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function modelASnap({ withHistory = true, historyCount } = {}) {
  const count = historyCount !== undefined ? historyCount : (withHistory ? 1 : 0);
  const msTasks = [msRecurring('ms1', 'Task 1', { due: '2026-01-02', status: 'notStarted' })];
  for (let i = 0; i < count; i += 1) {
    msTasks.push(msRecurring('ms-hist-' + (i ? String(i) : ''), 'Task 1', { due: '2026-01-01', status: 'completed' }));
  }
  msTasks.push(msRecurring('ms-unrelated', 'Unrelated', { due: '2026-01-05', recurrence: null }));
  return snapFor({
    gTasks: [gTask('g1', 'Task 1', { due: '2026-01-01T00:00:00.000Z', notes: '[TTS-REC:ABCDEF]\nuser body' })],
    msTasks: msTasks
  });
}

function modelAState(c) {
  const state = baseState(c);
  mappedPair(state, 'g1', 'ms1');
  return state;
}

test('R1: model-A advancement updates the Google due once, keeps the mapping, and holds the completed echo from the create batch', () => {
  const c = load();
  const state = modelAState(c);
  const snap = modelASnap();
  c.gTaskFixtures_['g-list/g1'] = snap.gTasksById.g1;
  const result = sweep(c, state, snap, { roundId: 'r1' });

  assert.equal(result.enabled, true);
  assert.equal(result.advanced, 1);
  assert.deepEqual(plain(c.gWrites_), [{ listId: 'g-list', taskId: 'g1', payload: { due: '2026-01-02T00:00:00.000Z' } }]);
  // Mapping untouched: no rebind, no tombstone, no new pair.
  assert.equal(state.g2m.g1.msId, 'ms1');
  assert.equal(state.m2g.ms1, 'g1');
  assert.deepEqual(Object.keys(state.m2g), ['ms1']);
  assert.equal(Object.keys(state.tombstones.g).length, 0);
  assert.equal(Object.keys(state.tombstones.m).length, 0);
  // No wait needed: the evidence was complete in one round.
  assert.deepEqual(plain(state.recurrenceAdvancement.waits), {});
  // The completed history instance must never become a Google duplicate,
  // while ordinary unmapped tasks stay creatable.
  const candidates = c.taskCreateBatchCandidates_(state, snap)
    .map((row) => row.sourceTaskId);
  assert.ok(!candidates.includes('ms-hist-'), 'completed echo instance is held from the create batch');
  assert.ok(candidates.includes('ms-unrelated'), 'ordinary unmapped tasks are untouched');
  // A second sweep over the same converged evidence is a strict no-op (the
  // write has landed, so Google and Microsoft dues agree again).
  snap.gTasksById.g1.due = '2026-01-02T00:00:00.000Z';
  const writesBefore = c.gWrites_.length;
  const again = sweep(c, state, snap, { roundId: 'r2' });
  assert.equal(again.advanced, 0);
  assert.equal(c.gWrites_.length, writesBefore);
  // Grid projection sanity for the observed recurrence shapes.
  assert.equal(c.recurrenceAdvanceNextDue_(DAILY, '2026-01-01'), '2026-01-02');
  assert.equal(c.recurrenceAdvanceNextDue_(WEEKLY, '2026-01-08'), '2026-01-11');
  assert.equal(c.recurrenceAdvanceNextDue_(DAILY_ENDED, '2026-01-03'), null);
});

test('R2: incomplete evidence opens a durable wait, writes nothing, and completes on a later round', () => {
  const c = load();
  const state = modelAState(c);
  const snapNoHistory = modelASnap({ withHistory: false });
  const result = sweep(c, state, snapNoHistory, { roundId: 'r1' });

  assert.equal(result.advanced, 0);
  assert.equal(result.waitsOpened, 1);
  assert.deepEqual(plain(c.gWrites_), []);
  const wait = state.recurrenceAdvancement.waits.g1;
  assert.ok(wait, 'wait state lives on the persisted state object, not in memory');
  assert.equal(wait.phase, 'WAIT_EVIDENCE');
  assert.equal(wait.roundsWaited, 0);
  assert.equal(wait.expectedDue, '2026-01-02');

  // Next round: the completed echo instance shows up; the wait is consumed.
  const snapWithHistory = modelASnap();
  c.gTaskFixtures_['g-list/g1'] = snapWithHistory.gTasksById.g1;
  const resumed = sweep(c, state, snapWithHistory, { roundId: 'r2' });
  assert.equal(resumed.advanced, 1);
  assert.deepEqual(plain(c.gWrites_), [{ listId: 'g-list', taskId: 'g1', payload: { due: '2026-01-02T00:00:00.000Z' } }]);
  assert.equal(state.recurrenceAdvancement.waits.g1, undefined);
});

test('R3: the wait window closes exactly once and never re-notifies within or after the window', () => {
  const c = load();
  const state = modelAState(c);
  const snap = modelASnap({ withHistory: false });
  sweep(c, state, snap, { roundId: 'r1' });

  sweep(c, state, snap, { roundId: 'r2' });
  sweep(c, state, snap, { roundId: 'r3' });
  // Still waiting: no closure, no conflict, no alert, no provider write.
  assert.deepEqual(plain(c.gWrites_), []);
  assert.deepEqual(plain(c.alerts_), []);
  assert.deepEqual(plain(state.recurrenceAdvancement.conflicts), {});
  assert.equal(state.recurrenceAdvancement.waits.g1.roundsWaited, 2);

  const closed = sweep(c, state, snap, { roundId: 'r4' });
  assert.equal(closed.closures, 1);
  assert.equal(c.alerts_.length, 1, 'exactly one operator alert at closure');
  const conflict = state.recurrenceAdvancement.conflicts.g1;
  assert.ok(conflict, 'a durable conflict record is written at closure');
  assert.equal(conflict.kind, 'RECURRENCE_ADVANCE_TIMEOUT');
  assert.equal(state.recurrenceAdvancement.waits.g1.phase, 'CLOSED');
  assert.deepEqual(plain(c.gWrites_), [], 'closure writes no provider payload');

  const after = sweep(c, state, snap, { roundId: 'r5' });
  assert.equal(after.closures, 0);
  assert.equal(c.alerts_.length, 1, 'no repeated notification after the window');
  assert.deepEqual(plain(c.gWrites_), []);
  assert.deepEqual(plain(state.recurrenceAdvancement.conflicts), { g1: plain(conflict) });
});

test('R4: two echo candidates are ambiguous: no binding, no candidates[0], hold plus conflict record', () => {
  const c = load();
  const state = modelAState(c);
  const snap = modelASnap({ historyCount: 2 });
  const beforeMappings = plain({ g2m: state.g2m, m2g: state.m2g });
  const result = sweep(c, state, snap, { roundId: 'r1' });

  assert.equal(result.advanced, 0);
  assert.deepEqual(plain(c.gWrites_), [], 'an ambiguous round never writes');
  assert.deepEqual(plain({ g2m: state.g2m, m2g: state.m2g }), beforeMappings, 'no candidates[0] binding');
  const conflict = state.recurrenceAdvancement.conflicts.g1;
  assert.ok(conflict, 'the ambiguity is reported');
  assert.equal(conflict.kind, 'RECURRENCE_ADVANCE_AMBIGUOUS');
  assert.ok(state.recurrenceAdvancement.waits.g1, 'held for a later unambiguous round');
  const candidates = c.taskCreateBatchCandidates_(state, snap).map((row) => row.sourceTaskId);
  assert.ok(!candidates.includes('ms-hist-'));
  assert.ok(!candidates.includes('ms-hist-1'), 'every echo instance is held from the create batch');
});

test('R5: zero candidates take the hold and timeout path and never auto-create mappings', () => {
  const c = load();
  const state = modelAState(c);
  const snap = modelASnap({ withHistory: false });
  const beforeMappings = plain({ g2m: state.g2m, m2g: state.m2g });
  const beforeTombstones = plain(state.tombstones);

  sweep(c, state, snap, { roundId: 'r1' });
  sweep(c, state, snap, { roundId: 'r2' });
  sweep(c, state, snap, { roundId: 'r3' });
  const closed = sweep(c, state, snap, { roundId: 'r4' });
  assert.equal(closed.closures, 1);
  assert.equal(c.alerts_.length, 1);
  assert.deepEqual(plain({ g2m: state.g2m, m2g: state.m2g }), beforeMappings,
    'no mapping is created, bound, or re-keyed anywhere in the zero-candidate path');
  assert.deepEqual(plain(state.tombstones), beforeTombstones, 'no tombstones are invented');
  assert.equal(closed.heldCreateIds.length, 0, 'with zero candidates there is nothing to hold');
  assert.ok(!c.gWrites_.some((w) => w.taskId !== 'g1'), 'no create-like write exists');
});

test('R6: model-B defense: the old marker is stripped only after the new mapping is confirmed persisted', () => {
  const c = load();
  const state = baseState(c);
  mappedPair(state, 'g1', 'ms1');
  const g1 = gTask('g1', 'Task 1', { due: '2026-01-01T00:00:00.000Z', notes: '[TTS-REC:ABCDEF]\nuser body' });
  const ms1 = msRecurring('ms1', 'Task 1', { due: '2026-01-01', status: 'completed' });
  const ms2 = msRecurring('ms2', 'Task 1', { due: '2026-01-02', status: 'notStarted' });
  const snap = snapFor({ gTasks: [g1], msTasks: [ms1, ms2] });
  c.gTaskFixtures_['g-list/g1'] = g1;

  // Round 1: the continuation exists but is not yet mapped. Hold, never strip.
  const first = sweep(c, state, snap, { roundId: 'r1' });
  assert.equal(first.markerStripped, 0);
  assert.deepEqual(plain(c.gWrites_), [], 'the marker survives until the new mapping is proven persisted');
  const wait = state.recurrenceAdvancement.waits.g1;
  assert.ok(wait, 'a durable wait tracks the pending handoff');
  assert.equal(wait.phase, 'WAIT_PERSIST_CONFIRM');
  assert.equal(wait.pendingBind.msId, 'ms2');
  assert.ok(String(g1.notes).indexOf('[TTS-REC:ABCDEF]') >= 0, 'marker still present after round 1');
  // The sweep itself never binds: the ordinary create path owns new mappings.
  assert.equal(state.m2g.ms2, undefined);

  // A round where the continuation is still unbound must not strip either.
  const still = sweep(c, state, snap, { roundId: 'r2' });
  assert.equal(still.markerStripped, 0);
  assert.deepEqual(plain(c.gWrites_), []);

  // Round 3: the new mapping is now visible in loaded (persisted) state.
  bindNewMsId(state, 'g2', 'ms2');
  const third = sweep(c, state, snap, { roundId: 'r3' });
  assert.equal(third.markerStripped, 1);
  assert.deepEqual(plain(c.gWrites_), [{ listId: 'g-list', taskId: 'g1', payload: { notes: 'user body' } }]);
  assert.equal(g1.notes, 'user body', 'only the marker line is removed, byte-for-byte');
  assert.equal(state.recurrenceAdvancement.waits.g1, undefined);
});

test('R7: model-C defense: a vanished series closes through the multi-round timeout, never a fast single-round decision', () => {
  const c = load();
  const state = baseState(c);
  mappedPair(state, 'g1', 'ms1');
  const g1 = gTask('g1', 'Task 1', { due: '2026-01-01T00:00:00.000Z', notes: '[TTS-REC:ABCDEF]\nuser body' });
  const ms1 = msRecurring('ms1', 'Task 1', { due: '2026-01-01', status: 'completed' });
  const ms2 = msRecurring('ms2', 'Task 1', { due: '2026-01-02', status: 'notStarted' });
  c.gTaskFixtures_['g-list/g1'] = g1;
  sweep(c, state, snapFor({ gTasks: [g1], msTasks: [ms1, ms2] }), { roundId: 'r1' });
  assert.ok(state.recurrenceAdvancement.waits.g1, 'round 1 arms the wait');

  // Rounds 2 and 3: the series is gone (old id and continuation both absent).
  const endedSnap = snapFor({ gTasks: [g1], msTasks: [] });
  const second = sweep(c, state, endedSnap, { roundId: 'r2' });
  const third = sweep(c, state, endedSnap, { roundId: 'r3' });
  assert.equal(second.closures, 0);
  assert.equal(third.closures, 0);
  assert.deepEqual(c.alerts_, [], 'no fast single-round decision');
  assert.deepEqual(plain(state.recurrenceAdvancement.conflicts), {});
  assert.ok(state.recurrenceAdvancement.waits.g1);

  const closed = sweep(c, state, endedSnap, { roundId: 'r4' });
  assert.equal(closed.closures, 1);
  assert.equal(c.alerts_.length, 1);
  assert.equal(state.recurrenceAdvancement.conflicts.g1.kind, 'RECURRENCE_ADVANCE_TIMEOUT');
  assert.equal(state.recurrenceAdvancement.waits.g1.phase, 'CLOSED');
  assert.deepEqual(plain(c.gWrites_), []);
  // The mapping and both tombstone tables stay exactly where the deletion
  // domain left them: closure never deletes anything itself.
  assert.ok(state.g2m.g1);
  assert.equal(state.m2g.ms1, 'g1');
  assert.equal(Object.keys(state.tombstones.g).length, 0);
  assert.equal(Object.keys(state.tombstones.m).length, 0);

  sweep(c, state, endedSnap, { roundId: 'r5' });
  assert.equal(c.alerts_.length, 1, 'closure happens once');
});

test('R8: with the knob off the sweep is a byte-identical no-op, the both-recurrence guard still intercepts, and the marker format is preserved', () => {
  const c = load();
  const state = modelAState(c);
  const snap = modelASnap();
  const before = JSON.stringify(state);
  const result = sweep(c, state, snap, { roundId: 'r1', enabled: false });

  assert.equal(result.enabled, false);
  assert.equal(JSON.stringify(state), before, 'state is byte-identical with the knob off');
  assert.deepEqual(plain(c.gWrites_), []);
  assert.deepEqual(plain(c.alerts_), []);
  // HEAD behavior: the completed echo instance is still an ordinary create
  // candidate when the feature is off (no holds armed).
  const candidates = c.taskCreateBatchCandidates_(state, snap).map((row) => row.sourceTaskId);
  assert.ok(candidates.includes('ms-hist-'), 'no hold is armed while the knob is off');

  // The both-recurrence guard still intercepts its path untouched.
  const guardState = baseState(c);
  mappedPair(guardState, 'g1', 'ms1');
  const guardSnap = snapFor({
    gTasks: [gTask('g1', 'Task 1', { notes: '[TTS-REC:ABCDEF]\nuser body' })],
    msTasks: [msRecurring('ms1', 'Task 1', { due: '2026-01-02' })]
  });
  assert.equal(c.bothRecurrenceGuard_(guardState, guardState.g2m.g1, 'g1', guardSnap), true);
  assert.equal(guardState.taskDeletionConflicts.g1.reason, 'BOTH_SIDES_RECURRENCE');

  // Marker format survives every code path: the stamp format itself is
  // untouched and a due-advance payload never carries notes.
  assert.match(c.newTtsRecMarker_(), /^\[TTS-REC:[0-9A-F]{6}\]$/);
  assert.deepEqual(plain(c.gWrites_), []);
  // The strip helper removes exactly the marker line and nothing else.
  assert.equal(c.stripTtsRecMarkerFromNotes_('[TTS-REC:ABCDEF]\nuser body'), 'user body');
  assert.equal(c.stripTtsRecMarkerFromNotes_('user body'), 'user body');
  assert.equal(c.stripTtsRecMarkerFromNotes_('before [TTS-REC:ABCDEF]\nafter'), 'before \nafter');
});

test('R9: a rollover rendered in a non-sync zone keeps the signature and the write on one projection', () => {
  const c = load();
  const state = modelAState(c);
  // Live-measured shape (2026-11-18): the rolled daily series came back as
  // 2026-01-03T16:00Z -- 2026-01-04 in +08:00.  The Google copy already reads
  // 2026-01-03, so a prefix read of the provider string would collide with it
  // and the signature would go permanently null (stuck pair).  The canonical
  // projection must see 01-04 and advance the write to 01-04 as well.
  const msTasks = [
    {
      id: 'ms1', title: 'Task 1', lastModifiedDateTime: '2026-01-01T00:00:00Z',
      status: 'notStarted', recurrence: DAILY,
      dueDateTime: { dateTime: '2026-01-03T16:00:00.0000000', timeZone: 'UTC' }
    },
    msRecurring('ms-hist', 'Task 1', { due: '2026-01-03', status: 'completed' })
  ];
  const snap = snapFor({
    gTasks: [gTask('g1', 'Task 1', { due: '2026-01-03T00:00:00.000Z', notes: '[TTS-REC:ABCDEF]\nuser body' })],
    msTasks: msTasks
  });
  c.gTaskFixtures_['g-list/g1'] = snap.gTasksById.g1;
  // The due projection reads the project time zone (Session), not the sweep
  // options, so the fixture must render in +08:00 for this case.
  c.Session.getScriptTimeZone = () => 'Asia/Taipei';
  const result = c.recurrenceAdvanceSweep_(state, snap, {
    advanceEnabled: true,
    nowMs: Date.parse('2026-01-02T00:00:00Z'),
    syncTimeZone: 'Asia/Taipei',
    roundId: 'r1'
  });
  assert.equal(result.enabled, true);
  assert.equal(result.advanced, 1);
  assert.deepEqual(plain(c.gWrites_), [{ listId: 'g-list', taskId: 'g1', payload: { due: '2026-01-04T00:00:00.000Z' } }]);
  assert.ok(result.heldCreateIds.includes('ms-hist'), 'echo instance held across a multi-date roll');
  assert.equal(state.recurrenceAdvancement.waits && Object.keys(state.recurrenceAdvancement.waits).length, 0);
  // Convergence: after the write the projections agree, and a resweep is a no-op.
  snap.gTasksById.g1.due = '2026-01-04T00:00:00.000Z';
  const again = c.recurrenceAdvanceSweep_(state, snap, {
    advanceEnabled: true,
    nowMs: Date.parse('2026-01-02T00:00:00Z'),
    syncTimeZone: 'Asia/Taipei',
    roundId: 'r2'
  });
  assert.equal(again.advanced, 0);
  assert.equal(c.gWrites_.length, 1);
});

test('R10: the echo hold arms even when the signature is not actionable', () => {
  const c = load();
  const state = modelAState(c);
  // Weekly series; the Google due sits on a Thursday and the provider rolled
  // to a Monday -- off-grid, so the signature is null.  The completed echo
  // instance must still be held out of the create batch this same round,
  // because the next round's hold set is rebuilt from scratch.
  const WEEKLY_OFF_GRID = {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['sunday'], firstDayOfWeek: 'sunday' },
    range: { type: 'noEnd', startDate: '2026-01-01' }
  };
  const msTasks = [
    msRecurring('ms1', 'Task 1', { due: '2026-01-05', status: 'notStarted', recurrence: WEEKLY_OFF_GRID }),
    msRecurring('ms-hist', 'Task 1', { due: '2026-01-01', status: 'completed', recurrence: WEEKLY_OFF_GRID }),
    msRecurring('ms-unrelated', 'Unrelated', { due: '2026-01-05', recurrence: null })
  ];
  const snap = snapFor({
    gTasks: [gTask('g1', 'Task 1', { due: '2026-01-01T00:00:00.000Z', notes: '[TTS-REC:ABCDEF]\nuser body' })],
    msTasks: msTasks
  });
  c.gTaskFixtures_['g-list/g1'] = snap.gTasksById.g1;
  const result = sweep(c, state, snap, { roundId: 'r1' });
  assert.equal(result.enabled, true);
  assert.equal(result.advanced, 0);
  assert.equal(c.gWrites_.length, 0, 'off-grid due stays with the field merge');
  assert.ok(result.heldCreateIds.includes('ms-hist'), 'hold armed without an actionable signature');
  const candidates = c.taskCreateBatchCandidates_(state, snap)
    .map((row) => row.sourceTaskId);
  assert.ok(!candidates.includes('ms-hist'), 'echo instance never reaches the create batch');
  assert.ok(candidates.includes('ms-unrelated'), 'ordinary unmapped tasks are untouched');
});
