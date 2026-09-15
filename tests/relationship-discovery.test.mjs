import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

function load() {
  const script = { values: {}, getProperty(k) { return this.values[k] || null; }, setProperty(k, v) { this.values[k] = String(v); }, deleteProperty(k) { delete this.values[k]; }, getProperties() { return { ...this.values }; }, setProperties(v) { this.values = { ...v }; } };
  const user = { ...script };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    Session: { getScriptTimeZone: () => 'Asia/Taipei', getEffectiveUser: () => ({ getEmail: () => '' }) },
    Utilities: { sleep() {}, getUuid: () => '00000000-0000-4000-8000-000000000000', newBlob: (v) => ({ getBytes: () => v, getDataAsString: () => v }), base64Encode: (v) => String(v), base64Decode: (v) => v },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }), getUserLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: { fetch: () => { throw new Error('unexpected provider call'); } },
    MailApp: { sendEmail() {}, getRemainingDailyQuota: () => 100 },
    DriveApp: {},
    FormApp: {}
  });
  runGasFilesInContext(context);
  return context;
}

function parent(id) { return { gParentId: `g-${id}`, msParentId: `ms-${id}`, msListId: 'list' }; }

test('production policy is unmeasured and schedules zero direct requests', () => {
  const c = load();
  let calls = 0;
  c.graphFetch_ = () => { calls += 1; return { value: [] }; };
  const state = c.newState_();
  const result = c.discoverRelationshipsReadOnly_(state, [parent('one')], c.relationshipDiscoveryPolicy_(), Date.now(), 'r1', Date.now());
  assert.equal(calls, 0);
  assert.equal(result.budgetStatus, 'UNMEASURED');
  assert.equal(result.scheduled, 0);
  assert.equal(result.directCollectionRequests, 0);
  assert.equal(result.graphBatchOuterRequests, 0);
  assert.equal(result.graphBatchInnerRequests, 0);
  const measuredCeilingButUnmeasured = c.discoverRelationshipsReadOnly_(state, [parent('one')], { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'UNMEASURED', maxParents: 20 }, 0, 'r1b', Date.now());
  assert.equal(measuredCeilingButUnmeasured.scheduled, 0);
  assert.equal(calls, 0);
});

test('direct GET validates and paginates complete collections', () => {
  const c = load();
  const pages = [
    { value: [{ id: 'a', displayName: 'A', isChecked: false }], '@odata.nextLink': 'https://next/1' },
    { value: [{ id: 'b', displayName: 'B', isChecked: true }] }
  ];
  const urls = [];
  c.graphFetch_ = (url, options) => { urls.push([url, options]); return pages.shift(); };
  const result = c.getMsChecklistItemsDirect_('list', 'task');
  assert.equal(result.kind, 'OBSERVED_COMPLETE');
  assert.equal(result.pageCount, 2);
  assert.equal(result.directCollectionRequests, 2);
  assert.deepEqual(Array.from(result.items, (item) => item.id), ['a', 'b']);
  assert.match(urls[0][0], /\/checklistItems\?\$top=100$/);
  assert.equal(urls[0][1].method, 'get');
});

test('later-page failure never leaks partial items and preserves prior observation', () => {
  const c = load();
  let page = 0;
  c.graphFetch_ = () => page++ === 0
    ? { value: [{ id: 'only-page-one', displayName: 'one', isChecked: false }], '@odata.nextLink': 'next' }
    : (() => { throw new Error('HTTP 500: later page'); })();
  const state = c.newState_();
  state.subtasks.parents['ms-one'] = { knowledge: 'empty', lastAttemptEpoch: 0, lastAttemptedAt: 1, lastObservedRoundId: 'old', lastObservedAt: 1, observationEpoch: 0 };
  const result = c.discoverRelationshipsReadOnly_(state, [parent('one')], { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'MEASURED', maxParents: 1 }, 0, 'new', 2);
  assert.equal(result.unobserved, 1);
  assert.equal(result.observed, 0);
  assert.equal(result.directCollectionRequests, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(result.itemsByMsParentId, 'ms-one'), false);
  assert.equal(state.subtasks.parents['ms-one'].knowledge, 'empty');
  assert.equal(state.subtasks.parents['ms-one'].observationEpoch, 0);
});

test('malformed collection pages and pagination controls classify MALFORMED', () => {
  const cases = [
    null,
    { value: {} },
    { value: [{ id: '', displayName: 'x', isChecked: false }] },
    { value: [{ id: 'x', displayName: 'x', isChecked: 'false' }] },
    { value: [], '@odata.nextLink': '' },
    { value: [], '@odata.nextLink': 'loop' },
  ];
  for (const fixture of cases) {
    const c = load();
    c.graphFetch_ = () => fixture;
    if (fixture && fixture['@odata.nextLink'] === 'loop') c.graphFetch_ = () => ({ value: [], '@odata.nextLink': 'loop' });
    assert.equal(c.classifyRelationshipReadError_((() => { try { c.getMsChecklistItemsDirect_('list', 'task'); } catch (error) { return error; } })()), 'MALFORMED');
  }
});

