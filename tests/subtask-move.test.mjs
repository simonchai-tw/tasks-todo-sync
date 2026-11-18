/* D4 move-journal resume executor tests (offline, mock providers only).
 *
 * S1-S9 acceptance rows per p2-supplemental-rulings-2026-11-12.md §2/§3 and
 * option-a-superseded-ruling-2026-11-17.md §6 R5 (S1-S9 UNAFFECTED).  The
 * executor lives in ../subtask-move.gs, which is not yet in lib/gas-files.mjs
 * (lead-owned), so it is loaded into the VM explicitly after the canonical
 * file set.  Every remote seam is a local mock; no network access. */

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { runGasFilesInContext } from './gas-loader.mjs';

const MOVE_SOURCE = readFileSync(new URL('../subtask-move.gs', import.meta.url), 'utf8');

function load() {
  const props = { values: {}, getProperty(k) { return this.values[k] || null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; } };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: { sleep() {}, getUuid: () => '00000000-0000-4000-8000-000000000000' }
  });
  runGasFilesInContext(c);
  new vm.Script(MOVE_SOURCE, { filename: 'subtask-move.gs' }).runInContext(c);
  return c;
}

/* A state with one mapped parent (g2m) whose checklist child 'child' maps to
 * the checklist item 'ms-old' under MS parent 'ms-parent' in list 'ms-list'. */
function baseState(c) {
  const s = c.newState_();
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.mappings.child = {
    gParentId: 'parent', msChecklistId: 'ms-old',
    parentMsId: 'ms-parent', parentMsListId: 'ms-list',
    base: { title: 'Child', completed: false }
  };
  return s;
}

function parent2State(c) {
  const s = baseState(c);
  s.g2m.parent2 = { msId: 'ms-parent2', gListId: 'g-list', msListId: 'ms-list2' };
  return s;
}

const G_CHILD_TOP_LEVEL = { id: 'child', title: 'Child', status: 'needsAction', notes: '', due: '' };
const G_CHILD_WITH_META = {
  id: 'child', title: 'Child', status: 'needsAction',
  notes: '[TTS-REC:AB12CD]\nuser body', due: '2026-01-02T00:00:00.000Z'
};

/* Live MS checklist item store shared by observation and the delete mock, so
 * "deleted exactly once" is measured against real store state, not call counts. */
function checklistStore(initial) {
  const items = {};
  (initial || []).forEach(function(item) { items[item.id] = item; });
  return {
    items: items,
    list: function() { return Object.keys(items).map(function(id) { return items[id]; }); },
    mock: function(c) {
      c.deleteMsChecklistItemNoRetry_ = (listId, parentId, checklistId) => {
        if (!items[checklistId]) throw new Error('HTTP 404: Not Found');
        delete items[checklistId];
        return {};
      };
    }
  };
}

function baseSnap(overrides) {
  /* Deep-clone the fixture: tests mutate snap.gTasksById.child (e.g. adding a
   * parent for reparent cases) and must never pollute the shared constant. */
  const child = overrides && overrides.child !== undefined
    ? JSON.parse(JSON.stringify(overrides.child === null ? null : overrides.child))
    : JSON.parse(JSON.stringify(G_CHILD_TOP_LEVEL));
  const snap = {
    safety: { enableSubtasks: true, allowDeletions: true },
    inventoryComplete: true,
    googleInventoryComplete: true,
    gTasksById: child === null ? {} : { child: child },
    gListByTask: { child: 'g-list' },
    msTasksById: {},
    msListByTask: {},
    msTaskInventoryListIds: { 'ms-list': true },
    msChecklistItemsByParentId: { 'ms-parent': checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]).list() }
  };
  Object.assign(snap, (overrides && overrides.snap) || {});
  return snap;
}

function options(c, extra) {
  return Object.assign({ enableSubtasks: true, allowDeletions: true, persist() {}, roundId: 'r1' }, extra || {});
}

const CREATE_EXTENSION_ID = 'microsoft.graph.openTypeExtension.com.tasksTodoSync.create';

function orphanTopLevelTask(correlationId, id) {
  return {
    id: id || 'ms-orphan',
    extensions: [{ id: CREATE_EXTENSION_ID, extensionName: 'com.tasksTodoSync.create', correlationId: correlationId }]
  };
}

function row(phase, extra) {
  return Object.assign({ phase: phase, gChildId: 'child', msChecklistId: 'ms-old', gParentId: 'parent' }, extra || {});
}

/* ------------------------------------------------------------------ S1 --- */

