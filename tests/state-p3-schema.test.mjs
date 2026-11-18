import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

// Lead-owned schema tests for the two P3 additions: the top-level
// recurrenceAdvancement table and the rec.nfp notes-diff3 fingerprint.
// Contract: persist -> load -> normalize round trips must not throw and must
// preserve the new fields; invalid shapes must fail closed with
// STATE_MALFORMED.  Without these registrations a knob-enabled round would
// throw STATE_MALFORMED on the next reload (save path does not validate).

function load() {
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Utilities: { sleep() {} }
  });
  runGasFilesInContext(c);
  return c;
}

function waitRecord(overrides) {
  return Object.assign({
    phase: 'WAIT_EVIDENCE',
    reason: 'NO_ECHO_INSTANCE',
    openedAt: '2026-11-18T00:30:00.000Z',
    lastRoundId: 'round-1',
    roundsWaited: 1,
    expectedDue: '2030-06-15',
    pendingBind: null,
    closedAt: null
  }, overrides || {});
}

function conflictRecord(overrides) {
  return Object.assign({
    at: '2026-11-18T00:35:00.000Z',
    kind: 'RECURRENCE_ADVANCE_TIMEOUT',
    reason: 'WAIT_TIMEOUT',
    roundsWaited: 3,
    msId: 'ms-task-1',
    gListId: 'g-list',
    msListId: 'ms-list'
  }, overrides || {});
}

function stateWithExtras(c) {
  const state = c.newState_();
  state.g2m['g-task-1'] = {
    msId: 'ms-task-1', gListId: 'g-list', msListId: 'ms-list',
    nfp: 'a'.repeat(32)
  };
  state.m2g['ms-task-1'] = 'g-task-1';
  state.recurrenceAdvancement = {
    waits: { 'g-task-1': waitRecord() },
    conflicts: { 'g-task-2': conflictRecord({ kind: 'RECURRENCE_ADVANCE_AMBIGUOUS', roundsWaited: undefined, candidateCount: 2 }) }
  };
  return state;
}

test('normalizeState_ preserves recurrenceAdvancement and rec.nfp across three rounds', () => {
  const c = load();
  let state = stateWithExtras(c);
  for (let round = 0; round < 3; round++) {
    state = c.normalizeState_(state);
  }
  assert.equal(state.schema, 4);
  assert.equal(state.g2m['g-task-1'].nfp, 'a'.repeat(32), 'nfp must survive normalize');
  assert.equal(state.recurrenceAdvancement.waits['g-task-1'].phase, 'WAIT_EVIDENCE');
  assert.equal(state.recurrenceAdvancement.waits['g-task-1'].roundsWaited, 1);
  assert.equal(state.recurrenceAdvancement.waits['g-task-1'].expectedDue, '2030-06-15');
  assert.equal(state.recurrenceAdvancement.conflicts['g-task-2'].kind, 'RECURRENCE_ADVANCE_AMBIGUOUS');
  assert.equal(state.recurrenceAdvancement.conflicts['g-task-2'].candidateCount, 2);
});

test('normalizeState_ leaves recurrenceAdvancement undefined on a state that never carried it', () => {
  const c = load();
  let state = c.newState_();
  for (let round = 0; round < 3; round++) {
    state = c.normalizeState_(state);
  }
  assert.equal(state.recurrenceAdvancement, undefined,
    'no default construction: the sweep self-heals the table only when the knob is on');
});

test('unknown keys inside waits/conflicts records fail closed', () => {
  const c = load();
  const state = stateWithExtras(c);
  state.recurrenceAdvancement.waits['g-task-1'].oops = true;
  assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED/,
    'an unknown wait-record key must be refused, not silently carried');
});

test('invalid phase in a wait record fails closed', () => {
  const c = load();
  const state = stateWithExtras(c);
  state.recurrenceAdvancement.waits['g-task-1'].phase = 'prepared';
  assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED/);
});

test('invalid rec.nfp fails closed', () => {
  const c = load();
  const state = stateWithExtras(c);
  state.g2m['g-task-1'].nfp = 'not-hex';
  assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED/);
});

test('negative roundsWaited in a conflict record fails closed', () => {
  const c = load();
  const state = stateWithExtras(c);
  state.recurrenceAdvancement.conflicts['g-task-2'].candidateCount = -1;
  assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED/);
});
