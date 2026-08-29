import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Deterministic, provider-free capacity model for the next sync release.
 *
 * This deliberately does not import Code.gs or make network calls.  It models
 * the inventory/write protocol with fixed provider costs and measures the
 * serialized state that the gzip+Base64 storage adapter would put in User
 * Properties. Fixtures remain deterministic, but pressure cases deliberately
 * use high-entropy provider-shaped IDs, UUIDs, timestamps, and fingerprints.
 */

export const TASK_COUNT = 600;
export const CLIFF_TASK_COUNT = 1200;
export const RUN_LIMIT_MS = 5.25 * 60 * 1000;
export const PROPERTY_VALUE_SAFE_LIMIT_BYTES = 8 * 1024;
export const PROPERTY_STORE_HARD_LIMIT_BYTES = 450 * 1024;
export const PROPERTY_STORE_ACCEPTANCE_BYTES = 225 * 1024;
export const PEAK_GENERATION_COUNT = 3;
const SATURATION_MODES = new Set(['moves', 'storage-pressure']);
export const STORAGE_CHUNK_CHARS = 7000;
export const PAGE_SIZE = 100;

const FIXED_NOW = '2026-08-29T00:00:00.000Z';
const SEED = 'tasks-todo-sync-600-corner-v1';

const COST = Object.freeze({
  listInventoryMs: 18,
  pageFetchMs: 72,
  taskCompareMs: 1,
  taskWriteMs: 24,
  journalMs: 4,
  remoteDeleteMs: 30,
  stateSaveMs: 180
});

const SUPPORTED_SCENARIOS = Object.freeze([
  { name: 'dense-1x600', shape: 'dense' },
  { name: 'sparse-60x10', shape: 'sparse' },
  { name: 'steady-state', shape: 'normal', mode: 'steady' },
  { name: 'bidirectional-changes', shape: 'normal', mode: 'bidirectional' },
  { name: 'completions', shape: 'normal', mode: 'completions' },
  { name: 'deletions-tombstones', shape: 'normal', mode: 'deletions' },
  { name: 'moves-journals', shape: 'normal', mode: 'moves' },
  { name: 'long-unicode-notes', shape: 'normal', mode: 'long-notes' },
  { name: 'storage-pressure', shape: 'normal', mode: 'storage-pressure' },
  { name: 'injected-408', shape: 'normal', mode: 'failure', fault: 'HTTP_408' },
  { name: 'injected-429', shape: 'normal', mode: 'failure', fault: 'HTTP_429' },
  { name: 'injected-500', shape: 'normal', mode: 'failure', fault: 'HTTP_500' },
  { name: 'injected-time-budget', shape: 'normal', mode: 'failure', fault: 'TIME_BUDGET' },
  { name: 'injected-property-failure', shape: 'normal', mode: 'failure', fault: 'STATE_STORE_LIMIT' }
]);

function pad(value, width = 4) {
  return String(value).padStart(width, '0');
}

function opaqueId(kind, index, length = 24) {
  // Domain-separate each provider table through the hash input while keeping
  // the persisted value opaque rather than prefixing it with fixture labels.
  return createHash('sha256').update(`${SEED}:${kind}:${index}`).digest('hex').slice(0, length);
}

function fixtureId(kind, index, mode) {
  // Every persisted mapping corner uses provider-shaped opaque IDs; using
  // sequential IDs in ordinary corners would make their gzip estimate false.
  return opaqueId(kind, index, mode === 'cliff' ? 40 : 24);
}

function variedTimestamp(index, offsetHours = 0) {
  const digest = createHash('sha256').update(`${SEED}:timestamp:${index}`).digest();
  const jitterMs = digest.readUInt32BE(0) % (365 * 24 * 60 * 60 * 1000);
  return new Date(Date.parse(FIXED_NOW) + offsetHours * 60 * 60 * 1000 + jitterMs).toISOString();
}

