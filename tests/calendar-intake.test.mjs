import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';
import { GAS_SOURCE_FILES } from '../lib/gas-files.mjs';

/* calendar-intake.gs is not yet in the canonical GAS_SOURCE_FILES list (the
 * lead owns lib/gas-files.mjs).  Inject it locally, right after time-bridge.gs,
 * so this file stays self-contained and the default order used by every other
 * test file is untouched. */
const ORDER_WITH_INTAKE = (() => {
  const order = [...GAS_SOURCE_FILES];
  const i = order.indexOf('time-bridge.gs');
  if (i < 0) throw new Error('time-bridge.gs missing from GAS_SOURCE_FILES');
  order.splice(i + 1, 0, 'calendar-intake.gs');
  return order;
})();

function blob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

/* Offline Calendar mock.  `list` replays a caller-provided page queue; every
 * mutating verb is counted so the C-suite "zero Calendar writes" assertions are
 * mechanical.  No network, no real API. */
function makeCalendarMock() {
  const store = {};
  const counters = { get: 0, insert: 0, patch: 0, remove: 0, listCalls: [] };
  const pageQueue = [];
  const httpError = (code) => {
    const e = new Error('HTTP ' + code);
    e.statusCode = code;
    return e;
  };
  const Events = {
    list(calId, args) {
      counters.listCalls.push(args ? { ...args } : null);
      const next = pageQueue.shift();
      if (next === undefined) return { items: [], nextSyncToken: 'sync-tail' };
      if (next && next.__status) throw httpError(next.__status);
      return next;
    },
    get(calId, id) {
      counters.get += 1;
      if (store[id]) return JSON.parse(JSON.stringify(store[id]));
      throw httpError(404);
    },
    insert(res, calId) {
      counters.insert += 1;
      store[res.id] = JSON.parse(JSON.stringify(res));
      return JSON.parse(JSON.stringify(store[res.id]));
    },
    patch(res, calId, id) {
      counters.patch += 1;
      store[id] = { ...(store[id] || {}), ...JSON.parse(JSON.stringify(res)) };
      return JSON.parse(JSON.stringify(store[id]));
    },
    remove(calId, id) {
      counters.remove += 1;
      delete store[id];
    }
  };
  return { store, counters, pageQueue, Events };
}

function loadContext({ syncCalendarIntake = 'true' } = {}) {
  const script = {
    values: { SYNC_CALENDAR_INTAKE: syncCalendarIntake },
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
  const cal = makeCalendarMock();

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
      sleep() {},
      getUuid: () => '00000000-0000-4000-8000-000000000000'
    },
    Calendar: { Events: cal.Events },
    CalendarApp: {
      getCalendarsByName(name) {
        return [{ getId: () => 'test-cal-id', getName: () => name, isOwnedByMe: () => true }];
      },
      createCalendar(name) {
        return [{ getId: () => 'created-cal-id', getName: () => name, isOwnedByMe: () => true }];
      }
    }
  });

  runGasFilesInContext(c, ORDER_WITH_INTAKE);
  return { c, script, cal };
}

/* A mapped pair whose engine state says: td = 2026-08-21 09:30 (Asia/Taipei),
 * last projected event = exactly that td, projected in silent reminder mode.
 * syncTimeZone is Asia/Taipei ⇒ start = 2026-08-21T01:30:00.000Z. */
function makeFixture(c, cal, { title = 'Task' } = {}) {
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.calendarProjection = { calendarId: 'cal-1', v: 1 };

  const startMs = c.timeBridgeWallClockToUtcMs_('2026-08-21T09:30:00', 'Asia/Taipei');
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + 30 * 60 * 1000).toISOString();
  const echoFp = c.timeBridgeEventFingerprint_(title, startIso, endIso, 'silent');

  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    td: { date: '2026-08-21', time: '09:30', v: 1 },
    rem: {
      e: c.timeBridgeDeterministicEventId_('g-task'), eFp: echoFp,
      // The UTC echo of the reminder this engine last rendered on Microsoft
      // (timeBridgeSetMsReminderEcho_) — armed on every convergent render, so
      // a projected+rendered pair always carries it in production.
      msAt: '2026-08-21T01:30:00.000Z'
    }
  };
  state.m2g['ms-task'] = 'g-task';

  const gTask = {
    id: 'g-task', title, notes: '', status: 'needsAction',
    due: '2026-08-21T00:00:00.000Z', updated: '2026-08-14T00:00:00Z'
  };
  const msTask = {
    id: 'ms-task', title,
    body: { contentType: 'text', content: '' },
    status: 'notStarted',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'UTC' },
    isReminderOn: true,
    reminderDateTime: { dateTime: '2026-08-21T01:30:00.000Z', timeZone: 'UTC' },
    lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const snap = {
    inventoryComplete: true,
    gTasksById: { 'g-task': gTask },
    msTasksById: { 'ms-task': msTask },
    gListByTask: { 'g-task': 'g-list' },
    msListByTask: { 'ms-task': 'ms-list' },
    safety: { allowDeletions: false, allowTaskMoves: false }
  };

  const gStore = { 'g-task': { ...gTask } };
  const gPatches = [];
  const msPatches = [];
  c.getGTask_ = (listId, taskId) => gStore[taskId] ? { ...gStore[taskId] } : null;
  c.updateGTask_ = (listId, taskId, payload) => {
    gPatches.push({ taskId, payload: JSON.parse(JSON.stringify(payload)) });
    gStore[taskId] = { ...gStore[taskId], ...payload, updated: '2026-08-22T00:00:00Z' };
    return { ...gStore[taskId] };
  };
  c.updateMsTask_ = (listId, taskId, payload) => {
    msPatches.push({ taskId, payload: JSON.parse(JSON.stringify(payload)) });
    return { id: taskId, ...payload, lastModifiedDateTime: '2026-08-22T00:00:00Z' };
  };

  return { state, snap, gTask, msTask, startMs, startIso, endIso, echoFp, gStore, gPatches, msPatches };
}

