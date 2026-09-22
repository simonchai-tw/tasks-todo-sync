function isUrlFetchTransientError_(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('bandwidth quota exceeded') ||
    msg.includes('address unavailable') ||
    msg.includes('dns error') ||
    msg.includes('rate limit') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('connection reset') ||
    msg.includes('socket');
}

function fetchJsonWithRetry_(url, options, authKind) {
  let lastError = null;
  let msAuth = null;
  let refreshedMicrosoftToken = null;
  let forcedRefreshAttempted = false;
  for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt++) {
    const opts = Object.assign({ muteHttpExceptions: true }, options || {});
    const noRetry = opts.__noRetry === true;
    delete opts.__noRetry;
    opts.headers = Object.assign({}, opts.headers || {});
    if (authKind === 'ms') {
      msAuth = msAuth || microsoftAuth_();
      if (!msAuth.hasAccess()) {
        sendReauthorizationAlert_();
        throw new Error('Microsoft authorization has expired. Reauthorize it.');
      }
      try {
        opts.headers.Authorization = 'Bearer ' +
          (refreshedMicrosoftToken || msAuth.getAccessToken());
      } catch (e) {
        if (String(e && e.message || '').indexOf('MICROSOFT_PERSONAL_REAUTH_REQUIRED') === 0) {
          try {
            msAuth.reset();
          } catch (resetError) {
            // Reset failure does not make the reauthorization alert safe to skip.
          }
          sendReauthorizationAlert_();
          throw new Error('Microsoft authorization has expired. Reauthorize it.');
        }
        throw e;
      }
    } else {
      opts.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
    }
    if (opts.payload !== undefined && !opts.headers['Content-Type']) {
      opts.headers['Content-Type'] = 'application/json';
    }
    recordUrlFetchCall_();
    let response;
    try {
      response = UrlFetchApp.fetch(url, opts);
    } catch (fetchErr) {
      if (isUrlFetchTransientError_(fetchErr)) {
        lastError = fetchErr;
        if (attempt === HTTP_MAX_RETRIES || noRetry) {
          throw new Error('TIME_BUDGET_HTTP: UrlFetch transient error (' + (fetchErr.message || fetchErr) + ')');
        }
        const exponential = Math.min(30000, 1000 * Math.pow(2, attempt));
        const delay = exponential + Math.floor(Math.random() * 750);
        if (RUN_STARTED_AT && Date.now() + delay > RUN_STARTED_AT + RUN_LIMIT_MS) {
          throw new Error('TIME_BUDGET_HTTP: Too close to timeout to retry UrlFetch transient error; the next round will rerun the full inventory, with no persisted page cursor.');
        }
        console.warn('[UrlFetch] Transient error: ' + (fetchErr.message || fetchErr) + '; retrying in ' + delay + ' ms.');
        Utilities.sleep(delay);
        continue;
      }
      throw fetchErr;
    }
    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code >= 200 && code < 300) {
      return text ? JSON.parse(text) : null;
    }
    if (authKind === 'ms' && code === 401) {
      if (!forcedRefreshAttempted) {
        forcedRefreshAttempted = true;
        const refresh = forceMicrosoftRefresh_(msAuth);
        if (refresh.ok) {
          refreshedMicrosoftToken = refresh.token;
          continue;
        }
        if (!refresh.reauthRequired) {
          throw new Error('MICROSOFT_REFRESH_FAILED_RETRY_LATER');
        }
      }
      try {
        msAuth.reset();
      } catch (e) {
        // Reset failure does not make the reauthorization alert safe to skip.
      }
      sendReauthorizationAlert_();
      throw new Error('HTTP 401: Microsoft authorization requires reauthorization.');
    }
    const transient = code === 429 || code === 408 || (code >= 500 && code < 600);
    lastError = buildProviderHttpError_(code, text);
    if (!transient || attempt === HTTP_MAX_RETRIES || noRetry) throw lastError;
    const retryAfter = parseRetryAfterMs_(response);
    const exponential = Math.min(30000, 1000 * Math.pow(2, attempt));
    const delay = Math.max(retryAfter, exponential + Math.floor(Math.random() * 750));
    if (RUN_STARTED_AT && Date.now() + delay > RUN_STARTED_AT + RUN_LIMIT_MS) {
      throw new Error('TIME_BUDGET_HTTP: Too close to timeout to retry; the next round will rerun the full inventory, with no persisted page cursor.');
    }
    recordProviderRetry_();
    console.warn('[HTTP] ' + code + '; retrying in ' + delay + ' ms.');
    Utilities.sleep(delay);
  }
  throw lastError || new Error('HTTP request failed');
}

