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
  const script = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; }, getProperties() { return { ...this.values }; }, getKeys() { return Object.keys(this.values); }, setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); }, deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; } };
  const user = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; }, getProperties() { return { ...this.values }; }, getKeys() { return Object.keys(this.values); }, setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); }, deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; } };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      newBlob: blob,
      gzip: (b) => blob(gzipSync(Buffer.from(b.getBytes()))),
      ungzip: (b) => blob(gunzipSync(Buffer.from(b.getBytes()))),
      base64Encode: (d) => Buffer.from(typeof d === 'string' ? d : d).toString('base64'),
      base64Decode: (d) => Array.from(Buffer.from(d, 'base64')),
      computeDigest: (_a, d) => Array.from(createHash('sha256').update(d, 'utf8').digest()),
      formatDate: (date, tz, format) => {
        const d = new Date(date);
        if (format === 'yyyy-MM-dd') return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
        return `${parts.find((p) => p.type === 'hour')?.value || '00'}:${parts.find((p) => p.type === 'minute')?.value || '00'}:${parts.find((p) => p.type === 'second')?.value || '00'}`;
      },
      sleep() {}
    }
  });
  runGasFilesInContext(c);
  return c;
}

const HEX32 = 'a'.repeat(32);
const HEX32B = 'b'.repeat(32);

function legacyState(c) {
  // The engine's own newState_() guarantees the full schema-4 shape; only the
  // legacy Time Bridge parts are injected.
  const state = c.newState_();
  state.listMap['g-list'] = 'ms-list';
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: { v: 1 },
    // Exactly what a v0.7.5 record looks like: ownership tri-state plus the
    // projection fingerprints.
    rem: { ms: true, msAt: '2026-09-22T07:30:00.000Z', hasTime: true, e: HEX32, eFp: HEX32B }
  };
  state.m2g['ms-task'] = 'g-task';
  state.timeBridgeJournal = { opId: HEX32, pairId: 'g-task', stage: 'INTENT_PERSISTED', retryCount: 0, intent: { duePayload: { dateTime: '2026-10-01T15:30:00', timeZone: 'Asia/Taipei' }, acquireOwnership: true, targetInstantMs: 1 } };
  state.deadLetterJournal = [{ opId: HEX32B, pairId: 'g-task', stage: 'MS_PATCHED', retryCount: 3, failedAt: '2026-09-22T00:00:00.000Z', reason: 'MS_PATCH_EXHAUSTED', intent: { duePayload: { dateTime: '2026-10-01T15:30:00', timeZone: 'Asia/Taipei' }, acquireOwnership: true, targetInstantMs: 1 } }];
  return state;
}

test('a v0.7.5 record rebuilds rec.td from the Microsoft side and drops the legacy keys (§4)', () => {
  const c = load();
  const state = legacyState(c);
  const snap = { gTasksById: { 'g-task': { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' } }, msTasksById: { 'ms-task': { id: 'ms-task', title: 'T', dueDateTime: { dateTime: '2026-10-01T15:30:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' } } };

  const result = c.timeBridgeMigrateLegacyRem_(state, snap, 'Asia/Taipei', 'Asia/Taipei');
  assert.equal(result.rebuilt, 1);
  assert.equal(result.cleared, 1);
  assert.equal(result.deadLetterCleared, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)), { date: '2026-10-01', time: '15:30', v: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].rem)), { e: HEX32, eFp: HEX32B }, 'projection fingerprints survive');
  assert.equal(state.timeBridgeJournal, null, 'the journal table is gone');
  assert.equal(state.deadLetterJournal.length, 0, 'the old drawer is emptied (§4.4)');
});

test('date-only and reminder-only Microsoft tasks migrate to the right record', () => {
  const c = load();
  // Midnight due with no reminder: nothing to rebuild.
  const plain = legacyState(c);
  const plainSnap = { gTasksById: { 'g-task': { id: 'g-task', notes: '' } }, msTasksById: { 'ms-task': { id: 'ms-task', dueDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: false } } };
  c.timeBridgeMigrateLegacyRem_(plain, plainSnap, 'Asia/Taipei', 'Asia/Taipei');
  assert.equal(plain.g2m['g-task'].td, undefined, 'a date-only pair gets no time record');
  assert.equal(plain.g2m['g-task'].rem.ms, undefined, 'but the legacy keys are still dropped');

  // A hand-set reminder on a date-only due is the only surviving time signal.
  const reminderOnly = legacyState(c);
  const reminderSnap = { gTasksById: { 'g-task': { id: 'g-task', notes: '' } }, msTasksById: { 'ms-task': { id: 'ms-task', dueDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, reminderDateTime: { dateTime: '2026-10-01T18:00:00', timeZone: 'UTC' } } } };
  c.timeBridgeMigrateLegacyRem_(reminderOnly, reminderSnap, 'Asia/Taipei', 'Asia/Taipei');
  assert.deepEqual(JSON.parse(JSON.stringify(reminderOnly.g2m['g-task'].td)), { date: '2026-10-02', time: '02:00', v: 1 },
    'the reminder wall clock in the project time zone becomes the record');
});

test('the state validator tolerates legacy rem keys while accepting the new record and retry buckets', () => {
  const c = load();
  const legacy = legacyState(c);
  // Loading a v0.7.5 state must not throw: the legacy keys stay accepted on the
  // load path so the first v0.8.0 round can migrate them.
  assert.doesNotThrow(() => c.normalizeState_(legacy));

  const modern = legacyState(c);
  delete modern.timeBridgeJournal;
  delete modern.deadLetterJournal;
  modern.g2m['g-task'].rem = { e: HEX32, eFp: HEX32B };
  modern.g2m['g-task'].td = { date: '2026-10-01', time: '15:30', v: 1, retry: { ms: { fails: 2, lastFailAt: '2026-09-30T00:00:00.000Z', quarantined: false } } };
  modern.calendarProjection = { calendarId: 'test-cal-id', v: 1 };
  assert.doesNotThrow(() => c.normalizeState_(modern));
  assert.deepEqual(JSON.parse(JSON.stringify(modern.g2m['g-task'].td.retry.ms)), { fails: 2, lastFailAt: '2026-09-30T00:00:00.000Z', quarantined: false });

  const broken = legacyState(c);
  broken.g2m['g-task'].td = { date: '2026-10-01', time: '9:30', v: 1 };
  assert.throws(() => c.normalizeState_(broken), /STATE_MALFORMED/);
  const brokenTime = legacyState(c);
  brokenTime.g2m['g-task'].td = { date: '2026-10-01', time: '24:00', v: 1 };
  assert.throws(() => c.normalizeState_(brokenTime), /STATE_MALFORMED/);
});