test('S1: crash injection at each of the 5 moveJournal phases self-heals', () => {
  /* PREPARED, no orphan on the remote side: exactly one create, no reposts. */
  {
    const c = load(); const s = baseState(c);
    s.subtasks.moveJournal.child = row('PREPARED');
    const posts = []; c.getMsTasks_ = () => [];
    c.createMsTask_ = (listId, payload) => { posts.push({ listId, payload }); return { id: 'ms-new', title: payload.title }; };
    const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
    const r1 = c.subtaskMoveRecovery_(s, baseSnap(), options(c));
    assert.equal(posts.length, 1, 'PREPARED resume creates the top-level task exactly once');
    assert.equal(r1.created, 1);
    assert.equal(s.subtasks.moveJournal.child.phase, 'OLD_DELETE_PENDING');
    const snap2 = baseSnap(); snap2.msChecklistItemsByParentId['ms-parent'] = [];
    c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
    assert.equal(s.subtasks.moveJournal.child, undefined, 'row retires after the old item is observed gone');
    assert.deepEqual(JSON.parse(JSON.stringify(s.g2m.child)), { msId: 'ms-new', gListId: 'g-list', msListId: 'ms-list' });
    assert.equal(posts.length, 1, 'zero duplicate POST across rounds');
    assert.deepEqual(store.list(), [], 'old item deleted exactly once');
  }

  /* PREPARED with an extension-correlated orphan (crash after POST, before the
   * REMOTE_CREATED persist): the orphan is adopted, never re-POSTed. */
  {
    const c = load(); const s = baseState(c);
    s.subtasks.moveJournal.child = row('PREPARED');
    let posts = 0; c.createMsTask_ = () => { posts += 1; return { id: 'never' }; };
    c.getMsTasks_ = () => [orphanTopLevelTask('subtask-move:child')];
    const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
    c.subtaskMoveRecovery_(s, baseSnap(), options(c));
    assert.equal(posts, 0, 'correlated orphan is adopted with zero duplicate POST');
    assert.equal(s.subtasks.moveJournal.child.nextMsChecklistId, 'ms-orphan');
    assert.equal(s.subtasks.moveJournal.child.phase, 'OLD_DELETE_PENDING');
  }

  /* Ambiguous correlation (two matching extensions) fails closed. */
  {
    const c = load(); const s = baseState(c);
    s.subtasks.moveJournal.child = row('PREPARED');
    c.createMsTask_ = () => { throw new Error('must not post'); };
    c.getMsTasks_ = () => [orphanTopLevelTask('subtask-move:child', 'a'), orphanTopLevelTask('subtask-move:child', 'b')];
    c.subtaskMoveRecovery_(s, baseSnap(), options(c));
    assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN');
    assert.equal(s.subtasks.moveJournal.child.nextMsChecklistId, undefined);
  }

  /* REMOTE_CREATED: rebind (tombstone + mapping release) then old-item delete. */
  {
    const c = load(); const s = baseState(c);
    s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new' });
    const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
    const snap = baseSnap(); snap.msTasksById['ms-new'] = { id: 'ms-new' };
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(s.subtasks.moveJournal.child.phase, 'OLD_DELETE_PENDING');
    assert.equal(s.subtasks.mappings.child, undefined, 'checklist mapping released at rebind');
    const tombstoneKeys = Object.keys(s.subtasks.tombstones.ms);
    assert.equal(tombstoneKeys.length, 1, 'old checklist id is tombstoned before its delete');
    const snap2 = baseSnap(); snap2.msChecklistItemsByParentId['ms-parent'] = [];
    snap2.msTasksById['ms-new'] = { id: 'ms-new' };
    c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
    assert.equal(s.subtasks.moveJournal.child, undefined);
    assert.equal(s.g2m.child.msId, 'ms-new');
    assert.equal(store.items['ms-old'], undefined, 'old item deleted exactly once');
  }

  /* REBIND_PERSISTED (mapping already released): resumes at the old-item delete. */
  {
    const c = load(); const s = baseState(c);
    delete s.subtasks.mappings.child;
    s.subtasks.moveJournal.child = row('REBIND_PERSISTED', { nextMsChecklistId: 'ms-new' });
    const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
    c.subtaskMoveRecovery_(s, baseSnap(), options(c));
    assert.equal(s.subtasks.moveJournal.child.phase, 'OLD_DELETE_PENDING');
    const snap2 = baseSnap(); snap2.msChecklistItemsByParentId['ms-parent'] = [];
    c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
    assert.equal(s.subtasks.moveJournal.child, undefined);
    assert.equal(store.items['ms-old'], undefined);
  }

  /* OLD_DELETE_PENDING with the old item already gone: pure bookkeeping finalize. */
  {
    const c = load(); const s = baseState(c);
    delete s.subtasks.mappings.child;
    s.subtasks.moveJournal.child = row('OLD_DELETE_PENDING', { nextMsChecklistId: 'ms-new' });
    let deletes = 0; c.deleteMsChecklistItemNoRetry_ = () => { deletes += 1; return {}; };
    const snap = baseSnap(); snap.msChecklistItemsByParentId['ms-parent'] = [];
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(deletes, 0, 'finalize never re-issues a delete for an observed-gone item');
    assert.equal(s.subtasks.moveJournal.child, undefined);
    assert.equal(s.g2m.child.msId, 'ms-new');
  }

  /* UNCERTAIN: fail-closed terminal-safe state, zero writes, row preserved. */
  {
    const c = load(); const s = baseState(c);
    s.subtasks.moveJournal.child = row('UNCERTAIN', { nextMsChecklistId: 'ms-new' });
    const guard = () => { throw new Error('UNCERTAIN must not write'); };
    c.createMsTask_ = guard; c.deleteMsChecklistItemNoRetry_ = guard; c.createMsChecklistItemNoRetry_ = guard;
    const r = c.subtaskMoveRecovery_(s, baseSnap(), options(c));
    assert.equal(r.uncertain, 1);
    assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN');
    assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings.child.base)), { title: 'Child', completed: false });
  }
});

