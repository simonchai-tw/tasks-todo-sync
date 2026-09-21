/**
 * Tasks-ToDo-Sync: Windows Companion Desktop Endpoint (companion.gs)
 *
 * Provides a lightweight, secure zero-sleep HTTP POST API for the Windows
 * Companion application. Authenticated via a local SHA-256 pre-shared key hash
 * uploaded during deployment (companion_auth.gs).
 */

function doPost(e) {
  // 1. Safe JSON parsing with zero-sleep fast-fail.
  // Malformed JSON must NOT increment AUTH_FAIL_COUNT (prevents denial-of-service lockout).
  if (!e || !e.postData || !e.postData.contents) {
    return companionJsonResponse_({ ok: false, error: 'BAD_REQUEST' });
  }

  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return companionJsonResponse_({ ok: false, error: 'BAD_REQUEST' });
  }

  if (!payload || typeof payload !== 'object') {
    return companionJsonResponse_({ ok: false, error: 'BAD_REQUEST' });
  }

  // 2. Fast-fail rate limiting (< 20ms, zero sleep to conserve quota)
  const cache = CacheService.getScriptCache();
  const failCount = Number(cache.get('AUTH_FAIL_COUNT') || '0');
  if (failCount >= 5) {
    return companionJsonResponse_({ ok: false, error: 'RATE_LIMITED' });
  }

  // 3. Constant-time hash verification
  if (!verifyCompanionKeyHash_(payload.apiKey)) {
    cache.put('AUTH_FAIL_COUNT', String(failCount + 1), 900); // 15-minute cooldown
    return companionJsonResponse_({ ok: false, error: 'UNAUTHORIZED' });
  }
  cache.remove('AUTH_FAIL_COUNT');

  // 4. Decommissioned / Disabled check
  const props = PropertiesService.getScriptProperties();
  const isCompanionDisabled = (props.getProperty('COMPANION_DISABLED') === 'true');
  const action = String(payload.action || '');

  // When unbound/disabled, reject all actions except 'bootstrap' (which re-enables)
  if (isCompanionDisabled && action !== 'bootstrap') {
    return companionJsonResponse_({
      ok: false,
      error: 'COMPANION_DISABLED',
      message: 'Companion endpoint is currently disabled. Run bootstrap to re-enable.'
    });
  }

  // 5. Action routing
  switch (action) {
    case 'ping':
      return companionJsonResponse_({ ok: true, version: '2.4.0' });

    case 'bootstrap':
      return companionJsonResponse_(handleCompanionBootstrap_());

    case 'get_status':
      return companionJsonResponse_(handleCompanionGetStatus_());

    case 'trigger_sync':
      return companionJsonResponse_(handleCompanionTriggerSync_());

    case 'update_settings':
      return companionJsonResponse_(handleCompanionUpdateSettings_(payload.settings));

    case 'unbind':
      return companionJsonResponse_(handleCompanionUnbind_());

    default:
      return companionJsonResponse_({ ok: false, error: 'UNKNOWN_ACTION' });
  }
}

function companionJsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function verifyCompanionKeyHash_(inputKey) {
  if (!inputKey || typeof inputKey !== 'string') return false;
  if (typeof COMPANION_KEY_HASH === 'undefined' || !COMPANION_KEY_HASH) return false;

  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, inputKey, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    let b = digest[i];
    if (b < 0) b += 256;
    hex += ('0' + b.toString(16)).slice(-2);
  }

  if (hex.length !== COMPANION_KEY_HASH.length) return false;
  let result = 0;
  for (let i = 0; i < hex.length; i++) {
    result |= (hex.charCodeAt(i) ^ COMPANION_KEY_HASH.charCodeAt(i));
  }
  return result === 0;
}

