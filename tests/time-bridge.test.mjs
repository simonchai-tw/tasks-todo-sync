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

function loadContext() {
  const script = {
    values: {
      SYNC_TIME_ZONE: 'Asia/Taipei',
      SYNC_TIME_BRIDGE: 'true',
      SYNC_CALENDAR_PROJECTION: 'true'
    },
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; },
    getProperties() { return { ...this.values }; },
    getKeys() { return Object.keys(this.values); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); },
    deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; }
  };
  const user = {
    values: {},
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; },
    getProperties() { return { ...this.values }; },
    getKeys() { return Object.keys(this.values); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); },
    deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; }
  };

  const calendarEvents = {};
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => script,
      getUserProperties: () => user
    },
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
        if (format === 'yyyy-MM-dd') {
          return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        }
        if (format === 'HH:mm:ss') {
          const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
          const h = parts.find((p) => p.type === 'hour')?.value || '00';
          const m = parts.find((p) => p.type === 'minute')?.value || '00';
          const s = parts.find((p) => p.type === 'second')?.value || '00';
          return `${h}:${m}:${s}`;
        }
        return d.toISOString();
      },
      sleep() {}
    },
    Calendar: {
      Events: {
        get(calId, id) {
          if (calendarEvents[id]) return calendarEvents[id];
          const err = new Error('Not found');
          err.statusCode = 404;
          throw err;
        },
        insert(res, calId) {
          calendarEvents[res.id] = { ...res, status: 'confirmed' };
          return calendarEvents[res.id];
        },
        patch(res, calId, id) {
          calendarEvents[id] = { ...(calendarEvents[id] || {}), ...res };
          return calendarEvents[id];
        },
        remove(calId, id) {
          delete calendarEvents[id];
        }
      }
    },
    CalendarApp: {
      getCalendarsByName(name) {
        return [{
          getId: () => 'test-cal-id',
          getName: () => name,
          isOwnedByMe: () => true,
          setTimeZone() {},
          setSelected() {}
        }];
      },
      createCalendar(name) {
        return {
          getId: () => 'created-cal-id',
          getName: () => name,
          isOwnedByMe: () => true,
          setTimeZone() {},
          setSelected() {}
        };
      }
    }
  });

  runGasFilesInContext(c);
  return { c, calendarEvents };
}

test('timeBridgeDeterministicEventId_ produces valid 32-char lowercase hex without negative byte corruptions', () => {
  const { c } = loadContext();
  const id1 = c.timeBridgeDeterministicEventId_('task-12345');
  const id2 = c.timeBridgeDeterministicEventId_('task-12345');
  const id3 = c.timeBridgeDeterministicEventId_('task-67890');

  assert.equal(typeof id1, 'string');
  assert.equal(id1.length, 32);
  assert.match(id1, /^[0-9a-f]{32}$/);
  assert.equal(id1, id2, 'Must be deterministic for identical pairId');
  assert.notEqual(id1, id3, 'Must produce different hash for different pairId');
});

test('timeBridgeParseNotesMarker_ adheres strictly to fail-closed grammar (Spec §2.1)', () => {
  const { c } = loadContext();

  // Valid 24h
  const p1 = c.timeBridgeParseNotesMarker_('[TTS-TIME:15:30]');
  assert.equal(p1.markerValid, true);
  assert.equal(p1.hh, '15');
  assert.equal(p1.mm, '30');
  assert.equal(p1.isNone, false);

  // Zero padded single digit
  const p2 = c.timeBridgeParseNotesMarker_('[TTS-TIME:09:05]');
  assert.equal(p2.markerValid, true);
  assert.equal(p2.hh, '09');
  assert.equal(p2.mm, '05');

  // Fullwidth characters & case insensitivity
  const p3 = c.timeBridgeParseNotesMarker_('［tts-time：19:40］');
  assert.equal(p3.markerValid, true);
  assert.equal(p3.hh, '19');
  assert.equal(p3.mm, '40');

  // NONE keyword
  const pNone = c.timeBridgeParseNotesMarker_('[TTS-TIME:NONE]\nmy notes');
  assert.equal(pNone.markerValid, true);
  assert.equal(pNone.isNone, true);
  assert.equal(pNone.exactMarkerLine, '[TTS-TIME:NONE]');

  // Fail-closed on 00:00
  const pMidnight = c.timeBridgeParseNotesMarker_('[TTS-TIME:00:00]');
  assert.equal(pMidnight.markerValid, false);
  assert.equal(pMidnight.midnightRejected, true);

  // Fail-closed on invalid hour
  const pInvalid = c.timeBridgeParseNotesMarker_('[TTS-TIME:25:00]');
  assert.equal(pInvalid.markerValid, false);

  // Whole notes check: reject if marker appears on lines 2+
  const pLine2 = c.timeBridgeParseNotesMarker_('Legit title line 1\n[TTS-TIME:15:30]\nline 3 notes');
  assert.equal(pLine2.markerValid, false);
  assert.equal(pLine2.wholeNotesRejected, true);
  assert.equal(pLine2.line, 2);
});

