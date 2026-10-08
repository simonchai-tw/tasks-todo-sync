import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import test from 'node:test';
import { createNodeRuntime, main } from '../lib/cli.mjs';
import { GAS_SOURCE_FILES } from '../lib/gas-files.mjs';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const PACKAGED_MANIFEST = readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8');
const ASSETS = {
  gasFiles: Object.fromEntries(GAS_SOURCE_FILES.map((name) => [
    name,
    name === 'Code.gs' ? 'function syncAll() {}\n' : `// ${name}\n`
  ])),
  setup: '<!doctype html><title>Microsoft setup</title>\n',
  manifest: PACKAGED_MANIFEST,
  claspignore: `**/**\n${GAS_SOURCE_FILES.map((name) => `!${name}`).join('\n')}\n!Setup.html\n!appsscript.json\n`,
  gitignore: '.clasp.json\n.clasprc.json\n.tasks-todo-sync-init.json\nCode.js\n.env\n.env.*\n*.secret.json\n*sync-state*.json\n*state-export*.json\n'
};

function createFakeRuntime({ cwd = resolve('cli-test-workspace'), files = {}, onClasp, onWebApp } = {}) {
  const directories = new Set([cwd]);
  const fileMap = new Map();
  const output = [];
  const errors = [];
  const calls = [];
  const webAppCalls = [];
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
    version: PACKAGE.version,
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
      // A real move, not a bookkeeping stub: the relocation tests exist to
      // prove the user's rollback files survive it, so a fake that only
      // rewrote bookkeeping would pass while the code lost data. A path can be
      // both a directory entry and carry files beneath it here, so both are
      // relocated.
      async rename(from, to) {
        const source = normal(from);
        const destination = normal(to);
        if (directories.has(destination) || fileMap.has(destination)) {
          throw new Error(`EEXIST: ${destination}`);
        }
        if (!directories.has(source) && !fileMap.has(source)) {
          throw new Error(`ENOENT: ${source}`);
        }
        addDirectory(destination);
        for (const path of [...directories]) {
          if (path === source || path.startsWith(source + sep)) {
            directories.delete(path);
            directories.add(destination + path.slice(source.length));
          }
        }
        for (const [path, contents] of [...fileMap]) {
          if (path === source || path.startsWith(source + sep)) {
            fileMap.delete(path);
            fileMap.set(destination + path.slice(source.length), contents);
          }
        }
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
    },
    webAppCall: async (call) => {
      webAppCalls.push(call);
      if (onWebApp) return onWebApp(call);
      return { ok: true, result: { ok: true }, rawText: '' };
    }
  };
  return { runtime, fileMap, output, errors, calls, webAppCalls, normal };
}

test('node runtime resolves the installed clasp entry point without a network or login call', () => {
  const runtime = createNodeRuntime();

  assert.equal(typeof runtime.runClasp, 'function');
  assert.equal(runtime.version, PACKAGE.version);
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
  for (const name of GAS_SOURCE_FILES) {
    assert.equal(fake.fileMap.get(join(target, name)), ASSETS.gasFiles[name]);
  }
  assert.equal(fake.fileMap.get(join(target, 'Setup.html')), ASSETS.setup);
  assert.equal(fake.fileMap.get(join(target, '.claspignore')), ASSETS.claspignore);
  assert.equal(fake.fileMap.get(join(target, '.gitignore')), ASSETS.gitignore);
  const installedManifest = fake.fileMap.get(join(target, 'appsscript.json'));
  assert.equal(JSON.parse(installedManifest).timeZone, 'America/New_York');
  const expectedManifest = JSON.parse(PACKAGED_MANIFEST);
  expectedManifest.timeZone = 'America/New_York';
  assert.equal(installedManifest, `${JSON.stringify(expectedManifest, null, 2)}\n`);
  assert.match(installedManifest, /\n  "timeZone": "America\/New_York",\n/);
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
  for (const name of GAS_SOURCE_FILES) {
    assert.equal(fake.fileMap.get(join(target, name)), ASSETS.gasFiles[name]);
  }
  assert.equal(fake.fileMap.get(join(target, 'Setup.html')), ASSETS.setup);
  assert.equal(fake.fileMap.has(join(target, 'Code.js')), false);
  assert.equal(JSON.parse(fake.fileMap.get(join(target, '.tasks-todo-sync-init.json'))).phase, 'pushed');
});

