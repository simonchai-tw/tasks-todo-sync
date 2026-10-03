import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { GAS_SOURCE_FILES } from './gas-files.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER_FILE = '.tasks-todo-sync-init.json';
const COMPANION_MARKER_FILE = '.tasks-todo-sync-companion.json';
const DESKTOP_COMMANDS = new Set(['doctor', 'detect', 'install', 'update', 'status', 'sync', 'preferences']);
const SAFE_PARTIAL_FILES = new Set([
  MARKER_FILE,
  '.clasp.json',
  '.gitignore',
  'Code.js',
  ...GAS_SOURCE_FILES,
  'Setup.html',
  'appsscript.json',
  '.claspignore'
]);
const MARKER_PHASES = new Set(['prepared', 'created', 'pushed']);

/* The remote files this CLI owns.  clasp push never deletes remote-only
 * files, so anything outside this set survives a push and keeps breaking
 * the Apps Script compiler (the v0.8.x legacy-.js incident). */
const MANAGED_REMOTE_FILES = new Set([...GAS_SOURCE_FILES, 'Setup.html', 'appsscript.json', '.clasp.json']);

export const POST_DEPLOY_FUNCTIONS = [
  'initializeSafeDefaults',
  'setupStatus',
  'startAuthorization',
  'dryRunReport',
  'syncAll',
  'createTrigger',
  'healthCheck'
];

export const HELP_TEXT = `Tasks-ToDo Sync Apps Script installer

Usage:
  tasks-todo-sync init [options]
  tasks-todo-sync doctor [--json]
  tasks-todo-sync detect [options] --json
  tasks-todo-sync install [options] --json
  tasks-todo-sync update [options] --json
  tasks-todo-sync status [options] --json
  tasks-todo-sync sync [options] --json
  tasks-todo-sync preferences [options] --json

Options:
  --target <directory>  Installation directory (default: tasks-todo-sync-app)
  --title <title>       Apps Script project title (default: Tasks-ToDo-Sync)
  --timezone <IANA>     Apps Script time zone (default: this computer's IANA zone)
  --yes                 Continue without a confirmation prompt
  --non-interactive     Alias for --yes; suitable for scripted use
  --dry-run             Show the safe deployment plan without changing anything
  --help, -h            Show this help
  --version, -v         Show the package version

Personal Microsoft setup uses the bundled public client and requires no secret.
Advanced BYO Entra credentials are added manually in Apps Script only.`;

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

export function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('--timezone must be a non-empty IANA time zone.');
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() })
      .resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid IANA time zone: ${value}`);
  }
}

export function parseArgs(argv, { cwd = process.cwd(), timeZone = localTimeZone(), version = readPackageVersion() } = {}) {
  if (!Array.isArray(argv)) {
    throw new Error('Arguments must be an array.');
  }

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', text: HELP_TEXT };
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    return { command: 'version', text: version };
  }
  if (argv[0] !== 'init') {
    throw new Error(`Unknown command: ${argv[0]}. Run tasks-todo-sync --help.`);
  }

  const options = {
    target: 'tasks-todo-sync-app',
    title: 'Tasks-ToDo-Sync',
    timezone: canonicalTimeZone(timeZone),
    yes: false,
    dryRun: false
  };
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inlineValue] = token.split(/=(.*)/s, 2);

    if (flag === '--help' || flag === '-h') {
      return { command: 'help', text: HELP_TEXT };
    }
    if (flag === '--version' || flag === '-v') {
      return { command: 'version', text: version };
    }
    if (flag === '--yes' || flag === '--non-interactive') {
      if (inlineValue !== undefined) {
        throw new Error(`${flag} does not accept a value.`);
      }
      options.yes = true;
      continue;
    }
    if (flag === '--dry-run') {
      if (inlineValue !== undefined) {
        throw new Error('--dry-run does not accept a value.');
      }
      options.dryRun = true;
      continue;
    }

    if (flag === '--target' || flag === '--title' || flag === '--timezone') {
      if (seen.has(flag)) {
        throw new Error(`${flag} may only be supplied once.`);
      }
      seen.add(flag);
      const value = inlineValue ?? argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value.`);
      }
      if (flag === '--target') options.target = value;
      if (flag === '--title') options.title = value;
      if (flag === '--timezone') options.timezone = canonicalTimeZone(value);
      continue;
    }

    if (/^--(?:ms|microsoft|client)(?:-|_)?(?:client(?:-|_)?id|client(?:-|_)?secret|id|secret)/i.test(flag)
      || /^--(?:ms|microsoft)(?:-|_)?(?:id|secret)/i.test(flag)) {
      throw new Error('Microsoft client IDs and secrets are intentionally not accepted by this CLI.');
    }
    throw new Error(`Unknown option: ${token}. Run tasks-todo-sync --help.`);
  }

  options.title = options.title.trim();
  if (!options.title) {
    throw new Error('--title must not be empty.');
  }
  if (!options.target.trim()) {
    throw new Error('--target must not be empty.');
  }

  return {
    command: 'init',
    ...options,
    target: resolve(cwd, options.target)
  };
}