function deterministicUuid(kind, index) {
  const bytes = Buffer.from(createHash('sha256').update(`${SEED}:uuid:${kind}:${index}`).digest('hex').slice(0, 32), 'hex');
  // RFC 4122 v4/variant bits, with deterministic high-entropy payload.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function variedFingerprint(kind, index, length = 160) {
  let value = '';
  let round = 0;
  while (value.length < length) {
    value += createHash('sha512')
      .update(`${SEED}:fingerprint:${kind}:${index}:${round}`)
      .digest('base64url');
    round += 1;
  }
  return value.slice(0, length);
}

function journalFingerprint(gId, pairRecord, targetMsListId, mode) {
  const canonical = JSON.stringify({
    gId,
    oldMsId: pairRecord.msId,
    gListId: pairRecord.gListId,
    oldMsListId: pairRecord.msListId,
    targetMsListId,
    gUpdated: pairRecord.gUpdated,
    oldMsUpdated: pairRecord.msUpdated,
    mode
  });
  return `sha256b64:${createHash('sha256').update(canonical, 'utf8').digest('base64')}`;
}

function listCountFor(shape) {
  return shape === 'dense' ? 1 : shape === 'sparse' ? 60 : 6;
}

function listIndexFor(index, shape) {
  return shape === 'dense' ? 0 : shape === 'sparse' ? Math.floor(index / 10) : Math.floor(index / 100);
}

function unicodeNote(index) {
  // Mix stable, non-ASCII and URL/email-like tokens.  Repeated structural text
  // makes gzip realistic while the indexed values prevent an unrealistically
  // perfect compression ratio.
  const token = pad(index);
  const entropy = createHash('sha256').update(`${SEED}:note:${index}`).digest('base64url').slice(0, 32);
  return [
    `工作事項 ${token}｜同步壓力測試｜繁體中文`,
    `這是一段長備註，用來測量 600 筆狀態在壓縮後的容量。任務-${token} 包含 emoji 😀🧪🚀、全形標點，以及跨服務同步證據。`,
    `https://example.invalid/tasks/${token}/source?provider=google&round=${token}`,
    `owner-${token}@example.invalid; backup-${token}@example.invalid`,
    `line-${token}: alpha beta gamma delta; entropy=${entropy}; ${'內容片段 '.repeat(18)}`
  ].join('\n');
}

function storageFingerprint(index, provider) {
  return `${provider}|${variedFingerprint(provider, index, 160)}|工作事項|證據`;
}

function task(index, provider, shape, mode) {
  const token = pad(index);
  const listIndex = listIndexFor(index, shape);
  const base = {
    id: fixtureId(`${provider}-task`, index, mode),
    listId: fixtureId(`${provider}-list`, listIndex, mode),
    title: `Fixture ${provider} task ${token}`,
    notes: mode === 'long-notes' ? unicodeNote(index) : mode === 'storage-pressure' ? storageFingerprint(index, provider) : `Fixture note ${token}`,
    status: 'needsAction',
    updated: variedTimestamp(index)
  };
  if (mode === 'bidirectional') {
    base.title += provider === 'g' ? ' · Google edit' : ' · Microsoft edit';
    base.updated = variedTimestamp(index, 1);
  }
  if (mode === 'completions') base.status = 'completed';
  if (mode === 'moves') base.listId = fixtureId(`${provider}-list`, (listIndex + 1) % listCountFor(shape), mode);
  return base;
}

function pair(index, shape, mode) {
  const token = pad(index);
  const listIndex = listIndexFor(index, shape);
  const gListId = fixtureId('g-list', listIndex, mode);
  const msListId = fixtureId('ms-list', listIndex, mode);
  const record = {
    msId: fixtureId('ms-task', index, mode),
    gListId,
    msListId,
    gUpdated: variedTimestamp(index),
    msUpdated: variedTimestamp(index)
  };
  return record;
}

