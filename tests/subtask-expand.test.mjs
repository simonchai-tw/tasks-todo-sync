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

// Values produced inside the vm context have a different Object.prototype;
// round-trip them before deepStrictEqual against test-realm literals.
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function makeFixture(c, entries) {
  const state = c.newState_();
  const snap = { safety: { enableSubtasks: true }, gTasksById: {}, msListByTask: {} };
  entries.forEach(function(e) {
    state.g2m[e.gParentId] = { msId: e.msParentId, msListId: e.msListId };
    snap.gTasksById[e.gParentId] = { id: e.gParentId };
    snap.msListByTask[e.msParentId] = e.msListId;
  });
  return { state, snap };
}

function observation(items) {
  return { kind: 'OBSERVED_COMPLETE', items: items, directCollectionRequests: 1 };
}

test('P1-2 case 1: expand 可用時所有 parent 取自展開，逐父 GET 為 0，completeness record 已更新', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-1', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-2', msListId: 'list-A' }
  ]);
  let expandCalls = 0;
  let directCalls = 0;
  c.getMsTasksWithChecklistItems_ = (listId) => {
    expandCalls += 1;
    assert.equal(listId, 'list-A');
    return [
      { id: 'ms-1', checklistItems: [{ id: 'c-1', displayName: 'One', isChecked: false }] },
      { id: 'ms-2', checklistItems: [
        { id: 'c-2a', displayName: 'Two-A', isChecked: true },
        { id: 'c-2b', displayName: 'Two-B', isChecked: false }
      ] }
    ];
  };
  c.getMsChecklistItemsDirect_ = () => { directCalls += 1; return observation([]); };
  const result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-1', 1000);
  assert.equal(expandCalls, 1);
  assert.equal(directCalls, 0);
  assert.equal(result.directCollectionRequests, 0);
  assert.deepEqual(plain(snap.msChecklistItemsByParentId), {
    'ms-1': [{ id: 'c-1', displayName: 'One', isChecked: false }],
    'ms-2': [
      { id: 'c-2a', displayName: 'Two-A', isChecked: true },
      { id: 'c-2b', displayName: 'Two-B', isChecked: false }
    ]
  });
  assert.equal(state.subtasks.parents['ms-1'].lastObservedRoundId, 'round-1');
  assert.equal(state.subtasks.parents['ms-2'].lastObservedRoundId, 'round-1');
  assert.equal(c.subtaskObservationComplete_(state, snap, 'ms-1', 'round-1'), true);
  // 展開成功的 parent 數計入報表，但不膨脹真實逐父 GET 計數
  assert.equal(result.observed, 2);
  assert.equal(result.scheduled, 2);
  assert.equal(result.attempted, 2);
});

test('P1-2 case 2: 0 項任務 (無 checklistItems 屬性) 視為空集合，不觸發逐父 fallback', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-empty', msListId: 'list-A' }
  ]);
  let directCalls = 0;
  c.getMsTasksWithChecklistItems_ = () => [{ id: 'ms-empty' }];
  c.getMsChecklistItemsDirect_ = () => {
    directCalls += 1;
    return observation([{ id: 'should-not-be-used', displayName: 'X', isChecked: false }]);
  };
  const result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-2', 2000);
  assert.equal(directCalls, 0);
  assert.equal(result.directCollectionRequests, 0);
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-empty']), []);
  assert.equal(state.subtasks.parents['ms-empty'].knowledge, 'empty');
  assert.equal(state.subtasks.parents['ms-empty'].lastObservedRoundId, 'round-2');
  assert.equal(c.subtaskObservationComplete_(state, snap, 'ms-empty', 'round-2'), true);
});

test('P1-2 case 3: 帶 checklistItems@odata.nextLink 的 parent 走逐父 fallback，其餘仍用展開', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-ok', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-paged', msListId: 'list-A' }
  ]);
  const directIds = [];
  c.getMsTasksWithChecklistItems_ = () => [
    { id: 'ms-ok', checklistItems: [{ id: 'expand-item', displayName: 'FromExpand', isChecked: false }] },
    { id: 'ms-paged', checklistItems: [{ id: 'partial', displayName: 'Partial', isChecked: false }], 'checklistItems@odata.nextLink': 'https://graph/next' }
  ];
  c.getMsChecklistItemsDirect_ = (listId, parentTaskId) => {
    directIds.push(parentTaskId);
    return observation([{ id: 'direct-item', displayName: 'FromDirect', isChecked: true }]);
  };
  const result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-3', 3000);
  assert.deepEqual(directIds, ['ms-paged']);
  assert.equal(result.directCollectionRequests, 1);
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-ok']), [{ id: 'expand-item', displayName: 'FromExpand', isChecked: false }]);
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-paged']), [{ id: 'direct-item', displayName: 'FromDirect', isChecked: true }]);
  assert.equal(state.subtasks.parents['ms-ok'].lastObservedRoundId, 'round-3');
  assert.equal(state.subtasks.parents['ms-paged'].lastObservedRoundId, 'round-3');
});