test('init migrates through a new directory containing only the copied clasp project binding', async () => {
  const cwd = resolve('cli-test-handoff');
  const target = join(cwd, 'multi-file');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'same-existing-script-id', rootDir: '.' })
    },
    onClasp: async ({ args }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') return { code: 0, stdout: '[]' };
      return { code: 0 };
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'multi-file'], fake.runtime);

  assert.equal(exitCode, 0);
  assert.deepEqual(fake.calls.map(({ args }) => args[2]), ['show-authorized-user', 'pull', 'push']);
  assert.equal(JSON.parse(fake.fileMap.get(join(target, '.clasp.json'))).scriptId, 'same-existing-script-id');
  for (const name of GAS_SOURCE_FILES) {
    assert.equal(fake.fileMap.get(join(target, name)), ASSETS.gasFiles[name]);
  }
  const marker = JSON.parse(fake.fileMap.get(join(target, '.tasks-todo-sync-init.json')));
  assert.equal(marker.phase, 'pushed');
  assert.equal(marker.scriptId, 'same-existing-script-id');
  // The backup must land BESIDE the target, never inside it: a backup entry
  // inside the target made inspectTarget() miss the handoff shape and refuse
  // with "Refusing non-empty target", so any machine that had run one update
  // could never adopt its own project again (2026-10-06, rc.8).
  assert.equal(
    await fake.runtime.fs.exists(join(dirname(target), '.tasks-todo-sync-backups', 'handoff-2026-08-25T00-00-00-000Z')),
    true,
    'the adoption pull leaves a backup directory as evidence'
  );
  assert.equal(
    (await fake.runtime.fs.readdir(target)).includes('.tasks-todo-sync-backups'),
    false,
    'the target stays clean so a later adoption can still recognise it'
  );
});

test('init handoff moves a legacy in-target backup tree aside instead of refusing the adoption', async () => {
  const cwd = resolve('cli-test-handoff-legacy-backup');
  const target = join(cwd, 'multi-file');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'legacy-project', rootDir: '.' }),
      // Written inside the target by releases up to 0.9.5-rc.8. With it in
      // place the target held two entries, so inspectTarget() never matched
      // the handoff shape and every adoption failed with "Refusing non-empty
      // target" on any machine that had run a single update (2026-10-06).
      [join(target, '.tasks-todo-sync-backups', '2026-08-01T00-00-00-000Z', '.clasp.json')]:
        JSON.stringify({ scriptId: 'legacy-project', rootDir: '.' })
    },
    onClasp: async ({ args, fileMap }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') return { code: 0, stdout: '[]' };
      return { code: 0 };
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'multi-file'], fake.runtime);

  assert.equal(exitCode, 0, 'the adoption is not refused');
  assert.equal(JSON.parse(fake.fileMap.get(join(target, '.clasp.json'))).scriptId, 'legacy-project');
  assert.equal(
    await fake.runtime.fs.exists(join(dirname(target), '.tasks-todo-sync-backups', '2026-08-01T00-00-00-000Z', '.clasp.json')),
    true,
    "the user's rollback data is kept, one level up"
    + ` | engine said: ${[...fake.output, ...fake.errors].join(' // ')}`
    + ` | target holds: ${(await fake.runtime.fs.readdir(target)).join(',')}`
  );
  assert.equal(
    (await fake.runtime.fs.readdir(target)).includes('.tasks-todo-sync-backups'),
    false,
    'the target no longer carries the legacy tree'
  );
});

