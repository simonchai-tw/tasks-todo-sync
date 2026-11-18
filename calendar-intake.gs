/* Calendar intake valve (D2, conservative edition).
 *
 * Reads the engine-owned projection calendar (the one Time Bridge creates) and
 * lets calendar-side time edits flow INTO rec.td — the reverse direction of
 * timeBridgeCalendarRenderer_.  The valve is strictly read-only against
 * Calendar.Events: every "zero patch / insert / remove" guarantee below is
 * structural, because the module never calls a Calendar write verb at all.
 *
 * Mechanism per the 2026-11-17 ruling (Option A SUPERSEDED):
 *  - Ownership evidence is the reverse index built each round from state.g2m:
 *    rec.rem.e (the authoritative event id, inherited wholesale by
 *    rotationRebind_ across a Google id rotation) plus the deterministic id
 *    timeBridgeDeterministicEventId_(gId).  No ttsOwner stamp, no detId-v2
 *    salt, no persisted index.
 *  - Adjudication is field-level only: the stored rec.rem.eFp must describe
 *    exactly what the CURRENT rec.td would project; a stored fingerprint that
 *    matches neither the observed event nor that baseline means the evidence
 *    is stale and the valve stands down.  No Max(lastModified, updated).
 *  - Watermark: a Calendar syncToken kept in a Script Property (never inside
 *    sync state, so the closed top-level schema whitelist stays untouched).
 *    It is written only after every page was read and every action completed.
 *  - C11 anti-revert: the merge aligns rec.td.date back to the converged due
 *    (field-merge.gs:688-717), so an adopted cross-day drag advances the
 *    Google due in the same breath — the frozen spec's "由進氣閥直接同步推進
 *    Google due" branch — instead of writing a td.source marker the closed
 *    td whitelist would reject.
 *  - Quarantine (all-day / foreign collisions) writes rec.rem.collisionQuarantined
 *    ONLY when the real state.gs validator accepts the key (capability probe);
 *    until the lead extends the whitelist the quarantine stays round-local and
 *    nothing is persisted that a later load would reject as STATE_MALFORMED.
 *
 * All top-level declarations end with _ (no public entrypoint count change).
 */

/* Knob: opt-in, OFF by default (a valve that writes user-facing task fields
 * must not switch itself on).  The property is parsed here so the module is
 * self-contained; consolidating the knob into getSafetyConfig_ is a lead-only
 * wiring step and is deliberately not assumed. */
var DEFAULT_SYNC_CALENDAR_INTAKE = false;
var CALENDAR_INTAKE_ENABLED_PROPERTY = 'SYNC_CALENDAR_INTAKE';
var CALENDAR_INTAKE_TOKEN_PROPERTY = 'SYNC_CALENDAR_INTAKE_SYNC_TOKEN';
var CALENDAR_INTAKE_PAGE_SIZE = 250;
var CALENDAR_INTAKE_MAX_PAGES = 20;
var CALENDAR_INTAKE_TIME_RESERVE_MS = 30000;

function calendarIntakeEnabled_() {
  if (typeof Calendar === 'undefined' || !Calendar || !Calendar.Events ||
      typeof Calendar.Events.list !== 'function') return false;
  var raw = '';
  try {
    raw = String(PropertiesService.getScriptProperties()
      .getProperty(CALENDAR_INTAKE_ENABLED_PROPERTY) || '').trim().toLowerCase();
  } catch (e) {
    return false;
  }
  if (raw === '') return DEFAULT_SYNC_CALENDAR_INTAKE === true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('CALENDAR_INTAKE_FLAG_INVALID: ' + CALENDAR_INTAKE_ENABLED_PROPERTY +
    ' must be true or false.');
}

function calendarIntakeReadToken_() {
  try {
    return PropertiesService.getScriptProperties()
      .getProperty(CALENDAR_INTAKE_TOKEN_PROPERTY) || null;
  } catch (e) {
    return null;
  }
}

/* Writing the token IS advancing the watermark (atomic per key), so "the
 * watermark advanced" and "the persist succeeded" are the same event (C7). */
