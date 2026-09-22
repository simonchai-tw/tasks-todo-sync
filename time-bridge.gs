/* Time Bridge engine (Spec v2.4 Frozen Baseline)
 *
 * Bridges Google Tasks (date-only) with Microsoft To Do (dateTimeTimeZone)
 * and Google Calendar (30-minute event projection).
 * All top-level declarations end with _ to preserve publicEntrypoints === 53.
 */

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

function timeBridgeEventFingerprint_(title, startIso, endIso) {
  var raw = String(title || '') + '|' + String(startIso || '') + '|' + String(endIso || '');
  return ordinaryFingerprintHex_(raw);
}

function timeBridgeParseNotesMarker_(notes) {
  if (notes == null || notes === '') return { markerValid: false };
  var text = String(notes);
  var lines = text.split(/\r?\n/);
  if (!lines.length) return { markerValid: false };

  // Fail-closed whole-notes check: scan lines 2+. If any matches, reject the whole note.
  for (var i = 1; i < lines.length; i += 1) {
    if (TIME_BRIDGE_WHOLE_NOTES_CHECK_REGEX_.test(lines[i])) {
      console.warn('[TimeBridge] Marker found on line ' + (i + 1) + '; rejecting whole note fail-closed.');
      return { markerValid: false, wholeNotesRejected: true, line: i + 1 };
    }
  }

  var line1 = lines[0];
  var match = line1.match(TIME_BRIDGE_MARKER_REGEX_);
  if (!match) return { markerValid: false };

  if (match[3] && match[3].toUpperCase() === 'NONE') {
    return {
      markerValid: true,
      isNone: true,
      exactMarkerLine: line1
    };
  }

  var hh = match[1];
  var mm = match[2];
  if (hh === '00' && mm === '00') {
    console.warn('[TimeBridge] [TTS-TIME:00:00] rejected fail-closed: 00:00 is ambiguous with platform date-only midnight; use 00:01+ or set time in Microsoft To Do.');
    return { markerValid: false, midnightRejected: true };
  }

  return {
    markerValid: true,
    isNone: false,
    hh: hh,
    mm: mm,
    exactMarkerLine: line1
  };
}

function timeBridgeDueHasTime_(dueDateTime, syncTimeZone) {
  if (!dueDateTime || !dueDateTime.dateTime) return false;
  var raw = String(dueDateTime.dateTime);
  var match = raw.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!match) return false;

  var h = parseInt(match[1], 10);
  var m = parseInt(match[2], 10);
  var s = parseInt(match[3], 10);
  // (a) Must have non-midnight in payload timezone
  if (h === 0 && m === 0 && s === 0) return false;

  // (b) Must have non-midnight in syncTimeZone
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
  var parts = formatter.formatToParts(date);
  var h = 0, m = 0, s = 0;
  for (var i = 0; i < parts.length; i += 1) {
    if (parts[i].type === 'hour') h = parseInt(parts[i].value, 10);
    if (parts[i].type === 'minute') m = parseInt(parts[i].value, 10);
    if (parts[i].type === 'second') s = parseInt(parts[i].value, 10);
  }
  return { h: h, m: m, s: s };
}

function timeBridgeFormatYmdInTimeZone_(instantMs, timeZone) {
  var date = new Date(instantMs);
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
  }
  var formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
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
    var curYear = parseInt(curParts[0], 10);
    var curMonth = parseInt(curParts[1], 10);
    var curDay = parseInt(curParts[2], 10);

    var targetTotalSec = Date.UTC(targetY, targetM - 1, targetD, targetH, targetMin, targetSec) / 1000;
    var curTotalSec = Date.UTC(curYear, curMonth - 1, curDay, curHms.h, curHms.m, curHms.s) / 1000;
    var diffSec = targetTotalSec - curTotalSec;
    if (diffSec === 0) return guessMs;
    guessMs += diffSec * 1000;
  }
  return guessMs;
}

function timeBridgeSpliceNotesMarker_(notes, exactMarkerLine) {
  if (notes == null) return '';
  var text = String(notes);
  var lines = text.split(/\r?\n/);
  if (!lines.length) return '';
  if (lines[0] !== exactMarkerLine) return text;

  lines.shift();
  if (lines.length > 0 && lines[0] === '') {
    lines.shift();
  }
  return lines.join('\n');
}