test('timeBridgeSpliceNotesMarker_ removes marker and optional trailing blank line', () => {
  const { c } = loadContext();

  const notesWithBlank = '[TTS-TIME:15:30]\n\nThese are user notes.\nLine 2.';
  const splicedWithBlank = c.timeBridgeSpliceNotesMarker_(notesWithBlank, '[TTS-TIME:15:30]');
  assert.equal(splicedWithBlank, 'These are user notes.\nLine 2.');

  const notesWithoutBlank = '[TTS-TIME:15:30]\nDirect notes.';
  const splicedWithoutBlank = c.timeBridgeSpliceNotesMarker_(notesWithoutBlank, '[TTS-TIME:15:30]');
  assert.equal(splicedWithoutBlank, 'Direct notes.');

  const notesOnlyMarker = '[TTS-TIME:15:30]';
  const splicedOnly = c.timeBridgeSpliceNotesMarker_(notesOnlyMarker, '[TTS-TIME:15:30]');
  assert.equal(splicedOnly, '');
});

test('timeBridgeDueHasTime_ correctly distinguishes date-only UTC midnight from wall-clock time', () => {
  const { c } = loadContext();
  const tz = 'Asia/Taipei';

  // Date-only from Microsoft To Do
  const dateOnlyUtc = { dateTime: '2026-09-22T00:00:00.0000000', timeZone: 'UTC' };
  assert.equal(c.timeBridgeDueHasTime_(dateOnlyUtc, tz), false);

  // 08:00 AM Taipei time (which translates to 00:00:00 UTC) must NOT be falsely rejected
  const taipei8am = { dateTime: '2026-09-22T08:00:00', timeZone: 'Asia/Taipei' };
  assert.equal(c.timeBridgeDueHasTime_(taipei8am, tz), true);

  // 15:30 Taipei time
  const taipeiAfternoon = { dateTime: '2026-09-22T15:30:00', timeZone: 'Asia/Taipei' };
  assert.equal(c.timeBridgeDueHasTime_(taipeiAfternoon, tz), true);

  // Midnight in Taipei
  const taipeiMidnight = { dateTime: '2026-09-22T00:00:00', timeZone: 'Asia/Taipei' };
  assert.equal(c.timeBridgeDueHasTime_(taipeiMidnight, tz), false);
});

/* ------------------------------------------------------------------ *
 * v0.8.0 canonical time record: intake, renderers, retry ladder
 * ------------------------------------------------------------------ */

function tbState(gId, recExtra) {
  return {
    schema: 4,
    listMap: { 'g-list': 'ms-list' },
    g2m: { [gId]: Object.assign({ msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {} }, recExtra || {}) },
    m2g: { 'ms-task': gId },
    subtasks: { mappings: {}, parents: {}, createJournal: {}, pendingDeletions: {}, deletionJournal: {}, moveJournal: {}, conflicts: {}, tombstones: { g: {}, ms: {} } },
    tombstones: { g: {}, ms: {} },
    listFaults: { g: {}, ms: {} },
    health: {}
  };
}

function tbSnap(gTask, msTask) {
  return {
    gTasksById: { 'g-task': gTask },
    msTasksById: { 'ms-task': msTask },
    gListByTask: { 'g-task': 'g-list' },
    msListByTask: { 'ms-task': 'ms-list' }
  };
}