function calendarIntakeWriteToken_(token) {
  PropertiesService.getScriptProperties()
    .setProperty(CALENDAR_INTAKE_TOKEN_PROPERTY, String(token));
}

/* ------------------------------------------------------------------ */
/* Reverse index (per-round, memory only, never persisted)             */
/* ------------------------------------------------------------------ */

function calendarIntakeClaim_(index, eventId, gId) {
  if (!eventId) return;
  var existing = index[eventId];
  if (existing === undefined) {
    index[eventId] = gId;
  } else if (existing !== gId) {
    // Two pairs claim the same id: fail-closed, the event resolves to nothing.
    index[eventId] = null;
  }
}

function calendarIntakeBuildReverseIndex_(state) {
  var index = {};
  Object.keys((state && state.g2m) || {}).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec) return;
    // rec.rem.e is authoritative: rotationRebind_ moves the whole rec (rem
    // included) to the new gId, so the inherited id keeps resolving after a
    // Google id rotation.  The deterministic id covers pairs whose renderer
    // has not confirmed an event yet.
    if (rec.rem && typeof rec.rem.e === 'string' && /^[0-9a-f]{32}$/.test(rec.rem.e)) {
      calendarIntakeClaim_(index, rec.rem.e, gId);
    }
    try {
      calendarIntakeClaim_(index, timeBridgeDeterministicEventId_(gId), gId);
    } catch (e) {
      console.warn('[CalendarIntake] detId derivation unavailable for one pair: ' +
        timeBridgeBoundedErrorCode_(e));
    }
  });
  return index;
}

/* ------------------------------------------------------------------ */
/* Field-level evidence helpers                                        */
/* ------------------------------------------------------------------ */

/* What this engine would project RIGHT NOW for the pair, and the fingerprint
 * of that projection — the same strings timeBridgeCalendarRenderer_ writes. */
function calendarIntakeExpectedProjection_(rec, gTask, syncTimeZone, reminderMode) {
  if (!rec || !rec.td || !rec.td.date || !rec.td.time) return null;
  var startMs = timeBridgeWallClockToUtcMs_(rec.td.date + 'T' + rec.td.time + ':00', syncTimeZone);
  if (!isFinite(startMs)) return null;
  var startIso = new Date(startMs).toISOString();
  var endIso = new Date(startMs + TIME_BRIDGE_EVENT_DURATION_MINUTES * 60 * 1000).toISOString();
  return {
    startMs: startMs,
    startIso: startIso,
    endIso: endIso,
    fingerprint: timeBridgeEventFingerprint_(gTask && gTask.title, startIso, endIso, reminderMode)
  };
}

function calendarIntakeWallFromInstant_(instantMs, timeZone) {
  return {
    date: timeBridgeFormatYmdInTimeZone_(instantMs, timeZone),
    time: timeBridgeFormatHhMmInTimeZone_(instantMs, timeZone)
  };
}

/* A wall time that does not exist (spring gap) converts to an instant whose
 * formatted wall clock differs from the input — the ISO string is never
 * substring'd; the round trip is the proof. */
function calendarIntakeWallIsRealizable_(date, time, timeZone) {
  var ms = timeBridgeWallClockToUtcMs_(date + 'T' + time + ':00', timeZone);
  if (!isFinite(ms)) return false;
  var back = calendarIntakeWallFromInstant_(ms, timeZone);
  return back.date === date && back.time === time;
}

/* Fall fold: two instants share one wall clock; the FIRST occurrence wins.
 * Bounded to one hour of backtracking (one transition per day). */
function calendarIntakeFoldFirstInstantMs_(instantMs, timeZone) {
  var first = instantMs;
  var i;
  for (i = 0; i < 2; i += 1) {
    var earlier = first - 60 * 60 * 1000;
    if (earlier < 0) break;
    var wallEarlier = calendarIntakeWallFromInstant_(earlier, timeZone);
    var wallNow = calendarIntakeWallFromInstant_(first, timeZone);
    if (wallEarlier.date === wallNow.date && wallEarlier.time === wallNow.time) {
      first = earlier;
    } else {
      break;
    }
  }
  return first;
}

