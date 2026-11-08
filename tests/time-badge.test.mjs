import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { runGasFilesInContext } from './gas-loader.mjs';

/* v1.2.0 / P1-3 — notes-tail time micro-badge 🕒 + rec.rem.lastRenderedBadge.
 *
 * Hard rules under test:
 *  - SYNC_TIME_BADGE is opt-in and OFF by default (no note rewrites on upgrade).
 *  - Only the EXACT string we rendered ourselves is ever stripped, and only on
 *    a strict === comparison.  No bare clock regex: user text, other 🕐–🕛
 *    glyphs and VS16 variants are preserved.
 *  - Stripping happens on the fingerprint projection chain (both sides), so the
 *    A4 splice baseline ordinaryFieldFp_(ordinaryProjectGoogle_, 'notes') never
 *    drifts and badges never stack.
 *  - MALFORMED / AMBIGUOUS columns are skipped in full (NOTES_UNMERGEABLE).
 *
 * FIXED-DATE-OK: the pinned td.date below is an arbitrary stable wall-clock
 * date used only to give rec.td a valid shape; it is never compared to today.
 */

function blob(data) {
  const bytes = Buffer.from(typeof data === 'string' ? data : data || []);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

function load(scriptValues = {}) {
  const script = {
    values: Object.assign({ SYNC_TIME_ZONE: 'Asia/Taipei', SYNC_TIME_BRIDGE: 'true' }, scriptValues),
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; },
    getProperties() { return { ...this.values }; },
    getKeys() { return Object.keys(this.values); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); },
    deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; }
  };
  const user = {
    values: {},
    getProperty(k) { return Object.hasOwn(this.values, k) ? this.values[k] : null; },
    setProperty(k, v) { this.values[k] = String(v); },
    deleteProperty(k) { delete this.values[k]; },
    getProperties() { return { ...this.values }; },
    getKeys() { return Object.keys(this.values); },
    setProperties(entries) { for (const [k, v] of Object.entries(entries)) this.values[k] = String(v); },
    deleteAllProperties() { for (const k of Object.keys(this.values)) delete this.values[k]; }
  };
  const c = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => script, getUserProperties: () => user },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'UTF-8' },
      newBlob: blob,
      gzip: (b) => blob(gzipSync(Buffer.from(b.getBytes()))),
      ungzip: (b) => blob(gunzipSync(Buffer.from(b.getBytes()))),
      base64Encode: (d) => Buffer.from(typeof d === 'string' ? d : d).toString('base64'),
      base64Decode: (d) => Array.from(Buffer.from(d, 'base64')),
      computeDigest: (_a, d) => Array.from(createHash('sha256').update(d, 'utf8').digest()),
      formatDate: (date, tz, format) => {
        const d = new Date(date);
        if (format === 'yyyy-MM-dd') {
          return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        }
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
        return `${parts.find((p) => p.type === 'hour')?.value || '00'}:${parts.find((p) => p.type === 'minute')?.value || '00'}:${parts.find((p) => p.type === 'second')?.value || '00'}`;
      },
      sleep() {}
    },
    Calendar: { Events: { get() { throw new Error('not found'); }, insert() {}, patch() {}, remove() {} } },
    CalendarApp: { getCalendarsByName() { return []; }, createCalendar() { return { getId: () => 'cal' }; } }
  });
  runGasFilesInContext(c);
  c.console = { log() {}, warn() {}, error() {} };
  return { c, script, user };
}

function badgeRec(extra) {
  return Object.assign({
    msId: 'ms-task', gListId: 'g-list', msListId: 'ms-list',
    gUpdated: '2026-03-01T00:00:00Z', msUpdated: '2026-03-01T00:00:00Z',
    fp: { v: 1, title: null, notes: null, completed: null, due: null },
    td: { date: '2026-03-05', time: '15:30', v: 1 }
  }, extra || {});
}

function badgeState(c, recExtra) {
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-task'] = badgeRec(recExtra);
  state.m2g['ms-task'] = 'g-task';
  return state;
}

function snap(gNotes, msBody) {
  return {
    gTasksById: { 'g-task': { id: 'g-task', title: 'T', notes: gNotes, status: 'needsAction' } },
    msTasksById: { 'ms-task': { id: 'ms-task', title: 'T', status: 'notStarted', body: { contentType: 'text', content: msBody } } }
  };
}

