function resolveMicrosoftAuthMode_() {
  const properties = PropertiesService.getScriptProperties();
  const explicitMode = String(properties.getProperty(MS_AUTH_MODE_PROPERTY_) || '').trim();
  if (explicitMode) {
    if (explicitMode !== MS_AUTH_MODE_PERSONAL_ && explicitMode !== MS_AUTH_MODE_ADVANCED_) {
      throw new Error('MICROSOFT_AUTH_MODE_INVALID');
    }
    return explicitMode;
  }
  // Preserve every legacy or partially configured BYO Entra installation.
  // A fresh installation has neither property and therefore uses Easy Setup.
  const hasLegacyClientId = !!String(properties.getProperty('MS_CLIENT_ID') || '').trim();
  const hasLegacySecret = !!String(properties.getProperty('MS_CLIENT_SECRET') || '').trim();
  return hasLegacyClientId || hasLegacySecret ? MS_AUTH_MODE_ADVANCED_ : MS_AUTH_MODE_PERSONAL_;
}

function personalMicrosoftAuthorizationPresent_() {
  return !!String(PropertiesService.getUserProperties()
    .getProperty(MS_PERSONAL_REFRESH_TOKEN_KEY_) || '').trim();
}

function personalMicrosoftVerificationPresent_() {
  return PropertiesService.getUserProperties().getProperty(
    MS_PERSONAL_VERIFIED_KEY_
  ) === 'true';
}

function personalMicrosoftTokensPresent_() {
  return personalMicrosoftAuthorizationPresent_();
}

function personalMicrosoftModeSwitchApproval_() {
  const properties = PropertiesService.getUserProperties();
  let approval;
  try {
    approval = JSON.parse(String(
      properties.getProperty(MS_PERSONAL_MODE_SWITCH_APPROVAL_KEY_) || ''
    ));
  } catch (e) {
    approval = null;
  }
  const approvedAt = Number(approval && approval.approvedAt);
  const expiresAt = Number(approval && approval.expiresAt);
  if (!approval || approval.schema !== 2 || approval.approved !== true ||
      approval.from !== MS_AUTH_MODE_ADVANCED_ || approval.to !== MS_AUTH_MODE_PERSONAL_ ||
      !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) ||
      expiresAt !== approvedAt + MS_PERSONAL_MODE_SWITCH_APPROVAL_TTL_MS_ ||
      approvedAt > Date.now() || Date.now() >= expiresAt) {
    if (properties.getProperty(MS_PERSONAL_MODE_SWITCH_APPROVAL_KEY_)) {
      properties.deleteProperty(MS_PERSONAL_MODE_SWITCH_APPROVAL_KEY_);
    }
    return null;
  }
  return approval;
}

function clearPersonalMicrosoftModeSwitchApproval_() {
  PropertiesService.getUserProperties().deleteProperty(
    MS_PERSONAL_MODE_SWITCH_APPROVAL_KEY_
  );
}

function sessionHasActivePersonalModeSwitchApproval_(session) {
  const embedded = session && session.switchApproval;
  if (!embedded || !Number.isFinite(Number(embedded.approvedAt)) ||
      !Number.isFinite(Number(embedded.expiresAt)) ||
      Date.now() >= Number(embedded.expiresAt)) {
    return false;
  }
  const approval = personalMicrosoftModeSwitchApproval_();
  return !!approval && Number(approval.approvedAt) === Number(embedded.approvedAt) &&
    Number(approval.expiresAt) === Number(embedded.expiresAt);
}

function preparePersonalMicrosoftModeSwitch_() {
  if (resolveMicrosoftAuthMode_() !== MS_AUTH_MODE_ADVANCED_) {
    return { status: 'ready', mode: MS_AUTH_MODE_PERSONAL_ };
  }
  // Reading also removes any stale evidence.  The confirmation action—not
  // merely opening this prompt—is what records approval server-side.
  personalMicrosoftModeSwitchApproval_();
  return {
    status: 'confirmation_required',
    mode: MS_AUTH_MODE_ADVANCED_,
    confirmationRequired: true
  };
}

