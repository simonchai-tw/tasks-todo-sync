/* Time Bridge engine (v0.8.0 — canonical time record + idempotent renderers)
 * Time lives in state as rec.td = { date, time|null, v } (wall clock only, never
 * an instant or a zone).  The [TTS-TIME:HH:mm] marker is an intake ticket: parsed
 * into rec.td, then spliced out.  Microsoft writes and Calendar projection are
 * idempotent renderers; `due` belongs to the ordinary three-way merge.
 * Round shape (§3.8): timeBridgeRun_ (intake/splice/Microsoft renderer) →
 * ordinaryReconcileMapped_ (the merge owns the DATE) →
 * timeBridgeRunRenderersAfterMerge_ (td.date sync + Calendar renderer).  The
 * Microsoft renderer must precede the merge because the merge fingerprints the
 * whole {date,time} unit, and the date sync must follow it or a stale td.date
 * would write the user's Microsoft date edit back away.
 * All top-level declarations end with _ to preserve publicEntrypoints === 58
 * (scripts/validate.mjs is the authority on that count).
 */

/* Digest, marker and time-zone helpers (behaviour unchanged since v0.7.x). */

function timeBridgeDeterministicEventId_(pairId) {
  var raw = String(pairId || '') + '|time_bridge';
  if (typeof Utilities === 'undefined' || !Utilities || typeof Utilities.computeDigest !== 'function' ||
      !Utilities.DigestAlgorithm || !Utilities.DigestAlgorithm.SHA_256) {
    throw new Error('TIME_BRIDGE_DIGEST_UNAVAILABLE');
  }
  var charset = Utilities.Charset && Utilities.Charset.UTF_8;
  var digest = charset
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, charset)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  var hex = '';
  for (var i = 0; i < digest.length && hex.length < 32; i += 1) {
    var b = digest[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex.slice(0, 32);
}

function timeBridgeEventFingerprint_(title, startIso, endIso, reminderMode) {
  var raw = String(title || '') + '|' + String(startIso || '') + '|' + String(endIso || '');
  // The reminders-on variant keeps the historical fingerprint byte for byte so an
  // upgrading installation does not re-patch every projected event; only the
  // silent variant adds a component, so flipping the knob re-converges events
  // one by one through the ordinary fingerprint comparison.
  if (reminderMode === 'silent') raw += '|silent';
  return ordinaryFingerprintHex_(raw);
}

/* The first two lines of a Google note are an engine header block: [TTS-REC]
 * (permanent identity for a Microsoft-native recurring task) and [TTS-TIME]
 * (a one-shot intake ticket).  A recurring task already owns line 1, so a user
 * adding a time naturally puts the ticket on line 2 — both orders must work.
 * Both header recognisers are the SAME ones the rest of the engine already
 * uses (TIME_BRIDGE_MARKER_REGEX_ accepts fullwidth brackets/colons, NONE and
 * padding; isTtsRecHeaderLine_ is shared with providers.gs).  No new grammar. */
function parseLeadingTtsHeadersUnified_(rawNotes) {
  var lines = String(rawNotes == null ? '' : rawNotes).split(/\r?\n/);
  var recHeader = null;
  var timeTicket = null;
  var consumedIndices = {};

  for (var i = 0; i < Math.min(lines.length, 2); i += 1) {
    var line = lines[i];
    if (!recHeader && isTtsRecHeaderLine_(line)) {
      recHeader = line.trim();
      consumedIndices[i] = true;
    } else if (!timeTicket && TIME_BRIDGE_MARKER_REGEX_.test(line)) {
      timeTicket = line;
      consumedIndices[i] = true;
    } else {
      break;
    }
  }

  var remainingLines = [];
  for (var j = 0; j < lines.length; j += 1) {
    if (!consumedIndices[j]) remainingLines.push(lines[j]);
  }
  // A blank separator line right after the header belongs to the header, as it
  // did when the ticket was the only first line (§3.3).
  if (timeTicket && remainingLines.length && remainingLines[0] === '') remainingLines.shift();
  var remainingBody = remainingLines.join('\n');
  var splicedNotes = recHeader
    ? (remainingBody ? recHeader + '\n' + remainingBody : recHeader)
    : remainingBody;

  return {
    recHeader: recHeader,
    timeTicket: timeTicket,
    consumedIndices: consumedIndices,
    remainingBody: remainingBody,
    splicedNotes: splicedNotes
  };
}

function timeBridgeParseNotesMarker_(notes) {
  if (notes == null || notes === '') return { markerValid: false };
  var text = String(notes);
  var lines = text.split(/\r?\n/);
  if (!lines.length) return { markerValid: false };
  var headers = parseLeadingTtsHeadersUnified_(text);

  // Fail-closed whole-notes check: a ticket outside the two-line engine header
  // is user content (or a malformed note), never an instruction to the engine.
  for (var i = 1; i < lines.length; i += 1) {
    if (headers.consumedIndices[i]) continue;
    if (TIME_BRIDGE_WHOLE_NOTES_CHECK_REGEX_.test(lines[i])) {
      console.warn('[TimeBridge] Marker found on line ' + (i + 1) + '; rejecting whole note fail-closed.');
      return { markerValid: false, wholeNotesRejected: true, line: i + 1 };
    }
  }

  var line1 = headers.timeTicket || lines[0];
  var match = line1.match(TIME_BRIDGE_MARKER_REGEX_);
  if (!match) return { markerValid: false };

  if (match[3] && match[3].toUpperCase() === 'NONE') {
    return { markerValid: true, isNone: true, exactMarkerLine: line1 };
  }

  var hh = match[1];
  var mm = match[2];
  if (hh === '00' && mm === '00') {
    console.warn('[TimeBridge] [TTS-TIME:00:00] rejected fail-closed: 00:00 is ambiguous with platform date-only midnight; use 00:01+ or set time in Microsoft To Do.');
    return { markerValid: false, midnightRejected: true };
  }

  return { markerValid: true, isNone: false, hh: hh, mm: mm, exactMarkerLine: line1 };
}

/* Migration helper only: does this Microsoft due payload carry a real time? */
function timeBridgeDueHasTime_(dueDateTime, syncTimeZone) {
  if (!dueDateTime || !dueDateTime.dateTime) return false;
  var raw = String(dueDateTime.dateTime);
  var match = raw.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!match) return false;
  var h = parseInt(match[1], 10);
  var m = parseInt(match[2], 10);
  var s = parseInt(match[3], 10);
  if (h === 0 && m === 0 && s === 0) return false;
  try {
    var instantMs = timeBridgeParseDateTimeZoneMs_(dueDateTime);
    var localHms = timeBridgeFormatHmsInTimeZone_(instantMs, syncTimeZone);
    if (localHms.h === 0 && localHms.m === 0 && localHms.s === 0) return false;
  } catch (e) {
    return false;
  }
  return true;
}