function simpleBlock(c) {
  return c.renderManagedResourceBlock_(
    c.projectGoogleResources_({
      id: 'g-task', title: 'T', status: 'needsAction',
      links: [{ type: 'email', description: 'Doc', link: 'https://example.invalid/doc' }]
    }),
    'g2m', '買牛奶', c.RESOURCE_NOTES_MAX_).block;
}

function installWrites(c) {
  const g = [], ms = [];
  c.updateGTask_ = (l, id, p) => { g.push(p); return { id, notes: p.notes }; };
  c.updateMsTask_ = (l, id, p) => { ms.push(p); return { id, body: p.body }; };
  return { g, ms };
}

/* ------------------------------------------------------------------ */

test('1. SYNC_TIME_BADGE knob: default false, strict true/false, bounded invalid code', () => {
  const { c } = load();
  assert.equal(c.getSafetyConfig_().enableTimeBadge, false, 'opt-in, OFF by default');
  assert.equal(load({ SYNC_TIME_BADGE: 'true' }).c.getSafetyConfig_().enableTimeBadge, true);
  assert.equal(load({ SYNC_TIME_BADGE: 'false' }).c.getSafetyConfig_().enableTimeBadge, false);
  assert.equal(load({ SYNC_TIME_BADGE: ' TRUE ' }).c.getSafetyConfig_().enableTimeBadge, true, 'trim + lowercase');
  const broken = load({ SYNC_TIME_BADGE: 'yes' }).c;
  assert.throws(() => broken.getSafetyConfig_(), /SYNC_TIME_BADGE_FLAG_INVALID/);
  assert.equal(
    broken.boundedSafetyConfigIssue_(new Error('SYNC_TIME_BADGE_FLAG_INVALID: x')),
    'SAFETY_CONFIGURATION_INVALID:SYNC_TIME_BADGE_FLAG_INVALID'
  );
});

test('2. fingerprint projection strips only the exact lastRenderedBadge (===); A4 baseline stable', () => {
  const { c } = load();
  const notes = '買牛奶\n🕒 15:30';
  const gTask = { id: 'g-task', title: 'T', notes, status: 'needsAction' };
  const withBadge = badgeState(c, { rem: { lastRenderedBadge: '🕒 15:30' } }).g2m['g-task'];
  const stripped = c.ordinaryProjectGoogle_(gTask, withBadge, null);
  assert.equal(stripped.notes, '買牛奶', 'badge removed before reaching ordinaryFieldFp_');
  const fpStripped = c.ordinaryFieldFp_(stripped, 'notes');

  // Backward compatibility: no recorded badge -> byte-for-byte legacy output.
  const noBadge = badgeState(c).g2m['g-task'];
  assert.equal(c.ordinaryProjectGoogle_(gTask, noBadge, null).notes, notes);

  // A4: the ordinary notes baseline of a clean task equals the stripped one, so
  // rec.fp.notes cannot drift and no phantom TRUE_FIELD_CONFLICT appears.
  const cleanTask = { id: 'g-task', title: 'T', notes: '買牛奶', status: 'needsAction' };
  const fpClean = c.ordinaryFieldFp_(c.ordinaryProjectGoogle_(cleanTask, noBadge, null), 'notes');
  assert.equal(fpStripped, fpClean);

  // A slightly different recorded value must NOT strip anything.
  const other = badgeState(c, { rem: { lastRenderedBadge: '🕒 15:31' } }).g2m['g-task'];
  assert.equal(c.ordinaryProjectGoogle_(gTask, other, null).notes, notes);
});

test('3. user-written "記得 🕒 15:30 開會" is never stripped', () => {
  const { c } = load();
  const rec = badgeState(c, { rem: { lastRenderedBadge: '🕒 15:30' } }).g2m['g-task'];
  const notes = '記得 🕒 15:30 開會';
  const gTask = { id: 'g-task', title: 'T', notes, status: 'needsAction' };
  assert.equal(c.ordinaryProjectGoogle_(gTask, rec, null).notes, notes);
  const msTask = { id: 'ms-task', title: 'T', status: 'notStarted', body: { contentType: 'text', content: notes } };
  assert.equal(c.ordinaryProjectMicrosoft_(msTask, rec, null).notes, notes, 'same strict rule on Microsoft');
  assert.equal(c.stripRenderedTimeBadge_('記得 🕒 15:30 開會', '🕒 15:30'), '記得 🕒 15:30 開會');
});

