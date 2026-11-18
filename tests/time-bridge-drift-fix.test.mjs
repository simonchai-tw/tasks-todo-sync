import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* Drift-fix tests for time-bridge.gs against the frozen D2 spec
 * (tasks_todo_sync_v2_consolidated_verified_report.md §D2):
 *   - cancelled  -> conservative stop of projection, zero Calendar writes
 *   - 409        -> zero writes + rec.rem.collisionQuarantined, never a patch
 *   - eventResource carries extendedProperties.private.ttsOwner = '1'
 * The cancelled/knob semantics mirror calendar-intake.gs:314-325 (the CORRECT
 * intake-side implementation) and its SYNC_CALENDAR_INTAKE knob pattern. */

function blob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

/* Offline Calendar mock: every mutating verb is counted so the "zero Calendar
 * writes" assertions are mechanical.  No network. */
function makeCalendarMock() {
  const store = {};
  const counters = { get: 0, insert: 0, patch: 0, remove: 0 };
  const payloads = { insert: [], patch: [] };
  let forcedInsertStatus = null;
  const httpError = (code) => {
    const e = new Error('HTTP ' + code);
    e.statusCode = code;
    return e;
  };
  const Events = {
    get(calId, id) {
      counters.get += 1;
      const entry = store[id];
      if (entry === undefined) throw httpError(404);
      if (entry && entry.__status) throw httpError(entry.__status);
      return JSON.parse(JSON.stringify(entry));
    },
    insert(res, calId) {
      counters.insert += 1;
      payloads.insert.push(JSON.parse(JSON.stringify(res)));
      if (forcedInsertStatus !== null) throw httpError(forcedInsertStatus);
      store[res.id] = { ...JSON.parse(JSON.stringify(res)), status: 'confirmed' };
      return JSON.parse(JSON.stringify(store[res.id]));
    },
    patch(res, calId, id) {
      counters.patch += 1;
      payloads.patch.push(JSON.parse(JSON.stringify(res)));
      store[id] = { ...(store[id] || {}), ...JSON.parse(JSON.stringify(res)) };
      return JSON.parse(JSON.stringify(store[id]));
    },
    remove(calId, id) {
      counters.remove += 1;
      delete store[id];
    }
  };
  return { store, counters, payloads, Events, httpError, setForcedInsertStatus(code) { forcedInsertStatus = code; } };
}

function loadContext({ scriptProps = {} } = {}) {
  const script = {
    values: {
      SYNC_TIME_ZONE: 'Asia/Taipei',
      SYNC_TIME_BRIDGE: 'true',
      SYNC_CALENDAR_PROJECTION: 'true',
      ...scriptProps
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
      sleep() {}
    },
    Calendar: { Events: cal.Events },
    CalendarApp: {
      getCalendarsByName(name) {
        return [{ getId: () => 'test-cal-id', getName: () => name, isOwnedByMe: () => true }];
      },
      createCalendar(name) {
        return { getId: () => 'created-cal-id', getName: () => name, isOwnedByMe: () => true };
      }
    }
  });

  runGasFilesInContext(c);
  return { c, script, cal };
}

/* Projection arguments for a future td (2027-01-15 09:00 Asia/Taipei). */
function projectionArgs(c) {
  const startMs = c.timeBridgeWallClockToUtcMs_('2027-01-15T09:00:00', 'Asia/Taipei');
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + 30 * 60 * 1000).toISOString()
  };
}

function assertZeroCalendarWrites(cal) {
  assert.equal(cal.counters.patch, 0, 'Calendar.Events.patch must not run');
  assert.equal(cal.counters.insert, 0, 'Calendar.Events.insert must not run');
  assert.equal(cal.counters.remove, 0, 'Calendar.Events.remove must not run');
}

/* A rec whose stored fingerprint is STALE (td moved without the renderer
 * catching up) so the fingerprint early-return does not fire and the Calendar
 * get actually happens — the realistic path under which a cancelled tombstone
 * is observed outbound-side. */
function makeRec(c, remExtra) {
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  return {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', fp: {},
    td: { date: '2027-01-15', time: '09:00', v: 1 },
    rem: Object.assign({ e: detId, eFp: 'ffffffffffffffffffffffffffffffff' }, remExtra || {})
  };
}