/* ------------------------------------------------------------------ S2 --- */

test('S2: move identity uses recorded IDs only, never titles', () => {
  const c = load(); const s = parent2State(c);
  s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new2' });
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]);
  /* A decoy with the IDENTICAL title sits in the new parent's observation. */
  store.items['ms-decoy2'] = { id: 'ms-decoy2', displayName: 'Child', isChecked: false };
  store.items['ms-new2'] = { id: 'ms-new2', displayName: 'Child', isChecked: false };
  store.mock(c);
  const snap = baseSnap();
  snap.gTasksById.child = { id: 'child', title: 'Child', status: 'needsAction', parent: 'parent2', notes: '', due: '' };
  snap.msChecklistItemsByParentId['ms-parent2'] = store.list();
  snap.msTaskInventoryListIds['ms-list2'] = true;
  c.subtaskMoveRecovery_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
  const snap2 = baseSnap();
  snap2.gTasksById.child = snap.gTasksById.child;
  snap2.msChecklistItemsByParentId['ms-parent'] = [];
  snap2.msChecklistItemsByParentId['ms-parent2'] = store.list();
  snap2.msTaskInventoryListIds['ms-list2'] = true;
  c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
  const mapping = s.subtasks.mappings.child;
  assert.ok(mapping, 'reparent keeps a checklist mapping');
  assert.equal(mapping.msChecklistId, 'ms-new2', 'mapping rebinds to the RECORDED id, not the title twin');
  assert.equal(mapping.gParentId, 'parent2');
  assert.equal(mapping.parentMsId, 'ms-parent2');
  assert.equal(mapping.parentMsListId, 'ms-list2');
  assert.equal(s.g2m.child, undefined, 'a reparented child never becomes an ordinary pair');
  assert.equal(store.items['ms-old'], undefined, 'old item deleted exactly once');
  assert.ok(store.items['ms-decoy2'], 'the title twin is never deleted');
  assert.ok(s.subtasks.tombstones.ms[JSON.stringify({ msParentId: 'ms-parent', msChecklistId: 'ms-old' })], 'old id tombstoned');
});

/* ------------------------------------------------------------------ S3 --- */

test('S3: Unnest copies notes/due from the same-round snapshot and keeps [TTS-REC]', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('PREPARED');
  const payloads = []; c.getMsTasks_ = () => [];
  c.createMsTask_ = (listId, payload) => { payloads.push({ listId, payload }); return { id: 'ms-new' }; };
  const snap = baseSnap({ child: G_CHILD_WITH_META });
  c.subtaskMoveRecovery_(s, snap, options(c));
  assert.equal(payloads.length, 1);
  const { listId, payload } = payloads[0];
  assert.equal(listId, 'ms-list', 'the top-level task is created in the old parent\'s MS list');
  assert.equal(payload.title, 'Child');
  assert.ok(typeof payload.body.content === 'string' && payload.body.content.indexOf('[TTS-REC:AB12CD]') >= 0,
    '[TTS-REC] header line is carried verbatim');
  assert.ok(payload.body.content.indexOf('user body') >= 0, 'user notes are carried');
  assert.ok(payload.body.content.indexOf('[TTS-REC:AB12CD]') < payload.body.content.indexOf('user body'),
    'the marker stays ahead of the user body (not re-parsed or rewritten)');
  assert.ok(payload.dueDateTime && String(payload.dueDateTime.dateTime || '').indexOf('2026-01-02') >= 0,
    'the snapshot due is carried into the new top-level task');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.extensions)), [{
    '@odata.type': 'microsoft.graph.openTypeExtension',
    extensionName: 'com.tasksTodoSync.create',
    correlationId: 'subtask-move:child'
  }]);
});

/* ------------------------------------------------------------------ S4 --- */

test('S4: a vanished Google child mid-move never fabricates deletion evidence', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new' });
  const writes = [];
  c.createMsTask_ = () => { writes.push('create'); };
  c.deleteMsChecklistItemNoRetry_ = () => { writes.push('delete'); };
  c.createMsChecklistItemNoRetry_ = () => { writes.push('create-item'); };
  const snap = baseSnap({ child: null });  // complete inventory, child absent
  const r = c.subtaskMoveRecovery_(s, snap, options(c));
  assert.deepEqual(writes, [], 'zero remote writes for a missing child');
  assert.equal(r.uncertain, 1);
  assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN', 'row is parked, never dereferenced');
  assert.deepEqual(Object.keys(s.subtasks.pendingDeletions), [], 'no deletion evidence is invented');
});

