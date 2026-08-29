import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLIFF_TASK_COUNT,
  PROPERTY_STORE_HARD_LIMIT_BYTES,
  PROPERTY_STORE_ACCEPTANCE_BYTES,
  TASK_COUNT,
  buildFixture,
  runStressSuite,
  runStorageCliffProbe,
  stressExitCode
} from '../scripts/stress-600.mjs';

test('600-task stress suite is deterministic and every supported corner passes integrity', () => {
  const first = runStressSuite();
  const second = runStressSuite();
  assert.deepEqual(first, second);
  assert.equal(first.providerCalls, 0, 'the suite must not call a provider');
  assert.equal(first.taskCountPerSupportedCorner, TASK_COUNT);
  assert.equal(first.summary.allSupportedPassed, true);
  assert.equal(first.summary.supportedFailed, 0);
  assert.equal(first.peakGenerationCount, 3);
  assert.equal(first.propertyHardCeilingBytes, PROPERTY_STORE_HARD_LIMIT_BYTES);
  assert.equal(stressExitCode(first), 0);
  assert.equal(stressExitCode({ summary: { ...first.summary, allSupportedPassed: true, cliffExceedsHardCeiling: true } }), 0);
  assert.ok(first.syntheticModelExcludes.includes('OAuth2 latency'));
  assert.match(first.runtimePreflightNote, /preflight/);
  assert.ok(first.summary.targetMarginFailureScenarios.includes('moves-journals'));
  assert.ok(first.summary.targetMarginFailureScenarios.includes('storage-pressure'));
  assert.equal(first.summary.saturationProbeCount, 1);
  assert.equal(first.summary.allSaturationProbesPassed, true);
  for (const scenario of first.scenarios) {
    assert.equal(scenario.fixture.taskCount, TASK_COUNT, scenario.name);
    assert.equal(scenario.fixture.googleTaskCount, TASK_COUNT, scenario.name);
    assert.equal(scenario.fixture.microsoftTaskCount, TASK_COUNT, scenario.name);
    assert.equal(scenario.metrics.duplicateCount, 0, scenario.name);
    assert.equal(scenario.metrics.integrity, true, scenario.name);
    assert.equal(scenario.pass, scenario.expectedStorageRefusal
      ? !scenario.metrics.storage.hardCeilingPass
      : scenario.metrics.storage.hardCeilingPass, scenario.name);
    assert.equal(
      scenario.metrics.storage.peakBytes,
      scenario.metrics.storage.generationBytes * scenario.metrics.storage.peakGenerationCount +
        scenario.metrics.storage.mutableManifestBytes + scenario.metrics.storage.roundManifestBytes,
      scenario.name
    );
    assert.ok(scenario.metrics.storage.largestChunkBytes <= 8 * 1024, scenario.name);
  }
});

test('dense and sparse corners model provider pagination per list', () => {
  const report = runStressSuite();
  assert.equal(report.scenarios.find((item) => item.name === 'dense-1x600').metrics.pageCalls, 12);
  assert.equal(report.scenarios.find((item) => item.name === 'sparse-60x10').metrics.pageCalls, 120);
});

test('bidirectional edit corner records one LWW winner write per logical pair', () => {
  const scenario = runStressSuite().scenarios.find((item) => item.name === 'bidirectional-changes');
  assert.equal(scenario.metrics.googleChanges, TASK_COUNT);
  assert.equal(scenario.metrics.microsoftChanges, TASK_COUNT);
  assert.equal(scenario.metrics.lwwConflicts, TASK_COUNT);
  assert.equal(scenario.metrics.actions, TASK_COUNT);
  assert.match(scenario.metrics.timingModel, /not-a-GAS-benchmark/);
});

test('failure injection is fail-closed without changing the exact 600-task fixture', () => {
  const report = runStressSuite();
  for (const name of ['injected-408', 'injected-429', 'injected-500', 'injected-time-budget', 'injected-property-failure']) {
    const scenario = report.scenarios.find((item) => item.name === name);
    assert.equal(scenario.fixture.taskCount, TASK_COUNT);
    assert.equal(scenario.metrics.committed, false, name);
    assert.equal(scenario.metrics.duplicateCount, 0, name);
    assert.equal(scenario.metrics.integrity, true, name);
    assert.match(scenario.metrics.errorCode, /^(HTTP_(?:408|429|500)|TIME_BUDGET_SYNC|STATE_STORE_LIMIT)$/);
  }
});

