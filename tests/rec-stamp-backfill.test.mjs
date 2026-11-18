import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

// Rec-stamp backfill: Microsoft Graph is eventually consistent, so a recurring
// task created and synced within seconds is mapped WITHOUT its recurrence
// field (observed live: absent at 41s and 3.2min, present at 5.5min).  The
// create payload therefore stamps no [TTS-REC] marker and nothing re-visited
// the pair — which disarms rotationRebind_ exactly on the day the Google id
// rotates.  These tests pin the bounded backfill window (rec.rst) and every
// fail-closed exit, including the ruling that pre-existing pairs (no rec.rst)
// are never touched.

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
    Utilities: {
      sleep() {},
      getUuid: () => '00000000-0000-4000-8000-000000000000'
    }
  });
  runGasFilesInContext(c);
  return c;
}

const RECURRENCE = { pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd' } };
const STAMP = '2026-01-01T00:00:00Z';

function gTask(id, title, notes) {
  return { id, title, updated: STAMP, notes: notes == null ? 'user body' : notes };
}
function msTask(id, title, withRecurrence = true) {
  return { id, title, lastModifiedDateTime: STAMP, recurrence: withRecurrence ? RECURRENCE : null };
}
function baseState(c) {
  const s = c.newState_();
  s.listMap['g-list'] = 'ms-list';
  return s;
}
function laggedRec(state, extra = {}) {
  state.g2m['g1'] = Object.assign({
    msId: 'ms1', gListId: 'g-list', msListId: 'ms-list', rst: 2
  }, extra);
  state.m2g['ms1'] = 'g1';
  return state.g2m['g1'];
}
function snapFor({ gTasks = [], msTasks = [] } = {}) {
  const snap = {
    inventoryComplete: true,
    gTasksById: {}, msTasksById: {}, gListByTask: {}, msListByTask: {}
  };
  gTasks.forEach((t) => { snap.gTasksById[t.id] = t; snap.gListByTask[t.id] = 'g-list'; });
  msTasks.forEach((t) => { snap.msTasksById[t.id] = t; snap.msListByTask[t.id] = 'ms-list'; });
  return snap;
}
function attachProvider(c, { verifyNotes = null } = {}) {
  const writes = [];
  const store = { notes: '' };
  c.updateGTask_ = (listId, id, payload) => {
    writes.push({ listId, id, payload });
    store.notes = payload.notes;
    return { id, notes: payload.notes };
  };
  c.getGTask_ = (listId, id) => ({ id, notes: verifyNotes === null ? store.notes : verifyNotes });
  return { writes, store };
}

test('B1: sweep stamps a lagged fast-synced pair once the recurrence field materializes', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state);
  const snap = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1')] });
  const { writes } = attachProvider(c);

  const stamped = c.backfillRecStampSweep_(state, snap, Date.now());

  assert.equal(stamped, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].listId, 'g-list');
  assert.equal(writes[0].id, 'g1');
  assert.match(writes[0].payload.notes, /^\[TTS-REC:[0-9A-F]{6}\]\nuser body$/,
    'the marker lands on line 1 above the untouched user content');
  assert.match(rec.recCode, /^[0-9A-F]{6}$/);
  assert.equal(rec.recCode, rec.recCode.toUpperCase());
  assert.equal(c.rotationRecCodeFromNotes_(writes[0].payload.notes), rec.recCode,
    'the stored identity is exactly the code the sweep wrote');
  assert.equal(rec.rst, undefined, 'the window closes on a successful stamp');
  assert.equal(snap.gTasksById['g1'].notes, writes[0].payload.notes,
    'the same-round snapshot is refreshed so the merge sees the marker');
});

test('B2: the window decrements while Graph lags and then gives up without any write', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state, { rst: 2 });
  const snap = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1', false)] });
  const { writes } = attachProvider(c);

  c.backfillRecStampSweep_(state, snap, Date.now());
  assert.equal(rec.rst, 1, 'one round with no recurrence field consumes one window round');
  assert.equal(writes.length, 0);

  c.backfillRecStampSweep_(state, snap, Date.now());
  assert.equal(rec.rst, undefined, 'the window expires after the last round');
  assert.equal(writes.length, 0, 'giving up never writes');
});

test('B3: a pair whose notes already carry the marker is cleared without a write', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state);
  const snap = snapFor({
    gTasks: [gTask('g1', 'Task 1', '[TTS-REC:AB12CD]\nuser body')],
    msTasks: [msTask('ms1', 'Task 1')]
  });
  const { writes } = attachProvider(c);

  c.backfillRecStampSweep_(state, snap, Date.now());

  assert.equal(writes.length, 0, 'already stamped: nothing to do');
  assert.equal(rec.rst, undefined);
  assert.equal(rec.recCode, undefined, 'the sweep does not overwrite a captured identity');
});

