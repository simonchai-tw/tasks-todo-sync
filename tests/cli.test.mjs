import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import test from 'node:test';
import { createNodeRuntime, main } from '../lib/cli.mjs';

const ASSETS = {
  code: 'function syncAll() {}\n',
  manifest: '{"timeZone":"Asia/Taipei","runtimeVersion":"V8"}',
  claspignore: '**/**\n!Code.gs\n!appsscript.json\n',
  gitignore: '.clasp.json\n.clasprc.json\n.tasks-todo-sync-init.json\nCode.js\n.env\n.env.*\n*.secret.json\n*sync-state*.json\n*state-export*.json\n'
};

function createFakeRuntime({ cwd = resolve('cli-test-workspace'), files = {}, onClasp } = {}) {
  const directories = new Set([cwd]);
  const fileMap = new Map();
  const output = [];
  const errors = [];
  const calls = [];
  const normal = (filename) => resolve(filename);
  const addDirectory = (directory) => {
    let current = normal(directory);
    const missing = [];
    while (!directories.has(current)) {
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const item of missing.reverse()) directories.add(item);
  };
  for (const [filename, contents] of Object.entries(files)) {
    const path = normal(filename);
    addDirectory(dirname(path));
    fileMap.set(path, contents);
  }

  const runtime = {
    cwd,
    timeZone: 'Asia/Taipei',
    version: '0.1.0-rc.7',
    isTTY: false,
    assets: ASSETS,
    now: () => '2026-08-25T00:00:00.000Z',
    out: (message) => output.push(message),
    err: (message) => errors.push(message),
    fs: {
      async exists(filename) {
        const path = normal(filename);
        return directories.has(path) || fileMap.has(path);
      },
      async stat(filename) {
        const path = normal(filename);
        if (directories.has(path)) return { isDirectory: () => true };
        if (fileMap.has(path)) return { isDirectory: () => false };
        throw new Error(`ENOENT: ${path}`);
      },
      async mkdir(filename) {
        addDirectory(filename);
      },
      async readdir(filename) {
        const directory = normal(filename);
        if (!directories.has(directory)) throw new Error(`ENOENT: ${directory}`);
        const entries = new Set();
        for (const path of [...directories, ...fileMap.keys()]) {
          if (dirname(path) === directory) entries.add(path.slice(directory.length + 1));
        }
        return [...entries];
      },
      async rm(filename) {
        const path = normal(filename);
        if (!fileMap.delete(path)) throw new Error(`ENOENT: ${path}`);
      },
      async readFile(filename) {
        const path = normal(filename);
        if (!fileMap.has(path)) throw new Error(`ENOENT: ${path}`);
        return fileMap.get(path);
      },
      async writeFile(filename, contents) {
        const path = normal(filename);
        if (!directories.has(dirname(path))) throw new Error(`ENOENT parent: ${dirname(path)}`);
        fileMap.set(path, contents);
      }
    },
    runClasp: async (args, options) => {
      calls.push({ args, options });
      const commandArgs = args[0] === '--project' ? args.slice(2) : args;
      if (onClasp) return onClasp({ args: commandArgs, scopedArgs: args, options, fileMap, normal });
      if (commandArgs[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      return { code: 0 };
    }
  };
  return { runtime, fileMap, output, errors, calls, normal };
}

test('node runtime resolves the installed clasp entry point without a network or login call', () => {
  const runtime = createNodeRuntime();

  assert.equal(typeof runtime.runClasp, 'function');
  assert.equal(runtime.version, '0.1.0-rc.7');
});

test('init --dry-run validates its plan without writing files or invoking clasp', async () => {
  const fake = createFakeRuntime();

  const exitCode = await main(['init', '--dry-run'], fake.runtime);

  assert.equal(exitCode, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.fileMap.size, 0);
  assert.match(fake.output.join('\n'), /Dry run/);
});

test('init pins every clasp invocation to its own target instead of inheriting an ancestor project', async () => {
  const cwd = resolve('cli-test-ancestor');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(cwd, 'ancestor', '.clasp.json')]: JSON.stringify({ scriptId: 'unrelated-ancestor-project' })
    },
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'create') {
        fileMap.set(normal(join(options.cwd, '.clasp.json')), JSON.stringify({ scriptId: 'script-id-123' }));
      }
      return { code: 0 };
    }
  });

  const exitCode = await main([
    'init',
    '--yes',
    '--target', join('ancestor', 'safe-target'),
    '--timezone', 'America/New_York'
  ], fake.runtime);

  const target = fake.normal(join(fake.runtime.cwd, 'ancestor', 'safe-target'));
  assert.equal(exitCode, 0);
  assert.deepEqual(fake.calls.map(({ args }) => args.slice(2, 4)), [
    ['show-authorized-user', '--json'],
    ['create', '--type'],
    ['push', '--force']
  ]);
  assert.ok(fake.calls.every(({ args }) => args[0] === '--project' && args[1] === target));
  assert.equal(fake.calls[0].options.capture, true);
  assert.equal(fake.fileMap.get(join(target, 'Code.gs')), ASSETS.code);
  assert.equal(fake.fileMap.get(join(target, '.claspignore')), ASSETS.claspignore);
  assert.equal(fake.fileMap.get(join(target, '.gitignore')), ASSETS.gitignore);
  assert.equal(JSON.parse(fake.fileMap.get(join(target, 'appsscript.json'))).timeZone, 'America/New_York');
  const marker = JSON.parse(fake.fileMap.get(join(target, '.tasks-todo-sync-init.json')));
  assert.deepEqual(Object.keys(marker).sort(), ['createdAt', 'phase', 'schemaVersion', 'scriptId', 'tool']);
  assert.equal(marker.phase, 'pushed');
  assert.equal(marker.scriptId, 'script-id-123');
  assert.match(fake.output.join('\n'), /https:\/\/script\.google\.com\/home\/projects\/script-id-123\/edit/);
  assert.match(fake.output.join('\n'), /https:\/\/script\.google\.com\/home\/usersettings/);
  assert.match(fake.output.join('\n'), /initializeSafeDefaults/);
  assert.doesNotMatch(fake.output.join('\n'), /client secret|MS_CLIENT_SECRET/i);
});

