import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER_FILE = '.tasks-todo-sync-init.json';
const SAFE_PARTIAL_FILES = new Set([
  MARKER_FILE,
  '.clasp.json',
  '.gitignore',
  'Code.js',
  'Code.gs',
  'appsscript.json',
  '.claspignore'
]);
const MARKER_PHASES = new Set(['prepared', 'created', 'pushed']);

export const POST_DEPLOY_FUNCTIONS = [
  'initializeSafeDefaults',
  'setupStatus',
  'showRedirectUri',
  'startAuthorization',
  'dryRunReport',
  'syncAll',
  'createTrigger',
  'healthCheck'
];

export const HELP_TEXT = `Tasks-ToDo Sync Apps Script installer

Usage:
  tasks-todo-sync init [options]

Options:
  --target <directory>  Installation directory (default: tasks-todo-sync-app)
  --title <title>       Apps Script project title (default: Tasks-ToDo Sync)
  --timezone <IANA>     Apps Script time zone (default: this computer's IANA zone)
  --yes                 Continue without a confirmation prompt
  --non-interactive     Alias for --yes; suitable for scripted use
  --dry-run             Show the safe deployment plan without changing anything
  --help, -h            Show this help
  --version, -v         Show the package version

Microsoft client IDs and secrets are intentionally not accepted by this CLI.
Add credentials manually in Apps Script only after reviewing the project.`;

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

export function parseArgs(argv, { cwd = process.cwd(), timeZone = localTimeZone(), version = '0.1.0' } = {}) {
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
    title: 'Tasks-ToDo Sync',
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

export async function main(argv, runtime = createNodeRuntime()) {
  try {
    const parsed = parseArgs(argv, {
      cwd: runtime.cwd,
      timeZone: runtime.timeZone,
      version: runtime.version
    });
    if (parsed.command === 'help' || parsed.command === 'version') {
      say(runtime, parsed.text);
      return 0;
    }
    return await init(parsed, runtime);
  } catch (error) {
    sayError(runtime, `Error: ${error.message}`);
    return 1;
  }
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
    say(runtime, initialState.kind === 'partial'
      ? 'A safe CLI-created partial deployment would be resumed.'
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
  say(runtime, 'The CLI did not accept, write, or print any Microsoft client ID or secret.');
  return 0;
}

async function loadAssets(runtime) {
  if (runtime.assets) return validateAssets(runtime.assets);
  return validateAssets({
    code: await readFile(join(PACKAGE_ROOT, 'Code.gs'), 'utf8'),
    manifest: await readFile(join(PACKAGE_ROOT, 'appsscript.json'), 'utf8'),
    claspignore: await readFile(join(PACKAGE_ROOT, 'assets', 'claspignore'), 'utf8'),
    gitignore: await readFile(join(PACKAGE_ROOT, 'assets', 'deploy-gitignore'), 'utf8')
  });
}

function validateAssets(assets) {
  if (!assets || typeof assets.code !== 'string' || typeof assets.manifest !== 'string'
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

  const unexpected = names.filter((name) => !SAFE_PARTIAL_FILES.has(name));
  if (unexpected.length > 0 || !names.includes(MARKER_FILE)) {
    throw new Error(`Refusing non-empty target ${target}. Use an empty directory; only a safe CLI-created partial deployment may be resumed.`);
  }

  const marker = await readMarker(runtime, target);
  if (marker.phase === 'pushed' && names.includes('Code.js')) {
    throw new Error(`Refusing target ${target}: unexpected clasp starter file remains after a completed push.`);
  }
  const requireInstalledAssets = marker.phase === 'pushed';
  for (const name of ['Code.gs', '.claspignore', '.gitignore']) {
    if (names.includes(name)) {
      const expected = name === 'Code.gs'
        ? assets.code
        : (name === '.claspignore' ? assets.claspignore : assets.gitignore);
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
  await runtime.fs.writeFile(join(target, 'Code.gs'), assets.code, 'utf8');
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
  const original = JSON.stringify(manifest.timeZone);
  const replacement = JSON.stringify(canonicalTimeZone(timezone));
  const output = manifestText.replace(`"timeZone":${original}`, `"timeZone":${replacement}`);
  if (output === manifestText && original !== replacement) {
    throw new Error('The packaged appsscript.json does not contain a replaceable timeZone field.');
  }
  return output;
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
