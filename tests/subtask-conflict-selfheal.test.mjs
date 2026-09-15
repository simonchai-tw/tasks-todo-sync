import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

/* Spec §32 (subtask half): a conflicted child is still observed each round, and
 * when both providers have re-converged to identical canonical state the
 * conflict auto-resolves, the baseline advances, and deletion evidence resets
 * (§31).  A true divergence keeps the conflict frozen with ZERO remote writes
 * (§29): the engine never picks a winner. */

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

function scenario(c, { conflictReason = 'SUBTASK_TITLE_CONFLICT', conflictChecklistId = 'check-1' } = {}) {
  const s = c.newState_();
  s.listMap = { 'g-list': 'ms-list' };
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.mappings['g-child'] = {
    gParentId: 'parent', parentMsId: 'ms-parent', msChecklistId: 'check-1',
    base: { title: 'Old', completed: false }
  };
  s.subtasks.conflicts['g-child'] = {
    gChildId: 'g-child', msChecklistId: conflictChecklistId, gParentId: 'parent',
    reason: conflictReason, at: '2026-09-13T00:00:00.000Z'
  };
  return s;
}

function snapFor({ childTitle, childStatus = 'needsAction', msTitle, msChecked = false, observeComplete = true }) {
  return {
    safety: { enableSubtasks: true },
    gTasksById: {
      parent: { id: 'parent', title: 'Parent', status: 'needsAction' },
      'g-child': { id: 'g-child', parent: 'parent', title: childTitle, status: childStatus }
    },
    gListByTask: { parent: 'g-list', 'g-child': 'g-list' },
    msListByTask: { 'ms-parent': 'ms-list' },
    msChecklistItemsByParentId: { 'ms-parent': [{ id: 'check-1', displayName: msTitle, isChecked: msChecked }] },
    checklistObservationCompleteByParentId: observeComplete ? {} : { 'ms-parent': false }
  };
}

test('both sides re-aligned by hand: the conflict auto-resolves, the baseline advances, nothing is written', () => {
  const c = load();
  const s = scenario(c);
  let patches = 0;
  c.updateMsChecklistItemNoRetry_ = () => { patches += 1; return {}; };
  c.updateGChecklistChildNoRetry_ = () => { patches += 1; return {}; };

  const out = c.reconcileSubtasks_(s, snapFor({ childTitle: 'Aligned', msTitle: 'Aligned' }), { enableSubtasks: true, persist() {} });
  assert.equal(patches, 0, 'a heal is a state clear, never a remote write');
  assert.equal(out.writes, 0);
  assert.equal(s.subtasks.conflicts['g-child'], undefined, 'the conflict record is cleared');
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings['g-child'].base)),
    { title: 'Aligned', completed: false }, 'the baseline advances to the converged meaning');
  assert.equal(s.subtasks.pendingDeletions['g-child'], undefined, 'deletion evidence is reset with the conflict');
});

test('a true divergence keeps the conflict frozen with zero writes', () => {
  const c = load();
  const s = scenario(c);
  let patches = 0;
  c.updateMsChecklistItemNoRetry_ = () => { patches += 1; return {}; };
  c.updateGChecklistChildNoRetry_ = () => { patches += 1; return {}; };

  c.reconcileSubtasks_(s, snapFor({ childTitle: 'Google Side', msTitle: 'Microsoft Side' }), { enableSubtasks: true, persist() {} });
  assert.equal(patches, 0, 'the engine never picks a winner');
  assert.ok(s.subtasks.conflicts['g-child'], 'the conflict stays');
  assert.equal(s.subtasks.mappings['g-child'].base.title, 'Old', 'the baseline does not move on a divergence');
});

test('an incomplete observation never proves convergence (fail-closed)', () => {
  const c = load();
  const s = scenario(c);
  let patches = 0;
  c.updateMsChecklistItemNoRetry_ = () => { patches += 1; return {}; };
  c.updateGChecklistChildNoRetry_ = () => { patches += 1; return {}; };

  c.reconcileSubtasks_(s, snapFor({ childTitle: 'Aligned', msTitle: 'Aligned', observeComplete: false }), { enableSubtasks: true, persist() {} });
  assert.equal(patches, 0);
  assert.ok(s.subtasks.conflicts['g-child'], 'unobserved is never treated as aligned');
  assert.equal(s.subtasks.mappings['g-child'].base.title, 'Old');
});

test('an operator ABANDONED pair is not un-excluded by the heal', () => {
  const c = load();
  const s = scenario(c, { conflictReason: 'SUBTASK_ABANDONED' });
  c.reconcileSubtasks_(s, snapFor({ childTitle: 'Aligned', msTitle: 'Aligned' }), { enableSubtasks: true, persist() {} });
  assert.ok(s.subtasks.conflicts['g-child'], 'the operator exclusion stays');
  assert.equal(s.subtasks.mappings['g-child'].base.title, 'Old');
});

test('a stale pendingDeletion is cleared together with the healed conflict (§31 linkage)', () => {
  const c = load();
  const s = scenario(c);
  s.subtasks.pendingDeletions['g-child'] = {
    gChildId: 'g-child', missingSide: 'MICROSOFT', confirmations: 1,
    survivorSemanticBaseline: 'Old', firstSeenRoundId: 'r1'
  };
  c.reconcileSubtasks_(s, snapFor({ childTitle: 'Aligned', msTitle: 'Aligned' }), { enableSubtasks: true, persist() {} });
  assert.equal(s.subtasks.conflicts['g-child'], undefined);
  assert.equal(s.subtasks.pendingDeletions['g-child'], undefined,
    'resetting the conflict also resets the frozen deletion evidence');
});

test('structural quarantine and parent loss stay manual even when values converge', () => {
  const c = load();
  const s = scenario(c, { conflictReason: 'SUBTASK_STRUCTURAL_QUARANTINE' });
  c.reconcileSubtasks_(s, snapFor({ childTitle: 'Aligned', msTitle: 'Aligned' }), { enableSubtasks: true, persist() {} });
  assert.ok(s.subtasks.conflicts['g-child'], 'a structural mismatch is not healable by value equality');
});
