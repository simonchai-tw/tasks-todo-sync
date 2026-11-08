import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* v1.2.0 / P1-1 — rec.res.journal convergence pruning (report §貳 B2, 120-122).
 * The persistent, top-level counter resourceJournalConvergedRounds guards the
 * prune; the guard must exclude exactly the six spec-named pending tables; and
 * a 2-round converged streak collapses each eligible journal to its last entry
 * while a trailing WRITTEN (unconfirmed) entry is kept in full. */

function blob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

function load() {
  const script = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; }, getKeys() { return Object.keys(this.values); }, getProperties() { return { ...this.values }; }, setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); }, deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; } };
  const user = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; }, getKeys() { return Object.keys(this.values); }, getProperties() { return { ...this.values }; }, setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); }, deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; } };
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

// 32 hex chars, accepted by assertResourceJournalEntries_ / assertOrdinaryMappingExtras_.
function fp(n) {
  return String(n).padStart(32, '0').slice(-32);
}

function journalOf(n, tailResult) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      side: i % 2 ? 'microsoft' : 'google',
      blockFp: fp(i + 1),
      at: i + 1,
      result: (i === n - 1 && tailResult) ? tailResult : 'CONFIRMED'
    });
  }
  return out;
}

function baseState(c) {
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  return state;
}

function addPair(state, gId, journal) {
  const msId = 'ms-' + gId;
  state.g2m[gId] = {
    msId: msId, gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    res: {
      gBlockFp: fp(201), msBlockFp: fp(202),
      gBlockIntentFp: fp(203), msBlockIntentFp: fp(204),
      journal: journal
    }
  };
  state.m2g[msId] = gId;
}

const SIX_TABLES = [
  ['pendingTaskDeletions', (s) => { s.pendingTaskDeletions = { k: { gId: 'g-1' } }; }],
  ['deletionJournal', (s) => { s.deletionJournal = { k: { phase: 'prepared' } }; }],
  ['taskMoveJournal', (s) => { s.taskMoveJournal = { k: { phase: 'prepared' } }; }],
  ['absenceHolds', (s) => { s.absenceHolds = { k: { at: 1 } }; }],
  ['mutationJournal', (s) => { s.mutationJournal = { k: { fp: 'x' } }; }],
  ['subtasks.conflicts', (s) => { s.subtasks.conflicts = { k: { gChildId: 'gc' } }; }]
];

test('resourceJournalConvergedRounds round-trips through normalizeState_/saveState_/loadStateForSync_ 3 times', () => {
  const c = load();
  let state = baseState(c);
  state.resourceJournalConvergedRounds = 4;
  for (let round = 0; round < 3; round += 1) {
    assert.doesNotThrow(() => c.normalizeState_(state), `round ${round + 1} normalizes`);
    c.saveState_(state);
    state = c.loadStateForSync_();
    assert.equal(state.resourceJournalConvergedRounds, 4, `counter value survives round ${round + 1}`);
  }
  assert.equal(typeof state.resourceJournalConvergedRounds, 'number');
});

test('guard returns true when all six tables are empty', () => {
  const c = load();
  const state = baseState(c);
  assert.equal(c.resourceJournalCompactionGuard_(state), true);
});

test('each of the six spec tables blocks the guard: counter reset, journal untouched, BLOCKED', () => {
  const c = load();
  for (const [label, poison] of SIX_TABLES) {
    const state = baseState(c);
    const journal = journalOf(5, 'CONFIRMED');
    addPair(state, 'g-1', journal.slice());
    // Pre-seed 1 round so a single call WOULD reach the prune if the guard passed.
    state.resourceJournalConvergedRounds = 1;
    poison(state);

    assert.equal(c.resourceJournalCompactionGuard_(state), false, `${label} must block the guard`);
    const result = c.compactResourceJournals_(state);
    assert.equal(result.guard, 'BLOCKED', `${label} returns BLOCKED`);
    assert.equal(result.reason, 'PENDING_STATE_TABLES', `${label} reason`);
    assert.equal(state.resourceJournalConvergedRounds, 0, `${label} resets the counter`);
    assert.equal(result.compacted, 0, `${label} compacts nothing`);
    assert.deepEqual(state.g2m['g-1'].res.journal, journal, `${label} leaves the journal completely untouched`);
  }
});

test('two converged rounds compact a 50-entry journal to its last entry; fps unchanged; validator passes', () => {
  const c = load();
  const state = baseState(c);
  const journal = journalOf(50, 'CONFIRMED');
  const lastEntry = journal[49];
  addPair(state, 'g-1', journal.slice());
  const res = state.g2m['g-1'].res;
  const fpsBefore = {
    gBlockFp: res.gBlockFp, msBlockFp: res.msBlockFp,
    gBlockIntentFp: res.gBlockIntentFp, msBlockIntentFp: res.msBlockIntentFp
  };

  const r1 = c.compactResourceJournals_(state);
  assert.equal(r1.guard, 'PASSED');
  assert.equal(r1.reason, 'STREAK_BELOW_THRESHOLD');
  assert.equal(r1.streak, 1);
  assert.equal(r1.compacted, 0);
  assert.equal(state.resourceJournalConvergedRounds, 1, 'first round only accumulates the streak');
  assert.equal(res.journal.length, 50, 'no pruning below the threshold');

  const r2 = c.compactResourceJournals_(state);
  assert.equal(r2.guard, 'PASSED');
  assert.equal(r2.reason, 'COMPACTED');
  assert.equal(r2.streak, 2);
  assert.equal(r2.compacted, 1);
  assert.equal(r2.skipped, 0);
  assert.equal(state.resourceJournalConvergedRounds, 0, 'counter resets after pruning');

  assert.equal(res.journal.length, 1, 'BENCH-01: one journal entry per mapping');
  assert.deepEqual(res.journal[0], lastEntry, 'the kept entry is the last one');
  assert.deepEqual({
    gBlockFp: res.gBlockFp, msBlockFp: res.msBlockFp,
    gBlockIntentFp: res.gBlockIntentFp, msBlockIntentFp: res.msBlockIntentFp
  }, fpsBefore, 'the four block/intent fingerprints are untouched');
  assert.equal(Object.keys(res).length, 5, 'only the journal key was rewritten, no extra keys');

  assert.doesNotThrow(() => c.assertResourceJournalEntries_(res.journal, 'g2m[g-1].res'));
  assert.doesNotThrow(() => c.normalizeState_(state), 'compacted state still passes full validation');
  assert.equal(res.journal.length, 1, 'normalizeState_ preserves the compacted journal');
});

