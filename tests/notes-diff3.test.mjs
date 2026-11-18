import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

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
  return c;
}

/* In-memory user-cache stub: the notes merge never touches CacheService
 * directly; it only sees this adapter, so node --test runs without any
 * Apps Script runtime. `calls` lets tests prove the adapter was (or was
 * not) consulted. */
function memoryCache() {
  const store = new Map();
  const calls = { get: 0, put: 0 };
  let lastTtl = null;
  return {
    store,
    calls,
    get lastTtl() { return lastTtl; },
    get(key) {
      calls.get += 1;
      return store.has(key) ? store.get(key) : null;
    },
    put(key, value, ttlSeconds) {
      calls.put += 1;
      lastTtl = ttlSeconds;
      store.set(key, String(value));
    }
  };
}

function diff3Options(cache) {
  return { diff3Enabled: true, nowMs: 1760000000000, cache };
}

function pair(c, extras = {}) {
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    ...extras
  };
  state.m2g['ms-task'] = 'g-task';
  const gTask = {
    id: 'g-task', title: 'Same', notes: 'note', status: 'needsAction',
    due: '2026-08-21T00:00:00.000Z', updated: '2026-08-14T00:00:00Z'
  };
  const msTask = {
    id: 'ms-task', title: 'Same',
    body: { contentType: 'text', content: 'note' },
    status: 'notStarted',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'UTC' },
    lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  return { state, gTask, msTask };
}

function stubWrites(c) {
  const gPatches = [];
  const msPatches = [];
  c.updateGTask_ = (list, id, payload) => {
    gPatches.push(payload);
    return { id, title: payload.title, notes: payload.notes, status: payload.status, due: payload.due, updated: '2026-08-15T00:00:00Z' };
  };
  c.updateMsTask_ = (list, id, payload) => {
    msPatches.push(payload);
    return {
      id,
      title: payload.title,
      body: payload.body,
      status: payload.status,
      dueDateTime: payload.dueDateTime,
      lastModifiedDateTime: '2026-08-15T00:00:00Z'
    };
  };
  return { gPatches, msPatches };
}

/* Provider reads for the pre-PATCH notes re-read: the harness mirrors
 * production (a fresh GET) with the current, unmodified provider state. */
function stubReads(c, gTask, msTask) {
  c.getGTask_ = () => ({ ...gTask });
  c.getMsTask_ = () => ({ ...msTask });
}

const BLOCK = '--- tasks-todo-sync ---\n[Link] https://example.invalid/a\n--- tasks-todo-sync end ---';

test('malformed notes column stays skipped with zero writes even when the notes merge is enabled', () => {
  const c = load();
  const cache = memoryCache();
  const { state, gTask, msTask } = pair(c);
  // Two begin separators: the parser refuses the whole column (MALFORMED).
  msTask.body = {
    contentType: 'text',
    content: 'note\n\n--- tasks-todo-sync ---\nA\n--- tasks-todo-sync end ---\n--- tasks-todo-sync ---\nB\n--- tasks-todo-sync end ---'
  };
  gTask.notes = 'edited from google';
  gTask.updated = '2026-08-15T00:00:00Z';
  const { gPatches, msPatches } = stubWrites(c);
  const result = c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.ok(result.plan.skipped.some((row) => row.field === 'notes' && row.reason === 'NOTES_UNMERGEABLE'));
  // Skip, not conflict: the column was left alone, no raw-text fallback.
  assert.ok(!state.g2m['g-task'].fc || !state.g2m['g-task'].fc.notes);
  // The Google edit must not leak to Microsoft through any back door.
  assert.equal(msTask.body.content.includes('edited from google'), false);
  assert.equal(cache.calls.put, 0);
});

