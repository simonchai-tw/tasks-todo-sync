import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

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

function state(c) {
  const s = c.newState_();
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  return s;
}

test('canonical title is trim-only and empty titles fail closed', () => {
  const c = load();
  assert.equal(c.subtaskCanonicalTitle_('  Café  '), 'Café');
  assert.equal(c.subtaskCanonicalTitle_(''), null);
  assert.equal(c.subtaskCanonicalTitle_(' \u0301 '), '\u0301');
  assert.equal(c.subtaskCanonicalTitle_(null), null);
  assert.equal(c.subtaskCanonicalTitle_(undefined), null);
  assert.equal(c.subtaskCanonicalGoogle_({ title: ' ', status: 'needsAction' }), null);
});

test('feature OFF performs no checklist scheduling or writes and retains journals', () => {
  const c = load(); const s = state(c); let calls = 0;
  s.subtasks.createJournal.pending = { phase: 'UNCERTAIN', gChildId: 'child', gParentId: 'parent', intended: { title: 'x', completed: false } };
  c.createMsChecklistItemNoRetry_ = () => { calls += 1; return { id: 'never' }; };
  const out = c.reconcileSubtasks_(s, { safety: { enableSubtasks: false }, gTasksById: {} }, { enableSubtasks: false, persist() { calls += 1; } });
  assert.equal(out.writes, 0); assert.equal(calls, 0); assert.equal(s.subtasks.createJournal.pending.phase, 'UNCERTAIN');
});

test('per-field three-way merge matrix is independent', () => {
  const c = load();
  assert.equal(c.subtaskThreeWayField_('a', 'a', 'a').action, 'NOOP');
  assert.equal(c.subtaskThreeWayField_('a', 'b', 'a').action, 'ONE_SIDE');
  assert.equal(c.subtaskThreeWayField_('a', 'b', 'b').action, 'ADVANCE_BASE');
  assert.equal(c.subtaskThreeWayField_('a', 'b', 'c').action, 'CONFLICT');
});

test('Google child create uses exact checklist body and crash-safe journal phases', () => {
  const c = load(); const s = state(c); const calls = []; let saves = 0;
  c.subtaskPersist_ = () => { saves += 1; };
  c.createMsChecklistItemNoRetry_ = (list, parent, title, checked) => { calls.push({ list, parent, title, checked }); return { id: 'check-1', displayName: title, isChecked: checked }; };
  const result = c.subtaskCreateGoogleToMicrosoft_(s, {}, { id: 'g-child', title: '  Child  ', status: 'completed' }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist: () => { saves += 1; } });
  assert.equal(result.created, true); assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { list: 'ms-list', parent: 'ms-parent', title: 'Child', checked: true });
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings['g-child'].base)), { title: 'Child', completed: true });
  assert.equal(Object.keys(s.subtasks.createJournal).length, 0); assert.equal(saves, 3);
});

test('Microsoft checklist create uses parent query and no previous/notes/due fields', () => {
  const c = load(); const s = state(c); const calls = [];
  c.createGChecklistChildNoRetry_ = (list, parent, title, status) => { calls.push({ list, parent, title, status }); return { id: 'g-child', title, status }; };
  const result = c.subtaskCreateMicrosoftToGoogle_(s, {}, { id: 'check-1', displayName: '  Item  ', isChecked: false }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} });
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { list: 'g-list', parent: 'parent', title: 'Item', status: 'needsAction' });
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings['g-child'].base)), { title: 'Item', completed: false });
});

test('acknowledged create ID with wrong projection or parent stays REMOTE_CREATED and never maps', () => {
  const c = load();
  for (const response of [
    { id: 'check-bad-title', displayName: 'Different', isChecked: true },
    { id: 'check-bad-parent', displayName: 'Child', isChecked: true, parentId: 'other-parent' }
  ]) {
    const s = state(c); let posts = 0;
    c.createMsChecklistItemNoRetry_ = () => { posts += 1; return response; };
    const out = c.subtaskCreateGoogleToMicrosoft_(s, {}, { id: 'g-child', title: 'Child', status: 'completed' }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} });
    assert.equal(out.created, undefined); assert.equal(posts, 1);
    const row = s.subtasks.createJournal['g:g-child'];
    assert.equal(row.phase, 'REMOTE_CREATED'); assert.equal(row.msChecklistId, response.id);
    assert.equal(s.subtasks.mappings['g-child'], undefined);
    assert.ok(s.subtasks.conflicts['g:g-child']);
    c.subtaskCreateGoogleToMicrosoft_(s, {}, { id: 'g-child', title: 'Child', status: 'completed' }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} });
    assert.equal(posts, 1);
  }
  assert.equal(c.subtaskCanonicalGoogle_({ title: 'x', status: 'bogus' }), null);
});