test('timeBridgeIntake_ writes rec.td from the marker and never calls a provider (§3.2)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z'); // 12:00 Taipei
  const state = tbState('g-task');
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: '[TTS-TIME:15:30]\nbody', status: 'needsAction', due: '2026-10-01T00:00:00.000Z' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  let remoteCalls = 0;
  c.getGTask_ = () => { remoteCalls += 1; return null; };
  c.updateGTask_ = () => { remoteCalls += 1; return null; };
  c.updateMsTask_ = () => { remoteCalls += 1; return null; };

  const count = c.timeBridgeIntake_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(count, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.g2m['g-task'].td)),
    { date: '2026-10-01', time: '15:30', v: 1 }, // FIXED-DATE-OK
    'the Google due date carries the marker time'
  );
  assert.equal(remoteCalls, 0, 'intake must not touch a remote API');

  // NONE keeps the existing date and clears the time.
  state.g2m['g-task'].td = { date: '2026-10-05', time: '09:00', v: 1 };
  snap.gTasksById['g-task'].notes = '[TTS-TIME:NONE]\nbody';
  c.timeBridgeIntake_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)), { date: '2026-10-05', time: null, v: 1, clear: true },
    'NONE records a pending clear so the renderer wipes our own leftover reminder');

  // A marker below line 1 is rejected fail-closed and leaves the record alone.
  snap.gTasksById['g-task'].notes = 'body\n[TTS-TIME:15:30]';
  c.timeBridgeIntake_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)), { date: '2026-10-05', time: null, v: 1, clear: true });
});

test('timeBridgeSpliceRenderer_ is idempotent and recomputes fp.notes from the final string (§3.3)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z');
  const state = tbState('g-task');
  const marked = '[TTS-TIME:15:30]\nbody';
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: marked, status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  const writes = [];
  c.getGTask_ = () => ({ id: 'g-task', notes: marked });
  c.updateGTask_ = (listId, id, payload) => { writes.push(payload); return { id, notes: payload.notes }; };

  assert.equal(c.timeBridgeSpliceRenderer_(state, snap, 'Asia/Taipei', nowMs), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ notes: 'body' }]);
  assert.equal(state.g2m['g-task'].fp.notes, c.ordinaryFingerprintHex_('body'), 'fp.notes is recomputed, not patched');
  assert.equal(state.g2m['g-task'].td, undefined, 'the splice renderer does not invent a time record');

  // Once the marker is gone the renderer has nothing to do (idempotent).
  snap.gTasksById['g-task'].notes = 'body';
  assert.equal(c.timeBridgeSpliceRenderer_(state, snap, 'Asia/Taipei', nowMs), 0);
  assert.equal(writes.length, 1);
});