function emptyState() {
  return {
    schema: 3,
    listMap: {},
    g2m: {},
    m2g: {},
    tombstones: { g: {}, m: {} },
    pendingTaskDeletions: {},
    deletionJournal: {},
    taskMoveJournal: {},
    taskDeletionConflicts: {},
    listPairMeta: {},
    pendingListDeletions: {},
    listDeletionJournal: {},
    listDeletionConflicts: {},
    listTombstones: { g: {}, ms: {} },
    listTombstoneNames: { g: {}, ms: {} },
    listFaults: { g: {}, ms: {} },
    health: {
      lastSuccessfulSyncAt: null,
      lastFailedSyncAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
      lastSuccessfulRoundId: null,
      roundFenceProjectionId: null
    },
    updatedAt: FIXED_NOW
  };
}

function addStateRecords(state, index, shape, mode) {
  const token = pad(index);
  const gId = fixtureId('g-task', index, mode);
  const p = pair(index, shape, mode);
  state.g2m[gId] = p;
  state.m2g[p.msId] = gId;
  if (mode === 'deletions') {
    // Deletion candidates are represented separately from the active mapping;
    // a live mapping and tombstone for the same provider ID is impossible.
    state.tombstones.g[fixtureId('g-deleted', index, mode)] = { at: FIXED_NOW, source: 'google' };
    state.tombstones.m[fixtureId('ms-deleted', index, mode)] = { at: FIXED_NOW, source: 'microsoft' };
    state.pendingTaskDeletions[gId] = {
      gId, msId: p.msId, missingSide: index % 2 ? 'g' : 'm',
      gListId: p.gListId, msListId: p.msListId, gUpdated: p.gUpdated, msUpdated: p.msUpdated,
      firstConfirmedAt: FIXED_NOW, lastConfirmedAt: FIXED_NOW, lastRoundId: 'round-delete-1', confirmations: 1
    };
  }
  if (mode === 'storage-pressure') {
    // Keep 600 active pairs and 600 distinct, recent deleted pairs so the
    // storage test exercises retention without self-contradictory state.
    const deletedGId = fixtureId('g-deleted', index, mode);
    const deletedMsId = fixtureId('ms-deleted', index, mode);
    state.tombstones.g[deletedGId] = { at: FIXED_NOW, source: 'google' };
    state.tombstones.m[deletedMsId] = { at: FIXED_NOW, source: 'microsoft' };
  }
  if (mode === 'moves' || mode === 'cliff' || (mode === 'storage-pressure' && index < 24)) {
    state.taskMoveJournal[gId] = {
      phase: 'creating', gId, oldMsId: p.msId,
      gListId: p.gListId, oldMsListId: p.msListId, targetMsListId: fixtureId('ms-list', (index + 1) % listCountFor(shape), mode),
      gUpdated: p.gUpdated, oldMsUpdated: p.msUpdated, preparedAt: FIXED_NOW,
      fingerprint: journalFingerprint(gId, p,
        fixtureId('ms-list', (index + 1) % listCountFor(shape), mode), mode),
      correlationId: deterministicUuid(mode, index),
      uncertainConfirmations: 0
    };
  }
}

const STATE_RECORD_FIELDS = Object.freeze({
  g2m: ['msId', 'gListId', 'msListId', 'gUpdated', 'msUpdated'],
  pendingTaskDeletions: ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
    'firstConfirmedAt', 'lastConfirmedAt', 'lastRoundId', 'confirmations'],
  deletionJournal: ['phase', 'gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
    'preparedAt', 'lastBlockedReason', 'lastBlockedAt'],
  taskMoveJournal: ['phase', 'gId', 'oldMsId', 'newMsId', 'gListId', 'oldMsListId',
    'targetMsListId', 'gUpdated', 'oldMsUpdated', 'preparedAt', 'fingerprint',
    'correlationId', 'uncertainConfirmations', 'lastRoundId', 'lastBlockedReason', 'lastBlockedAt'],
  tombstones: ['at', 'source']
});

