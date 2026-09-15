import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* The M->G resource observation scheduler (sync.gs) spends a bounded per-round
 * budget on the linkedResources collection GET and rotates the starting point
 * across rounds so no pair starves.  These tests exercise the REAL scheduler
 * (buildResourceObservationSnapshot_ / currentResourceObservation_ /
 * clearResourceObservationSnapshot_) and the durable rotation cursor. */

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

function scenario(c, pairCount) {
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  const snap = { msTasksById: {}, msListByTask: {} };
  for (let i = 0; i < pairCount; i += 1) {
    const gId = 'g-' + String(i).padStart(2, '0');
    const msId = 'ms-' + String(i).padStart(2, '0');
    state.g2m[gId] = {
      msId, gListId: 'g-list', msListId: 'ms-list',
      gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
    };
    state.m2g[msId] = gId;
    snap.msTasksById[msId] = { id: msId, title: gId };
    snap.msListByTask[msId] = 'ms-list';
  }
  return { state, snap };
}

function stubReads(c, calls, options = {}) {
  c.getMsTaskLinkedResources_ = (listId, taskId) => {
    calls.push(taskId);
    if (options.failFor && options.failFor.indexOf(taskId) >= 0) throw new Error('HTTP 503: read failed');
    return { kind: 'OBSERVED_COMPLETE', items: [{ id: 'lr-' + taskId, displayName: taskId, webUrl: 'https://example.com/' + taskId }] };
  };
  if (options.attachments) {
    c.getMsTaskAttachments_ = (listId, taskId) => {
      if (options.attachmentFailFor && options.attachmentFailFor.indexOf(taskId) >= 0) throw new Error('HTTP 404: attachments unavailable');
      return { kind: 'OBSERVED_COMPLETE', items: [{ id: 'att-' + taskId, name: taskId }] };
    };
  } else {
    delete c.getMsTaskAttachments_;
  }
}

test('the per-round budget bounds reads and the cursor rotates so every pair is covered', () => {
  const c = load();
  const { state, snap } = scenario(c, 12);
  const calls = [];
  stubReads(c, calls);
  c.remainingTimeOk_ = () => true;
  const startedAt = Date.now();

  c.buildResourceObservationSnapshot_(state, snap, startedAt);
  const round1 = Object.keys(state.g2m).sort().filter((gId) => c.currentResourceObservation_(state.g2m[gId]) !== undefined);
  assert.equal(round1.length, 10, 'the per-round budget caps observation at 10 pairs');
  assert.equal(calls.length, 10, 'no more provider reads than the budget allows');
  assert.equal(state.resourceObservationCursor, 10, 'the cursor advances by what was observed');
  c.clearResourceObservationSnapshot_();

  calls.length = 0;
  c.buildResourceObservationSnapshot_(state, snap, startedAt);
  const round2 = Object.keys(state.g2m).sort().filter((gId) => c.currentResourceObservation_(state.g2m[gId]) !== undefined);
  assert.equal(round2.length, 10);
  const union = new Set([...round1, ...round2]);
  assert.equal(union.size, 12, 'two rounds cover all 12 pairs: the last two are not starved');
  assert.deepEqual(calls.slice(0, 2), ['ms-10', 'ms-11'],
    'round 2 starts reading at the cursor, not at the head of the list');
});

test('an exhausted time budget observes nothing and never advances the cursor', () => {
  const c = load();
  const { state, snap } = scenario(c, 12);
  const calls = [];
  stubReads(c, calls);
  c.remainingTimeOk_ = () => false;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  assert.equal(calls.length, 0, 'no provider read is attempted without budget');
  assert.equal(state.resourceObservationCursor, 0, 'a budget stop must not advance the cursor');
  assert.equal(c.currentResourceObservation_(state.g2m['g-00']), undefined,
    'an unobserved pair reads as UNOBSERVED, closing M->G for it');
});

