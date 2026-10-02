#!/usr/bin/env node
// P1 (advisory review): "文件數字由 CI 同源產生 — 版本與測試數單一來源".
//
// The version badge, README test count, and audit test counts used to be hand
//-edited and drifted apart (the review caught 445 vs 465 vs 470 in the wild).
// This script makes the real test runner the single source of truth:
//   1. runs `node --test --test-reporter=tap` and parses its own summary;
//   2. refuses to patch anything unless fail === 0 (never publish "100% PASS"
//      next to a failing count);
//   3. writes docs/reliability.json (the generated artifact);
//   4. patches README.md, docs/audit.md and the docs/index.html version badge;
//   5. `--check` mode re-derives everything and exits 1 on drift (CI gate).
//
// The docs/audit.md H1 title and "Audit scope" line intentionally stay manual:
// the audit documents the evidence of a *released* version, not the dev one.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function runSuite() {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const tests = Number((output.match(/^# tests (\d+)$/m) || [])[1]);
  const pass = Number((output.match(/^# pass (\d+)$/m) || [])[1]);
  const fail = Number((output.match(/^# fail (\d+)$/m) || [])[1]);
  if (!Number.isFinite(tests) || !Number.isFinite(pass) || !Number.isFinite(fail)) {
    console.error('generate-doc-numbers: could not parse the test runner summary.');
    process.exit(1);
  }
  return { tests, pass, fail, output };
}

const suite = runSuite();
const pkg = JSON.parse(read('package.json'));
const version = String(pkg.version || '');
if (!version) {
  console.error('generate-doc-numbers: package.json has no version.');
  process.exit(1);
}

if (suite.fail !== 0) {
  console.error(`generate-doc-numbers: ${suite.fail} failing test(s) — refusing to write reliability numbers.`);
  process.exit(1);
}

const artifact = {
  version,
  tests: suite.tests,
  pass: suite.pass,
  fail: suite.fail,
  runner: 'node --test --test-reporter=tap',
  generatedAt: new Date().toISOString()
};

const targets = [
  {
    file: 'README.md',
    patches: [
      { re: /covered by \d+ automated tests/g, to: `covered by ${suite.pass} automated tests` }
    ]
  },
  {
    file: 'docs/audit.md',
    patches: [
      { re: /covered by \d+ automated tests/g, to: `covered by ${suite.pass} automated tests` },
      { re: /\*\*\d+ automated tests\*\*/g, to: `**${suite.pass} automated tests**` }
    ]
  },
  {
    file: 'docs/index.html',
    patches: [
      { re: /(<span class="badge ver"><i class="badge-dot"><\/i>)v[^<]*(<\/span>)/g, to: `$1v${version}$2` }
    ]
  }
];

let drift = false;
for (const target of targets) {
  const before = read(target.file);
  let after = before;
  for (const patch of target.patches) {
    after = after.replace(patch.re, patch.to);
  }
  if (after !== before) {
    drift = true;
    if (CHECK) {
      console.error(`generate-doc-numbers: ${target.file} is out of sync with the test suite / package version.`);
    } else {
      writeFileSync(join(ROOT, target.file), after);
      console.log(`generate-doc-numbers: patched ${target.file}`);
    }
  }
}

if (!CHECK) {
  writeFileSync(join(ROOT, 'docs', 'reliability.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`generate-doc-numbers: wrote docs/reliability.json (${suite.pass}/${suite.tests} passing, v${version})`);
}

if (CHECK && drift) {
  process.exit(1);
}
console.log(`generate-doc-numbers: ${CHECK ? 'check' : 'sync'} OK — ${suite.pass}/${suite.tests} tests, v${version}`);
