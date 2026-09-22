import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* W1c coverage: a refused provider mutation must leave a durable, bounded hold
 * so the identical payload is not repeated every round, recovery must come from
 * a changed payload or an explicit operator abandonment, and abandonment must
 * delete nothing remotely. */

function blob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

function load() {
  const script = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; } };
  const user = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; } };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    Session: { getScriptTimeZone: () => 'UTC' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      newBlob: blob,
      gzip: (b) => blob(gzipSync(Buffer.from(b.getBytes()))),
      ungzip: (b) => blob(gunzipSync(Buffer.from(b.getBytes()))),
      base64Encode: (d) => Buffer.from(typeof d === 'string' ? d : d).toString('base64'),
      base64Decode: (d) => Array.from(Buffer.from(d, 'base64')),
      computeDigest: (_a, d) => Array.from(createHash('sha256').update(d, 'utf8').digest()),
      formatDate: () => '2026-08-21',
      sleep() {}
    }
  });
  runGasFilesInContext(c);
  c.console = { log() {}, warn() {}, error() {} };
  return c;
}

function mkState(c) {
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g['ms-task'] = 'g-task';
  return state;
}

function mkSnap(msTitle, gNotes = '') {
  return {
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    inventoryComplete: true,
    safety: { allowDeletions: true, allowTaskMoves: false, absenceProbe: false },
    gTasksById: { 'g-task': { id: 'g-task', title: 'Same', notes: gNotes, status: 'needsAction', updated: '2026-08-14T00:00:00Z' } },
    msTasksById: {
      'ms-task': {
        id: 'ms-task', title: msTitle,
        body: { contentType: 'text', content: '' },
        status: 'notStarted', lastModifiedDateTime: '2026-08-14T00:00:00Z'
      }
    },
    gListByTask: { 'g-task': 'g-list' },
    msListByTask: { 'ms-task': 'ms-list' }
  };
}

function bootstrap(c, state) {
  c.updateGTask_ = (listId, taskId, payload) => ({ id: taskId, ...payload });
  c.updateMsTask_ = (listId, taskId, payload) => ({ id: taskId, ...payload });
  c.reconcileMapped_(state, mkSnap('Same'), Date.now(), 'bootstrap', {});
}

test('a refused write is recorded durably with bounded, non-content diagnostics', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  const err = new Error('HTTP 400: {"error":{"code":"invalidRequest","message":"no"}}');
  err.httpStatus = 400;
  err.providerCode = 'invalidRequest';
  err.providerMessage = 'no';
  c.updateGTask_ = () => { throw err; };

  c.reconcileMapped_(state, mkSnap('edited-on-microsoft'), Date.now(), 'round-1', {});

  const entry = state.mutationJournal['g-task'];
  assert.ok(entry, 'the refusal must be journaled');
  assert.equal(entry.phase, 'OPEN');
  assert.equal(entry.jv, 1);
  assert.match(entry.payloadFp, /^[0-9a-f]{32}$/, 'only a payload digest is stored');
  assert.equal(entry.httpStatus, 400);
  assert.equal(entry.providerCode, 'invalidRequest');
  assert.equal(entry.attempts, 1);
  assert.equal(entry.partial, null);
  assert.equal(JSON.stringify(entry).includes('edited-on-microsoft'), false, 'never the payload itself');
});

test('the same refused payload is not sent again on the next round', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  let writes = 0;
  c.updateGTask_ = () => { writes += 1; throw new Error('HTTP 400: nope'); };

  c.reconcileMapped_(state, mkSnap('edited-on-microsoft'), Date.now(), 'round-1', {});
  assert.equal(writes, 1, 'the first round attempts the write');

  assert.doesNotThrow(() => c.reconcileMapped_(state, mkSnap('edited-on-microsoft'), Date.now(), 'round-2', {}));
  assert.equal(writes, 1, 'an unchanged intent must not be repeated, and must not abort the round');
  assert.equal(state.mutationJournal['g-task'].attempts, 1, 'no new attempt is counted');
});

test('a changed payload releases the hold and a successful write clears it', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  let writes = 0;
  c.updateGTask_ = (listId, taskId, payload) => {
    writes += 1;
    if (writes === 1) throw new Error('HTTP 400: nope');
    return { id: taskId, ...payload };
  };

  c.reconcileMapped_(state, mkSnap('first-edit'), Date.now(), 'round-1', {});
  assert.ok(state.mutationJournal['g-task'], 'held after the refusal');

  // The user edits the other side again: a different intent is a legitimate retry.
  c.reconcileMapped_(state, mkSnap('second-edit'), Date.now(), 'round-2', {});
  assert.equal(writes, 2, 'a changed payload is attempted once');
  assert.equal(state.mutationJournal['g-task'], undefined, 'a successful write clears the hold');
});