function timeBridgeParseDateTimeZoneMs_(dtz) {
  if (!dtz || !dtz.dateTime) return NaN;
  var raw = String(dtz.dateTime);
  var tz = dtz.timeZone || 'UTC';
  if (tz.toUpperCase() === 'UTC' || raw.endsWith('Z')) {
    var iso = raw.endsWith('Z') ? raw : raw + 'Z';
    return Date.parse(iso);
  }
  var ianaTz = timeBridgeResolveWindowsTimeZone_(tz);
  return timeBridgeWallClockToUtcMs_(raw, ianaTz);
}

function timeBridgeFormatHmsInTimeZone_(instantMs, timeZone) {
  var date = new Date(instantMs);
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    var formatted = Utilities.formatDate(date, timeZone, 'HH:mm:ss');
    var parts = formatted.split(':');
    return { h: parseInt(parts[0], 10), m: parseInt(parts[1], 10), s: parseInt(parts[2], 10) };
  }
  var formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  var partsIntl = formatter.formatToParts(date);
  var h = 0, m = 0, s = 0;
  for (var i = 0; i < partsIntl.length; i += 1) {
    if (partsIntl[i].type === 'hour') h = parseInt(partsIntl[i].value, 10);
    if (partsIntl[i].type === 'minute') m = parseInt(partsIntl[i].value, 10);
    if (partsIntl[i].type === 'second') s = parseInt(partsIntl[i].value, 10);
  }
  return { h: h, m: m, s: s };
}

function timeBridgeFormatYmdInTimeZone_(instantMs, timeZone) {
  var date = new Date(instantMs);
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
  }
  var formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(date);
}

function timeBridgeFormatHhMmInTimeZone_(instantMs, timeZone) {
  var hms = timeBridgeFormatHmsInTimeZone_(instantMs, timeZone);
  return (hms.h < 10 ? '0' : '') + hms.h + ':' + (hms.m < 10 ? '0' : '') + hms.m;
}

function timeBridgeResolveWindowsTimeZone_(windowsTz) {
  if (!windowsTz) return 'UTC';
  var key = String(windowsTz).trim().toLowerCase();
  if (MICROSOFT_WINDOWS_TIME_ZONES[key]) return MICROSOFT_WINDOWS_TIME_ZONES[key];
  return windowsTz;
}

