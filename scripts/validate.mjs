import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const setup = readFileSync(new URL('../Setup.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(packageJson.name === 'tasks-todo-sync', 'package name must remain tasks-todo-sync');
assert(typeof packageJson.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version),
  'package version must be a valid release version');
assert(packageJson.private === false, 'package must remain publishable');
assert(packageJson.author === 'Simon Chai', 'package author must remain Simon Chai');
assert(Array.isArray(packageJson.contributors) && packageJson.contributors.length === 2
  && packageJson.contributors[0] === 'ChatGPT' && packageJson.contributors[1] === 'Claude',
  'package contributors must be ["ChatGPT", "Claude"]');
assert(packageLock.name === packageJson.name && packageLock.version === packageJson.version,
  'package-lock metadata must match package.json');
const lockRoot = packageLock.packages?.[''];
assert(lockRoot && lockRoot.name === packageJson.name && lockRoot.version === packageJson.version,
  'package-lock root metadata must match package.json');
assert(JSON.stringify(lockRoot.dependencies || {}) === JSON.stringify(packageJson.dependencies || {}),
  'package-lock root dependencies must match package.json');

const cliPath = fileURLToPath(new URL('../bin/tasks-todo-sync.mjs', import.meta.url));
const cliVersion = execFileSync(process.execPath, [cliPath, '--version'], {
  cwd: root,
  encoding: 'utf8'
}).trim();
assert(cliVersion === packageJson.version, 'CLI --version must match package.json');

new vm.Script(code, { filename: 'Code.gs' });

const requiredFunctions = [
  'initializeSafeDefaults',
  'setupStatus',
  'doGet',
  'setupWizardBeginPersonalAuthorization',
  'setupWizardPollPersonalAuthorization',
  'setupWizardPersonalAuthorizationStatus',
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

const declarations = new Map([...code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g)]
  .map((match) => [match[1], match[2].replace(/\s+/g, ' ').trim()]));
for (const [name, expected] of [
  ['SYNC_TRIGGER_INTERVAL_MINUTES', '10'],
  ['DESTRUCTIVE_OPERATION_RESERVE_MS', '45 * 1000'],
  ['ALLOW_NAME_PAIRING', 'false'],
  ['REQUIRE_LIST_ALLOWLIST', 'true'],
  ['DEFAULT_ALLOW_DELETIONS', 'false'],
  ['DEFAULT_ALLOW_LIST_DELETIONS', 'false'],
  ['DEFAULT_ALLOW_TASK_MOVES', 'false'],
  ['DEFAULT_LIST_DISCOVERY_MODE', "'explicit'"]
]) {
  assert(declarations.get(name) === expected, `${name} must remain ${expected}`);
}
assert(/const\s+MOVE_EXTENSION_NAME\s*=\s*['"]com\.tasksTodoSync\.move['"]/.test(code),
  'move extension name must remain stable');
assert(/const\s+MOVE_EXTENSION_IDS\s*=\s*\[[\s\S]*?MOVE_EXTENSION_NAME/.test(code)
  && /MOVE_EXTENSION_IDS\.indexOf\(extension\.id\)\s*>=\s*0/.test(code),
  'move recovery must use the service-normalized extension-id allowlist');
assert(/\.everyMinutes\(SYNC_TRIGGER_INTERVAL_MINUTES\)/.test(code),
  'trigger cadence must use the configured interval constant');
assert(/function\s+taskMoveOperationIntent_\s*\(/.test(code)
  && /taskMoveOperationEvidenceDigest_\s*\(/.test(code),
  'move operation intent and evidence helpers must remain present');

for (const marker of [
  "const TASK_MOVE_OPERATION_PROPERTY = 'SYNC_TASK_MOVE_OPERATION_JSON';",
  "const TASK_MOVE_OPERATION_RECEIPT_KEY = 'sync_task_move_operation_before_image';",
  'TIME_BUDGET_TASK_DELETE_RECOVERY_READ',
  'TIME_BUDGET_LIST_DELETE_RECOVERY_READ',
  'TIME_BUDGET_MOVE_DELETE_REMOTE'
]) {
  assert(code.includes(marker), `Missing sync invariant: ${marker}`);
}

if (/\$expand=extensions\(\$filter=id[^\n]*(?:microsoft\.graph|Microsoft\.OutlookServices)/.test(code)) {
  throw new Error('Move extension query must filter by the unqualified extension name, not a service prefix');
}
if (/extension\.id\s*===\s*MOVE_EXTENSION_NAME|\.endsWith\([^\n]*MOVE_EXTENSION_NAME/.test(code)) {
  throw new Error('Move recovery must use the exact service-normalized extension-id allowlist');
}

if (/\.everyMinutes\(15\)/.test(code) || /15-minute sync trigger/i.test(code)) {
  throw new Error('Current trigger implementation must not claim or install a 15-minute cadence');
}

for (const relative of [
  '../README.md', '../docs/deployment.md', '../docs/quick-start.md',
  '../docs/e2e-validation.md', '../SECURITY.md'
]) {
  const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
  if (/runs every 15 minutes|creates? (?:the |a )?15-minute .*trigger/i.test(text)) {
    throw new Error(`${relative} still presents 15 minutes as the current cadence`);
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
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/userinfo.email'
]) {
  if (!scopes.has(scope)) throw new Error(`Missing OAuth scope: ${scope}`);
}

const oauth2 = manifest.dependencies?.libraries?.find((item) => item.userSymbol === 'OAuth2');
if (!oauth2 || oauth2.version !== '43' || oauth2.developmentMode !== false) {
  throw new Error('OAuth2 library must be pinned to version 43 with developmentMode=false');
}

assert(manifest.webapp?.access === 'MYSELF', 'setup web app access must remain MYSELF');
assert(manifest.webapp?.executeAs === 'USER_DEPLOYING',
  'setup web app must execute as USER_DEPLOYING');
assert(code.includes("const MS_PERSONAL_CLIENT_ID_ = '1139ef4a-297c-4c4f-b414-6393aec2ee31';"),
  'Personal Device Flow public client ID must remain explicit');
assert(!/\.innerHTML\s*=/.test(setup), 'Setup wizard must not render dynamic data with innerHTML');
for (const forbidden of ['device_code', 'access_token', 'refresh_token', 'MS_CLIENT_SECRET']) {
  if (setup.includes(forbidden)) throw new Error(`Setup wizard exposes forbidden field: ${forbidden}`);
}
assert(setup.includes('microsoft.com/link') && setup.includes('microsoft.com/devicelogin'),
  'Setup wizard must identify current and legacy official Microsoft device sign-in pages');

for (const forbidden of ['MS_CLIENT_SECRET=', 'CLASPRC_JSON=', 'Bearer eyJ']) {
  if (code.includes(forbidden)) throw new Error(`Possible committed secret: ${forbidden}`);
}

console.log('Static validation passed.');