test('a one-sided success is preserved as a partial fact', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  let gWrites = 0;
  let msWrites = 0;
  c.updateGTask_ = (listId, taskId, payload) => { gWrites += 1; return { id: taskId, ...payload }; };
  c.updateMsTask_ = () => { msWrites += 1; throw new Error('HTTP 400: title is required'); };
  // WO-9: the pre-PATCH notes re-read now hits explicit provider stubs; the
  // provider still holds exactly what this round's snapshot read.
  const snap = mkSnap('edited-on-microsoft', 'edited-on-google');
  c.getGTask_ = (listId, taskId) => ({ ...snap.gTasksById[taskId] });
  c.getMsTask_ = (listId, taskId) => ({ ...snap.msTasksById[taskId] });

  // Microsoft's title changed and Google's notes changed, so both sides have a
  // payload: Google is written first, then Microsoft refuses the payload.  A 400
  // is pair-scoped, so the round continues and the partial fact must be recorded.
  assert.doesNotThrow(() => c.reconcileMapped_(
    state, snap, Date.now(), 'round-1', {}
  ));

  const entry = state.mutationJournal['g-task'];
  assert.ok(entry, 'the pair is held');
  assert.equal(gWrites, 1, 'the Google half was applied');
  assert.equal(msWrites, 1, 'the Microsoft half was attempted');
  assert.equal(entry.partial, 'google-applied', 'the applied half must be recorded, not rolled back blindly');
});

test('abandonPair_ excludes the pair, deletes nothing, and leaves the mapping reserved', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  let writes = 0;
  let remoteDeletes = 0;
  c.updateGTask_ = () => { writes += 1; throw new Error('HTTP 400: nope'); };
  c.deleteGTask_ = () => { remoteDeletes += 1; };
  c.deleteMsTask_ = () => { remoteDeletes += 1; };

  c.reconcileMapped_(state, mkSnap('edited-on-microsoft'), Date.now(), 'round-1', {});
  const writesBefore = writes;

  // simulate the operator call against this state
  state.mutationJournal['g-task'] = {
    jv: 1, gId: 'g-task', msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    phase: 'ABANDONED', reason: 'OPERATOR_ABANDONED_PAIR',
    payloadFp: state.mutationJournal['g-task'].payloadFp,
    httpStatus: null, providerCode: null, providerMessage: null,
    attempts: 1, firstFailedAt: null, lastFailedAt: null,
    abandonedAt: new Date().toISOString(), partial: null
  };

  c.reconcileMapped_(state, mkSnap('edited-again'), Date.now(), 'round-2', {});

  assert.equal(writes, writesBefore, 'an abandoned pair is not reconciled at all');
  assert.equal(remoteDeletes, 0, 'abandonment performs no remote delete');
  assert.ok(state.g2m['g-task'], 'the mapping stays, which reserves the exact IDs');
  assert.equal(state.mutationJournal['g-task'].phase, 'ABANDONED', 'abandonment is not overwritten');
});

test('a record from a newer schema is held and never cleared', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  state.mutationJournal['g-task'] = {
    jv: 99, gId: 'g-task', msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    phase: 'OPEN', reason: 'FUTURE', payloadFp: null,
    httpStatus: null, providerCode: null, providerMessage: null,
    attempts: 1, firstFailedAt: null, lastFailedAt: null, abandonedAt: null, partial: null
  };
  let writes = 0;
  c.updateGTask_ = () => { writes += 1; return {}; };

  assert.equal(c.mutationJournalHoldsPayload_(state, 'g-task', 'a'.repeat(32)), true,
    'an unknown newer shape is treated as a hold, not as cleared');
  c.reconcileMapped_(state, mkSnap('edited-on-microsoft'), Date.now(), 'round-1', {});
  assert.equal(writes, 0, 'the held pair is not written');
  assert.ok(state.mutationJournal['g-task'], 'the newer record survives');
});

test('the journal is bounded and a malformed entry is rejected by the validator', () => {
  const c = load();
  const state = mkState(c);

  state.mutationJournal['g-task'] = {
    jv: 1, gId: 'g-task', msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    phase: 'NONSENSE', reason: 'X', payloadFp: null,
    httpStatus: null, providerCode: null, providerMessage: null,
    attempts: 0, firstFailedAt: null, lastFailedAt: null, abandonedAt: null, partial: null
  };
  assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED.*mutationJournal/);

  const atCapacity = mkState(c);
  for (let i = 0; i < 200; i += 1) {
    atCapacity.mutationJournal['filler-' + i] = {
      jv: 1, gId: 'filler-' + i, msId: 'm', gListId: 'g-list', msListId: 'ms-list',
      phase: 'OPEN', reason: 'X', payloadFp: null,
      httpStatus: null, providerCode: null, providerMessage: null,
      attempts: 1, firstFailedAt: null, lastFailedAt: null, abandonedAt: null, partial: null
    };
  }
  c.recordPairMutationFailure_(atCapacity, 'g-task', atCapacity.g2m['g-task'], 'b'.repeat(32), new Error('HTTP 400'), null);
  assert.equal(atCapacity.mutationJournal['g-task'], undefined, 'no new entry beyond the cap');
  assert.equal(Object.keys(atCapacity.mutationJournal).length, 200);
});
