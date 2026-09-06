function epoch_(value) {
  const n = Date.parse(value || '');
  return isNaN(n) ? 0 : n;
}

function cleanupTombstones_(state, now) {
  // A tombstone expires at the exact 30-day boundary: age >= TOMBSTONE_TTL_MS.
  // Thus a 29-day-old record is retained and a 30-day-old record is removed.
  const cutoff = (now === undefined ? Date.now() : now) - TOMBSTONE_TTL_MS;
  ['g', 'm'].forEach(function(side) {
    Object.keys(state.tombstones[side]).forEach(function(id) {
      if ((state.tombstones[side][id].at || 0) <= cutoff) delete state.tombstones[side][id];
    });
  });
}

function listPairKey_(gListId, msListId) {
  // List IDs are opaque and may contain `|` (or any other separator). Treat a
  // pair key as an encoded tuple everywhere; callers must never parse it.
  return JSON.stringify([String(gListId || ''), String(msListId || '')]);
}

function listNameTombstoneKey_(name) {
  const normalized = normalizeListName_(name);
  return normalized ? 'name:' + normalized : null;
}

function listMetadataFingerprint_(side, list) {
  if (!list || !list.id) return null;
  if (side === 'g') {
    return JSON.stringify({ id: list.id, title: normalizeListName_(list.title) });
  }
  return JSON.stringify({
    id: list.id,
    title: normalizeListName_(list.displayName),
    isOwner: list.isOwner === true,
    isShared: list.isShared === false,
    wellknownListName: normalizeListName_(list.wellknownListName)
  });
}

function ensureListDeletionState_(state) {
  state.listPairMeta = state.listPairMeta || {};
  state.pendingListDeletions = state.pendingListDeletions || {};
  state.listDeletionJournal = state.listDeletionJournal || {};
  state.listDeletionConflicts = state.listDeletionConflicts || {};
  state.listTombstones = state.listTombstones || { g: {}, ms: {} };
  state.listTombstones.g = state.listTombstones.g || {};
  state.listTombstones.ms = state.listTombstones.ms || {};
  state.listTombstoneNames = state.listTombstoneNames || { g: {}, ms: {} };
  state.listTombstoneNames.g = state.listTombstoneNames.g || {};
  state.listTombstoneNames.ms = state.listTombstoneNames.ms || {};
}

function listTombstoneRecordMatches_(left, right) {
  const fields = ['at', 'source', 'gListId', 'msListId', 'gName', 'msName'];
  return !!left && !!right && fields.every(function(field) { return left[field] === right[field]; });
}

function listTombstoneRecordIssue_(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'MALFORMED_RECORD';
  const allowed = ['at', 'source', 'gListId', 'msListId', 'gName', 'msName'];
  if (Object.keys(record).some(function(key) { return allowed.indexOf(key) < 0; })) return 'UNKNOWN_RECORD_FIELD';
  if (typeof record.gListId !== 'string' || !record.gListId ||
      typeof record.msListId !== 'string' || !record.msListId) return 'MISSING_PAIR_IDS';
  if (typeof record.at !== 'number' || !isFinite(record.at)) return 'MALFORMED_AT';
  if (typeof record.source !== 'string' || !record.source) return 'MALFORMED_SOURCE';
  if (typeof record.gName !== 'string' || typeof record.msName !== 'string' ||
      record.gName !== normalizeListName_(record.gName) ||
      record.msName !== normalizeListName_(record.msName)) return 'MALFORMED_NAMES';
  return null;
}

// Returns reason codes only: diagnostics and health must never disclose task
// or list content/IDs while still making both directions of an asymmetric
// resurrection reservation visible to operators.

function listTombstoneIntegrityIssues_(state) {
  const issues = [];
  const tombstones = state && state.listTombstones;
  const nameGuards = state && state.listTombstoneNames;
  const gToMs = {};
  const msToG = {};
  const canonicalGoogleRecords = {};
  function add(code) {
    if (issues.indexOf(code) < 0) issues.push(code);
  }
  function validContainer(container, code) {
    if (!container || typeof container !== 'object' || Array.isArray(container) ||
        !container.g || typeof container.g !== 'object' || Array.isArray(container.g) ||
        !container.ms || typeof container.ms !== 'object' || Array.isArray(container.ms)) {
      add(code + '_INVALID');
      return false;
    }
    if (Object.keys(container).some(function(key) { return key !== 'g' && key !== 'ms'; })) {
      add(code + '_UNKNOWN_CONTAINER_KEY');
      return false;
    }
    return true;
  }
  const canonicalContainerValid = validContainer(tombstones, 'ID_CONTAINER');
  const nameContainerValid = validContainer(nameGuards, 'NAME_CONTAINER');
  if (!canonicalContainerValid || !nameContainerValid) return issues;
  const g = tombstones.g;
  const ms = tombstones.ms;
  const gNames = nameGuards.g;
  const msNames = nameGuards.ms;
  function inspectCanonical(side, key, record) {
    const issue = listTombstoneRecordIssue_(record);
    if (issue) {
      add(side + '_' + issue);
      return;
    }
    const expectedId = side === 'g' ? record.gListId : record.msListId;
    if (key !== expectedId) {
      add(side + '_ID_KEY_MISMATCH');
      return;
    }
    if (side === 'g') {
      canonicalGoogleRecords[key] = record;
      if (gToMs[key] && gToMs[key] !== record.msListId) add('DUPLICATE_GOOGLE_TARGET');
      if (msToG[record.msListId] && msToG[record.msListId] !== key) add('DUPLICATE_MICROSOFT_TARGET');
      gToMs[key] = record.msListId;
      msToG[record.msListId] = key;
      if (!ms[record.msListId] || !listTombstoneRecordMatches_(record, ms[record.msListId])) {
        add('GOOGLE_TO_MICROSOFT_ASYMMETRY');
      }
    } else {
      if (msToG[key] && msToG[key] !== record.gListId) add('DUPLICATE_MICROSOFT_TARGET');
      if (gToMs[record.gListId] && gToMs[record.gListId] !== key) add('DUPLICATE_GOOGLE_TARGET');
      msToG[key] = record.gListId;
      gToMs[record.gListId] = key;
      if (!g[record.gListId] || !listTombstoneRecordMatches_(record, g[record.gListId])) {
        add('MICROSOFT_TO_GOOGLE_ASYMMETRY');
      }
    }
  }
  Object.keys(g).forEach(function(key) { inspectCanonical('g', key, g[key]); });
  Object.keys(ms).forEach(function(key) { inspectCanonical('ms', key, ms[key]); });
  function inspectNameGuard(side, key, record) {
    const issue = listTombstoneRecordIssue_(record);
    if (issue) {
      add(side + '_NAME_' + issue);
      return;
    }
    const expectedNames = {};
    [listNameTombstoneKey_(record.gName), listNameTombstoneKey_(record.msName)].filter(Boolean)
      .forEach(function(nameKey) { expectedNames[nameKey] = true; });
    if (!expectedNames[key]) add(side + '_NAME_KEY_MISMATCH');
    const other = side === 'g' ? msNames : gNames;
    if (!other[key] || !listTombstoneRecordMatches_(record, other[key])) {
      add(side + '_NAME_ASYMMETRY');
    }
    const canonicalG = g[record.gListId];
    const canonicalMs = ms[record.msListId];
    if (!canonicalG || !canonicalMs || !listTombstoneRecordMatches_(record, canonicalG) ||
        !listTombstoneRecordMatches_(record, canonicalMs)) {
      add(side + '_NAME_ID_PAIR_MISMATCH');
    }
  }
  Object.keys(gNames).forEach(function(key) { inspectNameGuard('g', key, gNames[key]); });
  Object.keys(msNames).forEach(function(key) { inspectNameGuard('ms', key, msNames[key]); });
  // A generated tombstone reserves every non-empty normalized source name on
  // both sides. Absence is not benign: otherwise an import could retain only
  // ID guards and silently reopen auto-recreation by a surviving list name.
  // A name is a global guard, so multiple canonical pairs can legitimately
  // expect one alias.  That alias must always choose the newest *valid*
  // canonical pair; timestamp ties use the stable [gListId, msListId] order.
  // Do not treat malformed/crossed records as candidates for selection: their
  // own errors above already fail the state closed, and letting them choose an
  // alias could hide a good canonical reservation during inspection.
  const expectedNameAliases = {};
  Object.keys(canonicalGoogleRecords).forEach(function(gListId) {
    const record = canonicalGoogleRecords[gListId];
    const mirrored = ms[record.msListId];
    if (!mirrored || listTombstoneRecordIssue_(mirrored) ||
        mirrored.msListId !== record.msListId ||
        !listTombstoneRecordMatches_(record, mirrored)) return;
    [listNameTombstoneKey_(record.gName), listNameTombstoneKey_(record.msName)].filter(Boolean)
      .forEach(function(alias) {
        expectedNameAliases[alias] = listTombstoneAliasPreferredRecord_(
          expectedNameAliases[alias], record
        );
      });
  });
  Object.keys(expectedNameAliases).forEach(function(alias) {
    const expected = expectedNameAliases[alias];
    const googleAlias = gNames[alias];
    const microsoftAlias = msNames[alias];
    if (!googleAlias || !listTombstoneRecordMatches_(googleAlias, expected)) {
      add('GOOGLE_NAME_ALIAS_MISSING_OR_MISMATCHED');
    }
    if (!microsoftAlias || !listTombstoneRecordMatches_(microsoftAlias, expected)) {
      add('MICROSOFT_NAME_ALIAS_MISSING_OR_MISMATCHED');
    }
    if (googleAlias && microsoftAlias && !listTombstoneRecordMatches_(googleAlias, microsoftAlias)) {
      add('NAME_ALIAS_ASYMMETRIC');
    }
  });
  return issues;
}

function listTombstoneAliasPreferredRecord_(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (right.at !== left.at) return right.at > left.at ? right : left;
  // IDs are opaque strings.  Compare the tuple directly rather than joining
  // it with a separator, because an ID can itself contain any separator.
  const leftGoogle = String(left.gListId);
  const rightGoogle = String(right.gListId);
  if (rightGoogle !== leftGoogle) return rightGoogle > leftGoogle ? right : left;
  const leftMicrosoft = String(left.msListId);
  const rightMicrosoft = String(right.msListId);
  return rightMicrosoft > leftMicrosoft ? right : left;
}

// Rebuild only the separate mirrored name-guard tables after a valid canonical
// mutation. This deliberately does not run during normalize/import: malformed
// evidence must be rejected, never repaired. A shared name guard is
// deterministically rebound to a surviving canonical pair so an expired older
// pair cannot take its guard, while an opaque provider ID remains untouched.

function rebuildListTombstoneNameAliases_(state) {
  const tombstones = state.listTombstones;
  const nameGuards = state.listTombstoneNames;
  const selectedByAlias = {};
  Object.keys(tombstones.g).forEach(function(key) {
    const record = tombstones.g[key];
    if (!record || key !== record.gListId) return;
    [listNameTombstoneKey_(record.gName), listNameTombstoneKey_(record.msName)].filter(Boolean)
      .forEach(function(alias) {
        selectedByAlias[alias] = listTombstoneAliasPreferredRecord_(selectedByAlias[alias], record);
      });
  });
  nameGuards.g = {};
  nameGuards.ms = {};
  Object.keys(selectedByAlias).forEach(function(alias) {
    nameGuards.g[alias] = selectedByAlias[alias];
    nameGuards.ms[alias] = selectedByAlias[alias];
  });
}

function assertListTombstoneIntegrity_(state, errorCode) {
  const issues = listTombstoneIntegrityIssues_(state);
  if (issues.length) {
    throw new Error((errorCode || 'STATE_MALFORMED') + ': list tombstone ID/name guard integrity validation failed (' +
      issues.join(',') + '); overwriting or clearing resurrection evidence was refused.');
  }
}

function cleanupListTombstones_(state, now) {
  // Never "repair" one-sided or crossed tombstone evidence by deleting only
  // whichever table happens to have expired first. A malformed reservation is
  // fail-closed; a valid pair expires atomically at the exact 30-day boundary.
  assertListTombstoneIntegrity_(state, 'STATE_MALFORMED');
  const cutoff = (now === undefined ? Date.now() : now) - TOMBSTONE_TTL_MS;
  const expiredPairs = [];
  Object.keys(state.listTombstones.g).forEach(function(gListId) {
    const record = state.listTombstones.g[gListId];
    // An opaque provider ID may start with `name:`.  Treat it as canonical
    // only when it exactly identifies the record's Google side.
    if (!record || gListId !== record.gListId) return;
    if (record.at <= cutoff) {
      expiredPairs.push({
        gListId: record.gListId,
        msListId: record.msListId
      });
    }
  });
  expiredPairs.forEach(function(pair) {
    // Remove exact canonical entries atomically. Pair IDs are never rebuilt
    // from a composite key, so opaque IDs containing separators stay distinct.
    const gListId = pair.gListId;
    const msListId = pair.msListId;
    delete state.listTombstones.g[gListId];
    delete state.listTombstones.ms[msListId];
  });
  if (expiredPairs.length) rebuildListTombstoneNameAliases_(state);
}

function hasListTombstone_(state, side, id, name) {
  ensureListDeletionState_(state);
  const table = state.listTombstones[side] || {};
  const nameTable = state.listTombstoneNames[side] || {};
  const nameKey = listNameTombstoneKey_(name);
  return !!(table[id] || (nameKey && nameTable[nameKey]));
}

function markListPairDeleted_(state, pair, source) {
  ensureListDeletionState_(state);
  // This helper is intentionally callable only with a custom, auto-proven
  // pair. Default/unknown/shared lists must never gain list tombstones.
  if (!pair || !pair.deletable) {
    throw new Error('LIST_TOMBSTONE_INELIGIBLE: Default or ineligible lists cannot be written to tombstones.');
  }
  const record = {
    at: Date.now(),
    source: source || pair.missingSide || 'both',
    gListId: pair.gListId,
    msListId: pair.msListId,
    gName: normalizeListName_(pair.gTitle),
    msName: normalizeListName_(pair.msTitle)
  };
  state.listTombstones.g[pair.gListId] = record;
  state.listTombstones.ms[pair.msListId] = record;
  // Names are intentionally mirrored on both sides: after a one-sided
  // delete, either provider may later expose a similarly named survivor.
  // Rebuild instead of directly overwriting aliases so two independently
  // deleted pairs with one normalized name are immediately valid and choose
  // the deterministic newest canonical guard.
  rebuildListTombstoneNameAliases_(state);
}