function timeBridgeWallClockToUtcMs_(localIso, timeZone) {
  var match = String(localIso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return NaN;
  var targetY = parseInt(match[1], 10);
  var targetM = parseInt(match[2], 10);
  var targetD = parseInt(match[3], 10);
  var targetH = parseInt(match[4], 10);
  var targetMin = parseInt(match[5], 10);
  var targetSec = match[6] ? parseInt(match[6], 10) : 0;

  var guessMs = Date.UTC(targetY, targetM - 1, targetD, targetH, targetMin, targetSec);
  for (var iter = 0; iter < 5; iter += 1) {
    var curYmd = timeBridgeFormatYmdInTimeZone_(guessMs, timeZone);
    var curHms = timeBridgeFormatHmsInTimeZone_(guessMs, timeZone);
    var curParts = curYmd.split('-');
    var targetTotalSec = Date.UTC(targetY, targetM - 1, targetD, targetH, targetMin, targetSec) / 1000;
    var curTotalSec = Date.UTC(parseInt(curParts[0], 10), parseInt(curParts[1], 10) - 1, parseInt(curParts[2], 10),
      curHms.h, curHms.m, curHms.s) / 1000;
    var diffSec = targetTotalSec - curTotalSec;
    if (diffSec === 0) return guessMs;
    guessMs += diffSec * 1000;
  }
  return guessMs;
}

function timeBridgeSpliceNotesMarker_(notes, exactMarkerLine) {
  if (notes == null) return '';
  var text = String(notes);
  var headers = parseLeadingTtsHeadersUnified_(text);
  // The fresh read must still carry exactly the ticket this round parsed;
  // otherwise the note changed underneath us and nothing may be spliced.
  if (!headers.timeTicket || headers.timeTicket !== exactMarkerLine) return text;
  // Removing the ticket always leaves a [TTS-REC] header on line 1, so the
  // both-recurrence guard still finds its permanent marker.
  return headers.splicedNotes;
}

function timeBridgeCalendarHttpStatus_(e) {
  if (!e) return null;
  if (typeof e.httpStatus === 'number' && isFinite(e.httpStatus)) return e.httpStatus;
  if (typeof e.statusCode === 'number' && isFinite(e.statusCode)) return e.statusCode;
  if (typeof e.code === 'number' && isFinite(e.code)) return e.code;
  if (e.details && typeof e.details.code === 'number' && isFinite(e.details.code)) return e.details.code;
  var msg = String(e.message || '');
  var m = /(?:HTTP\s+|status\s*[:=]\s*|\bcode\s*[:=]\s*|\()(\d{3})(?:\b|\)|:)/i.exec(msg);
  if (m) return Number(m[1]);
  return providerHttpStatus_(e);
}

/* The Microsoft due payload as wall clock.  Graph renders the payload in the
 * authored zone (WO-5: the request carries Prefer: outlook.timezone), so an
 * offset-free payload already IS the wall clock; a payload carrying an instant
 * is projected into the authored zone instead.  Midnight means date-only
 * (time: null). */
function timeBridgeMsDueWallClock_(dueDateTime, authoredTimeZone) {
  if (!dueDateTime || !dueDateTime.dateTime) return null;
  var raw = String(dueDateTime.dateTime);
  var date = null;
  var time = null;
  if (/z$/i.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    var ms = Date.parse(raw);
    if (isNaN(ms)) return null;
    date = timeBridgeFormatYmdInTimeZone_(ms, authoredTimeZone);
    time = timeBridgeFormatHhMmInTimeZone_(ms, authoredTimeZone);
  } else {
    var m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    date = m[1];
    time = m[2] + ':' + m[3];
  }
  return { date: date, time: time === '00:00' ? null : time };
}

/* The zone Microsoft payloads are authored in (WO-5 mailbox discovery), falling
 * back to the project time zone exactly like v0.7.x did before the scope
 * existed. */
function timeBridgeAuthoredTimeZone_(syncTimeZone) {
  var authored = (typeof msAuthoredTimeZone_ === 'function') ? msAuthoredTimeZone_() : null;
  return authored || syncTimeZone;
}

function timeBridgeIsoSeconds_(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
}

function timeBridgeTdKey_(td) {
  if (!td) return null;
  return String(td.date || '') + 'T' + (td.time || '');
}

/* R-4 failure ladder (§3.4.5): rec.td.retry.<name> = { fails, lastFailAt, quarantined }. */

function timeBridgeRetryBucket_(rec, name) {
  if (!rec || !rec.td) return null;
  rec.td.retry = rec.td.retry || {};
  var bucket = rec.td.retry[name];
  if (!bucket || typeof bucket !== 'object') {
    bucket = { fails: 0, lastFailAt: null, quarantined: false };
    rec.td.retry[name] = bucket;
  }
  if (typeof bucket.fails !== 'number' || !isFinite(bucket.fails) || bucket.fails < 0) bucket.fails = 0;
  bucket.quarantined = bucket.quarantined === true;
  return bucket;
}

function timeBridgeRetryIsQuarantined_(rec, name) {
  var bucket = rec && rec.td && rec.td.retry ? rec.td.retry[name] : null;
  return !!(bucket && bucket.quarantined === true);
}

/* Quarantined pairs are skipped; once past the full-speed bound the renderer
 * only tries once per slow-lane interval. */
function timeBridgeRetryDue_(rec, name, nowMs) {
  var bucket = rec && rec.td && rec.td.retry ? rec.td.retry[name] : null;
  if (!bucket) return true;
  if (bucket.quarantined === true) return false;
  if ((bucket.fails || 0) <= TIME_BRIDGE_RETRY_FULL_SPEED_MAX) return true;
  var last = bucket.lastFailAt ? Date.parse(bucket.lastFailAt) : NaN;
  if (isNaN(last)) return true;
  return (nowMs - last) >= TIME_BRIDGE_RETRY_SLOW_LANE_INTERVAL_MS;
}

function timeBridgeRetryRecordSuccess_(rec, name) {
  if (!rec || !rec.td || !rec.td.retry || !rec.td.retry[name]) return;
  delete rec.td.retry[name];
  if (!Object.keys(rec.td.retry).length) delete rec.td.retry;
}

/* Returns { quarantined } — true only on the transition into the drawer, which
 * is what a single aggregated notification is sent for. */
function timeBridgeRetryRecordFailure_(rec, name, nowMs) {
  var bucket = timeBridgeRetryBucket_(rec, name);
  if (!bucket) return { quarantined: false };
  bucket.fails = (bucket.fails || 0) + 1;
  bucket.lastFailAt = new Date(nowMs).toISOString();
  if (bucket.quarantined === true) return { quarantined: false };
  if (bucket.fails > TIME_BRIDGE_RETRY_FULL_SPEED_MAX + TIME_BRIDGE_RETRY_SLOW_LANE_MAX) {
    bucket.quarantined = true;
    return { quarantined: true };
  }
  return { quarantined: false };
}

/* A user edit on the pair (marker or date) starts a fresh attempt. */
function timeBridgeRetryRevive_(rec) {
  if (rec && rec.td && rec.td.retry) delete rec.td.retry;
}

function timeBridgeBoundedErrorCode_(e) {
  var status = timeBridgeCalendarHttpStatus_(e);
  if (status) return 'HTTP_' + status;
  var msg = String((e && e.message) || e || 'UNKNOWN').replace(/\s+/g, ' ');
  return msg.slice(0, 60);
}

/* §3.2 Intake — the only place a marker is read; writes rec.td, no API. */

/* R-1 v0.8.2: the +20 guard is a ONE-SHOT at td creation.  A marker whose
 * moment already passed is lifted to the nearest future instant (now+20, or
 * now+5 when +20 crosses midnight, or now at the 23:59 edge) and from then on
 * the renderer writes exactly this authored time — it never re-lifts, so the
 * alarm converges instead of drifting 20 minutes forward every round. */
function timeBridgeApplyExpiryLift_(td, syncTimeZone, nowMs) {
  if (!td || !td.date || !td.time) return td;
  var instantMs = timeBridgeWallClockToUtcMs_(td.date + 'T' + td.time + ':00', syncTimeZone);
  if (!isFinite(instantMs) || instantMs >= nowMs) return td;
  var today = timeBridgeFormatYmdInTimeZone_(nowMs, syncTimeZone);
  var candidate = nowMs + 20 * 60 * 1000;
  if (timeBridgeFormatYmdInTimeZone_(candidate, syncTimeZone) !== today) {
    candidate = nowMs + 5 * 60 * 1000;
  }
  if (timeBridgeFormatYmdInTimeZone_(candidate, syncTimeZone) !== today) {
    candidate = nowMs;
  }
  td.date = timeBridgeFormatYmdInTimeZone_(candidate, syncTimeZone);
  td.time = timeBridgeFormatHhMmInTimeZone_(candidate, syncTimeZone);
  return td;
}

function timeBridgeIntakePair_(rec, gTask, msTask, syncTimeZone, nowMs, authoredTimeZone) {
  var parsed = timeBridgeParseNotesMarker_(gTask && gTask.notes);
  if (!parsed.markerValid) return parsed;
  var gDue = ordinaryCanonicalDueFromGoogle_(gTask);
  var msWall = timeBridgeMsDueWallClock_(msTask && msTask.dueDateTime, authoredTimeZone);
  var fallbackDate = (rec.td && rec.td.date) || (msWall && msWall.date) || gDue ||
    timeBridgeFormatYmdInTimeZone_(nowMs, syncTimeZone);

  var next;
  if (parsed.isNone) {
    // NONE is a clear-time intent: the record keeps the date but the time goes,
    // and `clear` tells the Microsoft renderer to wipe the leftover reminder
    // (which is OURS from a previous round, not a user edit).
    next = { date: fallbackDate, time: null, v: 1, clear: true };
  } else {
    next = { date: gDue || timeBridgeFormatYmdInTimeZone_(nowMs, syncTimeZone), time: parsed.hh + ':' + parsed.mm, v: 1 };
    timeBridgeApplyExpiryLift_(next, syncTimeZone, nowMs);
  }
  if (timeBridgeTdKey_(rec.td) !== timeBridgeTdKey_(next) || !!rec.td === false) {
    rec.td = next;
    timeBridgeRetryRevive_(rec);
  }
  return parsed;
}

function timeBridgeIntake_(state, snap, syncTimeZone, nowMs, authoredTimeZone) {
  var count = 0;
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec || !rec.msId) return;
    var gTask = snap.gTasksById[gId];
    var msTask = snap.msTasksById[rec.msId];
    if (!gTask || !msTask) return;
    var parsed = timeBridgeIntakePair_(rec, gTask, msTask, syncTimeZone, nowMs, authoredTimeZone);
    if (parsed && parsed.markerValid) count += 1;
  });
  return count;
}