function confirmPersonalMicrosoftModeSwitch_() {
  if (resolveMicrosoftAuthMode_() !== MS_AUTH_MODE_ADVANCED_) {
    return { status: 'ready', mode: MS_AUTH_MODE_PERSONAL_ };
  }
  const approvedAt = Date.now();
  const approval = {
    schema: 2,
    from: MS_AUTH_MODE_ADVANCED_,
    to: MS_AUTH_MODE_PERSONAL_,
    approved: true,
    approvedAt: approvedAt,
    expiresAt: approvedAt + MS_PERSONAL_MODE_SWITCH_APPROVAL_TTL_MS_
  };
  PropertiesService.getUserProperties().setProperty(
    MS_PERSONAL_MODE_SWITCH_APPROVAL_KEY_, JSON.stringify(approval)
  );
  return { status: 'ready', mode: MS_AUTH_MODE_ADVANCED_ };
}

function verifyPersonalMicrosoftAccessToken_(accessToken) {
  if (!accessToken) return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_NO_TOKEN' };
  let response;
  try {
    recordUrlFetchCall_();
    response = UrlFetchApp.fetch(MS_TODO_BASE + '?$top=1&$select=id', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_NETWORK_FAILED' };
  }
  const status = Number(response.getResponseCode());
  if (status === 401) return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_UNAUTHORIZED' };
  if (status === 403) return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_FORBIDDEN' };
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) {
    return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_RETRY' };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_FAILED' };
  }
  let body;
  try {
    body = JSON.parse(String(response.getContentText() || ''));
  } catch (e) {
    return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_FAILED' };
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.value)) {
    return { ok: false, code: 'MICROSOFT_PERSONAL_VERIFY_FAILED' };
  }
  return { ok: true };
}

function verifyStoredPersonalMicrosoftAuthorization_() {
  if (resolveMicrosoftAuthMode_() !== MS_AUTH_MODE_PERSONAL_) {
    // A stored token alone must never turn an Advanced installation into
    // Personal mode.  Only the device-session transaction may do that.
    return preparePersonalMicrosoftModeSwitch_();
  }
  let accessToken;
  try {
    accessToken = getPersonalMicrosoftAccessToken_();
  } catch (e) {
    return { status: 'verification_failed', errorCode: 'MICROSOFT_PERSONAL_REAUTH_REQUIRED' };
  }
  const verified = verifyPersonalMicrosoftAccessToken_(accessToken);
  if (!verified.ok) {
    PropertiesService.getUserProperties().deleteProperty(MS_PERSONAL_VERIFIED_KEY_);
    if (verified.code === 'MICROSOFT_PERSONAL_VERIFY_UNAUTHORIZED' ||
        verified.code === 'MICROSOFT_PERSONAL_VERIFY_FORBIDDEN') {
      clearPersonalMicrosoftTokens_();
    }
    return { status: 'verification_failed', errorCode: verified.code };
  }
  PropertiesService.getUserProperties().setProperty(MS_PERSONAL_VERIFIED_KEY_, 'true');
  return { status: 'authorized', verified: true };
}

function formEncode_(fields) {
  return Object.keys(fields || {}).filter(function(key) {
    return fields[key] !== null && typeof fields[key] !== 'undefined';
  }).map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(String(fields[key]));
  }).join('&');
}

function microsoftOAuthPost_(url, fields) {
  let response;
  try {
    recordUrlFetchCall_();
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: formEncode_(fields),
      muteHttpExceptions: true
    });
  } catch (e) {
    throw new Error('MICROSOFT_OAUTH_NETWORK_FAILED');
  }
  const status = Number(response.getResponseCode());
  let body = null;
  try {
    body = JSON.parse(String(response.getContentText() || ''));
  } catch (e) {
    body = null;
  }
  return {
    ok: status >= 200 && status < 300,
    status: status,
    body: body && typeof body === 'object' ? body : null
  };
}

function safeMicrosoftOAuthErrorCode_(body) {
  const raw = String(body && body.error || 'unknown_error').trim().toLowerCase();
  const allowed = {
    authorization_pending: true,
    authorization_declined: true,
    access_denied: true,
    slow_down: true,
    expired_token: true,
    bad_verification_code: true,
    invalid_client: true,
    invalid_scope: true,
    invalid_grant: true,
    temporarily_unavailable: true,
    server_error: true
  };
  return allowed[raw] ? raw : 'unknown_error';
}

function validMicrosoftVerificationUri_(value) {
  return /^https:\/\/(?:www\.)?microsoft\.com\/(?:link|devicelogin)\/?$/i.test(
    String(value || '').trim()
  );
}