function listPairHasTaskDeletionJournal_(state, gListId, msListId) {
  const deletePending = Object.keys(state.deletionJournal || {}).some(function(gTaskId) {
    const journal = state.deletionJournal[gTaskId];
    return !!journal && journal.gListId === gListId && journal.msListId === msListId;
  });
  if (deletePending) return true;
  return Object.keys(state.taskMoveJournal || {}).some(function(gTaskId) {
    const journal = state.taskMoveJournal[gTaskId];
    return !!journal && (journal.gListId === gListId ||
      journal.oldMsListId === msListId || journal.targetMsListId === msListId);
  });
}

function listPairHasTracking_(state, key) {
  return !!((state.pendingListDeletions && state.pendingListDeletions[key]) ||
    (state.listDeletionJournal && state.listDeletionJournal[key]) ||
    (state.listDeletionConflicts && state.listDeletionConflicts[key]));
}

// This is deliberately a pure inventory classifier.  A list is "missing"
// only when it is absent from a successfully paginated top-level inventory;
// filtering, default identity, sharing, ownership and exclusion are separate
// states and are never candidates for deletion.

function classifyListLifecycle_(state, allGLists, allMsLists, googleDefaultList, safety) {
  ensureListDeletionState_(state);
  const gById = autoListMapById_(allGLists);
  const msById = autoListMapById_(allMsLists);
  const lifecycle = {
    pairs: [],
    byKey: {},
    reservedGoogleIds: {},
    reservedMicrosoftIds: {},
    reservedNameKeys: {},
    reservedPairKeys: {},
    inventoryComplete: true,
    defaultGoogleListId: googleDefaultList && googleDefaultList.id || null
  };
  function reserveName(name) {
    const key = listNameTombstoneKey_(name);
    if (key) lifecycle.reservedNameKeys[key] = true;
  }
  ['g', 'ms'].forEach(function(side) {
    Object.keys(state.listTombstones[side] || {}).forEach(function(key) {
      const rec = state.listTombstones[side][key];
      if (rec && typeof rec === 'object') {
        if (rec.gListId) lifecycle.reservedGoogleIds[rec.gListId] = true;
        if (rec.msListId) lifecycle.reservedMicrosoftIds[rec.msListId] = true;
        reserveName(rec.gName);
        reserveName(rec.msName);
      }
    });
    Object.keys(state.listTombstoneNames[side] || {}).forEach(function(nameKey) {
      lifecycle.reservedNameKeys[nameKey] = true;
    });
  });
  // A candidate, journal, or conflict can outlive a mapping rebind or final
  // save failure.  Reserve its historic pair here, where lifecycle owns the
  // reservation tables; cleanupListTombstones_ only ages tombstone evidence.
  ['pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts'].forEach(function(field) {
    Object.keys(state[field] || {}).forEach(function(key) {
      const rec = state[field][key];
      if (!rec || typeof rec !== 'object') return;
      if (rec.gListId) lifecycle.reservedGoogleIds[rec.gListId] = true;
      if (rec.msListId) lifecycle.reservedMicrosoftIds[rec.msListId] = true;
      if (rec.gListId && rec.msListId) lifecycle.reservedPairKeys[
        listPairKey_(rec.gListId, rec.msListId)
      ] = true;
      reserveName(rec.gTitle || rec.gName);
      reserveName(rec.msTitle || rec.msName);
    });
  });
  Object.keys(state.listMap || {}).forEach(function(gListId) {
    const msListId = state.listMap[gListId];
    if (typeof msListId !== 'string' || !msListId) return;
    const key = listPairKey_(gListId, msListId);
    const meta = state.listPairMeta[key] || null;
    const google = gById[gListId] || null;
    const microsoft = msById[msListId] || null;
    const gLive = !!google;
    const msLive = !!microsoft;
    const gDefault = !!(googleDefaultList && gListId === googleDefaultList.id);
    const msDefault = !!(microsoft && normalizeListName_(microsoft.wellknownListName) === 'defaultlist');
    const excludedNames = excludedListNameSet_(safety);
    // A missing list has no current object, but a changed exclusion policy is
    // still current safety evidence.  Apply it to the last complete
    // both-live title instead of reusing stale `*Deletable=true` proof.
    const gKnownTitle = google ? (google.title || '') : (meta && meta.gTitle) || '';
    const msKnownTitle = microsoft ? (microsoft.displayName || '') : (meta && meta.msTitle) || '';
    const gExcluded = !!(gKnownTitle && excludedNames[normalizeListName_(gKnownTitle)]);
    const msExcluded = !!(msKnownTitle && excludedNames[normalizeListName_(msKnownTitle)]);
    const gEligible = isAutoDeletableGoogleList_(google, googleDefaultList, safety);
    const msEligible = isAutoDeletableMicrosoftList_(microsoft, safety);
    const gTitle = gKnownTitle;
    const msTitle = msKnownTitle;
    let status = 'both_live';
    if (!gLive && !msLive) status = 'both_missing';
    else if (!gLive) status = 'google_missing';
    else if (!msLive) status = 'microsoft_missing';
    if (gDefault || msDefault) status = 'default';
    else if (gExcluded || msExcluded) status = 'excluded';
    else if ((gLive && !gEligible) || (msLive && !msEligible)) status = 'ineligible';
    const tracked = listPairHasTracking_(state, key);
    const tombstoned = hasListTombstone_(state, 'g', gListId, gTitle) ||
      hasListTombstone_(state, 'ms', msListId, msTitle);
    const pair = {
      key: key,
      gListId: gListId,
      msListId: msListId,
      google: google,
      microsoft: microsoft,
      gLive: gLive,
      msLive: msLive,
      gTitle: gTitle || (meta && meta.gTitle) || '',
      msTitle: msTitle || (meta && meta.msTitle) || '',
      gFingerprint: listMetadataFingerprint_('g', google),
      msFingerprint: listMetadataFingerprint_('ms', microsoft),
      status: status,
      gDefault: gDefault,
      msDefault: msDefault,
      deletable: !gDefault && !msDefault && !gExcluded && !msExcluded &&
        ((gLive ? gEligible : !!(meta && meta.gDeletable)) &&
         (msLive ? msEligible : !!(meta && meta.msDeletable))),
      provenance: meta,
      tracked: tracked,
      tombstoned: tombstoned
    };
    // Every non-both-live pair, and any pair under lifecycle review, reserves
    // both stable IDs and all known names from the auto pairing/create planner.
    // Only a missing, tracked, or tombstoned pair takes ownership away from
    // normal task reconciliation. A default/excluded/ineligible pair that is
    // still live on both sides is not list-deletable, but its ordinary task
    // sync must remain available.
    if (status !== 'both_live' || tracked || tombstoned) {
      lifecycle.reservedGoogleIds[gListId] = true;
      lifecycle.reservedMicrosoftIds[msListId] = true;
      reserveName(gTitle || (meta && meta.gTitle));
      reserveName(msTitle || (meta && meta.msTitle));
    }
    if (!gLive || !msLive || tracked || tombstoned) lifecycle.reservedPairKeys[key] = true;
    lifecycle.pairs.push(pair);
    lifecycle.byKey[key] = pair;
  });
  return lifecycle;
}

function isListPairReserved_(snap, gListId, msListId) {
  return !!(snap && snap.listLifecycle && snap.listLifecycle.reservedPairKeys &&
    snap.listLifecycle.reservedPairKeys[listPairKey_(gListId, msListId)]);
}

function isProvenAutoListDeletionMissingPair_(state, lifecycle, gListId, msListId, statuses) {
  const key = listPairKey_(gListId, msListId);
  const pair = lifecycle && lifecycle.byKey && lifecycle.byKey[key];
  const meta = pair && pair.provenance;
  return !!pair && pair.gListId === gListId && pair.msListId === msListId &&
    hasExactUniqueListMapPair_(state, gListId, msListId) && pair.deletable === true &&
    !!meta && meta.gListId === gListId && meta.msListId === msListId &&
    !!meta.autoBothLiveProvenAt && meta.gDeletable === true && meta.msDeletable === true &&
    (statuses || ['google_missing', 'microsoft_missing', 'both_missing']).indexOf(pair.status) >= 0;
}

function autoListPairProofIsRevokedByObservation_(pair) {
  if (!pair) return false;
  const liveSideDisqualified = (pair.gLive || pair.msLive) &&
    ['default', 'excluded', 'ineligible'].indexOf(pair.status) >= 0;
  const liveMetadataChanged = !!pair.provenance &&
    ((pair.gLive && pair.provenance.gFingerprint !== pair.gFingerprint) ||
     (pair.msLive && pair.provenance.msFingerprint !== pair.msFingerprint));
  return liveSideDisqualified || liveMetadataChanged;
}

// This intentionally does only the destructive safety transition.  syncAll
// commits it immediately after complete list inventory and before the planner,
// list creation, task inventory, or any later operation can fail.  A lost
// final save must never resurrect a formerly eligible proof after a survivor
// was observed as excluded/default/ineligible/metadata-changed.

function revokeAutoListPairMetaForObservedSafety_(state, lifecycle, safety) {
  if (!isAutoDiscoveryMode_(safety) || !lifecycle || !lifecycle.inventoryComplete) return false;
  ensureListDeletionState_(state);
  let changed = false;
  lifecycle.pairs.forEach(function(pair) {
    if (autoListPairProofIsRevokedByObservation_(pair) && state.listPairMeta[pair.key]) {
      delete state.listPairMeta[pair.key];
      changed = true;
    }
  });
  return changed;
}

function recordAutoBothLivePairMeta_(state, lifecycle, safety) {
  if (!isAutoDiscoveryMode_(safety) || !lifecycle || !lifecycle.inventoryComplete) return;
  ensureListDeletionState_(state);
  const revoked = revokeAutoListPairMetaForObservedSafety_(state, lifecycle, safety);
  lifecycle.pairs.forEach(function(pair) {
    // A complete observation of either surviving side becoming default,
    // excluded, ineligible, or merely metadata-different revokes an old
    // auto-delete proof. This must not require both lists to be live: a
    // survivor can be renamed/excluded before the original missing side
    // reappears, and stale `*Deletable=true` must never bridge that side flip.
    // Only a later eligible both-live inventory can create fresh provenance.
    if (autoListPairProofIsRevokedByObservation_(pair)) return;
    if (pair.status !== 'both_live' || pair.tracked || pair.tombstoned || !pair.google || !pair.microsoft) return;
    state.listPairMeta[pair.key] = {
      gListId: pair.gListId,
      msListId: pair.msListId,
      gTitle: pair.gTitle,
      msTitle: pair.msTitle,
      gFingerprint: pair.gFingerprint,
      msFingerprint: pair.msFingerprint,
      gDeletable: !!isAutoDeletableGoogleList_(pair.google, null, safety) && !pair.gDefault,
      msDeletable: !!isAutoDeletableMicrosoftList_(pair.microsoft, safety),
      autoBothLiveProvenAt: new Date().toISOString()
    };
  });
  return revoked;
}

function pauseListDeletions_(state) {
  ensureListDeletionState_(state);
  let changed = Object.keys(state.pendingListDeletions).length > 0;
  state.pendingListDeletions = {};
  Object.keys(state.listDeletionJournal).forEach(function(key) {
    const journal = state.listDeletionJournal[key];
    if (journal && typeof journal === 'object' && journal.phase !== 'paused') {
      journal.phase = 'paused';
      changed = true;
    }
  });
  return changed;
}

function listDeletionModeError_(safety) {
  return !!(safety && safety.requestedListDeletions && !isAutoDiscoveryMode_(safety));
}

function pauseListDeletionIntentBeforeInventory_(state, safety) {
  ensureListDeletionState_(state);
  if (!safety || !safety.allowListDeletions || listDeletionModeError_(safety)) {
    const changed = pauseListDeletions_(state);
    // This write must finish before any inventory request.  A failed write
    // leaves the caller before it can inspect remote list state.
    if (changed || listDeletionModeError_(safety)) persistSyncState_(state);
  }
  if (listDeletionModeError_(safety)) {
    throw new Error('SYNC_LIST_DELETIONS_AUTO_ONLY: List deletion is allowed only when SYNC_LIST_DISCOVERY_MODE=auto.');
  }
}

function listPairMappings_(state, pair) {
  return Object.keys(state.g2m || {}).map(function(gId) {
    const rec = state.g2m[gId];
    if (!rec || rec.gListId !== pair.gListId || rec.msListId !== pair.msListId || !rec.msId) return null;
    return {
      gId: gId,
      msId: rec.msId,
      gListId: rec.gListId,
      msListId: rec.msListId,
      gUpdated: rec.gUpdated || null,
      msUpdated: rec.msUpdated || null
    };
  }).filter(Boolean).sort(function(a, b) {
    if (a.gId !== b.gId) return a.gId < b.gId ? -1 : 1;
    return a.msId < b.msId ? -1 : a.msId > b.msId ? 1 : 0;
  });
}

function hasExactUniqueListMapPair_(state, gListId, msListId) {
  if (!state || !state.listMap || state.listMap[gListId] !== msListId) return false;
  let owners = 0;
  Object.keys(state.listMap).forEach(function(candidateGListId) {
    if (state.listMap[candidateGListId] === msListId) owners++;
  });
  return owners === 1;
}

function hasCompleteListDeletionInventoryForPair_(state, snap, pair) {
  if (!snap || snap.listInventoryComplete !== true || !pair ||
      !hasExactUniqueListMapPair_(state, pair.gListId, pair.msListId) ||
      isGListFaulted_(state, pair.gListId) || isMsListFaulted_(state, pair.msListId)) {
    return false;
  }
  if (pair.status === 'google_missing') {
    return !!(snap.msTaskInventoryListIds && snap.msTaskInventoryListIds[pair.msListId]);
  }
  if (pair.status === 'microsoft_missing') {
    return !!(snap.gTaskInventoryListIds && snap.gTaskInventoryListIds[pair.gListId]);
  }
  // There is no live survivor to fetch after a complete top-level inventory
  // proves both lists absent.  Pair-local faults still make this unsafe.
  return pair.status === 'both_missing';
}