// Build a structured, redacted provider error from an HTTP status and a raw
// response body. The message keeps the canonical "HTTP <code>: <message>" shape
// so existing callers (isNotFoundError_, providerHttpStatus_) keep working; the
// structured fields are attached separately for typed, non-leaking handling.
function buildProviderHttpError_(code, text) {
  const parsed = parseProviderErrorBody_(text);
  const retryable = code === 429 || code === 408 || (code >= 500 && code < 600);
  const error = new Error('HTTP ' + code + ': ' + parsed.boundedMessage);
  error.httpStatus = code;
  error.providerCode = parsed.providerCode;
  error.providerMessage = parsed.boundedMessage;
  error.retryable = retryable;
  return error;
}

// Parse a provider error body into a bounded, sanitised provider code and a
// redacted, length-bounded message. Provider bodies (Graph and Google Tasks)
// nest the code differently: Graph uses a string error.code with a more specific
// innerError.code, Google Tasks uses a numeric error.code and a machine-readable
// errors[].reason. The most specific code wins when present, then the top-level
// string code, then the numeric code's reason, then a safe default.
function parseProviderErrorBody_(text) {
  let providerCode = '';
  let rawMessage = '';
  const body = safeJsonParse_(text);
  if (body && typeof body === 'object') {
    const err = body.error;
    if (err && typeof err === 'object') {
      const inner = err.innerError;
      const innerCode = inner && typeof inner === 'object' ? inner.code : undefined;
      if (typeof innerCode === 'string' && innerCode) {
        providerCode = sanitizeProviderCode_(innerCode);
      }
      if (!providerCode && typeof err.code === 'string' && err.code) {
        providerCode = sanitizeProviderCode_(err.code);
      }
      if (!providerCode && typeof err.code === 'number') {
        const reason = err.errors && Array.isArray(err.errors) && err.errors[0] &&
          err.errors[0].reason;
        if (typeof reason === 'string' && reason) providerCode = sanitizeProviderCode_(reason);
      }
      if (typeof err.message === 'string' && err.message) rawMessage = err.message;
    }
  }
  if (!providerCode) providerCode = 'UNKNOWN_PROVIDER';
  if (!rawMessage) rawMessage = text == null ? '' : String(text);
  if (rawMessage.length > 2000) rawMessage = rawMessage.slice(0, 2000);
  const redacted = redactSensitive_(rawMessage);
  const boundedMessage = redacted.length > 200 ? redacted.slice(0, 200) : redacted;
  return { providerCode: providerCode, boundedMessage: boundedMessage };
}

// Keep only an allow-listed character set and bound the length so a provider
// code can never carry injected or oversized content into durable state.
function sanitizeProviderCode_(raw) {
  const safe = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return /^[A-Za-z0-9_-]+$/.test(safe) ? safe : '';
}

// Remove emails, URLs, and token-like opaque strings (long unbroken runs that
// resemble secrets or IDs) before any provider text reaches logs or state.
function redactSensitive_(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.[^\s]+/gi, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/[A-Za-z0-9_-]{20,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function safeJsonParse_(text) {
  if (text == null) return null;
  try {
    return JSON.parse(String(text));
  } catch (e) {
    return null;
  }
}

function graphFetch_(url, options) {
  return fetchJsonWithRetry_(url, options, 'ms');
}

function gFetch_(path, options) {
  return fetchJsonWithRetry_(GTASKS_BASE + path, options, 'google');
}

function getAllPages_(firstUrl, fetcher, itemField, tokenMode) {
  let url = firstUrl;
  let items = [];
  const seen = {};
  let pageCount = 0;
  while (url) {
    if (RUN_STARTED_AT && !remainingTimeOk_(RUN_STARTED_AT, PAGINATION_RESERVE_MS)) {
      throw new Error('TIME_BUDGET_PAGINATION: insufficient time for another page.');
    }
    if (seen[url]) {
      throw new Error('PAGINATION_LOOP: repeated page token or nextLink.');
    }
    if (pageCount >= PAGINATION_MAX_PAGES) {
      throw new Error('PAGINATION_PAGE_CAP: page cap exceeded.');
    }
    seen[url] = true;
    pageCount += 1;
    const page = fetcher(url) || {};
    items = items.concat(page[itemField] || []);
    if (tokenMode === 'google') {
      const token = page.nextPageToken;
      if (!token) break;
      url = firstUrl + (firstUrl.indexOf('?') >= 0 ? '&' : '?') + 'pageToken=' + encodeURIComponent(token);
    } else {
      url = page['@odata.nextLink'] || null;
    }
  }
  return items;
}

function getGLists_() {
  const first = '/users/@me/lists?maxResults=100';
  return getAllPages_(first, function(path) { return gFetch_(path); }, 'items', 'google');
}

function getGDefaultList_() {
  return gFetch_('/users/@me/lists/@default');
}

function getGList_(listId) {
  return gFetch_('/users/@me/lists/' + encodeURIComponent(listId));
}

function getGTasks_(listId) {
  const first = '/lists/' + encodeURIComponent(listId) + '/tasks?showCompleted=true&showHidden=true&maxResults=100';
  return getAllPages_(first, function(path) { return gFetch_(path); }, 'items', 'google');
}

function getGTask_(listId, taskId) {
  try {
    return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId));
  } catch (e) {
    if (isNotFoundError_(e)) return null;
    throw e;
  }
}

