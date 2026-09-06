function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  const config = {
    clientId: p.getProperty('MS_CLIENT_ID'),
    clientSecret: p.getProperty('MS_CLIENT_SECRET'),
    tenantId: p.getProperty('MS_TENANT_ID') || 'common',
    alertEmail: p.getProperty('ALERT_EMAIL') || ''
  };
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'Microsoft Client ID/Secret is not configured. Set ' +
      'MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_TENANT_ID in Project Settings → Script Properties. ' +
      'ALERT_EMAIL is optional.'
    );
  }
  return config;
}

function getSafetyConfig_() {
  const p = PropertiesService.getScriptProperties();
  const listIds = String(p.getProperty('SYNC_GOOGLE_LIST_IDS') || '')
    .split(/[\s,]+/)
    .map(function(id) { return id.trim(); })
    .filter(Boolean);
  const allowDeletionsRaw = String(p.getProperty('SYNC_ALLOW_DELETIONS') || '').trim().toLowerCase();
  const allowListDeletionsRaw = String(
    p.getProperty('SYNC_ALLOW_LIST_DELETIONS') || ''
  ).trim().toLowerCase();
  const allowTaskMovesRaw = String(p.getProperty('SYNC_ALLOW_TASK_MOVES') || '').trim().toLowerCase();
  const discoveryMode = String(
    p.getProperty('SYNC_LIST_DISCOVERY_MODE') || DEFAULT_LIST_DISCOVERY_MODE
  ).trim().toLowerCase();
  if (discoveryMode !== 'explicit' && discoveryMode !== 'auto') {
    throw new Error(
      'SYNC_DISCOVERY_MODE_INVALID: SYNC_LIST_DISCOVERY_MODE must be explicit or auto.'
    );
  }
  const invalidSafetyKeys = [];
  [
    ['SYNC_ALLOW_DELETIONS', allowDeletionsRaw],
    ['SYNC_ALLOW_LIST_DELETIONS', allowListDeletionsRaw],
    ['SYNC_ALLOW_TASK_MOVES', allowTaskMovesRaw]
  ].forEach(function(entry) {
    if (entry[1] && entry[1] !== 'true' && entry[1] !== 'false') {
      invalidSafetyKeys.push(entry[0]);
    }
  });
  if (invalidSafetyKeys.length) {
    throw new Error('SYNC_SAFETY_CONFIG_INVALID:' + invalidSafetyKeys.join(','));
  }
  const excludedNames = String(p.getProperty('SYNC_EXCLUDED_LIST_NAMES') || '')
    .split(/[\r\n,]+/)
    .map(function(name) { return name.trim(); })
    .filter(Boolean);
  const requestedListDeletions = allowListDeletionsRaw === 'true' ||
    (!REQUIRE_LIST_ALLOWLIST && DEFAULT_ALLOW_LIST_DELETIONS);
  return {
    googleListIds: Array.from(new Set(listIds)),
    allowDeletions: allowDeletionsRaw === 'true' || (!REQUIRE_LIST_ALLOWLIST && DEFAULT_ALLOW_DELETIONS),
    // Keep both requested and effective values for operator reports.  In
    // explicit mode requested=true is an error after durable pausing, rather
    // than silently treating list deletion as available.
    requestedListDeletions: requestedListDeletions,
    allowListDeletions: requestedListDeletions && discoveryMode === 'auto',
    allowTaskMoves: allowTaskMovesRaw === 'true' || DEFAULT_ALLOW_TASK_MOVES,
    listDiscoveryMode: discoveryMode,
    excludedListNames: Array.from(new Set(excludedNames))
  };
}

function boundedSafetyConfigIssue_(error) {
  const code = String(error && error.message || error || '').match(
    /\b(SYNC_DISCOVERY_MODE_INVALID|SYNC_SAFETY_CONFIG_INVALID)\b/
  );
  return 'SAFETY_CONFIGURATION_INVALID:' + (code ? code[1] : 'UNCLASSIFIED');
}

function isAutoDiscoveryMode_(safety) {
  return !!safety && safety.listDiscoveryMode === 'auto';
}

