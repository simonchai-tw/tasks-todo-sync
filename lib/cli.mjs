import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { GAS_SOURCE_FILES, managedGasSourceName } from './gas-files.mjs';
import { callWebAppAction } from './web-app-client.mjs';

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

export const HELP_TEXT = `Tasks-ToDo-Sync Apps Script installer

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
  // Fingerprint EVERY script this account can see, not only the ones whose
  // title matches. Renaming a project in the Apps Script editor (a trailing
  // " (2)", a stray space, a deliberate rebrand) is ordinary use, and dropping
  // the renamed ones before the fingerprint ran meant detect reported an empty
  // Drive for an account that had a perfectly good project in it -- which the
  // state machine reads as permission to create a second one (P0-2).
  //
  // The title is now a ranking hint, not a filter: a name match still sorts
  // first so the common case reports the same candidate it always did, but a
  // project can only be recognised by its contents.
  const visible = scripts.filter((item) => item && item.id);
  const candidates = [];
  for (const item of visible) {
    const fingerprint = await fingerprintRemoteProject(runtime, config.target, item.id);
    candidates.push({
      scriptId: item.id,
      name: item.name,
      nameMatchesTitle: item.name === config.title,
      confidence: fingerprint.confidence,
      signals: fingerprint.signals,
      unknownFiles: fingerprint.unknownFiles
    });
  }
  candidates.sort((a, b) =>
    (Number(b.nameMatchesTitle) - Number(a.nameMatchesTitle))
    || (confidenceRank(b.confidence) - confidenceRank(a.confidence)));
  const high = candidates.filter((item) => item.confidence === 'high');
  // What "there is already a project here" means, stated once so the gate does
  // not have to re-derive it. 'low' is 0-1 of the six fingerprint signals, i.e.
  // the files do not look like this app at all -- an unrelated project must not
  // permanently block a first install, it just is not a candidate for adoption.
  // The app's own gate reads this list (CloudState.AdoptableCandidateIds).
  const adoptable = candidates.filter((item) => item.confidence === 'high' || item.confidence === 'medium');
  emitJson(runtime, {
    ok: true,
    installed: high.length === 1,
    ambiguous: high.length > 1,
    recommendedScriptId: high.length === 1 ? high[0].scriptId : null,
    visibleProjectCount: visible.length,
    adoptableScriptIds: adoptable.map((item) => item.scriptId),
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
  // A brand new project has never executed, so Apps Script has no property
  // store and the first cloud call can fail while Google provisions it
  // (observed on the rc.5 first-run install, 2026-10-05). Pay the one
  // execution here instead of letting the user's first button press hit it.
  // Never fatal: a failure here is reported as a warning, and a network
  // failure must not discard a successful install.
  const warmup = await runCloudFunction(runtime, config.target, 'setupWizardOverview', [], true);
  const provisioned = warmup.processOk && !warmup.json.error;
  if (!provisioned) {
    emitJson(runtime, {
      ok: false,
      warning: 'The Apps Script project was installed and deployed, but Google has not activated its runtime yet. The dashboard will finish activation on first use; no action is required.',
      scriptId,
      ...deployment,
      marker
    });
    return 0;
  }
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
  const backupDirectory = backupStampDirectory(config, stamp);
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
 * survives in the other.
 *
 * clasp reports server files as .js, so the pulled names are normalized onto
 * their canonical .gs names first. Without this every managed source looked
 * unmanaged and `update` refused to run against its own project. */
async function pullRemoteAndListUnmanaged(runtime, backupDirectory) {
  await runJsonClasp(runtime, ['pull', '--json', '--force'], backupDirectory);
  const remoteFiles = await runtime.fs.readdir(backupDirectory);
  return remoteFiles
    .map((name) => managedGasSourceName(name) || name)
    .filter((name) => !MANAGED_REMOTE_FILES.has(name));
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
    // clasp returns server files as .js; the managed set is .gs. Map every
    // pulled name onto its canonical .gs name so the fingerprint below (and
    // the unmanaged-file gate) compare like with like.
    const files = await runtime.fs.readdir(candidateDirectory);
    const canonicalName = new Map();
    for (const name of files) canonicalName.set(name, managedGasSourceName(name) || name);
    const readIfPresent = async (...candidates) => {
      for (const candidate of candidates) {
        const actual = files.includes(candidate) ? candidate
          : files.find((name) => canonicalName.get(name) === candidate);
        if (actual) {
          const content = await runtime.fs.readFile(join(candidateDirectory, actual), 'utf8').catch(() => '');
          if (content) return content;
        }
      }
      return '';
    };
    const has = (canonical) => files.some((name) => canonicalName.get(name) === canonical);
    const code = await readIfPresent('Code.gs', 'Code.js');
    const globals = await readIfPresent('globals.gs', 'globals.js');
    const setup = await readIfPresent('Setup.html');
    const manifest = await readIfPresent('appsscript.json');
    const signals = [
      has('Code.gs') && /function\s+setupWizardOverview\s*\(/.test(code),
      has('globals.gs') && /TIME_BRIDGE_CALENDAR_SUMMARY\s*=\s*['"]Tasks-ToDo-Sync['"]/.test(globals),
      has('Setup.html') && /personal device|Microsoft|Tasks-ToDo-Sync/i.test(setup),
      has('appsscript.json') && /webApp/.test(manifest),
      has('time-bridge.gs'),
      has('providers.gs')
    ].filter(Boolean).length;
    // An unmanaged file is one whose canonical name is not part of the managed
    // set. Comparing the raw pulled name here reported every .gs file as
    // unknown, which is what made an installed project look unrecognised.
    const unknownFiles = files
      .map((name) => canonicalName.get(name))
      .filter((name) => !MANAGED_REMOTE_FILES.has(name));
    return {
      confidence: signals >= 4 ? 'high' : signals >= 2 ? 'medium' : 'low',
      signals,
      unknownFiles
    };
  } finally {
    await runtime.fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export { fingerprintRemoteProject };

const WEB_APP_DESCRIPTION = 'Tasks-ToDo-Sync web app';

/* Picks one deployment when no --deployment-id was given and the project has
 * several. Never returns the unversioned HEAD deployment: publishing to HEAD is
 * exactly what produced "clasp create-deployment ... did not return JSON."
 */
function resolveAmbiguousDeploymentId(deployments, scriptId) {
  const ours = deployments.filter(
    (item) => item && item.deploymentId && item.description === WEB_APP_DESCRIPTION
  );
  const pool = ours.length > 0
    ? ours
    : deployments.filter((item) => item && item.deploymentId && Number.isInteger(item.versionNumber));
  if (pool.length === 0) {
    throw new Error(`Multiple web app deployments exist in Apps Script project ${scriptId} and none of them can be identified as a Tasks-ToDo-Sync deployment. Pass --deployment-id to select the deployment that must be updated.`);
  }
  return pool.slice().sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0))[0].deploymentId;
}

async function publishDeployment(runtime, target, scriptId, preferredDeploymentId = null) {
  const deployments = await runJsonClasp(runtime, ['list-deployments', '--json'], target);
  if (!Array.isArray(deployments)) throw new Error('clasp list-deployments did not return an array.');
  let deploymentId = preferredDeploymentId;
  if (!deploymentId && deployments.length > 1) {
    // This used to throw unconditionally, which deadlocked every install after
    // the first one: a fresh install creates a SECOND deployment beside the
    // project's auto-created HEAD (see the note below), so from then on every
    // run arrived here with two deployments and no preferred id, and the whole
    // setup reported "could not connect to the existing project". Measured
    // 2026-10-06 on 1o-hO0EoczMiFYGeDCLw1XAYxFiQff05lwvpWY85_sYJExH-fQc4wlNfS:
    // one unversioned HEAD plus one carrying WEB_APP_DESCRIPTION. Resolve the
    // ambiguity here instead of refusing to connect.
    deploymentId = resolveAmbiguousDeploymentId(deployments, scriptId);
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
    WEB_APP_DESCRIPTION
  ];
  if (deploymentId) args.push('--deploymentId', deploymentId);
  const deployment = await runJsonClasp(runtime, args, target);
  if (!deployment.deploymentId) throw new Error('clasp create-deployment did not return a deploymentId.');
  return {
    deploymentId: deployment.deploymentId,
    versionNumber: version.versionNumber
  };
}

/* The companion's cloud calls go over the deployed web app's JSON API
 * (Code.gs doGet/doPost). scripts.run was retired on 2026-10-07: it requires
 * an API-executable entry point plus a shared standard Cloud project, neither
 * of which this product's deployments ever have, and `clasp run-function`
 * answered with a misleading "reading from storage ... NOT_FOUND" on every
 * project we tried, including a freshly created minimal one, while the same
 * project executed fine through the web app URL. */

const defaultWebAppCall = (call) => callWebAppAction(call);

async function runCloudFunction(runtime, target, functionName, parameters = [], nonDev = true) {
  /* Keeps the shape clasp's `run-function --json` used to print --
   * { response: <script return> } on success, { error: { code, message } } on
   * failure -- so every caller keeps parsing it unchanged. */
  const marker = await readCompanionMarkerIfPresent(runtime, target);
  if (!marker?.deploymentId) {
    return {
      processOk: false,
      json: { error: { code: 'NO_DEPLOYMENT', message: 'No deployment id is known for this target; reinstall to connect.' } },
      stdout: '',
      stderr: 'No deployment id is known for this target; reinstall to connect.'
    };
  }
  const transport = runtime.webAppCall ?? defaultWebAppCall;
  const outcome = await transport({
    deploymentId: marker.deploymentId,
    action: functionName,
    params: parameters,
    dev: !nonDev
  });
  if (outcome && outcome.ok) {
    return {
      processOk: true,
      json: { response: outcome.result ?? null },
      stdout: outcome.rawText || '',
      stderr: ''
    };
  }
  const error = (outcome && outcome.error) || { code: 'TRANSPORT_ERROR', message: 'The web app call failed.' };
  return {
    processOk: false,
    json: { error },
    stdout: (outcome && outcome.rawText) || '',
    stderr: error.message || ''
  };
}

export { runCloudFunction };

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
      rename,
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
    const adoptionBackupDirectory = backupStampDirectory(config, `handoff-${stamp}`);
    await runtime.fs.mkdir(adoptionBackupDirectory, { recursive: true });
    // clasp resolves the project from .clasp.json in the directory it is given.
    // This path created the directory but never wrote that file, so every
    // adoption failed with "Project settings not found" -- measured 2026-10-06
    // on a real install, after detection had already found the project and
    // decided to adopt it. The update path above writes it; this one did not.
    await runtime.fs.writeFile(
      join(adoptionBackupDirectory, '.clasp.json'),
      `${JSON.stringify({ scriptId: state.scriptId, rootDir: '.' }, null, 2)}\n`,
      'utf8'
    );
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

/* Backups live BESIDE the target, never inside it.
 *
 * The target is the directory the engine inspects to decide what kind of
 * install it is, and an adoption is recognised by the target holding exactly
 * one entry: .clasp.json (inspectTarget below). A backup tree written inside
 * the target made that check fail for every machine that had ever run an
 * update, so the engine refused with "Refusing non-empty target" and adoption
 * became impossible (2026-10-06, rc.8: the user's own project could not be
 * adopted after a single update).
 *
 * One level up is also where the desktop companion already keeps its own
 * backups directory, so nothing new appears next to the user's data.
 */
function backupRoot(config) {
  return join(dirname(config.target), '.tasks-todo-sync-backups');
}

function backupStampDirectory(config, stamp) {
  return join(backupRoot(config), stamp);
}

const LEGACY_BACKUP_DIR = '.tasks-todo-sync-backups';

/* Moves a backup tree written inside the target by an older release to the
 * sibling location backups now use. Never overwrites: an existing destination
 * is given a numeric suffix, because both trees are the user's only rollback
 * path and losing one to gain the other is not a trade worth making.
 */
async function migrateLegacyBackups(runtime, target) {
  const legacy = join(target, LEGACY_BACKUP_DIR);
  if (!await runtime.fs.exists(legacy)) return;

  const root = join(dirname(target), LEGACY_BACKUP_DIR);
  let destination = root;
  let suffix = 1;
  while (await runtime.fs.exists(destination)) {
    destination = `${root}.${suffix}`;
    suffix++;
  }
  if (destination === legacy) return;

  try {
    await runtime.fs.rename(legacy, destination);
    say(runtime, `Moved existing update backups to ${destination}.`);
  } catch (error) {
    // Deliberately not fatal: the shape checks report the real problem with an
    // actionable message, which beats dying here with "EEXIST".
    say(runtime, `Could not move the update backups at ${legacy} (${error.message}); continuing.`);
  }
}

async function inspectTarget(runtime, target, assets) {
  if (!await runtime.fs.exists(target)) {
    return { kind: 'new', scriptId: null, marker: null };
  }
  const targetStats = await runtime.fs.stat(target);
  if (!targetStats.isDirectory()) {
    throw new Error(`Refusing target ${target}: it is not a directory.`);
  }
  // Releases up to 0.9.5-rc.8 wrote backups INSIDE the target. Relocating them
  // here keeps every already-updated machine adoptable without the caller (the
  // desktop companion) having to know this ever happened. A failure to move is
  // not fatal on its own: the shape checks below still run and will refuse the
  // target with the engine's own actionable message. This runs BEFORE the
  // directory is listed, so there is exactly one listing of the target shape.
  await migrateLegacyBackups(runtime, target);
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