function project(c, cal, rec, consumeOp) {
  const { startIso, endIso } = projectionArgs(c);
  return c.timeBridgeProjectCalendarEvent_('cal-1', 'g-task', 'T', startIso, endIso,
    'Asia/Taipei', rec, 'default', consumeOp || null);
}

/* ------------------------------------------------------------------ */
/* FIX 1 — cancelled: conservative stop of projection                  */
/* ------------------------------------------------------------------ */

test('D2 cancelled: stops projection conservatively — rem cleared, zero writes, td and MS reminder untouched', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { id: detId, status: 'cancelled', summary: 'T' };

  // Pair A: rem holds only projection keys -> rem disappears entirely.
  const recA = makeRec(c);
  // Pair B: rem also holds the MS reminder echo -> rem survives with msAt only.
  const recB = makeRec(c, { msAt: '2027-01-14T00:00:00.000Z' });

  const beforeTdA = JSON.stringify(recA.td);
  const beforeTdB = JSON.stringify(recB.td);

  assert.equal(project(c, cal, recA), false, 'nothing is projected for a cancelled event');
  assert.equal(project(c, cal, recB), false);

  assertZeroCalendarWrites(cal);
  assert.equal(cal.counters.get, 2, 'each pair performed exactly one read');

  assert.equal(recA.rem, undefined, 'an empty rem is deleted (calendar-intake.gs:321 pattern)');
  assert.equal(recB.rem.e, undefined, 'rec.rem.e cleared');
  assert.equal(recB.rem.eFp, undefined, 'rec.rem.eFp cleared');
  assert.equal(recB.rem.msAt, '2027-01-14T00:00:00.000Z', 'the MS reminder echo is untouched');
  assert.equal(JSON.stringify(recA.td), beforeTdA, 'rec.td untouched (conservative default)');
  assert.equal(JSON.stringify(recB.td), beforeTdB, 'rec.td untouched (conservative default)');
  assert.equal(recA.td.clear, undefined, 'no pendingClear is routed by default');
  assert.equal(recB.td.clear, undefined, 'no pendingClear is routed by default');
});

/* ------------------------------------------------------------------ */
/* FIX 1 — optional knob: delete-calendar-clears-time                  */
/* ------------------------------------------------------------------ */

test('D2 knob ON: cancelled also routes rec.td through the pendingClear path with no rebuild', () => {
  const { c, cal } = loadContext({
    scriptProps: { SYNC_TIME_BRIDGE_CALENDAR_DELETE_CLEARS_TIME: 'true' }
  });
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { id: detId, status: 'cancelled', summary: 'T' };
  const rec = makeRec(c);

  assert.equal(project(c, cal, rec), false, 'still no projection and no same-round rebuild');
  assertZeroCalendarWrites(cal);

  assert.deepEqual(JSON.parse(JSON.stringify(rec.td)),
    { date: '2027-01-15', time: null, v: 1, clear: true },
    'td keeps the date, loses the time, and carries clear:true (the intake NONE pendingClear shape)');
  assert.equal(rec.rem, undefined, 'projection state is still cleared');
});

test('D2 knob OFF variants: absent and explicit false both stay conservative', () => {
  for (const scriptProps of [{}, { SYNC_TIME_BRIDGE_CALENDAR_DELETE_CLEARS_TIME: 'false' }]) {
    const { c, cal } = loadContext({ scriptProps });
    const detId = c.timeBridgeDeterministicEventId_('g-task');
    cal.store[detId] = { id: detId, status: 'cancelled', summary: 'T' };
    const rec = makeRec(c);

    assert.equal(project(c, cal, rec), false);
    assertZeroCalendarWrites(cal);
    assert.deepEqual(JSON.parse(JSON.stringify(rec.td)),
      { date: '2027-01-15', time: '09:00', v: 1 }, 'td untouched');
    assert.equal(rec.td.clear, undefined, 'no pendingClear routed');
  }
});

test('D2 knob pattern: an invalid SYNC_TIME_BRIDGE_CALENDAR_DELETE_CLEARS_TIME value throws (calendar-intake pattern)', () => {
  const { c, cal } = loadContext({
    scriptProps: { SYNC_TIME_BRIDGE_CALENDAR_DELETE_CLEARS_TIME: 'yes' }
  });
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { id: detId, status: 'cancelled', summary: 'T' };
  const rec = makeRec(c);
  assert.throws(() => project(c, cal, rec), /TIME_BRIDGE_FLAG_INVALID|must be true or false/);
});

