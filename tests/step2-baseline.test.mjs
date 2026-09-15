import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../scripts/stress-600.mjs';
import {
  decideRelationshipDiscovery,
  runActualCodecCapacity,
  runStep2Baseline
} from '../scripts/step2-baseline.mjs';

const live = (classification) => ({
  source: 'live', ct: 'CT-05', sanitized: true,
  observedAt: '2026-09-08T00:00:00.000Z', classification
});

test('Step-2 decision defaults to bounded direct GET without accepted live evidence', () => {
  const fallback = decideRelationshipDiscovery();
  assert.deepEqual(fallback, {
    ct05: 'INSUFFICIENT_EVIDENCE', live: false,
    architecture: 'BOUNDED_DIRECT_GET', expandAuthoritative: false,
    expandAsSignal: false, budgetStatus: 'UNMEASURED',
    reason: 'no accepted live evidence'
  });
  assert.deepEqual(decideRelationshipDiscovery({ ...live('EXPAND_COMPLETE'), source: 'simulation' }), fallback);
  assert.deepEqual(decideRelationshipDiscovery({ ...live('EXPAND_COMPLETE'), sanitized: false }), fallback);
  assert.deepEqual(decideRelationshipDiscovery({ ...live('EXPAND_COMPLETE'), observedAt: 'not-a-date' }), fallback);
});

test('Step-2 decision maps every accepted live CT-05 classification exactly', () => {
  assert.equal(decideRelationshipDiscovery(live('EXPAND_COMPLETE')).architecture, 'EXPAND_FIRST_DIRECT_FALLBACK');
  assert.equal(decideRelationshipDiscovery(live('EXPAND_COMPLETE')).expandAuthoritative, true);
  assert.equal(decideRelationshipDiscovery(live('EXPAND_COMPLETE')).expandAsSignal, false);
  assert.equal(decideRelationshipDiscovery(live('HINT_ONLY')).architecture, 'EXPAND_SIGNAL_DIRECT_GET');
  assert.equal(decideRelationshipDiscovery(live('HINT_ONLY')).expandAuthoritative, false);
  assert.equal(decideRelationshipDiscovery(live('HINT_ONLY')).expandAsSignal, true);
  assert.equal(decideRelationshipDiscovery(live('UNRELIABLE')).architecture, 'BOUNDED_DIRECT_GET');
  assert.equal(decideRelationshipDiscovery(live('UNRELIABLE')).expandAuthoritative, false);
  assert.equal(decideRelationshipDiscovery(live('UNRELIABLE')).expandAsSignal, false);
});

test('actual capacity runner uses production codec for 100/300/600 without provider or state leakage', () => {
  const result = runActualCodecCapacity({
    fixtures: [100, 300, 600].map((count) => buildFixture({ count, shape: 'normal', mode: 'steady' }))
  });
  assert.equal(result.providerCalls, 0);
  assert.equal(result.environment, 'node-vm-gas-shim');
  assert.equal(result.actualAppsScriptRuntimeMeasured, false);
  assert.deepEqual(result.fixtures.map((item) => item.fixtureCount), [100, 300, 600]);
  for (const item of result.fixtures) {
    assert.equal(item.providerCalls, 0);
    assert.equal(item.inputSchema, 3);
    assert.equal(item.storedSchema, 4);
    assert.equal(item.roundTripPassed, true);
    assert.equal(item.preflightPassed, true);
    assert.equal(item.manifest.codec, 'gzip-base64');
    assert.equal(item.manifest.codecVersion, 1);
    assert.ok(item.manifest.chunkCount >= 1);
    assert.ok(item.manifest.uncompressedUtf8Bytes > 0);
    assert.ok(item.propertyBytes > 0);
    assert.ok(item.propertyKeyCount >= item.manifest.chunkCount + 3);
    assert.ok(item.peakGenerationCount >= 2);
    assert.equal(item.retainedGenerationCount, 1);
    assert.ok(Number.isFinite(item.timing.saveMs) && item.timing.saveMs >= 0);
    assert.ok(Number.isFinite(item.timing.loadMs) && item.timing.loadMs >= 0);
    assert.equal(JSON.stringify(item).includes('g-task'), false);
    assert.equal(JSON.stringify(item).includes('ms-task'), false);
  }
});

test('baseline structure is deterministic when timings are excluded', () => {
  const withoutTimings = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    for (const fixture of copy.capacity.fixtures) delete fixture.timing;
    for (const fixture of copy.capacity.results) delete fixture.timing;
    return copy;
  };
  assert.deepEqual(withoutTimings(runStep2Baseline()), withoutTimings(runStep2Baseline()));
});

test('baseline CLI emits compact content-safe JSON', () => {
  const run = spawnSync(process.execPath, ['scripts/step2-baseline.mjs', '--compact'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes('\n  '), false);
  const report = JSON.parse(run.stdout);
  assert.equal(report.capacity.providerCalls, 0);
  assert.equal(JSON.stringify(report).includes('g-task'), false);
  assert.equal(JSON.stringify(report).includes('ms-task'), false);
});
