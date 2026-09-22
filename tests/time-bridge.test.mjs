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

test('timeBridgeEvaluateOwnership_ adheres to Tri-State Ownership protocols (§1.1 & §1.2)', () => {
  const { c } = loadContext();
  const now = Date.parse('2026-09-22T12:00:00Z');

  // 1. Consumed Reminder: ms === true, isReminderOn === false, reminder in past -> ms = undefined
  const rec1 = { rem: { ms: true, msAt: '2026-09-22T10:00:00Z' } };
  const msTask1 = {
    isReminderOn: false,
    reminderDateTime: { dateTime: '2026-09-22T10:00:00', timeZone: 'UTC' }
  };
  c.timeBridgeEvaluateOwnership_(rec1, msTask1, now);
  assert.equal(rec1.rem.ms, undefined);
  assert.equal(rec1.rem.msAt, undefined);

  // 2. Surrender Trigger 1: user cancelled unexpired reminder in the future
  const rec2 = { rem: { ms: true, msAt: '2026-09-22T15:00:00Z' } };
  const msTask2 = {
    isReminderOn: false,
    reminderDateTime: { dateTime: '2026-09-22T15:00:00', timeZone: 'UTC' }
  };
  c.timeBridgeEvaluateOwnership_(rec2, msTask2, now);
  assert.equal(rec2.rem.ms, false, 'Should surrender ownership to false');
  assert.equal(rec2.rem.msAt, undefined);

  // 3. Surrender Trigger 2: user modified reminder timestamp beyond 60s
  const rec3 = { rem: { ms: true, msAt: '2026-09-22T15:00:00Z' } };
  const msTask3 = {
    isReminderOn: true,
    reminderDateTime: { dateTime: '2026-09-22T16:00:00', timeZone: 'UTC' }
  };
  c.timeBridgeEvaluateOwnership_(rec3, msTask3, now);
  assert.equal(rec3.rem.ms, false, 'Modified timestamp triggers surrender');

  // 4. Completed tasks skip surrender triggers
  const rec4 = { rem: { ms: true, msAt: '2026-09-22T15:00:00Z' } };
  const msTask4 = {
    isReminderOn: false,
    reminderDateTime: { dateTime: '2026-09-22T15:00:00', timeZone: 'UTC' },
    status: 'completed'
  };
  c.timeBridgeEvaluateOwnership_(rec4, msTask4, now);
  assert.equal(rec4.rem.ms, true, 'Completed task preserves ms = true');
});

test('timeBridgeComputeIntent_ handles Future, Expired Today, Past-Date, and NONE decisions (§3.1)', () => {
  const { c } = loadContext();
  const tz = 'Asia/Taipei';
  // Wednesday 2026-09-23 10:00:00 Asia/Taipei = 02:00:00 UTC
  const nowMs = Date.parse('2026-09-23T02:00:00Z');

  // A. Future task: today 15:30 Taipei = 07:30:00 UTC
  const futureT = Date.parse('2026-09-23T07:30:00Z');
  const recA = { rem: { ms: undefined } };
  const intentA = c.timeBridgeComputeIntent_(futureT, nowMs, tz, recA, false);
  assert.equal(intentA.duePayload.dateTime, '2026-09-23T15:30:00');
  assert.equal(intentA.reminderPayload?.isReminderOn, true);
  assert.equal(intentA.acquireOwnership, true);

  // B. Expired Today (e.g. today 09:00 Taipei = 01:00:00 UTC) -> 20m fallback
  const pastTodayT = Date.parse('2026-09-23T01:00:00Z');
  const intentB = c.timeBridgeComputeIntent_(pastTodayT, nowMs, tz, recA, false);
  assert.equal(intentB.duePayload.dateTime, '2026-09-23T09:00:00');
  assert.equal(intentB.reminderPayload?.isReminderOn, true);
  assert.ok(intentB.fallbackInstantMs > nowMs, 'Fallback must be set in the future');

  // C. Past Date (yesterday 2026-09-22) -> disabled reminder
  const yesterdayT = Date.parse('2026-09-22T07:00:00Z');
  const recC = { rem: { ms: true } };
  const intentC = c.timeBridgeComputeIntent_(yesterdayT, nowMs, tz, recC, false);
  assert.equal(intentC.duePayload.dateTime, '2026-09-22T15:00:00');
  assert.equal(intentC.releaseOwnership, true);
  assert.equal(intentC.reminderPayload?.isReminderOn, false);

  // D. NONE
  const intentD = c.timeBridgeComputeIntent_(0, nowMs, tz, recC, true);
  assert.equal(intentD.clearHasTime, true);
  assert.equal(intentD.releaseOwnership, true);
});

