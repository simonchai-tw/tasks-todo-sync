import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* W4 / crash-resilience coverage for ordinaryReconcileMappedPair_:
 *   1. pre-PATCH re-read abandons a notes write when the user edited after planning
 *      (or when the read fails) instead of clobbering the user's edit;
 *   2. a bounded, restart-identifiable resource write journal;
 *   3. Case C — a successful remote PATCH whose round commit is lost converges on
 *      the next read-back with zero provider writes;
 *   4. a half-seeded fingerprint state takes the bootstrap-conflict path instead of
 *      mis-judging an unknown field as our own.
 * The harness default for rereadProviderNotes_ (installed in gas-loader.mjs) returns
 * the observed notes, so existing behaviour is preserved; these tests override it to
 * exercise the abandon / fail-closed paths. */

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

function gTaskWithLink() {
  return {
    id: 'g-task', title: 'Same', notes: 'user notes', status: 'needsAction',
    updated: '2026-08-14T00:00:00Z',
    links: [{ link: 'https://example.com/one', description: 'One' }]
  };
}

function msTaskPlain() {
  return {
    id: 'ms-task', title: 'Same', body: { contentType: 'text', content: 'user notes' },
    status: 'notStarted', lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
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

// A plain Google task and a plain Microsoft task that differ ONLY on notes, with a
// known notes baseline so the divergence is a clean LWW (not a bootstrap conflict).
function gPlain(notes) {
  return {
    id: 'g-task', title: 'Same', notes: notes, status: 'needsAction',
    due: '2026-08-21T00:00:00.000Z', updated: '2026-08-14T00:00:00Z'
  };
}
function mPlain(notes) {
  return {
    id: 'ms-task', title: 'Same', body: { contentType: 'text', content: notes },
    status: 'notStarted', dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'UTC' },
    lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
}

// Build a rec.fp with one field known and the rest unknown, so any divergence on an
// unknown field is a bootstrap conflict rather than an LWW write.
function halfSeededFp(c) {
  const fp = c.ordinaryEmptyFp_();
  fp.title = c.ordinaryFingerprintHex_('Same');
  fp.completed = c.ordinaryFingerprintHex_(false);
  fp.due = c.ordinaryFingerprintHex_('2026-08-21');
  // notes stays null -> unknown baseline
  return fp;
}

test('pre-PATCH re-read abandons the Google notes write when the user edited after planning', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  rec.fp = halfSeededFp(c);
  rec.fp.notes = c.ordinaryFingerprintHex_('base notes');
  const baseNotes = 'base notes';

  // The user edited Google notes between our plan and the PATCH.
  c.rereadProviderNotes_ = (side) => ({ ok: true, notes: side === 'google' ? 'user edited after plan' : baseNotes });
  c.updateGTask_ = (listId, taskId, payload) => {
    throw new Error('updateGTask_ must NOT be called when the write was abandoned');
  };

  const r = c.ordinaryReconcileMappedPair_(state, rec, gPlain(baseNotes), mPlain('M notes'), 'g-list', {});

  assert.equal(r.googleWrites, 0, 'the write was abandoned, no provider call');
  assert.ok(r.resourceDiagnostic.includes('NOTES_REREAD_USER_EDIT'), 'diagnostic records the user edit');
  assert.equal(rec.fp.notes, c.ordinaryFingerprintHex_('base notes'), 'the unknown field must not be advanced');
});

test('pre-PATCH re-read is fail-closed: a read error abandons the notes write', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  rec.fp = halfSeededFp(c);
  rec.fp.notes = c.ordinaryFingerprintHex_('base notes');

  c.rereadProviderNotes_ = () => ({ ok: false, notes: null });
  c.updateGTask_ = () => { throw new Error('updateGTask_ must NOT be called after a failed read'); };

  const r = c.ordinaryReconcileMappedPair_(state, rec, gPlain('base notes'), mPlain('M notes'), 'g-list', {});

  assert.equal(r.googleWrites, 0, 'fail-closed: no write after a read error');
  assert.ok(r.resourceDiagnostic.includes('NOTES_REREAD_FAILED'), 'diagnostic records the failed read');
  assert.equal(rec.fp.notes, c.ordinaryFingerprintHex_('base notes'), 'the unknown field is not advanced');
});

test('pre-PATCH re-read does not abandon when notes are unchanged', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  rec.fp = halfSeededFp(c);
  rec.fp.notes = c.ordinaryFingerprintHex_('base notes');
  let written = null;
  c.rereadProviderNotes_ = (side) => ({ ok: true, notes: side === 'google' ? 'base notes' : 'M notes' });
  c.updateGTask_ = (listId, taskId, payload) => {
    written = payload;
    return { id: taskId, title: 'Same', notes: payload.notes, status: 'needsAction', due: payload.due, updated: '2026-08-15T00:00:00Z' };
  };

  const r = c.ordinaryReconcileMappedPair_(state, rec, gPlain('base notes'), mPlain('M notes'), 'g-list', {});

  assert.equal(r.googleWrites, 1, 'the LWW write proceeds when the user did not edit');
  assert.equal(written.notes, 'M notes', 'the intended value was written');
  assert.equal(rec.fp.notes, c.ordinaryFingerprintHex_('M notes'), 'the field advanced to the written value');
});

test('resource journal is bounded to RESOURCE_JOURNAL_MAX_ entries', () => {
  const c = load();
  const j = [];
  for (let i = 0; i < 60; i++) {
    c.resourceJournalPush_(j, { side: 'google', blockFp: 'f' + i, at: i, result: 'WRITTEN' });
  }
  assert.equal(j.length, c.RESOURCE_JOURNAL_MAX_, 'journal capped at the maximum');
  assert.equal(j[0].at, 10, 'the oldest 10 entries were evicted');
  assert.equal(j[j.length - 1].at, 59, 'the newest entry is retained');
});

