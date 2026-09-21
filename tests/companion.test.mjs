import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { runGasFilesInContext } from './gas-loader.mjs';

function createCompanionContext() {
  const cacheMap = new Map();
  const propsMap = new Map();
  const triggers = [];
  let activeUserEmail = 'owner@example.com';
  let effectiveUserEmail = 'owner@example.com';

  const propStore = {
    getProperty: (k) => propsMap.get(k) || null,
    setProperty: (k, v) => propsMap.set(k, String(v)),
    deleteProperty: (k) => propsMap.delete(k),
    setProperties: (obj, overwrite = true) => {
      for (const k of Object.keys(obj)) {
        propsMap.set(k, String(obj[k]));
      }
    },
    deleteAllProperties: () => propsMap.clear()
  };

  const context = vm.createContext({
    console,
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cacheMap.get(k) || null,
        put: (k, v, ttl) => cacheMap.set(k, String(v)),
        remove: (k) => cacheMap.delete(k)
      })
    },
    PropertiesService: {
      getScriptProperties: () => propStore,
      getUserProperties: () => propStore
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => {
        const idx = triggers.indexOf(t);
        if (idx !== -1) triggers.splice(idx, 1);
      },
      newTrigger: (fnName) => ({
        timeBased: () => ({
          after: (ms) => ({
            create: () => {
              const tr = { getHandlerFunction: () => fnName };
              triggers.push(tr);
              return tr;
            }
          }),
          everyMinutes: (min) => ({
            create: () => {
              const tr = { getHandlerFunction: () => fnName };
              triggers.push(tr);
              return tr;
            }
          })
        })
      })
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({
        text,
        mimeType: null,
        setMimeType(m) { this.mimeType = m; return this; }
      })
    },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
      createHtmlOutput: (content) => ({
        content,
        title: '',
        setTitle(t) { this.title = t; return this; }
      }),
      createHtmlOutputFromFile: (name) => ({
        name,
        title: '',
        xframe: null,
        setTitle(t) { this.title = t; return this; },
        setXFrameOptionsMode(m) { this.xframe = m; return this; }
      })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, input, charset) => {
        const hash = crypto.createHash('sha256').update(input, 'utf8').digest();
        const signedBytes = [];
        for (let i = 0; i < hash.length; i++) {
          let b = hash[i];
          if (b > 127) b -= 256;
          signedBytes.push(b);
        }
        return signedBytes;
      }
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => activeUserEmail }),
      getEffectiveUser: () => ({ getEmail: () => effectiveUserEmail })
    }
  });

  runGasFilesInContext(context);

  const testKey = 'test_companion_secret_key_12345';
  const testKeyHash = crypto.createHash('sha256').update(testKey, 'utf8').digest('hex');
  context.COMPANION_KEY_HASH = testKeyHash;

  return {
    context,
    testKey,
    testKeyHash,
    cacheMap,
    propsMap,
    triggers,
    setActiveEmail: (e) => { activeUserEmail = e; },
    setEffectiveEmail: (e) => { effectiveUserEmail = e; }
  };
}

function postRequest(context, body) {
  const e = {
    postData: {
      contents: typeof body === 'string' ? body : JSON.stringify(body)
    }
  };
  const res = context.doPost(e);
  return JSON.parse(res.text);
}

// ----------------------------------------------------------------------------
// Test 1: Owner Gate on doGet
// ----------------------------------------------------------------------------
test('doGet blocks anonymous and non-owner access with 403 Forbidden', () => {
  const { context, setActiveEmail, setEffectiveEmail } = createCompanionContext();

  // Anonymous visitor (empty active user email)
  setActiveEmail('');
  setEffectiveEmail('owner@example.com');
  const anonRes = context.doGet({});
  assert.equal(anonRes.content, 'Forbidden');

  // Different user logged in
  setActiveEmail('attacker@evil.com');
  const attackerRes = context.doGet({});
  assert.equal(attackerRes.content, 'Forbidden');

  // Legitimate owner
  setActiveEmail('owner@example.com');
  const ownerRes = context.doGet({});
  assert.equal(ownerRes.name, 'Setup');
});

// ----------------------------------------------------------------------------
// Test 2: Malformed JSON handling & zero-sleep fast-fail
// ----------------------------------------------------------------------------
test('doPost returns BAD_REQUEST on invalid JSON and does not increment AUTH_FAIL_COUNT', () => {
  const { context, cacheMap } = createCompanionContext();

  const res1 = context.doPost(null);
  assert.equal(JSON.parse(res1.text).error, 'BAD_REQUEST');
  assert.equal(cacheMap.get('AUTH_FAIL_COUNT'), undefined);

  const res2 = context.doPost({ postData: { contents: 'this is not valid json' } });
  assert.equal(JSON.parse(res2.text).error, 'BAD_REQUEST');
  assert.equal(cacheMap.get('AUTH_FAIL_COUNT'), undefined);

  const res3 = context.doPost({ postData: { contents: '12345' } });
  assert.equal(JSON.parse(res3.text).error, 'BAD_REQUEST');
  assert.equal(cacheMap.get('AUTH_FAIL_COUNT'), undefined);
});