function parsePersonalDeviceSession_(raw) {
  let session;
  try {
    session = JSON.parse(String(raw || ''));
  } catch (e) {
    return null;
  }
  if (!session || session.schema !== 1 ||
      typeof session.deviceCode !== 'string' || !session.deviceCode || session.deviceCode.length > 4096 ||
      typeof session.userCode !== 'string' || !session.userCode || session.userCode.length > 100 ||
      !validMicrosoftVerificationUri_(session.verificationUri) ||
      !Number.isFinite(Number(session.expiresAt)) ||
      !Number.isFinite(Number(session.intervalSec)) || Number(session.intervalSec) < 5 ||
      !Number.isFinite(Number(session.nextPollAt))) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(session, 'switchApproval')) {
    const approval = session.switchApproval;
    if (!approval || typeof approval !== 'object' ||
        !Number.isFinite(Number(approval.approvedAt)) ||
        !Number.isFinite(Number(approval.expiresAt)) ||
        Number(approval.expiresAt) !== Number(approval.approvedAt) +
          MS_PERSONAL_MODE_SWITCH_APPROVAL_TTL_MS_) {
      return null;
    }
  }
  return session;
}

function discardPersonalMicrosoftDeviceSession_(properties, session) {
  properties.deleteProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
  if (session && session.switchApproval) {
    clearPersonalMicrosoftModeSwitchApproval_();
  }
}

function publicPersonalDeviceSession_(session, status) {
  return {
    status: status || 'pending',
    userCode: String(session.userCode),
    verificationUri: String(session.verificationUri),
    expiresAt: Number(session.expiresAt),
    intervalSec: Number(session.intervalSec)
  };
}

function personalMicrosoftDeviceSessionStatus_() {
  const properties = PropertiesService.getUserProperties();
  const raw = properties.getProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
  if (!raw) return { status: 'not_started' };
  const session = parsePersonalDeviceSession_(raw);
  if (!session) {
    properties.deleteProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
    if (resolveMicrosoftAuthMode_() === MS_AUTH_MODE_ADVANCED_) {
      clearPersonalMicrosoftModeSwitchApproval_();
    }
    return { status: 'invalid_session' };
  }
  if (Date.now() >= Number(session.expiresAt)) {
    discardPersonalMicrosoftDeviceSession_(properties, session);
    return { status: 'expired' };
  }
  if (resolveMicrosoftAuthMode_() === MS_AUTH_MODE_ADVANCED_ &&
      !sessionHasActivePersonalModeSwitchApproval_(session)) {
    discardPersonalMicrosoftDeviceSession_(properties, session);
    return preparePersonalMicrosoftModeSwitch_();
  }
  return publicPersonalDeviceSession_(session);
}