/* §3.3 Splice renderer — idempotent; a failure keeps the marker and retries. */

function timeBridgeSpliceRenderer_(state, snap, syncTimeZone, nowMs) {
  var spliced = 0;
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec || !rec.msId) return;
    var gTask = snap.gTasksById[gId];
    if (!gTask) return;
    var parsed = timeBridgeParseNotesMarker_(gTask.notes);
    if (!parsed.markerValid || !parsed.exactMarkerLine) return;
    if (!timeBridgeRetryDue_(rec, 'splice', nowMs)) return;
    try {
      var fresh = getGTask_(rec.gListId, gId);
      var notes = fresh && fresh.notes != null ? String(fresh.notes) : '';
      if (notes.indexOf(parsed.exactMarkerLine) >= 0) {
        var finalNotes = timeBridgeSpliceNotesMarker_(notes, parsed.exactMarkerLine);
        updateGTask_(rec.gListId, gId, { notes: finalNotes });
        // Code.gs:1069-1071 reuses this snapshot for reconcileMapped_ in the
        // same round.  Mirror the provider write here: otherwise the merge
        // projects the ticket we just consumed, its [TTS-REC] header is no
        // longer on line 1 for field-merge.gs:391 to re-attach, and the W4
        // reread reports a phantom user edit against the stale string.
        gTask.notes = finalNotes;
        if (rec.fp && typeof rec.fp === 'object') {
          // A4 / BUG-V1-02: the merge baseline is ordinaryFieldFp_(gProj,'notes')
          // — the user notes AFTER the managed resource block and the [TTS-REC]
          // header have been stripped (field-merge.gs:126-144, :188-200).
          // Hashing the raw finalNotes made the next one-sided notes edit look
          // like a two-sided change, i.e. a phantom TRUE_FIELD_CONFLICT.
          // Only the notes projection is used here, so safety is deliberately
          // omitted; ordinaryProjectGoogle_ treats that as "bridge on".
          var gProj = ordinaryProjectGoogle_(gTask, rec, null);
          var notesFp = ordinaryFieldFp_(gProj, 'notes');
          // An unmergeable projection yields null; the merge skips notes this
          // round, so keep the last known baseline instead of poisoning it.
          if (notesFp !== null) rec.fp.notes = notesFp;
        }
        spliced += 1;
      }
      timeBridgeRetryRecordSuccess_(rec, 'splice');
    } catch (e) {
      console.warn('[TimeBridge] Splice failed for a pair: ' + timeBridgeBoundedErrorCode_(e));
      timeBridgeRetryRecordFailure_(rec, 'splice', nowMs);
    }
  });
  return spliced;
}

/* §3.4 Microsoft renderer — due time + reminder (R-1 single-rule policy). */

/* target = { wall, dateTime, timeZone, isReminderOn, reminderDateTime, reminderInstantMs }
 * Live-account fact (2026-09-23 probe): the Microsoft To Do API stores the due as
 * a DATE only — any time component in dueDateTime is dropped, whatever zone label
 * it carries.  So the due is always midnight and the TIME lives in the reminder,
 * following the R-1 alarm rule. */
function timeBridgeMsTarget_(td, syncTimeZone, nowMs, authoredTimeZone) {
  if (!td || !td.date) return null;
  var target = {
    wall: td.date + 'T00:00:00',
    dateTime: td.date + 'T00:00:00',
    timeZone: timeBridgeResolveWindowsTimeZone_(authoredTimeZone || syncTimeZone),
    isReminderOn: false,
    reminderDateTime: null,
    reminderInstantMs: null
  };
  if (!td.time) return target;
  // R-1 v0.8.2: the alarm is exactly the authored instant recorded in td.  The
  // now+20 guard fired ONCE when td was created (timeBridgeApplyExpiryLift_ in
  // the intake path); re-applying max(due, now+20) on every round made our own
  // write drift forward each round and the adopt path then read that drift back
  // as a user edit — the recurring +20-minute loop on Microsoft alarms.
  var instantMs = timeBridgeWallClockToUtcMs_(td.date + 'T' + td.time + ':00', syncTimeZone);
  if (!isFinite(instantMs)) return target;
  target.isReminderOn = true;
  target.reminderInstantMs = instantMs;
  target.reminderDateTime = { dateTime: timeBridgeIsoSeconds_(instantMs), timeZone: 'UTC' };
  return target;
}

function timeBridgeMsMatchesTarget_(msTask, target, authoredTimeZone) {
  if (!msTask || !target || !msTask.dueDateTime) return false;
  // Compare wall clocks (authored zone) rather than raw payload strings: Graph
  // may append fractional seconds, and a payload carrying an instant must still
  // compare equal when it lands on the same wall clock.
  var observed = timeBridgeMsDueWallClock_(msTask.dueDateTime, authoredTimeZone);
  if (!observed) return false;
  if (observed.date !== target.dateTime.slice(0, 10)) return false;
  // The Microsoft due is always date-only (the API drops the time component).
  if (observed.time !== null) return false;
  if (!!msTask.isReminderOn !== target.isReminderOn) return false;
  if (!target.isReminderOn) return true;
  if (!msTask.reminderDateTime) return false;
  var msReminderMs = timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime);
  return !isNaN(msReminderMs) && Math.abs(msReminderMs - target.reminderInstantMs) <= 60000;
}

/* UTC echo of the reminder instant this engine last wrote (or confirmed) on
 * Microsoft.  rec.td is a wall clock with no zone, so a project time-zone or
 * DST offset change re-interprets the SAME remote instant as a different HH:mm.
 * The echo is what separates those two cases: an unchanged remote instant means
 * nobody edited the reminder.  `msAt` is the v0.7.5 field name and is already
 * accepted by the state validator, so this guard needs no schema change. */
function timeBridgeMsReminderEchoMatches_(rec, msTask) {
  var echoMs = rec && rec.rem && rec.rem.msAt ? Date.parse(rec.rem.msAt) : NaN;
  if (isNaN(echoMs) || !msTask || !msTask.isReminderOn || !msTask.reminderDateTime) return false;
  var remoteMs = timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime);
  // Graph may truncate seconds; the renderer already uses the same tolerance.
  return isFinite(remoteMs) && Math.abs(remoteMs - echoMs) <= 60000;
}

