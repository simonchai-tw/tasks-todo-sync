import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

/* Three cross-cutting subtask properties that no existing suite pinned down:
 *  (a) parent status and child completion never derive each other;
 *  (b) a throttled/incomplete checklist read keeps old knowledge and can never
 *      manufacture deletion evidence for the parent whose read failed;
 *  (c) a Google child change that is not part of the checklist contract
 *      (notes/due) produces zero checklist writes.
 * All three drive the real entry point reconcileSubtasks_. */

function load() {
  const props = { values: {}, getProperty(k) { return this.values[k] || null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; } };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: { sleep() {}, getUuid: () => '00000000-0000-4000-8000-000000000000' }
  });
  runGasFilesInContext(c);
  return c;
}

function baseState(c) {
  const s = c.newState_();
  s.listMap = { 'g-list': 'ms-list' };
  return s;
}

function stubGrandparentWriters(c) {
  const counters = { parentWrites: 0 };
  c.updateGTask_ = () => { counters.parentWrites += 1; return {}; };
  c.updateMsTask_ = () => { counters.parentWrites += 1; return {}; };
  return counters;
}

test('a parent status change never derives a child write, and a child completion never writes the parent', () => {
  const c = load();
  const s = baseState(c);
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.mappings['g-child'] = {
    gParentId: 'parent', parentMsId: 'ms-parent', msChecklistId: 'check-1',
    base: { title: 'Child', completed: false }
  };
  let checklistPatches = 0, googleChildPatches = 0;
  const writers = stubGrandparentWriters(c);
  c.updateMsChecklistItemNoRetry_ = () => { checklistPatches += 1; return { id: 'check-1', displayName: 'Child', isChecked: true }; };
  c.updateGChecklistChildNoRetry_ = () => { googleChildPatches += 1; return { id: 'g-child', title: 'Child', status: 'completed' }; };

  const snapFor = (parentStatus, childStatus) => ({
    safety: { enableSubtasks: true },
    gTasksById: {
      parent: { id: 'parent', title: 'Parent', status: parentStatus },
      'g-child': { id: 'g-child', parent: 'parent', title: 'Child', status: childStatus }
    },
    gListByTask: { parent: 'g-list', 'g-child': 'g-list' },
    msListByTask: { 'ms-parent': 'ms-list' },
    msChecklistItemsByParentId: { 'ms-parent': [{ id: 'check-1', displayName: 'Child', isChecked: false }] }
  });

  // (1) The parent is completed while both copies of the child stay untouched.
  const first = c.reconcileSubtasks_(s, snapFor('completed', 'needsAction'), { enableSubtasks: true, persist() {} });
  assert.equal(checklistPatches, 0, 'parent status must never become a checklist PATCH');
  assert.equal(googleChildPatches, 0);
  assert.equal(writers.parentWrites, 0, 'child reconciliation must never write the parent task');
  assert.equal(first.writes, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings['g-child'].base)),
    { title: 'Child', completed: false }, 'parent status must not advance the child baseline');

  // (2) The child completes on Google: that is its own field, mirrored onto the
  // checklist item, and it still must not touch the parent.
  const second = c.reconcileSubtasks_(s, snapFor('needsAction', 'completed'), { enableSubtasks: true, persist() {} });
  assert.equal(checklistPatches, 1, 'the child own completion is mirrored onto its checklist item');
  assert.equal(googleChildPatches, 0);
  assert.equal(writers.parentWrites, 0, 'child completion must not propagate to the parent');
  assert.equal(second.writes, 1);
  assert.equal(s.subtasks.mappings['g-child'].base.completed, true, 'the mirrored field advances the child baseline');
});