test('ownership-ambiguous notes column stays skipped with zero writes even when the notes merge is enabled', () => {
  const c = load();
  const cache = memoryCache();
  const { state, gTask, msTask } = pair(c, { res: { msBlockFp: 'f'.repeat(32) } });
  msTask.body = { contentType: 'text', content: 'note\n\n' + BLOCK };
  gTask.notes = 'edited from google';
  gTask.updated = '2026-08-15T00:00:00Z';
  const { gPatches, msPatches } = stubWrites(c);
  const result = c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.ok(result.plan.skipped.some((row) => row.field === 'notes' && row.reason === 'NOTES_UNMERGEABLE'));
  assert.ok(!state.g2m['g-task'].fc || !state.g2m['g-task'].fc.notes);
  assert.equal(msTask.body.content.includes('edited from google'), false);
  assert.equal(cache.calls.put, 0);
});

test('converged round stores the baseline fingerprint in the mapping and the text in the user cache for the next round', () => {
  const c = load();
  const cache = memoryCache();
  const { state, gTask, msTask } = pair(c);
  gTask.notes = 'alpha\nbeta\ncharlie';
  msTask.body = { contentType: 'text', content: 'alpha\nbeta\ncharlie' };
  const { gPatches, msPatches } = stubWrites(c);
  // Round 1: fully converged, nothing written, baseline captured.
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(gPatches.length + msPatches.length, 0);
  const rec = state.g2m['g-task'];
  assert.match(rec.nfp, /^[0-9a-f]{32}$/);
  assert.equal(rec.nfp, c.ordinaryFingerprintHex_('alpha\nbeta\ncharlie'));
  const key = 'tts-notes-base-v1:g-task';
  assert.equal(cache.store.get(key), 'alpha\nbeta\ncharlie');
  assert.equal(cache.lastTtl, 21600);
  // Round 2: both sides readable — different-line edits merge cleanly, which
  // is only possible when the cached baseline round-trips and verifies.
  stubReads(c, gTask, msTask);
  const { gPatches: g2, msPatches: m2 } = stubWrites(c);
  gTask.notes = 'ALPHA-g\nbeta\ncharlie';
  gTask.updated = '2026-08-15T00:00:00Z';
  msTask.body = { contentType: 'html', content: 'alpha\nbeta\nCHARLIE-m' };
  msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
  const merged = 'ALPHA-g\nbeta\nCHARLIE-m';
  assert.equal(g2.length, 1);
  assert.equal(m2.length, 1);
  assert.equal(g2[0].notes, merged);
  assert.equal(m2[0].body.contentType, 'html');
  assert.equal(m2[0].body.content, c.textToHtml_(merged));
});

test('missing or mismatched cached baseline falls back to the whole-column conflict without touching either provider', () => {
  const c = load();
  const cache = memoryCache();
  const { state, gTask, msTask } = pair(c);
  gTask.notes = 'alpha\nbeta\ncharlie';
  msTask.body = { contentType: 'text', content: 'alpha\nbeta\ncharlie' };
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  const rec = state.g2m['g-task'];
  const seededFp = rec.nfp;
  assert.ok(seededFp);

  // Case 1: cache miss (TTL expiry / eviction).
  cache.store.clear();
  const { gPatches: g1, msPatches: m1 } = stubWrites(c);
  gTask.notes = 'ALPHA-g\nbeta\ncharlie';
  gTask.updated = '2026-08-15T00:00:00Z';
  msTask.body = { contentType: 'text', content: 'alpha\nbeta\nCHARLIE-m' };
  msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(g1.length + m1.length, 0);
  assert.equal(rec.fc.notes.kind, 'TRUE_FIELD_CONFLICT');
  // No data loss: neither provider value was rewritten.
  assert.equal(gTask.notes.includes('CHARLIE-m'), false);
  assert.equal(msTask.body.content.includes('ALPHA-g'), false);
  // No raw-text fallback: baseline bookkeeping untouched.
  assert.equal(rec.nfp, seededFp);

  // Case 2: corrupt cache content (a torn/stale entry — e.g. one side's own
  // current text). The fingerprint must veto it; without the check the merge
  // would silently adopt the wrong baseline and write the other side's text.
  cache.store.set('tts-notes-base-v1:g-task', 'ALPHA-g\nbeta\ncharlie');
  const { gPatches: g2, msPatches: m2 } = stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(g2.length + m2.length, 0);
  assert.equal(rec.fc.notes.kind, 'TRUE_FIELD_CONFLICT');
  assert.equal(gTask.notes.includes('CHARLIE-m'), false);
  assert.equal(msTask.body.content.includes('ALPHA-g'), false);
});

