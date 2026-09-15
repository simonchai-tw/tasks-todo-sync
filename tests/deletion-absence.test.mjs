import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* W2/W3 coverage: provider-level absence evidence and deletions=false terminal
 * states.  Written after the implementation landed without any tests; these
 * assertions are what proves the behaviour rather than the existence of code. */

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

function gTask(overrides = {}) {
  return {
    id: 'g-task', title: 'Same', notes: 'note', status: 'needsAction',
    due: '2026-08-21T00:00:00.000Z', updated: '2026-08-14T00:00:00Z', ...overrides
  };
}

function msTask(overrides = {}) {
  return {
    id: 'ms-task', title: 'Same', body: { contentType: 'text', content: 'note' },
    status: 'notStarted',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'UTC' },
    lastModifiedDateTime: '2026-08-14T00:00:00Z', ...overrides
  };
}

function mkSnap({ gPresent = true, msPresent = true, g = {}, m = {}, ...flags } = {}) {
  const {
    inventoryComplete = true,
    allowDeletions = true,
    allowTaskMoves = false,
    absenceProbe = true
  } = flags;
  return {
    activeGListIds: { 'g-list': true },
    gTaskInventoryListIds: { 'g-list': true },
    msTaskInventoryListIds: { 'ms-list': true },
    inventoryComplete,
    safety: { allowDeletions, allowTaskMoves, absenceProbe },
    gTasksById: gPresent ? { 'g-task': gTask(g) } : {},
    msTasksById: msPresent ? { 'ms-task': msTask(m) } : {},
    gListByTask: gPresent ? { 'g-task': 'g-list' } : {},
    msListByTask: msPresent ? { 'ms-task': 'ms-list' } : {}
  };
}

// One converged round with both sides present and equal, so rec.fp holds a real
// fingerprint (including a real version marker) for later comparisons.
function bootstrap(c, state) {
  c.reconcileMapped_(state, mkSnap(), Date.now(), 'bootstrap-round', {});
  return state.g2m['g-task'].fp;
}

function countDeletes(c) {
  const calls = { google: [], microsoft: [] };
  c.deleteGTask_ = (listId, taskId) => calls.google.push([listId, taskId]);
  c.deleteMsTask_ = (listId, taskId) => calls.microsoft.push([listId, taskId]);
  return calls;
}

/* ---------------------------------------------------------------- assertion 1 */

test('iron 1: a provider-rejected mutation leaves the baseline untouched', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  const fpBefore = JSON.parse(JSON.stringify(state.g2m['g-task'].fp));
  const stampsBefore = { g: state.g2m['g-task'].gUpdated, ms: state.g2m['g-task'].msUpdated };
  const deletes = countDeletes(c);
  c.updateGTask_ = () => { throw new Error('HTTP 400: {"error":{"code":"invalidRequest","message":"no"}}'); };

  assert.doesNotThrow(() => c.reconcileMapped_(
    state, mkSnap({ m: { title: 'edited-on-microsoft' } }), Date.now(), 'round-1', {}
  ));

  assert.deepEqual(
    JSON.parse(JSON.stringify(state.g2m['g-task'].fp)),
    fpBefore,
    'fingerprint must not advance'
  );
  assert.equal(state.g2m['g-task'].gUpdated, stampsBefore.g);
  assert.equal(state.g2m['g-task'].msUpdated, stampsBefore.ms);
  assert.equal(state.pendingTaskDeletions['g-task'], undefined, 'a refusal is not absence evidence');
  assert.deepEqual(deletes, { google: [], microsoft: [] });
});

/* ---------------------------------------------------------------- assertion 2 */

