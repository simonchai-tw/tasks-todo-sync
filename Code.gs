function initializeSafeDefaults() {
  const properties = PropertiesService.getScriptProperties();
  const defaults = {
    SYNC_LIST_DISCOVERY_MODE: PUBLIC_SETUP_DEFAULTS.SYNC_LIST_DISCOVERY_MODE,
    SYNC_ALLOW_DELETIONS: PUBLIC_SETUP_DEFAULTS.SYNC_ALLOW_DELETIONS,
    SYNC_ALLOW_LIST_DELETIONS: PUBLIC_SETUP_DEFAULTS.SYNC_ALLOW_LIST_DELETIONS,
    SYNC_ALLOW_TASK_MOVES: PUBLIC_SETUP_DEFAULTS.SYNC_ALLOW_TASK_MOVES
  };
  const missingDefaults = {};
  Object.keys(defaults).forEach(function(key) {
    const existing = properties.getProperty(key);
    // Do not silently correct a configured value. This preserves deliberate
    // overrides and leaves invalid values visible to setupStatus().
    if (existing === null || typeof existing === 'undefined') {
      missingDefaults[key] = defaults[key];
    }
  });
  // The second argument is false by design: preserve every unrelated Script
  // Property, including credentials and existing sync configuration.
  if (Object.keys(missingDefaults).length && typeof properties.setProperties === 'function') {
    properties.setProperties(missingDefaults, false);
  } else if (Object.keys(missingDefaults).length) {
    Object.keys(missingDefaults).forEach(function(key) {
      properties.setProperty(key, missingDefaults[key]);
    });
  }

  const report = {
    updatedProperties: missingDefaults,
    nextSteps: [
      {
        code: 'SETUP_STATUS',
        message: 'Run setupStatus() to check safety settings and trigger summary.'
      },
      {
        code: 'CONFIGURE_MICROSOFT_PROPERTIES',
        message: 'Use the private setup page to connect a personal Microsoft account. Script Properties are needed only for optional Advanced Entra OAuth.'
      }
    ]
  };
  if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

function setupStatus() {
  const properties = PropertiesService.getScriptProperties();
  const safetyDefaults = {};
  let allSafetyDefaultsCorrect = true;
  let allSafetySettingsValid = true;
  Object.keys(PUBLIC_SETUP_DEFAULTS).forEach(function(key) {
    safetyDefaults[key] = setupSafePropertyStatus_(
      properties, key, PUBLIC_SETUP_DEFAULTS[key]
    );
    if (!safetyDefaults[key].correct) allSafetyDefaultsCorrect = false;
    if (!safetyDefaults[key].valid) allSafetySettingsValid = false;
  });

  let projectTimeZone = DEFAULT_SYNC_TIME_ZONE;
  let projectTimeZoneAvailable = true;
  try {
    projectTimeZone = syncTimeZone_();
  } catch (e) {
    projectTimeZoneAvailable = false;
  }
  if (typeof projectTimeZone !== 'string' || !projectTimeZone.trim()) {
    projectTimeZone = DEFAULT_SYNC_TIME_ZONE;
    projectTimeZoneAvailable = false;
  }
  projectTimeZone = projectTimeZone.trim().slice(0, 100);

  function configured(key) {
    return String(properties.getProperty(key) || '').trim().length > 0;
  }
  const clientIdConfigured = configured('MS_CLIENT_ID');
  const clientSecretConfigured = configured('MS_CLIENT_SECRET');
  const tenantIdRaw = String(properties.getProperty('MS_TENANT_ID') || '').trim();
  const tenantIdConfigured = tenantIdRaw.length > 0;
  const usesCommonTenant = !tenantIdConfigured || tenantIdRaw.toLowerCase() === 'common';
  const alertEmailConfigured = configured('ALERT_EMAIL');
  const effectiveAlertRecipientAvailable = !!effectiveAlertRecipient_();
  const triggerStatus = setupTriggerCount_();
  const nextSteps = [];
  let microsoftMode = null;
  let microsoftModeValid = true;
  try {
    microsoftMode = resolveMicrosoftAuthMode_();
  } catch (e) {
    microsoftModeValid = false;
  }
  const personalAuthorizationPresent = personalMicrosoftAuthorizationPresent_();
  let personalAuthorizationStatus = null;
  let microsoftAuthorized = false;
  if (microsoftModeValid && microsoftMode === MS_AUTH_MODE_PERSONAL_) {
    personalAuthorizationStatus = personalAuthorizationPresent ?
      verifyStoredPersonalMicrosoftAuthorization_() : { status: 'not_started' };
    microsoftAuthorized = personalAuthorizationStatus.status === 'authorized';
  } else if (microsoftModeValid && clientIdConfigured && clientSecretConfigured &&
      typeof OAuth2 !== 'undefined') {
    try {
      microsoftAuthorized = !!microsoftService_().hasAccess();
    } catch (e) {
      microsoftAuthorized = false;
    }
  }

  if (!allSafetySettingsValid) {
    nextSteps.push({
      code: 'SAFETY_SETTINGS_MISSING_OR_INVALID',
      message: 'Set SYNC_LIST_DISCOVERY_MODE to auto or explicit and every SYNC_ALLOW_* switch to true or false, then run setupStatus() again.'
    });
  }
  if (!microsoftModeValid) {
    nextSteps.push({
      code: 'MICROSOFT_AUTH_MODE_INVALID',
      message: 'Set MS_AUTH_MODE to personal_device or advanced_entra, then run setupStatus() again.'
    });
  } else if (microsoftMode === MS_AUTH_MODE_ADVANCED_ &&
      (!clientIdConfigured || !clientSecretConfigured)) {
    nextSteps.push({
      code: 'MICROSOFT_CREDENTIALS_MISSING',
      message: 'Set MS_CLIENT_ID and MS_CLIENT_SECRET in Script Properties; this summary never shows their values.'
    });
  } else if (microsoftMode === MS_AUTH_MODE_PERSONAL_ && !personalAuthorizationPresent) {
    nextSteps.push({
      code: 'MICROSOFT_PERSONAL_AUTH_REQUIRED',
      message: 'Connect a personal Microsoft account with the setup wizard or run startAuthorization().'
    });
  } else if (!microsoftAuthorized) {
    nextSteps.push({
      code: microsoftMode === MS_AUTH_MODE_ADVANCED_ ?
        'MICROSOFT_ADVANCED_AUTH_REQUIRED' : 'MICROSOFT_PERSONAL_AUTH_REQUIRED',
      message: 'Microsoft authorization is not ready; run startAuthorization().'
    });
  }
  if (microsoftMode === MS_AUTH_MODE_ADVANCED_ && !tenantIdConfigured) {
    nextSteps.push({
      code: 'MS_TENANT_DEFAULT_COMMON',
      message: 'MS_TENANT_ID is not set; common will be used.'
    });
  }
  if (!effectiveAlertRecipientAvailable) {
    nextSteps.push({
      code: 'ALERT_RECIPIENT_UNAVAILABLE',
      message: 'The effective Google account email is unavailable; set ALERT_EMAIL to receive notifications.'
    });
  }
  if (!triggerStatus.available) {
    nextSteps.push({
      code: 'SYNC_TRIGGER_STATUS_UNAVAILABLE',
      message: 'The syncAll trigger count is unavailable; run setupStatus() again from the Apps Script project.'
    });
  } else if (triggerStatus.count === 0) {
    nextSteps.push({
      code: 'SYNC_TRIGGER_MISSING',
      message: 'No syncAll trigger was found; verify settings, then run createTrigger().'
    });
  } else if (triggerStatus.count > 1) {
    nextSteps.push({
      code: 'SYNC_TRIGGER_DUPLICATE',
      message: 'Multiple syncAll triggers were found; keep only the intended number.'
    });
  }
  if (!projectTimeZoneAvailable) {
    nextSteps.push({
      code: 'PROJECT_TIMEZONE_FALLBACK',
      message: 'The project time zone is unavailable; this summary uses the Asia/Taipei fallback.'
    });
  }
  if (!nextSteps.length) {
    nextSteps.push({
      code: 'SETUP_SUMMARY_READY',
      message: 'The safety summary and Microsoft authorization are ready.'
    });
  }

  const report = {
    projectTimeZone: projectTimeZone,
    safetyDefaults: safetyDefaults,
    allSafetyDefaultsCorrect: allSafetyDefaultsCorrect,
    allSafetySettingsValid: allSafetySettingsValid,
    microsoft: {
      mode: microsoftModeValid ? microsoftMode : 'invalid',
      configured: microsoftMode === MS_AUTH_MODE_PERSONAL_ ? true :
        (clientIdConfigured && clientSecretConfigured),
      authorized: microsoftAuthorized,
      reauthorizationRequired: microsoftModeValid && !microsoftAuthorized,
      authorizationStatus: personalAuthorizationStatus ?
        personalAuthorizationStatus.status : undefined
    },
    credentials: {
      msClientIdPresent: clientIdConfigured,
      msClientSecretPresent: clientSecretConfigured,
      msTenantIdPresent: tenantIdConfigured,
      usesCommonTenant: usesCommonTenant,
      alertEmailPresent: alertEmailConfigured,
      effectiveAlertRecipientAvailable: effectiveAlertRecipientAvailable
    },
    syncAllTriggerCount: triggerStatus.count,
    nextSteps: nextSteps
  };
  if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

function configureSync(config) {
  throw new Error(
    'CONFIGURE_SYNC_DEPRECATED: configureSync() no longer accepts secrets. ' +
    'Set MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_TENANT_ID directly in Script Properties. ' +
    'ALERT_EMAIL is an optional recipient override.'
  );
}

function listGoogleTaskLists() {
  initializeExecutionBudget_();
  const safety = getSafetyConfig_();
  const configured = {};
  safety.googleListIds.forEach(function(id) { configured[id] = true; });
  const lists = getGLists_().map(function(list) {
    return {
      id: list.id,
      title: list.title || '(Untitled list)',
      selected: isAutoDiscoveryMode_(safety)
        ? isAutoEligibleGoogleList_(list, safety)
        : !!configured[list.id]
    };
  });
  console.log(JSON.stringify({
    lists: lists,
    listDiscoveryMode: safety.listDiscoveryMode,
    configuredGoogleListIds: safety.googleListIds,
    note: isAutoDiscoveryMode_(safety)
      ? 'Auto mode syncs every regular Google list with selected=true; excluded names are controlled by SYNC_EXCLUDED_LIST_NAMES.'
      : 'Add the IDs to sync to Script Property SYNC_GOOGLE_LIST_IDS; separate multiple IDs with commas.'
  }, null, 2));
}

function listMicrosoftTaskLists() {
  initializeExecutionBudget_();
  const safety = getSafetyConfig_();
  const lists = getMsLists_().map(function(list) {
    return {
      id: list.id,
      title: list.displayName || '(Untitled list)',
      isOwner: list.isOwner === true,
      isShared: list.isShared === true,
      wellknownListName: list.wellknownListName || null,
      autoEligible: isAutoEligibleMicrosoftList_(list, safety)
    };
  });
  console.log(JSON.stringify({
    lists: lists,
    listDiscoveryMode: safety.listDiscoveryMode,
    note: isAutoDiscoveryMode_(safety)
      ? 'Auto mode syncs only owned, non-shared regular lists with autoEligible=true; Flagged Emails and excluded names are not synced.'
      : 'Write only existing list IDs to SYNC_LIST_PAIRS_JSON; do not infer IDs from titles or share a public ID list.'
  }, null, 2));
  return lists;
}

function validateConfiguredListPairs() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    const safety = getSafetyConfig_();
    requireExplicitListPairMode_(safety);
    requireSyncAllowlist_(safety);
    if (safety.allowDeletions) {
      throw new Error('SYNC_PAIR_DELETIONS_MUST_BE_FALSE: Set SYNC_ALLOW_DELETIONS to false before the initial pairing.');
    }
    const config = getConfiguredListPairs_(safety, true);
    const loaded = loadStateForInspection_();
    if (loaded.corrupt) {
      throw new Error('STATE_CORRUPT: State exists but cannot be read; applying list pairs is blocked.');
    }
    const details = validateConfiguredListPairInventory_(config.pairs, getGLists_(), getMsLists_());
    const statuses = validateConfiguredListPairState_(config.pairs, loaded.state);
    const statusByGoogle = {};
    statuses.forEach(function(item) { statusByGoogle[item.googleListId] = item.status; });
    details.forEach(function(item) { item.status = statusByGoogle[item.googleListId]; });
    const report = {
      ok: true,
      pairs: details,
      deletionsEnabled: safety.allowDeletions,
      note: 'Validation only; no sync state was changed and no lists or tasks were created, updated, or deleted.'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function applyConfiguredListPairs() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('SYNC_PAIR_APPLY');
    const safety = getSafetyConfig_();
    requireExplicitListPairMode_(safety);
    requireSyncAllowlist_(safety);
    if (safety.allowDeletions) {
      throw new Error('SYNC_PAIR_DELETIONS_MUST_BE_FALSE: Set SYNC_ALLOW_DELETIONS to false before the initial pairing.');
    }
    const config = getConfiguredListPairs_(safety, true);
    const state = loadStateForSync_();
    assertNoAnyDeletionJournals_(state, 'SYNC_PAIR_APPLY');
    const details = validateConfiguredListPairInventory_(config.pairs, getGLists_(), getMsLists_());
    validateConfiguredListPairState_(config.pairs, state);

    let applied = 0;
    config.pairs.forEach(function(pair) {
      if (state.listMap[pair.googleListId] === pair.microsoftListId) return;
      state.listMap[pair.googleListId] = pair.microsoftListId;
      applied += 1;
    });
    if (applied) saveState_(state);

    const report = {
      ok: true,
      applied: applied,
      alreadyApplied: config.pairs.length - applied,
      pairs: details,
      deletionsEnabled: safety.allowDeletions,
      note: 'Only listMap was updated; no cloud lists or tasks were created, updated, or deleted. Next, run dryRunReport().'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function adoptExistingListMappingsAsConfiguredPairs() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('SYNC_PAIR_ADOPT');
    const safety = getSafetyConfig_();
    requireExplicitListPairMode_(safety);
    requireSyncAllowlist_(safety);
    if (safety.allowDeletions) {
      throw new Error(
        'SYNC_PAIR_DELETIONS_MUST_BE_FALSE: Set SYNC_ALLOW_DELETIONS to false before adopting existing mappings.'
      );
    }

    const loaded = loadStateForInspection_();
    if (loaded.corrupt) {
      throw new Error('STATE_CORRUPT: State exists but cannot be read; adopting existing mappings is blocked.');
    }
    const pairs = buildConfiguredPairsFromExistingMappings_(loaded.state, safety);
    const details = validateConfiguredListPairInventory_(pairs, getGLists_(), getMsLists_());
    const statuses = validateConfiguredListPairState_(pairs, loaded.state);
    const statusByGoogle = {};
    statuses.forEach(function(item) { statusByGoogle[item.googleListId] = item.status; });
    details.forEach(function(item) { item.status = statusByGoogle[item.googleListId]; });

    const properties = PropertiesService.getScriptProperties();
    const existingValue = properties.getProperty('SYNC_LIST_PAIRS_JSON');
    const hasExistingProperty = existingValue !== null;
    const existingRaw = String(existingValue || '').trim();
    let changed = false;
    if (hasExistingProperty) {
      let existingConfig;
      try {
        existingConfig = parseConfiguredListPairs_(existingRaw, safety, true);
      } catch (e) {
        throw new Error(
          'SYNC_PAIR_ADOPT_PROPERTY_CONFLICT: Existing SYNC_LIST_PAIRS_JSON cannot be validated; overwrite refused.' +
          e.message
        );
      }
      if (!configuredListPairsEquivalent_(existingConfig.pairs, pairs)) {
        throw new Error(
          'SYNC_PAIR_ADOPT_PROPERTY_CONFLICT: Existing SYNC_LIST_PAIRS_JSON differs from the current listMap; overwrite refused.'
        );
      }
    } else {
      properties.setProperty('SYNC_LIST_PAIRS_JSON', JSON.stringify(pairs));
      changed = true;
    }

    const report = {
      ok: true,
      changed: changed,
      status: changed ? 'CONFIG_CREATED' : 'ALREADY_CONFIGURED',
      pairs: details,
      deletionsEnabled: safety.allowDeletions,
      note: changed
        ? 'SYNC_LIST_PAIRS_JSON was created only from the existing listMap; no sync state or cloud lists or tasks were changed.'
        : 'Existing SYNC_LIST_PAIRS_JSON matches listMap; no writes were made.'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function showRedirectUri() {
  initializeExecutionBudget_();
  // This helper belongs to Advanced BYO Entra setup. Personal Device Flow
  // deliberately has no redirect URI.
  console.log(microsoftService_().getRedirectUri());
}

function startAuthorization() {
  initializeExecutionBudget_();
  if (resolveMicrosoftAuthMode_() === MS_AUTH_MODE_PERSONAL_) {
    const session = beginPersonalMicrosoftAuth_();
    if (session.status === 'authorized') {
      console.log('[Auth] Valid personal Microsoft authorization already exists.');
      return session;
    }
    if (session.status === 'verification_required') {
      return verifyStoredPersonalMicrosoftAuthorization_();
    }
    if (session.status === 'verification_failed') {
      return session;
    }
    console.log('[Auth] Open Microsoft\'s official sign-in page: ' + session.verificationUri);
    console.log('[Auth] Enter this one-time code: ' + session.userCode);
    return session;
  }
  return startAdvancedAuthorization();
}

function startAdvancedAuthorization() {
  initializeExecutionBudget_();
  const service = microsoftService_();
  if (service.hasAccess()) {
    console.log('[Auth] Valid authorization already exists.');
    return { status: 'authorized', mode: MS_AUTH_MODE_ADVANCED_ };
  }
  console.log('[Auth] Open: ' + service.getAuthorizationUrl());
  return { status: 'pending', mode: MS_AUTH_MODE_ADVANCED_ };
}

function authCallback(request) {
  initializeExecutionBudget_();
  const ok = microsoftService_().handleCallback(request);
  if (ok) {
    PropertiesService.getScriptProperties().setProperty(
      MS_AUTH_MODE_PROPERTY_, MS_AUTH_MODE_ADVANCED_
    );
  }
  return HtmlService.createHtmlOutput(ok
    ? '<h2 style="color:green;font-family:sans-serif">Authorization successful. You may close this page.</h2>'
    : '<h2 style="color:red;font-family:sans-serif">Authorization failed. Check the Apps Script log.</h2>');
}

function resetMicrosoftAuthorization() {
  initializeExecutionBudget_();
  const auth = microsoftAuth_();
  auth.reset();
  console.log('[Auth] Active Microsoft authorization cleared for mode ' + auth.mode + '.');
}

function beginPersonalMicrosoftAuthorization() {
  initializeExecutionBudget_();
  return beginPersonalMicrosoftAuth_();
}

function pollPersonalMicrosoftAuthorization() {
  initializeExecutionBudget_();
  return pollPersonalMicrosoftAuth_();
}

function personalMicrosoftAuthorizationStatus() {
  initializeExecutionBudget_();
  if (resolveMicrosoftAuthMode_() === MS_AUTH_MODE_PERSONAL_) {
    if (personalMicrosoftTokensPresent_()) return verifyStoredPersonalMicrosoftAuthorization_();
  }
  return personalMicrosoftDeviceSessionStatus_();
}

function cancelPersonalMicrosoftAuthorization() {
  initializeExecutionBudget_();
  const properties = PropertiesService.getUserProperties();
  const raw = properties.getProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
  const session = parsePersonalDeviceSession_(
    raw
  );
  if (!session) {
    if (raw) properties.deleteProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
    clearPersonalMicrosoftModeSwitchApproval_();
    return {
      status: 'not_started',
      messageCode: 'CANCEL_ONLY_STOPS_LOCAL_POLLING'
    };
  }
  discardPersonalMicrosoftDeviceSession_(properties, session);
  return { status: 'cancelled', messageCode: 'CANCEL_ONLY_STOPS_LOCAL_POLLING' };
}

function forgetPersonalMicrosoftAuthorization() {
  initializeExecutionBudget_();
  clearPersonalMicrosoftTokens_();
  console.log('[Auth] Personal Microsoft authorization cleared; Advanced Entra properties were preserved.');
  return { status: 'cleared' };
}

function setupWizardBeginPersonalAuthorization() {
  initializeExecutionBudget_();
  return setupWizardPersonalAuthView_(beginPersonalMicrosoftAuth_());
}

function setupWizardConfirmPersonalAuthorization() {
  initializeExecutionBudget_();
  confirmPersonalMicrosoftModeSwitch_();
  return setupWizardPersonalAuthView_(beginPersonalMicrosoftAuth_());
}

function setupWizardVerifyPersonalAuthorization() {
  initializeExecutionBudget_();
  return setupWizardPersonalAuthView_(verifyStoredPersonalMicrosoftAuthorization_());
}

function setupWizardPollPersonalAuthorization() {
  initializeExecutionBudget_();
  return setupWizardPersonalAuthView_(pollPersonalMicrosoftAuth_());
}

function setupWizardPersonalAuthorizationStatus() {
  initializeExecutionBudget_();
  let result;
  const mode = resolveMicrosoftAuthMode_();
  const session = personalMicrosoftDeviceSessionStatus_();
  if (session.status === 'pending') {
    result = Object.assign({}, session, { mode: mode });
  } else if (mode === MS_AUTH_MODE_ADVANCED_) {
    result = { status: 'advanced', mode: mode };
  } else if (personalMicrosoftTokensPresent_()) {
    // This endpoint is called on initial setup-page load.  Probe Graph once
    // instead of trusting a durable marker forever, so revoked consent and
    // invalid tokens cannot be presented as a connected account.
    result = Object.assign({}, verifyStoredPersonalMicrosoftAuthorization_(), {
      mode: mode
    });
  } else {
    result = Object.assign({}, session, { mode: mode });
  }
  return setupWizardPersonalAuthView_(result);
}

function setupWizardCancelPersonalAuthorization() {
  return setupWizardPersonalAuthView_(cancelPersonalMicrosoftAuthorization());
}

function setupWizardForgetPersonalAuthorization() {
  return setupWizardPersonalAuthView_(forgetPersonalMicrosoftAuthorization());
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Setup')
    .setTitle('Tasks–To Do Sync — Easy Setup')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function checkpointTaskCreateBatch_(state) {
  if (!SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_) return false;
  normalizeState_(state);
  persistSyncState_(state, { finalCommit: true });
  taskCreateProgressClear_();
  SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_ = false;
  SYNC_TASK_CREATE_BATCH_PENDING_STATE_ = null;
  return true;
}

function syncAll() {
  const entryStartedAt = initializeExecutionBudget_();
  beginSyncObservability_(entryStartedAt);
  return withGlobalLock_(function() {
    const startedAt = entryStartedAt;
    const roundId = deletionRoundId_(startedAt);
    let state;
    let snap = null;
    let safetyAtStart = null;
    let pendingTaskDeletionsBeforeRound = null;
    let pendingListDeletionsBeforeRound = null;
    let deletionStateBeforeApply = null;
    let roundFenceOpened = false;
    let finalStateCommitted = false;
    const deletionProgress = { durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} };
    const listDeletionProgress = { durableListJournalKeys: {}, invalidatedListCandidateKeys: {} };
    try {
      state = loadStateForSync_();
      // A fence left by a crashed or double-save-failed run makes all volatile
      // proof untrusted. Persist the stripped baseline before clearing it; any
      // failure here stops before a single inventory or remote call.
      state = sanitizePreexistingSyncRoundFence_(state);
    } catch (e) {
      console.error('[Sync] State load failed: ' + e.message);
      sendFatalAlert_('State load failed: ' + e.message);
      logSyncSummary_('failure');
      throw e;
    }
    try {
      ensureTaskDeletionState_(state);
      ensureListDeletionState_(state);
      pendingTaskDeletionsBeforeRound = JSON.parse(JSON.stringify(state.pendingTaskDeletions));
      pendingListDeletionsBeforeRound = JSON.parse(JSON.stringify(state.pendingListDeletions));
      deletionProgress.pendingBeforeRound = pendingTaskDeletionsBeforeRound;
      listDeletionProgress.pendingListBeforeRound = pendingListDeletionsBeforeRound;
      // Write a fenced, baseline-only projection before any inventory/API
      // work. A hard crash can therefore retain completed-round 1/2 proof
      // without retaining current-round observations.
      openSyncRoundFence_(roundId);
      roundFenceOpened = true;
      beginSyncRoundProofProjection_(state, roundId,
        pendingTaskDeletionsBeforeRound, pendingListDeletionsBeforeRound);
      safetyAtStart = getSafetyConfig_();
      if (!safetyAtStart.allowDeletions) {
        // Pause durable delete intent before any inventory/API work.  If the
        // snapshot subsequently fails, catch-save still preserves this pause.
        pauseTaskDeletions_(state);
        pausePreparedDeletionJournals_(state);
        // Do not rely solely on the later success/catch save: a process crash
        // between inventory calls must not leave a prepared intent armed.
        persistSyncState_(state);
      }
      // This is independent from SYNC_ALLOW_DELETIONS.  It may write only the
      // pause of an existing list intent, and always occurs before inventories.
      pauseListDeletionIntentBeforeInventory_(state, safetyAtStart);
      cleanupTombstones_(state);
      cleanupListTombstones_(state);
      snap = buildSnapshot_(state, startedAt);
      while (true) {
        if (state.taskCreateBatch) {
          createUnmapped_(state, snap, startedAt);
          if (state.taskCreateBatch) throw new Error('TASK_CREATE_RECOVERY_PENDING: create batch is held; ordinary sync is fenced.');
        } else {
          if (!remainingTimeOk_(startedAt, TASK_CREATE_BATCH_START_RESERVE_MS) || !taskCreateBatchCandidates_(state, snap).length) break;
          createUnmapped_(state, snap, startedAt);
          if (state.taskCreateBatch) throw new Error('TASK_CREATE_RECOVERY_PENDING: create batch held; ordinary sync is fenced.');
        }
        if (SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_) checkpointTaskCreateBatch_(state);
      }
      reconcileMapped_(state, snap, startedAt, roundId, deletionProgress);
      deletionStateBeforeApply = captureTaskDeletionState_(state);
      applyConfirmedTaskDeletions_(state, snap, roundId, deletionProgress);
      applyConfirmedListDeletions_(state, snap, roundId, listDeletionProgress, deletionProgress);
      state.health.lastSuccessfulSyncAt = new Date().toISOString();
      state.health.lastFailedSyncAt = null;
      state.health.lastErrorMessage = null;
      state.health.consecutiveFailures = 0;
      state.health.lastSuccessfulRoundId = roundId;
      state.health.roundFenceProjectionId = null;
      normalizeState_(state);
      const finalGeneration = persistSyncState_(state, { finalCommit: true });
      if (SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_) {
        taskCreateProgressClear_();
        SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_ = false;
        SYNC_TASK_CREATE_BATCH_PENDING_STATE_ = null;
      }
      finalStateCommitted = true;
      recordSuccessfulSyncRound_(roundId, finalGeneration);
      clearSyncRoundFence_();
      console.log('[Sync] Completed. mapping=' + Object.keys(state.g2m).length);
      logSyncSummary_('success');
    } catch (e) {
      const isTimeBudget = String(e.message).indexOf('TIME_BUDGET_') === 0;
      if (!finalStateCommitted && SYNC_TASK_CREATE_BATCH_AWAITING_FINAL_COMMIT_ && SYNC_TASK_CREATE_BATCH_PENDING_STATE_) {
        state.taskCreateBatch = SYNC_TASK_CREATE_BATCH_PENDING_STATE_;
      }
      try {
        // A final state commit followed by a failed fence clear is a special
        // crash-recovery state. Do not overwrite it or clear the fence here:
        // next load must verify the durable final commit before resuming.
        if (roundFenceOpened && finalStateCommitted) throw e;
        // Only a successful pre-delete journal save may survive a failed round.
        // Restore every other candidate to its prior completed-round value so an
        // unrelated journal retry cannot promote it from 1/2 to 2/2.
        if (pendingTaskDeletionsBeforeRound) {
          rollbackUndurableTaskDeletionChanges_(
            state,
            deletionStateBeforeApply,
            pendingTaskDeletionsBeforeRound,
            deletionProgress.durableJournalTaskIds,
            deletionProgress.invalidatedCandidateTaskIds,
            deletionProgress.discardCandidateTaskIds,
            !((snap && snap.safety && !snap.safety.allowDeletions) ||
              (safetyAtStart && !safetyAtStart.allowDeletions))
          );
        }
        if (pendingListDeletionsBeforeRound) {
          rollbackUndurableListDeletionChanges_(
            state,
            pendingListDeletionsBeforeRound,
            listDeletionProgress,
            !!(safetyAtStart && safetyAtStart.allowListDeletions)
          );
        }
        if (!isTimeBudget) {
          state.health.lastFailedSyncAt = new Date().toISOString();
          state.health.lastErrorMessage = redactHealthErrorMessage_(e.message || e);
          state.health.consecutiveFailures = (state.health.consecutiveFailures || 0) + 1;
        }
        normalizeState_(state);
        persistSyncState_(state);
        // A catch-save is a committed stripped baseline, so it may end this
        // round. If this clear fails, leave the fence for next-run sanitizing.
        if (roundFenceOpened) clearSyncRoundFence_();
      } catch (saveError) {
        console.error('[Sync] Progress save failed: ' + saveError.message);
      }
      if (isTimeBudget) {
        console.warn('[Sync] Near the time limit; durable state was saved safely. The next round will rerun the full inventory, with no persisted page cursor.');
        logSyncSummary_('time_budget');
        return;
      }
      sendFatalAlert_(String(e.message || e));
      console.error('[Sync] Failed: ' + e.message + '\n' + (e.stack || ''));
      logSyncSummary_('failure');
      throw e;
    }
  });
}

// Only structured pendingMoves use stable opaque labels rather than provider
// IDs. They are diagnostic pseudonyms, not a security boundary. Legacy
// actions/warnings deliberately retain their existing operator-facing output,
// so callers must not treat the whole dry-run report as shareable.

function dryRunReport() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    let safety;
    try {
      safety = getSafetyConfig_();
    } catch (e) {
      const report = {
        warnings: [boundedSafetyConfigIssue_(e)],
        actions: [],
        info: [],
        pendingMoves: [],
        pendingMoveSummary: pendingMoveSummary_([]),
        note: 'Configuration validation stopped this read-only report before provider inventory.'
      };
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    const roundFence = syncRoundFenceStatus_();
    const loaded = loadStateForInspection_();
    if (loaded.corrupt) {
      const pendingMoves = [];
      const report = {
        warnings: ['STATE_CORRUPT: State exists but cannot be read. Do not run syncAll. Run exportRawSyncState() and pause syncing.'].concat(
          roundFence.active ? ['ROUND_FENCE_ACTIVE: The next syncAll will safely clear volatile proof first.'] : []
        ),
        roundFence: roundFence,
        pendingMoves: pendingMoves,
        pendingMoveSummary: pendingMoveSummary_(pendingMoves),
        note: 'Read-only report; no lists or tasks are created, updated, or deleted.'
      };
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    const state = loaded.state;
    const warnings = [];
    const actions = [];
    const info = [];
    const pendingMoves = [];
    if (roundFence.active) {
    warnings.push('[WARNING] An unfinished sync-round safety fence exists; the next syncAll will verify final commit or preserve baseline proof before continuing.');
    }
    const allGLists = getGLists_();
    const gLists = allowedGoogleLists_(allGLists, safety);
    const selectedGListIds = {};
    gLists.forEach(function(list) { selectedGListIds[list.id] = true; });
    const msLists = getMsLists_();
    if (isAutoDiscoveryMode_(safety)) {
      const excludedMicrosoft = msLists.filter(function(list) {
        return !isAutoEligibleMicrosoftList_(list, safety);
      }).map(function(list) {
        return {
          id: list.id,
          title: list.displayName || '(Untitled list)',
          reason: normalizeListName_(list.wellknownListName) === 'flaggedemails'
            ? 'FLAGGED_EMAILS'
            : list.isOwner !== true || list.isShared !== false
              ? 'NOT_OWNED_OR_SHARED'
              : 'EXCLUDED_OR_UNKNOWN_LIST_TYPE'
        };
      });
      let gDefaultList;
      let plan;
      let lifecycle;
      let autoError = null;
      try {
        gDefaultList = getGDefaultList_();
        if (!gDefaultList || !gDefaultList.id || !allGLists.some(function(list) {
          return list.id === gDefaultList.id;
        })) {
          throw new Error('AUTO_DEFAULT_LIST_LOOKUP_FAILED: Google default list is not in this round\'s inventory.');
        }
        lifecycle = classifyListLifecycle_(state, allGLists, msLists, gDefaultList, safety);
        plan = planAutoListMappings_(state, gLists, msLists, gDefaultList, safety, lifecycle);
      } catch (e) {
        autoError = String(e.message || e);
      }
    const googleTaskCounts = {};
    const microsoftTaskCounts = {};
    const moveInventory = {
      gTasksById: {},
      msTasksById: {},
      gListByTask: {},
      msListByTask: {}
    };
      let googleTasks = 0;
      let microsoftTasks = 0;
      if (!autoError) {
        gLists.forEach(function(list) {
          try {
          const tasks = getGTasks_(list.id);
          googleTaskCounts[list.id] = tasks.length;
          googleTasks += tasks.length;
          tasks.forEach(function(task) {
            moveInventory.gTasksById[task.id] = task;
            moveInventory.gListByTask[task.id] = list.id;
          });
          } catch (e) {
            if (isNotFoundError_(e)) {
              warnings.push('[WARNING] Google list ' + (list.title || list.id) + ' is unreadable and may be missing.');
              return;
            }
            throw e;
          }
        });
        plan.eligibleMicrosoftLists.forEach(function(list) {
          try {
          const tasks = getMsTasks_(list.id);
          microsoftTaskCounts[list.id] = tasks.length;
          microsoftTasks += tasks.length;
          tasks.forEach(function(task) {
            moveInventory.msTasksById[task.id] = task;
            moveInventory.msListByTask[task.id] = list.id;
          });
          } catch (e) {
            if (isNotFoundError_(e)) {
              warnings.push('[WARNING] Microsoft list ' + (list.displayName || list.id) + ' is unreadable and may be missing.');
              return;
            }
            throw e;
          }
        });
      }
      if (autoError) {
        warnings.push('[WARNING] Auto list discovery stopped safely: ' + autoError);
      } else {
        plan.pairs.forEach(function(pair) {
          if (pair.existing) return;
          actions.push('[ACTION] Auto-pair existing lists: ' + pair.googleListTitle + ' ↔ ' + pair.microsoftListTitle + ' (' + pair.reason + ')');
          if ((googleTaskCounts[pair.googleListId] || 0) > 0 &&
              (microsoftTaskCounts[pair.microsoftListId] || 0) > 0) {
            warnings.push('[WARNING] Initial union: Existing lists "' + pair.googleListTitle + '" and "' +
              pair.microsoftListTitle + '" both contain tasks; tasks with the same name may be retained as duplicates.');
          }
        });
        plan.createMicrosoft.forEach(function(list) {
          actions.push('[ACTION] Google → Microsoft create list: ' + (list.title || '(Untitled list)'));
        });
      plan.createGoogle.forEach(function(list) {
        actions.push('[ACTION] Microsoft → Google create list: ' + (list.displayName || '(Untitled list)'));
      });
      plan.faults.forEach(function(fault) {
          warnings.push('[WARNING] Will isolate without guessing a pair: ' + fault.reason + ' (' +
            (fault.googleListTitle || fault.microsoftListTitle || 'Unknown list') + ')');
        });
      }
      // A discovery failure leaves normal move candidates unobservable, but a
      // durable journal is still reported as RECOVERY with snapshot=MISSING.
      appendTaskMovePreview_(state, moveInventory, safety, actions, warnings, pendingMoves);
      if (!safety.allowDeletions) {
        info.push('[INFO] SYNC_ALLOW_DELETIONS=false; task-deletion candidates will not be accumulated or advanced.');
      }
      if (!safety.allowTaskMoves) {
        info.push('[INFO] SYNC_ALLOW_TASK_MOVES=false; Google cross-list moves will be blocked.');
      }
      if (!safety.allowListDeletions) {
        info.push('[INFO] SYNC_ALLOW_LIST_DELETIONS=false; list-deletion candidates will not be accumulated or advanced.');
      }
      const report = {
        warnings: warnings,
        actions: actions,
        info: info,
        pendingMoves: pendingMoves,
        pendingMoveSummary: finalizePendingMovePreview_(pendingMoves),
        listDiscoveryMode: 'auto',
        autoDiscoveryError: autoError,
        googleDefaultListId: gDefaultList ? gDefaultList.id : null,
        autoPlan: plan ? {
          pairs: plan.pairs,
          createMicrosoft: plan.createMicrosoft.map(function(list) {
            return { id: list.id, title: list.title || '(Untitled list)' };
          }),
          createGoogle: plan.createGoogle.map(function(list) {
            return { id: list.id, title: list.displayName || '(Untitled list)' };
          }),
          faults: plan.faults.map(function(fault) {
            const copy = Object.assign({}, fault);
            delete copy.key;
            return copy;
          })
        } : null,
        excludedMicrosoftLists: excludedMicrosoft,
        googleListsSelected: gLists.length,
        googleListsTotal: allGLists.length,
        microsoftListsTotal: msLists.length,
        microsoftListsEligible: plan ? plan.eligibleMicrosoftLists.length : null,
        googleTasks: googleTasks,
        microsoftTasksInEligibleLists: microsoftTasks,
        deletionsEnabled: safety.allowDeletions,
        taskMovesEnabled: safety.allowTaskMoves,
        roundFence: roundFence,
        taskDeletion: taskDeletionObservability_(state, safety),
        listDeletion: listDeletionObservability_(state, safety),
        reservedMissingPairs: lifecycle ? lifecycle.pairs.filter(function(pair) {
          return pair.status !== 'both_live' || pair.tracked || pair.tombstoned;
        }).length : null,
        lifecycleStatuses: lifecycle ? lifecycle.pairs.reduce(function(counts, pair) {
          counts[pair.status] = (counts[pair.status] || 0) + 1;
          return counts;
        }, {}) : null,
        note: 'Read-only auto list-discovery preview; no lists or tasks are created, updated, or deleted.'
      };
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    const explicitPairRaw = configuredListPairsRaw_();
    let explicitPairConfig = { configured: false, pairs: [] };
    let explicitPairDetails = [];
    let explicitPairError = null;
    if (explicitPairRaw) {
      try {
        explicitPairConfig = parseConfiguredListPairs_(explicitPairRaw, safety, true);
        explicitPairDetails = validateConfiguredListPairInventory_(
          explicitPairConfig.pairs,
          allGLists,
          msLists
        );
        const pairStatuses = validateConfiguredListPairState_(explicitPairConfig.pairs, state);
        const statusByGoogle = {};
        pairStatuses.forEach(function(item) { statusByGoogle[item.googleListId] = item.status; });
        explicitPairDetails.forEach(function(item) {
          item.status = statusByGoogle[item.googleListId];
        });
        const pendingCount = pairStatuses.filter(function(item) {
          return item.status === 'READY_TO_APPLY';
        }).length;
        if (pendingCount) {
          actions.push('[ACTION] Explicit list pairs are validated but not applied; run applyConfiguredListPairs() first.');
        } else {
          info.push('[INFO] All explicit ID pairs in SYNC_LIST_PAIRS_JSON have been applied.');
        }
      } catch (e) {
        explicitPairError = String(e.message || e);
        warnings.push('[WARNING] Explicit list pairs are invalid or not ready: ' + explicitPairError);
      }
    }
    if (!safety.googleListIds.length) {
      warnings.push('[WARNING] SYNC_GOOGLE_LIST_IDS is not configured; syncAll and createTrigger will refuse to run.');
    }
    warnings.push('[WARNING] dryRunReport is a read-only inventory and configuration report; it does not preview task-level updates, deletions, or conflicts.');
    if (!safety.allowDeletions) {
      info.push('[INFO] SYNC_ALLOW_DELETIONS=false; task-deletion candidates will not be accumulated or advanced.');
    }
    if (!safety.allowTaskMoves) {
      info.push('[INFO] SYNC_ALLOW_TASK_MOVES=false; Google cross-list moves will be blocked.');
    }
    if (!safety.allowListDeletions) {
      info.push('[INFO] SYNC_ALLOW_LIST_DELETIONS=false; list-deletion candidates will not be accumulated or advanced.');
    }
    if (listDeletionModeError_(safety)) {
      warnings.push('[WARNING] SYNC_ALLOW_LIST_DELETIONS=true is allowed only in auto mode; syncAll will durably pause existing list journals before refusing to run.');
    }
    const faults = [];
    Object.keys(state.listFaults.ms).forEach(function(msId) {
      const f = state.listFaults.ms[msId];
      faults.push(Object.assign({ side: 'microsoft', msListId: msId }, f));
      warnings.push('[WARNING] List isolated: Microsoft ' + msId + ' (Google: ' + (f.gListTitle || f.gListId || 'Unknown') + '). syncAll will skip it.');
    });
    Object.keys(state.listFaults.g).forEach(function(gId) {
      const f = state.listFaults.g[gId];
      faults.push(Object.assign({ side: 'google', gListId: gId }, f));
      warnings.push('[WARNING] List isolated: Google ' + (f.gListTitle || gId) + '. syncAll will skip it.');
    });
    const explicitPairByGoogle = {};
    explicitPairConfig.pairs.forEach(function(pair) {
      explicitPairByGoogle[pair.googleListId] = pair.microsoftListId;
    });
    const googleListsWithoutMapping = gLists.filter(function(list) {
      return !state.listMap[list.id] && !isGListFaulted_(state, list.id);
    }).map(function(list) {
      let nextSyncAction = 'CREATE_MICROSOFT_LIST';
      if (explicitPairRaw) {
        nextSyncAction = !explicitPairError && explicitPairByGoogle[list.id]
          ? 'APPLY_EXPLICIT_PAIR_FIRST'
          : 'BLOCKED_BY_EXPLICIT_PAIR_CONFIG';
      }
      return {
        id: list.id,
        title: list.title || '(Untitled list)',
        microsoftListId: explicitPairByGoogle[list.id] || null,
        nextSyncAction: nextSyncAction
      };
    });
    googleListsWithoutMapping.forEach(function(item) {
      if (item.nextSyncAction === 'CREATE_MICROSOFT_LIST') {
        actions.push('[ACTION] The next syncAll will create a Microsoft list: ' + item.title);
      } else if (item.nextSyncAction === 'APPLY_EXPLICIT_PAIR_FIRST') {
        actions.push('[ACTION] Google list "' + item.title + '" must first apply an explicit Microsoft list ID pair.');
      } else {
        actions.push('[ACTION] Google list "' + item.title + '" is safely blocked by an invalid explicit-pair configuration.');
      }
    });
    const possibleNameCollisions = [];
    if (!ALLOW_NAME_PAIRING && !explicitPairRaw) {
      gLists.forEach(function(gList) {
        const same = msLists.filter(function(ms) { return ms.displayName === gList.title; });
        if (same.length && !state.listMap[gList.id]) {
          possibleNameCollisions.push({
            googleListTitle: gList.title || '(Untitled list)',
            microsoftListTitles: same.map(function(x) { return x.displayName; }),
            note: 'ALLOW_NAME_PAIRING=false, so no automatic pairing will occur; the next syncAll will create a new Microsoft list.'
          });
        }
      });
      possibleNameCollisions.forEach(function(item) {
        info.push('[INFO] Google list "' + item.googleListTitle + '" has a Microsoft list with the same name, but they will not be paired automatically.');
      });
    }
  let gTaskCount = 0;
  let msTaskCount = 0;
  const explicitMoveInventory = {
    gTasksById: {},
    msTasksById: {},
    gListByTask: {},
    msListByTask: {}
  };
  gLists.forEach(function(list) {
      if (isGListFaulted_(state, list.id)) return;
      try {
      const tasks = getGTasks_(list.id);
      gTaskCount += tasks.length;
      tasks.forEach(function(task) {
        explicitMoveInventory.gTasksById[task.id] = task;
        explicitMoveInventory.gListByTask[task.id] = list.id;
      });
      } catch (e) {
        if (isNotFoundError_(e)) {
          warnings.push('[WARNING] Google list ' + (list.title || list.id) + ' is unreadable and may be missing.');
          return;
        }
        throw e;
      }
    });
    const candidateMsIds = Object.keys(state.listMap).map(function(gId) {
      if (!selectedGListIds[gId]) return null;
      if (isGListFaulted_(state, gId)) return null;
      const msId = state.listMap[gId];
      if (!msId || isMsListFaulted_(state, msId)) return null;
      return msId;
    }).filter(Boolean);
    if (!explicitPairError) {
      explicitPairConfig.pairs.forEach(function(pair) {
        if (selectedGListIds[pair.googleListId]) candidateMsIds.push(pair.microsoftListId);
      });
    }
    const mappedMsIds = Array.from(new Set(candidateMsIds));
  mappedMsIds.forEach(function(msListId) {
    try {
      const tasks = getMsTasks_(msListId);
      msTaskCount += tasks.length;
      tasks.forEach(function(task) {
        explicitMoveInventory.msTasksById[task.id] = task;
        explicitMoveInventory.msListByTask[task.id] = msListId;
      });
      } catch (e) {
        if (isNotFoundError_(e)) {
          warnings.push('[WARNING] Microsoft list ' + msListId + ' is unreadable and may be missing.');
          return;
        }
        throw e;
    }
  });
  appendTaskMovePreview_(state, explicitMoveInventory, safety, actions, warnings, pendingMoves);
  const report = {
      warnings: warnings,
      actions: actions,
      info: info,
      pendingMoves: pendingMoves,
      pendingMoveSummary: finalizePendingMovePreview_(pendingMoves),
      faults: faults,
      googleListsWithoutMapping: googleListsWithoutMapping,
      possibleNameCollisions: possibleNameCollisions,
      explicitListPairsConfigured: !!explicitPairRaw,
      explicitListPairs: explicitPairDetails,
      explicitListPairError: explicitPairError,
      googleListsSelected: gLists.length,
      googleListsTotal: allGLists.length,
      configuredGoogleListIds: safety.googleListIds,
      deletionsEnabled: safety.allowDeletions,
      taskMovesEnabled: safety.allowTaskMoves,
      roundFence: roundFence,
      taskDeletion: taskDeletionObservability_(state, safety),
      listDeletion: listDeletionObservability_(state, safety),
      microsoftLists: msLists.length,
      googleTasks: gTaskCount,
      microsoftTasksInMappedLists: msTaskCount,
      mappedPairs: Object.keys(state.g2m).length,
      note: 'Read-only inventory and configuration report; no lists or tasks are created, updated, or deleted.'
    };
  console.log(JSON.stringify(report, null, 2));
  return report;
  });
}

function createTrigger() {
  initializeExecutionBudget_();
  const safety = getSafetyConfig_();
  requireSyncAllowlist_(safety);
  requireConfiguredListPairsApplied_(loadStateForSync_(), safety);
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(SYNC_TRIGGER_INTERVAL_MINUTES).create();
  console.log('[Trigger] Created a sync every ' + SYNC_TRIGGER_INTERVAL_MINUTES +
    ' minutes; each run has a 5.25-minute budget, and overlaps are safely skipped by the global lock.');
}

function deleteSyncTriggers() {
  initializeExecutionBudget_();
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(trigger);
  });
}

function inspectSyncState() {
  const roundFence = syncRoundFenceStatus_();
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    console.log(JSON.stringify({
      error: 'STATE_CORRUPT',
      roundFence: roundFence,
      note: 'State exists but cannot be read. Run exportRawSyncState() and pause syncing.'
    }, null, 2));
    return;
  }
  const state = loaded.state;
  const safety = getSafetyConfig_();
  console.log(JSON.stringify({
    updatedAt: state.updatedAt,
    health: state.health,
    lists: Object.keys(state.listMap).length,
    mappings: Object.keys(state.g2m).length,
    googleTombstones: Object.keys(state.tombstones.g).length,
    microsoftTombstones: Object.keys(state.tombstones.m).length,
    taskDeletion: taskDeletionObservability_(state, safety),
    taskMoves: taskMoveObservability_(state),
    listDeletion: listDeletionObservability_(state, safety),
    googleListFaults: Object.keys(state.listFaults.g).length,
    microsoftListFaults: Object.keys(state.listFaults.ms).length,
    roundFence: roundFence
  }, null, 2));
}

// Move-journal operations are deliberately two-stage.  The Script Property is
// an auditable operator request, preview creates a token from fresh live
// evidence, and apply obtains that evidence again before changing only local
// state.  None of these helpers creates, updates, or deletes provider data.

function inspectTaskMoveJournals() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('MOVE_OPERATION');
    const state = loadStateForSync_();
    const journals = taskMoveJournalEntries_(state).map(taskMoveJournalPublic_);
    const report = {
      journalCount: journals.length,
      journals: journals,
      taskMoves: taskMoveObservability_(state),
      note: 'This report shows only opaque refs and bounded evidence. First back up with exportRawSyncState(), then set SYNC_TASK_MOVE_OPERATION_JSON and call previewTaskMoveJournalOperation().'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function inspectTaskCreateBatch() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('TASK_CREATE_OPERATION');
    const state = loadStateForSync_();
    const batch = state.taskCreateBatch;
    const progress = batch ? taskCreateProgressRead_(batch) : { batchId: null, boundary: null, entries: {} };
    const report = {
      active: !!batch,
      batchId: batch ? batch.batchId : null,
      direction: batch ? batch.direction : null,
      phase: batch ? batch.phase : null,
      itemCount: batch ? batch.items.length : 0,
      boundary: progress.boundary,
      entries: progress.entries,
      note: 'Read-only report. Set SYNC_TASK_CREATE_OPERATION_JSON and call previewTaskCreateBatchOperation() before any operator action.'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function previewTaskCreateBatchOperation() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('TASK_CREATE_OPERATION');
    const operation = parseTaskCreateOperation_(false);
    const state = loadStateForSync_();
    const entry = taskCreateOperationEntry_(state, operation);
    const progress = taskCreateProgressRead_(entry.batch);
    const evidence = taskCreateOperationEvidence_(entry);
    const token = taskCreateOperationDigest_(operation, entry, evidence);
    const held = progress.boundary === entry.index && progress.entries[entry.index] &&
      ['HELD_ZERO', 'HELD_MULTI'].indexOf(progress.entries[entry.index].status) >= 0;
    const ok = operation.action === 'RESOLVE_EXISTING'
      ? evidence.candidateIds.length === 1 && evidence.candidateIds[0] === operation.destinationId &&
        progress.boundary === entry.index
      : held && evidence.candidateIds.length === 0;
    const report = { action: operation.action, batchId: entry.batch.batchId, index: entry.index,
      ok: ok, code: ok ? 'READY' : 'NOT_SAFE', candidateIds: evidence.candidateIds,
      inventoryComplete: evidence.inventoryComplete, previewToken: token,
      note: 'Apply rereads complete live evidence under the global lock; no provider mutation occurs in preview.' };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function applyTaskCreateBatchOperation() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('TASK_CREATE_OPERATION');
    const operation = parseTaskCreateOperation_(true);
    const state = loadStateForSync_();
    const entry = taskCreateOperationEntry_(state, operation);
    const progress = taskCreateProgressRead_(entry.batch);
    const evidence = taskCreateOperationEvidence_(entry);
    if (operation.previewToken !== taskCreateOperationDigest_(operation, entry, evidence)) {
      throw new Error('TASK_CREATE_OPERATION_STALE_PREVIEW: Live evidence changed; preview again.');
    }
    const held = progress.boundary === entry.index && progress.entries[entry.index] &&
      ['HELD_ZERO', 'HELD_MULTI'].indexOf(progress.entries[entry.index].status) >= 0;
    if (operation.action === 'RESOLVE_EXISTING') {
      if (evidence.candidateIds.length !== 1 || evidence.candidateIds[0] !== operation.destinationId ||
          progress.boundary !== entry.index) {
        throw new Error('TASK_CREATE_OPERATION_NOT_SAFE: exact destination marker verification failed.');
      }
      progress.entries[entry.index] = { status: 'ACKED', destinationId: operation.destinationId };
      if (progress.boundary === entry.index) delete progress.boundary;
    } else {
      if (!held || evidence.candidateIds.length !== 0) {
        throw new Error('TASK_CREATE_OPERATION_NOT_SAFE: release requires a held boundary and zero exact candidates.');
      }
      progress.entries[entry.index] = { status: 'REPOST_ALLOWED' };
      delete progress.boundary;
    }
    taskCreateProgressWrite_(progress);
    const report = { action: operation.action, batchId: entry.batch.batchId, index: entry.index,
      destinationId: operation.action === 'RESOLVE_EXISTING' ? operation.destinationId : null,
      ok: true, note: 'Operator sidecar action applied; the next syncAll performs the bounded recovery.' };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function previewTaskMoveJournalOperation() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('MOVE_OPERATION');
    const operation = parseTaskMoveOperation_(false);
    const state = loadStateForSync_();
    const entry = resolveTaskMoveJournalRef_(state, operation.journalRef);
    if (entry.revision !== operation.revision) {
      throw new Error('MOVE_OPERATION_STALE_REVISION: Journal changed; inspect it again.');
    }
    const evidence = taskMoveOperationLiveEvidence_(state, entry);
    const plan = taskMoveOperationPlan_(operation, entry, evidence);
    const previewToken = taskMoveOperationEvidenceDigest_(operation, entry, evidence);
    const report = taskMoveOperationPublicResult_(operation, entry, evidence, plan, previewToken);
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function applyTaskMoveJournalOperation() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('MOVE_OPERATION');
    const operation = parseTaskMoveOperation_(true);
    const state = loadStateForSync_();
    const entry = resolveTaskMoveJournalRef_(state, operation.journalRef);
    if (entry.revision !== operation.revision) {
      throw new Error('MOVE_OPERATION_STALE_REVISION: Journal changed; inspect and preview it again.');
    }
    const evidence = taskMoveOperationLiveEvidence_(state, entry);
    const liveToken = taskMoveOperationEvidenceDigest_(operation, entry, evidence);
    if (operation.previewToken !== liveToken) {
      throw new Error('MOVE_OPERATION_STALE_PREVIEW: Live evidence changed; preview again.');
    }
    const plan = taskMoveOperationPlan_(operation, entry, evidence);
    if (!plan.ok) throw new Error('MOVE_OPERATION_NOT_SAFE: ' + boundedMoveReason_(plan.code));
    // Receipt first.  A receipt failure leaves the loaded state untouched and
    // cannot result in a provider mutation because this API is journal-only.
    saveTaskMoveOperationReceipt_(operation, entry, state);
    if (operation.action === 'resume') {
      delete entry.journal.lastBlockedReason;
      delete entry.journal.lastBlockedAt;
      if (entry.journal.phase === 'creating' || entry.journal.phase === 'retry_create') {
        entry.journal.uncertainConfirmations = 0;
        entry.journal.lastRoundId = null;
      }
    } else if (operation.action === 'cancel') {
      delete state.taskMoveJournal[entry.gId];
      delete state.taskDeletionConflicts[entry.gId];
    } else {
      entry.journal.newMsId = plan.candidate.id;
      entry.journal.phase = 'created';
      entry.journal.uncertainConfirmations = 0;
      entry.journal.lastRoundId = null;
      delete entry.journal.lastBlockedReason;
      delete entry.journal.lastBlockedAt;
    }
    normalizeState_(state);
    saveState_(state);
    const report = taskMoveOperationPublicResult_(operation, entry, evidence, plan, liveToken);
    report.applied = true;
    report.note = 'Only the local move journal was updated; the next syncAll will revalidate before it may change the provider.';
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function healthCheck() {
  initializeExecutionBudget_();
  const issues = [];
  const roundFence = syncRoundFenceStatus_();
  let safety;
  try {
    safety = getSafetyConfig_();
  } catch (e) {
    const report = {
      ok: false,
      issues: [boundedSafetyConfigIssue_(e)],
      health: null,
      taskDeletion: null,
      taskMoves: null,
      listDeletion: null,
      listTombstoneIntegrityIssues: [],
      listTombstoneIntegrityIssueCount: 0,
      roundFence: roundFence
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  if (!isAutoDiscoveryMode_(safety) && !safety.googleListIds.length) {
    issues.push('SYNC_GOOGLE_LIST_IDS is not configured; syncing and triggers are currently safety-locked.');
  }
  try {
    const auth = microsoftAuth_();
    if (!auth.hasAccess()) {
      issues.push(auth.mode === MS_AUTH_MODE_PERSONAL_ ?
        'MICROSOFT_PERSONAL_AUTH_REQUIRED: Open the setup wizard or run startAuthorization().' :
        'MICROSOFT_ADVANCED_AUTH_REQUIRED: Run resetMicrosoftAuthorization(), then startAuthorization().');
    }
  } catch (e) {
    const stableCode = String(e && e.message || '').indexOf('MICROSOFT_AUTH_MODE_INVALID') === 0 ?
      'MICROSOFT_AUTH_MODE_INVALID' : 'MICROSOFT_AUTH_CHECK_FAILED';
    issues.push(stableCode + ': Microsoft authorization configuration is not ready.');
  }
  const triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'syncAll';
  });
  if (!triggers.length) {
    issues.push('No syncAll trigger exists. Run createTrigger().');
  }
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    issues.push('State is corrupted: STATE_CORRUPT. Run exportRawSyncState() and pause syncing.');
  }
  const state = loaded.state;
  try {
    requireConfiguredListPairsApplied_(state, safety);
  } catch (e) {
    issues.push('Explicit list pairs are not ready: ' + e.message);
  }
  const faultCount = Object.keys(state.listFaults.g).length + Object.keys(state.listFaults.ms).length;
  if (faultCount) {
    issues.push(faultCount + ' lists are isolated. Run listSyncFaults().');
  }
  const taskDeletion = taskDeletionObservability_(state, safety);
  const taskMoves = taskMoveObservability_(state);
  const listDeletion = listDeletionObservability_(state, safety);
  if (listDeletionModeError_(safety)) {
    issues.push('SYNC_ALLOW_LIST_DELETIONS=true can be used only in auto mode; syncing will pause existing list journals first.');
  }
  if (listDeletion.journalPhases.orphan || listDeletion.journalPhases.blocked) {
    issues.push((listDeletion.journalPhases.orphan + listDeletion.journalPhases.blocked) +
      ' list-deletion journals cannot safely continue.');
  }
  const listTombstoneIntegrityIssues = loaded.listTombstoneIntegrityIssues ||
    listTombstoneIntegrityIssues_(state);
  if (listTombstoneIntegrityIssues.length) {
    issues.push(listTombstoneIntegrityIssues.length +
      ' list tombstone integrity errors (including bidirectional and alias symmetry checks); automatic recreation is conservatively blocked.');
  }
  if (taskDeletion.orphanDeletionJournals) {
    issues.push(taskDeletion.orphanDeletionJournals +
      ' deletion journals lack mappings; automatic creation is safely blocked. Restore or inspect state manually first.');
  }
  if (taskDeletion.blockedDeletionJournals) {
    issues.push(taskDeletion.blockedDeletionJournals +
      ' deletion journals have incomplete list pairing or inventory; they are isolated and will not delete.');
  }
  if (taskMoves.blockedJournals) {
    issues.push(taskMoves.blockedJournals +
      ' task-move journals are safely blocked. Run inspectTaskMoveJournals().');
  }
  if (taskMoves.legacyWithoutCorrelation) {
    issues.push(taskMoves.legacyWithoutCorrelation +
      ' legacy task-move journals have no correlation marker; they will not be adopted or recreated automatically. Run inspectTaskMoveJournals().');
  }
  if (roundFence.active) {
    issues.push('An unfinished sync-round safety fence exists; the next syncAll will verify final commit or preserve baseline proof before recovering safely.');
  }
  const report = {
    ok: issues.length === 0,
    issues: issues,
    health: state.health,
    taskDeletion: taskDeletion,
    taskMoves: taskMoves,
    listDeletion: listDeletion,
    // These are bounded reason codes, deliberately not IDs or names.  Keeping
    // both directional codes visible makes a one-sided reservation diagnosable
    // without exposing task/list contents in a health report.
    listTombstoneIntegrityIssues: listTombstoneIntegrityIssues,
    listTombstoneIntegrityIssueCount: listTombstoneIntegrityIssues.length,
    roundFence: roundFence
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function exportSyncState() {
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    console.error('[Export] State is corrupted. Use exportRawSyncState() instead.');
    console.log(JSON.stringify({ error: 'STATE_CORRUPT' }, null, 2));
    return;
  }
  console.log(JSON.stringify(loaded.state, null, 2));
}

function exportRawSyncState() {
  const props = PropertiesService.getUserProperties();
  const all = props.getProperties();
  const raw = {};
  Object.keys(all).forEach(function(key) {
    if (key === STATE_KEY + '_manifest' || key === SUCCESSFUL_ROUND_MANIFEST_KEY ||
        key === TASK_CREATE_PROGRESS_KEY ||
        key === ROUND_FENCE_KEY || key.indexOf(STATE_KEY + '_gen_') === 0) {
      raw[key] = all[key];
    }
  });
  const bundle = {
    warning: 'SENSITIVE_STATE_EXPORT: handle this raw state as private data and do not share it.',
    exportedAt: new Date().toISOString(),
    properties: raw
  };
  console.warn('[Export] WARNING: raw state may contain sensitive provider data or OAuth state.');
  console.log(JSON.stringify(bundle, null, 2));
  return bundle;
}

function restorePreviousSyncState() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('STATE_RESTORE');
    const current = loadStateForSync_();
    assertNoAnyDeletionJournals_(current, 'STATE_RESTORE');
    const props = PropertiesService.getUserProperties();
    const successful = successfulRoundManifest_(props);
    if (!successful) {
      throw new Error('STATE_RESTORE_UNAVAILABLE: No verifiable successful-sync-round snapshot exists yet.');
    }
    const currentGeneration = currentStateGeneration_(props);
    // If the main state is the current successful final commit, restore the
    // prior successful commit. Otherwise it is a failed/catch checkpoint and
    // recovery returns to the most recent successful commit.
    const target = currentGeneration === successful.current.generation ? successful.previous : successful.current;
    if (!target) {
      throw new Error('STATE_RESTORE_UNAVAILABLE: No earlier successful sync round is available to restore.');
    }
    const previous = loadStateGeneration_(props, target.generation, 'STATE_RESTORE_CORRUPT');
    assertNoAnyDeletionJournals_(previous, 'STATE_RESTORE');
    assertTombstoneEvidencePreserved_(current, previous);
    assertActiveDeletionEvidencePreserved_(current, previous);
    saveState_(previous);
    console.log('[Restore] Target successful sync round copied to current state. Run dryRunReport() first.');
  });
}

function importSyncState(jsonString) {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('IMPORT');
    const current = loadStateForSync_();
    assertNoAnyDeletionJournals_(current, 'IMPORT');
    let parsed;
    try {
      parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    } catch (e) {
      throw new Error('IMPORT_INVALID_JSON: Imported content is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('IMPORT_INVALID_STATE: Imported content must be a state JSON object.');
    }
    validateImportedState_(parsed);
    const normalized = normalizeState_(parsed);
    assertNoAnyDeletionJournals_(normalized, 'IMPORT');
    assertTombstoneEvidencePreserved_(current, normalized);
    assertActiveDeletionEvidencePreserved_(current, normalized);
    saveState_(normalized);
    console.log('[Import] State imported. Run dryRunReport() to confirm before enabling syncAll.');
  });
}