function timeBridgeEvaluateOwnership_(rec, msTask, nowUtcMs) {
  rec.rem = rec.rem || {};
  var ms = rec.rem.ms;
  var isReminderOn = !!(msTask && msTask.isReminderOn);
  var reminderDt = msTask && msTask.reminderDateTime;
  var reminderInstantMs = reminderDt ? timeBridgeParseDateTimeZoneMs_(reminderDt) : NaN;

  // 1. Consumed Reminder Rule
  if (ms === true && !isReminderOn && (!reminderDt || isNaN(reminderInstantMs) || reminderInstantMs <= nowUtcMs)) {
    rec.rem.ms = undefined;
    delete rec.rem.msAt;
    return;
  }

  // 2. Surrender Triggers (SKIPPED if completed)
  var completed = !!(msTask && msTask.status === 'completed');
  if (ms === true && !completed) {
    // Trigger 1: user actively turned off an unexpired reminder in the future
    if (!isReminderOn && !isNaN(reminderInstantMs) && reminderInstantMs > nowUtcMs) {
      rec.rem.ms = false;
      delete rec.rem.msAt;
      return;
    }
    // Trigger 2: user actively altered reminder timestamp (tolerance <= 60s)
    if (isReminderOn && rec.rem.msAt && !isNaN(reminderInstantMs)) {
      var msAtMs = Date.parse(rec.rem.msAt);
      if (!isNaN(msAtMs) && Math.abs(reminderInstantMs - msAtMs) > 60000) {
        rec.rem.ms = false;
        delete rec.rem.msAt;
        return;
      }
    }
  }
}

function timeBridgeComputeIntent_(T, nowMs, syncTimeZone, rec, isNone) {
  rec.rem = rec.rem || {};
  if (isNone) {
    // NONE: clear-time intent — keep the existing date on MS, clear hasTime and
    // reminder locally only.  Never emit a 1970 epoch payload to either side.
    return {
      duePayload: null,
      releaseOwnership: rec.rem.ms === true,
      acquireOwnership: false,
      targetInstantMs: null,
      clearHasTime: true
    };
  }

  var wLocalYmd = timeBridgeFormatYmdInTimeZone_(nowMs, syncTimeZone);
  var wLocalHms = timeBridgeFormatHmsInTimeZone_(nowMs, syncTimeZone);
  var tYmd = timeBridgeFormatYmdInTimeZone_(T, syncTimeZone);
  var tHhMm = timeBridgeFormatHhMmInTimeZone_(T, syncTimeZone);
  var duePayload = {
    dateTime: tYmd + 'T' + tHhMm + ':00',
    timeZone: timeBridgeResolveWindowsTimeZone_(syncTimeZone)
  };

  var ms = rec.rem.ms;
  var isFuture = T > nowMs;
  var isToday = tYmd === wLocalYmd;
  var isPastDate = T <= nowMs && tYmd < wLocalYmd;

  if (isFuture) {
    var canAcquire = ms !== false;
    var reminderPayload = canAcquire ? {
      dateTime: new Date(T).toISOString().replace(/\.\d{3}Z$/, ''),
      timeZone: 'UTC',
      isReminderOn: true
    } : undefined;
    return {
      duePayload: duePayload,
      reminderPayload: reminderPayload,
      targetInstantMs: T,
      acquireOwnership: canAcquire && ms === undefined,
      releaseOwnership: false
    };
  }

  if (isToday) {
    var wTotalMin = wLocalHms.h * 60 + wLocalHms.m;
    var cutoffMin = 23 * 60 + 35; // 23:35
    var canRemind = wTotalMin < cutoffMin && (ms === true || ms === undefined);
    var reminderPayload = undefined;
    var fallbackMs = undefined;
    var acquire = false;

    if (canRemind) {
      var candidateFallback = nowMs + 20 * 60 * 1000;
      var todayMaxMs = timeBridgeWallClockToUtcMs_(tYmd + 'T23:55:00', syncTimeZone);
      fallbackMs = Math.min(candidateFallback, todayMaxMs);
      reminderPayload = {
        dateTime: new Date(fallbackMs).toISOString().replace(/\.\d{3}Z$/, ''),
        timeZone: 'UTC',
        isReminderOn: true
      };
      acquire = ms === undefined;
    }
    return {
      duePayload: duePayload,
      reminderPayload: reminderPayload,
      targetInstantMs: T,
      fallbackInstantMs: fallbackMs,
      acquireOwnership: acquire,
      releaseOwnership: false
    };
  }

  if (isPastDate) {
    return {
      duePayload: duePayload,
      // Release ownership without emitting a 1970 epoch sentinel dateTime.
      // Just set isReminderOn: false; Microsoft accepts this without a dateTime.
      reminderPayload: ms === true ? { isReminderOn: false } : undefined,
      targetInstantMs: T,
      acquireOwnership: false,
      releaseOwnership: ms === true
    };
  }

  return {
    duePayload: duePayload,
    targetInstantMs: T,
    acquireOwnership: false,
    releaseOwnership: false
  };
}

