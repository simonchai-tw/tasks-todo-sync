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

// Wizard-facing health summaries must never carry task names, IDs, or tokens.
function boundedWizardHealth_(report) {
  if (!report || typeof report !== 'object') {
    return { ok: false, issueCount: 1, issues: ['Health report was unavailable.'] };
  }
  const issues = Array.isArray(report.issues) ? report.issues : [];
  return {
    ok: report.ok === true && issues.length === 0,
    issueCount: issues.length,
    issues: issues.slice(0, 5).map(function(issue) {
      return String(issue).slice(0, 200);
    })
  };
}

function boundedWizardErrorText_(error) {
  const text = String((error && error.message) || error || 'Unknown error');
  return text.slice(0, 200);
}

// P1 (advisory review): the wizard must display health from a real, traceable
// check result — never inferred from trigger existence. The outcome of the last
// real check (finalize's dry-run + healthCheck) is persisted here; a missing or
// unreadable record means "not yet verified", never "healthy".
function writeLastWizardHealth_(boundedHealth) {
  try {
    const ok = !!boundedHealth && boundedHealth.ok === true;
    const record = {
      state: ok ? 'pass' : 'fail',
      ok: ok,
      message: ok
        ? String((boundedHealth && boundedHealth.message) || 'No open issues.').slice(0, 300)
        : String((boundedHealth && boundedHealth.issues && boundedHealth.issues[0]) || 'Health check reported issues.').slice(0, 300),
      issueCount: boundedHealth ? (Number(boundedHealth.issueCount) || 0) : 1,
      checkedAt: new Date().toISOString()
    };
    PropertiesService.getScriptProperties().setProperty('LAST_WIZARD_HEALTH_CHECK', JSON.stringify(record));
  } catch (error) {
    // Persisting the record must never break finalize itself; the wizard will
    // fall back to "not yet verified" on the next overview render.
  }
}

function readLastWizardHealth_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('LAST_WIZARD_HEALTH_CHECK');
    if (!raw) {
      return { state: 'unverified', message: 'No health check has run yet.', checkedAt: null };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || (parsed.state !== 'pass' && parsed.state !== 'fail')) {
      return { state: 'unverified', message: 'Last health record was unreadable.', checkedAt: null };
    }
    return {
      state: parsed.state,
      ok: parsed.ok === true,
      message: String(parsed.message || '').slice(0, 300),
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null
    };
  } catch (error) {
    return { state: 'unverified', message: 'Last health record was unreadable.', checkedAt: null };
  }
}