function beginPersonalMicrosoftAuth_() {
  const mode = resolveMicrosoftAuthMode_();
  if (mode === MS_AUTH_MODE_PERSONAL_ &&
      personalMicrosoftAuthorizationPresent_()) {
    return verifyStoredPersonalMicrosoftAuthorization_();
  }
  const lock = LockService.getUserLock();
  lock.waitLock(5000);
  try {
    const properties = PropertiesService.getUserProperties();
    const now = Date.now();
    const existing = parsePersonalDeviceSession_(
      properties.getProperty(MS_PERSONAL_DEVICE_SESSION_KEY_)
    );
    if (existing && Number(existing.expiresAt) > now + 10000) {
      if (mode === MS_AUTH_MODE_ADVANCED_ &&
          !sessionHasActivePersonalModeSwitchApproval_(existing)) {
        discardPersonalMicrosoftDeviceSession_(properties, existing);
        return preparePersonalMicrosoftModeSwitch_();
      }
      return publicPersonalDeviceSession_(existing);
    }
    if (properties.getProperty(MS_PERSONAL_DEVICE_SESSION_KEY_)) {
      properties.deleteProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
      if (mode === MS_AUTH_MODE_ADVANCED_) {
        clearPersonalMicrosoftModeSwitchApproval_();
      }
    }
    const switchApproval = mode === MS_AUTH_MODE_ADVANCED_ ?
      personalMicrosoftModeSwitchApproval_() : null;
    if (mode === MS_AUTH_MODE_ADVANCED_ && !switchApproval) {
      return preparePersonalMicrosoftModeSwitch_();
    }
    try {
      const result = microsoftOAuthPost_(MS_PERSONAL_AUTHORITY_ + '/devicecode', {
        client_id: MS_PERSONAL_CLIENT_ID_,
        scope: MS_PERSONAL_SCOPE_
      });
      if (!result.ok) {
        throw new Error('MICROSOFT_DEVICE_CODE_REQUEST_FAILED:' +
          safeMicrosoftOAuthErrorCode_(result.body));
      }
      const body = result.body || {};
      if (!body.device_code || !body.user_code || !body.verification_uri ||
          !body.expires_in || !validMicrosoftVerificationUri_(body.verification_uri)) {
        throw new Error('MICROSOFT_DEVICE_CODE_RESPONSE_INVALID');
      }
      const intervalSec = Math.max(5, Number(body.interval) || 5);
      const expiresInSec = Number(body.expires_in);
      if (!Number.isFinite(expiresInSec) || expiresInSec <= 0 ||
          !Number.isFinite(intervalSec) || intervalSec > 300) {
        throw new Error('MICROSOFT_DEVICE_CODE_RESPONSE_INVALID');
      }
      const session = {
        schema: 1,
        deviceCode: String(body.device_code),
        userCode: String(body.user_code),
        verificationUri: String(body.verification_uri),
        expiresAt: now + expiresInSec * 1000,
        intervalSec: intervalSec,
        nextPollAt: now + intervalSec * 1000
      };
      if (switchApproval) {
        session.switchApproval = {
          approvedAt: Number(switchApproval.approvedAt),
          expiresAt: Number(switchApproval.expiresAt)
        };
      }
      properties.setProperty(MS_PERSONAL_DEVICE_SESSION_KEY_, JSON.stringify(session));
      return publicPersonalDeviceSession_(session);
    } catch (e) {
      if (switchApproval) clearPersonalMicrosoftModeSwitchApproval_();
      throw e;
    }
  } finally {
    lock.releaseLock();
  }
}

function storePersonalMicrosoftTokens_(token, requireRefreshToken) {
  const properties = PropertiesService.getUserProperties();
  const accessToken = String(token && token.access_token || '');
  const refreshToken = String(token && token.refresh_token || '');
  const expiresInSec = Number(token && token.expires_in);
  if (!accessToken || !Number.isFinite(expiresInSec) || expiresInSec <= 0 ||
      (requireRefreshToken && !refreshToken)) {
    throw new Error('MICROSOFT_PERSONAL_TOKEN_RESPONSE_INVALID');
  }
  const values = {};
  values[MS_PERSONAL_ACCESS_TOKEN_KEY_] = accessToken;
  values[MS_PERSONAL_ACCESS_EXPIRES_AT_KEY_] = String(Date.now() + expiresInSec * 1000);
  values[MS_PERSONAL_GRANTED_SCOPE_KEY_] = String(token.scope || '');
  if (requireRefreshToken) values[MS_PERSONAL_VERIFIED_KEY_] = 'false';
  if (refreshToken) values[MS_PERSONAL_REFRESH_TOKEN_KEY_] = refreshToken;
  properties.setProperties(values, false);
}