function listSyncFaults() {
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    console.log(JSON.stringify({
      error: 'STATE_CORRUPT',
      note: 'State exists but cannot be read. Run exportRawSyncState() and pause syncing.'
    }, null, 2));
    return;
  }
  const state = loaded.state;
  const faults = [];
  Object.keys(state.listFaults.ms).forEach(function(msId) {
    const f = state.listFaults.ms[msId];
    faults.push({
      side: 'microsoft',
      msListId: msId,
      reason: f.reason,
      at: f.at,
      googleListId: f.gListId || null,
      googleListTitle: f.gListTitle || null,
      affectedMappings: countAffectedMappings_(state, f.gListId || null, msId),
      suggestion: f.gListId
        ? 'Set Script Property REPAIR_GOOGLE_LIST_ID=' + f.gListId + ' first, then run repairFaultedListFromProperty().'
        : 'Google list ID is missing; keep the list isolated and inspect state manually first.'
    });
  });
  Object.keys(state.listFaults.g).forEach(function(gId) {
    const f = state.listFaults.g[gId];
    faults.push({
      side: 'google',
      gListId: gId,
      reason: f.reason,
      at: f.at,
      microsoftListId: f.msListId || null,
      microsoftListTitle: f.msListTitle || null,
      affectedMappings: countAffectedMappings_(state, gId, f.msListId || null),
      suggestion: 'Set Script Property REPAIR_GOOGLE_LIST_ID=' + gId + ' first, then run repairFaultedListFromProperty().'
    });
  });
  console.log(JSON.stringify({
    faultCount: faults.length,
    faults: faults,
    note: 'While lists are isolated, syncAll skips them and does not delete tasks.'
  }, null, 2));
}

