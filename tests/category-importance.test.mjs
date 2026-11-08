import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* v1.2.0 / P1-4 — category / importance opt-in + dry-run + "no marker = no
 * opinion".  The point of this file is to LOCK IN DATA-LOSS SAFETY:
 *   - opt-in OFF (default) or preview/apply not confirmed => ZERO MS writes;
 *   - Google "no [!] / no #tag" is Leave Alone, never normal / [];
 *   - an existing Microsoft high / category is preserved 100%;
 *   - MS 'low' is never mapped or overwritten;
 *   - only a proven "last round had a marker, this round the user removed it,
 *     and MS still equals what we last wrote" may clear.
 *
 * The two fingerprints (importanceFp / categoriesFp) run an INDEPENDENT
 * three-way chain; they never enter ORDINARY_SHARED_FIELDS_ and never produce
 * field conflicts (construction decision 1).  The title marker is never
 * stripped from the title text (decision 2).  The dry-run is a separate
 * two-stage preview / apply pair, not an extension of dryRunReport() (decision
 * 3), and its report contains only opaque ids / marker kinds / target values —
 * never user title or notes text (existing privacy boundary).
 */

function blob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

function store(values) {
  return {
    values: { ...values },
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; },
    getProperties() { return { ...this.values }; },
    getKeys() { return Object.keys(this.values); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); },
    deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; }
  };
}

function load(scriptValues = {}) {
  const script = store(scriptValues);
  const user = store({});
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => script,
      getUserProperties: () => user
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    // withGlobalLock_ (used by the two-stage preview/apply) needs a script lock.
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }),
      getUserLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      newBlob: blob,
      gzip: (b) => blob(gzipSync(Buffer.from(b.getBytes()))),
      ungzip: (b) => blob(gunzipSync(Buffer.from(b.getBytes()))),
      base64Encode: (d) => Buffer.from(typeof d === 'string' ? d : d).toString('base64'),
      base64Decode: (d) => Array.from(Buffer.from(d, 'base64')),
      computeDigest: (_a, d) => Array.from(createHash('sha256').update(d, 'utf8').digest()),
      formatDate: () => '2026-08-21',
      sleep() {}
    }
  });
  runGasFilesInContext(c);
  c.console = { log() {}, warn() {}, error() {} };
  return { c, script, user };
}

/* A fully converged ordinary pair (title/notes/completed/due all equal), so
 * the ONLY possible Microsoft PATCH would be an importance/categories write.
 * This is what makes "zero MS writes" assertable via updateMsTask_ counting. */
function pair(c, opts = {}) {
  const gTitle = opts.gTitle === undefined ? 'Same' : opts.gTitle;
  const gNotes = opts.gNotes === undefined ? 'note' : opts.gNotes;
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  const rec = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z'
  };
  if (opts.fp) rec.fp = opts.fp;
  state.g2m['g-task'] = rec;
  state.m2g['ms-task'] = 'g-task';
  const gTask = {
    id: 'g-task', title: gTitle, notes: gNotes, status: 'needsAction',
    due: '2026-08-21T00:00:00.000Z', updated: '2026-08-14T00:00:00Z'
  };
  const msTask = {
    id: 'ms-task', title: gTitle, // decision 2: the marker is NOT stripped
    body: { contentType: 'text', content: gNotes },
    status: 'notStarted',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'UTC' },
    lastModifiedDateTime: '2026-08-14T00:00:00Z'
  };
  if (opts.msImportance !== undefined) msTask.importance = opts.msImportance;
  if (opts.msCategories !== undefined) msTask.categories = opts.msCategories;
  return { state, rec, gTask, msTask };
}

function armGate(c, state, enabled = true, confirmed = true) {
  c.setCategoryImportanceRound_({ enabled, confirmed, state, safety: {} });
}

function stubWrites(c, msTask) {
  const gPatches = [];
  const msPatches = [];
  c.updateGTask_ = (list, id, payload) => {
    gPatches.push(payload);
    return { id, title: payload.title, notes: payload.notes, status: payload.status, due: payload.due, updated: '2026-08-15T00:00:00Z' };
  };
  c.updateMsTask_ = (list, id, payload) => {
    msPatches.push(payload);
    return Object.assign({}, msTask, payload); // simulate the post-PATCH readback
  };
  c.createMsLinkedResourceNoRetry_ = () => { throw new Error('native linkedResources create must not run'); };
  return { gPatches, msPatches };
}