function pollPersonalMicrosoftAuth_() {
  const lock = LockService.getUserLock();
  lock.waitLock(5000);
  const mode = resolveMicrosoftAuthMode_();
  let properties = null;
  let session = null;
  try {
    properties = PropertiesService.getUserProperties();
    const raw = properties.getProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
    if (!raw) return { status: 'not_started' };
    session = parsePersonalDeviceSession_(raw);
    if (!session) {
      properties.deleteProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
      if (mode === MS_AUTH_MODE_ADVANCED_) {
        clearPersonalMicrosoftModeSwitchApproval_();
      }
      return { status: 'invalid_session' };
    }
    const now = Date.now();
    if (now >= Number(session.expiresAt)) {
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return { status: 'expired' };
    }
    if (mode === MS_AUTH_MODE_ADVANCED_ &&
        !sessionHasActivePersonalModeSwitchApproval_(session)) {
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return preparePersonalMicrosoftModeSwitch_();
    }
    if (now < Number(session.nextPollAt)) {
      return {
        status: 'pending',
        retryAfterMs: Number(session.nextPollAt) - now,
        expiresAt: Number(session.expiresAt)
      };
    }
    // Reserve the next permitted poll before making the network request. This
    // keeps retries from hammering Microsoft's token endpoint even when the
    // request fails or Apps Script is interrupted after the response.
    session.nextPollAt = now + Number(session.intervalSec) * 1000;
    properties.setProperty(MS_PERSONAL_DEVICE_SESSION_KEY_, JSON.stringify(session));
    const result = microsoftOAuthPost_(MS_PERSONAL_AUTHORITY_ + '/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: MS_PERSONAL_CLIENT_ID_,
      device_code: session.deviceCode
    });
  if (result.ok) {
    const token = result.body || {};
    const accessToken = String(token.access_token || '');
    const refreshToken = String(token.refresh_token || '');
    const expiresInSec = Number(token.expires_in);
    if (!accessToken || !refreshToken || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
      throw new Error('MICROSOFT_PERSONAL_TOKEN_RESPONSE_INVALID');
    }
    // Keep a newly-issued token in memory until a live Microsoft To Do probe
    // accepts it, so a failed probe cannot strand the setup wizard.
    const verification = verifyPersonalMicrosoftAccessToken_(accessToken);
    if (!verification.ok) {
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return { status: 'verification_failed', errorCode: verification.code };
      }
    if (mode === MS_AUTH_MODE_ADVANCED_ &&
        !sessionHasActivePersonalModeSwitchApproval_(session)) {
      // Token persistence and Graph proof are deliberately insufficient on
      // their own: a current, approved server-side switch record is also
      // required before an Advanced installation can change active modes.
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return preparePersonalMicrosoftModeSwitch_();
    }
    storePersonalMicrosoftTokens_(token, true);
    properties.setProperty(MS_PERSONAL_VERIFIED_KEY_, 'true');
      if (mode === MS_AUTH_MODE_ADVANCED_) {
        // Commit only after the complete token set, Graph proof, and matching
        // approval evidence are all durable.
        PropertiesService.getScriptProperties().setProperty(
          MS_AUTH_MODE_PROPERTY_, MS_AUTH_MODE_PERSONAL_
        );
        discardPersonalMicrosoftDeviceSession_(properties, session);
      } else {
        // Fresh installations already resolve to Personal mode. Persist that
        // resolved choice after successful authorization without changing an
        // Advanced installation or relying on switch evidence.
        PropertiesService.getScriptProperties().setProperty(
          MS_AUTH_MODE_PROPERTY_, MS_AUTH_MODE_PERSONAL_
        );
        properties.deleteProperty(MS_PERSONAL_DEVICE_SESSION_KEY_);
      }
      return { status: 'authorized', verified: true };
    }
    const errorCode = safeMicrosoftOAuthErrorCode_(result.body);
    if (errorCode === 'authorization_pending') {
      return {
        status: 'pending',
        retryAfterMs: Number(session.intervalSec) * 1000,
        expiresAt: Number(session.expiresAt)
      };
    }
    if (errorCode === 'slow_down') {
      session.intervalSec = Number(session.intervalSec) + 5;
      session.nextPollAt = now + Number(session.intervalSec) * 1000;
      properties.setProperty(MS_PERSONAL_DEVICE_SESSION_KEY_, JSON.stringify(session));
      return {
        status: 'pending',
        retryAfterMs: Number(session.intervalSec) * 1000,
        slowedDown: true,
        expiresAt: Number(session.expiresAt)
      };
    }
    if (errorCode === 'authorization_declined' || errorCode === 'access_denied') {
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return { status: 'declined' };
    }
    if (errorCode === 'expired_token') {
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return { status: 'expired' };
    }
    if (errorCode === 'bad_verification_code') {
      discardPersonalMicrosoftDeviceSession_(properties, session);
      return { status: 'invalid_session' };
    }
    throw new Error('MICROSOFT_DEVICE_AUTH_FAILED:' + errorCode);
  } catch (e) {
    if (properties && session) {
      discardPersonalMicrosoftDeviceSession_(properties, session);
    } else if (mode === MS_AUTH_MODE_ADVANCED_) {
      clearPersonalMicrosoftModeSwitchApproval_();
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function clearPersonalMicrosoftTokens_() {
  const properties = PropertiesService.getUserProperties();
  [
    MS_PERSONAL_ACCESS_TOKEN_KEY_,
    MS_PERSONAL_REFRESH_TOKEN_KEY_,
    MS_PERSONAL_ACCESS_EXPIRES_AT_KEY_,
    MS_PERSONAL_GRANTED_SCOPE_KEY_,
    MS_PERSONAL_VERIFIED_KEY_
  ].forEach(function(key) {
    properties.deleteProperty(key);
  });
}

function refreshPersonalMicrosoftAccessToken_() {
  const lock = LockService.getUserLock();
  lock.waitLock(5000);
  try {
    const properties = PropertiesService.getUserProperties();
    const oldRefreshToken = String(
      properties.getProperty(MS_PERSONAL_REFRESH_TOKEN_KEY_) || ''
    );
    if (!oldRefreshToken) {
      throw new Error('MICROSOFT_PERSONAL_REAUTH_REQUIRED');
    }
    const result = microsoftOAuthPost_(MS_PERSONAL_AUTHORITY_ + '/token', {
      client_id: MS_PERSONAL_CLIENT_ID_,
      grant_type: 'refresh_token',
      refresh_token: oldRefreshToken,
      scope: MS_PERSONAL_SCOPE_
    });
    if (!result.ok) {
      const errorCode = safeMicrosoftOAuthErrorCode_(result.body);
      if (errorCode === 'invalid_grant') {
        clearPersonalMicrosoftTokens_();
        throw new Error('MICROSOFT_PERSONAL_REAUTH_REQUIRED');
      }
      throw new Error('MICROSOFT_PERSONAL_REFRESH_FAILED:' + errorCode);
    }
    storePersonalMicrosoftTokens_(result.body || {}, false);
    return String(properties.getProperty(MS_PERSONAL_ACCESS_TOKEN_KEY_) || '');
  } finally {
    lock.releaseLock();
  }
}

function getPersonalMicrosoftAccessToken_() {
  const properties = PropertiesService.getUserProperties();
  const accessToken = String(properties.getProperty(MS_PERSONAL_ACCESS_TOKEN_KEY_) || '');
  const expiresAt = Number(properties.getProperty(MS_PERSONAL_ACCESS_EXPIRES_AT_KEY_) || 0);
  if (accessToken && expiresAt > Date.now() + MS_PERSONAL_REFRESH_MARGIN_MS_) {
    return accessToken;
  }
  return refreshPersonalMicrosoftAccessToken_();
}

function personalMicrosoftAuth_() {
  return {
    mode: MS_AUTH_MODE_PERSONAL_,
    hasAccess: function() {
      return personalMicrosoftAuthorizationPresent_();
    },
    getAccessToken: function() {
      return getPersonalMicrosoftAccessToken_();
    },
    refresh: function() {
      return refreshPersonalMicrosoftAccessToken_();
    },
    reset: function() {
      clearPersonalMicrosoftTokens_();
    },
    reauthorizationInfo: function() {
      return { kind: 'device_code', action: 'startAuthorization' };
    }
  };
}

function advancedMicrosoftAuth_() {
  const service = microsoftService_();
  return {
    mode: MS_AUTH_MODE_ADVANCED_,
    hasAccess: function() {
      return service.hasAccess();
    },
    getAccessToken: function() {
      return service.getAccessToken();
    },
    refresh: function() {
      service.refresh();
      return service.getAccessToken();
    },
    reset: function() {
      service.reset();
    },
    reauthorizationInfo: function() {
      return { kind: 'url', url: service.getAuthorizationUrl() };
    }
  };
}

function microsoftAuth_() {
  return resolveMicrosoftAuthMode_() === MS_AUTH_MODE_PERSONAL_ ?
    personalMicrosoftAuth_() : advancedMicrosoftAuth_();
}

function microsoftService_() {
  const c = getConfig_();
  return OAuth2.createService('microsoft_todo_main')
    .setAuthorizationBaseUrl('https://login.microsoftonline.com/' + encodeURIComponent(c.tenantId) + '/oauth2/v2.0/authorize')
    .setTokenUrl('https://login.microsoftonline.com/' + encodeURIComponent(c.tenantId) + '/oauth2/v2.0/token')
    .setClientId(c.clientId)
    .setClientSecret(c.clientSecret)
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setCache(CacheService.getUserCache())
    .setLock(LockService.getUserLock())
    .setScope('Tasks.ReadWrite offline_access')
    .setParam('prompt', 'consent');
}