function echoEvent({ id, title = 'Task', startIso, endIso, etag = 'etag-1' }) {
  return {
    id, status: 'confirmed', etag, summary: title,
    start: { dateTime: startIso, timeZone: 'Asia/Taipei' },
    end: { dateTime: endIso, timeZone: 'Asia/Taipei' }
  };
}

function assertZeroCalendarWrites(cal) {
  assert.equal(cal.counters.patch, 0, 'Calendar.Events.patch must not run');
  assert.equal(cal.counters.insert, 0, 'Calendar.Events.insert must not run');
  assert.equal(cal.counters.remove, 0, 'Calendar.Events.remove must not run');
}

/* ------------------------------------------------------------------ */
/* C1 — self-written echo is skipped with zero Calendar writes         */
/* ------------------------------------------------------------------ */

test('C1: matching self-written echo is skipped with zero Calendar writes', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  cal.pageQueue.push({
    items: [echoEvent({ id: c.timeBridgeDeterministicEventId_('g-task'), startIso: fx.startIso, endIso: fx.endIso })],
    nextSyncToken: 'sync-1'
  });

  const before = JSON.stringify(fx.state);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);

  assert.equal(result.echoSkipped, 1, 'the echo must be recognised');
  assertZeroCalendarWrites(cal);
  assert.equal(JSON.stringify(fx.state), before, 'rec.td/rec.rem must stay byte-identical');

  // Resize clause of C1: same start, stretched end (60 minutes) — the echo no
  // longer matches, the baseline still does, and the resize is NOT adopted.
  const stretchedEnd = new Date(fx.startMs + 60 * 60 * 1000).toISOString();
  cal.pageQueue.push({
    items: [echoEvent({ id: c.timeBridgeDeterministicEventId_('g-task'), startIso: fx.startIso, endIso: stretchedEnd })],
    nextSyncToken: 'sync-2'
  });
  const result2 = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result2.titleOnlyEdits, 1, 'a resize must not be adopted');
  assertZeroCalendarWrites(cal);
  assert.equal(fx.state.g2m['g-task'].td.time, '09:30', 'td.time unchanged through a resize');
});

/* ------------------------------------------------------------------ */
/* C2 — missing etag / unusable baseline fails closed                   */
/* ------------------------------------------------------------------ */

test('C2: missing/changed etag fails closed against lastCalStartIso', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');

  // Dragged start (09:30 -> 11:00 Taipei) but NO etag: no change evidence.
  const draggedMs = c.timeBridgeWallClockToUtcMs_('2026-08-21T11:00:00', 'Asia/Taipei');
  const draggedIso = new Date(draggedMs).toISOString();
  cal.pageQueue.push({
    items: [{
      id: detId, status: 'confirmed', summary: 'Task',
      start: { dateTime: draggedIso, timeZone: 'Asia/Taipei' },
      end: { dateTime: new Date(draggedMs + 30 * 60 * 1000).toISOString(), timeZone: 'Asia/Taipei' }
    }],
    nextSyncToken: 'sync-1'
  });

  const before = JSON.stringify(fx.state);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.ok(result.failClosed >= 1, 'missing etag must fail closed');
  assert.equal(result.adopted, 0, 'nothing adopted without evidence');
  assertZeroCalendarWrites(cal);
  assert.equal(JSON.stringify(fx.state), before, 'zero state writes');

  // Stale baseline variant: the stored fingerprint no longer describes the
  // current td (td moved without the renderer catching up) — the calendar side
  // cannot be proven newer, so intake stands down (field-level evidence only,
  // never a Max(lastModified, updated) formula).
  fx.state.g2m['g-task'].rem.eFp = 'ffffffffffffffffffffffffffffffff';
  cal.pageQueue.push({
    items: [echoEvent({ id: detId, startIso: draggedIso, endIso: new Date(draggedMs + 30 * 60 * 1000).toISOString() })],
    nextSyncToken: 'sync-2'
  });
  const before2 = JSON.stringify(fx.state);
  const result2 = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.ok(result2.failClosed >= 1, 'stale baseline must fail closed');
  assert.equal(result2.adopted, 0);
  assert.equal(JSON.stringify(fx.state), before2, 'zero state writes');
});