test('overlong normalized baseline is never stored and the pair falls back to the whole-column conflict', () => {
  const c = load();
  const cache = memoryCache();
  const { state, gTask, msTask } = pair(c);
  gTask.notes = 'x'.repeat(1001);
  msTask.body = { contentType: 'text', content: 'x'.repeat(1001) };
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  const rec = state.g2m['g-task'];
  assert.equal(rec.nfp, undefined);
  assert.equal(cache.store.size, 0);
  // Converged round still converged; nothing written, no conflict recorded.
  assert.equal(rec.fc && rec.fc.notes, undefined);

  // Next round: both sides edited — without a baseline the merge must fall
  // back to the whole-column conflict.
  const { gPatches, msPatches } = stubWrites(c);
  gTask.notes = 'y'.repeat(1001);
  gTask.updated = '2026-08-15T00:00:00Z';
  msTask.body = { contentType: 'text', content: 'z'.repeat(1001) };
  msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.equal(rec.fc.notes.kind, 'TRUE_FIELD_CONFLICT');

  // Boundary: exactly 1,000 normalized chars IS baselineable.
  const cache2 = memoryCache();
  const target = pair(c);
  target.gTask.notes = 'w'.repeat(1000);
  target.msTask.body = { contentType: 'text', content: 'w'.repeat(1000) };
  c.ordinaryReconcileMappedPair_(target.state, target.state.g2m['g-task'], target.gTask, target.msTask, 'g-list', {}, diff3Options(cache2));
  assert.match(target.state.g2m['g-task'].nfp, /^[0-9a-f]{32}$/);
  assert.equal(cache2.store.get('tts-notes-base-v1:g-task'), 'w'.repeat(1000));
});

test('different-line edits from both sides merge into one value and keep the managed block with a single separator', () => {
  const c = load();
  const cache = memoryCache();
  const links = [{ type: 'email', description: 'Example', link: 'https://example.invalid/file' }];
  const block = c.renderManagedResourceBlock_(
    c.projectGoogleResources_({ id: 'g-task', title: 'Same', notes: 'alpha\nbeta\ncharlie', status: 'needsAction', links }),
    'g2m', 'alpha\nbeta\ncharlie', c.RESOURCE_NOTES_MAX_).block;
  const blockFp = c.managedBlockFingerprint_(block);
  const user1 = 'alpha\nbeta\ncharlie';
  const full1 = user1 + '\n\n' + block;

  const { state, gTask, msTask } = pair(c, { res: { gBlockFp: blockFp, msBlockFp: blockFp } });
  gTask.notes = full1;
  gTask.links = links;
  msTask.body = { contentType: 'html', content: full1 };
  stubWrites(c);
  // Round 1: converged with the block on both sides; baseline is the user part.
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  const rec = state.g2m['g-task'];
  assert.equal(rec.nfp, c.ordinaryFingerprintHex_(user1));
  assert.equal(cache.store.get('tts-notes-base-v1:g-task'), user1);

  // Round 2: Google edits line 1, Microsoft edits line 3.
  stubReads(c, gTask, msTask);
  const { gPatches, msPatches } = stubWrites(c);
  const merged = 'ALPHA-g\nbeta\nCHARLIE-m';
  gTask.notes = 'ALPHA-g\nbeta\ncharlie\n\n' + block;
  gTask.updated = '2026-08-15T00:00:00Z';
  msTask.body = { contentType: 'html', content: 'alpha\nbeta\nCHARLIE-m\n\n' + block };
  msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(gPatches.length, 1);
  assert.equal(msPatches.length, 1);
  // Both edits present, managed block preserved, exactly one separator.
  assert.equal(gPatches[0].notes, merged + '\n\n' + block);
  assert.equal((gPatches[0].notes.match(/^--- tasks-todo-sync ---$/gm) || []).length, 1);
  assert.equal(msPatches[0].body.content, c.textToHtml_(merged + '\n\n' + block));
  // Convergence bookkeeping: baseline refreshed to the merged value.
  assert.equal(rec.nfp, c.ordinaryFingerprintHex_(merged));
  assert.equal(cache.store.get('tts-notes-base-v1:g-task'), merged);
});

