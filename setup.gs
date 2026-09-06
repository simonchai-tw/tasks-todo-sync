function setupSafePropertyStatus_(properties, key, expected) {
  const stored = properties.getProperty(key);
  const missing = stored === null || typeof stored === 'undefined';
  const raw = missing ? '' : String(stored);
  const normalized = key === 'SYNC_LIST_DISCOVERY_MODE'
    ? raw.trim().toLowerCase()
    : raw.toLowerCase();
  const valid = key === 'SYNC_LIST_DISCOVERY_MODE'
    ? normalized === 'auto' || normalized === 'explicit'
    : normalized === 'true' || normalized === 'false';
  const matchesPublicDefault = valid && normalized === expected;
  return {
    value: missing ? 'Not configured' : (valid ? normalized : 'Invalid configuration'),
    expected: expected,
    // Keep correct as the legacy public-default comparison. Consumers that
    // need to distinguish a valid override can use valid and
    // matchesPublicDefault.
    correct: matchesPublicDefault,
    valid: valid,
    matchesPublicDefault: matchesPublicDefault
  };
}

function setupTriggerCount_() {
  if (typeof ScriptApp === 'undefined' || !ScriptApp ||
      typeof ScriptApp.getProjectTriggers !== 'function') {
    return { count: 0, available: false };
  }
  try {
    const triggers = ScriptApp.getProjectTriggers();
    if (!Array.isArray(triggers)) return { count: 0, available: false };
    let count = 0;
    triggers.forEach(function(trigger) {
      try {
        if (trigger && typeof trigger.getHandlerFunction === 'function' &&
            trigger.getHandlerFunction() === 'syncAll') count += 1;
      } catch (e) {
        // A malformed or restricted trigger mock is not allowed to leak its
        // error text into this bounded report.
      }
    });
    return { count: count, available: true };
  } catch (e) {
    return { count: 0, available: false };
  }
}

function setupWizardPersonalAuthView_(result) {
  const source = result && typeof result === 'object' ? result : {};
  const rawStatus = String(source.status || 'unknown');
  const allowedStatuses = {
    authorized: true,
    pending: true,
    not_started: true,
    invalid_session: true,
    expired: true,
    declined: true,
    cancelled: true,
    cleared: true,
    advanced: true,
    ready: true,
    confirmation_required: true,
    verification_required: true,
    verification_failed: true
  };
  const status = allowedStatuses[rawStatus] ? rawStatus : 'unknown';
  const view = { status: status };
  if (source.mode === MS_AUTH_MODE_PERSONAL_ || source.mode === MS_AUTH_MODE_ADVANCED_) {
    view.mode = String(source.mode);
  }
  if (source.verified === true) view.verified = true;
  const allowedMessageCodes = {
    CANCEL_ONLY_STOPS_LOCAL_POLLING: true,
    MICROSOFT_PERSONAL_VERIFY_RETRY: true,
    MICROSOFT_PERSONAL_VERIFY_UNAUTHORIZED: true,
    MICROSOFT_PERSONAL_VERIFY_FORBIDDEN: true,
    MICROSOFT_PERSONAL_VERIFY_FAILED: true,
    MICROSOFT_PERSONAL_REAUTH_REQUIRED: true
  };
  if (allowedMessageCodes[String(source.messageCode || '')]) {
    view.messageCode = String(source.messageCode);
  }
  if (allowedMessageCodes[String(source.errorCode || '')]) {
    view.errorCode = String(source.errorCode);
  }
  if (source.confirmationRequired === true) view.confirmationRequired = true;
  if (source.userCode && source.verificationUri &&
      validMicrosoftVerificationUri_(source.verificationUri)) {
    view.userCode = String(source.userCode).slice(0, 100);
    view.verificationUri = String(source.verificationUri);
  }
  const expiresAt = Number(source.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) view.expiresAt = expiresAt;
  const retryAfterMs = Number(source.retryAfterMs);
  const intervalSec = Number(source.intervalSec);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    view.retryAfterMs = Math.min(retryAfterMs, 300000);
  } else if (Number.isFinite(intervalSec) && intervalSec >= 5) {
    view.retryAfterMs = Math.min(intervalSec * 1000, 300000);
  }
  return view;
}