/* ------------------------------------------------------------------ */
/* C3 — cancelled stops projection, keeps td.time and the MS reminder  */
/* ------------------------------------------------------------------ */

test('C3: cancelled stops projection without clearing td.time or the MS reminder', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.pageQueue.push({
    items: [{ id: detId, status: 'cancelled', etag: 'etag-x', summary: 'Task' }],
    nextSyncToken: 'sync-1'
  });

  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.cancelledCleared, 1);
  assertZeroCalendarWrites(cal);
  assert.equal(fx.state.g2m['g-task'].td.time, '09:30', 'td.time untouched');
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-21', 'td.date untouched');
  assert.equal(fx.state.g2m['g-task'].rem.e, undefined, 'rec.rem.e cleared (projection stopped)');
  assert.equal(fx.state.g2m['g-task'].rem.eFp, undefined, 'rec.rem.eFp cleared');
  assert.equal(fx.state.g2m['g-task'].rem.msAt, '2026-08-21T01:30:00.000Z',
    'the MS reminder echo is Calendar-projection-independent and stays');
  c.normalizeState_(fx.state);  // the cleared shape must still validate
});

/* ------------------------------------------------------------------ */
/* C5 — 410 clears the token and runs exactly one full re-scan          */
/* ------------------------------------------------------------------ */

test('C5: 410 clears the token and triggers exactly one full re-scan', () => {
  const { c, cal, script } = loadContext();
  const fx = makeFixture(c, cal);
  script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'] = 'old_token';
  cal.pageQueue.push({ __status: 410 });
  cal.pageQueue.push({ items: [], nextPageToken: 'p2' });
  cal.pageQueue.push({ items: [], nextSyncToken: 'sync-new' });

  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.fullRescans, 1, 'exactly one full re-scan');
  assert.equal(result.pagesFetched, 2, 'the failed attempt is not a page');
  // First request carried the stale token; the re-scan request carries none.
  assert.equal(cal.counters.listCalls[0].syncToken, 'old_token');
  assert.equal(cal.counters.listCalls[1].syncToken, undefined, 'token cleared before the re-scan');
  assert.equal(script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'], 'sync-new', 'watermark replaced after success');
  assertZeroCalendarWrites(cal);
});

/* ------------------------------------------------------------------ */
/* C6 — pagination failure: zero state writes, watermark untouched      */
/* ------------------------------------------------------------------ */

test('C6: pagination failure leaves the watermark and sync state untouched', () => {
  const { c, cal, script } = loadContext();
  const fx = makeFixture(c, cal);
  script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'] = 'old_token';
  cal.pageQueue.push({ items: [], nextPageToken: 'p2' });
  cal.pageQueue.push({ __status: 500 });

  const before = JSON.stringify(fx.state);
  assert.throws(() => c.calendarIntakeRun_(fx.state, fx.snap, 0), /HTTP 500|500/);
  assert.equal(script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'], 'old_token', 'watermark not advanced');
  assert.equal(JSON.stringify(fx.state), before, 'zero state mutations');
  assertZeroCalendarWrites(cal);
});

/* ------------------------------------------------------------------ */
/* C7 — watermark advances only after all pages, once                   */
/* ------------------------------------------------------------------ */

test('C7: watermark advances only after all pages and a successful persist', () => {
  const { c, cal, script } = loadContext();
  const fx = makeFixture(c, cal);
  cal.pageQueue.push({ items: [], nextPageToken: 'p2' });
  cal.pageQueue.push({ items: [], nextPageToken: 'p3' });
  cal.pageQueue.push({ items: [], nextSyncToken: 'sync-final' });

  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.pagesFetched, 3, 'pagesFetched===3');
  assert.equal(result.tokenAdvanced, true);
  assert.equal(script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'], 'sync-final');

  // Persist failure variant: the write that would advance the watermark is the
  // advance; when it throws, the watermark stays where it was.
  delete script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'];
  const fx2 = makeFixture(c, cal);
  cal.pageQueue.push({ items: [], nextSyncToken: 'sync-late' });
  const realSet = script.setProperty;
  script.setProperty = (k, v) => {
    if (k === 'SYNC_CALENDAR_INTAKE_SYNC_TOKEN') throw new Error('PROPERTY_STORE_LIMIT');
    return realSet.call(script, k, v);
  };
  assert.throws(() => c.calendarIntakeRun_(fx2.state, fx2.snap, 0), /PROPERTY_STORE_LIMIT/);
  assert.equal(script.values['SYNC_CALENDAR_INTAKE_SYNC_TOKEN'], undefined, 'watermark not advanced on persist failure');
});

/* ------------------------------------------------------------------ */
/* C8 — an all-day event occupying a pair slot is isolated              */
/* ------------------------------------------------------------------ */

test('C8: an all-day collision is isolated, never overwritten', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.pageQueue.push({
    items: [{
      id: detId, status: 'confirmed', etag: 'etag-1', summary: 'Holiday',
      start: { date: '2026-08-21' }, end: { date: '2026-08-22' }
    }],
    nextSyncToken: 'sync-1'
  });

  const tdBefore = JSON.stringify(fx.state.g2m['g-task'].td);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.quarantined.length, 1, 'collision reported');
  assert.equal(result.quarantined[0].gId, 'g-task');
  assert.equal(result.quarantined[0].reason, 'ALL_DAY_COLLISION');
  assertZeroCalendarWrites(cal);
  // Post-wiring: state.gs accepts collisionQuarantined, so the halt is
  // persisted on rec.rem for later rounds and the renderer; rec.td never moves.
  assert.equal(fx.state.g2m['g-task'].rem.collisionQuarantined, true,
    'quarantine flag persisted once the whitelist accepts the key');
  assert.equal(JSON.stringify(fx.state.g2m['g-task'].td), tdBefore, 'rec.td unchanged');
  assert.equal(c.calendarIntakeQuarantinePersistable_(), true,
    'whitelist accepts collisionQuarantined after the lead wiring');
});

