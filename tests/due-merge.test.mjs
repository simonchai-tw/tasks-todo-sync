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

const ON = { enableTimeBridge: true };
const OFF = { enableTimeBridge: false };

test('due is a { date, time } unit and a Microsoft date edit propagates to Google (no carve-out)', () => {
  const c = load();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {}, td: { date: '2026-10-02', time: '15:30', v: 1 } };
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-02T00:00:00.000Z' };
  // The user changed the Microsoft date to 10-03; the time stays 15:30.
  const msTask = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-03T15:30:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' };

  const gProj = c.ordinaryProjectGoogle_(gTask, rec, ON);
  const mProj = c.ordinaryProjectMicrosoft_(msTask, rec, ON);
  assert.deepEqual(JSON.parse(JSON.stringify(gProj.due)), { date: '2026-10-02', time: '15:30' });
  assert.deepEqual(JSON.parse(JSON.stringify(mProj.due)), { date: '2026-10-03', time: '15:30' });

  const plan = c.ordinaryMergeMappedFields_({ v: 1, due: c.ordinaryFieldFp_(gProj, 'due') }, gProj, mProj, rec);
  assert.equal(plan.skipped.some((s) => s.field === 'due'), false, 'the TIME_BRIDGE_OWNED carve-out is gone');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.toGoogle.due)), { date: '2026-10-03', time: '15:30' });

  // Google only ever receives the date; the time travels with the unit.
  const gPayload = c.ordinaryGooglePatchFromPlan_(plan);
  assert.equal(gPayload.due, '2026-10-03T00:00:00.000Z');

  // A timed due is never written by the merge on the Microsoft side (the
  // renderer owns date + time + reminder in a single payload).
  const msPayload = c.ordinaryMicrosoftPatchFromPlan_(plan);
  assert.equal(Object.prototype.hasOwnProperty.call(msPayload, 'dueDateTime'), false);
});

test('a date-only due is still written to Microsoft by the merge', () => {
  const c = load();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {} };
  // Baseline = the Microsoft value, so the Google edit is the one that travels.
  const msTask = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-03T00:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: false, status: 'notStarted' };
  const mProj = c.ordinaryProjectMicrosoft_(msTask, rec, ON);
  rec.fp = { v: 1, due: c.ordinaryFieldFp_(mProj, 'due') };
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-09T00:00:00.000Z' };
  const plan = c.ordinaryMergeMappedFields_(rec.fp, c.ordinaryProjectGoogle_(gTask, rec, ON), mProj, rec);
  const msPayload = c.ordinaryMicrosoftPatchFromPlan_(plan);
  assert.ok(msPayload.dueDateTime, 'a date-only due keeps the historical merge write');
  assert.equal(msPayload.dueDateTime.dateTime, '2026-10-09T00:00:00');
});

test('both sides changing the due unit in one round is a fail-closed field conflict (R-3, no email)', () => {
  const c = load();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {} };
  const base = c.ordinaryFingerprintHex_('2026-10-02T15:30');
  rec.fp = { v: 1, due: base };
  const gProj = { title: 'T', notes: 'body', notesOk: true, completed: false, due: { date: '2026-10-04', time: '15:30' }, dueOk: true };
  const mProj = { title: 'T', notes: 'body', notesOk: true, completed: false, due: { date: '2026-10-05', time: '15:30' }, dueOk: true };
  const plan = c.ordinaryMergeMappedFields_(rec.fp, gProj, mProj, rec);
  assert.ok(plan.conflicts.some((x) => x.field === 'due' && x.kind === 'TRUE_FIELD_CONFLICT'));
  const stored = c.ordinaryStoreFieldConflicts_(rec, plan, 'g-task');
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), { due: { kind: 'TRUE_FIELD_CONFLICT' } });
  assert.equal(c.ordinaryObservability_({ g2m: { 'g-task': rec } }).fieldConflicts, 1);
});

