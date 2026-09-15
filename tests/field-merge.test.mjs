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
  c.createMsLinkedResourceNoRetry_ = () => { throw new Error('native linkedResources create must not run'); };
  return { gPatches, msPatches };
}

test('Step 2B recurrence classification is INSUFFICIENT_EVIDENCE both directions', () => {
  const c = load();
  const report = c.step2bRecurrenceClassification_();
  assert.equal(report.microsoftOwner, 'INSUFFICIENT_EVIDENCE');
  assert.equal(report.googleOwner, 'INSUFFICIENT_EVIDENCE');
  assert.equal(report.implementRecurrenceEngine, false);
  assert.equal(report.implementSuccessorMatcher, false);
  assert.equal(report.implementRuleTranslator, false);
});

test('one-side title change writes that field only', () => {
  const c = load();
  const { state, gTask, msTask } = pair(c);
  const { gPatches, msPatches } = stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  assert.equal(gPatches.length + msPatches.length, 0);
  gTask.title = 'Google only';
  gTask.updated = '2026-08-15T00:00:00Z';
  const rec = state.g2m['g-task'];
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {});
  assert.equal(gPatches.length, 0);
  assert.equal(msPatches.length, 1);
  assert.deepEqual(Object.keys(msPatches[0]), ['title']);
  assert.equal(msPatches[0].title, 'Google only');
});

test('equal both-sides values advance fingerprints without a write', () => {
  const c = load();
  const { state, gTask, msTask } = pair(c);
  const { gPatches, msPatches } = stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  const titleFp = state.g2m['g-task'].fp.title;
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.equal(state.g2m['g-task'].fp.v, 1);
  assert.match(titleFp, /^[0-9a-f]{32}$/);
  gTask.title = 'Both';
  msTask.title = 'Both';
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.notEqual(state.g2m['g-task'].fp.title, titleFp);
});

test('true same-field divergence conflicts without a timestamp LWW write', () => {
  const c = load();
  const { state, gTask, msTask } = pair(c);
  const { gPatches, msPatches } = stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  gTask.title = 'Google';
  msTask.title = 'Microsoft';
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.equal(state.g2m['g-task'].fc.title.kind, 'TRUE_FIELD_CONFLICT');
});

test('unknown baseline plus divergence is a bootstrap conflict not LWW', () => {
  const c = load();
  const { state, gTask, msTask } = pair(c);
  const { gPatches, msPatches } = stubWrites(c);
  gTask.title = 'Google';
  msTask.title = 'Microsoft';
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  assert.equal(gPatches.length + msPatches.length, 0);
  assert.equal(state.g2m['g-task'].fc.title.kind, 'BOOTSTRAP_CONFLICT');
});

test('one-side notes change keeps the owned managed resource block on the PATCH payload', () => {
  const c = load();
  const block = [
    '--- tasks-todo-sync related resources (v1) ---',
    'Microsoft To Do links',
    '- Example',
    '  https://example.invalid/file',
    '--- end tasks-todo-sync related resources ---'
  ].join('\n');
  const blockFp = c.managedBlockFingerprint_(block);

  const msTarget = pair(c, { res: { msBlockFp: blockFp } });
  const { gPatches, msPatches } = stubWrites(c);
  msTarget.msTask.body = { contentType: 'text', content: 'note\n\n' + block };
  msTarget.msTask.linkedResources = [];
  c.ordinaryReconcileMappedPair_(msTarget.state, msTarget.state.g2m['g-task'],
    msTarget.gTask, msTarget.msTask, 'g-list', {});
  msTarget.gTask.notes = 'edited user notes';
  msTarget.gTask.updated = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(msTarget.state, msTarget.state.g2m['g-task'],
    msTarget.gTask, msTarget.msTask, 'g-list', {});
  assert.equal(gPatches.length, 0);
  assert.equal(msPatches.length, 1);
  const composedMs = c.composeManagedNotes_('edited user notes', block);
  assert.equal(msPatches[0].body.content, composedMs);

  const gTarget = pair(c, { res: { gBlockFp: blockFp } });
  const gWrites = stubWrites(c);
  gTarget.gTask.notes = 'note\n\n' + block;
  gTarget.msTask.linkedResources = [];
  c.ordinaryReconcileMappedPair_(gTarget.state, gTarget.state.g2m['g-task'],
    gTarget.gTask, gTarget.msTask, 'g-list', {});
  gTarget.msTask.body = { contentType: 'text', content: 'edited from microsoft' };
  gTarget.msTask.lastModifiedDateTime = '2026-08-15T00:00:00Z';
  c.ordinaryReconcileMappedPair_(gTarget.state, gTarget.state.g2m['g-task'],
    gTarget.gTask, gTarget.msTask, 'g-list', {});
  assert.equal(gWrites.msPatches.length, 0);
  assert.equal(gWrites.gPatches.length, 1);
  const composedG = c.composeManagedNotes_('edited from microsoft', block);
  assert.equal(gWrites.gPatches[0].notes, composedG);
});

test('schema 4 mapping extras survive normalizeState_', () => {
  const c = load();
  const { state, gTask, msTask } = pair(c);
  stubWrites(c);
  c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  const normalized = c.normalizeState_(JSON.parse(JSON.stringify(state)));
  assert.equal(normalized.schema, 4);
  assert.match(normalized.g2m['g-task'].fp.title, /^[0-9a-f]{32}$/);
});