/* ------------------------------------------------------------------ */
/* C9 — a foreign collision is quarantined with zero Calendar writes    */
/* ------------------------------------------------------------------ */

test('C9: a foreign collision is quarantined with zero patch', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  // Different title AND different start: ownership cannot be established.
  cal.pageQueue.push({
    items: [{
      id: detId, status: 'confirmed', etag: 'etag-9', summary: 'Not mine',
      start: { dateTime: '2026-08-21T15:00:00.000Z', timeZone: 'Asia/Taipei' },
      end: { dateTime: '2026-08-21T16:00:00.000Z', timeZone: 'Asia/Taipei' }
    }],
    nextSyncToken: 'sync-1'
  });

  const tdBefore = JSON.stringify(fx.state.g2m['g-task'].td);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].reason, 'FOREIGN_COLLISION');
  assertZeroCalendarWrites(cal);
  // Post-wiring: the halt persists on rec.rem; rec.td stays untouched.
  assert.equal(fx.state.g2m['g-task'].rem.collisionQuarantined, true,
    'foreign-collision halt persisted once the whitelist accepts the key');
  assert.equal(JSON.stringify(fx.state.g2m['g-task'].td), tdBefore, 'rec.td untouched by quarantine');

  // The rec.rem whitelist (state.gs assertTimeBridgeMappingRem_) now accepts
  // collisionQuarantined, so the capability probe reports persistence honestly.
  assert.equal(c.calendarIntakeQuarantinePersistable_(), true,
    'quarantine persistence is live after the lead wiring');
});

/* ------------------------------------------------------------------ */
/* C10 — DST gap rejected, fold keeps the first occurrence              */
/* ------------------------------------------------------------------ */

test('C10: a spring DST gap is rejected with zero writes', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  // US spring forward 2027-03-14 (02:00 -> 03:00 America/New_York).  A floating
  // wall time of 02:30 inside the gap does not exist in that zone.
  cal.pageQueue.push({
    items: [{
      id: detId, status: 'confirmed', etag: 'etag-1', summary: 'Task',
      start: { dateTime: '2027-03-14T02:30:00', timeZone: 'America/New_York' },
      end: { dateTime: '2027-03-14T03:00:00', timeZone: 'America/New_York' }
    }],
    nextSyncToken: 'sync-1'
  });

  const before = JSON.stringify(fx.state);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.rejected, 1, 'gap wall time rejected');
  assert.equal(result.adopted, 0);
  assertZeroCalendarWrites(cal);
  assert.equal(JSON.stringify(fx.state), before, 'zero state writes');
});

test('C10b: fall fold keeps the first occurrence and is adopted', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  // US fall back 2026-11-01 (01:30 happens twice: 05:30Z EDT, 06:30Z EST).
  const secondOccurrenceMs = Date.parse('2026-11-01T06:30:00.000Z');
  const firstMs = c.calendarIntakeFoldFirstInstantMs_(secondOccurrenceMs, 'America/New_York');
  assert.equal(firstMs, Date.parse('2026-11-01T05:30:00.000Z'), 'first occurrence wins');

  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.pageQueue.push({
    items: [{
      id: detId, status: 'confirmed', etag: 'etag-1', summary: 'Task',
      start: { dateTime: '2026-11-01T06:30:00.000Z', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-01T07:00:00.000Z', timeZone: 'America/New_York' }
    }],
    nextSyncToken: 'sync-1'
  });
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.adopted, 1, 'ambiguous wall time is accepted');
  assert.equal(fx.state.g2m['g-task'].td.time, '01:30');
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-11-01');
});

