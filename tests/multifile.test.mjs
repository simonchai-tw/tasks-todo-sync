import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { GAS_SOURCE_FILES } from '../lib/gas-files.mjs';
import { deterministicShuffledGasFiles, runGasFilesInContext } from './gas-loader.mjs';

for (const [name, order] of [
  ['canonical', GAS_SOURCE_FILES],
  ['reverse', [...GAS_SOURCE_FILES].reverse()],
  ['deterministic shuffled', deterministicShuffledGasFiles()]
]) {
  test(`GAS sources load in ${name} order`, () => {
    const context = vm.createContext({});
    runGasFilesInContext(context, order);
    assert.equal(typeof context.syncAll, 'function');
    assert.equal(vm.runInContext('SYNC_TRIGGER_INTERVAL_MINUTES', context), 10);
  });
}