function getMsLists_() {
  return getAllPages_(MS_TODO_BASE, function(url) { return graphFetch_(url); }, 'value', 'graph');
}

function getMsList_(listId) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId));
}

function getMsTasks_(listId, options) {
  const includeMoveExtension = !!(options && options.includeMoveExtension);
  const includeTaskCreateExtension = !!(options && options.includeTaskCreateExtension);
  // A full extension expansion is intentionally reserved for the small set of
  // destination lists which contain an unresolved correlation journal.  Normal
  // inventories and dry runs retain their previous Graph request shape.
  // todoTask extension expansion requires the documented unqualified extension
  // name filter. The response is still checked locally against the exact
  // service-normalized ID allowlist, extensionName, and correlation UUID.
  const extensionQuery = includeMoveExtension && includeTaskCreateExtension
    ? '&$expand=extensions'
    : includeMoveExtension || includeTaskCreateExtension
      ? '&$expand=extensions($filter=id%20eq%20%27' +
        encodeURIComponent(includeTaskCreateExtension ? TASK_CREATE_EXTENSION_NAME : MOVE_EXTENSION_NAME) + '%27)'
      : '';
  const first = MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks?$top=100' + extensionQuery;
  return getAllPages_(first, function(url) {
    return graphFetch_(url, microsoftTaskRequestOptions_());
  }, 'value', 'graph');
}

/* Read checklist items with a bounded, direct Graph collection GET. */
function getMsChecklistItemsDirect_(listId, parentTaskId) {
  if (typeof listId !== 'string' || !listId ||
      typeof parentTaskId !== 'string' || !parentTaskId) {
    throw new Error('RELATIONSHIP_MALFORMED_ID');
  }
  let url = MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(parentTaskId) + '/checklistItems?$top=100';
  const seen = {};
  const items = [];
  let pageCount = 0;
  let directCollectionRequests = 0;
  try {
    while (url) {
      if (RUN_STARTED_AT && !remainingTimeOk_(RUN_STARTED_AT, PAGINATION_RESERVE_MS)) {
        throw new Error('TIME_BUDGET_RELATIONSHIP: insufficient time for another checklist page.');
      }
      if (seen[url]) throw new Error('RELATIONSHIP_PAGINATION_LOOP: repeated nextLink.');
      if (pageCount >= PAGINATION_MAX_PAGES) throw new Error('RELATIONSHIP_PAGINATION_PAGE_CAP: page cap exceeded.');
      seen[url] = true;
      pageCount += 1;
      directCollectionRequests += 1;
      let page;
      try {
        page = graphFetch_(url, microsoftTaskRequestOptions_({ method: 'get' }));
      } catch (error) {
        try { error.directCollectionRequests = directCollectionRequests; } catch (ignored) {}
        throw error;
      }
      if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.value)) {
        throw new Error('RELATIONSHIP_MALFORMED_PAGE: value must be an array.');
      }
      page.value.forEach(function(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            typeof item.id !== 'string' || !item.id ||
            typeof item.displayName !== 'string' ||
            typeof item.isChecked !== 'boolean') {
          throw new Error('RELATIONSHIP_MALFORMED_ITEM: invalid checklist item.');
        }
        items.push({ id: item.id, displayName: item.displayName, isChecked: item.isChecked });
      });
      const hasNext = Object.prototype.hasOwnProperty.call(page, '@odata.nextLink');
      if (!hasNext) {
        url = null;
      } else if (typeof page['@odata.nextLink'] !== 'string' || !page['@odata.nextLink']) {
        throw new Error('RELATIONSHIP_MALFORMED_PAGE: nextLink must be a non-empty string.');
      } else {
        url = page['@odata.nextLink'];
      }
    }
  } catch (error) {
    // A later-page failure never returns a partial collection.  Keep only the
    // numeric request count as caller-visible telemetry.
    try { error.directCollectionRequests = directCollectionRequests; } catch (ignored) {}
    throw error;
  }
  return {
    kind: 'OBSERVED_COMPLETE',
    items: items,
    pageCount: pageCount,
    directCollectionRequests: directCollectionRequests
  };
}

/* Read a Microsoft task's linkedResources through the navigation endpoint.
 * Graph silently ignores $expand=linkedResources on both the collection and the
 * single-task endpoint, and rejects $select on it with HTTP 400, so this
 * dedicated collection GET is the only reliable read path (verified live
 * 2026-09-11). Returns OBSERVED_COMPLETE with the exact items, or throws. */