function repairFaultedListByGoogleId(gListId) {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('REPAIR');
    const state = loadStateForSync_();
    const targets = [];
    Object.keys(state.listFaults.ms).forEach(function(msId) {
      const f = state.listFaults.ms[msId];
      if ((f.gListId || '') === gListId) {
        targets.push({ gListId: gListId, msListId: msId });
      }
    });
    if (state.listFaults.g[gListId]) {
      const msListId = resolveFaultedGoogleListPair_(state, gListId, state.listFaults.g[gListId]);
      targets.push({
        gListId: gListId,
        msListId: msListId
      });
    }
    if (!targets.length) {
      console.warn('[Repair] No fault found for Google list ID "' + gListId + '". Run listSyncFaults().');
      return;
    }
    const exactTargets = {};
    targets.forEach(function(target) {
      // An MS-side fault may itself carry a stale counterpart. Resolve it
      // against the current map/provenance too; conflicting evidence is not a
      // license to reset either pair.
      const msListId = resolveFaultedGoogleListPair_(state, target.gListId,
        target.msListId ? { msListId: target.msListId } : null);
      const key = listPairKey_(target.gListId, msListId || '');
      exactTargets[key] = { gListId: target.gListId, msListId: msListId };
    });
    const resolvedTargets = Object.keys(exactTargets).sort().map(function(key) { return exactTargets[key]; });
    // Preflight every affected exact pair before preservation/removal begins.
    // This avoids a second ambiguous/fenced target causing a partial repair.
    resolvedTargets.forEach(function(t) {
      assertNoDeletionJournalForListPair_(state, t.gListId, t.msListId);
      assertNoListLifecycleForPair_(state, t.gListId, t.msListId);
    });
    resolvedTargets.forEach(function(t) {
      resetListPairing_(state, t.gListId, t.msListId);
    });
    normalizeState_(state);
    saveState_(state);
    console.log('[Repair] Reset pairing for Google list ID "' + gListId + '".');
    console.log('[Repair] If SYNC_LIST_PAIRS_JSON is configured, validate and apply it again; otherwise the next round may create a new list. Run dryRunReport() first.');
  });
}