function wantsJson(argv) {
  return Array.isArray(argv) && argv.includes('--json');
}

function readOptionValue(argv, index, token, inlineValue) {
  const value = inlineValue ?? argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${token} requires a value.`);
  return value;
}

function parseBooleanFlag(token, value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false') {
    throw new Error(`${token} must be true or false.`);
  }
  return normalized === 'true';
}

function parseDesktopArgs(argv, { cwd, timeZone }) {
  const command = argv[0];
  const options = {
    command,
    target: resolve(cwd, 'tasks-todo-sync-app'),
    title: 'Tasks-ToDo-Sync',
    timezone: canonicalTimeZone(timeZone),
    json: false,
    yes: false,
    scriptId: null,
    deploymentId: null,
    calendarProjection: null,
    calendarReminder: null,
    alertEmail: null,
    clearAlertEmail: false
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const [flag, inlineValue] = token.split(/=(.*)/s, 2);
    if (flag === '--help' || flag === '-h') return { command: 'help', text: HELP_TEXT };
    if (flag === '--version' || flag === '-v') return { command: 'version', text: '' };
    if (flag === '--json' || flag === '--yes' || flag === '--non-interactive') {
      if (inlineValue !== undefined) throw new Error(`${flag} does not accept a value.`);
      if (flag === '--json') options.json = true;
      if (flag !== '--json') options.yes = true;
      continue;
    }
    if (flag === '--clear-alert-email') {
      options.clearAlertEmail = true;
      continue;
    }
    if (['--target', '--title', '--timezone', '--script-id', '--deployment-id'].includes(flag)) {
      const value = readOptionValue(argv, index, token, inlineValue);
      if (inlineValue === undefined) index += 1;
      if (flag === '--target') options.target = resolve(cwd, value);
      if (flag === '--title') options.title = value;
      if (flag === '--timezone') options.timezone = canonicalTimeZone(value);
      if (flag === '--script-id') options.scriptId = value.trim();
      if (flag === '--deployment-id') options.deploymentId = value.trim();
      continue;
    }
    if (['--calendar-projection', '--calendar-reminder', '--alert-email'].includes(flag)) {
      const value = readOptionValue(argv, index, token, inlineValue);
      if (inlineValue === undefined) index += 1;
      if (flag === '--calendar-projection') options.calendarProjection = parseBooleanFlag(flag, value);
      if (flag === '--calendar-reminder') options.calendarReminder = parseBooleanFlag(flag, value);
      if (flag === '--alert-email') options.alertEmail = value.trim();
      continue;
    }
    if (/^--(?:ms|microsoft|client)(?:-|_)?(?:client(?:-|_)?id|client(?:-|_)?secret|id|secret)/i.test(flag)
      || /^--(?:ms|microsoft)(?:-|_)?(?:id|secret)/i.test(flag)) {
      throw new Error('Microsoft client IDs and secrets are intentionally not accepted by this CLI.');
    }
    throw new Error(`Unknown option: ${token}. Run tasks-todo-sync --help.`);
  }

  if (!options.json) {
    throw new Error(`The ${command} companion command requires --json; use init for interactive installation.`);
  }
  if (command === 'preferences' && options.alertEmail !== null && options.clearAlertEmail) {
    throw new Error('Use either --alert-email or --clear-alert-email, not both.');
  }
  return options;
}

export async function main(argv, runtime = createNodeRuntime()) {
  const json = wantsJson(argv);
  try {
    const parsed = DESKTOP_COMMANDS.has(argv[0])
      ? parseDesktopArgs(argv, { cwd: runtime.cwd, timeZone: runtime.timeZone, version: runtime.version })
      : parseArgs(argv, {
        cwd: runtime.cwd,
        timeZone: runtime.timeZone,
        version: runtime.version
      });
    if (parsed.command === 'help') {
      say(runtime, parsed.text);
      return 0;
    }
    if (parsed.command === 'version') {
      say(runtime, runtime.version);
      return 0;
    }
    if (parsed.command === 'init') return await init(parsed, runtime);
    return await runDesktopCommand(parsed, runtime);
  } catch (error) {
    if (json) {
      say(runtime, JSON.stringify(jsonFailure(error.message, error.code || 'CLI_ERROR'), null, 2));
    } else {
      sayError(runtime, `Error: ${error.message}`);
    }
    return 1;
  }
}

async function runDesktopCommand(config, runtime) {
  switch (config.command) {
    case 'doctor': return doctorCommand(config, runtime);
    case 'detect': return detectCommand(config, runtime);
    case 'install': return installCompanionCommand(config, runtime);
    case 'update': return updateCompanionCommand(config, runtime);
    case 'status': return statusCommand(config, runtime);
    case 'sync': return syncCommand(config, runtime);
    case 'preferences': return preferencesCommand(config, runtime);
    default:
      throw new Error(`Unknown companion command: ${config.command}`);
  }
}

async function doctorCommand(config, runtime) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  emitJson(runtime, {
    ok: true,
    packageVersion: runtime.version,
    node: {
      version: process.versions.node,
      major: nodeMajor,
      supported: nodeMajor >= 22,
      platform: process.platform,
      arch: process.arch
    },
    target: config.target
  });
  return 0;
}

async function detectCommand(config, runtime) {
  await ensureClaspLogin(runtime, config.target);
  const scripts = await runJsonClasp(runtime, ['list-scripts', '--json'], config.target);
  if (!Array.isArray(scripts)) throw new Error('clasp list-scripts did not return an array.');
  const exact = scripts.filter((item) => item && item.name === config.title);
  const candidates = [];
  for (const item of exact) {
    if (!item.id) continue;
    const fingerprint = await fingerprintRemoteProject(runtime, config.target, item.id);
    candidates.push({
      scriptId: item.id,
      name: item.name,
      confidence: fingerprint.confidence,
      signals: fingerprint.signals,
      unknownFiles: fingerprint.unknownFiles
    });
  }
  candidates.sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));
  const high = candidates.filter((item) => item.confidence === 'high');
  emitJson(runtime, {
    ok: true,
    installed: high.length === 1,
    ambiguous: high.length > 1,
    recommendedScriptId: high.length === 1 ? high[0].scriptId : null,
    candidates
  });
  return 0;
}

async function installCompanionCommand(config, runtime) {
  const exitCode = await init(config, runtime);
  if (exitCode !== 0) return exitCode;
  const scriptId = await readScriptId(runtime, config.target);
  const deployment = await publishDeployment(runtime, config.target, scriptId, null);
  const marker = await writeCompanionMarker(runtime, config.target, {
    scriptId,
    deploymentId: deployment.deploymentId,
    versionNumber: deployment.versionNumber,
    installedAt: runtime.now ? runtime.now() : new Date().toISOString(),
    updatedAt: runtime.now ? runtime.now() : new Date().toISOString()
  });
  emitJson(runtime, { ok: true, action: 'installed', scriptId, ...deployment, marker });
  return 0;
}

async function updateCompanionCommand(config, runtime) {
  await runtime.fs.mkdir(config.target, { recursive: true });
  const bindingPath = join(config.target, '.clasp.json');
  if (!await runtime.fs.exists(bindingPath)) {
    if (!config.scriptId) {
      throw new Error('Update requires --script-id when the target does not contain .clasp.json.');
    }
    await runtime.fs.writeFile(bindingPath, `${JSON.stringify({ scriptId: config.scriptId, rootDir: '.' }, null, 2)}\n`, 'utf8');
  }
  const existingScriptId = await readScriptId(runtime, config.target);
  if (config.scriptId && config.scriptId !== existingScriptId) {
    throw new Error(`Refusing to update a different script ID. Target is ${existingScriptId}; request was ${config.scriptId}.`);
  }

  await ensureClaspLogin(runtime, config.target);
  const assets = await loadAssets(runtime);
  const stamp = (runtime.now ? runtime.now() : new Date().toISOString()).replace(/[:.]/g, '-');
  const backupDirectory = join(config.target, '.tasks-todo-sync-backups', stamp);
  await runtime.fs.mkdir(backupDirectory, { recursive: true });
  await runtime.fs.writeFile(
    join(backupDirectory, '.clasp.json'),
    `${JSON.stringify({ scriptId: existingScriptId, rootDir: '.' }, null, 2)}\n`,
    'utf8'
  );
  const unknownFiles = await pullRemoteAndListUnmanaged(runtime, backupDirectory);
  if (unknownFiles.length > 0) {
    throw new Error(`Refusing automatic update because the Apps Script project contains unmanaged files: ${unknownFiles.join(', ')}. Back them up and retry explicitly.`);
  }

  await installAssets(runtime, config.target, config.timezone, assets);
  await runClasp(runtime, ['push', '--force'], config.target);
  const previousMarker = await readCompanionMarkerIfPresent(runtime, config.target);
  const deploymentId = config.deploymentId
    || previousMarker?.deploymentId
    || null;
  const deployment = await publishDeployment(runtime, config.target, existingScriptId, deploymentId);
  const marker = await writeCompanionMarker(runtime, config.target, {
    scriptId: existingScriptId,
    deploymentId: deployment.deploymentId,
    versionNumber: deployment.versionNumber,
    installedAt: previousMarker?.installedAt || (runtime.now ? runtime.now() : new Date().toISOString()),
    updatedAt: runtime.now ? runtime.now() : new Date().toISOString(),
    backupDirectory
  });
  emitJson(runtime, { ok: true, action: 'updated', scriptId: existingScriptId, ...deployment, backupDirectory, marker });
  return 0;
}

/* Pulls the remote project into backupDirectory and lists the files the
 * managed set does not own.  Shared by `update` and the `init` handoff
 * adoption path so the gate cannot be patched in one copy while a mutant
 * survives in the other. */
async function pullRemoteAndListUnmanaged(runtime, backupDirectory) {
  await runJsonClasp(runtime, ['pull', '--json', '--force'], backupDirectory);
  const remoteFiles = await runtime.fs.readdir(backupDirectory);
  return remoteFiles.filter((name) => !MANAGED_REMOTE_FILES.has(name));
}

async function statusCommand(config, runtime) {
  const binding = await readBindingIfPresent(runtime, config.target);
  if (!binding) {
    emitJson(runtime, { ok: true, configured: false, target: config.target });
    return 0;
  }
  const marker = await readCompanionMarkerIfPresent(runtime, config.target);
  let deployments = [];
  let deploymentError = null;
  try {
    deployments = await runJsonClasp(runtime, ['list-deployments', '--json'], config.target);
  } catch (error) {
    deploymentError = error.message;
  }
  const deployment = selectDeployment(deployments, config.deploymentId || marker?.deploymentId);
  const cloud = await runCloudFunction(runtime, config.target, 'setupWizardOverview', [], true);
  emitJson(runtime, {
    ok: true,
    configured: true,
    target: config.target,
    scriptId: binding.scriptId,
    deployment,
    deployments,
    deploymentError,
    marker,
    cloudExecutionAvailable: cloud.processOk && !cloud.json.error,
    cloud: cloud.json.response ?? null,
    cloudError: cloud.json.error ?? (cloud.processOk ? null : { message: cloud.stderr || cloud.stdout })
  });
  return 0;
}

async function syncCommand(config, runtime) {
  const binding = await readBindingIfPresent(runtime, config.target);
  if (!binding) throw new Error('No installed Apps Script project was found in the target. Run install first.');
  const cloud = await runCloudFunction(runtime, config.target, 'syncAll', [], true);
  const ok = cloud.processOk && !cloud.json.error;
  emitJson(runtime, {
    ok,
    scriptId: binding.scriptId,
    response: cloud.json.response ?? null,
    error: cloud.json.error ?? (cloud.processOk ? null : { message: cloud.stderr || cloud.stdout }),
    fallback: ok ? null : 'Open the private Apps Script setup page and run SyncAll there if the Apps Script Execution API is unavailable.'
  });
  return ok ? 0 : 1;
}

async function preferencesCommand(config, runtime) {
  const binding = await readBindingIfPresent(runtime, config.target);
  if (!binding) throw new Error('No installed Apps Script project was found in the target. Run install first.');
  const input = {};
  if (config.calendarProjection !== null) input.calendarProjectionEnabled = config.calendarProjection;
  if (config.calendarReminder !== null) input.calendarReminderEnabled = config.calendarReminder;
  if (config.clearAlertEmail) input.alertEmail = '';
  else if (config.alertEmail !== null) input.alertEmail = config.alertEmail;
  if (Object.keys(input).length === 0) throw new Error('No preference change was requested.');
  const cloud = await runCloudFunction(runtime, config.target, 'setupWizardSavePreferences', [input], true);
  const ok = cloud.processOk && !cloud.json.error;
  emitJson(runtime, {
    ok,
    applied: ok ? input : null,
    response: cloud.json.response ?? null,
    error: cloud.json.error ?? (cloud.processOk ? null : { message: cloud.stderr || cloud.stdout })
  });
  return ok ? 0 : 1;
}

async function fingerprintRemoteProject(runtime, managedTarget, scriptId) {
  const detectionRoot = join(managedTarget, '.detection');
  const candidateDirectory = join(detectionRoot, randomUUID());
  await runtime.fs.mkdir(candidateDirectory, { recursive: true });
  try {
    await runtime.fs.writeFile(
      join(candidateDirectory, '.clasp.json'),
      `${JSON.stringify({ scriptId, rootDir: '.' }, null, 2)}\n`,
      'utf8'
    );
    await runJsonClasp(runtime, ['pull', '--json', '--force'], candidateDirectory);
    const files = await runtime.fs.readdir(candidateDirectory);
    const readIfPresent = async (name) => (files.includes(name)
      ? runtime.fs.readFile(join(candidateDirectory, name), 'utf8').catch(() => '')
      : '');
    const code = await readIfPresent('Code.gs');
    const globals = await readIfPresent('globals.gs');
    const setup = await readIfPresent('Setup.html');
    const manifest = await readIfPresent('appsscript.json');
    const signals = [
      files.includes('Code.gs') && /function\s+setupWizardOverview\s*\(/.test(code),
      files.includes('globals.gs') && /TIME_BRIDGE_CALENDAR_SUMMARY\s*=\s*['"]Tasks-ToDo-Sync['"]/.test(globals),
      files.includes('Setup.html') && /personal device|Microsoft|Tasks-ToDo Sync/i.test(setup),
      files.includes('appsscript.json') && /webApp/.test(manifest),
      files.includes('time-bridge.gs'),
      files.includes('providers.gs')
    ].filter(Boolean).length;
    const unknownFiles = files.filter((name) => !MANAGED_REMOTE_FILES.has(name));
    return {
      confidence: signals >= 4 ? 'high' : signals >= 2 ? 'medium' : 'low',
      signals,
      unknownFiles
    };
  } finally {
    await runtime.fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function publishDeployment(runtime, target, scriptId, preferredDeploymentId = null) {
  const deployments = await runJsonClasp(runtime, ['list-deployments', '--json'], target);
  if (!Array.isArray(deployments)) throw new Error('clasp list-deployments did not return an array.');
  let deploymentId = preferredDeploymentId;
  if (!deploymentId && deployments.length > 1) {
    throw new Error('Multiple web app deployments exist. Pass --deployment-id to select the deployment that must be updated.');
  }
  // Without an explicit preferred deployment (fresh install), never redeploy the
  // single auto-created deployment of a new project: GAS rejects or mis-responds
  // to updating the initial HEAD deployment, which surfaced as "clasp
  // create-deployment ... did not return JSON." Create a fresh deployment instead.
  if (deploymentId && !deployments.some((item) => item.deploymentId === deploymentId)) {
    throw new Error(`Deployment ${deploymentId} was not found in Apps Script project ${scriptId}.`);
  }

  const version = await runJsonClasp(
    runtime,
    ['create-version', '--json', `Tasks-ToDo-Sync ${runtime.version}`],
    target
  );
  if (!Number.isInteger(version.versionNumber)) {
    throw new Error('clasp create-version did not return a versionNumber.');
  }
  const args = [
    'create-deployment',
    '--json',
    '--versionNumber',
    String(version.versionNumber),
    '--description',
    'Tasks-ToDo-Sync web app'
  ];
  if (deploymentId) args.push('--deploymentId', deploymentId);
  const deployment = await runJsonClasp(runtime, args, target);
  if (!deployment.deploymentId) throw new Error('clasp create-deployment did not return a deploymentId.');
  return {
    deploymentId: deployment.deploymentId,
    versionNumber: version.versionNumber
  };
}

async function runCloudFunction(runtime, target, functionName, parameters = [], nonDev = true) {
  const args = ['run-function', functionName, '--json'];
  if (nonDev) args.push('--nondev');
  if (parameters.length > 0) args.push('--params', JSON.stringify(parameters));
  const result = await invokeClasp(runtime, args, target, { capture: true });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const json = extractJsonObject(text) || {};
  return {
    processOk: exitCode(result) === 0,
    json,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

async function runJsonClasp(runtime, args, cwd) {
  const result = await invokeClasp(runtime, args, cwd, { capture: true });
  if (exitCode(result) !== 0) {
    throw new Error(`clasp ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  const json = extractJsonObject(result.stdout || '');
  if (json === undefined) {
    const detail = (result.stdout || '').trim() || '(clasp wrote nothing to stdout)';
    const stderrDetail = (result.stderr || '').trim();
    throw new Error(`clasp ${args.join(' ')} did not return JSON. stdout: ${detail.slice(0, 400)}`
      + (stderrDetail ? ` stderr: ${stderrDetail.slice(0, 400)}` : ''));
  }
  return json;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  if (start === -1 && arrayStart === -1) return undefined;
  if (arrayStart !== -1 && (start === -1 || arrayStart < start)) {
    try { return JSON.parse(text.slice(arrayStart, text.lastIndexOf(']') + 1)); } catch { /* fall through */ }
  }
  if (start !== -1) {
    try { return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)); } catch { /* fall through */ }
  }
  return undefined;
}

