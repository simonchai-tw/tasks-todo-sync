import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(ROOT, 'bootstrap.sh');

test('bootstrap.sh exists at the repo root', () => {
  assert.equal(existsSync(script), true, 'bootstrap.sh must ship with the repo for the curl|sh entry point');
});

test('bootstrap minimum Node version matches the engines field (single source)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const engines = String(pkg.engines?.node || '');
  const major = Number((engines.match(/>=\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(major), 'package.json engines.node must be ">=<major>"');
  const source = readFileSync(script, 'utf8');
  const declared = Number((source.match(/NODE_MIN_MAJOR=(\d+)/) || [])[1]);
  assert.equal(declared, major, 'bootstrap.sh NODE_MIN_MAJOR must match package.json engines.node');
});

test('bootstrap does not assume Homebrew exists (offers a no-brew route)', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /command -v brew/, 'must branch on brew presence, not assume it');
  assert.match(source, /nodejs\.org/, 'must offer the official installer when brew is missing');
});

test('bootstrap fails closed when no interactive input is available', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /\/dev\/tty/, 'prompts must fall back to /dev/tty when stdin is the piped script');
  assert.match(source, /No interactive input available/, 'every interactive path needs a non-interactive escape');
});

test('bootstrap hands over to the guided setup instead of dropping the user at docs', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /exec npx -y "\$\{PACKAGE\}@/, 'must continue into the package CLI');
  assert.match(source, /init "\$@"/, 'must run the guided init command with pass-through args');
});

test('bootstrap.sh passes sh -n syntax check (when a POSIX shell is available)', () => {
  // POSIX sh eats backslashes as escapes; hand it a forward-slash path.
  const shPath = script.replace(/\\/g, '/');
  const probe = spawnSync('sh', ['-n', shPath], { encoding: 'utf8' });
  const errCode = probe.error && probe.error.code;
  if (errCode === 'ENOENT' || errCode === 'EBUSY') {
    // ENOENT: no POSIX shell on PATH (e.g. a plain Windows runner).
    // EBUSY: the local dev sandbox refuses to spawn sh.exe at all (observed
    // here); syntax is verified manually in that case. Real Linux CI runs it.
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || 'sh -n reported a syntax error');
});