// Objects/arrays created inside the GAS vm belong to a different realm, so
// Node's strict deepEqual rejects them on prototype identity even when the
// structure is identical.  Normalise both sides through JSON first.
function plain(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}
function deep(actual, expected, msg) {
  assert.deepEqual(plain(actual), plain(expected), msg);
}

const HEX32 = /^[0-9a-f]{32}$/;
// globals.gs declares this with `const` (a vm lexical binding, NOT a property
// of the global object), so it cannot be read as c.CATEGORY_IMPORTANCE_CONFIRMATION.
const CONFIRM = 'I_CONFIRM_CATEGORY_IMPORTANCE_MS_WRITES';

/* ------------------------------------------------------------------ */

test('1. knob: default false, strict true/false, bounded invalid code; ordinaryEmptyFp_ gains two nulls', () => {
  const { c } = load();
  assert.equal(c.getSafetyConfig_().enableCategoryImportance, false, 'opt-in OFF by default');
  assert.equal(load({ SYNC_ENABLE_CATEGORY_IMPORTANCE: 'true' }).c.getSafetyConfig_().enableCategoryImportance, true);
  assert.equal(load({ SYNC_ENABLE_CATEGORY_IMPORTANCE: ' false ' }).c.getSafetyConfig_().enableCategoryImportance, false);
  assert.equal(load({ SYNC_ENABLE_CATEGORY_IMPORTANCE: ' TRUE ' }).c.getSafetyConfig_().enableCategoryImportance, true);
  const bad = load({ SYNC_ENABLE_CATEGORY_IMPORTANCE: 'yes' }).c;
  assert.throws(() => bad.getSafetyConfig_(), /SYNC_CATEGORY_IMPORTANCE_FLAG_INVALID/);
  let err;
  try { bad.getSafetyConfig_(); } catch (e) { err = e; }
  assert.equal(c.boundedSafetyConfigIssue_(err),
    'SAFETY_CONFIGURATION_INVALID:SYNC_CATEGORY_IMPORTANCE_FLAG_INVALID');
  deep(c.ordinaryEmptyFp_(), {
    v: 1, title: null, notes: null, completed: null, due: null,
    importanceFp: null, categoriesFp: null
  });
});

test('2. first round, no Google marker -> ZERO MS writes on BOTH write paths', () => {
  // opt-in is ON, but preview/apply was NOT confirmed yet (confirmed=false).
  const { c } = load({ SYNC_ENABLE_CATEGORY_IMPORTANCE: 'true' });
  const { state, rec, gTask, msTask } = pair(c, { msImportance: 'high', msCategories: ['Work'] });
  armGate(c, state, true, false);
  const writes = stubWrites(c, msTask);

  // path A: providers.gs create + update payload builders
  const createPayload = c.msPayloadFromGoogle_(gTask, 'create');
  const updatePayload = c.msUpdatePayloadFromGoogle_(gTask, msTask);
  // path B: field-merge.gs patch builder
  const patchPayload = c.ordinaryMicrosoftPatchFromPlan_({ toMicrosoft: {} });
  for (const p of [createPayload, updatePayload, patchPayload]) {
    assert.equal(Object.hasOwn(p, 'importance'), false);
    assert.equal(Object.hasOwn(p, 'categories'), false);
  }

  // the merged-pair main flow must not even call updateMsTask_
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {});
  assert.equal(writes.msPatches.length, 0, 'updateMsTask_ must NOT be called');
  deep(
    c.categoryImportanceMsDelta_(gTask, msTask, rec, c.CATEGORY_IMPORTANCE_ROUND_).fields, {});
});

test('3. confirmed + Google unmarked: existing MS high / category preserved 100%', () => {
  const { c } = load({ SYNC_ENABLE_CATEGORY_IMPORTANCE: 'true' });
  const { state, rec, gTask, msTask } = pair(c, { msImportance: 'high', msCategories: ['Work'] });
  armGate(c, state, true, true);
  const writes = stubWrites(c, msTask);
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {});
  assert.equal(writes.msPatches.length, 0, 'no PATCH at all for an unmarked task');
  assert.equal(msTask.importance, 'high');
  deep(msTask.categories, ['Work']);
  // Even the update builder must leave both fields completely untouched.
  const p = c.msUpdatePayloadFromGoogle_(gTask, msTask);
  assert.equal(Object.hasOwn(p, 'importance'), false);
  assert.equal(Object.hasOwn(p, 'categories'), false);
});