/* ------------------------------------------------------------------ */
/* Quarantine (capability-probed persistence)                          */
/* ------------------------------------------------------------------ */

/* rec.rem.collisionQuarantined is the U4 quarantine slot, but the closed
 * rec.rem whitelist only accepts it once the lead extends state.gs.  Probe the
 * REAL validator instead of hard-coding a flag: the valve stages itself and
 * can never persist a key the next load would reject as STATE_MALFORMED. */
function calendarIntakeQuarantinePersistable_() {
  try {
    assertTimeBridgeMappingRem_({ collisionQuarantined: true }, 'calendar-intake-probe');
    return true;
  } catch (e) {
    return false;
  }
}

/* Returns whether the flag was persisted; round-local quarantine (skip +
 * report) happens either way.  Sticky WHILE colliding: the flag is released
 * automatically by calendarIntakeReleaseQuarantines_ once the event at the
 * pair's deterministic id is gone, cancelled, or provably ours again. */
function calendarIntakeQuarantine_(rec) {
  if (!calendarIntakeQuarantinePersistable_()) return false;
  rec.rem = rec.rem || {};
  rec.rem.collisionQuarantined = true;
  return true;
}

/* ------------------------------------------------------------------ */
/* Quarantine release sweep (D2: sticky-while-colliding)               */
/* ------------------------------------------------------------------ */

/* RELEASE is state-only: the flag is deleted (and an emptied rec.rem is
 * deleted with it — the same shape rule the C3 path uses), and the sweep
 * NEVER writes to Calendar.  After release the ordinary outbound ensure /
 * intake flow re-manages the pair on its own schedule. */
function calendarIntakeReleaseOne_(rec, result) {
  if (rec.rem) delete rec.rem.collisionQuarantined;
  if (rec.rem && !Object.keys(rec.rem).length) delete rec.rem;
  result.released += 1;
}

/* Is the event now sitting at the pair's deterministic id still a collision?
 * Re-runs the SAME evidence predicates adjudication uses
 * (calendarIntakeAdjudicateEvent_): RELEASE only when the slot is provably
 * ours again —
 *   - 'cancelled': the source is gone; the intake C3 path cleans the
 *     projection next round, so releasing the flag is safe;
 *   - C1 echo: the observed fingerprint equals the stored rec.rem.eFp (the
 *     user reverted the slot to exactly what this engine last rendered);
 *   - not foreign per C9: the title matches ours OR the start matches the
 *     current td projection, AND the chain that lets adjudication act is
 *     intact (a usable td baseline and an etag).
 * Everything else STAYS quarantined (fail-closed): all-day (C8), foreign
 * (C9), no stored fingerprint, stale td baseline, missing etag.  A fingerprint
 * that mismatches the stored echo without that intact chain can never prove
 * the collision is gone, so it can never release. */
function calendarIntakeQuarantineCleared_(rec, gTask, ev, syncTimeZone, reminderMode) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.status === 'cancelled') return true;
  if (ev.status !== 'confirmed') return false;
  // C8: an all-day event still occupies the pair's slot.
  if (!ev.start || !ev.start.dateTime) return false;

  var storedFp = rec.rem && rec.rem.eFp;
  var startRaw = String(ev.start.dateTime);
  var endRaw = ev.end && ev.end.dateTime ? String(ev.end.dateTime) : '';
  var observedFp = timeBridgeEventFingerprint_(ev.summary, startRaw, endRaw, reminderMode);
  if (storedFp && observedFp === storedFp) return true; // C1 echo

  // The chain below is exactly adjudication's: baseline → etag → C9.
  var expected = calendarIntakeExpectedProjection_(rec, gTask, syncTimeZone, reminderMode);
  if (!expected || !storedFp) return false;             // no usable baseline
  if (storedFp !== expected.fingerprint) return false;  // stale td baseline
  if (!ev.etag) return false;                           // no change evidence
  var evTitle = String(ev.summary == null ? '' : ev.summary).trim() || 'Task';
  var taskTitle = String(gTask.title == null ? '' : gTask.title).trim() || 'Task';
  var startMatches = !isNaN(Date.parse(startRaw)) && Date.parse(startRaw) === expected.startMs;
  if (evTitle !== taskTitle && !startMatches) return false; // C9 foreign persists
  return true;
}