function timeBridgeSetMsReminderEcho_(rec, instantMs) {
  if (!rec) return;
  if (instantMs === null || instantMs === undefined || !isFinite(instantMs)) {
    if (rec.rem) {
      delete rec.rem.msAt;
      if (!Object.keys(rec.rem).length) delete rec.rem;
    }
    return;
  }
  rec.rem = rec.rem || {};
  rec.rem.msAt = new Date(instantMs).toISOString();
}

/* Adopt a Microsoft-side time the user set by hand (the only other authoring
 * surface for a time on a task).  The reminder is the primary signal — the due
 * payload never carries a time (the API drops it).  Our own writes converge to
 * the same value, so a difference means the user edited it. */
function timeBridgeMsAdoptObservation_(rec, msTask, syncTimeZone, authoredTimeZone) {
  if (!rec || !rec.td) return false;
  // A pending NONE clear means the leftover reminder is ours to wipe, never a
  // user edit to adopt.
  if (rec.td.clear === true) return false;
  // An unchanged remote instant is a zone/DST shift, not a user edit.  Leave
  // rec.td alone and let the renderer repaint the wall clock under the new zone.
  if (timeBridgeMsReminderEchoMatches_(rec, msTask)) return false;
  var adopted = null;
  var observedReminderMs = null;
  if (msTask && msTask.isReminderOn && msTask.reminderDateTime) {
    var reminderMs = timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime);
    if (!isNaN(reminderMs)) {
      observedReminderMs = reminderMs;
      adopted = {
        date: timeBridgeFormatYmdInTimeZone_(reminderMs, syncTimeZone),
        time: timeBridgeFormatHhMmInTimeZone_(reminderMs, syncTimeZone)
      };
    }
  } else {
    var observed = timeBridgeMsDueWallClock_(msTask && msTask.dueDateTime, authoredTimeZone);
    if (observed && observed.time) adopted = { date: observed.date, time: observed.time };
  }
  if (!adopted) return false;
  if (timeBridgeTdKey_(rec.td) === timeBridgeTdKey_(adopted)) return false;
  rec.td = { date: adopted.date, time: adopted.time, v: 1 };
  // The genuinely edited instant becomes the new echo, so a later zone change
  // does not adopt it a second time.
  timeBridgeSetMsReminderEcho_(rec, observedReminderMs);
  timeBridgeRetryRevive_(rec);
  return true;
}

function timeBridgeMsRenderer_(state, snap, syncTimeZone, nowMs, authoredTimeZone) {
  var patched = 0;
  var quarantined = [];
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec || !rec.msId || !rec.td) return;
    // Date-only pairs without a pending clear are left entirely alone: the
    // reminder on such a task belongs to the user, not to the engine.
    var pendingClear = rec.td.clear === true;
    if (!rec.td.time && !pendingClear) return;
    var msTask = snap.msTasksById[rec.msId];
    if (!msTask) return;
    // 2026-10-11 recurrence storm: a Microsoft-native recurring task is owned
    // by Microsoft's recurrence engine. Rendering due/reminder into it
    // re-anchors the series and makes Microsoft spawn the next occurrence.
    // The time bridge never writes to native recurring tasks.
    if (msTaskHasRecurrence_(msTask)) return;
    // While a due conflict is unresolved the merge owns the outcome: writing a
    // due here would pick a side silently.
    if (rec.fc && rec.fc.due) return;
    if (!timeBridgeRetryDue_(rec, 'ms', nowMs)) return;
    // A pending NONE clear means the leftover reminder is OURS from a previous
    // round — it must be wiped, never adopted back as a user edit.
    if (!pendingClear && timeBridgeMsAdoptObservation_(rec, msTask, syncTimeZone, authoredTimeZone)) return;
    var target = timeBridgeMsTarget_(rec.td, syncTimeZone, nowMs, authoredTimeZone);
    if (!target) return;
    var observed = timeBridgeMsDueWallClock_(msTask.dueDateTime, authoredTimeZone);
    var dueOk = !!observed && observed.date === rec.td.date && observed.time === null;
    // R-1 v0.8.2: an alarm whose moment has already passed stays exactly as
    // Microsoft holds it — repainting a past reminder would fake a fresh alert
    // and, on recurring tasks, fight Microsoft's own recurrence engine.  Only
    // FUTURE alarms are owned by this renderer; a clear (isReminderOn false)
    // still wipes leftovers unconditionally.
    var reminderOk;
    if (target.isReminderOn && target.reminderInstantMs >= nowMs) {
      reminderOk = !!msTask.isReminderOn && !!msTask.reminderDateTime &&
        Math.abs(timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime) - target.reminderInstantMs) <= 60000;
    } else if (target.isReminderOn) {
      reminderOk = true;
    } else {
      reminderOk = !msTask.isReminderOn;
    }
    if (dueOk && reminderOk) {
      // A convergent round is also a confirmed echo — an upgrading deployment
      // with no msAt yet gets its guard armed here without any remote write.
      timeBridgeSetMsReminderEcho_(rec, target.isReminderOn ? target.reminderInstantMs : null);
      timeBridgeRetryRecordSuccess_(rec, 'ms');
      return;
    }
    // Live-account fact (2026-09-23, wipe probe): Graph ignores reminder fields
    // when a PATCH also carries dueDateTime, so the two are written separately.
    // The proven wipe form is { isReminderOn:false, reminderDateTime:null }.
    try {
      if (!reminderOk) {
        var reminderPayload = { isReminderOn: target.isReminderOn };
        reminderPayload.reminderDateTime = target.isReminderOn ? target.reminderDateTime : null;
        updateMsTask_(rec.msListId, rec.msId, reminderPayload);
        patched += 1;
      }
      if (!dueOk) {
        updateMsTask_(rec.msListId, rec.msId, { dueDateTime: { dateTime: rec.td.date + 'T00:00:00', timeZone: target.timeZone } });
      }
      timeBridgeRetryRecordSuccess_(rec, 'ms');
      // Every successful render re-arms the echo at the instant we just wrote
      // (or wipes it when the reminder was cleared).
      timeBridgeSetMsReminderEcho_(rec, target.isReminderOn ? target.reminderInstantMs : null);
      if (pendingClear) delete rec.td.clear;
    } catch (e) {
      var code = timeBridgeBoundedErrorCode_(e);
      console.warn('[TimeBridge] Microsoft render failed for a pair: ' + code);
      var outcome = timeBridgeRetryRecordFailure_(rec, 'ms', nowMs);
      if (outcome.quarantined) quarantined.push({ gId: gId, renderer: 'ms', code: code });
    }
  });
  return { patched: patched, quarantined: quarantined };
}