test('P1-2 case 4: 展開讀取拋錯 → 全部退回逐父 fallback，與舊行為一致且不拋給上層', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-1', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-2', msListId: 'list-B' }
  ]);
  const perParent = {
    'ms-1': [{ id: 'a', displayName: 'A', isChecked: false }],
    'ms-2': [{ id: 'b', displayName: 'B', isChecked: true }]
  };
  const directIds = [];
  c.getMsTasksWithChecklistItems_ = () => { throw new Error('HTTP 503: expand unavailable'); };
  c.getMsChecklistItemsDirect_ = (listId, parentTaskId) => {
    directIds.push(parentTaskId);
    return observation(perParent[parentTaskId]);
  };
  let result;
  assert.doesNotThrow(() => {
    result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-4', 4000);
  });
  assert.equal(directIds.length, 2);
  assert.ok(directIds.includes('ms-1') && directIds.includes('ms-2'));
  assert.equal(result.directCollectionRequests, 2);
  assert.deepEqual(plain(snap.msChecklistItemsByParentId), perParent);
  assert.equal(state.subtasks.parents['ms-1'].lastObservedRoundId, 'round-4');
  assert.equal(state.subtasks.parents['ms-2'].lastObservedRoundId, 'round-4');
});

test('P1-2 case 5: 混合展開/fallback/找不到，結果不互相覆蓋且 notFoundParentIds 正確', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-e1', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-e2', msListId: 'list-A' },
    { gParentId: 'g-3', msParentId: 'ms-fb', msListId: 'list-A' },
    { gParentId: 'g-4', msParentId: 'ms-miss', msListId: 'list-A' }
  ]);
  const directIds = [];
  c.getMsTasksWithChecklistItems_ = () => [
    { id: 'ms-e1', checklistItems: [{ id: 'e1', displayName: 'E1', isChecked: false }] },
    { id: 'ms-e2', checklistItems: [] }
    // ms-fb 與 ms-miss 不在展開結果 → fallback
  ];
  c.getMsChecklistItemsDirect_ = (listId, parentTaskId) => {
    directIds.push(parentTaskId);
    if (parentTaskId === 'ms-miss') throw new Error('HTTP 404: missing');
    return observation([{ id: 'fb-item', displayName: 'FromFallback', isChecked: true }]);
  };
  const result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-5', 5000);
  assert.deepEqual(directIds.slice().sort(), ['ms-fb', 'ms-miss']);
  // 展開結果
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-e1']), [{ id: 'e1', displayName: 'E1', isChecked: false }]);
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-e2']), []);
  // fallback 結果，未覆蓋任何已展開 parent
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-fb']), [{ id: 'fb-item', displayName: 'FromFallback', isChecked: true }]);
  assert.equal(Object.prototype.hasOwnProperty.call(snap.msChecklistItemsByParentId, 'ms-miss'), false);
  // notFound 邏輯保留
  assert.deepEqual(plain(result.notFoundParentIds), ['ms-miss']);
  assert.equal(snap.msParentNotFound['ms-miss'], true);
  assert.equal(snap.msParentNotFound['ms-e1'], undefined);
  // 報表：2 展開 + 1 fallback observed = 3；directCollectionRequests 只算真實逐父 GET
  assert.equal(result.observed, 3);
  assert.equal(result.scheduled, 4);
  assert.equal(result.attempted, 4);
  assert.equal(result.directCollectionRequests, 1);
});

test('P1-2 case 6: 門控/政策/getMsTasks_ URL 不變，展開 URL 獨立且不含 $select，早退不觸發讀取', () => {
  const c = load();
  assert.deepEqual(plain(c.subtaskDiscoveryPolicy_()), {
    architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'STATIC_CONSERVATIVE', maxParents: 10
  });
  assert.deepEqual(plain(c.relationshipDiscoveryPolicy_()), {
    architecture: 'BOUNDED_DIRECT_GET', budgetStatus: 'UNMEASURED', maxParents: 0
  });
  const urls = [];
  c.graphFetch_ = (url) => { urls.push(url); return { value: [] }; };
  c.getMsTasks_('list-A');
  c.getMsTasksWithChecklistItems_('list-A');
  assert.equal(urls.length, 2);
  assert.equal(urls[0].includes('$expand=checklistItems'), false);
  assert.equal(urls[1].includes('$expand=checklistItems'), true);
  assert.equal(urls[1].includes('$select'), false);
  assert.match(urls[1], /\?\$top=100&\$expand=checklistItems$/);
  // enableSubtasks !== true 時維持原本 early return，且不觸發任何 provider 讀取
  const state = c.newState_();
  state.g2m['g-1'] = { msId: 'ms-1', msListId: 'list-A' };
  const disabled = { safety: { enableSubtasks: false }, gTasksById: { 'g-1': { id: 'g-1' } }, msListByTask: {} };
  const before = urls.length;
  const early = c.discoverSubtaskRelationships_(state, disabled, 0, 'round-6', 6000);
  assert.equal(urls.length, before);
  assert.deepEqual(plain(early), { scheduled: 0, attempted: 0, observed: 0, itemsByMsParentId: {} });
});