test('4. VS16 🕒️ and plain 🕒 never cross-strip (both directions)', () => {
  const { c } = load();
  const plain = '🕒 15:30';
  const vs16 = '🕒\uFE0F 15:30';

  // Direction A: recorded plain, tail carries VS16 -> keep.
  const recA = badgeState(c, { rem: { lastRenderedBadge: plain } }).g2m['g-task'];
  assert.equal(c.stripRenderedTimeBadge_('備註\n' + vs16, plain), '備註\n' + vs16);
  assert.equal(c.ordinaryProjectGoogle_(
    { id: 'g-task', title: 'T', notes: '備註\n' + vs16, status: 'needsAction' }, recA, null).notes,
    '備註\n' + vs16, 'VS16 survives the whole projection chain');

  // Direction B: recorded VS16, tail is plain -> keep.
  assert.equal(c.stripRenderedTimeBadge_('備註\n' + plain, vs16), '備註\n' + plain);
  const recB = badgeState(c, { rem: { lastRenderedBadge: vs16 } }).g2m['g-task'];
  assert.equal(c.ordinaryProjectGoogle_(
    { id: 'g-task', title: 'T', notes: '備註\n' + plain, status: 'needsAction' }, recB, null).notes,
    '備註\n' + plain);

  // The exact VS16 value (selector + surrogate pair) still strips cleanly.
  assert.equal(c.stripRenderedTimeBadge_('備註\n' + vs16, vs16), '備註');
});

test('5. all 12 clock glyphs 🕐–🕛 are never stripped by a bare regex', () => {
  const { c } = load();
  const clocks = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
  // A recorded badge whose time matches none of the probes: a bare
  // /🕐-🕛 HH:mm$/ regex would wrongly strip all twelve tails.
  const badgeA = '🕒 00:00';
  const recA = badgeState(c, { rem: { lastRenderedBadge: badgeA } }).g2m['g-task'];
  for (const clock of clocks) {
    const notes = '備註\n' + clock + ' 15:30';
    assert.equal(c.stripRenderedTimeBadge_(notes, badgeA), notes, clock + ' tail kept (A)');
    assert.equal(c.ordinaryProjectGoogle_(
      { id: 'g-task', title: 'T', notes, status: 'needsAction' }, recA, null).notes, notes,
      clock + ' projection kept (A)');
  }
  // With the real badge value, the eleven OTHER glyphs still must not be
  // stripped; only the one exact rendered value is removed.
  for (const clock of clocks.filter((x) => x !== '🕒')) {
    const notes = '備註\n' + clock + ' 15:30';
    assert.equal(c.stripRenderedTimeBadge_(notes, '🕒 15:30'), notes, clock + ' is not our rendered value');
  }
  assert.equal(c.stripRenderedTimeBadge_('備註\n🕒 15:30', '🕒 15:30'), '備註', 'our own exact value is stripped');
});

test('6. lastRenderedBadge survives normalizeState_/saveState_/loadStateForSync_ 3 rounds; validator rejects bad types', () => {
  const { c } = load();
  const vs16 = '🕒\uFE0F 15:30';
  let state = badgeState(c, { rem: { lastRenderedBadge: vs16 } });
  for (let round = 0; round < 3; round += 1) {
    assert.doesNotThrow(() => c.normalizeState_(state), `round ${round + 1} normalizes`);
    c.saveState_(state);
    state = c.loadStateForSync_();
    assert.equal(state.g2m['g-task'].rem.lastRenderedBadge, vs16,
      `VS16 + surrogate pair survives round ${round + 1}`);
  }
  // null / undefined / missing are all acceptable.
  assert.doesNotThrow(() => c.normalizeState_(badgeState(c, { rem: { lastRenderedBadge: null } })));
  assert.doesNotThrow(() => c.normalizeState_(badgeState(c, { rem: {} })));
  assert.doesNotThrow(() => c.normalizeState_(badgeState(c, {})));
  // Non-string values are rejected with a bounded STATE_MALFORMED.
  for (const bad of [123, true, {}, []]) {
    assert.throws(
      () => c.normalizeState_(badgeState(c, { rem: { lastRenderedBadge: bad } })),
      /STATE_MALFORMED.*lastRenderedBadge/,
      `reject ${JSON.stringify(bad)}`
    );
  }
});