/* §3.7 Calendar renderer (SYNC_CALENDAR_PROJECTION ships ON by default since
 * the 2026-09-30 product decision; the popup reminder knob stays OFF). */

function timeBridgeGetOrCreateCalendar_(state, syncTimeZone) {
  if (typeof CalendarApp === 'undefined') return null;
  var cached = state && state.calendarProjection && state.calendarProjection.calendarId;
  if (cached) return cached;
  try {
    var calendars = CalendarApp.getCalendarsByName(TIME_BRIDGE_CALENDAR_SUMMARY);
    var owned = calendars.filter(function(cal) {
      return typeof cal.isOwnedByMe === 'function' ? cal.isOwnedByMe() : true;
    });
    var calendarId = null;
    if (owned.length > 0) {
      calendarId = owned[0].getId();
    } else {
      // Time zone and selection are a one-time property of the calendar, not a
      // per-round side effect.
      calendarId = CalendarApp.createCalendar(TIME_BRIDGE_CALENDAR_SUMMARY, {
        timeZone: syncTimeZone,
        selected: true
      }).getId();
    }
    if (calendarId) {
      state.calendarProjection = { calendarId: calendarId, v: 1 };
      persistSyncState_(state);
    }
    return calendarId;
  } catch (e) {
    console.warn('[TimeBridge] Failed to get or create projection calendar: ' + timeBridgeBoundedErrorCode_(e));
    return null;
  }
}

function timeBridgeProjectCalendarEvent_(calendarId, pairId, title, startIso, endIso, syncTimeZone, rec, reminderMode, consumeOp) {
  var deterministicId = timeBridgeDeterministicEventId_(pairId);
  var targetFp = timeBridgeEventFingerprint_(title, startIso, endIso, reminderMode);
  var fingerprintSlot = rec.rem && rec.rem.eFp;

  // A fingerprint hit is a pure in-memory comparison: zero Calendar.Events
  // calls, so it must not consume the per-round ops budget (BUG-V1-04).
  if (rec.rem && rec.rem.e === deterministicId && fingerprintSlot === targetFp) return false;

  // Charge exactly once here — after the miss and BEFORE the first network
  // call — so a provider error still counts.  Counting only successful writes
  // would let a round issue an unbounded number of failing API calls.
  if (typeof consumeOp === 'function') consumeOp();

  var eventResource = {
    id: deterministicId,
    summary: title || 'Task',
    start: { dateTime: startIso, timeZone: syncTimeZone },
    end: { dateTime: endIso, timeZone: syncTimeZone },
    reminders: {
      useDefault: false,
      overrides: reminderMode === 'silent' ? [] : [{ method: 'popup', minutes: 0 }]
    }
  };

  function confirm() {
    rec.rem = rec.rem || {};
    rec.rem.e = deterministicId;
    rec.rem.eFp = targetFp;
  }

  try {
    var existing = Calendar.Events.get(calendarId, deterministicId);
    if (existing && existing.status === 'cancelled') {
      Calendar.Events.patch(Object.assign({}, eventResource, { status: 'confirmed' }), calendarId, deterministicId);
      confirm();
      return true;
    }
    if (existing && existing.status === 'confirmed') {
      Calendar.Events.patch(eventResource, calendarId, deterministicId);
      confirm();
      return true;
    }
  } catch (e) {
    var status = timeBridgeCalendarHttpStatus_(e);
    if (status === 404 || status === 410) {
      try {
        Calendar.Events.insert(eventResource, calendarId);
        confirm();
        return true;
      } catch (insertErr) {
        if (timeBridgeCalendarHttpStatus_(insertErr) === 409) {
          Calendar.Events.patch(Object.assign({}, eventResource, { status: 'confirmed' }), calendarId, deterministicId);
          confirm();
          return true;
        }
        throw insertErr;
      }
    }
    if (status === 409) {
      Calendar.Events.patch(Object.assign({}, eventResource, { status: 'confirmed' }), calendarId, deterministicId);
      confirm();
      return true;
    }
    throw e;
  }
  return false;
}

function timeBridgeDeleteCalendarEvent_(calendarId, pairId, rec) {
  var deterministicId = timeBridgeDeterministicEventId_(pairId);
  try {
    Calendar.Events.remove(calendarId, deterministicId);
  } catch (e) {
    var status = timeBridgeCalendarHttpStatus_(e);
    if (status !== 404 && status !== 410) {
      console.warn('[TimeBridge] Failed to delete calendar event: ' + timeBridgeBoundedErrorCode_(e));
      throw e;
    }
  }
  if (rec && rec.rem) {
    delete rec.rem.e;
    delete rec.rem.eFp;
  }
  return true;
}

