import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';

test('healthCheck and dryRunReport fail closed on invalid safety settings without disclosure or mutation', () => {
  const logs = [];
  const invalid = 'private-invalid-safety-value';
  const { context, scriptStore, userStore } = loadContext({
    scriptValues: { SYNC_LIST_DISCOVERY_MODE: invalid },
    userValues: { unrelated: 'preserve-me' }
  });
  context.console = { log: (value) => logs.push(String(value)), warn: () => {}, error: () => {} };
  context.withGlobalLock_ = (fn) => fn();
  context.getGLists_ = () => { throw new Error('inventory must not run'); };
  const beforeScript = { ...scriptStore.values };
  const beforeUser = { ...userStore.values };
  const dry = context.dryRunReport();
  const health = context.healthCheck();
  assert.equal(dry.warnings[0], 'SAFETY_CONFIGURATION_INVALID:SYNC_DISCOVERY_MODE_INVALID');
  assert.equal(health.issues[0], 'SAFETY_CONFIGURATION_INVALID:SYNC_DISCOVERY_MODE_INVALID');
  const serialized = JSON.stringify([dry, health, logs]);
  assert.equal(serialized.includes(invalid), false);
  assert.deepEqual(scriptStore.values, beforeScript);
  assert.deepEqual(userStore.values, beforeUser);
});

test('Google-to-Microsoft update PATCHes only semantic changes and preserves matching rich HTML', () => {
  const { context } = loadContext();
  const msTask = {
    title: 'Original',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'Asia/Taipei' },
    status: 'notStarted',
    body: { contentType: 'html', content: '<p>Rich<br>body</p>' }
  };
  const googleTask = {
    title: 'Original', due: '2026-08-21T00:00:00.000Z', status: 'needsAction', notes: 'Rich\nbody'
  };
  const payloadFor = (changes) => JSON.parse(JSON.stringify(context.msUpdatePayloadFromGoogle_(
    { ...googleTask, ...changes }, msTask
  )));
  assert.deepEqual(payloadFor({ title: 'Renamed' }), { title: 'Renamed' });
  assert.deepEqual(payloadFor({ due: '2026-08-22T00:00:00.000Z' }), {
    dueDateTime: { dateTime: '2026-08-22T00:00:00', timeZone: 'Asia/Taipei' }
  });
  assert.deepEqual(payloadFor({ status: 'completed' }), { status: 'completed' });
  assert.deepEqual(payloadFor({ notes: 'Changed notes' }), {
    body: { contentType: 'html', content: 'Changed notes' }
  });
});

test('unknown Microsoft due zone omits due from Google PATCH data instead of clearing it', () => {
  const { context } = loadContext();
  const payload = context.googlePayloadFromMs_({
    title: 'Task', status: 'notStarted',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'Private Unknown Zone' }
  });
  assert.equal(Object.hasOwn(payload, 'due'), false);
  assert.equal(context.googleDue_({
    dateTime: '2026-08-21T00:00:00', timeZone: 'Private Unknown Zone'
  }), null);
});

test('configureSync rejects secret input without writing Script Properties', () => {
  const { context, scriptStore } = loadContext({ scriptValues: { unrelated: 'preserve-me' } });
  const before = { ...scriptStore.values };
  assert.throws(() => context.configureSync({
    clientId: 'client-secret-sentinel', clientSecret: 'secret-sentinel'
  }), /CONFIGURE_SYNC_DEPRECATED/);
  assert.deepEqual(scriptStore.values, before);
});

test('Microsoft 401 refreshes exactly once before retrying POST PATCH and DELETE', () => {
  for (const method of ['post', 'patch', 'delete']) {
    const fetches = [];
    const responses = [httpResponse(401, 'provider-body-must-not-escape'), httpResponse(200, JSON.stringify({ ok: true }))];
    let refreshes = 0;
    let resets = 0;
    const { context } = loadContext({
      urlFetchApp: { fetch(url, options) { fetches.push({ url, options }); return responses.shift(); } }
    });
    const service = {
      hasAccess: () => true,
      getAccessToken: () => refreshes ? 'fresh-token' : 'old-token',
      refresh: () => { refreshes += 1; },
      reset: () => { resets += 1; }
    };
    context.microsoftService_ = () => service;
    context.sendReauthorizationAlert_ = () => { throw new Error('should not alert'); };
    assert.deepEqual(JSON.parse(JSON.stringify(context.graphFetch_('https://example.invalid/resource', { method }))), { ok: true });
    assert.equal(refreshes, 1, method);
    assert.equal(resets, 0, method);
    assert.equal(fetches.length, 2, method);
    assert.equal(fetches[0].options.headers.Authorization, 'Bearer old-token', method);
    assert.equal(fetches[1].options.headers.Authorization, 'Bearer fresh-token', method);
  }
});

test('second Microsoft 401 resets and alerts after one forced refresh without exposing provider text', () => {
  const responses = [httpResponse(401, 'private provider body'), httpResponse(401, 'private provider body')];
  let refreshes = 0;
  let resets = 0;
  let alerts = 0;
  const { context } = loadContext({ urlFetchApp: { fetch: () => responses.shift() } });
  context.microsoftService_ = () => ({
    hasAccess: () => true, getAccessToken: () => 'token', refresh: () => { refreshes += 1; }, reset: () => { resets += 1; }
  });
  context.sendReauthorizationAlert_ = () => { alerts += 1; };
  assert.throws(() => context.graphFetch_('https://example.invalid/private', { method: 'post' }), /HTTP 401/);
  assert.equal(refreshes, 1);
  assert.equal(resets, 1);
  assert.equal(alerts, 1);
});

test('fatal alerts are bounded and raw state export explicitly warns about sensitivity', () => {
  const { context, userStore } = loadContext({ userValues: {
    sync_state_main_manifest: 'raw-state-sentinel',
    sync_state_main_successful_round_manifest: 'successful-round-sentinel',
    sync_state_main_round_fence: 'round-fence-sentinel',
    unrelated: 'not-exported'
  } });
  const redacted = context.redactFatalAlert_(
    'HTTP 500: https://private.invalid/lists/list-secret/tasks/task-secret token=token-secret request-id: req-123456'
  );
  for (const secret of ['private.invalid', 'list-secret', 'task-secret', 'token-secret']) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /HTTP code: 500/);
  assert.match(redacted, /Correlation code: req-123456/);
  const warnings = [];
  context.console = { log: () => {}, warn: (value) => warnings.push(String(value)), error: () => {} };
  const bundle = context.exportRawSyncState();
  assert.match(bundle.warning, /SENSITIVE_STATE_EXPORT/);
  assert.equal(bundle.properties.sync_state_main_manifest, 'raw-state-sentinel');
  assert.equal(bundle.properties.sync_state_main_successful_round_manifest, 'successful-round-sentinel');
  assert.equal(bundle.properties.sync_state_main_round_fence, 'round-fence-sentinel');
  assert.equal(warnings.some((value) => value.includes('WARNING')), true);
  assert.equal(Object.hasOwn(bundle.properties, 'unrelated'), false);
  assert.equal(Object.hasOwn(userStore.values, 'unrelated'), true);
});

test('health error summaries retain only bounded diagnostics and scrub legacy state', () => {
  const { context } = loadContext();
  const secretBody = JSON.stringify({
    access_token: 'token-secret-sentinel',
    listTitle: 'Private list title sentinel',
    taskTitle: 'Private task title sentinel',
    owner: 'person@example.invalid',
    endpoint: 'https://private.invalid/lists/list-secret/tasks/task-secret'
  });
  const httpSummary = context.redactHealthErrorMessage_(
    'HTTP 500: ' + secretBody + ' request-id: req-123456'
  );
  assert.equal(httpSummary, 'HTTP code: 500; Error type: HTTP_ERROR; Correlation code: req-123456');
  for (const secret of [
    'token-secret-sentinel', 'Private list title sentinel', 'Private task title sentinel',
    'person@example.invalid', 'private.invalid', 'list-secret', 'task-secret'
  ]) {
    assert.equal(httpSummary.includes(secret), false, secret);
  }

  const internalSummary = context.redactHealthErrorMessage_(
    'STATE_PROPERTY_VALUE_LIMIT: ' + 'sensitive-body-sentinel '.repeat(2000)
  );
  assert.equal(internalSummary, 'HTTP code: unavailable; Error type: STATE_PROPERTY_VALUE_LIMIT');
  assert.ok(internalSummary.length < 160);
  assert.equal(internalSummary.includes('sensitive-body'), false);

  const genericSummary = context.redactHealthErrorMessage_(
    'simulated failure for private task title sentinel'
  );
  assert.equal(genericSummary, 'HTTP code: unavailable; Error type: UNCLASSIFIED');

  const legacy = context.newState_();
  legacy.health.lastErrorMessage =
    'HTTP 429: https://private.invalid/secret token=legacy-token request-id: legacy-req-123';
  context.normalizeState_(legacy);
  assert.equal(legacy.health.lastErrorMessage,
    'HTTP code: 429; Error type: HTTP_ERROR; Correlation code: legacy-req-123');
  assert.equal(legacy.health.lastErrorMessage.includes('legacy-token'), false);
  assert.equal(legacy.health.lastErrorMessage.includes('private.invalid'), false);
});

test('network public entrypoints initialize a fresh execution budget', () => {
  const { context } = loadContext();
  context.getSafetyConfig_ = () => ({ listDiscoveryMode: 'auto', googleListIds: [], excludedListNames: [] });
  context.getGLists_ = () => [];
  context.console = { log: () => {}, warn: () => {}, error: () => {} };
  assert.equal(vm.runInContext('RUN_STARTED_AT', context), 0);
  context.listGoogleTaskLists();
  assert.ok(vm.runInContext('RUN_STARTED_AT', context) > 0);
});

test('Google and Graph pagination fail closed for repeated cursors, page caps, and exhausted time budgets', () => {
  const { context } = loadContext();
  for (const mode of ['google', 'graph']) {
    let calls = 0;
    assert.throws(() => context.getAllPages_('https://example.invalid/first', () => {
      calls += 1;
      return mode === 'google' ? { items: [], nextPageToken: 'again' } : { value: [], '@odata.nextLink': 'https://example.invalid/again' };
    }, mode === 'google' ? 'items' : 'value', mode), /PAGINATION_LOOP/);
    assert.equal(calls, 2, mode + ' repeated cursor');
    let pageCalls = 0;
    assert.throws(() => context.getAllPages_('https://example.invalid/cap', () => {
      pageCalls += 1;
      return mode === 'google' ? { items: [], nextPageToken: String(pageCalls) } :
        { value: [], '@odata.nextLink': 'https://example.invalid/cap/' + pageCalls };
    }, mode === 'google' ? 'items' : 'value', mode), /PAGINATION_PAGE_CAP/);
    assert.equal(pageCalls, 100, mode + ' page cap');
    vm.runInContext('RUN_STARTED_AT = Date.now() - (RUN_LIMIT_MS - PAGINATION_RESERVE_MS)', context);
    let timedFetches = 0;
    assert.throws(() => context.getAllPages_('https://example.invalid/time', () => {
      timedFetches += 1;
      return {};
    }, mode === 'google' ? 'items' : 'value', mode), /TIME_BUDGET_PAGINATION/);
    assert.equal(timedFetches, 0, mode + ' time budget');
    vm.runInContext('RUN_STARTED_AT = 0', context);
  }
});

test('state-save preflight counts the full property store and never writes partial generations', () => {
  const nearLimitValues = {};
  for (let i = 0; i < 54; i += 1) nearLimitValues['other_' + i] = 'x'.repeat(8000);
  const normal = loadContext();
  normal.context.saveState_(normal.context.newState_());
  assert.ok(normal.userStore.values.sync_state_main_manifest);
  const near = loadContext({ userValues: nearLimitValues });
  near.context.saveState_(near.context.newState_());
  assert.ok(near.userStore.values.sync_state_main_manifest);
  const overLimitValues = { ...nearLimitValues };
  for (let i = 54; i < 59; i += 1) overLimitValues['other_' + i] = 'x'.repeat(8000);
  const over = loadContext({ userValues: overLimitValues });
  const before = { ...over.userStore.values };
  let setPropertiesCalls = 0;
  const originalSetProperties = over.userStore.setProperties.bind(over.userStore);
  over.userStore.setProperties = (...args) => { setPropertiesCalls += 1; originalSetProperties(...args); };
  assert.throws(() => over.context.saveState_(over.context.newState_()), /STATE_STORE_LIMIT/);
  assert.equal(setPropertiesCalls, 0);
  assert.deepEqual(over.userStore.values, before);
});

test('state blob preflight accepts multi-chunk Unicode mappings by actual UTF-8 bytes and round-trips', () => {
  const { context, userStore } = loadContext();
  const g2m = {};
  for (let i = 0; i < 60; i += 1) {
    const marker = '工作事項-' + i + '-中文-😀';
    g2m['g-' + marker] = {
      msId: 'm-' + marker + '-🎯',
      gListId: 'g-list-私人',
      msListId: 'ms-list-待辦',
      gUpdated: '2026-08-28T00:00:00.000Z',
      msUpdated: '2026-08-28T00:00:00.000Z',
      gFingerprint: (marker + '-詳細內容-漢字-🧪').repeat(12),
      msFingerprint: (marker + '-同步證據-繁體中文-🚀').repeat(12)
    };
  }
  const payload = {
    version: 1,
    title: 'Multi-chunk state validation: Unicode, emoji, and 60 mappings',
    g2m: g2m
  };

  const baseKey = 'unicode_state';
  assert.doesNotThrow(() => context.saveBlobAtomic_(baseKey, payload));
  const chunks = Object.entries(userStore.values).filter(([key]) =>
    key.indexOf(baseKey + '_gen_') === 0 && !key.endsWith('_count')
  );
  assert.ok(chunks.length > 1, 'fixture must span multiple state chunks');
  assert.ok(chunks.every(([, value]) => context.utf8ByteLength_(value) <= 8 * 1024));
  assert.ok(chunks.every(([, value]) => value.length <= 7000));
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.loadBlobAtomic_(baseKey))),
    payload
  );
});

test('property preflight rejects an actual UTF-8 overage before any write', () => {
  const { context, userStore } = loadContext();
  const before = { ...userStore.values };
  let batchWrites = 0;
  let singleWrites = 0;
  const originalSetProperties = userStore.setProperties.bind(userStore);
  const originalSetProperty = userStore.setProperty.bind(userStore);
  userStore.setProperties = (...args) => {
    batchWrites += 1;
    originalSetProperties(...args);
  };
  userStore.setProperty = (...args) => {
    singleWrites += 1;
    originalSetProperty(...args);
  };
  const oversized = '中'.repeat(2731); // 2,731 * 3 UTF-8 bytes = 8,193 bytes.

  assert.equal(context.utf8ByteLength_('ASCII'), 5);
  assert.equal(context.utf8ByteLength_('中文😀'), 10);
  assert.equal(context.utf8ByteLength_('\uD83D'), 3, 'lone surrogate becomes U+FFFD');
  assert.equal(context.utf8ByteLength_(oversized), (8 * 1024) + 1);
  assert.throws(
    () => context.assertPropertyStorePreflight_(userStore, { oversized: oversized }),
    /STATE_PROPERTY_VALUE_LIMIT/
  );
  assert.equal(batchWrites, 0);
  assert.equal(singleWrites, 0);
  assert.deepEqual(userStore.values, before);
});

test('main sync state writes a versioned gzip generation with per-generation integrity evidence', () => {
  const { context, userStore } = loadContext();
  const logs = [];
  context.console = { log: (value) => logs.push(String(value)), warn: () => {}, error: () => {} };
  context.beginSyncObservability_(Date.now());
  const state = context.newState_();
  state.listMap['g-中文-😀-\uD83D'] = 'ms-🎯-\uD83D';
  const generation = context.saveState_(state);
  const manifest = JSON.parse(userStore.getProperty('sync_state_main_manifest'));
  const prefix = 'sync_state_main_gen_' + generation + '_';
  const generationMeta = JSON.parse(userStore.getProperty(prefix + 'meta'));

  assert.equal(manifest.codec, 'gzip-base64');
  assert.equal(manifest.codecVersion, 1);
  assert.deepEqual(generationMeta, {
    codec: 'gzip-base64',
    codecVersion: 1,
    integrity: manifest.integrity,
    uncompressedUtf8Bytes: manifest.uncompressedUtf8Bytes
  });
  assert.match(manifest.integrity.value, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(userStore.getProperty(prefix + '0').includes('%7B'), false);
  const loaded = context.loadStateForSync_();
  assert.equal(loaded.listMap['g-中文-😀-\uD83D'], 'ms-🎯-\uD83D');
  context.logSyncSummary_('success');
  const summary = JSON.parse(logs.at(-1));
  assert.equal(summary.stateCodecEncodeCalls, 1);
  assert.equal(summary.stateCodecDecodeCalls, 1);
  assert.equal(Number.isInteger(summary.stateCodecMs), true);
  assert.ok(summary.stateCodecMs >= 0);
  assert.equal(JSON.stringify(summary).includes('g-中文'), false, 'codec metrics never include state data');
});

test('legacy URI state loads and the next successful save migrates it to gzip', () => {
  const { context, userStore } = loadContext();
  const legacy = context.newState_();
  legacy.listMap['g-legacy'] = 'ms-legacy';
  legacy.g2m['g-legacy-task'] = {
    msId: 'ms-legacy-task', gListId: 'g-legacy', msListId: 'ms-legacy',
    gUpdated: '2026-08-29T00:00:00.000Z', msUpdated: '2026-08-29T00:00:00.000Z'
  };
  legacy.m2g['ms-legacy-task'] = 'g-legacy-task';
  userStore.setProperty('sync_state_main_manifest', JSON.stringify({
    generation: 'legacy', count: 1, previousGeneration: null
  }));
  userStore.setProperty('sync_state_main_gen_legacy_count', '1');
  userStore.setProperty('sync_state_main_gen_legacy_0', encodeURIComponent(JSON.stringify(legacy)));

  const loaded = context.loadStateForSync_();
  assert.equal(loaded.listMap['g-legacy'], 'ms-legacy');
  const generation = context.saveState_(loaded);
  const manifest = JSON.parse(userStore.getProperty('sync_state_main_manifest'));
  assert.equal(manifest.generation, generation);
  assert.equal(manifest.codec, 'gzip-base64');
  assert.equal(manifest.codecVersion, 1);
  assert.ok(userStore.getProperty('sync_state_main_gen_' + generation + '_meta'));
});

test('unknown, truncated, or tampered gzip state generations fail closed', () => {
  const { context, userStore } = loadContext();
  const generation = context.saveState_(context.newState_());
  const prefix = 'sync_state_main_gen_' + generation + '_';
  const manifestKey = 'sync_state_main_manifest';
  const originalManifest = userStore.getProperty(manifestKey);
  const originalChunk = userStore.getProperty(prefix + '0');
  const originalMeta = userStore.getProperty(prefix + 'meta');

  const unknown = JSON.parse(originalManifest);
  unknown.codec = 'future-codec';
  userStore.setProperty(manifestKey, JSON.stringify(unknown));
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);

  userStore.setProperty(manifestKey, originalManifest);
  userStore.deleteProperty(prefix + 'meta');
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);

  userStore.setProperty(prefix + 'meta', originalMeta);
  const oversizedCount = JSON.parse(originalManifest);
  oversizedCount.count = 101;
  userStore.setProperty(manifestKey, JSON.stringify(oversizedCount));
  let chunkReads = 0;
  const originalGetProperty = userStore.getProperty.bind(userStore);
  userStore.getProperty = (key) => {
    if (key.indexOf(prefix) === 0 && /^.+_\d+$/.test(key)) chunkReads += 1;
    return originalGetProperty(key);
  };
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);
  assert.equal(chunkReads, 0, 'invalid count is rejected before any chunk loop');
  userStore.getProperty = originalGetProperty;
  userStore.setProperty(manifestKey, originalManifest);
  userStore.setProperty(prefix + '1', 'unexpected-extra-chunk');
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);
  userStore.deleteProperty(prefix + '1');

  userStore.setProperty(prefix + '0', originalChunk.slice(0, -4));
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);

  userStore.setProperty(prefix + '0', originalChunk);
  const tamperedMeta = JSON.parse(originalMeta);
  tamperedMeta.integrity.value = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  userStore.setProperty(prefix + 'meta', JSON.stringify(tamperedMeta));
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);
  assert.throws(() => context.loadStateForSync_(), /STATE_CORRUPT/);
});

test('failed batch chunks are reclaimed only after all recovery pointers validate', () => {
  const { context, userStore } = loadContext();
  const stable = context.newState_();
  stable.listMap.stable = 'before';
  context.saveState_(stable);
  const originalSetProperties = userStore.setProperties.bind(userStore);
  let partialKeys = [];
  userStore.setProperties = (entries) => {
    partialKeys = Object.keys(entries).slice(0, 2);
    originalSetProperties(Object.fromEntries(partialKeys.map((key) => [key, entries[key]])));
    throw new Error('simulated partial batch failure');
  };
  const changed = context.newState_();
  changed.listMap.changed = 'after';
  assert.throws(() => context.saveState_(changed), /simulated partial batch failure/);
  assert.equal(context.loadStateForSync_().listMap.stable, 'before', 'old pointer remains readable');
  userStore.setProperties = originalSetProperties;
  context.saveState_(changed);
  assert.ok(partialKeys.length);
  assert.ok(partialKeys.every((key) => userStore.getProperty(key) === null), 'retry reclaimed orphan chunks');

  const blockedOrphan = 'sync_state_main_gen_orphan_0';
  userStore.setProperty(blockedOrphan, 'orphan');
  const bad = JSON.parse(userStore.getProperty('sync_state_main_manifest'));
  bad.count = 101;
  userStore.setProperty('sync_state_main_manifest', JSON.stringify(bad));
  let deletes = 0;
  const originalDelete = userStore.deleteProperty.bind(userStore);
  userStore.deleteProperty = (key) => { deletes += 1; originalDelete(key); };
  assert.throws(() => context.saveState_(context.newState_()), /STATE_MANIFEST_CORRUPT/);
  assert.equal(deletes, 0, 'corrupt pointer blocks orphan reclamation');
  assert.equal(userStore.getProperty(blockedOrphan), 'orphan');
});

test('successful-round restore reads a retained legacy generation after gzip migration', () => {
  const { context, userStore } = loadContext();
  const legacy = context.newState_();
  legacy.listMap['g-legacy'] = 'ms-legacy';
  userStore.setProperty('sync_state_main_manifest', JSON.stringify({
    generation: 'legacy', count: 1, previousGeneration: null
  }));
  userStore.setProperty('sync_state_main_gen_legacy_count', '1');
  userStore.setProperty('sync_state_main_gen_legacy_0', encodeURIComponent(JSON.stringify(legacy)));
  userStore.setProperty('sync_state_main_successful_round_manifest', JSON.stringify({
    version: 1, current: { generation: 'legacy', roundId: 'legacy-round' }, previous: null
  }));
  const migrated = context.loadStateForSync_();
  migrated.listMap.current = 'gzip-current';
  context.saveState_(migrated);
  context.withGlobalLock_ = (fn) => fn();
  context.restorePreviousSyncState();
  assert.equal(context.loadStateForSync_().listMap['g-legacy'], 'ms-legacy');
  assert.equal(context.loadStateForSync_().listMap.current, undefined);
});

test('gzip metadata length evidence rejects claimed and actual decompression expansion', () => {
  const { context, userStore } = loadContext();
  const generation = context.saveState_(context.newState_());
  const prefix = 'sync_state_main_gen_' + generation + '_';
  const manifest = JSON.parse(userStore.getProperty('sync_state_main_manifest'));
  const meta = JSON.parse(userStore.getProperty(prefix + 'meta'));
  meta.uncompressedUtf8Bytes = (2 * 1024 * 1024) + 1;
  manifest.uncompressedUtf8Bytes = meta.uncompressedUtf8Bytes;
  userStore.setProperty(prefix + 'meta', JSON.stringify(meta));
  userStore.setProperty('sync_state_main_manifest', JSON.stringify(manifest));
  let ungzipCalls = 0;
  const originalUngzip = context.Utilities.ungzip;
  context.Utilities.ungzip = (...args) => { ungzipCalls += 1; return originalUngzip(...args); };
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null);
  assert.equal(ungzipCalls, 0, 'over-limit metadata is rejected before decompression');

  const hugeJson = JSON.stringify('x'.repeat((2 * 1024 * 1024) + 1));
  const hugeCompressed = Buffer.from(gzipSync(Buffer.from(hugeJson))).toString('base64');
  const hugeMeta = {
    codec: 'gzip-base64', codecVersion: 1,
    integrity: { algorithm: 'SHA-256', encoding: 'base64', value: context.stateDigest_(hugeJson) },
    uncompressedUtf8Bytes: Buffer.byteLength(hugeJson, 'utf8')
  };
  const hugeManifest = { generation: 'huge', count: 1, previousGeneration: null, ...hugeMeta };
  userStore.setProperty('sync_state_main_manifest', JSON.stringify(hugeManifest));
  userStore.setProperty('sync_state_main_gen_huge_count', '1');
  userStore.setProperty('sync_state_main_gen_huge_0', hugeCompressed);
  userStore.setProperty('sync_state_main_gen_huge_meta', JSON.stringify(hugeMeta));
  context.Utilities.ungzip = originalUngzip;
  assert.equal(context.loadBlobAtomic_('sync_state_main'), null, 'actual expansion is bounded before JSON parsing');
});

test('oversized decoded state is rejected before any gzip generation write', () => {
  const { context, userStore } = loadContext();
  const before = { ...userStore.values };
  const oversized = context.newState_();
  oversized.listMap['g-' + 'x'.repeat((2 * 1024 * 1024) + 1)] = 'ms';
  let writes = 0;
  const originalSetProperties = userStore.setProperties.bind(userStore);
  userStore.setProperties = (...args) => { writes += 1; originalSetProperties(...args); };
  assert.throws(() => context.saveState_(oversized), /STATE_UNCOMPRESSED_LIMIT/);
  assert.equal(writes, 0);
  assert.deepEqual(userStore.values, before);
});

test('sync summaries expose only bounded success, failure, and time-budget metrics', () => {
  function run(outcome) {
    const logs = [];
    const privateUrl = 'https://example.invalid/private-list/private-task';
    const { context } = loadContext({
      urlFetchApp: { fetch: () => httpResponse(200, JSON.stringify({ providerPayload: 'private-response-body' })) }
    });
    const state = context.newState_();
    context.console = { log: (value) => logs.push(String(value)), warn: () => {}, error: () => {} };
    context.withGlobalLock_ = (fn) => fn();
    context.loadStateForSync_ = () => state;
    context.sanitizePreexistingSyncRoundFence_ = (value) => value;
    context.openSyncRoundFence_ = () => {};
    context.beginSyncRoundProofProjection_ = () => {};
    context.clearSyncRoundFence_ = () => {};
    context.getSafetyConfig_ = () => ({ allowDeletions: true, allowListDeletions: true, allowTaskMoves: false });
    context.pauseTaskDeletions_ = () => {};
    context.pausePreparedDeletionJournals_ = () => {};
    context.pauseListDeletionIntentBeforeInventory_ = () => {};
    context.cleanupTombstones_ = () => {};
    context.cleanupListTombstones_ = () => {};
    context.buildSnapshot_ = () => {
      context.graphFetch_(privateUrl, { method: 'get' });
      if (outcome === 'time_budget') throw new Error('TIME_BUDGET_TEST');
      return { safety: { allowDeletions: true, allowListDeletions: true, allowTaskMoves: false } };
    };
    context.reconcileMapped_ = () => {
      if (outcome === 'failure') throw new Error('PRIVATE_PROVIDER_RESPONSE_BODY');
    };
    context.createUnmapped_ = () => {};
    context.captureTaskDeletionState_ = () => ({});
    context.applyConfirmedTaskDeletions_ = () => {};
    context.applyConfirmedListDeletions_ = () => {};
    context.persistSyncState_ = (value) => context.saveState_(value);
    context.recordSuccessfulSyncRound_ = () => {};
    context.sendFatalAlert_ = () => {};
    context.normalizeState_ = (value) => value;
    context.microsoftService_ = () => ({ hasAccess: () => true, getAccessToken: () => 'private-token' });

    if (outcome === 'failure') {
      assert.throws(() => context.syncAll(), /PRIVATE_PROVIDER_RESPONSE_BODY/);
    } else {
      assert.equal(context.syncAll(), undefined);
    }
    const summary = logs.map((value) => {
      try { return JSON.parse(value); } catch (e) { return null; }
    }).find((value) => value && value.event === 'sync_summary');
    assert.ok(summary, outcome);
    assert.equal(summary.outcome, outcome);
    assert.equal(Number.isInteger(summary.durationMs), true);
    assert.ok(summary.durationMs >= 0);
    assert.equal(summary.urlFetchCalls, 1);
    assert.equal(summary.stateSaveCalls, 1);
    const serialized = JSON.stringify(summary);
    for (const privateValue of [privateUrl, 'private-list', 'private-task', 'private-response-body', 'private-token']) {
      assert.equal(serialized.includes(privateValue), false, outcome + ' summary must not disclose private data');
    }
  }

  run('success');
  run('failure');
  run('time_budget');
});

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function propertyStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getProperty(key) {
      return Object.hasOwn(values, key) ? values[key] : null;
    },
    getProperties() {
      return { ...values };
    },
    getKeys() {
      return Object.keys(values);
    },
    setProperty(key, value) {
      values[key] = String(value);
    },
    setProperties(entries) {
      for (const [key, value] of Object.entries(entries)) values[key] = String(value);
    },
    deleteProperty(key) {
      delete values[key];
    },
    deleteAllProperties() {
      for (const key of Object.keys(values)) delete values[key];
    }
  };
}

function appsScriptBlob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return {
    getBytes: () => Array.from(bytes),
    getDataAsString: () => bytes.toString('utf8')
  };
}

function appsScriptUtilities() {
  return {
    DigestAlgorithm: { SHA_256: 'SHA-256' },
    Charset: { UTF_8: 'UTF-8' },
    newBlob: (data) => appsScriptBlob(data),
    gzip: (blob) => appsScriptBlob(gzipSync(Buffer.from(blob.getBytes()))),
    ungzip: (blob) => appsScriptBlob(gunzipSync(Buffer.from(blob.getBytes()))),
    base64Encode: (data) => Buffer.from(typeof data === 'string' ? data : data).toString('base64'),
    base64Decode: (data) => Array.from(Buffer.from(data, 'base64')),
    computeDigest: (_algorithm, data) => Array.from(createHash('sha256').update(data, 'utf8').digest())
  };
}

function loadContext({ scriptValues = {}, userValues = {}, scriptTimeZone, effectiveUserEmail,
  utilities, scriptApp, urlFetchApp, mailApp } = {}) {
  const scriptStore = propertyStore(scriptValues);
  const userStore = propertyStore(userValues);
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => scriptStore,
      getUserProperties: () => userStore
    }
  });
  if (scriptTimeZone || effectiveUserEmail !== undefined) {
    context.Session = {
      getScriptTimeZone: () => scriptTimeZone,
      getEffectiveUser: () => ({ getEmail: () => effectiveUserEmail || '' })
    };
  }
  context.Utilities = Object.assign(appsScriptUtilities(), utilities || {});
  if (scriptApp) context.ScriptApp = scriptApp;
  if (urlFetchApp) context.UrlFetchApp = urlFetchApp;
  if (mailApp) context.MailApp = mailApp;
  new vm.Script(code, { filename: 'Code.gs' }).runInContext(context);
  return { context, scriptStore, userStore };
}

function httpResponse(status, text = '', headers = {}) {
  return {
    getResponseCode: () => status,
    getContentText: () => text,
    getAllHeaders: () => headers
  };
}

test('initializeSafeDefaults installs missing public defaults and preserves unrelated properties', () => {
  const { context, scriptStore, userStore } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'google-list-sentinel',
      MS_CLIENT_SECRET: 'secret-sentinel',
      ALERT_EMAIL: 'email-sentinel@example.invalid',
      unrelated: 'preserve-me'
    },
    userValues: { sync_state_main: 'state-sentinel' },
    scriptApp: {
      getProjectTriggers() {
        throw new Error('initializer must not inspect triggers');
      }
    }
  });
  context.console = { log: () => {} };
  const before = { ...scriptStore.values };

  const first = context.initializeSafeDefaults();
  const afterFirst = { ...scriptStore.values };
  const second = context.initializeSafeDefaults();

  assert.deepEqual(JSON.parse(JSON.stringify(first.updatedProperties)), {
    SYNC_LIST_DISCOVERY_MODE: 'auto',
    SYNC_ALLOW_DELETIONS: 'true',
    SYNC_ALLOW_LIST_DELETIONS: 'true',
    SYNC_ALLOW_TASK_MOVES: 'true'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(second.updatedProperties)), {});
  assert.deepEqual(
    Object.fromEntries(Object.keys(first.updatedProperties).map((key) => [key, afterFirst[key]])),
    JSON.parse(JSON.stringify(first.updatedProperties))
  );
  for (const key of ['SYNC_GOOGLE_LIST_IDS', 'MS_CLIENT_SECRET', 'ALERT_EMAIL', 'unrelated']) {
    assert.equal(afterFirst[key], before[key], `${key} must be preserved`);
  }
  assert.deepEqual(userStore.values, { sync_state_main: 'state-sentinel' });
  assert.equal(JSON.stringify(first).includes('secret-sentinel'), false);
  assert.equal(JSON.stringify(first).includes('email-sentinel@example.invalid'), false);
});

test('initializeSafeDefaults preserves existing all-true settings and is idempotent', () => {
  const { context, scriptStore } = loadContext({
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'explicit',
      SYNC_ALLOW_DELETIONS: 'true',
      SYNC_ALLOW_LIST_DELETIONS: 'true',
      SYNC_ALLOW_TASK_MOVES: 'true',
      unrelated: 'preserve-me'
    }
  });
  context.console = { log: () => {} };
  const before = { ...scriptStore.values };
  let setPropertiesCalls = 0;
  const originalSetProperties = scriptStore.setProperties.bind(scriptStore);
  scriptStore.setProperties = (...args) => {
    setPropertiesCalls += 1;
    originalSetProperties(...args);
  };

  const first = context.initializeSafeDefaults();
  const second = context.initializeSafeDefaults();

  assert.deepEqual(JSON.parse(JSON.stringify(first.updatedProperties)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(second.updatedProperties)), {});
  assert.equal(setPropertiesCalls, 0);
  assert.deepEqual(scriptStore.values, before);
});

test('setupStatus returns bounded public-default status without exposing credentials, IDs, email, or state', () => {
  const logs = [];
  const triggers = [
    { getHandlerFunction: () => 'syncAll' },
    { getHandlerFunction: () => 'otherHandler' },
    { getHandlerFunction: () => 'syncAll' }
  ];
  const { context, scriptStore, userStore } = loadContext({
    scriptTimeZone: 'America/Los_Angeles',
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'auto',
      SYNC_ALLOW_DELETIONS: 'true',
      SYNC_ALLOW_LIST_DELETIONS: 'true',
      SYNC_ALLOW_TASK_MOVES: 'true',
      MS_CLIENT_ID: 'client-id-sentinel',
      MS_CLIENT_SECRET: 'secret-sentinel',
      MS_TENANT_ID: 'tenant-id-sentinel',
      ALERT_EMAIL: 'email-sentinel@example.invalid',
      SYNC_GOOGLE_LIST_IDS: 'google-list-sentinel'
    },
    userValues: { sync_state_main: 'state-sentinel' },
    scriptApp: { getProjectTriggers: () => triggers }
  });
  context.console = { log: (message) => logs.push(message) };
  const beforeScript = { ...scriptStore.values };
  const beforeUser = { ...userStore.values };

  const report = context.setupStatus();

  assert.equal(report.projectTimeZone, 'America/Los_Angeles');
  assert.equal(report.allSafetyDefaultsCorrect, true);
  assert.equal(report.allSafetySettingsValid, true);
  for (const key of [
    'SYNC_LIST_DISCOVERY_MODE',
    'SYNC_ALLOW_DELETIONS',
    'SYNC_ALLOW_LIST_DELETIONS',
    'SYNC_ALLOW_TASK_MOVES'
  ]) {
    assert.equal(report.safetyDefaults[key].correct, true, key);
    assert.equal(report.safetyDefaults[key].valid, true, key);
    assert.equal(report.safetyDefaults[key].matchesPublicDefault, true, key);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report.credentials)), {
    msClientIdPresent: true,
    msClientSecretPresent: true,
    msTenantIdPresent: true,
    usesCommonTenant: false,
    alertEmailPresent: true,
    effectiveAlertRecipientAvailable: true
  });
  assert.equal(report.syncAllTriggerCount, 2);
  const serialized = JSON.stringify(report) + logs.join('\n');
  for (const sentinel of [
    'client-id-sentinel',
    'secret-sentinel',
    'tenant-id-sentinel',
    'email-sentinel@example.invalid',
    'google-list-sentinel',
    'state-sentinel'
  ]) {
    assert.equal(serialized.includes(sentinel), false, `must not disclose ${sentinel}`);
  }
  assert.deepEqual(scriptStore.values, beforeScript);
  assert.deepEqual(userStore.values, beforeUser);
});

test('setupStatus accepts deliberate valid overrides while showing public-default mismatches', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'explicit',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_ALLOW_LIST_DELETIONS: 'false',
      SYNC_ALLOW_TASK_MOVES: 'false'
    },
    scriptApp: { getProjectTriggers: () => [] }
  });
  context.console = { log: () => {} };

  const report = context.setupStatus();

  assert.equal(report.allSafetySettingsValid, true);
  assert.equal(report.allSafetyDefaultsCorrect, false);
  for (const key of [
    'SYNC_LIST_DISCOVERY_MODE',
    'SYNC_ALLOW_DELETIONS',
    'SYNC_ALLOW_LIST_DELETIONS',
    'SYNC_ALLOW_TASK_MOVES'
  ]) {
    assert.equal(report.safetyDefaults[key].valid, true, key);
    assert.equal(report.safetyDefaults[key].matchesPublicDefault, false, key);
  }
  assert.equal(
    report.nextSteps.some((item) => item.code === 'SAFETY_SETTINGS_MISSING_OR_INVALID'),
    false
  );
});

