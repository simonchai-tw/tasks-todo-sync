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
  const script = {
    values: {},
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; }
  };
  const user = {
    values: {},
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; }
  };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }),
      getUserLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      newBlob: blob,
      gzip: (b) => blob(gzipSync(Buffer.from(b.getBytes()))),
      ungzip: (b) => blob(gunzipSync(Buffer.from(b.getBytes()))),
      base64Encode: (d) => Buffer.from(typeof d === 'string' ? d : d).toString('base64'),
      base64Decode: (d) => Array.from(Buffer.from(d, 'base64')),
      computeDigest: (_a, d) => Array.from(createHash('sha256').update(d, 'utf8').digest()),
      sleep() {},
      getUuid: () => '00000000-0000-4000-8000-000000000000'
    }
  });
  runGasFilesInContext(c);
  c.withGlobalLock_ = (fn) => fn();
  c.assertNoActiveSyncRoundFence_ = () => {};
  return { c, script, user };
}

test('inspect report is bounded and omits titles notes tokens and raw ids', () => {
  const { c } = load();
  const s = c.newState_();
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.createJournal['g:raw-google-child-SECRET'] = {
    phase: 'UNCERTAIN',
    gChildId: 'raw-google-child-SECRET',
    gParentId: 'parent',
    intended: { title: 'Secret Title', completed: false },
    at: 't'
  };
  const entries = c.subtaskInspectEntries_(s);
  assert.equal(entries.length, 1);
  const pub = c.subtaskInspectPublic_(entries[0]);
  const serialized = JSON.stringify(pub);
  assert.equal(serialized.includes('Secret Title'), false);
  assert.equal(serialized.includes('raw-google-child-SECRET'), false);
  assert.equal(pub.kind, 'CREATE');
  assert.equal(pub.phase, 'UNCERTAIN');
  assert.equal(pub.nextSafeAction, 'ABANDON');
  assert.equal(typeof pub.operationRef, 'string');
  assert.match(pub.operationRef, /^subtaskOp_/);
});

test('ABANDON is blocked for REMOTE_CREATED create and REMOTE_DELETED delete', () => {
  const { c } = load();
  const s = c.newState_();
  s.subtasks.createJournal.job = {
    phase: 'REMOTE_CREATED', gChildId: 'child', msChecklistId: 'check', gParentId: 'parent',
    intended: { title: 'Child', completed: false }
  };
  s.subtasks.deletionJournal.child = {
    phase: 'REMOTE_DELETED', gChildId: 'child', msChecklistId: 'check', gParentId: 'parent',
    missingSide: 'MICROSOFT'
  };
  const create = c.subtaskInspectEntries_(s).find((e) => e.kind === 'CREATE');
  const del = c.subtaskInspectEntries_(s).find((e) => e.kind === 'DELETE');
  assert.equal(c.subtaskOperationPlan_({ action: 'ABANDON', revision: create.revision }, create).code,
    'SUBTASK_OPERATION_ABANDON_REMOTE_CREATED');
  assert.equal(c.subtaskOperationPlan_({ action: 'ABANDON', revision: del.revision }, del).code,
    'SUBTASK_OPERATION_ABANDON_REMOTE_DELETED');
});

test('apply is local-only and never calls provider POST PATCH DELETE', () => {
  const { c, script } = load();
  const s = c.newState_();
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.createJournal.pending = {
    phase: 'UNCERTAIN', gChildId: 'child', gParentId: 'parent',
    intended: { title: 'Child', completed: false }, at: 't'
  };
  const mutations = [];
  for (const name of [
    'createMsChecklistItemNoRetry_', 'createGChecklistChildNoRetry_',
    'updateMsChecklistItemNoRetry_', 'updateGChecklistChildNoRetry_',
    'deleteMsChecklistItemNoRetry_', 'deleteGChecklistChildNoRetry_',
    'createMsLinkedResourceNoRetry_', 'updateGTask_', 'updateMsTask_',
    'createGTask_', 'createMsTask_', 'deleteGTask_', 'deleteMsTask_'
  ]) {
    c[name] = (...args) => { mutations.push(name); return args[0]; };
  }
  c.saveState_ = (state) => { c.__saved = state; };
  c.loadStateForSync_ = () => s;
  const entry = c.subtaskInspectEntries_(s)[0];
  const operation = {
    action: 'ABANDON',
    operationRef: entry.operationRef,
    revision: entry.revision
  };
  const previewToken = c.subtaskOperationDigest_(operation, entry);
  script.setProperty('SYNC_SUBTASK_OPERATION_JSON', JSON.stringify({ ...operation, previewToken }));
  const report = c.applySubtaskOperation();
  assert.equal(report.applied, true);
  assert.equal(mutations.length, 0);
  assert.equal(s.subtasks.createJournal.pending, undefined);
  assert.equal(s.subtasks.conflicts.child.reason, 'SUBTASK_ABANDONED');
});

test('RESOLVE create commits stored remote identity without a provider POST', () => {
  const { c } = load();
  const s = c.newState_();
  s.g2m.parent = { msId: 'ms-parent', gListId: 'g-list', msListId: 'ms-list' };
  s.subtasks.createJournal['g:child'] = {
    phase: 'REMOTE_CREATED',
    gChildId: 'child',
    msChecklistId: 'check',
    gParentId: 'parent',
    parentMsId: 'ms-parent',
    parentMsListId: 'ms-list',
    intended: { title: 'Child', completed: true },
    at: 't'
  };
  let posts = 0;
  c.createMsChecklistItemNoRetry_ = () => { posts += 1; return { id: 'never' }; };
  const entry = c.subtaskInspectEntries_(s)[0];
  c.subtaskApplyLocalOperation_(s, { action: 'RESOLVE' }, entry, { persist() {} });
  assert.equal(posts, 0);
  assert.equal(s.subtasks.mappings.child.msChecklistId, 'check');
  assert.deepEqual(JSON.parse(JSON.stringify(s.subtasks.mappings.child.base)), { title: 'Child', completed: true });
  assert.equal(s.subtasks.createJournal['g:child'], undefined);
});