test('CRLF on the Microsoft side does not turn shared lines into conflicts', () => {
  const c = load();
  const cache = memoryCache();
  const links = [{ type: 'email', description: 'Example', link: 'https://example.invalid/file' }];
  const block = c.renderManagedResourceBlock_(
    c.projectGoogleResources_({ id: 'g-task', title: 'Same', notes: 'alpha\nbeta\ncharlie', status: 'needsAction', links }),
    'g2m', 'alpha\nbeta\ncharlie', c.RESOURCE_NOTES_MAX_).block;
  const blockFp = c.managedBlockFingerprint_(block);
  const user1 = 'alpha\nbeta\ncharlie';
  const full1 = user1 + '\n\n' + block;

  const { state, gTask, msTask } = pair(c, { res: { gBlockFp: blockFp, msBlockFp: blockFp } });
  gTask.notes = full1;
  gTask.links = links;
  msTask.body = { contentType: 'html', content: full1 };
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  const rec = state.g2m['g-task'];

  // Round 2: the provider returns the MS body with CRLF endings (measured
  // live 2026-11-18 on a text body) while Google is LF and both sides edited
  // different lines.
  stubReads(c, gTask, msTask);
  const { gPatches, msPatches } = stubWrites(c);
  const merged = 'ALPHA-g\nbeta\nCHARLIE-m';
  gTask.notes = 'ALPHA-g\nbeta\ncharlie\n\n' + block;
  gTask.updated = '2026-08-15T00:00:00Z';
  msTask.body = { contentType: 'text', content: 'alpha\r\nbeta\r\nCHARLIE-m\n\n' + block };
  msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
  assert.equal(gPatches.length, 1, 'CRLF must not collapse the merge into a conflict');
  assert.equal(msPatches.length, 1);
  assert.equal(gPatches[0].notes, merged + '\n\n' + block);
  // A text body stays text: the payload keeps the provider's contentType and
  // LF endings (field-merge keeps the body type verbatim).
  assert.equal(msPatches[0].body.contentType, 'text');
  assert.equal(msPatches[0].body.content, merged + '\n\n' + block);
  assert.equal(rec.nfp, c.ordinaryFingerprintHex_(merged));
  assert.equal(cache.store.get('tts-notes-base-v1:g-task'), merged);
});

test('composed output is re-parsed before any write and a duplicate separator blocks the write', () => {
  const c = load();
  // Unit: the write-safety check itself.
  assert.equal(c.notesDiff3WriteSafe_('hello world'), true);
  assert.equal(c.notesDiff3WriteSafe_('user\n\n' + BLOCK), true);
  assert.equal(c.notesDiff3WriteSafe_(''), true);
  assert.equal(c.notesDiff3WriteSafe_('user\n\n' + BLOCK + '\n\n' + BLOCK), false);
  assert.equal(c.notesDiff3WriteSafe_('user\n--- tasks-todo-sync ---\ndangling'), false);

  // Wiring: a successful merge whose composed output fails the re-parse is
  // blocked on both sides with zero writes (fail-closed, no data loss).
  const cache = memoryCache();
  const { state, gTask, msTask } = pair(c);
  gTask.notes = 'alpha\nbeta\ncharlie';
  msTask.body = { contentType: 'text', content: 'alpha\nbeta\ncharlie' };
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {}, diff3Options(cache));
  const rec = state.g2m['g-task'];
  stubReads(c, gTask, msTask);
  const { gPatches, msPatches } = stubWrites(c);
  gTask.notes = 'ALPHA-g\nbeta\ncharlie';
  gTask.updated = '2026-08-15T00:00:00Z';
  msTask.body = { contentType: 'text', content: 'alpha\nbeta\nCHARLIE-m' };
  msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  // Simulate a composed output that would stack separators: the guard must
  // veto the notes writes for this round.
  const originalGuard = c.notesDiff3WriteSafe_;
  c.notesDiff3WriteSafe_ = () => false;
  try {
    const result = c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {}, diff3Options(cache));
    assert.equal(gPatches.length + msPatches.length, 0);
    assert.ok(result.plan.skipped.some((row) => row.field === 'notes' && row.reason === 'NOTES_UNMERGEABLE'));
    assert.equal(gTask.notes.includes('CHARLIE-m'), false);
    assert.equal(msTask.body.content.includes('ALPHA-g'), false);
  } finally {
    c.notesDiff3WriteSafe_ = originalGuard;
  }
});