function timeBridgeMsMatchesIntent_(msTask, intent, syncTimeZone) {
  if (!msTask || !intent) return false;
  // NONE intent (clearHasTime with no duePayload): no MS patch is needed.
  // The "match" is trivially true so we skip the MS PATCH entirely.
  if (intent.clearHasTime && !intent.duePayload) return true;
  if (!intent.duePayload) return false;
  if (intent.clearHasTime) {
    if (!msTask.dueDateTime || !msTask.dueDateTime.dateTime) return false;
    var match = String(msTask.dueDateTime.dateTime).match(/T(\d{2}):(\d{2}):(\d{2})/);
    return !!match && match[1] === '00' && match[2] === '00';
  }

  var targetInstantMs = intent.targetInstantMs;
  var targetYmd = timeBridgeFormatYmdInTimeZone_(targetInstantMs, syncTimeZone);
  var targetHhMm = timeBridgeFormatHhMmInTimeZone_(targetInstantMs, syncTimeZone);

  if (!msTask.dueDateTime) return false;
  var msDueInstantMs = timeBridgeParseDateTimeZoneMs_(msTask.dueDateTime);
  if (isNaN(msDueInstantMs)) return false;
  var msDueYmd = timeBridgeFormatYmdInTimeZone_(msDueInstantMs, syncTimeZone);
  var msDueHhMm = timeBridgeFormatHhMmInTimeZone_(msDueInstantMs, syncTimeZone);

  if (msDueYmd !== targetYmd || msDueHhMm !== targetHhMm) return false;

  var targetReminder = intent.reminderPayload;
  if (!targetReminder) {
    return true;
  }

  var msIsReminderOn = !!msTask.isReminderOn;
  if (msIsReminderOn !== targetReminder.isReminderOn) return false;
  if (!targetReminder.isReminderOn) return true;

  if (!msTask.reminderDateTime) return false;
  var msReminderMs = timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime);
  var targetReminderMs = intent.fallbackInstantMs || targetInstantMs;
  return !isNaN(msReminderMs) && Math.abs(msReminderMs - targetReminderMs) <= 60000;
}