/* ------------------------------------------------------------------ */
/* FIX 2 — 409: zero patches, quarantine the pair                      */
/* ------------------------------------------------------------------ */

test('D2 insert-409: collision quarantine with zero Calendar writes and no confirm', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  // get -> 404 (no cached event), insert -> 409 (something occupies our id).
  cal.store[detId] = { __status: 404 };
  cal.setForcedInsertStatus(409);
  const rec = makeRec(c);

  const ops = [];
  assert.equal(project(c, cal, rec, () => ops.push(1)), false, 'nothing is projected');
  assert.equal(cal.counters.insert, 1, 'the insert was attempted once');
  assert.equal(cal.counters.patch, 0, 'NO blind re-patch after the 409');
  assert.equal(rec.rem.collisionQuarantined, true, 'the pair is quarantined');
  assert.equal(rec.rem.e, detId, 'the pre-existing projection state is left untouched (release is calendar-intake\'s job)');
  assert.equal(rec.rem.eFp, 'ffffffffffffffffffffffffffffffff', 'the fingerprint is NOT re-confirmed over a foreign event');
  assert.equal(ops.length, 1, 'the ops budget is still charged once for the attempted work');
  // The quarantined shape must survive the closed whitelist validator.
  const normState = c.newState_();
  normState.g2m['g-task'] = Object.assign({}, rec, { fp: { v: 1 } });
  normState.m2g['ms-task'] = 'g-task';
  c.normalizeState_(normState);
});

test('D2 get-409: collision quarantine with zero Calendar writes', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { __status: 409 };
  const rec = makeRec(c);

  assert.equal(project(c, cal, rec), false, 'nothing is projected');
  assert.equal(cal.counters.get, 1);
  assert.equal(cal.counters.patch, 0, 'NO blind re-patch after the 409');
  assert.equal(cal.counters.insert, 0, 'no insert either');
  assert.equal(rec.rem.collisionQuarantined, true, 'the pair is quarantined');
  assert.equal(rec.rem.eFp, 'ffffffffffffffffffffffffffffffff',
    'the stale fingerprint is NOT re-confirmed over a foreign event');
});

/* ------------------------------------------------------------------ */
/* FIX 3 — ttsOwner ownership marker on every write                    */
/* ------------------------------------------------------------------ */

test('D2 ttsOwner: the eventResource carries extendedProperties.private.ttsOwner="1" on insert AND patch', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');

  // Insert path: no cached event.
  const recInsert = makeRec(c);
  recInsert.rem = null;
  assert.equal(project(c, cal, recInsert), true);
  assert.equal(cal.counters.insert, 1);
  assert.deepEqual(cal.payloads.insert[0].extendedProperties, { private: { ttsOwner: '1' } },
    'the insert payload is stamped');

  // Patch path: a confirmed event we already own.
  cal.store[detId] = {
    id: detId, status: 'confirmed', summary: 'Old',
    start: { dateTime: projectionArgs(c).startIso, timeZone: 'Asia/Taipei' },
    end: { dateTime: projectionArgs(c).endIso, timeZone: 'Asia/Taipei' }
  };
  const recPatch = makeRec(c); // stale eFp forces the patch path
  assert.equal(project(c, cal, recPatch), true);
  assert.equal(cal.counters.patch, 1);
  assert.deepEqual(cal.payloads.patch[0].extendedProperties, { private: { ttsOwner: '1' } },
    'the patch payload is stamped');
});

/* ------------------------------------------------------------------ */
/* Regression — untouched paths stay byte-for-byte in behaviour         */
/* ------------------------------------------------------------------ */

test('regression: the confirmed-path patch is unchanged (no status override, confirm() still runs)', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  const { startIso, endIso } = projectionArgs(c);
  cal.store[detId] = {
    id: detId, status: 'confirmed', summary: 'T',
    start: { dateTime: startIso, timeZone: 'Asia/Taipei' },
    end: { dateTime: endIso, timeZone: 'Asia/Taipei' }
  };
  const rec = makeRec(c); // stale eFp -> fingerprint miss -> patch

  assert.equal(project(c, cal, rec), true, 'the normal path still projects');
  assert.equal(cal.counters.patch, 1);
  const payload = cal.payloads.patch[0];
  assert.equal(payload.status, undefined, 'no status key is smuggled into the ordinary patch');
  assert.equal(payload.id, detId);
  assert.equal(payload.summary, 'T');
  assert.equal(payload.start.dateTime, startIso);
  assert.deepEqual(payload.reminders.overrides, [{ method: 'popup', minutes: 0 }]);
  assert.equal(rec.rem.e, detId, 'confirm() still records the event id');
  assert.equal(rec.rem.eFp, c.timeBridgeEventFingerprint_('T', startIso, endIso, 'default'),
    'confirm() still records the fingerprint');
});