test('init handoff never overwrites an existing backup set while relocating a legacy one', async () => {
  const cwd = resolve('cli-test-handoff-backup-collision');
  const target = join(cwd, 'multi-file');
  const existing = join(cwd, '.tasks-todo-sync-backups');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'legacy-project', rootDir: '.' }),
      [join(target, '.tasks-todo-sync-backups', '2026-08-01T00-00-00-000Z', 'old.js')]: '// legacy\n',
      [join(existing, '2026-09-01T00-00-00-000Z', 'newer.js')]: '// newer\n'
    },
    onClasp: async ({ args }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') return { code: 0, stdout: '[]' };
      return { code: 0 };
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'multi-file'], fake.runtime);

  assert.equal(exitCode, 0);
  assert.equal(await fake.runtime.fs.exists(join(existing, '2026-09-01T00-00-00-000Z', 'newer.js')), true,
    'the newer backup set is untouched');
  assert.equal(await fake.runtime.fs.exists(join(cwd, '.tasks-todo-sync-backups.1', '2026-08-01T00-00-00-000Z', 'old.js')), true,
    'the legacy set is preserved under a suffixed directory, not merged or dropped');
});

test('init handoff refuses to adopt a remote project that still has unmanaged files', async () => {
  const cwd = resolve('cli-test-handoff-dirty');
  const target = join(cwd, 'multi-file');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'legacy-project', rootDir: '.' })
    },
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') {
        fileMap.set(normal(join(options.cwd, 'LegacyMacro.js')), '// leftover from a manual deploy\n');
        return { code: 0, stdout: '[]' };
      }
      return { code: 0 };
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'multi-file'], fake.runtime);

  assert.equal(exitCode, 1);
  assert.match(fake.errors.join('\n'), /Refusing to adopt the Apps Script project/);
  assert.match(fake.errors.join('\n'), /LegacyMacro\.js/);
  assert.equal(fake.calls.some(({ args }) => args[2] === 'push'), false, 'nothing may be pushed before the gate passes');
  assert.equal(fake.fileMap.has(join(target, 'Code.gs')), false, 'assets must not be installed into a refused target');
});

test('update refuses a remote pull with unmanaged files and pushes nothing', async () => {
  const cwd = resolve('cli-test-update-dirty');
  const target = join(cwd, 'app');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-1', rootDir: '.' })
    },
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') {
        fileMap.set(normal(join(options.cwd, 'OldThing.js')), '// stale remote-only file\n');
        return { code: 0, stdout: '[]' };
      }
      return { code: 0 };
    }
  });

  const exitCode = await main(['update', '--json', '--target', 'app'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 1);
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /Refusing automatic update/);
  assert.match(payload.error.message, /OldThing\.js/);
  assert.equal(fake.calls.some(({ args }) => args[2] === 'push'), false, 'nothing may be pushed when the gate refuses');
  assert.equal(fake.fileMap.has(join(target, 'Code.gs')), false, 'assets must not be installed into a refused target');
});

test('update proceeds through the unmanaged gate to push when the remote is clean', async () => {
  const cwd = resolve('cli-test-update-clean');
  const target = join(cwd, 'app');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-1', rootDir: '.' })
    },
    onClasp: async ({ args }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') return { code: 0, stdout: '[]' };
      if (args[0] === 'list-deployments') return { code: 0, stdout: '[]' };
      if (args[0] === 'create-version') return { code: 0, stdout: '{"versionNumber":7}' };
      if (args[0] === 'create-deployment') return { code: 0, stdout: '{"deploymentId":"deployment-7","versionNumber":7}' };
      return { code: 0 };
    }
  });

  const exitCode = await main(['update', '--json', '--target', 'app'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));
  const commands = fake.calls.map(({ args }) => args[2]);

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'updated');
  assert.equal(payload.deploymentId, 'deployment-7');
  assert.ok(commands.indexOf('pull') < commands.indexOf('push'), 'the gate pull must run before the push');
});