test('7. knob ON renders 🕒 at user-notes tail / before managed block; no-block branch & MS/Google parity', () => {
  const { c } = load({ SYNC_TIME_BADGE: 'true' });

  // Case A: no managed block at all -> badge must still be written.
  const stateA = badgeState(c);
  const recA = stateA.g2m['g-task'];
  const sA = snap('買牛奶', '買牛奶');
  const writesA = installWrites(c);
  const outA = c.timeBridgeRenderNotesBadge_(stateA, sA, { enableTimeBadge: true });
  assert.equal(outA.rendered, 1);
  assert.equal(recA.rem.lastRenderedBadge, '🕒 15:30', 'exact rendered string stored');
  assert.equal(sA.gTasksById['g-task'].notes, '買牛奶\n🕒 15:30', 'no-managed-block branch writes the badge');
  assert.equal(sA.msTasksById['ms-task'].body.content, '買牛奶\n🕒 15:30', 'Microsoft side identical');
  assert.equal(writesA.g.length, 1);
  assert.equal(writesA.ms.length, 1);
  // The rendered notes project back to clean user notes (A4 eats the strip).
  assert.equal(c.ordinaryProjectGoogle_(sA.gTasksById['g-task'], recA, null).notes, '買牛奶');

  // Case B: with a managed block -> badge sits BEFORE --- tasks-todo-sync ---.
  const stateB = badgeState(c);
  const recB = stateB.g2m['g-task'];
  const block = simpleBlock(c);
  const blockFp = c.managedBlockFingerprint_(block);
  recB.res = { gBlockFp: blockFp, msBlockFp: blockFp };
  const original = c.composeManagedNotes_('買牛奶', block);
  const sB = snap(original, original);
  const writesB = installWrites(c);
  c.timeBridgeRenderNotesBadge_(stateB, sB, { enableTimeBadge: true });
  const gNotes = sB.gTasksById['g-task'].notes;
  const badgeIdx = gNotes.indexOf('🕒 15:30');
  const blockIdx = gNotes.indexOf('--- tasks-todo-sync ---');
  assert.ok(badgeIdx >= 0 && blockIdx >= 0 && badgeIdx < blockIdx, 'badge precedes the managed block');
  assert.ok(gNotes.indexOf('買牛奶') < badgeIdx, 'badge is at the END of the user notes');
  assert.equal(sB.msTasksById['ms-task'].body.content, gNotes, 'both sides compose the same string');
  assert.equal(writesB.g.length, 1);
  assert.equal(writesB.ms.length, 1);
});

test('8. repeated runs: zero stacking, zero rec.fp.notes drift, time change swaps the badge without stacking', () => {
  const { c } = load({ SYNC_TIME_BADGE: 'true' });
  const state = badgeState(c);
  const rec = state.g2m['g-task'];
  const s = snap('買牛奶', '買牛奶');
  const writes = installWrites(c);
  const totalWrites = () => writes.g.length + writes.ms.length;

  c.timeBridgeRenderNotesBadge_(state, s, { enableTimeBadge: true });
  const first = s.gTasksById['g-task'].notes;
  const fp1 = c.ordinaryFieldFp_(c.ordinaryProjectGoogle_(s.gTasksById['g-task'], rec, null), 'notes');
  rec.fp.notes = fp1; // A4-style persisted baseline

  // Second identical round: no provider write, no stacking, no drift.
  const before = totalWrites();
  c.timeBridgeRenderNotesBadge_(state, s, { enableTimeBadge: true });
  assert.equal(totalWrites(), before, 'converged round performs zero provider writes');
  assert.equal(s.gTasksById['g-task'].notes, first, 'badge is not stacked');
  assert.equal((s.gTasksById['g-task'].notes.match(/🕒/g) || []).length, 1, 'exactly one 🕒');
  const fp2 = c.ordinaryFieldFp_(c.ordinaryProjectGoogle_(s.gTasksById['g-task'], rec, null), 'notes');
  assert.equal(fp2, rec.fp.notes, 'A4 recomputation equals the stored baseline: rec.fp.notes does not drift');

  // Time changes: the OLD badge is stripped first, so nothing stacks.
  rec.td.time = '16:45';
  c.timeBridgeRenderNotesBadge_(state, s, { enableTimeBadge: true });
  assert.equal(rec.rem.lastRenderedBadge, '🕒 16:45');
  assert.equal(s.gTasksById['g-task'].notes, '買牛奶\n🕒 16:45');
  assert.equal((s.gTasksById['g-task'].notes.match(/🕒/g) || []).length, 1, 'still exactly one 🕒');
  assert.ok(!s.gTasksById['g-task'].notes.includes('15:30'), 'old badge removed');
  const fp3 = c.ordinaryFieldFp_(c.ordinaryProjectGoogle_(s.gTasksById['g-task'], rec, null), 'notes');
  assert.equal(fp3, rec.fp.notes, 'baseline still stable after the time change');
});