test('4. MS low importance is never mapped or overwritten', () => {
  const { c } = load();
  // Google has a positive [!] marker, but MS importance is 'low'.
  const { state, rec, gTask, msTask } = pair(c, { gTitle: '[!] 買牛奶', msImportance: 'low' });
  armGate(c, state, true, true);
  const writes = stubWrites(c, msTask);
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {});
  assert.equal(writes.msPatches.length, 0, 'low is skipped entirely, no importance PATCH');
  const d = c.categoryImportanceMsDelta_(gTask, msTask, rec, c.CATEGORY_IMPORTANCE_ROUND_);
  assert.equal(Object.hasOwn(d.fields, 'importance'), false);
  const p = c.msUpdatePayloadFromGoogle_(gTask, msTask);
  assert.equal(Object.hasOwn(p, 'importance'), false);
});

test('5. Leave Alone three-way: null fp never derives normal/[], removal clears only when MS unchanged', () => {
  const { c } = load();
  const gate = { enabled: true, confirmed: true, state: { g2m: {} }, safety: {} };
  const highFp = c.categoryImportanceFp_('importance', 'high');
  const workFp = c.categoryImportanceFp_('categories', 'Work');

  // (a) fp = null (unknown) + Google unmarked + MS high/Work => never derive normal/[]
  const a = pair(c, { msImportance: 'high', msCategories: ['Work'] });
  deep(c.categoryImportanceMsDelta_(a.gTask, a.msTask, a.rec, gate).fields, {});

  // (b) last round HAD a marker, this round Google explicitly removed it,
  //     and MS still equals what we last wrote => clear (normal / [])
  const b = pair(c, { msImportance: 'high', msCategories: ['Work'] });
  b.rec.fp = Object.assign(c.ordinaryEmptyFp_(), { importanceFp: highFp, categoriesFp: workFp });
  const dB = c.categoryImportanceMsDelta_(b.gTask, b.msTask, b.rec, gate);
  assert.equal(dB.fields.importance, 'normal');
  deep(dB.fields.categories, []);

  // (c) MS was edited by the user (normal / renamed 'Office') => do NOT clear
  const cc = pair(c, { msImportance: 'normal', msCategories: ['Office'] });
  cc.rec.fp = Object.assign(c.ordinaryEmptyFp_(), { importanceFp: highFp, categoriesFp: workFp });
  const dC = c.categoryImportanceMsDelta_(cc.gTask, cc.msTask, cc.rec, gate);
  assert.equal(Object.hasOwn(dC.fields, 'importance'), false);
  assert.equal(Object.hasOwn(dC.fields, 'categories'), false);

  // (d) Google tag unchanged while MS category was renamed => Leave Alone,
  //     never resurrect the old #tag (C7 last-written-name protection).
  const d = pair(c, { gNotes: 'note\n#Work', msCategories: ['Office'] });
  d.rec.fp = Object.assign(c.ordinaryEmptyFp_(), { categoriesFp: workFp });
  const dD = c.categoryImportanceMsDelta_(d.gTask, d.msTask, d.rec, gate);
  assert.equal(Object.hasOwn(dD.fields, 'categories'), false);
});