/* Re-evaluates every quarantined pair, every round (the 2026-11-17 D2 ruling:
 * quarantine is sticky-WHILE-colliding, not sticky-forever — nothing pauses
 * the time-bridge renderers for a pair whose collision has vanished).
 *
 * Contract: the lead wires this to run EVERY round, independent of the
 * SYNC_CALENDAR_INTAKE knob and of whether the intake valve ran this round —
 * it reads only state.g2m, snap and Calendar, never the intake watermark or
 * its run result.  Per quarantined pair it issues exactly one
 * Calendar.Events.get at the pair's deterministic id (quarantines are rare, so
 * per-pair GETs are fine; the sweep never lists and never paginates) and
 * mutates sync state ONLY — zero Calendar writes.
 *   GET 404/410            → collision source gone → RELEASE;
 *   GET other error        → STAY (fail-closed), counted, sweep continues;
 *   status 'cancelled'     → RELEASE;
 *   status 'confirmed'     → RELEASE only if calendarIntakeQuarantineCleared_
 *                            says the slot is provably ours again;
 *                            otherwise STAY.
 * A sweep error must never abort the sync round: every failure is caught,
 * counted in errors and the sweep moves on.  Returns
 * { checked, released, stayed, errors } for logging. */
function calendarIntakeReleaseQuarantines_(state, snap, calendarId) {
  var result = { checked: 0, released: 0, stayed: 0, errors: 0 };
  if (!state || !state.g2m || !calendarId) return result;
  if (typeof Calendar === 'undefined' || !Calendar || !Calendar.Events ||
      typeof Calendar.Events.get !== 'function') return result;

  var reminderMode;
  var syncTimeZone;
  try {
    var safety = getSafetyConfig_();
    reminderMode = safety.enableCalendarProjectionReminder === false ? 'silent' : 'default';
    syncTimeZone = syncTimeZone_();
  } catch (e) {
    result.errors += 1;
    console.warn('[CalendarIntake] release sweep environment unavailable: ' +
      timeBridgeBoundedErrorCode_(e));
    return result;
  }

  Object.keys(state.g2m).forEach(function(gId) {
    var rec = state.g2m[gId];
    if (!rec || !rec.rem || rec.rem.collisionQuarantined !== true) return;
    result.checked += 1;
    try {
      var detId = timeBridgeDeterministicEventId_(gId);
      var ev;
      try {
        ev = Calendar.Events.get(calendarId, detId);
      } catch (e) {
        var status = timeBridgeCalendarHttpStatus_(e);
        if (status === 404 || status === 410) {
          calendarIntakeReleaseOne_(rec, result); // collision source gone
        } else {
          result.errors += 1; // fail-closed: stay quarantined, keep sweeping
          console.warn('[CalendarIntake] release sweep GET failed for a pair: ' +
            timeBridgeBoundedErrorCode_(e));
        }
        return;
      }
      var gTask = snap && snap.gTasksById ? snap.gTasksById[gId] : null;
      if (calendarIntakeQuarantineCleared_(rec, gTask, ev, syncTimeZone, reminderMode)) {
        calendarIntakeReleaseOne_(rec, result);
      } else {
        result.stayed += 1;
      }
    } catch (e) {
      result.errors += 1;
      console.warn('[CalendarIntake] release sweep failed for a pair: ' +
        timeBridgeBoundedErrorCode_(e));
    }
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Pagination + watermark (C5/C6/C7)                                   */
/* ------------------------------------------------------------------ */

/* Reads every page.  Any page failure throws BEFORE any state mutation has
 * happened upstream (the caller has not touched anything yet): zero state
 * writes, watermark not advanced.  A 410 on a syncToken request clears the
 * token in memory and runs exactly one full re-scan. */
function calendarIntakeListEvents_(calendarId, storedToken) {
  var events = [];
  var pagesFetched = 0;
  var fullRescans = 0;
  var nextSyncToken = null;
  var token = storedToken || null;
  var pageToken = null;

  while (true) {
    if (pagesFetched >= CALENDAR_INTAKE_MAX_PAGES) {
      throw new Error('CALENDAR_INTAKE_PAGE_CAP: page cap exceeded.');
    }
    if (RUN_STARTED_AT && !remainingTimeOk_(RUN_STARTED_AT, CALENDAR_INTAKE_TIME_RESERVE_MS)) {
      throw new Error('TIME_BUDGET_CALENDAR_INTAKE: insufficient time for another page.');
    }
    var requestArgs = { maxResults: CALENDAR_INTAKE_PAGE_SIZE };
    if (pageToken) {
      requestArgs.pageToken = pageToken;
    } else if (token) {
      requestArgs.syncToken = token;
    }
    var page;
    try {
      page = Calendar.Events.list(calendarId, requestArgs);
    } catch (e) {
      if (token && !pageToken && fullRescans === 0 &&
          timeBridgeCalendarHttpStatus_(e) === 410) {
        // C5: the token is dead.  Clear it FIRST, then re-scan in full; the
        // replacement token only lands after the whole scan succeeded.
        token = null;
        fullRescans += 1;
        continue;
      }
      throw e;
    }
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.items)) {
      throw new Error('PAGINATION_MALFORMED_PAGE: calendar page is malformed.');
    }
    pagesFetched += 1;
    events = events.concat(page.items);
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    break;
  }
  return { events: events, pagesFetched: pagesFetched, fullRescans: fullRescans, nextSyncToken: nextSyncToken };
}

/* ------------------------------------------------------------------ */
/* Adoption (C11 anti-revert branch)                                   */
/* ------------------------------------------------------------------ */

/* Applies the calendar wall clock to rec.td and, for a date change, advances
 * the Google due so the merge sees a genuine Google-side edit instead of
 * reverting the drag (C11).  Per-pair fail-closed: any failure rolls the pair
 * back to its previous td and writes nothing. */
function calendarIntakeAdopt_(state, snap, rec, gId, gTask, wall, dateChanged, result) {
  var previousTd = rec.td;
  try {
    if (dateChanged) {
      var fresh = getGTask_(rec.gListId, gId);
      var freshDue = googleDueDateOnly_(fresh && fresh.due);
      var previousDate = rec.td.date;
      if (freshDue !== previousDate) {
        // Google's due moved (or vanished) since the snapshot: the drag
        // evidence is stale and the valve stands down for this pair.
        result.skipped += 1;
        return false;
      }
      if (freshDue !== wall.date) {
        updateGTask_(rec.gListId, gId, { due: wall.date + 'T00:00:00.000Z' });
        result.dueAdvanced += 1;
        var snapTask = snap && snap.gTasksById ? snap.gTasksById[gId] : null;
        if (snapTask) snapTask.due = wall.date + 'T00:00:00.000Z';
      }
    }
    rec.td = { date: wall.date, time: wall.time, v: 1 };
    // A calendar drag is a user edit: fresh attempt on every R-4 ladder.
    timeBridgeRetryRevive_(rec);
    return true;
  } catch (e) {
    rec.td = previousTd;
    console.warn('[CalendarIntake] adoption failed for a pair: ' + timeBridgeBoundedErrorCode_(e));
    result.failures += 1;
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Per-event adjudication                                              */
/* ------------------------------------------------------------------ */

function calendarIntakeAdjudicateEvent_(state, snap, ev, index, syncTimeZone, reminderMode, result) {
  var gId = ev && ev.id ? index[ev.id] : undefined;
  if (!gId) {
    // Unresolvable event in the projection calendar: observed, never touched.
    result.orphans += 1;
    return;
  }
  var rec = state.g2m[gId];
  if (!rec || !rec.msId) {
    result.orphans += 1;
    return;
  }

  if (ev.status === 'cancelled') {
    // C3 (conservative deletion): stop projecting this pair and nothing else.
    // td.time and the MS reminder stay; zero Calendar writes; no same-round
    // rebuild (the valve runs after the Calendar renderer in the round).
    if (rec.rem) {
      delete rec.rem.e;
      delete rec.rem.eFp;
      if (!Object.keys(rec.rem).length) delete rec.rem;
    }
    result.cancelledCleared += 1;
    return;
  }

  // C8: an all-day event cannot carry an engine time.  Occupying a pair's
  // slot is a collision, never an intake signal.
  if (!ev.start || !ev.start.dateTime) {
    result.quarantined.push({
      gId: gId, eventId: ev.id, reason: 'ALL_DAY_COLLISION',
      persisted: calendarIntakeQuarantine_(rec)
    });
    return;
  }

  var gTask = snap && snap.gTasksById ? snap.gTasksById[gId] : null;
  if (!gTask) {
    result.failClosed += 1;
    return;
  }

  var startRaw = String(ev.start.dateTime);
  var endRaw = ev.end && ev.end.dateTime ? String(ev.end.dateTime) : '';
  var observedFp = timeBridgeEventFingerprint_(ev.summary, startRaw, endRaw, reminderMode);
  var storedFp = rec.rem && rec.rem.eFp;

  // C1: the event is byte-for-byte what this engine last rendered.
  if (storedFp && storedFp === observedFp) {
    result.echoSkipped += 1;
    return;
  }

  var expected = calendarIntakeExpectedProjection_(rec, gTask, syncTimeZone, reminderMode);
  if (!expected || !storedFp) {
    // No usable baseline (no stored fingerprint, or no td.time to derive one):
    // field-level evidence is unavailable, so no decision is made.
    result.failClosed += 1;
    return;
  }

  // The stored fingerprint must describe the projection the CURRENT td would
  // produce.  If it does not, td moved without the renderer catching up and
  // the calendar side cannot be proven the newer edit — stand down (this is
  // the anti-Max() rule: only field-level evidence, never timestamps).
  if (storedFp !== expected.fingerprint) {
    result.failClosed += 1;
    return;
  }

  // C2: an etag is the minimum change evidence; without one a deviating start
  // is never adopted.
  if (!ev.etag) {
    result.failClosed += 1;
    return;
  }

  var evTitle = String(ev.summary == null ? '' : ev.summary).trim() || 'Task';
  var taskTitle = String(gTask.title == null ? '' : gTask.title).trim() || 'Task';
  var startMatches = !isNaN(Date.parse(startRaw)) && Date.parse(startRaw) === expected.startMs;

  // C9: neither the title nor the start matches what we last wrote —
  // ownership of the event cannot be established.  Quarantine, zero writes.
  if (evTitle !== taskTitle && !startMatches) {
    result.quarantined.push({
      gId: gId, eventId: ev.id, reason: 'FOREIGN_COLLISION',
      persisted: calendarIntakeQuarantine_(rec)
    });
    return;
  }
  if (startMatches) {
    // Start unchanged (title-only edit, or a resized duration): nothing to
    // intake; the resize is not adopted and the renderer restores 30 minutes.
    result.titleOnlyEdits += 1;
    return;
  }

  // Guards mirrored from the renderers: a pending NONE clear, an R-4
  // quarantined cal bucket, or an unresolved due conflict means another
  // component owns the outcome this round.
  if (rec.td && rec.td.clear === true) { result.skipped += 1; return; }
  if (timeBridgeRetryIsQuarantined_(rec, 'cal')) { result.skipped += 1; return; }
  if (rec.fc && rec.fc.due) { result.skipped += 1; return; }

  // Wall clock per the event's own zone (fallback sync zone), never substring.
  var evTimeZone = ev.start.timeZone || syncTimeZone;
  var wall;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(startRaw)) {
    var instantMs = Date.parse(startRaw);
    if (!isFinite(instantMs)) { result.failClosed += 1; return; }
    instantMs = calendarIntakeFoldFirstInstantMs_(instantMs, evTimeZone);
    wall = calendarIntakeWallFromInstant_(instantMs, evTimeZone);
  } else {
    // Floating wall time authored in the event zone (no offset marker).
    var m = startRaw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (!m) { result.failClosed += 1; return; }
    wall = { date: m[1], time: m[2] };
  }
  // C10: a wall time inside a spring gap does not exist in the zone — reject.
  if (!wall || !wall.date || !wall.time ||
      !calendarIntakeWallIsRealizable_(wall.date, wall.time, evTimeZone)) {
    result.rejected += 1;
    return;
  }

  var dateChanged = wall.date !== rec.td.date;
  var timeChanged = wall.time !== rec.td.time;
  if (!dateChanged && !timeChanged) {
    result.echoSkipped += 1;
    return;
  }
  if (calendarIntakeAdopt_(state, snap, rec, gId, gTask, wall, dateChanged, result)) {
    result.adopted += 1;
  }
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

function calendarIntakeRun_(state, snap, startedAt) {
  var result = {
    enabled: false, blocked: false, reason: null,
    pagesFetched: 0, fullRescans: 0, scanned: 0,
    echoSkipped: 0, titleOnlyEdits: 0, cancelledCleared: 0,
    adopted: 0, dueAdvanced: 0, quarantined: [], orphans: 0,
    failClosed: 0, rejected: 0, skipped: 0, failures: 0,
    tokenAdvanced: false
  };

  var safety = getSafetyConfig_();
  if (!safety.enableTimeBridge || !safety.enableCalendarProjection) return result;

  result.enabled = calendarIntakeEnabled_();
  if (!result.enabled) return result;

  if (!state || !state.g2m || !snap) {
    result.blocked = true;
    result.reason = 'NO_STATE_OR_SNAPSHOT';
    return result;
  }
  var calendarId = state.calendarProjection && state.calendarProjection.calendarId;
  if (!calendarId) {
    // The valve never creates the calendar; creation stays the renderer's job.
    result.blocked = true;
    result.reason = 'NO_PROJECTION_CALENDAR';
    return result;
  }
  if (typeof hasCompleteTaskDeletionInventory_ !== 'function' ||
      !hasCompleteTaskDeletionInventory_(snap)) {
    // Fail-closed: a partial inventory makes every evidence comparison stale,
    // so not even a read happens.
    result.blocked = true;
    result.reason = 'INCOMPLETE_INVENTORY';
    return result;
  }

  var syncTimeZone = syncTimeZone_();
  var reminderMode = safety.enableCalendarProjectionReminder === false ? 'silent' : 'default';

  // Pure read phase.  Everything below runs only after ALL pages succeeded;
  // a failure here throws with zero state mutations and no token write (C6).
  var listing = calendarIntakeListEvents_(calendarId, calendarIntakeReadToken_());
  result.pagesFetched = listing.pagesFetched;
  result.fullRescans = listing.fullRescans;
  result.scanned = listing.events.length;

  var index = calendarIntakeBuildReverseIndex_(state);
  var i;
  for (i = 0; i < listing.events.length; i += 1) {
    try {
      calendarIntakeAdjudicateEvent_(state, snap, listing.events[i], index, syncTimeZone, reminderMode, result);
    } catch (e) {
      result.failures += 1;
      console.warn('[CalendarIntake] adjudication failed for one event: ' + timeBridgeBoundedErrorCode_(e));
    }
  }

  // Watermark LAST (C7): the token is written only after every page was read
  // and every adoption completed.  The write is atomic — it either lands
  // (advanced) or throws (not advanced), never half-way.
  if (listing.nextSyncToken) {
    calendarIntakeWriteToken_(listing.nextSyncToken);
    result.tokenAdvanced = true;
  }
  return result;
}