test('9. MALFORMED/AMBIGUOUS columns are skipped entirely (NOTES_UNMERGEABLE); no userNotes fallback; both sides', () => {
  const { c } = load({ SYNC_TIME_BADGE: 'true' });

  // MALFORMED: BEGIN with no END.  Google is unmergeable, Microsoft is fine.
  const malformed = '買牛奶\n--- tasks-todo-sync ---\n[Link] x';
  const stateA = badgeState(c);
  const recA = stateA.g2m['g-task'];
  const sA = snap(malformed, '買牛奶');
  const writesA = installWrites(c);
  const outA = c.timeBridgeRenderNotesBadge_(stateA, sA, { enableTimeBadge: true });
  assert.equal(outA.skipped, 1);
  assert.equal(outA.rendered, 0);
  assert.equal(writesA.g.length + writesA.ms.length, 0, 'neither side is written when one side is unmergeable');
  assert.equal(sA.gTasksById['g-task'].notes, malformed, 'no fallback to raw userNotes');
  assert.equal(recA.rem, undefined, 'no badge recorded for an unmergeable column');
  const projA = c.ordinaryProjectGoogle_(sA.gTasksById['g-task'], recA, null);
  assert.equal(projA.notesOk, false, 'merge reports NOTES_UNMERGEABLE');
  assert.equal(c.ordinaryFieldFp_(projA, 'notes'), null);

  // AMBIGUOUS: priorFp does not match the observed block on BOTH sides.
  const block = simpleBlock(c);
  const stateB = badgeState(c, { res: { gBlockFp: 'f'.repeat(32), msBlockFp: 'f'.repeat(32) } });
  const recB = stateB.g2m['g-task'];
  const original = c.composeManagedNotes_('買牛奶', block);
  const sB = snap(original, original);
  const writesB = installWrites(c);
  const outB = c.timeBridgeRenderNotesBadge_(stateB, sB, { enableTimeBadge: true });
  assert.equal(outB.skipped, 1);
  assert.equal(outB.rendered, 0);
  assert.equal(writesB.g.length + writesB.ms.length, 0);
  assert.equal(sB.gTasksById['g-task'].notes, original, 'Google unchanged');
  assert.equal(sB.msTasksById['ms-task'].body.content, original, 'Microsoft unchanged (both sides skip)');
  assert.equal(recB.rem, undefined);
  assert.equal(c.ordinaryProjectGoogle_(sB.gTasksById['g-task'], recB, null).notesOk, false);
});

