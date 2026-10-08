export const GAS_SOURCE_FILES = Object.freeze([
  'Code.gs',
  'globals.gs',
  'setup.gs',
  'auth.gs',
  'config.gs',
  'state.gs',
  'runtime.gs',
  'providers.gs',
  'relationship-discovery.gs',
  'subtask-classification.gs',
  'subtask-sync.gs',
  'resource-projection.gs',
  'field-merge.gs',
  'lifecycle.gs',
  'lists.gs',
  'time-bridge.gs',
  'sync.gs',
  'operations.gs'
]);

/* clasp pulls Apps Script server files with a .js extension (the format the
 * Apps Script API stores), while the canonical local sources are .gs. Every
 * fingerprint check compared names literally, so a perfectly healthy remote
 * project produced zero signals and fell to confidence "low" -- which made the
 * dashboard say "No existing project was found" while the project was right
 * there in Drive (observed live 2026-10-06 with rc.6, scriptId
 * 1o-hO0EoczMiFYGeDCLw1XAYxFiQff05lwvpWY85_sYJExH-fQc4wlNfS).
 *
 * Normalize on the stem so "Code.js" and "Code.gs" are the same managed file. */
export function managedGasSourceName(name) {
  if (typeof name !== 'string' || !name.endsWith('.js')) return null;
  const asGs = `${name.slice(0, -3)}.gs`;
  return GAS_SOURCE_FILES.includes(asGs) ? asGs : null;
}

export function isManagedGasSourceFile(name) {
  return managedGasSourceName(name) !== null;
}