test('404/410 are parent-not-found while timeout/429 are unobserved', () => {
  for (const status of [404, 410]) {
    const c = load();
    c.graphFetch_ = () => { throw new Error(`HTTP ${status}: missing`); };
    const result = c.discoverRelationshipsReadOnly_(c.newState_(), [parent('one')], { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'MEASURED', maxParents: 1 }, 0, 'r', 3);
    assert.equal(result.notFound, 1);
    assert.equal(result.unobserved, 0);
  }
  for (const error of [new Error('timeout while fetching'), new Error('HTTP 429: retry')]) {
    const c = load();
    c.graphFetch_ = () => { throw error; };
    const result = c.discoverRelationshipsReadOnly_(c.newState_(), [parent('one')], { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'MEASURED', maxParents: 1 }, 0, 'r', 3);
    assert.equal(result.unobserved, 1);
    assert.equal(result.notFound, 0);
  }
});

test('metrics separate direct requests from batch requests and URL fetch delta; provider use is GET-only', () => {
  const c = load();
  vm.runInContext('SYNC_OBSERVABILITY_ = { urlFetchCalls: 7 };', c);
  const requests = [];
  c.graphFetch_ = (url, options) => {
    requests.push({ url, method: options.method });
    vm.runInContext('SYNC_OBSERVABILITY_.urlFetchCalls += 1;', c);
    return { value: [] };
  };
  const result = c.discoverRelationshipsReadOnly_(c.newState_(), [parent('one')], { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'MEASURED', maxParents: 1 }, 0, 'r', 3);
  assert.equal(result.directCollectionRequests, 1);
  assert.equal(result.graphBatchOuterRequests, 0);
  assert.equal(result.graphBatchInnerRequests, 0);
  assert.equal(result.urlFetchCallsDelta, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url.includes('$expand'), false);
  assert.equal(requests[0].url.includes('$batch'), false);
});

test('error classification and failed observations preserve prior knowledge', () => {
  const c = load();
  assert.equal(c.classifyRelationshipReadError_(new Error('HTTP 404: missing')), 'PARENT_NOT_FOUND');
  assert.equal(c.classifyRelationshipReadError_(new Error('HTTP 410: gone')), 'PARENT_NOT_FOUND');
  assert.equal(c.classifyRelationshipReadError_(new Error('HTTP 429: retry')), 'UNOBSERVED');
  assert.equal(c.classifyRelationshipReadError_(new Error('HTTP 500: retry')), 'UNOBSERVED');
  assert.equal(c.classifyRelationshipReadError_(new SyntaxError('Unexpected token')), 'MALFORMED');
  const state = c.newState_();
  state.subtasks.parents['ms-one'] = { knowledge: 'present', lastAttemptEpoch: 2, lastAttemptedAt: 10, lastObservedRoundId: 'old', lastObservedAt: 10, observationEpoch: 1 };
  const before = JSON.stringify(state.subtasks.parents['ms-one']);
  c.graphFetch_ = () => { throw new Error('HTTP 500: retry'); };
  const result = c.discoverRelationshipsReadOnly_(state, [parent('one')], { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'MEASURED', maxParents: 1 }, 0, 'r2', 20);
  assert.equal(result.unobserved, 1);
  assert.equal(JSON.stringify({ ...state.subtasks.parents['ms-one'], lastAttemptEpoch: 2, lastAttemptedAt: 10 }), before);
  assert.equal(state.subtasks.parents['ms-one'].lastAttemptEpoch, 3);
  assert.equal(state.subtasks.parents['ms-one'].knowledge, 'present');
});

test('scheduler deduplicates IDs and rotates failed parents without starvation', () => {
  const c = load();
  const state = c.newState_();
  const all = Array.from({ length: 50 }, (_, i) => parent(String(i).padStart(2, '0')));
  let calls = 0;
  c.graphFetch_ = () => { calls += 1; throw new Error('HTTP 500: fail'); };
  const policy = { architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'MEASURED', maxParents: 20 };
  for (let round = 0; round < 3; round += 1) c.discoverRelationshipsReadOnly_(state, all.concat([all[0]]), policy, 0, `r${round}`, round);
  assert.equal(calls, 60);
  assert.equal(Object.keys(state.subtasks.parents).length, 50);
  assert.deepEqual(Object.values(state.subtasks.parents).map((record) => record.knowledge), Array(50).fill('unknown'));
  assert.doesNotThrow(() => c.normalizeState_(state));
});

test('strict parent records are accepted while malformed records fail closed', () => {
  const c = load();
  const state = c.newState_();
  state.subtasks.parents['ms-one'] = { knowledge: 'empty', lastAttemptEpoch: 0, lastAttemptedAt: 1, lastObservedRoundId: 'r', lastObservedAt: 1, observationEpoch: 0 };
  assert.doesNotThrow(() => c.normalizeState_(state));
  state.subtasks.parents['ms-one'].knowledge = 'bad';
  assert.throws(() => c.normalizeState_(state), /STATE_MALFORMED/);
});