function timeBridgeCalendarRenderer_(state, snap, syncTimeZone, nowMs, safety, startedAt) {
  var result = { projected: 0, deleted: 0, quarantined: [] };
  if (!safety || !safety.enableCalendarProjection) return result;
  if (typeof Calendar === 'undefined') return result;
  var reminderMode = safety.enableCalendarProjectionReminder === false ? 'silent' : 'default';
  var calendarId = timeBridgeGetOrCreateCalendar_(state, syncTimeZone);
  if (!calendarId) return result;
  var opsCount = 0;

  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    if (opsCount >= TIME_BRIDGE_OPS_MAX_PER_ROUND) return;
    var rec = state.g2m[gId];
    if (!rec || !rec.msId) return;
    var gTask = snap.gTasksById[gId];
    if (!gTask) return;
    var completed = gTask.status === 'completed' ||
      (snap.msTasksById[rec.msId] && snap.msTasksById[rec.msId].status === 'completed');
    var hasTime = !!(rec.td && rec.td.time) && !completed;
    // A Microsoft-native recurring task is immutable to the MS renderer (§3.4).
    // Re-projecting its Calendar instant under a changed zone would leave the
    // Calendar and the Microsoft reminder at two different instants, so the
    // projection is frozen with them.  Cleanup of a removed time still runs.
    if (hasTime && msTaskHasRecurrence_(snap.msTasksById[rec.msId])) return;
    if (!timeBridgeRetryDue_(rec, 'cal', nowMs)) return;
    try {
      if (!hasTime) {
        if (rec.rem && rec.rem.e) {
          opsCount += 1;
          timeBridgeDeleteCalendarEvent_(calendarId, gId, rec);
          result.deleted += 1;
        }
        timeBridgeRetryRecordSuccess_(rec, 'cal');
        return;
      }
      var startMs = timeBridgeWallClockToUtcMs_(rec.td.date + 'T' + rec.td.time + ':00', syncTimeZone);
      if (!isFinite(startMs) || startMs < nowMs) {
        timeBridgeRetryRecordSuccess_(rec, 'cal');
        return;
      }
      var startIso = new Date(startMs).toISOString();
      var endIso = new Date(startMs + TIME_BRIDGE_EVENT_DURATION_MINUTES * 60 * 1000).toISOString();
      // The ops budget counts attempted Calendar.Events work only, never
      // in-memory fingerprint examinations — otherwise already-projected
      // pairs would starve the pairs late in the key order (BUG-V1-04).
      // The projection function charges once itself, right after a miss.
      if (timeBridgeProjectCalendarEvent_(calendarId, gId, gTask.title, startIso, endIso,
        syncTimeZone, rec, reminderMode, function() { opsCount += 1; })) {
        result.projected += 1;
      }
      timeBridgeRetryRecordSuccess_(rec, 'cal');
    } catch (e) {
      var code = timeBridgeBoundedErrorCode_(e);
      console.warn('[TimeBridge] Calendar render failed for a pair: ' + code);
      // A cached calendar that no longer resolves invalidates the cache so the
      // next round looks the calendar up again.
      if (code === 'HTTP_404' && state.calendarProjection) delete state.calendarProjection;
      var outcome = timeBridgeRetryRecordFailure_(rec, 'cal', nowMs);
      if (outcome.quarantined) result.quarantined.push({ gId: gId, renderer: 'cal', code: code });
    }
  });
  return result;
}

/* §4 Migration from the v0.7.x state shape. */

function timeBridgeMigrateLegacyRem_(state, snap, syncTimeZone, authoredTimeZone) {
  var rebuilt = 0;
  var cleared = 0;
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec) return;
    var rem = rec.rem;
    // `msAt` is live again: it is the UTC echo of the reminder we last rendered.
    // Dropping it here would disarm the zone/DST adopt guard on every round.
    var hasLegacy = !!(rem && (rem.ms !== undefined ||
      rem.hasTime !== undefined || rem.markerOrphaned !== undefined));
    if (!rec.td && rec.msId) {
      var msTask = snap.msTasksById[rec.msId];
      var wall = timeBridgeMsDueWallClock_(msTask && msTask.dueDateTime, authoredTimeZone);
      if (wall && wall.time) {
        rec.td = { date: wall.date, time: wall.time, v: 1 };
        rebuilt += 1;
      } else if (msTask && msTask.isReminderOn && msTask.reminderDateTime) {
        var reminderMs = timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime);
        if (!isNaN(reminderMs)) {
          var reminderTime = timeBridgeFormatHhMmInTimeZone_(reminderMs, syncTimeZone);
          if (reminderTime !== '00:00') {
            rec.td = {
              date: timeBridgeFormatYmdInTimeZone_(reminderMs, syncTimeZone),
              time: reminderTime,
              v: 1
            };
            rebuilt += 1;
          }
        }
      }
    }
    if (hasLegacy) {
      // The v0.7.5 ownership tri-state is dropped once rec.td has been rebuilt;
      // e / eFp (Calendar projection) and msAt (reminder echo) both survive.
      delete rec.rem.ms;
      delete rec.rem.hasTime;
      delete rec.rem.markerOrphaned;
      if (!Object.keys(rec.rem).length) delete rec.rem;
      cleared += 1;
    }
  });

  var legacyJournal = null;
  if (state.timeBridgeJournal) {
    legacyJournal = 1;
    state.timeBridgeJournal = null;
  }
  var deadLetterCount = Array.isArray(state.deadLetterJournal) ? state.deadLetterJournal.length : 0;
  if (deadLetterCount) {
    // §4.4: the old drawer was unattended and may have held only transient
    // failures, so every pair starts again from a clean slate.
    state.deadLetterJournal = [];
  }
  return { rebuilt: rebuilt, cleared: cleared, legacyJournal: legacyJournal, deadLetterCleared: deadLetterCount };
}

/* §3.4.5 quarantine notification — one aggregated mail per round. */

function timeBridgeNotifyQuarantine_(entries) {
  if (!entries || !entries.length) return false;
  if (!canSendAlert_(ALERT_KEYS.timeBridgeQuarantine, ALERT_COOLDOWN_MS)) {
    console.warn('[TimeBridge] Quarantine notification is still in its cooldown period; email skipped.');
    return false;
  }
  var lines = entries.map(function(entry) {
    return '- ' + previewOpaqueId_('pair', entry.gId) + ' · ' + entry.renderer + ' · ' + entry.code;
  });
  var subject = '[Sync engine] ' + entries.length + ' task(s) moved to the Time Bridge drawer';
  var body = 'Time Bridge stopped retrying these tasks after repeated failures and put them in the drawer.\n' +
    'Nothing was deleted, and the ordinary task fields keep syncing.\n\n' +
    lines.join('\n') + '\n\n' +
    'To retry: edit the task marker in Google Tasks or change its date, then run syncAll().';
  var sent = sendMailAlert_(subject, body);
  if (sent) markAlertSent_(ALERT_KEYS.timeBridgeQuarantine);
  return sent;
}

/* §3.8 Orchestrator. */

/* v1.2.0 P1-3: notes-tail time micro-badge renderer.  Invoked from
 * timeBridgeRun_ ONLY when the SYNC_TIME_BADGE knob is on (and the bridge is
 * on), for pairs carrying rec.td.time.  It rewrites BOTH provider sides so the
 * exact badge "🕒 HH:mm" sits at the END of the user notes and BEFORE the
 * managed resource block, then records that exact string in
 * rec.rem.lastRenderedBadge.
 *
 * Idempotence: the previous badge (lastRenderedBadge) is stripped with a strict
 * === comparison before composing again.  A repeated round with an unchanged
 * time produces the identical string and performs NO provider write; a changed
 * time strips the OLD badge first, so badges never stack.  The snapshot is
 * updated in place so the same-round reconcileMapped_ sees the new notes and
 * the merge baseline (which strips the badge in its projection) stays stable.
 *
 * Spec §伍: an unmergeable status (MALFORMED / AMBIGUOUS / UNOWNED) or a null
 * canonicalUserNotes on EITHER side skips the whole notes column
 * (NOTES_UNMERGEABLE); userNotes is never used as a fallback. */
