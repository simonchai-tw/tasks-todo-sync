// VM integration coverage for real Code.gs control flow. This is not an Apps
// Script wall-clock benchmark: providers are deterministic in-memory mocks.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const TASK_COUNT = 600;
const PAGE_SIZE = 100;
const clone = (x) => JSON.parse(JSON.stringify(x));
const gid = (i) => `g-list-${String(i).padStart(2, '0')}`;
const mid = (i) => `ms-list-${String(i).padStart(2, '0')}`;
const gtid = (i) => `g-task-${String(i).padStart(4, '0')}`;
const mtid = (i) => `ms-task-${String(i).padStart(4, '0')}`;
function stamp(i, add = 0) { const n = i + add, day = n % 86400; return `2026-08-29T${String(Math.floor(day / 3600)).padStart(2, '0')}:${String(Math.floor(day / 60) % 60).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}.000Z`; }
function propStore(initial = {}) {
  const values = { ...initial };
  return { values, getProperty: (k) => Object.hasOwn(values, k) ? values[k] : null,
    getProperties: () => ({ ...values }), getKeys: () => Object.keys(values),
    setProperty: (k, v) => { values[k] = String(v); },
    setProperties: (o) => Object.entries(o).forEach(([k, v]) => { values[k] = String(v); }),
    deleteProperty: (k) => { delete values[k]; } };
}
function blob(v) { const b = Buffer.from(typeof v === 'string' ? v : v || []); return { getBytes: () => Array.from(b), getDataAsString: () => b.toString('utf8') }; }
function appsUtilities() { return {
  DigestAlgorithm: { SHA_256: 'SHA-256' }, Charset: { UTF_8: 'UTF-8' }, newBlob: blob,
  gzip: (v) => blob(gzipSync(Buffer.from(v.getBytes()))), ungzip: (v) => blob(gunzipSync(Buffer.from(v.getBytes()))),
  base64Encode: (v) => Buffer.from(v).toString('base64'), base64Decode: (v) => Array.from(Buffer.from(v, 'base64')),
  computeDigest: (_a, v) => Array.from(createHash('sha256').update(v, 'utf8').digest()), sleep: () => {} }; }
function note(i) { return `工作事項 ${i} 😀🧪🚀\nhttps://example.invalid/task/${i}\n${'繁體中文內容 '.repeat(35)}\n\uD83D`; }