/* ------------------------------------------------------------------ S5 --- */

test('S5: Reparent auto-runs only when notes and due are both empty', () => {
  /* Metadata-bearing child: HOLD with the loss list, zero remote writes. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED');
    const writes = [];
    c.createMsChecklistItemNoRetry_ = () => { writes.push('create-item'); return { id: 'x' }; };
    c.deleteMsChecklistItemNoRetry_ = () => { writes.push('delete-item'); return {}; };
    const snap = baseSnap({ child: G_CHILD_WITH_META });
    snap.gTasksById.child.parent = 'parent2';
    const r = c.subtaskMoveRecovery_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
    assert.deepEqual(writes, [], 'a metadata-bearing reparent never writes remotely');
    assert.equal(r.held, 1);
    assert.ok(Array.isArray(r.heldFields) && r.heldFields.indexOf('notes') >= 0 && r.heldFields.indexOf('due') >= 0,
      'the fields that would be lost are listed');
    assert.equal(s.subtasks.moveJournal.child.phase, 'PREPARED', 'the row is held, not dropped');
  }
  /* Empty-metadata PREPARED row WITHOUT the journaled title (today's frozen
   * 5-field contract): the executor cannot correlate a checklist POST by any
   * artifact (checklistItems carry no notes/extendedProperties), so it stays
   * fail-closed — park UNCERTAIN, zero writes.  Wiring request: journal the
   * child title at PREPARED write time to activate the create leg below. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED');
    let creates = 0; c.createMsChecklistItemNoRetry_ = () => { creates += 1; return { id: 'x' }; };
    const snap = baseSnap();
    snap.gTasksById.child.parent = 'parent2';
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(creates, 0, 'no ambiguous checklist POST is re-issued from recovery');
    assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN');
  }
  /* Create-then-delete completes exactly once from REMOTE_CREATED (the writer
   * has already created; the executor owns rebind + delete + finalize). */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new2' });
    const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]);
    store.items['ms-new2'] = { id: 'ms-new2', displayName: 'Child', isChecked: false };
    store.mock(c);
    const snap = baseSnap();
    snap.gTasksById.child = { id: 'child', title: 'Child', status: 'needsAction', parent: 'parent2', notes: '', due: '' };
    snap.msChecklistItemsByParentId['ms-parent2'] = store.list();
    snap.msTaskInventoryListIds['ms-list2'] = true;
    c.subtaskMoveRecovery_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
    const snap2 = JSON.parse(JSON.stringify(snap));
    snap2.msChecklistItemsByParentId['ms-parent'] = [];
    c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
    assert.equal(store.items['ms-old'], undefined, 'old item deleted exactly once');
    assert.equal(s.subtasks.moveJournal.child, undefined, 'row retires');
    const m = s.subtasks.mappings.child;
    assert.equal(m.msChecklistId, 'ms-new2');
    assert.equal(m.gParentId, 'parent2');
    assert.deepEqual(JSON.parse(JSON.stringify(m.base)), { title: 'Child', completed: false });
    assert.equal(s.g2m.child, undefined);
  }
});

/* ------------------------------------------------------------------ S6 --- */

test('S6: moveJournal executes first and refreshes snap/mappedChecklistIds in the same round', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new' });
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  c.getMsTasks_ = () => [];
  const createdTasks = [];
  c.createMsTask_ = (listId, payload) => { createdTasks.push(payload); return { id: 'ms-new' }; };
  const order = [];
  const realRecovery = c.subtaskMoveRecovery_;
  const realObserve = c.subtaskObserveDeletionEvidence_;
  c.subtaskMoveRecovery_ = function(st, sn, op) { order.push('recovery'); return realRecovery(st, sn, op); };
  c.subtaskObserveDeletionEvidence_ = function(st, sn, op) { order.push('observe'); return realObserve(st, sn, op); };
  const snap = baseSnap();
  snap.msTasksById['ms-new'] = { id: 'ms-new' };
  const out = c.reconcileSubtasks_(s, snap, options(c));
  assert.ok(order.indexOf('recovery') >= 0, 'the move recovery runs inside reconcile');
  assert.ok(order.indexOf('recovery') < order.indexOf('observe'), 'recovery precedes deletion observation');
  assert.equal(s.subtasks.mappings.child, undefined, 'mapping released in the same round');
  assert.ok(Object.keys(s.subtasks.tombstones.ms).length === 1, 'old id reserved in the same round');
  assert.deepEqual(Object.keys(s.subtasks.pendingDeletions), [], 'old item absence is not counted as a user deletion');
  /* Same-round snapshot refresh: the executor registered the new top-level
   * task, so the M->G adoption loop cannot double-create it. */
  assert.ok(snap.msTasksById['ms-new'], 'the created task is registered in the round snapshot');
  /* No Google child was re-created for the old checklist item (tombstone) or
   * the new task (registered): the M->G loop stays silent. */
  assert.equal(out.creates, 0);
  assert.equal(createdTasks.length, 0, 'reconcile itself did not create a duplicate top-level task');
});

