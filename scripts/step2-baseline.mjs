import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildFixture } from './stress-600.mjs';
import { runGasFilesInContext } from '../tests/gas-loader.mjs';

const CAPACITY_COUNTS = Object.freeze([100, 300, 600]);
const ACCEPTED_CLASSIFICATIONS = new Set(['EXPAND_COMPLETE', 'HINT_ONLY', 'UNRELIABLE']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function acceptedCt05Evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.source !== 'live' || value.ct !== 'CT-05' || value.sanitized !== true ||
      typeof value.observedAt !== 'string' || !ISO_DATE.test(value.observedAt) ||
      !Number.isFinite(Date.parse(value.observedAt)) ||
      !ACCEPTED_CLASSIFICATIONS.has(value.classification)) return false;
  return true;
}

/**
 * Decide the relationship-discovery architecture from CT-05 evidence.
 * Simulation, provider-shaped, and malformed evidence is deliberately not
 * carried into the result and therefore cannot influence the decision.
 */
export function decideRelationshipDiscovery(ct05Evidence = null) {
  if (!acceptedCt05Evidence(ct05Evidence)) {
    return {
      ct05: 'INSUFFICIENT_EVIDENCE',
      live: false,
      architecture: 'BOUNDED_DIRECT_GET',
      expandAuthoritative: false,
      expandAsSignal: false,
      budgetStatus: 'UNMEASURED',
      reason: 'no accepted live evidence'
    };
  }
  const classification = ct05Evidence.classification;
  if (classification === 'EXPAND_COMPLETE') {
    return {
      ct05: classification,
      live: true,
      architecture: 'EXPAND_FIRST_DIRECT_FALLBACK',
      expandAuthoritative: true,
      expandAsSignal: false,
      budgetStatus: 'UNMEASURED',
      reason: 'accepted live CT-05 evidence'
    };
  }
  if (classification === 'HINT_ONLY') {
    return {
      ct05: classification,
      live: true,
      architecture: 'EXPAND_SIGNAL_DIRECT_GET',
      expandAuthoritative: false,
      expandAsSignal: true,
      budgetStatus: 'UNMEASURED',
      reason: 'accepted live CT-05 evidence'
    };
  }
  return {
    ct05: classification,
    live: true,
    architecture: 'BOUNDED_DIRECT_GET',
    expandAuthoritative: false,
    expandAsSignal: false,
    budgetStatus: 'UNMEASURED',
    reason: 'accepted live CT-05 evidence'
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function propertyStore(initial = {}) {
  const values = { ...initial };
  const countGenerations = () => new Set(Object.keys(values).flatMap((key) => {
    const match = key.match(/^sync_state_main_gen_([^_]+(?:_[^_]+)*)_(?:\d+|count|meta)$/);
    return match ? [match[1]] : [];
  })).size;
  let peakGenerationCount = countGenerations();
  const observe = () => { peakGenerationCount = Math.max(peakGenerationCount, countGenerations()); };
  return {
    values,
    get peakGenerationCount() { return peakGenerationCount; },
    getProperty: (key) => Object.hasOwn(values, key) ? values[key] : null,
    getProperties: () => ({ ...values }),
    getKeys: () => Object.keys(values),
    setProperty: (key, value) => { values[key] = String(value); observe(); },
    setProperties: (entries) => Object.entries(entries).forEach(([key, value]) => {
      values[key] = String(value); observe();
    }),
    deleteProperty: (key) => { delete values[key]; observe(); }
  };
}

function blob(value) {
  const bytes = Buffer.from(typeof value === 'string' ? value : value || []);
  return {
    getBytes: () => Array.from(bytes),
    getDataAsString: () => bytes.toString('utf8')
  };
}

function appsScriptUtilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA-256' },
    Charset: { UTF_8: 'UTF-8' },
    newBlob: blob,
    gzip: (value) => blob(gzipSync(Buffer.from(value.getBytes()))),
    ungzip: (value) => blob(gunzipSync(Buffer.from(value.getBytes()))),
    base64Encode: (value) => Buffer.from(value).toString('base64'),
    base64Decode: (value) => Array.from(Buffer.from(value, 'base64')),
    computeDigest: (_algorithm, value) => Array.from(createHash('sha256').update(value, 'utf8').digest()),
    sleep: () => {}
  };
}