function getMsTaskLinkedResources_(listId, taskId) {
  if (typeof listId !== 'string' || !listId || typeof taskId !== 'string' || !taskId) {
    throw new Error('RELATIONSHIP_MALFORMED_ID');
  }
  let url = MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(taskId) + '/linkedResources?$top=100';
  const seen = {};
  const items = [];
  let pageCount = 0;
  while (url) {
    if (RUN_STARTED_AT && !remainingTimeOk_(RUN_STARTED_AT, PAGINATION_RESERVE_MS)) {
      throw new Error('TIME_BUDGET_RELATIONSHIP: insufficient time for another linkedResources page.');
    }
    if (seen[url]) throw new Error('RELATIONSHIP_PAGINATION_LOOP: repeated nextLink.');
    if (pageCount >= PAGINATION_MAX_PAGES) throw new Error('RELATIONSHIP_PAGINATION_PAGE_CAP: page cap exceeded.');
    seen[url] = true;
    pageCount += 1;
    const page = graphFetch_(url, microsoftTaskRequestOptions_({ method: 'get' }));
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.value)) {
      throw new Error('RELATIONSHIP_MALFORMED_PAGE: value must be an array.');
    }
    page.value.forEach(function(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.id !== 'string' || !item.id) {
        throw new Error('RELATIONSHIP_MALFORMED_ITEM: invalid linkedResource.');
      }
      items.push(item);
    });
    const hasNext = Object.prototype.hasOwnProperty.call(page, '@odata.nextLink');
    if (!hasNext) {
      url = null;
    } else if (typeof page['@odata.nextLink'] !== 'string' || !page['@odata.nextLink']) {
      throw new Error('RELATIONSHIP_MALFORMED_PAGE: nextLink must be a non-empty string.');
    } else {
      url = page['@odata.nextLink'];
    }
  }
  return { kind: 'OBSERVED_COMPLETE', items: items, pageCount: pageCount };
}

/* Read a Microsoft task's attachments through the navigation endpoint, mirroring
 * getMsTaskLinkedResources_ exactly in structure and error semantics.
 *
 * NOTE: This endpoint has NOT been verified live against Microsoft Graph. It is
 * implemented to the same bounded-observation contract so a future caller can
 * rely on a frozen interface (function name, parameters, return shape
 * {kind:'OBSERVED_COMPLETE', items, pageCount}, and the shared
 * RELATIONSHIP_* and TIME_BUDGET_RELATIONSHIP error codes). It is intentionally
 * NOT wired into any automatic sync path: it
 * is fail-closed and off by default until live verification confirms the
 * navigation endpoint exists and returns `id`-keyed items. */
function getMsTaskAttachments_(listId, taskId) {
  if (typeof listId !== 'string' || !listId || typeof taskId !== 'string' || !taskId) {
    throw new Error('RELATIONSHIP_MALFORMED_ID');
  }
  let url = MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(taskId) + '/attachments?$top=100';
  const seen = {};
  const items = [];
  let pageCount = 0;
  while (url) {
    if (RUN_STARTED_AT && !remainingTimeOk_(RUN_STARTED_AT, PAGINATION_RESERVE_MS)) {
      throw new Error('TIME_BUDGET_RELATIONSHIP: insufficient time for another attachments page.');
    }
    if (seen[url]) throw new Error('RELATIONSHIP_PAGINATION_LOOP: repeated nextLink.');
    if (pageCount >= PAGINATION_MAX_PAGES) throw new Error('RELATIONSHIP_PAGINATION_PAGE_CAP: page cap exceeded.');
    seen[url] = true;
    pageCount += 1;
    const page = graphFetch_(url, microsoftTaskRequestOptions_({ method: 'get' }));
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.value)) {
      throw new Error('RELATIONSHIP_MALFORMED_PAGE: value must be an array.');
    }
    page.value.forEach(function(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.id !== 'string' || !item.id) {
        throw new Error('RELATIONSHIP_MALFORMED_ITEM: invalid attachment.');
      }
      items.push(item);
    });
    const hasNext = Object.prototype.hasOwnProperty.call(page, '@odata.nextLink');
    if (!hasNext) {
      url = null;
    } else if (typeof page['@odata.nextLink'] !== 'string' || !page['@odata.nextLink']) {
      throw new Error('RELATIONSHIP_MALFORMED_PAGE: nextLink must be a non-empty string.');
    } else {
      url = page['@odata.nextLink'];
    }
  }
  return { kind: 'OBSERVED_COMPLETE', items: items, pageCount: pageCount };
}

function getMsTask_(listId, taskId) {
  try {
    return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) +
      '/tasks/' + encodeURIComponent(taskId), microsoftTaskRequestOptions_());
  } catch (e) {
    if (isNotFoundError_(e)) return null;
    throw e;
  }
}

function createMsList_(displayName) {
  return graphFetch_(MS_TODO_BASE, {
    method: 'post',
    payload: JSON.stringify({ displayName: displayName || '(Untitled list)' })
  });
}

function createGList_(title) {
  return gFetch_('/users/@me/lists', {
    method: 'post',
    payload: JSON.stringify({ title: title || '(Untitled list)' })
  });
}

function deleteGList_(listId) {
  return gFetch_('/users/@me/lists/' + encodeURIComponent(listId), {
    method: 'delete'
  });
}

function deleteMsList_(listId) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId), {
    method: 'delete'
  });
}