test('the merge keeps the canonical date in rec.td and drops the time when the date is cleared', () => {
  const c = load();
  const state = {
    schema: 4, listMap: { 'g-list': 'ms-list' },
    g2m: { 'g-task': { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {}, td: { date: '2026-10-02', time: '15:30', v: 1 } } },
    m2g: { 'ms-task': 'g-task' },
    subtasks: { mappings: {}, parents: {}, createJournal: {}, pendingDeletions: {}, deletionJournal: {}, moveJournal: {}, conflicts: {}, tombstones: { g: {}, ms: {} } },
    tombstones: { g: {}, ms: {} }, listFaults: { g: {}, ms: {} }, health: {}
  };
  const rec = state.g2m['g-task'];
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-02T00:00:00.000Z' };
  rec.fp = { v: 1, due: c.ordinaryFieldFp_(c.ordinaryProjectGoogle_(gTask, rec, ON), 'due') };
  // The user cleared the Microsoft date; the merge propagates that to Google and
  // the canonical time record goes with it.
  const msTask = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: null, isReminderOn: false, status: 'notStarted' };
  c.updateGTask_ = (listId, id, payload) => Object.assign({ id }, gTask, payload);
  c.updateMsTask_ = (listId, id, payload) => Object.assign({ id }, msTask, payload);
  c.putMapping_ = () => {};

  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', ON);
  assert.equal(state.g2m['g-task'].td, undefined, 'a cleared date clears the time record');

  // A Microsoft date edit is adopted as the canonical date.
  state.g2m['g-task'].td = { date: '2026-10-02', time: '15:30', v: 1 };
  const gTask2 = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-02T00:00:00.000Z' };
  const msTask2 = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-07T15:30:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' };
  state.g2m['g-task'].fp = { v: 1, due: c.ordinaryFieldFp_(c.ordinaryProjectGoogle_(gTask2, rec, ON), 'due') };
  c.ordinaryReconcileMappedPair_(state, rec, gTask2, msTask2, 'g-list', ON);
  assert.equal(state.g2m['g-task'].td.date, '2026-10-07', 'td.date follows the converged date');
  assert.equal(state.g2m['g-task'].td.time, '15:30', 'the time survives a date move');
});

test('with the bridge off the due unit is date-only on both sides (v0.6.x behaviour)', () => {
  const c = load();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {}, td: { date: '2026-10-02', time: '15:30', v: 1 } };
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-02T00:00:00.000Z' };
  const msTask = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-02T15:30:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' };
  const gProj = c.ordinaryProjectGoogle_(gTask, rec, OFF);
  const mProj = c.ordinaryProjectMicrosoft_(msTask, rec, OFF);
  assert.equal(gProj.due.time, null);
  assert.equal(mProj.due.time, null, 'the Microsoft time is ignored while the bridge is off');
  const plan = c.ordinaryMergeMappedFields_(null, gProj, mProj, rec);
  assert.equal(plan.bootstrapConflicts.length, 0, 'the two sides agree on the date');
  assert.equal(plan.conflicts.length, 0);
});

test('a brand-new pair with a marker time never deadlocks on a due bootstrap conflict', () => {
  const c = load();
  // Round 1 on a new pair: no baseline at all, the Microsoft counterpart was just
  // created date-only, and the time lives only in rec.td.
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {}, td: { date: '2026-10-02', time: '15:30', v: 1 } };
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-02T00:00:00.000Z' };
  const msTask = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-02T00:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: false, status: 'notStarted' };

  const gProj = c.ordinaryProjectGoogle_(gTask, rec, ON);
  const mProj = c.ordinaryProjectMicrosoft_(msTask, rec, ON);
  assert.equal(gProj.due.time, '15:30');
  assert.equal(mProj.due.time, '15:30', 'the merge reads the time from rec.td, not from the provider');
  const plan = c.ordinaryMergeMappedFields_(rec.fp, gProj, mProj, rec);
  assert.equal(plan.bootstrapConflicts.length, 0, 'no bootstrap conflict: the date is the merge unit');
  assert.equal(plan.conflicts.length, 0);
  // The merge must not write a date-only Microsoft due while a time exists — that
  // would strip the time the renderer is about to set.
  const msPayload = c.ordinaryMicrosoftPatchFromPlan_(plan);
  assert.equal(Object.prototype.hasOwnProperty.call(msPayload, 'dueDateTime'), false);

  // A Microsoft-side time edit is adopted by the renderer instead of surfacing as
  // a merge conflict.
  const edited = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-02T18:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' };
  const mEdited = c.ordinaryProjectMicrosoft_(edited, rec, ON);
  assert.equal(mEdited.due.time, '15:30', 'the provider time is invisible to the merge');
  const plan2 = c.ordinaryMergeMappedFields_(rec.fp, gProj, mEdited, rec);
  assert.equal(plan2.conflicts.concat(plan2.bootstrapConflicts).length, 0);
});