/* ------------------------------------------------------------------ S9 --- */

test('S9: Move recovery runs before deletion observation and the new item survives', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new' });
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  c.getMsTasks_ = () => [];
  let msTaskDeletes = 0, gTaskDeletes = 0;
  c.deleteMsTask_ = () => { msTaskDeletes += 1; return {}; };
  c.deleteGTask_ = () => { gTaskDeletes += 1; return {}; };
  const order = [];
  const realRecovery = c.subtaskMoveRecovery_;
  const realObserve = c.subtaskObserveDeletionEvidence_;
  const realExecute = c.subtaskExecuteEligibleDeletes_;
  c.subtaskMoveRecovery_ = function(st, sn, op) { order.push('recovery'); return realRecovery(st, sn, op); };
  c.subtaskObserveDeletionEvidence_ = function(st, sn, op) { order.push('observe'); return realObserve(st, sn, op); };
  c.subtaskExecuteEligibleDeletes_ = function(st, sn, op) { order.push('execute-deletes'); return realExecute(st, sn, op); };
  const snap = baseSnap();
  snap.msTasksById['ms-new'] = { id: 'ms-new' };
  c.reconcileSubtasks_(s, snap, options(c));
  assert.ok(order.indexOf('recovery') < order.indexOf('observe'), 'recovery index < first deletion observation');
  assert.ok(order.indexOf('recovery') < order.indexOf('execute-deletes'), 'recovery precedes eligible delete execution');
  assert.equal(store.items['ms-old'], undefined, 'old item removed by the move, not by deletion confirmation');
  /* Round 2: the old checklist id is absent from observation.  The two-round
   * deletion confirmation must NOT inherit the absence as user evidence, and
   * the new top-level task must survive untouched. */
  const snap2 = baseSnap();
  snap2.msChecklistItemsByParentId['ms-parent'] = [];
  snap2.msTasksById['ms-new'] = { id: 'ms-new' };
  c.reconcileSubtasks_(s, snap2, Object.assign(options(c), { roundId: 'r2', allowDeletions: true }));
  assert.deepEqual(Object.keys(s.subtasks.pendingDeletions), [], 'no pending deletion for the moved child');
  assert.equal(s.subtasks.moveJournal.child, undefined, 'the move row retired cleanly');
  assert.equal(s.g2m.child.msId, 'ms-new', 'the new pairing is live');
  assert.equal(msTaskDeletes, 0, 'the new top-level task is never deleted');
  assert.equal(gTaskDeletes, 0, 'the Google child is never deleted');
});

/* ------------------------------------------------- fail-closed extras --- */

test('incomplete Google inventory defers every row with zero remote writes', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new' });
  const writes = [];
  c.createMsTask_ = () => { writes.push('create'); };
  c.deleteMsChecklistItemNoRetry_ = () => { writes.push('delete'); };
  const snap = baseSnap();
  snap.inventoryComplete = false;
  snap.googleInventoryComplete = false;
  const r = c.subtaskMoveRecovery_(s, snap, options(c));
  assert.deepEqual(writes, []);
  assert.equal(r.deferred, 1);
  assert.equal(s.subtasks.moveJournal.child.phase, 'REMOTE_CREATED', 'row untouched while the inventory is blind');
});

test('a stale row (Google parent unchanged) defers with zero remote writes', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('REMOTE_CREATED', { nextMsChecklistId: 'ms-new' });
  const writes = [];
  c.deleteMsChecklistItemNoRetry_ = () => { writes.push('delete'); };
  const snap = baseSnap();
  snap.gTasksById.child.parent = 'parent';  // Google side never moved
  const r = c.subtaskMoveRecovery_(s, snap, options(c));
  assert.deepEqual(writes, []);
  assert.equal(r.deferred, 1);
  assert.equal(s.subtasks.moveJournal.child.phase, 'REMOTE_CREATED');
});

test('old-item delete is gated by the operator-wide deletion switch', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.child = row('REBIND_PERSISTED', { nextMsChecklistId: 'ms-new' });
  delete s.subtasks.mappings.child;
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  const snap = baseSnap();
  snap.safety = { enableSubtasks: true };  // allowDeletions absent => off
  const r = c.subtaskMoveRecovery_(s, snap, { enableSubtasks: true, persist() {}, roundId: 'r1' });
  assert.equal(r.paused, 1);
  assert.ok(store.items['ms-old'], 'old item survives while deletions are off');
  assert.equal(s.subtasks.moveJournal.child.phase, 'REBIND_PERSISTED');
  const r2 = c.subtaskMoveRecovery_(s, snap, { enableSubtasks: true, allowDeletions: true, persist() {}, roundId: 'r2' });
  assert.equal(r2.deleted, 1);
  assert.equal(store.items['ms-old'], undefined);
  assert.equal(s.subtasks.moveJournal.child.phase, 'OLD_DELETE_PENDING');
});

