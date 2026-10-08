import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

// 2026-10-03 double-task incident: reinstalling the cloud project left the
// state with an empty mapping table, so taskCreateBatchCandidates_ treated
// BOTH sides as unmapped sources and every existing task was duplicated.
// The bootstrap gate adopts same-title pairs 1:1 and holds every remaining
// one-sided create until setupWizardConfirmBootstrap() releases it.

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
  return c;
}

function coldSnap({ gTasks = [], msTasks = [], gList = 'gList', msList = 'msList' } = {}) {
  const gTasksById = {}, msTasksById = {}, gListByTask = {}, msListByTask = {};
  gTasks.forEach((t) => { gTasksById[t.id] = t; gListByTask[t.id] = gList; });
  msTasks.forEach((t) => { msTasksById[t.id] = t; msListByTask[t.id] = msList; });
  return {
    activeGListIds: { [gList]: true },
    gTaskInventoryListIds: { [gList]: true },
    msTaskInventoryListIds: { [msList]: true },
    inventoryComplete: true,
    safety: { allowDeletions: true, allowTaskMoves: false },
    gTasksById, msTasksById, gListByTask, msListByTask
  };
}

test('Bootstrap: cold start adopts same-title pairs instead of duplicating them', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  // Case and whitespace differences must still match.
  const snap = coldSnap({
    gTasks: [{ id: 'g1', title: 'Task 1' }, { id: 'g2', title: 'Task 2' }],
    msTasks: [{ id: 'ms1', title: 'task 1' }, { id: 'ms2', title: '  TASK  2 ' }]
  });
  const gate = c.bootstrapCreationGate_(state, snap);
  assert.equal(gate.blocked, false, 'fully-adopted cold start must not block');
  assert.equal(state.bootstrap.status, 'done');
  assert.equal(state.g2m['g1'].msId, 'ms1');
  assert.equal(state.g2m['g2'].msId, 'ms2');
  assert.equal(state.m2g['ms1'], 'g1');
  assert.equal(state.m2g['ms2'], 'g2');
  assert.equal(c.taskCreateBatchCandidates_(state, snap).length, 0,
    'no create candidate may remain after adoption');
});

test('Bootstrap: duplicate titles pair 1:1 deterministically, leftovers stay candidates', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  const snap = coldSnap({
    gTasks: [{ id: 'g1', title: 'Standup' }, { id: 'g2', title: 'Standup' }],
    msTasks: [{ id: 'ms1', title: 'Standup' }]
  });
  const gate = c.bootstrapCreationGate_(state, snap);
  assert.equal(gate.blocked, true, 'one unpaired Google task must hold the gate');
  assert.equal(state.bootstrap.status, 'awaitingConfirmation');
  assert.equal(state.g2m['g1'].msId, 'ms1', 'first sorted Google id pairs first');
  assert.equal(state.g2m['g2'], undefined, 'the leftover must not be adopted');
  assert.equal(state.bootstrap.plan.adoptedCount, 1);
  assert.equal(state.bootstrap.plan.pendingCreates, 1);
  assert.equal(state.bootstrap.plan.pairs[0].googleOnly, 1);
});

test('Bootstrap: one-sided tasks are held (fail-closed) until released', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  const snap = coldSnap({ gTasks: [{ id: 'g1', title: 'Only Google' }], msTasks: [] });
  const gate = c.bootstrapCreationGate_(state, snap);
  assert.equal(gate.blocked, true);
  assert.equal(state.bootstrap.status, 'awaitingConfirmation');
  assert.equal(state.bootstrap.plan.pendingCreates, 1);
  assert.equal(state.bootstrap.plan.pairs[0].googleOnly, 1);
  assert.equal(state.bootstrap.plan.pairs[0].microsoftOnly, 0);
  assert.equal(state.g2m['g1'], undefined, 'nothing may be created or adopted yet');
  assert.equal(c.bootstrapCreationGate_(state, snap).blocked, true,
    'the gate must stay closed on later rounds');
  // Releasing the gate (what setupWizardConfirmBootstrap persists) reopens it.
  state.bootstrap.status = 'done';
  assert.equal(c.bootstrapCreationGate_(state, snap).blocked, false);
  assert.equal(c.taskCreateBatchCandidates_(state, snap).length, 1,
    'after release the ordinary create path must see the task');
});

test('Bootstrap: different titles on both sides count both directions, adopt nothing', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  const snap = coldSnap({
    gTasks: [{ id: 'g1', title: 'A' }],
    msTasks: [{ id: 'ms1', title: 'B' }]
  });
  const gate = c.bootstrapCreationGate_(state, snap);
  assert.equal(gate.blocked, true);
  assert.equal(state.bootstrap.plan.adoptedCount, 0);
  assert.equal(state.bootstrap.plan.pairs[0].googleOnly, 1);
  assert.equal(state.bootstrap.plan.pairs[0].microsoftOnly, 1);
});

test('Bootstrap: empty/whitespace titles are never auto-adopted', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  const snap = coldSnap({
    gTasks: [{ id: 'g1', title: '   ' }],
    msTasks: [{ id: 'ms1', title: '' }]
  });
  const gate = c.bootstrapCreationGate_(state, snap);
  assert.equal(gate.blocked, true);
  assert.equal(state.bootstrap.plan.adoptedCount, 0);
  assert.equal(state.g2m['g1'], undefined);
});

test('Bootstrap: an empty listMap with tasks present stays pending (no premature done)', () => {
  const c = load();
  const state = c.newState_();
  // No list pairs yet: the gate must not auto-resolve to 'done', otherwise a
  // later round with freshly paired lists would create without a gate.
  const snap = coldSnap({ gTasks: [{ id: 'g1', title: 'Solo' }], msTasks: [] });
  c.bootstrapAdoptMatchingPairs_(state, snap);
  assert.deepEqual(Object.keys(state.g2m), []);
  assert.equal(state.bootstrap.status, 'pending');
});

test('Bootstrap: a truly empty account auto-resolves to done', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  const snap = coldSnap({ gTasks: [], msTasks: [] });
  const gate = c.bootstrapCreationGate_(state, snap);
  assert.equal(gate.blocked, false);
  assert.equal(state.bootstrap.status, 'done');
});

test('Bootstrap migration: existing mappings normalize to done (warm start never gated)', () => {
  const c = load();
  const state = c.newState_();
  delete state.bootstrap;
  state.g2m['g1'] = { msId: 'ms1', gListId: 'gList', msListId: 'msList' };
  state.m2g['ms1'] = 'g1';
  c.normalizeState_(state);
  assert.equal(state.bootstrap.status, 'done');
  assert.equal(state.bootstrap.plan, null);
});

test('Bootstrap migration: a mapping-less state normalizes to pending', () => {
  const c = load();
  const state = c.newState_();
  delete state.bootstrap;
  c.normalizeState_(state);
  assert.equal(state.bootstrap.status, 'pending');
});

test('Bootstrap schema guard: malformed bootstrap is rejected (STATE_MALFORMED)', () => {
  const c = load();
  const badStatus = c.newState_();
  badStatus.bootstrap.status = 'bogus';
  assert.throws(() => c.normalizeState_(badStatus), /STATE_MALFORMED/);
  const badCount = c.newState_();
  badCount.bootstrap.adoptedCount = -1;
  assert.throws(() => c.normalizeState_(badCount), /STATE_MALFORMED/);
  const badExtra = c.newState_();
  badExtra.bootstrap.surprise = 'poison';
  assert.throws(() => c.normalizeState_(badExtra), /STATE_MALFORMED/);
});
