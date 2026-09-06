function initializeExecutionBudget_() {
  RUN_STARTED_AT = Date.now();
  return RUN_STARTED_AT;
}

function beginSyncObservability_(startedAt) {
  SYNC_OBSERVABILITY_ = {
    startedAt: startedAt,
    urlFetchCalls: 0,
    stateSaveCalls: 0,
    stateCodecMs: 0,
    stateCodecEncodeCalls: 0,
    stateCodecDecodeCalls: 0
  };
}

function recordUrlFetchCall_() {
  if (SYNC_OBSERVABILITY_) SYNC_OBSERVABILITY_.urlFetchCalls += 1;
}

function recordStateSaveCall_(baseKey) {
  if (SYNC_OBSERVABILITY_ && baseKey === STATE_KEY) {
    SYNC_OBSERVABILITY_.stateSaveCalls += 1;
  }
}

function recordStateCodecCall_(direction, startedAt) {
  if (!SYNC_OBSERVABILITY_) return;
  SYNC_OBSERVABILITY_.stateCodecMs += Math.max(0, Date.now() - startedAt);
  if (direction === 'encode') SYNC_OBSERVABILITY_.stateCodecEncodeCalls += 1;
  if (direction === 'decode') SYNC_OBSERVABILITY_.stateCodecDecodeCalls += 1;
}

function logSyncSummary_(outcome) {
  if (!SYNC_OBSERVABILITY_) return;
  const summary = {
    event: 'sync_summary',
    outcome: outcome,
    durationMs: Math.max(0, Date.now() - SYNC_OBSERVABILITY_.startedAt),
    urlFetchCalls: SYNC_OBSERVABILITY_.urlFetchCalls,
    stateSaveCalls: SYNC_OBSERVABILITY_.stateSaveCalls,
    stateCodecMs: SYNC_OBSERVABILITY_.stateCodecMs,
    stateCodecEncodeCalls: SYNC_OBSERVABILITY_.stateCodecEncodeCalls,
    stateCodecDecodeCalls: SYNC_OBSERVABILITY_.stateCodecDecodeCalls
  };
  console.log(JSON.stringify(summary));
  SYNC_OBSERVABILITY_ = null;
}

function withGlobalLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('[Lock] Another sync is running; this round is skipped.');
    return null;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function remainingTimeOk_(startedAt, reserveMs) {
  return Date.now() - startedAt < RUN_LIMIT_MS - (reserveMs || 0);
}

function assertDestructiveTimeBudget_(code) {
  if (RUN_STARTED_AT &&
      !remainingTimeOk_(RUN_STARTED_AT, DESTRUCTIVE_OPERATION_RESERVE_MS)) {
    throw new Error((code || 'TIME_BUDGET_DESTRUCTIVE') +
      ': Insufficient time before the deletion safety boundary; no subsequent live read, durable journal save, or remote delete was performed.');
  }
}