function requireSyncAllowlist_(safety) {
  if (isAutoDiscoveryMode_(safety)) return;
  if (REQUIRE_LIST_ALLOWLIST && (!safety || !safety.googleListIds.length)) {
    throw new Error(
      'SYNC_ALLOWLIST_REQUIRED: Run listGoogleTaskLists(), then set ' +
      'SYNC_GOOGLE_LIST_IDS in Script Properties. Separate multiple IDs with commas.'
    );
  }
}

function requireExplicitListPairMode_(safety) {
  if (isAutoDiscoveryMode_(safety)) {
    throw new Error(
      'SYNC_PAIR_HELPER_EXPLICIT_MODE_ONLY: Auto mode is active. Use dryRunReport() to view the automatic list-discovery plan.'
    );
  }
}

function normalizeListName_(value) {
  const raw = String(value || '');
  const normalized = typeof raw.normalize === 'function' ? raw.normalize('NFC') : raw;
  return normalized.trim().replace(/\s+/g, ' ').toLowerCase();
}

function excludedListNameSet_(safety) {
  const excluded = {};
  (safety.excludedListNames || []).forEach(function(name) {
    excluded[normalizeListName_(name)] = true;
  });
  return excluded;
}

function isAutoEligibleGoogleList_(list, safety) {
  if (!list || !list.id) return false;
  const name = normalizeListName_(list.title);
  if (!name || name === 'flagged emails') return false;
  return !excludedListNameSet_(safety)[name];
}

function isAutoEligibleMicrosoftList_(list, safety) {
  if (!list || !list.id || list.isOwner !== true || list.isShared !== false) return false;
  const wellknown = normalizeListName_(list.wellknownListName);
  const name = normalizeListName_(list.displayName);
  if ((wellknown !== 'none' && wellknown !== 'defaultlist') ||
      wellknown === 'flaggedemails' || name === 'flagged emails' || !name) return false;
  return !excludedListNameSet_(safety)[name];
}

// Eligibility to sync is broader than eligibility to delete.  Built-in
// default lists may be paired for ordinary task sync, but list lifecycle V1
// never journals, tombstones, or deletes them.

function isAutoDeletableGoogleList_(list, googleDefaultList, safety) {
  return !!list && !!list.id &&
    (!googleDefaultList || list.id !== googleDefaultList.id) &&
    isAutoEligibleGoogleList_(list, safety);
}

function isAutoDeletableMicrosoftList_(list, safety) {
  return isAutoEligibleMicrosoftList_(list, safety) &&
    normalizeListName_(list.wellknownListName) === 'none';
}

function allowedGoogleLists_(lists, safety) {
  if (isAutoDiscoveryMode_(safety)) {
    return (lists || []).filter(function(list) {
      return isAutoEligibleGoogleList_(list, safety);
    });
  }
  const ids = {};
  (safety.googleListIds || []).forEach(function(id) { ids[id] = true; });
  return (lists || []).filter(function(list) { return !!ids[list.id]; });
}

function configuredListPairsRaw_() {
  return String(
    PropertiesService.getScriptProperties().getProperty('SYNC_LIST_PAIRS_JSON') || ''
  ).trim();
}