test('malformed or foreign move rows are reported and left byte-identical', () => {
  const c = load(); const s = baseState(c);
  s.subtasks.moveJournal.badPhase = { phase: 'BOGUS', gChildId: 'x', msChecklistId: 'y', gParentId: 'p' };
  s.subtasks.moveJournal.missingField = { phase: 'PREPARED', gChildId: 'x', msChecklistId: 'y' };
  s.subtasks.moveJournal.unknownKey = { phase: 'PREPARED', gChildId: 'x', msChecklistId: 'y', gParentId: 'p', foo: 1 };
  const guard = () => { throw new Error('malformed rows must not write'); };
  c.createMsTask_ = guard; c.deleteMsChecklistItemNoRetry_ = guard; c.getMsTasks_ = guard;
  const before = JSON.stringify(s.subtasks.moveJournal);
  const r = c.subtaskMoveRecovery_(s, baseSnap(), options(c));
  assert.equal(r.blocked, 3);
  assert.equal(JSON.stringify(s.subtasks.moveJournal), before, 'rows untouched');
});

test('unnest finalize releases a residual mapping before writing g2m (ownership cross-check)', () => {
  const c = load(); const s = baseState(c);
  /* A writer that jumped straight to OLD_DELETE_PENDING without the rebind
   * persist leaves the mapping in place; finalize must still complete in ONE
   * persist without ever leaving row.gChildId overlapping state.g2m. */
  s.subtasks.moveJournal.child = row('OLD_DELETE_PENDING', { nextMsChecklistId: 'ms-new' });
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  const snap = baseSnap(); snap.msChecklistItemsByParentId['ms-parent'] = [];
  c.subtaskMoveRecovery_(s, snap, options(c));
  assert.equal(s.subtasks.moveJournal.child, undefined, 'row retired');
  assert.equal(s.subtasks.mappings.child, undefined, 'residual mapping released in the same persist');
  assert.deepEqual(JSON.parse(JSON.stringify(s.g2m.child)), { msId: 'ms-new', gListId: 'g-list', msListId: 'ms-list' });
  assert.equal(Object.keys(s.subtasks.tombstones.ms).length, 1, 'old checklist id tombstoned');
});

test('repeated resumes on the same journal state are idempotent (store-backed)', () => {
  const c = load(); const s = baseState(c);
  delete s.subtasks.mappings.child;
  s.subtasks.moveJournal.child = row('REBIND_PERSISTED', { nextMsChecklistId: 'ms-new' });
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  const snap = baseSnap();
  snap.msTasksById['ms-new'] = { id: 'ms-new' };
  c.subtaskMoveRecovery_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
  const midPhase = s.subtasks.moveJournal.child.phase;
  assert.equal(midPhase, 'OLD_DELETE_PENDING');
  /* Same stale snapshot twice: the re-verification delete 404s and is absorbed. */
  c.subtaskMoveRecovery_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
  const snap2 = baseSnap(); snap2.msChecklistItemsByParentId['ms-parent'] = [];
  snap2.msTasksById['ms-new'] = { id: 'ms-new' };
  c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
  c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
  assert.equal(Object.keys(store.items).length, 0, 'exactly one real deletion happened');
  assert.equal(s.subtasks.moveJournal.child, undefined);
  assert.equal(s.g2m.child.msId, 'ms-new');
  const r3 = c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
  assert.equal(r3.total, 0, 'retired rows stay retired');
});

/* ------------------------------------- REPARENT PREPARED create leg --- */

/* A reparent snapshot: the Google child now lives under 'parent2' (MS parent
 * 'ms-parent2' in list 'ms-list2') and carries no notes/due. */
function reparentSnap(childOverrides) {
  const snap = baseSnap();
  snap.gTasksById.child = Object.assign(
    { id: 'child', title: 'Child', status: 'needsAction', parent: 'parent2', notes: '', due: '' },
    childOverrides || {}
  );
  snap.msChecklistItemsByParentId['ms-parent2'] = [];
  snap.msTaskInventoryListIds['ms-list2'] = true;
  return snap;
}