function parseRetryAfterMs_(response) {
  const headers = response.getAllHeaders ? response.getAllHeaders() : {};
  let value = headers['Retry-After'] || headers['retry-after'];
  if (Array.isArray(value)) value = value[0];
  if (!value) return 0;
  const seconds = Number(value);
  if (isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

function isNotFoundError_(e) {
  const msg = String((e && e.message) || '');
  // Only the response status at the start of the error is authoritative.  A
  // 500 response can legitimately include a quoted "HTTP 404" from another
  // service and must remain retryable rather than being treated as deleted.
  return /^HTTP (404|410)(?:\b|:)/.test(msg);
}

function taskLabel_(id, title) {
  if (VERBOSE_LOG) return title || '(Untitled)';
  return previewOpaqueId_('task', id);
}

function listLabel_(id, title) {
  if (VERBOSE_LOG) return title || '(Untitled list)';
  return previewOpaqueId_('list', id);
}

function canSendAlert_(key, cooldownMs) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = Number(props.getProperty(key) || 0);
  return (now - last) >= Number(cooldownMs || ALERT_COOLDOWN_MS);
}

function markAlertSent_(key) {
  PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
}

function effectiveAlertRecipient_() {
  const configured = String(
    PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL') || ''
  ).trim();
  if (configured) return configured;
  try {
    if (typeof Session === 'undefined' || !Session ||
        typeof Session.getEffectiveUser !== 'function') return '';
    const user = Session.getEffectiveUser();
    return user && typeof user.getEmail === 'function' ? String(user.getEmail() || '').trim() : '';
  } catch (e) {
    return '';
  }
}

function sendMailAlert_(subject, body) {
  try {
    const recipient = effectiveAlertRecipient_();
    if (!recipient) {
      console.error('[Alert] No effective Google account email or ALERT_EMAIL override is available.');
      return false;
    }
    if (MailApp.getRemainingDailyQuota && MailApp.getRemainingDailyQuota() < 1) {
      console.warn('[Alert] MailApp quota is insufficient; email skipped.');
      return false;
    }
    MailApp.sendEmail({ to: recipient, subject: subject, body: body });
    return true;
  } catch (e) {
    console.error('[Alert] Send failed: ' + e.message);
    return false;
  }
}

function maybeSendStoragePressureAlert_(props, projectedStoreBytes) {
  try {
    const usageBytes = Math.max(
      propertyStoreUsageBytes_(props),
      Number(projectedStoreBytes || 0)
    );
    if (usageBytes < PROPERTY_STORE_WARNING_BYTES ||
        !canSendAlert_(ALERT_KEYS.storagePressure, STORAGE_PRESSURE_ALERT_COOLDOWN_MS)) return false;
    const sent = sendMailAlert_(
      '[Sync engine] State storage is nearing its safety limit',
      'Synchronization state is using at least 80% of the configured safe Apps Script property-store limit.\n\n' +
      'Sync has not been stopped. If deletion synchronization is enabled, first delete a small batch of old ' +
      'completed tasks you no longer need from either service, then allow two complete sync rounds before ' +
      'repeating. Completed tasks still count until deleted, and deletion safety records remain for 30 days.\n\n' +
      'If you already clean up completed tasks regularly, this deployment may genuinely be approaching its ' +
      'capacity boundary. Expired deletion records are cleaned automatically; do not clear tombstones or state ' +
      'properties manually. Keep a private exportRawSyncState() backup before making further changes.'
    );
    if (sent) markAlertSent_(ALERT_KEYS.storagePressure);
    return sent;
  } catch (e) {
    // A best-effort warning must never make a successful state commit fail.
    console.error('[Storage] Pressure alert failed: ' + e.message);
    return false;
  }
}

function sendReauthorizationAlert_() {
  let body;
  try {
    const info = microsoftAuth_().reauthorizationInfo();
    body = info.kind === 'url' ?
      'Syncing has stopped. Open the following URL to reauthorize:\n' + info.url :
      'Syncing has stopped. Open your private Apps Script setup wizard, or run startAuthorization() in the Apps Script editor, to reconnect Microsoft To Do.';
  } catch (e) {
    console.error('[Auth] Failed to prepare bounded reauthorization instructions.');
    return;
  }
  if (!canSendAlert_(ALERT_KEYS.reauth)) {
    console.warn('[Auth] Reauthorization alert is still in its cooldown period; email skipped.');
    return;
  }
  const sent = sendMailAlert_(
    '[Sync engine] Microsoft To Do authorization needs renewal', body
  );
  if (sent) markAlertSent_(ALERT_KEYS.reauth);
}

function sendFatalAlert_(message) {
  if (!canSendAlert_(ALERT_KEYS.fatal)) {
    console.warn('[Alert] Fatal-error alert is still in its cooldown period; email skipped.');
    return;
  }
  const sent = sendMailAlert_('[Sync engine] Sync failed', redactFatalAlert_(message));
  if (sent) markAlertSent_(ALERT_KEYS.fatal);
}

function redactFatalAlert_(error) {
  const diagnostic = boundedErrorDiagnostic_(error);
  const lines = [
    'Sync failed. Check the Apps Script execution log.',
    'HTTP code: ' + diagnostic.httpCode,
    'Error type: ' + diagnostic.errorType
  ];
  if (diagnostic.correlationCode) lines.push('Correlation code: ' + diagnostic.correlationCode);
  return lines.join('\n');
}

// Provider failures can include JSON bodies, URLs, opaque IDs, and occasionally
// user-entered data. Keep durable health state useful without treating it as a
// log sink. Only a status, a locally-recognized error code, and an explicitly
// labelled correlation/request code may survive this boundary.

function boundedErrorDiagnostic_(error) {
  const raw = String(error == null ? '' : error);
  const http = raw.match(/\bHTTP(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i);
  const correlation = raw.match(/\b(?:correlation(?:[ _-]?(?:id|code))?|request[ _-]?(?:id|code))\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9-]{5,79})\b/i);
  const leadingCode = raw.match(/^\s*([A-Z][A-Z0-9_]{2,80})(?=\s*(?:[:\uFF1A]|$))/);
  // The second form is only our own previously-sanitized health string. Do
  // not scan arbitrary provider bodies for a field named "type".
  const storedCode = raw.match(/^\s*HTTP code:\s*(?:\d{3}|unavailable);\s*Error type:\s*([A-Z][A-Z0-9_]{2,80})(?:;|$)/);
  const candidateCode = (storedCode && storedCode[1]) || (leadingCode && leadingCode[1]) || '';
  const errorType = safeHealthErrorCode_(candidateCode) ? candidateCode :
    (http ? 'HTTP_ERROR' : 'UNCLASSIFIED');
  return {
    httpCode: http ? http[1] : 'unavailable',
    errorType: errorType,
    correlationCode: correlation ? correlation[1] : null
  };
}

