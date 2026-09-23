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

function load(scriptValues = {}) {
  const script = {
    values: Object.assign({ SYNC_TIME_BRIDGE: 'true', SYNC_CALENDAR_PROJECTION: 'true' }, scriptValues),
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; },
    getProperties() { return { ...this.values }; },
    getKeys() { return Object.keys(this.values); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); },
    deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; }
  };
  const user = { values: {}, getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; }, getProperties() { return { ...this.values }; }, getKeys() { return Object.keys(this.values); }, setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); }, deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; } };
  const calendarEvents = {};
  let calendarLookups = 0;
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
    },
    Calendar: {
      Events: {
        get(calId, id) {
          if (calId === 'stale-cal') { const err = new Error('Not found'); err.statusCode = 404; throw err; }
          if (calendarEvents[id]) return calendarEvents[id];
          const err = new Error('Not found');
          err.statusCode = 404;
          throw err;
        },
        insert(res, calId) {
          if (calId === 'stale-cal') { const err = new Error('Not found'); err.statusCode = 404; throw err; }
          calendarEvents[res.id] = { ...res, status: 'confirmed' };
          return calendarEvents[res.id];
        },
        patch(res, calId, id) {
          if (calId === 'stale-cal') { const err = new Error('Not found'); err.statusCode = 404; throw err; }
          calendarEvents[id] = { ...(calendarEvents[id] || {}), ...res };
          return calendarEvents[id];
        },
        remove(calId, id) { delete calendarEvents[id]; }
      }
    },
    CalendarApp: {
      getCalendarsByName() {
        calendarLookups += 1;
        return [{ getId: () => 'test-cal-id', getName: () => 'Tasks-ToDo-Sync', isOwnedByMe: () => true }];
      },
      createCalendar() { return { getId: () => 'created-cal-id', getName: () => 'Tasks-ToDo-Sync', isOwnedByMe: () => true }; }
    }
  });
  runGasFilesInContext(c);
  return { c, calendarEvents, lookups: () => calendarLookups, script };
}

function fixture(c) {
  const state = c.newState_();
  state.listMap['g-list'] = 'ms-list';
  state.g2m['g-task'] = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: { v: 1 }, td: { date: '2026-10-02', time: '15:30', v: 1 } };
  state.m2g['ms-task'] = 'g-task';
  const gTask = { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' };
  const snap = { gTasksById: { 'g-task': gTask }, msTasksById: { 'ms-task': { id: 'ms-task', title: 'T', dueDateTime: { dateTime: '2026-10-02T15:30:00', timeZone: 'Asia/Taipei' }, isReminderOn: true, status: 'notStarted' } } };
  return { state, gTask, snap };
}

test('SYNC_CALENDAR_PROJECTION_REMINDER switches the event between ringing and silent, element by element', () => {
  const { c, calendarEvents } = load();
  const { state, snap } = fixture(c);
  const nowMs = Date.parse('2026-10-01T12:00:00Z');
  const on = { enableTimeBridge: true, enableCalendarProjection: true, enableCalendarProjectionReminder: true };
  const silent = { enableTimeBridge: true, enableCalendarProjection: true, enableCalendarProjectionReminder: false };

  c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, on, nowMs);
  const eventId = c.timeBridgeDeterministicEventId_('g-task');
  assert.deepEqual(JSON.parse(JSON.stringify(calendarEvents[eventId].reminders.overrides)), [{ method: 'popup', minutes: 0 }]);

  // Repeating the same mode is a no-op.
  c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, on, nowMs);
  assert.deepEqual(JSON.parse(JSON.stringify(calendarEvents[eventId].reminders.overrides)), [{ method: 'popup', minutes: 0 }]);

  // Flipping the knob re-converges the existing event instead of recreating it.
  c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, silent, nowMs);
  assert.deepEqual(JSON.parse(JSON.stringify(calendarEvents[eventId].reminders.overrides)), [], 'the silent variant keeps the slot but does not ring');
  assert.equal(calendarEvents[eventId].summary, 'T', 'the event itself survives the flip');
});

test('the config knob parses strictly and reports a bounded error code', () => {
  const { c } = load({ SYNC_CALENDAR_PROJECTION_REMINDER: 'false' });
  assert.equal(c.getSafetyConfig_().enableCalendarProjectionReminder, false);
  const { c: onByDefault } = load();
  assert.equal(onByDefault.getSafetyConfig_().enableCalendarProjectionReminder, true, 'default true keeps v0.7.5 behaviour');
  const { c: broken } = load({ SYNC_CALENDAR_PROJECTION_REMINDER: 'yes' });
  assert.throws(() => broken.getSafetyConfig_(), /SYNC_CALENDAR_PROJECTION_REMINDER_FLAG_INVALID/);
  assert.equal(broken.boundedSafetyConfigIssue_(new Error('SYNC_CALENDAR_PROJECTION_REMINDER_FLAG_INVALID: x')),
    'SAFETY_CONFIGURATION_INVALID:SYNC_CALENDAR_PROJECTION_REMINDER_FLAG_INVALID');
});

test('the projection calendar id is cached in state and a dead cache is dropped', () => {
  const { c, lookups, state: _ignored } = load();
  const { state, snap } = fixture(c);
  const nowMs = Date.parse('2026-10-01T12:00:00Z');
  const safety = { enableTimeBridge: true, enableCalendarProjection: true, enableCalendarProjectionReminder: true };

  c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.deepEqual(JSON.parse(JSON.stringify(state.calendarProjection)), { calendarId: 'test-cal-id', v: 1 });
  const afterFirst = lookups();
  c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(lookups(), afterFirst, 'the cached calendar id is reused, not re-resolved');

  // A cached calendar that no longer resolves is dropped so the next round looks
  // it up again instead of failing forever.  The 404 only surfaces on a write,
  // so the target is changed to force one.
  state.calendarProjection = { calendarId: 'stale-cal', v: 1 };
  state.g2m['g-task'].td.time = '16:30';
  delete state.g2m['g-task'].rem;
  c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs, safety, nowMs);
  assert.equal(state.calendarProjection, undefined, 'the dead cache entry is dropped');
});