test('a trailing WRITTEN journal is skipped and keeps its complete history', () => {
  const c = load();
  const state = baseState(c);
  const journal = journalOf(6, 'WRITTEN');
  addPair(state, 'g-1', journal.slice());
  state.resourceJournalConvergedRounds = 1; // single call reaches the prune path

  const result = c.compactResourceJournals_(state);
  assert.equal(result.reason, 'COMPACTED');
  assert.equal(result.skipped, 1, 'the WRITTEN-tail pair is counted as skipped');
  assert.equal(result.compacted, 0, 'no journal was pruned');
  assert.equal(state.resourceJournalConvergedRounds, 0, 'counter still resets');
  assert.deepEqual(state.g2m['g-1'].res.journal, journal, 'full crash history is preserved');
  assert.equal(state.g2m['g-1'].res.journal.length, 6);
});

test('counter resets after compaction and re-accumulates on the third round', () => {
  const c = load();
  const state = baseState(c);
  addPair(state, 'g-1', journalOf(3, 'CONFIRMED'));

  const r1 = c.compactResourceJournals_(state);
  assert.equal(r1.reason, 'STREAK_BELOW_THRESHOLD');
  assert.equal(r1.streak, 1);
  assert.equal(state.resourceJournalConvergedRounds, 1);

  const r2 = c.compactResourceJournals_(state);
  assert.equal(r2.reason, 'COMPACTED');
  assert.equal(r2.streak, 2);
  assert.equal(state.resourceJournalConvergedRounds, 0, 'reset to zero after pruning');

  const r3 = c.compactResourceJournals_(state);
  assert.equal(r3.reason, 'STREAK_BELOW_THRESHOLD', 'third round starts a fresh streak');
  assert.equal(r3.streak, 1);
  assert.equal(state.resourceJournalConvergedRounds, 1);
});

test('validator rejects illegal resourceJournalConvergedRounds (negative / string / float) with STATE_MALFORMED', () => {
  const c = load();
  for (const bad of [-1, '2', 1.5, NaN]) {
    const state = baseState(c);
    state.resourceJournalConvergedRounds = bad;
    assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED.*resourceJournalConvergedRounds/,
      `value ${String(bad)} must be rejected`);
  }
  for (const good of [0, 1, 2, 7]) {
    const state = baseState(c);
    state.resourceJournalConvergedRounds = good;
    assert.doesNotThrow(() => c.normalizeState_(state), `value ${good} must be accepted`);
  }
});

test('state unavailable is a no-op; length<=1 and non-array journals are never pruned', () => {
  const c = load();
  for (const bad of [null, undefined, 42, 'x', []]) {
    const result = c.compactResourceJournals_(bad);
    assert.equal(result.reason, 'STATE_UNAVAILABLE');
    assert.equal(result.guard, 'SKIPPED');
  }

  const state = baseState(c);
  const single = journalOf(1, 'CONFIRMED');
  addPair(state, 'single', single.slice());
  state.g2m['nonarray'] = {
    msId: 'ms-nonarray', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    res: { journal: 'not-an-array', gBlockFp: fp(301) }
  };
  state.g2m['eligible'] = {
    msId: 'ms-eligible', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    res: { journal: journalOf(4, 'CONFIRMED') }
  };
  state.resourceJournalConvergedRounds = 1;

  const result = c.compactResourceJournals_(state);
  assert.equal(result.reason, 'COMPACTED');
  assert.equal(result.compacted, 1, 'only the eligible journal is pruned');
  assert.deepEqual(state.g2m['single'].res.journal, single, 'length-1 journal untouched');
  assert.equal(state.g2m['nonarray'].res.journal, 'not-an-array', 'non-array journal untouched');
  assert.equal(state.g2m['eligible'].res.journal.length, 1, 'eligible journal compacted');
});

test('mixed pass: one pair compacted, one WRITTEN-tail pair skipped, counter reset', () => {
  const c = load();
  const state = baseState(c);
  const writtenTail = journalOf(4, 'WRITTEN');
  addPair(state, 'g-a', journalOf(7, 'CONFIRMED'));
  addPair(state, 'g-b', writtenTail.slice());
  state.resourceJournalConvergedRounds = 1;

  const result = c.compactResourceJournals_(state);
  assert.equal(result.reason, 'COMPACTED');
  assert.equal(result.compacted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(state.resourceJournalConvergedRounds, 0);
  assert.equal(state.g2m['g-a'].res.journal.length, 1);
  assert.deepEqual(state.g2m['g-b'].res.journal, writtenTail, 'WRITTEN-tail history fully preserved');
});