test('update treats pulled .js files as their managed .gs equivalents', async () => {
  // Regression guard for the canonical-name mapping in
  // pullRemoteAndListUnmanaged. clasp returns server files as .js while
  // MANAGED_REMOTE_FILES holds .gs names, so without the mapping every managed
  // file looked unmanaged and `update` refused to run against its own project.
  //
  // This exact assertion is what a mutant that deletes the .map() line has to
  // survive: the two "update" tests above both pull an EMPTY directory, so they
  // cannot observe the mapping at all. Measured on 2026-10-06: removing the
  // mapping left the suite at 505 pass / 0 fail.
  const cwd = resolve('cli-test-update-js-mapping');
  const target = join(cwd, 'app');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-1', rootDir: '.' })
    },
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') {
        // Exactly what the Apps Script server actually holds: every managed
        // source, in the .js form clasp writes it.
        for (const name of ['Code', 'globals', 'setup', 'auth', 'config', 'state', 'sync', 'operations'])
          fileMap.set(normal(join(options.cwd, `${name}.js`)), '// remote\n');
        return { code: 0, stdout: '[]' };
      }
      if (args[0] === 'list-deployments') return { code: 0, stdout: '[]' };
      if (args[0] === 'create-version') return { code: 0, stdout: '{"versionNumber":9}' };
      if (args[0] === 'create-deployment') return { code: 0, stdout: '{"deploymentId":"deployment-9","versionNumber":9}' };
      return { code: 0 };
    }
  });

  const exitCode = await main(['update', '--json', '--target', 'app'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 0, `a remote holding only managed .js files must not be refused: ${payload?.error?.message ?? ''}`);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'updated');
});

test('update still refuses a genuinely unmanaged .js file alongside managed ones', async () => {
  // The other half of the contract: the mapping must not become a blanket
  // pass. A file outside the managed set has to keep blocking the update, and it
  // has to be reported by the name the user will recognise (.js, not .gs).
  const cwd = resolve('cli-test-update-js-mixed');
  const target = join(cwd, 'app');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-1', rootDir: '.' })
    },
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') {
        fileMap.set(normal(join(options.cwd, 'Code.js')), '// remote\n');
        fileMap.set(normal(join(options.cwd, 'sync.js')), '// remote\n');
        fileMap.set(normal(join(options.cwd, 'LegacyMacro.js')), '// stale remote-only file\n');
        return { code: 0, stdout: '[]' };
      }
      return { code: 0 };
    }
  });

  const exitCode = await main(['update', '--json', '--target', 'app'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 1);
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /Refusing automatic update/);
  assert.match(payload.error.message, /LegacyMacro\.js/);
  assert.equal(fake.calls.some(({ args }) => args[2] === 'push'), false, 'nothing may be pushed when the gate refuses');
});

test('init refuses an in-place single-file upgrade with an actionable migration path', async () => {
  const cwd = resolve('cli-test-legacy-upgrade');
  const target = join(cwd, 'single-file');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'existing-script-id', rootDir: '.' }),
      [join(target, 'Code.gs')]: 'function syncAll() {}\n',
      [join(target, 'appsscript.json')]: PACKAGED_MANIFEST
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'single-file'], fake.runtime);

  assert.equal(exitCode, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(fake.errors.join('\n'), /Refusing in-place upgrade/);
  assert.match(fake.errors.join('\n'), /copy only \.clasp\.json/);
  assert.match(fake.errors.join('\n'), /healthCheck\(\).*dryRunReport\(\)/);
});