// ----------------------------------------------------------------------------
// Test 3: Rate limiting after 5 failures and RATE_LIMITED on 6th attempt
// ----------------------------------------------------------------------------
test('doPost rate limits after 5 bad authentication attempts and returns RATE_LIMITED on 6th', () => {
  const { context, cacheMap } = createCompanionContext();

  for (let i = 1; i <= 5; i++) {
    const res = postRequest(context, { apiKey: 'wrong_key', action: 'ping' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'UNAUTHORIZED');
    assert.equal(cacheMap.get('AUTH_FAIL_COUNT'), String(i));
  }

  // 6th attempt: immediately rate limited without even checking key
  const tStart = Date.now();
  const res6 = postRequest(context, { apiKey: 'wrong_key', action: 'ping' });
  const durationMs = Date.now() - tStart;

  assert.equal(res6.ok, false);
  assert.equal(res6.error, 'RATE_LIMITED');
  assert.ok(durationMs < 50, `Expected rate limit response to be < 50ms (zero sleep), took ${durationMs}ms`);
});

// ----------------------------------------------------------------------------
// Test 4: Successful authentication clears failure counter and serves actions
// ----------------------------------------------------------------------------
test('doPost succeeds with valid key, clears failure count, and routes ping action', () => {
  const { context, testKey, cacheMap } = createCompanionContext();

  cacheMap.set('AUTH_FAIL_COUNT', '2');

  const res = postRequest(context, { apiKey: testKey, action: 'ping' });
  assert.equal(res.ok, true);
  assert.equal(res.version, '2.4.0');
  assert.equal(cacheMap.get('AUTH_FAIL_COUNT'), undefined);
});

// ----------------------------------------------------------------------------
// Test 5: Bootstrap idempotency
// ----------------------------------------------------------------------------
test('bootstrap initializes defaults and triggers idempotently without resetting existing settings', () => {
  const { context, testKey, propsMap, triggers } = createCompanionContext();

  // User configured an override beforehand
  propsMap.set('SYNC_ALLOW_DELETIONS', 'true');
  propsMap.set('COMPANION_DISABLED', 'true');

  const res = postRequest(context, { apiKey: testKey, action: 'bootstrap' });
  assert.equal(res.ok, true);
  assert.equal(propsMap.get('COMPANION_DISABLED'), undefined); // Cleared disabled flag
  assert.equal(propsMap.get('SYNC_ALLOW_DELETIONS'), 'true'); // Preserved user configuration
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].getHandlerFunction(), 'syncAll');

  // Calling bootstrap again does not duplicate triggers
  const res2 = postRequest(context, { apiKey: testKey, action: 'bootstrap' });
  assert.equal(res2.ok, true);
  assert.equal(triggers.length, 1);
});

// ----------------------------------------------------------------------------
// Test 6: Unbind disables companion endpoint with COMPANION_DISABLED gate
// ----------------------------------------------------------------------------
test('unbind removes triggers, resets MS auth, and marks endpoint COMPANION_DISABLED', () => {
  const { context, testKey, propsMap, triggers } = createCompanionContext();

  // Set up an active trigger
  triggers.push({ getHandlerFunction: () => 'syncAll' });

  // Call unbind
  const unbindRes = postRequest(context, { apiKey: testKey, action: 'unbind' });
  assert.equal(unbindRes.ok, true);
  assert.equal(propsMap.get('COMPANION_DISABLED'), 'true');
  assert.equal(triggers.length, 0);

  // Subsequent actions (ping, get_status, trigger_sync) must be rejected even with valid key
  const pingRes = postRequest(context, { apiKey: testKey, action: 'ping' });
  assert.equal(pingRes.ok, false);
  assert.equal(pingRes.error, 'COMPANION_DISABLED');

  const statusRes = postRequest(context, { apiKey: testKey, action: 'get_status' });
  assert.equal(statusRes.ok, false);
  assert.equal(statusRes.error, 'COMPANION_DISABLED');

  // Only bootstrap can re-enable it
  const reEnableRes = postRequest(context, { apiKey: testKey, action: 'bootstrap' });
  assert.equal(reEnableRes.ok, true);
  assert.equal(propsMap.get('COMPANION_DISABLED'), undefined);

  const pingAfterRes = postRequest(context, { apiKey: testKey, action: 'ping' });
  assert.equal(pingAfterRes.ok, true);
});
