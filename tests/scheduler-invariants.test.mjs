import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

function load() {
  const values = {
    SYNC_GOOGLE_LIST_IDS: 'gList',
    SYNC_MICROSOFT_LIST_IDS: 'msList'
  };
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

test('Invariant 1: R-Completeness (fail-closed on pagination failure)', () => {
  const c = load();
  const state = c.newState_();
  state.g2m['g1'] = { msId: 'ms1', gListId: 'gList', msListId: 'msList' };
  state.m2g['ms1'] = 'g1';
  state.listMap['gList'] = 'msList';
  state.syncToken = 'old_token';

  c.gFetch_ = () => { throw new Error('API_ERROR during pagination'); };
  
  assert.throws(() => {
    c.buildSnapshot_(state, Date.now());
  }, /API_ERROR/);
  
  assert.equal(state.syncToken, 'old_token', '0 state mutations');
});

function mappedTaskSnapshot({
  gTask = { id: 'g1', title: 'Task1', updated: '2026-08-14T00:00:00Z' },
  msTask = { id: 'ms1', title: 'Task1', lastModifiedDateTime: '2026-08-14T00:00:00Z' },
  allowDeletions = true
} = {}) {
  return {
    activeGListIds: { 'gList': true },
    gTaskInventoryListIds: { 'gList': true },
    msTaskInventoryListIds: { 'msList': true },
    inventoryComplete: true,
    safety: { allowDeletions, allowTaskMoves: false },
    gTasksById: gTask ? { [gTask.id]: gTask } : {},
    msTasksById: msTask ? { [msTask.id]: msTask } : {},
    gListByTask: gTask ? { [gTask.id]: 'gList' } : {},
    msListByTask: msTask ? { [msTask.id]: 'msList' } : {}
  };
}

test('Invariant 2: Two-Round Deletion with Absence Probe Soundness', () => {
  const c = load();
  const state = c.newState_();
  state.g2m['g1'] = { msId: 'ms1', gListId: 'gList', msListId: 'msList' };
  state.m2g['ms1'] = 'g1';
  state.listMap['gList'] = 'msList';
  
  const startedAt = Date.now();
  const progress = { durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} };

  // Round 1: Missing on Google
  const snap1 = mappedTaskSnapshot({ gTask: null });
  c.reconcileMapped_(state, snap1, startedAt, 'round1', progress);
  assert.ok(state.pendingTaskDeletions['g1'], 'Deletion candidate generated');
  assert.equal(state.pendingTaskDeletions['g1'].lastRoundId, 'round1', 'Candidate roundId matches');
  assert.equal(state.pendingTaskDeletions['g1'].confirmations, 1, 'Confirmations should be 1');

  // Same round: should not delete
  c.reconcileMapped_(state, snap1, startedAt, 'round1', progress);
  assert.equal(state.pendingTaskDeletions['g1'].confirmations, 1, 'Confirmations should still be 1 (same round guard)');
  assert.equal(state.pendingTaskDeletions['g1'].lastRoundId, 'round1');

  // Round 2: Probe alive -> invalidate
  let probed = false;
  c.getGTask_ = (listId, taskId) => {
    if (listId === 'gList' && taskId === 'g1') probed = true;
    return { id: 'g1', title: 'Task1', status: 'needsAction' };
  };
  
  const snap2 = mappedTaskSnapshot({ gTask: null });
  c.reconcileMapped_(state, snap2, startedAt, 'round2', progress);
  
  assert.ok(probed, 'Should probe via GET');
  assert.equal(state.pendingTaskDeletions['g1'], undefined, 'Candidate invalidated (filter artifact)');
  assert.ok(progress.invalidatedCandidateTaskIds['g1'], 'Progress updated with invalidation');
});

test('Invariant 3: Starvation-Free Rotating Observation Cursor', () => {
  const c = load();
  const state = c.newState_();
  state.listMap['gList'] = 'msList';
  
  // Create 25 pairs
  const snap = { msTasksById: {} };
  for (let i = 0; i < 25; i++) {
    const id = `t${i}`;
    state.g2m[id] = { msId: id, gListId: 'gList', msListId: 'msList' };
    state.m2g[id] = id;
    snap.msTasksById[id] = { id: id };
  }
  
  // Set budget B = 10
  c.RESOURCE_OBSERVATION_MAX_PAIRS_ = 10;
  
  // Check how many pairs are observed in 3 rounds (ceil(25/10) = 3)
  c.getMsTaskLinkedResources_ = (listId, msId) => {
    return { kind: 'OBSERVED_COMPLETE', items: [] };
  };
  
  // Track observation count per pair
  const observationCounts = {};
  for (let i = 0; i < 25; i++) {
    observationCounts[`t${i}`] = 0;
  }
  
  // Round 1
  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  const snap1 = Object.keys(c._resourceObservationSnapshot_);
  assert.equal(snap1.length, 10);
  assert.equal(state.resourceObservationCursor, 10);
  for (const msId of snap1) { observationCounts[msId]++; }
  
  // Round 2
  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  const snap2 = Object.keys(c._resourceObservationSnapshot_);
  assert.equal(snap2.length, 10);
  assert.equal(state.resourceObservationCursor, 20);
  for (const msId of snap2) { observationCounts[msId]++; }
  
  // Round 3
  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  const snap3 = Object.keys(c._resourceObservationSnapshot_);
  assert.equal(snap3.length, 10); // 5 elements from end, 5 wrapped around from start
  assert.equal(state.resourceObservationCursor, 5); // (20+10)%25 = 5
  for (const msId of snap3) { observationCounts[msId]++; }
  
  // In 3 rounds, 30 observations made across 25 pairs.
  // So all pairs must have been observed at least once.
  for (let i = 0; i < 25; i++) {
    assert.ok(observationCounts[`t${i}`] >= 1, `Pair t${i} must be observed at least once`);
  }
  
  // Now simulate addition of pairs (N changes)
  for (let i = 25; i < 30; i++) {
    const id = `t${i}`;
    state.g2m[id] = { msId: id, gListId: 'gList', msListId: 'msList' };
    state.m2g[id] = id;
    snap.msTasksById[id] = { id: id };
  }
  
  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  assert.equal(state.resourceObservationCursor, 15);
});