function timeBridgeRenderNotesBadge_(state, snap, safety) {
  var result = { rendered: 0, rewritten: 0, skipped: 0 };
  // Defense in depth: even a stray caller must not rewrite user notes unless
  // the opt-in knob is explicitly on.
  if (!safety || !safety.enableTimeBadge) return result;
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec || !rec.msId) return;
    if (!rec.td || !rec.td.time) return;
    var gTask = snap.gTasksById[gId];
    var msTask = snap.msTasksById[rec.msId];
    if (!gTask || !msTask) return;

    var newBadge = '🕒 ' + rec.td.time;
    var oldBadge = (rec.rem && typeof rec.rem.lastRenderedBadge === 'string')
      ? rec.rem.lastRenderedBadge : '';
    var res = rec.res || {};

    var gParsed = parseManagedResourceBlock_(gTask.notes, res.gBlockFp, res.gBlockIntentFp);
    var msParsed = parseManagedResourceBlock_(microsoftNotesPlainTextProjection_(msTask),
      res.msBlockFp, res.msBlockIntentFp);
    if (!notesWriteAllowed_(gParsed.status) || gParsed.canonicalUserNotes === null ||
        !notesWriteAllowed_(msParsed.status) || msParsed.canonicalUserNotes === null) {
      result.skipped += 1;
      return;
    }

    var gStripped = splitTtsRecMarkerLine_(googleNotesPlainTextProjection_(gParsed.canonicalUserNotes));
    var gClean = stripRenderedTimeBadge_(gStripped.notes, oldBadge);
    var msClean = stripRenderedTimeBadge_(
      googleNotesPlainTextProjection_(msParsed.canonicalUserNotes), oldBadge);

    var gComposed = composeManagedNotes_(gClean, gParsed.block, newBadge);
    if (gStripped.markerLine) {
      gComposed = gStripped.markerLine + (gComposed ? '\n' + gComposed : '');
    }
    var msComposed = composeManagedNotes_(msClean, msParsed.block, newBadge);
    var msIsHtml = !!(msTask.body && String(msTask.body.contentType || '').toLowerCase() === 'html');
    var msContent = msIsHtml ? textToHtml_(msComposed) : msComposed;

    var gBefore = gTask.notes == null ? '' : String(gTask.notes);
    var msBefore = msTask.body && msTask.body.content != null ? String(msTask.body.content) : '';
    var gChanged = gComposed !== gBefore;
    var msChanged = msContent !== msBefore;
    // Isolate one pair's provider failure exactly like the other Time Bridge
    // renderers: a single bad pair must not abort the whole round.  On failure
    // the snapshot and state stay untouched, so the pair is retried next round
    // against the previous badge value.
    try {
      if (gChanged) updateGTask_(rec.gListId, gId, { notes: gComposed });
      if (msChanged) {
        updateMsTask_(rec.msListId, rec.msId, {
          body: { contentType: msIsHtml ? 'html' : 'text', content: msContent }
        });
      }
    } catch (e) {
      console.warn('[TimeBridge] Badge render failed for a pair: ' + timeBridgeBoundedErrorCode_(e));
      result.skipped += 1;
      return;
    }
    if (gChanged) {
      gTask.notes = gComposed;
      result.rewritten += 1;
    }
    if (msChanged) {
      msTask.body = { contentType: msIsHtml ? 'html' : 'text', content: msContent };
      result.rewritten += 1;
    }
    if (!rec.rem || typeof rec.rem !== 'object') rec.rem = {};
    rec.rem.lastRenderedBadge = newBadge;
    result.rendered += 1;
  });
  return result;
}

function timeBridgeRun_(state, snap, startedAt, roundId) {
  var safety = getSafetyConfig_();
  var syncTimeZone = syncTimeZone_();
  var nowMs = Date.now();
  var authoredTimeZone = timeBridgeAuthoredTimeZone_(syncTimeZone);
  var summary = { migrated: null, intaken: 0, spliced: 0, msPatched: 0, quarantined: [] };

  if (!safety.enableTimeBridge) {
    // Knob OFF: no intake, no renderers, and no legacy-record migration.  A
    // disabled feature must not rewrite state either — the migration used to
    // run before this check, rebuilding rec.td and deleting legacy rem keys
    // on deployments that had turned the bridge off (advisory review
    // 2026-10-13, §3.15).  It waits here until the knob is on.  `due` stays
    // fully owned by the merge and the time component is ignored there, so
    // nothing has to be released here.
    return summary;
  }

  summary.migrated = timeBridgeMigrateLegacyRem_(state, snap, syncTimeZone, authoredTimeZone);

  summary.intaken = timeBridgeIntake_(state, snap, syncTimeZone, nowMs, authoredTimeZone);
  if (!remainingTimeOk_(startedAt, 30000)) return summary;
  summary.spliced = timeBridgeSpliceRenderer_(state, snap, syncTimeZone, nowMs);
  if (!remainingTimeOk_(startedAt, 30000)) return summary;
  // v1.2.0 P1-3: opt-in, OFF by default.  Stripping in the fingerprint
  // projection is knob-independent, but rendering/rewriting notes and storing
  // lastRenderedBadge only happen here, when the knob is explicitly on.
  if (safety.enableTimeBadge) {
    summary.badge = timeBridgeRenderNotesBadge_(state, snap, safety);
  }
  var msResult = timeBridgeMsRenderer_(state, snap, syncTimeZone, nowMs, authoredTimeZone);
  summary.msPatched = msResult.patched;
  summary.quarantined = summary.quarantined.concat(msResult.quarantined);
  return summary;
}

function timeBridgeRunRenderersAfterMerge_(state, snap, startedAt, roundId) {
  var safety = getSafetyConfig_();
  var syncTimeZone = syncTimeZone_();
  var nowMs = Date.now();
  var summary = { calendarProjected: 0, calendarDeleted: 0, quarantined: [] };
  if (!safety.enableTimeBridge) return summary;

  var calResult = timeBridgeCalendarRenderer_(state, snap, syncTimeZone, nowMs, safety, startedAt);
  summary.calendarProjected = calResult.projected;
  summary.calendarDeleted = calResult.deleted;
  summary.quarantined = calResult.quarantined;
  if (summary.quarantined.length) timeBridgeNotifyQuarantine_(summary.quarantined);
  return summary;
}