function parseConfiguredListPairs_(raw, safety, requireConfig) {
  raw = String(raw || '').trim();
  if (!raw) {
    if (requireConfig) {
      throw new Error(
        'SYNC_PAIR_CONFIG_REQUIRED: First set Script Property SYNC_LIST_PAIRS_JSON.'
      );
    }
    return { configured: false, pairs: [] };
  }

  requireSyncAllowlist_(safety);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('SYNC_PAIR_INVALID_JSON: SYNC_LIST_PAIRS_JSON is not valid JSON.');
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(
      'SYNC_PAIR_INVALID_FORMAT: SYNC_LIST_PAIRS_JSON must be a JSON array with at least one pair.'
    );
  }

  const allowed = new Set(safety.googleListIds);
  const seenGoogle = new Set();
  const seenMicrosoft = new Set();
  const pairs = parsed.map(function(item, index) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('SYNC_PAIR_INVALID_ENTRY: Pair ' + (index + 1) + ' must be an object.');
    }
    const googleListId = typeof item.googleListId === 'string' ? item.googleListId.trim() : '';
    const microsoftListId = typeof item.microsoftListId === 'string' ? item.microsoftListId.trim() : '';
    if (!googleListId || !microsoftListId) {
      throw new Error(
        'SYNC_PAIR_INVALID_ENTRY: Pair ' + (index + 1) + ' is missing googleListId or microsoftListId.'
      );
    }
    if (!allowed.has(googleListId)) {
      throw new Error(
        'SYNC_PAIR_NOT_ALLOWLISTED: Google list ' + googleListId +
        ' is not in SYNC_GOOGLE_LIST_IDS.'
      );
    }
    if (seenGoogle.has(googleListId)) {
      throw new Error('SYNC_PAIR_DUPLICATE_GOOGLE: Google list is paired more than once: ' + googleListId);
    }
    if (seenMicrosoft.has(microsoftListId)) {
      throw new Error('SYNC_PAIR_DUPLICATE_MICROSOFT: Microsoft list is paired more than once: ' + microsoftListId);
    }
    seenGoogle.add(googleListId);
    seenMicrosoft.add(microsoftListId);
    return {
      googleListId: googleListId,
      microsoftListId: microsoftListId
    };
  });

  const unpairedAllowed = safety.googleListIds.filter(function(id) { return !seenGoogle.has(id); });
  if (unpairedAllowed.length) {
    throw new Error(
      'SYNC_PAIR_ALLOWLIST_UNPAIRED: When explicit pairs are configured, every Google list in the allowlist must be paired. Missing: ' +
      unpairedAllowed.join(', ')
    );
  }
  return { configured: true, pairs: pairs };
}

function getConfiguredListPairs_(safety, requireConfig) {
  return parseConfiguredListPairs_(configuredListPairsRaw_(), safety, requireConfig);
}

function buildConfiguredPairsFromExistingMappings_(state, safety) {
  requireSyncAllowlist_(safety);
  state = normalizeState_(state);
  const seenMicrosoft = new Set();
  return safety.googleListIds.map(function(googleListId) {
    const rawMicrosoftListId = state.listMap[googleListId];
    if (typeof rawMicrosoftListId !== 'string' || !rawMicrosoftListId.trim()) {
      throw new Error(
        'SYNC_PAIR_ADOPT_MAPPING_MISSING: Google list ' + googleListId +
        ' in the allowlist has no existing listMap and cannot be adopted automatically.'
      );
    }
    const microsoftListId = rawMicrosoftListId.trim();
    if (seenMicrosoft.has(microsoftListId)) {
      throw new Error(
        'SYNC_PAIR_ADOPT_DUPLICATE_MICROSOFT: Multiple Google lists point to Microsoft list ' +
        microsoftListId + '.'
      );
    }
    seenMicrosoft.add(microsoftListId);
    return {
      googleListId: googleListId,
      microsoftListId: microsoftListId
    };
  });
}

function canonicalConfiguredListPairs_(pairs) {
  return (pairs || []).map(function(pair) {
    return {
      googleListId: pair.googleListId,
      microsoftListId: pair.microsoftListId
    };
  }).sort(function(a, b) {
    if (a.googleListId !== b.googleListId) {
      return a.googleListId < b.googleListId ? -1 : 1;
    }
    if (a.microsoftListId === b.microsoftListId) return 0;
    return a.microsoftListId < b.microsoftListId ? -1 : 1;
  });
}

function configuredListPairsEquivalent_(left, right) {
  return JSON.stringify(canonicalConfiguredListPairs_(left)) ===
    JSON.stringify(canonicalConfiguredListPairs_(right));
}

