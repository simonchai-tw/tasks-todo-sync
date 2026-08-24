const GTASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
const MS_TODO_BASE = 'https://graph.microsoft.com/v1.0/me/todo/lists';
const STATE_KEY = 'sync_state_main';
const ROUND_FENCE_KEY = STATE_KEY + '_round_fence';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MOVE_CREATE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const RUN_LIMIT_MS = 5.25 * 60 * 1000;
const DESTRUCTIVE_OPERATION_RESERVE_MS = 45 * 1000;
// Apps Script permits a six-minute execution.  Ten minutes is the first
// supported minute cadence which remains above that hard ceiling, so a slow
// run can finish or release its lock before the next scheduled opportunity.
const SYNC_TRIGGER_INTERVAL_MINUTES = 10;
const MOVE_EXTENSION_NAME = 'com.tasksTodoSync.move';
// Graph has returned two service-normalized open-extension identities for To Do.
// Keep an exact allowlist: never accept a bare name, suffix match, or other prefix.
const MOVE_EXTENSION_IDS = [
  'microsoft.graph.openTypeExtension.' + MOVE_EXTENSION_NAME,
  'Microsoft.OutlookServices.OpenTypeExtension.' + MOVE_EXTENSION_NAME
];
const TASK_MOVE_OPERATION_PROPERTY = 'SYNC_TASK_MOVE_OPERATION_JSON';
const TASK_MOVE_OPERATION_RECEIPT_KEY = 'sync_task_move_operation_before_image';
const HTTP_MAX_RETRIES = 4;
// Execution-local only. The durable fence lives in User Properties; this flag
// makes every sync-path checkpoint write a stripped safety projection until a
// final state commit has succeeded.
let SYNC_ROUND_FENCE_ACTIVE_ = false;
const CHUNK_SIZE = 7000;
const ALLOW_NAME_PAIRING = false;
const REQUIRE_LIST_ALLOWLIST = true;
const DEFAULT_ALLOW_DELETIONS = false;
// List deletion is deliberately a separate, opt-in capability.  It is only
// effective in auto discovery mode; explicit ID pairings are an operator
// controlled mode and must never turn a property typo into a remote delete.
const DEFAULT_ALLOW_LIST_DELETIONS = false;
const DEFAULT_ALLOW_TASK_MOVES = false;
const DEFAULT_LIST_DISCOVERY_MODE = 'explicit';
const DEFAULT_SYNC_TIME_ZONE = 'Asia/Taipei';
// These onboarding defaults are intentionally explicit and limited to the
// four non-secret safety switches below.  Keep this separate from runtime
// defaults so an operator can opt into auto discovery through one auditable
// helper without changing credentials, IDs, or sync state.
const SAFE_SETUP_DEFAULTS = {
  SYNC_LIST_DISCOVERY_MODE: 'auto',
  SYNC_ALLOW_DELETIONS: 'false',
  SYNC_ALLOW_LIST_DELETIONS: 'false',
  SYNC_ALLOW_TASK_MOVES: 'false'
};
const MICROSOFT_WINDOWS_TIME_ZONES = {
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
  'taipei standard time': 'Asia/Taipei',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'india standard time': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'singapore standard time': 'Asia/Singapore',
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kyiv',
  'israel standard time': 'Asia/Jerusalem',
  'south africa standard time': 'Africa/Johannesburg',
  'arabian standard time': 'Asia/Dubai',
  'w. australia standard time': 'Australia/Perth',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland'
};
const VERBOSE_LOG = false;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ALERT_KEYS = {
  reauth: 'alert_reauth_last_at',
  fatal: 'alert_fatal_last_at',
  listFault: 'alert_listfault_last_at'
};
let RUN_STARTED_AT = 0;