test('timeBridgeRun_ executes full end-to-end flow with Google notes splice and field ownership', () => {
  const { c, calendarEvents } = loadContext();
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = {
    msId: 'ms-task',
    gListId: 'g-list',
    msListId: 'ms-list',
    gUpdated: '2026-09-21T00:00:00Z',
    msUpdated: '2026-09-21T00:00:00Z',
    fp: { due: 'old-due-fp', notes: 'old-notes-fp', v: 1 },
    rem: { ms: undefined }
  };
  state.m2g['ms-task'] = 'g-task';

  // Use tomorrow's date so the fixture is always in the future (WO-2: prevents time-bomb).
  const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const tomorrowDateOnly = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

  const gTask = {
    id: 'g-task',
    title: 'Pay bills',
    notes: '[TTS-TIME:15:30]\n\nBring checkbook.',
    due: tomorrowDateOnly + 'T00:00:00.000Z',
    status: 'needsAction'
  };
  const msTask = {
    id: 'ms-task',
    title: 'Pay bills',
    dueDateTime: { dateTime: tomorrowDateOnly + 'T00:00:00', timeZone: 'UTC' },
    isReminderOn: false,
    status: 'notStarted'
  };

  let msPatched = null;
  let gPatched = null;

  c.getGTask_ = (listId, id) => gTask;
  c.updateMsTask_ = (listId, id, payload) => {
    msPatched = payload;
    msTask.dueDateTime = payload.dueDateTime;
    msTask.isReminderOn = payload.isReminderOn;
    msTask.reminderDateTime = payload.reminderDateTime;
    return msTask;
  };
  c.updateGTask_ = (listId, id, payload) => {
    gPatched = payload;
    if (payload.notes !== undefined) gTask.notes = payload.notes;
    return gTask;
  };

  const snap = {
    gTasksById: { 'g-task': gTask },
    msTasksById: { 'ms-task': msTask },
    safety: { allowDeletions: true }
  };

  // Run Time Bridge
  c.timeBridgeRun_(state, snap, Date.now(), 'round-1');

  // Verify MS was patched with local due and reminder
  assert.ok(msPatched, 'Microsoft task must be updated');
  assert.equal(msPatched.dueDateTime.dateTime, tomorrowDateOnly + 'T15:30:00');
  assert.equal(msPatched.isReminderOn, true);

  // Verify Google Task notes had marker spliced out cleanly
  assert.ok(gPatched, 'Google task notes must be spliced');
  assert.equal(gTask.notes, 'Bring checkbook.');

  // Verify ownership acquired
  assert.equal(state.g2m['g-task'].rem.ms, true);
  assert.equal(state.g2m['g-task'].rem.hasTime, true);

  // Verify calendar event was projected
  const eventId = c.timeBridgeDeterministicEventId_('g-task');
  assert.ok(calendarEvents[eventId], 'Calendar projection event must exist');
  assert.equal(calendarEvents[eventId].summary, 'Pay bills');
  assert.equal(calendarEvents[eventId].reminders.overrides[0].minutes, 0);

  // Verify field-merge skips due field when rec.rem.hasTime === true (§0)
  const gProj = c.ordinaryProjectGoogle_(gTask, state.g2m['g-task']);
  const mProj = c.ordinaryProjectMicrosoft_(msTask, state.g2m['g-task']);
  const plan = c.ordinaryMergeMappedFields_(state.g2m['g-task'].fp, gProj, mProj, state.g2m['g-task']);
  assert.equal(plan.toGoogle.due, undefined, 'Core sync must not touch due for Google');
  assert.equal(plan.toMicrosoft.due, undefined, 'Core sync must not touch due for Microsoft');
  assert.ok(plan.skipped.some((s) => s.field === 'due' && s.reason === 'TIME_BRIDGE_OWNED'));
});