function timeBridgeExecuteJournalStep_(state, gTask, msTask, gListId, msListId, syncTimeZone) {
  var journal = state.timeBridgeJournal;
  if (!journal) return;

  var pairId = journal.pairId;
  var rec = state.g2m && state.g2m[pairId];
  rec.rem = rec.rem || {};

  // 1. MS stage
  if (journal.stage === 'INTENT_PERSISTED' || journal.stage === 'MS_PATCHED') {
    var intent = journal.intent;
    var msMatches = timeBridgeMsMatchesIntent_(msTask, intent, syncTimeZone);

    if (msMatches) {
      journal.stage = 'MS_VERIFIED';
      if (intent.acquireOwnership) {
        rec.rem.ms = true;
        rec.rem.msAt = msTask && msTask.reminderDateTime ? msTask.reminderDateTime.dateTime : new Date(intent.targetInstantMs).toISOString();
      } else if (intent.releaseOwnership) {
        rec.rem.ms = undefined;
        delete rec.rem.msAt;
        if (intent.clearHasTime) rec.rem.hasTime = false;
      }
      persistSyncState_(state);
    } else {
      var msPatchPayload = {};
      if (intent.duePayload) {
        msPatchPayload.dueDateTime = {
          dateTime: intent.duePayload.dateTime,
          timeZone: intent.duePayload.timeZone
        };
      }
      if (intent.reminderPayload) {
        msPatchPayload.isReminderOn = intent.reminderPayload.isReminderOn;
        if (intent.reminderPayload.isReminderOn) {
          msPatchPayload.reminderDateTime = {
            dateTime: intent.reminderPayload.dateTime,
            timeZone: intent.reminderPayload.timeZone
          };
        }
      }
      try {
        // WO-4: updateMsTask_ takes 3 parameters; the former 4th If-Match arg was
        // dead (msEtag was declared in state schema but never assigned anywhere).
        var updatedMs = updateMsTask_(msListId, rec.msId, msPatchPayload);
        journal.stage = 'MS_VERIFIED';
        if (intent.acquireOwnership) {
          rec.rem.ms = true;
          rec.rem.msAt = updatedMs && updatedMs.reminderDateTime ? updatedMs.reminderDateTime.dateTime : new Date(intent.targetInstantMs || 0).toISOString();
        } else if (intent.releaseOwnership) {
          rec.rem.ms = undefined;
          delete rec.rem.msAt;
          if (intent.clearHasTime) rec.rem.hasTime = false;
        }
        persistSyncState_(state);
      } catch (e) {
        journal.retryCount = (journal.retryCount || 0) + 1;
        if (journal.retryCount >= 3) {
          timeBridgeMoveToDeadLetter_(state, journal, 'MS_PATCH_EXHAUSTED: ' + String(e.message || e));
          return;
        }
        persistSyncState_(state);
        throw e;
      }
    }
  }

  // 2. Google stage
  if (journal.stage === 'MS_VERIFIED' || journal.stage === 'GOOGLE_PATCHED') {
    if (!journal.intent.exactMarkerLine) {
      journal.stage = 'GOOGLE_VERIFIED';
      persistSyncState_(state);
    } else {
      try {
        var freshG = getGTask_(gListId, pairId);
        var currentNotes = freshG && freshG.notes ? String(freshG.notes) : '';
        if (currentNotes.indexOf(journal.intent.exactMarkerLine) < 0) {
          journal.stage = 'GOOGLE_VERIFIED';
          persistSyncState_(state);
        } else {
          var splicedNotes = timeBridgeSpliceNotesMarker_(currentNotes, journal.intent.exactMarkerLine);
          updateGTask_(gListId, pairId, { notes: splicedNotes });
          if (rec.fp && typeof rec.fp === 'object') {
            rec.fp.notes = ordinaryFingerprintHex_(timeBridgeSpliceNotesMarker_(rec.fp.notes, journal.intent.exactMarkerLine));
          }
          journal.stage = 'GOOGLE_VERIFIED';
          persistSyncState_(state);
        }
      } catch (e) {
        journal.retryCount = (journal.retryCount || 0) + 1;
        if (journal.retryCount >= 3) {
          timeBridgeMoveToDeadLetter_(state, journal, 'GOOGLE_PATCH_EXHAUSTED: ' + String(e.message || e));
          return;
        }
        persistSyncState_(state);
        throw e;
      }
    }
  }

  // 3. Committed
  if (journal.stage === 'GOOGLE_VERIFIED') {
    state.timeBridgeJournal = null;
    persistSyncState_(state);
  }
}