test('10. knob OFF: timeBridgeRun_ never renders and never writes state; knob ON wires the renderer', () => {
  const { c, script } = load({ SYNC_TIME_BRIDGE: 'true' }); // SYNC_TIME_BADGE absent -> OFF
  // Isolate the orchestrator so only the badge renderer can touch state.
  c.timeBridgeMigrateLegacyRem_ = () => ({ rebuilt: 0, cleared: 0, legacyJournal: null, deadLetterCleared: 0 });
  c.timeBridgeIntake_ = () => 0;
  c.timeBridgeSpliceRenderer_ = () => 0;
  c.timeBridgeMsRenderer_ = () => ({ patched: 0, quarantined: [] });
  const writes = [];
  c.updateGTask_ = (l, id, p) => { writes.push(p); return { id, notes: p.notes }; };
  c.updateMsTask_ = (l, id, p) => { writes.push(p); return { id, body: p.body }; };
  let called = 0;
  const real = c.timeBridgeRenderNotesBadge_;
  c.timeBridgeRenderNotesBadge_ = (...args) => { called += 1; return real(...args); };
  vm.runInContext('Date.now = () => 1735689600000;', c);

  const off = badgeState(c);
  const before = JSON.stringify(off);
  const sOff = snap('買牛奶', '買牛奶');
  c.timeBridgeRun_(off, sOff, 1735689600000, 'round-off');
  assert.equal(called, 0, 'knob OFF: badge renderer never invoked');
  assert.equal(JSON.stringify(off), before, 'knob OFF: state byte-for-byte unchanged');
  assert.equal(writes.length, 0, 'knob OFF: no provider writes');
  assert.ok(!sOff.gTasksById['g-task'].notes.includes('🕒'), 'knob OFF: no badge in notes');

  script.setProperty('SYNC_TIME_BADGE', 'true');
  const on = badgeState(c);
  const sOn = snap('買牛奶', '買牛奶');
  c.timeBridgeRun_(on, sOn, 1735689600000, 'round-on');
  assert.equal(called, 1, 'knob ON: badge renderer invoked');
  assert.equal(on.g2m['g-task'].rem.lastRenderedBadge, '🕒 15:30');
  assert.ok(sOn.gTasksById['g-task'].notes.includes('🕒 15:30'));
});

test('11. composeManagedNotes_ two-arg output is byte-identical (backward compatibility)', () => {
  const { c } = load();
  const block = '--- tasks-todo-sync ---\n[Link] x\n--- tasks-todo-sync end ---';
  assert.equal(c.composeManagedNotes_('body', block), 'body\n\n' + block);
  assert.equal(c.composeManagedNotes_('body', null), 'body');
  assert.equal(c.composeManagedNotes_('', block), block);
  assert.equal(c.composeManagedNotes_('trailing\n\n', block), 'trailing\n\n' + block);
  assert.equal(c.composeManagedNotes_('body', block, ''), 'body\n\n' + block, 'empty badge is a no-op');
  // With a badge: no-block branch writes it, blocked branch keeps it before the block.
  assert.equal(c.composeManagedNotes_('body', null, '🕒 15:30'), 'body\n🕒 15:30');
  assert.equal(c.composeManagedNotes_('body', block, '🕒 15:30'), 'body\n🕒 15:30\n\n' + block);
  assert.equal(c.composeManagedNotes_('', block, '🕒 15:30'), '🕒 15:30\n\n' + block);
});

test('12. a pair whose provider write fails is isolated; other pairs still render', () => {
  const { c } = load({ SYNC_TIME_BADGE: 'true' });
  const state = c.newState_();
  state.listMap = { 'g-list': 'ms-list' };
  state.g2m['g-bad'] = badgeRec({ msId: 'ms-bad' });
  state.g2m['g-ok'] = badgeRec({ msId: 'ms-ok' });
  state.m2g['ms-bad'] = 'g-bad';
  state.m2g['ms-ok'] = 'g-ok';
  const s = {
    gTasksById: {
      'g-bad': { id: 'g-bad', title: 'T', notes: 'A', status: 'needsAction' },
      'g-ok': { id: 'g-ok', title: 'T', notes: 'B', status: 'needsAction' }
    },
    msTasksById: {
      'ms-bad': { id: 'ms-bad', title: 'T', status: 'notStarted', body: { contentType: 'text', content: 'A' } },
      'ms-ok': { id: 'ms-ok', title: 'T', status: 'notStarted', body: { contentType: 'text', content: 'B' } }
    }
  };
  c.updateGTask_ = (l, id, p) => {
    if (id === 'g-bad') throw new Error('simulated provider failure');
    return { id, notes: p.notes };
  };
  c.updateMsTask_ = (l, id, p) => ({ id, body: p.body });

  const out = c.timeBridgeRenderNotesBadge_(state, s, { enableTimeBadge: true });
  assert.equal(out.skipped, 1);
  assert.equal(out.rendered, 1);
  assert.equal(state.g2m['g-bad'].rem, undefined, 'failed pair records no badge');
  assert.equal(state.g2m['g-ok'].rem.lastRenderedBadge, '🕒 15:30', 'healthy pair still rendered');
  assert.equal(s.gTasksById['g-bad'].notes, 'A', 'failed pair snapshot untouched');
  assert.ok(s.gTasksById['g-ok'].notes.includes('🕒 15:30'));
});