test('REPARENT PREPARED resume completes the create leg (0-match proven absence)', () => {
  const c = load(); const s = parent2State(c);
  s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
  const posts = [];
  c.createMsChecklistItemNoRetry_ = (listId, parentId, displayName, isChecked) => {
    posts.push({ listId, parentId, displayName, isChecked }); return { id: 'ms-new2' };
  };
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  const snap = reparentSnap();
  const r1 = c.subtaskMoveRecovery_(s, snap, options(c));
  assert.equal(posts.length, 1, 'zero exact matches proves the POST never landed: create exactly once');
  assert.deepEqual(posts[0], { listId: 'ms-list2', parentId: 'ms-parent2', displayName: 'Child', isChecked: false });
  assert.equal(r1.created, 1);
  assert.equal(s.subtasks.moveJournal.child.phase, 'OLD_DELETE_PENDING', 'same-round advance through rebind and gated old delete');
  assert.equal(s.subtasks.moveJournal.child.nextMsChecklistId, 'ms-new2');
  /* Replay idempotency: re-running the executor on the same stale snapshot
   * re-verifies the old delete (404 absorbed) but never re-POSTs. */
  const r2 = c.subtaskMoveRecovery_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
  assert.equal(posts.length, 1, 'replay never re-POSTs');
  assert.deepEqual(store.list(), [], 'the old item is deleted exactly once (store-backed)');
  assert.equal(r2.deferred, 0, 'the re-verification 404 is absorbed as crash-safe success, not deferred');
  /* Fresh observation: new item present, old item gone -> row retires. */
  const snap2 = JSON.parse(JSON.stringify(snap));
  snap2.msChecklistItemsByParentId['ms-parent'] = [];
  snap2.msChecklistItemsByParentId['ms-parent2'] = [{ id: 'ms-new2', displayName: 'Child', isChecked: false }];
  c.subtaskMoveRecovery_(s, snap2, Object.assign(options(c), { roundId: 'r2' }));
  assert.equal(s.subtasks.moveJournal.child, undefined, 'row retires');
  const m = s.subtasks.mappings.child;
  assert.ok(m, 'reparent keeps a checklist mapping');
  assert.equal(m.msChecklistId, 'ms-new2');
  assert.equal(m.gParentId, 'parent2');
  assert.deepEqual(JSON.parse(JSON.stringify(m.base)), { title: 'Child', completed: false }, 'base carries over unchanged');
  assert.equal(s.g2m.child, undefined, 'a reparented child never becomes an ordinary pair');
});

test('REPARENT PREPARED resume: any exact-title match parks UNCERTAIN with zero writes', () => {
  /* 1 match: our orphan vs a pre-existing user item is indistinguishable. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
    const writes = [];
    c.createMsChecklistItemNoRetry_ = (listId, parentId, displayName) => { writes.push('post:' + displayName); return { id: 'x' }; };
    c.deleteMsChecklistItemNoRetry_ = () => { writes.push('delete'); return {}; };
    const snap = reparentSnap();
    snap.msChecklistItemsByParentId['ms-parent2'] = [{ id: 'ms-user', displayName: 'Child', isChecked: false }];
    const r = c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(r.uncertain, 1);
    assert.deepEqual(writes, [], 'an ambiguous row performs zero remote writes (no POST, no delete)');
    assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN');
    assert.equal(s.subtasks.moveJournal.child.title, 'Child', 'the row is parked intact, never dropped');
    assert.equal(s.subtasks.moveJournal.child.nextMsChecklistId, undefined, 'never adopt blindly');
  }
  /* 2+ matches: equally ambiguous. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
    const writes = [];
    c.createMsChecklistItemNoRetry_ = () => { writes.push('post'); return { id: 'x' }; };
    c.deleteMsChecklistItemNoRetry_ = () => { writes.push('delete'); return {}; };
    const snap = reparentSnap();
    snap.msChecklistItemsByParentId['ms-parent2'] = [
      { id: 'ms-user', displayName: 'Child', isChecked: false },
      { id: 'ms-user2', displayName: 'Child', isChecked: true }
    ];
    const r = c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(r.uncertain, 1);
    assert.deepEqual(writes, [], 'two title twins are ambiguous too: zero remote writes');
    assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN');
  }
  /* A near-match (different title) does NOT block the create leg. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
    const posts = [];
    c.createMsChecklistItemNoRetry_ = (l, p, displayName) => { posts.push(displayName); return { id: 'ms-new2' }; };
    const snap = reparentSnap();
    snap.msChecklistItemsByParentId['ms-parent2'] = [{ id: 'ms-other', displayName: 'Child 2', isChecked: false }];
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.deepEqual(posts, ['Child'], 'only an EXACT title match is ambiguity evidence');
  }
});

test('REPARENT PREPARED resume without the journaled title parks UNCERTAIN (wiring gap)', () => {
  const c = load(); const s = parent2State(c);
  s.subtasks.moveJournal.child = row('PREPARED');  // frozen 5-field row: no title
  const guard = () => { throw new Error('an uncorrelatable row must not write remotely'); };
  c.createMsChecklistItemNoRetry_ = guard; c.deleteMsChecklistItemNoRetry_ = guard;
  const snap = reparentSnap();
  const r = c.subtaskMoveRecovery_(s, snap, options(c));
  assert.equal(r.uncertain, 1);
  assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN');
  assert.equal(s.subtasks.moveJournal.child.nextMsChecklistId, undefined);
});

test('REPARENT PREPARED create leg: ambiguous POST outcome parks, blind round defers', () => {
  /* POST throws: the outcome (landed or not) is unknowable -> park, never retry. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
    c.createMsChecklistItemNoRetry_ = () => { throw new Error('HTTP 500: Internal Server Error'); };
    const snap = reparentSnap();
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(s.subtasks.moveJournal.child.phase, 'UNCERTAIN', 'a thrown POST is an ambiguous outcome');
    assert.equal(s.subtasks.moveJournal.child.nextMsChecklistId, undefined);
  }
  /* New-parent checklist observation incomplete: defer with zero writes. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
    c.createMsChecklistItemNoRetry_ = () => { throw new Error('a blind round must not write'); };
    const snap = reparentSnap();
    delete snap.msChecklistItemsByParentId['ms-parent2'];  // observation not complete
    const r = c.subtaskMoveRecovery_(s, snap, options(c));
    assert.equal(r.deferred, 1);
    assert.equal(s.subtasks.moveJournal.child.phase, 'PREPARED', 'the row stays resumable');
  }
});

test('REPARENT PREPARED create leg keeps the journaled title as the correlation key', () => {
  /* Rename between crash and recovery: the scan key AND the POST title stay
   * the JOURNALED title (exactly what the writer's POST carried), so a second
   * crash before the REMOTE_CREATED persist re-finds our orphan as 1 match
   * (park) instead of re-POSTing a duplicate.  The ordinary title sync
   * reconciles the rename afterwards. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Old' });
    const posts = [];
    c.createMsChecklistItemNoRetry_ = (l, p, displayName) => { posts.push(displayName); return { id: 'ms-new2' }; };
    const snap = reparentSnap({ title: 'New' });
    snap.msChecklistItemsByParentId['ms-parent'] = [{ id: 'ms-old', displayName: 'Old', isChecked: false }];
    snap.msChecklistItemsByParentId['ms-parent2'] = [{ id: 'ms-other', displayName: 'Unrelated', isChecked: false }];
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.deepEqual(posts, ['Old'], 'the POST reuses the journaled title, not the current Google title');
  }
  /* completed comes from the Google child in the same-round snapshot. */
  {
    const c = load(); const s = parent2State(c);
    s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
    const checks = [];
    c.createMsChecklistItemNoRetry_ = (l, p, d, isChecked) => { checks.push(isChecked); return { id: 'ms-new2' }; };
    const snap = reparentSnap({ status: 'completed' });
    c.subtaskMoveRecovery_(s, snap, options(c));
    assert.deepEqual(checks, [true], 'isChecked projects the Google child completed state');
  }
  /* A non-string title is a malformed row: blocked, byte-identical. */
  {
    const c = load(); const s = baseState(c);
    s.subtasks.moveJournal.badTitle = { phase: 'PREPARED', gChildId: 'x', msChecklistId: 'y', gParentId: 'p', title: 42 };
    const guard = () => { throw new Error('malformed rows must not write'); };
    c.createMsTask_ = guard; c.createMsChecklistItemNoRetry_ = guard; c.getMsTasks_ = guard;
    const before = JSON.stringify(s.subtasks.moveJournal);
    const r = c.subtaskMoveRecovery_(s, baseSnap(), options(c));
    assert.equal(r.blocked, 1);
    assert.equal(JSON.stringify(s.subtasks.moveJournal), before, 'rows untouched');
  }
});