test('completed partial resume byte-compares every canonical GAS source', async () => {
  const cwd = resolve('cli-test-byte-compare');
  const target = join(cwd, 'pushed');
  const files = Object.fromEntries(GAS_SOURCE_FILES.map((name) => [
    join(target, name),
    ASSETS.gasFiles[name]
  ]));
  files[join(target, 'lifecycle.gs')] = '// locally modified lifecycle\n';
  files[join(target, '.tasks-todo-sync-init.json')] = JSON.stringify({
    schemaVersion: 1,
    tool: 'tasks-todo-sync',
    phase: 'pushed',
    scriptId: 'script-id-pushed',
    createdAt: '2026-08-25T00:00:00.000Z'
  });
  files[join(target, '.clasp.json')] = JSON.stringify({ scriptId: 'script-id-pushed', rootDir: '.' });
  files[join(target, 'Setup.html')] = ASSETS.setup;
  files[join(target, '.claspignore')] = ASSETS.claspignore;
  files[join(target, '.gitignore')] = ASSETS.gitignore;
  files[join(target, 'appsscript.json')] = ASSETS.manifest;
  const fake = createFakeRuntime({ cwd, files });

  const exitCode = await main(['init', '--yes', '--target', 'pushed'], fake.runtime);

  assert.equal(exitCode, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(fake.errors.join('\n'), /lifecycle\.gs differs from the packaged safe partial state/);
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

test('doctor --json reports the local Node.js compatibility gate', async () => {
  const fake = createFakeRuntime();

  const exitCode = await main(['doctor', '--json'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.packageVersion, PACKAGE.version);
  assert.equal(payload.node.major >= 22, true);
  assert.equal(payload.node.supported, true);
});

test('install --json creates one version and one web app deployment without recreating an existing project', async () => {
  const cwd = resolve('cli-test-install');
  const fake = createFakeRuntime({
    cwd,
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'create') {
        fileMap.set(normal(join(options.cwd, '.clasp.json')), JSON.stringify({ scriptId: 'new-script', rootDir: '.' }));
        return { code: 0 };
      }
      if (args[0] === 'list-deployments') return { code: 0, stdout: '[]' };
      if (args[0] === 'create-version') return { code: 0, stdout: '{"versionNumber":7}' };
      if (args[0] === 'create-deployment') {
        return { code: 0, stdout: '{"deploymentId":"deployment-7","versionNumber":7}' };
      }
      return { code: 0 };
    }
  });

  const exitCode = await main(['install', '--json', '--non-interactive', '--target', 'managed'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));
  const commands = fake.calls.map(({ args }) => args[2]);

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.scriptId, 'new-script');
  assert.equal(payload.deploymentId, 'deployment-7');
  assert.equal(payload.versionNumber, 7);
  assert.deepEqual(commands.filter((command) => ['create', 'push', 'create-version', 'create-deployment'].includes(command)), [
    'create',
    'push',
    'create-version',
    'create-deployment'
  ]);
  const marker = JSON.parse(fake.fileMap.get(join(cwd, 'managed', '.tasks-todo-sync-companion.json')));
  assert.equal(marker.scriptId, 'new-script');
  assert.equal(marker.deploymentId, 'deployment-7');
});

test('update adopts the deployment this tool created when the project already has several', async () => {
  // Regression guard for the deadlock measured 2026-10-06 on
  // 1o-hO0EoczMiFYGeDCLw1XAYxFiQff05lwvpWY85_sYJExH-fQc4wlNfS: a first install
  // creates a SECOND deployment beside the project's auto-created HEAD, so
  // every later run arrived with two deployments and no --deployment-id, and
  // publishDeployment threw "Multiple web app deployments exist" -- which the
  // companion surfaced as "could not connect to the existing project".
  //
  // The remote below is that exact state: one unversioned HEAD plus one
  // deployment carrying this tool's own description. A mutant that restores the
  // unconditional throw has to fail this, and the older tests cannot catch it
  // because they all list an empty deployment set.
  const cwd = resolve('cli-test-update-picks-own-deployment');
  const target = join(cwd, 'app');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-1', rootDir: '.' })
    },
    onClasp: async ({ args }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') return { code: 0, stdout: '[]' };
      if (args[0] === 'list-deployments') {
        return {
          code: 0,
          stdout: JSON.stringify([
            { deploymentId: 'AKfycbHEAD' },
            { deploymentId: 'AKfycbOURS', versionNumber: 1, description: 'Tasks-ToDo-Sync web app' }
          ])
        };
      }
      if (args[0] === 'create-version') return { code: 0, stdout: '{"versionNumber":8}' };
      if (args[0] === 'create-deployment') return { code: 0, stdout: '{"deploymentId":"AKfycbOURS","versionNumber":8}' };
      return { code: 0 };
    }
  });

  const exitCode = await main(['update', '--json', '--target', 'app'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));
  const deploymentCall = fake.calls.find(({ args }) => args[2] === 'create-deployment');

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.deploymentId, 'AKfycbOURS');
  assert.ok(deploymentCall, 'create-deployment must run');
  assert.equal(
    deploymentCall.args[deploymentCall.args.indexOf('--deploymentId') + 1],
    'AKfycbOURS',
    'the existing Tasks-ToDo-Sync deployment must be updated, not replaced'
  );
});