test('a throttled checklist read leaves only that parent unobserved and never manufactures deletion evidence', () => {
  const c = load();
  const s = baseState(c);
  const PARENTS = 20;
  const THROTTLED = 19;
  const gTasksById = {};
  const gListByTask = {};
  const msListByTask = {};
  const msChecklistItemsByParentId = {};
  const checklistObservationCompleteByParentId = {};
  for (let i = 0; i < PARENTS; i += 1) {
    const gParent = 'g-p' + i, msParent = 'ms-p' + i, gChild = 'g-c' + i, msCheck = 'check-' + i;
    s.g2m[gParent] = { msId: msParent, gListId: 'g-list', msListId: 'ms-list' };
    s.subtasks.mappings[gChild] = {
      gParentId: gParent, parentMsId: msParent, msChecklistId: msCheck,
      base: { title: 'Child', completed: false }
    };
    gTasksById[gParent] = { id: gParent, title: 'Parent', status: 'needsAction' };
    // Both sides independently agree on a new title, so the observed parents
    // advance their baseline without any provider write.
    gTasksById[gChild] = { id: gChild, parent: gParent, title: 'Renamed', status: 'needsAction' };
    gListByTask[gParent] = 'g-list';
    gListByTask[gChild] = 'g-list';
    msListByTask[msParent] = 'ms-list';
    if (i !== THROTTLED) {
      msChecklistItemsByParentId[msParent] = [{ id: msCheck, displayName: 'Renamed', isChecked: false }];
    } else {
      // The read for this parent was throttled: incomplete observation, no items.
      checklistObservationCompleteByParentId[msParent] = false;
    }
  }
  const snap = {
    safety: { enableSubtasks: true },
    gTasksById: gTasksById,
    gListByTask: gListByTask,
    msListByTask: msListByTask,
    msChecklistItemsByParentId: msChecklistItemsByParentId,
    checklistObservationCompleteByParentId: checklistObservationCompleteByParentId
  };
  let patches = 0;
  c.updateMsChecklistItemNoRetry_ = () => { patches += 1; return { id: 'check-x', displayName: 'Renamed', isChecked: false }; };
  c.updateGChecklistChildNoRetry_ = () => { patches += 1; return { id: 'g-cx', title: 'Renamed', status: 'needsAction' }; };

  const first = c.reconcileSubtasks_(s, snap, { enableSubtasks: true, persist() {} });
  assert.equal(patches, 0, 'an unobserved parent must not be written to');
  assert.equal(s.subtasks.mappings['g-c0'].base.title, 'Renamed',
    'the 19 completely observed parents are processed');
  assert.equal(s.subtasks.mappings['g-c18'].base.title, 'Renamed');
  assert.equal(s.subtasks.mappings['g-c' + THROTTLED].base.title, 'Child',
    'the throttled parent keeps its old knowledge');
  assert.equal(s.subtasks.pendingDeletions['g-c' + THROTTLED], undefined,
    'an incomplete observation must never enter the deletion path');
  assert.equal(first.conflicts, 0, 'an incomplete read is not a conflict either');
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.conflicts)), {},
    'a throttled read must not quarantine the child');

  // A second round with the same throttled read still produces no evidence: an
  // incomplete observation can never be counted twice into a confirmation.
  c.reconcileSubtasks_(s, snap, { enableSubtasks: true, persist() {} });
  assert.equal(s.subtasks.pendingDeletions['g-c' + THROTTLED], undefined);
  assert.equal(patches, 0);
  assert.equal(s.subtasks.mappings['g-c' + THROTTLED].base.title, 'Child');
});

test('a Google child notes/due-only change produces zero checklist writes', () => {
  const c = load();
  const s = baseState(c);
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.mappings['g-child'] = {
    gParentId: 'parent', parentMsId: 'ms-parent', msChecklistId: 'check-1',
    base: { title: 'Child', completed: false }
  };
  const writers = stubGrandparentWriters(c);
  let patches = 0;
  c.updateMsChecklistItemNoRetry_ = () => { patches += 1; return { id: 'check-1', displayName: 'Child', isChecked: false }; };
  c.updateGChecklistChildNoRetry_ = () => { patches += 1; return { id: 'g-child', title: 'Child', status: 'needsAction' }; };

  const snap = {
    safety: { enableSubtasks: true },
    gTasksById: {
      parent: { id: 'parent', title: 'Parent', status: 'needsAction' },
      'g-child': {
        id: 'g-child', parent: 'parent', title: 'Child', status: 'needsAction',
        notes: 'a note the checklist contract does not carry',
        due: '2026-09-20T00:00:00.000Z'
      }
    },
    gListByTask: { parent: 'g-list', 'g-child': 'g-list' },
    msListByTask: { 'ms-parent': 'ms-list' },
    msChecklistItemsByParentId: { 'ms-parent': [{ id: 'check-1', displayName: 'Child', isChecked: false }] }
  };
  const out = c.reconcileSubtasks_(s, snap, { enableSubtasks: true, persist() {} });
  assert.equal(patches, 0, 'notes/due are outside the checklist field contract');
  assert.equal(writers.parentWrites, 0);
  assert.equal(out.writes, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings['g-child'].base)),
    { title: 'Child', completed: false });
});
