#!/usr/bin/env node
/**
 * CT Contract Probes — Direct REST API execution from Node.js.
 * Uses clasp OAuth token for Google Tasks API.
 * Uses a GAS web app endpoint for Microsoft Graph calls.
 * 
 * Usage: node scripts/ct-probes-live.mjs
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GTASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

// --- Token Management ---
async function getGoogleToken() {
  const clasprc = JSON.parse(readFileSync(join(homedir(), '.clasprc.json'), 'utf8'));
  const tokenData = clasprc.tokens['tts-disposable'];
  
  // Refresh the token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokenData.client_id,
      client_secret: tokenData.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

// --- Google Tasks API Helpers ---
async function gFetch(token, path, opts = {}) {
  const url = GTASKS_BASE + path;
  const resp = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Google API ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getGLists(token) {
  const resp = await gFetch(token, '/users/@me/lists');
  return resp.items || [];
}

async function createGTask(token, listId, task) {
  return gFetch(token, `/lists/${encodeURIComponent(listId)}/tasks`, {
    method: 'POST', body: task
  });
}

async function getGTask(token, listId, taskId) {
  return gFetch(token, `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`);
}

async function updateGTask(token, listId, taskId, patch) {
  return gFetch(token, `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', body: patch
  });
}

async function deleteGTask(token, listId, taskId) {
  return gFetch(token, `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE'
  });
}

async function createGChildTask(token, listId, parentId, task) {
  return gFetch(token, `/lists/${encodeURIComponent(listId)}/tasks?parent=${encodeURIComponent(parentId)}`, {
    method: 'POST', body: task
  });
}

async function moveGTask(token, listId, taskId, parentId) {
  const url = `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/move` +
    (parentId ? `?parent=${encodeURIComponent(parentId)}` : '');
  return gFetch(token, url, { method: 'POST' });
}

async function getAllGTasks(token, listId) {
  let all = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await gFetch(token, `/lists/${encodeURIComponent(listId)}/tasks?${params}`);
    if (resp && resp.items) all = all.concat(resp.items);
    pageToken = resp && resp.nextPageToken;
  } while (pageToken);
  return all;
}

// --- CT Probes ---

async function ct01(token, listId) {
  console.log('\n=== CT-01: Google child insert under parent ===');
  const parent = await createGTask(token, listId, { title: 'CT01-Parent-' + Date.now() });
  console.log('  Parent:', parent.id, parent.title);

  const child = await createGChildTask(token, listId, parent.id, {
    title: 'CT01-Child-' + Date.now(), status: 'needsAction'
  });
  console.log('  Child:', child.id, 'parent field:', child.parent);

  const readBack = await getGTask(token, listId, child.id);
  const pass = readBack.parent === parent.id;
  console.log('  Read-back parent:', readBack.parent, pass ? 'PASS' : 'FAIL');

  await deleteGTask(token, listId, child.id);
  await deleteGTask(token, listId, parent.id);
  return { ct: 'CT-01', pass, parentId: parent.id, childParent: readBack.parent };
}

async function ct02(token, listId) {
  console.log('\n=== CT-02: Google child ordering with previous ===');
  const parent = await createGTask(token, listId, { title: 'CT02-Parent-' + Date.now() });

  // Create first child
  const child1 = await createGChildTask(token, listId, parent.id, {
    title: 'CT02-Child1-' + Date.now(), status: 'needsAction'
  });
  // Create second child (should appear at front without `previous`)
  const child2 = await createGChildTask(token, listId, parent.id, {
    title: 'CT02-Child2-' + Date.now(), status: 'needsAction'
  });

  // Read back to check order
  const c1 = await getGTask(token, listId, child1.id);
  const c2 = await getGTask(token, listId, child2.id);
  
  // child2 should have position < child1 (inserted at front)
  const pass = c2.position < c1.position;
  console.log('  child1 position:', c1.position, 'child2 position:', c2.position, pass ? 'PASS' : 'FAIL');

  await deleteGTask(token, listId, child2.id);
  await deleteGTask(token, listId, child1.id);
  await deleteGTask(token, listId, parent.id);
  return { ct: 'CT-02', pass, c1Pos: c1.position, c2Pos: c2.position };
}

async function ct08(token, listId) {
  console.log('\n=== CT-08: Google same-list reparent preserves task ID ===');
  const parentA = await createGTask(token, listId, { title: 'CT08-ParentA-' + Date.now() });
  const parentB = await createGTask(token, listId, { title: 'CT08-ParentB-' + Date.now() });
  
  const child = await createGChildTask(token, listId, parentA.id, {
    title: 'CT08-Child-' + Date.now(), status: 'needsAction'
  });
  const originalId = child.id;
  console.log('  Original child ID:', originalId, 'parent:', parentA.id);

  // Move child to parentB
  const moved = await moveGTask(token, listId, child.id, parentB.id);
  console.log('  Moved child ID:', moved.id, 'new parent:', moved.parent);

  const pass = moved.id === originalId && moved.parent === parentB.id;
  console.log('  ', pass ? 'PASS' : 'FAIL');

  await deleteGTask(token, listId, child.id);
  await deleteGTask(token, listId, parentA.id);
  await deleteGTask(token, listId, parentB.id);
  return { ct: 'CT-08', pass, originalId, movedId: moved.id, newParent: moved.parent };
}

async function ct09(token, listId) {
  console.log('\n=== CT-09: Parent deletion → child becomes top-level ===');
  const parent = await createGTask(token, listId, { title: 'CT09-Parent-' + Date.now() });
  const child = await createGChildTask(token, listId, parent.id, {
    title: 'CT09-Orphan-' + Date.now(), status: 'needsAction'
  });
  console.log('  Child before:', child.id, 'parent:', child.parent);

  await deleteGTask(token, listId, parent.id);
  await sleep(500);

  const childAfter = await getGTask(token, listId, child.id);
  const pass = !!childAfter && !childAfter.parent;
  console.log('  Child after parent deletion:', childAfter ? 'survived' : 'GONE', 'parent:', childAfter?.parent || 'null');
  console.log('  ', pass ? 'PASS' : 'FAIL');

  if (childAfter) await deleteGTask(token, listId, child.id);
  return { ct: 'CT-09', pass, childSurvived: !!childAfter, parentAfter: childAfter?.parent || null };
}

async function ct10(token, listId) {
  console.log('\n=== CT-10: Parent completion does NOT cascade to children ===');
  const parent = await createGTask(token, listId, { title: 'CT10-Parent-' + Date.now() });
  const child = await createGChildTask(token, listId, parent.id, {
    title: 'CT10-Child-' + Date.now(), status: 'needsAction'
  });

  // Complete parent
  await updateGTask(token, listId, parent.id, { status: 'completed' });
  await sleep(1000);

  const childAfter = await getGTask(token, listId, child.id);
  const pass = childAfter && childAfter.status === 'needsAction';
  console.log('  Child status after parent completed:', childAfter?.status, pass ? 'PASS' : 'FAIL');

  await deleteGTask(token, listId, child.id);
  await deleteGTask(token, listId, parent.id);
  return { ct: 'CT-10', pass, childStatus: childAfter?.status };
}

async function ct11_google(token, listId) {
  console.log('\n=== CT-11: Title Unicode NFC round-trip (Google) ===');
  const titles = [
    'CT11-ASCII-Simple',
    'CT11-中文測試-繁體',
    'CT11-Café-résumé',
    'CT11-🎯-emoji-test',
    'CT11-  spaces  trim  '
  ];
  const results = [];
  for (const title of titles) {
    const task = await createGTask(token, listId, { title });
    const readBack = await getGTask(token, listId, task.id);
    const match = readBack.title === title;
    results.push({ original: title, readBack: readBack.title, match });
    console.log(`  "${title}" → "${readBack.title}" ${match ? '✓' : '✗'}`);
    await deleteGTask(token, listId, task.id);
  }
  const pass = results.every(r => r.match);
  console.log('  ', pass ? 'PASS' : 'FAIL');
  return { ct: 'CT-11-google', pass, results };
}

async function cleanAllGoogleTasks(token) {
  console.log('\n=== Cleaning all Google Tasks ===');
  const lists = await getGLists(token);
  let total = 0;
  for (const list of lists) {
    const tasks = await getAllGTasks(token, list.id);
    for (const task of tasks) {
      await deleteGTask(token, list.id, task.id);
      total++;
    }
    console.log(`  ${list.title}: ${tasks.length} tasks deleted`);
  }
  console.log(`  Total: ${total} tasks cleaned across ${lists.length} lists`);
  return { cleaned: total, lists: lists.length };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Main ---
async function main() {
  console.log('Tasks-ToDo-Sync CT Contract Probes — Live Execution');
  console.log('================================================');
  console.log('Time:', new Date().toISOString());

  const token = await getGoogleToken();
  console.log('Token refreshed ✓');

  const lists = await getGLists(token);
  console.log('Google Task Lists:', lists.map(l => l.title).join(', '));
  if (!lists.length) { console.error('No lists!'); process.exit(1); }
  const listId = lists[0].id;
  console.log('Using list:', lists[0].title, '(' + listId + ')');

  // Clean first
  await cleanAllGoogleTasks(token);
  
  // Run Google-side CT probes
  const results = {};
  results['CT-01'] = await ct01(token, listId);
  results['CT-02'] = await ct02(token, listId);
  results['CT-08'] = await ct08(token, listId);
  results['CT-09'] = await ct09(token, listId);
  results['CT-10'] = await ct10(token, listId);
  results['CT-11-google'] = await ct11_google(token, listId);

  // Summary
  console.log('\n\n========== CT PROBE SUMMARY ==========');
  let allPass = true;
  for (const [name, r] of Object.entries(results)) {
    const status = r.pass ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${name}: ${status}`);
    if (!r.pass) allPass = false;
  }
  console.log('======================================');
  console.log(allPass ? '🎉 ALL GOOGLE-SIDE PROBES PASSED' : '⚠️ SOME PROBES FAILED');
  
  // Output JSON
  console.log('\n--- JSON EVIDENCE ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
