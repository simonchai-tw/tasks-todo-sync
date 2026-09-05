import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const args = npmCli ? [npmCli, 'pack', '--dry-run', '--json'] : ['pack', '--dry-run', '--json'];
const output = execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: !npmCli && process.platform === 'win32'
});
const packed = JSON.parse(output);
const files = packed[0]?.files?.map((entry) => entry.path) || [];
const required = [
  'package.json',
  'bin/tasks-todo-sync.mjs',
  'lib/cli.mjs',
  'assets/claspignore',
  'assets/deploy-gitignore',
  'Code.gs',
  'Setup.html',
  'appsscript.json'
];
for (const filename of required) {
  if (!files.includes(filename)) {
    throw new Error(`npm pack --dry-run omitted required release asset: ${filename}`);
  }
}

const forbidden = /(^|\/)(?:\.clasp(?:rc)?(?:\.json)?|\.env(?:\.|$)|[^/]*(?:secret|state)[^/]*)(?:$|\/)/i;
const unsafe = files.filter((filename) => forbidden.test(filename));
if (unsafe.length > 0) {
  throw new Error(`npm pack --dry-run includes unsafe local configuration or state: ${unsafe.join(', ')}`);
}

console.log(`Package dry-run validation passed (${files.length} files).`);