test('setupStatus reports missing and invalid safety settings without exposing stored values', () => {
  const { context } = loadContext({
    scriptTimeZone: undefined,
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'invalid-discovery-sentinel',
      SYNC_ALLOW_DELETIONS: 'invalid-deletions-sentinel',
      SYNC_ALLOW_LIST_DELETIONS: 'false'
    },
    scriptApp: { getProjectTriggers: () => { throw new Error('restricted'); } }
  });
  context.console = { log: () => {} };

  const report = context.setupStatus();

  assert.equal(report.projectTimeZone, 'Asia/Taipei');
  assert.equal(report.allSafetyDefaultsCorrect, false);
  assert.equal(report.allSafetySettingsValid, false);
  assert.equal(report.safetyDefaults.SYNC_LIST_DISCOVERY_MODE.value, 'Invalid configuration');
  assert.equal(report.safetyDefaults.SYNC_ALLOW_DELETIONS.value, 'Invalid configuration');
  assert.equal(report.safetyDefaults.SYNC_ALLOW_LIST_DELETIONS.valid, true);
  assert.equal(report.safetyDefaults.SYNC_ALLOW_TASK_MOVES.value, 'Not configured');
  assert.equal(report.credentials.msClientIdPresent, false);
  assert.equal(report.credentials.msClientSecretPresent, false);
  assert.equal(report.credentials.msTenantIdPresent, false);
  assert.equal(report.credentials.usesCommonTenant, true);
  assert.equal(report.credentials.alertEmailPresent, false);
  assert.equal(report.credentials.effectiveAlertRecipientAvailable, false);
  assert.equal(report.syncAllTriggerCount, 0);
  assert.ok(report.nextSteps.some((item) => item.code === 'SAFETY_SETTINGS_MISSING_OR_INVALID'));
  assert.ok(report.nextSteps.some((item) => item.code === 'SYNC_TRIGGER_STATUS_UNAVAILABLE'));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('invalid-discovery-sentinel'), false);
  assert.equal(serialized.includes('invalid-deletions-sentinel'), false);
});

test('alerts prefer an explicit override and otherwise use the effective Google account without disclosure', () => {
  const sent = [];
  const mailApp = {
    getRemainingDailyQuota: () => 10,
    sendEmail: (message) => sent.push({ ...message })
  };
  const fallback = loadContext({
    effectiveUserEmail: 'effective-user@example.invalid', mailApp
  });
  fallback.context.console = { log: () => {}, warn: () => {}, error: () => {} };
  assert.equal(fallback.context.sendMailAlert_('subject', 'body'), true);
  assert.equal(sent.at(-1).to, 'effective-user@example.invalid');

  const override = loadContext({
    effectiveUserEmail: 'effective-user@example.invalid',
    scriptValues: { ALERT_EMAIL: 'override@example.invalid' },
    mailApp
  });
  override.context.console = { log: () => {}, warn: () => {}, error: () => {} };
  assert.equal(override.context.sendMailAlert_('subject', 'body'), true);
  assert.equal(sent.at(-1).to, 'override@example.invalid');
  const report = override.context.setupStatus();
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('effective-user@example.invalid'), false);
  assert.equal(serialized.includes('override@example.invalid'), false);
});

test('storage pressure sends one best-effort alert per cooldown without blocking a successful save', () => {
  const userValues = {};
  for (let i = 0; i < 46; i += 1) userValues['other_' + i] = 'x'.repeat(8000);
  const sent = [];
  const { context, scriptStore } = loadContext({
    effectiveUserEmail: 'effective-user@example.invalid',
    userValues,
    mailApp: {
      getRemainingDailyQuota: () => 10,
      sendEmail: (message) => sent.push({ ...message })
    }
  });
  context.console = { log: () => {}, warn: () => {}, error: () => {} };

  assert.doesNotThrow(() => context.saveState_(context.newState_()));
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /State storage/);
  assert.match(sent[0].body, /small batch of old completed tasks/);
  assert.match(sent[0].body, /two complete sync rounds/);
  assert.match(sent[0].body, /deletion safety records remain for 30 days/);
  assert.match(sent[0].body, /genuinely be approaching its capacity boundary/);
  assert.match(sent[0].body, /Expired deletion records are cleaned automatically/);
  assert.match(sent[0].body, /do not clear tombstones or state properties manually/);
  assert.ok(scriptStore.getProperty('alert_storage_pressure_last_at'));
  assert.doesNotThrow(() => context.saveState_(context.newState_()));
  assert.equal(sent.length, 1, 'the 30-day cooldown prevents repeated pressure mail');
});

function mappedTaskState(context, {
  gUpdated = '2026-08-14T00:00:00Z',
  msUpdated = '2026-08-14T00:00:00Z'
} = {}) {
  const state = context.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m = {
    'g-task': {
      msId: 'ms-task',
      gListId: 'g-list',
      msListId: 'ms-list',
      gUpdated,
      msUpdated
    }
  };
  state.m2g = { 'ms-task': 'g-task' };
  return state;
}

function mappedTaskSnapshot({
  gTask = { id: 'g-task', title: 'Google task', updated: '2026-08-14T00:00:00Z' },
  msTask = { id: 'ms-task', title: 'Microsoft task', lastModifiedDateTime: '2026-08-14T00:00:00Z' },
  allowDeletions = true,
  allowTaskMoves = false,
  inventoryComplete = true,
  activeGListIds = { 'g-list': true },
  gTaskInventoryListIds = { 'g-list': true },
  msTaskInventoryListIds = { 'ms-list': true }
} = {}) {
  return {
    activeGListIds,
    gTaskInventoryListIds,
    msTaskInventoryListIds,
    inventoryComplete,
    safety: { allowDeletions, allowTaskMoves },
    gTasksById: gTask ? { 'g-task': gTask } : {},
    msTasksById: msTask ? { 'ms-task': msTask } : {},
    gListByTask: gTask ? { 'g-task': 'g-list' } : {},
    msListByTask: msTask ? { 'ms-task': 'ms-list' } : {}
  };
}

function readyDeletionCandidate(state, missingSide, roundId = 'round-2') {
  const rec = state.g2m['g-task'];
  state.pendingTaskDeletions['g-task'] = {
    gId: 'g-task',
    msId: 'ms-task',
    missingSide,
    gListId: rec.gListId,
    msListId: rec.msListId,
    gUpdated: rec.gUpdated,
    msUpdated: rec.msUpdated,
    confirmations: 2,
    lastRoundId: roundId
  };
}

test('uses the Apps Script project time zone and has a Node-safe fallback', () => {
  const { context: fallback } = loadContext();
  const { context: project } = loadContext({ scriptTimeZone: 'America/Los_Angeles' });

  assert.equal(fallback.syncTimeZone_(), 'Asia/Taipei');
  assert.equal(project.syncTimeZone_(), 'America/Los_Angeles');
});

test('converts offset Microsoft due instants to the project calendar date', () => {
  const { context } = loadContext();

  assert.equal(
    context.googleDue_({ dateTime: '2026-08-20T16:30:00.0000000Z', timeZone: 'UTC' }),
    '2026-08-21T00:00:00.000Z'
  );
  assert.equal(
    context.googleDue_({ dateTime: '2025-12-31T16:30:00+00:00', timeZone: 'UTC' }),
    '2026-01-01T00:00:00.000Z'
  );
});

test('converts no-offset Graph due values through their supplied time zone', () => {
  const { context } = loadContext();

  assert.equal(
    context.googleDue_({
      dateTime: '2026-08-20T16:00:00.0000000',
      timeZone: 'UTC'
    }),
    '2026-08-21T00:00:00.000Z'
  );
  assert.equal(
    context.googleDue_({
      dateTime: '2026-03-08T16:30:00.0000000',
      timeZone: 'Pacific Standard Time'
    }),
    '2026-03-09T00:00:00.000Z'
  );
  assert.equal(
    context.googleDue_({
      dateTime: '2026-11-01T16:30:00.0000000',
      timeZone: 'America/Los_Angeles'
    }),
    '2026-11-02T00:00:00.000Z'
  );
  assert.equal(
    context.googleDue_({
      dateTime: '2026-03-08T02:30:00.0000000',
      timeZone: 'Pacific Standard Time'
    }),
    null
  );
});

test('uses Utilities to project offset instants when running in Apps Script', () => {
  const calls = [];
  const { context } = loadContext({
    utilities: {
      formatDate(instant, timeZone, format) {
        calls.push([instant.toISOString(), timeZone, format]);
        return format === 'yyyy-MM-dd' ? '2026-08-21' : '+0800';
      }
    }
  });

  assert.equal(
    context.googleDue_({ dateTime: '2026-08-20T16:30:00Z', timeZone: 'UTC' }),
    '2026-08-21T00:00:00.000Z'
  );
  assert.deepEqual(calls, [['2026-08-20T16:30:00.000Z', 'Asia/Taipei', 'yyyy-MM-dd']]);
});

test('adds the project time zone Prefer header to every Microsoft task request', () => {
  const { context } = loadContext();
  const calls = [];
  context.graphFetch_ = (url, options) => {
    calls.push({ url, options });
    if (url.includes('?$top=')) {
      return { value: [], '@odata.nextLink': 'https://graph.microsoft.com/next' };
    }
    return { value: [], id: 'task-id' };
  };

  context.getMsTasks_('list id');
  context.createMsTask_('list id', { title: 'Create' });
  context.updateMsTask_('list id', 'task id', { title: 'Update' });
  context.deleteMsTask_('list id', 'task id');

  assert.equal(calls.length, 5);
  assert.equal(
    calls.every((call) => call.options.headers.Prefer === 'outlook.timezone="Asia/Taipei"'),
    true
  );
  assert.equal(calls[0].url.includes('list%20id/tasks?$top=100'), true);
  assert.equal(calls[1].url, 'https://graph.microsoft.com/next');
  assert.equal(calls[2].options.method, 'post');
  assert.equal(calls[3].options.method, 'patch');
  assert.equal(calls[4].options.method, 'delete');
});

test('Graph 429 retry honors Retry-After and returns success without a real wait', () => {
  const sleeps = [];
  const fetches = [];
  const responses = [
    httpResponse(429, 'retry later', { 'Retry-After': '2' }),
    httpResponse(200, JSON.stringify({ id: 'created-task' }))
  ];
  const { context } = loadContext({
    utilities: { sleep: (milliseconds) => sleeps.push(milliseconds) },
    urlFetchApp: {
      fetch(url, options) {
        fetches.push({ url, options });
        return responses.shift();
      }
    }
  });
  context.microsoftService_ = () => ({
    hasAccess: () => true,
    getAccessToken: () => 'test-token'
  });

  const result = context.graphFetch_('https://example.invalid/graph', { method: 'get' });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { id: 'created-task' });
  assert.equal(fetches.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fetches[0].options.headers.Authorization, 'Bearer test-token');
});

test('Graph exhausted 429 retries throw after HTTP_MAX_RETRIES plus one attempts without real waits', () => {
  const sleeps = [];
  let fetches = 0;
  const { context } = loadContext({
    utilities: { sleep: (milliseconds) => sleeps.push(milliseconds) },
    urlFetchApp: {
      fetch() {
        fetches += 1;
        return httpResponse(429, 'retry budget exhausted', { 'Retry-After': '0' });
      }
    }
  });
  context.microsoftService_ = () => ({
    hasAccess: () => true,
    getAccessToken: () => 'test-token'
  });
  const maxRetries = vm.runInContext('HTTP_MAX_RETRIES', context);

  assert.throws(() => {
    context.graphFetch_('https://example.invalid/graph', { method: 'get' });
  }, /HTTP 429: retry budget exhausted/);
  assert.equal(fetches, maxRetries + 1);
  assert.equal(sleeps.length, maxRetries);
  assert.equal(sleeps.every(Number.isFinite), true);
});