test('P1-2 case 7: 展開讀取以不重複 msListId 為單位，各 list 僅一次', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-1', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-2', msListId: 'list-A' },
    { gParentId: 'g-3', msParentId: 'ms-3', msListId: 'list-B' }
  ]);
  const byList = {
    'list-A': [
      { id: 'ms-1', checklistItems: [{ id: 'a1', displayName: 'A1', isChecked: false }] },
      { id: 'ms-2', checklistItems: [{ id: 'a2', displayName: 'A2', isChecked: false }] }
    ],
    'list-B': [
      { id: 'ms-3', checklistItems: [{ id: 'b3', displayName: 'B3', isChecked: true }] }
    ]
  };
  const expandLists = [];
  let directCalls = 0;
  c.getMsTasksWithChecklistItems_ = (listId) => { expandLists.push(listId); return byList[listId]; };
  c.getMsChecklistItemsDirect_ = () => { directCalls += 1; return observation([]); };
  c.discoverSubtaskRelationships_(state, snap, 0, 'round-7', 7000);
  assert.deepEqual(expandLists, ['list-A', 'list-B']);
  assert.equal(directCalls, 0);
  assert.equal(snap.msChecklistItemsByParentId['ms-1'][0].id, 'a1');
  assert.equal(snap.msChecklistItemsByParentId['ms-2'][0].id, 'a2');
  assert.equal(snap.msChecklistItemsByParentId['ms-3'][0].id, 'b3');
});

test('P1-2 case 8: checklistItems 存在但非陣列時視為異常資料並走 fallback，不誤判為空集合', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-null', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-object', msListId: 'list-A' },
    { gParentId: 'g-3', msParentId: 'ms-ok', msListId: 'list-A' }
  ]);
  const directIds = [];
  c.getMsTasksWithChecklistItems_ = () => [
    { id: 'ms-null', checklistItems: null },
    { id: 'ms-object', checklistItems: { value: [{ id: 'hidden', displayName: 'Hidden', isChecked: false }] } },
    { id: 'ms-ok', checklistItems: [{ id: 'ok', displayName: 'OK', isChecked: false }] }
  ];
  c.getMsChecklistItemsDirect_ = (listId, parentTaskId) => {
    directIds.push(parentTaskId);
    return observation([{ id: 'real-' + parentTaskId, displayName: 'Real', isChecked: false }]);
  };
  const result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-8', 8000);
  assert.deepEqual(directIds.slice().sort(), ['ms-null', 'ms-object']);
  assert.equal(snap.msChecklistItemsByParentId['ms-null'][0].id, 'real-ms-null');
  assert.equal(snap.msChecklistItemsByParentId['ms-object'][0].id, 'real-ms-object');
  assert.deepEqual(plain(snap.msChecklistItemsByParentId['ms-ok']), [{ id: 'ok', displayName: 'OK', isChecked: false }]);
  assert.equal(result.eligible, 3, 'eligible 涵蓋全部候選，不只是 fallback 子集');
  assert.equal(result.directCollectionRequests, 2);
});

test('P1-2 case 9: eligible 是全體候選數；混合展開/fallback 時不小於 observed', () => {
  const c = load();
  const { state, snap } = makeFixture(c, [
    { gParentId: 'g-1', msParentId: 'ms-e', msListId: 'list-A' },
    { gParentId: 'g-2', msParentId: 'ms-f', msListId: 'list-A' },
    { gParentId: 'g-3', msParentId: 'ms-g', msListId: 'list-A' }
  ]);
  c.getMsTasksWithChecklistItems_ = () => [
    { id: 'ms-e', checklistItems: [] },
    { id: 'ms-f', checklistItems: [] }
  ];
  c.getMsChecklistItemsDirect_ = () => observation([]);
  const result = c.discoverSubtaskRelationships_(state, snap, 0, 'round-9', 9000);
  assert.equal(result.eligible, 3);
  assert.equal(result.observed, 3);
  assert.ok(result.observed <= result.eligible);
});
