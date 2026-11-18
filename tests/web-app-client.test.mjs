import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callWebAppAction } from '../lib/web-app-client.mjs';

const DEFAULT_CLASP_CLIENT_ID = '1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0.apps.googleusercontent.com';
const DEFAULT_CLASP_CLIENT_SECRET = 'v6V3fKV_zWU7iw1DrpO1rknX';

async function credentialFile(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'tts-clasp-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '.clasprc.json');
  await writeFile(path, JSON.stringify(contents), 'utf8');
  return path;
}

function successfulFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    const payload = url === 'https://oauth2.googleapis.com/token'
      ? { access_token: 'fresh-access-token' }
      : { ok: true, result: { connected: true } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
}

async function runWithCredentials(t, contents) {
  const credentialsPath = await credentialFile(t, contents);
  const calls = [];
  const reply = await callWebAppAction({
    deploymentId: 'test-deployment',
    action: 'webAppHandshake',
    credentialsPath,
    fetchImpl: successfulFetch(calls)
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(calls.length, 2);
  return Object.fromEntries(calls[0].options.body);
}

test('clasp v3 default credentials supply their own OAuth client fields', async (t) => {
  const body = await runWithCredentials(t, {
    tokens: {
      default: {
        type: 'authorized_user',
        client_id: 'modern-client-id',
        client_secret: 'modern-client-secret',
        refresh_token: 'modern-refresh-token',
        access_token: 'expired-access-token'
      }
    }
  });
  assert.deepEqual(body, {
    client_id: 'modern-client-id',
    client_secret: 'modern-client-secret',
    refresh_token: 'modern-refresh-token',
    grant_type: 'refresh_token'
  });
});

test('legacy local clasp credentials remain supported', async (t) => {
  const body = await runWithCredentials(t, {
    token: { refresh_token: 'legacy-local-refresh-token' },
    oauth2ClientSettings: {
      clientId: 'legacy-local-client-id',
      clientSecret: 'legacy-local-client-secret'
    }
  });
  assert.equal(body.client_id, 'legacy-local-client-id');
  assert.equal(body.client_secret, 'legacy-local-client-secret');
  assert.equal(body.refresh_token, 'legacy-local-refresh-token');
});

test('legacy global clasp credentials use the public clasp OAuth client', async (t) => {
  const body = await runWithCredentials(t, {
    access_token: 'legacy-global-access-token',
    refresh_token: 'legacy-global-refresh-token',
    token_type: 'Bearer',
    expiry_date: 1
  });
  assert.equal(body.client_id, DEFAULT_CLASP_CLIENT_ID);
  assert.equal(body.client_secret, DEFAULT_CLASP_CLIENT_SECRET);
  assert.equal(body.refresh_token, 'legacy-global-refresh-token');
});

test('modern default credentials take precedence over stale legacy fields', async (t) => {
  const body = await runWithCredentials(t, {
    tokens: {
      default: {
        client_id: 'current-client-id',
        client_secret: 'current-client-secret',
        refresh_token: 'current-refresh-token'
      }
    },
    token: { refresh_token: 'stale-refresh-token' },
    oauth2ClientSettings: {
      clientId: 'stale-client-id',
      clientSecret: 'stale-client-secret'
    }
  });
  assert.equal(body.client_id, 'current-client-id');
  assert.equal(body.client_secret, 'current-client-secret');
  assert.equal(body.refresh_token, 'current-refresh-token');
});

test('incomplete modern credentials still fail closed without network access', async (t) => {
  const credentialsPath = await credentialFile(t, {
    tokens: { default: { refresh_token: 'refresh-token-without-client' } }
  });
  let fetchCalled = false;
  const reply = await callWebAppAction({
    deploymentId: 'test-deployment',
    action: 'webAppHandshake',
    credentialsPath,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('network must not be called');
    }
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'NO_CREDENTIALS');
  assert.equal(fetchCalled, false);
});