test('iron 2: an incomplete inventory writes no deletion evidence at all', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  const deletes = countDeletes(c);
  const snap = mkSnap({ gPresent: false, inventoryComplete: false, allowDeletions: true, absenceProbe: true });
  const progress = {};

  c.reconcileMapped_(state, snap, Date.now(), 'round-1', progress);
  c.applyConfirmedTaskDeletions_(state, snap, 'round-1', progress);

  assert.equal(state.pendingTaskDeletions['g-task'], undefined, 'no candidate from an incomplete inventory');
  assert.equal(state.deletionJournal['g-task'], undefined, 'no deletion journal from an incomplete inventory');
  assert.deepEqual(deletes, { google: [], microsoft: [] });
  assert.ok(state.g2m['g-task'], 'the mapping must survive');
});

/* ---------------------------------------------------------------- assertion 3 */

test('iron 3: a task that is alive by id must never trigger a remote delete', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  const deletes = countDeletes(c);
  // The inventory says the Google side is gone, but a direct read finds it alive.
  c.getGTask_ = () => gTask();
  const progress = {};

  c.reconcileMapped_(state, mkSnap({ gPresent: false, allowDeletions: true, absenceProbe: true }), Date.now(), 'round-1', progress);
  assert.ok(state.pendingTaskDeletions['g-task'], 'round 1 may still register a candidate');

  const snap2 = mkSnap({ gPresent: false, allowDeletions: true, absenceProbe: true });
  c.reconcileMapped_(state, snap2, Date.now(), 'round-2', progress);
  c.applyConfirmedTaskDeletions_(state, snap2, 'round-2', progress);

  assert.deepEqual(deletes, { google: [], microsoft: [] }, 'a live task must never be deleted');
  assert.equal(state.pendingTaskDeletions['g-task'], undefined, 'the candidate must be discarded');
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'ABSENCE_WAS_FILTER_ARTIFACT');
  assert.ok(state.g2m['g-task'], 'the mapping must survive');
});

/* ---------------------------------------------------------------- assertion 4 */

test('iron 4: one pair performs at most one write per side per round', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  const gWrites = [];
  const msWrites = [];
  c.updateGTask_ = (listId, taskId, payload) => { gWrites.push(payload); return gTask({ ...payload }); };
  c.updateMsTask_ = (listId, taskId, payload) => { msWrites.push(payload); return msTask({ ...payload }); };

  c.reconcileMapped_(state, mkSnap({ m: { title: 'microsoft-edited' } }), Date.now(), 'round-1', {});

  assert.ok(gWrites.length <= 1, 'at most one Google PATCH per pair per round');
  assert.ok(msWrites.length <= 1, 'at most one Microsoft PATCH per pair per round');
});

/* ------------------------------------------------------- W3 terminal states */

test('W3: an absence that was never completed must HOLD, not retire the mapping', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);                       // both sides not completed -> fp.completed is the hash of false
  const deletes = countDeletes(c);
  // Provider unavailable (no HTTP status) so the baseline decides the terminal state.
  c.getGTask_ = () => { throw new Error('NO_PROVIDER_IN_TEST'); };

  c.reconcileMapped_(
    state, mkSnap({ gPresent: false, allowDeletions: false, absenceProbe: true }), Date.now(), 'round-1', {}
  );

  assert.equal(state.retiredPairs['g-task'], undefined,
    'a pair that was never observed completed must not be retired');
  assert.ok(state.absenceHolds['g-task'], 'it must be held instead');
  assert.equal(state.absenceHolds['g-task'].reason, 'ABSENCE_UNEXPLAINED');
  assert.ok(state.g2m['g-task'], 'the mapping must be retained while held');
  assert.deepEqual(deletes, { google: [], microsoft: [] });
});

test('W3: an absence that WAS completed retires the mapping without deleting the counterpart', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  const rec = state.g2m['g-task'];
  // Converged baseline where both sides were observed completed.
  rec.fp.completed = c.ordinaryFieldFp_({ completed: true }, 'completed');
  const deletes = countDeletes(c);
  c.getGTask_ = () => { throw new Error('NO_PROVIDER_IN_TEST'); };

  c.reconcileMapped_(
    state, mkSnap({ gPresent: false, allowDeletions: false, absenceProbe: true }), Date.now(), 'round-1', {}
  );

  assert.ok(state.retiredPairs['g-task'], 'a completed pair is retired');
  assert.equal(state.retiredPairs['g-task'].reason, 'RETIRE_COMPLETED');
  assert.equal(state.absenceHolds['g-task'], undefined);
  assert.equal(state.g2m['g-task'], undefined, 'the mapping leaves the active table');
  assert.deepEqual(deletes, { google: [], microsoft: [] }, 'the counterpart must NOT be deleted');
});