test('uses create and update notes semantics without trimming non-empty text', () => {
  const { context } = loadContext();
  const emptyNotes = [undefined, null, '', ' ', '\t\n\r', '\u00a0', ' \t\n\u00a0 '];
  for (const notes of emptyNotes) {
    const task = { title: 'Empty notes', notes };
    const createPayload = context.msPayloadFromGoogle_(task, 'create');
    const updatePayload = context.msPayloadFromGoogle_(task, 'update');
    assert.equal(Object.hasOwn(createPayload, 'body'), false, `create body for ${JSON.stringify(notes)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(updatePayload.body)), { contentType: 'html', content: '' });
  }

  const cases = [
    ['一般多行文字\n第二行', '一般多行文字<br>第二行'],
    ['  前後有意義的空白  ', '  前後有意義的空白  '],
    ['<tag>& "quoted"', '&lt;tag&gt;&amp; "quoted"'],
    ['\u1680', '\u1680'],
    ['\u3000', '\u3000'],
    ['\u2003', '\u2003'],
    ['\u202f', '\u202f'],
    ['\ufeff', '\ufeff']
  ];
  for (const [notes, html] of cases) {
    const task = { title: 'Non-empty notes', notes };
    assert.deepEqual(JSON.parse(JSON.stringify(context.msPayloadFromGoogle_(task, 'create').body)), {
      contentType: 'html',
      content: html
    });
    assert.deepEqual(JSON.parse(JSON.stringify(context.msPayloadFromGoogle_(task, 'update').body)), {
      contentType: 'html',
      content: html
    });
  }

  const roundTripText = '第一行\n第二行 & <tag>';
  const roundTripBody = context.msPayloadFromGoogle_(
    { title: 'Round trip', notes: roundTripText }, 'create'
  ).body;
  assert.equal(
    context.googlePayloadFromMs_({ title: 'Round trip', body: roundTripBody }).notes,
    roundTripText
  );
});

test('requires an explicit valid Google-to-Microsoft payload mode', () => {
  const { context } = loadContext();
  for (const mode of [undefined, null, '', 'delete', 'CREATE', 0]) {
    assert.throws(
      () => context.msPayloadFromGoogle_({ title: 'Task' }, mode),
      /MS_PAYLOAD_MODE_REQUIRED/
    );
  }
});

test('sends exact Microsoft create and update request payloads for Google notes', () => {
  const { context } = loadContext();
  const calls = [];
  context.graphFetch_ = (url, options) => {
    calls.push({ url, options });
    return { id: 'ms-task' };
  };

  context.createMsTask_('list id', context.msPayloadFromGoogle_(
    { title: 'Create', notes: '\u00a0' }, 'create'
  ));
  context.updateMsTask_('list id', 'task id', context.msPayloadFromGoogle_(
    { title: 'Update', notes: '\t\n' }, 'update'
  ));
  context.createMsTask_('list id', context.msPayloadFromGoogle_(
    { title: 'Create text', notes: '  A & <B>\n' }, 'create'
  ));
  context.updateMsTask_('list id', 'task id', context.msPayloadFromGoogle_(
    { title: 'Update text', notes: '  A & <B>\n' }, 'update'
  ));

  assert.equal(calls[0].options.payload, JSON.stringify({
    title: 'Create',
    dueDateTime: null,
    status: 'notStarted'
  }));
  assert.equal(calls[1].options.payload, JSON.stringify({
    title: 'Update',
    body: { contentType: 'html', content: '' },
    dueDateTime: null,
    status: 'notStarted'
  }));
  assert.equal(calls[2].options.payload, JSON.stringify({
    title: 'Create text',
    body: { contentType: 'html', content: '  A &amp; &lt;B&gt;<br>' },
    dueDateTime: null,
    status: 'notStarted'
  }));
  assert.equal(calls[3].options.payload, JSON.stringify({
    title: 'Update text',
    body: { contentType: 'html', content: '  A &amp; &lt;B&gt;<br>' },
    dueDateTime: null,
    status: 'notStarted'
  }));
});

test('rejects null, malformed RFC3339, and invalid time-zone due values', () => {
  const { context } = loadContext();

  assert.equal(context.googleDue_(null), null);
  assert.equal(context.googleDue_({ dateTime: '2025-02-29T00:00:00Z', timeZone: 'UTC' }), null);
  assert.equal(context.googleDue_({ dateTime: '2026-08-21T00:00:00+25:00', timeZone: 'UTC' }), null);
  assert.equal(context.googleDue_({ dateTime: '2026-08-21T00:00:00' }), null);
  assert.equal(context.googleDue_({ dateTime: '2026-08-21T00:00:00', timeZone: 'Invalid Time Zone' }), null);
  assert.equal(context.msDue_(null), null);
  assert.equal(context.msDue_('2026-13-01T00:00:00.000Z'), null);
  assert.equal(context.msDue_('2026-08-21'), null);
  assert.equal(context.msDue_('2026-08-21T00:00:00.123Z'), null);

  const { context: invalidProjectZone } = loadContext({ scriptTimeZone: 'Invalid Time Zone' });
  assert.equal(invalidProjectZone.msDue_('2026-08-21T00:00:00.000Z'), null);
  assert.throws(() => invalidProjectZone.getMsTasks_('list-id'), /SYNC_TIME_ZONE_INVALID/);
});

test('round-trips date-only due values without changing their next sync payload', () => {
  const { context } = loadContext();
  const googleDue = '2026-08-21T00:00:00.000Z';
  const firstMicrosoft = context.msDue_(googleDue);
  const returnedGoogle = context.googleDue_({
    dateTime: firstMicrosoft.dateTime + '.0000000',
    timeZone: 'Taipei Standard Time'
  });
  const secondMicrosoft = context.msDue_(returnedGoogle);

  assert.deepEqual(JSON.parse(JSON.stringify(firstMicrosoft)), {
    dateTime: '2026-08-21T00:00:00',
    timeZone: 'Asia/Taipei'
  });
  assert.equal(returnedGoogle, googleDue);
  assert.deepEqual(JSON.parse(JSON.stringify(secondMicrosoft)), JSON.parse(JSON.stringify(firstMicrosoft)));
});

test('parses allowlist and keeps deletions disabled by default', () => {
  const { context } = loadContext({
    scriptValues: { SYNC_GOOGLE_LIST_IDS: 'list-a, list-b list-a' }
  });
  const result = context.getSafetyConfig_();
  assert.deepEqual([...result.googleListIds], ['list-a', 'list-b']);
  assert.equal(result.allowDeletions, false);
  assert.equal(result.allowTaskMoves, false);
});

test('requires an explicit Google list allowlist', () => {
  const { context } = loadContext();
  assert.throws(
    () => context.requireSyncAllowlist_(context.getSafetyConfig_()),
    /SYNC_ALLOWLIST_REQUIRED/
  );
});

test('parses one-to-one explicit list pairs only for the complete allowlist', () => {
  const { context } = loadContext();
  const result = context.parseConfiguredListPairs_(JSON.stringify([
    { googleListId: 'g-one', microsoftListId: 'ms-one' },
    { googleListId: 'g-two', microsoftListId: 'ms-two' }
  ]), {
    googleListIds: ['g-one', 'g-two'],
    allowDeletions: false
  }, true);

  assert.equal(result.configured, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.pairs)),
    [
      { googleListId: 'g-one', microsoftListId: 'ms-one' },
      { googleListId: 'g-two', microsoftListId: 'ms-two' }
    ]
  );
});

test('rejects explicit pairs outside or incomplete for the allowlist', () => {
  const { context } = loadContext();
  assert.throws(
    () => context.parseConfiguredListPairs_(JSON.stringify([
      { googleListId: 'g-other', microsoftListId: 'ms-one' }
    ]), {
      googleListIds: ['g-one'],
      allowDeletions: false
    }, true),
    /SYNC_PAIR_NOT_ALLOWLISTED/
  );
  assert.throws(
    () => context.parseConfiguredListPairs_(JSON.stringify([
      { googleListId: 'g-one', microsoftListId: 'ms-one' }
    ]), {
      googleListIds: ['g-one', 'g-two'],
      allowDeletions: false
    }, true),
    /SYNC_PAIR_ALLOWLIST_UNPAIRED/
  );
});

test('rejects duplicate Microsoft targets in explicit list pairs', () => {
  const { context } = loadContext();
  assert.throws(
    () => context.parseConfiguredListPairs_(JSON.stringify([
      { googleListId: 'g-one', microsoftListId: 'ms-shared' },
      { googleListId: 'g-two', microsoftListId: 'ms-shared' }
    ]), {
      googleListIds: ['g-one', 'g-two'],
      allowDeletions: false
    }, true),
    /SYNC_PAIR_DUPLICATE_MICROSOFT/
  );
});

test('builds configured pairs from complete existing mappings in allowlist order', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.listMap = {
    'g-two': 'ms-two',
    'g-one': 'ms-one'
  };

  const pairs = context.buildConfiguredPairsFromExistingMappings_(state, {
    googleListIds: ['g-one', 'g-two'],
    allowDeletions: false
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(pairs)),
    [
      { googleListId: 'g-one', microsoftListId: 'ms-one' },
      { googleListId: 'g-two', microsoftListId: 'ms-two' }
    ]
  );
});

test('rejects adoption when an allowlisted Google list has no mapping', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.listMap['g-one'] = 'ms-one';

  assert.throws(
    () => context.buildConfiguredPairsFromExistingMappings_(state, {
      googleListIds: ['g-one', 'g-two'],
      allowDeletions: false
    }),
    /SYNC_PAIR_ADOPT_MAPPING_MISSING/
  );
});

test('rejects adoption when existing mappings share a Microsoft list', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.listMap = {
    'g-one': 'ms-shared',
    'g-two': 'ms-shared'
  };

  assert.throws(
    () => context.buildConfiguredPairsFromExistingMappings_(state, {
      googleListIds: ['g-one', 'g-two'],
      allowDeletions: false
    }),
    /STATE_MALFORMED.*not one-to-one/
  );
});

test('treats configured pairs as equivalent regardless of JSON order', () => {
  const { context } = loadContext();
  assert.equal(context.configuredListPairsEquivalent_([
    { googleListId: 'g-one', microsoftListId: 'ms-one' },
    { googleListId: 'g-two', microsoftListId: 'ms-two' }
  ], [
    { googleListId: 'g-two', microsoftListId: 'ms-two' },
    { googleListId: 'g-one', microsoftListId: 'ms-one' }
  ]), true);
  assert.equal(context.configuredListPairsEquivalent_([
    { googleListId: 'g-one', microsoftListId: 'ms-one' }
  ], [
    { googleListId: 'g-one', microsoftListId: 'ms-other' }
  ]), false);
});

test('requires both Google and Microsoft inventory IDs before adoption', () => {
  const { context } = loadContext();
  assert.throws(
    () => context.validateConfiguredListPairInventory_([
      { googleListId: 'g-missing', microsoftListId: 'ms-missing' }
    ], [], []),
    (error) => /SYNC_PAIR_GOOGLE_NOT_FOUND/.test(error.message) &&
      /SYNC_PAIR_MICROSOFT_NOT_FOUND/.test(error.message)
  );
});

test('blocks silent rebinding of an existing Google list mapping', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.listMap['g-one'] = 'ms-original';

  assert.throws(
    () => context.validateConfiguredListPairState_([
      { googleListId: 'g-one', microsoftListId: 'ms-new' }
    ], state),
    /SYNC_PAIR_REBIND_BLOCKED/
  );
});

test('blocks pairing a Microsoft list already owned by another Google list', () => {
  const { context } = loadContext();
  const state = context.newState_();
  state.listMap['g-existing'] = 'ms-one';

  assert.throws(
    () => context.validateConfiguredListPairState_([
      { googleListId: 'g-new', microsoftListId: 'ms-one' }
    ], state),
    /SYNC_PAIR_MICROSOFT_IN_USE/
  );
});

test('requires configured list pairs to be applied before sync', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-one' }
      ])
    }
  });
  const state = context.newState_();
  assert.throws(
    () => context.requireConfiguredListPairsApplied_(state, context.getSafetyConfig_()),
    /SYNC_PAIR_NOT_APPLIED/
  );
});

test('snapshot blocks pending explicit pairs before reading or creating lists', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-one' }
      ])
    }
  });
  let googleListReads = 0;
  let createCalls = 0;
  context.getGLists_ = () => {
    googleListReads += 1;
    return [];
  };
  context.createMsList_ = () => {
    createCalls += 1;
    return { id: 'unexpected' };
  };

  assert.throws(
    () => context.buildSnapshot_(context.newState_(), Date.now()),
    /SYNC_PAIR_NOT_APPLIED/
  );
  assert.equal(googleListReads, 0);
  assert.equal(createCalls, 0);
});

test('refuses to apply first-time list pairs while deletions are enabled', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'true',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-one' }
      ])
    }
  });
  context.withGlobalLock_ = (fn) => fn();
  assert.throws(
    () => context.applyConfiguredListPairs(),
    /SYNC_PAIR_DELETIONS_MUST_BE_FALSE/
  );
});

test('applies validated explicit list pairs without creating cloud lists', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-one' }
      ])
    }
  });
  const state = context.newState_();
  let saveCalls = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.getGLists_ = () => [{ id: 'g-one', title: 'Existing Google' }];
  context.getMsLists_ = () => [{ id: 'ms-one', displayName: 'Existing Microsoft' }];
  context.createMsList_ = () => { throw new Error('must not create a list'); };
  context.saveState_ = () => { saveCalls += 1; };

  const report = context.applyConfiguredListPairs();
  assert.equal(state.listMap['g-one'], 'ms-one');
  assert.equal(report.applied, 1);
  assert.equal(report.deletionsEnabled, false);
  assert.equal(saveCalls, 1);
});

test('snapshot reuses an applied existing-list pair without creating a Microsoft list', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-one' }
      ])
    }
  });
  const state = context.newState_();
  state.listMap['g-one'] = 'ms-one';
  let createCalls = 0;
  context.getGLists_ = () => [{ id: 'g-one', title: 'Existing Google' }];
  context.getMsLists_ = () => [{ id: 'ms-one', displayName: 'Existing Microsoft' }];
  context.getGTasks_ = () => [];
  context.getMsTasks_ = () => [];
  context.createMsList_ = () => {
    createCalls += 1;
    return { id: 'unexpected' };
  };
  context.alertListFaultsIfAny_ = () => {};

  const snapshot = context.buildSnapshot_(state, Date.now());
  assert.equal(createCalls, 0);
  assert.deepEqual(Object.keys(snapshot.activeGListIds), ['g-one']);
});

test('explicit pair apply is all-or-nothing when any mapping conflicts', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one,g-two',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-one' },
        { googleListId: 'g-two', microsoftListId: 'ms-two' }
      ])
    }
  });
  const state = context.newState_();
  state.listMap['g-two'] = 'ms-original';
  let saveCalls = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.getGLists_ = () => [
    { id: 'g-one', title: 'One' },
    { id: 'g-two', title: 'Two' }
  ];
  context.getMsLists_ = () => [
    { id: 'ms-one', displayName: 'One' },
    { id: 'ms-two', displayName: 'Two' }
  ];
  context.saveState_ = () => { saveCalls += 1; };

  assert.throws(() => context.applyConfiguredListPairs(), /SYNC_PAIR_REBIND_BLOCKED/);
  assert.equal(state.listMap['g-one'], undefined);
  assert.equal(state.listMap['g-two'], 'ms-original');
  assert.equal(saveCalls, 0);
});

test('adopts existing mappings by writing only the explicit pair property', () => {
  const { context, scriptStore } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'false'
    }
  });
  const state = context.newState_();
  state.listMap['g-one'] = 'ms-one';
  const beforeState = JSON.stringify(state);
  let lockCalls = 0;
  let setCalls = 0;
  const originalSetProperty = scriptStore.setProperty.bind(scriptStore);
  scriptStore.setProperty = (key, value) => {
    setCalls += 1;
    originalSetProperty(key, value);
  };
  context.withGlobalLock_ = (fn) => {
    lockCalls += 1;
    return fn();
  };
  context.loadStateForInspection_ = () => ({ corrupt: false, state });
  context.getGLists_ = () => [{ id: 'g-one', title: 'Existing Google' }];
  context.getMsLists_ = () => [{ id: 'ms-one', displayName: 'Existing Microsoft' }];
  context.saveState_ = () => { throw new Error('must not save sync state'); };
  context.createMsList_ = () => { throw new Error('must not create a list'); };

  const report = context.adoptExistingListMappingsAsConfiguredPairs();
  assert.equal(report.changed, true);
  assert.equal(report.status, 'CONFIG_CREATED');
  assert.equal(report.deletionsEnabled, false);
  assert.equal(lockCalls, 1);
  assert.equal(setCalls, 1);
  assert.equal(
    scriptStore.getProperty('SYNC_LIST_PAIRS_JSON'),
    JSON.stringify([{ googleListId: 'g-one', microsoftListId: 'ms-one' }])
  );
  assert.equal(JSON.stringify(state), beforeState);
});

test('adopting an equivalent existing pair property is idempotent', () => {
  const existingJson = JSON.stringify([
    { googleListId: 'g-two', microsoftListId: 'ms-two' },
    { googleListId: 'g-one', microsoftListId: 'ms-one' }
  ]);
  const { context, scriptStore } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one,g-two',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_LIST_PAIRS_JSON: existingJson
    }
  });
  const state = context.newState_();
  state.listMap = { 'g-one': 'ms-one', 'g-two': 'ms-two' };
  let setCalls = 0;
  const originalSetProperty = scriptStore.setProperty.bind(scriptStore);
  scriptStore.setProperty = (key, value) => {
    setCalls += 1;
    originalSetProperty(key, value);
  };
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForInspection_ = () => ({ corrupt: false, state });
  context.getGLists_ = () => [
    { id: 'g-one', title: 'One' },
    { id: 'g-two', title: 'Two' }
  ];
  context.getMsLists_ = () => [
    { id: 'ms-one', displayName: 'One' },
    { id: 'ms-two', displayName: 'Two' }
  ];

  const report = context.adoptExistingListMappingsAsConfiguredPairs();
  assert.equal(report.changed, false);
  assert.equal(report.status, 'ALREADY_CONFIGURED');
  assert.equal(setCalls, 0);
  assert.equal(scriptStore.getProperty('SYNC_LIST_PAIRS_JSON'), existingJson);
});

test('refuses to overwrite a different existing pair property during adoption', () => {
  const { context, scriptStore } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-one', microsoftListId: 'ms-other' }
      ])
    }
  });
  const state = context.newState_();
  state.listMap['g-one'] = 'ms-one';
  let setCalls = 0;
  const originalSetProperty = scriptStore.setProperty.bind(scriptStore);
  scriptStore.setProperty = (key, value) => {
    setCalls += 1;
    originalSetProperty(key, value);
  };
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForInspection_ = () => ({ corrupt: false, state });
  context.getGLists_ = () => [{ id: 'g-one', title: 'One' }];
  context.getMsLists_ = () => [{ id: 'ms-one', displayName: 'One' }];

  assert.throws(
    () => context.adoptExistingListMappingsAsConfiguredPairs(),
    /SYNC_PAIR_ADOPT_PROPERTY_CONFLICT/
  );
  assert.equal(setCalls, 0);
});

test('refuses to overwrite an existing blank pair property during adoption', () => {
  const { context, scriptStore } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_LIST_PAIRS_JSON: '   '
    }
  });
  const state = context.newState_();
  state.listMap['g-one'] = 'ms-one';
  let setCalls = 0;
  const originalSetProperty = scriptStore.setProperty.bind(scriptStore);
  scriptStore.setProperty = (key, value) => {
    setCalls += 1;
    originalSetProperty(key, value);
  };
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForInspection_ = () => ({ corrupt: false, state });
  context.getGLists_ = () => [{ id: 'g-one', title: 'One' }];
  context.getMsLists_ = () => [{ id: 'ms-one', displayName: 'One' }];

  assert.throws(
    () => context.adoptExistingListMappingsAsConfiguredPairs(),
    /SYNC_PAIR_ADOPT_PROPERTY_CONFLICT/
  );
  assert.equal(setCalls, 0);
  assert.equal(scriptStore.getProperty('SYNC_LIST_PAIRS_JSON'), '   ');
});

test('refuses mapping adoption from corrupt state before inventory reads', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'false'
    }
  });
  let inventoryReads = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForInspection_ = () => ({ corrupt: true, state: context.newState_() });
  context.getGLists_ = () => {
    inventoryReads += 1;
    return [];
  };
  context.getMsLists_ = () => {
    inventoryReads += 1;
    return [];
  };

  assert.throws(
    () => context.adoptExistingListMappingsAsConfiguredPairs(),
    /STATE_CORRUPT/
  );
  assert.equal(inventoryReads, 0);
});

test('refuses mapping adoption while deletions are enabled', () => {
  const { context } = loadContext({
    scriptValues: {
      SYNC_GOOGLE_LIST_IDS: 'g-one',
      SYNC_ALLOW_DELETIONS: 'true'
    }
  });
  let stateReads = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForInspection_ = () => {
    stateReads += 1;
    return { corrupt: false, state: context.newState_() };
  };

  assert.throws(
    () => context.adoptExistingListMappingsAsConfiguredPairs(),
    /SYNC_PAIR_DELETIONS_MUST_BE_FALSE/
  );
  assert.equal(stateReads, 0);
});

test('counts and resets mappings by Microsoft list ID', () => {
  const { context } = loadContext();
  const state = {
    listMap: { 'g-list': 'ms-list' },
    g2m: {
      'g-task': {
        msId: 'ms-task',
        gListId: 'g-list',
        msListId: 'ms-list'
      }
    },
    m2g: { 'ms-task': 'g-task' },
    pendingTaskDeletions: { 'g-task': { confirmations: 1 } },
    deletionJournal: {},
    taskDeletionConflicts: { 'g-task': { reason: 'DELETE_VS_EDIT_CONFLICT' } },
    listFaults: { g: {}, ms: { 'ms-list': { reason: 'missing' } } }
  };

  assert.equal(context.countAffectedMappings_(state, null, 'ms-list'), 1);
  context.resetListPairing_(state, null, 'ms-list');
  assert.deepEqual(Object.keys(state.g2m), []);
  assert.deepEqual(Object.keys(state.m2g), []);
  assert.deepEqual(Object.keys(state.listMap), []);
  assert.deepEqual(Object.keys(state.pendingTaskDeletions), []);
  assert.deepEqual(Object.keys(state.deletionJournal), []);
  assert.deepEqual(Object.keys(state.taskDeletionConflicts), []);
  assert.deepEqual(Object.keys(state.listFaults.ms), []);
});

test('cleans old state generations with the supported single-key API', () => {
  const { context, userStore } = loadContext({
    userValues: {
      'sync_state_main_gen_old_0': 'old',
      'sync_state_main_gen_old_count': '1',
      'sync_state_main_gen_previous_0': 'previous',
      'sync_state_main_gen_previous_count': '1',
      'sync_state_main_gen_current_0': 'current',
      'sync_state_main_gen_current_count': '1'
    }
  });

  context.cleanupOldGenerations_(userStore, 'sync_state_main', 'current', 'previous');
  assert.equal(userStore.getProperty('sync_state_main_gen_old_0'), null);
  assert.equal(userStore.getProperty('sync_state_main_gen_previous_0'), 'previous');
  assert.equal(userStore.getProperty('sync_state_main_gen_current_0'), 'current');
});

test('rejects incomplete imported state', () => {
  const { context } = loadContext();
  assert.throws(() => context.validateImportedState_({}), /schema=2/);
});

test('does not propagate a missing Google task while deletions are disabled', () => {
  const { context } = loadContext();
  let deleteCalls = 0;
  context.deleteMsTask_ = () => { deleteCalls += 1; };
  const state = {
    listMap: { 'g-list': 'ms-list' },
    g2m: {
      'g-task': {
        msId: 'ms-task',
        gListId: 'g-list',
        msListId: 'ms-list',
        gUpdated: null,
        msUpdated: null
      }
    },
    m2g: { 'ms-task': 'g-task' },
    tombstones: { g: {}, m: {} },
    listFaults: { g: {}, ms: {} }
  };
  const snapshot = {
    activeGListIds: { 'g-list': true },
    safety: { allowDeletions: false },
    gTasksById: {},
    msTasksById: {
      'ms-task': { id: 'ms-task', title: 'Keep me', lastModifiedDateTime: '2026-08-14T00:00:00Z' }
    },
    gListByTask: {},
    msListByTask: { 'ms-task': 'ms-list' }
  };

  context.reconcileMapped_(state, snapshot, Date.now());
  assert.equal(deleteCalls, 0);
  assert.equal(state.g2m['g-task'].msId, 'ms-task');
});

test('keeps Google cross-list moves disabled independently of deletion propagation', () => {
  const { context } = loadContext();
  const calls = [];
  context.createMsTask_ = () => {
    calls.push('create');
    return { id: 'ms-task-new', lastModifiedDateTime: '2026-08-14T00:02:00Z' };
  };
  context.deleteMsTask_ = () => { calls.push('delete'); };
  const state = {
    listMap: { 'g-old': 'ms-old', 'g-new': 'ms-new' },
    g2m: {
      'g-task': {
        msId: 'ms-task-old',
        gListId: 'g-old',
        msListId: 'ms-old',
        gUpdated: '2026-08-14T00:00:00Z',
        msUpdated: '2026-08-14T00:00:00Z'
      }
    },
    m2g: { 'ms-task-old': 'g-task' },
    tombstones: { g: {}, m: {} },
    listFaults: { g: {}, ms: {} }
  };
  const snapshot = {
    activeGListIds: { 'g-old': true, 'g-new': true },
    safety: { allowDeletions: true, allowTaskMoves: false },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: {
      'ms-task-old': { id: 'ms-task-old', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z' }
    },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task-old': 'ms-old' }
  };

  context.reconcileMapped_(state, snapshot, Date.now());
  assert.deepEqual(calls, []);
  assert.equal(state.g2m['g-task'].msListId, 'ms-old');
  assert.equal(state.g2m['g-task'].msId, 'ms-task-old');
});

test('does not create Google tasks for Microsoft lists outside the allowlist', () => {
  const { context } = loadContext();
  let createCalls = 0;
  context.createGTask_ = () => {
    createCalls += 1;
    return { id: 'unexpected' };
  };
  const state = {
    listMap: { 'g-inactive': 'ms-inactive' },
    g2m: {},
    m2g: {},
    tombstones: { g: {}, m: {} },
    listFaults: { g: {}, ms: {} }
  };
  const snapshot = {
    activeGListIds: { 'g-active': true },
    gTasksById: {},
    msTasksById: {
      'ms-task': { id: 'ms-task', title: 'Out of scope' }
    },
    gListByTask: {},
    msListByTask: { 'ms-task': 'ms-inactive' }
  };

  context.createUnmapped_(state, snapshot, Date.now());
  assert.equal(createCalls, 0);
});

test('snapshot only reads allowlisted Google and Microsoft lists', () => {
  const { context } = loadContext();
  const googleReads = [];
  const microsoftReads = [];
  context.getSafetyConfig_ = () => ({ googleListIds: ['g-active'], allowDeletions: false });
  context.getGLists_ = () => [
    { id: 'g-active', title: 'Active' },
    { id: 'g-inactive', title: 'Inactive' }
  ];
  context.getMsLists_ = () => [
    { id: 'ms-active', displayName: 'Active' },
    { id: 'ms-inactive', displayName: 'Inactive' }
  ];
  context.getGTasks_ = (id) => {
    googleReads.push(id);
    return [];
  };
  context.getMsTasks_ = (id) => {
    microsoftReads.push(id);
    return [];
  };
  const state = context.newState_();
  state.listMap = { 'g-active': 'ms-active', 'g-inactive': 'ms-inactive' };

  const snapshot = context.buildSnapshot_(state, Date.now());
  assert.deepEqual(googleReads, ['g-active']);
  assert.deepEqual(microsoftReads, ['ms-active']);
  assert.deepEqual(Object.keys(snapshot.activeGListIds), ['g-active']);
});

test('snapshot faults an allowlisted mapped Google list missing from inventory', () => {
  const { context } = loadContext();
  let microsoftReads = 0;
  let saveCalls = 0;
  context.getSafetyConfig_ = () => ({ googleListIds: ['g-missing'], allowDeletions: false });
  context.getGLists_ = () => [];
  context.getMsLists_ = () => [{ id: 'ms-existing', displayName: 'Existing' }];
  context.getGTasks_ = () => {
    throw new Error('A missing Google list must not be read');
  };
  context.getMsTasks_ = () => {
    microsoftReads += 1;
    return [];
  };
  context.saveState_ = () => {
    saveCalls += 1;
  };
  context.alertListFaultsIfAny_ = () => {};
  const state = context.newState_();
  state.listMap = { 'g-missing': 'ms-existing' };

  const snapshot = context.buildSnapshot_(state, Date.now());

  assert.deepEqual(Object.keys(snapshot.activeGListIds), ['g-missing']);
  assert.equal(state.listFaults.g['g-missing'].reason, 'GOOGLE_LIST_MISSING');
  assert.equal(state.listFaults.g['g-missing'].msListId, 'ms-existing');
  assert.equal(microsoftReads, 0);
  assert.equal(saveCalls, 1);
});

test('auto discovery only includes owned, unshared standard Microsoft lists', () => {
  const { context } = loadContext({
    scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_EXCLUDED_LIST_NAMES: 'Staging' }
  });
  const safety = context.getSafetyConfig_();
  const lists = [
    { id: 'default', displayName: '工作', isOwner: true, isShared: false, wellknownListName: 'defaultList' },
    { id: 'normal', displayName: '日常', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'flagged', displayName: 'Flagged Emails', isOwner: true, isShared: false, wellknownListName: 'flaggedEmails' },
    { id: 'shared', displayName: 'Shared', isOwner: true, isShared: true, wellknownListName: 'none' },
    { id: 'not-owner', displayName: 'Other', isOwner: false, isShared: false, wellknownListName: 'none' },
    { id: 'unknown', displayName: 'Unknown', isOwner: true, isShared: false, wellknownListName: 'unknownFutureValue' },
    { id: 'excluded', displayName: 'Staging', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'incomplete', displayName: 'Incomplete', isOwner: true, wellknownListName: 'none' }
  ];

  assert.deepEqual(
    lists.filter((list) => context.isAutoEligibleMicrosoftList_(list, safety)).map((list) => list.id),
    ['default', 'normal']
  );
});

test('auto discovery pairs platform defaults and creates Google lists for Microsoft-only lists', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  const state = context.newState_();
  const google = [{ id: 'g-default', title: '我的工作' }];
  const microsoft = [
    { id: 'm-default', displayName: '工作', isOwner: true, isShared: false, wellknownListName: 'defaultList' },
    { id: 'm-home', displayName: '居家', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'm-daily', displayName: '日常', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'm-flagged', displayName: 'Flagged Emails', isOwner: true, isShared: false, wellknownListName: 'flaggedEmails' }
  ];

  const plan = context.planAutoListMappings_(state, google, microsoft, google[0], context.getSafetyConfig_());
  const plain = JSON.parse(JSON.stringify(plan));

  assert.deepEqual(plain.pairs.map((pair) => [pair.googleListId, pair.microsoftListId, pair.reason]), [
    ['g-default', 'm-default', 'DEFAULT_LIST_IDENTITY']
  ]);
  assert.deepEqual(plain.createGoogle.map((list) => list.id), ['m-home', 'm-daily']);
  assert.deepEqual(plain.createMicrosoft, []);
  assert.deepEqual(plain.faults, []);
});

test('auto discovery preserves a valid ID mapping even when titles later differ', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  const state = context.newState_();
  state.listMap['g-renamed'] = 'm-original';
  const google = [{ id: 'g-renamed', title: '改名後的 Google 清單' }];
  const microsoft = [{
    id: 'm-original', displayName: 'Original Microsoft List', isOwner: true, isShared: false, wellknownListName: 'none'
  }];

  const plan = JSON.parse(JSON.stringify(
    context.planAutoListMappings_(state, google, microsoft, null, context.getSafetyConfig_())
  ));
  assert.deepEqual(plan.pairs.map((pair) => [pair.googleListId, pair.microsoftListId, pair.existing]), [
    ['g-renamed', 'm-original', true]
  ]);
  assert.deepEqual(plan.createGoogle, []);
  assert.deepEqual(plan.createMicrosoft, []);
});

test('auto discovery pairs only unique normalized titles and faults ambiguous titles', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  const state = context.newState_();
  const google = [
    { id: 'g-one', title: 'Same   Name' },
    { id: 'g-two', title: ' same name ' }
  ];
  const microsoft = [{
    id: 'm-one', displayName: 'Same Name', isOwner: true, isShared: false, wellknownListName: 'none'
  }];

  const plan = JSON.parse(JSON.stringify(
    context.planAutoListMappings_(state, google, microsoft, null, context.getSafetyConfig_())
  ));
  assert.deepEqual(plan.pairs, []);
  assert.deepEqual(plan.createMicrosoft, []);
  assert.deepEqual(plan.createGoogle, []);
  assert.deepEqual(plan.faults.map((fault) => fault.reason), [
    'AMBIGUOUS_GOOGLE_LIST_TITLE',
    'AMBIGUOUS_GOOGLE_LIST_TITLE',
    'AMBIGUOUS_COUNTERPART_TITLE'
  ]);
});

test('auto snapshot creates Google lists for Microsoft-only lists and never reads Flagged Emails', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  const google = [{ id: 'g-default', title: '我的工作' }];
  const microsoft = [
    { id: 'm-default', displayName: '工作', isOwner: true, isShared: false, wellknownListName: 'defaultList' },
    { id: 'm-home', displayName: '居家', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'm-daily', displayName: '日常', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'm-flagged', displayName: 'Flagged Emails', isOwner: true, isShared: false, wellknownListName: 'flaggedEmails' }
  ];
  const createdGoogle = [];
  const googleReads = [];
  const microsoftReads = [];
  let saveCalls = 0;
  context.getGLists_ = () => google;
  context.getGDefaultList_ = () => google[0];
  context.getMsLists_ = () => microsoft;
  context.createGList_ = (title) => {
    const created = { id: 'g-' + title, title };
    createdGoogle.push(created);
    return created;
  };
  context.getGTasks_ = (id) => {
    googleReads.push(id);
    return [];
  };
  context.getMsTasks_ = (id) => {
    microsoftReads.push(id);
    return [];
  };
  context.saveState_ = () => { saveCalls += 1; };
  context.alertListFaultsIfAny_ = () => {};
  const state = context.newState_();

  const snapshot = context.buildSnapshot_(state, Date.now());

  assert.deepEqual(createdGoogle.map((list) => list.title), ['居家', '日常']);
  assert.deepEqual(googleReads, ['g-default', 'g-居家', 'g-日常']);
  assert.deepEqual(microsoftReads, ['m-default', 'm-home', 'm-daily']);
  assert.equal(state.listMap['g-default'], 'm-default');
  assert.equal(state.listMap['g-居家'], 'm-home');
  assert.equal(state.listMap['g-日常'], 'm-daily');
  assert.equal(snapshot.activeGListIds['g-default'], true);
  assert.equal(snapshot.activeGListIds['g-居家'], true);
  assert.equal(snapshot.activeGListIds['g-日常'], true);
  assert.equal(saveCalls, 3);
});

test('auto discovery bypasses the explicit list allowlist while explicit mode remains guarded', () => {
  const { context: auto } = loadContext({
    scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_DELETIONS: 'true' }
  });
  assert.doesNotThrow(() => auto.requireSyncAllowlist_(auto.getSafetyConfig_()));
  const { context: explicit } = loadContext();
  assert.throws(() => explicit.requireSyncAllowlist_(explicit.getSafetyConfig_()), /SYNC_ALLOWLIST_REQUIRED/);
});

test('auto snapshot aborts before list creation when Google default identity cannot be resolved', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  let createCalls = 0;
  context.getGLists_ = () => [{ id: 'g-default', title: '我的工作' }];
  context.getGDefaultList_ = () => { throw new Error('404'); };
  context.getMsLists_ = () => [{
    id: 'm-default', displayName: '工作', isOwner: true, isShared: false, wellknownListName: 'defaultList'
  }];
  context.createMsList_ = () => { createCalls += 1; return { id: 'unexpected' }; };
  context.createGList_ = () => { createCalls += 1; return { id: 'unexpected' }; };

  assert.throws(() => context.buildSnapshot_(context.newState_(), Date.now()), /AUTO_DEFAULT_LIST_LOOKUP_FAILED/);
  assert.equal(createCalls, 0);
});

test('deletion propagation requires two different complete inventory rounds before Google to Microsoft delete', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const first = mappedTaskSnapshot({ gTask: null });
  const second = mappedTaskSnapshot({ gTask: null });
  const deletes = [];
  const now = Date.now();
  context.deleteMsTask_ = (listId, taskId) => deletes.push([listId, taskId]);
  context.saveState_ = () => {};

  context.reconcileMapped_(state, first, now, 'round-1');
  context.applyConfirmedTaskDeletions_(state, first, 'round-1');
  assert.equal(deletes.length, 0);
  assert.equal(state.pendingTaskDeletions['g-task'].confirmations, 1);

  context.reconcileMapped_(state, second, now, 'round-2');
  context.applyConfirmedTaskDeletions_(state, second, 'round-2');
  assert.deepEqual(deletes, [['ms-list', 'ms-task']]);
  assert.equal(state.g2m['g-task'], undefined);
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.tombstones.m['ms-task']);

  context.reconcileMapped_(state, second, now, 'round-3');
  context.applyConfirmedTaskDeletions_(state, second, 'round-3');
  assert.equal(deletes.length, 1);
});

test('deletion propagation deletes Google only after two Microsoft-missing rounds with exact IDs', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const first = mappedTaskSnapshot({ msTask: null });
  const second = mappedTaskSnapshot({ msTask: null });
  const deletes = [];
  const now = Date.now();
  context.deleteGTask_ = (listId, taskId) => deletes.push([listId, taskId]);
  context.saveState_ = () => {};

  context.reconcileMapped_(state, first, now, 'round-1');
  context.applyConfirmedTaskDeletions_(state, first, 'round-1');
  context.reconcileMapped_(state, second, now, 'round-2');
  context.applyConfirmedTaskDeletions_(state, second, 'round-2');

  assert.deepEqual(deletes, [['g-list', 'g-task']]);
  assert.equal(state.g2m['g-task'], undefined);
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.tombstones.m['ms-task']);
});

test('both-missing mappings require two rounds then tombstone without a remote delete', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const first = mappedTaskSnapshot({ gTask: null, msTask: null });
  const second = mappedTaskSnapshot({ gTask: null, msTask: null });
  const now = Date.now();
  context.deleteGTask_ = () => { throw new Error('must not remotely delete'); };
  context.deleteMsTask_ = () => { throw new Error('must not remotely delete'); };
  context.saveState_ = () => {};

  context.reconcileMapped_(state, first, now, 'round-1');
  context.applyConfirmedTaskDeletions_(state, first, 'round-1');
  assert.ok(state.g2m['g-task']);
  context.reconcileMapped_(state, second, now, 'round-2');
  context.applyConfirmedTaskDeletions_(state, second, 'round-2');

  assert.equal(state.g2m['g-task'], undefined);
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.tombstones.m['ms-task']);
});

test('delete-versus-edit is quarantined instead of deleting the newer live task', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const first = mappedTaskSnapshot({ gTask: null });
  const edited = mappedTaskSnapshot({
    gTask: null,
    msTask: { id: 'ms-task', title: 'Edited live task', lastModifiedDateTime: '2026-08-14T00:01:00Z' }
  });
  let deletes = 0;
  const now = Date.now();
  context.deleteMsTask_ = () => { deletes += 1; };
  context.saveState_ = () => {};

  context.reconcileMapped_(state, first, now, 'round-1');
  context.applyConfirmedTaskDeletions_(state, first, 'round-1');
  context.reconcileMapped_(state, edited, now, 'round-2');
  context.applyConfirmedTaskDeletions_(state, edited, 'round-2');

  assert.equal(deletes, 0);
  assert.ok(state.g2m['g-task']);
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'DELETE_VS_EDIT_CONFLICT');
});

test('an incomplete inventory and an unproven live timestamp never count toward deletion', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const incomplete = mappedTaskSnapshot({ gTask: null, inventoryComplete: false });
  const unknownTimestamp = mappedTaskSnapshot({
    gTask: null,
    msTask: { id: 'ms-task', title: 'No timestamp', lastModifiedDateTime: null }
  });
  let deletes = 0;
  context.deleteMsTask_ = () => { deletes += 1; };
  context.saveState_ = () => {};

  context.reconcileMapped_(state, incomplete, Date.now(), 'incomplete-round');
  context.applyConfirmedTaskDeletions_(state, incomplete, 'incomplete-round');
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);

  context.reconcileMapped_(state, mappedTaskSnapshot({ gTask: null }), Date.now(), 'round-1');
  context.applyConfirmedTaskDeletions_(state, mappedTaskSnapshot({ gTask: null }), 'round-1');
  context.reconcileMapped_(state, unknownTimestamp, Date.now(), 'round-2');
  context.applyConfirmedTaskDeletions_(state, unknownTimestamp, 'round-2');
  assert.equal(deletes, 0);
  assert.ok(state.g2m['g-task']);
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'DELETE_TIMESTAMP_UNPROVEN');
});

test('disabled deletion clears candidates and never advances them', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google');
  const snap = mappedTaskSnapshot({ gTask: null, allowDeletions: false });
  let deletes = 0;
  context.deleteMsTask_ = () => { deletes += 1; };

  context.reconcileMapped_(state, snap, Date.now(), 'round-disabled');
  context.applyConfirmedTaskDeletions_(state, snap, 'round-disabled');

  assert.equal(deletes, 0);
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);
  assert.ok(state.g2m['g-task']);
});

test('404 and 410 remote deletes are idempotent successes and create dual tombstones', () => {
  for (const status of [404, 410]) {
    const { context } = loadContext();
    const state = mappedTaskState(context);
    readyDeletionCandidate(state, 'google');
    const snap = mappedTaskSnapshot({ gTask: null });
    context.saveState_ = () => {};
    context.deleteMsTask_ = () => { throw new Error('HTTP ' + status + ': gone'); };

    context.applyConfirmedTaskDeletions_(state, snap, 'round-2');
    assert.equal(state.g2m['g-task'], undefined);
    assert.ok(state.tombstones.g['g-task']);
    assert.ok(state.tombstones.m['ms-task']);
  }
});

test('ordinary remote deletion failure retains the mapping and durable journal for retry', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google');
  const snap = mappedTaskSnapshot({ gTask: null });
  let saves = 0;
  let deletes = 0;
  context.saveState_ = () => { saves += 1; };
  context.deleteMsTask_ = () => {
    deletes += 1;
    throw new Error('HTTP 500: retry later');
  };

  assert.throws(() => context.applyConfirmedTaskDeletions_(state, snap, 'round-2'), /HTTP 500/);
  assert.ok(state.g2m['g-task']);
  assert.ok(state.deletionJournal['g-task']);
  assert.equal(saves, 1);

  context.deleteMsTask_ = () => { deletes += 1; };
  context.applyConfirmedTaskDeletions_(state, mappedTaskSnapshot({ gTask: null }), 'round-3');
  assert.equal(deletes, 2);
  assert.equal(state.g2m['g-task'], undefined);
});

test('a failed non-delete sync stores only a bounded error and no new deletion confirmation', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google', 'previous-round');
  state.pendingTaskDeletions['g-task'].confirmations = 1;
  const snap = mappedTaskSnapshot({ gTask: null });
  let saved = null;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => snap;
  context.createUnmapped_ = () => {
    throw new Error(
      'HTTP 500: {"taskTitle":"private-task-sentinel","token":"private-token-sentinel"} ' +
      'request-id: req-sync-123456'
    );
  };
  context.saveState_ = (value) => { saved = JSON.parse(JSON.stringify(value)); };
  context.sendFatalAlert_ = () => {};

  assert.throws(() => context.syncAll(), /HTTP 500/);
  // An active round fence retains only the completed-round baseline, never
  // this round's attempted 2/2 promotion.
  assert.equal(saved.pendingTaskDeletions['g-task'].confirmations, 1);
  assert.equal(saved.deletionJournal['g-task'], undefined);
  assert.equal(
    saved.health.lastErrorMessage,
    'HTTP code: 500; Error type: HTTP_ERROR; Correlation code: req-sync-123456'
  );
  assert.equal(saved.health.lastErrorMessage.includes('private-task-sentinel'), false);
  assert.equal(saved.health.lastErrorMessage.includes('private-token-sentinel'), false);
});

test('a persisted delete journal recovers after remote success and final state-save failure', () => {
  const first = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(first.context);
  readyDeletionCandidate(state, 'google', 'old-round');
  const snap = mappedTaskSnapshot({ gTask: null });
  let durableBeforeDelete = null;
  let saveCalls = 0;
  let remoteDeletes = 0;
  first.context.withGlobalLock_ = (fn) => fn();
  first.context.loadStateForSync_ = () => state;
  first.context.buildSnapshot_ = () => snap;
  first.context.createUnmapped_ = () => {};
  first.context.sendFatalAlert_ = () => {};
  first.context.deleteMsTask_ = () => { remoteDeletes += 1; };
  first.context.saveState_ = (value) => {
    saveCalls += 1;
    if (value.deletionJournal['g-task'] && !durableBeforeDelete) {
      durableBeforeDelete = JSON.parse(JSON.stringify(value));
      return;
    }
    if (remoteDeletes > 0) throw new Error('simulated state save failure');
  };

  assert.throws(() => first.context.syncAll(), /simulated state save failure/);
  assert.equal(remoteDeletes, 1);
  assert.ok(durableBeforeDelete.deletionJournal['g-task']);
  assert.ok(durableBeforeDelete.g2m['g-task']);

  const second = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const recoveryState = durableBeforeDelete;
  const recoveredSnap = mappedTaskSnapshot({ gTask: null, msTask: null });
  let recoveryDeletes = 0;
  second.context.withGlobalLock_ = (fn) => fn();
  second.context.recordSuccessfulSyncRound_ = () => true;
  second.context.loadStateForSync_ = () => recoveryState;
  second.context.buildSnapshot_ = () => recoveredSnap;
  second.context.createUnmapped_ = () => {};
  second.context.saveState_ = () => {};
  second.context.deleteMsTask_ = () => { recoveryDeletes += 1; };
  second.context.sendFatalAlert_ = () => {};

  second.context.syncAll();
  assert.equal(recoveryDeletes, 0);
  assert.equal(recoveryState.g2m['g-task'], undefined);
  assert.ok(recoveryState.tombstones.g['g-task']);
  assert.ok(recoveryState.tombstones.m['ms-task']);
});

test('dual tombstones prevent both directions from recreating deleted mappings until the exact TTL boundary', () => {
  const { context } = loadContext();
  const now = Date.parse('2026-08-21T00:00:00Z');
  const state = context.newState_();
  state.listMap['g-list'] = 'ms-list';
  state.tombstones.g['g-task'] = { at: now - (29 * 24 * 60 * 60 * 1000), source: 'google' };
  state.tombstones.m['ms-task'] = { at: now - (29 * 24 * 60 * 60 * 1000), source: 'google' };
  const snap = mappedTaskSnapshot();
  let creates = 0;
  context.createMsTask_ = () => { creates += 1; return { id: 'new-ms' }; };
  context.createGTask_ = () => { creates += 1; return { id: 'new-g' }; };

  context.cleanupTombstones_(state, now);
  context.createUnmapped_(state, snap, Date.now());
  assert.equal(creates, 0);
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.tombstones.m['ms-task']);

  context.cleanupTombstones_(state, now + (24 * 60 * 60 * 1000));
  assert.equal(state.tombstones.g['g-task'], undefined);
  assert.equal(state.tombstones.m['ms-task'], undefined);
});

test('new deletion fields remain backward-compatible with schema 2 imports and observable without task contents', () => {
  const { context } = loadContext();
  const oldState = {
    schema: 2,
    listMap: {},
    g2m: {},
    m2g: {},
    tombstones: { g: {}, m: {} },
    listFaults: { g: {}, ms: {} },
    health: {}
  };

  context.validateImportedState_(oldState);
  const normalized = context.normalizeState_(oldState);
  assert.deepEqual(Object.keys(normalized.pendingTaskDeletions), []);
  assert.deepEqual(Object.keys(normalized.deletionJournal), []);
  assert.deepEqual(Object.keys(normalized.taskDeletionConflicts), []);
  const summary = context.taskDeletionObservability_(normalized, {
    allowDeletions: true,
    allowTaskMoves: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    deletionsEnabled: true,
    taskMovesEnabled: false,
    taskMovesAvailable: true,
    taskMovesEffective: false,
    taskMoveJournals: 0,
    pendingTaskDeletionCandidates: 0,
    deletionJournals: 0,
    orphanDeletionJournals: 0,
    blockedDeletionJournals: 0,
    taskDeletionConflicts: 0,
    googleTombstones: 0,
    microsoftTombstones: 0
  });
});

test('task moves are independently authorized when deletion propagation is disabled', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_TASK_MOVES: 'true' } });
  const state = mappedTaskState(context);
  state.listMap['g-old'] = 'ms-old';
  state.listMap['g-new'] = 'ms-new';
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  state.g2m['g-task'].msId = 'ms-task-old';
  state.m2g = { 'ms-task-old': 'g-task' };
  const snap = {
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    moveExtensionInventoryListIds: { 'ms-new': true },
    inventoryComplete: true,
    safety: { allowDeletions: false, allowTaskMoves: context.getSafetyConfig_().allowTaskMoves },
    gTasksById: { 'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:00:00Z' } },
    msTasksById: { 'ms-task-old': { id: 'ms-task-old', lastModifiedDateTime: '2026-08-14T00:00:00Z' } },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task-old': 'ms-old' }
  };
  const oldMsTask = {
    id: 'ms-task-old', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const movedMsTask = {
    id: 'ms-task-new', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:01:00Z'
  };
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) => taskId === 'ms-task-new' ? movedMsTask : oldMsTask;
  context.createMsTask_ = () => movedMsTask;
  context.deleteMsTask_ = () => {};

  context.reconcileMapped_(state, snap, Date.now(), 'move-round');
  assert.equal(state.g2m['g-task'].msId, 'ms-task-new');
  assert.equal(state.g2m['g-task'].msListId, 'ms-new');
  assert.equal(state.taskMoveJournal['g-task'], undefined);
});

test('move journal rejects unknown phases and created state without destination ID', () => {
  const { context } = loadContext();
  const makeState = () => {
    const state = mappedTaskState(context);
    const rec = state.g2m['g-task'];
    state.taskMoveJournal['g-task'] = {
      phase: 'creating',
      gId: 'g-task',
      oldMsId: rec.msId,
      newMsId: null,
      gListId: 'g-new',
      oldMsListId: rec.msListId,
      targetMsListId: 'ms-new',
      gUpdated: rec.gUpdated,
      oldMsUpdated: rec.msUpdated,
      preparedAt: '2026-08-14T00:01:00Z',
      fingerprint: '{}',
      uncertainConfirmations: 0,
      lastRoundId: null
    };
    return state;
  };

  const unknownPhase = makeState();
  unknownPhase.taskMoveJournal['g-task'].phase = 'typo';
  assert.throws(() => context.normalizeState_(unknownPhase), /STATE_MALFORMED.*taskMoveJournal/);

  const missingDestination = makeState();
  missingDestination.taskMoveJournal['g-task'].phase = 'created';
  assert.throws(() => context.normalizeState_(missingDestination), /STATE_MALFORMED.*taskMoveJournal/);
});

test('Google cross-list move re-syncs only that task and retires the old Microsoft ID', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'] = {
    msId: 'ms-task-old',
    gListId: 'g-old',
    msListId: 'ms-old',
    gUpdated: '2026-08-14T00:00:00Z',
    msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g = { 'ms-task-old': 'g-task' };
  state.pendingTaskDeletions['g-task'] = { confirmations: 1 };
  state.taskDeletionConflicts['g-task'] = { reason: 'stale' };
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    safety: { allowDeletions: true, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: {
      'ms-task-old': {
        id: 'ms-task-old', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z'
      }
    },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task-old': 'ms-old' }
  };
  const calls = [];
  const oldMsTask = {
    id: 'ms-task-old', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const movedMsTask = {
    id: 'ms-task-new', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:02:00Z'
  };
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) => taskId === 'ms-task-new' ? movedMsTask : oldMsTask;
  context.deleteMsTask_ = (listId, taskId) => calls.push(['delete', listId, taskId]);
  context.createMsTask_ = (listId, payload) => {
    calls.push(['create', listId, payload.title]);
    return movedMsTask;
  };

  context.reconcileMapped_(state, snap, Date.now(), 'move-round', {
    durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {}
  });

  assert.deepEqual(calls, [
    ['create', 'ms-new', 'Moved'],
    ['delete', 'ms-old', 'ms-task-old']
  ]);
  assert.equal(state.g2m['g-task'].msId, 'ms-task-new');
  assert.equal(state.g2m['g-task'].gListId, 'g-new');
  assert.equal(state.g2m['g-task'].msListId, 'ms-new');
  assert.equal(state.m2g['ms-task-old'], undefined);
  assert.equal(state.m2g['ms-task-new'], 'g-task');
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);
  assert.equal(state.deletionJournal['g-task'], undefined);
  assert.equal(state.taskDeletionConflicts['g-task'], undefined);
  assert.ok(state.tombstones.m['ms-task-old']);
  assert.equal(state.tombstones.g['g-task'], undefined);
});

test('Google move retries from its still-live source when the old Microsoft task is already gone', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    safety: { allowDeletions: true, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Retry move', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: {},
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: {}
  };
  let deletes = 0;
  const movedMsTask = {
    id: 'ms-task-new', title: 'Retry move', lastModifiedDateTime: '2026-08-14T00:02:00Z'
  };
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) => taskId === 'ms-task-new' ? movedMsTask : null;
  context.deleteMsTask_ = () => { deletes += 1; };
  context.createMsTask_ = () => movedMsTask;

  context.reconcileMapped_(state, snap, Date.now(), 'move-retry');

  assert.equal(deletes, 0);
  assert.equal(state.g2m['g-task'].msId, 'ms-task-new');
  assert.equal(state.g2m['g-task'].msListId, 'ms-new');
});

test('Google move fails closed before mutation when Microsoft changed since mapping', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    moveExtensionInventoryListIds: { 'ms-new': true },
    safety: { allowDeletions: false, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: {
      'ms-task': {
        id: 'ms-task', title: 'Edited on Microsoft',
        lastModifiedDateTime: '2026-08-14T00:05:00Z'
      }
    },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old' }
  };
  context.createMsTask_ = () => { throw new Error('must fail before create'); };
  context.deleteMsTask_ = () => { throw new Error('must fail before delete'); };

  context.reconcileMapped_(state, snap, Date.now(), 'move-edit-conflict');

  assert.equal(state.g2m['g-task'].msId, 'ms-task');
  assert.equal(state.taskMoveJournal['g-task'], undefined);
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'MOVE_VS_EDIT_CONFLICT');
});

test('move exhausted-429-shaped create failure keeps source and durable retry journal', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    moveExtensionInventoryListIds: { 'ms-new': true },
    safety: { allowDeletions: false, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: {
      'ms-task': { id: 'ms-task', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z' }
    },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old' }
  };
  let deletes = 0;
  let creates = 0;
  let freshSource = snap.msTasksById['ms-task'];
  const durableJournalSnapshots = [];
  context.persistSyncState_ = (nextState) => {
    durableJournalSnapshots.push(JSON.parse(JSON.stringify(
      nextState.taskMoveJournal['g-task'] || null
    )));
  };
  context.getMsTask_ = () => freshSource;
  context.createMsTask_ = () => {
    creates += 1;
    throw new Error('HTTP 429: retry budget exhausted');
  };
  context.deleteMsTask_ = () => { deletes += 1; };

  assert.throws(() => {
    context.reconcileMapped_(state, snap, Date.now(), 'move-create-failed');
  }, /HTTP 429: retry budget exhausted/);
  assert.equal(deletes, 0);
  assert.equal(state.g2m['g-task'].msId, 'ms-task');
  assert.ok(snap.msTasksById['ms-task']);
  assert.equal(state.taskMoveJournal['g-task'].phase, 'creating');
  assert.equal(state.taskMoveJournal['g-task'].newMsId, null);
  assert.equal(state.taskMoveJournal['g-task'].uncertainConfirmations, 0);
  assert.equal(durableJournalSnapshots.some((journal) =>
    journal && journal.phase === 'creating' &&
    journal.lastBlockedReason === 'MOVE_DESTINATION_CREATE_FAILED'
  ), true);
  assert.doesNotThrow(() => {
    context.reconcileMapped_(state, snap, Date.now(), 'move-create-miss-1');
  });
  assert.equal(creates, 1);
  assert.equal(state.taskMoveJournal['g-task'].phase, 'creating');
  assert.equal(state.taskMoveJournal['g-task'].uncertainConfirmations, 1);
  freshSource = {
    id: 'ms-task', title: 'Edited during recovery',
    lastModifiedDateTime: '2026-08-14T00:05:00Z'
  };
  assert.doesNotThrow(() => {
    context.reconcileMapped_(state, snap, Date.now(), 'move-create-miss-2');
  });
  assert.equal(creates, 1);
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'MOVE_VS_EDIT_CONFLICT');
});

test('a crashed creating move journal adopts its fully-qualified marker without a duplicate POST', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const gTask = {
    id: 'g-task', title: 'Moved', notes: '', status: 'needsAction',
    updated: '2026-08-14T00:01:00Z'
  };
  const oldTask = {
    id: 'ms-task', title: 'Moved', body: { content: '', contentType: 'html' },
    status: 'notStarted', lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const recovered = {
    id: 'ms-task-new', title: 'Moved', body: { content: '', contentType: 'html' },
    status: 'notStarted', createdDateTime: '2026-08-14T00:02:00Z',
    lastModifiedDateTime: '2026-08-14T00:02:00Z',
    extensions: [{
      id: 'microsoft.graph.openTypeExtension.com.tasksTodoSync.move',
      extensionName: 'com.tasksTodoSync.move',
      correlationId: '11111111-1111-4111-8111-111111111111'
    }]
  };
  state.taskMoveJournal['g-task'] = {
    phase: 'creating', gId: 'g-task', oldMsId: 'ms-task', newMsId: null,
    gListId: 'g-new', oldMsListId: 'ms-old', targetMsListId: 'ms-new',
    gUpdated: gTask.updated, oldMsUpdated: oldTask.lastModifiedDateTime,
    preparedAt: '2026-08-14T00:01:30Z',
    fingerprint: context.moveFingerprintFromGoogle_(gTask),
    correlationId: '11111111-1111-4111-8111-111111111111',
    uncertainConfirmations: 0, lastRoundId: 'prior-round'
  };
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    moveExtensionInventoryListIds: { 'ms-new': true },
    safety: { allowDeletions: false, allowTaskMoves: true },
    gTasksById: { 'g-task': gTask },
    msTasksById: { 'ms-task': oldTask, 'ms-task-new': recovered },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old', 'ms-task-new': 'ms-new' }
  };
  let creates = 0;
  const deletes = [];
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) => taskId === 'ms-task' ? oldTask : recovered;
  context.createMsTask_ = () => { creates += 1; };
  context.deleteMsTask_ = (listId, taskId) => deletes.push([listId, taskId]);

  context.reconcileMapped_(state, snap, Date.now(), 'recovery-round');

  assert.equal(creates, 0);
  assert.deepEqual(deletes, [['ms-old', 'ms-task']]);
  assert.equal(state.g2m['g-task'].msId, 'ms-task-new');
  assert.equal(state.taskMoveJournal['g-task'], undefined);
});

test('pre-delete re-read preserves both tasks when Microsoft changes during move creation', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const oldTask = {
    id: 'ms-task', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const editedOldTask = {
    id: 'ms-task', title: 'Edited while moving', lastModifiedDateTime: '2026-08-14T00:05:00Z'
  };
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    safety: { allowDeletions: false, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: { 'ms-task': oldTask },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old' }
  };
  const movedMsTask = {
    id: 'ms-task-new', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:02:00Z'
  };
  let oldReads = 0;
  let deletes = 0;
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) => {
    if (taskId === 'ms-task-new') return movedMsTask;
    oldReads += 1;
    return oldReads <= 2 ? oldTask : editedOldTask;
  };
  context.createMsTask_ = () => movedMsTask;
  context.deleteMsTask_ = () => { deletes += 1; };

  context.reconcileMapped_(state, snap, Date.now(), 'move-race');

  assert.equal(deletes, 0);
  assert.equal(state.g2m['g-task'].msId, 'ms-task');
  assert.equal(state.taskMoveJournal['g-task'].newMsId, 'ms-task-new');
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'MOVE_VS_EDIT_CONFLICT');
});

test('destination edit after move creation preserves both tasks and fails closed', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const oldTask = {
    id: 'ms-task', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const createdDestination = {
    id: 'ms-task-new', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:02:00Z'
  };
  const editedDestination = {
    id: 'ms-task-new', title: 'Edited at destination',
    lastModifiedDateTime: '2026-08-14T00:03:00Z'
  };
  const snap = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    safety: { allowDeletions: false, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:01:00Z' }
    },
    msTasksById: { 'ms-task': oldTask },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old' }
  };
  let deletes = 0;
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) =>
    taskId === 'ms-task-new' ? editedDestination : oldTask;
  context.createMsTask_ = () => createdDestination;
  context.deleteMsTask_ = () => { deletes += 1; };

  context.reconcileMapped_(state, snap, Date.now(), 'move-destination-edit');

  assert.equal(deletes, 0);
  assert.equal(state.g2m['g-task'].msId, 'ms-task');
  assert.equal(state.taskMoveJournal['g-task'].newMsId, 'ms-task-new');
  assert.equal(state.taskDeletionConflicts['g-task'].reason, 'MOVE_DESTINATION_EDIT_CONFLICT');
});

test('same-ID Microsoft list change fails closed instead of rebounding the task', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const snap = mappedTaskSnapshot();
  snap.msListByTask['ms-task'] = 'ms-new';
  let writes = 0;
  context.updateGTask_ = () => { writes += 1; };
  context.updateMsTask_ = () => { writes += 1; };

  context.reconcileMapped_(state, snap, Date.now(), 'same-id-move');

  assert.equal(writes, 0);
  assert.equal(state.g2m['g-task'].msListId, 'ms-list');
  assert.equal(state.taskDeletionConflicts['g-task'].reason,
    'MOVE_MICROSOFT_SAME_ID_LIST_CHANGED');
});

test('dry-run task move preview reports enabled, blocked, and recovery states without mutation', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const inventory = {
    gTasksById: { 'g-task': { id: 'g-task', title: 'Moved' } },
    msTasksById: { 'ms-task': { id: 'ms-task', title: 'Moved' } },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old' }
  };
  const actions = [];
  const warnings = [];
  context.appendTaskMovePreview_(state, inventory, { allowTaskMoves: true }, actions, warnings);
  assert.equal(actions.length, 1);
  assert.match(actions[0], /Google.*move/);

  const blocked = [];
  context.appendTaskMovePreview_(state, inventory, { allowTaskMoves: false }, [], blocked);
  assert.match(blocked[0], /currently blocked/);
  assert.equal(state.g2m['g-task'].msListId, 'ms-old');
});

test('structured move preview is deterministic, opaque, and reports observed metadata only', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-z': 'ms-z', 'g-a': 'ms-a' };
  state.g2m = {
    'g-z-task': {
      msId: 'ms-z-task', gListId: 'g-z', msListId: 'ms-z',
      gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
    },
    'g-a-task': {
      msId: 'ms-a-task', gListId: 'g-a', msListId: 'ms-a',
      gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
    }
  };
  state.m2g = { 'ms-z-task': 'g-z-task', 'ms-a-task': 'g-a-task' };
  const inventory = {
    gTasksById: {
      'g-z-task': { id: 'g-z-task', title: 'Private Z title' },
      'g-a-task': { id: 'g-a-task', title: 'Private A title' }
    },
    msTasksById: {
      'ms-z-task': {
        id: 'ms-z-task', title: 'Private Z title', importance: 'high',
        categories: ['Work'], isReminderOn: true,
        reminderDateTime: { dateTime: '2026-08-14T09:00:00', timeZone: 'Asia/Taipei' },
        recurrence: { pattern: { type: 'daily', interval: 1 } },
        startDateTime: { dateTime: '2026-08-14T00:00:00', timeZone: 'Asia/Taipei' },
        hasAttachments: true, completedDateTime: '2026-08-14T10:00:00Z', status: 'inProgress'
      },
      'ms-a-task': {
        id: 'ms-a-task', title: 'Private A title', importance: 'normal',
        categories: [], isReminderOn: false, recurrence: null,
        hasAttachments: false, completedDateTime: null
      }
    },
    gListByTask: { 'g-z-task': 'g-z', 'g-a-task': 'g-a' },
    msListByTask: { 'ms-z-task': 'ms-z', 'ms-a-task': 'ms-a' }
  };
  inventory.gListByTask['g-z-task'] = 'g-target-z';
  inventory.gListByTask['g-a-task'] = 'g-target-a';
  state.listMap['g-target-z'] = 'ms-target-z';
  state.listMap['g-target-a'] = 'ms-target-a';

  const render = (allowTaskMoves) => {
    const actions = [];
    const warnings = [];
    const pendingMoves = [];
    context.appendTaskMovePreview_(state, inventory, { allowTaskMoves }, actions, warnings, pendingMoves);
    return { actions, warnings, pendingMoves };
  };
  const enabled = render(true);
  const blocked = render(false);

  assert.deepEqual(enabled.pendingMoves.map((move) => move.status), ['READY', 'READY']);
  assert.deepEqual(blocked.pendingMoves.map((move) => move.status), ['BLOCKED_SWITCH_OFF', 'BLOCKED_SWITCH_OFF']);
  assert.deepEqual(enabled.pendingMoves.map((move) => move.googleTaskId).sort(), [
    context.previewOpaqueId_('gTask', 'g-a-task'),
    context.previewOpaqueId_('gTask', 'g-z-task')
  ].sort());
  const richMove = enabled.pendingMoves.find((move) =>
    move.sourceMicrosoftTaskId === context.previewOpaqueId_('msTask', 'ms-z-task'));
  const plainMove = enabled.pendingMoves.find((move) =>
    move.sourceMicrosoftTaskId === context.previewOpaqueId_('msTask', 'ms-a-task'));
  assert.ok(richMove);
  assert.ok(plainMove);
  assert.deepEqual(JSON.parse(JSON.stringify(richMove.metadataLoss.detectedNonPreserved)),
    ['categories', 'completedDateTime', 'hasAttachments', 'importance', 'recurrence', 'reminder', 'startDateTime', 'statusDetail']);
  assert.deepEqual(JSON.parse(JSON.stringify(plainMove.metadataLoss.detectedNonPreserved)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(plainMove.metadataLoss.uninspectedRelationships)),
    ['attachmentDetails', 'checklistItems', 'linkedResources', 'extensions']);
  assert.equal(plainMove.metadataLoss.detectionScope.extraMicrosoftRequests, false);
  assert.equal(plainMove.metadataLoss.detectionScope.valuesIncludedInReport, false);
  assert.equal(plainMove.metadataLoss.detectionScope.relationshipExpansion, false);
  assert.equal(plainMove.sourceMicrosoftTaskId.includes('ms-a-task'), false);
  assert.equal(plainMove.targetMicrosoftListId.includes('ms-target-a'), false);
  assert.equal(JSON.stringify(enabled.pendingMoves).includes('Private A title'), false);
  assert.deepEqual(enabled.pendingMoves, render(true).pendingMoves);
  assert.equal(state.g2m['g-a-task'].msListId, 'ms-a');
  assert.equal(enabled.actions.length, 2);
});

test('recovery move preview is emitted once and does not duplicate the mapped candidate', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  state.taskMoveJournal['g-task'] = {
    phase: 'creating', gId: 'g-task', oldMsId: 'ms-task', newMsId: null,
    gListId: 'g-new', oldMsListId: 'ms-old', targetMsListId: 'ms-new',
    gUpdated: '2026-08-14T00:00:00Z', oldMsUpdated: '2026-08-14T00:00:00Z',
    preparedAt: '2026-08-14T00:01:00Z', fingerprint: 'fingerprint',
    uncertainConfirmations: 1
  };
  const inventory = {
    gTasksById: { 'g-task': { id: 'g-task', title: 'Recovery task' } },
    msTasksById: { 'ms-task': { id: 'ms-task', title: 'Recovery task' } },
    gListByTask: { 'g-task': 'g-new' },
    msListByTask: { 'ms-task': 'ms-old' }
  };
  const actions = [];
  const warnings = [];
  const pendingMoves = [];
  context.appendTaskMovePreview_(state, inventory, { allowTaskMoves: true }, actions, warnings, pendingMoves);

  assert.equal(pendingMoves.length, 1);
  assert.equal(pendingMoves[0].status, 'RECOVERY');
  assert.equal(pendingMoves[0].recoveryPhase, 'creating');
  assert.deepEqual(JSON.parse(JSON.stringify(pendingMoves[0].metadataLoss.uninspectedRelationships)),
    ['attachmentDetails', 'checklistItems', 'linkedResources', 'extensions']);
  assert.equal(warnings.length, 1);
  assert.equal(actions.length, 0);
  assert.equal(JSON.stringify(pendingMoves).includes('g-task'), false);
  assert.equal(JSON.stringify(pendingMoves).includes('ms-task'), false);
});

test('dryRunReport returns and logs the same structured preview without N+1 reads or mutations', () => {
  const logs = [];
  const { context, userStore } = loadContext({
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'explicit',
      SYNC_GOOGLE_LIST_IDS: 'g-old,g-new',
      SYNC_LIST_PAIRS_JSON: JSON.stringify([
        { googleListId: 'g-old', microsoftListId: 'ms-old' },
        { googleListId: 'g-new', microsoftListId: 'ms-new' }
      ]),
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_ALLOW_LIST_DELETIONS: 'false',
      SYNC_ALLOW_TASK_MOVES: 'true'
    }
  });
  context.console = { log: (message) => logs.push(message), warn: () => {}, error: () => {} };
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  context.saveState_(state);
  context.getGLists_ = () => [
    { id: 'g-old', title: 'Source' }, { id: 'g-new', title: 'Target' }
  ];
  context.getMsLists_ = () => [
    { id: 'ms-old', displayName: 'Source' }, { id: 'ms-new', displayName: 'Target' }
  ];
  context.getGTasks_ = (listId) => listId === 'g-new'
    ? [{ id: 'g-task', title: 'Private title' }]
    : [];
  context.getMsTasks_ = (listId) => listId === 'ms-old'
    ? [{ id: 'ms-task', title: 'Private title', importance: 'high' }]
    : [];
  context.getMsTask_ = () => { throw new Error('dryRunReport must not perform per-task reads'); };
  const writes = [];
  for (const name of ['createGTask_', 'updateGTask_', 'deleteGTask_', 'createMsTask_', 'updateMsTask_', 'deleteMsTask_', 'createGList_', 'createMsList_', 'deleteGList_', 'deleteMsList_']) {
    context[name] = () => writes.push(name);
  }

  const beforeState = JSON.stringify(userStore.values);
  const report = context.dryRunReport();
  const afterState = JSON.stringify(userStore.values);
  const logged = JSON.parse(logs.at(-1));

  assert.equal(report.pendingMoves.length, 1);
  assert.deepEqual(logged.pendingMoves, JSON.parse(JSON.stringify(report.pendingMoves)));
  assert.deepEqual(logged.pendingMoveSummary, JSON.parse(JSON.stringify(report.pendingMoveSummary)));
  assert.equal(report.pendingMoves[0].status, 'READY');
  assert.deepEqual(JSON.parse(JSON.stringify(report.pendingMoves[0].metadataLoss.detectedNonPreserved)), ['importance']);
  assert.equal(JSON.stringify(report.pendingMoves).includes('g-task'), false);
  assert.equal(JSON.stringify(report.pendingMoves).includes('ms-task'), false);
  assert.equal(JSON.stringify(report.pendingMoves).includes('Private title'), false);
  assert.equal(writes.length, 0);
  assert.equal(afterState, beforeState);
});

test('corrupt-state dryRunReport returns empty pending moves and preserves return-log parity', () => {
  const logs = [];
  const { context, userStore } = loadContext();
  context.console = { log: (message) => logs.push(message), warn: () => {}, error: () => {} };
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  context.loadStateForInspection_ = () => ({ corrupt: true, state: context.newState_() });
  const beforeState = JSON.stringify(userStore.values);

  const report = context.dryRunReport();
  const logged = JSON.parse(logs.at(-1));

  assert.deepEqual(JSON.parse(JSON.stringify(report.pendingMoves)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(report.pendingMoveSummary)), {
    total: 0,
    byStatus: { READY: 0, BLOCKED_SWITCH_OFF: 0, RECOVERY: 0 },
    movesWithDetectedNonPreserved: 0,
    detectedNonPreserved: [],
    movesWithUninspectedRelationships: 0,
    microsoftTaskSnapshotsPresent: 0,
    microsoftTaskSnapshotsMissing: 0,
    detectionScope: 'CURRENT_MICROSOFT_TASK_SNAPSHOT_ONLY_NO_EXTRA_GRAPH_REQUESTS'
  });
  assert.deepEqual(logged.pendingMoves, []);
  assert.deepEqual(logged.pendingMoveSummary, JSON.parse(JSON.stringify(report.pendingMoveSummary)));
  assert.match(report.warnings[0], /STATE_CORRUPT/);
  assert.equal(JSON.stringify(userStore.values), beforeState);
});

test('auto-mode dryRunReport returns and logs the same pending move preview without mutations', () => {
  const logs = [];
  const { context, userStore } = loadContext({
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'auto',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_ALLOW_LIST_DELETIONS: 'false',
      SYNC_ALLOW_TASK_MOVES: 'true'
    }
  });
  context.console = { log: (message) => logs.push(message), warn: () => {}, error: () => {} };
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  context.saveState_(state);
  context.getGLists_ = () => [
    { id: 'g-old', title: 'Source' }, { id: 'g-new', title: 'Target' }
  ];
  context.getGDefaultList_ = () => ({ id: 'g-old', title: 'Source' });
  context.getMsLists_ = () => [
    { id: 'ms-old', displayName: 'Source', isOwner: true, isShared: false, wellknownListName: 'none' },
    { id: 'ms-new', displayName: 'Target', isOwner: true, isShared: false, wellknownListName: 'none' }
  ];
  context.getGTasks_ = (listId) => listId === 'g-new'
    ? [{ id: 'g-task', title: 'Private title' }]
    : [];
  context.getMsTasks_ = (listId) => listId === 'ms-old'
    ? [{ id: 'ms-task', title: 'Private title', importance: 'high' }]
    : [];
  context.getMsTask_ = () => { throw new Error('auto dry-run must not perform per-task reads'); };
  const writes = [];
  for (const name of ['createGTask_', 'updateGTask_', 'deleteGTask_', 'createMsTask_', 'updateMsTask_', 'deleteMsTask_', 'createGList_', 'createMsList_', 'deleteGList_', 'deleteMsList_']) {
    context[name] = () => writes.push(name);
  }

  const beforeState = JSON.stringify(userStore.values);
  const report = context.dryRunReport();
  const logged = JSON.parse(logs.at(-1));

  assert.equal(report.listDiscoveryMode, 'auto');
  assert.equal(report.pendingMoves.length, 1);
  assert.deepEqual(logged.pendingMoves, JSON.parse(JSON.stringify(report.pendingMoves)));
  assert.deepEqual(logged.pendingMoveSummary, JSON.parse(JSON.stringify(report.pendingMoveSummary)));
  assert.equal(report.pendingMoves[0].status, 'READY');
  assert.equal(writes.length, 0);
  assert.equal(JSON.stringify(userStore.values), beforeState);
});

test('auto discovery dry-run failure preserves a durable move journal and reports no guessed preview', () => {
  const logs = [];
  const { context, userStore } = loadContext({
    scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'auto',
      SYNC_ALLOW_DELETIONS: 'false',
      SYNC_ALLOW_LIST_DELETIONS: 'false',
      SYNC_ALLOW_TASK_MOVES: 'true'
    }
  });
  context.console = { log: (message) => logs.push(message), warn: () => {}, error: () => {} };
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  state.taskMoveJournal['g-task'] = {
    phase: 'creating', gId: 'g-task', oldMsId: 'ms-task', newMsId: null,
    gListId: 'g-new', oldMsListId: 'ms-old', targetMsListId: 'ms-new',
    gUpdated: '2026-08-14T00:00:00Z', oldMsUpdated: '2026-08-14T00:00:00Z',
    preparedAt: '2026-08-14T00:01:00Z', fingerprint: 'fingerprint',
    uncertainConfirmations: 1
  };
  context.saveState_(state);
  context.getGLists_ = () => [{ id: 'g-old', title: 'Source' }];
  context.getMsLists_ = () => [{ id: 'ms-old', displayName: 'Source', isOwner: true, isShared: false, wellknownListName: 'none' }];
  context.getGDefaultList_ = () => { throw new Error('AUTO_DEFAULT_FAIL'); };

  const beforeState = JSON.stringify(userStore.values);
  const report = context.dryRunReport();
  const logged = JSON.parse(logs.at(-1));

  assert.equal(report.pendingMoves.length, 1);
  assert.equal(report.pendingMoves[0].status, 'RECOVERY');
  assert.equal(report.pendingMoves[0].metadataLoss.detectionScope.microsoftTaskSnapshot, 'MISSING');
  assert.deepEqual(JSON.parse(JSON.stringify(report.pendingMoves[0].metadataLoss.detectedNonPreserved)), []);
  assert.equal(report.pendingMoveSummary.total, 1);
  assert.equal(report.pendingMoveSummary.microsoftTaskSnapshotsMissing, 1);
  assert.deepEqual(logged.pendingMoves, JSON.parse(JSON.stringify(report.pendingMoves)));
  assert.match(report.warnings.join('\n'), /auto/i);
  assert.equal(JSON.stringify(userStore.values), beforeState);
});

test('Microsoft cross-list move converges as create-new then confirmed delete-old', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'].gListId = 'g-old';
  state.g2m['g-task'].msListId = 'ms-old';
  const base = {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    safety: { allowDeletions: true, allowTaskMoves: true },
    gTasksById: {
      'g-task': { id: 'g-task', title: 'Moved', updated: '2026-08-14T00:00:00Z'
      }
    },
    msTasksById: {
      'ms-task-new': {
        id: 'ms-task-new', title: 'Moved', lastModifiedDateTime: '2026-08-14T00:01:00Z'
      }
    },
    gListByTask: { 'g-task': 'g-old' },
    msListByTask: { 'ms-task-new': 'ms-new' }
  };
  context.createGTask_ = () => ({
    id: 'g-task-new', title: 'Moved', updated: '2026-08-14T00:02:00Z'
  });
  context.saveState_ = () => {};
  const deleted = [];
  context.deleteGTask_ = (listId, taskId) => deleted.push([listId, taskId]);

  context.reconcileMapped_(state, base, Date.now(), 'move-ms-1');
  context.createUnmapped_(state, base, Date.now());
  context.applyConfirmedTaskDeletions_(state, base, 'move-ms-1');
  assert.equal(state.pendingTaskDeletions['g-task'].confirmations, 1);
  assert.equal(state.g2m['g-task-new'].msId, 'ms-task-new');

  const second = {
    ...base,
    gTasksById: {
      ...base.gTasksById,
      'g-task-new': {
        id: 'g-task-new', title: 'Moved', updated: '2026-08-14T00:02:00Z'
      }
    },
    gListByTask: { 'g-task': 'g-old', 'g-task-new': 'g-new' }
  };
  context.reconcileMapped_(state, second, Date.now(), 'move-ms-2');
  context.applyConfirmedTaskDeletions_(state, second, 'move-ms-2');

  assert.deepEqual(deleted, [['g-old', 'g-task']]);
  assert.equal(state.g2m['g-task'], undefined);
  assert.equal(state.g2m['g-task-new'].msId, 'ms-task-new');
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.tombstones.m['ms-task']);
});

test('finalized task deletion clears active mapping and temporary state but retains bounded tombstones', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const rec = state.g2m['g-task'];
  state.pendingTaskDeletions['g-task'] = { confirmations: 2 };
  state.deletionJournal['g-task'] = { phase: 'prepared', msId: 'ms-task' };
  state.taskDeletionConflicts['g-task'] = { reason: 'stale' };
  const snap = mappedTaskSnapshot({ gTask: null, msTask: null });

  context.finalizeTaskDeletion_(state, snap, 'g-task', rec, 'both');

  assert.equal(state.g2m['g-task'], undefined);
  assert.equal(state.m2g['ms-task'], undefined);
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);
  assert.equal(state.deletionJournal['g-task'], undefined);
  assert.equal(state.taskDeletionConflicts['g-task'], undefined);
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.tombstones.m['ms-task']);
});

test('a reappearing task clears a first-miss candidate so a later miss restarts at 1/2', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const missing = mappedTaskSnapshot({ gTask: null });
  const live = mappedTaskSnapshot();
  let deletes = 0;
  context.saveState_ = () => {};
  context.deleteMsTask_ = () => { deletes += 1; };

  context.reconcileMapped_(state, missing, Date.now(), 'A-missing');
  context.applyConfirmedTaskDeletions_(state, missing, 'A-missing');
  assert.equal(state.pendingTaskDeletions['g-task'].confirmations, 1);

  context.reconcileMapped_(state, live, Date.now(), 'B-live');
  context.applyConfirmedTaskDeletions_(state, live, 'B-live');
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);
  assert.equal(state.taskDeletionConflicts['g-task'], undefined);

  context.reconcileMapped_(state, missing, Date.now(), 'C-missing');
  context.applyConfirmedTaskDeletions_(state, missing, 'C-missing');
  assert.equal(deletes, 0);
  assert.equal(state.pendingTaskDeletions['g-task'].confirmations, 1);
});

test('pair-specific inventory coverage blocks prepared deletion recovery without changing mapping or journal', () => {
  const cases = [
    ['explicit allowlist removed mapped Google list', {
      activeGListIds: { 'other-g': true },
      gTaskInventoryListIds: { 'other-g': true },
      msTaskInventoryListIds: { 'other-ms': true }
    }],
    ['auto exclusion makes mapped Google list inactive', {
      activeGListIds: { 'other-g': true },
      gTaskInventoryListIds: { 'other-g': true },
      msTaskInventoryListIds: { 'other-ms': true }
    }],
    ['faulted mapped pair while another pair inventory succeeds', {
      activeGListIds: { 'g-list': true, 'other-g': true },
      gTaskInventoryListIds: { 'g-list': true, 'other-g': true },
      msTaskInventoryListIds: { 'ms-list': true, 'other-ms': true },
      fault: true
    }]
  ];
  for (const [, options] of cases) {
    const { context } = loadContext();
    const state = mappedTaskState(context);
    readyDeletionCandidate(state, 'google');
    state.deletionJournal['g-task'] = context.preparedDeletionJournal_(state.pendingTaskDeletions['g-task']);
    delete state.pendingTaskDeletions['g-task'];
    if (options.fault) state.listFaults.g['g-list'] = { reason: 'HTTP_404_WHILE_FETCHING_TASKS' };
    const snap = mappedTaskSnapshot({
      gTask: null,
      activeGListIds: options.activeGListIds,
      gTaskInventoryListIds: options.gTaskInventoryListIds,
      msTaskInventoryListIds: options.msTaskInventoryListIds
    });
    let deletes = 0;
    context.deleteMsTask_ = () => { deletes += 1; };
    context.applyConfirmedTaskDeletions_(state, snap, 'pair-blocked');
    assert.equal(deletes, 0);
    assert.ok(state.g2m['g-task']);
    assert.ok(state.deletionJournal['g-task']);
    assert.ok(state.deletionJournal['g-task'].lastBlockedReason);
    assert.equal(state.tombstones.g['g-task'], undefined);
  }
});

test('a rebinding listMap quarantines the exact old pair and never deletes its task', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.listMap = { 'g-list': 'ms-new', 'g-other': 'ms-list' };
  readyDeletionCandidate(state, 'google');
  const snap = mappedTaskSnapshot({
    gTask: null,
    activeGListIds: { 'g-list': true, 'g-other': true },
    gTaskInventoryListIds: { 'g-list': true, 'g-other': true },
    msTaskInventoryListIds: { 'ms-list': true, 'ms-new': true }
  });
  let deletes = 0;
  context.deleteMsTask_ = () => { deletes += 1; };
  context.applyConfirmedTaskDeletions_(state, snap, 'rebound');
  assert.equal(deletes, 0);
  assert.ok(state.g2m['g-task']);
  assert.equal(state.pendingTaskDeletions['g-task'], undefined);
  assert.equal(state.tombstones.g['g-task'], undefined);
});

test('a journal survives actual mapped-list inventory fetch failure and cannot be finalized as both missing', () => {
  const { context } = loadContext({
    scriptValues: { SYNC_GOOGLE_LIST_IDS: 'g-list', SYNC_ALLOW_DELETIONS: 'true' }
  });
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google');
  state.deletionJournal['g-task'] = context.preparedDeletionJournal_(state.pendingTaskDeletions['g-task']);
  delete state.pendingTaskDeletions['g-task'];
  context.getGLists_ = () => [{ id: 'g-list', title: 'G' }];
  context.getMsLists_ = () => [{ id: 'ms-list', displayName: 'M' }];
  context.getGTasks_ = () => { throw new Error('HTTP 404: mapped list gone'); };
  context.getMsTasks_ = () => { throw new Error('must not read after paired Google fault'); };
  context.alertListFaultsIfAny_ = () => {};
  let deletes = 0;
  context.deleteMsTask_ = () => { deletes += 1; };

  const snap = context.buildSnapshot_(state, Date.now());
  context.applyConfirmedTaskDeletions_(state, snap, 'inventory-fault');
  assert.equal(snap.inventoryComplete, false);
  assert.equal(deletes, 0);
  assert.ok(state.g2m['g-task']);
  assert.ok(state.deletionJournal['g-task']);
  assert.equal(state.tombstones.g['g-task'], undefined);
});

test('repair and clear-all fail closed when a durable deletion journal touches the faulted pair', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google');
  state.deletionJournal['g-task'] = context.preparedDeletionJournal_(state.pendingTaskDeletions['g-task']);
  delete state.pendingTaskDeletions['g-task'];
  state.listFaults.g['g-list'] = { reason: 'HTTP_404_WHILE_FETCHING_TASKS', msListId: 'ms-list' };
  const before = JSON.parse(JSON.stringify(state));

  assert.throws(() => context.resetListPairing_(state, 'g-list', 'ms-list'), /REPAIR_DELETION_JOURNAL_PENDING/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), before);

  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.saveState_ = () => { throw new Error('must not save a refused repair'); };
  assert.throws(() => context.clearAllListFaultsAndPrepareResync(), /REPAIR_DELETION_JOURNAL_PENDING/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), before);
});

test('a final-save failure rolls back an undurable first-miss confirmation before catch-save', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  const snap = mappedTaskSnapshot({ gTask: null });
  let saved = null;
  let saves = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => snap;
  context.createUnmapped_ = () => {};
  context.sendFatalAlert_ = () => {};
  context.saveState_ = (value) => {
    saves += 1;
    if (saves === 1) throw new Error('final save failure');
    saved = JSON.parse(JSON.stringify(value));
  };

  assert.throws(() => context.syncAll(), /final save failure/);
  assert.equal(saved.pendingTaskDeletions['g-task'], undefined);
  assert.ok(saved.g2m['g-task']);
  assert.equal(saved.deletionJournal['g-task'], undefined);
});

test('a pre-delete journal save never persists another task\'s failed-round first confirmation', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  state.g2m['g-task-b'] = {
    msId: 'ms-task-b', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g['ms-task-b'] = 'g-task-b';
  readyDeletionCandidate(state, 'google', 'previous-round');
  state.pendingTaskDeletions['g-task'].confirmations = 1;
  const missingBothGoogle = {
    ...mappedTaskSnapshot({ gTask: null, msTask: { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' } }),
    msTasksById: {
      'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' },
      'ms-task-b': { id: 'ms-task-b', lastModifiedDateTime: '2026-08-14T00:00:00Z' }
    },
    msListByTask: { 'ms-task': 'ms-list', 'ms-task-b': 'ms-list' }
  };
  let persistedJournalSave = null;
  let saves = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => missingBothGoogle;
  context.createUnmapped_ = () => {};
  context.sendFatalAlert_ = () => {};
  context.deleteMsTask_ = (listId, taskId) => {
    if (taskId === 'ms-task') throw new Error('HTTP 500: first journal delete failed');
  };
  context.saveState_ = (value) => {
    saves += 1;
    if (!value.deletionJournal['g-task']) return;
    if (value.deletionJournal['g-task'] && !persistedJournalSave) {
      persistedJournalSave = JSON.parse(JSON.stringify(value));
      return;
    }
    throw new Error('catch state save failed');
  };

  assert.throws(() => context.syncAll(), /first journal delete failed/);
  assert.ok(persistedJournalSave.deletionJournal['g-task']);
  assert.equal(persistedJournalSave.pendingTaskDeletions['g-task-b'], undefined);
  const recovered = context.normalizeState_(persistedJournalSave);
  assert.equal(recovered.pendingTaskDeletions['g-task-b'], undefined);

  let bDeletes = 0;
  context.deleteMsTask_ = (listId, taskId) => {
    if (taskId === 'ms-task-b') bDeletes += 1;
  };
  context.reconcileMapped_(recovered, missingBothGoogle, Date.now(), 'fresh-b-after-journal');
  context.applyConfirmedTaskDeletions_(recovered, missingBothGoogle, 'fresh-b-after-journal');
  assert.equal(bDeletes, 0);
  assert.equal(recovered.pendingTaskDeletions['g-task-b'].confirmations, 1);
});

test('each of multiple prepared journals persists only completed-round candidates for the other task', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  state.g2m['g-task-b'] = {
    msId: 'ms-task-b', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g['ms-task-b'] = 'g-task-b';
  readyDeletionCandidate(state, 'google', 'round-2');
  state.pendingTaskDeletions['g-task-b'] = {
    gId: 'g-task-b', msId: 'ms-task-b', missingSide: 'google',
    gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    confirmations: 2, lastRoundId: 'round-2'
  };
  const beforeRound = JSON.parse(JSON.stringify(state.pendingTaskDeletions));
  Object.values(beforeRound).forEach((candidate) => {
    candidate.confirmations = 1;
    candidate.lastRoundId = 'round-1';
  });
  const snap = {
    ...mappedTaskSnapshot({ gTask: null, msTask: { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' } }),
    msTasksById: {
      'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' },
      'ms-task-b': { id: 'ms-task-b', lastModifiedDateTime: '2026-08-14T00:00:00Z' }
    },
    msListByTask: { 'ms-task': 'ms-list', 'ms-task-b': 'ms-list' }
  };
  const saves = [];
  context.saveState_ = (value) => { saves.push(JSON.parse(JSON.stringify(value))); };
  context.deleteMsTask_ = () => {};
  context.applyConfirmedTaskDeletions_(state, snap, 'round-2', {
    pendingBeforeRound: beforeRound,
    durableJournalTaskIds: {},
    invalidatedCandidateTaskIds: {},
    discardCandidateTaskIds: {}
  });

  assert.equal(saves.length, 2);
  assert.ok(saves[0].deletionJournal['g-task']);
  assert.equal(saves[0].pendingTaskDeletions['g-task-b'].confirmations, 1);
  assert.ok(saves[1].deletionJournal['g-task-b']);
  assert.equal(saves[1].pendingTaskDeletions['g-task'], undefined);
  assert.equal(saves[1].pendingTaskDeletions['g-task-b'].confirmations, 1);
});

test('a failed round never restores a candidate invalidated by a both-live observation', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google', 'previous-round');
  state.pendingTaskDeletions['g-task'].confirmations = 1;
  let saved = null;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => mappedTaskSnapshot();
  context.createUnmapped_ = () => { throw new Error('unrelated create failure'); };
  context.sendFatalAlert_ = () => {};
  context.saveState_ = (value) => { saved = JSON.parse(JSON.stringify(value)); };

  assert.throws(() => context.syncAll(), /unrelated create failure/);
  assert.equal(saved.pendingTaskDeletions['g-task'], undefined);

  const missing = mappedTaskSnapshot({ gTask: null });
  let deletes = 0;
  context.deleteMsTask_ = () => { deletes += 1; };
  context.reconcileMapped_(saved, missing, Date.now(), 'fresh-after-live');
  context.applyConfirmedTaskDeletions_(saved, missing, 'fresh-after-live');
  assert.equal(deletes, 0);
  assert.equal(saved.pendingTaskDeletions['g-task'].confirmations, 1);
});

test('a durable journal retry failure does not persist another task\'s second confirmation', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  state.g2m['g-task-b'] = {
    msId: 'ms-task-b', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g['ms-task-b'] = 'g-task-b';
  readyDeletionCandidate(state, 'google', 'old-round');
  state.deletionJournal['g-task'] = context.preparedDeletionJournal_(state.pendingTaskDeletions['g-task']);
  delete state.pendingTaskDeletions['g-task'];
  state.pendingTaskDeletions['g-task-b'] = {
    gId: 'g-task-b', msId: 'ms-task-b', missingSide: 'google',
    gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    confirmations: 1, lastRoundId: 'old-round'
  };
  const snap = {
    ...mappedTaskSnapshot({ gTask: null, msTask: { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' } }),
    msTasksById: {
      'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' },
      'ms-task-b': { id: 'ms-task-b', lastModifiedDateTime: '2026-08-14T00:00:00Z' }
    },
    msListByTask: { 'ms-task': 'ms-list', 'ms-task-b': 'ms-list' }
  };
  let saved = null;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => snap;
  context.createUnmapped_ = () => {};
  context.sendFatalAlert_ = () => {};
  context.deleteMsTask_ = () => { throw new Error('HTTP 500: journal retry failed'); };
  context.saveState_ = (value) => { saved = JSON.parse(JSON.stringify(value)); };

  assert.throws(() => context.syncAll(), /journal retry failed/);
  assert.equal(saved.pendingTaskDeletions['g-task-b'].confirmations, 1);
  assert.ok(saved.deletionJournal['g-task']);
});

test('a failed round drops a side-flip replacement candidate instead of counting it', () => {
  const { context } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  state.g2m['g-task-b'] = {
    msId: 'ms-task-b', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g['ms-task-b'] = 'g-task-b';
  readyDeletionCandidate(state, 'google', 'old-round');
  state.deletionJournal['g-task'] = context.preparedDeletionJournal_(state.pendingTaskDeletions['g-task']);
  delete state.pendingTaskDeletions['g-task'];
  state.pendingTaskDeletions['g-task-b'] = {
    gId: 'g-task-b', msId: 'ms-task-b', missingSide: 'google',
    gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    confirmations: 1, lastRoundId: 'old-round'
  };
  const sideFlip = {
    ...mappedTaskSnapshot({ gTask: null, msTask: { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' } }),
    gTasksById: { 'g-task-b': { id: 'g-task-b', updated: '2026-08-14T00:00:00Z' } },
    gListByTask: { 'g-task-b': 'g-list' },
    msTasksById: { 'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-14T00:00:00Z' } },
    msListByTask: { 'ms-task': 'ms-list' }
  };
  let saved = null;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => sideFlip;
  context.createUnmapped_ = () => {};
  context.sendFatalAlert_ = () => {};
  context.deleteMsTask_ = () => { throw new Error('HTTP 500: journal retry failed'); };
  context.saveState_ = (value) => { saved = JSON.parse(JSON.stringify(value)); };

  assert.throws(() => context.syncAll(), /journal retry failed/);
  assert.equal(saved.pendingTaskDeletions['g-task-b'], undefined);

  let deletes = 0;
  context.deleteMsTask_ = () => {};
  context.deleteGTask_ = () => { deletes += 1; };
  context.reconcileMapped_(saved, sideFlip, Date.now(), 'fresh-side-flip');
  context.applyConfirmedTaskDeletions_(saved, sideFlip, 'fresh-side-flip');
  assert.equal(deletes, 0);
  assert.equal(saved.pendingTaskDeletions['g-task-b'].confirmations, 1);
  assert.equal(saved.pendingTaskDeletions['g-task-b'].missingSide, 'microsoft');
});

test('disabled snapshot failure durably pauses prepared journals and re-enable requires fresh confirmation', () => {
  const disabled = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'false' } });
  const state = mappedTaskState(disabled.context);
  readyDeletionCandidate(state, 'google');
  state.deletionJournal['g-task'] = disabled.context.preparedDeletionJournal_(state.pendingTaskDeletions['g-task']);
  delete state.pendingTaskDeletions['g-task'];
  let paused = null;
  disabled.context.withGlobalLock_ = (fn) => fn();
  disabled.context.loadStateForSync_ = () => state;
  disabled.context.buildSnapshot_ = () => { throw new Error('snapshot failed'); };
  disabled.context.saveState_ = (value) => { paused = JSON.parse(JSON.stringify(value)); };
  disabled.context.sendFatalAlert_ = () => {};
  assert.throws(() => disabled.context.syncAll(), /snapshot failed/);
  assert.equal(paused.deletionJournal['g-task'].phase, 'paused');
  const disabledBothMissing = mappedTaskSnapshot({
    gTask: null, msTask: null, allowDeletions: false
  });
  disabled.context.reconcileMapped_(paused, disabledBothMissing, Date.now(), 'disabled-both-missing');
  disabled.context.applyConfirmedTaskDeletions_(paused, disabledBothMissing, 'disabled-both-missing');
  assert.ok(paused.g2m['g-task']);
  assert.equal(paused.tombstones.g['g-task'], undefined);
  assert.equal(paused.deletionJournal['g-task'].phase, 'paused');

  const enabled = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const snap = mappedTaskSnapshot({ gTask: null });
  let deletes = 0;
  enabled.context.deleteMsTask_ = () => { deletes += 1; };
  enabled.context.saveState_ = () => {};
  enabled.context.reconcileMapped_(paused, snap, Date.now(), 're-enabled');
  enabled.context.applyConfirmedTaskDeletions_(paused, snap, 're-enabled');
  assert.equal(deletes, 0);
  assert.equal(paused.deletionJournal['g-task'], undefined);
  enabled.context.reconcileMapped_(paused, snap, Date.now(), 'fresh-1');
  enabled.context.applyConfirmedTaskDeletions_(paused, snap, 'fresh-1');
  assert.equal(paused.pendingTaskDeletions['g-task'].confirmations, 1);
});

test('imports reject a ready pending candidate and normalize legacy residue into a fresh first confirmation', () => {
  const { context } = loadContext();
  const imported = mappedTaskState(context);
  readyDeletionCandidate(imported, 'google');
  assert.throws(() => context.validateImportedState_(imported), /IMPORT_INVALID_STATE/);
  const normalized = context.normalizeState_(imported);
  assert.equal(normalized.pendingTaskDeletions['g-task'], undefined);
  const missing = mappedTaskSnapshot({ gTask: null });
  let deletes = 0;
  context.saveState_ = () => {};
  context.deleteMsTask_ = () => { deletes += 1; };
  context.reconcileMapped_(normalized, missing, Date.now(), 'fresh-1');
  context.applyConfirmedTaskDeletions_(normalized, missing, 'fresh-1');
  assert.equal(deletes, 0);
  assert.equal(normalized.pendingTaskDeletions['g-task'].confirmations, 1);
  context.reconcileMapped_(normalized, missing, Date.now(), 'fresh-2');
  context.applyConfirmedTaskDeletions_(normalized, missing, 'fresh-2');
  assert.equal(deletes, 1);
});

test('only leading 404 or 410 status is idempotent; embedded status text in a 500 is retryable', () => {
  const { context } = loadContext();
  assert.equal(context.isNotFoundError_(new Error('HTTP 404: gone')), true);
  assert.equal(context.isNotFoundError_(new Error('HTTP 410: gone')), true);
  assert.equal(context.isNotFoundError_(new Error('HTTP 500: upstream quoted HTTP 404')), false);
});

function listDeletionPair(context, {
  status = 'google_missing',
  gFingerprint = null,
  msFingerprint = JSON.stringify({ id: 'ms-list', title: 'custom', isOwner: true, isShared: true, wellknownListName: 'none' })
} = {}) {
  const key = context.listPairKey_('g-list', 'ms-list');
  return {
    key,
    gListId: 'g-list',
    msListId: 'ms-list',
    gTitle: 'Custom',
    msTitle: 'Custom',
    gLive: status !== 'google_missing' && status !== 'both_missing',
    msLive: status !== 'microsoft_missing' && status !== 'both_missing',
    gFingerprint,
    msFingerprint,
    status,
    gDefault: false,
    msDefault: false,
    deletable: true,
    tracked: false,
    tombstoned: false
  };
}

function listDeletionState(context) {
  const state = context.newState_();
  const key = context.listPairKey_('g-list', 'ms-list');
  state.listMap = { 'g-list': 'ms-list' };
  state.listPairMeta[key] = {
    gListId: 'g-list',
    msListId: 'ms-list',
    gTitle: 'Custom',
    msTitle: 'Custom',
    gFingerprint: JSON.stringify({ id: 'g-list', title: 'custom' }),
    msFingerprint: JSON.stringify({ id: 'ms-list', title: 'custom', isOwner: true, isShared: true, wellknownListName: 'none' }),
    gDeletable: true,
    msDeletable: true,
    autoBothLiveProvenAt: '2026-08-01T00:00:00Z'
  };
  return state;
}

function listDeletionSnapshot(pair, overrides = {}) {
  return {
    inventoryComplete: true,
    listInventoryComplete: true,
    safety: { listDiscoveryMode: 'auto', allowListDeletions: true },
    gTasksById: {},
    msTasksById: {},
    gListByTask: {},
    msListByTask: {},
    gTaskInventoryListIds: {},
    msTaskInventoryListIds: pair.status === 'google_missing' ? { 'ms-list': true } :
      pair.status === 'microsoft_missing' ? { 'g-list': true } : {},
    listLifecycle: { inventoryComplete: true, pairs: [pair] },
    ...overrides
  };
}

function listDeletionCandidateRecord(pair, overrides = {}) {
  return {
    key: pair.key,
    gListId: pair.gListId,
    msListId: pair.msListId,
    gTitle: pair.gTitle,
    msTitle: pair.msTitle,
    gFingerprint: pair.gFingerprint,
    msFingerprint: pair.msFingerprint,
    survivorFingerprint: pair.status === 'google_missing' ? pair.msFingerprint :
      pair.status === 'microsoft_missing' ? pair.gFingerprint : null,
    taskPairs: [],
    taskFingerprint: '[]',
    missingSide: pair.status === 'google_missing' ? 'google' :
      pair.status === 'microsoft_missing' ? 'microsoft' : 'both',
    deletable: true,
    confirmations: 1,
    lastRoundId: 'round-1',
    firstConfirmedAt: '2026-08-01T00:00:00Z',
    lastConfirmedAt: '2026-08-01T00:00:00Z',
    ...overrides
  };
}

test('keeps the list deletion switch independent, default-off, and auto-only', () => {
  const auto = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true'
  } }).context.getSafetyConfig_();
  assert.equal(auto.requestedListDeletions, true);
  assert.equal(auto.allowListDeletions, true);

  const explicit = loadContext({ scriptValues: {
    SYNC_GOOGLE_LIST_IDS: 'g-list', SYNC_ALLOW_LIST_DELETIONS: 'true'
  } }).context.getSafetyConfig_();
  assert.equal(explicit.requestedListDeletions, true);
  assert.equal(explicit.allowListDeletions, false);
});

test('pauses list journals durably before explicit-mode inventory and then fails closed', () => {
  const { context } = loadContext({ scriptValues: {
    SYNC_GOOGLE_LIST_IDS: 'g-list', SYNC_ALLOW_LIST_DELETIONS: 'true'
  } });
  const state = listDeletionState(context);
  const key = context.listPairKey_('g-list', 'ms-list');
  state.listDeletionJournal[key] = {
    ...context.preparedListDeletionJournal_({
      ...listDeletionPair(context), taskPairs: [], taskFingerprint: '[]', missingSide: 'google',
      confirmations: 1, lastRoundId: 'old', deletable: true
    })
  };
  let inventories = 0;
  const saved = [];
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => { inventories += 1; return null; };
  context.saveState_ = (value) => saved.push(JSON.parse(JSON.stringify(value)));
  context.sendFatalAlert_ = () => {};

  assert.throws(() => context.syncAll(), /SYNC_LIST_DELETIONS_AUTO_ONLY/);
  assert.equal(inventories, 0);
  assert.equal(saved.some((item) => item.listDeletionJournal[key].phase === 'paused'), true);
  assert.equal(saved.some((item) => Object.keys(item.pendingListDeletions).length === 0), true);
});

test('migrates schema 2 additively and rejects unknown or malformed schema 3 list state', () => {
  const { context } = loadContext();
  const migrated = context.normalizeState_({
    schema: 2, listMap: {}, g2m: {}, m2g: {}, tombstones: { g: {}, m: {} },
    listFaults: { g: {}, ms: {} }, health: {}
  });
  assert.equal(migrated.schema, 3);
  assert.equal(JSON.stringify(migrated.listTombstones), JSON.stringify({ g: {}, ms: {} }));
  assert.equal(JSON.stringify(migrated.listTombstoneNames), JSON.stringify({ g: {}, ms: {} }));
  assert.doesNotThrow(() => context.normalizeState_(migrated));
  assert.throws(() => context.normalizeState_({ schema: 4 }), /STATE_SCHEMA_UNSUPPORTED/);
  const malformed = context.newState_();
  malformed.pendingListDeletions = 'discard me';
  assert.throws(() => context.normalizeState_(malformed), /STATE_MALFORMED/);
});

test('schema 2 migration rejects poison before import or restore save while retaining known deployed and task-delete fields', () => {
  const deployedSchema2 = () => ({
    schema: 2,
    listMap: { 'g-list': 'ms-list' },
    g2m: {
      'g-task': {
        msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
        gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z'
      }
    },
    m2g: { 'ms-task': 'g-task' },
    tombstones: { g: {}, m: {} },
    pendingTaskDeletions: {},
    deletionJournal: {},
    taskDeletionConflicts: {},
    listFaults: { g: {}, ms: {} },
    health: {},
    updatedAt: null
  });
  const { context } = loadContext();
  const migrated = context.normalizeState_(deployedSchema2());
  assert.equal(migrated.schema, 3);
  assert.doesNotThrow(() => context.normalizeState_(migrated));

  const poisoned = [
    (state) => { state.surprise = 'poison'; },
    (state) => { state.g2m['g-task'].surprise = 'poison'; },
    (state) => {
      state.pendingTaskDeletions['g-task'] = {
        gId: 'g-task', msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
        missingSide: 'google', confirmations: 1, lastRoundId: 'round-1', surprise: 'poison'
      };
    }
  ];
  for (const poison of poisoned) {
    const malformed = deployedSchema2();
    poison(malformed);
    assert.throws(() => context.normalizeState_(JSON.parse(JSON.stringify(malformed))), /STATE_MALFORMED/);

    const imported = loadContext();
    let importSaves = 0;
    imported.context.withGlobalLock_ = (fn) => fn();
    imported.context.loadStateForSync_ = () => imported.context.newState_();
    imported.context.saveState_ = () => { importSaves += 1; };
    assert.throws(() => imported.context.importSyncState(JSON.parse(JSON.stringify(malformed))), /IMPORT_INVALID_STATE/);
    assert.equal(importSaves, 0);

    const restored = loadContext({ userValues: {
      sync_state_main_manifest: JSON.stringify({ generation: 'current', count: 1, previousGeneration: 'previous' }),
      sync_state_main_successful_round_manifest: JSON.stringify({ version: 1, current: { generation: 'previous', roundId: 'legacy-test-success' }, previous: null }),
      sync_state_main_gen_previous_count: '1',
      sync_state_main_gen_previous_0: encodeURIComponent(JSON.stringify(malformed))
    } });
    let restoreSaves = 0;
    restored.context.withGlobalLock_ = (fn) => fn();
    restored.context.loadStateForSync_ = () => restored.context.newState_();
    restored.context.saveState_ = () => { restoreSaves += 1; };
    assert.throws(() => restored.context.restorePreviousSyncState(), /STATE_MALFORMED/);
    assert.equal(restoreSaves, 0);
  }
});

test('classifies default, ineligible, missing and excluded list states without mistaking filters for missing', () => {
  const { context } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_EXCLUDED_LIST_NAMES: 'Excluded'
  } });
  const state = context.newState_();
  state.listMap = {
    'g-default': 'ms-default', 'g-shared': 'ms-shared', 'g-excluded': 'ms-excluded',
    'g-gone': 'ms-custom'
  };
  const lifecycle = context.classifyListLifecycle_(state,
    [
      { id: 'g-default', title: 'Tasks' }, { id: 'g-shared', title: 'Shared' },
      { id: 'g-excluded', title: 'Excluded' }
    ],
    [
      { id: 'ms-default', displayName: 'Tasks', isOwner: true, isShared: false, wellknownListName: 'defaultList' },
      { id: 'ms-shared', displayName: 'Shared', isOwner: true, isShared: true, wellknownListName: 'none' },
      { id: 'ms-excluded', displayName: 'Excluded', isOwner: true, isShared: false, wellknownListName: 'none' },
      { id: 'ms-custom', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }
    ], { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_());
  assert.equal(lifecycle.byKey[context.listPairKey_('g-default', 'ms-default')].status, 'default');
  assert.equal(lifecycle.byKey[context.listPairKey_('g-shared', 'ms-shared')].status, 'ineligible');
  assert.equal(lifecycle.byKey[context.listPairKey_('g-excluded', 'ms-excluded')].status, 'excluded');
  assert.equal(lifecycle.byKey[context.listPairKey_('g-gone', 'ms-custom')].status, 'google_missing');
  assert.equal(lifecycle.byKey[context.listPairKey_('g-shared', 'ms-shared')].gLive, true);
});

test('reserved missing pairs and list tombstone names block auto recreation', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  const state = listDeletionState(context);
  const key = context.listPairKey_('g-list', 'ms-list');
  const lifecycle = context.classifyListLifecycle_(state,
    [{ id: 'g-new', title: 'Custom' }],
    [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }],
    { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_());
  const plan = context.planAutoListMappings_(state,
    [{ id: 'g-new', title: 'Custom' }],
    [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }],
    { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_(), lifecycle);
  assert.equal(lifecycle.reservedPairKeys[key], true);
  assert.equal(JSON.stringify(plan.createMicrosoft), '[]');
  assert.equal(JSON.stringify(plan.createGoogle), '[]');
});

test('list tombstone cleanup is inert while pending, journal, and conflict evidence reserve historic pairs', () => {
  const cases = ['pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts'];
  for (const field of cases) {
    const { context } = loadContext({ scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true'
    } });
    const state = listDeletionState(context);
    const key = context.listPairKey_('g-list', 'ms-list');
    delete state.listMap['g-list']; // Simulate a rebind/final-save residue.
    delete state.listPairMeta[key];
    const pair = listDeletionPair(context);
    const record = {
      key: pair.key, gListId: pair.gListId, msListId: pair.msListId,
      gTitle: pair.gTitle, msTitle: pair.msTitle, gFingerprint: pair.gFingerprint,
      msFingerprint: pair.msFingerprint, survivorFingerprint: pair.msFingerprint,
      taskPairs: [], taskFingerprint: '[]', missingSide: 'google', deletable: true,
      confirmations: 1, lastRoundId: 'old',
      firstConfirmedAt: '2026-08-01T00:00:00Z', lastConfirmedAt: '2026-08-01T00:00:00Z'
    };
    if (field === 'listDeletionJournal') {
      state[field][key] = context.preparedListDeletionJournal_(record);
    } else if (field === 'listDeletionConflicts') {
      state[field][key] = {
        at: '2026-08-01T00:00:00Z', reason: 'LIST_DELETE_REVIEW_REQUIRED',
        gListId: 'g-list', msListId: 'ms-list', gTitle: 'Custom', msTitle: 'Custom'
      };
    } else {
      state[field][key] = record;
    }

    assert.doesNotThrow(() => context.cleanupListTombstones_(state));
    const lifecycle = context.classifyListLifecycle_(state,
      [{ id: 'g-new', title: 'Custom' }],
      [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }],
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_());
    const plan = context.planAutoListMappings_(state,
      [{ id: 'g-new', title: 'Custom' }],
      [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }],
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_(), lifecycle);
    assert.equal(lifecycle.reservedGoogleIds['g-list'], true);
    assert.equal(lifecycle.reservedMicrosoftIds['ms-list'], true);
    assert.equal(lifecycle.reservedPairKeys[key], true);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.createMicrosoft)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.createGoogle)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.pairs)), []);

    let inventories = 0;
    let recoveries = 0;
    context.withGlobalLock_ = (fn) => fn();
    context.recordSuccessfulSyncRound_ = () => true;
    context.loadStateForSync_ = () => state;
    context.buildSnapshot_ = () => {
      inventories += 1;
      return {
        inventoryComplete: false,
        activeGListIds: {}, gTasksById: {}, msTasksById: {},
        gListByTask: {}, msListByTask: {},
        safety: { allowDeletions: false, allowTaskMoves: false, allowListDeletions: true, listDiscoveryMode: 'auto' },
        listLifecycle: { inventoryComplete: false, pairs: [] }
      };
    };
    context.recoverPreparedListDeletions_ = () => { recoveries += 1; };
    context.saveState_ = () => {};
    context.sendFatalAlert_ = () => {};
    context.syncAll();
    assert.equal(inventories, 1);
    assert.equal(recoveries, 1);
  }
});

test('requires two different complete list rounds and quarantines source/fingerprint changes', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  const snap = listDeletionSnapshot(pair);
  const first = context.observeListDeletionCandidate_(state, snap, pair, 'round-1', { invalidatedListCandidateKeys: {} });
  assert.equal(first.confirmations, 1);
  const second = context.observeListDeletionCandidate_(state, snap, pair, 'round-2', { invalidatedListCandidateKeys: {} });
  assert.equal(second.confirmations, 2);
  const changed = { ...pair, msFingerprint: 'changed' };
  context.observeListDeletionCandidate_(state, listDeletionSnapshot(changed), changed, 'round-3', {
    invalidatedListCandidateKeys: {}
  });
  assert.equal(state.pendingListDeletions[pair.key], undefined);
  assert.equal(state.listDeletionConflicts[pair.key].reason, 'LIST_DELETE_METADATA_CHANGED');
});

test('syncAll persists a schema-safe first list miss and deletes only on the next complete round', () => {
  const { context, userStore } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true'
  } });
  let durable = listDeletionState(context);
  const key = context.listPairKey_('g-list', 'ms-list');
  const saved = [];
  let deletes = 0;
  let round = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.recordSuccessfulSyncRound_ = () => true;
  context.sendFatalAlert_ = () => {};
  context.deletionRoundId_ = () => 'list-e2e-round-' + (++round);
  context.loadStateForSync_ = () => context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  context.saveState_ = (value) => {
    durable = JSON.parse(JSON.stringify(value));
    saved.push(durable);
  };
  context.buildSnapshot_ = (state) => {
    const pair = listDeletionPair(context);
    pair.provenance = state.listPairMeta[key];
    return listDeletionSnapshot(pair, {
      listLifecycle: { inventoryComplete: true, pairs: [pair], byKey: { [key]: pair } }
    });
  };
  context.buildListDeletionRevalidation_ = (_state, record) => ({ ok: true, input: {
    key: record.key,
    gListId: record.gListId,
    msListId: record.msListId,
    gTitle: record.gTitle,
    msTitle: record.msTitle,
    missingSide: record.missingSide,
    gFingerprint: record.gFingerprint,
    msFingerprint: record.msFingerprint,
    survivorFingerprint: record.survivorFingerprint,
    taskPairs: record.taskPairs,
    taskFingerprint: record.taskFingerprint,
    deletable: true
  } });
  context.deleteMsList_ = (id) => {
    assert.equal(id, 'ms-list');
    deletes += 1;
  };

  context.syncAll();
  const afterFirst = context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  assert.equal(afterFirst.pendingListDeletions[key].confirmations, 1);
  assert.equal(Object.hasOwn(afterFirst.pendingListDeletions[key], 'ok'), false);
  assert.equal(deletes, 0);
  assert.equal(userStore.getProperty('sync_state_main_round_fence'), null);

  context.syncAll();
  const afterSecond = context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  assert.equal(deletes, 1);
  assert.equal(afterSecond.listMap['g-list'], undefined);
  assert.equal(afterSecond.pendingListDeletions[key], undefined);
  assert.ok(afterSecond.listTombstones.g['g-list']);
  assert.ok(afterSecond.listTombstones.ms['ms-list']);
  assert.equal(saved.length >= 3, true); // first final + pre-delete journal + second final
});

test('syncAll treats a proven Microsoft-missing auto pair as lifecycle evidence, not an ordinary fault', () => {
  const { context } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true'
  } });
  const customKey = context.listPairKey_('g-list', 'ms-list');
  let durable = listDeletionState(context);
  durable.listMap['g-default'] = 'ms-default';
  let round = 0;
  let missingTaskListReads = 0;
  let deletedGoogleList = 0;
  const gDefault = { id: 'g-default', title: 'Tasks' };
  const gCustom = { id: 'g-list', title: 'Custom' };
  const msDefault = {
    id: 'ms-default', displayName: 'Tasks', isOwner: true, isShared: false, wellknownListName: 'defaultList'
  };
  context.withGlobalLock_ = (fn) => fn();
  context.recordSuccessfulSyncRound_ = () => true;
  context.sendFatalAlert_ = () => {};
  context.sendListFaultAlert_ = () => {};
  context.deletionRoundId_ = () => 'ms-missing-e2e-round-' + (++round);
  context.loadStateForSync_ = () => context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  context.saveState_ = (value) => { durable = JSON.parse(JSON.stringify(value)); };
  context.getGLists_ = () => [gDefault, gCustom];
  context.getMsLists_ = () => [msDefault]; // ms-list is conclusively absent from top-level inventory.
  context.getGDefaultList_ = () => gDefault;
  context.getGTasks_ = (id) => {
    assert.ok(id === 'g-default' || id === 'g-list');
    return [];
  };
  context.getMsTasks_ = (id) => {
    if (id === 'ms-list') {
      missingTaskListReads += 1;
      throw new Error('HTTP 404: missing list must not be fetched');
    }
    assert.equal(id, 'ms-default');
    return [];
  };
  context.getGList_ = (id) => {
    assert.equal(id, 'g-list');
    return gCustom;
  };
  context.getMsList_ = (id) => {
    assert.notEqual(id, 'ms-list');
    return msDefault;
  };
  context.deleteGList_ = (id) => {
    assert.equal(id, 'g-list');
    deletedGoogleList += 1;
  };

  context.syncAll();
  const afterFirst = context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  assert.equal(afterFirst.pendingListDeletions[customKey].missingSide, 'microsoft');
  assert.equal(afterFirst.pendingListDeletions[customKey].confirmations, 1);
  assert.equal(afterFirst.listFaults.g['g-list'], undefined);
  assert.equal(afterFirst.listFaults.ms['ms-list'], undefined);
  assert.equal(missingTaskListReads, 0);
  assert.equal(deletedGoogleList, 0);

  context.syncAll();
  const afterSecond = context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  assert.equal(missingTaskListReads, 0);
  assert.equal(deletedGoogleList, 1);
  assert.equal(afterSecond.listMap['g-list'], undefined);
  assert.ok(afterSecond.listTombstones.g['g-list']);
  assert.ok(afterSecond.listTombstones.ms['ms-list']);
});

test('auto default list keeps ordinary task create and both update directions without list-delete ownership', () => {
  const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
  let durable = context.newState_();
  let mode = 'create';
  let created = 0;
  let googleToMicrosoftUpdates = 0;
  let microsoftToGoogleUpdates = 0;
  const gDefault = { id: 'g-default', title: 'Tasks' };
  const msDefault = {
    id: 'ms-default', displayName: 'Tasks', isOwner: true, isShared: false, wellknownListName: 'defaultList'
  };
  const gTask = (updated) => ({
    id: 'g-task', title: 'Default task', notes: '', status: 'needsAction', updated
  });
  const msTask = (updated) => ({
    id: 'ms-task', title: 'Default task', body: { content: '' }, status: 'notStarted', lastModifiedDateTime: updated
  });
  context.withGlobalLock_ = (fn) => fn();
  context.recordSuccessfulSyncRound_ = () => true;
  context.sendFatalAlert_ = () => {};
  context.sendListFaultAlert_ = () => {};
  context.loadStateForSync_ = () => context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  context.saveState_ = (value) => { durable = JSON.parse(JSON.stringify(value)); };
  context.getGLists_ = () => [gDefault];
  context.getMsLists_ = () => [msDefault];
  context.getGDefaultList_ = () => gDefault;
  context.getGTasks_ = () => [gTask(mode === 'create' ? '2026-08-01T00:00:00Z' : '2026-08-01T00:02:00Z')];
  context.getMsTasks_ = () => {
    if (mode === 'create') return [];
    return [msTask(mode === 'google-update' ? '2026-08-01T00:00:00Z' : '2026-08-01T00:04:00Z')];
  };
  context.createMsTask_ = (listId) => {
    assert.equal(listId, 'ms-default');
    created += 1;
    return msTask('2026-08-01T00:00:00Z');
  };
  context.updateMsTask_ = (listId, id) => {
    assert.equal(listId, 'ms-default');
    assert.equal(id, 'ms-task');
    googleToMicrosoftUpdates += 1;
    return msTask('2026-08-01T00:03:00Z');
  };
  context.updateGTask_ = (listId, id) => {
    assert.equal(listId, 'g-default');
    assert.equal(id, 'g-task');
    microsoftToGoogleUpdates += 1;
    return gTask('2026-08-01T00:05:00Z');
  };
  context.deleteGList_ = () => { throw new Error('default list must never be deleted'); };
  context.deleteMsList_ = () => { throw new Error('default list must never be deleted'); };

  context.syncAll();
  mode = 'google-update';
  context.syncAll();
  mode = 'microsoft-update';
  context.syncAll();

  const finalState = context.normalizeState_(JSON.parse(JSON.stringify(durable)));
  assert.equal(finalState.listMap['g-default'], 'ms-default');
  assert.equal(finalState.g2m['g-task'].msId, 'ms-task');
  assert.equal(created, 1);
  assert.equal(googleToMicrosoftUpdates, 0);
  assert.equal(microsoftToGoogleUpdates, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(finalState.pendingListDeletions)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(finalState.listDeletionJournal)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(finalState.listTombstones)), { g: {}, ms: {} });
});

test('list candidates reject unmapped, newer, unproven tasks and task journals', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  let snap = listDeletionSnapshot(pair, {
    msTasksById: { loose: { id: 'loose', lastModifiedDateTime: '2026-08-01T00:00:00Z' } },
    msListByTask: { loose: 'ms-list' }
  });
  assert.equal(context.listDeletionCandidateInput_(state, snap, pair).reason, 'LIST_DELETE_UNMAPPED_TASK');
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z'
  };
  state.m2g['ms-task'] = 'g-task';
  snap = listDeletionSnapshot(pair, {
    msTasksById: { 'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-01T00:01:00Z' } },
    msListByTask: { 'ms-task': 'ms-list' }
  });
  assert.equal(context.listDeletionCandidateInput_(state, snap, pair).reason, 'LIST_DELETE_TASK_NEWER_THAN_MAPPING');
  state.deletionJournal['g-task'] = { gListId: 'g-list', msListId: 'ms-list' };
  assert.equal(context.listDeletionCandidateInput_(state, snap, pair).reason, 'LIST_DELETE_TASK_JOURNAL_PENDING');
});

test('list journal saves only completed-round pending baseline and preserves 404/410 idempotency', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  const candidate = {
    ...pair, taskPairs: [], taskFingerprint: '[]', missingSide: 'google', deletable: true,
    confirmations: 2, lastRoundId: 'round-2'
  };
  state.pendingListDeletions[pair.key] = candidate;
  state.listDeletionJournal[pair.key] = context.preparedListDeletionJournal_(candidate);
  let persisted;
  context.saveState_ = (value) => { persisted = JSON.parse(JSON.stringify(value)); };
  context.saveListDeletionJournalDurably_(state, {
    pendingListBeforeRound: { other: { confirmations: 1, lastRoundId: 'old' } },
    invalidatedListCandidateKeys: {}
  });
  assert.equal(persisted.pendingListDeletions[pair.key], undefined);
  assert.equal(persisted.pendingListDeletions.other.confirmations, 1);
  for (const status of [404, 410]) {
    context.deleteMsList_ = () => { throw new Error(`HTTP ${status}: gone`); };
    assert.equal(context.remoteDeleteForMissingListSide_(candidate).alreadyGone, true);
  }
});

test('finalizing an exact list pair writes task/list tombstones and name guards until 30 days', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z'
  };
  state.m2g['ms-task'] = 'g-task';
  const key = context.listPairKey_('g-list', 'ms-list');
  const record = {
    key, gListId: 'g-list', msListId: 'ms-list', gTitle: 'Custom', msTitle: 'Custom',
    missingSide: 'both', deletable: true, taskPairs: context.listPairMappings_(state, {
      gListId: 'g-list', msListId: 'ms-list'
    })
  };
  context.finalizeListDeletion_(state, key, record, 'test');
  assert.ok(state.tombstones.g['g-task']);
  assert.ok(state.listTombstones.g['g-list']);
  assert.ok(state.listTombstoneNames.g['name:custom']);
  const now = Date.now();
  state.listTombstones.g['g-list'].at = now - 29 * 24 * 60 * 60 * 1000;
  context.cleanupListTombstones_(state, now);
  assert.ok(state.listTombstones.g['g-list']);
  context.cleanupListTombstones_(state, now + 24 * 60 * 60 * 1000);
  assert.equal(state.listTombstones.g['g-list'], undefined);
});

test('repair, import and observability stay fail-closed around list lifecycle evidence without task content', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const key = context.listPairKey_('g-list', 'ms-list');
  state.pendingListDeletions[key] = {
    ...listDeletionPair(context), taskPairs: [], taskFingerprint: '[]', missingSide: 'google',
    deletable: true, confirmations: 1, lastRoundId: 'round-1'
  };
  assert.throws(() => context.resetListPairing_(state, 'g-list', 'ms-list'), /REPAIR_LIST_LIFECYCLE_PENDING/);
  state.listDeletionConflicts[key] = { at: '2026-08-01T00:00:00Z', reason: 'SECRET_TASK_CONTENT' };
  const report = JSON.stringify(context.listDeletionObservability_(state, {
    listDiscoveryMode: 'auto', requestedListDeletions: false, allowListDeletions: false
  }));
  assert.equal(report.includes('SECRET_TASK_CONTENT'), true);
  assert.equal(report.includes('gTitle'), false);
});

test('list remote journal is per-pair, stops after a non-idempotent failure, and recovers both-missing without DELETE', () => {
  const { context } = loadContext();
  const state = context.newState_();
  const makeCandidate = (gListId, msListId, missingSide = 'google') => ({
    gListId, msListId, gTitle: gListId, msTitle: msListId, missingSide,
    gFingerprint: null, msFingerprint: JSON.stringify({ id: msListId }), survivorFingerprint: JSON.stringify({ id: msListId }),
    taskPairs: [], taskFingerprint: '[]', deletable: true, confirmations: 2, lastRoundId: 'round-2'
  });
  const a = makeCandidate('g-a', 'ms-a');
  const b = makeCandidate('g-b', 'ms-b');
  const keyA = context.listPairKey_(a.gListId, a.msListId);
  const keyB = context.listPairKey_(b.gListId, b.msListId);
  state.listMap = { 'g-a': 'ms-a', 'g-b': 'ms-b' };
  state.pendingListDeletions = { [keyA]: a, [keyB]: b };
  const calls = [];
  context.saveState_ = () => {};
  context.buildListDeletionRevalidation_ = (_state, record) => ({ ok: true, input: record });
  context.deleteMsList_ = (id) => {
    calls.push(id);
    if (id === 'ms-b') throw new Error('HTTP 500: stop later deletes');
  };
  const snap = { inventoryComplete: true, safety: { allowListDeletions: true, listDiscoveryMode: 'auto' },
    listLifecycle: { inventoryComplete: true, pairs: [] } };
  assert.throws(() => context.applyConfirmedListDeletions_(state, snap, 'round-2', {
    pendingListBeforeRound: {}, invalidatedListCandidateKeys: {}
  }), /HTTP 500/);
  assert.deepEqual(calls, ['ms-a', 'ms-b']);
  assert.equal(state.listMap['g-a'], undefined);
  assert.equal(state.listMap['g-b'], 'ms-b');
  assert.ok(state.listDeletionJournal[keyB]);

  const recovery = context.newState_();
  const both = makeCandidate('g-c', 'ms-c', 'both');
  const keyC = context.listPairKey_('g-c', 'ms-c');
  recovery.listMap = { 'g-c': 'ms-c' };
  recovery.listDeletionJournal[keyC] = context.preparedListDeletionJournal_(both);
  let remote = 0;
  context.buildListDeletionRevalidation_ = () => ({ ok: true, input: both });
  context.deleteGList_ = () => { remote += 1; };
  context.deleteMsList_ = () => { remote += 1; };
  context.recoverPreparedListDeletions_(recovery, {
    allowListDeletions: true, listDiscoveryMode: 'auto'
  }, {});
  assert.equal(remote, 0);
  assert.equal(recovery.listMap['g-c'], undefined);
  assert.ok(recovery.listTombstones.g['g-c']);
});

test('pre-delete revalidation re-reads complete inventories, survivor metadata, and survivor tasks', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pairKey = context.listPairKey_('g-list', 'ms-list');
  const record = {
    ...listDeletionPair(context), taskPairs: [], taskFingerprint: '[]', missingSide: 'google',
    gFingerprint: state.listPairMeta[pairKey].gFingerprint,
    msFingerprint: state.listPairMeta[pairKey].msFingerprint,
    survivorFingerprint: state.listPairMeta[pairKey].msFingerprint,
    deletable: true
  };
  const reads = [];
  context.getGLists_ = () => { reads.push('g-inventory'); return [{ id: 'g-default', title: 'Tasks' }]; };
  context.getMsLists_ = () => { reads.push('ms-inventory'); return [{
    id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none'
  }]; };
  context.getGDefaultList_ = () => ({ id: 'g-default', title: 'Tasks' });
  context.getMsList_ = () => { reads.push('ms-direct'); return {
    id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none'
  }; };
  context.getMsTasks_ = () => { reads.push('ms-tasks'); return []; };
  const result = context.buildListDeletionRevalidation_(state, record, {
    allowListDeletions: true, listDiscoveryMode: 'auto'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(reads, ['g-inventory', 'ms-inventory', 'ms-direct', 'ms-tasks']);
});

test('list deletion never reuses stale eligibility after exclusion or observed Microsoft downgrade', () => {
  const { context } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true',
    SYNC_EXCLUDED_LIST_NAMES: 'Excluded'
  } });
  const excluded = listDeletionState(context);
  const key = context.listPairKey_('g-list', 'ms-list');
  excluded.listPairMeta[key].gTitle = 'Excluded';
  const excludedPair = context.classifyListLifecycle_(excluded, [], [{
    id: 'ms-list', displayName: 'Keep', isOwner: true, isShared: false, wellknownListName: 'none'
  }], { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_()).byKey[key];
  assert.equal(excludedPair.status, 'excluded');
  assert.equal(excludedPair.deletable, false);
  assert.equal(context.listDeletionCandidateInput_(excluded, listDeletionSnapshot(excludedPair), excludedPair).ok, false);

  const downgraded = [
    { label: 'shared', isOwner: true, isShared: true, wellknownListName: 'none' },
    { label: 'non-owner', isOwner: false, isShared: false, wellknownListName: 'none' },
    { label: 'unknown', isOwner: true, isShared: false, wellknownListName: 'unknown' },
    { label: 'flagged', displayName: 'Flagged Emails', isOwner: true, isShared: false, wellknownListName: 'none' },
    { label: 'default', isOwner: true, isShared: false, wellknownListName: 'defaultList' }
  ];
  for (const change of downgraded) {
    const state = listDeletionState(context);
    const ms = { id: 'ms-list', displayName: change.displayName || 'Custom', ...change };
    const live = context.classifyListLifecycle_(state, [{ id: 'g-list', title: 'Custom' }], [ms],
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_());
    context.recordAutoBothLivePairMeta_(state, live, context.getSafetyConfig_());
    assert.equal(state.listPairMeta[key], undefined, change.label);
    const missing = context.classifyListLifecycle_(state, [{ id: 'g-list', title: 'Custom' }], [],
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_()).byKey[key];
    assert.equal(missing.deletable, false, change.label);
    assert.equal(context.listDeletionCandidateInput_(state, listDeletionSnapshot(missing), missing).ok, false, change.label);
  }
});

test('one-sided ineligible survivor revokes list deletion proof before any later side flip can delete', () => {
  const scenarios = [
    {
      label: 'Google survivor becomes excluded',
      intermediateGoogle: [{ id: 'g-list', title: 'Excluded' }],
      intermediateMicrosoft: [],
      laterGoogle: [],
      laterMicrosoft: [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }],
      defaultGoogle: { id: 'g-default', title: 'Tasks' }
    },
    {
      label: 'Google survivor becomes default',
      intermediateGoogle: [{ id: 'g-list', title: 'Tasks' }],
      intermediateMicrosoft: [],
      laterGoogle: [],
      laterMicrosoft: [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' }],
      defaultGoogle: { id: 'g-list', title: 'Tasks' }
    },
    {
      label: 'Microsoft survivor becomes shared',
      intermediateGoogle: [],
      intermediateMicrosoft: [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: true, wellknownListName: 'none' }],
      laterGoogle: [{ id: 'g-list', title: 'Custom' }],
      laterMicrosoft: [],
      defaultGoogle: { id: 'g-default', title: 'Tasks' }
    },
    {
      label: 'Microsoft survivor loses ownership',
      intermediateGoogle: [],
      intermediateMicrosoft: [{ id: 'ms-list', displayName: 'Custom', isOwner: false, isShared: false, wellknownListName: 'none' }],
      laterGoogle: [{ id: 'g-list', title: 'Custom' }],
      laterMicrosoft: [],
      defaultGoogle: { id: 'g-default', title: 'Tasks' }
    },
    {
      label: 'Microsoft survivor becomes unknown',
      intermediateGoogle: [],
      intermediateMicrosoft: [{ id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'unknown' }],
      laterGoogle: [{ id: 'g-list', title: 'Custom' }],
      laterMicrosoft: [],
      defaultGoogle: { id: 'g-default', title: 'Tasks' }
    },
    {
      label: 'Microsoft survivor becomes default',
      intermediateGoogle: [],
      intermediateMicrosoft: [{ id: 'ms-list', displayName: 'Tasks', isOwner: true, isShared: false, wellknownListName: 'defaultList' }],
      laterGoogle: [{ id: 'g-list', title: 'Custom' }],
      laterMicrosoft: [],
      defaultGoogle: { id: 'g-default', title: 'Tasks' }
    }
  ];
  for (const scenario of scenarios) {
    const { context } = loadContext({ scriptValues: {
      SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true',
      SYNC_EXCLUDED_LIST_NAMES: 'Excluded'
    } });
    const state = listDeletionState(context);
    const key = context.listPairKey_('g-list', 'ms-list');
    const safety = context.getSafetyConfig_();
    const intermediate = context.classifyListLifecycle_(state,
      scenario.intermediateGoogle, scenario.intermediateMicrosoft, scenario.defaultGoogle, safety);
    context.recordAutoBothLivePairMeta_(state, intermediate, safety);
    assert.equal(state.listPairMeta[key], undefined, scenario.label + ': stale proof must be revoked');

    const later = context.classifyListLifecycle_(state,
      scenario.laterGoogle, scenario.laterMicrosoft, scenario.defaultGoogle, safety).byKey[key];
    assert.equal(later.provenance, null, scenario.label + ': no later missing-side proof');
    assert.equal(later.deletable, false, scenario.label + ': later side flip must be ineligible');
    let deletes = 0;
    context.deleteGList_ = () => { deletes += 1; };
    context.deleteMsList_ = () => { deletes += 1; };
    const snapshot = listDeletionSnapshot(later, {
      listLifecycle: { inventoryComplete: true, pairs: [later], byKey: { [key]: later } }
    });
    context.applyConfirmedListDeletions_(state, snapshot, 'later-round-1');
    context.applyConfirmedListDeletions_(state, snapshot, 'later-round-2');
    assert.equal(deletes, 0, scenario.label + ': staged apply must not delete');
    assert.equal(state.pendingListDeletions[key], undefined, scenario.label + ': no candidate survives');
  }
});

test('a list journal durable save never persists same-round task candidates', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  state.g2m = {
    'g-old-a': { msId: 'ms-old-a', gListId: 'g-old-a-list', msListId: 'ms-old-a-list' },
    'g-old-b': { msId: 'ms-old-b', gListId: 'g-old-b-list', msListId: 'ms-old-b-list' },
    'g-new': { msId: 'ms-new', gListId: 'g-new-list', msListId: 'ms-new-list' }
  };
  const baseline = {
    'g-old-a': { gId: 'g-old-a', confirmations: 1, lastRoundId: 'completed-a' },
    'g-old-b': { gId: 'g-old-b', confirmations: 1, lastRoundId: 'completed-b' }
  };
  state.pendingTaskDeletions = {
    ...baseline,
    'g-new': { gId: 'g-new', confirmations: 1, lastRoundId: 'failed-round' }
  };
  const pair = listDeletionPair(context);
  const candidate = listDeletionCandidateRecord(pair, { confirmations: 2, lastRoundId: 'round-2' });
  state.listDeletionJournal[pair.key] = context.preparedListDeletionJournal_(candidate);
  let durable;
  context.saveState_ = (value) => { durable = JSON.parse(JSON.stringify(value)); };
  context.saveListDeletionJournalDurably_(state,
    { pendingListBeforeRound: {}, invalidatedListCandidateKeys: {} },
    { pendingBeforeRound: baseline, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} });
  assert.deepEqual(durable.pendingTaskDeletions, baseline);
  assert.equal(durable.pendingTaskDeletions['g-new'], undefined);
  assert.ok(durable.listDeletionJournal[pair.key]);
});

test('a later list journal save does not persist an already-finalized pair\'s stale baseline candidate', () => {
  const { context } = loadContext();
  const state = context.newState_();
  const pairA = { ...listDeletionPair(context), key: context.listPairKey_('g-a', 'ms-a'), gListId: 'g-a', msListId: 'ms-a' };
  const pairB = { ...listDeletionPair(context), key: context.listPairKey_('g-b', 'ms-b'), gListId: 'g-b', msListId: 'ms-b' };
  const staleA = listDeletionCandidateRecord(pairA, { lastRoundId: 'completed-a' });
  const baselineB = listDeletionCandidateRecord(pairB, { lastRoundId: 'completed-b' });
  // Pair A already completed locally earlier in this apply pass.  Its map and
  // pending record are gone in memory, but the round baseline still contains
  // its historical 1/2 candidate when B needs a durable pre-delete journal.
  state.listMap = { 'g-b': 'ms-b' };
  state.pendingListDeletions[pairB.key] = baselineB;
  state.listDeletionJournal[pairB.key] = context.preparedListDeletionJournal_(
    listDeletionCandidateRecord(pairB, { confirmations: 2, lastRoundId: 'current-round' })
  );
  let durable;
  context.saveState_ = (value) => { durable = JSON.parse(JSON.stringify(value)); };
  context.saveListDeletionJournalDurably_(state, {
    pendingListBeforeRound: { [pairA.key]: staleA, [pairB.key]: baselineB },
    invalidatedListCandidateKeys: {}
  }, {});
  assert.equal(durable.pendingListDeletions[pairA.key], undefined);
  assert.deepEqual(durable.pendingListDeletions[pairB.key], baselineB);
  assert.ok(durable.listDeletionJournal[pairB.key]);
});

test('a pre-existing round fence strips stale task candidates before the same run can observe a fresh miss', () => {
  const { context, userStore } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const stale = mappedTaskState(context);
  readyDeletionCandidate(stale, 'google', 'old-completed-round');
  stale.pendingTaskDeletions['g-task'].confirmations = 1;
  context.saveState_(stale);
  userStore.setProperty('sync_state_main_round_fence', JSON.stringify({
    roundId: 'crashed-round', startedAt: '2026-08-01T00:00:00Z', phase: 'active'
  }));
  let deletes = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.buildSnapshot_ = () => mappedTaskSnapshot({ gTask: null });
  context.createUnmapped_ = () => {};
  context.deleteMsTask_ = () => { deletes += 1; };
  context.sendFatalAlert_ = () => {};

  context.syncAll();
  const recovered = context.loadStateForSync_();
  assert.equal(deletes, 0);
  assert.equal(recovered.pendingTaskDeletions['g-task'].confirmations, 1);
  assert.notEqual(recovered.pendingTaskDeletions['g-task'].lastRoundId, 'old-completed-round');
  assert.equal(context.syncRoundFenceStatus_().active, false);
});

test('round fence intermediate projection strips volatile proof but retains exact prepared list-journal provenance', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  const otherKey = context.listPairKey_('g-other', 'ms-other');
  state.listMap['g-other'] = 'ms-other';
  state.listPairMeta[otherKey] = {
    gListId: 'g-other', msListId: 'ms-other', gTitle: 'Other', msTitle: 'Other',
    gFingerprint: 'g-other-proof', msFingerprint: 'ms-other-proof',
    gDeletable: true, msDeletable: true, autoBothLiveProvenAt: '2026-08-01T00:00:00Z'
  };
  state.pendingTaskDeletions['g-task'] = {
    gId: 'g-task', msId: 'ms-task', missingSide: 'google',
    gListId: 'g-list', msListId: 'ms-list', confirmations: 1, lastRoundId: 'round'
  };
  state.pendingListDeletions[pair.key] = listDeletionCandidateRecord(pair);
  state.listDeletionJournal[pair.key] = context.preparedListDeletionJournal_(
    listDeletionCandidateRecord(pair, { confirmations: 2, lastRoundId: 'round-2' })
  );
  context.openSyncRoundFence_('projection-round');
  context.persistSyncState_(state);
  const durable = context.loadBlobAtomic_('sync_state_main');
  assert.deepEqual(JSON.parse(JSON.stringify(durable.pendingTaskDeletions)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(durable.pendingListDeletions)), {});
  assert.ok(durable.listPairMeta[pair.key]);
  assert.equal(durable.listPairMeta[otherKey], undefined);
  assert.ok(durable.listDeletionJournal[pair.key]);
  context.withGlobalLock_ = (fn) => fn();
  assert.throws(() => context.importSyncState(context.newState_()), /IMPORT_ROUND_FENCE_ACTIVE/);
  assert.throws(() => context.restorePreviousSyncState(), /STATE_RESTORE_ROUND_FENCE_ACTIVE/);
  assert.throws(() => context.applyConfiguredListPairs(), /SYNC_PAIR_APPLY_ROUND_FENCE_ACTIVE/);
  assert.throws(() => context.adoptExistingListMappingsAsConfiguredPairs(), /SYNC_PAIR_ADOPT_ROUND_FENCE_ACTIVE/);
  assert.throws(() => context.repairFaultedListByGoogleId('g-list'), /REPAIR_ROUND_FENCE_ACTIVE/);
  context.clearSyncRoundFence_();
});

test('round fence read-back failure stops sync before inventory or remote mutation', () => {
  const { context, userStore } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const originalSet = userStore.setProperty.bind(userStore);
  userStore.setProperty = (key, value) => {
    if (key === 'sync_state_main_round_fence') return;
    originalSet(key, value);
  };
  let inventory = 0;
  let remote = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => context.newState_();
  context.buildSnapshot_ = () => { inventory += 1; return mappedTaskSnapshot({ gTask: null }); };
  context.createUnmapped_ = () => { remote += 1; };
  context.sendFatalAlert_ = () => {};
  assert.throws(() => context.syncAll(), /SYNC_ROUND_FENCE_SET_FAILED/);
  assert.equal(inventory, 0);
  assert.equal(remote, 0);
  assert.equal(context.syncRoundFenceStatus_().active, false);
});

test('durable one-sided list proof revocation survives later double-save loss and blocks a side-flip delete', () => {
  const { context, userStore } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true',
    SYNC_ALLOW_DELETIONS: 'true', SYNC_EXCLUDED_LIST_NAMES: 'Excluded'
  } });
  const state = listDeletionState(context);
  const realSave = context.saveState_;
  realSave(state);
  let saves = 0;
  let laterWork = 0;
  let remote = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.getGLists_ = () => [{ id: 'g-default', title: 'Tasks' }, { id: 'g-list', title: 'Excluded' }];
  context.getMsLists_ = () => [];
  context.getGDefaultList_ = () => ({ id: 'g-default', title: 'Tasks' });
  context.getGTasks_ = () => { laterWork += 1; return []; };
  context.createMsList_ = () => { remote += 1; return { id: 'new-ms', displayName: 'x' }; };
  context.createGList_ = () => { remote += 1; return { id: 'new-g', title: 'x' }; };
  context.sendFatalAlert_ = () => {};
  context.saveState_ = (value) => {
    saves += 1;
    if (saves === 1) return realSave(value); // early revocation checkpoint
    throw new Error('simulated later and catch save loss');
  };
  assert.throws(() => context.syncAll(), /simulated later and catch save loss/);
  assert.equal(laterWork, 0);
  assert.equal(remote, 0);
  assert.equal(userStore.getProperty('sync_state_main_round_fence') !== null, true);
  const durable = context.loadStateForSync_();
  const key = context.listPairKey_('g-list', 'ms-list');
  assert.equal(durable.listPairMeta[key], undefined);
  const later = context.classifyListLifecycle_(durable, [], [{
    id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none'
  }], { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_()).byKey[key];
  assert.equal(context.listDeletionCandidateInput_(durable, listDeletionSnapshot(later), later).ok, false);
  context.deleteMsList_ = () => { remote += 1; };
  context.applyConfirmedListDeletions_(durable, listDeletionSnapshot(later), 'flip-1');
  context.applyConfirmedListDeletions_(durable, listDeletionSnapshot(later), 'flip-2');
  assert.equal(remote, 0);
});

test('list proof revocation checkpoint failure aborts before planner, task inventory, or remote create', () => {
  const { context } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_LIST_DELETIONS: 'true',
    SYNC_EXCLUDED_LIST_NAMES: 'Excluded'
  } });
  const state = listDeletionState(context);
  let taskInventory = 0;
  let remote = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.getGLists_ = () => [{ id: 'g-default', title: 'Tasks' }, { id: 'g-list', title: 'Excluded' }];
  context.getMsLists_ = () => [];
  context.getGDefaultList_ = () => ({ id: 'g-default', title: 'Tasks' });
  context.getGTasks_ = () => { taskInventory += 1; return []; };
  context.createMsList_ = () => { remote += 1; return { id: 'new-ms' }; };
  context.createGList_ = () => { remote += 1; return { id: 'new-g' }; };
  context.saveState_ = () => { throw new Error('early proof checkpoint failed'); };
  context.sendFatalAlert_ = () => {};
  assert.throws(() => context.syncAll(), /early proof checkpoint failed/);
  assert.equal(taskInventory, 0);
  assert.equal(remote, 0);
});

test('a final-commit fence-clear failure retains the committed proof for the next complete round', () => {
  const { context, userStore } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  let deterministicRound = 0;
  context.deletionRoundId_ = () => 'fence-clear-' + (++deterministicRound);
  const originalDelete = userStore.deleteProperty.bind(userStore);
  userStore.deleteProperty = (key) => {
    if (key === 'sync_state_main_round_fence') throw new Error('clear unavailable');
    originalDelete(key);
  };
  let deletes = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.buildSnapshot_ = () => mappedTaskSnapshot({ gTask: null });
  context.createUnmapped_ = () => {};
  context.deleteMsTask_ = () => { deletes += 1; };
  context.sendFatalAlert_ = () => {};
  assert.throws(() => context.syncAll(), /SYNC_ROUND_FENCE_CLEAR_FAILED/);
  assert.equal(userStore.getProperty('sync_state_main_round_fence') !== null, true);
  userStore.deleteProperty = originalDelete;
  // The persisted final candidate is protected by the fence. A new process
  // must sanitize it before its next observation, so one fresh miss is 1/2.
  const durable = context.loadBlobAtomic_('sync_state_main');
  context.loadStateForSync_ = () => durable;
  context.syncAll();
  assert.equal(deletes, 1);
  assert.equal(context.loadBlobAtomic_('sync_state_main').g2m['g-task'], undefined);
});

test('duplicate Microsoft listMap targets fail closed before list journal recovery or import', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  const candidate = listDeletionCandidateRecord(pair, { confirmations: 2, lastRoundId: 'round-2' });
  state.listMap['g-live'] = 'ms-list';
  state.listDeletionJournal[pair.key] = context.preparedListDeletionJournal_(candidate);
  let deletes = 0;
  context.buildListDeletionRevalidation_ = () => { throw new Error('must not read/revalidate malformed pair'); };
  context.deleteMsList_ = () => { deletes += 1; };
  context.recoverPreparedListDeletions_(state, { allowListDeletions: true, listDiscoveryMode: 'auto' }, {});
  assert.equal(deletes, 0);
  assert.equal(state.listMap['g-list'], 'ms-list');
  assert.equal(state.listMap['g-live'], 'ms-list');
  assert.equal(state.listDeletionJournal[pair.key].phase, 'blocked');
  assert.throws(() => context.normalizeState_(JSON.parse(JSON.stringify(state))), /STATE_MALFORMED.*not one-to-one/);
  assert.throws(() => context.validateImportedState_(JSON.parse(JSON.stringify(state))), /IMPORT_INVALID_STATE.*not one-to-one/);
});

test('fault repair converts pure list metadata into an anti-recreate historic guard', () => {
  for (const mode of ['targeted', 'clear-all']) {
    const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
    const state = listDeletionState(context);
    const key = context.listPairKey_('g-list', 'ms-list');
    state.listFaults.g['g-list'] = { reason: 'HTTP_404_WHILE_FETCHING_TASKS', msListId: 'ms-list' };
    context.withGlobalLock_ = (fn) => fn();
    context.loadStateForSync_ = () => state;
    context.saveState_ = () => {};
    if (mode === 'targeted') context.repairFaultedListByGoogleId('g-list');
    else context.clearAllListFaultsAndPrepareResync();
    assert.equal(state.listMap['g-list'], undefined, mode);
    assert.equal(state.listPairMeta[key], undefined, mode);
    assert.equal(state.listDeletionConflicts[key].reason, 'LIST_REPAIR_HISTORIC_PAIR_GUARD', mode);
    const lifecycle = context.classifyListLifecycle_(state, [{ id: 'g-list', title: 'Custom' }], [],
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_());
    const plan = context.planAutoListMappings_(state, [{ id: 'g-list', title: 'Custom' }], [],
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_(), lifecycle);
    assert.deepEqual(JSON.parse(JSON.stringify(plan.createMicrosoft)), [], mode);
  }
  for (const field of ['pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts']) {
    const { context } = loadContext();
    const state = listDeletionState(context);
    const pair = listDeletionPair(context);
    state.listFaults.g['g-list'] = { reason: 'fault', msListId: 'ms-list' };
    const candidate = listDeletionCandidateRecord(pair);
    state[field][pair.key] = field === 'listDeletionJournal'
      ? context.preparedListDeletionJournal_(candidate)
      : field === 'listDeletionConflicts'
        ? { at: '2026-08-01T00:00:00Z', reason: 'REVIEW', gListId: 'g-list', msListId: 'ms-list' }
        : candidate;
    assert.throws(() => context.resetListPairing_(state, 'g-list', 'ms-list'), /PENDING/);
    assert.equal(state.listMap['g-list'], 'ms-list');
  }
});

test('a Google task-list 404 repair resolves the exact mapped pair before preserving its historic guard', () => {
  const { context } = loadContext({ scriptValues: {
    SYNC_GOOGLE_LIST_IDS: 'g-list',
    SYNC_LIST_PAIRS_JSON: JSON.stringify([{ googleListId: 'g-list', microsoftListId: 'ms-list' }])
  } });
  const state = listDeletionState(context);
  const key = context.listPairKey_('g-list', 'ms-list');
  const google = { id: 'g-list', title: 'Custom' };
  const microsoft = { id: 'ms-list', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' };
  context.getGLists_ = () => [google];
  context.getMsLists_ = () => [microsoft];
  context.getGTasks_ = () => { throw new Error('HTTP 404: task list gone'); };
  context.getMsTasks_ = () => { throw new Error('Google fault must skip MS task read'); };
  context.alertListFaultsIfAny_ = () => {};

  context.buildSnapshot_(state, Date.now());
  assert.equal(state.listFaults.g['g-list'].msListId, 'ms-list');

  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.saveState_ = () => {};
  context.repairFaultedListByGoogleId('g-list');
  assert.equal(state.listMap['g-list'], undefined);
  assert.equal(state.listPairMeta[key], undefined);
  assert.equal(state.listDeletionConflicts[key].reason, 'LIST_REPAIR_HISTORIC_PAIR_GUARD');
  const autoSafety = { listDiscoveryMode: 'auto', excludedListNames: [] };
  const lifecycle = context.classifyListLifecycle_(state, [google], [microsoft], null, autoSafety);
  const plan = context.planAutoListMappings_(state, [google], [microsoft], null, autoSafety, lifecycle);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.pairs)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.createMicrosoft)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.createGoogle)), []);
});

test('fault repair rejects ambiguous or mismatched historical counterparts before state mutation', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const originalKey = context.listPairKey_('g-list', 'ms-list');
  const conflictingKey = context.listPairKey_('g-list', 'ms-other');
  state.listPairMeta[conflictingKey] = {
    ...state.listPairMeta[originalKey], msListId: 'ms-other', msTitle: 'Other'
  };
  state.listFaults.g['g-list'] = { reason: 'HTTP_404_WHILE_FETCHING_TASKS', msListId: 'ms-list' };
  const before = JSON.parse(JSON.stringify(state));
  let saves = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.loadStateForSync_ = () => state;
  context.saveState_ = () => { saves += 1; };

  assert.throws(() => context.repairFaultedListByGoogleId('g-list'), /REPAIR_LIST_PAIR_AMBIGUOUS/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), before);
  assert.equal(saves, 0);
});

test('import and restore refuse to remove current unexpired task or list tombstone evidence', () => {
  const now = Date.now();
  const makeCurrent = (context) => {
    const state = context.newState_();
    const record = { at: now - 29 * 24 * 60 * 60 * 1000, source: 'test' };
    state.tombstones.g['g-task'] = record;
    state.tombstones.m['ms-task'] = record;
    state.listTombstones.g['g-list'] = { ...record, gListId: 'g-list', msListId: 'ms-list', gName: 'custom', msName: 'custom' };
    state.listTombstones.ms['ms-list'] = state.listTombstones.g['g-list'];
    state.listTombstoneNames.g['name:custom'] = state.listTombstones.g['g-list'];
    state.listTombstoneNames.ms['name:custom'] = state.listTombstones.g['g-list'];
    return state;
  };
  const imported = loadContext();
  const current = makeCurrent(imported.context);
  let saves = 0;
  imported.context.withGlobalLock_ = (fn) => fn();
  imported.context.loadStateForSync_ = () => current;
  imported.context.saveState_ = () => { saves += 1; };
  assert.throws(() => imported.context.importSyncState(imported.context.newState_()), /STATE_TOMBSTONE_PRESERVATION_REQUIRED/);
  assert.equal(saves, 0);
  const preserved = JSON.parse(JSON.stringify(current));
  preserved.tombstones.g['g-task'].at += 1;
  imported.context.importSyncState(preserved);
  assert.equal(saves, 1);
  const boundary = imported.context.newState_();
  boundary.tombstones.g['g-task'] = { at: now - 30 * 24 * 60 * 60 * 1000, source: 'expired' };
  assert.doesNotThrow(() => imported.context.assertTombstoneEvidencePreserved_(boundary, imported.context.newState_(), now));

  const previous = imported.context.newState_();
  const userValues = {
    sync_state_main_manifest: JSON.stringify({ generation: 'current', count: 1, previousGeneration: 'previous' }),
    sync_state_main_successful_round_manifest: JSON.stringify({ version: 1, current: { generation: 'previous', roundId: 'legacy-test-success' }, previous: null }),
    sync_state_main_gen_previous_count: '1',
    sync_state_main_gen_previous_0: encodeURIComponent(JSON.stringify(previous))
  };
  const restored = loadContext({ userValues });
  const restoreCurrent = makeCurrent(restored.context);
  let restoreSaves = 0;
  restored.context.withGlobalLock_ = (fn) => fn();
  restored.context.loadStateForSync_ = () => restoreCurrent;
  restored.context.saveState_ = () => { restoreSaves += 1; };
  assert.throws(() => restored.context.restorePreviousSyncState(), /STATE_TOMBSTONE_PRESERVATION_REQUIRED/);
  assert.equal(restoreSaves, 0);
});

test('import and restore preserve each exact list tombstone pair while accepting a newer timestamp for that same pair', () => {
  const now = 2_000_000_000_000;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function addCanonical(context, state, pair, at) {
    const record = {
      at,
      source: 'both',
      gListId: pair.gListId,
      msListId: pair.msListId,
      gName: pair.gName,
      msName: pair.msName
    };
    state.listTombstones.g[pair.gListId] = record;
    state.listTombstones.ms[pair.msListId] = { ...record };
    context.rebuildListTombstoneNameAliases_(state);
  }

  function makeCurrent(context) {
    const state = context.newState_();
    addCanonical(context, state, {
      gListId: 'g-old', msListId: 'ms-old',
      gName: 'old google', msName: 'old microsoft'
    }, now - 1000);
    addCanonical(context, state, {
      gListId: 'g-new', msListId: 'ms-new',
      gName: 'new google', msName: 'new microsoft'
    }, now - 1000);
    return state;
  }

  function makeIntegrityValidSplit(context) {
    const state = context.newState_();
    addCanonical(context, state, {
      gListId: 'g-old', msListId: 'ms-new',
      gName: 'old google', msName: 'new microsoft'
    }, now);
    addCanonical(context, state, {
      gListId: 'g-new', msListId: 'ms-old',
      gName: 'new google', msName: 'old microsoft'
    }, now);
    assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);
    return state;
  }

  function advanceExactPairs(context, state) {
    for (const side of ['g', 'ms']) {
      for (const record of Object.values(state.listTombstones[side])) record.at = now;
    }
    context.rebuildListTombstoneNameAliases_(state);
    assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);
  }

  function setPrevious(userStore, state) {
    userStore.setProperty('sync_state_main_manifest', JSON.stringify({
      generation: 'current', count: 1, previousGeneration: 'previous'
    }));
    userStore.setProperty('sync_state_main_successful_round_manifest', JSON.stringify({
      version: 1, current: { generation: 'previous', roundId: 'legacy-test-success' }, previous: null
    }));
    userStore.setProperty('sync_state_main_gen_previous_count', '1');
    userStore.setProperty('sync_state_main_gen_previous_0', encodeURIComponent(JSON.stringify(state)));
  }

  for (const operation of ['import', 'restore']) {
    const { context, userStore } = loadContext();
    new vm.Script('Date.now = function() { return 2000000000000; };').runInContext(context);
    const current = makeCurrent(context);
    const split = makeIntegrityValidSplit(context);
    let saves = 0;
    context.withGlobalLock_ = (fn) => fn();
    context.loadStateForSync_ = () => current;
    context.saveState_ = () => { saves += 1; };

    if (operation === 'import') {
      assert.throws(() => context.importSyncState(split),
        /STATE_TOMBSTONE_PRESERVATION_REQUIRED/, 'split-pair import');
    } else {
      setPrevious(userStore, split);
      assert.throws(() => context.restorePreviousSyncState(),
        /STATE_TOMBSTONE_PRESERVATION_REQUIRED/, 'split-pair restore');
    }
    assert.equal(saves, 0, operation + ' must not save an integrity-valid cross-pair replacement');

    const compatible = clone(current);
    advanceExactPairs(context, compatible);
    if (operation === 'import') {
      assert.doesNotThrow(() => context.importSyncState(compatible), 'same-pair newer import');
    } else {
      setPrevious(userStore, compatible);
      assert.doesNotThrow(() => context.restorePreviousSyncState(), 'same-pair newer restore');
    }
    assert.equal(saves, 1, operation + ' accepts exactly preserved pairs with monotonic timestamps');
  }
});

test('import and restore preserve active task/list anti-recreate reservations instead of replacing them clean', () => {
  const cases = [
    {
      label: 'task pending candidate',
      setup(context) {
        const state = mappedTaskState(context);
        const rec = state.g2m['g-task'];
        state.pendingTaskDeletions['g-task'] = {
          gId: 'g-task', msId: 'ms-task', missingSide: 'google',
          gListId: rec.gListId, msListId: rec.msListId,
          gUpdated: rec.gUpdated, msUpdated: rec.msUpdated,
          confirmations: 1, lastRoundId: 'completed-round',
          firstConfirmedAt: '2026-08-01T00:00:00Z', lastConfirmedAt: '2026-08-01T00:00:00Z'
        };
        return state;
      },
      advance(state) { state.pendingTaskDeletions['g-task'].lastConfirmedAt = '2026-08-02T00:00:00Z'; }
    },
    {
      label: 'task delete-vs-edit conflict',
      setup(context) {
        const state = mappedTaskState(context);
        state.taskDeletionConflicts['g-task'] = {
          at: '2026-08-01T00:00:00Z', reason: 'DELETE_VS_EDIT',
          msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list'
        };
        return state;
      },
      advance(state) { state.taskDeletionConflicts['g-task'].at = '2026-08-02T00:00:00Z'; }
    },
    {
      label: 'list pending candidate',
      setup(context) {
        const state = listDeletionState(context);
        const pair = listDeletionPair(context);
        state.pendingListDeletions[pair.key] = listDeletionCandidateRecord(pair);
        return state;
      },
      advance(state) {
        state.pendingListDeletions[Object.keys(state.pendingListDeletions)[0]].lastConfirmedAt = '2026-08-02T00:00:00Z';
      },
      listReservation: true
    },
    {
      label: 'list delete conflict',
      setup(context) {
        const state = listDeletionState(context);
        state.listDeletionConflicts[context.listPairKey_('g-list', 'ms-list')] = {
          at: '2026-08-01T00:00:00Z', reason: 'LIST_DELETE_SOURCE_REAPPEARED',
          gListId: 'g-list', msListId: 'ms-list', gTitle: 'Custom', msTitle: 'Custom'
        };
        return state;
      },
      advance(state) {
        state.listDeletionConflicts[Object.keys(state.listDeletionConflicts)[0]].at = '2026-08-02T00:00:00Z';
      },
      listReservation: true
    },
    {
      label: 'historic repair guard',
      setup(context) {
        const state = listDeletionState(context);
        state.listDeletionConflicts[context.listPairKey_('g-list', 'ms-list')] = {
          at: '2026-08-01T00:00:00Z', reason: 'LIST_REPAIR_HISTORIC_PAIR_GUARD',
          gListId: 'g-list', msListId: 'ms-list', gTitle: 'Custom', msTitle: 'Custom'
        };
        return state;
      },
      advance(state) {
        state.listDeletionConflicts[Object.keys(state.listDeletionConflicts)[0]].at = '2026-08-02T00:00:00Z';
      },
      listReservation: true
    }
  ];

  function setPreviousState(userStore, state) {
    userStore.setProperty('sync_state_main_manifest', JSON.stringify({
      generation: 'current', count: 1, previousGeneration: 'previous'
    }));
    userStore.setProperty('sync_state_main_successful_round_manifest', JSON.stringify({
      version: 1, current: { generation: 'previous', roundId: 'legacy-test-success' }, previous: null
    }));
    userStore.setProperty('sync_state_main_gen_previous_count', '1');
    userStore.setProperty('sync_state_main_gen_previous_0', encodeURIComponent(JSON.stringify(state)));
  }

  for (const item of cases) {
    for (const operation of ['import', 'restore']) {
      const { context, userStore } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
      const current = item.setup(context);
      let saves = 0;
      context.withGlobalLock_ = (fn) => fn();
      context.loadStateForSync_ = () => current;
      context.saveState_ = () => { saves += 1; };
      if (operation === 'import') {
        assert.throws(() => context.importSyncState(context.newState_()),
          /STATE_(?:DELETION_EVIDENCE|HISTORIC_GUARD)_PRESERVATION_REQUIRED/, item.label + ' import');
      } else {
        setPreviousState(userStore, context.newState_());
        assert.throws(() => context.restorePreviousSyncState(),
          /STATE_(?:DELETION_EVIDENCE|HISTORIC_GUARD)_PRESERVATION_REQUIRED/, item.label + ' restore');
      }
      assert.equal(saves, 0, item.label + ' ' + operation + ': no replacement save');
      assert.ok(JSON.stringify(current).includes(item.label === 'historic repair guard'
        ? 'LIST_REPAIR_HISTORIC_PAIR_GUARD'
        : item.label === 'list delete conflict' ? 'LIST_DELETE_SOURCE_REAPPEARED'
          : item.label === 'task delete-vs-edit conflict' ? 'DELETE_VS_EDIT'
            : item.label === 'task pending candidate' ? 'g-task' : 'g-list'),
      item.label + ' ' + operation + ': current evidence remains in memory');

      const compatible = JSON.parse(JSON.stringify(current));
      item.advance(compatible);
      if (operation === 'import') {
        assert.doesNotThrow(() => context.importSyncState(compatible), item.label + ' newer import');
      } else {
        setPreviousState(userStore, compatible);
        assert.doesNotThrow(() => context.restorePreviousSyncState(), item.label + ' newer restore');
      }
      assert.equal(saves, 1, item.label + ' ' + operation + ': compatible replacement saves once');

      if (item.listReservation) {
        const reservationOnly = JSON.parse(JSON.stringify(current));
        reservationOnly.listMap = {};
        const lifecycle = context.classifyListLifecycle_(reservationOnly,
          [{ id: 'g-list', title: 'Custom' }], [], { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_());
        assert.equal(lifecycle.reservedGoogleIds['g-list'], true, item.label + ': Google ID remains reserved');
        assert.equal(lifecycle.reservedMicrosoftIds['ms-list'], true, item.label + ': Microsoft ID remains reserved');
        const plan = context.planAutoListMappings_(reservationOnly,
          [{ id: 'g-list', title: 'Custom' }], [], { id: 'g-default', title: 'Tasks' },
          context.getSafetyConfig_(), lifecycle);
        assert.deepEqual(JSON.parse(JSON.stringify(plan.createMicrosoft)), [], item.label + ': planner cannot recreate');
      }
    }
  }
});

test('schema 3 rejects unknown lifecycle keys before normalization or import writes', () => {
  const { context } = loadContext();
  const badTop = context.newState_();
  badTop.listDeletionJournals = { typo: 'prepared' };
  assert.throws(() => context.normalizeState_(badTop), /STATE_MALFORMED.*unknown field/);
  assert.ok(badTop.listDeletionJournals);
  const fieldCases = [
    ['pendingTaskDeletions', 'g-task', { gId: 'g-task', unexpected: true }],
    ['deletionJournal', 'g-task', { gId: 'g-task', unexpected: true }],
    ['listPairMeta', context.listPairKey_('g-list', 'ms-list'), { gListId: 'g-list', msListId: 'ms-list', unexpected: true }],
    ['pendingListDeletions', context.listPairKey_('g-list', 'ms-list'), { gListId: 'g-list', msListId: 'ms-list', unexpected: true }]
  ];
  for (const [field, key, record] of fieldCases) {
    const state = context.newState_();
    state[field][key] = record;
    assert.throws(() => context.normalizeState_(state), /STATE_MALFORMED.*unknown field/, field);
  }
  const tombstone = context.newState_();
  tombstone.tombstones.g['g-task'] = { at: Date.now(), source: 'test', unexpected: true };
  assert.throws(() => context.normalizeState_(tombstone), /STATE_MALFORMED.*unknown field/);
  const imported = loadContext();
  let saves = 0;
  imported.context.withGlobalLock_ = (fn) => fn();
  imported.context.loadStateForSync_ = () => imported.context.newState_();
  imported.context.saveState_ = () => { saves += 1; };
  assert.throws(() => imported.context.importSyncState(badTop), /IMPORT_INVALID_STATE.*unknown field/);
  assert.equal(saves, 0);
});

test('list survivor evidence fingerprints exact IDs and timestamps deterministically', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  state.g2m = {
    'g-task': { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list', gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z' },
    'g-other': { msId: 'ms-other', gListId: 'g-list', msListId: 'ms-list', gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z' }
  };
  state.m2g = { 'ms-task': 'g-task', 'ms-other': 'g-other' };
  const tasksForward = {
    'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-01T00:00:00Z' },
    'ms-other': { id: 'ms-other', lastModifiedDateTime: '2026-08-01T00:00:00Z' }
  };
  const tasksReverse = {
    'ms-other': tasksForward['ms-other'], 'ms-task': tasksForward['ms-task']
  };
  const forward = listDeletionSnapshot(pair, { msTasksById: tasksForward, msListByTask: { 'ms-task': 'ms-list', 'ms-other': 'ms-list' } });
  const reverse = listDeletionSnapshot(pair, { msTasksById: tasksReverse, msListByTask: { 'ms-other': 'ms-list', 'ms-task': 'ms-list' } });
  const first = context.listDeletionCandidateInput_(state, forward, pair);
  assert.equal(first.ok, true);
  assert.equal(context.hasExactUniqueListMapPair_(state, pair.gListId, pair.msListId), true);
  assert.equal(first.taskFingerprint, context.listDeletionCandidateInput_(state, reverse, pair).taskFingerprint);
  const missingSurvivor = listDeletionSnapshot(pair, {
    msTasksById: { 'ms-task': tasksForward['ms-task'] }, msListByTask: { 'ms-task': 'ms-list' }
  });
  assert.equal(context.hasExactUniqueListMapPair_(state, pair.gListId, pair.msListId), true);
  assert.equal(context.listDeletionCandidateInput_(state, missingSurvivor, pair).reason, 'LIST_DELETE_SURVIVOR_TASK_SET_MISMATCH');
  assert.equal(context.hasExactUniqueListMapPair_(state, pair.gListId, pair.msListId), true);
  assert.equal(context.listDeletionCandidateInput_(state, listDeletionSnapshot(pair, {
    msTasksById: { ...tasksForward, loose: { id: 'loose', lastModifiedDateTime: '2026-08-01T00:00:00Z' } },
    msListByTask: { 'ms-task': 'ms-list', 'ms-other': 'ms-list', loose: 'ms-list' }
  }), pair).reason, 'LIST_DELETE_UNMAPPED_TASK');
  context.observeListDeletionCandidate_(state, forward, pair, 'round-1', { invalidatedListCandidateKeys: {} });
  const older = listDeletionSnapshot(pair, {
    msTasksById: { ...tasksForward, 'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-07-31T00:00:00Z' } },
    msListByTask: { 'ms-task': 'ms-list', 'ms-other': 'ms-list' }
  });
  context.observeListDeletionCandidate_(state, older, pair, 'round-2', { invalidatedListCandidateKeys: {} });
  assert.equal(state.pendingListDeletions[pair.key], undefined);
  assert.equal(state.listDeletionConflicts[pair.key].reason, 'LIST_DELETE_SOURCE_OR_FINGERPRINT_CHANGED');
});

test('prepared one-side list journal finalizes locally after the survivor is freshly both-missing', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  state.g2m['g-task'] = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z' };
  state.m2g['ms-task'] = 'g-task';
  const initial = listDeletionSnapshot(pair, {
    msTasksById: { 'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-01T00:00:00Z' } },
    msListByTask: { 'ms-task': 'ms-list' }
  });
  const candidate = context.listDeletionCandidateInput_(state, initial, pair);
  Object.assign(candidate, { confirmations: 2, lastRoundId: 'round-2' });
  state.listDeletionJournal[pair.key] = context.preparedListDeletionJournal_(candidate);
  let durable;
  context.saveState_ = (value) => { durable = JSON.parse(JSON.stringify(value)); };
  context.saveListDeletionJournalDurably_(state, { pendingListBeforeRound: {}, invalidatedListCandidateKeys: {} }, {});
  let firstDelete = 0;
  context.deleteMsList_ = () => { firstDelete += 1; }; // remote success before final/catch save loss
  context.remoteDeleteForMissingListSide_(candidate);
  assert.equal(firstDelete, 1);
  const reloaded = durable;
  const bothMissing = { ...candidate, missingSide: 'both', survivorFingerprint: null, taskFingerprint: 'fresh-both-missing' };
  let repeatedDelete = 0;
  context.buildListDeletionRevalidation_ = () => ({ ok: true, input: bothMissing });
  context.deleteMsList_ = () => { repeatedDelete += 1; };
  context.deleteGList_ = () => { repeatedDelete += 1; };
  context.recoverPreparedListDeletions_(reloaded, { allowListDeletions: true, listDiscoveryMode: 'auto' }, {});
  assert.equal(repeatedDelete, 0);
  assert.equal(reloaded.listMap['g-list'], undefined);
  assert.equal(reloaded.listDeletionJournal[pair.key], undefined);
  assert.ok(reloaded.tombstones.g['g-task']);
  assert.ok(reloaded.tombstones.m['ms-task']);
  assert.ok(reloaded.listTombstones.g['g-list']);
  assert.ok(reloaded.listTombstones.ms['ms-list']);
});

test('a third-read survivor set mismatch quarantines a ready list deletion before DELETE', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  state.g2m['g-task'] = { msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-01T00:00:00Z', msUpdated: '2026-08-01T00:00:00Z' };
  state.m2g['ms-task'] = 'g-task';
  const snap = listDeletionSnapshot(pair, {
    msTasksById: { 'ms-task': { id: 'ms-task', lastModifiedDateTime: '2026-08-01T00:00:00Z' } },
    msListByTask: { 'ms-task': 'ms-list' },
    listLifecycle: { inventoryComplete: true, pairs: [pair], byKey: { [pair.key]: pair } }
  });
  const ready = context.listDeletionCandidateInput_(state, snap, pair);
  Object.assign(ready, { confirmations: 2, lastRoundId: 'round-2' });
  state.pendingListDeletions[pair.key] = ready;
  let deletes = 0;
  context.deleteMsList_ = () => { deletes += 1; };
  context.buildListDeletionRevalidation_ = () => ({ ok: false, reason: 'LIST_DELETE_SURVIVOR_TASK_SET_MISMATCH' });
  context.applyConfirmedListDeletions_(state, snap, 'round-2', {
    pendingListBeforeRound: {}, invalidatedListCandidateKeys: {}
  });
  assert.equal(deletes, 0);
  assert.equal(state.pendingListDeletions[pair.key], undefined);
  assert.equal(state.listDeletionConflicts[pair.key].reason, 'LIST_DELETE_SURVIVOR_TASK_SET_MISMATCH');
});

test('an unrelated list task fault neither advances nor quarantines another pair candidate', () => {
  const { context } = loadContext();
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  const candidate = context.listDeletionCandidateInput_(state, listDeletionSnapshot(pair), pair);
  Object.assign(candidate, { confirmations: 1, lastRoundId: 'round-1' });
  state.pendingListDeletions[pair.key] = candidate;
  state.listMap['g-other'] = 'ms-other';
  state.listFaults.g['g-other'] = { reason: 'HTTP_404_WHILE_FETCHING_TASKS', msListId: 'ms-other' };
  const interrupted = listDeletionSnapshot(pair, {
    inventoryComplete: false,
    listLifecycle: { inventoryComplete: true, pairs: [pair], byKey: { [pair.key]: pair } }
  });
  context.applyConfirmedListDeletions_(state, interrupted, 'round-2', { pendingListBeforeRound: {}, invalidatedListCandidateKeys: {} });
  assert.equal(state.pendingListDeletions[pair.key].confirmations, 1);
  assert.equal(state.listDeletionConflicts[pair.key], undefined);
  assert.equal(context.listDeletionCandidateInput_(state, interrupted, pair).ok, true);
  context.observeListDeletionCandidate_(state, listDeletionSnapshot(pair), pair, 'round-3', { invalidatedListCandidateKeys: {} });
  assert.equal(state.pendingListDeletions[pair.key].confirmations, 2);
});

test('auto-list create applies fresh lifecycle reservation guards before either remote create', () => {
  const scenarios = [
    {
      side: 'microsoft',
      source: { id: 'g-new', title: 'Custom' },
      setup(state, context) {
        const pair = { key: context.listPairKey_('g-new', 'ms-old'), gListId: 'g-new', msListId: 'ms-old',
          gTitle: 'Custom', msTitle: 'Custom', gFingerprint: null, msFingerprint: null, taskPairs: [],
          taskFingerprint: '[]', missingSide: 'google', deletable: true, confirmations: 1, lastRoundId: 'old' };
        state.pendingListDeletions[pair.key] = pair;
      }
    },
    {
      side: 'google',
      source: { id: 'ms-new', displayName: 'Custom', isOwner: true, isShared: false, wellknownListName: 'none' },
      setup(state, context) {
        state.listTombstones.ms['ms-new'] = { at: Date.now(), source: 'guard', gListId: 'g-old', msListId: 'ms-new', gName: 'custom', msName: 'custom' };
      }
    }
  ];
  for (const scenario of scenarios) {
    const { context } = loadContext({ scriptValues: { SYNC_LIST_DISCOVERY_MODE: 'auto' } });
    const state = context.newState_();
    scenario.setup(state, context);
    const gLists = scenario.side === 'microsoft' ? [scenario.source] : [];
    const msLists = scenario.side === 'google' ? [scenario.source] : [];
    context.planAutoListMappings_ = () => ({ pairs: [], faults: [],
      createMicrosoft: scenario.side === 'microsoft' ? [scenario.source] : [],
      createGoogle: scenario.side === 'google' ? [scenario.source] : [] });
    let creates = 0;
    context.createMsList_ = () => { creates += 1; return { id: 'should-not-exist' }; };
    context.createGList_ = () => { creates += 1; return { id: 'should-not-exist' }; };
    assert.throws(() => context.ensureAutoListMappings_(state, gLists, msLists,
      { id: 'g-default', title: 'Tasks' }, context.getSafetyConfig_(), { reservedGoogleIds: {}, reservedMicrosoftIds: {}, reservedNameKeys: {} }),
    /AUTO_CREATE_STALE_PLAN_BLOCKED/);
    assert.equal(creates, 0, scenario.side);
    assert.equal(Object.keys(state.listMap).length, 0, scenario.side);
  }
});

function generatedListTombstoneState(context, at = Date.now()) {
  const state = context.newState_();
  context.markListPairDeleted_(state, {
    gListId: 'g-tombstone',
    msListId: 'ms-tombstone',
    gTitle: 'Custom Google',
    msTitle: 'Custom Microsoft',
    missingSide: 'both',
    deletable: true
  }, 'both');
  ['g', 'ms'].forEach((side) => {
    Object.keys(state.listTombstones[side]).forEach((key) => {
      state.listTombstones[side][key].at = at;
    });
  });
  return state;
}

test('generated list tombstones round-trip symmetrically and expire every pair key at the exact 30-day boundary', () => {
  const { context } = loadContext();
  const now = Date.now();
  const state = generatedListTombstoneState(context, now);
  const roundTrip = context.normalizeState_(JSON.parse(JSON.stringify(state)));

  assert.doesNotThrow(() => context.validateImportedState_(roundTrip));
  assert.doesNotThrow(() => context.assertTombstoneEvidencePreserved_(roundTrip,
    JSON.parse(JSON.stringify(roundTrip)), now));
  assert.equal(context.listTombstoneIntegrityIssues_(roundTrip).length, 0);
  assert.ok(roundTrip.listTombstones.g['g-tombstone']);
  assert.ok(roundTrip.listTombstones.ms['ms-tombstone']);
  assert.ok(roundTrip.listTombstoneNames.g['name:custom google']);
  assert.ok(roundTrip.listTombstoneNames.ms['name:custom microsoft']);

  context.cleanupListTombstones_(roundTrip, now + 29 * 24 * 60 * 60 * 1000);
  assert.ok(roundTrip.listTombstones.g['g-tombstone']);
  assert.ok(roundTrip.listTombstones.ms['ms-tombstone']);

  context.cleanupListTombstones_(roundTrip, now + 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(roundTrip.listTombstones)), { g: {}, ms: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(roundTrip.listTombstoneNames)), { g: {}, ms: {} });
});

test('list tombstone aliases are complete on both sides, dedupe equal names, and reject unknown side tables', () => {
  const { context } = loadContext();
  const base = generatedListTombstoneState(context);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const alpha = 'name:custom google';
  const beta = 'name:custom microsoft';

  const missingOne = clone(base);
  delete missingOne.listTombstoneNames.g[alpha];
  assert.ok(context.listTombstoneIntegrityIssues_(missingOne)
    .includes('GOOGLE_NAME_ALIAS_MISSING_OR_MISMATCHED'));
  assert.throws(() => context.normalizeState_(missingOne), /STATE_MALFORMED/);

  const missingAll = clone(base);
  ['g', 'ms'].forEach((side) => {
    delete missingAll.listTombstoneNames[side][alpha];
    delete missingAll.listTombstoneNames[side][beta];
  });
  const missingAllIssues = context.listTombstoneIntegrityIssues_(missingAll);
  assert.ok(missingAllIssues.includes('GOOGLE_NAME_ALIAS_MISSING_OR_MISMATCHED'));
  assert.ok(missingAllIssues.includes('MICROSOFT_NAME_ALIAS_MISSING_OR_MISMATCHED'));
  assert.throws(() => context.normalizeState_(missingAll), /STATE_MALFORMED/);

  const sameName = context.newState_();
  context.markListPairDeleted_(sameName, {
    gListId: 'g-same', msListId: 'ms-same', gTitle: 'Same Name', msTitle: 'Same Name',
    missingSide: 'both', deletable: true
  }, 'both');
  assert.deepEqual(Object.keys(sameName.listTombstones.g).sort(), ['g-same']);
  assert.deepEqual(Object.keys(sameName.listTombstones.ms).sort(), ['ms-same']);
  assert.deepEqual(Object.keys(sameName.listTombstoneNames.g).sort(), ['name:same name']);
  assert.deepEqual(Object.keys(sameName.listTombstoneNames.ms).sort(), ['name:same name']);
  assert.doesNotThrow(() => context.normalizeState_(sameName));

  const unexpectedSide = clone(base);
  unexpectedSide.listTombstones.unexpected = { ignoredPreviously: true };
  assert.deepEqual(Array.from(context.listTombstoneIntegrityIssues_(unexpectedSide)), ['ID_CONTAINER_UNKNOWN_CONTAINER_KEY']);
  assert.throws(() => context.normalizeState_(unexpectedSide), /STATE_MALFORMED/);
  assert.throws(() => context.validateImportedState_(unexpectedSide), /IMPORT_INVALID_STATE/);
});

test('code-generated shared-name aliases are immediately valid, deterministically selected, and repointed through staggered expiry', () => {
  const { context } = loadContext();
  const now = 2_000_000_000_000;
  new vm.Script('Date.now = function() { return 2000000000000; };').runInContext(context);
  const state = context.newState_();
  const olderTieWinner = {
    gListId: 'g-z', msListId: 'ms-z', gTitle: 'Shared Name', msTitle: 'Shared Name',
    missingSide: 'both', deletable: true
  };
  const newerAfterExpiry = {
    gListId: 'g-a', msListId: 'ms-a', gTitle: 'Shared Name', msTitle: 'Shared Name',
    missingSide: 'both', deletable: true
  };
  context.markListPairDeleted_(state, olderTieWinner, 'both');
  context.markListPairDeleted_(state, newerAfterExpiry, 'both');

  // Both are deliberately generated in the same millisecond. The stable
  // [gListId, msListId] tie-break chooses g-z/ms-z, even though g-a was added
  // last; the generated state must be valid without an import/cleanup repair.
  assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);
  assert.equal(state.listTombstoneNames.g['name:shared name'].gListId, 'g-z');
  assert.equal(state.listTombstoneNames.ms['name:shared name'].msListId, 'ms-z');

  function setPairAt(pair, at) {
    ['g', 'ms'].forEach((side) => Object.keys(state.listTombstones[side]).forEach((key) => {
      const record = state.listTombstones[side][key];
      if (record.gListId === pair.gListId && record.msListId === pair.msListId) record.at = at;
    }));
  }
  // g-z/ms-z now reaches its exact 30-day boundary while g-a/ms-a is 29 days
  // old. Rebuilding represents the normal post-expiry alias selection.
  setPairAt(olderTieWinner, now - 30 * 24 * 60 * 60 * 1000);
  setPairAt(newerAfterExpiry, now - 29 * 24 * 60 * 60 * 1000);
  context.rebuildListTombstoneNameAliases_(state);
  assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);

  const staleAlias = JSON.parse(JSON.stringify(state));
  staleAlias.listTombstoneNames.g['name:shared name'] = staleAlias.listTombstones.g['g-z'];
  staleAlias.listTombstoneNames.ms['name:shared name'] = staleAlias.listTombstones.ms['ms-z'];
  const staleIssues = Array.from(context.listTombstoneIntegrityIssues_(staleAlias));
  assert.ok(staleIssues.includes('GOOGLE_NAME_ALIAS_MISSING_OR_MISMATCHED'));
  assert.ok(staleIssues.includes('MICROSOFT_NAME_ALIAS_MISSING_OR_MISMATCHED'));
  assert.throws(() => context.normalizeState_(staleAlias), /STATE_MALFORMED/);

  context.cleanupListTombstones_(state, now);
  assert.equal(state.listTombstones.g['g-z'], undefined);
  assert.equal(state.listTombstones.ms['ms-z'], undefined);
  assert.equal(state.listTombstoneNames.g['name:shared name'].gListId, 'g-a');
  assert.equal(state.listTombstoneNames.ms['name:shared name'].msListId, 'ms-a');
  assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);

  context.cleanupListTombstones_(state, now + 24 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(state.listTombstones)), { g: {}, ms: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(state.listTombstoneNames)), { g: {}, ms: {} });
});

test('opaque list IDs containing the pair separator expire by exact pair, not a colliding composite key', () => {
  const { context } = loadContext();
  const now = 2_000_000_000_000;
  const state = context.newState_();
  const expired = { gListId: 'a|b', msListId: 'c', gTitle: 'Alpha', msTitle: 'Beta' };
  const retained = { gListId: 'a', msListId: 'b|c', gTitle: 'Gamma', msTitle: 'Delta' };
  [expired, retained].forEach((pair) => context.markListPairDeleted_(state, {
    ...pair, missingSide: 'both', deletable: true
  }, 'both'));
  function setPairAt(pair, at) {
    ['g', 'ms'].forEach((side) => Object.keys(state.listTombstones[side]).forEach((key) => {
      const record = state.listTombstones[side][key];
      if (record.gListId === pair.gListId && record.msListId === pair.msListId) record.at = at;
    }));
  }
  // The historical delimiter key made (a|b, c) collide with (a, b|c). The old
  // record reaches the boundary first, so that collision-prone de-duplication
  // would wrongly remove the still-29-day-old pair too.
  setPairAt(expired, now - 30 * 24 * 60 * 60 * 1000);
  setPairAt(retained, now - 29 * 24 * 60 * 60 * 1000);
  context.rebuildListTombstoneNameAliases_(state);
  assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);

  context.cleanupListTombstones_(state, now);
  assert.equal(state.listTombstones.g['a|b'], undefined);
  assert.equal(state.listTombstones.ms.c, undefined);
  assert.ok(state.listTombstones.g.a);
  assert.ok(state.listTombstones.ms['b|c']);
  assert.equal(context.listTombstoneIntegrityIssues_(state).length, 0);

  context.cleanupListTombstones_(state, now + 24 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(state.listTombstones)), { g: {}, ms: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(state.listTombstoneNames)), { g: {}, ms: {} });
});

test('separate name guards keep name-like provider IDs and colliding lifecycle tuple journals independent', () => {
  const { context } = loadContext();
  const now = 2_000_000_000_000;
  new vm.Script('Date.now = function() { return 2000000000000; };').runInContext(context);

  const names = context.newState_();
  context.markListPairDeleted_(names, {
    gListId: 'name:shared', msListId: 'ms-opaque',
    gTitle: 'Opaque ID', msTitle: 'Opaque ID', missingSide: 'both', deletable: true
  }, 'both');
  context.markListPairDeleted_(names, {
    gListId: 'g-shared', msListId: 'ms-shared',
    gTitle: 'Shared', msTitle: 'Shared', missingSide: 'both', deletable: true
  }, 'both');
  assert.equal(context.listTombstoneIntegrityIssues_(names).length, 0);
  assert.equal(names.listTombstones.g['name:shared'].gListId, 'name:shared');
  assert.equal(names.listTombstoneNames.g['name:shared'].gListId, 'g-shared');
  assert.equal(names.listTombstoneNames.ms['name:shared'].msListId, 'ms-shared');
  assert.equal(context.hasListTombstone_(names, 'g', 'name:shared', 'Shared'), true);

  const lifecycle = context.newState_();
  const pairA = { gListId: 'a|b', msListId: 'c', gTitle: 'One', msTitle: 'One' };
  const pairB = { gListId: 'a', msListId: 'b|c', gTitle: 'Two', msTitle: 'Two' };
  const recordFor = (pair) => ({
    key: context.listPairKey_(pair.gListId, pair.msListId),
    gListId: pair.gListId, msListId: pair.msListId, gTitle: pair.gTitle, msTitle: pair.msTitle,
    missingSide: 'google', gFingerprint: null, msFingerprint: null, survivorFingerprint: null,
    taskPairs: [], taskFingerprint: '[]', deletable: true, confirmations: 1,
    lastRoundId: 'round-1', firstConfirmedAt: '2026-08-01T00:00:00Z', lastConfirmedAt: '2026-08-01T00:00:00Z'
  });
  const candidateA = recordFor(pairA);
  const candidateB = recordFor(pairB);
  assert.notEqual(candidateA.key, candidateB.key);
  lifecycle.listMap = { [pairA.gListId]: pairA.msListId, [pairB.gListId]: pairB.msListId };
  lifecycle.pendingListDeletions[candidateA.key] = candidateA;
  lifecycle.pendingListDeletions[candidateB.key] = candidateB;
  lifecycle.listDeletionJournal[candidateA.key] = context.preparedListDeletionJournal_(candidateA);
  lifecycle.listDeletionJournal[candidateB.key] = context.preparedListDeletionJournal_(candidateB);
  lifecycle.listDeletionJournal[candidateA.key].phase = 'paused';
  lifecycle.listDeletionJournal[candidateB.key].phase = 'paused';
  context.buildListDeletionRevalidation_ = (_state, journal) => ({
    ok: true,
    input: { gListId: journal.gListId, msListId: journal.msListId, missingSide: 'both' }
  });
  context.recoverPreparedListDeletions_(lifecycle, {
    allowListDeletions: true, listDiscoveryMode: 'auto'
  }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycle.listMap)), {});
  assert.equal(lifecycle.listDeletionJournal[candidateA.key], undefined);
  assert.equal(lifecycle.listDeletionJournal[candidateB.key], undefined);
  assert.ok(lifecycle.listTombstones.g[pairA.gListId]);
  assert.ok(lifecycle.listTombstones.g[pairB.gListId]);
  assert.equal(context.listTombstoneIntegrityIssues_(lifecycle).length, 0);

  function setPairAt(pair, at) {
    ['g', 'ms'].forEach((side) => Object.keys(lifecycle.listTombstones[side]).forEach((key) => {
      const record = lifecycle.listTombstones[side][key];
      if (record.gListId === pair.gListId && record.msListId === pair.msListId) record.at = at;
    }));
  }
  setPairAt(pairA, now - 30 * 24 * 60 * 60 * 1000);
  setPairAt(pairB, now - 29 * 24 * 60 * 60 * 1000);
  context.rebuildListTombstoneNameAliases_(lifecycle);
  context.cleanupListTombstones_(lifecycle, now);
  assert.equal(lifecycle.listTombstones.g[pairA.gListId], undefined);
  assert.ok(lifecycle.listTombstones.g[pairB.gListId]);
  context.cleanupListTombstones_(lifecycle, now + 24 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycle.listTombstones)), { g: {}, ms: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycle.listTombstoneNames)), { g: {}, ms: {} });
});

test('load and import reject asymmetric, crossed, malformed, and alias-mismatched list tombstone evidence before mutation', () => {
  const { context } = loadContext();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    {
      label: 'Google-only orphan',
      mutate(state) { state.listTombstones.ms = {}; }
    },
    {
      label: 'Microsoft-only orphan',
      mutate(state) { state.listTombstones.g = {}; }
    },
    {
      label: 'crossed canonical Google ID',
      mutate(state) {
        state.listTombstones.ms['ms-tombstone'] = {
          ...state.listTombstones.ms['ms-tombstone'], gListId: 'g-crossed'
        };
      }
    },
    {
      label: 'duplicate Microsoft target',
      mutate(state) {
        state.listTombstones.g['g-second'] = {
          ...state.listTombstones.g['g-tombstone'], gListId: 'g-second'
        };
      }
    },
    {
      label: 'mismatched timestamp source and name evidence',
      mutate(state) {
        state.listTombstones.ms['ms-tombstone'] = {
          ...state.listTombstones.ms['ms-tombstone'],
          at: state.listTombstones.ms['ms-tombstone'].at + 1,
          source: 'different-source',
          gName: 'different name'
        };
      }
    },
    {
      label: 'non-numeric timestamp',
      mutate(state) { state.listTombstones.g['g-tombstone'].at = 'not-an-epoch'; }
    },
    {
      label: 'unknown record field',
      mutate(state) { state.listTombstones.g['g-tombstone'].unexpected = true; }
    },
    {
      label: 'unknown list tombstone side table',
      mutate(state) { state.listTombstones.unexpected = {}; }
    },
    {
      label: 'name alias that does not identify its canonical pair',
      mutate(state) {
        const record = { ...state.listTombstones.g['g-tombstone'] };
        state.listTombstoneNames.g['name:unrelated'] = record;
        state.listTombstoneNames.ms['name:unrelated'] = { ...record };
      }
    }
  ];

  for (const item of cases) {
    const malformed = generatedListTombstoneState(context);
    item.mutate(malformed);
    const before = clone(malformed);
    assert.throws(() => context.normalizeState_(malformed), /STATE_MALFORMED/, item.label + ' load');
    assert.deepEqual(clone(malformed), before, item.label + ' was not silently normalized away');
    assert.throws(() => context.validateImportedState_(clone(before)), /IMPORT_INVALID_STATE/, item.label + ' import preflight');
  }
});

test('malformed list tombstones reject import and restore without save, while health reports both asymmetric directions without IDs', () => {
  const malformedImport = loadContext();
  const incoming = generatedListTombstoneState(malformedImport.context);
  malformedImport.context.withGlobalLock_ = (fn) => fn();
  malformedImport.context.loadStateForSync_ = () => malformedImport.context.newState_();
  let importSaves = 0;
  malformedImport.context.saveState_ = () => { importSaves += 1; };
  incoming.listTombstones.ms = {};
  assert.throws(() => malformedImport.context.importSyncState(incoming), /IMPORT_INVALID_STATE/);
  assert.equal(importSaves, 0);

  const malformedPrevious = generatedListTombstoneState(malformedImport.context);
  malformedPrevious.listTombstones.unexpected = {};
  const restore = loadContext({ userValues: {
    sync_state_main_manifest: JSON.stringify({ generation: 'current', count: 1, previousGeneration: 'previous' }),
    sync_state_main_successful_round_manifest: JSON.stringify({ version: 1, current: { generation: 'previous', roundId: 'legacy-test-success' }, previous: null }),
    sync_state_main_gen_previous_count: '1',
    sync_state_main_gen_previous_0: encodeURIComponent(JSON.stringify(malformedPrevious))
  } });
  restore.context.withGlobalLock_ = (fn) => fn();
  restore.context.loadStateForSync_ = () => restore.context.newState_();
  let restoreSaves = 0;
  restore.context.saveState_ = () => { restoreSaves += 1; };
  assert.throws(() => restore.context.restorePreviousSyncState(), /STATE_MALFORMED/);
  assert.equal(restoreSaves, 0);

  const reports = [];
  const { context } = loadContext();
  context.getConfig_ = () => ({});
  context.microsoftService_ = () => ({ hasAccess: () => true });
  context.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }] };
  context.getSafetyConfig_ = () => ({
    listDiscoveryMode: 'auto', googleListIds: ['g-default'], allowDeletions: false,
    allowTaskMoves: false, requestedListDeletions: false, allowListDeletions: false
  });
  context.requireConfiguredListPairsApplied_ = () => ({ configured: false, pairs: [] });
  context.console = { log: (message) => reports.push(JSON.parse(message)) };

  const directionCases = [
    { expected: 'GOOGLE_TO_MICROSOFT_ASYMMETRY', remove: 'ms' },
    { expected: 'MICROSOFT_TO_GOOGLE_ASYMMETRY', remove: 'g' },
    { expected: 'ID_CONTAINER_UNKNOWN_CONTAINER_KEY', unknownSide: true }
  ];
  for (const item of directionCases) {
    const malformed = generatedListTombstoneState(context);
    if (item.remove) malformed.listTombstones[item.remove] = {};
    if (item.unknownSide) malformed.listTombstones.unexpected = {};
    // Exercise the real inspection catch path: mutation paths reject this
    // raw state, while health keeps only bounded integrity reason codes.
    context.loadBlobAtomic_ = () => malformed;
    context.healthCheck();
    const report = reports.at(-1);
    assert.equal(report.ok, false);
    assert.ok(report.listTombstoneIntegrityIssues.includes(item.expected), item.expected);
    assert.ok(report.issues.some((issue) => issue.includes('tombstone integrity error')));
    assert.equal(JSON.stringify(report).includes('g-tombstone'), false, 'health must not disclose IDs');
    assert.equal(JSON.stringify(report).includes('custom google'), false, 'health must not disclose names');
  }
});

const RC6_CORRELATION = '11111111-1111-4111-8111-111111111111';
const RC6_EXTENSION_NAME = 'com.tasksTodoSync.move';
const RC6_EXTENSION_ID = 'microsoft.graph.openTypeExtension.' + RC6_EXTENSION_NAME;
const RC6_LEGACY_EXTENSION_ID =
  'Microsoft.OutlookServices.OpenTypeExtension.' + RC6_EXTENSION_NAME;

function rc6MoveFixture(context, { legacy = false, phase = 'creating', newMsId = null } = {}) {
  const state = context.newState_();
  state.listMap = { 'g-old': 'ms-old', 'g-new': 'ms-new' };
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-old', msListId: 'ms-old',
    gUpdated: '2026-08-14T00:01:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  state.m2g['ms-task'] = 'g-task';
  const gTask = {
    id: 'g-task', title: 'Private moved title', notes: 'Private body',
    status: 'needsAction', updated: '2026-08-14T00:01:00Z'
  };
  const oldMsTask = {
    id: 'ms-task', title: 'Private moved title',
    body: { content: 'Private body', contentType: 'text' }, status: 'notStarted',
    lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  const journal = {
    phase, gId: 'g-task', oldMsId: 'ms-task', newMsId,
    gListId: 'g-new', oldMsListId: 'ms-old', targetMsListId: 'ms-new',
    gUpdated: gTask.updated, oldMsUpdated: oldMsTask.lastModifiedDateTime,
    preparedAt: '2026-08-14T00:01:30Z',
    fingerprint: context.moveFingerprintFromGoogle_(gTask),
    uncertainConfirmations: 0, lastRoundId: 'prior-round',
    lastBlockedReason: 'MOVE_DESTINATION_CREATE_FAILED',
    lastBlockedAt: '2026-08-14T00:03:00Z'
  };
  if (!legacy) journal.correlationId = RC6_CORRELATION;
  state.taskMoveJournal['g-task'] = journal;
  return { state, journal, gTask, oldMsTask };
}

function rc6MoveSnapshot(fixture, targetTasks = [], extensionComplete = true) {
  const msTasksById = { 'ms-task': fixture.oldMsTask };
  const msListByTask = { 'ms-task': 'ms-old' };
  for (const task of targetTasks) {
    msTasksById[task.id] = task;
    msListByTask[task.id] = 'ms-new';
  }
  return {
    inventoryComplete: true,
    activeGListIds: { 'g-old': true, 'g-new': true },
    gTaskInventoryListIds: { 'g-old': true, 'g-new': true },
    msTaskInventoryListIds: { 'ms-old': true, 'ms-new': true },
    moveExtensionInventoryListIds: extensionComplete ? { 'ms-new': true } : {},
    safety: { allowDeletions: false, allowTaskMoves: true },
    gTasksById: { 'g-task': fixture.gTask },
    msTasksById,
    gListByTask: { 'g-task': 'g-new' },
    msListByTask
  };
}

function rc6Destination(context, fixture, {
  id = 'ms-task-new', correlationId = RC6_CORRELATION, title = fixture.gTask.title,
  marked = true, extensionId = RC6_EXTENSION_ID,
  createdDateTime = '2026-08-14T00:02:00Z'
} = {}) {
  const task = {
    id, title, body: { content: 'Private body', contentType: 'text' },
    status: 'notStarted', createdDateTime,
    lastModifiedDateTime: '2026-08-14T00:02:00Z'
  };
  if (marked) task.extensions = [{
    id: extensionId,
    extensionName: RC6_EXTENSION_NAME,
    correlationId
  }];
  return task;
}

test('rc6 persists a UUID move journal before POST and atomically sends its open extension', () => {
  const { context } = loadContext({
    utilities: { getUuid: () => RC6_CORRELATION }
  });
  const fixture = rc6MoveFixture(context);
  delete fixture.state.taskMoveJournal['g-task'];
  const snap = rc6MoveSnapshot(fixture);
  const durable = [];
  const calls = [];
  const created = rc6Destination(context, fixture);
  context.persistSyncState_ = (state) => durable.push(JSON.parse(JSON.stringify(state.taskMoveJournal)));
  context.getMsTask_ = (listId, taskId) => taskId === 'ms-task' ? fixture.oldMsTask : created;
  context.createMsTask_ = (listId, payload) => {
    calls.push({ listId, payload: JSON.parse(JSON.stringify(payload)) });
    assert.equal(durable.some((value) =>
      value['g-task']?.correlationId === RC6_CORRELATION && value['g-task']?.phase === 'creating'
    ), true, 'journal and correlation must be durable before POST');
    return created;
  };
  context.deleteMsTask_ = () => {};

  context.reconcileMapped_(fixture.state, snap, Date.now(), 'rc6-first-create');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].listId, 'ms-new');
  assert.deepEqual(calls[0].payload.extensions, [{
    '@odata.type': 'microsoft.graph.openTypeExtension',
    extensionName: 'com.tasksTodoSync.move',
    correlationId: RC6_CORRELATION
  }]);
  assert.equal(fixture.state.g2m['g-task'].msId, 'ms-task-new');
});

test('rc6 correlation recovery rejects lookalikes, edited markers, duplicate markers, incomplete expansion, and legacy uncertainty', () => {
  const cases = [
    {
      name: 'same fingerprint without marker is not adopted',
      fixture: {}, destination: { marked: false }, extensionComplete: true,
      expectedReason: 'MOVE_DESTINATION_CREATE_FAILED', expectedConfirmations: 1
    },
    {
      name: 'exact marker with changed content fails closed',
      fixture: {}, destination: { title: 'Edited destination' }, extensionComplete: true,
      expectedReason: 'MOVE_DESTINATION_EDIT_CONFLICT'
    },
    {
      name: 'multiple exact markers fail closed', fixture: {},
      destinations: [{ id: 'ms-new-a' }, { id: 'ms-new-b' }], extensionComplete: true,
      expectedReason: 'MOVE_CORRELATION_AMBIGUOUS'
    },
    {
      name: 'missing extension inventory fails closed', fixture: {}, destination: { marked: false },
      extensionComplete: false, expectedReason: 'MOVE_EXTENSION_INVENTORY_INCOMPLETE'
    },
    {
      name: 'legacy unresolved journal cannot auto-adopt or recreate', fixture: { legacy: true },
      destination: { marked: false }, extensionComplete: true,
      expectedReason: 'MOVE_LEGACY_CORRELATION_MISSING'
    }
  ];
  for (const item of cases) {
    const { context } = loadContext();
    const fixture = rc6MoveFixture(context, item.fixture);
    const targetTasks = item.destinations
      ? item.destinations.map((details) => rc6Destination(context, fixture, details))
      : [rc6Destination(context, fixture, item.destination)];
    const snap = rc6MoveSnapshot(fixture, targetTasks, item.extensionComplete);
    let creates = 0;
    let deletes = 0;
    context.persistSyncState_ = () => {};
    context.getMsTask_ = () => fixture.oldMsTask;
    context.createMsTask_ = () => { creates += 1; throw new Error('must not create'); };
    context.deleteMsTask_ = () => { deletes += 1; };

    assert.doesNotThrow(() => context.reconcileMapped_(fixture.state, snap, Date.now(), 'matrix-round'), item.name);
    assert.equal(creates, 0, item.name);
    assert.equal(deletes, 0, item.name);
    assert.equal(fixture.journal.newMsId, null, item.name);
    assert.equal(fixture.journal.lastBlockedReason || null, item.expectedReason, item.name);
    if (item.expectedConfirmations !== undefined) {
      assert.equal(fixture.journal.uncertainConfirmations, item.expectedConfirmations, item.name);
    }
  }
});

test('move marker recovery accepts only the two exact service-normalized ids with exact name and UUID', () => {
  const { context } = loadContext();
  const extensions = context.moveExtensionOnTask_({ extensions: [
    { id: RC6_EXTENSION_NAME, extensionName: RC6_EXTENSION_NAME, correlationId: RC6_CORRELATION },
    { id: 'evil.' + RC6_EXTENSION_ID, extensionName: RC6_EXTENSION_NAME, correlationId: RC6_CORRELATION },
    { id: 'contoso.openTypeExtension.' + RC6_EXTENSION_NAME, extensionName: RC6_EXTENSION_NAME, correlationId: RC6_CORRELATION },
    { id: RC6_EXTENSION_ID, extensionName: 'com.example.wrong', correlationId: RC6_CORRELATION },
    { id: RC6_EXTENSION_ID, extensionName: RC6_EXTENSION_NAME, correlationId: 'invalid' },
    { id: RC6_EXTENSION_ID, extensionName: RC6_EXTENSION_NAME, correlationId: RC6_CORRELATION },
    { id: RC6_LEGACY_EXTENSION_ID, extensionName: RC6_EXTENSION_NAME, correlationId: RC6_CORRELATION }
  ] });
  assert.deepEqual(
    extensions.map((extension) => extension.id),
    [RC6_EXTENSION_ID, RC6_LEGACY_EXTENSION_ID]
  );
});

test('the exact legacy Outlook service id also recovers without a duplicate POST', () => {
  const { context } = loadContext();
  const fixture = rc6MoveFixture(context);
  const destination = rc6Destination(context, fixture, {
    extensionId: RC6_LEGACY_EXTENSION_ID
  });
  const snap = rc6MoveSnapshot(fixture, [destination]);
  let creates = 0;
  context.persistSyncState_ = () => {};
  context.createMsTask_ = () => { creates += 1; throw new Error('must not duplicate'); };
  context.getMsTask_ = (listId, taskId) =>
    taskId === destination.id ? destination : fixture.oldMsTask;
  context.deleteMsTask_ = () => {};

  context.reconcileMapped_(fixture.state, snap, Date.now(), 'legacy-prefix-recovery');

  assert.equal(creates, 0);
  assert.equal(fixture.state.g2m['g-task'].msId, destination.id);
  assert.equal(fixture.state.taskMoveJournal['g-task'], undefined);
});

test('rc6 accepts a strict legacy created journal but rejects malformed non-empty correlations', () => {
  const { context } = loadContext();
  const fixture = rc6MoveFixture(context, { legacy: true, phase: 'created', newMsId: 'ms-task-new' });
  const destination = rc6Destination(context, fixture, { marked: false });
  const snap = rc6MoveSnapshot(fixture, [destination], false);
  let deletes = 0;
  context.persistSyncState_ = () => {};
  context.getMsTask_ = (listId, taskId) => taskId === 'ms-task' ? fixture.oldMsTask : destination;
  context.deleteMsTask_ = () => { deletes += 1; };
  context.createMsTask_ = () => { throw new Error('legacy created recovery must not recreate'); };

  context.reconcileMapped_(fixture.state, snap, Date.now(), 'legacy-created');
  assert.equal(deletes, 1);
  assert.equal(fixture.state.g2m['g-task'].msId, 'ms-task-new');

  const absentCorrelation = rc6MoveFixture(context, { legacy: true }).state;
  assert.doesNotThrow(() => context.normalizeState_(absentCorrelation));
  const malformed = rc6MoveFixture(context).state;
  malformed.taskMoveJournal['g-task'].correlationId = 'not-a-uuid';
  assert.throws(() => context.normalizeState_(malformed), /STATE_MALFORMED/);
});

test('snapshot expands extensions once per unresolved target list and never performs per-task Graph reads', () => {
  const { context } = loadContext();
  context.getSafetyConfig_ = () => ({
    googleListIds: ['g-old', 'g-new'], listDiscoveryMode: 'explicit',
    allowDeletions: false, allowListDeletions: false, allowTaskMoves: true
  });
  context.getGLists_ = () => [{ id: 'g-old', title: 'Old' }, { id: 'g-new', title: 'New' }];
  context.getMsLists_ = () => [{ id: 'ms-old', displayName: 'Old' }, { id: 'ms-new', displayName: 'New' }];
  context.getGTasks_ = () => [];
  const reads = [];
  context.getMsTasks_ = (listId, options) => {
    reads.push([listId, !!options?.includeMoveExtension]);
    return [];
  };
  context.getMsTask_ = () => { throw new Error('snapshot must not perform N+1 reads'); };
  const fixture = rc6MoveFixture(context);

  const snap = context.buildSnapshot_(fixture.state, Date.now());

  assert.deepEqual(reads.sort(), [['ms-new', true], ['ms-old', false]].sort());
  assert.deepEqual(Object.keys(snap.moveExtensionInventoryListIds), ['ms-new']);
});

test('extension inventory failure aborts before move create, adoption, or delete', () => {
  const { context } = loadContext();
  context.getSafetyConfig_ = () => ({
    googleListIds: ['g-old', 'g-new'], listDiscoveryMode: 'explicit',
    allowDeletions: false, allowListDeletions: false, allowTaskMoves: true
  });
  context.getGLists_ = () => [{ id: 'g-old', title: 'Old' }, { id: 'g-new', title: 'New' }];
  context.getMsLists_ = () => [{ id: 'ms-old', displayName: 'Old' }, { id: 'ms-new', displayName: 'New' }];
  context.getGTasks_ = () => [];
  context.getMsTasks_ = (listId, options) => {
    if (options?.includeMoveExtension) throw new Error('extension expansion unavailable');
    return [];
  };
  let mutations = 0;
  context.createMsTask_ = context.deleteMsTask_ = context.updateMsTask_ = () => { mutations += 1; };
  const fixture = rc6MoveFixture(context);

  assert.throws(() => context.buildSnapshot_(fixture.state, Date.now()), /extension expansion unavailable/);
  assert.equal(mutations, 0);
  assert.equal(fixture.journal.newMsId, null);
});

function rc6OperationHarness({ legacy = false, targetTasks = [], googleLocation = 'g-new' } = {}) {
  const logs = [];
  const { context, scriptStore, userStore } = loadContext();
  const fixture = rc6MoveFixture(context, { legacy });
  fixture.state.taskDeletionConflicts['g-task'] = {
    at: '2026-08-14T00:03:00Z', reason: fixture.journal.lastBlockedReason,
    msId: 'ms-task', gListId: 'g-old', msListId: 'ms-old'
  };
  const liveGoogleTask = { ...fixture.gTask };
  if (googleLocation === 'g-old') liveGoogleTask.updated = '2026-08-14T00:05:00Z';
  const providerMutations = [];
  let saves = 0;
  context.withGlobalLock_ = (fn) => fn();
  context.syncRoundFenceStatus_ = () => ({ active: false });
  context.loadStateForSync_ = () => fixture.state;
  context.saveState_ = () => { saves += 1; };
  context.getGTasks_ = (listId) => listId === googleLocation ? [liveGoogleTask] : [];
  context.getMsTasks_ = (listId, options) => {
    assert.equal(listId, 'ms-new');
    assert.equal(options?.includeMoveExtension, true);
    return targetTasks;
  };
  context.getMsTask_ = (listId, taskId) =>
    listId === 'ms-old' && taskId === 'ms-task' ? fixture.oldMsTask : null;
  for (const name of [
    'createGTask_', 'updateGTask_', 'deleteGTask_',
    'createMsTask_', 'updateMsTask_', 'deleteMsTask_'
  ]) {
    context[name] = () => { providerMutations.push(name); throw new Error('operation helper mutated provider'); };
  }
  context.console = { log: (value) => logs.push(String(value)), warn: () => {}, error: () => {} };
  return {
    context, scriptStore, userStore, fixture, liveGoogleTask,
    providerMutations, logs, get saves() { return saves; }
  };
}

function rc6SetOperation(harness, operation) {
  harness.scriptStore.setProperty('SYNC_TASK_MOVE_OPERATION_JSON', JSON.stringify(operation));
}

function rc6InspectEntry(harness, gId = 'g-task') {
  const report = harness.context.inspectTaskMoveJournals();
  assert.equal(report.journalCount >= 1, true);
  return report.journals.find((journal) =>
    journal.journalRef === harness.context.taskMoveJournalRef_(gId));
}

test('move journal inspection and preview are deterministic, private, locked, and read-only', () => {
  const harness = rc6OperationHarness();
  let lockAttempts = 0;
  let releases = 0;
  delete harness.context.withGlobalLock_;
  // Re-evaluate the real helper because deleting a global function binding is
  // not portable across V8 contexts; assign its original implementation body.
  harness.context.withGlobalLock_ = (fn) => {
    const lock = harness.context.LockService.getScriptLock();
    lockAttempts += 1;
    assert.equal(lock.tryLock(10000), true);
    try { return fn(); } finally { lock.releaseLock(); }
  };
  harness.context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { releases += 1; } })
  };
  const before = JSON.stringify(harness.fixture.state);
  const first = rc6InspectEntry(harness);
  const second = rc6InspectEntry(harness);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  rc6SetOperation(harness, { action: 'resume', journalRef: first.journalRef, revision: first.revision });
  const previewOne = harness.context.previewTaskMoveJournalOperation();
  const previewTwo = harness.context.previewTaskMoveJournalOperation();
  assert.equal(previewOne.previewToken, previewTwo.previewToken);
  assert.equal(previewOne.ok, true);
  assert.equal(JSON.stringify(harness.fixture.state), before);
  assert.equal(harness.saves, 0);
  assert.equal(lockAttempts, 4);
  assert.equal(releases, 4);
  assert.deepEqual(harness.providerMutations, []);
  const publicText = harness.logs.join('\n') + JSON.stringify([first, previewOne]);
  for (const privateValue of [
    'g-task', 'ms-task', 'g-old', 'g-new', 'ms-old', 'ms-new',
    'Private moved title', 'Private body', RC6_CORRELATION
  ]) assert.equal(publicText.includes(privateValue), false, privateValue);
});

test('resume clears only bounded move blockers after fresh evidence and writes a private receipt first', () => {
  const harness = rc6OperationHarness();
  const entry = rc6InspectEntry(harness);
  const operation = { action: 'resume', journalRef: entry.journalRef, revision: entry.revision };
  rc6SetOperation(harness, operation);
  const preview = harness.context.previewTaskMoveJournalOperation();
  rc6SetOperation(harness, { ...operation, previewToken: preview.previewToken });

  const applied = harness.context.applyTaskMoveJournalOperation();

  assert.equal(applied.applied, true);
  assert.equal(harness.fixture.journal.lastBlockedReason, undefined);
  assert.equal(harness.fixture.journal.lastBlockedAt, undefined);
  assert.equal(harness.fixture.journal.uncertainConfirmations, 0);
  assert.equal(harness.fixture.state.taskMoveJournal['g-task'], harness.fixture.journal);
  assert.ok(harness.userStore.getProperty('sync_task_move_operation_before_image'));
  assert.equal(harness.saves, 1);
  assert.deepEqual(harness.providerMutations, []);
});

test('move operation rejects stale revision, stale live token, active fence, and incomplete inventory without mutation', () => {
  const staleRevision = rc6OperationHarness();
  const first = rc6InspectEntry(staleRevision);
  rc6SetOperation(staleRevision, {
    action: 'resume', journalRef: first.journalRef, revision: 'moveRevision_stale'
  });
  assert.throws(() => staleRevision.context.previewTaskMoveJournalOperation(), /STALE_REVISION/);

  const staleToken = rc6OperationHarness();
  const entry = rc6InspectEntry(staleToken);
  const operation = { action: 'resume', journalRef: entry.journalRef, revision: entry.revision };
  rc6SetOperation(staleToken, operation);
  const preview = staleToken.context.previewTaskMoveJournalOperation();
  staleToken.fixture.oldMsTask.lastModifiedDateTime = '2026-08-14T00:06:00Z';
  rc6SetOperation(staleToken, { ...operation, previewToken: preview.previewToken });
  const before = JSON.stringify(staleToken.fixture.state);
  assert.throws(() => staleToken.context.applyTaskMoveJournalOperation(), /STALE_PREVIEW/);
  assert.equal(JSON.stringify(staleToken.fixture.state), before);
  assert.equal(staleToken.saves, 0);

  const fenced = rc6OperationHarness();
  const fencedEntry = rc6InspectEntry(fenced);
  fenced.context.syncRoundFenceStatus_ = () => ({ active: true, valid: true });
  rc6SetOperation(fenced, {
    action: 'resume', journalRef: fencedEntry.journalRef, revision: fencedEntry.revision
  });
  assert.throws(() => fenced.context.previewTaskMoveJournalOperation(), /ROUND_FENCE_ACTIVE/);

  const incomplete = rc6OperationHarness();
  const incompleteEntry = rc6InspectEntry(incomplete);
  incomplete.context.getMsTasks_ = () => { throw new Error('partial inventory'); };
  rc6SetOperation(incomplete, {
    action: 'resume', journalRef: incompleteEntry.journalRef, revision: incompleteEntry.revision
  });
  const incompletePreview = incomplete.context.previewTaskMoveJournalOperation();
  assert.equal(incompletePreview.ok, false);
  assert.equal(incompletePreview.code, 'MOVE_OPERATION_INVENTORY_INCOMPLETE');
  assert.equal(incomplete.saves, 0);
});

test('preview tokens cannot be reused after action, candidate, or confirmation intent changes', () => {
  const actionSwap = rc6OperationHarness();
  const actionEntry = rc6InspectEntry(actionSwap);
  const resume = {
    action: 'resume', journalRef: actionEntry.journalRef, revision: actionEntry.revision
  };
  rc6SetOperation(actionSwap, resume);
  const resumePreview = actionSwap.context.previewTaskMoveJournalOperation();
  const actionBefore = JSON.stringify(actionSwap.fixture.state);
  rc6SetOperation(actionSwap, {
    action: 'cancel', journalRef: resume.journalRef, revision: resume.revision,
    previewToken: resumePreview.previewToken
  });
  assert.throws(() => actionSwap.context.applyTaskMoveJournalOperation(), /STALE_PREVIEW/);
  assert.equal(JSON.stringify(actionSwap.fixture.state), actionBefore);
  assert.equal(actionSwap.saves, 0);
  assert.deepEqual(actionSwap.providerMutations, []);

  const base = loadContext();
  const baseFixture = rc6MoveFixture(base.context, { legacy: true });
  const candidateA = rc6Destination(base.context, baseFixture, {
    id: 'ms-candidate-a', marked: false
  });
  const candidateB = rc6Destination(base.context, baseFixture, {
    id: 'ms-candidate-b', marked: false
  });
  const candidateSwap = rc6OperationHarness({
    legacy: true, targetTasks: [candidateA, candidateB]
  });
  const candidateEntry = rc6InspectEntry(candidateSwap);
  const discover = {
    action: 'reconcile', journalRef: candidateEntry.journalRef, revision: candidateEntry.revision
  };
  rc6SetOperation(candidateSwap, discover);
  const candidates = candidateSwap.context.previewTaskMoveJournalOperation().evidence.candidateRefs;
  const reconcile = {
    ...discover, candidateRef: candidates[0], confirmation: 'ADOPT_EXACT_DESTINATION'
  };
  rc6SetOperation(candidateSwap, reconcile);
  const reconcilePreview = candidateSwap.context.previewTaskMoveJournalOperation();
  assert.equal(reconcilePreview.ok, true);
  const candidateBefore = JSON.stringify(candidateSwap.fixture.state);
  rc6SetOperation(candidateSwap, {
    ...reconcile, candidateRef: candidates[1], previewToken: reconcilePreview.previewToken
  });
  assert.throws(() => candidateSwap.context.applyTaskMoveJournalOperation(), /STALE_PREVIEW/);
  assert.equal(JSON.stringify(candidateSwap.fixture.state), candidateBefore);
  assert.equal(candidateSwap.saves, 0);
  assert.deepEqual(candidateSwap.providerMutations, []);

  rc6SetOperation(candidateSwap, reconcile);
  const confirmationPreview = candidateSwap.context.previewTaskMoveJournalOperation();
  rc6SetOperation(candidateSwap, {
    ...reconcile, confirmation: 'CHANGED_CONFIRMATION',
    previewToken: confirmationPreview.previewToken
  });
  assert.throws(() => candidateSwap.context.applyTaskMoveJournalOperation(), /STALE_PREVIEW/);
  assert.equal(JSON.stringify(candidateSwap.fixture.state), candidateBefore);
  assert.equal(candidateSwap.saves, 0);
  assert.deepEqual(candidateSwap.providerMutations, []);
});

test('cancel requires a manual Google rollback, preserves mappings and other journals, and never touches providers', () => {
  const harness = rc6OperationHarness({ googleLocation: 'g-old' });
  const secondTask = {
    id: 'g-task-two', title: 'Second', notes: '', status: 'needsAction',
    updated: '2026-08-14T00:01:00Z'
  };
  harness.fixture.state.g2m['g-task-two'] = {
    msId: 'ms-task-two', gListId: 'g-old', msListId: 'ms-old',
    gUpdated: secondTask.updated, msUpdated: '2026-08-14T00:00:00Z'
  };
  harness.fixture.state.m2g['ms-task-two'] = 'g-task-two';
  harness.fixture.state.taskMoveJournal['g-task-two'] = {
    phase: 'creating', gId: 'g-task-two', oldMsId: 'ms-task-two', newMsId: null,
    gListId: 'g-new', oldMsListId: 'ms-old', targetMsListId: 'ms-new',
    gUpdated: secondTask.updated, oldMsUpdated: '2026-08-14T00:00:00Z',
    preparedAt: '2026-08-14T00:01:30Z',
    fingerprint: harness.context.moveFingerprintFromGoogle_(secondTask),
    correlationId: '22222222-2222-4222-8222-222222222222',
    uncertainConfirmations: 0, lastRoundId: 'prior-round'
  };
  const entry = rc6InspectEntry(harness);
  const operation = { action: 'cancel', journalRef: entry.journalRef, revision: entry.revision };
  rc6SetOperation(harness, operation);
  const preview = harness.context.previewTaskMoveJournalOperation();
  assert.equal(preview.ok, true);
  rc6SetOperation(harness, { ...operation, previewToken: preview.previewToken });
  harness.context.applyTaskMoveJournalOperation();

  assert.equal(harness.fixture.state.taskMoveJournal['g-task'], undefined);
  assert.ok(harness.fixture.state.taskMoveJournal['g-task-two']);
  assert.equal(harness.fixture.state.taskDeletionConflicts['g-task'], undefined);
  assert.equal(harness.fixture.state.g2m['g-task'].msId, 'ms-task');
  assert.equal(harness.fixture.state.m2g['ms-task'], 'g-task');
  assert.deepEqual(harness.providerMutations, []);

  const candidatePresent = rc6OperationHarness({
    googleLocation: 'g-old',
    targetTasks: [rc6Destination(harness.context, harness.fixture)]
  });
  const blocked = rc6InspectEntry(candidatePresent);
  rc6SetOperation(candidatePresent, {
    action: 'cancel', journalRef: blocked.journalRef, revision: blocked.revision
  });
  assert.equal(candidatePresent.context.previewTaskMoveJournalOperation().code,
    'MOVE_OPERATION_DESTINATION_CANDIDATE_PRESENT');
});

test('reconcile adopts one exact correlated candidate into journal only', () => {
  const base = loadContext();
  const baseFixture = rc6MoveFixture(base.context);
  const candidate = rc6Destination(base.context, baseFixture);
  const harness = rc6OperationHarness({ targetTasks: [candidate] });
  const entry = rc6InspectEntry(harness);
  const operation = { action: 'reconcile', journalRef: entry.journalRef, revision: entry.revision };
  rc6SetOperation(harness, operation);
  const preview = harness.context.previewTaskMoveJournalOperation();
  assert.equal(preview.ok, true);
  assert.equal(preview.evidence.candidateRefs.length, 1);
  rc6SetOperation(harness, { ...operation, previewToken: preview.previewToken });
  harness.context.applyTaskMoveJournalOperation();

  assert.equal(harness.fixture.journal.phase, 'created');
  assert.equal(harness.fixture.journal.newMsId, 'ms-task-new');
  assert.equal(harness.fixture.state.g2m['g-task'].msId, 'ms-task');
  assert.deepEqual(harness.providerMutations, []);
});

test('legacy reconcile exposes only an opaque candidate ref and requires explicit exact-adoption confirmation', () => {
  const base = loadContext();
  const baseFixture = rc6MoveFixture(base.context, { legacy: true });
  const candidate = rc6Destination(base.context, baseFixture, { marked: false });
  const harness = rc6OperationHarness({ legacy: true, targetTasks: [candidate] });
  const entry = rc6InspectEntry(harness);
  const operation = { action: 'reconcile', journalRef: entry.journalRef, revision: entry.revision };
  rc6SetOperation(harness, operation);
  const preview = harness.context.previewTaskMoveJournalOperation();
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'MOVE_OPERATION_LEGACY_CONFIRMATION_REQUIRED');
  assert.equal(preview.evidence.candidateRefs.length, 1);
  const candidateRef = preview.evidence.candidateRefs[0];
  assert.equal(candidateRef.includes('ms-task-new'), false);
  const adoptOperation = {
    ...operation, candidateRef, confirmation: 'ADOPT_EXACT_DESTINATION'
  };
  rc6SetOperation(harness, adoptOperation);
  const adoptPreview = harness.context.previewTaskMoveJournalOperation();
  assert.equal(adoptPreview.ok, true);
  rc6SetOperation(harness, { ...adoptOperation, previewToken: adoptPreview.previewToken });
  harness.context.applyTaskMoveJournalOperation();
  assert.equal(harness.fixture.journal.phase, 'created');
  assert.equal(harness.fixture.journal.newMsId, 'ms-task-new');
  assert.deepEqual(harness.providerMutations, []);
});

test('journal ref collisions and receipt failures fail closed with zero state mutation', () => {
  const collision = rc6OperationHarness();
  const second = rc6MoveFixture(collision.context);
  second.journal.gId = 'g-task-two';
  second.journal.oldMsId = 'ms-task-two';
  second.journal.correlationId = '22222222-2222-4222-8222-222222222222';
  collision.fixture.state.g2m['g-task-two'] = {
    msId: 'ms-task-two', gListId: 'g-old', msListId: 'ms-old',
    gUpdated: second.journal.gUpdated, msUpdated: second.journal.oldMsUpdated
  };
  collision.fixture.state.m2g['ms-task-two'] = 'g-task-two';
  collision.fixture.state.taskMoveJournal['g-task-two'] = second.journal;
  const originalOpaque = collision.context.previewOpaqueId_;
  collision.context.previewOpaqueId_ = (kind, value) =>
    kind === 'moveJournal' ? 'moveJournal_collision' : originalOpaque(kind, value);
  const reports = collision.context.inspectTaskMoveJournals();
  rc6SetOperation(collision, {
    action: 'resume', journalRef: reports.journals[0].journalRef,
    revision: reports.journals[0].revision
  });
  assert.throws(() => collision.context.previewTaskMoveJournalOperation(), /REF_COLLISION/);

  const receipt = rc6OperationHarness();
  const entry = rc6InspectEntry(receipt);
  const operation = { action: 'resume', journalRef: entry.journalRef, revision: entry.revision };
  rc6SetOperation(receipt, operation);
  const preview = receipt.context.previewTaskMoveJournalOperation();
  rc6SetOperation(receipt, { ...operation, previewToken: preview.previewToken });
  const before = JSON.stringify(receipt.fixture.state);
  const realSetProperty = receipt.userStore.setProperty.bind(receipt.userStore);
  receipt.userStore.setProperty = (key, value) => {
    if (key === 'sync_task_move_operation_before_image') throw new Error('quota failure');
    return realSetProperty(key, value);
  };
  assert.throws(() => receipt.context.applyTaskMoveJournalOperation(), /RECEIPT_SAVE_FAILED/);
  assert.equal(JSON.stringify(receipt.fixture.state), before);
  assert.equal(receipt.saves, 0);
  assert.deepEqual(receipt.providerMutations, []);

  const staleReceipt = rc6OperationHarness();
  const staleEntry = rc6InspectEntry(staleReceipt);
  const staleOperation = {
    action: 'resume', journalRef: staleEntry.journalRef, revision: staleEntry.revision
  };
  rc6SetOperation(staleReceipt, staleOperation);
  const stalePreview = staleReceipt.context.previewTaskMoveJournalOperation();
  rc6SetOperation(staleReceipt, {
    ...staleOperation, previewToken: stalePreview.previewToken
  });
  staleReceipt.userStore.setProperty(
    'sync_task_move_operation_before_image', '{"old":"receipt"}'
  );
  const normalSetProperty = staleReceipt.userStore.setProperty.bind(staleReceipt.userStore);
  staleReceipt.userStore.setProperty = (key, value) => {
    if (key === 'sync_task_move_operation_before_image') return staleReceipt.userStore;
    return normalSetProperty(key, value);
  };
  const staleBefore = JSON.stringify(staleReceipt.fixture.state);
  assert.throws(() => staleReceipt.context.applyTaskMoveJournalOperation(), /RECEIPT_SAVE_FAILED/);
  assert.equal(JSON.stringify(staleReceipt.fixture.state), staleBefore);
  assert.equal(staleReceipt.saves, 0);
  assert.deepEqual(staleReceipt.providerMutations, []);
});

test('move observability makes blocked and legacy journals health issues without leaking arbitrary reasons', () => {
  const reports = [];
  const { context } = loadContext();
  const fixture = rc6MoveFixture(context, { legacy: true });
  fixture.journal.lastBlockedReason = 'PRIVATE_REASON_WITH_TASK_g-task';
  context.getConfig_ = () => ({});
  context.microsoftService_ = () => ({ hasAccess: () => true });
  context.ScriptApp = { getProjectTriggers: () => [{ getHandlerFunction: () => 'syncAll' }] };
  context.getSafetyConfig_ = () => ({
    listDiscoveryMode: 'auto', googleListIds: ['g-old'], allowDeletions: false,
    allowTaskMoves: true, requestedListDeletions: false, allowListDeletions: false
  });
  context.requireConfiguredListPairsApplied_ = () => ({ configured: false, pairs: [] });
  context.loadStateForInspection_ = () => ({ corrupt: false, state: fixture.state });
  context.syncRoundFenceStatus_ = () => ({ active: false });
  context.console = { log: (value) => reports.push(JSON.parse(value)) };

  context.healthCheck();

  const report = reports.at(-1);
  assert.equal(report.ok, false);
  assert.equal(report.taskMoves.journals, 1);
  assert.equal(report.taskMoves.blockedJournals, 1);
  assert.equal(report.taskMoves.blockedReasons.OTHER, 1);
  assert.equal(report.taskMoves.legacyWithoutCorrelation, 1);
  assert.ok(report.issues.some((issue) => issue.includes('inspectTaskMoveJournals')));
  assert.equal(JSON.stringify(report).includes('PRIVATE_REASON_WITH_TASK_g-task'), false);
  assert.equal(JSON.stringify(report).includes(RC6_CORRELATION), false);

  fixture.state.taskMoveJournal = {};
  fixture.state.taskDeletionConflicts = {};
  context.healthCheck();
  assert.equal(reports.at(-1).taskMoves.journals, 0);
  assert.equal(reports.at(-1).issues.some((issue) => issue.includes('task move journal')), false);
});

test('state replacement and explicit pair apply remain blocked while any move journal exists', () => {
  const { context } = loadContext();
  const fixture = rc6MoveFixture(context);
  context.withGlobalLock_ = (fn) => fn();
  context.syncRoundFenceStatus_ = () => ({ active: false });
  context.loadStateForSync_ = () => fixture.state;
  context.getSafetyConfig_ = () => ({
    listDiscoveryMode: 'explicit', googleListIds: ['g-old'], allowDeletions: false,
    allowTaskMoves: true, requestedListDeletions: false, allowListDeletions: false
  });
  context.getConfiguredListPairs_ = () => ({
    configured: true, pairs: [{ googleListId: 'g-old', microsoftListId: 'ms-old' }]
  });
  context.getGLists_ = context.getMsLists_ = () => { throw new Error('inventory must not run'); };

  assert.throws(() => context.importSyncState('{}'), /DELETION_JOURNAL_PENDING/);
  assert.throws(() => context.restorePreviousSyncState(), /DELETION_JOURNAL_PENDING/);
  assert.throws(() => context.applyConfiguredListPairs(), /DELETION_JOURNAL_PENDING/);
});

test('createTrigger replaces sync triggers with the exact 10-minute cadence and explains overlap safety', () => {
  const logs = [];
  const deleted = [];
  const everyMinutesCalls = [];
  const { context } = loadContext();
  context.getSafetyConfig_ = () => ({ listDiscoveryMode: 'auto', googleListIds: [] });
  context.requireSyncAllowlist_ = () => {};
  context.loadStateForSync_ = () => context.newState_();
  context.requireConfiguredListPairsApplied_ = () => {};
  const triggers = [
    { name: 'sync', getHandlerFunction: () => 'syncAll' },
    { name: 'other', getHandlerFunction: () => 'other' }
  ];
  context.ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger: (trigger) => deleted.push(trigger.name),
    newTrigger: (handler) => {
      assert.equal(handler, 'syncAll');
      return {
        timeBased() { return this; },
        everyMinutes(value) { everyMinutesCalls.push(value); return this; },
        create() { return { created: true }; }
      };
    }
  };
  context.console = { log: (value) => logs.push(String(value)) };

  context.createTrigger();

  assert.deepEqual(deleted, ['sync']);
  assert.deepEqual(everyMinutesCalls, [10]);
  assert.match(logs.join('\n'), /every 10 minutes/);
  assert.match(logs.join('\n'), /5\.25-minute budget/);
  assert.match(logs.join('\n'), /lock/);
});

test('destructive task and list delete paths stop at the reserve with journals intact and no remote delete', () => {
  function exhaustBudget(context) {
    new vm.Script('RUN_STARTED_AT = 1000; Date.now = function() { return 271000; };')
      .runInContext(context);
  }

  const taskRecovery = loadContext();
  const taskRecoveryState = mappedTaskState(taskRecovery.context);
  readyDeletionCandidate(taskRecoveryState, 'google');
  taskRecoveryState.deletionJournal['g-task'] =
    taskRecovery.context.preparedDeletionJournal_(taskRecoveryState.pendingTaskDeletions['g-task']);
  const taskSnap = mappedTaskSnapshot({ gTask: null });
  let taskRecoveryDeletes = 0;
  taskRecovery.context.deleteMsTask_ = () => { taskRecoveryDeletes += 1; };
  exhaustBudget(taskRecovery.context);
  assert.throws(
    () => taskRecovery.context.recoverPreparedTaskDeletions_(taskRecoveryState, taskSnap),
    /TIME_BUDGET_TASK_DELETE_RECOVERY_READ/
  );
  assert.ok(taskRecoveryState.deletionJournal['g-task']);
  assert.equal(taskRecoveryDeletes, 0);

  const taskApply = loadContext();
  const taskApplyState = mappedTaskState(taskApply.context);
  readyDeletionCandidate(taskApplyState, 'google', 'budget-round');
  let taskApplyDeletes = 0;
  let taskApplySaves = 0;
  taskApply.context.deleteMsTask_ = () => { taskApplyDeletes += 1; };
  taskApply.context.persistSyncState_ = () => { taskApplySaves += 1; };
  exhaustBudget(taskApply.context);
  assert.throws(
    () => taskApply.context.applyConfirmedTaskDeletions_(
      taskApplyState, taskSnap, 'budget-round', {
        durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {}
      }
    ),
    /TIME_BUDGET_TASK_DELETE_REVALIDATION/
  );
  assert.equal(taskApplyState.deletionJournal['g-task'], undefined);
  assert.equal(taskApplySaves, 0, 'current-round confirmation must remain volatile');
  assert.equal(taskApplyDeletes, 0);

  const listRecovery = loadContext();
  const recoveryPair = listDeletionPair(listRecovery.context);
  const listRecoveryState = listDeletionState(listRecovery.context);
  const recoveryCandidate = listDeletionCandidateRecord(recoveryPair, {
    confirmations: 2, lastRoundId: 'budget-round'
  });
  listRecoveryState.listDeletionJournal[recoveryPair.key] =
    listRecovery.context.preparedListDeletionJournal_(recoveryCandidate);
  let listRecoveryDeletes = 0;
  listRecovery.context.deleteMsList_ = () => { listRecoveryDeletes += 1; };
  exhaustBudget(listRecovery.context);
  assert.throws(
    () => listRecovery.context.recoverPreparedListDeletions_(
      listRecoveryState, listDeletionSnapshot(recoveryPair).safety, {}
    ),
    /TIME_BUDGET_LIST_DELETE_RECOVERY_READ/
  );
  assert.ok(listRecoveryState.listDeletionJournal[recoveryPair.key]);
  assert.equal(listRecoveryDeletes, 0);

  const listApply = loadContext();
  const applyPair = listDeletionPair(listApply.context);
  const listApplyState = listDeletionState(listApply.context);
  listApplyState.pendingListDeletions[applyPair.key] = listDeletionCandidateRecord(applyPair, {
    confirmations: 2, lastRoundId: 'budget-round'
  });
  let listApplyDeletes = 0;
  let listApplySaves = 0;
  listApply.context.deleteMsList_ = () => { listApplyDeletes += 1; };
  listApply.context.persistSyncState_ = () => { listApplySaves += 1; };
  exhaustBudget(listApply.context);
  assert.throws(
    () => listApply.context.applyConfirmedListDeletions_(
      listApplyState,
      listDeletionSnapshot(applyPair, {
        listLifecycle: { inventoryComplete: true, pairs: [] }
      }),
      'budget-round',
      { durableListJournalKeys: {}, invalidatedListCandidateKeys: {} },
      { durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} }
    ),
    /TIME_BUDGET_LIST_DELETE_REVALIDATION/
  );
  assert.equal(listApplyState.listDeletionJournal[applyPair.key], undefined);
  assert.equal(listApplySaves, 0, 'current-round list confirmation must remain volatile');
  assert.equal(listApplyDeletes, 0);

  const round = loadContext();
  const roundState = mappedTaskState(round.context);
  readyDeletionCandidate(roundState, 'google', 'previous-round');
  roundState.pendingTaskDeletions['g-task'].confirmations = 1;
  const catchSaves = [];
  let roundDeletes = 0;
  round.context.withGlobalLock_ = (fn) => fn();
  round.context.loadStateForSync_ = () => roundState;
  round.context.sanitizePreexistingSyncRoundFence_ = (value) => value;
  round.context.getSafetyConfig_ = () => ({
    allowDeletions: true, allowListDeletions: false, allowTaskMoves: false
  });
  round.context.pauseListDeletionIntentBeforeInventory_ = () => {};
  round.context.cleanupTombstones_ = () => {};
  round.context.cleanupListTombstones_ = () => {};
  round.context.buildSnapshot_ = () => mappedTaskSnapshot({ gTask: null });
  round.context.reconcileMapped_ = (state, snap, startedAt, roundId) => {
    state.pendingTaskDeletions['g-task'].confirmations = 2;
    state.pendingTaskDeletions['g-task'].lastRoundId = roundId;
  };
  round.context.createUnmapped_ = () => {
    new vm.Script('Date.now = function() { return 271000; };').runInContext(round.context);
  };
  round.context.deleteMsTask_ = () => { roundDeletes += 1; };
  round.context.saveState_ = (value) => {
    catchSaves.push(JSON.parse(JSON.stringify(value)));
  };
  round.context.sendFatalAlert_ = () => {};
  new vm.Script('Date.now = function() { return 1000; };').runInContext(round.context);

  assert.equal(round.context.syncAll(), undefined);
  assert.equal(roundDeletes, 0);
  assert.ok(catchSaves.length > 0);
  assert.equal(catchSaves.at(-1).pendingTaskDeletions['g-task'].confirmations, 1);
  assert.equal(catchSaves.at(-1).deletionJournal['g-task'], undefined);
});

test('completed move preserves its durable journal when the delete boundary runs out of time', () => {
  const { context } = loadContext();
  const fixture = rc6MoveFixture(context, { phase: 'created', newMsId: 'ms-task-new' });
  const destination = rc6Destination(context, fixture);
  const snap = rc6MoveSnapshot(fixture, [destination]);
  let deletes = 0;
  let reads = 0;
  context.getMsTask_ = () => { reads += 1; return null; };
  context.deleteMsTask_ = () => { deletes += 1; };
  context.persistSyncState_ = () => {};
  new vm.Script('RUN_STARTED_AT = 1000; Date.now = function() { return 271000; };')
    .runInContext(context);

  assert.throws(
    () => context.resyncGoogleTaskMove_(
      fixture.state, snap, 'g-task', fixture.gTask, fixture.state.g2m['g-task'],
      'g-new', 'ms-new', {}, 'budget-round'
    ),
    /TIME_BUDGET_MOVE_DESTINATION_READ/
  );
  assert.ok(fixture.state.taskMoveJournal['g-task']);
  assert.equal(fixture.state.taskMoveJournal['g-task'].newMsId, 'ms-task-new');
  assert.equal(reads, 0);
  assert.equal(deletes, 0);
});

test('time budget text promises full re-inventory instead of cursor resume', () => {
  assert.match(code, /next (?:round|invocation).*full inventory.*persisted page cursor/i);
  assert.doesNotMatch(code, /TIME_BUDGET_HTTP[^\n]*resum/i);
  assert.match(code, /SYNC_TRIGGER_INTERVAL_MINUTES = 10/);
});

test('Microsoft task inventory expands only the requested move extension list', () => {
  const { context } = loadContext();
  const urls = [];
  context.graphFetch_ = (url) => { urls.push(url); return { value: [] }; };
  context.getMsTasks_('ms-list');
  context.getMsTasks_('ms-list', { includeMoveExtension: true });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].includes('$expand'), false);
  assert.equal(
    urls[1].includes(
      '&$expand=extensions($filter=id%20eq%20%27com.tasksTodoSync.move%27)'
    ),
    true
  );
  assert.equal(
    decodeURIComponent(urls[1]).includes(
      "$expand=extensions($filter=id eq 'com.tasksTodoSync.move')"
    ),
    true
  );
  assert.equal(urls[1].includes('microsoft.graph.openTypeExtension.'), false);
  assert.equal(urls[1].includes('Microsoft.OutlookServices.OpenTypeExtension.'), false);
});

test('real fenced task rounds retain completed baseline through a time-budget failure', () => {
  const { context, userStore } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_DELETIONS: 'true',
    SYNC_ALLOW_LIST_DELETIONS: 'true', SYNC_ALLOW_TASK_MOVES: 'false'
  } });
  const state = mappedTaskState(context);
  context.saveState_(state);
  context.withGlobalLock_ = (fn) => fn();
  let deterministicRound = 0;
  context.deletionRoundId_ = () => 'task-time-budget-' + (++deterministicRound);
  context.sendFatalAlert_ = () => {};
  context.pauseListDeletionIntentBeforeInventory_ = () => {};
  context.cleanupTombstones_ = () => {};
  context.cleanupListTombstones_ = () => {};
  context.buildSnapshot_ = () => mappedTaskSnapshot({ gTask: null });
  context.createUnmapped_ = () => {};
  let microsoftDeletes = 0;
  context.deleteMsTask_ = () => { microsoftDeletes += 1; };

  context.syncAll();
  let after = context.loadStateForSync_();
  assert.equal(after.pendingTaskDeletions['g-task'].confirmations, 1);
  assert.equal(userStore.getProperty('sync_state_main_round_fence'), null);

  context.assertDestructiveTimeBudget_ = (code) => { throw new Error(code || 'TIME_BUDGET_TASK_DELETE_REVALIDATION'); };
  assert.equal(context.syncAll(), undefined);
  after = context.loadStateForSync_();
  assert.equal(after.pendingTaskDeletions['g-task'].confirmations, 1);
  assert.equal(userStore.getProperty('sync_state_main_round_fence'), null);

  context.assertDestructiveTimeBudget_ = () => {};
  context.syncAll();
  after = context.loadStateForSync_();
  assert.equal(microsoftDeletes, 1);
  assert.equal(after.g2m['g-task'], undefined);
  assert.equal(after.pendingTaskDeletions['g-task'], undefined);
});

test('real fenced list rounds retain completed baseline through a time-budget failure', () => {
  const { context, userStore } = loadContext({ scriptValues: {
    SYNC_LIST_DISCOVERY_MODE: 'auto', SYNC_ALLOW_DELETIONS: 'true',
    SYNC_ALLOW_LIST_DELETIONS: 'true', SYNC_ALLOW_TASK_MOVES: 'false'
  } });
  const state = listDeletionState(context);
  const pair = listDeletionPair(context);
  pair.provenance = state.listPairMeta[pair.key];
  context.saveState_(state);
  context.withGlobalLock_ = (fn) => fn();
  let deterministicRound = 0;
  context.deletionRoundId_ = () => 'list-time-budget-' + (++deterministicRound);
  context.sendFatalAlert_ = () => {};
  context.cleanupTombstones_ = () => {};
  context.cleanupListTombstones_ = () => {};
  context.createUnmapped_ = () => {};
  context.buildSnapshot_ = () => listDeletionSnapshot(pair);

  context.syncAll();
  let after = context.loadStateForSync_();
  assert.equal(after.pendingListDeletions[pair.key].confirmations, 1);
  assert.equal(userStore.getProperty('sync_state_main_round_fence'), null);

  context.assertDestructiveTimeBudget_ = (code) => { throw new Error(code || 'TIME_BUDGET_LIST_DELETE_REVALIDATION'); };
  assert.equal(context.syncAll(), undefined);
  after = context.loadStateForSync_();
  assert.equal(after.pendingListDeletions[pair.key].confirmations, 1);
  assert.equal(after.pendingListDeletions[pair.key].missingSide, 'google');
  assert.equal(userStore.getProperty('sync_state_main_round_fence'), null);

  context.assertDestructiveTimeBudget_ = () => {};
  context.buildListDeletionRevalidation_ = (liveState, record) => ({
    ok: true,
    input: { ...record }
  });
  context.deleteMsList_ = () => {};
  context.syncAll();
  after = context.loadStateForSync_();
  assert.equal(after.listMap['g-list'], undefined);
  assert.equal(after.pendingListDeletions[pair.key], undefined);
});

test('round fence accepts only arming or active, and stale arming preserves completed state', () => {
  const { context, userStore } = loadContext({ scriptValues: { SYNC_ALLOW_DELETIONS: 'true' } });
  const state = mappedTaskState(context);
  readyDeletionCandidate(state, 'google', 'completed-round');
  state.pendingTaskDeletions['g-task'].confirmations = 1;
  context.saveState_(state);
  userStore.setProperty('sync_state_main_round_fence', JSON.stringify({
    roundId: 'arming-round', startedAt: '2026-08-28T00:00:00.000Z', phase: 'arming'
  }));
  assert.equal(context.syncRoundFenceStatus_().valid, true);
  const preserved = context.sanitizePreexistingSyncRoundFence_(context.loadStateForSync_());
  assert.equal(preserved.pendingTaskDeletions['g-task'].confirmations, 1);
  assert.equal(context.syncRoundFenceStatus_().active, false);

  userStore.setProperty('sync_state_main_round_fence', JSON.stringify({
    roundId: 'invalid-round', startedAt: '2026-08-28T00:00:00.000Z', phase: 'unknown'
  }));
  assert.equal(context.syncRoundFenceStatus_().valid, false);
});

function saveSuccessfulRoundForRestore_(context, state, roundId) {
  state.health.lastSuccessfulRoundId = roundId;
  state.health.roundFenceProjectionId = null;
  const generation = context.saveState_(state);
  context.recordSuccessfulSyncRound_(roundId, generation);
  return generation;
}

test('successful-round pointer rejects a missing final generation', () => {
  const { context } = loadContext();
  assert.throws(() => context.recordSuccessfulSyncRound_('missing-generation', undefined),
    /STATE_SUCCESSFUL_ROUND_GENERATION_REQUIRED/);
});

test('restore rejects legacy checkpoint history with no successful-round pointer', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  context.saveState_(state);
  context.withGlobalLock_ = (fn) => fn();
  assert.throws(() => context.restorePreviousSyncState(), /STATE_RESTORE_UNAVAILABLE/);
});

test('restore selects last successful round after multiple fenced checkpoints', () => {
  const { context, userStore } = loadContext();
  context.withGlobalLock_ = (fn) => fn();
  const first = mappedTaskState(context);
  first.g2m['g-task'].gUpdated = '2026-08-01T00:00:00Z';
  saveSuccessfulRoundForRestore_(context, first, 'successful-1');
  const second = mappedTaskState(context);
  second.g2m['g-task'].gUpdated = '2026-08-02T00:00:00Z';
  const secondGeneration = saveSuccessfulRoundForRestore_(context, second, 'successful-2');
  const checkpoint = mappedTaskState(context);
  checkpoint.g2m['g-task'].gUpdated = 'failed-checkpoint-1';
  checkpoint.health.lastSuccessfulRoundId = 'successful-2';
  checkpoint.health.roundFenceProjectionId = 'failed-round';
  context.saveState_(checkpoint);
  checkpoint.g2m['g-task'].gUpdated = 'failed-checkpoint-2';
  context.saveState_(checkpoint);

  assert.notEqual(JSON.parse(userStore.getProperty('sync_state_main_manifest')).generation, secondGeneration);
  context.restorePreviousSyncState();
  assert.equal(context.loadStateForSync_().g2m['g-task'].gUpdated, '2026-08-02T00:00:00Z');
});

test('restore selects prior successful round when current generation is itself successful', () => {
  const { context } = loadContext();
  context.withGlobalLock_ = (fn) => fn();
  const first = mappedTaskState(context);
  first.g2m['g-task'].gUpdated = '2026-08-01T00:00:00Z';
  saveSuccessfulRoundForRestore_(context, first, 'successful-1');
  const second = mappedTaskState(context);
  second.g2m['g-task'].gUpdated = '2026-08-02T00:00:00Z';
  saveSuccessfulRoundForRestore_(context, second, 'successful-2');

  context.restorePreviousSyncState();
  assert.equal(context.loadStateForSync_().g2m['g-task'].gUpdated, '2026-08-01T00:00:00Z');
});

test('task and list deletion journal checkpoints retain fence marker and prior proof baseline', () => {
  const task = loadContext();
  const taskState = mappedTaskState(task.context);
  readyDeletionCandidate(taskState, 'google', 'prior-task-round');
  taskState.g2m['g-task-b'] = {
    msId: 'ms-task-b', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  taskState.m2g['ms-task-b'] = 'g-task-b';
  taskState.pendingTaskDeletions['g-task-b'] = {
    ...taskState.pendingTaskDeletions['g-task'], gId: 'g-task-b', msId: 'ms-task-b',
    confirmations: 1, lastRoundId: 'prior-task-round'
  };
  const taskBaseline = JSON.parse(JSON.stringify(taskState.pendingTaskDeletions));
  task.context.openSyncRoundFence_('task-journal-round');
  task.context.beginSyncRoundProofProjection_(taskState, 'task-journal-round', taskBaseline, {});
  assert.equal(task.context.roundBaselineTaskCandidates_(taskState, {
    pendingTaskDeletions: taskBaseline
  })['g-task-b'].confirmations, 1);
  taskState.deletionJournal['g-task'] = task.context.preparedDeletionJournal_(taskState.pendingTaskDeletions['g-task']);
  task.context.saveDeletionJournalDurably_(taskState, {
    pendingBeforeRound: taskBaseline,
    durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {}
  });
  const durableTask = task.context.loadStateForSync_();
  assert.equal(durableTask.health.roundFenceProjectionId, 'task-journal-round');
  assert.equal(durableTask.pendingTaskDeletions['g-task'], undefined);
  assert.equal(durableTask.pendingTaskDeletions['g-task-b'].confirmations, 1);
  assert.equal(durableTask.deletionJournal['g-task'].phase, 'prepared');

  const list = loadContext();
  const listState = listDeletionState(list.context);
  const pair = listDeletionPair(list.context);
  const candidate = listDeletionCandidateRecord(pair);
  listState.pendingListDeletions[pair.key] = candidate;
  const otherPair = {
    ...pair,
    key: list.context.listPairKey_('g-list-b', 'ms-list-b'),
    gListId: 'g-list-b', msListId: 'ms-list-b', gTitle: 'Other', msTitle: 'Other'
  };
  listState.listMap[otherPair.gListId] = otherPair.msListId;
  listState.listPairMeta[otherPair.key] = {
    ...listState.listPairMeta[pair.key],
    gListId: otherPair.gListId, msListId: otherPair.msListId, gTitle: otherPair.gTitle, msTitle: otherPair.msTitle
  };
  listState.pendingListDeletions[otherPair.key] = listDeletionCandidateRecord(otherPair);
  const listBaseline = JSON.parse(JSON.stringify(listState.pendingListDeletions));
  list.context.openSyncRoundFence_('list-journal-round');
  list.context.beginSyncRoundProofProjection_(listState, 'list-journal-round', {}, listBaseline);
  listState.listDeletionJournal[pair.key] = list.context.preparedListDeletionJournal_(candidate);
  list.context.saveListDeletionJournalDurably_(listState, {
    pendingListBeforeRound: listBaseline,
    durableListJournalKeys: {}, invalidatedListCandidateKeys: {}
  }, { pendingBeforeRound: {}, durableJournalTaskIds: {}, invalidatedCandidateTaskIds: {}, discardCandidateTaskIds: {} });
  const durableList = list.context.loadStateForSync_();
  assert.equal(durableList.health.roundFenceProjectionId, 'list-journal-round');
  assert.equal(durableList.pendingListDeletions[pair.key].confirmations, 1);
  assert.equal(durableList.pendingListDeletions[otherPair.key].confirmations, 1);
  assert.equal(durableList.listDeletionJournal[pair.key].phase, 'prepared');
});
test('new state manifests omit ordinary previousGeneration and retain at most three candidates', () => {
  const { context, userStore } = loadContext();
  let peak = 0;
  const originalSetProperties = userStore.setProperties.bind(userStore);
  userStore.setProperties = (entries) => {
    originalSetProperties(entries);
    const generations = new Set(Object.keys(userStore.values).map((key) => {
      const match = key.match(/^sync_state_main_gen_(.+)_(?:\\d+|count|meta)$/);
      return match && match[1];
    }).filter(Boolean));
    peak = Math.max(peak, generations.size);
  };
  for (let i = 0; i < 5; i += 1) context.saveState_(context.newState_());
  const manifest = JSON.parse(userStore.getProperty('sync_state_main_manifest'));
  assert.equal(manifest.previousGeneration, null);
  assert.ok(peak <= 3, `candidate peak exceeded three generations: ${peak}`);
});

test('successful restore selector follows the current main generation transition', () => {
  const { context, userStore } = loadContext();
  const first = mappedTaskState(context); first.g2m['g-task'].gUpdated = '2026-08-01T00:00:00Z';
  const firstGeneration = saveSuccessfulRoundForRestore_(context, first, 'retention-1');
  const second = mappedTaskState(context); second.g2m['g-task'].gUpdated = '2026-08-02T00:00:00Z';
  const secondGeneration = saveSuccessfulRoundForRestore_(context, second, 'retention-2');
  assert.equal(context.successfulRoundRestoreGeneration_(userStore), firstGeneration);

  const checkpoint = mappedTaskState(context); checkpoint.g2m['g-task'].gUpdated = 'checkpoint';
  const checkpointGeneration = context.saveState_(checkpoint);
  assert.equal(context.successfulRoundRestoreGeneration_(userStore), secondGeneration);
  const generations = new Set(Object.keys(userStore.values).map((key) => {
    const match = key.match(/^sync_state_main_gen_(.+)_(?:\\d+|count|meta)$/);
    return match && match[1];
  }).filter(Boolean));
  assert.deepEqual([...generations].sort(), [checkpointGeneration, secondGeneration].sort());
});

test('retention fails closed when the selected successful restore target is missing', () => {
  const { context, userStore } = loadContext();
  const first = mappedTaskState(context); const firstGeneration = saveSuccessfulRoundForRestore_(context, first, 'retention-corrupt-1');
  const second = mappedTaskState(context); saveSuccessfulRoundForRestore_(context, second, 'retention-corrupt-2');
  userStore.deleteProperty('sync_state_main_gen_' + firstGeneration + '_0');
  assert.throws(() => context.saveState_(context.newState_()), /STATE_RESTORE_CORRUPT/);
});

test('move journal fingerprints use strict SHA-256 Base64 while matching legacy raw values', () => {
  const { context } = loadContext();
  const task = { id: 'g-task', title: 'Moved', notes: 'payload', status: 'needsAction' };
  const raw = context.moveFingerprintFromGoogle_(task);
  const encoded = context.moveFingerprintForJournal_(task);
  assert.match(encoded, /^sha256b64:[A-Za-z0-9+/]{43}=$/);
  assert.equal(context.moveFingerprintMatches_(raw, encoded), true);
  assert.equal(context.moveFingerprintMatches_(raw, raw), true);
  assert.equal(context.moveFingerprintMatches_(raw + 'changed', raw), false);
  assert.equal(context.moveFingerprintMatches_(raw, 'sha256b64:not-a-digest'), false);
});

test('malformed prefixed move fingerprints fail normalization while legacy values remain accepted', () => {
  const { context } = loadContext();
  const state = mappedTaskState(context);
  const rec = state.g2m['g-task'];
  state.taskMoveJournal['g-task'] = {
    phase: 'creating', gId: 'g-task', oldMsId: rec.msId, newMsId: null,
    gListId: 'g-new', oldMsListId: rec.msListId, targetMsListId: 'ms-new',
    gUpdated: rec.gUpdated, oldMsUpdated: rec.msUpdated,
    preparedAt: '2026-08-14T00:01:00Z', fingerprint: 'sha256b64:bad',
    uncertainConfirmations: 0, lastRoundId: null
  };
  assert.throws(() => context.normalizeState_(state), /STATE_MALFORMED.*taskMoveJournal/);
  state.taskMoveJournal['g-task'].fingerprint = 'legacy-fingerprint';
  assert.doesNotThrow(() => context.normalizeState_(state));
});