function validateConfiguredListPairInventory_(pairs, googleLists, microsoftLists) {
  const googleById = {};
  const microsoftById = {};
  (googleLists || []).forEach(function(list) { googleById[list.id] = list; });
  (microsoftLists || []).forEach(function(list) { microsoftById[list.id] = list; });
  const errors = [];
  const details = pairs.map(function(pair) {
    const google = googleById[pair.googleListId] || null;
    const microsoft = microsoftById[pair.microsoftListId] || null;
    if (!google) {
      errors.push('SYNC_PAIR_GOOGLE_NOT_FOUND: Google list not found: ' + pair.googleListId);
    }
    if (!microsoft) {
      errors.push('SYNC_PAIR_MICROSOFT_NOT_FOUND: Microsoft list not found: ' + pair.microsoftListId);
    }
    return {
      googleListId: pair.googleListId,
      googleListTitle: google ? (google.title || '(Untitled list)') : null,
      microsoftListId: pair.microsoftListId,
      microsoftListTitle: microsoft ? (microsoft.displayName || '(Untitled list)') : null
    };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  return details;
}

function validateConfiguredListPairState_(pairs, state) {
  state = normalizeState_(state);
  const errors = [];
  const requestedByGoogle = {};
  const requestedByMicrosoft = {};
  pairs.forEach(function(pair) {
    requestedByGoogle[pair.googleListId] = pair.microsoftListId;
    requestedByMicrosoft[pair.microsoftListId] = pair.googleListId;
  });

  pairs.forEach(function(pair) {
    const existingMicrosoft = state.listMap[pair.googleListId] || null;
    const existingGoogle = Object.keys(state.listMap).find(function(googleListId) {
      return googleListId !== pair.googleListId &&
        state.listMap[googleListId] === pair.microsoftListId;
    }) || null;
    if (existingMicrosoft && existingMicrosoft !== pair.microsoftListId) {
      errors.push(
        'SYNC_PAIR_REBIND_BLOCKED: Google list ' + pair.googleListId +
        ' is already paired with another Microsoft list.'
      );
    }
    if (existingGoogle && existingGoogle !== pair.googleListId) {
      errors.push(
        'SYNC_PAIR_MICROSOFT_IN_USE: Microsoft list ' + pair.microsoftListId +
        ' is already paired with another Google list.'
      );
    }
    if (state.listFaults.g[pair.googleListId] || state.listFaults.ms[pair.microsoftListId]) {
      errors.push(
        'SYNC_PAIR_FAULTED: Pair ' + pair.googleListId + ' ↔ ' + pair.microsoftListId +
        ' currently has a list-fault marker. Repair it first.'
      );
    }
  });

  Object.keys(state.g2m).forEach(function(googleTaskId) {
    const rec = state.g2m[googleTaskId];
    if (!rec) return;
    const requestedMicrosoft = requestedByGoogle[rec.gListId];
    const requestedGoogle = requestedByMicrosoft[rec.msListId];
    if (requestedMicrosoft && requestedMicrosoft !== rec.msListId) {
      errors.push(
        'SYNC_PAIR_TASK_MAPPING_CONFLICT: Google list ' + rec.gListId +
        ' still has task mappings pointing to another Microsoft list.'
      );
    }
    if (requestedGoogle && requestedGoogle !== rec.gListId) {
      errors.push(
        'SYNC_PAIR_TASK_MAPPING_CONFLICT: Microsoft list ' + rec.msListId +
        ' still has task mappings from another Google list.'
      );
    }
  });

  if (errors.length) throw new Error(errors.join('\n'));
  return pairs.map(function(pair) {
    return {
      googleListId: pair.googleListId,
      microsoftListId: pair.microsoftListId,
      status: state.listMap[pair.googleListId] === pair.microsoftListId ? 'APPLIED' : 'READY_TO_APPLY'
    };
  });
}

function requireConfiguredListPairsApplied_(state, safety) {
  if (isAutoDiscoveryMode_(safety)) {
    return { configured: false, pairs: [] };
  }
  const config = getConfiguredListPairs_(safety, false);
  if (!config.configured) return config;
  validateConfiguredListPairState_(config.pairs, state);
  const pending = config.pairs.filter(function(pair) {
    return state.listMap[pair.googleListId] !== pair.microsoftListId;
  });
  if (pending.length) {
    throw new Error(
      'SYNC_PAIR_NOT_APPLIED: SYNC_LIST_PAIRS_JSON is configured but has not been applied. Run ' +
      'validateConfiguredListPairs(), then applyConfiguredListPairs().'
    );
  }
  return config;
}