function syncTimeZone_() {
  if (typeof Session !== 'undefined' &&
      Session && typeof Session.getScriptTimeZone === 'function') {
    const timeZone = Session.getScriptTimeZone();
    if (typeof timeZone === 'string' && timeZone.trim()) return timeZone.trim();
  }
  return DEFAULT_SYNC_TIME_ZONE;
}

function validDateOnly_(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1] ? match[1] + '-' + match[2] + '-' + match[3] : null;
}

function dateOnly_(value) {
  return validDateOnly_(value);
}

function googleDueDateOnly_(value) {
  const match = String(value || '').trim().match(
    /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/
  );
  return match ? validDateOnly_(match[1]) : null;
}

function parseMicrosoftDateTime_(value) {
  const raw = String(value || '').trim();
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i
  );
  if (!match || !validDateOnly_(match[1]) || Number(match[2]) > 23 ||
      Number(match[3]) > 59 || (match[4] && Number(match[4]) > 59)) {
    return null;
  }
  if (match[6] && match[6].toUpperCase() !== 'Z') {
    const offset = match[6].slice(1).replace(':', '');
    if (Number(offset.slice(0, 2)) > 23 || Number(offset.slice(2, 4)) > 59) return null;
  }
  return {
    raw: raw,
    date: match[1],
    hour: Number(match[2]),
    minute: Number(match[3]),
    second: match[4] ? Number(match[4]) : 0,
    millisecond: match[5] ? Number(('0' + match[5]) * 1000) : 0,
    hasOffset: !!match[6]
  };
}

function timeZoneIsSupported_(timeZone) {
  if (!timeZone) return false;
  if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timeZone }).format(new Date(0));
      return true;
    } catch (e) {
      return false;
    }
  }
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    try {
      return /^[+-]\d{4}$/.test(Utilities.formatDate(new Date(0), timeZone, 'Z'));
    } catch (e) {
      return false;
    }
  }
  return timeZone === 'UTC';
}

function resolveTimeZone_(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const timeZone = MICROSOFT_WINDOWS_TIME_ZONES[raw.toLowerCase()] || raw;
  if (timeZone === raw && timeZone !== 'UTC' &&
      !/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/.test(timeZone)) {
    return null;
  }
  return timeZoneIsSupported_(timeZone) ? timeZone : null;
}

function timeZoneOffsetMinutes_(instant, timeZone) {
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    const match = Utilities.formatDate(instant, timeZone, 'Z').match(/([+-])(\d{2})(\d{2})$/);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === '+' ? minutes : -minutes;
  }
  if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(instant);
    const fields = {};
    parts.forEach(function(part) { fields[part.type] = part.value; });
    const local = Date.UTC(
      Number(fields.year), Number(fields.month) - 1, Number(fields.day),
      Number(fields.hour), Number(fields.minute), Number(fields.second)
    );
    return Math.round((local - instant.getTime()) / 60000);
  } catch (e) {
    return null;
  }
}

function localDateTimeInTimeZone_(instant, timeZone) {
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    return parseMicrosoftDateTime_(
      Utilities.formatDate(instant, timeZone, "yyyy-MM-dd'T'HH:mm:ss")
    );
  }
  if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(instant);
    const fields = {};
    parts.forEach(function(part) { fields[part.type] = part.value; });
    return parseMicrosoftDateTime_(
      fields.year + '-' + fields.month + '-' + fields.day + 'T' +
      fields.hour + ':' + fields.minute + ':' + fields.second
    );
  } catch (e) {
    return null;
  }
}

function instantFromMicrosoftLocalDateTime_(parsed, timeZone) {
  const dateParts = parsed.date.split('-').map(Number);
  const localEpoch = Date.UTC(
    dateParts[0], dateParts[1] - 1, dateParts[2],
    parsed.hour, parsed.minute, parsed.second, parsed.millisecond
  );
  let instant = new Date(localEpoch);
  for (let attempt = 0; attempt < 4; attempt++) {
    const offsetMinutes = timeZoneOffsetMinutes_(instant, timeZone);
    if (offsetMinutes === null) return null;
    const next = new Date(localEpoch - offsetMinutes * 60 * 1000);
    if (next.getTime() === instant.getTime()) break;
    instant = next;
  }
  const local = localDateTimeInTimeZone_(instant, timeZone);
  if (!local || local.date !== parsed.date || local.hour !== parsed.hour ||
      local.minute !== parsed.minute || local.second !== parsed.second) {
    return null;
  }
  return instant;
}

function dateInTimeZone_(instant, timeZone) {
  if (!(instant instanceof Date) || isNaN(instant.getTime()) || !timeZone) return null;
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.formatDate === 'function') {
    return validDateOnly_(Utilities.formatDate(instant, timeZone, 'yyyy-MM-dd'));
  }
  if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(instant);
    const fields = {};
    parts.forEach(function(part) { fields[part.type] = part.value; });
    return validDateOnly_(fields.year + '-' + fields.month + '-' + fields.day);
  } catch (e) {
    return null;
  }
}