function listDeletionTaskEvidence_(state, snap, pair) {
  if (!pair || !hasExactUniqueListMapPair_(state, pair.gListId, pair.msListId)) {
    return { ok: false, reason: 'LIST_DELETE_LIST_MAP_NOT_ONE_TO_ONE' };
  }
  if (!hasCompleteListDeletionInventoryForPair_(state, snap, pair)) {
    return { ok: false, reason: 'LIST_DELETE_PAIR_INVENTORY_INCOMPLETE' };
  }
  if (listPairHasTaskDeletionJournal_(state, pair.gListId, pair.msListId)) {
    return { ok: false, reason: 'LIST_DELETE_TASK_JOURNAL_PENDING' };
  }
  const missingSide = pair.status === 'google_missing' ? 'google' :
    pair.status === 'microsoft_missing' ? 'microsoft' :
      pair.status === 'both_missing' ? 'both' : null;
  if (!missingSide) return { ok: false, reason: 'LIST_DELETE_SOURCE_REAPPEARED' };
  const pairs = listPairMappings_(state, pair);
  const byGoogle = {};
  const byMicrosoft = {};
  pairs.forEach(function(item) {
    byGoogle[item.gId] = item;
    byMicrosoft[item.msId] = item;
    // Both stored mapping timestamps must be parseable.  The missing copy is
    // not observable, so its last safe timestamp is the mapping evidence.
    if (validTimestampMs_(item.gUpdated) === null || validTimestampMs_(item.msUpdated) === null) {
      item.timestampInvalid = true;
    }
  });
  if (pairs.some(function(item) { return item.timestampInvalid; })) {
    return { ok: false, reason: 'LIST_DELETE_TASK_TIMESTAMP_UNPROVEN' };
  }
  const liveTasks = missingSide === 'google'
    ? Object.keys(snap.msTasksById || {}).filter(function(msId) {
      return snap.msListByTask[msId] === pair.msListId;
    }).map(function(msId) { return { side: 'ms', id: msId, task: snap.msTasksById[msId] }; })
    : missingSide === 'microsoft'
      ? Object.keys(snap.gTasksById || {}).filter(function(gId) {
        return snap.gListByTask[gId] === pair.gListId;
      }).map(function(gId) { return { side: 'g', id: gId, task: snap.gTasksById[gId] }; })
      : [];
  const expectedSurvivorIds = (missingSide === 'google'
    ? pairs.map(function(item) { return item.msId; })
    : missingSide === 'microsoft'
      ? pairs.map(function(item) { return item.gId; })
      : []).sort();
  const survivorEvidence = [];
  for (const live of liveTasks) {
    const rec = live.side === 'g' ? byGoogle[live.id] : byMicrosoft[live.id];
    if (!rec || (live.side === 'g' && state.m2g[rec.msId] !== rec.gId) ||
        (live.side === 'ms' && state.m2g[live.id] !== rec.gId)) {
      return { ok: false, reason: 'LIST_DELETE_UNMAPPED_TASK' };
    }
    const observed = validTimestampMs_(live.side === 'g' ? live.task.updated : live.task.lastModifiedDateTime);
    const mapped = validTimestampMs_(live.side === 'g' ? rec.gUpdated : rec.msUpdated);
    if (observed === null || mapped === null) {
      return { ok: false, reason: 'LIST_DELETE_TASK_TIMESTAMP_UNPROVEN' };
    }
    if (observed > mapped) return { ok: false, reason: 'LIST_DELETE_TASK_NEWER_THAN_MAPPING' };
    survivorEvidence.push({ id: live.id, updatedMs: observed });
  }
  const actualSurvivorIds = survivorEvidence.map(function(item) { return item.id; }).sort();
  if (JSON.stringify(actualSurvivorIds) !== JSON.stringify(expectedSurvivorIds)) {
    return { ok: false, reason: 'LIST_DELETE_SURVIVOR_TASK_SET_MISMATCH' };
  }
  survivorEvidence.sort(function(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  return {
    ok: true,
    taskPairs: pairs,
    taskFingerprint: JSON.stringify({
      missingSide: missingSide,
      taskPairs: pairs,
      survivorTasks: survivorEvidence
    }),
    missingSide: missingSide
  };
}

function listDeletionCandidateInput_(state, snap, pair) {
  if (!snap || !snap.safety || !snap.safety.allowListDeletions ||
      !isAutoDiscoveryMode_(snap.safety)) {
    return { ok: false, reason: 'LIST_DELETE_DISABLED' };
  }
  if (!pair || !hasExactUniqueListMapPair_(state, pair.gListId, pair.msListId)) {
    return { ok: false, reason: 'LIST_DELETE_LIST_MAP_NOT_ONE_TO_ONE' };
  }
  if (!pair.deletable || !pair.provenance ||
      ['google_missing', 'microsoft_missing', 'both_missing'].indexOf(pair.status) < 0) {
    return { ok: false, reason: 'LIST_DELETE_INELIGIBLE_OR_UNPROVEN' };
  }
  const meta = pair.provenance;
  if (meta.gListId !== pair.gListId || meta.msListId !== pair.msListId ||
      !meta.autoBothLiveProvenAt || !meta.gDeletable || !meta.msDeletable) {
    return { ok: false, reason: 'LIST_DELETE_PROVENANCE_MISSING' };
  }
  if (pair.gLive && meta.gFingerprint !== pair.gFingerprint) {
    return { ok: false, reason: 'LIST_DELETE_METADATA_CHANGED' };
  }
  if (pair.msLive && meta.msFingerprint !== pair.msFingerprint) {
    return { ok: false, reason: 'LIST_DELETE_METADATA_CHANGED' };
  }
  const evidence = listDeletionTaskEvidence_(state, snap, pair);
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    key: pair.key,
    gListId: pair.gListId,
    msListId: pair.msListId,
    gTitle: pair.gTitle || meta.gTitle || '',
    msTitle: pair.msTitle || meta.msTitle || '',
    missingSide: evidence.missingSide,
    gFingerprint: pair.gFingerprint || meta.gFingerprint || null,
    msFingerprint: pair.msFingerprint || meta.msFingerprint || null,
    survivorFingerprint: evidence.missingSide === 'google' ? pair.msFingerprint :
      evidence.missingSide === 'microsoft' ? pair.gFingerprint : null,
    taskPairs: evidence.taskPairs,
    taskFingerprint: evidence.taskFingerprint,
    deletable: true
  };
}

function listDeletionScenarioMatches_(record, input) {
  return !!record && !!input && record.gListId === input.gListId &&
    record.msListId === input.msListId && record.missingSide === input.missingSide &&
    record.gFingerprint === input.gFingerprint && record.msFingerprint === input.msFingerprint &&
    record.survivorFingerprint === input.survivorFingerprint &&
    record.taskFingerprint === input.taskFingerprint &&
    JSON.stringify(record.taskPairs || []) === JSON.stringify(input.taskPairs || []);
}

function clearListPairTaskCandidates_(state, pair) {
  Object.keys(state.pendingTaskDeletions || {}).forEach(function(gId) {
    const rec = state.g2m[gId];
    if (rec && rec.gListId === pair.gListId && rec.msListId === pair.msListId) {
      delete state.pendingTaskDeletions[gId];
    }
  });
}

function recordListDeletionConflict_(state, key, pairOrRecord, reason, keepJournal) {
  ensureListDeletionState_(state);
  const pair = pairOrRecord || {};
  state.listDeletionConflicts[key] = {
    at: new Date().toISOString(),
    reason: reason,
    gListId: pair.gListId || null,
    msListId: pair.msListId || null
  };
  delete state.pendingListDeletions[key];
  if (keepJournal && state.listDeletionJournal[key]) {
    state.listDeletionJournal[key].phase = 'blocked';
    state.listDeletionJournal[key].lastBlockedReason = reason;
    state.listDeletionJournal[key].lastBlockedAt = new Date().toISOString();
  }
}

function observeListDeletionCandidate_(state, snap, pair, roundId, progress) {
  ensureListDeletionState_(state);
  const existing = state.pendingListDeletions[pair.key];
  const input = listDeletionCandidateInput_(state, snap, pair);
  if (!input.ok) {
    if (existing && input.reason !== 'LIST_DELETE_DISABLED') {
      recordListDeletionConflict_(state, pair.key, pair, input.reason, false);
      if (progress) progress.invalidatedListCandidateKeys[pair.key] = true;
    }
    return null;
  }
  if (state.listDeletionConflicts[pair.key] || state.listDeletionJournal[pair.key]) return null;
  if (!existing) {
    // `input.ok` is control-flow evidence, not durable state.  Keeping it in
    // the candidate would make the strict schema reject the final sync save
    // and silently force every list deletion back to its first observation.
    const candidate = durableListDeletionCandidate_(input, {
      confirmations: 1,
      lastRoundId: roundId,
      firstConfirmedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString()
    });
    state.pendingListDeletions[pair.key] = candidate;
    clearListPairTaskCandidates_(state, pair);
    return candidate;
  }
  if (!listDeletionScenarioMatches_(existing, input)) {
    recordListDeletionConflict_(state, pair.key, pair, 'LIST_DELETE_SOURCE_OR_FINGERPRINT_CHANGED', false);
    if (progress) progress.invalidatedListCandidateKeys[pair.key] = true;
    return null;
  }
  if (existing.lastRoundId !== roundId) {
    existing.confirmations = Math.min(2, Number(existing.confirmations || 0) + 1);
    existing.lastRoundId = roundId;
    existing.lastConfirmedAt = new Date().toISOString();
  }
  clearListPairTaskCandidates_(state, pair);
  return existing;
}

function durableListDeletionCandidate_(input, progress) {
  // Pick the complete schema-3 allowlist explicitly.  `listDeletionCandidateInput_`
  // also returns transient fields such as `ok` / `reason`, which must never
  // cross the durable state boundary.
  const source = input || {};
  const extra = progress || {};
  return {
    key: source.key,
    gListId: source.gListId,
    msListId: source.msListId,
    gTitle: source.gTitle,
    msTitle: source.msTitle,
    missingSide: source.missingSide,
    gFingerprint: source.gFingerprint,
    msFingerprint: source.msFingerprint,
    survivorFingerprint: source.survivorFingerprint,
    taskPairs: cloneTaskDeletionValue_(source.taskPairs || []),
    taskFingerprint: source.taskFingerprint,
    deletable: source.deletable === true,
    confirmations: extra.confirmations,
    lastRoundId: extra.lastRoundId,
    firstConfirmedAt: extra.firstConfirmedAt,
    lastConfirmedAt: extra.lastConfirmedAt
  };
}

function preparedListDeletionJournal_(candidate) {
  return Object.assign({}, cloneTaskDeletionValue_(candidate), {
    phase: 'prepared',
    preparedAt: new Date().toISOString()
  });
}

function pendingForListDeletionJournalSave_(state, progress) {
  const baseline = progress && progress.pendingListBeforeRound;
  const pending = baseline ? cloneTaskDeletionValue_(baseline) :
    cloneTaskDeletionValue_(state.pendingListDeletions);
  Object.keys((progress && progress.invalidatedListCandidateKeys) || {}).forEach(function(key) {
    delete pending[key];
  });
  // A preceding pair in this same apply pass may already have finalized and
  // removed its exact listMap entry.  Do not let a later pair's journal save
  // resurrect that finalized pair's old 1/2 baseline candidate in durable
  // state; the list/task tombstones are now its sole resurrection evidence.
  Object.keys(pending).forEach(function(key) {
    const candidate = pending[key];
    if (!candidate || state.listMap[candidate.gListId] !== candidate.msListId) {
      delete pending[key];
    }
  });
  return pending;
}

function saveListDeletionJournalDurably_(state, progress, taskDeletionProgress) {
  const inMemoryListPending = state.pendingListDeletions;
  const inMemoryTaskPending = state.pendingTaskDeletions;
  state.pendingListDeletions = pendingForListDeletionJournalSave_(state, progress);
  // A list DELETE journal is also an early durable save.  It must not make a
  // task's current-round 1/2 (or replacement) durable merely because task
  // reconciliation ran first in this sync.
  state.pendingTaskDeletions = pendingForDeletionJournalSave_(state, taskDeletionProgress);
  try {
    persistSyncState_(state);
  } finally {
    state.pendingListDeletions = inMemoryListPending;
    state.pendingTaskDeletions = inMemoryTaskPending;
  }
}

function remoteDeleteForMissingListSide_(record) {
  try {
    if (record.missingSide === 'google') deleteMsList_(record.msListId);
    else if (record.missingSide === 'microsoft') deleteGList_(record.gListId);
    return { alreadyGone: false };
  } catch (e) {
    if (isNotFoundError_(e)) return { alreadyGone: true };
    throw e;
  }
}

function exactListDeletionTaskPairsMatch_(state, record) {
  const pair = { gListId: record.gListId, msListId: record.msListId };
  return JSON.stringify(listPairMappings_(state, pair)) === JSON.stringify(record.taskPairs || []);
}

function finalizeListDeletion_(state, key, record, source) {
  ensureListDeletionState_(state);
  if (!record || !record.deletable || !hasExactUniqueListMapPair_(state, record.gListId, record.msListId) ||
      !exactListDeletionTaskPairsMatch_(state, record)) {
    throw new Error('LIST_DELETE_FINALIZE_EXACT_MATCH_REQUIRED');
  }
  (record.taskPairs || []).forEach(function(taskPair) {
    const rec = state.g2m[taskPair.gId];
    if (!rec || rec.msId !== taskPair.msId || rec.gListId !== record.gListId ||
        rec.msListId !== record.msListId) {
      throw new Error('LIST_DELETE_FINALIZE_TASK_MAPPING_CHANGED');
    }
  });
  (record.taskPairs || []).forEach(function(taskPair) {
    markPairDeleted_(state, taskPair.gId, taskPair.msId, 'list:' + (source || record.missingSide));
    delete state.g2m[taskPair.gId];
    if (state.m2g[taskPair.msId] === taskPair.gId) delete state.m2g[taskPair.msId];
    delete state.pendingTaskDeletions[taskPair.gId];
    delete state.deletionJournal[taskPair.gId];
    delete state.taskDeletionConflicts[taskPair.gId];
  });
  markListPairDeleted_(state, record, source);
  if (state.listMap[record.gListId] === record.msListId) delete state.listMap[record.gListId];
  delete state.listPairMeta[key];
  delete state.pendingListDeletions[key];
  delete state.listDeletionConflicts[key];
  delete state.listDeletionJournal[key];
  delete state.listFaults.g[record.gListId];
  delete state.listFaults.ms[record.msListId];
}

function directListOrNull_(reader, id) {
  try {
    return reader(id);
  } catch (e) {
    if (isNotFoundError_(e)) return null;
    throw e;
  }
}

// Remote deletion is preceded by a fresh, independent read.  It intentionally
// does not reuse the normal-sync snapshot because task updates or list rebinding
// can occur between ordinary reconciliation and DELETE.

function buildListDeletionRevalidation_(state, record, safety) {
  if (!record || !hasExactUniqueListMapPair_(state, record.gListId, record.msListId)) {
    return { ok: false, reason: 'LIST_DELETE_LIST_MAP_NOT_ONE_TO_ONE' };
  }
  const allGLists = getGLists_();
  const allMsLists = getMsLists_();
  let gDefault = null;
  try {
    gDefault = getGDefaultList_();
  } catch (e) {
    throw new Error('LIST_DELETE_DEFAULT_REVALIDATION_FAILED: ' + e.message);
  }
  if (!gDefault || !gDefault.id || !allGLists.some(function(list) { return list.id === gDefault.id; })) {
    throw new Error('LIST_DELETE_DEFAULT_REVALIDATION_FAILED');
  }
  const lifecycle = classifyListLifecycle_(state, allGLists, allMsLists, gDefault, safety);
  const pair = lifecycle.byKey[listPairKey_(record.gListId, record.msListId)] || null;
  if (!pair) return { ok: false, reason: 'LIST_DELETE_MAPPING_CHANGED' };
  let directGoogle = null;
  let directMicrosoft = null;
  if (pair.gLive) {
    directGoogle = directListOrNull_(getGList_, pair.gListId);
    if (!directGoogle || listMetadataFingerprint_('g', directGoogle) !== pair.gFingerprint) {
      return { ok: false, reason: 'LIST_DELETE_DIRECT_GOOGLE_CHANGED' };
    }
    pair.google = directGoogle;
    pair.gTitle = directGoogle.title || pair.gTitle;
    pair.gFingerprint = listMetadataFingerprint_('g', directGoogle);
  }
  if (pair.msLive) {
    directMicrosoft = directListOrNull_(getMsList_, pair.msListId);
    if (!directMicrosoft || listMetadataFingerprint_('ms', directMicrosoft) !== pair.msFingerprint) {
      return { ok: false, reason: 'LIST_DELETE_DIRECT_MICROSOFT_CHANGED' };
    }
    pair.microsoft = directMicrosoft;
    pair.msTitle = directMicrosoft.displayName || pair.msTitle;
    pair.msFingerprint = listMetadataFingerprint_('ms', directMicrosoft);
  }
  const snap = {
    inventoryComplete: true,
    listInventoryComplete: true,
    safety: safety,
    gTasksById: {},
    msTasksById: {},
    gListByTask: {},
    msListByTask: {},
    gTaskInventoryListIds: {},
    msTaskInventoryListIds: {}
  };
  if (pair.gLive) {
    const tasks = getGTasks_(pair.gListId);
    snap.gTaskInventoryListIds[pair.gListId] = true;
    tasks.forEach(function(task) {
      snap.gTasksById[task.id] = task;
      snap.gListByTask[task.id] = pair.gListId;
    });
  }
  if (pair.msLive) {
    const tasks = getMsTasks_(pair.msListId);
    snap.msTaskInventoryListIds[pair.msListId] = true;
    tasks.forEach(function(task) {
      snap.msTasksById[task.id] = task;
      snap.msListByTask[task.id] = pair.msListId;
    });
  }
  const input = listDeletionCandidateInput_(state, snap, pair);
  return input.ok ? { ok: true, pair: pair, input: input, snap: snap } : input;
}

function canFinalizePreparedListJournalBothMissing_(state, journal, input) {
  if (!journal || journal.phase !== 'prepared' || !input || input.missingSide !== 'both' ||
      ['google', 'microsoft'].indexOf(journal.missingSide) < 0 ||
      !hasExactUniqueListMapPair_(state, journal.gListId, journal.msListId) ||
      !exactListDeletionTaskPairsMatch_(state, journal)) {
    return false;
  }
  // The survivor may have disappeared because the journaled DELETE succeeded
  // after its durable write but before final state persistence.  This is a
  // safe local completion only when the unchanged mapping/provenance and all
  // journaled task pairs still exactly match the fresh both-missing proof.
  return journal.gListId === input.gListId && journal.msListId === input.msListId &&
    journal.gFingerprint === input.gFingerprint && journal.msFingerprint === input.msFingerprint &&
    JSON.stringify(journal.taskPairs || []) === JSON.stringify(input.taskPairs || []);
}

function recoverPreparedListDeletions_(state, safety, progress) {
  ensureListDeletionState_(state);
  const keys = Object.keys(state.listDeletionJournal).sort();
  for (const key of keys) {
    const journal = state.listDeletionJournal[key];
    if (!journal || !journal.gListId || !journal.msListId) {
      recordListDeletionConflict_(state, key, journal || {}, 'LIST_DELETE_JOURNAL_MALFORMED', true);
      continue;
    }
    if (journal.phase === 'blocked') continue;
    if (!hasExactUniqueListMapPair_(state, journal.gListId, journal.msListId)) {
      recordListDeletionConflict_(state, key, journal, 'LIST_DELETE_LIST_MAP_NOT_ONE_TO_ONE', true);
      continue;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_LIST_DELETE_RECOVERY_READ');
    const revalidation = buildListDeletionRevalidation_(state, journal, safety);
    if (!revalidation.ok) {
      recordListDeletionConflict_(state, key, journal, revalidation.reason, true);
      continue;
    }
    if (journal.phase === 'paused') {
      // A paused intent may only finish without another DELETE when both
      // inventories independently prove both copies absent. Otherwise it is
      // quarantined; re-enabling starts no automatic delete from stale intent.
      if (revalidation.input.missingSide === 'both') {
        finalizeListDeletion_(state, key, journal, 'journal-both-missing');
      } else {
        recordListDeletionConflict_(state, key, journal, 'LIST_DELETE_PAUSED_REQUIRES_REVIEW', true);
      }
      continue;
    }
    if (journal.phase === 'prepared' &&
        canFinalizePreparedListJournalBothMissing_(state, journal, revalidation.input)) {
      finalizeListDeletion_(state, key, journal, 'journal-both-missing');
      continue;
    }
    if (journal.phase !== 'prepared' || !listDeletionScenarioMatches_(journal, revalidation.input)) {
      recordListDeletionConflict_(state, key, journal, 'LIST_DELETE_JOURNAL_REVALIDATION_CHANGED', true);
      continue;
    }
    if (revalidation.input.missingSide === 'both') {
      finalizeListDeletion_(state, key, journal, 'journal-both-missing');
      continue;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_LIST_DELETE_RECOVERY_REMOTE');
    remoteDeleteForMissingListSide_(journal);
    finalizeListDeletion_(state, key, journal, 'journal-recovery');
  }
  return progress;
}

function applyConfirmedListDeletions_(state, snap, roundId, progress, taskDeletionProgress) {
  ensureListDeletionState_(state);
  progress = progress || {};
  progress.durableListJournalKeys = progress.durableListJournalKeys || {};
  progress.invalidatedListCandidateKeys = progress.invalidatedListCandidateKeys || {};
  if (!snap || !snap.safety || !snap.safety.allowListDeletions) return progress;
  recoverPreparedListDeletions_(state, snap.safety, progress);
  const lifecycle = snap.listLifecycle;
  // A list candidate's proof is pair-local, but a failed overall sync is not
  // a completed confirmation round. Leave every existing candidate untouched
  // here (rather than feeding the unrelated fault into its evidence check).
  if (!lifecycle || lifecycle.inventoryComplete !== true || snap.inventoryComplete !== true) return progress;
  lifecycle.pairs.forEach(function(pair) {
    const existing = state.pendingListDeletions[pair.key];
    if (pair.status === 'both_live' && existing) {
      recordListDeletionConflict_(state, pair.key, pair, 'LIST_DELETE_SOURCE_REAPPEARED', false);
      progress.invalidatedListCandidateKeys[pair.key] = true;
      return;
    }
    observeListDeletionCandidate_(state, snap, pair, roundId, progress);
  });
  // A candidate whose exact pair is no longer present in listMap is a rebind,
  // not a new first observation.  Quarantine it and retain the conflict rather
  // than allowing a later automatic restart against a different counterpart.
  // `byKey` is always supplied by buildSnapshot_ in the real sync flow.  Keep
  // this lower-level helper compatible with focused callers that supply only
  // the lifecycle pair array; absent evidence must not be misread as a
  // rebind.  A supplied (including empty) index remains authoritative.
  const lifecycleByKey = lifecycle.byKey || null;
  Object.keys(state.pendingListDeletions).forEach(function(key) {
    if (lifecycleByKey && !lifecycleByKey[key]) {
      const pending = state.pendingListDeletions[key];
      recordListDeletionConflict_(state, key, pending, 'LIST_DELETE_MAPPING_CHANGED', false);
      progress.invalidatedListCandidateKeys[key] = true;
    }
  });
  const keys = Object.keys(state.pendingListDeletions).sort();
  for (const key of keys) {
    const candidate = state.pendingListDeletions[key];
    if (!candidate || candidate.lastRoundId !== roundId || Number(candidate.confirmations || 0) < 2 ||
        state.listDeletionJournal[key] || state.listDeletionConflicts[key]) continue;
    assertDestructiveTimeBudget_('TIME_BUDGET_LIST_DELETE_REVALIDATION');
    const revalidation = buildListDeletionRevalidation_(state, candidate, snap.safety);
    if (!revalidation.ok || !listDeletionScenarioMatches_(candidate, revalidation.input)) {
      recordListDeletionConflict_(state, key, candidate,
        !revalidation.ok ? revalidation.reason : 'LIST_DELETE_REVALIDATION_FINGERPRINT_CHANGED', false);
      progress.invalidatedListCandidateKeys[key] = true;
      continue;
    }
    if (candidate.missingSide === 'both') {
      finalizeListDeletion_(state, key, candidate, 'both-missing');
      continue;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_LIST_DELETE_JOURNAL_SAVE');
    state.listDeletionJournal[key] = preparedListDeletionJournal_(candidate);
    // The one-pair journal is durable before DELETE.  The save substitutes the
    // completed-round pending baseline so a later remote failure cannot make a
    // different pair's first/second confirmation durable.
    saveListDeletionJournalDurably_(state, progress, taskDeletionProgress);
    progress.durableListJournalKeys[key] = true;
    assertDestructiveTimeBudget_('TIME_BUDGET_LIST_DELETE_REMOTE');
    remoteDeleteForMissingListSide_(candidate);
    finalizeListDeletion_(state, key, candidate, 'remote-delete');
  }
  return progress;
}

function listDeletionObservability_(state, safety) {
  ensureListDeletionState_(state);
  const journals = Object.keys(state.listDeletionJournal);
  const pendingBySide = { google: 0, microsoft: 0, both: 0 };
  Object.keys(state.pendingListDeletions).forEach(function(key) {
    const side = state.pendingListDeletions[key] && state.pendingListDeletions[key].missingSide;
    if (Object.prototype.hasOwnProperty.call(pendingBySide, side)) pendingBySide[side]++;
  });
  const phases = { prepared: 0, paused: 0, blocked: 0, orphan: 0 };
  journals.forEach(function(key) {
    const journal = state.listDeletionJournal[key];
    if (!journal || state.listMap[journal.gListId] !== journal.msListId) phases.orphan++;
    else if (Object.prototype.hasOwnProperty.call(phases, journal.phase)) phases[journal.phase]++;
    else phases.blocked++;
  });
  const reasons = {};
  Object.keys(state.listDeletionConflicts).forEach(function(key) {
    const reason = state.listDeletionConflicts[key] && state.listDeletionConflicts[key].reason || 'UNKNOWN';
    reasons[reason] = (reasons[reason] || 0) + 1;
  });
  return {
    requested: !!(safety && safety.requestedListDeletions),
    effective: !!(safety && safety.allowListDeletions),
    mode: safety && safety.listDiscoveryMode || 'unknown',
    pendingListDeletionCandidates: Object.keys(state.pendingListDeletions).length,
    pendingByMissingSide: pendingBySide,
    listDeletionJournals: journals.length,
    journalPhases: phases,
    listDeletionConflicts: Object.keys(state.listDeletionConflicts).length,
    conflictReasons: reasons,
    googleListTombstones: Object.keys(state.listTombstones.g).length,
    microsoftListTombstones: Object.keys(state.listTombstones.ms).length,
    googleListTombstoneNameGuards: Object.keys(state.listTombstoneNames.g).length,
    microsoftListTombstoneNameGuards: Object.keys(state.listTombstoneNames.ms).length,
    provenanceMissing: Object.keys(state.listMap).filter(function(gId) {
      const key = listPairKey_(gId, state.listMap[gId]);
      return !state.listPairMeta[key];
    }).length
  };
}

function rollbackUndurableListDeletionChanges_(state, pendingBeforeRound, progress, enabled) {
  ensureListDeletionState_(state);
  if (!enabled) {
    state.pendingListDeletions = {};
    return;
  }
  state.pendingListDeletions = cloneTaskDeletionValue_(pendingBeforeRound || {});
  Object.keys((progress && progress.invalidatedListCandidateKeys) || {}).forEach(function(key) {
    delete state.pendingListDeletions[key];
  });
}

function markPairDeleted_(state, gId, msId, source) {
  const record = { at: Date.now(), source: source };
  if (gId) state.tombstones.g[gId] = record;
  if (msId) state.tombstones.m[msId] = record;
}

function clearPendingTaskDeletion_(state, gId) {
  if (!gId) return;
  ensureTaskDeletionState_(state);
  delete state.pendingTaskDeletions[gId];
}

function ensureTaskDeletionState_(state) {
  state.pendingTaskDeletions = state.pendingTaskDeletions || {};
  state.deletionJournal = state.deletionJournal || {};
  state.taskDeletionConflicts = state.taskDeletionConflicts || {};
}

function hasDeletionJournalForMsTask_(state, msId) {
  return Object.keys(state.deletionJournal || {}).some(function(gId) {
    const journal = state.deletionJournal[gId];
    return !!journal && journal.msId === msId;
  });
}

function hasMoveJournalForMsTask_(state, msId) {
  return Object.keys(state.taskMoveJournal || {}).some(function(gId) {
    const journal = state.taskMoveJournal[gId];
    return !!journal && (journal.oldMsId === msId || journal.newMsId === msId);
  });
}

function clearDeletionTracking_(state, gId) {
  if (!gId) return;
  clearPendingTaskDeletion_(state, gId);
  delete state.deletionJournal[gId];
}

function clearTaskDeletionConflict_(state, gId) {
  if (!gId) return;
  delete state.taskDeletionConflicts[gId];
}

function removeMapping_(state, gId, msId) {
  if (gId) delete state.g2m[gId];
  if (msId) delete state.m2g[msId];
  clearDeletionTracking_(state, gId);
  clearTaskDeletionConflict_(state, gId);
}

function putMapping_(state, gTask, gListId, msTask, msListId) {
  const previous = state.g2m[gTask.id];
  if (previous && previous.msId && previous.msId !== msTask.id) {
    delete state.m2g[previous.msId];
  }
  state.g2m[gTask.id] = {
    msId: msTask.id,
    gListId: gListId,
    msListId: msListId,
    gUpdated: gTask.updated || null,
    msUpdated: msTask.lastModifiedDateTime || null
  };
  state.m2g[msTask.id] = gTask.id;
}

function deletionRoundId_(startedAt) {
  return String(startedAt === undefined ? Date.now() : startedAt);
}

function missingSide_(gTask, msTask) {
  if (!gTask && !msTask) return 'both';
  if (!gTask) return 'google';
  if (!msTask) return 'microsoft';
  return null;
}

function hasCompleteTaskDeletionInventory_(snap) {
  // A missing task is meaningful only when both mapped task inventories finished.
  // buildSnapshot_ marks any list fault or partial task inventory as false.
  return !!snap && snap.inventoryComplete === true;
}

function hasCompleteTaskDeletionInventoryForPair_(state, snap, rec) {
  return hasCompleteTaskDeletionInventory_(snap) && !!rec &&
    !!(state.listMap && state.listMap[rec.gListId] === rec.msListId) &&
    !!(snap.activeGListIds && snap.activeGListIds[rec.gListId]) &&
    !!(snap.gTaskInventoryListIds && snap.gTaskInventoryListIds[rec.gListId]) &&
    !!(snap.msTaskInventoryListIds && snap.msTaskInventoryListIds[rec.msListId]) &&
    !isGListFaulted_(state, rec.gListId) && !isMsListFaulted_(state, rec.msListId);
}

function markDeletionJournalInventoryBlocked_(journal) {
  markDeletionJournalBlocked_(journal, 'DELETE_PAIR_INVENTORY_UNAVAILABLE');
}

function markDeletionJournalBlocked_(journal, reason) {
  if (!journal) return;
  journal.lastBlockedReason = reason || 'DELETE_PAIR_INVENTORY_UNAVAILABLE';
  journal.lastBlockedAt = new Date().toISOString();
}

function clearDeletionJournalInventoryBlock_(journal) {
  if (!journal) return;
  delete journal.lastBlockedReason;
  delete journal.lastBlockedAt;
}

function taskDeletionPairBlockReason_(state, snap, rec) {
  if (!rec || !state.listMap || state.listMap[rec.gListId] !== rec.msListId) {
    return 'DELETE_LIST_PAIR_CHANGED';
  }
  return hasCompleteTaskDeletionInventoryForPair_(state, snap, rec)
    ? null : 'DELETE_PAIR_INVENTORY_UNAVAILABLE';
}

function markTaskDeletionCandidateInvalidated_(progress, gId) {
  if (!progress || !gId) return;
  progress.invalidatedCandidateTaskIds = progress.invalidatedCandidateTaskIds || {};
  progress.invalidatedCandidateTaskIds[gId] = true;
}

function markTaskDeletionCandidateReplacement_(progress, gId) {
  if (!progress || !gId) return;
  progress.discardCandidateTaskIds = progress.discardCandidateTaskIds || {};
  progress.discardCandidateTaskIds[gId] = true;
}

function blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress) {
  markTaskDeletionCandidateInvalidated_(progress, gId);
  clearPendingTaskDeletion_(state, gId);
  const journal = state.deletionJournal[gId];
  const reason = taskDeletionPairBlockReason_(state, snap, rec);
  if (journal && reason) markDeletionJournalBlocked_(journal, reason);
  return reason;
}

function validTimestampMs_(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return isNaN(timestamp) ? null : timestamp;
}

function deletionScenarioMatches_(record, rec, gId, missingSide, snap) {
  if (!record || !rec || record.gId !== gId || record.msId !== rec.msId ||
      record.missingSide !== missingSide || record.gListId !== rec.gListId ||
      record.msListId !== rec.msListId ||
      (record.gUpdated || null) !== (rec.gUpdated || null) ||
      (record.msUpdated || null) !== (rec.msUpdated || null)) {
    return false;
  }
  if (snap.gTasksById[gId] && snap.gListByTask[gId] !== rec.gListId) return false;
  if (snap.msTasksById[rec.msId] && snap.msListByTask[rec.msId] !== rec.msListId) return false;
  return true;
}

function recordTaskDeletionConflict_(state, gId, rec, reason) {
  if (!gId || !rec) return;
  state.taskDeletionConflicts[gId] = {
    at: new Date().toISOString(),
    reason: reason,
    msId: rec.msId,
    gListId: rec.gListId,
    msListId: rec.msListId
  };
  clearDeletionTracking_(state, gId);
  console.warn('[DeleteConflict] ' + reason + ': ' + taskLabel_(gId, null));
}

function deletionTargetIsSafe_(gId, rec, missingSide, gTask, msTask, snap) {
  if (missingSide === 'both') return { ok: true };
  const target = missingSide === 'google' ? msTask : gTask;
  const targetTimestamp = missingSide === 'google'
    ? (target && target.lastModifiedDateTime)
    : (target && target.updated);
  const mappedTimestamp = missingSide === 'google' ? rec.msUpdated : rec.gUpdated;
  const targetListId = missingSide === 'google'
    ? snap.msListByTask[rec.msId]
    : snap.gListByTask[gId];
  const expectedListId = missingSide === 'google' ? rec.msListId : rec.gListId;
  const observed = validTimestampMs_(targetTimestamp);
  const mapped = validTimestampMs_(mappedTimestamp);
  if (!target || targetListId !== expectedListId) {
    return { ok: false, reason: 'DELETE_SOURCE_SCENARIO_CHANGED' };
  }
  if (observed === null || mapped === null) {
    return { ok: false, reason: 'DELETE_TIMESTAMP_UNPROVEN' };
  }
  if (observed > mapped) {
    return { ok: false, reason: 'DELETE_VS_EDIT_CONFLICT' };
  }
  return { ok: true };
}

function pauseTaskDeletions_(state) {
  Object.keys(state.pendingTaskDeletions).forEach(function(gId) {
    delete state.pendingTaskDeletions[gId];
  });
}

function pausePreparedDeletionJournals_(state) {
  Object.keys(state.deletionJournal).forEach(function(gId) {
    state.deletionJournal[gId].phase = 'paused';
  });
}

function observeTaskDeletionCandidate_(state, rec, gId, missingSide, snap, roundId, progress) {
  if (!hasCompleteTaskDeletionInventoryForPair_(state, snap, rec) || state.taskDeletionConflicts[gId] ||
      state.deletionJournal[gId]) {
    return null;
  }
  let candidate = state.pendingTaskDeletions[gId];
  if (!deletionScenarioMatches_(candidate, rec, gId, missingSide, snap)) {
    if (candidate) {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      // This replacement is a first observation in the current round.  It is
      // valid only if the round completes; rollback must not retain it while
      // also refusing to restore the incompatible old candidate.
      markTaskDeletionCandidateReplacement_(progress, gId);
    }
    candidate = {
      gId: gId,
      msId: rec.msId,
      missingSide: missingSide,
      gListId: rec.gListId,
      msListId: rec.msListId,
      gUpdated: rec.gUpdated || null,
      msUpdated: rec.msUpdated || null,
      firstConfirmedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
      lastRoundId: roundId,
      confirmations: 1
    };
    state.pendingTaskDeletions[gId] = candidate;
    console.log('[DeleteCandidate] Confirmation round 1/2: ' + taskLabel_(gId, null) + ' missing=' + missingSide);
    return candidate;
  }
  if (candidate.lastRoundId !== roundId) {
    candidate.confirmations = Math.min(2, Number(candidate.confirmations || 0) + 1);
    candidate.lastRoundId = roundId;
    candidate.lastConfirmedAt = new Date().toISOString();
    console.log('[DeleteCandidate] Confirmation round ' + candidate.confirmations + '/2: ' + taskLabel_(gId, null) + ' missing=' + missingSide);
  }
  return candidate;
}

function finalizeTaskDeletion_(state, snap, gId, rec, missingSide) {
  markPairDeleted_(state, gId, rec.msId, missingSide);
  removeMapping_(state, gId, rec.msId);
  delete snap.gTasksById[gId];
  delete snap.msTasksById[rec.msId];
  delete snap.gListByTask[gId];
  delete snap.msListByTask[rec.msId];
  console.log('[Delete] Completed: ' + taskLabel_(gId, null) + ' missing=' + missingSide);
}

function remoteDeleteForMissingSide_(gId, rec, missingSide) {
  try {
    if (missingSide === 'google') {
      deleteMsTask_(rec.msListId, rec.msId);
    } else if (missingSide === 'microsoft') {
      deleteGTask_(rec.gListId, gId);
    }
    return { alreadyGone: false };
  } catch (e) {
    if (isNotFoundError_(e)) return { alreadyGone: true };
    throw e;
  }
}

function preparedDeletionJournal_(candidate) {
  return {
    phase: 'prepared',
    gId: candidate.gId,
    msId: candidate.msId,
    missingSide: candidate.missingSide,
    gListId: candidate.gListId,
    msListId: candidate.msListId,
    gUpdated: candidate.gUpdated || null,
    msUpdated: candidate.msUpdated || null,
    preparedAt: new Date().toISOString()
  };
}

function pendingForDeletionJournalSave_(state, progress) {
  const beforeRound = progress && progress.pendingBeforeRound;
  const invalidated = (progress && progress.invalidatedCandidateTaskIds) || {};
  // A journal save is an exception to normal end-of-round persistence: it is
  // allowed to make this delete intent durable before the remote call, but it
  // must not accidentally count any other task's current-round observation if
  // the later call or final state save fails.
  const pending = beforeRound
    ? cloneTaskDeletionValue_(beforeRound)
    : cloneTaskDeletionValue_(state.pendingTaskDeletions);
  Object.keys(invalidated).forEach(function(gId) {
    delete pending[gId];
  });
  Object.keys(pending).forEach(function(gId) {
    if (!state.g2m[gId]) delete pending[gId];
  });
  return pending;
}

function saveDeletionJournalDurably_(state, progress) {
  const inMemoryPending = state.pendingTaskDeletions;
  state.pendingTaskDeletions = pendingForDeletionJournalSave_(state, progress);
  try {
    persistSyncState_(state);
  } finally {
    state.pendingTaskDeletions = inMemoryPending;
  }
}

function recoverPreparedTaskDeletions_(state, snap) {
  ensureTaskDeletionState_(state);
  if (!hasCompleteTaskDeletionInventory_(snap)) return;
  Object.keys(state.deletionJournal).forEach(function(gId) {
    const journal = state.deletionJournal[gId];
    const rec = state.g2m[gId];
    if (!journal) {
      clearDeletionTracking_(state, gId);
      return;
    }
    if (!rec) {
      console.error('[DeleteJournal] Mapping is missing; journal retained and automatic creation stopped: ' + taskLabel_(gId, null));
      return;
    }
    const pairBlockReason = taskDeletionPairBlockReason_(state, snap, rec);
    if (pairBlockReason) {
      markDeletionJournalBlocked_(journal, pairBlockReason);
      return;
    }
    clearDeletionJournalInventoryBlock_(journal);
    if (journal.phase === 'paused') {
      clearPendingTaskDeletion_(state, gId);
      if (snap.safety && snap.safety.allowDeletions) {
        // Re-enabling deletion starts confirmation from scratch; a paused
        // journal never inherits a previously ready candidate.
        clearDeletionTracking_(state, gId);
      }
      return;
    }
    if (!snap.safety.allowDeletions) {
      journal.phase = 'paused';
      clearPendingTaskDeletion_(state, gId);
      return;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_TASK_DELETE_RECOVERY_READ');
    const gTask = snap.gTasksById[gId] || null;
    const msTask = snap.msTasksById[rec.msId] || null;
    const currentMissingSide = missingSide_(gTask, msTask);
    if (currentMissingSide === 'both') {
      // The remote delete either succeeded before the final save failed, or both
      // sides were independently removed. In both cases no further API delete is safe.
      finalizeTaskDeletion_(state, snap, gId, rec, 'both');
      return;
    }
    if (!deletionScenarioMatches_(journal, rec, gId, currentMissingSide, snap)) {
      recordTaskDeletionConflict_(state, gId, rec, 'DELETE_SOURCE_SCENARIO_CHANGED');
      return;
    }
    const safety = deletionTargetIsSafe_(gId, rec, currentMissingSide, gTask, msTask, snap);
    if (!safety.ok) {
      recordTaskDeletionConflict_(state, gId, rec, safety.reason);
      return;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_TASK_DELETE_RECOVERY_REMOTE');
    remoteDeleteForMissingSide_(gId, rec, currentMissingSide);
    finalizeTaskDeletion_(state, snap, gId, rec, currentMissingSide);
  });
}

function applyConfirmedTaskDeletions_(state, snap, roundId, progress) {
  progress = progress || { durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} };
  progress.durableJournalTaskIds = progress.durableJournalTaskIds || {};
  progress.invalidatedCandidateTaskIds = progress.invalidatedCandidateTaskIds || {};
  progress.discardCandidateTaskIds = progress.discardCandidateTaskIds || {};
  ensureTaskDeletionState_(state);
  if (!hasCompleteTaskDeletionInventory_(snap)) return progress;
  Object.keys(state.deletionJournal).forEach(function(gId) {
    if (state.deletionJournal[gId] && state.deletionJournal[gId].phase === 'prepared') {
      progress.durableJournalTaskIds[gId] = true;
    }
  });
  recoverPreparedTaskDeletions_(state, snap);
  if (!snap.safety.allowDeletions) return progress;
  Object.keys(state.pendingTaskDeletions).forEach(function(gId) {
    const candidate = state.pendingTaskDeletions[gId];
    const rec = state.g2m[gId];
    if (!candidate || !rec) {
      return;
    }
    if (taskDeletionPairBlockReason_(state, snap, rec)) {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      clearPendingTaskDeletion_(state, gId);
      return;
    }
    if (candidate.lastRoundId !== roundId || Number(candidate.confirmations || 0) < 2 ||
        state.deletionJournal[gId]) {
      return;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_TASK_DELETE_REVALIDATION');
    const gTask = snap.gTasksById[gId] || null;
    const msTask = snap.msTasksById[rec.msId] || null;
    const currentMissingSide = missingSide_(gTask, msTask);
    if (!currentMissingSide || !deletionScenarioMatches_(candidate, rec, gId, currentMissingSide, snap)) {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      recordTaskDeletionConflict_(state, gId, rec, 'DELETE_SOURCE_SCENARIO_CHANGED');
      return;
    }
    const safety = deletionTargetIsSafe_(gId, rec, currentMissingSide, gTask, msTask, snap);
    if (!safety.ok) {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      recordTaskDeletionConflict_(state, gId, rec, safety.reason);
      return;
    }
    if (currentMissingSide === 'both') {
      finalizeTaskDeletion_(state, snap, gId, rec, currentMissingSide);
      return;
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_TASK_DELETE_JOURNAL_SAVE');
    state.deletionJournal[gId] = preparedDeletionJournal_(candidate);
    // This save is intentionally before the remote call. A crash after the call
    // leaves a durable journal that the next inventory can safely reconcile.
    saveDeletionJournalDurably_(state, progress);
    progress.durableJournalTaskIds[gId] = true;
    assertDestructiveTimeBudget_('TIME_BUDGET_TASK_DELETE_REMOTE');
    remoteDeleteForMissingSide_(gId, rec, currentMissingSide);
    finalizeTaskDeletion_(state, snap, gId, rec, currentMissingSide);
  });
  return progress;
}

function taskDeletionObservability_(state, safety) {
  ensureTaskDeletionState_(state);
  ensureTaskMoveState_(state);
  const orphanDeletionJournals = Object.keys(state.deletionJournal).filter(function(gId) {
    return !state.g2m[gId];
  }).length;
  const blockedDeletionJournals = Object.keys(state.deletionJournal).filter(function(gId) {
    return !!(state.deletionJournal[gId] && state.deletionJournal[gId].lastBlockedReason);
  }).length;
  return {
    deletionsEnabled: !!(safety && safety.allowDeletions),
    taskMovesEnabled: !!(safety && safety.allowTaskMoves),
    taskMovesAvailable: true,
    taskMovesEffective: !!(safety && safety.allowTaskMoves),
    taskMoveJournals: Object.keys(state.taskMoveJournal).length,
    pendingTaskDeletionCandidates: Object.keys(state.pendingTaskDeletions).length,
    deletionJournals: Object.keys(state.deletionJournal).length,
    orphanDeletionJournals: orphanDeletionJournals,
    blockedDeletionJournals: blockedDeletionJournals,
    taskDeletionConflicts: Object.keys(state.taskDeletionConflicts).length,
    googleTombstones: Object.keys(state.tombstones.g).length,
    microsoftTombstones: Object.keys(state.tombstones.m).length
  };
}

function boundedMoveReason_(reason) {
  const known = [
    'MOVE_VS_EDIT_CONFLICT', 'MOVE_SOURCE_SCENARIO_CHANGED',
    'MOVE_CREATE_RESULT_AMBIGUOUS', 'MOVE_GOOGLE_SOURCE_MISSING',
    'MOVE_DESTINATION_CREATE_FAILED', 'MOVE_DESTINATION_EDIT_CONFLICT',
    'MOVE_DESTINATION_UNAVAILABLE', 'MOVE_MICROSOFT_SAME_ID_LIST_CHANGED',
    'MOVE_LEGACY_CORRELATION_MISSING', 'MOVE_CORRELATION_AMBIGUOUS',
    'MOVE_EXTENSION_INVENTORY_INCOMPLETE', 'MOVE_SOURCE_CHANGED',
    'MOVE_OPERATION_INVENTORY_INCOMPLETE', 'MOVE_OPERATION_MAPPING_CHANGED',
    'MOVE_OPERATION_SOURCE_CHANGED', 'MOVE_OPERATION_GOOGLE_SOURCE_CHANGED',
    'MOVE_OPERATION_CANCEL_PRECONDITION_FAILED',
    'MOVE_OPERATION_DESTINATION_CANDIDATE_PRESENT',
    'MOVE_OPERATION_ALREADY_HAS_DESTINATION',
    'MOVE_OPERATION_CORRELATION_CANDIDATE_REQUIRED',
    'MOVE_OPERATION_CANDIDATE_CHANGED',
    'MOVE_OPERATION_LEGACY_CONFIRMATION_REQUIRED'
  ];
  return known.indexOf(reason) >= 0 ? reason : 'OTHER';
}

function taskMoveObservability_(state) {
  ensureTaskMoveState_(state);
  const phases = { creating: 0, retry_create: 0, created: 0 };
  const blockedReasons = {};
  let blockedJournals = 0;
  let legacyWithoutCorrelation = 0;
  let createdWithDestinationId = 0;
  let creatingWithoutDestinationId = 0;
  Object.keys(state.taskMoveJournal).forEach(function(gId) {
    const journal = state.taskMoveJournal[gId] || {};
    if (Object.prototype.hasOwnProperty.call(phases, journal.phase)) phases[journal.phase] += 1;
    if (!moveJournalHasCorrelation_(journal)) legacyWithoutCorrelation += 1;
    if (journal.phase === 'created' && journal.newMsId) createdWithDestinationId += 1;
    if ((journal.phase === 'creating' || journal.phase === 'retry_create') && !journal.newMsId) {
      creatingWithoutDestinationId += 1;
    }
    if (journal.lastBlockedReason) {
      blockedJournals += 1;
      const reason = boundedMoveReason_(journal.lastBlockedReason);
      blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
    }
  });
  return {
    journals: Object.keys(state.taskMoveJournal).length,
    phases: phases,
    blockedJournals: blockedJournals,
    blockedReasons: blockedReasons,
    legacyWithoutCorrelation: legacyWithoutCorrelation,
    createdWithDestinationId: createdWithDestinationId,
    creatingWithoutDestinationId: creatingWithoutDestinationId
  };
}

function googleMoveInventoryComplete_(state, snap, rec, currentGListId, targetMsListId) {
  return hasCompleteTaskDeletionInventory_(snap) && !!rec &&
    !!(snap.activeGListIds && snap.activeGListIds[currentGListId]) &&
    !!(snap.gTaskInventoryListIds && snap.gTaskInventoryListIds[currentGListId]) &&
    !!(snap.msTaskInventoryListIds && snap.msTaskInventoryListIds[targetMsListId]) &&
    !isGListFaulted_(state, rec.gListId) && !isMsListFaulted_(state, rec.msListId) &&
    !isGListFaulted_(state, currentGListId) && !isMsListFaulted_(state, targetMsListId) &&
    !isListPairReserved_(snap, rec.gListId, rec.msListId) &&
    !isListPairReserved_(snap, currentGListId, targetMsListId);
}

function ensureTaskMoveState_(state) {
  state.taskMoveJournal = state.taskMoveJournal || {};
}

function moveFingerprintFromGoogle_(task) {
  return JSON.stringify({
    title: task && task.title || '(Untitled)',
    notes: task && task.notes == null ? '' : String(task.notes),
    due: task && task.due ? String(task.due).slice(0, 10) : null,
    status: task && task.status === 'completed' ? 'completed' : 'needsAction'
  });
}

function moveFingerprintFromMicrosoft_(task) {
  return moveFingerprintFromGoogle_(googlePayloadFromMs_(task || {}));
}

// Journal fingerprints written by current versions are compact, standard
// Base64 SHA-256 digests. Existing journals may still carry the canonical raw
// JSON fingerprint; those remain readable for backward compatibility.

function moveFingerprintForJournal_(task) {
  return MOVE_FINGERPRINT_PREFIX + stateDigest_(moveFingerprintFromGoogle_(task || {}));
}

function validMoveFingerprint_(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.indexOf(MOVE_FINGERPRINT_PREFIX) === 0) {
    return /^sha256b64:[A-Za-z0-9+/]{43}=$/.test(value);
  }
  // Legacy fingerprints are canonical JSON strings in deployed state. Keep
  // accepting any non-empty legacy value here; exact matching below is what
  // prevents an arbitrary value from being treated as a match.
  return true;
}

function moveFingerprintMatches_(canonicalFingerprint, journalFingerprint) {
  if (!validMoveFingerprint_(journalFingerprint)) return false;
  if (journalFingerprint.indexOf(MOVE_FINGERPRINT_PREFIX) === 0) {
    return journalFingerprint === MOVE_FINGERPRINT_PREFIX + stateDigest_(canonicalFingerprint);
  }
  return journalFingerprint === canonicalFingerprint;
}

function moveJournalHasCorrelation_(journal) {
  return !!(journal && validMoveCorrelationId_(journal.correlationId));
}

function unresolvedMoveExtensionTargetListIds_(state) {
  const targetIds = {};
  Object.keys((state && state.taskMoveJournal) || {}).forEach(function(gId) {
    const journal = state.taskMoveJournal[gId];
    if (!journal || journal.newMsId || !moveJournalHasCorrelation_(journal)) return;
    if (journal.phase === 'creating' || journal.phase === 'retry_create') {
      targetIds[journal.targetMsListId] = true;
    }
  });
  return targetIds;
}

function moveExtensionOnTask_(task) {
  const extensions = task && task.extensions;
  if (!Array.isArray(extensions)) return [];
  return extensions.filter(function(extension) {
    return !!extension && MOVE_EXTENSION_IDS.indexOf(extension.id) >= 0 &&
      extension.extensionName === MOVE_EXTENSION_NAME &&
      validMoveCorrelationId_(extension.correlationId);
  });
}

function moveCorrelationCandidates_(state, snap, journal) {
  if (!moveJournalHasCorrelation_(journal)) return [];
  return Object.keys(snap.msTasksById || {}).filter(function(msId) {
    const task = snap.msTasksById[msId];
    if (!task || snap.msListByTask[msId] !== journal.targetMsListId) return false;
    if (state.m2g[msId]) return false;
    return moveExtensionOnTask_(task).some(function(extension) {
      return extension.correlationId === journal.correlationId;
    });
  }).map(function(msId) { return snap.msTasksById[msId]; });
}

function legacyMoveJournalCandidates_(state, snap, journal) {
  const preparedAt = validTimestampMs_(journal.preparedAt);
  return Object.keys(snap.msTasksById || {}).filter(function(msId) {
    const task = snap.msTasksById[msId];
    if (!task || snap.msListByTask[msId] !== journal.targetMsListId) return false;
    if (state.m2g[msId]) return false;
    if (!moveFingerprintMatches_(moveFingerprintFromMicrosoft_(task), journal.fingerprint)) return false;
    const createdAt = validTimestampMs_(task.createdDateTime);
    return preparedAt !== null && createdAt !== null &&
      createdAt >= preparedAt - 60000 &&
      createdAt <= preparedAt + MOVE_CREATE_RECOVERY_WINDOW_MS;
  }).map(function(msId) { return snap.msTasksById[msId]; });
}

function moveExtensionInventoryComplete_(snap, journal) {
  return !!(snap && snap.moveExtensionInventoryListIds &&
    snap.moveExtensionInventoryListIds[journal.targetMsListId]);
}

function moveDestinationPayload_(gTask, journal) {
  const payload = msPayloadFromGoogle_(gTask, 'create');
  payload.extensions = [{
    '@odata.type': 'microsoft.graph.openTypeExtension',
    extensionName: MOVE_EXTENSION_NAME,
    correlationId: journal.correlationId
  }];
  return payload;
}

function blockTaskMove_(state, gId, rec, journal, reason) {
  if (journal) {
    journal.lastBlockedReason = reason;
    journal.lastBlockedAt = new Date().toISOString();
  }
  recordTaskDeletionConflict_(state, gId, rec, reason);
  console.warn('[MoveConflict] ' + reason + ': ' + taskLabel_(gId, null));
  return false;
}

function msTaskMatchesMoveBaseline_(task, journal) {
  if (!task) return true;
  const observed = validTimestampMs_(task.lastModifiedDateTime);
  const baseline = validTimestampMs_(journal.oldMsUpdated);
  return observed !== null && baseline !== null && observed === baseline;
}

function msTaskChangedSinceMapping_(task, mappedTimestamp) {
  if (!task) return false;
  const observed = validTimestampMs_(task.lastModifiedDateTime);
  const mapped = validTimestampMs_(mappedTimestamp);
  return observed === null || mapped === null || observed > mapped;
}

function resyncGoogleTaskMove_(state, snap, gId, gTask, rec, currentGListId,
    targetMsListId, progress, roundId) {
  ensureTaskMoveState_(state);
  if (!snap.safety || !snap.safety.allowTaskMoves) {
    console.warn('[MoveBlocked] Google task moved across lists; SYNC_ALLOW_TASK_MOVES=false: ' +
      taskLabel_(gId, gTask.title));
    return false;
  }
  if (state.deletionJournal[gId]) {
    console.warn('[MoveBlocked] Google task moved across lists; DELETE_JOURNAL_PENDING: ' +
      taskLabel_(gId, gTask.title));
    return false;
  }
  if (!googleMoveInventoryComplete_(state, snap, rec, currentGListId, targetMsListId)) {
    console.warn('[MoveBlocked] Google task moved across lists; MOVE_INVENTORY_INCOMPLETE: ' +
      taskLabel_(gId, gTask.title));
    return false;
  }

  let journal = state.taskMoveJournal[gId] || null;
  const oldMsTask = snap.msTasksById[rec.msId] || null;
  if (oldMsTask && snap.msListByTask[rec.msId] !== rec.msListId) {
    console.warn('[MoveBlocked] Google task moved across lists; MOVE_SOURCE_CHANGED: ' +
      taskLabel_(gId, gTask.title));
    return false;
  }

  const fingerprint = moveFingerprintFromGoogle_(gTask);
  let newJournal = false;
  if (!journal) {
    if (msTaskChangedSinceMapping_(oldMsTask, rec.msUpdated)) {
      return blockTaskMove_(state, gId, rec, null, 'MOVE_VS_EDIT_CONFLICT');
    }
    assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_SOURCE_READ');
    const freshBeforeCreate = oldMsTask ? getMsTask_(rec.msListId, rec.msId) : null;
    if (msTaskChangedSinceMapping_(freshBeforeCreate, rec.msUpdated)) {
      return blockTaskMove_(state, gId, rec, null, 'MOVE_VS_EDIT_CONFLICT');
    }
    journal = {
      phase: 'creating',
      gId: gId,
      oldMsId: rec.msId,
      newMsId: null,
      gListId: currentGListId,
      oldMsListId: rec.msListId,
      targetMsListId: targetMsListId,
      gUpdated: gTask.updated || null,
      oldMsUpdated: freshBeforeCreate && freshBeforeCreate.lastModifiedDateTime || rec.msUpdated || null,
      preparedAt: new Date().toISOString(),
      fingerprint: moveFingerprintForJournal_(gTask),
      correlationId: newMoveCorrelationId_(),
      uncertainConfirmations: 0,
      lastRoundId: roundId || null
    };
    assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_JOURNAL_SAVE');
    state.taskMoveJournal[gId] = journal;
    persistSyncState_(state);
    newJournal = true;
  } else if (journal.oldMsId !== rec.msId || journal.oldMsListId !== rec.msListId ||
      journal.gListId !== currentGListId || journal.targetMsListId !== targetMsListId ||
      !moveFingerprintMatches_(fingerprint, journal.fingerprint)) {
    return blockTaskMove_(state, gId, rec, journal, 'MOVE_SOURCE_SCENARIO_CHANGED');
  }

  let movedMsTask = journal.newMsId
    ? (snap.msTasksById[journal.newMsId] || getMsTask_(journal.targetMsListId, journal.newMsId))
    : null;
  if (!movedMsTask && journal.newMsId) {
    // A known created destination must never be silently converted back into a
    // new create.  Its identity may have been deleted or become unavailable;
    // preserve the source and leave an explicit operator-visible journal.
    return blockTaskMove_(state, gId, rec, journal, 'MOVE_DESTINATION_UNAVAILABLE');
  }
  if (!movedMsTask && !journal.newMsId && !newJournal) {
    if (!moveJournalHasCorrelation_(journal)) {
      return blockTaskMove_(state, gId, rec, journal, 'MOVE_LEGACY_CORRELATION_MISSING');
    }
    // Without the $expand response this round cannot distinguish a prior
    // create from a manually-created lookalike.  Do not adopt, retry, or
    // delete when the extension inventory is incomplete.
    if (!moveExtensionInventoryComplete_(snap, journal)) {
      return blockTaskMove_(state, gId, rec, journal, 'MOVE_EXTENSION_INVENTORY_INCOMPLETE');
    }
    const correlationCandidates = moveCorrelationCandidates_(state, snap, journal);
    if (correlationCandidates.length > 1) {
      return blockTaskMove_(state, gId, rec, journal, 'MOVE_CORRELATION_AMBIGUOUS');
    }
    if (correlationCandidates.length === 1) {
      if (!moveFingerprintMatches_(moveFingerprintFromMicrosoft_(correlationCandidates[0]), journal.fingerprint)) {
        return blockTaskMove_(state, gId, rec, journal, 'MOVE_DESTINATION_EDIT_CONFLICT');
      }
      movedMsTask = correlationCandidates[0];
    }
  }
  if (movedMsTask && !journal.newMsId) {
    journal.newMsId = movedMsTask.id;
    journal.phase = 'created';
    delete journal.lastBlockedReason;
    delete journal.lastBlockedAt;
    persistSyncState_(state);
  }
  if (!movedMsTask && !newJournal && journal.phase === 'creating') {
    if (journal.lastRoundId !== roundId) {
      journal.uncertainConfirmations = Number(journal.uncertainConfirmations || 0) + 1;
      journal.lastRoundId = roundId;
      persistSyncState_(state);
    }
    if (Number(journal.uncertainConfirmations || 0) < 2) {
      console.warn('[MoveRecovery] Creation result is not yet confirmed; check again next round: ' + taskLabel_(gId, gTask.title));
      return false;
    }
    journal.phase = 'retry_create';
    persistSyncState_(state);
  }
  if (!movedMsTask) {
    // This can be the initial create or a retry after two uncertain inventory
    // rounds. Revalidate the old source every time; it may have been edited
    // while recovery was waiting.
    assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_CREATE_SOURCE_READ');
    const freshBeforeDestinationCreate = getMsTask_(journal.oldMsListId, journal.oldMsId);
    if (freshBeforeDestinationCreate &&
        !msTaskMatchesMoveBaseline_(freshBeforeDestinationCreate, journal)) {
      return blockTaskMove_(state, gId, rec, journal, 'MOVE_VS_EDIT_CONFLICT');
    }
    // A retried POST is only safe after the complete target extension
    // inventory above found no exact correlation marker.  Initial creates are
    // safe after the durable journal checkpoint because this execution has not
    // attempted a destination POST yet.
    if (!newJournal && !moveExtensionInventoryComplete_(snap, journal)) {
      return blockTaskMove_(state, gId, rec, journal, 'MOVE_EXTENSION_INVENTORY_INCOMPLETE');
    }
    try {
      journal.phase = 'creating';
      journal.lastRoundId = roundId || journal.lastRoundId || null;
      assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_CREATE_JOURNAL_SAVE');
      persistSyncState_(state);
      assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_CREATE_REMOTE');
      movedMsTask = createMsTask_(
        journal.targetMsListId,
        moveDestinationPayload_(gTask, journal)
      );
    } catch (e) {
      if (String(e && e.message || e).indexOf('TIME_BUDGET_') === 0) throw e;
      // A client-side error does not prove the remote create failed. Keep the
      // result uncertain so two later complete inventories must miss it before
      // another create attempt is allowed.
      journal.phase = 'creating';
      journal.uncertainConfirmations = 0;
      journal.lastRoundId = roundId || journal.lastRoundId || null;
      journal.lastBlockedReason = 'MOVE_DESTINATION_CREATE_FAILED';
      journal.lastBlockedAt = new Date().toISOString();
      persistSyncState_(state);
      throw e;
    }
    journal.newMsId = movedMsTask.id;
    journal.phase = 'created';
    journal.uncertainConfirmations = 0;
    delete journal.lastBlockedReason;
    delete journal.lastBlockedAt;
    snap.msTasksById[movedMsTask.id] = movedMsTask;
    snap.msListByTask[movedMsTask.id] = journal.targetMsListId;
    persistSyncState_(state);
  }

  // Re-read the destination before source deletion. A stale snapshot, a
  // temporarily invisible create, or a concurrent destination edit must leave
  // the old task intact instead of silently accepting divergent content.
  assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_DESTINATION_READ');
  const freshDestination = getMsTask_(journal.targetMsListId, journal.newMsId);
  if (!freshDestination) {
    return blockTaskMove_(state, gId, rec, journal, 'MOVE_DESTINATION_UNAVAILABLE');
  }
  if (!moveFingerprintMatches_(moveFingerprintFromMicrosoft_(freshDestination), journal.fingerprint)) {
    return blockTaskMove_(state, gId, rec, journal, 'MOVE_DESTINATION_EDIT_CONFLICT');
  }
  movedMsTask = freshDestination;
  snap.msTasksById[movedMsTask.id] = movedMsTask;
  snap.msListByTask[movedMsTask.id] = journal.targetMsListId;

  assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_DELETE_SOURCE_READ');
  const freshOld = getMsTask_(journal.oldMsListId, journal.oldMsId);
  if (freshOld && !msTaskMatchesMoveBaseline_(freshOld, journal)) {
    return blockTaskMove_(state, gId, rec, journal, 'MOVE_VS_EDIT_CONFLICT');
  }
  if (freshOld) {
    try {
      assertDestructiveTimeBudget_('TIME_BUDGET_MOVE_DELETE_REMOTE');
      deleteMsTask_(journal.oldMsListId, journal.oldMsId);
    } catch (e) {
      if (!isNotFoundError_(e)) throw e;
    }
  }

  markTaskDeletionCandidateInvalidated_(progress, gId);
  clearDeletionTracking_(state, gId);
  clearTaskDeletionConflict_(state, gId);
  state.tombstones.m[journal.oldMsId] = { at: Date.now(), source: 'move' };
  putMapping_(state, gTask, currentGListId, movedMsTask, journal.targetMsListId);
  delete state.taskMoveJournal[gId];

  delete snap.msTasksById[journal.oldMsId];
  delete snap.msListByTask[journal.oldMsId];
  snap.msTasksById[movedMsTask.id] = movedMsTask;
  snap.msListByTask[movedMsTask.id] = journal.targetMsListId;
  console.log('[Move] Google → Microsoft resync: ' + taskLabel_(gId, gTask.title));
  return true;
}

function cloneTaskDeletionValue_(value) {
  return JSON.parse(JSON.stringify(value));
}

function captureTaskDeletionState_(state) {
  return {
    g2m: cloneTaskDeletionValue_(state.g2m),
    m2g: cloneTaskDeletionValue_(state.m2g),
    tombstones: cloneTaskDeletionValue_(state.tombstones),
    pendingTaskDeletions: cloneTaskDeletionValue_(state.pendingTaskDeletions),
    deletionJournal: cloneTaskDeletionValue_(state.deletionJournal),
    taskDeletionConflicts: cloneTaskDeletionValue_(state.taskDeletionConflicts)
  };
}

function restoreTaskDeletionState_(state, saved) {
  if (!saved) return;
  state.g2m = cloneTaskDeletionValue_(saved.g2m);
  state.m2g = cloneTaskDeletionValue_(saved.m2g);
  state.tombstones = cloneTaskDeletionValue_(saved.tombstones);
  state.pendingTaskDeletions = cloneTaskDeletionValue_(saved.pendingTaskDeletions);
  state.deletionJournal = cloneTaskDeletionValue_(saved.deletionJournal);
  state.taskDeletionConflicts = cloneTaskDeletionValue_(saved.taskDeletionConflicts);
}

function restoreTaskDeletionRecord_(state, saved, pendingBeforeRound, gId) {
  const current = state.g2m[gId] || null;
  const previous = saved.g2m[gId] || null;
  const msIds = {};
  [current, previous, state.pendingTaskDeletions[gId], saved.pendingTaskDeletions[gId],
    state.deletionJournal[gId], saved.deletionJournal[gId]].forEach(function(record) {
    if (record && record.msId) msIds[record.msId] = true;
  });
  if (current) delete state.m2g[current.msId];
  if (previous) {
    state.g2m[gId] = cloneTaskDeletionValue_(previous);
    state.m2g[previous.msId] = gId;
  } else {
    delete state.g2m[gId];
  }
  if (saved.tombstones.g[gId]) {
    state.tombstones.g[gId] = cloneTaskDeletionValue_(saved.tombstones.g[gId]);
  } else {
    delete state.tombstones.g[gId];
  }
  Object.keys(msIds).forEach(function(msId) {
    if (saved.tombstones.m[msId]) {
      state.tombstones.m[msId] = cloneTaskDeletionValue_(saved.tombstones.m[msId]);
    } else {
      delete state.tombstones.m[msId];
    }
  });
  const pending = pendingBeforeRound[gId];
  if (pending) {
    state.pendingTaskDeletions[gId] = cloneTaskDeletionValue_(pending);
  } else {
    delete state.pendingTaskDeletions[gId];
  }
  if (saved.deletionJournal[gId]) {
    state.deletionJournal[gId] = cloneTaskDeletionValue_(saved.deletionJournal[gId]);
  } else {
    delete state.deletionJournal[gId];
  }
  if (saved.taskDeletionConflicts[gId]) {
    state.taskDeletionConflicts[gId] = cloneTaskDeletionValue_(saved.taskDeletionConflicts[gId]);
  } else {
    delete state.taskDeletionConflicts[gId];
  }
}

function rollbackUndurableTaskDeletionChanges_(state, saved, pendingBeforeRound, durableJournalTaskIds, invalidatedCandidateTaskIds, discardCandidateTaskIds, deletionsEnabled) {
  invalidatedCandidateTaskIds = invalidatedCandidateTaskIds || {};
  discardCandidateTaskIds = discardCandidateTaskIds || {};
  if (!saved) {
    state.pendingTaskDeletions = deletionsEnabled
      ? cloneTaskDeletionValue_(pendingBeforeRound)
      : {};
    Object.keys(invalidatedCandidateTaskIds).forEach(function(gId) {
      delete state.pendingTaskDeletions[gId];
    });
    Object.keys(discardCandidateTaskIds).forEach(function(gId) {
      delete state.pendingTaskDeletions[gId];
    });
    return;
  }
  const affected = {};
  ['g2m', 'pendingTaskDeletions', 'deletionJournal', 'taskDeletionConflicts'].forEach(function(field) {
    Object.keys(saved[field]).forEach(function(gId) { affected[gId] = true; });
    Object.keys(state[field]).forEach(function(gId) { affected[gId] = true; });
  });
  Object.keys(pendingBeforeRound).forEach(function(gId) { affected[gId] = true; });
  Object.keys(affected).forEach(function(gId) {
    if (durableJournalTaskIds[gId] || invalidatedCandidateTaskIds[gId]) return;
    restoreTaskDeletionRecord_(state, saved, pendingBeforeRound, gId);
  });
  Object.keys(discardCandidateTaskIds).forEach(function(gId) {
    delete state.pendingTaskDeletions[gId];
  });
  if (!deletionsEnabled) state.pendingTaskDeletions = {};
}

function isGListFaulted_(state, gListId) {
  return !!(state.listFaults && state.listFaults.g && state.listFaults.g[gListId]);
}

function isMsListFaulted_(state, msListId) {
  return !!(state.listFaults && state.listFaults.ms && state.listFaults.ms[msListId]);
}

function markListFault_(state, side, id, info) {
  if (!id) return;
  if (info) {
    if (info.gListTitle) info.gListTitle = truncateLabel_(info.gListTitle, 80);
    if (info.msListTitle) info.msListTitle = truncateLabel_(info.msListTitle, 80);
  }
  state.listFaults[side][id] = Object.assign({ at: new Date().toISOString() }, info || {});
}

function alertListFaultsIfAny_(state) {
  const count = Object.keys(state.listFaults.g).length + Object.keys(state.listFaults.ms).length;
  if (!count) return;
  sendListFaultAlert_(count + ' lists are currently isolated. syncAll will skip them and will not delete tasks.');
}

function taskMoveJournalRef_(gId) {
  return previewOpaqueId_('moveJournal', gId);
}

function taskMoveJournalRevision_(state, gId, journal, rec) {
  return previewOpaqueId_('moveRevision', JSON.stringify({
    gId: gId,
    journal: journal,
    mapping: rec || null,
    reverseMapping: rec && state.m2g[rec.msId] || null,
    listTarget: journal && state.listMap[journal.gListId] || null
  }));
}

function taskMoveJournalEntries_(state) {
  ensureTaskMoveState_(state);
  return Object.keys(state.taskMoveJournal).map(function(gId) {
    const journal = state.taskMoveJournal[gId];
    const rec = state.g2m[gId] || null;
    return {
      gId: gId,
      journal: journal,
      rec: rec,
      journalRef: taskMoveJournalRef_(gId),
      revision: taskMoveJournalRevision_(state, gId, journal, rec)
    };
  }).sort(function(left, right) {
    return left.journalRef < right.journalRef ? -1 : left.journalRef > right.journalRef ? 1 : 0;
  });
}

function resolveTaskMoveJournalRef_(state, journalRef) {
  const matches = taskMoveJournalEntries_(state).filter(function(entry) {
    return entry.journalRef === journalRef;
  });
  if (matches.length !== 1) {
    throw new Error(matches.length > 1
      ? 'MOVE_OPERATION_JOURNAL_REF_COLLISION: journalRef is not unique; selection refused.'
      : 'MOVE_OPERATION_JOURNAL_NOT_FOUND: journalRef not found.');
  }
  return matches[0];
}

function taskMoveJournalPublic_(entry) {
  const journal = entry.journal || {};
  return {
    journalRef: entry.journalRef,
    revision: entry.revision,
    phase: journal.phase || 'unknown',
    preparedAt: journal.preparedAt || null,
    lastBlockedAt: journal.lastBlockedAt || null,
    blockedReason: journal.lastBlockedReason ? boundedMoveReason_(journal.lastBlockedReason) : null,
    evidence: {
      correlationMarker: moveJournalHasCorrelation_(journal) ? 'PRESENT' : 'LEGACY_MISSING',
      destinationRecorded: !!journal.newMsId,
      mappingIntact: !!(entry.rec && entry.rec.msId === journal.oldMsId &&
        entry.rec.msListId === journal.oldMsListId)
    },
    actions: ['resume', 'cancel', 'reconcile']
  };
}

function parseTaskMoveOperation_(requirePreviewToken) {
  const raw = PropertiesService.getScriptProperties().getProperty(TASK_MOVE_OPERATION_PROPERTY);
  if (!raw) throw new Error('MOVE_OPERATION_MISSING: Set SYNC_TASK_MOVE_OPERATION_JSON.');
  let operation;
  try {
    operation = JSON.parse(raw);
  } catch (e) {
    throw new Error('MOVE_OPERATION_INVALID_JSON: SYNC_TASK_MOVE_OPERATION_JSON is not valid JSON.');
  }
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('MOVE_OPERATION_INVALID: Operation must be a JSON object.');
  }
  const allowed = ['action', 'journalRef', 'revision', 'candidateRef', 'previewToken', 'confirmation'];
  Object.keys(operation).forEach(function(key) {
    if (allowed.indexOf(key) < 0) throw new Error('MOVE_OPERATION_INVALID: Unknown field is not accepted: ' + key + '.');
  });
  if (['resume', 'cancel', 'reconcile'].indexOf(operation.action) < 0 ||
      typeof operation.journalRef !== 'string' || !operation.journalRef ||
      typeof operation.revision !== 'string' || !operation.revision) {
    throw new Error('MOVE_OPERATION_INVALID: action, journalRef, and revision must be valid.');
  }
  ['candidateRef', 'previewToken', 'confirmation'].forEach(function(field) {
    if (operation[field] !== undefined && (typeof operation[field] !== 'string' || !operation[field])) {
      throw new Error('MOVE_OPERATION_INVALID: ' + field + ' must be a non-empty string when provided.');
    }
  });
  if (requirePreviewToken && (typeof operation.previewToken !== 'string' || !operation.previewToken)) {
    throw new Error('MOVE_OPERATION_PREVIEW_TOKEN_REQUIRED: Preview first, then write previewToken back to the operation JSON.');
  }
  return operation;
}

function uniqueIds_(values) {
  const found = {};
  (values || []).forEach(function(value) {
    if (typeof value === 'string' && value) found[value] = true;
  });
  return Object.keys(found);
}

function taskMoveOperationLiveEvidence_(state, entry) {
  const journal = entry.journal;
  const rec = entry.rec;
  const gLocations = {};
  let inventoryComplete = true;
  try {
    uniqueIds_([journal.gListId, rec && rec.gListId]).forEach(function(gListId) {
      const tasks = getGTasks_(gListId);
      tasks.forEach(function(task) {
        if (task && task.id === journal.gId) gLocations[gListId] = task;
      });
    });
    const targetTasks = getMsTasks_(journal.targetMsListId, { includeMoveExtension: true });
    const oldMsTask = getMsTask_(journal.oldMsListId, journal.oldMsId);
    const correlationCandidates = moveCorrelationCandidates_(state, {
      msTasksById: targetTasks.reduce(function(result, task) {
        result[task.id] = task;
        return result;
      }, {}),
      msListByTask: targetTasks.reduce(function(result, task) {
        result[task.id] = journal.targetMsListId;
        return result;
      }, {})
    }, journal).sort(function(left, right) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const legacyCandidates = legacyMoveJournalCandidates_(state, {
      msTasksById: targetTasks.reduce(function(result, task) {
        result[task.id] = task;
        return result;
      }, {}),
      msListByTask: targetTasks.reduce(function(result, task) {
        result[task.id] = journal.targetMsListId;
        return result;
      }, {})
    }, journal).sort(function(left, right) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const expectedGoogleTask = gLocations[journal.gListId] || null;
    const originalGoogleTask = rec && gLocations[rec.gListId] || null;
    const mappingIntact = !!(rec && rec.msId === journal.oldMsId &&
      rec.msListId === journal.oldMsListId && state.m2g[rec.msId] === journal.gId &&
      state.listMap[journal.gListId] === journal.targetMsListId &&
      !isGListFaulted_(state, journal.gListId) && !isGListFaulted_(state, rec.gListId) &&
      !isMsListFaulted_(state, journal.oldMsListId) && !isMsListFaulted_(state, journal.targetMsListId));
    return {
      inventoryComplete: inventoryComplete,
      mappingIntact: mappingIntact,
      expectedGoogleTask: expectedGoogleTask,
      originalGoogleTask: originalGoogleTask,
      oldMsTask: oldMsTask,
      targetTasks: targetTasks,
      correlationCandidates: correlationCandidates,
      legacyCandidates: legacyCandidates,
      destinationTask: journal.newMsId ? targetTasks.find(function(task) {
        return task.id === journal.newMsId;
      }) || null : null
    };
  } catch (e) {
    // Do not relay provider text, list IDs, or task contents through an
    // operator report.  An unsuccessful live read is simply incomplete proof.
    inventoryComplete = false;
    return {
      inventoryComplete: inventoryComplete,
      mappingIntact: false,
      expectedGoogleTask: null,
      originalGoogleTask: null,
      oldMsTask: null,
      targetTasks: [],
      correlationCandidates: [],
      legacyCandidates: [],
      destinationTask: null
    };
  }
}

function taskMoveOperationIntent_(operation) {
  return {
    action: operation.action,
    journalRef: operation.journalRef,
    revision: operation.revision,
    candidateRef: operation.candidateRef || null,
    confirmation: operation.confirmation || null
  };
}

function taskMoveOperationEvidenceDigest_(operation, entry, evidence) {
  const journal = entry.journal;
  return previewOpaqueId_('moveOperation', JSON.stringify({
    operation: taskMoveOperationIntent_(operation),
    journalRef: entry.journalRef,
    revision: entry.revision,
    inventoryComplete: evidence.inventoryComplete,
    mappingIntact: evidence.mappingIntact,
    expectedGoogle: evidence.expectedGoogleTask && {
      id: evidence.expectedGoogleTask.id,
      updated: evidence.expectedGoogleTask.updated || null,
      fingerprint: moveFingerprintFromGoogle_(evidence.expectedGoogleTask)
    },
    originalGoogle: evidence.originalGoogleTask && {
      id: evidence.originalGoogleTask.id,
      updated: evidence.originalGoogleTask.updated || null,
      fingerprint: moveFingerprintFromGoogle_(evidence.originalGoogleTask)
    },
    oldMicrosoft: evidence.oldMsTask && {
      id: evidence.oldMsTask.id,
      updated: evidence.oldMsTask.lastModifiedDateTime || null
    },
    destination: evidence.destinationTask && {
      id: evidence.destinationTask.id,
      fingerprint: moveFingerprintFromMicrosoft_(evidence.destinationTask)
    },
    correlationCandidates: evidence.correlationCandidates.map(function(task) {
      return { id: task.id, fingerprint: moveFingerprintFromMicrosoft_(task) };
    }),
    legacyCandidates: evidence.legacyCandidates.map(function(task) { return task.id; })
  }));
}

function taskMoveOperationCandidateRef_(task) {
  return previewOpaqueId_('moveCandidate', task && task.id);
}

function resolveTaskMoveOperationCandidate_(tasks, candidateRef) {
  const matches = (tasks || []).filter(function(task) {
    return taskMoveOperationCandidateRef_(task) === candidateRef;
  });
  if (matches.length !== 1) {
    throw new Error(matches.length > 1
      ? 'MOVE_OPERATION_CANDIDATE_REF_COLLISION: candidateRef is not unique; selection refused.'
      : 'MOVE_OPERATION_CANDIDATE_NOT_FOUND: candidateRef not found.');
  }
  return matches[0];
}

function taskMoveOperationBaseFailure_(entry, evidence) {
  const journal = entry.journal;
  if (!evidence.inventoryComplete) return 'MOVE_OPERATION_INVENTORY_INCOMPLETE';
  if (!evidence.mappingIntact) return 'MOVE_OPERATION_MAPPING_CHANGED';
  if (!evidence.oldMsTask || !msTaskMatchesMoveBaseline_(evidence.oldMsTask, journal)) {
    return 'MOVE_OPERATION_SOURCE_CHANGED';
  }
  return null;
}

function taskMoveOperationPlan_(operation, entry, evidence) {
  const journal = entry.journal;
  const failure = taskMoveOperationBaseFailure_(entry, evidence);
  if (failure) return { ok: false, code: failure };
  const expected = evidence.expectedGoogleTask;
  const expectedMatches = !!expected && moveFingerprintMatches_(moveFingerprintFromGoogle_(expected), journal.fingerprint) &&
    (expected.updated || null) === (journal.gUpdated || null);
  const correlationCandidates = evidence.correlationCandidates || [];
  const mismatchedCorrelationCandidate = correlationCandidates.length === 1 &&
    !moveFingerprintMatches_(moveFingerprintFromMicrosoft_(correlationCandidates[0]), journal.fingerprint);
  if (operation.action === 'resume') {
    if (!expectedMatches) return { ok: false, code: 'MOVE_OPERATION_GOOGLE_SOURCE_CHANGED' };
    if (correlationCandidates.length > 1) return { ok: false, code: 'MOVE_CORRELATION_AMBIGUOUS' };
    if (mismatchedCorrelationCandidate) return { ok: false, code: 'MOVE_DESTINATION_EDIT_CONFLICT' };
    if (journal.newMsId && (!evidence.destinationTask ||
        !moveFingerprintMatches_(moveFingerprintFromMicrosoft_(evidence.destinationTask), journal.fingerprint))) {
      return { ok: false, code: 'MOVE_DESTINATION_EDIT_CONFLICT' };
    }
    return { ok: true, effect: 'RESUME_JOURNAL_ONLY', candidate: null };
  }
  if (operation.action === 'cancel') {
    const original = evidence.originalGoogleTask;
    const returnedToOriginal = !!original && !expected &&
      moveFingerprintMatches_(moveFingerprintFromGoogle_(original), journal.fingerprint);
    if (!returnedToOriginal || journal.newMsId) {
      return { ok: false, code: 'MOVE_OPERATION_CANCEL_PRECONDITION_FAILED' };
    }
    if (correlationCandidates.length || evidence.legacyCandidates.length) {
      return { ok: false, code: 'MOVE_OPERATION_DESTINATION_CANDIDATE_PRESENT' };
    }
    return { ok: true, effect: 'CANCEL_JOURNAL_ONLY', candidate: null };
  }
  if (!expectedMatches) return { ok: false, code: 'MOVE_OPERATION_GOOGLE_SOURCE_CHANGED' };
  if (journal.newMsId) return { ok: false, code: 'MOVE_OPERATION_ALREADY_HAS_DESTINATION' };
  if (moveJournalHasCorrelation_(journal)) {
    if (correlationCandidates.length !== 1) {
      return { ok: false, code: correlationCandidates.length > 1
        ? 'MOVE_CORRELATION_AMBIGUOUS' : 'MOVE_OPERATION_CORRELATION_CANDIDATE_REQUIRED' };
    }
    const candidate = correlationCandidates[0];
    if (!moveFingerprintMatches_(moveFingerprintFromMicrosoft_(candidate), journal.fingerprint)) {
      return { ok: false, code: 'MOVE_DESTINATION_EDIT_CONFLICT' };
    }
    if (operation.candidateRef && taskMoveOperationCandidateRef_(candidate) !== operation.candidateRef) {
      return { ok: false, code: 'MOVE_OPERATION_CANDIDATE_CHANGED' };
    }
    return { ok: true, effect: 'ADOPT_DESTINATION_JOURNAL_ONLY', candidate: candidate };
  }
  if (operation.confirmation !== 'ADOPT_EXACT_DESTINATION' || !operation.candidateRef) {
    return { ok: false, code: 'MOVE_OPERATION_LEGACY_CONFIRMATION_REQUIRED' };
  }
  let candidate;
  try {
    candidate = resolveTaskMoveOperationCandidate_(evidence.legacyCandidates, operation.candidateRef);
  } catch (e) {
    return { ok: false, code: 'MOVE_OPERATION_CANDIDATE_CHANGED' };
  }
  if (!moveFingerprintMatches_(moveFingerprintFromMicrosoft_(candidate), journal.fingerprint)) {
    return { ok: false, code: 'MOVE_DESTINATION_EDIT_CONFLICT' };
  }
  return { ok: true, effect: 'ADOPT_LEGACY_DESTINATION_JOURNAL_ONLY', candidate: candidate };
}

function taskMoveOperationPublicResult_(operation, entry, evidence, plan, previewToken) {
  return {
    action: operation.action,
    journal: taskMoveJournalPublic_(entry),
    ok: !!plan.ok,
    code: plan.ok ? 'READY' : boundedMoveReason_(plan.code),
    effect: plan.ok ? plan.effect : 'NO_CHANGE',
    candidateRef: plan.ok && plan.candidate ? taskMoveOperationCandidateRef_(plan.candidate) : null,
    evidence: {
      inventoryComplete: !!evidence.inventoryComplete,
      mappingIntact: !!evidence.mappingIntact,
      correlationCandidateCount: (evidence.correlationCandidates || []).length,
      legacyWindowCandidateCount: (evidence.legacyCandidates || []).length,
      candidateRefs: (moveJournalHasCorrelation_(entry.journal)
        ? evidence.correlationCandidates : evidence.legacyCandidates
      ).map(taskMoveOperationCandidateRef_).sort()
    },
    previewToken: previewToken,
    note: 'apply rereads live evidence; this preview does not change the provider or sync state.'
  };
}

function saveTaskMoveOperationReceipt_(operation, entry, state) {
  const receipt = {
    schema: 1,
    recordedAt: new Date().toISOString(),
    action: operation.action,
    journalRef: entry.journalRef,
    journalBefore: cloneTaskDeletionValue_(entry.journal),
    conflictBefore: cloneTaskDeletionValue_(state.taskDeletionConflicts[entry.gId] || null),
    mappingBefore: cloneTaskDeletionValue_(state.g2m[entry.gId] || null),
    reverseMappingBefore: state.m2g[entry.journal.oldMsId] || null
  };
  const props = PropertiesService.getUserProperties();
  const serialized = JSON.stringify(receipt);
  try {
    props.setProperty(TASK_MOVE_OPERATION_RECEIPT_KEY, serialized);
    if (props.getProperty(TASK_MOVE_OPERATION_RECEIPT_KEY) !== serialized) {
      throw new Error('receipt read-back mismatch');
    }
  } catch (e) {
    throw new Error('MOVE_OPERATION_RECEIPT_SAVE_FAILED: Could not save private before-image; no journal was changed.');
  }
}