test('init starts clasp login only after a captured loggedIn=false result', async () => {
  const fake = createFakeRuntime({
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":false}' };
      if (args[0] === 'create') {
        fileMap.set(normal(join(options.cwd, '.clasp.json')), JSON.stringify({ scriptId: 'script-id-logged-out' }));
      }
      return { code: 0 };
    }
  });

  const exitCode = await main(['init', '--yes'], fake.runtime);

  assert.equal(exitCode, 0);
  assert.deepEqual(fake.calls.map(({ args }) => args[2]), [
    'show-authorized-user',
    'login',
    'create',
    'push'
  ]);
});

test('init resumes the bounded post-create partial state before replacing clasp starter files', async () => {
  const cwd = resolve('cli-test-resume');
  const target = join(cwd, 'partial');
  const marker = {
    schemaVersion: 1,
    tool: 'tasks-todo-sync',
    phase: 'created',
    scriptId: 'script-id-partial',
    createdAt: '2026-08-25T00:00:00.000Z'
  };
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.tasks-todo-sync-init.json')]: JSON.stringify(marker),
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-id-partial', rootDir: '.' }),
      [join(target, 'Code.js')]: 'function claspStarter() {}\n',
      [join(target, 'Code.gs')]: 'function starter() {}\n',
      [join(target, 'appsscript.json')]: '{"timeZone":"Etc/UTC"}'
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'partial'], fake.runtime);

  assert.equal(exitCode, 0);
  assert.deepEqual(fake.calls.map(({ args }) => args[2]), ['show-authorized-user', 'push']);
  assert.equal(fake.fileMap.get(join(target, 'Code.gs')), ASSETS.code);
  assert.equal(fake.fileMap.has(join(target, 'Code.js')), false);
  assert.equal(JSON.parse(fake.fileMap.get(join(target, '.tasks-todo-sync-init.json'))).phase, 'pushed');
});

test('init refuses a non-empty target that is not a safe partial deployment', async () => {
  const cwd = resolve('cli-test-unsafe');
  const fake = createFakeRuntime({ files: { [join(cwd, 'occupied', 'notes.txt')]: 'do not touch' }, cwd });

  const exitCode = await main(['init', '--yes', '--target', 'occupied'], fake.runtime);

  assert.equal(exitCode, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(fake.errors.join('\n'), /Refusing non-empty target/);
});

test('init refuses Microsoft client credential flags before touching the filesystem', async () => {
  const fake = createFakeRuntime();

  const exitCode = await main(['init', '--yes', '--ms-client-secret', 'not-accepted'], fake.runtime);

  assert.equal(exitCode, 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.fileMap.size, 0);
  assert.match(fake.errors.join('\n'), /intentionally not accepted/);
});