function googleDue_(msDue) {
  if (!msDue || !msDue.dateTime) return null;
  const parsed = parseMicrosoftDateTime_(msDue.dateTime);
  const syncTimeZone = resolveTimeZone_(syncTimeZone_());
  if (!parsed || !syncTimeZone) return null;

  // A Microsoft due value is either a floating calendar date or an instant,
  // and the payload shape says which:
  //
  //   * No offset marker + exactly midnight — the shape Graph gives a
  //     date-only task when the value is rendered in the zone the date was
  //     authored in.  The due date is the date the user picked, parsed.date.
  //     Routing midnight through an instant and back into the sync time zone
  //     shifts it one calendar day whenever the rendering zone differs from
  //     the sync zone (a negative-UTC-offset project zone sees the previous
  //     day), so the date is taken verbatim.
  //   * Anything else — an offset marker, or a non-midnight local time — is a
  //     real instant and is projected into the sync time zone.
  if (!parsed.hasOffset) {
    // The Microsoft time zone must resolve before any date is derived: an
    // unsupported zone stays fail-closed (null) so the existing Google due
    // is preserved rather than overwritten with a guess.
    const microsoftTimeZone = resolveTimeZone_(msDue.timeZone);
    if (!microsoftTimeZone) return null;
    if (parsed.hour === 0 && parsed.minute === 0 && parsed.second === 0) {
      return validDateOnly_(parsed.date) ? parsed.date + 'T00:00:00.000Z' : null;
    }
    const day = dateInTimeZone_(
      instantFromMicrosoftLocalDateTime_(parsed, microsoftTimeZone), syncTimeZone);
    return day ? day + 'T00:00:00.000Z' : null;
  }

  const normalized = parsed.raw
    .replace(/z$/i, 'Z')
    .replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})$)/, '$1');
  const day = dateInTimeZone_(new Date(normalized), syncTimeZone);
  return day ? day + 'T00:00:00.000Z' : null;
}

function msDue_(googleDue) {
  const day = googleDueDateOnly_(googleDue);
  const timeZone = resolveTimeZone_(syncTimeZone_());
  return day && timeZone ? { dateTime: day + 'T00:00:00', timeZone: timeZone } : null;
}

// Per-execution memo for msAuthoredTimeZone_: undefined = not attempted yet,
// null = attempted and unavailable, string = resolved IANA zone.
let msAuthoredTimeZoneMemo_;

// The time zone the Microsoft account authors its values in (its mailbox
// time zone).  Graph renders date-only dues as local midnight in that zone,
// so asking for it in the Prefer header is what guarantees the midnight
// shape googleDue_ relies on (WO-5 request half).  Fail-soft everywhere:
// no MailboxSettings.Read grant (pre-re-consent tokens) or any read error
// yields null and callers fall back to the sync time zone.
function msAuthoredTimeZone_() {
  if (msAuthoredTimeZoneMemo_ !== undefined) return msAuthoredTimeZoneMemo_;
  msAuthoredTimeZoneMemo_ = null;
  try {
    const grantedScope = String(PropertiesService.getUserProperties()
      .getProperty(MS_PERSONAL_GRANTED_SCOPE_KEY_) || '').toLowerCase();
    if (grantedScope.indexOf('mailboxsettings.read') === -1) return msAuthoredTimeZoneMemo_;
    const raw = graphFetch_(MS_MAILBOX_TIME_ZONE_URL_);
    const value = raw && typeof raw === 'object'
      ? String(raw.value || '')
      : String(raw || '');
    msAuthoredTimeZoneMemo_ = resolveTimeZone_(value);
  } catch (e) {
    msAuthoredTimeZoneMemo_ = null;
  }
  return msAuthoredTimeZoneMemo_;
}

function microsoftTaskRequestOptions_(options) {
  const timeZone = resolveTimeZone_(syncTimeZone_());
  if (!timeZone) {
    throw new Error('SYNC_TIME_ZONE_INVALID: The Apps Script project time zone is not a supported IANA time zone.');
  }
  const request = Object.assign({}, options || {});
  request.headers = Object.assign({}, request.headers || {});
  // Render in the zone the values were authored in when it is known, so a
  // date-only due keeps its local-midnight shape; otherwise the sync time
  // zone (previous behaviour).
  request.headers.Prefer = 'outlook.timezone="' + (msAuthoredTimeZone_() || timeZone) + '"';
  return request;
}