function timeBridgeMoveToDeadLetter_(state, journal, reason) {
  state.deadLetterJournal = state.deadLetterJournal || [];
  state.deadLetterJournal.push(Object.assign({}, journal, {
    failedAt: new Date().toISOString(),
    reason: reason || 'UNKNOWN'
  }));
  if (state.deadLetterJournal.length > TIME_BRIDGE_DEAD_LETTER_JOURNAL_MAX) {
    state.deadLetterJournal.splice(0, state.deadLetterJournal.length - TIME_BRIDGE_DEAD_LETTER_JOURNAL_MAX);
  }
  var rec = state.g2m && state.g2m[journal.pairId];
  if (rec) {
    rec.rem = rec.rem || {};
    rec.rem.markerOrphaned = true;
  }
  state.timeBridgeJournal = null;
  persistSyncState_(state);
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

function timeBridgeProjectCalendarEvent_(calendarId, pairId, title, startIso, endIso, syncTimeZone, rec) {
  rec.rem = rec.rem || {};
  var deterministicId = timeBridgeDeterministicEventId_(pairId);
  var targetFp = timeBridgeEventFingerprint_(title, startIso, endIso);

  if (rec.rem.e === deterministicId && rec.rem.eFp === targetFp) return;

  var eventResource = {
    id: deterministicId,
    summary: title || 'Task',
    start: { dateTime: startIso, timeZone: syncTimeZone },
    end: { dateTime: endIso, timeZone: syncTimeZone },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 0 }]
    }
  };

  try {
    var existing = Calendar.Events.get(calendarId, deterministicId);
    if (existing && existing.status === 'cancelled') {
      Calendar.Events.patch(Object.assign({}, eventResource, { status: 'confirmed' }), calendarId, deterministicId);
      rec.rem.e = deterministicId;
      rec.rem.eFp = targetFp;
      return;
    }
    if (existing && existing.status === 'confirmed') {
      Calendar.Events.patch(eventResource, calendarId, deterministicId);
      rec.rem.e = deterministicId;
      rec.rem.eFp = targetFp;
      return;
    }
  } catch (e) {
    var status = timeBridgeCalendarHttpStatus_(e);
    if (status === 404 || status === 410) {
      try {
        Calendar.Events.insert(eventResource, calendarId);
        rec.rem.e = deterministicId;
        rec.rem.eFp = targetFp;
        return;
      } catch (insertErr) {
        if (timeBridgeCalendarHttpStatus_(insertErr) === 409) {
          Calendar.Events.patch(Object.assign({}, eventResource, { status: 'confirmed' }), calendarId, deterministicId);
          rec.rem.e = deterministicId;
          rec.rem.eFp = targetFp;
          return;
        }
        throw insertErr;
      }
    }
    if (status === 409) {
      Calendar.Events.patch(Object.assign({}, eventResource, { status: 'confirmed' }), calendarId, deterministicId);
      rec.rem.e = deterministicId;
      rec.rem.eFp = targetFp;
      return;
    }
    throw e;
  }
}

function timeBridgeDeleteCalendarEvent_(calendarId, pairId, rec) {
  var deterministicId = timeBridgeDeterministicEventId_(pairId);
  try {
    Calendar.Events.remove(calendarId, deterministicId);
  } catch (e) {
    var status = timeBridgeCalendarHttpStatus_(e);
    if (status !== 404 && status !== 410) {
      console.warn('[TimeBridge] Failed to delete calendar event: ' + String(e.message || e));
    }
  }
  if (rec && rec.rem) {
    delete rec.rem.e;
    delete rec.rem.eFp;
  }
}

function timeBridgeGetOrCreateCalendar_(syncTimeZone) {
  if (typeof CalendarApp === 'undefined') return null;
  try {
    var calendars = CalendarApp.getCalendarsByName(TIME_BRIDGE_CALENDAR_SUMMARY);
    var owned = calendars.filter(function(cal) {
      return typeof cal.isOwnedByMe === 'function' ? cal.isOwnedByMe() : true;
    });
    if (owned.length > 0) {
      var cal = owned[0];
      if (typeof cal.setTimeZone === 'function') cal.setTimeZone(syncTimeZone);
      if (typeof cal.setSelected === 'function') cal.setSelected(true);
      return cal.getId();
    }
    var created = CalendarApp.createCalendar(TIME_BRIDGE_CALENDAR_SUMMARY, {
      timeZone: syncTimeZone,
      selected: true
    });
    return created.getId();
  } catch (e) {
    console.warn('[TimeBridge] Failed to get or create projection calendar: ' + String(e.message || e));
    return null;
  }
}