test('6. syntax boundaries: [!NOTE], ★★★★★, mid-line [!] do not trigger; [!] / ★ + space do', () => {
  const { c } = load();
  const R = c.categoryImportanceTitleHigh_;
  assert.equal(R('[!] 買牛奶'), 'high');
  assert.equal(R('★ 買牛奶'), 'high');
  assert.equal(R('[!NOTE] 買牛奶'), null, 'Markdown callout');
  assert.equal(R('[!IMPORTANT] 買牛奶'), null, 'Markdown callout');
  assert.equal(R('★★★★★'), null, 'star rating');
  assert.equal(R('買 [!] 牛奶'), null, 'not at start');
  assert.equal(R('[!]'), null, 'marker without trailing whitespace');
  assert.equal(R('★'), null);

  const T = (notes, rec) => c.categoryImportanceTagsFromGoogle_({ id: 'x', notes }, rec || null).categories;
  deep(T('買牛奶\n#Work'), ['Work']);
  deep(T('#Work'), ['Work']);
  deep(T('買牛奶\n#Work\n'), ['Work'], 'trailing blank lines popped');
  deep(T('買牛奶 #Work'), null, 'mixed-text line');
  deep(T('#Work\n買牛奶'), null, 'tag not on the last line');
  deep(T('買牛奶'), null, 'no tag');
  deep(T('買牛奶\n#Work #Home'), ['Work', 'Home'], 'whole line of #tags');

  // a #tag on the LAST line BEFORE a well-formed managed block is recognised
  // only when rec carries the block fingerprint (OWNED).
  const block = c.RESOURCE_BLOCK_BEGIN_ + '\n[Link] x\n' + c.RESOURCE_BLOCK_END_;
  const ownedRec = { res: { gBlockFp: c.managedBlockFingerprint_(block) } };
  deep(T('買牛奶\n#Work\n\n' + block, ownedRec), ['Work']);
});

test('7. MALFORMED / AMBIGUOUS notes: whole column skipped (NOTES_UNMERGEABLE), no raw-userNotes fallback', () => {
  const { c } = load();
  const malformed = '買牛奶\n#Work\n' + c.RESOURCE_BLOCK_BEGIN_ + '\nx\n' + c.RESOURCE_BLOCK_BEGIN_;
  const r1 = c.categoryImportanceTagsFromGoogle_({ id: 'x', notes: malformed }, null);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, c.RESOURCE_BLOCK_STATUS_.MALFORMED);
  assert.equal(r1.categories, null);

  const block = c.RESOURCE_BLOCK_BEGIN_ + '\n[Link] x\n' + c.RESOURCE_BLOCK_END_;
  const ambiguousRec = { res: { gBlockFp: 'a'.repeat(32) } }; // deliberately mismatched
  const r2 = c.categoryImportanceTagsFromGoogle_(
    { id: 'x', notes: '買牛奶\n#Work\n\n' + block }, ambiguousRec);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, c.RESOURCE_BLOCK_STATUS_.AMBIGUOUS);
  assert.equal(r2.categories, null);

  // Even though the raw full text contains '#Work', the delta must NOT fall
  // back to it.  The independent title chain still works on its own.
  armGate(c, c.newState_(), true, true);
  const gTask = { id: 'x', title: '[!] 買牛奶', notes: malformed };
  // MS is 'normal' so the positive [!] marker really needs a write; MALFORMED
  // notes must still suppress ONLY the categories column.
  const msTask = { importance: 'normal', categories: ['Work'] };
  const d = c.categoryImportanceMsDelta_(gTask, msTask, { fp: c.ordinaryEmptyFp_() }, c.CATEGORY_IMPORTANCE_ROUND_);
  assert.equal(Object.hasOwn(d.fields, 'categories'), false, 'no fallback to raw userNotes');
  assert.equal(d.fields.importance, 'high', 'title marker is an independent chain');
});

