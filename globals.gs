const GTASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
const MS_TODO_BASE = 'https://graph.microsoft.com/v1.0/me/todo/lists';
const MS_AUTH_MODE_PROPERTY_ = 'MS_AUTH_MODE';
const MS_AUTH_MODE_PERSONAL_ = 'personal_device';
const MS_AUTH_MODE_ADVANCED_ = 'advanced_entra';
// Public application identifiers are not credentials. This app registration
// is a personal-account-only public client and has no secret or redirect URI.
const MS_PERSONAL_CLIENT_ID_ = '1139ef4a-297c-4c4f-b414-6393aec2ee31';
const MS_PERSONAL_AUTHORITY_ = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MS_PERSONAL_SCOPE_ = 'Tasks.ReadWrite offline_access';
const MS_PERSONAL_DEVICE_SESSION_KEY_ = 'MS_PERSONAL_DEVICE_SESSION_V1';
const MS_PERSONAL_ACCESS_TOKEN_KEY_ = 'MS_PERSONAL_ACCESS_TOKEN';
const MS_PERSONAL_REFRESH_TOKEN_KEY_ = 'MS_PERSONAL_REFRESH_TOKEN';
const MS_PERSONAL_ACCESS_EXPIRES_AT_KEY_ = 'MS_PERSONAL_ACCESS_EXPIRES_AT';
const MS_PERSONAL_GRANTED_SCOPE_KEY_ = 'MS_PERSONAL_GRANTED_SCOPE';
const MS_PERSONAL_VERIFIED_KEY_ = 'MS_PERSONAL_VERIFIED';
// An Advanced-to-Personal change is a small transaction.  This evidence is
// deliberately user-scoped, short-lived, and consumed only after the new
// Personal token set has passed a live Graph probe.
const MS_PERSONAL_MODE_SWITCH_APPROVAL_KEY_ = 'MS_PERSONAL_MODE_SWITCH_PENDING_V1';
const MS_PERSONAL_MODE_SWITCH_APPROVAL_TTL_MS_ = 30 * 60 * 1000;
const MS_PERSONAL_REFRESH_MARGIN_MS_ = 5 * 60 * 1000;
const STATE_KEY = 'sync_state_main';
const ROUND_FENCE_KEY = STATE_KEY + '_round_fence';
// This small manifest points at complete main-state generations only.  It is
// deliberately separate from the ordinary previousGeneration checkpoint,
// which can be an in-progress sync save.
const SUCCESSFUL_ROUND_MANIFEST_KEY = STATE_KEY + '_successful_round_manifest';
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
let SYNC_ROUND_FENCE_ROUND_ID_ = null;
let SYNC_ROUND_PROOF_BASELINE_ = null;
const CHUNK_SIZE = 7000;
const PROPERTY_VALUE_SAFE_LIMIT_BYTES = 8 * 1024;
const PROPERTY_STORE_SAFE_LIMIT_BYTES = 450 * 1024;
// Warn before the fail-closed 450 KiB preflight ceiling.  This intentionally
// leaves roughly 20% of the safe store for OAuth2 and other private properties.
const PROPERTY_STORE_WARNING_BYTES = 360 * 1024;
const STORAGE_PRESSURE_ALERT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STATE_GENERATION_CHUNKS = 100;
const MAX_STATE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
// State generations written by this version are gzip-compressed before being
// Base64-encoded for PropertiesService.  The codec information lives in the
// manifest, not in an implicit key name, so older URI-encoded generations
// remain readable and a damaged or unknown generation can fail closed.
const STATE_CODEC_GZIP_BASE64 = 'gzip-base64';
const STATE_CODEC_VERSION = 1;
const STATE_INTEGRITY_ALGORITHM = 'SHA-256';
const STATE_INTEGRITY_ENCODING = 'base64';
const PAGINATION_MAX_PAGES = 100;
const PAGINATION_RESERVE_MS = 20000;
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
// These public-deployment defaults are intentionally explicit and limited to
// four non-secret settings. Keep them separate from runtime fallbacks: a
// missing or invalid setting must remain conservative until setup validates it.
const PUBLIC_SETUP_DEFAULTS = {
  SYNC_LIST_DISCOVERY_MODE: 'auto',
  SYNC_ALLOW_DELETIONS: 'true',
  SYNC_ALLOW_LIST_DELETIONS: 'true',
  SYNC_ALLOW_TASK_MOVES: 'true'
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
  storagePressure: 'alert_storage_pressure_last_at',
  listFault: 'alert_listfault_last_at'
};
let RUN_STARTED_AT = 0;
let SYNC_OBSERVABILITY_ = null;
const MOVE_FINGERPRINT_PREFIX = 'sha256b64:';