function handleCompanionBootstrap_() {
  try {
    const props = PropertiesService.getScriptProperties();
    // Clear disabled flag if previously unbound
    props.deleteProperty('COMPANION_DISABLED');

    // Only fills missing safe defaults; never overwrites existing user configurations
    if (typeof initializeSafeDefaults === 'function') {
      initializeSafeDefaults();
    }

    // Idempotent trigger creation: only creates trigger if syncAll trigger does not exist
    const triggerInfo = (typeof setupTriggerCount_ === 'function') ? setupTriggerCount_() : { count: 0 };
    if (triggerInfo.count === 0 && typeof createTrigger === 'function') {
      createTrigger();
    }

    return { ok: true, message: 'Bootstrap successful: defaults initialized, triggers verified, and endpoint active.' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function handleCompanionGetStatus_() {
  try {
    const status = (typeof setupStatus === 'function') ? setupStatus() : {};
    let lastRunAt = null;
    let health = 'unknown';
    let listsCount = 0;
    let mappingsCount = 0;

    if (typeof loadStateForInspection_ === 'function') {
      const loaded = loadStateForInspection_();
      if (loaded && loaded.state) {
        lastRunAt = loaded.state.updatedAt || null;
        health = loaded.state.health || 'unknown';
        listsCount = loaded.state.listMap ? Object.keys(loaded.state.listMap).length : 0;
        mappingsCount = loaded.state.g2m ? Object.keys(loaded.state.g2m).length : 0;
      }
    }

    const triggerInfo = (typeof setupTriggerCount_ === 'function') ? setupTriggerCount_() : { count: 0 };
    const props = PropertiesService.getScriptProperties();

    return {
      ok: true,
      telemetry: {
        lastRunAt: lastRunAt,
        health: health,
        listsCount: listsCount,
        mappingsCount: mappingsCount
      },
      auth: {
        googleConnected: true,
        msConnected: status.microsoftAuthorized === true
      },
      triggerActive: triggerInfo.count > 0,
      settings: {
        alertEmail: props.getProperty('ALERT_EMAIL') || '',
        allowDeletions: props.getProperty('SYNC_ALLOW_DELETIONS') || 'true',
        allowListDeletions: props.getProperty('SYNC_ALLOW_LIST_DELETIONS') || 'true',
        allowTaskMoves: props.getProperty('SYNC_ALLOW_TASK_MOVES') || 'false',
        discoveryMode: props.getProperty('SYNC_LIST_DISCOVERY_MODE') || 'auto',
        excludedLists: props.getProperty('SYNC_EXCLUDED_LIST_NAMES') || ''
      }
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function handleCompanionTriggerSync_() {
  const cache = CacheService.getScriptCache();
  const cooldown = cache.get('TRIGGER_SYNC_COOLDOWN');
  if (cooldown) {
    return { ok: false, error: 'COOLDOWN', message: 'Sync was recently triggered. Please wait 2 minutes before triggering again.' };
  }

  try {
    const triggers = ScriptApp.getProjectTriggers();
    let alreadyScheduled = false;
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'companionSyncOnce') {
        alreadyScheduled = true;
        break;
      }
    }

    if (!alreadyScheduled) {
      ScriptApp.newTrigger('companionSyncOnce')
        .timeBased()
        .after(1000)
        .create();
    }

    cache.put('TRIGGER_SYNC_COOLDOWN', '1', 120);
    return { ok: true, message: 'One-off sync trigger successfully queued (executes in cloud within ~1 minute).' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function companionSyncOnce() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'companionSyncOnce') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (err) {
    console.error('Failed to clean up companionSyncOnce trigger: ' + err);
  }

  if (typeof syncAll === 'function') {
    syncAll();
  }
}

function handleCompanionUpdateSettings_(settings) {
  if (!settings || typeof settings !== 'object') {
    return { ok: false, error: 'INVALID_SETTINGS_PAYLOAD' };
  }

  const allowed = {
    ALERT_EMAIL: function(v) { return typeof v === 'string' && (v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)); },
    SYNC_ALLOW_DELETIONS: function(v) { return v === 'true' || v === 'false'; },
    SYNC_ALLOW_LIST_DELETIONS: function(v) { return v === 'true' || v === 'false'; },
    SYNC_ALLOW_TASK_MOVES: function(v) { return v === 'true' || v === 'false'; },
    SYNC_EXCLUDED_LIST_NAMES: function(v) { return typeof v === 'string' && v.length <= 500; }
  };

  const toSet = {};
  for (const key in allowed) {
    if (settings.hasOwnProperty(key) && allowed[key](settings[key])) {
      toSet[key] = String(settings[key]);
    }
  }

  if (Object.keys(toSet).length > 0) {
    PropertiesService.getScriptProperties().setProperties(toSet, false);
  }

  return { ok: true, updated: Object.keys(toSet) };
}

function handleCompanionUnbind_() {
  try {
    if (typeof deleteSyncTriggers === 'function') {
      deleteSyncTriggers();
    }

    // Clean up one-off triggers if any
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'companionSyncOnce') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    if (typeof microsoftAuth_ === 'function') {
      try {
        microsoftAuth_().reset();
      } catch (authErr) {
        console.warn('Reset microsoft auth warning: ' + authErr);
      }
    }

    // Mark endpoint as disabled so even with key, subsequent requests are rejected
    const props = PropertiesService.getScriptProperties();
    props.setProperty('COMPANION_DISABLED', 'true');

    return {
      ok: true,
      message: 'Unbound successfully: sync triggers removed, credentials reset, and endpoint disabled.',
      note: 'GAS project and Web App deployment remain in your Google Drive; you may delete them from script.google.com if desired.'
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