test('B4: pairs without rec.rst are never touched, even when recurrence and missing marker align', () => {
  const c = load();
  const state = baseState(c);
  state.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list' };
  state.m2g['ms1'] = 'g1';
  const snap = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1')] });
  const { writes } = attachProvider(c);

  c.backfillRecStampSweep_(state, snap, Date.now());

  assert.equal(writes.length, 0,
    'the engine does not fight a user who deliberately removed a marker from an old pair');
  assert.equal(state.g2m['g1'].rst, undefined);
  assert.equal(state.g2m['g1'].recCode, undefined);
});

test('B5: a pair that vanished from this round\'s inventory hands the window back', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state);
  const snapGone = snapFor({ gTasks: [], msTasks: [msTask('ms1', 'Task 1')] });
  const { writes } = attachProvider(c);

  c.backfillRecStampSweep_(state, snapGone, Date.now());
  assert.equal(rec.rst, undefined, 'deletion/rebind paths own a vanished pair');
  assert.equal(writes.length, 0);

  const rec2 = laggedRec(state);
  const snapMsGone = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [] });
  c.backfillRecStampSweep_(state, snapMsGone, Date.now());
  assert.equal(rec2.rst, undefined);
  assert.equal(writes.length, 0);
});

test('B6: a stale list mapping is never written through', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state);
  const snap = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1')] });
  snap.gListByTask['g1'] = 'other-list';
  const { writes } = attachProvider(c);

  c.backfillRecStampSweep_(state, snap, Date.now());

  assert.equal(writes.length, 0);
  assert.equal(rec.rst, undefined);
});

test('B7: an unverified write throws fail-closed and keeps the window armed', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state, { rst: 2 });
  const snap = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1')] });
  const { writes } = attachProvider(c, { verifyNotes: 'user body' });

  assert.throws(() => c.backfillRecStampSweep_(state, snap, Date.now()),
    /TTS_REC_BACKFILL_UNVERIFIED/);
  assert.equal(writes.length, 1, 'the attempt itself happened');
  assert.equal(rec.rst, 2, 'the round aborts before the window is consumed');
});

test('B8: create-time stamping stamps immediately when recurrence arrived, arms the window when not', () => {
  const c = load();
  const state = baseState(c);
  state.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list' };
  state.m2g['ms1'] = 'g1';
  const { writes } = attachProvider(c);

  // (a) Graph materialized the field between prepare and finalize: stamp now.
  const snapNow = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1')] });
  c.afterMsCreateRecStamp_(state, snapNow, 'g1', 'g-list', snapNow.msTasksById['ms1']);
  assert.equal(writes.length, 1, 'no extra round is spent when the field is already there');
  assert.match(writes[0].payload.notes, /^\[TTS-REC:[0-9A-F]{6}\]\nuser body$/);
  assert.match(state.g2m['g1'].recCode, /^[0-9A-F]{6}$/);
  assert.equal(state.g2m['g1'].rst, undefined);

  // (b) Field still absent: arm the window without writing.
  const state2 = baseState(c);
  state2.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list' };
  state2.m2g['ms1'] = 'g1';
  const snapLate = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1', false)] });
  const writes2 = attachProvider(c).writes;
  c.afterMsCreateRecStamp_(state2, snapLate, 'g1', 'g-list', snapLate.msTasksById['ms1']);
  assert.equal(writes2.length, 0);
  assert.equal(state2.g2m['g1'].rst, 2);

  // (c) Recovery re-entry must not reset the window: a partially consumed
  // window stays where it is.
  state2.g2m['g1'].rst = 1;
  c.afterMsCreateRecStamp_(state2, snapLate, 'g1', 'g-list', snapLate.msTasksById['ms1']);
  assert.equal(state2.g2m['g1'].rst, 1, 're-entry must not reset a consumed window');
  assert.equal(writes2.length, 0);
});