function escapeHtml_(text) {
  // Element-text context only. Do not reuse this helper for HTML attribute
  // values, which also require quote escaping and context-specific handling.
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtml_(text) {
  return escapeHtml_(text).replace(/\r\n|\r|\n/g, '<br>');
}

function htmlToText_(html) {
 return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
 .trim();
}

function microsoftPlainTextBodyCanonical_(text) {
 return String(text == null ? '' : text)
 .replace(/\r\n|\r/g, '\n')
 .replace(/\n$/, '');
}

/* Recurrence marker: MS has recurrence, Google cannot express it. Stamp the
 * Google copy's notes with a single ASCII line so a later Google ID rotation
 * (daily recurrence regenerates the Google task) can still be recognized.
 * The marker is permanent (not a create sentinel); format [TTS-REC:xxxxxx]. */
var TTS_REC_MARKER_PREFIX_ = '[TTS-REC:';
var TTS_REC_MARKER_SUFFIX_ = ']';

function newTtsRecMarker_() {
  const raw = String(newMoveCorrelationId_()).replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 6);
  const code = (raw + '000000').slice(0, 6);
  return TTS_REC_MARKER_PREFIX_ + code + TTS_REC_MARKER_SUFFIX_;
}

function msTaskHasRecurrence_(task) {
  if (!task || typeof task !== 'object') return false;
  const recurrence = task.recurrence;
  if (recurrence === null || recurrence === undefined) return false;
  if (typeof recurrence === 'object') return Object.keys(recurrence).length > 0;
  return Boolean(recurrence);
}

function googleNotesHaveTtsRecMarker_(notes) {
  return String(notes == null ? '' : notes).indexOf(TTS_REC_MARKER_PREFIX_) >= 0;
}

function googlePayloadFromMs_(task, mode) {
  const rawContent = task.body && task.body.content ? task.body.content : '';
  const isHtml = task.body && String(task.body.contentType || '').toLowerCase() === 'html';
  const baseNotes = isHtml ? htmlToText_(rawContent) : microsoftPlainTextBodyCanonical_(rawContent);
  let notes = baseNotes;
  // Only MS→Google create stamps the marker: Google occurrence PATCH paths
  // must never re-stamp (would fork the fingerprint on every round).
  if (mode === 'create' && msTaskHasRecurrence_(task) && !googleNotesHaveTtsRecMarker_(baseNotes)) {
    notes = newTtsRecMarker_() + (baseNotes ? '\n' + baseNotes : '');
  }
  const payload = {
    title: task.title || '(Untitled)',
    notes: notes,
    status: task.status === 'completed' ? 'completed' : 'needsAction'
  };
  if (task && Object.prototype.hasOwnProperty.call(task, 'dueDateTime')) {
    if (task.dueDateTime === null || task.dueDateTime === undefined || task.dueDateTime === '') {
      payload.due = null;
    } else {
      const due = googleDue_(task.dueDateTime);
      // Graph can return a non-IANA zone even when Prefer was requested. With
      // no offset that date cannot be proved, so omit due rather than clear a
      // valid Google value during a PATCH.
      if (due) payload.due = due;
    }
  } else if (mode === 'create') {
    // Keep Google create payload semantics explicit even when a provider mock
    // or partial Graph object omitted the optional dueDateTime field.
    payload.due = null;
  }
  return payload;
}

function googleNotesAreBlank_(notes) {
  return notes == null || /^[\t\n\v\f\r \u00A0]*$/.test(String(notes));
}

/* A title that is missing OR entirely whitespace is not a valid Microsoft task
 * title: Graph rejects it with HTTP 400 "The property 'title' is required".
 * Non-blank titles keep their exact spacing, matching the notes contract.
 * Shared by the Microsoft payload projection and the Step 3 canonical title so
 * both sides agree on the same placeholder for a blank task. */
function canonicalTaskTitle_(task) {
  const raw = task && task.title;
  if (raw === null || raw === undefined) return '(Untitled)';
  const text = String(raw);
  return text.trim() ? text : '(Untitled)';
}

function msPayloadFromGoogle_(task, mode) {
  if (mode !== 'create' && mode !== 'update') {
    throw new Error('MS_PAYLOAD_MODE_REQUIRED: Google → Microsoft payload must specify create or update.');
  }
  const notes = task && task.notes;
  const payload = {
    title: canonicalTaskTitle_(task)
  };
  if (mode === 'update' || !googleNotesAreBlank_(notes)) {
    payload.body = {
      contentType: 'html',
      content: googleNotesAreBlank_(notes) ? '' : textToHtml_(String(notes))
    };
  }
  payload.dueDateTime = msDue_(task.due);
  payload.status = task.status === 'completed' ? 'completed' : 'notStarted';
  return payload;
}

function googleNotesPlainTextProjection_(notes) {
  return googleNotesAreBlank_(notes) ? '' : htmlToText_(textToHtml_(String(notes)));
}

function microsoftNotesPlainTextProjection_(task) {
  const body = task && task.body;
  if (!body || !body.content) return '';
 return String(body.contentType || '').toLowerCase() === 'html'
 ? htmlToText_(body.content)
 : microsoftPlainTextBodyCanonical_(body.content);
}

function sameGoogleAndMicrosoftDue_(googleDue, microsoftDue) {
  const googleDay = googleDueDateOnly_(googleDue);
  if (!googleDay) return !microsoftDue;
  return !!microsoftDue && googleDue_(microsoftDue) === googleDay + 'T00:00:00.000Z';
}