function safeHealthErrorCode_(value) {
  // Accept only our own stable code namespaces, and only when the code is the
  // leading error token or our prior canonical health summary. This prevents
  // provider text or an arbitrary task title from becoming durable output.
  return /^(?:ALERT|AMBIGUOUS|AUTH|AUTO|CONFIG|DELETE|GOOGLE|HTTP|IMPORT|LIST|MICROSOFT|MOVE|OAUTH|PAGINATION|REPAIR|ROUND|SAFETY|STATE|SYNC|TIME)_[A-Z0-9_]{1,64}$/.test(String(value || ''));
}

function redactHealthErrorMessage_(error) {
  const diagnostic = boundedErrorDiagnostic_(error);
  const parts = [
    'HTTP code: ' + diagnostic.httpCode,
    'Error type: ' + diagnostic.errorType
  ];
  if (diagnostic.correlationCode) parts.push('Correlation code: ' + diagnostic.correlationCode);
  return parts.join('; ');
}

function sendListFaultAlert_(message) {
  if (!canSendAlert_(ALERT_KEYS.listFault)) {
    console.warn('[ListFault] List-isolation alert is still in its cooldown period; email skipped.');
    return;
  }
  const sent = sendMailAlert_('[Sync engine] List isolation warning', message + '\n\nRun listSyncFaults() and dryRunReport().');
  if (sent) markAlertSent_(ALERT_KEYS.listFault);
}

function forceMicrosoftRefresh_(service) {
  if (!service || typeof service.refresh !== 'function') {
    return { ok: false, code: 'OAUTH_REFRESH_UNSUPPORTED' };
  }
  try {
    service.refresh();
    if (typeof service.hasAccess !== 'function' || !service.hasAccess()) {
      return { ok: false, code: 'OAUTH_REFRESH_FAILED' };
    }
    const token = service.getAccessToken();
    return typeof token === 'string' && token ? { ok: true, token: token } :
      { ok: false, code: 'OAUTH_REFRESH_FAILED' };
  } catch (e) {
    const stable = String(e && e.message || '');
    return {
      ok: false,
      code: stable.indexOf('MICROSOFT_PERSONAL_REAUTH_REQUIRED') === 0 ?
        'MICROSOFT_PERSONAL_REAUTH_REQUIRED' : 'OAUTH_REFRESH_FAILED',
      reauthRequired: stable.indexOf('MICROSOFT_PERSONAL_REAUTH_REQUIRED') === 0
    };
  }
}