function initializeSafeDefaults() {
  const properties = PropertiesService.getScriptProperties();
  const defaults = {
    SYNC_LIST_DISCOVERY_MODE: SAFE_SETUP_DEFAULTS.SYNC_LIST_DISCOVERY_MODE,
    SYNC_ALLOW_DELETIONS: SAFE_SETUP_DEFAULTS.SYNC_ALLOW_DELETIONS,
    SYNC_ALLOW_LIST_DELETIONS: SAFE_SETUP_DEFAULTS.SYNC_ALLOW_LIST_DELETIONS,
    SYNC_ALLOW_TASK_MOVES: SAFE_SETUP_DEFAULTS.SYNC_ALLOW_TASK_MOVES
  };
  // The second argument is false by design: preserve every unrelated Script
  // Property, including credentials and existing sync configuration.
  if (typeof properties.setProperties === 'function') {
    properties.setProperties(defaults, false);
  } else {
    Object.keys(defaults).forEach(function(key) {
      properties.setProperty(key, defaults[key]);
    });
  }

  const report = {
    updatedProperties: defaults,
    nextSteps: [
      {
        code: 'SETUP_STATUS',
        message: '請執行 setupStatus() 檢查安全設定與觸發器摘要。'
      },
      {
        code: 'CONFIGURE_MICROSOFT_PROPERTIES',
        message: '請在 Script Properties 設定 Microsoft OAuth 連線資料；摘要不會顯示 credential、email 或 ID 內容。'
      }
    ]
  };
  if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

function setupSafePropertyStatus_(properties, key, expected) {
  const raw = String(properties.getProperty(key) || '');
  const normalized = key === 'SYNC_LIST_DISCOVERY_MODE'
    ? raw.trim().toLowerCase()
    : raw.toLowerCase();
  const correct = normalized === expected;
  return {
    value: correct ? expected : (normalized ? '設定但不符合安全預設' : '未設定'),
    expected: expected,
    correct: correct
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

function setupStatus() {
  const properties = PropertiesService.getScriptProperties();
  const safetyDefaults = {};
  let allSafetyDefaultsCorrect = true;
  Object.keys(SAFE_SETUP_DEFAULTS).forEach(function(key) {
    safetyDefaults[key] = setupSafePropertyStatus_(
      properties, key, SAFE_SETUP_DEFAULTS[key]
    );
    if (!safetyDefaults[key].correct) allSafetyDefaultsCorrect = false;
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
  const triggerStatus = setupTriggerCount_();
  const nextSteps = [];

  if (!allSafetyDefaultsCorrect) {
    nextSteps.push({
      code: 'SAFE_DEFAULTS_NOT_INITIALIZED',
      message: '請執行 initializeSafeDefaults()，將四個安全開關設為預期值。'
    });
  }
  if (!clientIdConfigured || !clientSecretConfigured) {
    nextSteps.push({
      code: 'MICROSOFT_CREDENTIALS_MISSING',
      message: '請在 Script Properties 設定 MS_CLIENT_ID 與 MS_CLIENT_SECRET；本摘要不會顯示其內容。'
    });
  }
  if (!tenantIdConfigured) {
    nextSteps.push({
      code: 'MS_TENANT_DEFAULT_COMMON',
      message: '未設定 MS_TENANT_ID，目前會使用 common。'
    });
  }
  if (!alertEmailConfigured) {
    nextSteps.push({
      code: 'ALERT_EMAIL_NOT_CONFIGURED',
      message: '如需錯誤通知，請設定 ALERT_EMAIL。'
    });
  }
  if (!triggerStatus.available) {
    nextSteps.push({
      code: 'SYNC_TRIGGER_STATUS_UNAVAILABLE',
      message: '目前無法讀取 syncAll 觸發器數量；請在 Apps Script 專案中重新執行 setupStatus()。'
    });
  } else if (triggerStatus.count === 0) {
    nextSteps.push({
      code: 'SYNC_TRIGGER_MISSING',
      message: '尚未找到 syncAll 觸發器；確認設定後再執行 createTrigger()。'
    });
  } else if (triggerStatus.count > 1) {
    nextSteps.push({
      code: 'SYNC_TRIGGER_DUPLICATE',
      message: '找到多個 syncAll 觸發器；請檢查並保留預期的觸發器數量。'
    });
  }
  if (!projectTimeZoneAvailable) {
    nextSteps.push({
      code: 'PROJECT_TIMEZONE_FALLBACK',
      message: '無法讀取專案時區，摘要使用 Asia/Taipei fallback。'
    });
  }
  if (!nextSteps.length) {
    nextSteps.push({
      code: 'SETUP_SUMMARY_READY',
      message: '安全設定摘要已就緒；如尚未授權 Microsoft，請執行 startAuthorization()。'
    });
  }

  const report = {
    projectTimeZone: projectTimeZone,
    safetyDefaults: safetyDefaults,
    allSafetyDefaultsCorrect: allSafetyDefaultsCorrect,
    credentials: {
      msClientIdPresent: clientIdConfigured,
      msClientSecretPresent: clientSecretConfigured,
      msTenantIdPresent: tenantIdConfigured,
      usesCommonTenant: usesCommonTenant,
      alertEmailPresent: alertEmailConfigured
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
  if (!config || !config.clientId || !config.clientSecret) {
    throw new Error('clientId 與 clientSecret 必填。');
  }
  const values = {
    MS_CLIENT_ID: String(config.clientId),
    MS_CLIENT_SECRET: String(config.clientSecret),
    MS_TENANT_ID: String(config.tenantId || 'common'),
    ALERT_EMAIL: String(config.alertEmail || '')
  };
  PropertiesService.getScriptProperties().setProperties(values, false);
  console.log('[Config] 設定已寫入 Script Properties。');
}

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
      '尚未設定 Microsoft Client ID/Secret；請在 Project Settings → Script Properties 設定 ' +
      'MS_CLIENT_ID、MS_CLIENT_SECRET、MS_TENANT_ID、ALERT_EMAIL。'
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
  const allowDeletionsRaw = String(p.getProperty('SYNC_ALLOW_DELETIONS') || '').toLowerCase();
  const allowListDeletionsRaw = String(
    p.getProperty('SYNC_ALLOW_LIST_DELETIONS') || ''
  ).toLowerCase();
  const allowTaskMovesRaw = String(p.getProperty('SYNC_ALLOW_TASK_MOVES') || '').toLowerCase();
  const discoveryMode = String(
    p.getProperty('SYNC_LIST_DISCOVERY_MODE') || DEFAULT_LIST_DISCOVERY_MODE
  ).trim().toLowerCase();
  if (discoveryMode !== 'explicit' && discoveryMode !== 'auto') {
    throw new Error(
      'SYNC_DISCOVERY_MODE_INVALID：SYNC_LIST_DISCOVERY_MODE 只能是 explicit 或 auto。'
    );
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

function isAutoDiscoveryMode_(safety) {
  return !!safety && safety.listDiscoveryMode === 'auto';
}

function requireSyncAllowlist_(safety) {
  if (isAutoDiscoveryMode_(safety)) return;
  if (REQUIRE_LIST_ALLOWLIST && (!safety || !safety.googleListIds.length)) {
    throw new Error(
      'SYNC_ALLOWLIST_REQUIRED：請先執行 listGoogleTaskLists()，再於 Script Properties 設定 ' +
      'SYNC_GOOGLE_LIST_IDS。多個 ID 以逗號分隔。'
    );
  }
}

function requireSafeAutoDiscovery_(safety) {
  // Auto discovery is safe to use with deletion propagation only after list mappings
  // have been resolved. Task deletion itself is guarded by the two-round state machine.
  return safety;
}

function requireExplicitListPairMode_(safety) {
  if (isAutoDiscoveryMode_(safety)) {
    throw new Error(
      'SYNC_PAIR_HELPER_EXPLICIT_MODE_ONLY：目前是 auto 模式；請使用 dryRunReport() 檢視自動清單發現計畫。'
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

function listGoogleTaskLists() {
  const safety = getSafetyConfig_();
  const configured = {};
  safety.googleListIds.forEach(function(id) { configured[id] = true; });
  const lists = getGLists_().map(function(list) {
    return {
      id: list.id,
      title: list.title || '(無標題清單)',
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
      ? 'auto 模式會同步所有 selected=true 的一般 Google 清單；排除名稱由 SYNC_EXCLUDED_LIST_NAMES 控制。'
      : '將要同步的 id 寫入 Script Property：SYNC_GOOGLE_LIST_IDS；多個 ID 以逗號分隔。'
  }, null, 2));
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
        'SYNC_PAIR_CONFIG_REQUIRED：請先設定 Script Property SYNC_LIST_PAIRS_JSON。'
      );
    }
    return { configured: false, pairs: [] };
  }

  requireSyncAllowlist_(safety);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('SYNC_PAIR_INVALID_JSON：SYNC_LIST_PAIRS_JSON 不是有效 JSON。');
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(
      'SYNC_PAIR_INVALID_FORMAT：SYNC_LIST_PAIRS_JSON 必須是至少包含一組配對的 JSON 陣列。'
    );
  }

  const allowed = new Set(safety.googleListIds);
  const seenGoogle = new Set();
  const seenMicrosoft = new Set();
  const pairs = parsed.map(function(item, index) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('SYNC_PAIR_INVALID_ENTRY：第 ' + (index + 1) + ' 組配對必須是物件。');
    }
    const googleListId = typeof item.googleListId === 'string' ? item.googleListId.trim() : '';
    const microsoftListId = typeof item.microsoftListId === 'string' ? item.microsoftListId.trim() : '';
    if (!googleListId || !microsoftListId) {
      throw new Error(
        'SYNC_PAIR_INVALID_ENTRY：第 ' + (index + 1) + ' 組配對缺少 googleListId 或 microsoftListId。'
      );
    }
    if (!allowed.has(googleListId)) {
      throw new Error(
        'SYNC_PAIR_NOT_ALLOWLISTED：Google 清單 ' + googleListId +
        ' 不在 SYNC_GOOGLE_LIST_IDS。'
      );
    }
    if (seenGoogle.has(googleListId)) {
      throw new Error('SYNC_PAIR_DUPLICATE_GOOGLE：Google 清單重複配對：' + googleListId);
    }
    if (seenMicrosoft.has(microsoftListId)) {
      throw new Error('SYNC_PAIR_DUPLICATE_MICROSOFT：Microsoft 清單重複配對：' + microsoftListId);
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
      'SYNC_PAIR_ALLOWLIST_UNPAIRED：設定明確配對後，allowlist 中每個 Google 清單都必須配對。缺少：' +
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
        'SYNC_PAIR_ADOPT_MAPPING_MISSING：allowlist 中的 Google 清單 ' + googleListId +
        ' 尚未有既存 listMap，不能自動採納。'
      );
    }
    const microsoftListId = rawMicrosoftListId.trim();
    if (seenMicrosoft.has(microsoftListId)) {
      throw new Error(
        'SYNC_PAIR_ADOPT_DUPLICATE_MICROSOFT：多個 Google 清單指向同一個 Microsoft 清單 ' +
        microsoftListId + '。'
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
      errors.push('SYNC_PAIR_GOOGLE_NOT_FOUND：找不到 Google 清單 ' + pair.googleListId);
    }
    if (!microsoft) {
      errors.push('SYNC_PAIR_MICROSOFT_NOT_FOUND：找不到 Microsoft 清單 ' + pair.microsoftListId);
    }
    return {
      googleListId: pair.googleListId,
      googleListTitle: google ? (google.title || '(無標題清單)') : null,
      microsoftListId: pair.microsoftListId,
      microsoftListTitle: microsoft ? (microsoft.displayName || '(無標題清單)') : null
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
        'SYNC_PAIR_REBIND_BLOCKED：Google 清單 ' + pair.googleListId +
        ' 已配對到另一個 Microsoft 清單。'
      );
    }
    if (existingGoogle && existingGoogle !== pair.googleListId) {
      errors.push(
        'SYNC_PAIR_MICROSOFT_IN_USE：Microsoft 清單 ' + pair.microsoftListId +
        ' 已配對到另一個 Google 清單。'
      );
    }
    if (state.listFaults.g[pair.googleListId] || state.listFaults.ms[pair.microsoftListId]) {
      errors.push(
        'SYNC_PAIR_FAULTED：配對 ' + pair.googleListId + ' ↔ ' + pair.microsoftListId +
        ' 目前有清單故障標記，請先修復。'
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
        'SYNC_PAIR_TASK_MAPPING_CONFLICT：Google 清單 ' + rec.gListId +
        ' 仍有任務映射指向另一個 Microsoft 清單。'
      );
    }
    if (requestedGoogle && requestedGoogle !== rec.gListId) {
      errors.push(
        'SYNC_PAIR_TASK_MAPPING_CONFLICT：Microsoft 清單 ' + rec.msListId +
        ' 仍有任務映射來自另一個 Google 清單。'
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
      'SYNC_PAIR_NOT_APPLIED：已設定 SYNC_LIST_PAIRS_JSON，但尚未套用。請先執行 ' +
      'validateConfiguredListPairs()，再執行 applyConfiguredListPairs()。'
    );
  }
  return config;
}

function listMicrosoftTaskLists() {
  const safety = getSafetyConfig_();
  const lists = getMsLists_().map(function(list) {
    return {
      id: list.id,
      title: list.displayName || '(無標題清單)',
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
      ? 'auto 模式只會同步 autoEligible=true 的自有非共享一般清單；Flagged Emails 與排除名稱不會同步。'
      : '只將既有清單 ID 寫入 SYNC_LIST_PAIRS_JSON；不要依標題猜測或公開分享 ID 清單。'
  }, null, 2));
  return lists;
}

function validateConfiguredListPairs() {
  return withGlobalLock_(function() {
    const safety = getSafetyConfig_();
    requireExplicitListPairMode_(safety);
    requireSyncAllowlist_(safety);
    if (safety.allowDeletions) {
      throw new Error('SYNC_PAIR_DELETIONS_MUST_BE_FALSE：首次配對前請將 SYNC_ALLOW_DELETIONS 設為 false。');
    }
    const config = getConfiguredListPairs_(safety, true);
    const loaded = loadStateForInspection_();
    if (loaded.corrupt) {
      throw new Error('STATE_CORRUPT：狀態存在但無法讀取，禁止套用清單配對。');
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
      note: '純驗證；未修改同步狀態，也未建立、更新或刪除任何清單與任務。'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function applyConfiguredListPairs() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('SYNC_PAIR_APPLY');
    const safety = getSafetyConfig_();
    requireExplicitListPairMode_(safety);
    requireSyncAllowlist_(safety);
    if (safety.allowDeletions) {
      throw new Error('SYNC_PAIR_DELETIONS_MUST_BE_FALSE：首次配對前請將 SYNC_ALLOW_DELETIONS 設為 false。');
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
      note: '只更新 listMap；未建立、更新或刪除任何雲端清單與任務。請接著執行 dryRunReport()。'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function adoptExistingListMappingsAsConfiguredPairs() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('SYNC_PAIR_ADOPT');
    const safety = getSafetyConfig_();
    requireExplicitListPairMode_(safety);
    requireSyncAllowlist_(safety);
    if (safety.allowDeletions) {
      throw new Error(
        'SYNC_PAIR_DELETIONS_MUST_BE_FALSE：採納既有 mapping 前請將 SYNC_ALLOW_DELETIONS 設為 false。'
      );
    }

    const loaded = loadStateForInspection_();
    if (loaded.corrupt) {
      throw new Error('STATE_CORRUPT：狀態存在但無法讀取，禁止採納既有 mapping。');
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
          'SYNC_PAIR_ADOPT_PROPERTY_CONFLICT：既有 SYNC_LIST_PAIRS_JSON 無法驗證，拒絕覆蓋。' +
          e.message
        );
      }
      if (!configuredListPairsEquivalent_(existingConfig.pairs, pairs)) {
        throw new Error(
          'SYNC_PAIR_ADOPT_PROPERTY_CONFLICT：既有 SYNC_LIST_PAIRS_JSON 與目前 listMap 不同，拒絕覆蓋。'
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
        ? '只由既有 listMap 建立 SYNC_LIST_PAIRS_JSON；未修改同步狀態或任何雲端清單與任務。'
        : '既有 SYNC_LIST_PAIRS_JSON 與 listMap 相同；未執行任何寫入。'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
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

function showRedirectUri() {
  console.log(microsoftService_().getRedirectUri());
}

function startAuthorization() {
  const service = microsoftService_();
  if (service.hasAccess()) {
    console.log('[Auth] 已有有效授權。');
    return;
  }
  console.log('[Auth] 請開啟：' + service.getAuthorizationUrl());
}

function authCallback(request) {
  const ok = microsoftService_().handleCallback(request);
  return HtmlService.createHtmlOutput(ok
    ? '<h2 style="color:green;font-family:sans-serif">授權成功，可關閉此頁。</h2>'
    : '<h2 style="color:red;font-family:sans-serif">授權失敗，請查看 Apps Script log。</h2>');
}

function resetMicrosoftAuthorization() {
  microsoftService_().reset();
  console.log('[Auth] Microsoft OAuth token 已清除。');
}

function newState_() {
  return {
    schema: 3,
    listMap: {},
    g2m: {},
    m2g: {},
    tombstones: { g: {}, m: {} },
    // A candidate is recorded during one complete sync. It cannot cause a remote
    // delete until a later, independently completed inventory confirms it again.
    pendingTaskDeletions: {},
    // A prepared journal is saved before every remote delete. This lets a later
    // run decide whether the delete completed if the final state save was lost.
    deletionJournal: {},
    // Durable cross-list move intent.  A prepared/creating record keeps a
    // remote create from being mistaken for an ordinary unmapped task, while
    // a created record lets a later run finish deleting the old counterpart.
    taskMoveJournal: {},
    // Kept separately from list faults so delete-vs-edit does not hide a whole list.
    taskDeletionConflicts: {},
    // List lifecycle state is intentionally separate from task deletion.  A
    // list candidate owns its pair while it is pending/journaled/conflicted,
    // which prevents the ordinary planner from recreating a survivor.
    listPairMeta: {},
    pendingListDeletions: {},
    listDeletionJournal: {},
    listDeletionConflicts: {},
    // Provider IDs are opaque, so canonical ID tombstones and normalized-name
    // guards must never share a key space.  Keeping name guards in their own
    // mirrored maps makes an ID such as `name:shared` completely ordinary.
    listTombstones: { g: {}, ms: {} },
    listTombstoneNames: { g: {}, ms: {} },
    listFaults: { g: {}, ms: {} },
    health: {
      lastSuccessfulSyncAt: null,
      lastFailedSyncAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0
    },
    updatedAt: null
  };
}

function assertKnownObjectKeys_(value, allowed, label, errorCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.keys(value).forEach(function(key) {
    if (allowed.indexOf(key) >= 0) return;
    throw new Error((errorCode || 'STATE_MALFORMED') + '：' + label + ' 包含未知欄位 ' + key + '，已拒絕覆寫。');
  });
}

function assertListMapOneToOne_(state, errorCode) {
  const seenMicrosoft = {};
  const listMap = state && state.listMap;
  if (!listMap || typeof listMap !== 'object' || Array.isArray(listMap)) return;
  Object.keys(listMap).forEach(function(gListId) {
    const msListId = listMap[gListId];
    if (!gListId || typeof msListId !== 'string' || !msListId) {
      throw new Error((errorCode || 'STATE_MALFORMED') + '：listMap 包含無效清單 ID，已拒絕覆寫。');
    }
    if (seenMicrosoft[msListId] && seenMicrosoft[msListId] !== gListId) {
      throw new Error((errorCode || 'STATE_MALFORMED') + '：listMap 不是一對一配對；Microsoft 清單 ' +
        msListId + ' 同時指向 ' + seenMicrosoft[msListId] + ' 與 ' + gListId + '。');
    }
    seenMicrosoft[msListId] = gListId;
  });
}

function assertStrictSchema3StateShape_(state, errorCode) {
  if (!state || state.schema !== 3) return;
  const allowedTopLevel = [
    'schema', 'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskMoveJournal', 'taskDeletionConflicts', 'listPairMeta',
    'pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts',
    'listTombstones', 'listTombstoneNames', 'listFaults', 'health', 'updatedAt'
  ];
  assertKnownObjectKeys_(state, allowedTopLevel, 'state', errorCode);
  const recordFields = {
    g2m: ['msId', 'gListId', 'msListId', 'gUpdated', 'msUpdated'],
    pendingTaskDeletions: ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'firstConfirmedAt', 'lastConfirmedAt', 'lastRoundId', 'confirmations'],
    deletionJournal: ['phase', 'gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'preparedAt', 'lastBlockedReason', 'lastBlockedAt'],
    taskMoveJournal: ['phase', 'gId', 'oldMsId', 'newMsId', 'gListId', 'oldMsListId',
      'targetMsListId', 'gUpdated', 'oldMsUpdated', 'preparedAt', 'fingerprint',
      'correlationId', 'uncertainConfirmations', 'lastRoundId', 'lastBlockedReason', 'lastBlockedAt'],
    taskDeletionConflicts: ['at', 'reason', 'msId', 'gListId', 'msListId'],
    listPairMeta: ['gListId', 'msListId', 'gTitle', 'msTitle', 'gFingerprint', 'msFingerprint',
      'gDeletable', 'msDeletable', 'autoBothLiveProvenAt'],
    pendingListDeletions: ['key', 'gListId', 'msListId', 'gTitle', 'msTitle', 'missingSide',
      'gFingerprint', 'msFingerprint', 'survivorFingerprint', 'taskPairs', 'taskFingerprint', 'deletable',
      'confirmations', 'lastRoundId', 'firstConfirmedAt', 'lastConfirmedAt'],
    listDeletionJournal: ['key', 'gListId', 'msListId', 'gTitle', 'msTitle', 'missingSide',
      'gFingerprint', 'msFingerprint', 'survivorFingerprint', 'taskPairs', 'taskFingerprint', 'deletable',
      'confirmations', 'lastRoundId', 'firstConfirmedAt', 'lastConfirmedAt', 'phase', 'preparedAt',
      'lastBlockedReason', 'lastBlockedAt'],
    listDeletionConflicts: ['at', 'reason', 'gListId', 'msListId', 'gTitle', 'msTitle', 'gName', 'msName'],
    tombstones: ['at', 'source'],
    listTombstones: ['at', 'source', 'gListId', 'msListId', 'gName', 'msName'],
    listTombstoneNames: ['at', 'source', 'gListId', 'msListId', 'gName', 'msName']
  };
  Object.keys(recordFields).forEach(function(field) {
    const table = state[field];
    if (!table || typeof table !== 'object' || Array.isArray(table)) return;
    if (field === 'tombstones' || field === 'listTombstones' || field === 'listTombstoneNames') {
      ['g', field === 'tombstones' ? 'm' : 'ms'].forEach(function(side) {
        const sideTable = table[side];
        if (!sideTable || typeof sideTable !== 'object' || Array.isArray(sideTable)) return;
        Object.keys(sideTable).forEach(function(key) {
          assertKnownObjectKeys_(sideTable[key], recordFields[field], field + '.' + side + '[' + key + ']', errorCode);
        });
      });
      return;
    }
    Object.keys(table).forEach(function(key) {
      assertKnownObjectKeys_(table[key], recordFields[field], field + '[' + key + ']', errorCode);
    });
  });
}

// Schema 2 is accepted only as the deployed pre-list-lifecycle format.  It
// must not be a bypass for arbitrary fields that would be written back as a
// self-corrupting schema-3 state on the next save.  Task-delete evidence was
// already documented as backward-compatible, so it remains explicitly known.
function assertStrictSchema2StateShape_(state, errorCode) {
  if (!state || state.schema !== 2) return;
  const allowedTopLevel = [
    'schema', 'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskDeletionConflicts', 'listFaults', 'health', 'updatedAt'
  ];
  assertKnownObjectKeys_(state, allowedTopLevel, 'schema=2 state', errorCode);
  const recordFields = {
    g2m: ['msId', 'gListId', 'msListId', 'gUpdated', 'msUpdated'],
    pendingTaskDeletions: ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'firstConfirmedAt', 'lastConfirmedAt', 'lastRoundId', 'confirmations'],
    deletionJournal: ['phase', 'gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'preparedAt', 'lastBlockedReason', 'lastBlockedAt'],
    taskDeletionConflicts: ['at', 'reason', 'msId', 'gListId', 'msListId'],
    tombstones: ['at', 'source'],
    listFaults: ['at', 'reason', 'gListId', 'msListId', 'gListTitle', 'msListTitle']
  };
  ['listMap', 'm2g'].forEach(function(field) {
    const table = state[field];
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error((errorCode || 'STATE_MALFORMED') + '：schema=2 ' + field + ' 必須是物件。');
    }
    Object.keys(table).forEach(function(key) {
      if (typeof table[key] !== 'string') {
        throw new Error((errorCode || 'STATE_MALFORMED') + '：schema=2 ' + field + '[' + key + '] 必須是字串。');
      }
    });
  });
  if (!state.health || typeof state.health !== 'object' || Array.isArray(state.health)) {
    throw new Error((errorCode || 'STATE_MALFORMED') + '：schema=2 health 必須是物件。');
  }
  assertKnownObjectKeys_(state.health,
    ['lastSuccessfulSyncAt', 'lastFailedSyncAt', 'lastErrorMessage', 'consecutiveFailures'],
    'schema=2 health', errorCode);
  Object.keys(recordFields).forEach(function(field) {
    const table = state[field];
    if (table === undefined) return;
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error((errorCode || 'STATE_MALFORMED') + '：schema=2 ' + field + ' 必須是物件。');
    }
    if (field === 'tombstones') {
      assertKnownObjectKeys_(table, ['g', 'm'], 'schema=2 tombstones', errorCode);
      ['g', 'm'].forEach(function(side) {
        const sideTable = table[side];
        if (sideTable === undefined) return;
        if (!sideTable || typeof sideTable !== 'object' || Array.isArray(sideTable)) {
          throw new Error((errorCode || 'STATE_MALFORMED') + '：schema=2 tombstones 必須包含 g/m 物件。');
        }
        Object.keys(sideTable).forEach(function(key) {
          assertKnownObjectKeys_(sideTable[key], recordFields[field], field + '.' + side + '[' + key + ']', errorCode);
        });
      });
      return;
    }
    if (field === 'listFaults') {
      assertKnownObjectKeys_(table, ['g', 'ms'], 'schema=2 listFaults', errorCode);
      ['g', 'ms'].forEach(function(side) {
        const sideTable = table[side];
        if (!sideTable || typeof sideTable !== 'object' || Array.isArray(sideTable)) {
          throw new Error((errorCode || 'STATE_MALFORMED') + '：schema=2 listFaults 必須包含 g/ms 物件。');
        }
        Object.keys(sideTable).forEach(function(key) {
          assertKnownObjectKeys_(sideTable[key], recordFields[field], field + '.' + side + '[' + key + ']', errorCode);
        });
      });
      return;
    }
    Object.keys(table).forEach(function(key) {
      assertKnownObjectKeys_(table[key], recordFields[field], field + '[' + key + ']', errorCode);
    });
  });
}

function validMoveCorrelationId_(value) {
  // Utilities.getUuid() produces the canonical UUID form.  Do not accept an
  // arbitrary non-empty string here: a malformed marker would otherwise turn a
  // stale journal into a potentially adoptable remote task.
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function newMoveCorrelationId_() {
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.getUuid === 'function') {
    const value = Utilities.getUuid();
    if (validMoveCorrelationId_(value)) return value;
    throw new Error('MOVE_CORRELATION_GENERATION_FAILED：Utilities.getUuid() 未回傳有效 UUID。');
  }
  // Node tests do not provide Apps Script Utilities.  This fallback is never
  // used in Apps Script, but keeps the pure synchronizer testable there.
  function hex(count) {
    let value = '';
    while (value.length < count) value += Math.floor(Math.random() * 0x100000000).toString(16);
    return value.slice(0, count);
  }
  return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-8' + hex(3) + '-' + hex(12);
}

function normalizeState_(state) {
  if (state === undefined || state === null) return newState_();
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('STATE_MALFORMED：同步狀態必須是物件，已拒絕覆寫。');
  }
  if (state.schema !== 2 && state.schema !== 3) {
    throw new Error('STATE_SCHEMA_UNSUPPORTED：只支援 schema=2 或 schema=3，已拒絕覆寫。');
  }
  // Validate the deployed schema 2 shape before its additive migration, then
  // validate the complete schema 3 lifecycle state. Silently ignoring a
  // typoed journal can recreate a remotely deleted list or task.
  assertStrictSchema2StateShape_(state, 'STATE_MALFORMED');
  assertStrictSchema3StateShape_(state, 'STATE_MALFORMED');
  const isSchema2 = state.schema === 2;
  // Schema 2 has no list lifecycle provenance.  Upgrade only by adding empty
  // fields; never infer proof or discard unknown malformed values.
  if (isSchema2) state.schema = 3;
  const requiredObjects = [
    'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskDeletionConflicts', 'listFaults', 'health'
  ];
  requiredObjects.forEach(function(field) {
    if (state[field] === undefined) state[field] = {};
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error('STATE_MALFORMED：' + field + ' 必須是物件，已拒絕覆寫。');
    }
  });
  ['taskMoveJournal', 'listPairMeta', 'pendingListDeletions', 'listDeletionJournal',
    'listDeletionConflicts'].forEach(function(field) {
    if (state[field] === undefined) state[field] = {};
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error('STATE_MALFORMED：' + field + ' 必須是物件，已拒絕覆寫。');
    }
  });
  if (state.listTombstones === undefined) state.listTombstones = { g: {}, ms: {} };
  if (!state.listTombstones || typeof state.listTombstones !== 'object' || Array.isArray(state.listTombstones) ||
      !state.listTombstones.g || typeof state.listTombstones.g !== 'object' || Array.isArray(state.listTombstones.g) ||
      !state.listTombstones.ms || typeof state.listTombstones.ms !== 'object' || Array.isArray(state.listTombstones.ms)) {
    throw new Error('STATE_MALFORMED：listTombstones 必須包含 g/ms 物件，已拒絕覆寫。');
  }
  if (state.listTombstoneNames === undefined) {
    if (!isSchema2) {
      throw new Error('STATE_MALFORMED：schema=3 缺少 listTombstoneNames，已拒絕猜測或重建名稱防護。');
    }
    state.listTombstoneNames = { g: {}, ms: {} };
  }
  if (!state.listTombstoneNames || typeof state.listTombstoneNames !== 'object' || Array.isArray(state.listTombstoneNames) ||
      !state.listTombstoneNames.g || typeof state.listTombstoneNames.g !== 'object' || Array.isArray(state.listTombstoneNames.g) ||
      !state.listTombstoneNames.ms || typeof state.listTombstoneNames.ms !== 'object' || Array.isArray(state.listTombstoneNames.ms)) {
    throw new Error('STATE_MALFORMED：listTombstoneNames 必須包含 g/ms 物件，已拒絕覆寫。');
  }
  if (!state.tombstones.g || typeof state.tombstones.g !== 'object' || Array.isArray(state.tombstones.g) ||
      !state.tombstones.m || typeof state.tombstones.m !== 'object' || Array.isArray(state.tombstones.m)) {
    throw new Error('STATE_MALFORMED：tombstones 必須包含 g/m 物件，已拒絕覆寫。');
  }
  if (!state.listFaults.g || typeof state.listFaults.g !== 'object' || Array.isArray(state.listFaults.g) ||
      !state.listFaults.ms || typeof state.listFaults.ms !== 'object' || Array.isArray(state.listFaults.ms)) {
    throw new Error('STATE_MALFORMED：listFaults 必須包含 g/ms 物件，已拒絕覆寫。');
  }
  // A schema-2 state becomes schema=3 above. Re-run strict validation only
  // after every additive default is present, so no unknown top-level or task
  // lifecycle record can be silently persisted into a future self-corruption.
  assertStrictSchema3StateShape_(state, 'STATE_MALFORMED');
  assertListMapOneToOne_(state, 'STATE_MALFORMED');
  validateLoadedListDeletionState_(state);
  state.health.lastSuccessfulSyncAt = state.health.lastSuccessfulSyncAt || null;
  state.health.lastFailedSyncAt = state.health.lastFailedSyncAt || null;
  state.health.lastErrorMessage = state.health.lastErrorMessage || null;
  state.health.consecutiveFailures = state.health.consecutiveFailures || 0;
  // Do not rebuild reverse mappings during a migration.  Repairing a corrupt
  // state by deleting information can recreate remotely deleted objects.
  Object.keys(state.pendingTaskDeletions).forEach(function(gId) {
    const pending = state.pendingTaskDeletions[gId];
    if (!state.g2m[gId]) {
      throw new Error('STATE_MALFORMED：pendingTaskDeletions[' + gId + '] 缺少 mapping，已拒絕覆寫。');
      return;
    }
    // A ready 2/2 candidate must already have a prepared deletion journal.
    // Legacy residue has no proof that its second round completed, so discard
    // it entirely: the next sync must begin a fresh 1/2 confirmation.
    if (pending && Number(pending.confirmations || 0) > 1) {
      // Ready task candidates have never been durable proof (a journal is the
      // only safe second-round state), including in old in-memory test/state
      // exports. Discard this specific legacy task residue; schema-3 list
      // lifecycle fields remain strict and are never normalized away.
      delete state.pendingTaskDeletions[gId];
    }
  });
  Object.keys(state.taskDeletionConflicts).forEach(function(gId) {
    if (!state.g2m[gId]) {
      throw new Error('STATE_MALFORMED：taskDeletionConflicts[' + gId + '] 缺少 mapping，已拒絕覆寫。');
    }
  });
  Object.keys(state.taskMoveJournal).forEach(function(gId) {
    const journal = state.taskMoveJournal[gId];
    const mapping = state.g2m[gId];
    const validMovePhases = ['creating', 'retry_create', 'created'];
    if (!journal || !mapping || journal.gId !== gId || journal.oldMsId !== mapping.msId ||
        journal.oldMsListId !== mapping.msListId || !journal.targetMsListId ||
        !journal.gListId || !journal.preparedAt || !journal.fingerprint ||
        validMovePhases.indexOf(journal.phase) < 0 ||
        (journal.phase === 'created' && !journal.newMsId) ||
        !Number.isInteger(Number(journal.uncertainConfirmations || 0)) ||
        Number(journal.uncertainConfirmations || 0) < 0 ||
        Number(journal.uncertainConfirmations || 0) > 2 ||
        (Object.prototype.hasOwnProperty.call(journal, 'correlationId') &&
          !validMoveCorrelationId_(journal.correlationId))) {
      throw new Error('STATE_MALFORMED：taskMoveJournal[' + gId +
        '] 與 mapping 不一致或缺少復原證據，已拒絕覆寫。');
    }
  });
  return state;
}

function truncateLabel_(value, max) {
  value = String(value || '');
  max = max || 80;
  return value.length <= max ? value : value.slice(0, max) + '…';
}

function saveBlobAtomic_(baseKey, value) {
  const props = PropertiesService.getUserProperties();
  const oldManifestRaw = props.getProperty(baseKey + '_manifest');
  let previousGeneration = null;
  if (oldManifestRaw) {
    try {
      previousGeneration = JSON.parse(oldManifestRaw).generation || null;
    } catch (e) {
      previousGeneration = null;
    }
  }
  const encoded = encodeURIComponent(JSON.stringify(value));
  const generation = String(Date.now()) + '_' + Math.floor(Math.random() * 1000000);
  const prefix = baseKey + '_gen_' + generation + '_';
  const batch = {};
  let count = 0;
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    batch[prefix + count] = encoded.slice(i, i + CHUNK_SIZE);
    count++;
  }
  batch[prefix + 'count'] = String(count);
  props.setProperties(batch, false);
  props.setProperty(baseKey + '_manifest', JSON.stringify({
    generation: generation,
    count: count,
    previousGeneration: previousGeneration
  }));
  cleanupOldGenerations_(props, baseKey, generation, previousGeneration);
}

function loadBlobAtomic_(baseKey) {
  const props = PropertiesService.getUserProperties();
  const rawManifest = props.getProperty(baseKey + '_manifest');
  if (!rawManifest) return null;
  try {
    const manifest = JSON.parse(rawManifest);
    const prefix = baseKey + '_gen_' + manifest.generation + '_';
    const parts = [];
    for (let i = 0; i < manifest.count; i++) {
      const piece = props.getProperty(prefix + i);
      if (piece === null) throw new Error('missing chunk ' + i);
      parts.push(piece);
    }
    return JSON.parse(decodeURIComponent(parts.join('')));
  } catch (e) {
    console.error('[Storage] 讀取失敗：' + e.message);
    return null;
  }
}

function cleanupOldGenerations_(props, baseKey, keepGeneration, previousGeneration) {
  const keepPrefixes = [baseKey + '_gen_' + keepGeneration + '_'];
  if (previousGeneration) {
    keepPrefixes.push(baseKey + '_gen_' + previousGeneration + '_');
  }
  const deleteKeys = props.getKeys().filter(function(key) {
    if (key.indexOf(baseKey + '_gen_') !== 0) return false;
    return !keepPrefixes.some(function(prefix) {
      return key.indexOf(prefix) === 0;
    });
  });
  deleteKeys.forEach(function(key) {
    props.deleteProperty(key);
  });
}

function saveState_(state) {
  state.updatedAt = new Date().toISOString();
  saveBlobAtomic_(STATE_KEY, state);
}

function syncRoundFenceStatus_() {
  const raw = PropertiesService.getUserProperties().getProperty(ROUND_FENCE_KEY);
  if (!raw) return { active: false };
  try {
    const fence = JSON.parse(raw);
    return {
      active: true,
      valid: !!fence && typeof fence === 'object' && typeof fence.roundId === 'string' && !!fence.roundId,
      roundId: fence && fence.roundId || null,
      startedAt: fence && fence.startedAt || null
    };
  } catch (e) {
    return { active: true, valid: false, roundId: null, startedAt: null };
  }
}

function assertNoActiveSyncRoundFence_(code) {
  const fence = syncRoundFenceStatus_();
  if (fence.active) {
    throw new Error((code || 'STATE_CHANGE') +
      '_ROUND_FENCE_ACTIVE：上一輪同步尚未完成 durable commit；請先執行 syncAll() 讓它安全恢復。');
  }
}

function openSyncRoundFence_(roundId) {
  const props = PropertiesService.getUserProperties();
  const expectedRoundId = String(roundId || Date.now());
  SYNC_ROUND_FENCE_ACTIVE_ = false;
  try {
    props.setProperty(ROUND_FENCE_KEY, JSON.stringify({
      roundId: expectedRoundId,
      startedAt: new Date().toISOString(),
      phase: 'active'
    }));
    const written = JSON.parse(props.getProperty(ROUND_FENCE_KEY) || 'null');
    if (!written || written.roundId !== expectedRoundId || written.phase !== 'active') {
      throw new Error('round fence read-back mismatch');
    }
  } catch (e) {
    SYNC_ROUND_FENCE_ACTIVE_ = false;
    throw new Error('SYNC_ROUND_FENCE_SET_FAILED：無法建立同步 safety fence；已在 inventory 前停止。' + e.message);
  }
  SYNC_ROUND_FENCE_ACTIVE_ = true;
}

function clearSyncRoundFence_() {
  const props = PropertiesService.getUserProperties();
  try {
    props.deleteProperty(ROUND_FENCE_KEY);
    if (props.getProperty(ROUND_FENCE_KEY)) {
      throw new Error('round fence property still exists');
    }
  } catch (e) {
    // Keep the execution-local flag true as well.  The next sync will see the
    // durable fence, strip volatile proof, and retry the safe baseline.
    throw new Error('SYNC_ROUND_FENCE_CLEAR_FAILED：final state 已保存但無法清除 safety fence；下輪將安全捨棄 volatile proof。' + e.message);
  }
  SYNC_ROUND_FENCE_ACTIVE_ = false;
}

function exactJournalListPairMeta_(state) {
  const preserved = {};
  ensureListDeletionState_(state);
  Object.keys(state.listDeletionJournal || {}).forEach(function(key) {
    const journal = state.listDeletionJournal[key];
    if (!journal || ['prepared', 'paused'].indexOf(journal.phase) < 0 ||
        !hasExactUniqueListMapPair_(state, journal.gListId, journal.msListId)) return;
    const meta = state.listPairMeta[key];
    if (meta && meta.gListId === journal.gListId && meta.msListId === journal.msListId) {
      preserved[key] = cloneTaskDeletionValue_(meta);
    }
  });
  return preserved;
}

function strippedVolatileProofState_(state) {
  const projected = cloneTaskDeletionValue_(state);
  ensureTaskDeletionState_(projected);
  ensureListDeletionState_(projected);
  // A journal is separately durable delete intent. It is the sole exception:
  // recovery needs its exact historical pair meta to classify a remote-success
  // one-sided delete as fresh both-missing, but malformed/rebound journals get
  // no provenance and therefore fail closed.
  projected.listPairMeta = exactJournalListPairMeta_(state);
  projected.pendingTaskDeletions = {};
  projected.pendingListDeletions = {};
  return projected;
}

function persistSyncState_(state, options) {
  const finalCommit = !!(options && options.finalCommit);
  if (SYNC_ROUND_FENCE_ACTIVE_ && !finalCommit) {
    saveState_(strippedVolatileProofState_(state));
    return;
  }
  saveState_(state);
}

function sanitizePreexistingSyncRoundFence_(state) {
  const fence = syncRoundFenceStatus_();
  if (!fence.active) return state;
  // This runs before opening the new fence and before every inventory/remote
  // call. Persist first; clear second. A clear failure leaves the old fence
  // for an idempotent repeat and blocks the new round.
  const sanitized = strippedVolatileProofState_(state);
  saveState_(sanitized);
  clearSyncRoundFence_();
  return sanitized;
}

function loadStateForSync_() {
  const props = PropertiesService.getUserProperties();
  const rawManifest = props.getProperty(STATE_KEY + '_manifest');
  if (!rawManifest) {
    return newState_();
  }
  const raw = loadBlobAtomic_(STATE_KEY);
  if (!raw) {
    throw new Error('STATE_CORRUPT：狀態存在但無法讀取。請執行 exportRawSyncState() 並暫停同步。');
  }
  return normalizeState_(raw);
}

function loadStateForInspection_() {
  const props = PropertiesService.getUserProperties();
  const rawManifest = props.getProperty(STATE_KEY + '_manifest');
  const raw = loadBlobAtomic_(STATE_KEY);
  if (rawManifest && !raw) {
    return { corrupt: true, state: newState_() };
  }
  try {
    return { corrupt: false, state: normalizeState_(raw) };
  } catch (e) {
    // Inspection must never make malformed resurrection evidence invisible.
    // Keep mutation paths fail-closed in loadStateForSync_, but allow health
    // to report bounded list-tombstone direction/alias reason codes.
    return {
      corrupt: true,
      state: newState_(),
      listTombstoneIntegrityIssues: listTombstoneIntegrityIssues_(raw)
    };
  }
}

function tombstoneEvidenceIsUnexpired_(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return true;
  const at = Number(record.at);
  // Malformed tombstone evidence is deliberately retained by cleanup and must
  // therefore also survive import/restore until an operator reviews it.
  if (!isFinite(at)) return true;
  return at > now - TOMBSTONE_TTL_MS;
}

function assertTombstoneEvidencePreserved_(current, replacement, now) {
  now = now === undefined ? Date.now() : now;
  const replacementTask = replacement && replacement.tombstones || {};
  [
    { current: current.tombstones || {}, replacement: replacementTask, sides: ['g', 'm'], label: 'task tombstone' }
  ].forEach(function(group) {
    group.sides.forEach(function(side) {
      const currentSide = group.current[side] || {};
      const replacementSide = group.replacement[side] || {};
      Object.keys(currentSide).forEach(function(idOrName) {
        const existing = currentSide[idOrName];
        if (!tombstoneEvidenceIsUnexpired_(existing, now)) return;
        const incoming = replacementSide[idOrName];
        const oldAt = existing && typeof existing === 'object' ? Number(existing.at) : NaN;
        const newAt = incoming && typeof incoming === 'object' ? Number(incoming.at) : NaN;
        const preserved = incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
          (isFinite(oldAt) ? isFinite(newAt) && newAt >= oldAt :
            JSON.stringify(incoming) === JSON.stringify(existing));
        if (!preserved) {
          throw new Error('STATE_TOMBSTONE_PRESERVATION_REQUIRED：' + group.label + ' ' + side +
            '[' + idOrName + '] 尚未過期，匯入/還原不得移除或回退其 resurrection evidence。');
        }
      });
    });
  });
  assertListTombstoneCanonicalsPreserved_(current, replacement, now);
}

// List tombstones reserve an exact cross-provider pair, not merely whichever
// individual ID happened to be used as a storage key.  Import/restore must
// therefore not accept a newer, integrity-valid split such as g-old↔ms-new
// plus g-new↔ms-old. Name guards are derived from these canonicals and may be
// repointed only when their underlying canonical evidence survives.
function assertListTombstoneCanonicalsPreserved_(current, replacement, now) {
  const currentTombstones = current && current.listTombstones || {};
  const replacementTombstones = replacement && replacement.listTombstones || {};
  ['g', 'ms'].forEach(function(side) {
    const currentSide = currentTombstones[side] || {};
    const replacementSide = replacementTombstones[side] || {};
    Object.keys(currentSide).forEach(function(id) {
      const existing = currentSide[id];
      const expectedId = side === 'g' ? existing && existing.gListId : existing && existing.msListId;
      // A loaded current state is already strict, but keep this helper
      // conservative if it is called directly by an administrative test/tool.
      if (id !== expectedId || !tombstoneEvidenceIsUnexpired_(existing, now)) return;
      const incoming = replacementSide[id];
      const oldAt = existing && typeof existing === 'object' ? Number(existing.at) : NaN;
      const newAt = incoming && typeof incoming === 'object' ? Number(incoming.at) : NaN;
      const sameCanonical = incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
        incoming.gListId === existing.gListId && incoming.msListId === existing.msListId &&
        incoming.gName === existing.gName && incoming.msName === existing.msName &&
        incoming.source === existing.source;
      const atLeastAsNew = isFinite(oldAt) ? isFinite(newAt) && newAt >= oldAt :
        JSON.stringify(incoming) === JSON.stringify(existing);
      if (!sameCanonical || !atLeastAsNew) {
        throw new Error('STATE_TOMBSTONE_PRESERVATION_REQUIRED：list tombstone ' + side + '[' + id +
          '] 尚未過期，匯入/還原不得拆分、改綁、改名或回退其 exact-pair resurrection evidence。');
      }
    });
  });
}

function assertHistoricListGuardsPreserved_(current, replacement) {
  const currentGuards = current && current.listDeletionConflicts || {};
  const replacementGuards = replacement && replacement.listDeletionConflicts || {};
  Object.keys(currentGuards).forEach(function(key) {
    const existing = currentGuards[key];
    if (!existing || existing.reason !== 'LIST_REPAIR_HISTORIC_PAIR_GUARD') return;
    const incoming = replacementGuards[key];
    const oldAt = durableEvidenceTimestampMs_(existing.at);
    const newAt = incoming && durableEvidenceTimestampMs_(incoming.at);
    const samePairAndNames = incoming && incoming.reason === existing.reason &&
      incoming.gListId === existing.gListId && incoming.msListId === existing.msListId &&
      (incoming.gTitle || incoming.gName || '') === (existing.gTitle || existing.gName || '') &&
      (incoming.msTitle || incoming.msName || '') === (existing.msTitle || existing.msName || '');
    const atLeastAsNew = oldAt !== null ? newAt !== null && newAt >= oldAt :
      JSON.stringify(incoming) === JSON.stringify(existing);
    if (!samePairAndNames || !atLeastAsNew) {
      throw new Error('STATE_HISTORIC_GUARD_PRESERVATION_REQUIRED：repair historic pair ' + key +
        ' 仍阻擋自動重建，匯入/還原不得移除、改綁或回退其 reservation evidence。');
    }
  });
}

// Repair guards are written with ISO timestamps, while tombstones use epoch
// milliseconds.  Replacement preflight must compare both forms; treating an
// ISO timestamp as malformed would accept only byte-identical guard records
// and make a genuinely newer safe state impossible to import.
function durableEvidenceTimestampMs_(value) {
  const numberValue = Number(value);
  if (isFinite(numberValue)) return numberValue;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : parsed;
}

function sameEvidenceFields_(existing, incoming, fields) {
  return !!existing && typeof existing === 'object' && !Array.isArray(existing) &&
    !!incoming && typeof incoming === 'object' && !Array.isArray(incoming) && fields.every(function(field) {
    return existing[field] === incoming[field];
  });
}

function sameEvidenceTaskPairs_(existing, incoming) {
  return JSON.stringify(existing.taskPairs || []) === JSON.stringify(incoming.taskPairs || []);
}

function evidenceRecordAtLeastAsNew_(existing, incoming, timestampFields) {
  let oldAt = null;
  let newAt = null;
  (timestampFields || []).some(function(field) {
    oldAt = durableEvidenceTimestampMs_(existing[field]);
    return oldAt !== null;
  });
  (timestampFields || []).some(function(field) {
    newAt = durableEvidenceTimestampMs_(incoming && incoming[field]);
    return newAt !== null;
  });
  // If an older schema/runtime did not emit a usable timestamp, only a
  // byte-identical record is safe.  We must never treat opaque evidence as
  // expired merely because replacement cannot order it.
  return oldAt === null ? JSON.stringify(incoming) === JSON.stringify(existing) :
    newAt !== null && newAt >= oldAt;
}

function assertReservationTablePreserved_(currentTable, replacementTable, label, compatible) {
  Object.keys(currentTable || {}).forEach(function(key) {
    const existing = currentTable[key];
    const incoming = replacementTable && replacementTable[key];
    if (!compatible(existing, incoming)) {
      throw new Error('STATE_DELETION_EVIDENCE_PRESERVATION_REQUIRED：' + label + '[' + key +
        '] 仍是 anti-recreate/delete reservation，匯入/還原不得移除、改綁或回退其 evidence。');
    }
  });
}

// Import and restore replace a whole state generation.  A first-round
// candidate or a delete-vs-edit conflict reserves the exact task/list pair;
// silently dropping it together with its mapping would let the normal planner
// recreate a possible remote-delete survivor.  These records are therefore
// treated as durable resurrection evidence just like tombstones.  No merge is
// attempted: a replacement must already contain compatible, same-or-newer
// evidence before it may become current.
function assertActiveDeletionEvidencePreserved_(current, replacement) {
  assertHistoricListGuardsPreserved_(current, replacement);
  assertReservationTablePreserved_(
    current && current.pendingTaskDeletions,
    replacement && replacement.pendingTaskDeletions,
    'pendingTaskDeletions',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated']) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['lastConfirmedAt', 'firstConfirmedAt']);
    }
  );
  assertReservationTablePreserved_(
    current && current.taskDeletionConflicts,
    replacement && replacement.taskDeletionConflicts,
    'taskDeletionConflicts',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['msId', 'gListId', 'msListId', 'reason']) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['at']);
    }
  );
  assertReservationTablePreserved_(
    current && current.pendingListDeletions,
    replacement && replacement.pendingListDeletions,
    'pendingListDeletions',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['key', 'gListId', 'msListId', 'gTitle', 'msTitle', 'missingSide',
          'gFingerprint', 'msFingerprint', 'survivorFingerprint', 'taskFingerprint', 'deletable']) &&
        sameEvidenceTaskPairs_(existing, incoming) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['lastConfirmedAt', 'firstConfirmedAt']);
    }
  );
  assertReservationTablePreserved_(
    current && current.listDeletionConflicts,
    replacement && replacement.listDeletionConflicts,
    'listDeletionConflicts',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['gListId', 'msListId', 'gTitle', 'msTitle', 'gName', 'msName', 'reason']) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['at']);
    }
  );
}

function withGlobalLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('[Lock] 另一同步執行中，本輪跳過。');
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
      '：刪除安全邊界前時間不足；未執行後續 live read、durable journal save 或 remote delete。');
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
  if (VERBOSE_LOG) return title || '(無標題)';
  return id;
}

function canSendAlert_(key) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = Number(props.getProperty(key) || 0);
  return (now - last) >= ALERT_COOLDOWN_MS;
}

function markAlertSent_(key) {
  PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
}

function sendMailAlert_(subject, body) {
  try {
    const c = getConfig_();
    if (!c.alertEmail) {
      console.error('[Alert] 未設定 ALERT_EMAIL，無法寄送警報。');
      return false;
    }
    if (MailApp.getRemainingDailyQuota && MailApp.getRemainingDailyQuota() < 1) {
      console.warn('[Alert] MailApp 配額不足，跳過寄信。');
      return false;
    }
    MailApp.sendEmail({ to: c.alertEmail, subject: subject, body: body });
    return true;
  } catch (e) {
    console.error('[Alert] 寄送失敗：' + e.message);
    return false;
  }
}

function sendReauthorizationAlert_() {
  let url;
  try {
    url = microsoftService_().getAuthorizationUrl();
  } catch (e) {
    console.error('[Auth] 產生授權網址失敗：' + e.message);
    return;
  }
  if (!canSendAlert_(ALERT_KEYS.reauth)) {
    console.warn('[Auth] 重新授權警報仍在冷卻期，跳過寄信。');
    return;
  }
  const sent = sendMailAlert_('[同步引擎] Microsoft To Do 授權需更新', '同步已停止。請開啟以下網址重新授權：\n' + url);
  if (sent) markAlertSent_(ALERT_KEYS.reauth);
}

