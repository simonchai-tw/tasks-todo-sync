import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* W4 coverage: the managed-resource write intent must be persisted BEFORE the
 * provider call and promoted to a confirmed fingerprint only after the
 * provider's own readback matches it.  Before this change the intent fields were
 * read but never written, so a crash between the PATCH and the round commit left
 * a block the engine could not recognise as its own. */

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

// A Google side that actually carries resources, so the plan intends a block.
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

test('the plan reports the block it intends to write, per side', () => {
  const c = load();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list' };
  const plan = c.planResourceProjection_(gTaskWithLink(), msTaskPlain(), rec, {}, null, null);

  assert.equal(plan.writeMicrosoft, true, 'the Microsoft side needs the block');
  assert.match(plan.blockIntent.microsoft, /^[0-9a-f]{32}$/, 'an intended Microsoft block fingerprint');
  assert.equal(plan.blockIntent.google, null, 'nothing is intended on the Google side');
});

test('no write intent is produced when the plan writes nothing', () => {
  const c = load();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list' };
  const plainG = { id: 'g-task', title: 'Same', notes: 'user notes', status: 'needsAction', updated: '2026-08-14T00:00:00Z' };
  const plan = c.planResourceProjection_(plainG, msTaskPlain(), rec, {}, null, null);

  assert.equal(plan.writeMicrosoft, false);
  assert.equal(plan.blockIntent.microsoft, null);
  assert.equal(plan.blockIntent.google, null);
});

test('the write intent is persisted BEFORE the provider call, then confirmed by readback', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  const events = [];
  c.persistSyncState_ = () => { events.push('save:' + JSON.stringify(rec.res || {})); };
  c.updateMsTask_ = (listId, taskId, payload) => {
    events.push('write:intent=' + String(rec.res && rec.res.msBlockIntentFp));
    // The provider stores exactly what it was sent, so the readback matches.
    return {
      id: taskId, title: 'Same', status: 'notStarted',
      lastModifiedDateTime: '2026-08-15T00:00:00Z',
      body: { contentType: 'text', content: payload.body.content }
    };
  };

  c.ordinaryReconcileMappedPair_(state, rec, gTaskWithLink(), msTaskPlain(), 'g-list', {});

  assert.equal(events.length, 2, 'exactly one checkpoint and one write');
  assert.match(events[0], /^save:/, 'the checkpoint must come first');
  assert.match(events[1], /^write:/, 'the provider call must come second');
  assert.match(events[1], /intent=[0-9a-f]{32}/, 'the intent must already be stored when the provider is called');

  assert.match(rec.res.msBlockFp, /^[0-9a-f]{32}$/, 'the readback confirmed the block');
  assert.equal(rec.res.msBlockIntentFp, undefined, 'a confirmed intent is cleared');
});

test('a failed write keeps the intent and never advances the confirmed fingerprint', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  c.persistSyncState_ = () => {};
  c.updateMsTask_ = () => { throw new Error('HTTP 500: nope'); };

  assert.throws(
    () => c.ordinaryReconcileMappedPair_(state, rec, gTaskWithLink(), msTaskPlain(), 'g-list', {}),
    /HTTP 500/
  );

  assert.match(rec.res.msBlockIntentFp, /^[0-9a-f]{32}$/, 'the intent survives the failed write');
  assert.equal(rec.res.msBlockFp, undefined, 'an unconfirmed write must not advance the baseline');
});

test('a readback that lost the block keeps the intent instead of trusting the write', () => {
  const c = load();
  const state = mkState(c);
  const rec = state.g2m['g-task'];
  c.persistSyncState_ = () => {};
  c.updateMsTask_ = (listId, taskId, payload) => ({
    id: taskId, title: 'Same', status: 'notStarted',
    lastModifiedDateTime: '2026-08-15T00:00:00Z',
    // The provider accepted the call but did not keep the block.
    body: { contentType: 'text', content: 'user notes' }
  });

  c.ordinaryReconcileMappedPair_(state, rec, gTaskWithLink(), msTaskPlain(), 'g-list', {});

  assert.match(rec.res.msBlockIntentFp, /^[0-9a-f]{32}$/, 'the intent is retained');
  assert.equal(rec.res.msBlockFp, undefined, 'a mismatched readback must not advance the baseline');
});

test('a stored intent lets a crash-orphaned block be recognised as ours', () => {
  const c = load();
  const block = [c.RESOURCE_BLOCK_BEGIN_, '- [One](https://example.com/one)', c.RESOURCE_BLOCK_END_].join('\n');
  const notes = 'user notes\n\n' + block;
  const fp = c.managedBlockFingerprint_(block);

  // Without an intent and without a prior confirmed fingerprint the block reads
  // as UNOWNED, and notesWriteAllowed_ refuses every later projection.
  const orphaned = c.parseManagedResourceBlock_(notes, null, null);
  assert.equal(orphaned.status, c.RESOURCE_BLOCK_STATUS_.UNOWNED);
  assert.equal(c.notesWriteAllowed_(orphaned.status), false, 'the projection would be blocked');

  // With the persisted intent the same block is recognised as owned.
  const recovered = c.parseManagedResourceBlock_(notes, null, fp);
  assert.equal(recovered.status, c.RESOURCE_BLOCK_STATUS_.OWNED);
  assert.equal(c.notesWriteAllowed_(recovered.status), true);
  assert.equal(recovered.blockFp, fp, 'the recovered fingerprint can be promoted to confirmed');
});
