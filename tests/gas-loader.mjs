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