function sendFatalAlert_(message) {
  if (!canSendAlert_(ALERT_KEYS.fatal)) {
    console.warn('[Alert] 嚴重錯誤警報仍在冷卻期，跳過寄信。');
    return;
  }
  const sent = sendMailAlert_('[同步引擎] 同步失敗', '同步失敗，請查看 Apps Script 執行紀錄。\n\n' + message);
  if (sent) markAlertSent_(ALERT_KEYS.fatal);
}

function sendListFaultAlert_(message) {
  if (!canSendAlert_(ALERT_KEYS.listFault)) {
    console.warn('[ListFault] 清單隔離警報仍在冷卻期，跳過寄信。');
    return;
  }
  const sent = sendMailAlert_('[同步引擎] 清單隔離警告', message + '\n\n請執行 listSyncFaults() 與 dryRunReport()。');
  if (sent) markAlertSent_(ALERT_KEYS.listFault);
}

function fetchJsonWithRetry_(url, options, authKind) {
  let lastError = null;
  for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt++) {
    const opts = Object.assign({ muteHttpExceptions: true }, options || {});
    opts.headers = Object.assign({}, opts.headers || {});
    if (authKind === 'ms') {
      const service = microsoftService_();
      if (!service.hasAccess()) {
        sendReauthorizationAlert_();
        throw new Error('Microsoft 授權失效，請重新授權。');
      }
      opts.headers.Authorization = 'Bearer ' + service.getAccessToken();
    } else {
      opts.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
    }
    if (opts.payload !== undefined && !opts.headers['Content-Type']) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const response = UrlFetchApp.fetch(url, opts);
    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code >= 200 && code < 300) {
      return text ? JSON.parse(text) : null;
    }
    if (authKind === 'ms' && code === 401) {
      microsoftService_().reset();
      sendReauthorizationAlert_();
      throw new Error('HTTP 401：Microsoft 授權失效。');
    }
    const transient = code === 429 || code === 408 || (code >= 500 && code < 600);
    lastError = new Error('HTTP ' + code + ': ' + text);
    if (!transient || attempt === HTTP_MAX_RETRIES) throw lastError;
    const retryAfter = parseRetryAfterMs_(response);
    const exponential = Math.min(30000, 1000 * Math.pow(2, attempt));
    const delay = Math.max(retryAfter, exponential + Math.floor(Math.random() * 750));
    if (RUN_STARTED_AT && Date.now() + delay > RUN_STARTED_AT + RUN_LIMIT_MS) {
      throw new Error('TIME_BUDGET_HTTP：距逾時過近，暫緩重試；下輪會重新執行完整 inventory，沒有持久化 page cursor。');
    }
    console.warn('[HTTP] ' + code + '，' + delay + ' ms 後重試。');
    Utilities.sleep(delay);
  }
  throw lastError || new Error('HTTP request failed');
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
  while (url) {
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

function getMsLists_() {
  return getAllPages_(MS_TODO_BASE, function(url) { return graphFetch_(url); }, 'value', 'graph');
}

function getMsList_(listId) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId));
}

function getMsTasks_(listId, options) {
  const includeMoveExtension = !!(options && options.includeMoveExtension);
  // A full extension expansion is intentionally reserved for the small set of
  // destination lists which contain an unresolved correlation journal.  Normal
  // inventories and dry runs retain their previous Graph request shape.
  // todoTask extension expansion requires the documented unqualified extension
  // name filter. The response is still checked locally against the exact
  // service-normalized ID allowlist, extensionName, and correlation UUID.
  const extensionQuery = includeMoveExtension
    ? '&$expand=extensions($filter=id%20eq%20%27' +
      encodeURIComponent(MOVE_EXTENSION_NAME) + '%27)'
    : '';
  const first = MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks?$top=100' + extensionQuery;
  return getAllPages_(first, function(url) {
    return graphFetch_(url, microsoftTaskRequestOptions_());
  }, 'value', 'graph');
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
    payload: JSON.stringify({ displayName: displayName || '(無標題清單)' })
  });
}

function createGList_(title) {
  return gFetch_('/users/@me/lists', {
    method: 'post',
    payload: JSON.stringify({ title: title || '(無標題清單)' })
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
  let instant;
  if (parsed.hasOffset) {
    const normalized = parsed.raw
      .replace(/z$/i, 'Z')
      .replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})$)/, '$1');
    instant = new Date(normalized);
  } else {
    const microsoftTimeZone = resolveTimeZone_(msDue.timeZone);
    if (!microsoftTimeZone) return null;
    instant = instantFromMicrosoftLocalDateTime_(parsed, microsoftTimeZone);
  }
  const day = dateInTimeZone_(instant, syncTimeZone);
  return day ? day + 'T00:00:00.000Z' : null;
}

function msDue_(googleDue) {
  const day = googleDueDateOnly_(googleDue);
  const timeZone = resolveTimeZone_(syncTimeZone_());
  return day && timeZone ? { dateTime: day + 'T00:00:00', timeZone: timeZone } : null;
}

function microsoftTaskRequestOptions_(options) {
  const timeZone = resolveTimeZone_(syncTimeZone_());
  if (!timeZone) {
    throw new Error('SYNC_TIME_ZONE_INVALID：Apps Script 專案時區不是支援的 IANA 時區。');
  }
  const request = Object.assign({}, options || {});
  request.headers = Object.assign({}, request.headers || {});
  request.headers.Prefer = 'outlook.timezone="' + timeZone + '"';
  return request;
}

function escapeHtml_(text) {
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

function googlePayloadFromMs_(task) {
  const rawContent = task.body && task.body.content ? task.body.content : '';
  const isHtml = task.body && String(task.body.contentType || '').toLowerCase() === 'html';
  return {
    title: task.title || '(無標題)',
    notes: isHtml ? htmlToText_(rawContent) : rawContent,
    due: googleDue_(task.dueDateTime),
    status: task.status === 'completed' ? 'completed' : 'needsAction'
  };
}

function googleNotesAreBlank_(notes) {
  return notes == null || /^[\t\n\v\f\r \u00A0]*$/.test(String(notes));
}

function msPayloadFromGoogle_(task, mode) {
  if (mode !== 'create' && mode !== 'update') {
    throw new Error('MS_PAYLOAD_MODE_REQUIRED：Google → Microsoft payload 必須指定 create 或 update。');
  }
  const notes = task && task.notes;
  const payload = {
    title: task.title || '(無標題)'
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
    throw new Error((errorCode || 'STATE_MALFORMED') + '：list tombstone ID/name guard 完整性驗證失敗（' +
      issues.join(',') + '）；已拒絕覆寫或清理 resurrection evidence。');
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
    throw new Error('LIST_TOMBSTONE_INELIGIBLE：預設或不合資格清單不可寫入 tombstone。');
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
    throw new Error('SYNC_LIST_DELETIONS_AUTO_ONLY：清單刪除只允許 SYNC_LIST_DISCOVERY_MODE=auto。');
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
    throw new Error('LIST_DELETE_DEFAULT_REVALIDATION_FAILED：' + e.message);
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
  console.warn('[DeleteConflict] ' + reason + '：' + gId);
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
    console.log('[DeleteCandidate] 第 1/2 輪確認：' + gId + ' missing=' + missingSide);
    return candidate;
  }
  if (candidate.lastRoundId !== roundId) {
    candidate.confirmations = Math.min(2, Number(candidate.confirmations || 0) + 1);
    candidate.lastRoundId = roundId;
    candidate.lastConfirmedAt = new Date().toISOString();
    console.log('[DeleteCandidate] 第 ' + candidate.confirmations + '/2 輪確認：' + gId + ' missing=' + missingSide);
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
  console.log('[Delete] 完成：' + gId + ' missing=' + missingSide);
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
      console.error('[DeleteJournal] mapping 缺失，保留 journal 並停止自動建立：' + gId);
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
    title: task && task.title || '(無標題)',
    notes: task && task.notes == null ? '' : String(task.notes),
    due: task && task.due ? String(task.due).slice(0, 10) : null,
    status: task && task.status === 'completed' ? 'completed' : 'needsAction'
  });
}

function moveFingerprintFromMicrosoft_(task) {
  return moveFingerprintFromGoogle_(googlePayloadFromMs_(task || {}));
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
    if (moveFingerprintFromMicrosoft_(task) !== journal.fingerprint) return false;
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
  console.warn('[MoveConflict] ' + reason + '：' + gId);
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
    console.warn('[MoveBlocked] Google 任務跨清單；SYNC_ALLOW_TASK_MOVES=false：' +
      taskLabel_(gId, gTask.title));
    return false;
  }
  if (state.deletionJournal[gId]) {
    console.warn('[MoveBlocked] Google 任務跨清單；DELETE_JOURNAL_PENDING：' +
      taskLabel_(gId, gTask.title));
    return false;
  }
  if (!googleMoveInventoryComplete_(state, snap, rec, currentGListId, targetMsListId)) {
    console.warn('[MoveBlocked] Google 任務跨清單；MOVE_INVENTORY_INCOMPLETE：' +
      taskLabel_(gId, gTask.title));
    return false;
  }

  let journal = state.taskMoveJournal[gId] || null;
  const oldMsTask = snap.msTasksById[rec.msId] || null;
  if (oldMsTask && snap.msListByTask[rec.msId] !== rec.msListId) {
    console.warn('[MoveBlocked] Google 任務跨清單；MOVE_SOURCE_CHANGED：' +
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
      fingerprint: fingerprint,
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
      journal.fingerprint !== fingerprint) {
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
      if (moveFingerprintFromMicrosoft_(correlationCandidates[0]) !== journal.fingerprint) {
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
      console.warn('[MoveRecovery] 建立結果尚未確認，下一輪再查：' + taskLabel_(gId, gTask.title));
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
  if (moveFingerprintFromMicrosoft_(freshDestination) !== journal.fingerprint) {
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
  console.log('[Move] Google → Microsoft 重新同步：' + taskLabel_(gId, gTask.title));
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
  sendListFaultAlert_('目前有 ' + count + ' 個清單處於隔離狀態。syncAll 會跳過這些清單，不會刪除任務。');
}

function ensureExplicitListMappings_(state, gLists, msLists, activeGListIds) {
  const msById = {};
  msLists.forEach(function(x) { msById[x.id] = x; });
  const gById = {};
  gLists.forEach(function(x) { gById[x.id] = x; });
  const mappedMsIds = {};
  Object.keys(state.listMap).forEach(function(gId) {
    const id = state.listMap[gId];
    if (id) mappedMsIds[id] = true;
  });
  let stateChanged = false;

  gLists.forEach(function(gList) {
    if (isGListFaulted_(state, gList.id)) return;
    const msId = state.listMap[gList.id];
    if (!msId) {
      let target = null;
      if (ALLOW_NAME_PAIRING) {
        target = msLists.find(function(x) { return x.displayName === gList.title && !mappedMsIds[x.id]; }) || null;
      }
      if (!target) {
        target = createMsList_(gList.title || '(無標題清單)');
        msLists.push(target);
        msById[target.id] = target;
        console.log('[List] 建立 MS 清單：' + (VERBOSE_LOG ? (gList.title || '(無標題清單)') : gList.id));
      }
      state.listMap[gList.id] = target.id;
      mappedMsIds[target.id] = true;
      stateChanged = true;
      persistSyncState_(state);
      return;
    }
    if (msById[msId]) return;
    markListFault_(state, 'ms', msId, {
      reason: 'MS_LIST_MISSING',
      gListId: gList.id,
      gListTitle: gList.title || '(無標題清單)',
      msListTitle: '(已消失或無法讀取)'
    });
    stateChanged = true;
    console.error('[ListFault] Microsoft 清單消失或無法讀取，已隔離：msListId=' + msId);
  });

  Object.keys(state.listMap).forEach(function(gListId) {
    if (activeGListIds && !activeGListIds[gListId]) return;
    if (isGListFaulted_(state, gListId)) return;
    if (gById[gListId]) return;
    const msListId = state.listMap[gListId];
    markListFault_(state, 'g', gListId, {
      reason: 'GOOGLE_LIST_MISSING',
      gListTitle: '(已消失或無法讀取)',
      msListId: msListId,
      msListTitle: (msById[msListId] && msById[msListId].displayName) || ''
    });
    stateChanged = true;
    console.error('[ListFault] Google 清單消失或無法讀取，已隔離：gListId=' + gListId);
  });

  if (stateChanged) {
    persistSyncState_(state);
  }
}

function autoListMapById_(lists) {
  const byId = {};
  (lists || []).forEach(function(list) {
    if (list && list.id) byId[list.id] = list;
  });
  return byId;
}

function autoListTitleGroups_(lists, getTitle, excludedIds) {
  const groups = {};
  (lists || []).forEach(function(list) {
    if (!list || !list.id || (excludedIds && excludedIds[list.id])) return;
    const title = normalizeListName_(getTitle(list));
    if (!title) return;
    const key = 'title:' + title;
    groups[key] = groups[key] || [];
    groups[key].push(list);
  });
  return groups;
}

function planAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle) {
  state = normalizeState_(state);
  const activeGoogle = autoListMapById_(gLists);
  const allMicrosoft = autoListMapById_(allMsLists);
  const eligibleMicrosoftLists = (allMsLists || []).filter(function(list) {
    return isAutoEligibleMicrosoftList_(list, safety);
  });
  const eligibleMicrosoft = autoListMapById_(eligibleMicrosoftLists);
  const plan = {
    pairs: [],
    createMicrosoft: [],
    createGoogle: [],
    faults: [],
    eligibleMicrosoftLists: eligibleMicrosoftLists
  };
  const reservedGoogle = {};
  const reservedMicrosoft = {};
  const reservedNameKeys = (lifecycle && lifecycle.reservedNameKeys) || {};
  const faultedGoogle = {};
  const faultedMicrosoft = {};

  Object.keys((lifecycle && lifecycle.reservedGoogleIds) || {}).forEach(function(id) {
    reservedGoogle[id] = true;
  });
  Object.keys((lifecycle && lifecycle.reservedMicrosoftIds) || {}).forEach(function(id) {
    reservedMicrosoft[id] = true;
  });

  function nameReserved(name) {
    const key = listNameTombstoneKey_(name);
    return !!(key && reservedNameKeys[key]);
  }

  function reserve(google, microsoft, reason, existing) {
    if (!google || !microsoft || reservedGoogle[google.id] || reservedMicrosoft[microsoft.id]) return false;
    reservedGoogle[google.id] = true;
    reservedMicrosoft[microsoft.id] = true;
    plan.pairs.push({
      googleListId: google.id,
      googleListTitle: google.title || '(無標題清單)',
      microsoftListId: microsoft.id,
      microsoftListTitle: microsoft.displayName || '(無標題清單)',
      reason: reason,
      existing: !!existing
    });
    return true;
  }

  function fault(google, microsoft, reason) {
    const googleId = google && google.id;
    const microsoftId = microsoft && microsoft.id;
    const key = (googleId || '') + '|' + (microsoftId || '') + '|' + reason;
    if (plan.faults.some(function(item) { return item.key === key; })) return;
    if (googleId) {
      reservedGoogle[googleId] = true;
      faultedGoogle[googleId] = true;
    }
    if (microsoftId) {
      reservedMicrosoft[microsoftId] = true;
      faultedMicrosoft[microsoftId] = true;
    }
    plan.faults.push({
      key: key,
      googleListId: googleId || null,
      microsoftListId: microsoftId || null,
      googleListTitle: google ? (google.title || '(無標題清單)') : '',
      microsoftListTitle: microsoft ? (microsoft.displayName || '(無標題清單)') : '',
      reason: reason
    });
  }

  Object.keys(state.listMap).forEach(function(googleListId) {
    const microsoftListId = state.listMap[googleListId];
    const google = activeGoogle[googleListId] || null;
    if (!google) return;
    const microsoft = allMicrosoft[microsoftListId] || null;
    if (isGListFaulted_(state, googleListId) || isMsListFaulted_(state, microsoftListId)) {
      reservedGoogle[googleListId] = true;
      if (microsoftListId) reservedMicrosoft[microsoftListId] = true;
      return;
    }
    if (!microsoft) {
      // A complete top-level inventory can safely classify a formerly proven
      // custom pair as Microsoft-missing. It is a list-deletion lifecycle
      // observation, not an ordinary list-fetch fault: retain the exact map,
      // reserve it, and let buildSnapshot_ read only the Google survivor.
      if (isProvenAutoListDeletionMissingPair_(state, lifecycle, googleListId,
        microsoftListId, ['microsoft_missing'])) {
        reservedGoogle[googleListId] = true;
        reservedMicrosoft[microsoftListId] = true;
        return;
      }
      fault(google, { id: microsoftListId, displayName: '(已消失或無法讀取)' }, 'MS_LIST_MISSING');
      return;
    }
    if (!eligibleMicrosoft[microsoftListId]) {
      fault(google, microsoft, 'MS_LIST_NOT_AUTO_ELIGIBLE');
      return;
    }
    // Existing stable ID mappings remain mapped even when lifecycle has
    // reserved the IDs for planner safety. Adopt this exact live mapping
    // before duplicate-reservation checks: default and other non-deletable
    // live pairs must keep their ordinary task-sync semantics.
    if (!plan.pairs.some(function(pair) {
      return pair.googleListId === google.id && pair.microsoftListId === microsoft.id;
    })) {
      plan.pairs.push({
        googleListId: google.id,
        googleListTitle: google.title || '(無標題清單)',
        microsoftListId: microsoft.id,
        microsoftListTitle: microsoft.displayName || '(無標題清單)',
        reason: 'EXISTING_ID_MAPPING',
        existing: true
      });
      reservedGoogle[google.id] = true;
      reservedMicrosoft[microsoft.id] = true;
    }
  });

  const defaultGoogle = gDefaultList && activeGoogle[gDefaultList.id] ? activeGoogle[gDefaultList.id] : null;
  const defaultMicrosoft = eligibleMicrosoftLists.filter(function(list) {
    return normalizeListName_(list.wellknownListName) === 'defaultlist';
  });
  if (defaultGoogle && !reservedGoogle[defaultGoogle.id]) {
    if (defaultMicrosoft.length !== 1) {
      fault(defaultGoogle, null, 'DEFAULT_LIST_UNRESOLVED');
    } else if (!reservedMicrosoft[defaultMicrosoft[0].id]) {
      reserve(defaultGoogle, defaultMicrosoft[0], 'DEFAULT_LIST_IDENTITY', false);
    } else {
      fault(defaultGoogle, defaultMicrosoft[0], 'DEFAULT_LIST_ALREADY_MAPPED');
    }
  } else if (defaultMicrosoft.length === 1 && !reservedMicrosoft[defaultMicrosoft[0].id]) {
    // The Google default list is excluded or already mapped elsewhere. Never create a second
    // Google list merely to mirror Microsoft’s built-in default list.
    fault(null, defaultMicrosoft[0], 'DEFAULT_LIST_GOOGLE_SIDE_UNAVAILABLE');
  }

  const googleGroups = autoListTitleGroups_(gLists, function(list) { return list.title; }, reservedGoogle);
  const microsoftGroups = autoListTitleGroups_(eligibleMicrosoftLists, function(list) {
    return list.displayName;
  }, reservedMicrosoft);
  Object.keys(googleGroups).forEach(function(key) {
    if (googleGroups[key].length < 2) return;
    googleGroups[key].forEach(function(google) {
      fault(google, null, 'AMBIGUOUS_GOOGLE_LIST_TITLE');
    });
    (microsoftGroups[key] || []).forEach(function(microsoft) {
      fault(null, microsoft, 'AMBIGUOUS_COUNTERPART_TITLE');
    });
  });
  Object.keys(microsoftGroups).forEach(function(key) {
    if (microsoftGroups[key].length < 2) return;
    microsoftGroups[key].forEach(function(microsoft) {
      fault(null, microsoft, 'AMBIGUOUS_MICROSOFT_LIST_TITLE');
    });
    (googleGroups[key] || []).forEach(function(google) {
      fault(google, null, 'AMBIGUOUS_COUNTERPART_TITLE');
    });
  });

  const uniqueGoogleGroups = autoListTitleGroups_(gLists, function(list) { return list.title; }, reservedGoogle);
  const uniqueMicrosoftGroups = autoListTitleGroups_(eligibleMicrosoftLists, function(list) {
    return list.displayName;
  }, reservedMicrosoft);
  Object.keys(uniqueGoogleGroups).forEach(function(key) {
    const googleMatches = uniqueGoogleGroups[key];
    const microsoftMatches = uniqueMicrosoftGroups[key] || [];
    if (googleMatches.length === 1 && microsoftMatches.length === 1) {
      reserve(googleMatches[0], microsoftMatches[0], 'UNIQUE_NORMALIZED_TITLE', false);
    }
  });

  (gLists || []).forEach(function(google) {
    if (!google || reservedGoogle[google.id] || faultedGoogle[google.id]) return;
    if (nameReserved(google.title)) return;
    plan.createMicrosoft.push(google);
  });
  eligibleMicrosoftLists.forEach(function(microsoft) {
    if (!microsoft || reservedMicrosoft[microsoft.id] || faultedMicrosoft[microsoft.id]) return;
    if (nameReserved(microsoft.displayName)) return;
    plan.createGoogle.push(microsoft);
  });
  return plan;
}

function applyAutoListFaults_(state, faults) {
  let changed = false;
  (faults || []).forEach(function(fault) {
    if (fault.googleListId && !isGListFaulted_(state, fault.googleListId)) {
      markListFault_(state, 'g', fault.googleListId, {
        reason: fault.reason,
        msListId: fault.microsoftListId || null,
        gListTitle: fault.googleListTitle,
        msListTitle: fault.microsoftListTitle
      });
      changed = true;
    }
    if (fault.microsoftListId && !isMsListFaulted_(state, fault.microsoftListId)) {
      markListFault_(state, 'ms', fault.microsoftListId, {
        reason: fault.reason,
        gListId: fault.googleListId || null,
        gListTitle: fault.googleListTitle,
        msListTitle: fault.microsoftListTitle
      });
      changed = true;
    }
  });
  return changed;
}

function assertAutoListCreateStillSafe_(state, side, planned, gLists, allMsLists, gDefaultList, safety) {
  const lifecycle = classifyListLifecycle_(state, gLists, allMsLists, gDefaultList, safety);
  const source = side === 'microsoft' ? autoListMapById_(gLists)[planned.id] :
    autoListMapById_(allMsLists)[planned.id];
  const sourceName = side === 'microsoft' ? source && source.title : source && source.displayName;
  const reservedIds = side === 'microsoft' ? lifecycle.reservedGoogleIds : lifecycle.reservedMicrosoftIds;
  const tombstoneSide = side === 'microsoft' ? 'g' : 'ms';
  const sourceEligible = side === 'microsoft'
    ? isAutoDeletableGoogleList_(source, gDefaultList, safety)
    : isAutoDeletableMicrosoftList_(source, safety);
  const nameKey = listNameTombstoneKey_(sourceName);
  const mapped = side === 'microsoft'
    ? !!state.listMap[planned.id]
    : Object.keys(state.listMap).some(function(gListId) { return state.listMap[gListId] === planned.id; });
  const exactFingerprint = side === 'microsoft'
    ? listMetadataFingerprint_('g', source) === listMetadataFingerprint_('g', planned)
    : listMetadataFingerprint_('ms', source) === listMetadataFingerprint_('ms', planned);
  if (!source || !exactFingerprint || !sourceEligible || mapped || reservedIds[planned.id] ||
      hasListTombstone_(state, tombstoneSide, planned.id, sourceName) ||
      (nameKey && lifecycle.reservedNameKeys[nameKey])) {
    throw new Error('AUTO_CREATE_STALE_PLAN_BLOCKED：清單 lifecycle reservation 或來源 metadata 已變更，已拒絕建立對端清單。');
  }
}

function ensureAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle) {
  const plan = planAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle);
  let stateChanged = applyAutoListFaults_(state, plan.faults);
  plan.pairs.forEach(function(pair) {
    if (pair.existing || isGListFaulted_(state, pair.googleListId) || isMsListFaulted_(state, pair.microsoftListId)) {
      return;
    }
    state.listMap[pair.googleListId] = pair.microsoftListId;
    stateChanged = true;
    console.log('[List] 自動配對：' + pair.reason + '（' + pair.googleListId + ' ↔ ' + pair.microsoftListId + '）');
  });
  if (stateChanged) persistSyncState_(state);

  plan.createMicrosoft.forEach(function(google) {
    if (isGListFaulted_(state, google.id) || state.listMap[google.id]) return;
    assertAutoListCreateStillSafe_(state, 'microsoft', google, gLists, allMsLists, gDefaultList, safety);
    const microsoft = createMsList_(google.title || '(無標題清單)');
    if (!microsoft || !microsoft.id) throw new Error('AUTO_CREATE_MICROSOFT_LIST_FAILED：未取得新 Microsoft 清單 ID。');
    allMsLists.push(microsoft);
    state.listMap[google.id] = microsoft.id;
    persistSyncState_(state);
    console.log('[List] Google → Microsoft 建立清單：' + google.id);
  });
  plan.createGoogle.forEach(function(microsoft) {
    if (isMsListFaulted_(state, microsoft.id)) return;
    const alreadyMapped = Object.keys(state.listMap).some(function(googleListId) {
      return state.listMap[googleListId] === microsoft.id;
    });
    if (alreadyMapped) return;
    assertAutoListCreateStillSafe_(state, 'google', microsoft, gLists, allMsLists, gDefaultList, safety);
    const google = createGList_(microsoft.displayName || '(無標題清單)');
    if (!google || !google.id) throw new Error('AUTO_CREATE_GOOGLE_LIST_FAILED：未取得新 Google 清單 ID。');
    gLists.push(google);
    state.listMap[google.id] = microsoft.id;
    persistSyncState_(state);
    console.log('[List] Microsoft → Google 建立清單：' + microsoft.id);
  });
  return plan;
}