function timeBridgeRun_(state, snap, startedAt, roundId) {
  var safety = getSafetyConfig_();
  if (!safety.enableTimeBridge) return;

  var syncTimeZone = syncTimeZone_();
  var nowMs = Date.now();

  // Phase 1: Journal Recovery
  if (state.timeBridgeJournal) {
    var j = state.timeBridgeJournal;
    var gId = j.pairId;
    var rec = state.g2m && state.g2m[gId];
    if (!rec) {
      state.timeBridgeJournal = null;
      persistSyncState_(state);
    } else {
      var gTask = snap.gTasksById[gId];
      var msTask = snap.msTasksById[rec.msId];
      if (!gTask || !msTask) {
        state.timeBridgeJournal = null;
        persistSyncState_(state);
      } else {
        timeBridgeExecuteJournalStep_(state, gTask, msTask, rec.gListId, rec.msListId, syncTimeZone);
      }
    }
  }

  // Phase 2 & 3: Ingestion & Rescheduling
  var opsCount = 0;
  var calendarId = null;
  if (safety.enableCalendarProjection && typeof Calendar !== 'undefined') {
    calendarId = timeBridgeGetOrCreateCalendar_(syncTimeZone);
  }

  var mappedGIds = Object.keys(state.g2m || {});
  for (var i = 0; i < mappedGIds.length; i += 1) {
    if (!remainingTimeOk_(startedAt, 30000)) break;
    if (opsCount >= TIME_BRIDGE_OPS_MAX_PER_ROUND) break;

    var gId = mappedGIds[i];
    var rec = state.g2m[gId];
    if (!rec || !rec.msId) continue;
    rec.rem = rec.rem || {};

    var gTask = snap.gTasksById[gId];
    var msTask = snap.msTasksById[rec.msId];
    if (!gTask || !msTask) continue;

    var completed = gTask.status === 'completed' || msTask.status === 'completed';

    // Parse marker
    var parsed = timeBridgeParseNotesMarker_(gTask.notes);
    var markerValid = parsed.markerValid;

    // Hard reset check
    if (markerValid && rec.rem.ms === false) {
      rec.rem.ms = undefined;
    }

    // Evaluate ownership & surrender
    timeBridgeEvaluateOwnership_(rec, msTask, nowMs);

    var dueHasTime = timeBridgeDueHasTime_(msTask.dueDateTime, syncTimeZone);

    // Set / Clear hasTime
    var priorHasTime = !!rec.rem.hasTime;
    if (markerValid && !parsed.isNone) {
      rec.rem.hasTime = true;
    } else if (msTask.isReminderOn || dueHasTime) {
      rec.rem.hasTime = true;
    } else if (!markerValid && !msTask.isReminderOn && !dueHasTime) {
      rec.rem.hasTime = false;
    }

    // Cleanup calendar if completed or hasTime false
    if (calendarId) {
      if (completed || !rec.rem.hasTime) {
        if (rec.rem.e) timeBridgeDeleteCalendarEvent_(calendarId, gId, rec);
      }
    }

    // If completed, acquisition is excluded
    if (completed) continue;

    // Event-Driven Ingestion Triggers (§3.1)
    var trigger1 = markerValid;
    var trigger2 = false;
    var trigger3 = false;
    var trigger4 = !priorHasTime && rec.rem.hasTime;

    var gDueChanged = false;
    var gDueCanonical = ordinaryCanonicalDueFromGoogle_(gTask);
    if (rec.fp && rec.fp.due !== undefined && gDueCanonical !== null) {
      var gDueFp = ordinaryFieldFp_(ordinaryProjectGoogle_(gTask, rec), 'due');
      if (gDueFp && rec.fp.due && gDueFp !== rec.fp.due) gDueChanged = true;
    }

    var msDueChanged = false;
    var msDueCanonical = ordinaryCanonicalDueFromMicrosoft_(msTask);
    if (rec.fp && rec.fp.due !== undefined && msDueCanonical !== null) {
      var msDueFp = ordinaryFieldFp_(ordinaryProjectMicrosoft_(msTask, rec), 'due');
      if (msDueFp && rec.fp.due && msDueFp !== rec.fp.due) msDueChanged = true;
    }

    if (!markerValid && gDueChanged && rec.rem.hasTime) trigger2 = true;
    if (msDueChanged && rec.rem.hasTime && !state.timeBridgeJournal) trigger3 = true;

    // Deduplicate triggers into single pass
    if (!trigger1 && !trigger2 && !trigger3 && !trigger4) {
      // Steady state: ensure projection up to date if hasTime
      if (calendarId && rec.rem.hasTime && !rec.rem.e) {
        var startMs = timeBridgeDueHasTime_(msTask.dueDateTime, syncTimeZone)
          ? timeBridgeParseDateTimeZoneMs_(msTask.dueDateTime)
          : (msTask.reminderDateTime ? timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime) : NaN);
        if (!isNaN(startMs) && startMs >= nowMs) {
          var endMs = startMs + TIME_BRIDGE_EVENT_DURATION_MINUTES * 60 * 1000;
          timeBridgeProjectCalendarEvent_(calendarId, gId, gTask.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), syncTimeZone, rec);
        }
      }
      continue;
    }

    // Determine target T
    var T = NaN;
    var isNone = false;
    if (trigger1) {
      if (parsed.isNone) {
        isNone = true;
      } else {
        var baseDate = gDueCanonical || timeBridgeFormatYmdInTimeZone_(nowMs, syncTimeZone);
        T = timeBridgeWallClockToUtcMs_(baseDate + 'T' + parsed.hh + ':' + parsed.mm + ':00', syncTimeZone);
      }
    } else if (trigger2) {
      var existingHhMm = dueHasTime
        ? timeBridgeFormatHhMmInTimeZone_(timeBridgeParseDateTimeZoneMs_(msTask.dueDateTime), syncTimeZone)
        : (msTask.isReminderOn && msTask.reminderDateTime
          ? timeBridgeFormatHhMmInTimeZone_(timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime), syncTimeZone)
          : null);
      if (existingHhMm) {
        T = timeBridgeWallClockToUtcMs_(gDueCanonical + 'T' + existingHhMm + ':00', syncTimeZone);
      }
    } else if (trigger3) {
      var msLocalYmd = timeBridgeFormatYmdInTimeZone_(timeBridgeParseDateTimeZoneMs_(msTask.dueDateTime), syncTimeZone);
      updateGTask_(rec.gListId, gId, { due: msLocalYmd + 'T00:00:00.000Z' });
      if (rec.fp && typeof rec.fp === 'object') {
        rec.fp.due = ordinaryFieldFp_({ due: msLocalYmd, dueOk: true }, 'due');
      }
      var existingHhMm3 = dueHasTime
        ? timeBridgeFormatHhMmInTimeZone_(timeBridgeParseDateTimeZoneMs_(msTask.dueDateTime), syncTimeZone)
        : (msTask.isReminderOn && msTask.reminderDateTime
          ? timeBridgeFormatHhMmInTimeZone_(timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime), syncTimeZone)
          : null);
      if (existingHhMm3) {
        T = timeBridgeWallClockToUtcMs_(msLocalYmd + 'T' + existingHhMm3 + ':00', syncTimeZone);
      }
    } else if (trigger4) {
      if (dueHasTime) {
        T = timeBridgeParseDateTimeZoneMs_(msTask.dueDateTime);
      } else {
        // Driven solely by isReminderOn: zero MS intent, calendar projection only
        T = NaN;
      }
    }

    if (isNaN(T) && !isNone) {
      // If T is not applicable, project calendar if appropriate
      if (calendarId && rec.rem.hasTime && msTask.reminderDateTime) {
        var rMs = timeBridgeParseDateTimeZoneMs_(msTask.reminderDateTime);
        if (!isNaN(rMs) && rMs >= nowMs) {
          timeBridgeProjectCalendarEvent_(calendarId, gId, gTask.title, new Date(rMs).toISOString(), new Date(rMs + 1800000).toISOString(), syncTimeZone, rec);
        }
      }
      continue;
    }

    var intent = timeBridgeComputeIntent_(T, nowMs, syncTimeZone, rec, isNone);
    if (parsed.exactMarkerLine) intent.exactMarkerLine = parsed.exactMarkerLine;

    var msMatches = timeBridgeMsMatchesIntent_(msTask, intent, syncTimeZone);
    var ownershipChanged = intent.acquireOwnership || intent.releaseOwnership;

    // Complete Zero-Mutation No-op
    if (msMatches && !parsed.exactMarkerLine && !ownershipChanged) {
      continue;
    }

    // Create journal
    var journal = {
      opId: ordinaryFingerprintHex_(gId + '|' + nowMs),
      pairId: gId,
      stage: 'INTENT_PERSISTED',
      intent: intent,
      retryCount: 0
    };
    state.timeBridgeJournal = journal;
    persistSyncState_(state);
    opsCount += 1;

    // Execute journal steps
    timeBridgeExecuteJournalStep_(state, gTask, msTask, rec.gListId, rec.msListId, syncTimeZone);

    // Project calendar if active
    if (calendarId && rec.rem.hasTime && !isNone && T >= nowMs) {
      var startIso = new Date(T).toISOString();
      var endIso = new Date(T + TIME_BRIDGE_EVENT_DURATION_MINUTES * 60 * 1000).toISOString();
      timeBridgeProjectCalendarEvent_(calendarId, gId, gTask.title, startIso, endIso, syncTimeZone, rec);
    }
  }
}