test('B9: putMapping_ carries rec.rst across a mapping rebuild, like recCode', () => {
  const c = load();
  const state = baseState(c);
  state.g2m['g1'] = {
    msId: 'ms-old', gListId: 'g-list', msListId: 'ms-list', rst: 2, recCode: 'AB12CD'
  };
  state.m2g['ms-old'] = 'g1';

  c.putMapping_(
    state,
    { id: 'g1', title: 'Task 1', notes: 'user body', updated: STAMP },
    'g-list',
    { id: 'ms-new', title: 'Task 1', lastModifiedDateTime: STAMP },
    'ms-list'
  );

  assert.equal(state.g2m['g1'].msId, 'ms-new');
  assert.equal(state.g2m['g1'].rst, 2, 'a mid-window rebuild must not drop the tracker');
  assert.equal(state.g2m['g1'].recCode, 'AB12CD');
  assert.equal(state.m2g['ms-old'], undefined);
  assert.equal(state.m2g['ms-new'], 'g1');
});

test('B10: state validation admits rec.rst and refuses a malformed value', () => {
  const c = load();
  const state = baseState(c);
  state.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list', rst: 2 };
  state.m2g['ms1'] = 'g1';

  c.assertStrictSchema4StateShape_(state);

  [0, 1.5, 'x', null].forEach((bad) => {
    const probe = baseState(c);
    probe.g2m['g1'] = { msId: 'ms1', gListId: 'g-list', msListId: 'ms-list', rst: bad };
    probe.m2g['ms1'] = 'g1';
    assert.throws(() => c.assertStrictSchema4StateShape_(probe), /STATE_MALFORMED/,
      'rst=' + JSON.stringify(bad) + ' must be refused');
  });
});

test('B11: assignment-blocked notes are never written; the window is surrendered', () => {
  const c = load();
  const state = baseState(c);
  const rec = laggedRec(state);
  const g = gTask('g1', 'Task 1');
  g.assignmentInfo = { assignee: 'someone' };
  const snap = snapFor({ gTasks: [g], msTasks: [msTask('ms1', 'Task 1')] });
  const { writes } = attachProvider(c);

  c.backfillRecStampSweep_(state, snap, Date.now());

  assert.equal(writes.length, 0, 'the merge owns this notes surface');
  assert.equal(rec.rst, undefined);
});

test('B12: the backfilled marker coexists with an existing [TTS-TIME] header', () => {
  const c = load();
  const state = baseState(c);
  laggedRec(state);
  const snap = snapFor({
    gTasks: [gTask('g1', 'Task 1', '[TTS-TIME:09:00]\nuser body')],
    msTasks: [msTask('ms1', 'Task 1')]
  });
  const { store } = attachProvider(c);

  c.backfillRecStampSweep_(state, snap, Date.now());

  const finalNotes = store.notes;
  const lines = finalNotes.split('\n');
  assert.match(lines[0], /^\[TTS-REC:[0-9A-F]{6}\]$/, 'REC lands on line 1');
  assert.equal(lines[1], '[TTS-TIME:09:00]', 'the TIME ticket survives underneath');
  assert.equal(lines[2], 'user body');
  assert.match(c.rotationRecCodeFromNotes_(finalNotes), /^[0-9A-F]{6}$/);
  assert.equal(c.timeBridgeParseNotesMarker_(finalNotes).markerValid, true,
    'the time-bridge grammar still parses the ticket');
});

test('B13: rec.rst survives a persist-time normalize (schema 4 mapping extras round-trip)', () => {
  const c = load();
  const state = baseState(c);
  laggedRec(state, { rst: 1 });

  const normalized = c.normalizeState_(state);

  assert.equal(normalized.schema, 4);
  assert.equal(normalized.g2m['g1'].rst, 1,
    'normalize collects and re-attaches mapping extras; rst must ride the same path');
});

test('B14: backfillRecMarkerOnGoogle_ itself is precondition-checked and idempotent', () => {
  const c = load();
  const state = baseState(c);
  laggedRec(state);
  const { writes } = attachProvider(c);

  // Already stamped: the stamper refuses on its own contract, not only
  // because its callers pre-check.
  const snapStamped = snapFor({
    gTasks: [gTask('g1', 'Task 1', '[TTS-REC:AB12CD]\nuser body')],
    msTasks: [msTask('ms1', 'Task 1')]
  });
  assert.equal(c.backfillRecMarkerOnGoogle_(state, snapStamped, 'g1', 'g-list', snapStamped.msTasksById['ms1']), false,
    'marker present on the notes: false, no write');
  assert.equal(writes.length, 0);

  // No recurrence: nothing to stamp.
  const snapPlain = snapFor({ gTasks: [gTask('g1', 'Task 1')], msTasks: [msTask('ms1', 'Task 1', false)] });
  assert.equal(c.backfillRecMarkerOnGoogle_(state, snapPlain, 'g1', 'g-list', snapPlain.msTasksById['ms1']), false,
    'no MS recurrence: false, no write');
  assert.equal(writes.length, 0);
});