function ensureListMappings_(state, gLists, allMsLists, activeGListIds, safety, gDefaultList, lifecycle) {
  if (isAutoDiscoveryMode_(safety)) {
    return ensureAutoListMappings_(state, gLists, allMsLists, gDefaultList, safety, lifecycle);
  }
  return ensureExplicitListMappings_(state, gLists, allMsLists, activeGListIds);
}

function buildSnapshot_(state, startedAt) {
  const safety = getSafetyConfig_();
  requireSyncAllowlist_(safety);
  requireSafeAutoDiscovery_(safety);
  requireConfiguredListPairsApplied_(state, safety);
  const allGLists = getGLists_();
  const gLists = allowedGoogleLists_(allGLists, safety);
  const activeGListIds = {};
  const msLists = getMsLists_();
  let gDefaultList = null;
  if (isAutoDiscoveryMode_(safety)) {
    try {
      gDefaultList = getGDefaultList_();
    } catch (e) {
      throw new Error('AUTO_DEFAULT_LIST_LOOKUP_FAILED：無法確認 Google 預設清單，已停止自動配對。' + e.message);
    }
    if (!gDefaultList || !gDefaultList.id || !allGLists.some(function(list) {
      return list.id === gDefaultList.id;
    })) {
      throw new Error('AUTO_DEFAULT_LIST_LOOKUP_FAILED：Google 預設清單不在本輪 inventory，已停止自動配對。');
    }
  } else {
    safety.googleListIds.forEach(function(id) { activeGListIds[id] = true; });
  }
  // Classify the complete, unfiltered inventories before any automatic
  // pairing/create.  In particular, a filtered or ineligible list is not
  // treated as missing and cannot make its survivor eligible for recreation.
  let listLifecycle = classifyListLifecycle_(state, allGLists, msLists, gDefaultList, safety);
  const proofRevokedBeforePlanning = revokeAutoListPairMetaForObservedSafety_(state, listLifecycle, safety);
  if (proofRevokedBeforePlanning) {
    // This checkpoint is intentionally before pairing, create, task reads and
    // reconciliation.  If it cannot be stored, the round aborts with no later
    // remote mutation; if later saves fail, this durable absence still wins.
    persistSyncState_(state);
  }
  ensureListMappings_(state, gLists, msLists, activeGListIds, safety, gDefaultList, listLifecycle);
  if (isAutoDiscoveryMode_(safety)) {
    gLists.forEach(function(list) { activeGListIds[list.id] = true; });
  }
  // ensureAutoListMappings_ can append a newly created counterpart.  Refresh
  // the pure lifecycle view without another remote inventory call.
  listLifecycle = classifyListLifecycle_(
    state,
    allGLists.concat(gLists),
    msLists,
    gDefaultList,
    safety
  );
  // A revocation needs a distinct, later fully eligible both-live round before
  // it may establish fresh deletion provenance. Do not recreate proof in the
  // same round that just invalidated it.
  if (!proofRevokedBeforePlanning) recordAutoBothLivePairMeta_(state, listLifecycle, safety);
  alertListFaultsIfAny_(state);

  const gTasksById = {};
  const msTasksById = {};
  const gListByTask = {};
  const msListByTask = {};
  const gTaskInventoryListIds = {};
  const msTaskInventoryListIds = {};
  // This is separate from ordinary task inventory completion.  A correlated
  // recovery is allowed to use an expanded target only when this exact list
  // read completed successfully; all other lists keep their lean snapshot.
  const moveExtensionInventoryListIds = {};
  const unresolvedMoveTargets = unresolvedMoveExtensionTargetListIds_(state);
  let inventoryComplete = true;

  for (const gList of gLists) {
    if (isGListFaulted_(state, gList.id)) continue;
    if (!remainingTimeOk_(startedAt, 90000)) throw new Error('TIME_BUDGET_SNAPSHOT');
    try {
      const tasks = getGTasks_(gList.id);
      gTaskInventoryListIds[gList.id] = true;
      tasks.forEach(function(task) {
        gTasksById[task.id] = task;
        gListByTask[task.id] = gList.id;
      });
    } catch (e) {
      if (isNotFoundError_(e)) {
        inventoryComplete = false;
        markListFault_(state, 'g', gList.id, {
          reason: 'HTTP_404_WHILE_FETCHING_TASKS',
          gListTitle: gList.title || '(無標題清單)',
          // Keep the exact mapped counterpart on the fault.  Repair needs this
          // historical pair to convert ordinary auto provenance into the
          // anti-recreation guard before it removes the mapping.
          msListId: state.listMap[gList.id] || null
        });
        console.error('[ListFault] 抓取 Google 任務時 404，已隔離：gListId=' + gList.id);
        continue;
      }
      throw e;
    }
  }

  const mappedMsIds = Array.from(new Set(Object.keys(state.listMap).map(function(gId) {
    if (!activeGListIds[gId]) return null;
    if (isGListFaulted_(state, gId)) return null;
    const msId = state.listMap[gId];
    if (!msId || isMsListFaulted_(state, msId)) return null;
    // The top-level Microsoft inventory already proved this exact list absent.
    // Do not turn that lifecycle observation into a second, expected 404 from
    // getMsTasks_; only the Google survivor inventory is required this round.
    if (isProvenAutoListDeletionMissingPair_(state, listLifecycle, gId, msId,
      ['microsoft_missing', 'both_missing'])) return null;
    return msId;
  }).filter(Boolean).concat(listLifecycle.pairs.map(function(pair) {
    // A Google-missing custom pair needs the live Microsoft survivor's full
    // task inventory for lifecycle validation.  This is read-only and does
    // not make the absent Google list a normal sync target.
    if (pair.status === 'google_missing' && pair.msLive && pair.deletable) {
      return pair.msListId;
    }
    return null;
  }).filter(Boolean))));

  for (const msListId of mappedMsIds) {
    if (!remainingTimeOk_(startedAt, 90000)) throw new Error('TIME_BUDGET_SNAPSHOT');
    try {
      const includeMoveExtension = !!unresolvedMoveTargets[msListId];
      const tasks = getMsTasks_(msListId, { includeMoveExtension: includeMoveExtension });
      msTaskInventoryListIds[msListId] = true;
      if (includeMoveExtension) moveExtensionInventoryListIds[msListId] = true;
      tasks.forEach(function(task) {
        msTasksById[task.id] = task;
        msListByTask[task.id] = msListId;
      });
    } catch (e) {
      if (isNotFoundError_(e)) {
        inventoryComplete = false;
        const gListId = Object.keys(state.listMap).find(function(id) {
          return state.listMap[id] === msListId;
        }) || null;
        const gList = gLists.find(function(list) { return list.id === gListId; }) || null;
        markListFault_(state, 'ms', msListId, {
          reason: 'HTTP_404_WHILE_FETCHING_TASKS',
          gListId: gListId,
          gListTitle: gList ? (gList.title || '(無標題清單)') : ''
        });
        console.error('[ListFault] 抓取 Microsoft 任務時 404，已隔離：msListId=' + msListId);
        continue;
      }
      throw e;
    }
  }

  alertListFaultsIfAny_(state);
  if (Object.keys(state.listFaults.g).length || Object.keys(state.listFaults.ms).length) {
    inventoryComplete = false;
  }
  return {
    gLists: gLists,
    msLists: msLists,
    gTasksById: gTasksById,
    msTasksById: msTasksById,
    gListByTask: gListByTask,
    msListByTask: msListByTask,
    gTaskInventoryListIds: gTaskInventoryListIds,
    msTaskInventoryListIds: msTaskInventoryListIds,
    moveExtensionInventoryListIds: moveExtensionInventoryListIds,
    activeGListIds: activeGListIds,
    inventoryComplete: inventoryComplete,
    listInventoryComplete: true,
    allGLists: allGLists,
    googleDefaultList: gDefaultList,
    listLifecycle: listLifecycle,
    safety: safety
  };
}

function reconcileMapped_(state, snap, startedAt, roundId, progress) {
  roundId = roundId || deletionRoundId_(startedAt);
  progress = progress || { invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} };
  progress.invalidatedCandidateTaskIds = progress.invalidatedCandidateTaskIds || {};
  progress.discardCandidateTaskIds = progress.discardCandidateTaskIds || {};
  ensureTaskDeletionState_(state);
  const allowDeletions = !!(snap.safety && snap.safety.allowDeletions);
  if (!allowDeletions) {
    pauseTaskDeletions_(state);
    // This is an operator safety switch, not an inventory decision.  A
    // prepared intent must not survive a disabled run merely because snapshot
    // collection later faults or times out.
    pausePreparedDeletionJournals_(state);
  }
  const mappedGIds = Object.keys(state.g2m);
  for (const gId of mappedGIds) {
    if (!remainingTimeOk_(startedAt, 45000)) throw new Error('TIME_BUDGET_RECONCILE');
    const rec = state.g2m[gId];
    if (!rec || !rec.msId) {
      delete state.g2m[gId];
      continue;
    }
    if (isListPairReserved_(snap, rec.gListId, rec.msListId)) {
      // A list lifecycle candidate owns this pair.  Ordinary task deletion
      // candidates are cleared so they cannot race a later list finalization;
      // durable task journals remain a hard block for list deletion.
      clearPendingTaskDeletion_(state, gId);
      continue;
    }
    const pairBlockReason = taskDeletionPairBlockReason_(state, snap, rec);
    if (pairBlockReason) {
      blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress);
      continue;
    }
    const msId = rec.msId;
    const gTask = snap.gTasksById[gId] || null;
    const msTask = snap.msTasksById[msId] || null;
    if (msTask && snap.msListByTask[msId] && snap.msListByTask[msId] !== rec.msListId) {
      blockTaskMove_(state, gId, rec, state.taskMoveJournal[gId] || null,
        'MOVE_MICROSOFT_SAME_ID_LIST_CHANGED');
      continue;
    }
    const currentGListId = gTask ? snap.gListByTask[gId] : rec.gListId;
    const targetMsListId = state.listMap[currentGListId];

    const moveJournal = state.taskMoveJournal && state.taskMoveJournal[gId];
    if (moveJournal && !gTask) {
      blockTaskMove_(state, gId, rec, moveJournal, 'MOVE_GOOGLE_SOURCE_MISSING');
      continue;
    }
    if (gTask && moveJournal) {
      resyncGoogleTaskMove_(
        state, snap, gId, gTask, rec, currentGListId,
        moveJournal.targetMsListId, progress, roundId
      );
      continue;
    }
    if (gTask && targetMsListId && targetMsListId !== rec.msListId) {
      resyncGoogleTaskMove_(
        state, snap, gId, gTask, rec, currentGListId, targetMsListId, progress, roundId
      );
      continue;
    }

    const missingSide = missingSide_(gTask, msTask);
    if (missingSide) {
      if (missingSide === 'google' && msTask) {
        if (state.listMap[rec.gListId] !== rec.msListId) {
          markListFault_(state, 'g', rec.gListId, {
            reason: 'GOOGLE_LIST_MAPPING_CHANGED',
            msListId: rec.msListId
          });
          blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress);
          continue;
        }
      }
      if (missingSide === 'microsoft' && gTask) {
        if (!targetMsListId || targetMsListId !== rec.msListId) {
          markListFault_(state, 'ms', rec.msListId, {
            reason: 'MS_TASK_MISSING_AFTER_LIST_CHANGE',
            gListId: currentGListId
          });
          blockTaskDeletionForUnavailablePair_(state, gId, rec, snap, progress);
          continue;
        }
      }
      if (!allowDeletions) {
        if (missingSide === 'google') {
          console.warn('[DeleteBlocked] Google 任務消失；SYNC_ALLOW_DELETIONS=false，保留 Microsoft 任務：' + msId);
        } else if (missingSide === 'microsoft') {
          console.warn('[DeleteBlocked] Microsoft 任務消失；SYNC_ALLOW_DELETIONS=false，保留 Google 任務：' + taskLabel_(gId, gTask.title));
        } else {
          console.warn('[DeleteBlocked] 兩端任務消失；SYNC_ALLOW_DELETIONS=false，保留 mapping 並不建立 tombstone：' + gId);
        }
      } else {
        observeTaskDeletionCandidate_(state, rec, gId, missingSide, snap, roundId, progress);
      }
      continue;
    }
    // The previously missing task has returned. A stale candidate must never
    // survive a both-live round and make a later independent disappearance look
    // like a second confirmation. A prepared journal is quarantined as a changed
    // source scenario; ordinary candidates/conflicts are simply resolved.
    if (state.deletionJournal[gId]) {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      recordTaskDeletionConflict_(state, gId, rec, 'DELETE_SOURCE_REAPPEARED');
    } else {
      markTaskDeletionCandidateInvalidated_(progress, gId);
      clearPendingTaskDeletion_(state, gId);
      clearTaskDeletionConflict_(state, gId);
    }
    const gChanged = epoch_(gTask.updated) > epoch_(rec.gUpdated);
    const mChanged = epoch_(msTask.lastModifiedDateTime) > epoch_(rec.msUpdated);
    if (gChanged && !mChanged) {
      const updatedMs = updateMsTask_(rec.msListId, msId, msPayloadFromGoogle_(gTask, 'update'));
      putMapping_(state, gTask, currentGListId, updatedMs, rec.msListId);
    } else if (!gChanged && mChanged) {
      const updatedG = updateGTask_(rec.gListId, gId, googlePayloadFromMs_(msTask));
      putMapping_(state, updatedG, rec.gListId, msTask, rec.msListId);
    } else if (gChanged && mChanged) {
      if (epoch_(gTask.updated) >= epoch_(msTask.lastModifiedDateTime)) {
        const updatedMs = updateMsTask_(rec.msListId, msId, msPayloadFromGoogle_(gTask, 'update'));
        putMapping_(state, gTask, currentGListId, updatedMs, rec.msListId);
        console.warn('[Conflict] LWW 選 Google：' + taskLabel_(gId, gTask.title));
      } else {
        const updatedG = updateGTask_(rec.gListId, gId, googlePayloadFromMs_(msTask));
        putMapping_(state, updatedG, rec.gListId, msTask, rec.msListId);
        console.warn('[Conflict] LWW 選 Microsoft：' + msId);
      }
    } else {
      rec.gListId = currentGListId;
    }
  }
}