test('timeBridgeMsRenderer_ converges due + reminder under the R-1 single rule (§3.4)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-10-01T12:00:00Z'); // 20:00 Taipei
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const msTask = { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' };
  const snap = tbSnap({ id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' }, msTask);
  const patches = [];
  c.updateMsTask_ = (listId, id, payload) => {
    patches.push(payload);
    return Object.assign({ id }, payload, { dueDateTime: payload.dueDateTime, reminderDateTime: payload.reminderDateTime });
  };

  const first = c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(first.patched, 1);
  assert.equal(patches.length, 2, 'reminder and due are separate PATCHes (bug #4)');
  assert.deepEqual(JSON.parse(JSON.stringify(patches[0])), { isReminderOn: true, reminderDateTime: { dateTime: '2026-10-02T07:30:00', timeZone: 'UTC' } });
  assert.equal(patches[1].dueDateTime.dateTime, '2026-10-02T00:00:00', 'the due is date-only on Microsoft');
  assert.equal(patches[1].dueDateTime.timeZone, 'Asia/Taipei');
  assert.equal(JSON.stringify(patches[1]).indexOf('isReminderOn'), -1, 'the due PATCH carries no reminder fields');
  assert.equal(patches[0].reminderDateTime.dateTime, '2026-10-02T07:30:00', 'the alarm carries the time (15:30 Taipei = 07:30Z)');

  // A converged pair is a zero-mutation no-op: due is date-only on Microsoft
  // and the TIME lives in the reminder.
  msTask.dueDateTime = { dateTime: '2026-10-02T00:00:00', timeZone: 'Asia/Taipei' };
  msTask.isReminderOn = true;
  msTask.reminderDateTime = { dateTime: '2026-10-02T07:30:00', timeZone: 'UTC' };
  const second = c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(second.patched, 0);
  assert.equal(patches.length, 2, 'no redundant PATCH once converged');
});

test('R-1 v0.8.2 alarm = the authored instant; the +20 lift fired once at td creation', () => {
  const { c } = loadContext();
  const tz = 'Asia/Taipei';

  // A past time today alarms at its authored instant (no repaint, no drift).
  const nowA = Date.parse('2026-10-01T12:00:00Z'); // 20:00 Taipei
  const targetA = c.timeBridgeMsTarget_({ date: '2026-10-01', time: '15:25', v: 1 }, tz, nowA, tz); // FIXED-DATE-OK
  assert.equal(targetA.isReminderOn, true);
  assert.equal(targetA.reminderDateTime.dateTime, '2026-10-01T07:25:00');

  // 23:36 with a past time today keeps 23:30 — the renderer, not the target,
  // decides a past alarm stays as Microsoft holds it.
  const nowB = Date.parse('2026-10-01T15:36:00Z'); // 23:36 Taipei
  const targetB = c.timeBridgeMsTarget_({ date: '2026-10-01', time: '23:30', v: 1 }, tz, nowB, tz); // FIXED-DATE-OK
  assert.equal(targetB.isReminderOn, true);
  assert.equal(targetB.reminderDateTime.dateTime, '2026-10-01T15:30:00');

  // A long-past date alarms at its authored instant — no epoch sentinel (WO-1).
  const targetD = c.timeBridgeMsTarget_({ date: '2020-01-01', time: '09:00', v: 1 }, tz, nowA, tz);
  assert.equal(targetD.isReminderOn, true);
  assert.equal(JSON.stringify(targetD).indexOf('1970'), -1);
  assert.equal(targetD.reminderDateTime.dateTime, '2020-01-01T01:00:00');

  // date-only (time: null) clears the alarm and never carries a dateTime.
  const targetE = c.timeBridgeMsTarget_({ date: '2026-10-02', time: null, v: 1 }, tz, nowA, tz); // FIXED-DATE-OK
  assert.equal(targetE.isReminderOn, false);
  assert.equal(targetE.reminderDateTime, null);
  assert.equal(targetE.dateTime, '2026-10-02T00:00:00', 'a date-only target still pins the midnight date');
});

test('timeBridgeApplyExpiryLift_ lifts an expired marker once: +20, then +5, then now', () => {
  const { c } = loadContext();
  const tz = 'Asia/Taipei';

  // A marker for 15:25 seen at 20:00 lifts to 20:20 (same day, now+20).
  const tdA = { date: '2026-10-01', time: '15:25', v: 1 }; // FIXED-DATE-OK
  c.timeBridgeApplyExpiryLift_(tdA, tz, Date.parse('2026-10-01T12:00:00Z'));
  assert.deepEqual(tdA, { date: '2026-10-01', time: '20:20', v: 1 }); // FIXED-DATE-OK

  // A future marker is untouched.
  const tdB = { date: '2026-10-02', time: '09:00', v: 1 }; // FIXED-DATE-OK
  c.timeBridgeApplyExpiryLift_(tdB, tz, Date.parse('2026-10-01T12:00:00Z'));
  assert.deepEqual(tdB, { date: '2026-10-02', time: '09:00', v: 1 }); // FIXED-DATE-OK

  // 23:57 building a 09:00 marker: +20 rolls past midnight, +5 as well, so the
  // lift lands on now itself and keeps the alarm on the authored day.
  const tdC = { date: '2026-10-01', time: '09:00', v: 1 }; // FIXED-DATE-OK
  c.timeBridgeApplyExpiryLift_(tdC, tz, Date.parse('2026-10-01T15:57:00Z')); // 23:57 Taipei
  assert.deepEqual(tdC, { date: '2026-10-01', time: '23:57', v: 1 }); // FIXED-DATE-OK

  // 23:59:50 edge (now+5 would also roll): the lift lands on now itself.
  const tdD = { date: '2026-10-01', time: '09:00', v: 1 }; // FIXED-DATE-OK
  c.timeBridgeApplyExpiryLift_(tdD, tz, Date.parse('2026-10-01T15:59:50Z')); // 23:59:50 Taipei
  assert.equal(tdD.date, '2026-10-01'); // FIXED-DATE-OK
  assert.equal(tdD.time, '23:59');

  // A date-only td is left alone.
  const tdE = { date: '2026-10-01', time: null, v: 1 }; // FIXED-DATE-OK
  c.timeBridgeApplyExpiryLift_(tdE, tz, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(tdE.time, null);
});

test('v0.8.2 regression: a past alarm is never repainted and the adopt loop cannot drift', () => {
  const { c } = loadContext();
  const tz = 'Asia/Taipei';
  const nowMs = Date.parse('2026-10-01T12:00:00Z'); // 20:00 Taipei — the 08:00 alarm fired long ago
  const state = tbState('g-task', { td: { date: '2026-10-01', time: '08:00', v: 1 } }); // FIXED-DATE-OK
  const msTask = {
    id: 'ms-task', title: 'Recurring', dueDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'Asia/Taipei' },
    isReminderOn: true, reminderDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' }, status: 'notStarted'
  };
  const snap = tbSnap({ id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' }, msTask);
  const patches = [];
  c.updateMsTask_ = (listId, id, payload) => { patches.push(payload); return { id }; };

  const first = c.timeBridgeMsRenderer_(state, snap, tz, nowMs, tz);
  assert.equal(first.patched, 0, 'a past alarm is left exactly as Microsoft holds it');
  assert.equal(patches.length, 0);
  assert.deepEqual(state.g2m['g-task'].td, { date: '2026-10-01', time: '08:00', v: 1 }, 'adopt must not read our own stale reminder back as a user edit'); // FIXED-DATE-OK

  // The old +20 loop: renderer wrote now+20, adopt ate it, next round wrote
  // (now+20)+20.  Under v0.8.2 the target is stable, so a second pass after a
  // hand-set reminder that MATCHES td converges with zero writes.
  msTask.reminderDateTime = { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' };
  const second = c.timeBridgeMsRenderer_(state, snap, tz, nowMs, tz);
  assert.equal(second.patched, 0);
  assert.deepEqual(state.g2m['g-task'].td, { date: '2026-10-01', time: '08:00', v: 1 }); // FIXED-DATE-OK
});

test('v0.8.2: a future alarm is still owned and written by the renderer (R-1 live path)', () => {
  const { c } = loadContext();
  const tz = 'Asia/Taipei';
  const nowMs = Date.parse('2026-10-01T12:00:00Z'); // 20:00 Taipei
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const msTask = { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' };
  const snap = tbSnap({ id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' }, msTask);
  const patches = [];
  c.updateMsTask_ = (listId, id, payload) => { patches.push(payload); return { id }; };

  const result = c.timeBridgeMsRenderer_(state, snap, tz, nowMs, tz);
  assert.equal(result.patched, 1, 'only the reminder PATCH counts (due PATCH is silent, matching v0.8.0 behaviour)');
  assert.equal(patches.length, 2);
  assert.equal(patches[0].reminderDateTime.dateTime, '2026-10-02T07:30:00', 'future alarm written at the authored instant');
  assert.equal(patches[1].dueDateTime.dateTime, '2026-10-02T00:00:00');
});

test('timeBridgeCalendarRenderer_ projects, cleans up, and respects the projection knobs (§3.7)', () => {
  const { c, calendarEvents } = loadContext();
  const nowMs = Date.parse('2026-10-01T12:00:00Z');
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' };
  const snap = tbSnap(gTask, { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' });
  const safety = { enableTimeBridge: true, enableCalendarProjection: true, enableCalendarProjectionReminder: true };

  const projected = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(projected.projected, 1);
  const eventId = c.timeBridgeDeterministicEventId_('g-task');
  assert.ok(calendarEvents[eventId], 'event inserted');
  assert.equal(calendarEvents[eventId].start.dateTime, '2026-10-02T07:30:00.000Z');
  assert.deepEqual(JSON.parse(JSON.stringify(calendarEvents[eventId].reminders.overrides)), [{ method: 'popup', minutes: 0 }]);
  assert.equal(state.g2m['g-task'].rem.e, eventId);

  // A second pass with an unchanged target is a no-op.
  const again = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(again.projected, 0);

  // Completion removes the projection.
  gTask.status = 'completed';
  const completed = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(completed.deleted, 1);
  assert.equal(calendarEvents[eventId], undefined);

  // With the projection knob off nothing is inserted or deleted.
  gTask.status = 'needsAction';
  const off = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, { enableTimeBridge: true, enableCalendarProjection: false }, nowMs);
  assert.deepEqual(JSON.parse(JSON.stringify(off)), { projected: 0, deleted: 0, quarantined: [] });
  assert.equal(calendarEvents[eventId], undefined);
});

test('knob OFF ignores the time component while the merge keeps owning the date (replaces WO-7)', () => {
  const { c } = loadContext();
  const rec = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {}, td: { date: '2026-10-02', time: '15:30', v: 1 } }; // FIXED-DATE-OK
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction', due: '2026-10-02T00:00:00.000Z' };
  const msTask = { id: 'ms-task', title: 'T', body: { contentType: 'text', content: 'body' }, dueDateTime: { dateTime: '2026-10-02T15:30:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' };

  const offSafety = { enableTimeBridge: false };
  const gOff = c.ordinaryProjectGoogle_(gTask, rec, offSafety);
  const mOff = c.ordinaryProjectMicrosoft_(msTask, rec, offSafety);
  assert.deepEqual(JSON.parse(JSON.stringify(gOff.due)), { date: '2026-10-02', time: null }); // FIXED-DATE-OK
  assert.deepEqual(JSON.parse(JSON.stringify(mOff.due)), { date: '2026-10-02', time: null }); // FIXED-DATE-OK

  const planOff = c.ordinaryMergeMappedFields_(null, gOff, mOff, rec);
  assert.equal(planOff.skipped.some((s) => s.field === 'due'), false, 'no TIME_BRIDGE_OWNED carve-out remains');
  assert.equal(planOff.bootstrapConflicts.length, 0);

  // With the bridge on, the same pair exposes the time to the merge.
  const onSafety = { enableTimeBridge: true };
  const gOn = c.ordinaryProjectGoogle_(gTask, rec, onSafety);
  const mOn = c.ordinaryProjectMicrosoft_(msTask, rec, onSafety);
  assert.deepEqual(JSON.parse(JSON.stringify(gOn.due)), { date: '2026-10-02', time: '15:30' }); // FIXED-DATE-OK
  assert.deepEqual(JSON.parse(JSON.stringify(mOn.due)), { date: '2026-10-02', time: '15:30' }); // FIXED-DATE-OK
});

test('R-4 retry ladder quarantines a repeatedly failing renderer and revives on a user edit (§3.4.5)', () => {
  const { c } = loadContext();
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const rec = state.g2m['g-task'];
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  let attempts = 0;
  c.updateMsTask_ = () => { attempts += 1; const e = new Error('HTTP 500: nope'); throw e; };
  c.sendMailAlert_ = () => true;

  let nowMs = Date.parse('2026-10-01T00:00:00Z');
  let quarantined = null;
  const drawerOpen = () => {
    const retry = state.g2m['g-task'].td.retry;
    return !!(retry && retry.ms && retry.ms.quarantined);
  };
  for (let round = 0; round < 12 && !drawerOpen(); round += 1) {
    const result = c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
    if (result.quarantined.length) quarantined = result.quarantined[0];
    nowMs += 24 * 60 * 60 * 1000;
  }
  assert.equal(attempts, 10, 'six full-speed attempts plus three slow-lane attempts plus the quarantine attempt');
  assert.ok(quarantined, 'the transition into the drawer is reported once');
  assert.equal(quarantined.renderer, 'ms');
  assert.equal(state.g2m['g-task'].td.retry.ms.quarantined, true);

  // A quarantined pair is skipped until the user edits it.
  const before = attempts;
  c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(attempts, before, 'quarantined pairs are not retried');

  // A marker edit revives it.
  snap.gTasksById['g-task'].notes = '[TTS-TIME:18:00]\nbody';
  c.timeBridgeIntake_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(state.g2m['g-task'].td.retry, undefined, 'a user edit clears the ladder');
});

/* ------------------------------------------------------------------ *
 * Orchestrator, notification and adoption paths
 * ------------------------------------------------------------------ */

test('timeBridgeRun_ orchestrates intake, splice and the Microsoft renderer, and stops at the knob (§3.8)', () => {
  const { c } = loadContext();
  // v0.8.3: dynamic fixture anchored on the REAL clock — the marker points 25
  // hours ahead so it is always future and never drifts into the expiry-lift
  // window (WO-2 relapse: a pinned anchor expired the very next day).
  const nowMs = Date.now();
  const targetMs = nowMs + 25 * 60 * 60 * 1000;
  const tpe = (ms) => new Date(ms + 8 * 60 * 60 * 1000);
  const tpeDate = tpe(targetMs).toISOString().slice(0, 10);
  const tpeHhMm = tpe(targetMs).toISOString().slice(11, 16);
  const marked = '[TTS-TIME:' + tpeHhMm + ']\nbody';
  const state = tbState('g-task');
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: marked, status: 'needsAction', due: tpeDate + 'T00:00:00.000Z' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  const writes = { g: 0, ms: 0 };
  c.getGTask_ = () => ({ id: 'g-task', notes: marked });
  c.updateGTask_ = (listId, id, payload) => { writes.g += 1; return { id, notes: payload.notes }; };
  c.updateMsTask_ = (listId, id, payload) => { writes.ms += 1; return Object.assign({ id }, payload); };

  const summary = c.timeBridgeRun_(state, snap, nowMs, 'round-1');
  assert.equal(summary.intaken, 1);
  assert.equal(summary.spliced, 1);
  assert.equal(summary.msPatched, 1);
  assert.equal(writes.g, 1);
  assert.equal(writes.ms, 2, 'the Microsoft renderer sends one reminder PATCH and one due PATCH');
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)), { date: tpeDate, time: tpeHhMm, v: 1 });

  // With the knob off nothing runs at all.
  c.PropertiesService.getScriptProperties().setProperty('SYNC_TIME_BRIDGE', 'false');
  const offState = tbState('g-task');
  const offSnap = tbSnap({ id: 'g-task', title: 'T', notes: marked, status: 'needsAction' }, { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' });
  const offSummary = c.timeBridgeRun_(offState, offSnap, Date.now(), 'round-2');
  assert.equal(offSummary.intaken, 0);
  assert.equal(offSummary.spliced, 0);
  assert.equal(offSummary.msPatched, 0);
  assert.equal(offState.g2m['g-task'].td, undefined, 'no intake while the bridge is off');
});

test('timeBridgeRunRenderersAfterMerge_ aggregates one de-identified quarantine mail (§3.4.5)', () => {
  const { c } = loadContext();
  const nowMs = Date.now();
  const targetMs = nowMs + 25 * 60 * 60 * 1000;
  const tpe = (ms) => new Date(ms + 8 * 60 * 60 * 1000);
  const tpeDate = tpe(targetMs).toISOString().slice(0, 10);
  const tpeHhMm = tpe(targetMs).toISOString().slice(11, 16);
  const state = tbState('g-task', { td: { date: tpeDate, time: tpeHhMm, v: 1 } });
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: { dateTime: tpeDate + 'T' + tpeHhMm + ':00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' }
  );
  // Force the transition into the drawer.
  // The orchestrator reads the real clock, so the slow lane must be due against it.
  state.g2m['g-task'].td.retry = { cal: { fails: 9, lastFailAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), quarantined: false } };
  c.Calendar = {
    Events: {
      get() { const e = new Error('HTTP 500: boom'); e.statusCode = 500; throw e; },
      insert() { throw new Error('unreachable'); },
      patch() { throw new Error('unreachable'); },
      remove() { throw new Error('unreachable'); }
    }
  };
  const mails = [];
  c.sendMailAlert_ = (subject, body) => { mails.push({ subject, body }); return true; };
  c.PropertiesService.getScriptProperties().setProperty('SYNC_CALENDAR_PROJECTION', 'true');
  c.PropertiesService.getScriptProperties().setProperty('SYNC_TIME_BRIDGE', 'true');

  const summary = c.timeBridgeRunRenderersAfterMerge_(state, snap, nowMs, 'round-1');
  assert.equal(summary.quarantined.length, 1);
  assert.equal(mails.length, 1, 'one aggregated mail');
  assert.ok(mails[0].body.indexOf('g-task') < 0, 'the pair id is de-identified in the body');
  assert.ok(mails[0].subject.indexOf('drawer') >= 0);

  // The alert cooldown is now marked, so an immediate repeat does not mail again.
  assert.equal(vm.runInContext('canSendAlert_(ALERT_KEYS.timeBridgeQuarantine, ALERT_COOLDOWN_MS)', c), false,
    'the cooldown is marked after sending');
  assert.equal(c.timeBridgeNotifyQuarantine_([{ gId: 'g-task', renderer: 'cal', code: 'HTTP_500' }]), false);
  assert.equal(mails.length, 1, 'the cooldown suppresses a repeat mail');

  assert.equal(state.g2m['g-task'].td.retry.cal.quarantined, true);
});

test('a Microsoft-side time the user set by hand is adopted into the canonical record (§3.4)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z');
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: { dateTime: '2026-10-02T18:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, reminderDateTime: { dateTime: '2026-10-02T10:00:00', timeZone: 'UTC' }, status: 'notStarted' }
  );
  const summary = c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(summary.patched, 0, 'adoption writes nothing in that round');
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)), { date: '2026-10-02', time: '18:00', v: 1 }); // FIXED-DATE-OK
});

