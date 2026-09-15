import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { runGasFilesInContext } from './gas-loader.mjs';

// Self-contained harness for the attachment observation line and provider-call
// telemetry. Provider reads never reach the network here: graphFetch_ is
// overridden per test, so getMsTaskAttachments_ exercises only its own bounded
// pagination and error semantics.
function propertyStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getProperty(key) { return Object.hasOwn(values, key) ? values[key] : null; },
    getProperties() { return { ...values }; },
    getKeys() { return Object.keys(values); },
    setProperty(key, value) { values[key] = String(value); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) values[k] = String(v); },
    deleteProperty(key) { delete values[key]; },
    deleteAllProperties() { for (const k of Object.keys(values)) delete values[k]; }
  };
}

function load({ urlFetchApp } = {}) {
  const scriptStore = propertyStore();
  const userStore = propertyStore();
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => scriptStore,
      getUserProperties: () => userStore
    },
    Session: { getScriptTimeZone: () => 'Asia/Taipei', getEffectiveUser: () => ({ getEmail: () => '' }) },
    Utilities: {
      sleep() {},
      getUuid: () => '00000000-0000-4000-8000-000000000000',
      newBlob: (v) => ({ getBytes: () => v, getDataAsString: () => v }),
      base64Encode: (v) => String(v),
      base64Decode: (v) => v
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }),
      getUserLock: () => ({ tryLock: () => true, releaseLock() {} })
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: { fetch: urlFetchApp || (() => { throw new Error('unexpected provider call'); }) },
    MailApp: { sendEmail() {}, getRemainingDailyQuota: () => 100 },
    DriveApp: {},
    FormApp: {}
  });
  runGasFilesInContext(context);
  return context;
}

const ATTACHMENT_URL_RE = /\/tasks\/[^/]+\/attachments\?\$top=100$/;

test('getMsTaskAttachments_ returns OBSERVED_COMPLETE for a single page', () => {
  const c = load();
  let capturedUrl = null;
  c.graphFetch_ = (url) => { capturedUrl = url; return { value: [{ id: 'a' }, { id: 'b' }] }; };
  const result = c.getMsTaskAttachments_('list-1', 'task-1');
  assert.equal(result.kind, 'OBSERVED_COMPLETE');
  assert.equal(result.pageCount, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, 'a');
  assert.equal(result.items[1].id, 'b');
  assert.match(capturedUrl, ATTACHMENT_URL_RE);
});

test('getMsTaskAttachments_ paginates multiple pages and counts them', () => {
  const c = load();
  const pages = [
    { value: [{ id: 'a' }], '@odata.nextLink': 'https://next/1' },
    { value: [{ id: 'b' }] }
  ];
  c.graphFetch_ = () => pages.shift();
  const result = c.getMsTaskAttachments_('list-1', 'task-1');
  assert.equal(result.kind, 'OBSERVED_COMPLETE');
  assert.equal(result.pageCount, 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, 'a');
  assert.equal(result.items[1].id, 'b');
});

test('getMsTaskAttachments_ throws RELATIONSHIP_MALFORMED_ID on empty or non-string ids', () => {
  const c = load();
  c.graphFetch_ = () => { throw new Error('must not be called'); };
  for (const [listId, taskId] of [['', 't'], ['l', ''], [123, 't'], ['l', null], [undefined, 't']]) {
    assert.throws(() => c.getMsTaskAttachments_(listId, taskId), /RELATIONSHIP_MALFORMED_ID/);
  }
});

test('getMsTaskAttachments_ throws RELATIONSHIP_MALFORMED_PAGE on malformed pages', () => {
  const cases = [null, { foo: 1 }, { value: {} }, { value: 'not-array' }, { value: [], '@odata.nextLink': 123 }];
  for (const fixture of cases) {
    const c = load();
    c.graphFetch_ = () => fixture;
    assert.throws(() => c.getMsTaskAttachments_('l', 't'), /RELATIONSHIP_MALFORMED_PAGE/);
  }
});

