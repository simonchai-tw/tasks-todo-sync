import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GAS_SOURCE_FILES } from '../lib/gas-files.mjs';

export function gasSourceFiles(order = GAS_SOURCE_FILES) {
  return order.map((filename) => ({
    filename,
    source: readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8')
  }));
}

export function runGasFilesInContext(context, order = GAS_SOURCE_FILES) {
  for (const { filename, source } of gasSourceFiles(order)) {
    new vm.Script(source, { filename }).runInContext(context);
  }
  // Test-only default for the pre-PATCH notes re-read (W4 reread).  Production
  // uses the real rereadProviderNotes_ in field-merge.gs which performs a fresh
  // provider GET and is fail-closed on read errors.  Hermetic harnesses rarely stub
  // getGTask_/getMsTask_, so this default uses the provider when a stub exists and
  // otherwise treats the side as unchanged (no user edit detected), preserving the
  // pre-feature behaviour of the existing suite.  Individual tests override this to
  // exercise the abandon / fail-closed paths.
  context.rereadProviderNotes_ = function (side, rec, gTask, msTask) {
    try {
      if (side === 'google') {
        const freshG = context.getGTask_(rec.gListId, gTask.id);
        return { ok: true, notes: freshG && freshG.notes != null ? freshG.notes : '' };
      }
      const freshMs = context.getMsTask_(rec.msListId, rec.msId);
      return { ok: true, notes: context.microsoftNotesPlainTextProjection_(freshMs) };
    } catch (e) {
      if (side === 'google') {
        return { ok: true, notes: gTask && gTask.notes != null ? gTask.notes : '' };
      }
      return { ok: true, notes: context.microsoftNotesPlainTextProjection_(msTask) };
    }
  };
  return context;
}

export function deterministicShuffledGasFiles() {
  const files = [...GAS_SOURCE_FILES];
  let state = 0x5eed1234;
  for (let index = files.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [files[index], files[swapIndex]] = [files[swapIndex], files[index]];
  }
  return files;
}