function harness({ listCount = 1, tasksPerList = TASK_COUNT, deletions = false, moves = false, unicode = false, advanceMs = 0 } = {}) {
  assert.equal(listCount * tasksPerList, TASK_COUNT, 'scenario must have exactly 600 pairs');
  const script = propStore({ SYNC_LIST_DISCOVERY_MODE: 'explicit',
    SYNC_GOOGLE_LIST_IDS: Array.from({ length: listCount }, (_, i) => gid(i)).join(','),
    SYNC_LIST_PAIRS_JSON: JSON.stringify(Array.from({ length: listCount }, (_, i) => ({ googleListId: gid(i), microsoftListId: mid(i) }))),
    SYNC_ALLOW_DELETIONS: String(deletions), SYNC_ALLOW_LIST_DELETIONS: 'false', SYNC_ALLOW_TASK_MOVES: String(moves) });
  const user = propStore(); const logs = [];
  const context = vm.createContext({ console: { log: (v) => logs.push(String(v)), warn: (v) => logs.push(String(v)), error: (v) => logs.push(String(v)) },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user }, Utilities: appsUtilities() });
  new vm.Script(CODE, { filename: 'Code.gs' }).runInContext(context);
  context.withGlobalLock_ = (fn) => fn(); context.sendFatalAlert_ = () => {};
  const p = { googleLists: [], microsoftLists: [], google: new Map(), microsoft: new Map(), gPages: 0, msPages: 0, gListPages: 0, msListPages: 0, gWrites: 0, msWrites: 0, gDeletes: 0, msDeletes: 0, calls: [], fail: null, sequence: 0 };
  for (let i = 0; i < listCount; i++) { p.googleLists.push({ id: gid(i), title: `VM list ${i}` }); p.microsoftLists.push({ id: mid(i), displayName: `VM list ${i}`, isOwner: true, isShared: false, wellknownListName: 'none' }); p.google.set(gid(i), []); p.microsoft.set(mid(i), []); }
  const state = context.newState_();
  for (let i = 0; i < listCount; i++) state.listMap[gid(i)] = mid(i);
  for (let i = 0; i < TASK_COUNT; i++) {
    const list = Math.floor(i / tasksPerList), updated = stamp(i), text = unicode ? note(i) : `note ${i}`;
    const g = { id: gtid(i), title: `Task ${i}`, notes: text, status: 'needsAction', updated };
    const m = { id: mtid(i), title: `Task ${i}`, body: { contentType: 'html', content: text.replace(/\n/g, '<br>') }, status: 'notStarted', lastModifiedDateTime: updated };
    p.google.get(gid(list)).push(g); p.microsoft.get(mid(list)).push(m);
    state.g2m[g.id] = { msId: m.id, gListId: gid(list), msListId: mid(list), gUpdated: updated, msUpdated: updated }; state.m2g[m.id] = g.id;
  }
  context.saveState_(state);
  const payload = (o) => o && o.payload ? JSON.parse(o.payload) : {};
  const find = (map, list, id) => (map.get(list) || []).find((t) => t.id === id) || null;
  const remove = (map, list, id) => { const a = map.get(list) || [], i = a.findIndex((t) => t.id === id); if (i < 0) throw new Error('HTTP 404: task missing'); a.splice(i, 1); };
  const touchG = (t) => { t.updated = stamp(10000 + p.sequence++); return t; };
  const touchM = (t) => { t.lastModifiedDateTime = stamp(10000 + p.sequence++); return t; };
  const page = (a, token, field, counter, next) => { p[counter]++; const start = Number(token || 0), values = a.slice(start, start + PAGE_SIZE).map(clone), more = start + PAGE_SIZE < a.length ? String(start + PAGE_SIZE) : null; return field === 'items' ? { items: values, ...(more ? { nextPageToken: more } : {}) } : { value: values, ...(more ? { '@odata.nextLink': next(more) } : {}) }; };
  const fail = (side) => { if (!p.fail || p.fail.side !== side) return; const f = p.fail; p.fail = null; throw new Error(`HTTP ${f.status}: injected ${side} provider failure`); };
  const tick = () => { if (advanceMs) { vm.runInContext(`globalThis.__vmNow += ${advanceMs};`, context); logs.push('TIME_BUDGET virtual clock advanced'); } };
  context.gFetch_ = (path, options = {}) => {
    tick(); fail('google'); const [pathname, query = ''] = path.split('?'), params = new URLSearchParams(query), method = String(options.method || 'get').toLowerCase(); p.calls.push({ side: 'google', method, path });
    if (pathname === '/users/@me/lists') { p.gListPages++; return { items: p.googleLists.map(clone) }; }
    const listed = pathname.match(/^\/users\/@me\/lists\/([^/]+)$/); if (listed && method === 'get') return clone(p.googleLists.find((x) => x.id === decodeURIComponent(listed[1])));
    const match = pathname.match(/^\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/); if (!match) throw new Error(`unexpected Google path ${path}`);
    const list = decodeURIComponent(match[1]), id = match[2] && decodeURIComponent(match[2]);
    if (!id && method === 'get') return page(p.google.get(list) || [], params.get('pageToken'), 'items', 'gPages');
    if (!id && method === 'post') { const t = touchG({ id: `g-created-${p.sequence++}`, ...payload(options) }); p.google.get(list).push(t); p.gWrites++; return clone(t); }
    if (method === 'delete') { remove(p.google, list, id); p.gDeletes++; return {}; }
    const t = find(p.google, list, id); if (!t) throw new Error('HTTP 404: task missing'); Object.assign(t, payload(options)); p.gWrites++; return clone(touchG(t));
  };
  context.graphFetch_ = (url, options = {}) => {
    tick(); fail('microsoft'); const u = new URL(url), method = String(options.method || 'get').toLowerCase(); p.calls.push({ side: 'microsoft', method, url: method === 'post' ? `${url}#mutation-${p.calls.length}` : url });
    const match = u.pathname.match(/\/me\/todo\/lists(?:\/([^/]+)(?:\/tasks(?:\/([^/]+))?)?)?$/); if (!match) throw new Error(`unexpected Microsoft URL ${url}`);
    const list = match[1] && decodeURIComponent(match[1]), id = match[2] && decodeURIComponent(match[2]);
    if (!list) { p.msListPages++; return { value: p.microsoftLists.map(clone) }; }
    if (!id && method === 'get' && !u.pathname.endsWith('/tasks')) return clone(p.microsoftLists.find((x) => x.id === list));
    if (!id && method === 'get') return page(p.microsoft.get(list) || [], u.searchParams.get('$skiptoken'), 'value', 'msPages', (n) => `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list)}/tasks?$top=100&$skiptoken=${n}`);
    if (id && method === 'get') { const t = find(p.microsoft, list, id); if (!t) throw new Error('HTTP 404: task missing'); return clone(t); }
    if (!id && method === 'post') { const t = touchM({ id: `ms-created-${p.sequence++}`, createdDateTime: new Date().toISOString(), ...payload(options) }); p.microsoft.get(list).push(t); p.msWrites++; return clone(t); }
    if (method === 'delete') { remove(p.microsoft, list, id); p.msDeletes++; return {}; }
    const t = find(p.microsoft, list, id); if (!t) throw new Error('HTTP 404: task missing'); Object.assign(t, payload(options)); p.msWrites++; return clone(touchM(t));
  };
  return { context, provider: p, user, logs, state: () => context.loadStateForSync_(), setTime: (n) => vm.runInContext(`globalThis.__vmNow = ${n}; Date.now = function() { return globalThis.__vmNow; };`, context),
    removeGoogle: () => p.google.forEach((a) => a.splice(0, a.length)), moveGoogle: () => { for (let i = 0; i < TASK_COUNT; i++) { const from = gid(Math.floor(i / tasksPerList)), to = gid((Math.floor(i / tasksPerList) + 1) % listCount), a = p.google.get(from), at = a.findIndex((t) => t.id === gtid(i)), t = a.splice(at, 1)[0]; p.google.get(to).push(touchG(t)); } } };
}
function assertIntegrity(h) { const s = h.state(); assert.equal(Object.keys(s.g2m).length, TASK_COUNT); assert.equal(Object.keys(s.m2g).length, TASK_COUNT); assert.equal(new Set(Object.values(s.g2m).map((r) => r.msId)).size, TASK_COUNT); assert.match(h.user.values.sync_state_main_manifest, /gzip-base64/); assert.deepEqual(h.context.loadStateForSync_().g2m, s.g2m); }