test('8. two-stage: unconfirmed zero writes; wrong confirmation rejected; stale/altered token rejected; reset', () => {
  const { c } = load({
    SYNC_ENABLE_CATEGORY_IMPORTANCE: 'true',
    SYNC_GOOGLE_LIST_IDS: 'g-list'
  });
  const oneMarked = () => [{ id: 'g-task', title: '[!] 買牛奶', notes: 'note\n#Work', status: 'needsAction' }];
  c.getGLists_ = () => [{ id: 'g-list', title: 'My Tasks' }];
  c.getGTasks_ = oneMarked;

  const gTask = { id: 'g-task', title: '[!] 買牛奶', notes: 'note\n#Work' };
  const msTask = { importance: 'normal', categories: [] };

  // (a) unconfirmed -> gate inert -> zero writes even with a positive marker
  assert.equal(c.categoryImportanceWritesConfirmed_(), false);
  armGate(c, c.newState_(), true, c.categoryImportanceWritesConfirmed_());
  const p0 = c.msUpdatePayloadFromGoogle_(gTask, msTask);
  assert.equal(Object.hasOwn(p0, 'importance'), false);
  assert.equal(Object.hasOwn(p0, 'categories'), false);

  // (b) wrong confirmation constant is rejected
  assert.throws(
    () => c.applyCategoryImportanceConfirmation({ confirmation: 'WRONG', previewToken: 'whatever' }),
    /CATEGORY_IMPORTANCE_CONFIRMATION_REQUIRED/);

  // (c) preview is bounded + privacy preserving (no title/notes text)
  const preview = c.previewCategoryImportance();
  assert.equal(preview.enabled, true);
  assert.equal(preview.taskCount, 1);
  assert.equal(preview.items[0].importance, 'high');
  deep(preview.items[0].categories, ['Work']);
  assert.match(preview.items[0].opaqueId, /^gTask_/);
  const rendered = JSON.stringify(preview.items);
  assert.equal(rendered.includes('買牛奶'), false, 'no user title text');
  assert.equal(rendered.includes('note'), false, 'no user notes text');
  assert.equal(rendered.includes('g-task'), false, 'no raw provider id');

  // (d) altered token rejected (cf. SUBTASK_OPERATION_STALE_PREVIEW)
  assert.throws(
    () => c.applyCategoryImportanceConfirmation({
      confirmation: CONFIRM,
      previewToken: preview.previewToken + 'x'
    }), /CATEGORY_IMPORTANCE_STALE_PREVIEW/);

  // (e) inventory changed after preview -> old token is stale
  c.getGTasks_ = () => [{ id: 'g-task', title: '[!] 買牛奶', notes: 'note\n#Home', status: 'needsAction' }];
  assert.throws(
    () => c.applyCategoryImportanceConfirmation({
      confirmation: CONFIRM,
      previewToken: preview.previewToken
    }), /CATEGORY_IMPORTANCE_STALE_PREVIEW/);
  assert.equal(c.categoryImportanceWritesConfirmed_(), false, 'a rejected apply persists nothing');

  // (f) correct token + same inventory -> confirmation persisted, writes enabled
  c.getGTasks_ = oneMarked;
  const applied = c.applyCategoryImportanceConfirmation({
    confirmation: CONFIRM,
    previewToken: preview.previewToken
  });
  assert.equal(applied.applied, true);
  assert.equal(c.categoryImportanceWritesConfirmed_(), true);
  armGate(c, c.newState_(), true, true);
  const p1 = c.msUpdatePayloadFromGoogle_(gTask, msTask);
  assert.equal(p1.importance, 'high');
  deep(p1.categories, ['Work']);

  // (g) reset clears the durable acknowledgement
  const reset = c.applyCategoryImportanceConfirmation({
    confirmation: CONFIRM, reset: true
  });
  assert.equal(reset.reset, true);
  assert.equal(c.categoryImportanceWritesConfirmed_(), false);
});

test('9. state round-trip with the two new fp fields (3 rounds) + validator rejects illegal types', () => {
  const { c } = load();
  let state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = {
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-08-14T00:00:00Z', msUpdated: '2026-08-14T00:00:00Z',
    fp: Object.assign(c.ordinaryEmptyFp_(), {
      importanceFp: c.categoryImportanceFp_('importance', 'high'),
      categoriesFp: c.categoryImportanceFp_('categories', 'Work')
    })
  };
  state.m2g['ms-task'] = 'g-task';
  for (let round = 0; round < 3; round += 1) {
    assert.doesNotThrow(() => c.normalizeState_(state), `round ${round + 1} normalizes`);
    c.saveState_(state);
    state = c.loadStateForSync_();
    assert.match(state.g2m['g-task'].fp.importanceFp, HEX32, `importanceFp round ${round + 1}`);
    assert.match(state.g2m['g-task'].fp.categoriesFp, HEX32, `categoriesFp round ${round + 1}`);
  }

  // assertOrdinaryFingerprint_ accepts null / 32-hex and rejects anything else
  const ok = Object.assign(c.ordinaryEmptyFp_(), { importanceFp: null, categoriesFp: c.categoryImportanceFp_('categories', 'X') });
  assert.doesNotThrow(() => c.assertOrdinaryFingerprint_(ok, 'ok'));
  for (const bad of ['not-hex', 123, 'ABCDEF', '0'.repeat(31), 'g'.repeat(32), {}]) {
    const fp = Object.assign(c.ordinaryEmptyFp_(), { importanceFp: bad });
    assert.throws(() => c.assertOrdinaryFingerprint_(fp, 'bad'),
      /STATE_MALFORMED.*importanceFp/, `reject ${JSON.stringify(bad)}`);
  }
  const unknownKey = Object.assign(c.ordinaryEmptyFp_(), { stray: 'x' });
  assert.throws(() => c.assertOrdinaryFingerprint_(unknownKey, 'bad'), /STATE_MALFORMED/);
});

