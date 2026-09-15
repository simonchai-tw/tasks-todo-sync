import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

function load() {
  const props = {
    values: {},
    getProperty(k) { return this.values[k] || null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; }
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

function mapped(c) {
  const s = c.newState_();
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.mappings.child = {
    gParentId: 'parent',
    msChecklistId: 'check',
    parentMsId: 'ms-parent',
    parentMsListId: 'ms-list',
    base: { title: 'Child', completed: false }
  };
  return s;
}

function snap(overrides = {}) {
  return {
    safety: { enableSubtasks: true },
    googleInventoryComplete: true,
    gTasksById: {
      parent: { id: 'parent', title: 'Parent', status: 'needsAction' },
      child: { id: 'child', parent: 'parent', title: 'Child', status: 'needsAction' }
    },
    gListByTask: { parent: 'g-list', child: 'g-list' },
    msChecklistItemsByParentId: {
      'ms-parent': [{ id: 'check', displayName: 'Child', isChecked: false }]
    },
    ...overrides
  };
}

test('feature OFF performs zero provider writes while retaining journals', () => {
  const c = load();
  const s = mapped(c);
  s.subtasks.createJournal.pending = {
    phase: 'UNCERTAIN', gChildId: 'child', gParentId: 'parent',
    intended: { title: 'x', completed: false }
  };
  let writes = 0;
  c.createMsChecklistItemNoRetry_ = () => { writes += 1; return { id: 'never' }; };
  c.deleteMsChecklistItemNoRetry_ = () => { writes += 1; };
  c.deleteGChecklistChildNoRetry_ = () => { writes += 1; };
  const out = c.reconcileSubtasks_(s, snap({ safety: { enableSubtasks: false } }), {
    enableSubtasks: false,
    persist() { writes += 1; }
  });
  assert.equal(out.writes, 0);
  assert.equal(writes, 0);
  assert.equal(s.subtasks.createJournal.pending.phase, 'UNCERTAIN');
});

test('incomplete malformed and unobserved reads do not increment deletion streak', () => {
  const c = load();
  const s = mapped(c);
  c.subtaskObserveDeletionEvidence_(s, {
    googleInventoryComplete: false,
    gTasksById: { parent: { id: 'parent' } },
    msChecklistItemsByParentId: {}
  }, { roundId: 'r1', persist() {} });
  assert.equal(s.subtasks.pendingDeletions.child, undefined);

  c.subtaskRecordMissingObservation_(s, {
    gChildId: 'child', missingSide: 'MICROSOFT', roundId: 'r1', observationComplete: false,
    googleChild: { title: 'Child', status: 'needsAction' }
  }, { persist() {} });
  assert.equal(s.subtasks.pendingDeletions.child, undefined);
});

test('one complete observation is insufficient; two independent observations delete the survivor', () => {
  const c = load();
  const s = mapped(c);
  const deletes = [];
  c.deleteGChecklistChildNoRetry_ = (list, id) => { deletes.push({ list, id }); };
  c.deleteMsChecklistItemNoRetry_ = () => { throw new Error('must not delete microsoft'); };
  const missingMs = snap({
    msChecklistItemsByParentId: { 'ms-parent': [] }
  });
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r1', persist() {} });
  assert.equal(s.subtasks.pendingDeletions.child.missingStreak, 1);
  assert.equal(deletes.length, 0);
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r2', persist() {} });
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0], { list: 'g-list', id: 'child' });
  assert.equal(s.subtasks.mappings.child, undefined);
  assert.ok(s.subtasks.tombstones.g.child);
});

test('item reappearance resets the missing streak', () => {
  const c = load();
  const s = mapped(c);
  const missingMs = snap({ msChecklistItemsByParentId: { 'ms-parent': [] } });
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r1', persist() {} });
  assert.equal(s.subtasks.pendingDeletions.child.missingStreak, 1);
  c.reconcileSubtasks_(s, snap(), { enableSubtasks: true, roundId: 'r2', persist() {} });
  assert.equal(s.subtasks.pendingDeletions.child, undefined);
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r3', persist() {} });
  assert.equal(s.subtasks.pendingDeletions.child.missingStreak, 1);
});

test('active conflict freezes deletion evidence', () => {
  const c = load();
  const s = mapped(c);
  s.subtasks.conflicts.child = {
    gChildId: 'child', msChecklistId: 'check', gParentId: 'parent', reason: 'SUBTASK_TITLE_CONFLICT'
  };
  let deletes = 0;
  c.deleteGChecklistChildNoRetry_ = () => { deletes += 1; };
  const missingMs = snap({ msChecklistItemsByParentId: { 'ms-parent': [] } });
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r1', persist() {} });
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r2', persist() {} });
  assert.equal(deletes, 0);
  assert.equal(s.subtasks.pendingDeletions.child, undefined);
  assert.ok(s.subtasks.mappings.child);
});

test('delete-versus-edit conflict does not delete', () => {
  const c = load();
  const s = mapped(c);
  let deletes = 0;
  c.deleteGChecklistChildNoRetry_ = () => { deletes += 1; };
  c.reconcileSubtasks_(s, snap({
    gTasksById: {
      parent: { id: 'parent', title: 'Parent', status: 'needsAction' },
      child: { id: 'child', parent: 'parent', title: 'Child', status: 'needsAction' }
    },
    msChecklistItemsByParentId: { 'ms-parent': [] }
  }), { enableSubtasks: true, roundId: 'r1', persist() {} });
  c.reconcileSubtasks_(s, snap({
    gTasksById: {
      parent: { id: 'parent', title: 'Parent', status: 'needsAction' },
      child: { id: 'child', parent: 'parent', title: 'Renamed', status: 'needsAction' }
    },
    msChecklistItemsByParentId: { 'ms-parent': [] }
  }), { enableSubtasks: true, roundId: 'r2', persist() {} });
  assert.equal(deletes, 0);
  assert.equal(s.subtasks.conflicts.child.reason, 'SUBTASK_DELETE_EDIT_CONFLICT');
  assert.ok(s.subtasks.mappings.child);
});

test('404 and 410 remote deletes are idempotent success', () => {
  const c = load();
  const s = mapped(c);
  c.deleteGChecklistChildNoRetry_ = () => { throw new Error('HTTP 404: gone'); };
  const missingMs = snap({ msChecklistItemsByParentId: { 'ms-parent': [] } });
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r1', persist() {} });
  c.reconcileSubtasks_(s, missingMs, { enableSubtasks: true, roundId: 'r2', persist() {} });
  assert.equal(s.subtasks.mappings.child, undefined);
  assert.ok(s.subtasks.tombstones.g.child);
});

test('parent loss is per-child AMBIGUOUS_PARENT_LOSS and does not cascade deletes', () => {
  const c = load();
  const s = mapped(c);
  let deletes = 0;
  c.deleteGChecklistChildNoRetry_ = () => { deletes += 1; };
  c.deleteMsChecklistItemNoRetry_ = () => { deletes += 1; };
  c.reconcileSubtasks_(s, snap({
    googleInventoryComplete: true,
    gTasksById: {},
    msChecklistItemsByParentId: { 'ms-parent': [{ id: 'check', displayName: 'Child', isChecked: false }] }
  }), { enableSubtasks: true, roundId: 'r1', persist() {} });
  assert.equal(deletes, 0);
  assert.equal(s.subtasks.conflicts.child.reason, 'AMBIGUOUS_PARENT_LOSS_GOOGLE');
  assert.ok(s.subtasks.mappings.child);
  assert.equal(s.subtasks.pendingDeletions.child, undefined);
});