function createUnmapped_(state, snap, startedAt) {
  for (const gId of Object.keys(snap.gTasksById)) {
    if (!remainingTimeOk_(startedAt, 30000)) throw new Error('TIME_BUDGET_CREATE');
    if (state.g2m[gId] || state.tombstones.g[gId] || state.deletionJournal[gId] ||
        (state.taskMoveJournal && state.taskMoveJournal[gId])) continue;
    const gTask = snap.gTasksById[gId];
    const gListId = snap.gListByTask[gId];
    if (isGListFaulted_(state, gListId)) continue;
    const msListId = state.listMap[gListId];
    if (!msListId || isMsListFaulted_(state, msListId)) continue;
    if (isListPairReserved_(snap, gListId, msListId)) continue;
    const msTask = createMsTask_(msListId, msPayloadFromGoogle_(gTask, 'create'));
    putMapping_(state, gTask, gListId, msTask, msListId);
    snap.msTasksById[msTask.id] = msTask;
    snap.msListByTask[msTask.id] = msListId;
    console.log('[Create] Google → MS：' + taskLabel_(gId, gTask.title));
  }
  for (const msId of Object.keys(snap.msTasksById)) {
    if (!remainingTimeOk_(startedAt, 30000)) throw new Error('TIME_BUDGET_CREATE');
    if (state.m2g[msId] || state.tombstones.m[msId] ||
        hasDeletionJournalForMsTask_(state, msId) || hasMoveJournalForMsTask_(state, msId)) continue;
    const msTask = snap.msTasksById[msId];
    const msListId = snap.msListByTask[msId];
    if (isMsListFaulted_(state, msListId)) continue;
    const gListId = Object.keys(state.listMap).find(function(id) {
      return state.listMap[id] === msListId &&
        (!snap.activeGListIds || !!snap.activeGListIds[id]) &&
        !isGListFaulted_(state, id);
    });
    if (!gListId) continue;
    if (isListPairReserved_(snap, gListId, msListId)) continue;
    const gTask = createGTask_(gListId, googlePayloadFromMs_(msTask));
    putMapping_(state, gTask, gListId, msTask, msListId);
    console.log('[Create] MS → Google：' + taskLabel_(msId, msTask.title));
  }
}

function syncAll() {
  return withGlobalLock_(function() {
    const startedAt = Date.now();
    RUN_STARTED_AT = startedAt;
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
      openSyncRoundFence_(String(startedAt) + '-' + Math.random());
      roundFenceOpened = true;
    } catch (e) {
      console.error('[Sync] 狀態載入失敗：' + e.message);
      sendFatalAlert_('狀態載入失敗：' + e.message);
      throw e;
    }
    try {
      ensureTaskDeletionState_(state);
      ensureListDeletionState_(state);
      pendingTaskDeletionsBeforeRound = JSON.parse(JSON.stringify(state.pendingTaskDeletions));
      pendingListDeletionsBeforeRound = JSON.parse(JSON.stringify(state.pendingListDeletions));
      deletionProgress.pendingBeforeRound = pendingTaskDeletionsBeforeRound;
      listDeletionProgress.pendingListBeforeRound = pendingListDeletionsBeforeRound;
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
      const roundId = deletionRoundId_(startedAt);
      reconcileMapped_(state, snap, startedAt, roundId, deletionProgress);
      createUnmapped_(state, snap, startedAt);
      deletionStateBeforeApply = captureTaskDeletionState_(state);
      applyConfirmedTaskDeletions_(state, snap, roundId, deletionProgress);
      applyConfirmedListDeletions_(state, snap, roundId, listDeletionProgress, deletionProgress);
      state.health.lastSuccessfulSyncAt = new Date().toISOString();
      state.health.lastFailedSyncAt = null;
      state.health.lastErrorMessage = null;
      state.health.consecutiveFailures = 0;
      normalizeState_(state);
      persistSyncState_(state, { finalCommit: true });
      finalStateCommitted = true;
      clearSyncRoundFence_();
      console.log('[Sync] 完成。mapping=' + Object.keys(state.g2m).length);
    } catch (e) {
      const isTimeBudget = String(e.message).indexOf('TIME_BUDGET_') === 0;
      try {
        // A final state commit followed by a failed fence clear is a special
        // crash-recovery state. Do not overwrite it or clear the fence here:
        // next load must strip volatile proof before it can be reused.
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
          state.health.lastErrorMessage = String(e.message || e).slice(0, 500);
          state.health.consecutiveFailures = (state.health.consecutiveFailures || 0) + 1;
        }
        normalizeState_(state);
        persistSyncState_(state);
        // A catch-save is a committed stripped baseline, so it may end this
        // round. If this clear fails, leave the fence for next-run sanitizing.
        if (roundFenceOpened) clearSyncRoundFence_();
      } catch (saveError) {
        console.error('[Sync] 保存進度失敗：' + saveError.message);
      }
      if (isTimeBudget) {
        console.warn('[Sync] 接近時間上限，已安全保存 durable state；下輪會重新執行完整 inventory，沒有持久化 page cursor。');
        return;
      }
      sendFatalAlert_(String(e.message || e));
      console.error('[Sync] 失敗：' + e.message + '\n' + (e.stack || ''));
      throw e;
    }
  });
}

// Only structured pendingMoves use stable opaque labels rather than provider
// IDs. They are diagnostic pseudonyms, not a security boundary. Legacy
// actions/warnings deliberately retain their existing operator-facing output,
// so callers must not treat the whole dry-run report as shareable.
function previewOpaqueId_(kind, value) {
  const text = String(value == null ? '' : value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + i), 0x85ebca6b);
  }
  function hex(value) {
    return ('00000000' + (value >>> 0).toString(16)).slice(-8);
  }
  return String(kind || 'id') + '_' + hex(left) + hex(right);
}

function previewHasSnapshotValue_(task, field) {
  if (!task || typeof task !== 'object' ||
      !Object.prototype.hasOwnProperty.call(task, field)) return false;
  const value = task[field];
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== '' && value !== false;
}

// This deliberately looks only at the task object already loaded by dry-run.
// Do not add Graph calls here: relationship contents are reported as
// uninspected rather than guessed.
function moveMetadataLossPreview_(msTask) {
  const detected = [];
  if (msTask && typeof msTask === 'object') {
    if ((Object.prototype.hasOwnProperty.call(msTask, 'isReminderOn') &&
        msTask.isReminderOn === true) || previewHasSnapshotValue_(msTask, 'reminderDateTime')) {
      detected.push('reminder');
    }
    if (previewHasSnapshotValue_(msTask, 'recurrence')) detected.push('recurrence');
    if (previewHasSnapshotValue_(msTask, 'categories')) detected.push('categories');
    if (previewHasSnapshotValue_(msTask, 'startDateTime')) detected.push('startDateTime');
    if (previewHasSnapshotValue_(msTask, 'importance') &&
        String(msTask.importance).toLowerCase() !== 'normal') {
      detected.push('importance');
    }
    if (previewHasSnapshotValue_(msTask, 'status') &&
        ['notstarted', 'completed'].indexOf(String(msTask.status).toLowerCase()) < 0) {
      detected.push('statusDetail');
    }
    if (Object.prototype.hasOwnProperty.call(msTask, 'hasAttachments') &&
        msTask.hasAttachments === true) {
      detected.push('hasAttachments');
    }
    if (previewHasSnapshotValue_(msTask, 'completedDateTime')) {
      detected.push('completedDateTime');
    }
  }
  return {
    detectedNonPreserved: detected.sort(),
    // No relationship endpoint or $expand request is made by dryRunReport.
    uninspectedRelationships: ['attachmentDetails', 'checklistItems', 'linkedResources', 'extensions'],
    detectionScope: {
      source: 'CURRENT_MICROSOFT_TASK_SNAPSHOT_ONLY',
      microsoftTaskSnapshot: msTask ? 'PRESENT' : 'MISSING',
      extraMicrosoftRequests: false,
      valuesIncludedInReport: false,
      relationshipExpansion: false
    }
  };
}

function addPendingMovePreview_(pendingMoves, details) {
  const metadata = moveMetadataLossPreview_(details.msTask || null);
  pendingMoves.push({
    status: details.status,
    googleTaskId: previewOpaqueId_('gTask', details.gId),
    sourceGoogleListId: previewOpaqueId_('gList', details.sourceGoogleListId),
    targetGoogleListId: previewOpaqueId_('gList', details.targetGoogleListId),
    sourceMicrosoftTaskId: previewOpaqueId_('msTask', details.sourceMicrosoftTaskId),
    replacementMicrosoftTaskId: details.replacementMicrosoftTaskId
      ? previewOpaqueId_('msTask', details.replacementMicrosoftTaskId) : null,
    sourceMicrosoftListId: previewOpaqueId_('msList', details.sourceMicrosoftListId),
    targetMicrosoftListId: previewOpaqueId_('msList', details.targetMicrosoftListId),
    recoveryPhase: details.recoveryPhase || null,
    identityChanges: [
      'MICROSOFT_TASK_ID_RECREATED',
      'MICROSOFT_CREATED_DATETIME_REGENERATED',
      'MICROSOFT_LIST_MEMBERSHIP_CHANGED'
    ],
    metadataLoss: {
      detectedNonPreserved: metadata.detectedNonPreserved,
      uninspectedRelationships: metadata.uninspectedRelationships,
      detectionScope: metadata.detectionScope
    }
  });
}

function pendingMoveSummary_(pendingMoves) {
  const byStatus = {
    READY: 0,
    BLOCKED_SWITCH_OFF: 0,
    RECOVERY: 0
  };
  const detected = {};
  let withDetectedNonPreserved = 0;
  let withUninspectedRelationships = 0;
  let microsoftTaskSnapshotsPresent = 0;
  pendingMoves.forEach(function(move) {
    if (Object.prototype.hasOwnProperty.call(byStatus, move.status)) {
      byStatus[move.status] += 1;
    }
    if (move.metadataLoss.detectedNonPreserved.length) withDetectedNonPreserved += 1;
    move.metadataLoss.detectedNonPreserved.forEach(function(field) { detected[field] = true; });
    if (move.metadataLoss.uninspectedRelationships.length) withUninspectedRelationships += 1;
    if (move.metadataLoss.detectionScope.microsoftTaskSnapshot === 'PRESENT') {
      microsoftTaskSnapshotsPresent += 1;
    }
  });
  return {
    total: pendingMoves.length,
    byStatus: byStatus,
    movesWithDetectedNonPreserved: withDetectedNonPreserved,
    detectedNonPreserved: Object.keys(detected).sort(),
    movesWithUninspectedRelationships: withUninspectedRelationships,
    microsoftTaskSnapshotsPresent: microsoftTaskSnapshotsPresent,
    microsoftTaskSnapshotsMissing: pendingMoves.length - microsoftTaskSnapshotsPresent,
    detectionScope: 'CURRENT_MICROSOFT_TASK_SNAPSHOT_ONLY_NO_EXTRA_GRAPH_REQUESTS'
  };
}

function sortPendingMovePreviews_(pendingMoves) {
  pendingMoves.sort(function(left, right) {
    const leftKey = left.googleTaskId + '\u0000' + left.sourceMicrosoftTaskId;
    const rightKey = right.googleTaskId + '\u0000' + right.sourceMicrosoftTaskId;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function finalizePendingMovePreview_(pendingMoves) {
  sortPendingMovePreviews_(pendingMoves);
  return pendingMoveSummary_(pendingMoves);
}

function appendTaskMovePreview_(state, inventory, safety, actions, warnings, pendingMoves) {
  pendingMoves = pendingMoves || [];
  const journals = state.taskMoveJournal || {};
  // A journal represents the same logical move as its mapping. Report it once
  // as recovery, never again as a new candidate.
  Object.keys(journals).sort().forEach(function(gId) {
    const journal = journals[gId];
    const rec = state.g2m[gId] || {};
    const sourceMsId = journal.oldMsId || rec.msId || '';
    const replacementMsId = journal.newMsId || null;
    // Recovery metadata belongs to the old/source task. The replacement can
    // show what was recreated, not what source-only metadata was at risk.
    const msTask = inventory.msTasksById[sourceMsId] || null;
    addPendingMovePreview_(pendingMoves, {
      status: 'RECOVERY',
      gId: gId,
      sourceGoogleListId: rec.gListId || journal.gListId || '',
      targetGoogleListId: journal.gListId || rec.gListId || '',
      sourceMicrosoftTaskId: sourceMsId,
      replacementMicrosoftTaskId: replacementMsId,
      sourceMicrosoftListId: journal.oldMsListId || rec.msListId || '',
      targetMicrosoftListId: journal.targetMsListId || rec.msListId || '',
      recoveryPhase: journal.phase || 'unknown',
      msTask: msTask
    });
    warnings.push('[WARNING] 尚有待復原的跨清單移動：' + gId +
      ' phase=' + journal.phase + (journal.lastBlockedReason
        ? ' reason=' + journal.lastBlockedReason : ''));
  });
  Object.keys(state.g2m || {}).sort().forEach(function(gId) {
    if (journals[gId]) return;
    const rec = state.g2m[gId];
    const gTask = inventory.gTasksById[gId];
    const msTask = inventory.msTasksById[rec.msId];
    if (gTask) {
      const currentGListId = inventory.gListByTask[gId];
      const targetMsListId = state.listMap[currentGListId];
      if (targetMsListId && targetMsListId !== rec.msListId) {
        const label = taskLabel_(gId, gTask.title);
        addPendingMovePreview_(pendingMoves, {
          status: safety.allowTaskMoves ? 'READY' : 'BLOCKED_SWITCH_OFF',
          gId: gId,
          sourceGoogleListId: rec.gListId,
          targetGoogleListId: currentGListId,
          sourceMicrosoftTaskId: rec.msId,
          replacementMicrosoftTaskId: null,
          sourceMicrosoftListId: rec.msListId,
          targetMicrosoftListId: targetMsListId,
          recoveryPhase: null,
          msTask: msTask
        });
        if (safety.allowTaskMoves) {
          actions.push('[ACTION] Google 跨清單移動將重建 Microsoft 對應：' + label +
            '（' + rec.msListId + ' → ' + targetMsListId + '）');
        } else {
          warnings.push('[WARNING] Google 跨清單移動目前被阻擋：' + label);
        }
      }
    }
    if (msTask && inventory.msListByTask[rec.msId] &&
        inventory.msListByTask[rec.msId] !== rec.msListId) {
      warnings.push('[WARNING] Microsoft 任務以相同 ID 出現在不同清單，下一輪會 fail closed：' +
        taskLabel_(rec.msId, msTask.title));
    }
  });
  sortPendingMovePreviews_(pendingMoves);
  return pendingMoves;
}

function dryRunReport() {
  RUN_STARTED_AT = Date.now();
  return withGlobalLock_(function() {
    const roundFence = syncRoundFenceStatus_();
    const loaded = loadStateForInspection_();
    if (loaded.corrupt) {
      const pendingMoves = [];
      const report = {
        warnings: ['STATE_CORRUPT：狀態存在但無法讀取。請勿執行 syncAll。請執行 exportRawSyncState() 並暫停同步。'].concat(
          roundFence.active ? ['ROUND_FENCE_ACTIVE：下一次 syncAll 會先安全清除 volatile proof。'] : []
        ),
        roundFence: roundFence,
        pendingMoves: pendingMoves,
        pendingMoveSummary: pendingMoveSummary_(pendingMoves),
        note: '純讀取報告；不建立清單，也不建立、更新或刪除任務。'
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
      warnings.push('[WARNING] 有未完成的 sync round safety fence；下一次 syncAll 會先清除 volatile deletion proof 再繼續。');
    }
    const safety = getSafetyConfig_();
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
          title: list.displayName || '(無標題清單)',
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
        requireSafeAutoDiscovery_(safety);
        gDefaultList = getGDefaultList_();
        if (!gDefaultList || !gDefaultList.id || !allGLists.some(function(list) {
          return list.id === gDefaultList.id;
        })) {
          throw new Error('AUTO_DEFAULT_LIST_LOOKUP_FAILED：Google 預設清單不在本輪 inventory。');
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
              warnings.push('[WARNING] Google 清單 ' + (list.title || list.id) + ' 無法讀取，可能已消失。');
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
              warnings.push('[WARNING] Microsoft 清單 ' + (list.displayName || list.id) + ' 無法讀取，可能已消失。');
              return;
            }
            throw e;
          }
        });
      }
      if (autoError) {
        warnings.push('[WARNING] auto 清單發現已安全停止：' + autoError);
      } else {
        plan.pairs.forEach(function(pair) {
          if (pair.existing) return;
          actions.push('[ACTION] 自動配對既有清單：' + pair.googleListTitle + ' ↔ ' + pair.microsoftListTitle + '（' + pair.reason + '）');
          if ((googleTaskCounts[pair.googleListId] || 0) > 0 &&
              (microsoftTaskCounts[pair.microsoftListId] || 0) > 0) {
            warnings.push('[WARNING] 首次聯集：既有清單「' + pair.googleListTitle + '」與「' +
              pair.microsoftListTitle + '」兩端都有任務；同名任務可能保留為兩筆。');
          }
        });
        plan.createMicrosoft.forEach(function(list) {
          actions.push('[ACTION] Google → Microsoft 建立清單：' + (list.title || '(無標題清單)'));
        });
      plan.createGoogle.forEach(function(list) {
        actions.push('[ACTION] Microsoft → Google 建立清單：' + (list.displayName || '(無標題清單)'));
      });
      plan.faults.forEach(function(fault) {
          warnings.push('[WARNING] 將隔離而不猜測配對：' + fault.reason + '（' +
            (fault.googleListTitle || fault.microsoftListTitle || '未知清單') + '）');
        });
      }
      // A discovery failure leaves normal move candidates unobservable, but a
      // durable journal is still reported as RECOVERY with snapshot=MISSING.
      appendTaskMovePreview_(state, moveInventory, safety, actions, warnings, pendingMoves);
      if (!safety.allowDeletions) {
        info.push('[INFO] SYNC_ALLOW_DELETIONS=false；不會累積或推進任務刪除候選。');
      }
      if (!safety.allowTaskMoves) {
        info.push('[INFO] SYNC_ALLOW_TASK_MOVES=false；Google 跨清單移動會被阻擋。');
      }
      if (!safety.allowListDeletions) {
        info.push('[INFO] SYNC_ALLOW_LIST_DELETIONS=false；不會累積或推進清單刪除候選。');
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
            return { id: list.id, title: list.title || '(無標題清單)' };
          }),
          createGoogle: plan.createGoogle.map(function(list) {
            return { id: list.id, title: list.displayName || '(無標題清單)' };
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
        note: '純讀取 auto 清單發現預演；不建立清單，也不建立、更新或刪除任務。'
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
          actions.push('[ACTION] 明確清單配對已驗證但尚未套用；請先執行 applyConfiguredListPairs()。');
        } else {
          info.push('[INFO] SYNC_LIST_PAIRS_JSON 的明確 ID 配對已全部套用。');
        }
      } catch (e) {
        explicitPairError = String(e.message || e);
        warnings.push('[WARNING] 明確清單配對無效或未就緒：' + explicitPairError);
      }
    }
    if (!safety.googleListIds.length) {
      warnings.push('[WARNING] 尚未設定 SYNC_GOOGLE_LIST_IDS；syncAll 與 createTrigger 會拒絕執行。');
    }
    warnings.push('[WARNING] dryRunReport 是只讀庫存與設定報告，不預演任務層級的更新、刪除或衝突。');
    if (!safety.allowDeletions) {
      info.push('[INFO] SYNC_ALLOW_DELETIONS=false；不會累積或推進任務刪除候選。');
    }
    if (!safety.allowTaskMoves) {
      info.push('[INFO] SYNC_ALLOW_TASK_MOVES=false；Google 跨清單移動會被阻擋。');
    }
    if (!safety.allowListDeletions) {
      info.push('[INFO] SYNC_ALLOW_LIST_DELETIONS=false；不會累積或推進清單刪除候選。');
    }
    if (listDeletionModeError_(safety)) {
      warnings.push('[WARNING] SYNC_ALLOW_LIST_DELETIONS=true 只能用於 auto；syncAll 會先持久化暫停 journal 再拒絕執行。');
    }
    const faults = [];
    Object.keys(state.listFaults.ms).forEach(function(msId) {
      const f = state.listFaults.ms[msId];
      faults.push(Object.assign({ side: 'microsoft', msListId: msId }, f));
      warnings.push('[WARNING] 清單隔離中：Microsoft ' + msId + '（Google：' + (f.gListTitle || f.gListId || '未知') + '）。syncAll 會跳過。');
    });
    Object.keys(state.listFaults.g).forEach(function(gId) {
      const f = state.listFaults.g[gId];
      faults.push(Object.assign({ side: 'google', gListId: gId }, f));
      warnings.push('[WARNING] 清單隔離中：Google ' + (f.gListTitle || gId) + '。syncAll 會跳過。');
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
        title: list.title || '(無標題清單)',
        microsoftListId: explicitPairByGoogle[list.id] || null,
        nextSyncAction: nextSyncAction
      };
    });
    googleListsWithoutMapping.forEach(function(item) {
      if (item.nextSyncAction === 'CREATE_MICROSOFT_LIST') {
        actions.push('[ACTION] 下次 syncAll 會建立 Microsoft 清單：' + item.title);
      } else if (item.nextSyncAction === 'APPLY_EXPLICIT_PAIR_FIRST') {
        actions.push('[ACTION] Google 清單「' + item.title + '」必須先套用明確 Microsoft 清單 ID 配對。');
      } else {
        actions.push('[ACTION] Google 清單「' + item.title + '」被無效的明確配對設定安全阻擋。');
      }
    });
    const possibleNameCollisions = [];
    if (!ALLOW_NAME_PAIRING && !explicitPairRaw) {
      gLists.forEach(function(gList) {
        const same = msLists.filter(function(ms) { return ms.displayName === gList.title; });
        if (same.length && !state.listMap[gList.id]) {
          possibleNameCollisions.push({
            googleListTitle: gList.title || '(無標題清單)',
            microsoftListTitles: same.map(function(x) { return x.displayName; }),
            note: 'ALLOW_NAME_PAIRING=false，因此不會自動配對；下次 syncAll 會建立新的 Microsoft 清單。'
          });
        }
      });
      possibleNameCollisions.forEach(function(item) {
        info.push('[INFO] Google 清單「' + item.googleListTitle + '」在 Microsoft 有同名清單，但不會自動配對。');
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
          warnings.push('[WARNING] Google 清單 ' + (list.title || list.id) + ' 無法讀取，可能已消失。');
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
          warnings.push('[WARNING] Microsoft 清單 ' + msListId + ' 無法讀取，可能已消失。');
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
      note: '純讀取庫存與設定報告；不建立清單，也不建立、更新或刪除任務。'
    };
  console.log(JSON.stringify(report, null, 2));
  return report;
  });
}