test('a failed read leaves only that pair UNOBSERVED while its neighbours are observed', () => {
  const c = load();
  const { state, snap } = scenario(c, 3);
  const calls = [];
  stubReads(c, calls, { failFor: ['ms-01'] });
  c.remainingTimeOk_ = () => true;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  assert.equal(c.currentResourceObservation_(state.g2m['g-00']).kind, 'OBSERVED_COMPLETE');
  assert.equal(c.currentResourceObservation_(state.g2m['g-01']), undefined, 'the failed pair is UNOBSERVED');
  assert.equal(c.currentResourceObservation_(state.g2m['g-02']).kind, 'OBSERVED_COMPLETE');
  // The cursor is a position within the sorted pair list (mod n), so a full
  // sweep of 3 pairs lands back on 0 and the next round restarts at the head.
  assert.equal(state.resourceObservationCursor, 0, 'a failed read still consumes its turn');
});

test('an attachment read failure keeps the linked-resource observation with attachments UNOBSERVED', () => {
  const c = load();
  const { state, snap } = scenario(c, 2);
  const calls = [];
  stubReads(c, calls, { attachments: true, attachmentFailFor: ['ms-00'] });
  c.remainingTimeOk_ = () => true;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  const withAttachmentFailure = c.currentResourceObservation_(state.g2m['g-00']);
  assert.equal(withAttachmentFailure.kind, 'OBSERVED_COMPLETE', 'linked resources are still observed');
  assert.equal(withAttachmentFailure.attachments, null, 'the attachment section alone is UNOBSERVED');
  const normal = c.currentResourceObservation_(state.g2m['g-01']);
  assert.equal(normal.attachments.kind, 'OBSERVED_COMPLETE');
  assert.equal(normal.attachments.items.length, 1);
});

test('an observed-but-empty collection is a fact, not an absence of observation', () => {
  const c = load();
  const { state, snap } = scenario(c, 1);
  c.getMsTaskLinkedResources_ = () => ({ kind: 'OBSERVED_COMPLETE', items: [] });
  delete c.getMsTaskAttachments_;
  c.remainingTimeOk_ = () => true;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  const observation = c.currentResourceObservation_(state.g2m['g-00']);
  assert.equal(observation.kind, 'OBSERVED_COMPLETE');
  assert.deepEqual(JSON.parse(JSON.stringify(observation.items)), []);
  assert.equal(observation.attachments, null);
});

test('the transient snapshot never survives a round and is not part of persisted state', () => {
  const c = load();
  const { state, snap } = scenario(c, 3);
  const calls = [];
  stubReads(c, calls);
  c.remainingTimeOk_ = () => true;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  assert.notEqual(c.currentResourceObservation_(state.g2m['g-00']), undefined);
  c.clearResourceObservationSnapshot_();
  assert.equal(c.currentResourceObservation_(state.g2m['g-00']), undefined,
    'nothing is readable once the round is over');
  assert.equal(JSON.stringify(state).includes('lr-ms-00'), false,
    'no observed resource content is persisted into state');
  assert.equal(typeof state.resourceObservationCursor, 'number', 'only the cursor is durable');
});

test('a persisted cursor resumes rotation instead of restarting at the head', () => {
  const c = load();
  const { state, snap } = scenario(c, 12);
  const calls = [];
  stubReads(c, calls);
  c.remainingTimeOk_ = () => true;
  state.resourceObservationCursor = 5;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  assert.deepEqual(calls.slice(0, 2), ['ms-05', 'ms-06'], 'rotation resumes at the stored cursor');
  assert.equal(state.resourceObservationCursor, 15 % 12);
});

test('pairs whose Microsoft task is absent this round are not read at all', () => {
  const c = load();
  const { state, snap } = scenario(c, 4);
  delete snap.msTasksById['ms-02'];
  const calls = [];
  stubReads(c, calls);
  c.remainingTimeOk_ = () => true;

  c.buildResourceObservationSnapshot_(state, snap, Date.now());
  assert.equal(calls.indexOf('ms-02'), -1, 'a pair with no live Microsoft task is skipped');
  assert.equal(c.currentResourceObservation_(state.g2m['g-02']), undefined);
  // 3 eligible pairs were swept, so the position wraps back to the head.
  assert.equal(state.resourceObservationCursor, 0);
});