test('journal metrics count actual journal records and expose target-margin misses', () => {
  const report = runStressSuite();
  const moves = report.scenarios.find((item) => item.name === 'moves-journals');
  const pressure = report.scenarios.find((item) => item.name === 'storage-pressure');
  assert.equal(moves.metrics.journals, 600);
  assert.equal(moves.metrics.taskMoveJournalCount, 600);
  assert.equal(moves.metrics.deletionJournalCount, 0);
  assert.equal(moves.metrics.storage.peakGenerationCount, 3);
  const moveFixture = buildFixture({ count: TASK_COUNT, shape: 'normal', mode: 'moves' });
  assert.ok(Object.values(moveFixture.state.taskMoveJournal).every((entry) => entry.fingerprint.startsWith('sha256b64:')));
  assert.ok(Object.values(moveFixture.state.taskMoveJournal).every((entry) => /^sha256b64:[A-Za-z0-9+/]{43}=$/.test(entry.fingerprint)));
  assert.equal(pressure.metrics.journals, 24);
  assert.equal(pressure.metrics.taskMoveJournalCount, 24);
  assert.equal(report.summary.targetMarginFailureCount, 3);
  assert.deepEqual(report.summary.targetMarginFailureScenarios, [
    'deletions-tombstones', 'moves-journals', 'storage-pressure'
  ]);
  for (const name of ['moves-journals']) {
    const scenario = report.scenarios.find((item) => item.name === name);
    assert.equal(scenario.supported, false, name);
    assert.equal(scenario.expectedStorageRefusal, true, name);
    assert.equal(scenario.metrics.outcome, 'storage_refusal', name);
    assert.equal(scenario.metrics.committed, false, name);
    assert.equal(scenario.pass, true, name);
  }
});

test('storage pressure uses distinct tombstones, valid schema fields, and reports both storage gates', () => {
  const fixture = buildFixture({ count: TASK_COUNT, shape: 'normal', mode: 'storage-pressure' });
  assert.equal(Object.keys(fixture.state.g2m).length, TASK_COUNT);
  assert.equal(Object.keys(fixture.state.tombstones.g).length, TASK_COUNT);
  assert.equal(Object.keys(fixture.state.tombstones.m).length, TASK_COUNT);
  assert.equal(Object.keys(fixture.state.taskMoveJournal).length, 24);
  assert.equal(Object.keys(fixture.state.deletionJournal).length, 0);
  assert.ok(Object.keys(fixture.state.g2m)[0].length >= 24, 'pressure IDs should resemble opaque provider IDs');
  assert.equal(new Set(Object.keys(fixture.state.g2m)).size, TASK_COUNT);
  assert.equal(new Set(Object.values(fixture.state.taskMoveJournal).map((entry) => entry.correlationId)).size, 24);
  assert.ok([...Object.values(fixture.state.taskMoveJournal)].every((entry) => entry.fingerprint.length >= 24));
  assert.ok([...Object.values(fixture.state.taskMoveJournal)].every((entry) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.correlationId)));
  assert.ok([...Object.keys(fixture.state.tombstones.g)].every((id) => !fixture.state.g2m[id]));
  const storage = runStressSuite().scenarios.find((item) => item.name === 'storage-pressure').metrics.storage;
  assert.ok(storage.peakBytes <= PROPERTY_STORE_HARD_LIMIT_BYTES);
  assert.equal(storage.peakGenerationCount, 3);
  assert.equal(storage.hardCeilingPass, true);
  assert.equal(storage.targetMarginPass, false);
  assert.ok(storage.targetMarginHeadroomBytes < 0);
});

test('long Unicode notes include URL/email-like payloads without provider calls', () => {
  const fixture = buildFixture({ count: TASK_COUNT, mode: 'long-notes' });
  assert.equal(fixture.googleTasks.length, TASK_COUNT);
  assert.match(fixture.googleTasks[0].notes, /工作事項/);
  assert.match(fixture.googleTasks[0].notes, /https:\/\/example\.invalid/);
  assert.match(fixture.googleTasks[0].notes, /@example\.invalid/);
});

test('1200-task storage-only cliff is explicitly unsupported and reports the overage', () => {
  const cliff = runStorageCliffProbe();
  assert.equal(cliff.supported, false);
  assert.equal(cliff.fixture.taskCount, CLIFF_TASK_COUNT);
  assert.equal(cliff.fixture.providerCalls, 0);
  assert.equal(cliff.metrics.peakGenerationCount, 3);
  assert.ok(cliff.metrics.peakBytes > PROPERTY_STORE_ACCEPTANCE_BYTES);
  assert.ok(cliff.metrics.peakBytes > cliff.metrics.hardCeilingBytes);
  assert.equal(cliff.metrics.hardCeilingPass, false);
  assert.equal(cliff.pass, false);
});