/* ------------------------------------------------------------------ */
/* C11 — cal_drag date survives field-merge until MS write confirmed    */
/* ------------------------------------------------------------------ */

function mergeBaseline(c, fx) {
  // One converged round first: builds rec.fp baselines without any write.
  c.ordinaryReconcileMappedPair_(fx.state, fx.state.g2m['g-task'], fx.gTask, fx.msTask, 'g-list', {});
}

test('C11: a cal_drag date survives field-merge until the MS write is confirmed', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  mergeBaseline(c, fx);
  const baselineFp = fx.state.g2m['g-task'].fp.due;
  assert.ok(baselineFp, 'merge baseline built');

  // The user drags the projected event one week later in the calendar.
  const draggedMs = c.timeBridgeWallClockToUtcMs_('2026-08-28T09:30:00', 'Asia/Taipei');
  cal.pageQueue.push({
    items: [{
      id: c.timeBridgeDeterministicEventId_('g-task'), status: 'confirmed', etag: 'etag-1',
      summary: 'Task',
      start: { dateTime: new Date(draggedMs).toISOString(), timeZone: 'Asia/Taipei' },
      end: { dateTime: new Date(draggedMs + 30 * 60 * 1000).toISOString(), timeZone: 'Asia/Taipei' }
    }],
    nextSyncToken: 'sync-1'
  });
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.adopted, 1, 'drag adopted into rec.td');
  assert.equal(result.dueAdvanced, 1, 'the intake valve advanced the Google due (anti-revert branch)');
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28');
  assert.equal(fx.gPatches.length, 1, 'exactly one Google due write');
  assert.equal(fx.gPatches[0].payload.due, '2026-08-28T00:00:00.000Z');

  // The merge sees a genuine Google-side due edit.  For a TIMED due the merge
  // payload deliberately sends nothing (the Microsoft renderer owns the write,
  // field-merge.gs:377-388), but the converged date is the planned one, so the
  // drag date is NOT reverted.
  const merged = c.ordinaryReconcileMappedPair_(
    fx.state, fx.state.g2m['g-task'], fx.gTask, fx.msTask, 'g-list', {});
  assert.equal(merged.microsoftWrites, 0, 'timed due: renderer owns the MS write');
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28', 'drag date survived the merge');

  // The MS write is confirmed by the Microsoft renderer (due + reminder).
  c.timeBridgeMsRenderer_(fx.state, fx.snap, 'Asia/Taipei', Date.now(), 'UTC');
  const duePatch = fx.msPatches.find((p) => p.payload.dueDateTime);
  assert.ok(duePatch, 'the renderer wrote the MS due');
  assert.equal(duePatch.payload.dueDateTime.dateTime.slice(0, 10), '2026-08-28',
    'final converged date === dragged date');
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28');
});

test('C11b: with the MS write blocked the drag date is still not reverted', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  mergeBaseline(c, fx);

  const draggedMs = c.timeBridgeWallClockToUtcMs_('2026-08-28T09:30:00', 'Asia/Taipei');
  cal.pageQueue.push({
    items: [{
      id: c.timeBridgeDeterministicEventId_('g-task'), status: 'confirmed', etag: 'etag-1',
      summary: 'Task',
      start: { dateTime: new Date(draggedMs).toISOString(), timeZone: 'Asia/Taipei' },
      end: { dateTime: new Date(draggedMs + 30 * 60 * 1000).toISOString(), timeZone: 'Asia/Taipei' }
    }],
    nextSyncToken: 'sync-1'
  });
  c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28');

  // The merge round runs with the MS write still unconfirmed: the merge's
  // date alignment keeps the planned (dragged) date...
  c.ordinaryReconcileMappedPair_(
    fx.state, fx.state.g2m['g-task'], fx.gTask, fx.msTask, 'g-list', {});
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28',
    'the drag date survives field-merge while the MS write is unconfirmed');

  // ...and a refused renderer write (R-4 ladder) also leaves the drag intact.
  c.updateMsTask_ = () => { throw new Error('HTTP 503'); };
  c.timeBridgeMsRenderer_(fx.state, fx.snap, 'Asia/Taipei', Date.now(), 'UTC');
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28',
    'a refused MS write must not revert the drag date');
});

/* ------------------------------------------------------------------ */
/* D2 quarantine release sweep — sticky-while-colliding, released-when-clear */
/* ------------------------------------------------------------------ */