export function assertExactStateShape(state) {
  const topLevel = ['schema', 'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskMoveJournal', 'taskDeletionConflicts', 'listPairMeta',
    'pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts',
    'listTombstones', 'listTombstoneNames', 'listFaults', 'health', 'updatedAt'];
  if (state.schema !== 3 || Object.keys(state).some((key) => !topLevel.includes(key))) {
    throw new Error('FIXTURE_SCHEMA_INVALID: unexpected top-level state field');
  }
  for (const field of ['listMap', 'g2m', 'm2g', 'pendingTaskDeletions', 'deletionJournal', 'taskMoveJournal',
    'taskDeletionConflicts', 'listPairMeta', 'pendingListDeletions', 'listDeletionJournal',
    'listDeletionConflicts']) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error(`FIXTURE_SCHEMA_INVALID: ${field} must be an object`);
    }
  }
  for (const field of ['g2m', 'pendingTaskDeletions', 'deletionJournal', 'taskMoveJournal']) {
    for (const [id, record] of Object.entries(state[field])) {
      if (Object.keys(record).some((key) => !STATE_RECORD_FIELDS[field].includes(key))) {
        throw new Error(`FIXTURE_SCHEMA_INVALID: ${field}[${id}] has an unknown field`);
      }
    }
  }
  for (const side of ['g', 'm']) {
    if (!state.tombstones[side] || typeof state.tombstones[side] !== 'object') {
      throw new Error(`FIXTURE_SCHEMA_INVALID: tombstones.${side} must be an object`);
    }
    for (const [id, record] of Object.entries(state.tombstones[side])) {
      if (Object.keys(record).some((key) => !STATE_RECORD_FIELDS.tombstones.includes(key))) {
        throw new Error(`FIXTURE_SCHEMA_INVALID: tombstones.${side}[${id}] has an unknown field`);
      }
    }
  }
  if (Object.keys(state.g2m).some((gId) => state.tombstones.g[gId]) ||
      Object.values(state.g2m).some((record) => state.tombstones.m[record.msId])) {
    throw new Error('FIXTURE_SCHEMA_INVALID: active mapping overlaps a tombstone');
  }
  const msIds = Object.values(state.g2m).map((record) => record.msId);
  if (new Set(msIds).size !== msIds.length) throw new Error('FIXTURE_SCHEMA_INVALID: duplicate mapped Microsoft ID');
  for (const [gId, journal] of Object.entries(state.taskMoveJournal)) {
    const mapping = state.g2m[gId];
    if (!mapping || journal.gId !== gId || journal.oldMsId !== mapping.msId ||
        journal.oldMsListId !== mapping.msListId || journal.phase !== 'creating' ||
        !journal.targetMsListId || !journal.fingerprint || !journal.preparedAt ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.correlationId)) {
      throw new Error(`FIXTURE_SCHEMA_INVALID: taskMoveJournal[${gId}] is not a valid creating journal`);
    }
  }
  return true;
}

