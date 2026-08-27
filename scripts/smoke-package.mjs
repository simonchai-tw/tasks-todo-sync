import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const requiredFiles = [
  'package.json',
  'bin/tasks-todo-sync.mjs',
  'lib/cli.mjs',
  'assets/claspignore',
  'assets/deploy-gitignore',
  'Code.gs',
  'appsscript.json'
];
const forbiddenPath = /(^|[\\/])(?:\.clasp(?:rc)?(?:\.json)?|\.env(?:\.|$)|[^\\/]*(?:secret|state)[^\\/]*)(?:$|[\\/])/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, cwd) {
  const options = {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  };
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const quote = (value) => `"${String(value).replace(/(["^&|<>])/g, '^$1')}"`;
    const commandLine = [command, ...args].map(quote).join(' ');
    return execFileSync(process.env.ComSpec || 'cmd.exe', [
      '/d', '/s', '/c', `"${commandLine}"`
    ], { ...options, windowsVerbatimArguments: true });
  }
  return execFileSync(command, args, options);
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return run(process.execPath, [npmExecPath, ...args], cwd);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}

function runPackageBinary(binary, args, cwd) {
  return run(binary, args, cwd);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tasks-todo-sync-package-'));
const installRoot = join(tempRoot, 'install');
mkdirSync(installRoot);

try {
  const packOutput = runNpm(['pack', '--json', '--pack-destination', tempRoot], root);
  const packed = JSON.parse(packOutput);
  assert(Array.isArray(packed) && packed.length === 1, 'npm pack did not return one package record');
  const record = packed[0];
  assert(record.name === packageJson.name && record.version === packageJson.version,
    'packed package metadata does not match package.json');
  assert(typeof record.filename === 'string' && record.filename.endsWith('.tgz'),
    'npm pack did not return a tarball filename');
  const tarball = join(tempRoot, record.filename);
  assert(existsSync(tarball), `npm pack did not create ${record.filename}`);

  const packedFiles = (record.files || []).map((entry) => entry.path);
  for (const filename of requiredFiles) {
    assert(packedFiles.includes(filename), `tarball omitted required file: ${filename}`);
  }
  const forbidden = packedFiles.filter((filename) => forbiddenPath.test(filename));
  assert(forbidden.length === 0, `tarball includes forbidden local state: ${forbidden.join(', ')}`);

  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], installRoot);
  const installedRoot = join(installRoot, 'node_modules', packageJson.name);
  for (const filename of requiredFiles) {
    assert(existsSync(join(installedRoot, filename)), `installed package omitted ${filename}`);
  }
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'appsscript.json'), 'utf8'));
  assert(installedManifest.timeZone === 'Asia/Taipei', 'packaged manifest has an unexpected default time zone');
  assert(readFileSync(join(installedRoot, 'Code.gs'), 'utf8').includes('function syncAll'),
    'packaged Code.gs is not the sync engine');

  const installedCli = await import(pathToFileURL(join(installedRoot, 'lib', 'cli.mjs')).href);
  assert(installedCli.createNodeRuntime().version === packageJson.version,
    'installed CLI runtime version does not match package.json');

  const binaryName = process.platform === 'win32' ? 'tasks-todo-sync.cmd' : 'tasks-todo-sync';
  const installedShorthand = join(installRoot, 'node_modules', '.bin', binaryName);
  assert(existsSync(installedShorthand), `installed package binary is missing: ${binaryName}`);
  const binary = join(installedRoot, packageJson.bin['tasks-todo-sync']);
  assert(existsSync(binary), 'package bin target is missing from the installed package');
  const runBinary = (args) => runPackageBinary(installedShorthand, args, installRoot);
  const versionOutput = runBinary(['--version']).trim();
  assert(versionOutput === packageJson.version, 'installed package binary returned the wrong version');

  const smokeTarget = join(installRoot, 'dry-run-target');
  const dryRunOutput = runBinary([
    'init', '--dry-run', '--timezone', 'America/New_York', '--target', smokeTarget
  ], installRoot);
  assert(dryRunOutput.includes('Dry run'), 'installed package binary did not complete init --dry-run');
  assert(dryRunOutput.includes('America/New_York'), 'installed package binary did not exercise non-default time zone');
  assert(!existsSync(smokeTarget), 'init --dry-run unexpectedly created its target directory');

  console.log(`Packed smoke passed (${record.filename}); verified ${requiredFiles.length} release files.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