/* A pair carrying the persisted quarantine flag on top of the echo fixture. */
function quarantinedFixture(c, cal, { title = 'Task' } = {}) {
  const fx = makeFixture(c, cal, { title });
  fx.state.g2m['g-task'].rem.collisionQuarantined = true;
  return fx;
}

/* A second, independent quarantined pair sharing the same state/snap, so a
 * per-pair failure can be observed NOT to abort the sweep of the next pair. */
function addSecondQuarantinedPair(c, fx, gId, msId) {
  const startMs = c.timeBridgeWallClockToUtcMs_('2026-09-01T14:00:00', 'Asia/Taipei');
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + 30 * 60 * 1000).toISOString();
  const fp = c.timeBridgeEventFingerprint_('Second', startIso, endIso, 'silent');
  fx.state.g2m[gId] = {
    msId, gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    td: { date: '2026-09-01', time: '14:00', v: 1 },
    rem: { e: c.timeBridgeDeterministicEventId_(gId), eFp: fp, collisionQuarantined: true }
  };
  fx.state.m2g[msId] = gId;
  fx.snap.gTasksById[gId] = {
    id: gId, title: 'Second', notes: '', status: 'needsAction',
    due: '2026-09-01T00:00:00.000Z', updated: '2026-08-14T00:00:00Z'
  };
  fx.snap.msTasksById[msId] = {
    id: msId, title: 'Second',
    body: { contentType: 'text', content: '' },
    status: 'notStarted',
    dueDateTime: { dateTime: '2026-09-01T00:00:00', timeZone: 'UTC' },
    isReminderOn: true,
    reminderDateTime: { dateTime: startIso, timeZone: 'UTC' },
    lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  return { startMs, startIso, endIso };
}

function assertFlagGone(fx) {
  assert.equal(fx.state.g2m['g-task'].rem.collisionQuarantined, undefined,
    'the quarantine flag must be released');
}

function assertFlagKept(fx) {
  assert.equal(fx.state.g2m['g-task'].rem.collisionQuarantined, true,
    'the pair must stay quarantined');
}

test('release sweep: GET 404 — collision source gone — releases the pair', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  // Nothing in cal.store → Calendar.Events.get throws 404 (mock default).

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.checked, 1);
  assert.equal(result.released, 1);
  assert.equal(result.stayed, 0);
  assert.equal(result.errors, 0);
  assertFlagGone(fx);
  assert.equal(fx.state.g2m['g-task'].td.time, '09:30', 'td untouched by the sweep');
  assertZeroCalendarWrites(cal);
});

test('release sweep: GET 410 releases the pair', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  const realGet = cal.Events.get;
  cal.Events.get = (calId, id) => {
    if (id === detId) { const e = new Error('HTTP 410'); e.statusCode = 410; throw e; }
    return realGet.call(cal.Events, calId, id);
  };

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.released, 1);
  assertFlagGone(fx);
  assertZeroCalendarWrites(cal);
});

test('release sweep: cancelled event at the slot releases the pair', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  cal.store[c.timeBridgeDeterministicEventId_('g-task')] = {
    id: c.timeBridgeDeterministicEventId_('g-task'), status: 'cancelled', etag: 'etag-x', summary: 'Task'
  };

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.released, 1);
  assertFlagGone(fx);
  assertZeroCalendarWrites(cal);
});

test('release sweep: echo fingerprint match (user reverted to our render) releases', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  cal.store[c.timeBridgeDeterministicEventId_('g-task')] =
    echoEvent({ id: c.timeBridgeDeterministicEventId_('g-task'), startIso: fx.startIso, endIso: fx.endIso });

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.checked, 1);
  assert.equal(result.released, 1);
  assert.equal(result.stayed, 0);
  assertFlagGone(fx);
  assertZeroCalendarWrites(cal);
});

test('release sweep: title match with valid baseline and etag releases (not foreign per C9)', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  // Same title, different start, etag present, stored fp still describes td:
  // adjudication itself would treat this as a user edit at our own slot, not
  // a collision — so the sweep releases the pair back to the normal flow.
  const draggedMs = c.timeBridgeWallClockToUtcMs_('2026-08-21T11:00:00', 'Asia/Taipei');
  cal.store[c.timeBridgeDeterministicEventId_('g-task')] =
    echoEvent({ id: c.timeBridgeDeterministicEventId_('g-task'), startIso: new Date(draggedMs).toISOString(), endIso: new Date(draggedMs + 30 * 60 * 1000).toISOString() });

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.released, 1);
  assertFlagGone(fx);
  assertZeroCalendarWrites(cal);
});

test('release sweep: all-day event still occupies the slot — stays quarantined', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  cal.store[c.timeBridgeDeterministicEventId_('g-task')] = {
    id: c.timeBridgeDeterministicEventId_('g-task'), status: 'confirmed', etag: 'etag-1', summary: 'Holiday',
    start: { date: '2026-08-21' }, end: { date: '2026-08-22' }
  };

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.checked, 1);
  assert.equal(result.released, 0);
  assert.equal(result.stayed, 1);
  assertFlagKept(fx);
  assertZeroCalendarWrites(cal);
});