test('timeBridgeRun_ deletes calendar event when task is completed (§4.2)', () => {
  const { c, calendarEvents } = loadContext();
  const eventId = c.timeBridgeDeterministicEventId_('g-task-comp');
  calendarEvents[eventId] = { id: eventId, summary: 'Done task', status: 'confirmed' };

  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task-comp'] = {
    msId: 'ms-task-comp',
    gListId: 'g-list',
    msListId: 'ms-list',
    rem: { ms: true, hasTime: true, e: eventId }
  };
  state.m2g['ms-task-comp'] = 'g-task-comp';

  const gTask = { id: 'g-task-comp', title: 'Done task', notes: '', status: 'completed' };
  const msTask = { id: 'ms-task-comp', title: 'Done task', status: 'completed', isReminderOn: false };

  const snap = {
    gTasksById: { 'g-task-comp': gTask },
    msTasksById: { 'ms-task-comp': msTask },
    safety: {}
  };

  c.timeBridgeRun_(state, snap, Date.now(), 'round-2');

  assert.equal(calendarEvents[eventId], undefined, 'Calendar event must be removed when completed');
  assert.equal(state.g2m['g-task-comp'].rem.e, undefined);
});

test('SYNC_TIME_BRIDGE="false" disables Time Bridge entirely (knob verification)', () => {
  const { c, calendarEvents } = loadContext();
  c.PropertiesService.getScriptProperties().setProperty('SYNC_TIME_BRIDGE', 'false');

  const safety = c.getSafetyConfig_();
  assert.equal(safety.enableTimeBridge, false);

  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {} };
  state.m2g['ms-task'] = 'g-task';

  const gTask = {
    id: 'g-task',
    title: 'Disabled test',
    notes: '[TTS-TIME:15:30]\nBring checkbook.',
    due: '2026-09-22T00:00:00.000Z',
    status: 'needsAction'
  };
  const msTask = {
    id: 'ms-task',
    title: 'Disabled test',
    dueDateTime: { dateTime: '2026-09-22T00:00:00', timeZone: 'Asia/Taipei' },
    isReminderOn: false,
    status: 'notStarted'
  };

  const snap = {
    gTasksById: { 'g-task': gTask },
    msTasksById: { 'ms-task': msTask },
    safety: safety
  };

  c.timeBridgeRun_(state, snap, Date.now(), 'round-knob-off');

  // Verify marker NOT spliced and calendar NOT created
  assert.equal(gTask.notes, '[TTS-TIME:15:30]\nBring checkbook.');
  assert.equal(state.timeBridgeJournal, null);
  const eventId = c.timeBridgeDeterministicEventId_('g-task');
  assert.equal(calendarEvents[eventId], undefined);
});

test('SYNC_CALENDAR_PROJECTION="false" preserves reminder sync but skips Google Calendar projection', () => {
  const { c, calendarEvents } = loadContext();
  c.PropertiesService.getScriptProperties().setProperty('SYNC_CALENDAR_PROJECTION', 'false');

  const safety = c.getSafetyConfig_();
  assert.equal(safety.enableTimeBridge, true);
  assert.equal(safety.enableCalendarProjection, false);

  // Use tomorrow's date so the fixture is always in the future (WO-2: prevents time-bomb).
  const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const tomorrowDateOnly = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {} };
  state.m2g['ms-task'] = 'g-task';

  const gTask = {
    id: 'g-task',
    title: 'No cal test',
    notes: '[TTS-TIME:15:30]\nBring checkbook.',
    due: tomorrowDateOnly + 'T00:00:00.000Z',
    status: 'needsAction'
  };
  const msTask = {
    id: 'ms-task',
    title: 'No cal test',
    dueDateTime: { dateTime: tomorrowDateOnly + 'T00:00:00', timeZone: 'Asia/Taipei' },
    isReminderOn: false,
    status: 'notStarted'
  };

  let msPatched = null;
  c.updateMsTask_ = (listId, id, payload) => {
    msPatched = payload;
    msTask.dueDateTime = payload.dueDateTime || msTask.dueDateTime;
    msTask.isReminderOn = payload.isReminderOn;
    msTask.reminderDateTime = payload.reminderDateTime;
    return msTask;
  };
  c.getGTask_ = () => gTask;
  c.updateGTask_ = (listId, id, patch) => {
    if (patch.notes) gTask.notes = patch.notes;
  };

  const snap = {
    gTasksById: { 'g-task': gTask },
    msTasksById: { 'ms-task': msTask },
    safety: safety
  };

  c.timeBridgeRun_(state, snap, Date.now(), 'round-knob-nocal');

  // Microsoft reminder is still set
  assert.ok(msPatched);
  assert.equal(msPatched.isReminderOn, true);
  assert.equal(gTask.notes, 'Bring checkbook.');

  // But NO calendar event was projected!
  const eventId = c.timeBridgeDeterministicEventId_('g-task');
  assert.equal(calendarEvents[eventId], undefined);
  assert.equal(state.g2m['g-task'].rem.e, undefined);
});