function selectDeployment(deployments, preferredDeploymentId) {
  if (!Array.isArray(deployments)) return null;
  if (preferredDeploymentId) return deployments.find((item) => item.deploymentId === preferredDeploymentId) || null;
  return deployments.length === 1 ? deployments[0] : null;
}

async function readBindingIfPresent(runtime, target) {
  const bindingPath = join(target, '.clasp.json');
  if (!await runtime.fs.exists(bindingPath)) return null;
  try {
    const binding = JSON.parse(await runtime.fs.readFile(bindingPath, 'utf8'));
    return binding.scriptId ? binding : null;
  } catch {
    return null;
  }
}

async function readCompanionMarkerIfPresent(runtime, target) {
  const markerPath = join(target, COMPANION_MARKER_FILE);
  if (!await runtime.fs.exists(markerPath)) return null;
  try {
    return JSON.parse(await runtime.fs.readFile(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCompanionMarker(runtime, target, values) {
  const marker = {
    schemaVersion: 1,
    tool: 'tasks-todo-sync-companion',
    packageVersion: runtime.version,
    ...values
  };
  await runtime.fs.writeFile(join(target, COMPANION_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return marker;
}

function confidenceRank(confidence) {
  return { high: 3, medium: 2, low: 1 }[confidence] || 0;
}

function emitJson(runtime, payload) {
  say(runtime, JSON.stringify(payload, null, 2));
}

function jsonFailure(message, code = 'CLI_ERROR') {
  return { ok: false, error: { code, message } };
}

export function createNodeRuntime() {
  const require = createRequire(import.meta.url);
  const claspEntrypoint = require.resolve('@google/clasp');

  return {
    cwd: process.cwd(),
    timeZone: localTimeZone(),
    version: readPackageVersion(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (message) => process.stdout.write(`${message}\n`),
    err: (message) => process.stderr.write(`${message}\n`),
    confirm: async (message) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await readline.question(`${message} [y/N] `);
        return /^(?:y|yes)$/i.test(answer.trim());
      } finally {
        readline.close();
      }
    },
    fs: {
      async exists(filename) {
        try {
          await access(filename, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      stat,
      mkdir,
      readFile,
      readdir,
      rm,
      writeFile
    },
    runClasp: (args, { cwd, capture = false }) => runProcess(
      process.execPath,
      [claspEntrypoint, ...args],
      cwd,
      { capture }
    )
  };
}

async function init(config, runtime) {
  const assets = await loadAssets(runtime);
  const initialState = await inspectTarget(runtime, config.target, assets);

  say(runtime, `Target: ${config.target}`);
  say(runtime, `Project title: ${config.title}`);
  say(runtime, `Apps Script time zone: ${config.timezone}`);

  if (config.dryRun) {
    say(runtime, 'Dry run: the target was checked, but no files, project, sign-in, or push will occur.');
  say(runtime, initialState.kind === 'partial' || initialState.kind === 'handoff'
    ? 'The existing Apps Script project would be populated from a safe migration directory and pushed.'
    : 'A new standalone Apps Script project would be created, populated, and pushed.');
    return 0;
  }

  if (!config.yes) {
    if (!runtime.isTTY) {
      throw new Error('Non-interactive use requires --yes (or --non-interactive).');
    }
    const confirmed = await runtime.confirm('Create or resume this Apps Script project?');
    if (!confirmed) {
      say(runtime, 'Cancelled; nothing was changed.');
      return 0;
    }
  }

  let state = initialState;
  if (state.kind === 'new') {
    await runtime.fs.mkdir(config.target, { recursive: true });
    state = { kind: 'empty', scriptId: null, marker: null };
  }
  if (state.kind === 'empty') {
    state.marker = newMarker(runtime);
    await writeMarker(runtime, config.target, state.marker);
  }

  say(runtime, 'Before signing in or creating the project, enable the Apps Script API if needed: https://script.google.com/home/usersettings');
  await ensureClaspLogin(runtime, config.target);

  if (!state.scriptId) {
    say(runtime, 'Creating a standalone Apps Script project…');
    await runClasp(runtime, ['create', '--type', 'standalone', '--title', config.title], config.target);
    state.scriptId = await readScriptId(runtime, config.target);
    state.marker = {
      ...(state.marker || newMarker(runtime)),
      phase: 'created',
      scriptId: state.scriptId
    };
    await writeMarker(runtime, config.target, state.marker);
  }

  say(runtime, 'Installing the checked-in Apps Script files…');
  if (initialState.kind === 'handoff') {
    say(runtime, 'Adopting the existing Apps Script project; checking the remote for unmanaged files…');
    const stamp = (runtime.now ? runtime.now() : new Date().toISOString()).replace(/[:.]/g, '-');
    const adoptionBackupDirectory = join(config.target, '.tasks-todo-sync-backups', `handoff-${stamp}`);
    await runtime.fs.mkdir(adoptionBackupDirectory, { recursive: true });
    const unknownFiles = await pullRemoteAndListUnmanaged(runtime, adoptionBackupDirectory);
    if (unknownFiles.length > 0) {
      throw new Error(`Refusing to adopt the Apps Script project because the remote contains unmanaged files: ${unknownFiles.join(', ')}. `
        + 'clasp push cannot delete remote-only files, so they would survive the adoption and keep breaking the Apps Script compiler; '
        + 'remove them in the Apps Script editor (keep a local copy), then rerun init.');
    }
  }
  await installAssets(runtime, config.target, config.timezone, assets);
  say(runtime, 'Pushing the project…');
  await runClasp(runtime, ['push', '--force'], config.target);

  state.marker = {
    ...(state.marker || newMarker(runtime)),
    phase: 'pushed',
    scriptId: state.scriptId
  };
  await writeMarker(runtime, config.target, state.marker);

  const editorUrl = `https://script.google.com/home/projects/${encodeURIComponent(state.scriptId)}/edit`;
  say(runtime, 'Deployment complete.');
  say(runtime, `Apps Script editor: ${editorUrl}`);
  say(runtime, 'Safe post-deploy functions (run manually in this order as needed):');
  for (const name of POST_DEPLOY_FUNCTIONS) say(runtime, `  - ${name}`);
  say(runtime, 'Personal Microsoft setup requires no Entra application registration.');
  say(runtime, 'Private browser wizard guide: https://github.com/simonchai-tw/tasks-todo-sync/blob/main/docs/quick-start.md');
  return 0;
}

async function loadAssets(runtime) {
  if (runtime.assets) return validateAssets(runtime.assets);
  const gasFiles = Object.fromEntries(await Promise.all(GAS_SOURCE_FILES.map(async (filename) => [
    filename,
    await readFile(join(PACKAGE_ROOT, filename), 'utf8')
  ])));
  return validateAssets({
    gasFiles,
    setup: await readFile(join(PACKAGE_ROOT, 'Setup.html'), 'utf8'),
    manifest: await readFile(join(PACKAGE_ROOT, 'appsscript.json'), 'utf8'),
    claspignore: await readFile(join(PACKAGE_ROOT, 'assets', 'claspignore'), 'utf8'),
    gitignore: await readFile(join(PACKAGE_ROOT, 'assets', 'deploy-gitignore'), 'utf8')
  });
}

function validateAssets(assets) {
  const gasFileNames = assets?.gasFiles && Object.keys(assets.gasFiles);
  if (!assets || !gasFileNames
    || gasFileNames.length !== GAS_SOURCE_FILES.length
    || !GAS_SOURCE_FILES.every((name) => typeof assets.gasFiles[name] === 'string')
    || !gasFileNames.every((name) => GAS_SOURCE_FILES.includes(name))
    || typeof assets.setup !== 'string'
    || typeof assets.manifest !== 'string'
    || typeof assets.claspignore !== 'string' || typeof assets.gitignore !== 'string') {
    throw new Error('The packaged Apps Script assets are incomplete. Reinstall tasks-todo-sync.');
  }
  try {
    JSON.parse(assets.manifest);
  } catch {
    throw new Error('The packaged appsscript.json is invalid. Reinstall tasks-todo-sync.');
  }
  return assets;
}

async function inspectTarget(runtime, target, assets) {
  if (!await runtime.fs.exists(target)) {
    return { kind: 'new', scriptId: null, marker: null };
  }
  const targetStats = await runtime.fs.stat(target);
  if (!targetStats.isDirectory()) {
    throw new Error(`Refusing target ${target}: it is not a directory.`);
  }
  const names = await runtime.fs.readdir(target);
  if (names.length === 0) {
    return { kind: 'empty', scriptId: null, marker: null };
  }

  if (names.length === 1 && names[0] === '.clasp.json') {
    return { kind: 'handoff', scriptId: await readScriptId(runtime, target), marker: null };
  }

  if (!names.includes(MARKER_FILE) && names.includes('.clasp.json') && names.includes('Code.gs')) {
    throw new Error(`Refusing in-place upgrade of an existing single-file deployment at ${target}. `
      + 'Create a new empty directory, copy only .clasp.json into it, then rerun init with --target pointing to that directory. '
      + 'This keeps the same Apps Script project and its remote properties/state. Keep the old directory as a backup until healthCheck() and dryRunReport() pass.');
  }

  const unexpected = names.filter((name) => !SAFE_PARTIAL_FILES.has(name));
  if (unexpected.length > 0 || !names.includes(MARKER_FILE)) {
    throw new Error(`Refusing non-empty target ${target}. Use an empty directory; only a safe CLI-created partial deployment may be resumed.`);
  }

  const marker = await readMarker(runtime, target);
  if (marker.phase === 'pushed' && names.includes('Code.js')) {
    throw new Error(`Refusing target ${target}: unexpected clasp starter file remains after a completed push.`);
  }
  const requireInstalledAssets = marker.phase === 'pushed';
  if (requireInstalledAssets) {
    const missing = GAS_SOURCE_FILES.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      throw new Error(`Refusing target ${target}: packaged safe partial state is missing ${missing.join(', ')}.`);
    }
  }
  for (const name of [...GAS_SOURCE_FILES, 'Setup.html', '.claspignore', '.gitignore']) {
    if (names.includes(name)) {
      const expected = GAS_SOURCE_FILES.includes(name)
        ? assets.gasFiles[name]
        : (name === 'Setup.html' ? assets.setup
        : (name === '.claspignore' ? assets.claspignore : assets.gitignore));
      const actual = await runtime.fs.readFile(join(target, name), 'utf8');
      if (requireInstalledAssets && actual !== expected) {
        throw new Error(`Refusing target ${target}: ${name} differs from the packaged safe partial state.`);
      }
    }
  }
  if (names.includes('appsscript.json')) {
    const actual = await runtime.fs.readFile(join(target, 'appsscript.json'), 'utf8');
    if (requireInstalledAssets && !isCompatibleManifest(actual, assets.manifest)) {
      throw new Error(`Refusing target ${target}: appsscript.json differs from the packaged safe partial state.`);
    }
  }

  const scriptId = names.includes('.clasp.json') ? await readScriptId(runtime, target) : null;
  if (marker.scriptId && marker.scriptId !== scriptId) {
    throw new Error(`Refusing target ${target}: its clasp project does not match the safe partial-state marker.`);
  }
  if (marker.phase !== 'prepared' && !scriptId) {
    throw new Error(`Refusing target ${target}: its safe partial-state marker is incomplete.`);
  }
  return { kind: 'partial', scriptId, marker };
}

function isCompatibleManifest(candidateText, sourceText) {
  try {
    const candidate = JSON.parse(candidateText);
    const source = JSON.parse(sourceText);
    const candidateTimeZone = candidate.timeZone;
    delete candidate.timeZone;
    delete source.timeZone;
    canonicalTimeZone(candidateTimeZone);
    return JSON.stringify(candidate) === JSON.stringify(source);
  } catch {
    return false;
  }
}

function newMarker(runtime) {
  return {
    schemaVersion: 1,
    tool: 'tasks-todo-sync',
    phase: 'prepared',
    scriptId: null,
    createdAt: runtime.now ? runtime.now() : new Date().toISOString()
  };
}

async function readMarker(runtime, target) {
  let marker;
  try {
    marker = JSON.parse(await runtime.fs.readFile(join(target, MARKER_FILE), 'utf8'));
  } catch {
    throw new Error(`Refusing target ${target}: its partial-state marker is invalid.`);
  }
  const valid = marker
    && marker.schemaVersion === 1
    && marker.tool === 'tasks-todo-sync'
    && MARKER_PHASES.has(marker.phase)
    && (marker.scriptId === null || (typeof marker.scriptId === 'string' && marker.scriptId.length > 0))
    && typeof marker.createdAt === 'string'
    && Object.keys(marker).every((key) => ['schemaVersion', 'tool', 'phase', 'scriptId', 'createdAt'].includes(key));
  if (!valid) {
    throw new Error(`Refusing target ${target}: its partial-state marker is not a safe CLI-created state.`);
  }
  return marker;
}

async function writeMarker(runtime, target, marker) {
  await runtime.fs.writeFile(join(target, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

async function readScriptId(runtime, target) {
  let clasp;
  try {
    clasp = JSON.parse(await runtime.fs.readFile(join(target, '.clasp.json'), 'utf8'));
  } catch {
    throw new Error(`clasp did not create a readable .clasp.json in ${target}.`);
  }
  if (typeof clasp.scriptId !== 'string' || !clasp.scriptId.trim()) {
    throw new Error(`clasp did not return a script ID in ${target}.`);
  }
  if ((clasp.rootDir && clasp.rootDir !== '.') || clasp.srcDir || clasp.allowSymlinks === true) {
    throw new Error(`Refusing ${target}: .clasp.json is not scoped to the target directory.`);
  }
  return clasp.scriptId;
}

async function installAssets(runtime, target, timezone, assets) {
  const manifest = withTimeZone(assets.manifest, timezone);
  for (const name of GAS_SOURCE_FILES) {
    await runtime.fs.writeFile(join(target, name), assets.gasFiles[name], 'utf8');
  }
  await runtime.fs.writeFile(join(target, 'Setup.html'), assets.setup, 'utf8');
  await runtime.fs.writeFile(join(target, 'appsscript.json'), manifest, 'utf8');
  await runtime.fs.writeFile(join(target, '.claspignore'), assets.claspignore, 'utf8');
  await runtime.fs.writeFile(join(target, '.gitignore'), assets.gitignore, 'utf8');
  await removeClaspStarterFile(runtime, target);
}

async function removeClaspStarterFile(runtime, target) {
  const starter = join(target, 'Code.js');
  if (!await runtime.fs.exists(starter)) return;
  const starterStats = await runtime.fs.stat(starter);
  if (starterStats.isDirectory()) {
    throw new Error(`Refusing ${target}: clasp starter path Code.js is a directory.`);
  }
  await runtime.fs.rm(starter);
}

function withTimeZone(manifestText, timezone) {
  const manifest = JSON.parse(manifestText);
  if (!Object.prototype.hasOwnProperty.call(manifest, 'timeZone')) {
    throw new Error('The packaged appsscript.json does not contain a timeZone field.');
  }
  manifest.timeZone = canonicalTimeZone(timezone);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function ensureClaspLogin(runtime, target) {
  const status = await invokeClasp(runtime, ['show-authorized-user', '--json'], target, { capture: true });
  if (exitCode(status) !== 0) {
    throw new Error('Unable to determine clasp login state. Resolve your clasp login and run init again.');
  }
  let loggedIn;
  try {
    loggedIn = JSON.parse(status.stdout).loggedIn;
  } catch {
    throw new Error('clasp returned an invalid authorization-status response.');
  }
  if (loggedIn === true) {
    say(runtime, 'Using the existing clasp login.');
    return;
  }
  if (loggedIn !== false) {
    throw new Error('clasp authorization status did not contain a loggedIn boolean.');
  }
  say(runtime, 'No clasp login was found; starting the clasp sign-in flow…');
  await runClasp(runtime, ['login'], target);
}

async function runClasp(runtime, args, cwd) {
  const result = await invokeClasp(runtime, args, cwd);
  if (exitCode(result) !== 0) {
    throw new Error(`clasp ${args.join(' ')} failed with exit code ${exitCode(result)}.`);
  }
  return result;
}

function invokeClasp(runtime, args, cwd, { capture = false } = {}) {
  // clasp 3.4.0 rejects a missing --project file but accepts its containing
  // directory, resolving only that directory's .clasp.json without walking up.
  return runtime.runClasp(['--project', resolve(cwd), ...args], { cwd, capture });
}

function exitCode(result) {
  if (!result || typeof result !== 'object') return 0;
  return result.exitCode ?? result.code ?? 0;
}

function runProcess(command, args, cwd, { capture = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    if (capture) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({
      code: code ?? 1,
      stdout: capture ? Buffer.concat(stdout).toString('utf8') : undefined,
      stderr: capture ? Buffer.concat(stderr).toString('utf8') : undefined
    }));
  });
}

function readPackageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

function say(runtime, message) {
  runtime.out(message);
}

function sayError(runtime, message) {
  runtime.err(message);
}
