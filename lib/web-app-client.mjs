/* HTTP transport for the companion's web app JSON API (Code.gs doGet/doPost).
 *
 * Why this exists: scripts.run (clasp run-function) requires the project to be
 * deployed with an API-executable entry point plus a shared standard Cloud
 * project. This product's deployments never have either -- verified 2026-10-07
 * with projects.deployments.get (entryPoints holds a single WEB_APP entry) --
 * while the same project executed fine through the web app URL. clasp
 * run-function answered every attempt, including on a freshly created minimal
 * project, with a misleading "reading from storage ... NOT_FOUND".
 *
 * Token source: the OAuth credentials the user already created with
 * `clasp login`. Measured 2026-10-07: any one `script.*` scope plus
 * `drive.file` passes the web app's MYSELF gate (drive.metadata.readonly does
 * NOT, and cloud-platform alone does not either). The token source is kept
 * behind this module so a first-party OAuth client can replace it without
 * touching any call site.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const WEB_APP_DEFAULT_TIMEOUT_MS = 180000;

/* Only reads may be retried blindly: syncAll applies deletions and
 * setupWizardSavePreferences writes preferences, so neither is idempotent. */
const IDEMPOTENT_ACTIONS = new Set(['webAppHandshake', 'setupWizardOverview']);

export function claspCredentialsPath() {
  return process.env.TASKSTODOSYNC_CLASP_CREDENTIALS || join(homedir(), '.clasprc.json');
}

export function webAppUrlFor(deploymentId, { dev = false } = {}) {
  const base = `https://script.google.com/macros/s/${encodeURIComponent(deploymentId)}`;
  return dev ? `${base}/dev` : `${base}/exec`;
}

async function loadAccessToken({ credentialsPath, fetchImpl }) {
  const path = credentialsPath || claspCredentialsPath();
  let raw = null;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw Object.assign(
      new Error(`The clasp credentials at ${path} could not be read (${error.code ?? error.message}). Run clasp login first.`),
      { code: 'NO_CREDENTIALS' }
    );
  }
  const settings = raw.oauth2ClientSettings ?? {};
  const record = raw.token ?? (raw.tokens && raw.tokens.default) ?? null;
  if (!record || !record.refresh_token || !settings.clientId || !settings.clientSecret) {
    throw Object.assign(
      new Error('The clasp credentials are incomplete. Run clasp login first.'),
      { code: 'NO_CREDENTIALS' }
    );
  }
  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    refresh_token: record.refresh_token,
    grant_type: 'refresh_token'
  });
  let response = null;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', body });
  } catch (error) {
    throw Object.assign(new Error(`Refreshing the clasp OAuth token failed: ${error.message}`), { code: 'TOKEN_REFRESH_FAILED' });
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(`Refreshing the clasp OAuth token failed with HTTP ${response.status}. Run clasp login again.`),
      { code: 'TOKEN_REFRESH_FAILED' }
    );
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw Object.assign(
      new Error('The OAuth token refresh did not return an access token. Run clasp login again.'),
      { code: 'TOKEN_REFRESH_FAILED' }
    );
  }
  return payload.access_token;
}

/* Calls one whitelisted action on the deployed web app and returns
 *   { ok: true,  result, rawText }                       on success, or
 *   { ok: false, error: { code, message }, rawText }     on failure.
 * Never throws: every failure mode is folded into the envelope so callers can
 * branch on ok and surface the code. */
export async function callWebAppAction({
  deploymentId,
  action,
  params = [],
  dev = false,
  credentialsPath,
  fetchImpl = fetch,
  timeoutMs = WEB_APP_DEFAULT_TIMEOUT_MS
} = {}) {
  if (!deploymentId) {
    return {
      ok: false,
      error: { code: 'NO_DEPLOYMENT', message: 'No deployment id is known for this target; reinstall to connect.' },
      rawText: ''
    };
  }
  let token = null;
  try {
    token = await loadAccessToken({ credentialsPath, fetchImpl });
  } catch (error) {
    return { ok: false, error: { code: error.code ?? 'TOKEN_ERROR', message: error.message }, rawText: '' };
  }
  const url = webAppUrlFor(deploymentId, { dev });
  const attempts = IDEMPOTENT_ACTIONS.has(action) ? 2 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params }),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      let envelope = null;
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = null;
      }
      if (!envelope || typeof envelope !== 'object' || !('ok' in envelope)) {
        // Web apps cannot set HTTP status codes: an HTML error page arrives as
        // HTTP 200 (measured: "錯誤 — 找不到以下指令碼函式：doPost"). A body that
        // is not our JSON envelope is therefore always a failure.
        throw Object.assign(
          new Error(`The web app answered HTTP ${response.status} with a non-JSON body (${text.length} bytes).`),
          { code: 'NON_JSON_RESPONSE', rawText: text.slice(0, 4000) }
        );
      }
      if (envelope.ok) {
        return { ok: true, result: envelope.result ?? null, rawText: text };
      }
      return {
        ok: false,
        error: envelope.error ?? { code: 'REMOTE_ERROR', message: 'The web app reported a failure without details.' },
        rawText: text
      };
    } catch (error) {
      lastError = error;
      if (error.code === 'NON_JSON_RESPONSE' || attempt >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  return {
    ok: false,
    error: { code: lastError?.code ?? 'TRANSPORT_ERROR', message: lastError?.message ?? 'The web app call failed.' },
    rawText: lastError?.rawText ?? ''
  };
}