function createTrigger() {
  const safety = getSafetyConfig_();
  requireSyncAllowlist_(safety);
  requireSafeAutoDiscovery_(safety);
  requireConfiguredListPairsApplied_(loadStateForSync_(), safety);
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(SYNC_TRIGGER_INTERVAL_MINUTES).create();
  console.log('[Trigger] 已建立每 ' + SYNC_TRIGGER_INTERVAL_MINUTES +
    ' 分鐘同步；單次執行預算為 5.25 分鐘，遇到重疊會由全域 lock 安全略過。');
}

function deleteSyncTriggers() {
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
      note: '狀態存在但無法讀取。請執行 exportRawSyncState() 並暫停同步。'
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
      ? 'MOVE_OPERATION_JOURNAL_REF_COLLISION：journalRef 不唯一，拒絕選取。'
      : 'MOVE_OPERATION_JOURNAL_NOT_FOUND：找不到 journalRef。');
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

function inspectTaskMoveJournals() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('MOVE_OPERATION');
    const state = loadStateForSync_();
    const journals = taskMoveJournalEntries_(state).map(taskMoveJournalPublic_);
    const report = {
      journalCount: journals.length,
      journals: journals,
      taskMoves: taskMoveObservability_(state),
      note: '此報告只顯示 opaque refs 與 bounded evidence；先執行 exportRawSyncState() 備份，再設定 SYNC_TASK_MOVE_OPERATION_JSON 並呼叫 previewTaskMoveJournalOperation()。'
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function parseTaskMoveOperation_(requirePreviewToken) {
  const raw = PropertiesService.getScriptProperties().getProperty(TASK_MOVE_OPERATION_PROPERTY);
  if (!raw) throw new Error('MOVE_OPERATION_MISSING：請設定 SYNC_TASK_MOVE_OPERATION_JSON。');
  let operation;
  try {
    operation = JSON.parse(raw);
  } catch (e) {
    throw new Error('MOVE_OPERATION_INVALID_JSON：SYNC_TASK_MOVE_OPERATION_JSON 不是有效 JSON。');
  }
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('MOVE_OPERATION_INVALID：操作必須是 JSON 物件。');
  }
  const allowed = ['action', 'journalRef', 'revision', 'candidateRef', 'previewToken', 'confirmation'];
  Object.keys(operation).forEach(function(key) {
    if (allowed.indexOf(key) < 0) throw new Error('MOVE_OPERATION_INVALID：不接受未知欄位 ' + key + '。');
  });
  if (['resume', 'cancel', 'reconcile'].indexOf(operation.action) < 0 ||
      typeof operation.journalRef !== 'string' || !operation.journalRef ||
      typeof operation.revision !== 'string' || !operation.revision) {
    throw new Error('MOVE_OPERATION_INVALID：action、journalRef、revision 必須有效。');
  }
  ['candidateRef', 'previewToken', 'confirmation'].forEach(function(field) {
    if (operation[field] !== undefined && (typeof operation[field] !== 'string' || !operation[field])) {
      throw new Error('MOVE_OPERATION_INVALID：' + field + ' 若提供必須是非空字串。');
    }
  });
  if (requirePreviewToken && (typeof operation.previewToken !== 'string' || !operation.previewToken)) {
    throw new Error('MOVE_OPERATION_PREVIEW_TOKEN_REQUIRED：請先 preview，再將 previewToken 寫回操作 JSON。');
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
      ? 'MOVE_OPERATION_CANDIDATE_REF_COLLISION：candidateRef 不唯一，拒絕選取。'
      : 'MOVE_OPERATION_CANDIDATE_NOT_FOUND：找不到 candidateRef。');
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
  const expectedMatches = !!expected && moveFingerprintFromGoogle_(expected) === journal.fingerprint &&
    (expected.updated || null) === (journal.gUpdated || null);
  const correlationCandidates = evidence.correlationCandidates || [];
  const mismatchedCorrelationCandidate = correlationCandidates.length === 1 &&
    moveFingerprintFromMicrosoft_(correlationCandidates[0]) !== journal.fingerprint;
  if (operation.action === 'resume') {
    if (!expectedMatches) return { ok: false, code: 'MOVE_OPERATION_GOOGLE_SOURCE_CHANGED' };
    if (correlationCandidates.length > 1) return { ok: false, code: 'MOVE_CORRELATION_AMBIGUOUS' };
    if (mismatchedCorrelationCandidate) return { ok: false, code: 'MOVE_DESTINATION_EDIT_CONFLICT' };
    if (journal.newMsId && (!evidence.destinationTask ||
        moveFingerprintFromMicrosoft_(evidence.destinationTask) !== journal.fingerprint)) {
      return { ok: false, code: 'MOVE_DESTINATION_EDIT_CONFLICT' };
    }
    return { ok: true, effect: 'RESUME_JOURNAL_ONLY', candidate: null };
  }
  if (operation.action === 'cancel') {
    const original = evidence.originalGoogleTask;
    const returnedToOriginal = !!original && !expected &&
      moveFingerprintFromGoogle_(original) === journal.fingerprint;
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
    if (moveFingerprintFromMicrosoft_(candidate) !== journal.fingerprint) {
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
  if (moveFingerprintFromMicrosoft_(candidate) !== journal.fingerprint) {
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
    note: 'apply 會重新讀取 live evidence；此 preview 不會修改 provider 或同步狀態。'
  };
}

function previewTaskMoveJournalOperation() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('MOVE_OPERATION');
    const operation = parseTaskMoveOperation_(false);
    const state = loadStateForSync_();
    const entry = resolveTaskMoveJournalRef_(state, operation.journalRef);
    if (entry.revision !== operation.revision) {
      throw new Error('MOVE_OPERATION_STALE_REVISION：journal 已改變，請重新 inspect。');
    }
    const evidence = taskMoveOperationLiveEvidence_(state, entry);
    const plan = taskMoveOperationPlan_(operation, entry, evidence);
    const previewToken = taskMoveOperationEvidenceDigest_(operation, entry, evidence);
    const report = taskMoveOperationPublicResult_(operation, entry, evidence, plan, previewToken);
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
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
    throw new Error('MOVE_OPERATION_RECEIPT_SAVE_FAILED：無法保存 private before-image；未修改任何 journal。');
  }
}

function applyTaskMoveJournalOperation() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('MOVE_OPERATION');
    const operation = parseTaskMoveOperation_(true);
    const state = loadStateForSync_();
    const entry = resolveTaskMoveJournalRef_(state, operation.journalRef);
    if (entry.revision !== operation.revision) {
      throw new Error('MOVE_OPERATION_STALE_REVISION：journal 已改變，請重新 inspect 與 preview。');
    }
    const evidence = taskMoveOperationLiveEvidence_(state, entry);
    const liveToken = taskMoveOperationEvidenceDigest_(operation, entry, evidence);
    if (operation.previewToken !== liveToken) {
      throw new Error('MOVE_OPERATION_STALE_PREVIEW：live evidence 已改變，請重新 preview。');
    }
    const plan = taskMoveOperationPlan_(operation, entry, evidence);
    if (!plan.ok) throw new Error('MOVE_OPERATION_NOT_SAFE：' + boundedMoveReason_(plan.code));
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
    report.note = '只更新 local move journal；下一個 syncAll 會重新驗證後才可能修改 provider。';
    console.log(JSON.stringify(report, null, 2));
    return report;
  });
}

function healthCheck() {
  const issues = [];
  const roundFence = syncRoundFenceStatus_();
  const safety = getSafetyConfig_();
  if (!isAutoDiscoveryMode_(safety) && !safety.googleListIds.length) {
    issues.push('尚未設定 SYNC_GOOGLE_LIST_IDS；同步與觸發器目前被安全鎖住。');
  }
  try {
    getConfig_();
  } catch (e) {
    issues.push('Script Properties 缺少必要設定：' + e.message);
  }
  try {
    const service = microsoftService_();
    if (!service.hasAccess()) {
      issues.push('Microsoft 授權失效。請執行 resetMicrosoftAuthorization() 後再執行 startAuthorization()。');
    }
  } catch (e) {
    issues.push('Microsoft 授權檢查失敗：' + e.message);
  }
  const triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'syncAll';
  });
  if (!triggers.length) {
    issues.push('沒有 syncAll 觸發器。請執行 createTrigger()。');
  }
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    issues.push('狀態損壞：STATE_CORRUPT。請執行 exportRawSyncState() 並暫停同步。');
  }
  const state = loaded.state;
  try {
    requireConfiguredListPairsApplied_(state, safety);
  } catch (e) {
    issues.push('明確清單配對未就緒：' + e.message);
  }
  const faultCount = Object.keys(state.listFaults.g).length + Object.keys(state.listFaults.ms).length;
  if (faultCount) {
    issues.push('有 ' + faultCount + ' 個清單處於隔離狀態。請執行 listSyncFaults()。');
  }
  const taskDeletion = taskDeletionObservability_(state, safety);
  const taskMoves = taskMoveObservability_(state);
  const listDeletion = listDeletionObservability_(state, safety);
  if (listDeletionModeError_(safety)) {
    issues.push('SYNC_ALLOW_LIST_DELETIONS=true 只能在 auto 模式使用；同步會先暫停既有清單 journal。');
  }
  if (listDeletion.journalPhases.orphan || listDeletion.journalPhases.blocked) {
    issues.push('有 ' + (listDeletion.journalPhases.orphan + listDeletion.journalPhases.blocked) +
      ' 個清單刪除 journal 無法安全續跑。');
  }
  const listTombstoneIntegrityIssues = loaded.listTombstoneIntegrityIssues ||
    listTombstoneIntegrityIssues_(state);
  if (listTombstoneIntegrityIssues.length) {
    issues.push('有 ' + listTombstoneIntegrityIssues.length +
      ' 項清單 tombstone 完整性錯誤（含雙向與 alias 對稱檢查）；已保守阻擋自動重建。');
  }
  if (taskDeletion.orphanDeletionJournals) {
    issues.push('有 ' + taskDeletion.orphanDeletionJournals +
      ' 個刪除 journal 缺少 mapping；已安全阻擋自動建立，請先恢復或人工檢查 state。');
  }
  if (taskDeletion.blockedDeletionJournals) {
    issues.push('有 ' + taskDeletion.blockedDeletionJournals +
      ' 個刪除 journal 的清單配對或 inventory 未完成；已隔離且不會刪除。');
  }
  if (taskMoves.blockedJournals) {
    issues.push('有 ' + taskMoves.blockedJournals +
      ' 個 task move journal 被安全阻擋。請執行 inspectTaskMoveJournals()。');
  }
  if (taskMoves.legacyWithoutCorrelation) {
    issues.push('有 ' + taskMoves.legacyWithoutCorrelation +
      ' 個 legacy task move journal 沒有 correlation marker；不會自動採納或重建。請執行 inspectTaskMoveJournals()。');
  }
  if (roundFence.active) {
    issues.push('有未完成的 sync round safety fence；下一次 syncAll 會先清除 volatile deletion proof，再安全恢復。');
  }
  console.log(JSON.stringify({
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
  }, null, 2));
}

function exportSyncState() {
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    console.error('[Export] 狀態損壞。請改用 exportRawSyncState()。');
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
    if (key === STATE_KEY + '_manifest' || key.indexOf(STATE_KEY + '_gen_') === 0) {
      raw[key] = all[key];
    }
  });
  const bundle = { exportedAt: new Date().toISOString(), properties: raw };
  console.log(JSON.stringify(bundle, null, 2));
  return bundle;
}

function restorePreviousSyncState() {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('STATE_RESTORE');
    const current = loadStateForSync_();
    assertNoAnyDeletionJournals_(current, 'STATE_RESTORE');
    const props = PropertiesService.getUserProperties();
    const manifestRaw = props.getProperty(STATE_KEY + '_manifest');
    if (!manifestRaw) throw new Error('STATE_RESTORE_UNAVAILABLE：找不到狀態 manifest。');
    const manifest = JSON.parse(manifestRaw);
    const generation = manifest.previousGeneration;
    if (!generation) throw new Error('STATE_RESTORE_UNAVAILABLE：沒有上一個狀態世代。');
    const prefix = STATE_KEY + '_gen_' + generation + '_';
    const count = Number(props.getProperty(prefix + 'count'));
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('STATE_RESTORE_CORRUPT：上一世代缺少有效 count。');
    }
    const parts = [];
    for (let i = 0; i < count; i++) {
      const piece = props.getProperty(prefix + i);
      if (piece === null) throw new Error('STATE_RESTORE_CORRUPT：上一世代缺少 chunk ' + i + '。');
      parts.push(piece);
    }
    const previous = normalizeState_(JSON.parse(decodeURIComponent(parts.join(''))));
    assertNoAnyDeletionJournals_(previous, 'STATE_RESTORE');
    assertTombstoneEvidencePreserved_(current, previous);
    assertActiveDeletionEvidencePreserved_(current, previous);
    saveState_(previous);
    console.log('[Restore] 已將上一個可讀世代複製為目前狀態。請先執行 dryRunReport()。');
  });
}

function importSyncState(jsonString) {
  return withGlobalLock_(function() {
    assertNoActiveSyncRoundFence_('IMPORT');
    const current = loadStateForSync_();
    assertNoAnyDeletionJournals_(current, 'IMPORT');
    let parsed;
    try {
      parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    } catch (e) {
      throw new Error('IMPORT_INVALID_JSON：匯入內容不是有效 JSON。');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('IMPORT_INVALID_STATE：匯入內容必須是狀態 JSON 物件。');
    }
    validateImportedState_(parsed);
    const normalized = normalizeState_(parsed);
    assertNoAnyDeletionJournals_(normalized, 'IMPORT');
    assertTombstoneEvidencePreserved_(current, normalized);
    assertActiveDeletionEvidencePreserved_(current, normalized);
    saveState_(normalized);
    console.log('[Import] 已匯入狀態。請執行 dryRunReport() 確認後再啟用 syncAll。');
  });
}

