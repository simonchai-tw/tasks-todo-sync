import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));

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
  'healthCheck'
];

for (const name of requiredFunctions) {
  if (!new RegExp(`function\\s+${name}\\s*\\(`).test(code)) {
    throw new Error(`Missing required function: ${name}`);
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