test('10. knob OFF: exact legacy payloads stay byte-for-byte (JSON.stringify)', () => {
  const { c } = load(); // opt-in OFF, no round gate
  // mirrors the exact JSON.stringify assertions in tests/sync.test.mjs:2859-2881
  assert.equal(JSON.stringify(c.msPayloadFromGoogle_({ title: 'Create', notes: '\u00a0' }, 'create')),
    JSON.stringify({ title: 'Create', dueDateTime: null, status: 'notStarted' }));
  assert.equal(JSON.stringify(c.msPayloadFromGoogle_({ title: 'Update', notes: '\t\n' }, 'update')),
    JSON.stringify({
      title: 'Update', body: { contentType: 'html', content: '' },
      dueDateTime: null, status: 'notStarted'
    }));
  // and the exact deepEqual assertions in tests/sync.test.mjs:304-311
  const msTask = {
    title: 'Original',
    dueDateTime: { dateTime: '2026-08-21T00:00:00', timeZone: 'Asia/Taipei' },
    status: 'notStarted',
    body: { contentType: 'html', content: '<p>Rich<br>body</p>' }
  };
  const googleTask = { title: 'Original', due: '2026-08-21T00:00:00.000Z', status: 'needsAction', notes: 'Rich\nbody' };
  const payloadFor = (changes) => JSON.parse(JSON.stringify(
    c.msUpdatePayloadFromGoogle_(Object.assign({}, googleTask, changes), msTask)));
  deep(payloadFor({ title: 'Renamed' }), { title: 'Renamed' });
  deep(payloadFor({ status: 'completed' }), { status: 'completed' });
  deep(payloadFor({ notes: 'Changed notes' }), {
    body: { contentType: 'html', content: 'Changed notes' }
  });
  // field-merge patch builder is unchanged with no ciFields
  deep(c.ordinaryMicrosoftPatchFromPlan_({ toMicrosoft: { title: 'X' } }), { title: 'X' });
  deep(c.ordinaryMicrosoftPatchFromPlan_({ toMicrosoft: {} }), {});
});

test('11. after opt-in + confirmation, repeated rounds with the same marker do not re-PATCH', () => {
  const { c } = load();
  const { state, rec, gTask, msTask } = pair(c, {
    gTitle: '[!] 買牛奶', gNotes: 'note\n#Work'
  });
  armGate(c, state, true, true);
  const writes = stubWrites(c, msTask);

  // round 1: positive markers are written once (diff-pruned against MS values)
  c.ordinaryReconcileMappedPair_(state, rec, gTask, msTask, 'g-list', {});
  assert.equal(writes.msPatches.length, 1);
  assert.equal(writes.msPatches[0].importance, 'high');
  deep(writes.msPatches[0].categories, ['Work']);
  // both fingerprints advanced to 32-hex
  const fp1 = state.g2m['g-task'].fp;
  assert.match(fp1.importanceFp, HEX32);
  assert.match(fp1.categoriesFp, HEX32);

  // simulate the Microsoft readback now carrying the written values
  msTask.importance = 'high';
  msTask.categories = ['Work'];

  // round 2: same marker values -> converged, no jitter, no second PATCH
  const r2 = c.ordinaryReconcileMappedPair_(state, state.g2m['g-task'], gTask, msTask, 'g-list', {});
  assert.equal(r2.microsoftWrites, 0);
  assert.equal(writes.msPatches.length, 1, 'no duplicate PATCH');
  assert.equal(state.g2m['g-task'].fp.importanceFp, fp1.importanceFp, 'importanceFp stable');
  assert.equal(state.g2m['g-task'].fp.categoriesFp, fp1.categoriesFp, 'categoriesFp stable');
});