test('WO-1: NONE intent produces no 1970 epoch duePayload and clears hasTime without MS PATCH', () => {
  const { c } = loadContext();

  // timeBridgeComputeIntent_ NONE path must return null duePayload
  const rec = { rem: { ms: true } };
  const intent = c.timeBridgeComputeIntent_(0, Date.now(), 'Asia/Taipei', rec, true);
  assert.equal(intent.duePayload, null, 'NONE must produce null duePayload, not 1970 epoch');
  assert.equal(intent.targetInstantMs, null, 'NONE must produce null targetInstantMs');
  assert.equal(intent.clearHasTime, true);
  assert.equal(intent.releaseOwnership, true, 'NONE with ms=true releases ownership');
  assert.equal(intent.acquireOwnership, false);
  assert.ok(!JSON.stringify(intent).includes('1970'), 'NONE intent must not contain any 1970 sentinel');

  // timeBridgeMsMatchesIntent_ must return true for NONE (skip MS patch)
  const msTask = { id: 'ms-task', dueDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'Asia/Taipei' } };
  const matches = c.timeBridgeMsMatchesIntent_(msTask, intent, 'Asia/Taipei');
  assert.equal(matches, true, 'NONE intent must match (no MS patch needed)');
});

test('WO-1: past-date release reminderPayload contains no 1970 dateTime', () => {
  const { c } = loadContext();

  // Past date: 28h ago
  const pastMs = Date.now() - 28 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const tz = 'Asia/Taipei';

  const rec = { rem: { ms: true, msAt: new Date(pastMs).toISOString() } };
  const intent = c.timeBridgeComputeIntent_(pastMs, nowMs, tz, rec, false);

  if (intent.reminderPayload) {
    assert.ok(!JSON.stringify(intent.reminderPayload).includes('1970'),
      'Past-date reminderPayload must not contain 1970 epoch sentinel');
    assert.equal(intent.reminderPayload.isReminderOn, false);
    assert.equal(intent.reminderPayload.dateTime, undefined,
      'Past-date release reminderPayload must omit dateTime entirely');
  }
});

test('WO-4: updateMsTask_ is called with exactly 3 arguments (no dead If-Match arg)', () => {
  const { c, calendarEvents } = loadContext();
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task-etag'] = {
    msId: 'ms-task-etag', gListId: 'g-list', msListId: 'ms-list',
    fp: {}, rem: { ms: undefined }
  };
  state.m2g['ms-task-etag'] = 'g-task-etag';

  const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const tomorrowDateOnly = tomorrow.toISOString().slice(0, 10);

  const gTask = {
    id: 'g-task-etag', title: 'Etag test',
    notes: '[TTS-TIME:10:00]\nNote.',
    due: tomorrowDateOnly + 'T00:00:00.000Z',
    status: 'needsAction'
  };
  const msTask = {
    id: 'ms-task-etag', title: 'Etag test',
    dueDateTime: { dateTime: tomorrowDateOnly + 'T00:00:00', timeZone: 'Asia/Taipei' },
    isReminderOn: false, status: 'notStarted'
  };

  let updateArgCount = 0;
  c.updateMsTask_ = (...args) => { updateArgCount = args.length; return msTask; };
  c.updateGTask_ = () => gTask;
  c.getGTask_ = () => gTask;

  const snap = {
    gTasksById: { 'g-task-etag': gTask },
    msTasksById: { 'ms-task-etag': msTask },
    safety: {}
  };
  c.timeBridgeRun_(state, snap, Date.now(), 'round-etag');

  assert.equal(updateArgCount, 3, 'updateMsTask_ must be called with exactly 3 args (no dead If-Match)');
});