test('preferences --json calls the bounded Apps Script preference endpoint', async () => {
  const cwd = resolve('cli-test-preferences');
  const target = join(cwd, 'tasks-todo-sync-app');
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId: 'script-1', rootDir: '.' }),
      [join(target, '.tasks-todo-sync-companion.json')]: JSON.stringify({
        schemaVersion: 1,
        tool: 'tasks-todo-sync-companion',
        scriptId: 'script-1',
        deploymentId: 'AKfycbMARKER'
      })
    },
    onWebApp: async ({ action, params }) => ({ ok: true, result: { ok: true, applied: params } })
  });

  const exitCode = await main([
    'preferences',
    '--json',
    '--calendar-projection',
    'true',
    '--calendar-reminder',
    'false',
    '--alert-email',
    'alerts@example.com'
  ], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));
  const webAppCall = fake.webAppCalls.find(({ action }) => action === 'setupWizardSavePreferences');

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.ok(webAppCall, 'the preference change must go over the web app JSON API');
  assert.deepEqual(webAppCall.params, [{
    calendarProjectionEnabled: true,
    calendarReminderEnabled: false,
    alertEmail: 'alerts@example.com'
  }]);
});

// detect had NO coverage at all before P0-2: the name filter at cli.mjs:319 was
// never exercised, which is how a renamed project could be reported as an empty
// Drive for six releases. These tests exist to keep that from coming back.
//
// A realistic fingerprint needs the actual signal text, because the whole point
// is that a project is recognised by its CONTENTS rather than its name.
const HEALTHY_REMOTE_FILES = {
  'Code.js': 'function syncAll() {}\nfunction setupWizardOverview() {}\n',
  'globals.js': "const TIME_BRIDGE_CALENDAR_SUMMARY = 'Tasks-ToDo-Sync';\n",
  'Setup.html': '<!doctype html><p>Set up your personal device with Microsoft To Do.</p>',
  'appsscript.json': JSON.stringify({ webApp: { access: 'anyone' } }),
  'time-bridge.js': '// time bridge\n',
  'providers.js': '// providers\n'
};

function detectRuntime({ cwd, listed, remoteFiles }) {
  return createFakeRuntime({
    cwd,
    onClasp: async ({ args, options, fileMap, normal }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'list-scripts') return { code: 0, stdout: JSON.stringify(listed) };
      if (args[0] === 'pull') {
        // invokeClasp passes the directory as options.cwd and the project id
        // only in the .clasp.json it wrote there, so that is where the id has to
        // come from -- it is not on the command line.
        const target = normal(options.cwd);
        const binding = JSON.parse(fileMap.get(normal(`${target}/.clasp.json`)));
        for (const [name, contents] of Object.entries(remoteFiles[binding.scriptId] || {})) {
          fileMap.set(normal(`${target}/${name}`), contents);
        }
        return { code: 0, stdout: '{}' };
      }
      return { code: 0 };
    }
  });
}

test('detect finds a project the user renamed', async () => {
  const cwd = resolve('cli-test-detect-renamed');
  const fake = detectRuntime({
    cwd,
    listed: [{ id: 'script-renamed', name: 'Tasks-ToDo-Sync (2)' }],
    remoteFiles: { 'script-renamed': HEALTHY_REMOTE_FILES }
  });

  const exitCode = await main(['detect', '--json'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 0);
  // The name does not match, but the files do. Reporting zero candidates here is
  // what let the app create a duplicate project next to this one.
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].name, 'Tasks-ToDo-Sync (2)');
  assert.equal(payload.candidates[0].nameMatchesTitle, false);
  assert.equal(payload.candidates[0].confidence, 'high');
  assert.equal(payload.installed, true);
  assert.equal(payload.recommendedScriptId, 'script-renamed');
  assert.deepEqual(payload.adoptableScriptIds, ['script-renamed']);
});

test('an unrelated project is listed but never blocks a first install', async () => {
  const cwd = resolve('cli-test-detect-unrelated');
  const fake = detectRuntime({
    cwd,
    listed: [{ id: 'script-other', name: 'My budget tracker' }],
    remoteFiles: {
      'script-other': {
        'Code.js': 'function onOpen() { SpreadsheetApp.getUi(); }\n',
        'appsscript.json': JSON.stringify({ timeZone: 'Asia/Taipei' })
      }
    }
  });

  const exitCode = await main(['detect', '--json'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 0);
  // It IS visible -- the gate can see it -- but it does not look like this app,
  // so it must not become a permanent "you already have a project" wall. This
  // is the coupling the name filter used to hide: counting every visible script
  // as adoptable would deadlock anyone who owns an unrelated Apps Script project.
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].confidence, 'low');
  assert.deepEqual(payload.adoptableScriptIds, []);
  assert.equal(payload.installed, false);
});

