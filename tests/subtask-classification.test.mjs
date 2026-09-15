import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

function load() {
  const props = { getProperty: (key) => props.values[key] || null, values: {} };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Utilities: { sleep() {} }
  });
  runGasFilesInContext(context);
  return context;
}

function baseSnapshot(overrides = {}) {
  return Object.assign({
    gTasksById: {}, gListByTask: {}, msTasksById: {}, msListByTask: {},
    safety: { enableSubtasks: true }
  }, overrides);
}

test('legacy ordinary mapping wins over child eligibility', () => {
  const c = load();
  const state = c.newState_();
  state.g2m.parent = { msId: 'ms-parent' };
  state.g2m.child = { msId: 'ms-flat' };
  const snap = baseSnapshot({
    gTasksById: { parent: {}, child: { parent: 'parent' } },
    msTasksById: { 'ms-parent': {}, 'ms-flat': {} }
  });
  assert.equal(c.classifySubtaskCandidate_(state, snap, { side: 'g', id: 'child' }).classification, 'LEGACY_FLAT');
});

test('one-level child is eligible, while an unready parent is deferred and never flattened', () => {
  const c = load();
  const state = c.newState_();
  state.g2m.parent = { msId: 'ms-parent' };
  const ready = baseSnapshot({
    gTasksById: { parent: {}, child: { parent: 'parent' } }, msTasksById: { 'ms-parent': {} }
  });
  assert.equal(c.classifySubtaskCandidate_(state, ready, { side: 'g', id: 'child' }).classification, 'ELIGIBLE_GOOGLE_CHILD');
  const missing = baseSnapshot({ gTasksById: { child: { parent: 'new-parent' } } });
  const deferred = c.classifySubtaskCandidate_(state, missing, { side: 'g', id: 'child' });
  assert.equal(deferred.classification, 'PARENT_NOT_READY');
  assert.equal(deferred.ordinaryExcluded, true);
});

test('deep and assigned children remain non-checklist classifications', () => {
  const c = load();
  const state = c.newState_();
  state.g2m.parent = { msId: 'ms-parent' };
  const deep = baseSnapshot({
    gTasksById: { grand: { parent: 'parent' }, parent: { parent: 'root' }, root: {} },
    msTasksById: { 'ms-parent': {} }
  });
  assert.equal(c.classifySubtaskCandidate_(state, deep, { side: 'g', id: 'grand' }).reason, 'DEEP_HIERARCHY');
  const assigned = baseSnapshot({
    gTasksById: { parent: {}, child: { parent: 'parent', assignmentInfo: { assignee: 'x' } } },
    msTasksById: { 'ms-parent': {} }
  });
  assert.equal(c.classifySubtaskCandidate_(state, assigned, { side: 'g', id: 'child' }).reason, 'ASSIGNED_TASK');
});

test('checklist identity is ID-only, deterministic across titles and response order', () => {
  const c = load();
  const state = c.newState_();
  state.g2m.parent = { msId: 'ms-parent' };
  const snap = baseSnapshot({
    gTasksById: { parent: {} }, msTasksById: { 'ms-check': {}, 'ms-other': {} },
    itemsByMsParentId: { 'ms-parent': [
      { id: 'check-a', displayName: 'Same title' }, { id: 'check-b', displayName: 'Same title' }
    ] }
  });
  assert.equal(c.classifySubtaskCandidate_(state, snap, { side: 'ms', id: 'check-a' }).reason, 'CHECKLIST_ID');
  assert.equal(c.classifySubtaskCandidate_(state, snap, { side: 'ms', id: 'check-b' }).reason, 'CHECKLIST_ID');
  assert.equal(c.classifySubtaskCandidate_(state, snap, { side: 'ms', id: 'ms-check' }).reason, 'TOP_LEVEL');
  const duplicate = JSON.parse(JSON.stringify(snap));
  duplicate.itemsByMsParentId['ms-parent'].push({ id: 'check-a', displayName: 'Same title' });
  assert.equal(c.classifySubtaskCandidate_(state, duplicate, { side: 'ms', id: 'check-a' }).reason, 'DUPLICATE_CHECKLIST_IDENTITY');
  const reversed = JSON.parse(JSON.stringify(snap));
  reversed.itemsByMsParentId['ms-parent'].reverse();
  assert.deepEqual(c.classifySubtaskCandidates_(state, snap), c.classifySubtaskCandidates_(state, reversed));
});

test('feature-off unmanaged checklist remains excluded from ordinary top-level create', () => {
  const c = load();
  const state = c.newState_();
  const snap = baseSnapshot({ safety: { enableSubtasks: false }, msTasksById: { 'ms-check': {} },
    itemsByMsParentId: { 'ms-parent': [{ id: 'ms-check', displayName: 'ordinary title' }] } });
  const item = c.classifySubtaskCandidate_(state, snap, { side: 'ms', id: 'ms-check' });
  assert.equal(item.classification, 'NON_CANDIDATE');
  assert.equal(item.ordinaryExcluded, true);
  assert.equal(c.subtaskClassificationReservations_(state, snap).reservedMicrosoftIds['ms-check'], true);
  state.listMap['g-list'] = 'ms-list';
  snap.msListByTask = { 'ms-check': 'ms-list' };
  snap.activeGListIds = { 'g-list': true };
  assert.equal(c.taskCreateBatchCandidates_(state, snap).some((candidate) => candidate.sourceTaskId === 'ms-check'), false);
});

test('managed reparent, unnest, and cross-list changes remain pending reservations', () => {
  const c = load();
  const state = c.newState_();
  state.subtasks.mappings.child = { gParentId: 'parent', msChecklistId: 'check' };
  const make = (task, list) => baseSnapshot({ gTasksById: { child: task, parent: {} }, gListByTask: { child: list, parent: 'list-a' } });
  assert.doesNotThrow(() => c.normalizeState_(state));
  assert.equal(c.classifySubtaskCandidate_(state, make({ parent: 'other' }, 'list-a'), { side: 'g', id: 'child' }).classification, 'SUBTASK_REPARENT_PENDING');
  assert.equal(c.classifySubtaskCandidate_(state, make({}, 'list-a'), { side: 'g', id: 'child' }).classification, 'SUBTASK_UNNEST_PENDING');
  assert.equal(c.classifySubtaskCandidate_(state, make({ parent: 'parent' }, 'list-b'), { side: 'g', id: 'child' }).classification, 'SUBTASK_CROSS_LIST_MOVE_PENDING');
  assert.equal(c.subtaskClassificationReservations_(state, make({ parent: 'other' }, 'list-a')).reservedGoogleIds.child, true);
});