function createGasHarness() {
  const userStore = propertyStore();
  const scriptStore = propertyStore({ SYNC_LIST_DISCOVERY_MODE: 'explicit' });
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => scriptStore,
      getUserProperties: () => userStore
    },
    Utilities: appsScriptUtilities(),
    LockService: {
      getUserLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }),
      getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} })
    }
  });
  // Keep serialized state and generation suffixes stable across runs. Timing
  // is measured outside the VM and remains a real local execution measurement.
  vm.runInContext(`
    const NativeDate = Date;
    function StableDate(...args) {
      return new.target ? new NativeDate(...(args.length ? args : [1788825600000]))
        : NativeDate(...(args.length ? args : [1788825600000]));
    }
    StableDate.prototype = NativeDate.prototype;
    StableDate.now = () => 1788825600000;
    StableDate.parse = NativeDate.parse;
    StableDate.UTC = NativeDate.UTC;
    Date = StableDate;
    let randomSequence = 0;
    Math.random = () => ((randomSequence++ % 1000000) + 0.5) / 1000000;
  `, context);
  runGasFilesInContext(context);
  return { context, userStore };
}

function utf8PropertyUsage(values) {
  return Object.entries(values).reduce((total, [key, value]) =>
    total + Buffer.byteLength(String(key), 'utf8') + Buffer.byteLength(String(value), 'utf8'), 0);
}

function generationCount(values) {
  const generations = new Set();
  for (const key of Object.keys(values)) {
    const match = key.match(/^sync_state_main_gen_([^_]+(?:_[^_]+)*)_(?:\d+|count|meta)$/);
    if (match) generations.add(match[1]);
  }
  return generations.size;
}

function normalizeFixtures(fixtures) {
  const requested = fixtures === undefined ? CAPACITY_COUNTS : fixtures;
  if (!Array.isArray(requested)) throw new TypeError('fixtures must be an array');
  return requested.map((fixture) => {
    const value = typeof fixture === 'number'
      ? buildFixture({ count: fixture, shape: 'normal', mode: 'steady' })
      : fixture;
    if (!value || value.mode !== 'steady' || value.shape !== 'normal' ||
        !CAPACITY_COUNTS.includes(value.count) || value.state?.schema !== 3) {
      throw new TypeError('Step-2 capacity fixtures must be steady schema-3 fixtures at 100, 300, or 600');
    }
    return value;
  });
}

function runOneCapacityFixture(fixture) {
  const { context, userStore } = createGasHarness();
  const state = clone(fixture.state);
  let maxGenerations = userStore.peakGenerationCount;
  const updatePeak = () => { maxGenerations = Math.max(maxGenerations, userStore.peakGenerationCount); };
  const startedSave = process.hrtime.bigint();
  context.saveState_(state);
  updatePeak();
  context.saveState_(state);
  updatePeak();
  context.saveState_(state);
  updatePeak();
  const saveMs = Number(process.hrtime.bigint() - startedSave) / 1e6;
  const startedLoad = process.hrtime.bigint();
  const inspected = context.loadStateForInspection_();
  const loadMs = Number(process.hrtime.bigint() - startedLoad) / 1e6;
  const expectedState = context.normalizeState_(clone(state));
  const roundTripPassed = inspected && inspected.corrupt === false &&
    JSON.stringify(inspected.state) === JSON.stringify(expectedState);
  if (!roundTripPassed) throw new Error(`Step-2 codec round trip failed for ${fixture.count}`);

  const manifest = JSON.parse(userStore.values.sync_state_main_manifest);
  const propertyValues = userStore.getProperties();
  const propertyBytes = utf8PropertyUsage(propertyValues);
  const propertyKeyCount = Object.keys(propertyValues).length;
  return {
    fixtureCount: fixture.count,
    inputSchema: state.schema,
    storedSchema: inspected.state.schema,
    providerCalls: 0,
    roundTripPassed: true,
    propertyBytes,
    propertyKeyCount,
    manifest: {
      chunkCount: Number(manifest.count),
      codec: manifest.codec,
      codecVersion: Number(manifest.codecVersion),
      uncompressedUtf8Bytes: Number(manifest.uncompressedUtf8Bytes)
    },
    timing: { saveMs, loadMs },
    preflightPassed: true,
    retainedGenerationCount: generationCount(propertyValues),
    peakGenerationCount: maxGenerations,
    environment: 'node-vm-gas-shim',
    actualAppsScriptRuntimeMeasured: false
  };
}

/** Run actual production GAS codec writes/reads for the supplied fixtures. */
export function runActualCodecCapacity({ fixtures } = {}) {
  const results = normalizeFixtures(fixtures).map(runOneCapacityFixture);
  return {
    fixtures: results,
    results,
    providerCalls: 0,
    environment: 'node-vm-gas-shim',
    actualAppsScriptRuntimeMeasured: false
  };
}

export function runStep2Baseline() {
  return {
    step: 'step2-baseline',
    decision: decideRelationshipDiscovery(),
    capacity: runActualCodecCapacity({ fixtures: CAPACITY_COUNTS })
  };
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const report = runStep2Baseline();
  process.stdout.write(JSON.stringify(report, null, process.argv.includes('--compact') ? 0 : 2) + '\n');
}
