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
  return { c, script };
}

test('managed resource block is stripped before notes fingerprint and merge', () => {
  const { c } = load();
  const block = [
    '--- tasks-todo-sync ---',
    'Microsoft To Do links',
    '- Example',
    '  https://example.invalid/file',
    '--- tasks-todo-sync end ---'
  ].join('\n');
  const fp = c.managedBlockFingerprint_(block);
  const parsed = c.parseManagedResourceBlock_('User note\n\n' + block, fp, null);
  assert.equal(parsed.status, 'OWNED');
  assert.equal(parsed.canonicalUserNotes, 'User note');
  const rec = { res: { gBlockFp: fp } };
  const proj = c.ordinaryProjectGoogle_({ title: 'T', notes: 'User note\n\n' + block, status: 'needsAction' }, rec);
  const plain = c.ordinaryProjectGoogle_({ title: 'T', notes: 'User note', status: 'needsAction' }, {});
  assert.equal(proj.notes, plain.notes);
  assert.equal(c.ordinaryFieldFp_(proj, 'notes'), c.ordinaryFieldFp_(plain, 'notes'));
});

test('native linkedResources create remains uninvoked while the flag is off or on', () => {
  const { c, script } = load();
  script.setProperty('SYNC_ENABLE_NATIVE_LINKED_RESOURCES', 'true');
  const safety = c.getSafetyConfig_();
  assert.equal(safety.enableNativeLinkedResources, true);
  assert.equal(c.nativeLinkedResourceCreateEffective_(safety), false);
  let creates = 0;
  c.createMsLinkedResourceNoRetry_ = () => { creates += 1; return { id: 'lr' }; };
  const gTask = {
    id: 'g-task', title: 'Same', notes: 'note', status: 'needsAction',
    links: [{ type: 'email', description: 'Mail', link: 'https://mail.google.com/x' }]
  };
  const msTask = {
    id: 'ms-task', title: 'Same', body: { contentType: 'text', content: 'note' },
    status: 'notStarted', linkedResources: []
  };
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list' };
  const plan = c.planResourceProjection_(gTask, msTask, rec, safety, 'note', 'note');
  assert.equal(plan.nativeCreate, false);
  assert.equal(creates, 0);
  assert.equal(plan.writeMicrosoft, true);
  assert.equal(plan.microsoftBody.content.includes('--- tasks-todo-sync ---'), true);
});

test('MS linkedResources observation opens the M->G branch; unobserved stays closed', () => {
  const { c } = load();
  const gTask = {
    id: 'g-task', title: 'Same', notes: 'note', status: 'needsAction'
  };
  const msTask = {
    id: 'ms-task', title: 'Same', body: { contentType: 'text', content: 'note' },
    status: 'notStarted'
  };
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list' };
  // Unobserved (no observation arg): M->G branch closed, same as before the wiring.
  const closed = c.planResourceProjection_(gTask, msTask, rec, {}, 'note', 'note');
  assert.ok(closed.diagnostic.indexOf('INCOMPLETE_MICROSOFT_RESOURCE_OBSERVATION') >= 0);
  assert.equal(closed.writeGoogle, false);
  // Observed with one link: the managed block is planned onto the Google notes.
  const observed = c.planResourceProjection_(gTask, msTask, rec, {}, 'note', 'note',
    { kind: 'OBSERVED_COMPLETE', items: [{ id: 'lr-1', displayName: 'https://example.com/doc', webUrl: 'https://example.com/doc' }] });
  assert.equal(observed.diagnostic.indexOf('INCOMPLETE_MICROSOFT_RESOURCE_OBSERVATION'), -1);
  assert.equal(observed.writeGoogle, true);
  assert.match(observed.googleNotes, /--- tasks-todo-sync ---/);
  assert.match(observed.googleNotes, /https:\/\/example\.com\/doc/);
  // Observed-but-empty: a real empty set, projects an empty (or unchanged) block, not the gate.
  const empty = c.planResourceProjection_(gTask, msTask, rec, {}, 'note', 'note',
    { kind: 'OBSERVED_COMPLETE', items: [] });
  assert.equal(empty.diagnostic.indexOf('INCOMPLETE_MICROSOFT_RESOURCE_OBSERVATION'), -1);
});

test('malformed managed block fails closed and does not merge notes', () => {
  const { c } = load();
  const parsed = c.parseManagedResourceBlock_(
    '--- tasks-todo-sync ---\nbroken',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    null
  );
  assert.equal(parsed.status, 'RESOURCE_BLOCK_MALFORMED');
  const notes = c.ordinaryUserNotesFromGoogle_({ notes: '--- tasks-todo-sync ---\nbroken' }, {
    res: { gBlockFp: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  });
  assert.equal(notes.ok, false);
});

test('default native linked resources flag is off', () => {
  const { c } = load();
  assert.equal(c.getSafetyConfig_().enableNativeLinkedResources, false);
});