test('getMsTaskAttachments_ throws RELATIONSHIP_MALFORMED_ITEM when an attachment lacks a non-empty string id', () => {
  const cases = [
    [{ id: '' }],
    [{ id: 123 }],
    [{ id: null }],
    [{}],
    [null],
    [{ id: 'ok' }, { id: '' }]
  ];
  for (const value of cases) {
    const c = load();
    c.graphFetch_ = () => ({ value });
    assert.throws(() => c.getMsTaskAttachments_('l', 't'), /RELATIONSHIP_MALFORMED_ITEM/);
  }
});

test('getMsTaskAttachments_ throws RELATIONSHIP_PAGINATION_LOOP on a repeated nextLink', () => {
  const c = load();
  c.graphFetch_ = () => ({ value: [], '@odata.nextLink': 'loop' });
  assert.throws(() => c.getMsTaskAttachments_('l', 't'), /RELATIONSHIP_PAGINATION_LOOP/);
});

test('getMsTaskAttachments_ throws RELATIONSHIP_PAGINATION_PAGE_CAP at the page limit', () => {
  const c = load();
  let calls = 0;
  c.graphFetch_ = () => {
    calls += 1;
    return { value: [], '@odata.nextLink': 'https://next/' + calls };
  };
  assert.throws(() => c.getMsTaskAttachments_('l', 't'), /RELATIONSHIP_PAGINATION_PAGE_CAP/);
});

test('getMsTaskAttachments_ throws TIME_BUDGET_RELATIONSHIP when the time budget is exhausted', () => {
  const c = load();
  c.graphFetch_ = () => { throw new Error('must not be reached'); };
  vm.runInContext('RUN_STARTED_AT = 1;', c);
  assert.throws(() => c.getMsTaskAttachments_('l', 't'), /TIME_BUDGET_RELATIONSHIP/);
});

test('providerCallTelemetry_ returns only numeric counts with no leaked content', () => {
  const c = load();
  // No active round: observability is null, telemetry must be all zeros.
  const idle = c.providerCallTelemetry_();
  assert.equal(idle.providerRequests, 0);
  assert.equal(idle.providerRetries, 0);

  vm.runInContext('SYNC_OBSERVABILITY_ = null;', c);
  const idle2 = c.providerCallTelemetry_();
  assert.equal(idle2.providerRequests, 0);
  assert.equal(idle2.providerRetries, 0);

  c.beginSyncObservability_(Date.now());
  for (let i = 0; i < 3; i += 1) c.recordUrlFetchCall_();
  for (let i = 0; i < 2; i += 1) c.recordProviderRetry_();
  const tel = c.providerCallTelemetry_();
  assert.equal(tel.providerRequests, 3);
  assert.equal(tel.providerRetries, 2);
  assert.equal(typeof tel.providerRequests, 'number');
  assert.equal(typeof tel.providerRetries, 'number');
  assert.equal(Object.keys(tel).length, 2);
  // The snapshot must contain no IDs, tokens, or body text — numbers and the
  // two known keys only.
  const serialized = JSON.stringify(tel);
  assert.match(serialized, /^\{"providerRequests":\d+,"providerRetries":\d+\}$/);
  assert.equal(/[A-Za-z]/.test(serialized.replace(/"providerRequests"|"providerRetries"|[0-9{},":]/g, '')), false);
});

test('providerCallTelemetry_ reflects the real retry path through fetchJsonWithRetry_', () => {
  let calls = 0;
  const c = load({
    urlFetchApp: () => {
      calls += 1;
      if (calls === 1) return { getResponseCode: () => 500, getContentText: () => 'server error' };
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    }
  });
  c.beginSyncObservability_(Date.now());
  c.fetchJsonWithRetry_('https://example.invalid/x', { method: 'get' }, 'google');
  const tel = c.providerCallTelemetry_();
  assert.equal(tel.providerRequests, 2, 'one UrlFetch per attempt');
  assert.equal(tel.providerRetries, 1, 'exactly one retry after the 500');
});