test('create final persist failure restores REMOTE_CREATED journal and prevents repost', () => {
  const c = load(); const s = state(c); let saves = 0; let posts = 0;
  c.createMsChecklistItemNoRetry_ = () => { posts += 1; return { id: 'check-1', displayName: 'Child', isChecked: true }; };
  const persist = () => { saves += 1; if (saves === 3) throw new Error('final commit failed'); };
  const first = c.subtaskCreateGoogleToMicrosoft_(s, {}, { id: 'g-child', title: 'Child', status: 'completed' }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist });
  assert.equal(first.created, undefined); assert.equal(posts, 1); assert.equal(s.subtasks.mappings['g-child'], undefined);
  assert.equal(s.subtasks.createJournal['g:g-child'].phase, 'REMOTE_CREATED');
  c.subtaskCreateGoogleToMicrosoft_(s, {}, { id: 'g-child', title: 'Child', status: 'completed' }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} });
  assert.equal(posts, 1);
});

test('persisted PREPARED create becomes UNCERTAIN on restart and never reposts', () => {
  const c = load(); const s = state(c); let calls = 0;
  c.subtaskPrepareCreate_(s, { key: 'g:g-child', gChildId: 'g-child', gParentId: 'parent', parentMsId: 'ms-parent', parentMsListId: 'ms-list', intended: { title: 'Child', completed: false } }, { persist() {} });
  c.createMsChecklistItemNoRetry_ = () => { calls += 1; throw new Error('must not post'); };
  const out = c.reconcileSubtasks_(s, { safety: { enableSubtasks: true }, gTasksById: {}, msChecklistItemsByParentId: {} }, { persist() {} });
  assert.equal(calls, 0); assert.equal(out.writes, 0); assert.equal(s.subtasks.createJournal['g:g-child'].phase, 'UNCERTAIN');
});

test('mapped updates require complete observation and send one-field exact patches', () => {
  const c = load(); const s = state(c); const m = s.subtasks.mappings.child = { gParentId: 'parent', msChecklistId: 'check', parentMsId: 'ms-parent', parentMsListId: 'ms-list', base: { title: 'Old', completed: false } };
  const calls = []; c.updateMsChecklistItemNoRetry_ = (...args) => { calls.push(args); return { displayName: 'New' }; };
  const snap = { gListByTask: { child: 'g-list' }, gTasksById: { child: { id: 'child', parent: 'parent', title: 'New', status: 'needsAction' } }, msChecklistItemsByParentId: { 'ms-parent': [{ id: 'check', displayName: 'Old', isChecked: false }] } };
  assert.equal(c.subtaskUpdateMapped_(s, snap, 'child', m, snap.gTasksById.child, snap.msChecklistItemsByParentId['ms-parent'][0], { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} }).writes, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['ms-list', 'ms-parent', 'check', { displayName: 'New' }]);
  assert.equal(c.subtaskUpdateMapped_(s, { ...snap, msChecklistItemsByParentId: {} }, 'child', m, snap.gTasksById.child, null, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} }).writes, undefined);
});

test('update projection mismatch is UNCERTAIN, preserves BASE, and permits one PATCH only', () => {
  const c = load(); const s = state(c); const m = s.subtasks.mappings.child = { gParentId: 'parent', msChecklistId: 'check', base: { title: 'Old', completed: false } };
  const calls = []; c.updateMsChecklistItemNoRetry_ = (...args) => { calls.push(args); return { displayName: 'Wrong' }; };
  const snap = { gListByTask: { child: 'g-list' }, gTasksById: { child: { id: 'child', parent: 'parent', title: 'New', status: 'completed' } } };
  const ms = { id: 'check', displayName: 'Old', isChecked: false };
  const result = c.subtaskUpdateMapped_(s, snap, 'child', m, snap.gTasksById.child, ms, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} });
  assert.equal(result.writes, 0); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(m.base)), { title: 'Old', completed: false });
  assert.equal(s.subtasks.createJournal['u:child:title'].phase, 'UNCERTAIN'); assert.equal(s.subtasks.createJournal['u:child:completed'], undefined);
});