test('S9 reparent regression: PREPARED create leg runs before deletion observation', () => {
  const c = load(); const s = parent2State(c);
  s.subtasks.moveJournal.child = row('PREPARED', { title: 'Child' });
  const store = checklistStore([{ id: 'ms-old', displayName: 'Child', isChecked: false }]); store.mock(c);
  c.getMsTasks_ = () => [];
  c.createMsChecklistItemNoRetry_ = (listId, parentId, displayName, isChecked) => ({ id: 'ms-new2' });
  let msTaskDeletes = 0, gTaskDeletes = 0;
  c.deleteMsTask_ = () => { msTaskDeletes += 1; return {}; };
  c.deleteGTask_ = () => { gTaskDeletes += 1; return {}; };
  const order = [];
  const realRecovery = c.subtaskMoveRecovery_;
  const realObserve = c.subtaskObserveDeletionEvidence_;
  c.subtaskMoveRecovery_ = function(st, sn, op) { order.push('recovery'); return realRecovery(st, sn, op); };
  c.subtaskObserveDeletionEvidence_ = function(st, sn, op) { order.push('observe'); return realObserve(st, sn, op); };
  const snap = reparentSnap();
  c.reconcileSubtasks_(s, snap, Object.assign(options(c), { roundId: 'r1' }));
  assert.ok(order.indexOf('recovery') >= 0 && order.indexOf('recovery') < order.indexOf('observe'),
    'recovery precedes deletion observation');
  assert.deepEqual(Object.keys(s.subtasks.pendingDeletions), [], 'no deletion evidence is inherited from the move');
  assert.equal(s.subtasks.mappings.child.msChecklistId, 'ms-new2', 'mapping rebound to the created id in the same round');
  assert.equal(store.items['ms-old'], undefined, 'old item removed by the move, not by deletion confirmation');
  assert.equal(msTaskDeletes, 0, 'the MS parent is never deleted');
  assert.equal(gTaskDeletes, 0, 'the Google child is never deleted');
});
