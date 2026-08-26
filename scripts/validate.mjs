import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

new vm.Script(code, { filename: 'Code.gs' });

const requiredFunctions = [
  'initializeSafeDefaults',
  'setupStatus',
  'showRedirectUri',
  'startAuthorization',
  'authCallback',
  'listGoogleTaskLists',
  'listMicrosoftTaskLists',
  'createGList_',
  'deleteGList_',
  'deleteMsList_',
  'planAutoListMappings_',
  'classifyListLifecycle_',
  'applyConfirmedListDeletions_',
  'ensureAutoListMappings_',
  'validateConfiguredListPairs',
  'applyConfiguredListPairs',
  'adoptExistingListMappingsAsConfiguredPairs',
  'dryRunReport',
  'syncAll',
  'createTrigger',
  'deleteSyncTriggers',
  'inspectTaskMoveJournals',
  'previewTaskMoveJournalOperation',
  'applyTaskMoveJournalOperation',
  'healthCheck'
];

for (const name of requiredFunctions) {
  if (!new RegExp(`function\\s+${name}\\s*\\(`).test(code)) {
    throw new Error(`Missing required function: ${name}`);
  }
}

if (packageJson.version !== '0.1.0') {
  throw new Error('package version must be 0.1.0');
}

for (const expected of [
  "const SYNC_TRIGGER_INTERVAL_MINUTES = 10;",
  "const MOVE_EXTENSION_NAME = 'com.tasksTodoSync.move';",
  "const MOVE_EXTENSION_IDS = [",
  "'microsoft.graph.openTypeExtension.' + MOVE_EXTENSION_NAME",
  "'Microsoft.OutlookServices.OpenTypeExtension.' + MOVE_EXTENSION_NAME",
  "MOVE_EXTENSION_IDS.indexOf(extension.id) >= 0",
  "const DESTRUCTIVE_OPERATION_RESERVE_MS = 45 * 1000;",
  "const TASK_MOVE_OPERATION_PROPERTY = 'SYNC_TASK_MOVE_OPERATION_JSON';",
  ".everyMinutes(SYNC_TRIGGER_INTERVAL_MINUTES)",
  "'@odata.type': 'microsoft.graph.openTypeExtension'",
  "extension.extensionName === MOVE_EXTENSION_NAME",
  "? '&$expand=extensions($filter=id%20eq%20%27' +",
  "encodeURIComponent(MOVE_EXTENSION_NAME) + '%27)'",
  "function taskMoveOperationIntent_(operation)",
  "candidateRef: operation.candidateRef || null",
  "confirmation: operation.confirmation || null",
  "taskMoveOperationEvidenceDigest_(operation, entry, evidence)",
  "props.getProperty(TASK_MOVE_OPERATION_RECEIPT_KEY) !== serialized",
  "TIME_BUDGET_TASK_DELETE_RECOVERY_READ",
  "TIME_BUDGET_LIST_DELETE_RECOVERY_READ",
  "TIME_BUDGET_MOVE_DELETE_REMOTE",
  '下輪會重新執行完整 inventory，沒有持久化 page cursor'
]) {
  if (!code.includes(expected)) throw new Error(`Missing sync invariant: ${expected}`);
}

if (/\$expand=extensions\(\$filter=id[^\n]*(?:microsoft\.graph|Microsoft\.OutlookServices)/.test(code)) {
  throw new Error('Move extension query must filter by the unqualified extension name, not a service prefix');
}
if (/extension\.id\s*===\s*MOVE_EXTENSION_NAME|\.endsWith\([^\n]*MOVE_EXTENSION_NAME/.test(code)) {
  throw new Error('Move recovery must use the exact service-normalized extension-id allowlist');
}

if (/\.everyMinutes\(15\)/.test(code) || /已建立每 15 分鐘同步/.test(code)) {
  throw new Error('Current trigger implementation must not claim or install a 15-minute cadence');
}

for (const relative of [
  '../README.md', '../docs/deployment.md', '../docs/quick-start.md',
  '../docs/e2e-validation.md', '../SECURITY.md'
]) {
  const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
  if (/runs every 15 minutes|creates? (?:the |a )?15-minute .*trigger|每 15 分鐘同步/i.test(text)) {
    throw new Error(`${relative} still presents 15 minutes as the current cadence`);
  }
}

for (const [name, expected] of [
  ['ALLOW_NAME_PAIRING', 'false'],
  ['REQUIRE_LIST_ALLOWLIST', 'true'],
  ['DEFAULT_ALLOW_DELETIONS', 'false'],
  ['DEFAULT_ALLOW_LIST_DELETIONS', 'false'],
  ['DEFAULT_ALLOW_TASK_MOVES', 'false'],
  ['DEFAULT_LIST_DISCOVERY_MODE', "'explicit'"]
]) {
  if (!new RegExp(`const\\s+${name}\\s*=\\s*${expected}\\s*;`).test(code)) {
    throw new Error(`${name} must remain ${expected}`);
  }
}

if (!code.includes("getProperty('SYNC_LIST_PAIRS_JSON')")) {
  throw new Error('Explicit list pairing must be configured through SYNC_LIST_PAIRS_JSON');
}

for (const property of [
  'SYNC_LIST_DISCOVERY_MODE',
  'SYNC_EXCLUDED_LIST_NAMES',
  'SYNC_ALLOW_DELETIONS',
  'SYNC_ALLOW_LIST_DELETIONS',
  'SYNC_ALLOW_TASK_MOVES'
]) {
  if (!code.includes(`getProperty('${property}')`)) {
    throw new Error(`Missing auto-discovery safety property: ${property}`);
  }
}

const scopes = new Set(manifest.oauthScopes || []);
for (const scope of [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.send_mail',
  'https://www.googleapis.com/auth/script.scriptapp'
]) {
  if (!scopes.has(scope)) throw new Error(`Missing OAuth scope: ${scope}`);
}

const oauth2 = manifest.dependencies?.libraries?.find((item) => item.userSymbol === 'OAuth2');
if (!oauth2 || oauth2.version !== '43' || oauth2.developmentMode !== false) {
  throw new Error('OAuth2 library must be pinned to version 43 with developmentMode=false');
}

for (const forbidden of ['MS_CLIENT_SECRET=', 'CLASPRC_JSON=', 'Bearer eyJ']) {
  if (code.includes(forbidden)) throw new Error(`Possible committed secret: ${forbidden}`);
}

console.log('Static validation passed.');