test('a same-named project still sorts ahead of a renamed one', async () => {
  const cwd = resolve('cli-test-detect-order');
  const fake = detectRuntime({
    cwd,
    listed: [
      { id: 'script-renamed', name: 'Tasks-ToDo-Sync (copy)' },
      { id: 'script-canonical', name: 'Tasks-ToDo-Sync' }
    ],
    remoteFiles: {
      'script-renamed': HEALTHY_REMOTE_FILES,
      'script-canonical': HEALTHY_REMOTE_FILES
    }
  });

  await main(['detect', '--json'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  // Two healthy copies: genuinely ambiguous, and the name match is the one
  // reported first so the common case is unchanged.
  assert.equal(payload.candidates.length, 2);
  assert.equal(payload.candidates[0].scriptId, 'script-canonical');
  assert.equal(payload.ambiguous, true);
  assert.equal(payload.recommendedScriptId, null);
  assert.deepEqual(payload.adoptableScriptIds, ['script-canonical', 'script-renamed']);
});

test('an account with no scripts reports an empty adoptable list, not an error', async () => {
  const cwd = resolve('cli-test-detect-empty');
  const fake = detectRuntime({ cwd, listed: [], remoteFiles: {} });

  const exitCode = await main(['detect', '--json'], fake.runtime);
  const payload = JSON.parse(fake.output.at(-1));

  assert.equal(exitCode, 0);
  assert.equal(payload.visibleProjectCount, 0);
  assert.deepEqual(payload.candidates, []);
  // Present and empty -- this is what tells the app creation is allowed. An
  // absent key must not be confused with it (see CloudState.AdoptableIdsSupplied).
  assert.equal(Array.isArray(payload.adoptableScriptIds), true);
  assert.deepEqual(payload.adoptableScriptIds, []);
});

test('init adoption gives clasp a project settings file in the directory it pulls into', async () => {
  // Regression guard for a real install failure, 2026-10-06 (rc.10).
  //
  // clasp resolves the project from the .clasp.json in the directory it is
  // handed. The adoption path created that backup directory and then called
  // pull without ever writing the file, so every adoption of an existing
  // project failed with:
  //
  //   clasp pull --json --force failed: Project settings not found.
  //
  // Detection had already succeeded and decided to adopt, so this was reached
  // on a project that demonstrably exists and is reachable. The earlier handoff
  // test could not catch it because its fake clasp answered `pull` with
  // success no matter what, which is precisely the assumption that was wrong.
  //
  // This fake reproduces clasp's actual requirement: refuse the pull when the
  // directory has no .clasp.json.
  const cwd = resolve('cli-test-handoff-project-settings');
  const target = join(cwd, 'multi-file');
  const scriptId = 'existing-project-script-id';
  const fake = createFakeRuntime({
    cwd,
    files: {
      [join(target, '.clasp.json')]: JSON.stringify({ scriptId, rootDir: '.' })
    },
    onClasp: async ({ args, options, fileMap }) => {
      if (args[0] === 'show-authorized-user') return { code: 0, stdout: '{"loggedIn":true}' };
      if (args[0] === 'pull') {
        const settings = join(resolve(options.cwd), '.clasp.json');
        if (!fileMap.has(settings)) {
          return { code: 1, stderr: 'Project settings not found.' };
        }
        return { code: 0, stdout: '[]' };
      }
      return { code: 0 };
    }
  });

  const exitCode = await main(['init', '--yes', '--target', 'multi-file'], fake.runtime);

  assert.equal(
    exitCode,
    0,
    'adoption failed: clasp refused the pull because the directory had no .clasp.json'
  );
  assert.equal(
    fake.calls.some(({ args }) => args[2] === 'pull'),
    true,
    'the adoption path must actually pull'
  );
});