test('resource journal records WRITTEN then CONFIRMED and survives a round-trip restart', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  let writtenBody = null;
  c.persistSyncState_ = () => {};
  c.rereadProviderNotes_ = () => ({ ok: true, notes: 'user notes' });
  c.updateMsTask_ = (listId, taskId, payload) => {
    writtenBody = payload.body.content;
    return {
      id: taskId, title: 'Same', status: 'notStarted',
      lastModifiedDateTime: '2026-08-15T00:00:00Z',
      body: { contentType: 'text', content: writtenBody }
    };
  };

  c.ordinaryReconcileMappedPair_(state, rec, gTaskWithLink(), msTaskPlain(), 'g-list', {});

  assert.ok(Array.isArray(rec.res.journal), 'a journal is attached to rec.res');
  const results = rec.res.journal.map((e) => e.result);
  assert.ok(results.includes('WRITTEN'), 'a WRITTEN entry is recorded');
  assert.ok(results.includes('CONFIRMED'), 'a CONFIRMED entry is recorded');
  const written = rec.res.journal.find((e) => e.result === 'WRITTEN');
  assert.equal(written.side, 'microsoft');
  assert.match(written.blockFp, /^[0-9a-f]{32}$/, 'the intended block fingerprint is logged');
  // Restart-identifiable: the journal survives serialization like a persisted state.
  const reloaded = JSON.parse(JSON.stringify(rec.res));
  assert.ok(Array.isArray(reloaded.journal), 'journal survives serialization');
  assert.equal(reloaded.journal.length, rec.res.journal.length);
});

test('Case C — a successful PATCH whose round commit is lost converges with zero writes', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  let checkpointRes = null;
  let writtenBody = null;
  // persistSyncState_ succeeds for the W4 durable intent checkpoint, but we record
  // the on-disk state it would have written. The fatal final commit (which would
  // persist the confirmed fingerprint) never happens in this simulated crash.
  let persistCount = 0;
  c.persistSyncState_ = (s) => {
    persistCount += 1;
    checkpointRes = JSON.parse(JSON.stringify((s.g2m['g-task'] || {}).res || null));
  };
  c.rereadProviderNotes_ = () => ({ ok: true, notes: 'user notes' });
  c.updateMsTask_ = (listId, taskId, payload) => {
    writtenBody = payload.body.content;
    return {
      id: taskId, title: 'Same', status: 'notStarted',
      lastModifiedDateTime: '2026-08-15T00:00:00Z',
      body: { contentType: 'text', content: writtenBody }
    };
  };

  const r1 = c.ordinaryReconcileMappedPair_(state, rec, gTaskWithLink(), msTaskPlain(), 'g-list', {});
  assert.equal(r1.microsoftWrites, 1, 'round 1 wrote the block to Microsoft');
  assert.match(rec.res.msBlockFp, /^[0-9a-f]{32}$/, 'round 1 confirmed the block in memory');

  assert.equal(persistCount, 1, 'exactly one durable checkpoint (the W4 intent)');
  assert.ok(checkpointRes && checkpointRes.msBlockIntentFp, 'checkpoint carried the intent');
  assert.ok(!checkpointRes.msBlockFp, 'checkpoint did NOT carry the confirmed fp (commit crashed)');

  // Round 2 — reload from the crashed checkpoint. The provider still holds the block
  // written in round 1, so no rewrite should occur and the fp re-derives.
  const rec2 = state.g2m['g-task'];
  rec2.res = JSON.parse(JSON.stringify(checkpointRes));
  let msWritesRound2 = 0;
  c.updateMsTask_ = () => { msWritesRound2 += 1; return msTaskPlain(); };
  const msWithBlock = {
    id: 'ms-task', title: 'Same', body: { contentType: 'text', content: writtenBody },
    status: 'notStarted', lastModifiedDateTime: '2026-08-15T00:00:00Z'
  };

  const r2 = c.ordinaryReconcileMappedPair_(state, rec2, gTaskWithLink(), msWithBlock, 'g-list', {});

  assert.equal(r2.microsoftWrites, 0, 'round 2 must not rewrite the block');
  assert.equal(msWritesRound2, 0, 'round 2 issued zero Microsoft writes');
  assert.match(rec2.res.msBlockFp, /^[0-9a-f]{32}$/, 'round 2 re-derived the confirmed fingerprint');
  assert.equal(rec2.res.msBlockIntentFp, undefined, 'round 2 cleared the stale intent marker');
});

test('partial bootstrap — an unknown field is a conflict, never a write or own-block claim', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  // Half-new, half-old: title/completed/due are known; notes baseline is unknown.
  rec.fp = halfSeededFp(c);

  const r = c.ordinaryReconcileMappedPair_(state, rec, gPlain('G notes'), mPlain('M notes'), 'g-list', {});

  const bootstrapNotes = (r.plan.bootstrapConflicts || []).find((x) => x.field === 'notes');
  assert.ok(bootstrapNotes, 'notes divergence on an unknown baseline is a bootstrap conflict');
  assert.equal(bootstrapNotes.kind, 'BOOTSTRAP_CONFLICT');
  assert.equal(r.googleWrites, 0, 'no Google write');
  assert.equal(r.microsoftWrites, 0, 'no Microsoft write');
  assert.equal(rec.fp.notes, null, 'the unknown field is not advanced to either side');
  assert.equal(rec.res, undefined, 'no resource block is mis-claimed as our own');
  assert.equal(rec.fp.title, c.ordinaryFingerprintHex_('Same'), 'the known field is untouched');
});