export function buildFixture({ count = TASK_COUNT, shape = 'normal', mode = 'steady', fault = null } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be a positive integer');
  const listCount = listCountFor(shape);
  const googleLists = Array.from({ length: listCount }, (_, i) => ({
    id: fixtureId('g-list', i, mode), title: `Fixture list ${pad(i, 2)}`
  }));
  const microsoftLists = Array.from({ length: listCount }, (_, i) => ({
    id: fixtureId('ms-list', i, mode), displayName: `Fixture list ${pad(i, 2)}`
  }));
  const googleTasks = Array.from({ length: count }, (_, i) => task(i, 'g', shape, mode));
  const microsoftTasks = Array.from({ length: count }, (_, i) => task(i, 'ms', shape, mode));
  const state = emptyState();
  for (let i = 0; i < listCount; i++) state.listMap[googleLists[i].id] = microsoftLists[i].id;
  for (let i = 0; i < count; i++) addStateRecords(state, i, shape, mode);
  assertExactStateShape(state);
  return {
    count,
    shape,
    mode,
    fault,
    googleLists,
    microsoftLists,
    googleTasks,
    microsoftTasks,
    state
  };
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

export function storageMetrics(state) {
  assertExactStateShape(state);
  const raw = JSON.stringify(state);
  // Use node:zlib's default level as a provider-free approximation. Apps
  // Script's Utilities.gzip settings must still be measured in the GAS gate.
  const compressed = gzipSync(Buffer.from(raw, 'utf8'));
  const encoded = compressed.toString('base64');
  const chunks = [];
  for (let i = 0; i < encoded.length; i += STORAGE_CHUNK_CHARS) chunks.push(encoded.slice(i, i + STORAGE_CHUNK_CHARS));
  const generation = `sync_state_main_gen_fixture_`;
  const chunkBytes = chunks.reduce((total, value, i) => total + utf8Bytes(`${generation}${i}`) + utf8Bytes(value), 0);
  const countBytes = utf8Bytes(`${generation}count`) + utf8Bytes(String(chunks.length));
  const codec = {
    codec: 'gzip-base64', codecVersion: 1,
    integrity: { algorithm: 'SHA-256', encoding: 'base64', value: '0'.repeat(44) },
    uncompressedUtf8Bytes: utf8Bytes(raw)
  };
  const generationMeta = JSON.stringify(codec);
  const manifest = JSON.stringify({ generation: 'fixture', count: chunks.length, previousGeneration: 'previous', ...codec });
  const mutableManifestBytes = utf8Bytes('sync_state_main_manifest') + utf8Bytes(manifest);
  const generationMetadataBytes = utf8Bytes(`${generation}meta`) + utf8Bytes(generationMeta);
  // A save temporarily retains current, previous ordinary, two successful-round
  // generations, and the candidate generation. The mutable pointer manifest is
  // a single key/value, not a copy in every generation.
  const generationBytes = chunkBytes + countBytes + generationMetadataBytes;
  const roundManifestBytes = utf8Bytes('sync_state_main_successful_round_manifest') + utf8Bytes(JSON.stringify({
    version: 1, current: { generation: 'fixture', roundId: 'round-fixture' },
    previous: { generation: 'previous', roundId: 'round-previous' }
  }));
  const peakBytes = generationBytes * PEAK_GENERATION_COUNT + mutableManifestBytes + roundManifestBytes;
  return {
    rawBytes: utf8Bytes(raw),
    compressedBytes: compressed.byteLength,
    encodedChars: encoded.length,
    chunkCount: chunks.length,
    generationBytes,
    oneGenerationBytes: generationBytes,
    generationMetadataBytes,
    mutableManifestBytes,
    roundManifestBytes,
    codecManifestBytes: mutableManifestBytes + generationMetadataBytes,
    compressionModel: 'node-zlib-default-gzip-base64',
    peakGenerationCount: PEAK_GENERATION_COUNT,
    peakBytes,
    peakKiB: Number((peakBytes / 1024).toFixed(2)),
    hardCeilingBytes: PROPERTY_STORE_HARD_LIMIT_BYTES,
    hardCeilingPass: peakBytes <= PROPERTY_STORE_HARD_LIMIT_BYTES,
    hardHeadroomBytes: PROPERTY_STORE_HARD_LIMIT_BYTES - peakBytes,
    hardHeadroomPct: Number(((PROPERTY_STORE_HARD_LIMIT_BYTES - peakBytes) / PROPERTY_STORE_HARD_LIMIT_BYTES * 100).toFixed(2)),
    targetMarginBytes: PROPERTY_STORE_ACCEPTANCE_BYTES,
    targetMarginPass: peakBytes <= PROPERTY_STORE_ACCEPTANCE_BYTES,
    targetMarginHeadroomBytes: PROPERTY_STORE_ACCEPTANCE_BYTES - peakBytes,
    targetMarginHeadroomPct: Number(((PROPERTY_STORE_ACCEPTANCE_BYTES - peakBytes) / PROPERTY_STORE_ACCEPTANCE_BYTES * 100).toFixed(2)),
    // Backward-compatible aliases for consumers of the first report format.
    acceptanceLimitBytes: PROPERTY_STORE_ACCEPTANCE_BYTES,
    headroomBytes: PROPERTY_STORE_ACCEPTANCE_BYTES - peakBytes,
    headroomPct: Number(((PROPERTY_STORE_ACCEPTANCE_BYTES - peakBytes) / PROPERTY_STORE_ACCEPTANCE_BYTES * 100).toFixed(2)),
    perValueLimitBytes: PROPERTY_VALUE_SAFE_LIMIT_BYTES,
    largestChunkBytes: Math.max(...chunks.map(utf8Bytes))
  };
}

function countDuplicates(items) {
  const ids = items.map((item) => item.id);
  return ids.length - new Set(ids).size;
}

function inventoryCost(fixture) {
  const listCalls = fixture.googleLists.length + fixture.microsoftLists.length;
  const pagesFor = (lists, tasks) => lists.reduce((total, list) => {
    const count = tasks.filter((taskItem) => taskItem.listId === list.id).length;
    return total + Math.max(1, Math.ceil(count / PAGE_SIZE));
  }, 0);
  const pages = pagesFor(fixture.googleLists, fixture.googleTasks) + pagesFor(fixture.microsoftLists, fixture.microsoftTasks);
  return {
    listCalls,
    pageCalls: pages,
    taskCount: fixture.googleTasks.length,
    listInventoryMs: listCalls * COST.listInventoryMs,
    pageFetchMs: pages * COST.pageFetchMs
  };
}

function simulateProviderFreeSync(fixture) {
  const inventory = inventoryCost(fixture);
  const metrics = {
    taskCount: fixture.count,
    googleTaskCount: fixture.googleTasks.length,
    microsoftTaskCount: fixture.microsoftTasks.length,
    googleListCount: fixture.googleLists.length,
    microsoftListCount: fixture.microsoftLists.length,
    listCalls: inventory.listCalls,
    pageCalls: inventory.pageCalls,
    duplicateGoogleIds: countDuplicates(fixture.googleTasks),
    duplicateMicrosoftIds: countDuplicates(fixture.microsoftTasks),
    exactCounts: fixture.googleTasks.length === fixture.count && fixture.microsoftTasks.length === fixture.count,
    // This remains zero by construction: all provider interaction is mocked.
    providerCalls: 0,
    simulatedProviderCalls: inventory.listCalls + inventory.pageCalls,
    actions: 0,
    googleChanges: 0,
    microsoftChanges: 0,
    lwwConflicts: 0,
    journals: Object.keys(fixture.state.deletionJournal).length + Object.keys(fixture.state.taskMoveJournal).length,
    deletionJournalCount: Object.keys(fixture.state.deletionJournal).length,
    taskMoveJournalCount: Object.keys(fixture.state.taskMoveJournal).length,
    tombstones: Object.keys(fixture.state.tombstones.g).length + Object.keys(fixture.state.tombstones.m).length,
    committed: false,
    outcome: 'success',
    errorCode: null
  };

  const mode = fixture.mode;
  if (mode === 'bidirectional') {
    metrics.googleChanges = fixture.count;
    metrics.microsoftChanges = fixture.count;
    metrics.lwwConflicts = fixture.count;
    // One winner is written per simultaneous-edit pair, not two writes.
    metrics.actions = fixture.count;
  }
  if (mode === 'completions') metrics.actions = fixture.count;
  if (mode === 'deletions') metrics.actions = fixture.count * 2;
  if (mode === 'moves') metrics.actions = fixture.count * 2;

  const actionCost = metrics.actions * COST.taskWriteMs;
  const journalCost = metrics.journals * COST.journalMs;
  const deleteCost = mode === 'deletions' ? fixture.count * COST.remoteDeleteMs : 0;
  let virtualElapsedMs = inventory.listInventoryMs + inventory.pageFetchMs + fixture.count * COST.taskCompareMs + actionCost + journalCost + deleteCost;
  const storage = storageMetrics(fixture.state);
  virtualElapsedMs += COST.stateSaveMs + Math.ceil(storage.compressedBytes / 1024);

  if (fixture.fault === 'HTTP_408' || fixture.fault === 'HTTP_429' || fixture.fault === 'HTTP_500') {
    metrics.outcome = 'provider_failure';
    metrics.errorCode = fixture.fault;
    metrics.simulatedProviderCalls += 1;
    metrics.committed = false;
  } else if (fixture.fault === 'TIME_BUDGET') {
    metrics.outcome = 'time_budget';
    metrics.errorCode = 'TIME_BUDGET_SYNC';
    virtualElapsedMs = RUN_LIMIT_MS;
    metrics.committed = false;
  } else if (fixture.fault === 'STATE_STORE_LIMIT') {
    metrics.outcome = 'storage_failure';
    metrics.errorCode = 'STATE_STORE_LIMIT';
    metrics.committed = false;
  } else {
    metrics.committed = true;
  }
  const finalTaskIds = new Set(fixture.googleTasks.map((item) => item.id));
  metrics.duplicateCount = metrics.duplicateGoogleIds + metrics.duplicateMicrosoftIds;
  metrics.integrity = metrics.exactCounts && metrics.duplicateCount === 0 && finalTaskIds.size === fixture.count;
  return {
    ...metrics,
    // Synthetic fixed-cost timing is useful for branch ordering and margin
    // arithmetic only; it is not evidence of Apps Script wall-clock speed.
    timingModel: 'synthetic-fixed-cost-not-a-GAS-benchmark',
    syntheticVirtualElapsedMs: virtualElapsedMs,
    virtualElapsedMs,
    marginMs: Math.max(0, RUN_LIMIT_MS - virtualElapsedMs),
    marginPct: Number((Math.max(0, RUN_LIMIT_MS - virtualElapsedMs) / RUN_LIMIT_MS * 100).toFixed(2)),
    storage
  };
}

export function runScenario(spec) {
  const fixture = buildFixture({
    count: TASK_COUNT,
    shape: spec.shape,
    mode: spec.mode || 'steady',
    fault: spec.fault || null
  });
  const result = simulateProviderFreeSync(fixture);
  // A pressure corner is only a refusal probe when the production peak still
  // exceeds the hard ceiling. If three generations fit, it is a supported
  // capacity-survival corner with a separately reported target-margin miss.
  const saturationProbe = SATURATION_MODES.has(fixture.mode) && !result.storage.hardCeilingPass;
  const reportedMetrics = saturationProbe
    ? { ...result, committed: false, outcome: 'storage_refusal', errorCode: 'STATE_STORE_LIMIT' }
    : result;
  const expectedPass = saturationProbe
    ? result.integrity && !result.storage.hardCeilingPass
    : result.integrity && result.storage.hardCeilingPass &&
      (result.outcome === 'success' ? result.virtualElapsedMs < RUN_LIMIT_MS : true);
  return {
    name: spec.name,
    supported: !saturationProbe,
    classification: saturationProbe ? 'exact-600-storage-saturation-probe' : 'supported-capacity-corner',
    expectedStorageRefusal: saturationProbe,
    fixture: {
      taskCount: fixture.count,
      googleTaskCount: fixture.googleTasks.length,
      microsoftTaskCount: fixture.microsoftTasks.length,
      googleListCount: fixture.googleLists.length,
      microsoftListCount: fixture.microsoftLists.length,
      shape: fixture.shape,
      mode: fixture.mode
    },
    metrics: reportedMetrics,
    pass: expectedPass
  };
}

export function runStorageCliffProbe() {
  const fixture = buildFixture({ count: CLIFF_TASK_COUNT, shape: 'normal', mode: 'cliff' });
  const storage = storageMetrics(fixture.state);
  return {
    name: 'unsupported-storage-only-1200',
    supported: false,
    fixture: { taskCount: fixture.count, mode: fixture.mode, providerCalls: 0 },
    metrics: storage,
    note: 'Storage-only cliff probe; not a provider-sync support claim.',
    pass: storage.hardCeilingPass
  };
}

export function runStressSuite() {
  const scenarios = SUPPORTED_SCENARIOS.map(runScenario);
  const cliff = runStorageCliffProbe();
  const supportedScenarios = scenarios.filter((scenario) => scenario.supported);
  const saturationProbes = scenarios.filter((scenario) => scenario.expectedStorageRefusal);
  const supportedPassed = supportedScenarios.filter((scenario) => scenario.pass).length;
  const saturationProbesPassed = saturationProbes.filter((scenario) => scenario.pass).length;
  return {
    schemaVersion: 1,
    seed: SEED,
    generatedAt: FIXED_NOW,
    deterministic: true,
    providerCalls: 0,
    realAppsScriptBenchmarkRequired: true,
    realAppsScriptBenchmark: { status: 'not-run', note: 'Run the same fixtures in Apps Script before changing cadence or support claims.' },
    timingNote: 'All elapsed values are synthetic fixed-cost models, not Apps Script wall-clock measurements.',
    syntheticModelExcludes: [
      'OAuth2 latency', 'Apps Script UserProperties quota contention',
      'round-fence writes', 'move receipt writes', 'arbitrary unrelated properties',
      'legacy raw-state migration overhead'
    ],
    runtimePreflightNote: 'The real runtime preflight includes these costs; legacy migration may be worse. Run the Apps Script benchmark before changing support or cadence claims.',
    taskCountPerSupportedCorner: TASK_COUNT,
    runLimitMs: RUN_LIMIT_MS,
    propertyHardCeilingBytes: PROPERTY_STORE_HARD_LIMIT_BYTES,
    propertyTargetMarginBytes: PROPERTY_STORE_ACCEPTANCE_BYTES,
    peakGenerationCount: PEAK_GENERATION_COUNT,
    scenarios,
    storageCliffProbe: cliff,
    summary: {
      supportedScenarioCount: supportedScenarios.length,
      supportedPassed,
      supportedFailed: supportedScenarios.length - supportedPassed,
      allSupportedPassed: supportedPassed === supportedScenarios.length,
      saturationProbeCount: saturationProbes.length,
      saturationProbesPassed,
      allSaturationProbesPassed: saturationProbesPassed === saturationProbes.length,
      worstVirtualElapsedMs: Math.max(...scenarios.map((scenario) => scenario.metrics.virtualElapsedMs)),
      lowestHardStorageHeadroomBytes: Math.min(...scenarios.map((scenario) => scenario.metrics.storage.hardHeadroomBytes)),
      targetMarginFailureCount: scenarios.filter((scenario) => !scenario.metrics.storage.targetMarginPass).length,
      targetMarginFailureScenarios: scenarios.filter((scenario) => !scenario.metrics.storage.targetMarginPass).map((scenario) => scenario.name),
      cliffExceedsHardCeiling: cliff.metrics.peakBytes > PROPERTY_STORE_HARD_LIMIT_BYTES,
      cliffExceedsTargetMargin: cliff.metrics.peakBytes > PROPERTY_STORE_ACCEPTANCE_BYTES
    }
  };
}

export function stressExitCode(report) {
  return report.summary.allSupportedPassed && report.summary.allSaturationProbesPassed &&
    report.summary.cliffExceedsHardCeiling ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = runStressSuite();
  const compact = process.argv.includes('--compact');
  process.stdout.write(JSON.stringify(report, null, compact ? 0 : 2) + '\n');
  process.exitCode = stressExitCode(report);
}
