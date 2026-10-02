import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// P1 (advisory review): "Setup 讀取真實 health 結果" — the wizard's health row
// must reflect the persisted outcome of a real check (unknown / fail / pass
// distinguishable) and must never display "System healthy" merely because a
// trigger exists.

const SETUP_GS = readFileSync(new URL('../setup.gs', import.meta.url), 'utf8');
const CODE_GS = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const SETUP_HTML = readFileSync(new URL('../Setup.html', import.meta.url), 'utf8');

function extractFunction_(source, name) {
  // Top-level function bodies close with a `}` at column 0; nested braces are
  // indented, so a lazy match up to the first line-start brace is sufficient
  // for these helpers.
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected function ${name}() in source`);
  return match[0];
}

function runHealthHelpersInContext() {
  const store = {};
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
        setProperty: (key, value) => { store[key] = String(value); }
      })
    }
  });
  vm.runInContext(`${extractFunction_(SETUP_GS, 'writeLastWizardHealth_')}\n${extractFunction_(SETUP_GS, 'readLastWizardHealth_')}`, context);
  return { store, context };
}

test('unverified when no health record exists — never inferred healthy', () => {
  const { context } = runHealthHelpersInContext();
  const view = vm.runInContext('readLastWizardHealth_()', context);
  assert.equal(view.state, 'unverified');
  assert.equal(view.checkedAt, null);
});

test('finalize persists a passing check; overview reads it back with a timestamp', () => {
  const { store, context } = runHealthHelpersInContext();
  vm.runInContext('writeLastWizardHealth_({ ok: true, issueCount: 0, issues: [] })', context);
  assert.ok(Object.prototype.hasOwnProperty.call(store, 'LAST_WIZARD_HEALTH_CHECK'));
  const view = vm.runInContext('readLastWizardHealth_()', context);
  assert.equal(view.state, 'pass');
  assert.equal(view.ok, true);
  assert.notEqual(view.checkedAt, null);
  assert.equal(Number.isNaN(Date.parse(view.checkedAt)), false);
});

test('a failing check persists state=fail with the first bounded issue', () => {
  const { context } = runHealthHelpersInContext();
  vm.runInContext("writeLastWizardHealth_({ ok: false, issueCount: 2, issues: ['Google Tasks read failed.', 'Second issue.'] })", context);
  const view = vm.runInContext('readLastWizardHealth_()', context);
  assert.equal(view.state, 'fail');
  assert.equal(view.ok, false);
  assert.equal(view.message, 'Google Tasks read failed.');
});

test('a corrupted persisted record reads back as unverified, not healthy', () => {
  const { store, context } = runHealthHelpersInContext();
  store['LAST_WIZARD_HEALTH_CHECK'] = '{not-json';
  let view = vm.runInContext('readLastWizardHealth_()', context);
  assert.equal(view.state, 'unverified');
  store['LAST_WIZARD_HEALTH_CHECK'] = JSON.stringify({ state: 'excellent' });
  view = vm.runInContext('readLastWizardHealth_()', context);
  assert.equal(view.state, 'unverified');
});

test('setupWizardOverview exposes the persisted health record', () => {
  assert.match(CODE_GS, /health: readLastWizardHealth_\(\),/);
});

test('setupWizardFinalize persists the real bounded health outcome', () => {
  assert.match(CODE_GS, /writeLastWizardHealth_\(boundedHealth\);/);
});

test('Setup.html no longer fabricates "Dry-run passed. System healthy." from trigger existence', () => {
  assert.equal(
    SETUP_HTML.includes("markRowSuccess('finalRowHealth', 'finalIconBoxHealth', 'finalDetailHealth', 'Dry-run passed. System healthy.');"),
    false,
    'the trigger-only fabricated health line must be removed from refreshStep3Overview'
  );
});

test('Setup.html renders all three health states from the persisted record', () => {
  assert.match(SETUP_HTML, /renderOverviewHealth\(data && data\.health\)/);
  assert.match(SETUP_HTML, /Not yet verified/);
  assert.match(SETUP_HTML, /state === 'pass'/);
  assert.match(SETUP_HTML, /state === 'fail'/);
});