function msUpdatePayloadFromGoogle_(googleTask, microsoftTask) {
  const payload = msPayloadFromGoogle_(googleTask, 'update');
  if (String(payload.title) === String((microsoftTask && microsoftTask.title) || '(Untitled)')) {
    delete payload.title;
  }
  if (sameGoogleAndMicrosoftDue_(googleTask && googleTask.due,
    microsoftTask && microsoftTask.dueDateTime)) {
    delete payload.dueDateTime;
  }
  if (String(payload.status) === String((microsoftTask && microsoftTask.status) || 'notStarted')) {
    delete payload.status;
  }
  if (googleNotesPlainTextProjection_(googleTask && googleTask.notes) ===
      microsoftNotesPlainTextProjection_(microsoftTask)) {
    delete payload.body;
  }
  return payload;
}

function sameGoogleDuePayload_(googleDue, projectedDue) {
  const googleMissing = googleDue === null || googleDue === undefined || googleDue === '';
  const projectedMissing = projectedDue === null || projectedDue === undefined || projectedDue === '';
  if (googleMissing || projectedMissing) return googleMissing && projectedMissing;
  const googleDay = googleDueDateOnly_(googleDue);
  const projectedDay = googleDueDateOnly_(projectedDue);
  return !!googleDay && googleDay === projectedDay;
}

function googleUpdatePayloadFromMs_(microsoftTask, googleTask) {
  const payload = googlePayloadFromMs_(microsoftTask, 'update');
  if (String(payload.title) === String((googleTask && googleTask.title) || '(Untitled)')) {
    delete payload.title;
  }
  if (String(payload.status) === String((googleTask && googleTask.status) || 'needsAction')) {
    delete payload.status;
  }
  if (googleNotesPlainTextProjection_(payload.notes) ===
      googleNotesPlainTextProjection_(googleTask && googleTask.notes)) {
    delete payload.notes;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'due') &&
      sameGoogleDuePayload_(googleTask && googleTask.due, payload.due)) {
    delete payload.due;
  }
  return payload;
}

function createGTask_(listId, payload) {
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks', {
    method: 'post',
    payload: JSON.stringify(payload)
  });
}

function updateGTask_(listId, taskId, payload) {
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId), {
    method: 'patch',
    payload: JSON.stringify(payload)
  });
}

/* Subtask relationship writes deliberately bypass the ordinary retry loop.
 * These endpoints have no client idempotency key; retrying an ambiguous POST
 * can create a duplicate child.  The caller journals before invoking them. */
function createMsChecklistItemNoRetry_(listId, parentTaskId, displayName, isChecked) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(parentTaskId) + '/checklistItems', {
      method: 'post',
      __noRetry: true,
      payload: JSON.stringify({ displayName: displayName, isChecked: isChecked === true })
    });
}

function updateMsChecklistItemNoRetry_(listId, parentTaskId, checklistId, patch) {
  const keys = Object.keys(patch || {});
  if (keys.length !== 1 || ['displayName', 'isChecked'].indexOf(keys[0]) < 0) {
    throw new Error('SUBTASK_CHECKLIST_PATCH_INVALID');
  }
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(parentTaskId) + '/checklistItems/' + encodeURIComponent(checklistId), {
      method: 'patch', __noRetry: true, payload: JSON.stringify(patch)
    });
}

function createGChecklistChildNoRetry_(listId, parentTaskId, title, status) {
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks?parent=' +
    encodeURIComponent(parentTaskId), {
      method: 'post', __noRetry: true,
      payload: JSON.stringify({ title: title, status: status })
    });
}

function updateGChecklistChildNoRetry_(listId, taskId, patch) {
  const keys = Object.keys(patch || {});
  if (keys.length !== 1 || ['title', 'status'].indexOf(keys[0]) < 0) {
    throw new Error('SUBTASK_GOOGLE_PATCH_INVALID');
  }
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId), {
    method: 'patch', __noRetry: true, payload: JSON.stringify(patch)
  });
}

function deleteMsChecklistItemNoRetry_(listId, parentTaskId, checklistId) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(parentTaskId) + '/checklistItems/' + encodeURIComponent(checklistId), {
      method: 'delete', __noRetry: true
    });
}

function deleteGChecklistChildNoRetry_(listId, taskId) {
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId), {
    method: 'delete', __noRetry: true
  });
}

function deleteGTask_(listId, taskId) {
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId), {
    method: 'delete'
  });
}

function createMsTask_(listId, payload) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks',
    microsoftTaskRequestOptions_({
      method: 'post',
      payload: JSON.stringify(payload)
    }));
}

function updateMsTask_(listId, taskId, payload) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId),
    microsoftTaskRequestOptions_({
      method: 'patch',
      payload: JSON.stringify(payload)
    }));
}

function deleteMsTask_(listId, taskId) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' + encodeURIComponent(taskId),
    microsoftTaskRequestOptions_({
      method: 'delete'
    }));
}