test('release sweep: foreign fingerprint mismatch stays quarantined', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  // Different title AND different start with a valid baseline + etag: the C9
  // foreign predicate still holds, so the collision is not gone.
  cal.store[c.timeBridgeDeterministicEventId_('g-task')] = {
    id: c.timeBridgeDeterministicEventId_('g-task'), status: 'confirmed', etag: 'etag-9', summary: 'Not mine',
    start: { dateTime: '2026-08-21T15:00:00.000Z', timeZone: 'Asia/Taipei' },
    end: { dateTime: '2026-08-21T16:00:00.000Z', timeZone: 'Asia/Taipei' }
  };

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.released, 0);
  assert.equal(result.stayed, 1);
  assertFlagKept(fx);
  assertZeroCalendarWrites(cal);
});

test('release sweep: insufficient evidence stays quarantined (no storedFp / stale baseline / no etag)', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  const draggedMs = c.timeBridgeWallClockToUtcMs_('2026-08-21T11:00:00', 'Asia/Taipei');
  const draggedIso = new Date(draggedMs).toISOString();
  cal.store[detId] = echoEvent({ id: detId, startIso: draggedIso, endIso: new Date(draggedMs + 30 * 60 * 1000).toISOString() });

  // No stored fingerprint: nothing to compare, fail-closed.
  delete fx.state.g2m['g-task'].rem.eFp;
  let result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.stayed, 1);
  assertFlagKept(fx);

  // Stale baseline: stored fp describes neither the observed event nor what
  // the current td would project.
  fx.state.g2m['g-task'].rem.eFp = 'ffffffffffffffffffffffffffffffff';
  result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.stayed, 1);
  assertFlagKept(fx);

  // No etag: minimum change evidence missing.
  fx.state.g2m['g-task'].rem.eFp = fx.echoFp;
  delete cal.store[detId].etag;
  result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.stayed, 1);
  assertFlagKept(fx);
  assert.equal(result.errors, 0, 'a stay is a decision, not an error');
  assertZeroCalendarWrites(cal);
});

test('release sweep: a GET error stays fail-closed and the sweep continues to the next pair', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  const second = addSecondQuarantinedPair(c, fx, 'g-second', 'ms-second');
  const detIdA = c.timeBridgeDeterministicEventId_('g-task');
  const detIdB = c.timeBridgeDeterministicEventId_('g-second');
  cal.store[detIdB] = { id: detIdB, status: 'cancelled' }; // pair B: releasable
  const realGet = cal.Events.get;
  cal.Events.get = (calId, id) => {
    if (id === detIdA) { const e = new Error('HTTP 500'); e.statusCode = 500; throw e; } // pair A: server error
    return realGet.call(cal.Events, calId, id);
  };

  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.checked, 2, 'both quarantined pairs swept');
  assert.equal(result.released, 1, 'pair B released despite pair A failing');
  assert.equal(result.errors, 1, 'the 500 counted, not swallowed');
  assertFlagKept(fx);
  assert.equal(fx.state.g2m['g-second'].rem.collisionQuarantined, undefined,
    'the pair after the failing one was still processed');
  assert.ok(second);
  assertZeroCalendarWrites(cal);
});

test('release sweep: releasing a flag-only rem cleans up the empty rem object', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  fx.state.g2m['g-task'].rem = { collisionQuarantined: true };

  c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(fx.state.g2m['g-task'].rem, undefined,
    'an emptied rec.rem is deleted (same shape rule as the C3 path)');
  c.normalizeState_(fx.state);
});

test('release sweep: knob-off independence — works without the intake valve having run', () => {
  const { c, cal } = loadContext({ syncCalendarIntake: 'false' });
  const fx = quarantinedFixture(c, cal);
  // Intentionally: calendarIntakeRun_ is NEVER called; the property is off.
  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.released, 1, 'the sweep must not depend on the intake knob');
  assertFlagGone(fx);
  assert.equal(cal.counters.listCalls.length, 0, 'the sweep never lists');
  assertZeroCalendarWrites(cal);
});

test('release sweep: collisionQuarantined survives a persist-time normalizeState_', () => {
  const { c } = loadContext();
  const state = c.newState_();
  state.g2m['g-task'] = { msId: 'ms-task', gListId: 'g', msListId: 'm', rem: { collisionQuarantined: true } };
  c.normalizeState_(state);
  assert.equal(state.g2m['g-task'].rem.collisionQuarantined, true,
    'the flag round-trips the closed whitelist');
});