test('same-line edits from both sides still conflict, and with the knob off behavior is unchanged', () => {
  const c = load();
  const cacheA = memoryCache();

  // Part A — knob ON: identical baseline, same line edited on both sides.
  const a = pair(c);
  a.gTask.notes = 'alpha\nbeta\ncharlie';
  a.msTask.body = { contentType: 'text', content: 'alpha\nbeta\ncharlie' };
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(a.state, a.state.g2m['g-task'], a.gTask, a.msTask, 'g-list', {}, diff3Options(cacheA));
  const recA = a.state.g2m['g-task'];
  const { gPatches: gA, msPatches: mA } = stubWrites(c);
  a.gTask.notes = 'alpha\nBETA-g\ncharlie';
  a.gTask.updated = '2026-08-15T00:00:00Z';
  a.msTask.body = { contentType: 'text', content: 'alpha\nBETA-m\ncharlie' };
  a.msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(a.state, recA, a.gTask, a.msTask, 'g-list', {}, diff3Options(cacheA));
  assert.equal(gA.length + mA.length, 0);
  assert.equal(recA.fc.notes.kind, 'TRUE_FIELD_CONFLICT');
  // A conflict round does not refresh the baseline.
  assert.equal(cacheA.store.get('tts-notes-base-v1:g-task'), 'alpha\nbeta\ncharlie');
  assert.equal(recA.nfp, c.ordinaryFingerprintHex_('alpha\nbeta\ncharlie'));

  // Part B — knob OFF: byte-identical legacy behavior, zero cache traffic,
  // no new mapping fields.
  const cacheB = memoryCache();
  const b = pair(c);
  b.gTask.notes = 'alpha\nbeta\ncharlie';
  b.msTask.body = { contentType: 'text', content: 'alpha\nbeta\ncharlie' };
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(b.state, b.state.g2m['g-task'], b.gTask, b.msTask, 'g-list', {});
  const recB = b.state.g2m['g-task'];
  const { gPatches: gB, msPatches: mB } = stubWrites(c);
  b.gTask.notes = 'alpha\nBETA-g\ncharlie';
  b.gTask.updated = '2026-08-15T00:00:00Z';
  b.msTask.body = { contentType: 'text', content: 'alpha\nBETA-m\ncharlie' };
  b.msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(b.state, recB, b.gTask, b.msTask, 'g-list', {});
  assert.equal(gB.length + mB.length, 0);
  assert.equal(recB.fc.notes.kind, 'TRUE_FIELD_CONFLICT');
  assert.equal(Object.prototype.hasOwnProperty.call(recB, 'nfp'), false);
  assert.equal(cacheB.calls.get, 0);
  assert.equal(cacheB.calls.put, 0);

  // Part C — knob OFF, one-sided notes change: the exact legacy payload.
  const d = pair(c);
  stubReads(c, d.gTask, d.msTask);
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(d.state, d.state.g2m['g-task'], d.gTask, d.msTask, 'g-list', {});
  const writesD = stubWrites(c);
  d.gTask.notes = 'edited from google';
  d.gTask.updated = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(d.state, d.state.g2m['g-task'], d.gTask, d.msTask, 'g-list', {});
  assert.equal(writesD.msPatches.length, 1);
  assert.equal(writesD.msPatches[0].body.content, c.textToHtml_('edited from google'));
  assert.equal(Object.prototype.hasOwnProperty.call(d.state.g2m['g-task'], 'nfp'), false);
});