test('VM dense 1x600 pagination and steady no-op mapping', () => { const h = harness({ listCount: 1, tasksPerList: 600 }); h.context.syncAll(); assert.equal(h.provider.gPages, 6); assert.equal(h.provider.msPages, 6); assert.equal(h.provider.gWrites + h.provider.msWrites, 0); assertIntegrity(h); });
test('VM sparse 60x10 pagination and inventory', () => { const h = harness({ listCount: 60, tasksPerList: 10 }); h.context.syncAll(); assert.equal(h.provider.gPages, 60); assert.equal(h.provider.msPages, 60); assert.equal(h.provider.gListPages, 1); assert.equal(h.provider.msListPages, 1); assertIntegrity(h); });
test('VM 600-pair LWW edits use Google on equal timestamps', () => { const h = harness({ listCount: 1, tasksPerList: 600 }); h.provider.google.get(gid(0)).forEach((g, i) => { const m = h.provider.microsoft.get(mid(0))[i]; g.title = `Google ${i}`; m.title = `Microsoft ${i}`; if (i % 3 === 0) { g.updated = '2026-08-29T02:00:00.000Z'; m.lastModifiedDateTime = '2026-08-29T01:00:00.000Z'; } else if (i % 3 === 1) { g.updated = '2026-08-29T01:00:00.000Z'; m.lastModifiedDateTime = '2026-08-29T02:00:00.000Z'; } else g.updated = m.lastModifiedDateTime = '2026-08-29T02:00:00.000Z'; }); h.context.syncAll(); assert.equal(h.provider.msWrites, 400); assert.equal(h.provider.gWrites, 200); for (let i = 0; i < TASK_COUNT; i++) { const expected = i % 3 === 1 ? `Microsoft ${i}` : `Google ${i}`; assert.equal(h.provider.google.get(gid(0))[i].title, expected); assert.equal(h.provider.microsoft.get(mid(0))[i].title, expected); } assertIntegrity(h); });
test('VM 600 Google completions propagate to Microsoft', () => { const h = harness({ listCount: 1, tasksPerList: 600 }); h.provider.google.get(gid(0)).forEach((t) => { t.status = 'completed'; t.updated = '2026-08-29T02:00:00.000Z'; }); h.context.syncAll(); assert.equal(h.provider.msWrites, TASK_COUNT); assert.ok(h.provider.microsoft.get(mid(0)).every((t) => t.status === 'completed')); assertIntegrity(h); });
test('VM two-round deletion journals 600 missing Google tasks', () => { const h = harness({ listCount: 1, tasksPerList: 600, deletions: true }); h.removeGoogle(); h.setTime(1000); h.context.syncAll(); assert.equal(Object.keys(h.state().pendingTaskDeletions).length, TASK_COUNT); assert.equal(h.provider.msDeletes, 0); h.setTime(2000); h.context.syncAll(); const s = h.state(); assert.equal(h.provider.msDeletes, TASK_COUNT); assert.equal(new Set(h.provider.calls.filter((x) => x.method === 'delete').map((x) => x.url || x.path)).size, TASK_COUNT); assert.equal(Object.keys(s.g2m).length, 0); assert.equal(Object.keys(s.tombstones.g).length, TASK_COUNT); assert.equal(Object.keys(s.tombstones.m).length, TASK_COUNT); });
test('VM Google-origin moves across two paired lists have no duplicate mutations', () => { const h = harness({ listCount: 2, tasksPerList: 300, moves: true }); h.moveGoogle(); h.context.syncAll(); const s = h.state(); assert.equal(h.provider.msWrites, TASK_COUNT); assert.equal(h.provider.msDeletes, TASK_COUNT); assert.equal(Object.keys(s.taskMoveJournal).length, 0); assert.equal(new Set(h.provider.calls.filter((x) => x.method === 'post').map((x) => x.url)).size, TASK_COUNT); assert.equal(new Set(h.provider.calls.filter((x) => x.method === 'delete').map((x) => x.url)).size, TASK_COUNT); assertIntegrity(h); });
test('VM long Unicode payload survives 600 Google-to-Microsoft updates', () => { const h = harness({ listCount: 1, tasksPerList: 600, unicode: true }); h.provider.google.get(gid(0)).forEach((t) => { t.notes += '\n追加変更'; t.updated = '2026-08-29T02:00:00.000Z'; }); h.context.syncAll(); assert.equal(h.provider.msWrites, TASK_COUNT); assert.ok(h.provider.microsoft.get(mid(0)).every((t) => t.body.content.includes('工作事項') && t.body.content.includes('😀'))); assertIntegrity(h); });
test('VM injected provider failure and controllable time budget fail closed', () => { const failed = harness({ listCount: 1, tasksPerList: 600 }); failed.provider.fail = { side: 'google', status: 500 }; assert.throws(() => failed.context.syncAll(), /HTTP 500/); assert.equal(failed.provider.gWrites + failed.provider.msWrites, 0); assertIntegrity(failed); const timed = harness({ listCount: 1, tasksPerList: 600, advanceMs: 300000 }); timed.setTime(1000); assert.equal(timed.context.syncAll(), undefined); assert.equal(timed.provider.gWrites + timed.provider.msWrites, 0); assertIntegrity(timed); assert.ok(timed.logs.some((x) => x.includes('Near time limit') || x.includes('TIME_BUDGET'))); });