test('W3: a hold blocks automatic creation on the surviving list and survives TTL', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  c.getGTask_ = () => { throw new Error('NO_PROVIDER_IN_TEST'); };

  c.reconcileMapped_(
    state, mkSnap({ gPresent: false, allowDeletions: false, absenceProbe: true }), Date.now(), 'round-1', {}
  );

  assert.equal(state.listCreateGuards['ms-list'].reason, 'ABSENCE_HOLD',
    'the surviving list must stop accepting automatic creation');

  // A very long time later the unresolved hold must still be there, while an
  // expired retired record is dropped.
  state.retiredPairs['g-expired'] = { ttlExpiresAt: Date.now() - 1000 };
  state.retiredPairs['g-fresh'] = { ttlExpiresAt: Date.now() + 100000 };
  c.expireRetiredPairs_(state);

  assert.equal(state.retiredPairs['g-expired'], undefined, 'an expired retired record is dropped');
  assert.ok(state.retiredPairs['g-fresh'], 'an unexpired retired record stays');
  assert.ok(state.absenceHolds['g-task'], 'an unresolved hold is never auto-released by TTL');
  assert.ok(state.listCreateGuards['ms-list'], 'nor is its list create guard');
});

test('W3: a provider error during the absence probe is fail-closed, not a terminal state', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  c.getGTask_ = () => { throw new Error('HTTP 503: service unavailable'); };

  c.reconcileMapped_(
    state, mkSnap({ gPresent: false, allowDeletions: false, absenceProbe: true }), Date.now(), 'round-1', {}
  );

  assert.equal(state.retiredPairs['g-task'], undefined, 'a provider error must not retire');
  assert.equal(state.absenceHolds['g-task'], undefined, 'a provider error must not hold');
  assert.ok(state.g2m['g-task'], 'the mapping must be retained untouched');
});

test('W3 is inert unless the capability is enabled for the round', () => {
  const c = load();
  const state = mkState(c);
  bootstrap(c, state);
  c.getGTask_ = () => { throw new Error('NO_PROVIDER_IN_TEST'); };

  c.reconcileMapped_(
    state, mkSnap({ gPresent: false, allowDeletions: false, absenceProbe: false }), Date.now(), 'round-1', {}
  );

  assert.equal(state.retiredPairs['g-task'], undefined);
  assert.equal(state.absenceHolds['g-task'], undefined);
  assert.equal(state.listCreateGuards['ms-list'], undefined);
  assert.ok(state.g2m['g-task'], 'legacy retain-and-wait behaviour is preserved when disabled');
});

test('the absence-terminal capability reaches snap.safety and defaults to off', () => {
  // Until this flag existed the capability was unreachable: lifecycle.gs read
  // snap.safety.absenceProbe but nothing ever set it, so the terminal states were
  // dead code in production.
  const off = load();
  assert.equal(off.getSafetyConfig_().absenceProbe, false, 'must default to off');

  const on = load();
  on.PropertiesService.getScriptProperties().setProperty('SYNC_ENABLE_ABSENCE_TERMINAL', 'true');
  assert.equal(on.getSafetyConfig_().absenceProbe, true);
  assert.equal(on.buildSnapshot_ === undefined, false, 'buildSnapshot_ still present');

  const bad = load();
  bad.PropertiesService.getScriptProperties().setProperty('SYNC_ENABLE_ABSENCE_TERMINAL', 'yes');
  assert.throws(() => bad.getSafetyConfig_(), /SYNC_ABSENCE_TERMINAL_FLAG_INVALID/);
});