test('a marker without a Google due date falls back to today in the project zone (§3.2)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z'); // 12:00 Taipei
  const state = tbState('g-task');
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: '[TTS-TIME:09:15]\nbody', status: 'needsAction', due: null },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  c.timeBridgeIntake_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  // 09:15 already passed by the time the marker was seen — the one-shot R-1
  // lift moves the alarm to now+20 (12:20) so it still rings, exactly once.
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)), { date: '2026-09-30', time: '12:20', v: 1 }); // FIXED-DATE-OK
});

test('a failing splice keeps the marker and climbs the ladder; success clears it (§3.3/§3.4.5)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z');
  const state = tbState('g-task', { td: { date: '2026-10-01', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const marked = '[TTS-TIME:15:30]\nbody';
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: marked, status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  c.getGTask_ = () => ({ id: 'g-task', notes: marked });
  c.updateGTask_ = () => { throw new Error('HTTP 500: nope'); };

  c.timeBridgeSpliceRenderer_(state, snap, 'Asia/Taipei', nowMs);
  assert.equal(state.g2m['g-task'].td.retry.splice.fails, 1);
  assert.equal(state.g2m['g-task'].td.retry.splice.quarantined, false);

  // A successful splice clears the bucket again.
  c.updateGTask_ = (listId, id, payload) => ({ id, notes: payload.notes });
  c.timeBridgeSpliceRenderer_(state, snap, 'Asia/Taipei', nowMs);
  assert.equal(state.g2m['g-task'].td.retry, undefined, 'success resets the ladder');
});

test('a quarantine blocks the renderer until a user edit revives the pair (§3.4.5)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z');
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1, retry: { ms: { fails: 10, lastFailAt: new Date(nowMs).toISOString(), quarantined: true } } } }); // FIXED-DATE-OK
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  let calls = 0;
  c.updateMsTask_ = () => { calls += 1; return {}; };
  assert.equal(c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei').patched, 0);
  assert.equal(calls, 0, 'quarantined pairs are skipped');

  // Changing the date revives it.
  c.timeBridgeRetryRevive_(state.g2m['g-task']);
  assert.equal(c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei').patched, 1);
});