test('regression: 404 and 410 on get still fall through to insert', () => {
  for (const code of [404, 410]) {
    const { c, cal } = loadContext();
    const detId = c.timeBridgeDeterministicEventId_('g-task');
    cal.store[detId] = { __status: code };
    const rec = makeRec(c);
    rec.rem = null;

    assert.equal(project(c, cal, rec), true, 'HTTP ' + code + ' inserts');
    assert.equal(cal.counters.insert, 1);
    assert.equal(cal.counters.patch, 0);
    assert.equal(rec.rem.e, detId);
  }
});

test('regression: the delete path is unchanged (remove + rem.e/eFp cleared)', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { id: detId, status: 'confirmed' };
  const rec = makeRec(c);

  assert.equal(c.timeBridgeDeleteCalendarEvent_('cal-1', 'g-task', rec), true);
  assert.equal(cal.counters.remove, 1);
  assert.equal(cal.store[detId], undefined);
  assert.equal(rec.rem.e, undefined, 'rem.e cleared');
  assert.equal(rec.rem.eFp, undefined, 'rem.eFp cleared');
  assert.ok(rec.rem, 'other rem keys (e.g. msAt) survive the delete');
});

/* ------------------------------------------------------------------ */
/* Renderer-level integration                                          */
/* ------------------------------------------------------------------ */

function rendererFixture(c) {
  const state = {
    schema: 4, listMap: { 'g-list': 'ms-list' },
    calendarProjection: { calendarId: 'cal-1', v: 1 },
    g2m: {}, m2g: {}, subtasks: { mappings: {}, parents: {}, createJournal: {},
    pendingDeletions: {}, deletionJournal: {}, moveJournal: {}, conflicts: {},
    tombstones: { g: {}, ms: {} } }, tombstones: { g: {}, ms: {} }, listFaults: { g: {}, ms: {} },
    health: {}
  };
  state.g2m['g-task'] = makeRec(c);
  state.m2g['ms-task'] = 'g-task';
  const snap = {
    gTasksById: { 'g-task': { id: 'g-task', title: 'T', notes: 'body', status: 'needsAction' } },
    msTasksById: { 'ms-task': { id: 'ms-task', title: 'T', status: 'notStarted' } },
    gListByTask: { 'g-task': 'g-list' }, msListByTask: { 'ms-task': 'ms-list' }
  };
  return { state, snap };
}

test('renderer-level: a cancelled tombstone stops the pair end-to-end with zero writes', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { id: detId, status: 'cancelled', summary: 'T' };
  const { state, snap } = rendererFixture(c);
  const nowMs = Date.parse('2027-01-01T00:00:00Z');

  const result = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs,
    { enableCalendarProjection: true, enableCalendarProjectionReminder: true }, nowMs);
  assert.equal(result.projected, 0, 'the cancelled pair is not projected');
  assertZeroCalendarWrites(cal);
  assert.equal(state.g2m['g-task'].rem, undefined, 'projection state cleared');
  assert.deepEqual(JSON.parse(JSON.stringify(state.g2m['g-task'].td)),
    { date: '2027-01-15', time: '09:00', v: 1 }, 'td untouched (conservative)');
});

test('renderer-level: a collisionQuarantined pair is skipped entirely (existing :798 guard)', () => {
  const { c, cal } = loadContext();
  const detId = c.timeBridgeDeterministicEventId_('g-task');
  cal.store[detId] = { __status: 409 };
  const { state, snap } = rendererFixture(c);
  state.g2m['g-task'].rem.collisionQuarantined = true;
  const nowMs = Date.parse('2027-01-01T00:00:00Z');

  const result = c.timeBridgeCalendarRenderer_(state, snap, 'Asia/Taipei', nowMs,
    { enableCalendarProjection: true, enableCalendarProjectionReminder: true }, nowMs);
  assert.equal(result.projected, 0);
  assert.equal(cal.counters.get, 0, 'the quarantined pair is never even read');
});