function repairFaultedListFromProperty() {
  initializeExecutionBudget_();
  const gListId = PropertiesService.getScriptProperties().getProperty('REPAIR_GOOGLE_LIST_ID');
  if (!gListId) {
    throw new Error('Set REPAIR_GOOGLE_LIST_ID in Script Properties first.');
  }
  return repairFaultedListByGoogleId(gListId);
}

function clearAllListFaultsAndPrepareResync() {
  initializeExecutionBudget_();
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('REPAIR');
    const state = loadStateForSync_();
    const faultedG = {};
    const faultedMs = {};
    Object.keys(state.listFaults.g).forEach(function(gId) {
      faultedG[gId] = true;
      const f = state.listFaults.g[gId];
      if (f && f.msListId) faultedMs[f.msListId] = true;
    });
    Object.keys(state.listFaults.ms).forEach(function(msId) {
      faultedMs[msId] = true;
      const f = state.listFaults.ms[msId];
      if (f && f.gListId) faultedG[f.gListId] = true;
    });
    // Preflight before clearing any mapping/fault.  A prepared/paused journal
    // is durable evidence of a remote-delete intent and losing it could let a
    // later resync recreate the already deleted task.
    Object.keys(state.deletionJournal || {}).forEach(function(gTaskId) {
      const journal = state.deletionJournal[gTaskId];
      const mapping = state.g2m[gTaskId];
      if (journal && (faultedG[journal.gListId] || faultedMs[journal.msListId] ||
          (mapping && (faultedG[mapping.gListId] || faultedMs[mapping.msListId])))) {
        throw new Error('REPAIR_DELETION_JOURNAL_PENDING: Complete or manually inspect the deletion journal before clearing all faults. task=' + gTaskId);
      }
    });
    Object.keys(state.listMap).forEach(function(gListId) {
      const msListId = state.listMap[gListId];
      if (faultedG[gListId] || faultedMs[msListId]) {
        assertNoListLifecycleForPair_(state, gListId, msListId);
      }
    });
    Object.keys(state.listMap).forEach(function(gListId) {
      const msListId = state.listMap[gListId];
      if (faultedG[gListId] || faultedMs[msListId]) {
        preserveListPairMetaForRepair_(state, gListId, msListId);
      }
    });
    Object.keys(state.g2m).forEach(function(gTaskId) {
      const rec = state.g2m[gTaskId];
      if (!rec) return;
      if (faultedG[rec.gListId] || faultedMs[rec.msListId]) {
        removeMapping_(state, gTaskId, rec.msId);
      }
    });
    Object.keys(state.listMap).forEach(function(gListId) {
      const msListId = state.listMap[gListId];
      if (faultedG[gListId] || faultedMs[msListId]) {
        delete state.listMap[gListId];
      }
    });
    state.listFaults = { g: {}, ms: {} };
    normalizeState_(state);
    saveState_(state);
    console.log('[Repair] Cleared all list-fault markers and reset pairing for affected lists.');
    console.log('[Repair] If SYNC_LIST_PAIRS_JSON is configured, validate and apply it again; otherwise the next round will be handled as an initial sync.');
    console.log('[Repair] Without explicit pairing, this may create new lists or duplicate tasks. Run dryRunReport() first to confirm.');
  });
}