test('a past timed task is not projected but an existing event is still cleaned up (§3.7)', () => {
  const { c, calendarEvents } = loadContext();
  const nowMs = Date.parse('2026-10-10T12:00:00Z');
  const state = tbState('g-task', { td: { date: '2026-10-02', time: '15:30', v: 1 } }); // FIXED-DATE-OK
  const snap = tbSnap(
    { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' },
    { id: 'ms-task', title: 'T', dueDateTime: null, isReminderOn: false, status: 'notStarted' }
  );
  const safety = { enableTimeBridge: true, enableCalendarProjection: true, enableCalendarProjectionReminder: true };
  const result = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(result.projected, 0, 'a past instant is never projected');
  assert.equal(Object.keys(calendarEvents).length, 0);

  // A task whose time was cleared drops its event even when the date is past.
  state.g2m['g-task'].td = { date: '2026-10-02', time: null, v: 1 }; // FIXED-DATE-OK
  state.g2m['g-task'].rem = { e: c.timeBridgeDeterministicEventId_('g-task'), eFp: 'c'.repeat(32) };
  calendarEvents[state.g2m['g-task'].rem.e] = { id: state.g2m['g-task'].rem.e, status: 'confirmed' };
  const cleanup = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(cleanup.deleted, 1);
  assert.equal(Object.keys(calendarEvents).length, 0);
});

test('NONE clears the leftover Microsoft reminder once and then the pair rests (R-3 clear-time flow)', () => {
  const { c } = loadContext();
  const nowMs = Date.parse('2026-09-30T04:00:00Z');
  const state = tbState('g-task', { td: { date: '2026-10-02', time: null, v: 1, clear: true } }); // FIXED-DATE-OK
  const msTask = { id: 'ms-task', title: 'T', dueDateTime: { dateTime: '2026-10-02T00:00:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, reminderDateTime: { dateTime: '2026-10-02T07:30:00', timeZone: 'UTC' }, status: 'notStarted' };
  const snap = tbSnap({ id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' }, msTask);
  const patches = [];
  c.updateMsTask_ = (listId, id, payload) => { patches.push(payload); return Object.assign({ id }, payload); };

  const first = c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(first.patched, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(patches[0])), { isReminderOn: false, reminderDateTime: null },
    'the proven wipe form (bug #4): reminder fields PATCHed alone');
  assert.equal(state.g2m['g-task'].td.clear, undefined, 'the pending clear is consumed');
  assert.equal(JSON.stringify(patches[0]).indexOf('1970'), -1);

  // The leftover reminder is adopted as if the user had just set it.
  msTask.isReminderOn = false;
  msTask.reminderDateTime = null;
  const second = c.timeBridgeMsRenderer_(state, snap, 'Asia/Taipei', nowMs, 'Asia/Taipei');
  assert.equal(second.patched, 0, 'a cleared date-only pair rests');
});


