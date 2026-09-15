import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

function propertyStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getProperty(key) { return Object.hasOwn(values, key) ? values[key] : null; },
    getProperties() { return { ...values }; },
    getKeys() { return Object.keys(values); },
    setProperty(key, value) { values[key] = String(value); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) values[k] = String(v); },
    deleteProperty(key) { delete values[key]; },
    deleteAllProperties() { for (const k of Object.keys(values)) delete values[k]; }
  };
}

function appsScriptUtilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA-256' },
    Charset: { UTF_8: 'UTF-8' },
    newBlob: (data) => ({ getBytes: () => Array.from(Buffer.from(data)), getDataAsString: () => String(data) }),
    gzip: (b) => b, ungzip: (b) => b,
    base64Encode: (data) => Buffer.from(typeof data === 'string' ? data : data).toString('base64'),
    base64Decode: (data) => Array.from(Buffer.from(data, 'base64')),
    computeDigest: () => [],
    sleep: () => {}
  };
}

function loadContext({ scriptValues = {}, userValues = {} } = {}) {
  const scriptStore = propertyStore(scriptValues);
  const userStore = propertyStore(userValues);
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => scriptStore,
      getUserProperties: () => userStore
    },
    ScriptApp: { getOAuthToken: () => 'test-token' },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) }
  });
  context.Utilities = appsScriptUtilities();
  context.LockService = {
    getUserLock: () => ({ waitLock() {}, releaseLock() {} }),
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
  };
  runGasFilesInContext(context);
  return { context, scriptStore, userStore };
}

test('applyConfirmedTaskDeletions_ batches deletion journal saves for all eligible tasks into one persistSyncState_', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.schema = 4;
  state.listMap = { 'g-list': 'ms-list' };

  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    gTasksById: {},
    msTasksById: {},
    gListByTask: {},
    msListByTask: {},
    safety: { allowDeletions: true }
  };

  // Set up 5 mapped task pairs
  for (let i = 1; i <= 5; i++) {
    const gId = 'g-task-' + i;
    const msId = 'ms-task-' + i;
    state.g2m[gId] = {
      msId: msId,
      gListId: 'g-list',
      msListId: 'ms-list',
      gUpdated: '2026-09-01T00:00:00Z',
      msUpdated: '2026-09-01T00:00:00Z'
    };
    state.m2g[msId] = gId;
    state.pendingTaskDeletions[gId] = {
      gId: gId,
      msId: msId,
      missingSide: 'google',
      gListId: 'g-list',
      msListId: 'ms-list',
      confirmations: 2,
      lastRoundId: 'round-current',
      gUpdated: '2026-09-01T00:00:00Z',
      msUpdated: '2026-09-01T00:00:00Z'
    };
    snap.msTasksById[msId] = { id: msId, title: 'Task ' + i, lastModifiedDateTime: '2026-09-01T00:00:00Z' };
    snap.msListByTask[msId] = 'ms-list';
  }

  let saveCalls = 0;
  context.persistSyncState_ = () => { saveCalls += 1; };
  const deletedMsIds = [];
  context.deleteMsTask_ = (listId, taskId) => { deletedMsIds.push(taskId); };

  const progress = context.applyConfirmedTaskDeletions_(state, snap, 'round-current', {
    durableJournalTaskIds: {},
    invalidatedCandidateTaskIds: {},
    discardCandidateTaskIds: {}
  });

  // Exactly 1 batch save of journals for all 5 tasks (instead of 5 individual saves!)
  assert.equal(saveCalls, 1, 'Deletion journal saving must be batched into a single durable save');
  assert.equal(deletedMsIds.length, 5, 'All 5 tasks must be deleted via remote call');
  assert.deepEqual(Object.keys(state.deletionJournal), [], 'All finalized journals must be cleared from state');
  assert.deepEqual(Object.keys(state.pendingTaskDeletions), [], 'All pending deletions must be cleared');
  assert.equal(Object.keys(state.g2m).length, 0, 'Mappings must be cleared');
  assert.equal(Object.keys(state.tombstones.g).length, 5, '5 tombstones must be created');
});

test('crash safety: if remote DELETE crashes midway, prepared journals were already saved durably and recover on next round', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.schema = 4;
  state.listMap = { 'g-list': 'ms-list' };

  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    gTasksById: {},
    msTasksById: {},
    gListByTask: {},
    msListByTask: {},
    safety: { allowDeletions: true }
  };

  for (let i = 1; i <= 3; i++) {
    const gId = 'g-task-' + i;
    const msId = 'ms-task-' + i;
    state.g2m[gId] = {
      msId: msId,
      gListId: 'g-list',
      msListId: 'ms-list',
      gUpdated: '2026-09-01T00:00:00Z',
      msUpdated: '2026-09-01T00:00:00Z'
    };
    state.m2g[msId] = gId;
    state.pendingTaskDeletions[gId] = {
      gId: gId,
      msId: msId,
      missingSide: 'google',
      gListId: 'g-list',
      msListId: 'ms-list',
      confirmations: 2,
      lastRoundId: 'round-current',
      gUpdated: '2026-09-01T00:00:00Z',
      msUpdated: '2026-09-01T00:00:00Z'
    };
    snap.msTasksById[msId] = { id: msId, title: 'Task ' + i, lastModifiedDateTime: '2026-09-01T00:00:00Z' };
    snap.msListByTask[msId] = 'ms-list';
  }

  // Simulate crash on the 2nd task's remote delete
  context.deleteMsTask_ = (listId, taskId) => {
    if (taskId === 'ms-task-2') throw new Error('SIMULATED_CRASH_DURING_DELETE');
  };

  assert.throws(() => {
    context.applyConfirmedTaskDeletions_(state, snap, 'round-current', {
      durableJournalTaskIds: {},
      invalidatedCandidateTaskIds: {},
      discardCandidateTaskIds: {}
    });
  }, /SIMULATED_CRASH_DURING_DELETE/);

  // Because journals were batch-persisted before remote deletes began:
  // Task 1 was finalized. Task 2 and 3 still have prepared journals!
  assert.ok(state.deletionJournal['g-task-2'], 'Task 2 journal must be present in state');
  assert.ok(state.deletionJournal['g-task-3'], 'Task 3 journal must be present in state');

  // Next round: recovery runs
  const nextSnap = {
    inventoryComplete: true,
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    gTasksById: {},
    msTasksById: {
      'ms-task-2': { id: 'ms-task-2', lastModifiedDateTime: '2026-09-01T00:00:00Z' },
      'ms-task-3': { id: 'ms-task-3', lastModifiedDateTime: '2026-09-01T00:00:00Z' }
    },
    gListByTask: {},
    msListByTask: {
      'ms-task-2': 'ms-list',
      'ms-task-3': 'ms-list'
    },
    safety: { allowDeletions: true }
  };
  const recoveredDeletes = [];
  context.deleteMsTask_ = (listId, taskId) => { recoveredDeletes.push(taskId); };

  context.recoverPreparedTaskDeletions_(state, nextSnap);
  assert.deepEqual(recoveredDeletes, ['ms-task-2', 'ms-task-3'], 'Unfinished deletions must be recovered');
  assert.deepEqual(Object.keys(state.deletionJournal), [], 'All journals recovered and cleared');
});