function validateImportedState_(state) {
  const objectFields = ['listMap', 'g2m', 'm2g', 'tombstones', 'listFaults', 'health'];
  const optionalObjectFields = ['pendingTaskDeletions', 'deletionJournal', 'taskMoveJournal',
    'taskDeletionConflicts'];
  if (state.schema !== 2 && state.schema !== 3) {
    throw new Error('IMPORT_INVALID_STATE：僅接受 schema=2 或 schema=3 的完整匯出。');
  }
  assertStrictSchema2StateShape_(state, 'IMPORT_INVALID_STATE');
  assertStrictSchema3StateShape_(state, 'IMPORT_INVALID_STATE');
  objectFields.forEach(function(field) {
    const value = state[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('IMPORT_INVALID_STATE：欄位 ' + field + ' 必須是物件。');
    }
  });
  optionalObjectFields.forEach(function(field) {
    if (state[field] !== undefined &&
        (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field]))) {
      throw new Error('IMPORT_INVALID_STATE：欄位 ' + field + ' 若提供必須是物件。');
    }
  });
  assertListMapOneToOne_(state, 'IMPORT_INVALID_STATE');
  Object.keys(state.g2m).forEach(function(gTaskId) {
    const rec = state.g2m[gTaskId];
    if (!rec || typeof rec !== 'object' || !rec.msId || !rec.gListId || !rec.msListId) {
      throw new Error('IMPORT_INVALID_STATE：g2m[' + gTaskId + '] 缺少必要 ID。');
    }
  });
  validateImportedTaskDeletionState_(state);
  if (state.schema === 3) validateImportedListDeletionState_(state);
}

function validateImportedTaskDeletionRecord_(field, gTaskId, record, requireRound) {
  const hasStrings = record && typeof record === 'object' && !Array.isArray(record) &&
    record.gId === gTaskId && typeof record.msId === 'string' && !!record.msId &&
    typeof record.gListId === 'string' && !!record.gListId &&
    typeof record.msListId === 'string' && !!record.msListId &&
    ['google', 'microsoft', 'both'].indexOf(record.missingSide) >= 0 &&
    (record.gUpdated === null || typeof record.gUpdated === 'string' || record.gUpdated === undefined) &&
    (record.msUpdated === null || typeof record.msUpdated === 'string' || record.msUpdated === undefined);
  if (!hasStrings) {
    throw new Error('IMPORT_INVALID_STATE：' + field + '[' + gTaskId + '] 格式或 task/list ID 無效。');
  }
  if (requireRound &&
      (!Number.isInteger(record.confirmations) || record.confirmations !== 1 ||
       typeof record.lastRoundId !== 'string' || !record.lastRoundId)) {
    throw new Error('IMPORT_INVALID_STATE：pendingTaskDeletions[' + gTaskId + '] 缺少有效 round。');
  }
}

function validateImportedTaskDeletionState_(state) {
  const pending = state.pendingTaskDeletions || {};
  const journals = state.deletionJournal || {};
  const conflicts = state.taskDeletionConflicts || {};
  Object.keys(pending).forEach(function(gTaskId) {
    const record = pending[gTaskId];
    validateImportedTaskDeletionRecord_('pendingTaskDeletions', gTaskId, record, true);
    const mapping = state.g2m[gTaskId];
    if (!mapping || mapping.msId !== record.msId || mapping.gListId !== record.gListId ||
        mapping.msListId !== record.msListId) {
      throw new Error('IMPORT_INVALID_STATE：pendingTaskDeletions[' + gTaskId + '] 與 mapping 不一致。');
    }
  });
  Object.keys(journals).forEach(function(gTaskId) {
    const record = journals[gTaskId];
    validateImportedTaskDeletionRecord_('deletionJournal', gTaskId, record, false);
    if (record.phase !== 'prepared' && record.phase !== 'paused') {
      throw new Error('IMPORT_INVALID_STATE：deletionJournal[' + gTaskId + '] phase 無效。');
    }
    if (typeof record.preparedAt !== 'string' || !record.preparedAt) {
      throw new Error('IMPORT_INVALID_STATE：deletionJournal[' + gTaskId + '] 缺少 preparedAt。');
    }
    const mapping = state.g2m[gTaskId];
    if (mapping && (mapping.msId !== record.msId || mapping.gListId !== record.gListId ||
        mapping.msListId !== record.msListId)) {
      throw new Error('IMPORT_INVALID_STATE：deletionJournal[' + gTaskId + '] 與 mapping 不一致。');
    }
  });
  Object.keys(conflicts).forEach(function(gTaskId) {
    const record = conflicts[gTaskId];
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.msId !== 'string' || !record.msId ||
        typeof record.gListId !== 'string' || !record.gListId ||
        typeof record.msListId !== 'string' || !record.msListId ||
        typeof record.reason !== 'string' || !record.reason ||
        typeof record.at !== 'string' || !record.at) {
      throw new Error('IMPORT_INVALID_STATE：taskDeletionConflicts[' + gTaskId + '] 格式或 ID 無效。');
    }
  });
}

function validateImportedListDeletionRecord_(field, key, record, requireRound) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.gListId !== 'string' || !record.gListId ||
      typeof record.msListId !== 'string' || !record.msListId ||
      key !== listPairKey_(record.gListId, record.msListId) ||
      ['google', 'microsoft', 'both'].indexOf(record.missingSide) < 0 ||
      typeof record.taskFingerprint !== 'string' || !Array.isArray(record.taskPairs) ||
      record.deletable !== true) {
    throw new Error('IMPORT_INVALID_STATE：' + field + '[' + key + '] 格式或 list ID 無效。');
  }
  if (requireRound && (!Number.isInteger(record.confirmations) || record.confirmations !== 1 ||
      typeof record.lastRoundId !== 'string' || !record.lastRoundId)) {
    throw new Error('IMPORT_INVALID_STATE：pendingListDeletions[' + key + '] 缺少有效 round。');
  }
}

function validateImportedListDeletionState_(state) {
  const fields = ['listPairMeta', 'pendingListDeletions', 'listDeletionJournal',
    'listDeletionConflicts', 'listTombstones', 'listTombstoneNames'];
  fields.forEach(function(field) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error('IMPORT_INVALID_STATE：欄位 ' + field + ' 必須是物件。');
    }
  });
  if (!state.listTombstones.g || typeof state.listTombstones.g !== 'object' || Array.isArray(state.listTombstones.g) ||
      !state.listTombstones.ms || typeof state.listTombstones.ms !== 'object' || Array.isArray(state.listTombstones.ms)) {
    throw new Error('IMPORT_INVALID_STATE：listTombstones 必須包含 g/ms 物件。');
  }
  if (!state.listTombstoneNames.g || typeof state.listTombstoneNames.g !== 'object' || Array.isArray(state.listTombstoneNames.g) ||
      !state.listTombstoneNames.ms || typeof state.listTombstoneNames.ms !== 'object' || Array.isArray(state.listTombstoneNames.ms)) {
    throw new Error('IMPORT_INVALID_STATE：listTombstoneNames 必須包含 g/ms 物件。');
  }
  Object.keys(state.listPairMeta).forEach(function(key) {
    const meta = state.listPairMeta[key];
    if (!meta || typeof meta !== 'object' || key !== listPairKey_(meta.gListId, meta.msListId) ||
        typeof meta.autoBothLiveProvenAt !== 'string' || !meta.autoBothLiveProvenAt) {
      throw new Error('IMPORT_INVALID_STATE：listPairMeta[' + key + '] 格式無效。');
    }
  });
  Object.keys(state.pendingListDeletions).forEach(function(key) {
    validateImportedListDeletionRecord_('pendingListDeletions', key, state.pendingListDeletions[key], true);
  });
  Object.keys(state.listDeletionJournal).forEach(function(key) {
    const record = state.listDeletionJournal[key];
    validateImportedListDeletionRecord_('listDeletionJournal', key, record, false);
    if (['prepared', 'paused', 'blocked'].indexOf(record.phase) < 0 ||
        typeof record.preparedAt !== 'string' || !record.preparedAt) {
      throw new Error('IMPORT_INVALID_STATE：listDeletionJournal[' + key + '] phase 無效。');
    }
  });
  Object.keys(state.listDeletionConflicts).forEach(function(key) {
    const record = state.listDeletionConflicts[key];
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.reason !== 'string' || !record.reason ||
        typeof record.at !== 'string' || !record.at) {
      throw new Error('IMPORT_INVALID_STATE：listDeletionConflicts[' + key + '] 格式無效。');
    }
  });
  assertListTombstoneIntegrity_(state, 'IMPORT_INVALID_STATE');
}

function validateLoadedListDeletionState_(state) {
  ensureListDeletionState_(state);
  assertListTombstoneIntegrity_(state, 'STATE_MALFORMED');
  Object.keys(state.listPairMeta).forEach(function(key) {
    const meta = state.listPairMeta[key];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
        typeof meta.gListId !== 'string' || typeof meta.msListId !== 'string' ||
        key !== listPairKey_(meta.gListId, meta.msListId) ||
        typeof meta.autoBothLiveProvenAt !== 'string' || !meta.autoBothLiveProvenAt) {
      throw new Error('STATE_MALFORMED：listPairMeta[' + key + '] 無法安全使用。');
    }
  });
  Object.keys(state.pendingListDeletions).forEach(function(key) {
    const rec = state.pendingListDeletions[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
        rec.gListId === undefined || rec.msListId === undefined ||
        key !== listPairKey_(rec.gListId, rec.msListId) || rec.confirmations !== 1 ||
        typeof rec.lastRoundId !== 'string' || !rec.lastRoundId ||
        !Array.isArray(rec.taskPairs) || typeof rec.taskFingerprint !== 'string') {
      throw new Error('STATE_MALFORMED：pendingListDeletions[' + key + '] 無法安全使用。');
    }
  });
  Object.keys(state.listDeletionJournal).forEach(function(key) {
    const rec = state.listDeletionJournal[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
        key !== listPairKey_(rec.gListId, rec.msListId) ||
        ['prepared', 'paused', 'blocked'].indexOf(rec.phase) < 0 ||
        typeof rec.preparedAt !== 'string' || !rec.preparedAt || !Array.isArray(rec.taskPairs)) {
      throw new Error('STATE_MALFORMED：listDeletionJournal[' + key + '] 無法安全使用。');
    }
  });
  Object.keys(state.listDeletionConflicts).forEach(function(key) {
    const rec = state.listDeletionConflicts[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
        typeof rec.reason !== 'string' || !rec.reason || typeof rec.at !== 'string' || !rec.at) {
      throw new Error('STATE_MALFORMED：listDeletionConflicts[' + key + '] 無法安全使用。');
    }
  });
}

function countAffectedMappings_(state, gListId, msListId) {
  return Object.keys(state.g2m).filter(function(gTaskId) {
    const rec = state.g2m[gTaskId];
    if (!rec) return false;
    if (gListId && rec.gListId === gListId) return true;
    if (msListId && rec.msListId === msListId) return true;
    return false;
  }).length;
}

function listSyncFaults() {
  const loaded = loadStateForInspection_();
  if (loaded.corrupt) {
    console.log(JSON.stringify({
      error: 'STATE_CORRUPT',
      note: '狀態存在但無法讀取。請執行 exportRawSyncState() 並暫停同步。'
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
        ? '先設定 Script Property REPAIR_GOOGLE_LIST_ID=' + f.gListId + '，再執行 repairFaultedListFromProperty()。'
        : '缺少 Google 清單 ID；先保留隔離並人工檢查狀態。'
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
      suggestion: '先設定 Script Property REPAIR_GOOGLE_LIST_ID=' + gId + '，再執行 repairFaultedListFromProperty()。'
    });
  });
  console.log(JSON.stringify({
    faultCount: faults.length,
    faults: faults,
    note: '清單隔離期間，syncAll 會跳過這些清單，不會刪除任務。'
  }, null, 2));
}

function deletionJournalIdsForListPair_(state, gListId, msListId) {
  ensureTaskDeletionState_(state);
  ensureTaskMoveState_(state);
  const deleteIds = Object.keys(state.deletionJournal).filter(function(gTaskId) {
    const journal = state.deletionJournal[gTaskId];
    const mapping = state.g2m[gTaskId];
    return !!journal &&
      ((gListId && (journal.gListId === gListId || (mapping && mapping.gListId === gListId))) ||
      (msListId && (journal.msListId === msListId || (mapping && mapping.msListId === msListId))));
  });
  const moveIds = Object.keys(state.taskMoveJournal).filter(function(gTaskId) {
    const journal = state.taskMoveJournal[gTaskId];
    return !!journal && ((gListId && journal.gListId === gListId) ||
      (msListId && (journal.oldMsListId === msListId || journal.targetMsListId === msListId)));
  });
  return Array.from(new Set(deleteIds.concat(moveIds)));
}

function assertNoDeletionJournalForListPair_(state, gListId, msListId) {
  const journalIds = deletionJournalIdsForListPair_(state, gListId, msListId);
  if (journalIds.length) {
    throw new Error('REPAIR_DELETION_JOURNAL_PENDING：先完成或人工檢查 deletion journal，不能重設配對。task=' + journalIds.join(','));
  }
}

function listLifecycleRecordsForPair_(state, gListId, msListId) {
  ensureListDeletionState_(state);
  const key = listPairKey_(gListId, msListId);
  const records = [];
  ['listPairMeta', 'pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts'].forEach(function(field) {
    if (state[field][key]) records.push(field);
  });
  const gTombstone = hasListTombstone_(state, 'g', gListId, null);
  const msTombstone = hasListTombstone_(state, 'ms', msListId, null);
  if (gTombstone || msTombstone) records.push('listTombstones');
  return records;
}

function assertNoListLifecycleForPair_(state, gListId, msListId) {
  // Auto both-live provenance alone is not an unresolved delete intent. A
  // fault repair may reset its mapping, but first turns that metadata into an
  // orphan reservation so the planner cannot recreate the historic survivor.
  const records = listLifecycleRecordsForPair_(state, gListId, msListId)
    .filter(function(record) { return record !== 'listPairMeta'; });
  if (records.length) {
    throw new Error('REPAIR_LIST_LIFECYCLE_PENDING：不能遺失清單刪除 provenance：' + records.join(','));
  }
}

function preserveListPairMetaForRepair_(state, gListId, msListId) {
  ensureListDeletionState_(state);
  const key = listPairKey_(gListId, msListId);
  const meta = state.listPairMeta[key];
  if (!meta) return false;
  // This is deliberately a non-delete conflict/guard, not a tombstone: the
  // operator is repairing a fault, not declaring either list deleted. The
  // lifecycle classifier reserves its exact IDs and normalized names even
  // after listMap is removed, preventing an unsafe auto-create on resync.
  state.listDeletionConflicts[key] = {
    at: new Date().toISOString(),
    reason: 'LIST_REPAIR_HISTORIC_PAIR_GUARD',
    gListId: gListId,
    msListId: msListId,
    gTitle: meta.gTitle || '',
    msTitle: meta.msTitle || ''
  };
  delete state.listPairMeta[key];
  return true;
}

function assertNoAnyDeletionJournals_(state, code) {
  ensureTaskDeletionState_(state);
  ensureTaskMoveState_(state);
  ensureListDeletionState_(state);
  if (Object.keys(state.deletionJournal).length || Object.keys(state.taskMoveJournal).length ||
      Object.keys(state.listDeletionJournal).length) {
    throw new Error((code || 'STATE_CHANGE') +
      '_DELETION_JOURNAL_PENDING：存在 task deletion、task move 或 list deletion journal，已拒絕覆寫。');
  }
}

function resetListPairing_(state, gListId, msListId) {
  assertNoDeletionJournalForListPair_(state, gListId, msListId);
  assertNoListLifecycleForPair_(state, gListId, msListId);
  preserveListPairMetaForRepair_(state, gListId, msListId);
  Object.keys(state.g2m).forEach(function(gTaskId) {
    const rec = state.g2m[gTaskId];
    if (!rec) return;
    const matchG = gListId && rec.gListId === gListId;
    const matchMs = msListId && rec.msListId === msListId;
    if (matchG || matchMs) {
      removeMapping_(state, gTaskId, rec.msId);
    }
  });
  if (gListId) {
    delete state.listMap[gListId];
    delete state.listFaults.g[gListId];
  }
  if (msListId) {
    Object.keys(state.listMap).forEach(function(id) {
      if (state.listMap[id] === msListId) delete state.listMap[id];
    });
    delete state.listFaults.ms[msListId];
  }
}

function resolveFaultedGoogleListPair_(state, gListId, fault) {
  ensureListDeletionState_(state);
  const candidates = {};
  function add(msListId) {
    if (typeof msListId === 'string' && msListId) candidates[msListId] = true;
  }
  add(fault && fault.msListId);
  add(state.listMap && state.listMap[gListId]);
  Object.keys(state.listPairMeta || {}).forEach(function(key) {
    const meta = state.listPairMeta[key];
    if (meta && meta.gListId === gListId) add(meta.msListId);
  });
  Object.keys(state.listFaults.ms || {}).forEach(function(msListId) {
    const msFault = state.listFaults.ms[msListId];
    if (msFault && msFault.gListId === gListId) add(msListId);
  });
  const ids = Object.keys(candidates).sort();
  if (ids.length > 1) {
    throw new Error('REPAIR_LIST_PAIR_AMBIGUOUS：Google 清單 ' + gListId +
      ' 對應多個歷史 Microsoft 清單，已拒絕變更。');
  }
  return ids.length === 1 ? ids[0] : null;
}

function repairFaultedListByGoogleId(gListId) {
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
      console.warn('[Repair] 找不到 Google 清單 ID「' + gListId + '」的故障。請執行 listSyncFaults()。');
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
    console.log('[Repair] 已重設 Google 清單 ID「' + gListId + '」的配對。');
    console.log('[Repair] 若已設定 SYNC_LIST_PAIRS_JSON，請重新驗證並套用；否則下一輪可能建立新清單。請先執行 dryRunReport()。');
  });
}

function repairFaultedListFromProperty() {
  const gListId = PropertiesService.getScriptProperties().getProperty('REPAIR_GOOGLE_LIST_ID');
  if (!gListId) {
    throw new Error('請先在 Script Properties 設定 REPAIR_GOOGLE_LIST_ID。');
  }
  return repairFaultedListByGoogleId(gListId);
}

function clearAllListFaultsAndPrepareResync() {
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
        throw new Error('REPAIR_DELETION_JOURNAL_PENDING：先完成或人工檢查 deletion journal，不能清除所有 fault。task=' + gTaskId);
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
    console.log('[Repair] 已清除所有清單故障標記，並重設受影響清單的配對。');
    console.log('[Repair] 若已設定 SYNC_LIST_PAIRS_JSON，請重新驗證並套用；否則下一輪會以首次同步方式處理。');
    console.log('[Repair] 未使用明確配對時可能建立新清單或產生重複任務。請先執行 dryRunReport() 確認。');
  });
}