test('final PATCH commit failure reconstructs UNCERTAIN intent without dereference or BASE advance', () => {
  const c = load(); const s = state(c); const m = s.subtasks.mappings.child = { gParentId: 'parent', msChecklistId: 'check', base: { title: 'Old', completed: false } };
  let saves = 0; c.updateMsChecklistItemNoRetry_ = () => ({ displayName: 'New' });
  const persist = () => { saves += 1; if (saves === 2) throw new Error('final save failed'); };
  const snap = { gListByTask: { child: 'g-list' }, gTasksById: { child: { id: 'child', parent: 'parent', title: 'New', status: 'needsAction' } } };
  const ms = { id: 'check', displayName: 'Old', isChecked: false };
  assert.doesNotThrow(() => c.subtaskUpdateMapped_(s, snap, 'child', m, snap.gTasksById.child, ms, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist }));
  assert.deepEqual(JSON.parse(JSON.stringify(m.base)), { title: 'Old', completed: false });
  assert.equal(s.subtasks.createJournal['u:child:title'].phase, 'UNCERTAIN');
});

test('structural mismatch quarantines without mutating BASE', () => {
  const c = load(); const s = state(c); const m = s.subtasks.mappings.child = { gParentId: 'parent', msChecklistId: 'check', base: { title: 'Old', completed: false } };
  const before = JSON.stringify(m.base);
  const snap = { gListByTask: { child: 'g-list' } };
  const out = c.subtaskUpdateMapped_(s, snap, 'child', m, { id: 'child', parent: 'other', title: 'New', status: 'completed' }, { id: 'check', displayName: 'New', isChecked: true }, { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' }, { persist() {} });
  assert.equal(out.quarantined, true); assert.equal(JSON.stringify(m.base), before); assert.equal(s.subtasks.conflicts.child.reason, 'SUBTASK_STRUCTURAL_QUARANTINE');
});

test('ambiguous update resolves only from a complete fresh observation', () => {
  const c = load(); const s = state(c);
  s.subtasks.mappings.child = { gParentId: 'parent', msChecklistId: 'check', parentMsId: 'ms-parent', base: { title: 'Old', completed: false } };
  s.subtasks.createJournal['u:child:title'] = { phase: 'UNCERTAIN', gChildId: 'child', msChecklistId: 'check', gParentId: 'parent', parentMsId: 'ms-parent', field: 'title', base: 'Old', source: 'GOOGLE', target: 'Old', desired: 'New', at: 't' };
  const snap = { gTasksById: { child: { id: 'child', parent: 'parent', title: 'New', status: 'needsAction' } }, msChecklistItemsByParentId: { 'ms-parent': [{ id: 'check', displayName: 'New', isChecked: false }] } };
  const out = c.subtaskRecoverUpdateIntents_(s, snap, { persist() {} });
  assert.equal(out.resolved, 1); assert.equal(s.subtasks.createJournal['u:child:title'], undefined); assert.equal(s.subtasks.mappings.child.base.title, 'New');
});

test('subtask create skips empty or blank titles in both directions without writing createJournal', () => {
  const c = load();
  const s = state(c);
  const parent = { gParentId: 'parent', msParentId: 'ms-parent', msListId: 'ms-list', gListId: 'g-list' };

  // Google to Microsoft with blank title
  const gOut = c.subtaskCreateGoogleToMicrosoft_(s, {}, { id: 'g-empty', title: '   ', status: 'needsAction' }, parent, { persist() {} });
  assert.equal(gOut.skipped, 'EMPTY_TITLE');
  assert.equal(s.subtasks.createJournal['g:g-empty'], undefined);

  // Microsoft to Google with blank title
  const msOut = c.subtaskCreateMicrosoftToGoogle_(s, {}, { id: 'ms-empty', displayName: '   ', isChecked: false }, parent, { persist() {} });
  assert.equal(msOut.skipped, 'EMPTY_TITLE');
  assert.equal(s.subtasks.createJournal['ms:ms-empty'], undefined);
});