function assertInertCounts(result) {
  // Field-by-field: the counts object is created inside the vm context, so
  // deepStrictEqual's prototype check would flag it cross-realm.
  assert.equal(result.checked, 0);
  assert.equal(result.released, 0);
  assert.equal(result.stayed, 0);
  assert.equal(result.errors, 0);
}

test('release sweep: degenerate inputs are inert', () => {
  const { c, cal } = loadContext();
  const fx = quarantinedFixture(c, cal);
  const plain = makeFixture(c, cal); // no quarantine flag anywhere
  const before = JSON.stringify(fx.state);
  assertInertCounts(c.calendarIntakeReleaseQuarantines_(null, fx.snap, 'cal-1'));
  assertInertCounts(c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, null));
  assertInertCounts(c.calendarIntakeReleaseQuarantines_(plain.state, plain.snap, 'cal-1'),
    'no quarantined pair → no work');
  assert.equal(JSON.stringify(fx.state), before);
  assertZeroCalendarWrites(cal);
});

test('release sweep: intake quarantine followed by sweep release round-trips', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  // Round 1: an all-day collision quarantines the pair through the valve.
  cal.pageQueue.push({
    items: [{
      id: detId, status: 'confirmed', etag: 'etag-1', summary: 'Holiday',
      start: { date: '2026-08-21' }, end: { date: '2026-08-22' }
    }],
    nextSyncToken: 'sync-1'
  });
  const run = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(run.quarantined.length, 1);
  assertFlagKept(fx);

  // Round 2: the collision source is gone (user deleted the event) → release.
  const result = c.calendarIntakeReleaseQuarantines_(fx.state, fx.snap, 'cal-1');
  assert.equal(result.released, 1);
  assertFlagGone(fx);
  assertZeroCalendarWrites(cal);
});

/* ------------------------------------------------------------------ */
/* Gates and invariants                                                 */
/* ------------------------------------------------------------------ */

test('intake gate: incomplete inventory blocks every intake action', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  fx.snap.inventoryComplete = false;
  const before = JSON.stringify(fx.state);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'INCOMPLETE_INVENTORY');
  assert.equal(cal.counters.listCalls.length, 0, 'not even a read happens');
  assert.equal(JSON.stringify(fx.state), before, 'zero state mutations');
});

test('intake gate: the knob is opt-in and validated fail-closed', () => {
  const { c, cal, script } = loadContext({ syncCalendarIntake: 'false' });
  const fx = makeFixture(c, cal);
  const result = c.calendarIntakeRun_(fx.state, fx.snap, 0);
  assert.equal(result.enabled, false, 'knob off => inert');
  assert.equal(cal.counters.listCalls.length, 0);

  script.values['SYNC_CALENDAR_INTAKE'] = 'banana';
  assert.throws(() => c.calendarIntakeRun_(fx.state, fx.snap, 0), /CALENDAR_INTAKE_FLAG_INVALID/);
});

test('intake state writes round-trip through normalizeState_ without STATE_MALFORMED', () => {
  const { c, cal } = loadContext();
  const fx = makeFixture(c, cal);
  const draggedMs = c.timeBridgeWallClockToUtcMs_('2026-08-28T09:30:00', 'Asia/Taipei');
  cal.pageQueue.push({
    items: [{
      id: c.timeBridgeDeterministicEventId_('g-task'), status: 'confirmed', etag: 'etag-1',
      summary: 'Task',
      start: { dateTime: new Date(draggedMs).toISOString(), timeZone: 'Asia/Taipei' },
      end: { dateTime: new Date(draggedMs + 30 * 60 * 1000).toISOString(), timeZone: 'Asia/Taipei' }
    }],
    nextSyncToken: 'sync-1'
  });
  c.calendarIntakeRun_(fx.state, fx.snap, 0);
  // Adopted td keeps the closed whitelist shape {date,time,v}.
  c.normalizeState_(fx.state);
  assert.equal(fx.state.g2m['g-task'].td.date, '2026-08-28');
  assert.equal(fx.state.g2m['g-task'].td.time, '09:30');
});

test('intake reverse index resolves both the inherited rem.e and the current detId', () => {
  const { c } = loadContext();
  const state = c.newState_();
  state.g2m['g-old'] = { msId: 'ms1', gListId: 'g', msListId: 'm', rem: { e: c.timeBridgeDeterministicEventId_('dead-gid') } };
  state.g2m['g-new'] = { msId: 'ms2', gListId: 'g', msListId: 'm' };
  const index = c.calendarIntakeBuildReverseIndex_(state);
  // rec.rem.e inherited from a rotation keeps resolving to the CURRENT pair id.
  assert.equal(index[c.timeBridgeDeterministicEventId_('dead-gid')], 'g-old');
  // The current deterministic id resolves to its own pair.
  assert.equal(index[c.timeBridgeDeterministicEventId_('g-new')], 'g-new');
  assert.equal(index[c.timeBridgeDeterministicEventId_('g-old')], 'g-old');
});
