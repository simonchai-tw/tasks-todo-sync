function newState_() {
  return {
    schema: 3,
    listMap: {},
    g2m: {},
    m2g: {},
    tombstones: { g: {}, m: {} },
    // A candidate is recorded during one complete sync. It cannot cause a remote
    // delete until a later, independently completed inventory confirms it again.
    pendingTaskDeletions: {},
    // A prepared journal is saved before every remote delete. This lets a later
    // run decide whether the delete completed if the final state save was lost.
    deletionJournal: {},
    // Durable cross-list move intent.  A prepared/creating record keeps a
    // remote create from being mistaken for an ordinary unmapped task, while
    // a created record lets a later run finish deleting the old counterpart.
    taskMoveJournal: {},
    // Kept separately from list faults so delete-vs-edit does not hide a whole list.
    taskDeletionConflicts: {},
    // List lifecycle state is intentionally separate from task deletion.  A
    // list candidate owns its pair while it is pending/journaled/conflicted,
    // which prevents the ordinary planner from recreating a survivor.
    listPairMeta: {},
    pendingListDeletions: {},
    listDeletionJournal: {},
    listDeletionConflicts: {},
    // Provider IDs are opaque, so canonical ID tombstones and normalized-name
    // guards must never share a key space.  Keeping name guards in their own
    // mirrored maps makes an ID such as `name:shared` completely ordinary.
    listTombstones: { g: {}, ms: {} },
    listTombstoneNames: { g: {}, ms: {} },
    listFaults: { g: {}, ms: {} },
    health: {
      lastSuccessfulSyncAt: null,
      lastFailedSyncAt: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
      // Round IDs distinguish a fenced checkpoint from a final successful
      // commit after an Apps Script interruption.
      lastSuccessfulRoundId: null,
      roundFenceProjectionId: null
    },
    updatedAt: null
  };
}

function assertKnownObjectKeys_(value, allowed, label, errorCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.keys(value).forEach(function(key) {
    if (allowed.indexOf(key) >= 0) return;
    throw new Error((errorCode || 'STATE_MALFORMED') + ': ' + label + ' contains unknown field ' + key + '; overwrite refused.');
  });
}

function assertListMapOneToOne_(state, errorCode) {
  const seenMicrosoft = {};
  const listMap = state && state.listMap;
  if (!listMap || typeof listMap !== 'object' || Array.isArray(listMap)) return;
  Object.keys(listMap).forEach(function(gListId) {
    const msListId = listMap[gListId];
    if (!gListId || typeof msListId !== 'string' || !msListId) {
      throw new Error((errorCode || 'STATE_MALFORMED') + ': listMap contains an invalid list ID; overwrite refused.');
    }
    if (seenMicrosoft[msListId] && seenMicrosoft[msListId] !== gListId) {
      throw new Error((errorCode || 'STATE_MALFORMED') + ': listMap is not one-to-one; Microsoft list ' +
        msListId + ' is mapped to both ' + seenMicrosoft[msListId] + ' and ' + gListId + '.');
    }
    seenMicrosoft[msListId] = gListId;
  });
}

function assertStrictSchema3StateShape_(state, errorCode) {
  if (!state || state.schema !== 3) return;
  const allowedTopLevel = [
    'schema', 'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskMoveJournal', 'taskDeletionConflicts', 'listPairMeta',
    'pendingListDeletions', 'listDeletionJournal', 'listDeletionConflicts',
    'listTombstones', 'listTombstoneNames', 'listFaults', 'health', 'updatedAt'
  ];
  assertKnownObjectKeys_(state, allowedTopLevel, 'state', errorCode);
  const recordFields = {
    g2m: ['msId', 'gListId', 'msListId', 'gUpdated', 'msUpdated'],
    pendingTaskDeletions: ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'firstConfirmedAt', 'lastConfirmedAt', 'lastRoundId', 'confirmations'],
    deletionJournal: ['phase', 'gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'preparedAt', 'lastBlockedReason', 'lastBlockedAt'],
    taskMoveJournal: ['phase', 'gId', 'oldMsId', 'newMsId', 'gListId', 'oldMsListId',
      'targetMsListId', 'gUpdated', 'oldMsUpdated', 'preparedAt', 'fingerprint',
      'correlationId', 'uncertainConfirmations', 'lastRoundId', 'lastBlockedReason', 'lastBlockedAt'],
    taskDeletionConflicts: ['at', 'reason', 'msId', 'gListId', 'msListId'],
    listPairMeta: ['gListId', 'msListId', 'gTitle', 'msTitle', 'gFingerprint', 'msFingerprint',
      'gDeletable', 'msDeletable', 'autoBothLiveProvenAt'],
    pendingListDeletions: ['key', 'gListId', 'msListId', 'gTitle', 'msTitle', 'missingSide',
      'gFingerprint', 'msFingerprint', 'survivorFingerprint', 'taskPairs', 'taskFingerprint', 'deletable',
      'confirmations', 'lastRoundId', 'firstConfirmedAt', 'lastConfirmedAt'],
    listDeletionJournal: ['key', 'gListId', 'msListId', 'gTitle', 'msTitle', 'missingSide',
      'gFingerprint', 'msFingerprint', 'survivorFingerprint', 'taskPairs', 'taskFingerprint', 'deletable',
      'confirmations', 'lastRoundId', 'firstConfirmedAt', 'lastConfirmedAt', 'phase', 'preparedAt',
      'lastBlockedReason', 'lastBlockedAt'],
    listDeletionConflicts: ['at', 'reason', 'gListId', 'msListId', 'gTitle', 'msTitle', 'gName', 'msName'],
    tombstones: ['at', 'source'],
    listTombstones: ['at', 'source', 'gListId', 'msListId', 'gName', 'msName'],
    listTombstoneNames: ['at', 'source', 'gListId', 'msListId', 'gName', 'msName']
  };
  Object.keys(recordFields).forEach(function(field) {
    const table = state[field];
    if (!table || typeof table !== 'object' || Array.isArray(table)) return;
    if (field === 'tombstones' || field === 'listTombstones' || field === 'listTombstoneNames') {
      ['g', field === 'tombstones' ? 'm' : 'ms'].forEach(function(side) {
        const sideTable = table[side];
        if (!sideTable || typeof sideTable !== 'object' || Array.isArray(sideTable)) return;
        Object.keys(sideTable).forEach(function(key) {
          assertKnownObjectKeys_(sideTable[key], recordFields[field], field + '.' + side + '[' + key + ']', errorCode);
        });
      });
      return;
    }
    Object.keys(table).forEach(function(key) {
      assertKnownObjectKeys_(table[key], recordFields[field], field + '[' + key + ']', errorCode);
    });
  });
}

// Schema 2 is accepted only as the deployed pre-list-lifecycle format.  It
// must not be a bypass for arbitrary fields that would be written back as a
// self-corrupting schema-3 state on the next save.  Task-delete evidence was
// already documented as backward-compatible, so it remains explicitly known.

function assertStrictSchema2StateShape_(state, errorCode) {
  if (!state || state.schema !== 2) return;
  const allowedTopLevel = [
    'schema', 'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskDeletionConflicts', 'listFaults', 'health', 'updatedAt'
  ];
  assertKnownObjectKeys_(state, allowedTopLevel, 'schema=2 state', errorCode);
  const recordFields = {
    g2m: ['msId', 'gListId', 'msListId', 'gUpdated', 'msUpdated'],
    pendingTaskDeletions: ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'firstConfirmedAt', 'lastConfirmedAt', 'lastRoundId', 'confirmations'],
    deletionJournal: ['phase', 'gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated',
      'preparedAt', 'lastBlockedReason', 'lastBlockedAt'],
    taskDeletionConflicts: ['at', 'reason', 'msId', 'gListId', 'msListId'],
    tombstones: ['at', 'source'],
    listFaults: ['at', 'reason', 'gListId', 'msListId', 'gListTitle', 'msListTitle']
  };
  ['listMap', 'm2g'].forEach(function(field) {
    const table = state[field];
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error((errorCode || 'STATE_MALFORMED') + ': schema=2 ' + field + ' must be an object.');
    }
    Object.keys(table).forEach(function(key) {
      if (typeof table[key] !== 'string') {
        throw new Error((errorCode || 'STATE_MALFORMED') + ': schema=2 ' + field + '[' + key + '] must be a string.');
      }
    });
  });
  if (!state.health || typeof state.health !== 'object' || Array.isArray(state.health)) {
    throw new Error((errorCode || 'STATE_MALFORMED') + ': schema=2 health must be an object.');
  }
  assertKnownObjectKeys_(state.health,
    ['lastSuccessfulSyncAt', 'lastFailedSyncAt', 'lastErrorMessage', 'consecutiveFailures',
      'lastSuccessfulRoundId', 'roundFenceProjectionId'],
    'schema=2 health', errorCode);
  Object.keys(recordFields).forEach(function(field) {
    const table = state[field];
    if (table === undefined) return;
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error((errorCode || 'STATE_MALFORMED') + ': schema=2 ' + field + ' must be an object.');
    }
    if (field === 'tombstones') {
      assertKnownObjectKeys_(table, ['g', 'm'], 'schema=2 tombstones', errorCode);
      ['g', 'm'].forEach(function(side) {
        const sideTable = table[side];
        if (sideTable === undefined) return;
        if (!sideTable || typeof sideTable !== 'object' || Array.isArray(sideTable)) {
          throw new Error((errorCode || 'STATE_MALFORMED') + ': schema=2 tombstones must contain g/m objects.');
        }
        Object.keys(sideTable).forEach(function(key) {
          assertKnownObjectKeys_(sideTable[key], recordFields[field], field + '.' + side + '[' + key + ']', errorCode);
        });
      });
      return;
    }
    if (field === 'listFaults') {
      assertKnownObjectKeys_(table, ['g', 'ms'], 'schema=2 listFaults', errorCode);
      ['g', 'ms'].forEach(function(side) {
        const sideTable = table[side];
        if (!sideTable || typeof sideTable !== 'object' || Array.isArray(sideTable)) {
          throw new Error((errorCode || 'STATE_MALFORMED') + ': schema=2 listFaults must contain g/ms objects.');
        }
        Object.keys(sideTable).forEach(function(key) {
          assertKnownObjectKeys_(sideTable[key], recordFields[field], field + '.' + side + '[' + key + ']', errorCode);
        });
      });
      return;
    }
    Object.keys(table).forEach(function(key) {
      assertKnownObjectKeys_(table[key], recordFields[field], field + '[' + key + ']', errorCode);
    });
  });
}

function validMoveCorrelationId_(value) {
  // Utilities.getUuid() produces the canonical UUID form.  Do not accept an
  // arbitrary non-empty string here: a malformed marker would otherwise turn a
  // stale journal into a potentially adoptable remote task.
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function newMoveCorrelationId_() {
  if (typeof Utilities !== 'undefined' && Utilities && typeof Utilities.getUuid === 'function') {
    const value = Utilities.getUuid();
    if (validMoveCorrelationId_(value)) return value;
    throw new Error('MOVE_CORRELATION_GENERATION_FAILED: Utilities.getUuid() did not return a valid UUID.');
  }
  // Node tests do not provide Apps Script Utilities.  This fallback is never
  // used in Apps Script, but keeps the pure synchronizer testable there.
  function hex(count) {
    let value = '';
    while (value.length < count) value += Math.floor(Math.random() * 0x100000000).toString(16);
    return value.slice(0, count);
  }
  return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-8' + hex(3) + '-' + hex(12);
}

function normalizeState_(state) {
  if (state === undefined || state === null) return newState_();
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('STATE_MALFORMED: Sync state must be an object; overwrite refused.');
  }
  if (state.schema !== 2 && state.schema !== 3) {
    throw new Error('STATE_SCHEMA_UNSUPPORTED: Only schema=2 or schema=3 is supported; overwrite refused.');
  }
  // Validate the deployed schema 2 shape before its additive migration, then
  // validate the complete schema 3 lifecycle state. Silently ignoring a
  // typoed journal can recreate a remotely deleted list or task.
  assertStrictSchema2StateShape_(state, 'STATE_MALFORMED');
  assertStrictSchema3StateShape_(state, 'STATE_MALFORMED');
  const isSchema2 = state.schema === 2;
  // Schema 2 has no list lifecycle provenance.  Upgrade only by adding empty
  // fields; never infer proof or discard unknown malformed values.
  if (isSchema2) state.schema = 3;
  const requiredObjects = [
    'listMap', 'g2m', 'm2g', 'tombstones', 'pendingTaskDeletions',
    'deletionJournal', 'taskDeletionConflicts', 'listFaults', 'health'
  ];
  requiredObjects.forEach(function(field) {
    if (state[field] === undefined) state[field] = {};
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error('STATE_MALFORMED: ' + field + ' must be an object; overwrite refused.');
    }
  });
  ['taskMoveJournal', 'listPairMeta', 'pendingListDeletions', 'listDeletionJournal',
    'listDeletionConflicts'].forEach(function(field) {
    if (state[field] === undefined) state[field] = {};
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error('STATE_MALFORMED: ' + field + ' must be an object; overwrite refused.');
    }
  });
  if (state.listTombstones === undefined) state.listTombstones = { g: {}, ms: {} };
  if (!state.listTombstones || typeof state.listTombstones !== 'object' || Array.isArray(state.listTombstones) ||
      !state.listTombstones.g || typeof state.listTombstones.g !== 'object' || Array.isArray(state.listTombstones.g) ||
      !state.listTombstones.ms || typeof state.listTombstones.ms !== 'object' || Array.isArray(state.listTombstones.ms)) {
    throw new Error('STATE_MALFORMED: listTombstones must contain g/ms objects; overwrite refused.');
  }
  if (state.listTombstoneNames === undefined) {
    if (!isSchema2) {
      throw new Error('STATE_MALFORMED: schema=3 is missing listTombstoneNames; name protections will not be inferred or rebuilt.');
    }
    state.listTombstoneNames = { g: {}, ms: {} };
  }
  if (!state.listTombstoneNames || typeof state.listTombstoneNames !== 'object' || Array.isArray(state.listTombstoneNames) ||
      !state.listTombstoneNames.g || typeof state.listTombstoneNames.g !== 'object' || Array.isArray(state.listTombstoneNames.g) ||
      !state.listTombstoneNames.ms || typeof state.listTombstoneNames.ms !== 'object' || Array.isArray(state.listTombstoneNames.ms)) {
    throw new Error('STATE_MALFORMED: listTombstoneNames must contain g/ms objects; overwrite refused.');
  }
  if (!state.tombstones.g || typeof state.tombstones.g !== 'object' || Array.isArray(state.tombstones.g) ||
      !state.tombstones.m || typeof state.tombstones.m !== 'object' || Array.isArray(state.tombstones.m)) {
    throw new Error('STATE_MALFORMED: tombstones must contain g/m objects; overwrite refused.');
  }
  if (!state.listFaults.g || typeof state.listFaults.g !== 'object' || Array.isArray(state.listFaults.g) ||
      !state.listFaults.ms || typeof state.listFaults.ms !== 'object' || Array.isArray(state.listFaults.ms)) {
    throw new Error('STATE_MALFORMED: listFaults must contain g/ms objects; overwrite refused.');
  }
  // A schema-2 state becomes schema=3 above. Re-run strict validation only
  // after every additive default is present, so no unknown top-level or task
  // lifecycle record can be silently persisted into a future self-corruption.
  assertStrictSchema3StateShape_(state, 'STATE_MALFORMED');
  assertListMapOneToOne_(state, 'STATE_MALFORMED');
  validateLoadedListDeletionState_(state);
  state.health.lastSuccessfulSyncAt = state.health.lastSuccessfulSyncAt || null;
  state.health.lastFailedSyncAt = state.health.lastFailedSyncAt || null;
  // Rewrite legacy raw error text at the load boundary before any inspection
  // report can expose it. The stored field remains a string for compatibility.
  state.health.lastErrorMessage = state.health.lastErrorMessage ?
    redactHealthErrorMessage_(state.health.lastErrorMessage) : null;
  state.health.consecutiveFailures = state.health.consecutiveFailures || 0;
  state.health.lastSuccessfulRoundId = state.health.lastSuccessfulRoundId || null;
  state.health.roundFenceProjectionId = state.health.roundFenceProjectionId || null;
  // Do not rebuild reverse mappings during a migration.  Repairing a corrupt
  // state by deleting information can recreate remotely deleted objects.
  Object.keys(state.pendingTaskDeletions).forEach(function(gId) {
    const pending = state.pendingTaskDeletions[gId];
    if (!state.g2m[gId]) {
      throw new Error('STATE_MALFORMED: pendingTaskDeletions[' + gId + '] has no mapping; overwrite refused.');
      return;
    }
    // A ready 2/2 candidate must already have a prepared deletion journal.
    // Legacy residue has no proof that its second round completed, so discard
    // it entirely: the next sync must begin a fresh 1/2 confirmation.
    if (pending && Number(pending.confirmations || 0) > 1) {
      // Ready task candidates have never been durable proof (a journal is the
      // only safe second-round state), including in old in-memory test/state
      // exports. Discard this specific legacy task residue; schema-3 list
      // lifecycle fields remain strict and are never normalized away.
      delete state.pendingTaskDeletions[gId];
    }
  });
  Object.keys(state.taskDeletionConflicts).forEach(function(gId) {
    if (!state.g2m[gId]) {
      throw new Error('STATE_MALFORMED: taskDeletionConflicts[' + gId + '] has no mapping; overwrite refused.');
    }
  });
  Object.keys(state.taskMoveJournal).forEach(function(gId) {
    const journal = state.taskMoveJournal[gId];
    const mapping = state.g2m[gId];
    const validMovePhases = ['creating', 'retry_create', 'created'];
    if (!journal || !mapping || journal.gId !== gId || journal.oldMsId !== mapping.msId ||
        journal.oldMsListId !== mapping.msListId || !journal.targetMsListId ||
      !journal.gListId || !journal.preparedAt || !validMoveFingerprint_(journal.fingerprint) ||
        validMovePhases.indexOf(journal.phase) < 0 ||
        (journal.phase === 'created' && !journal.newMsId) ||
        !Number.isInteger(Number(journal.uncertainConfirmations || 0)) ||
        Number(journal.uncertainConfirmations || 0) < 0 ||
        Number(journal.uncertainConfirmations || 0) > 2 ||
        (Object.prototype.hasOwnProperty.call(journal, 'correlationId') &&
          !validMoveCorrelationId_(journal.correlationId))) {
      throw new Error('STATE_MALFORMED: taskMoveJournal[' + gId +
        '] is inconsistent with its mapping or lacks restoration evidence; overwrite refused.');
    }
  });
  return state;
}

function truncateLabel_(value, max) {
  value = String(value || '');
  max = max || 80;
  return value.length <= max ? value : value.slice(0, max) + '…';
}

function utf8ByteLength_(value) {
  // Mirrors the UTF-8 byte length produced by TextEncoder without depending
  // on TextEncoder, Utilities, or Buffer (Apps Script and Node differ here).
  // Lone surrogate code units are encoded as U+FFFD, matching TextEncoder.
  const text = String(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const codeUnit = text.charCodeAt(i);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF &&
        i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function assertPropertyStorePreflight_(props, replacements) {
  const projected = Object.assign({}, props.getProperties() || {});
  Object.keys(replacements).forEach(function(key) {
    const value = String(replacements[key]);
    const valueBytes = utf8ByteLength_(value);
    if (valueBytes > PROPERTY_VALUE_SAFE_LIMIT_BYTES) {
      throw new Error('STATE_PROPERTY_VALUE_LIMIT: a state property would exceed the safe per-value limit.');
    }
    projected[key] = value;
  });
  const bytes = Object.keys(projected).reduce(function(total, key) {
    return total + utf8ByteLength_(key) + utf8ByteLength_(projected[key]);
  }, 0);
  if (bytes > PROPERTY_STORE_SAFE_LIMIT_BYTES) {
    throw new Error('STATE_STORE_LIMIT: projected User Properties usage exceeds the safe storage limit.');
  }
  return bytes;
}

function propertyStoreUsageBytes_(props) {
  const values = props.getProperties() || {};
  return Object.keys(values).reduce(function(total, key) {
    return total + utf8ByteLength_(key) + utf8ByteLength_(values[key]);
  }, 0);
}

function validStateGenerationId_(generation) {
  // Generation IDs are used only as a suffix in Properties keys.  Keep the
  // accepted legacy alphabet small enough that a manifest cannot redirect a
  // read or cleanup toward an arbitrary key family.
  return typeof generation === 'string' && /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/.test(generation) &&
    generation.length <= 128;
}

function validStateGenerationCount_(count) {
  return Number.isInteger(Number(count)) && Number(count) >= 1 &&
    Number(count) <= MAX_STATE_GENERATION_CHUNKS;
}

function parseStatePointerManifest_(raw, errorCode) {
  const code = errorCode || 'STATE_MANIFEST_CORRUPT';
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(code + ': State manifest cannot be parsed.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !validStateGenerationId_(manifest.generation) || !validStateGenerationCount_(manifest.count) ||
      (manifest.previousGeneration !== null && manifest.previousGeneration !== undefined &&
        !validStateGenerationId_(manifest.previousGeneration))) {
    throw new Error(code + ': State manifest has an invalid generation or chunk count.');
  }
  if (!hasLegacyStateCodec_(manifest)) assertStateCodecManifest_(manifest, code);
  return manifest;
}

function requireStateUtilities_() {
  if (typeof Utilities === 'undefined' || !Utilities ||
      typeof Utilities.newBlob !== 'function' ||
      typeof Utilities.gzip !== 'function' ||
      typeof Utilities.ungzip !== 'function' ||
      typeof Utilities.base64Encode !== 'function' ||
      typeof Utilities.base64Decode !== 'function' ||
      typeof Utilities.computeDigest !== 'function' ||
      !Utilities.DigestAlgorithm || !Utilities.DigestAlgorithm.SHA_256) {
    throw new Error('STATE_CODEC_UNAVAILABLE: Apps Script Utilities gzip and SHA-256 support is required.');
  }
}

function stateDigest_(json) {
  requireStateUtilities_();
  const charset = Utilities.Charset && Utilities.Charset.UTF_8;
  const digest = charset
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json, charset)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json);
  return Utilities.base64Encode(digest);
}

function encodeStateGeneration_(value) {
  const startedAt = Date.now();
  requireStateUtilities_();
  try {
    const json = JSON.stringify(value);
    const uncompressedUtf8Bytes = utf8ByteLength_(json);
    if (uncompressedUtf8Bytes > MAX_STATE_UNCOMPRESSED_BYTES) {
      throw new Error('STATE_UNCOMPRESSED_LIMIT: State JSON exceeds the safe decoded-size limit.');
    }
    const compressed = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
    return {
      encoded: Utilities.base64Encode(compressed.getBytes()),
      codec: STATE_CODEC_GZIP_BASE64,
      codecVersion: STATE_CODEC_VERSION,
      integrity: {
        algorithm: STATE_INTEGRITY_ALGORITHM,
        encoding: STATE_INTEGRITY_ENCODING,
        value: stateDigest_(json)
      },
      uncompressedUtf8Bytes: uncompressedUtf8Bytes
    };
  } finally {
    recordStateCodecCall_('encode', startedAt);
  }
}

function hasLegacyStateCodec_(manifest) {
  return !Object.prototype.hasOwnProperty.call(manifest, 'codec') &&
    !Object.prototype.hasOwnProperty.call(manifest, 'codecVersion') &&
    !Object.prototype.hasOwnProperty.call(manifest, 'integrity') &&
    !Object.prototype.hasOwnProperty.call(manifest, 'uncompressedUtf8Bytes');
}

function assertStateCodecManifest_(manifest, errorCode) {
  const code = errorCode || 'STATE_CODEC_CORRUPT';
  if (manifest.codec !== STATE_CODEC_GZIP_BASE64 || manifest.codecVersion !== STATE_CODEC_VERSION ||
      !manifest.integrity || typeof manifest.integrity !== 'object' || Array.isArray(manifest.integrity) ||
      manifest.integrity.algorithm !== STATE_INTEGRITY_ALGORITHM ||
      manifest.integrity.encoding !== STATE_INTEGRITY_ENCODING ||
      typeof manifest.integrity.value !== 'string' || !manifest.integrity.value ||
      !Number.isInteger(Number(manifest.uncompressedUtf8Bytes)) ||
      Number(manifest.uncompressedUtf8Bytes) < 0 ||
      Number(manifest.uncompressedUtf8Bytes) > MAX_STATE_UNCOMPRESSED_BYTES) {
    throw new Error(code + ': State generation has an unknown or incomplete codec manifest.');
  }
}

function stateCodecEvidenceMatches_(left, right) {
  return !!left && !!right && left.codec === right.codec &&
    left.codecVersion === right.codecVersion && !!left.integrity && !!right.integrity &&
    left.integrity.algorithm === right.integrity.algorithm &&
    left.integrity.encoding === right.integrity.encoding &&
    left.integrity.value === right.integrity.value &&
    Number(left.uncompressedUtf8Bytes) === Number(right.uncompressedUtf8Bytes);
}

function stateGenerationManifest_(props, prefix, pointerManifest, errorCode) {
  const code = errorCode || 'STATE_CODEC_CORRUPT';
  const raw = props.getProperty(prefix + 'meta');
  if (!raw) {
    if (!pointerManifest || hasLegacyStateCodec_(pointerManifest)) return pointerManifest || {};
    throw new Error(code + ': State generation codec metadata is missing.');
  }
  let generationManifest;
  try {
    generationManifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(code + ': State generation codec metadata cannot be parsed.');
  }
  assertStateCodecManifest_(generationManifest, code);
  // Restore targets intentionally have no mutable pointer manifest to compare:
  // their own generation metadata is the complete codec contract.
  if (!pointerManifest) return generationManifest;
  if (!hasLegacyStateCodec_(pointerManifest) && !stateCodecEvidenceMatches_(pointerManifest, generationManifest)) {
    throw new Error(code + ': State manifest codec evidence does not match its generation.');
  }
  if (hasLegacyStateCodec_(pointerManifest)) {
    throw new Error(code + ': Legacy state manifest cannot point at a coded generation.');
  }
  return generationManifest;
}

function protectedStateGenerations_(props) {
  const protectedGenerations = [];
  const rawCurrent = props.getProperty(STATE_KEY + '_manifest');
  if (rawCurrent) {
    const current = parseStatePointerManifest_(rawCurrent, 'STATE_MANIFEST_CORRUPT');
    protectedGenerations.push(current.generation);
  }
  const restoreGeneration = successfulRoundRestoreGeneration_(props);
  if (restoreGeneration) protectedGenerations.push(restoreGeneration);
  return protectedGenerations.filter(function(generation, index, all) {
    return all.indexOf(generation) === index;
  });
}

function reclaimOrphanedStateGenerations_(props) {
  const generations = protectedStateGenerations_(props);
  const keepPrefixes = generations.map(function(generation) {
    return STATE_KEY + '_gen_' + generation + '_';
  });
  const orphanKeys = props.getKeys().filter(function(key) {
    if (key.indexOf(STATE_KEY + '_gen_') !== 0) return false;
    return !keepPrefixes.some(function(prefix) { return key.indexOf(prefix) === 0; });
  });
  orphanKeys.forEach(function(key) { props.deleteProperty(key); });
}

function assertCompleteStateGenerationKeys_(props, prefix, count, manifest, errorCode) {
  const code = errorCode || 'STATE_CODEC_CORRUPT';
  const expected = {};
  for (let i = 0; i < count; i++) expected[prefix + i] = true;
  expected[prefix + 'count'] = true;
  const hasMeta = props.getProperty(prefix + 'meta') !== null;
  if (hasMeta) expected[prefix + 'meta'] = true;
  if (hasMeta === hasLegacyStateCodec_(manifest)) {
    throw new Error(code + ': State generation codec metadata does not match its manifest.');
  }
  const unknown = props.getKeys().filter(function(key) {
    return key.indexOf(prefix) === 0 && !expected[key];
  });
  if (unknown.length) {
    throw new Error(code + ': State generation has unexpected or excess chunks.');
  }
}

function decodeStateGeneration_(encoded, manifest, errorCode) {
  const code = errorCode || 'STATE_CODEC_CORRUPT';
  if (hasLegacyStateCodec_(manifest)) {
    return JSON.parse(decodeURIComponent(encoded));
  }
  assertStateCodecManifest_(manifest, code);
  const startedAt = Date.now();
  requireStateUtilities_();
  try {
    let json;
    try {
      const compressed = Utilities.newBlob(Utilities.base64Decode(encoded), 'application/gzip');
      json = Utilities.ungzip(compressed).getDataAsString();
    } catch (e) {
      throw new Error(code + ': State generation cannot be decompressed.');
    }
    if (utf8ByteLength_(json) !== Number(manifest.uncompressedUtf8Bytes)) {
      throw new Error(code + ': State generation uncompressed length check failed.');
    }
    if (stateDigest_(json) !== manifest.integrity.value) {
      throw new Error(code + ': State generation integrity check failed.');
    }
    try {
      return JSON.parse(json);
    } catch (e) {
      throw new Error(code + ': State generation JSON cannot be parsed.');
    }
  } finally {
    recordStateCodecCall_('decode', startedAt);
  }
}

function saveBlobAtomic_(baseKey, value) {
  const props = PropertiesService.getUserProperties();
  // A successful-round recovery target can be older than the ordinary prior
  // checkpoint. Read it before any write so cleanup never deletes that target.
  const oldManifestRaw = props.getProperty(baseKey + '_manifest');
  let previousGeneration = null;
  if (oldManifestRaw) {
    try {
      previousGeneration = baseKey === STATE_KEY
        ? (parseStatePointerManifest_(oldManifestRaw, 'STATE_MANIFEST_CORRUPT'), null)
        : JSON.parse(oldManifestRaw).generation || null;
    } catch (e) {
      if (baseKey === STATE_KEY) throw e;
      previousGeneration = null;
    }
  }
  // Only the durable sync state uses the new codec.  This helper is also used
  // by diagnostic/test blobs, whose legacy wire format remains intentionally
  // unchanged so this migration cannot alter any unrelated storage contract.
  const stateEncoding = baseKey === STATE_KEY ? encodeStateGeneration_(value) : null;
  const encoded = stateEncoding ? stateEncoding.encoded : encodeURIComponent(JSON.stringify(value));
  // A failed batch write can leave chunks whose manifest was never promoted.
  // Remove only generations not protected by fully validated current/previous
  // or successful-round pointers, before calculating the next peak usage.
  // Encoding happens first so an invalid new state never changes storage.
  if (baseKey === STATE_KEY) reclaimOrphanedStateGenerations_(props);
  let generation = String(Date.now()) + '_' + Math.floor(Math.random() * 1000000);
  let uniquenessAttempts = 0;
  while (props.getProperty(baseKey + '_gen_' + generation + '_count') !== null) {
    uniquenessAttempts += 1;
    if (uniquenessAttempts > 10) {
      throw new Error('STATE_GENERATION_ID_COLLISION: could not allocate a unique state generation.');
    }
    generation = String(Date.now()) + '_' + Math.floor(Math.random() * 1000000);
  }
  const prefix = baseKey + '_gen_' + generation + '_';
  const batch = {};
  let count = 0;
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    batch[prefix + count] = encoded.slice(i, i + CHUNK_SIZE);
    count++;
  }
  batch[prefix + 'count'] = String(count);
  const manifest = {
    generation: generation,
    count: count,
    previousGeneration: previousGeneration
  };
  if (stateEncoding) {
    manifest.codec = stateEncoding.codec;
    manifest.codecVersion = stateEncoding.codecVersion;
    manifest.integrity = stateEncoding.integrity;
    manifest.uncompressedUtf8Bytes = stateEncoding.uncompressedUtf8Bytes;
    // Unlike the mutable pointer manifest, this follows the generation. It is
    // required for successful-round restore, which may target a generation
    // that stopped being current several saves ago.
    batch[prefix + 'meta'] = JSON.stringify({
      codec: stateEncoding.codec,
      codecVersion: stateEncoding.codecVersion,
      integrity: stateEncoding.integrity,
      uncompressedUtf8Bytes: stateEncoding.uncompressedUtf8Bytes
    });
  }
  const manifestValue = JSON.stringify(manifest);
  const prospectiveWrites = Object.assign({}, batch);
  prospectiveWrites[baseKey + '_manifest'] = manifestValue;
  // Cleanup only happens after a manifest has been durably replaced, so do
  // not subtract old chunks here. This rejects a write before any new chunk
  // when its short-lived peak would be unsafe.
  const projectedStoreBytes = assertPropertyStorePreflight_(props, prospectiveWrites);
  recordStateSaveCall_(baseKey);
  props.setProperties(batch, false);
  props.setProperty(baseKey + '_manifest', manifestValue);
  cleanupOldGenerations_(props, baseKey, generation, null,
    baseKey === STATE_KEY ? successfulRoundGenerations_(props) : []);
  if (baseKey === STATE_KEY) maybeSendStoragePressureAlert_(props, projectedStoreBytes);
  return generation;
}

function loadBlobAtomic_(baseKey) {
  const props = PropertiesService.getUserProperties();
  const rawManifest = props.getProperty(baseKey + '_manifest');
  if (!rawManifest) return null;
  try {
    const manifest = baseKey === STATE_KEY
      ? parseStatePointerManifest_(rawManifest, 'STATE_MANIFEST_CORRUPT')
      : JSON.parse(rawManifest);
    const prefix = baseKey + '_gen_' + manifest.generation + '_';
    if (baseKey === STATE_KEY) {
      assertCompleteStateGenerationKeys_(props, prefix, Number(manifest.count), manifest, 'STATE_CODEC_CORRUPT');
    }
    const parts = [];
    for (let i = 0; i < manifest.count; i++) {
      const piece = props.getProperty(prefix + i);
      if (piece === null) throw new Error('missing chunk ' + i);
      parts.push(piece);
    }
    const generationManifest = baseKey === STATE_KEY
      ? stateGenerationManifest_(props, prefix, manifest, 'STATE_CODEC_CORRUPT')
      : manifest;
    return baseKey === STATE_KEY
      ? decodeStateGeneration_(parts.join(''), generationManifest, 'STATE_CODEC_CORRUPT')
      : JSON.parse(decodeURIComponent(parts.join('')));
  } catch (e) {
    console.error('[Storage] Read failed: ' + e.message);
    return null;
  }
}

function cleanupOldGenerations_(props, baseKey, keepGeneration, previousGeneration, retainedGenerations) {
  const keepPrefixes = [baseKey + '_gen_' + keepGeneration + '_'];
  if (previousGeneration) {
    keepPrefixes.push(baseKey + '_gen_' + previousGeneration + '_');
  }
  (retainedGenerations || []).forEach(function(generation) {
    if (generation) keepPrefixes.push(baseKey + '_gen_' + generation + '_');
  });
  const deleteKeys = props.getKeys().filter(function(key) {
    if (key.indexOf(baseKey + '_gen_') !== 0) return false;
    return !keepPrefixes.some(function(prefix) {
      return key.indexOf(prefix) === 0;
    });
  });
  deleteKeys.forEach(function(key) {
    props.deleteProperty(key);
  });
}

function saveState_(state) {
  state.updatedAt = new Date().toISOString();
  return saveBlobAtomic_(STATE_KEY, state);
}

function validSuccessfulRoundEntry_(entry) {
  return !!entry && typeof entry === 'object' &&
    validStateGenerationId_(entry.generation) &&
    typeof entry.roundId === 'string' && !!entry.roundId;
}

function successfulRoundManifest_(props) {
  const raw = props.getProperty(SUCCESSFUL_ROUND_MANIFEST_KEY);
  if (!raw) return null;
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error('STATE_SUCCESSFUL_ROUND_MANIFEST_CORRUPT: Successful-round restore pointer cannot be parsed.');
  }
  if (!manifest || manifest.version !== 1 || !validSuccessfulRoundEntry_(manifest.current) ||
      (manifest.previous !== null && manifest.previous !== undefined && !validSuccessfulRoundEntry_(manifest.previous))) {
    throw new Error('STATE_SUCCESSFUL_ROUND_MANIFEST_CORRUPT: Successful-round restore pointer has an invalid format.');
  }
  return manifest;
}

function successfulRoundGenerations_(props) {
  const manifest = successfulRoundManifest_(props);
  if (!manifest) return [];
  const target = successfulRoundRestoreGeneration_(props, manifest);
  return target ? [target] : [];
}

function successfulRoundRestoreGeneration_(props, successful) {
  const manifest = successful || successfulRoundManifest_(props);
  if (!manifest) return null;
  const rawCurrent = props.getProperty(STATE_KEY + '_manifest');
  if (!rawCurrent) {
    throw new Error('STATE_RESTORE_UNAVAILABLE: Current-state manifest is required to select a successful restore target.');
  }
  const current = parseStatePointerManifest_(rawCurrent, 'STATE_MANIFEST_CORRUPT');
  const target = current.generation === manifest.current.generation
    ? (manifest.previous && manifest.previous.generation)
    : manifest.current.generation;
  if (!target) return null;
  if (!validStateGenerationId_(target)) {
    throw new Error('STATE_SUCCESSFUL_ROUND_MANIFEST_CORRUPT: Successful-round restore pointer has an invalid generation.');
  }
  const prefix = STATE_KEY + '_gen_' + target + '_';
  const count = Number(props.getProperty(prefix + 'count'));
  if (!validStateGenerationCount_(count)) {
    throw new Error('STATE_RESTORE_CORRUPT: Successful-round restore target is missing or incomplete.');
  }
  for (let i = 0; i < count; i++) {
    if (props.getProperty(prefix + i) === null) {
      throw new Error('STATE_RESTORE_CORRUPT: Successful-round restore target is missing or incomplete.');
    }
  }
  return target;
}

function loadStateGeneration_(props, generation, errorCode) {
  if (!validStateGenerationId_(generation)) {
    throw new Error((errorCode || 'STATE_RESTORE_CORRUPT') + ': Target generation has an invalid ID.');
  }
  const prefix = STATE_KEY + '_gen_' + generation + '_';
  const count = Number(props.getProperty(prefix + 'count'));
  if (!validStateGenerationCount_(count)) {
    throw new Error((errorCode || 'STATE_RESTORE_CORRUPT') + ': Target generation has no valid count.');
  }
  const parts = [];
  // Restore has no mutable base manifest to compare against. Its own metadata
  // is nevertheless mandatory for gzip generations and prohibited for legacy.
  const rawMeta = props.getProperty(prefix + 'meta');
  const restoreManifest = rawMeta ? { codec: STATE_CODEC_GZIP_BASE64 } : {};
  assertCompleteStateGenerationKeys_(props, prefix, count, restoreManifest,
    errorCode || 'STATE_RESTORE_CORRUPT');
  for (let i = 0; i < count; i++) {
    const piece = props.getProperty(prefix + i);
    if (piece === null) throw new Error((errorCode || 'STATE_RESTORE_CORRUPT') + ': Target generation is missing chunk ' + i + '.');
    parts.push(piece);
  }
  let manifest;
  try {
    // Codec metadata is generation-local because a successful-round pointer
    // may deliberately target an older retained generation.
    manifest = stateGenerationManifest_(props, prefix, null,
      errorCode || 'STATE_RESTORE_CORRUPT');
    return normalizeState_(decodeStateGeneration_(parts.join(''), manifest, errorCode || 'STATE_RESTORE_CORRUPT'));
  } catch (e) {
    if (String(e.message || '').indexOf(errorCode || 'STATE_RESTORE_CORRUPT') === 0) throw e;
    throw new Error((errorCode || 'STATE_RESTORE_CORRUPT') + ': Target generation cannot be read. ' + String(e && e.message ? e.message : e));
  }
}

function currentStateGeneration_(props) {
  const raw = props.getProperty(STATE_KEY + '_manifest');
  if (!raw) throw new Error('STATE_RESTORE_UNAVAILABLE: Current-state manifest not found.');
  const manifest = parseStatePointerManifest_(raw, 'STATE_RESTORE_CORRUPT');
  return manifest.generation;
}

function recordSuccessfulSyncRound_(roundId, generation) {
  const props = PropertiesService.getUserProperties();
  if (typeof generation !== 'string' || !generation) {
    throw new Error('STATE_SUCCESSFUL_ROUND_GENERATION_REQUIRED: A successful sync round must reference a verified final-state generation.');
  }
  const existing = successfulRoundManifest_(props);
  if (existing && existing.current.generation === generation && existing.current.roundId === roundId) return true;
  if (existing && existing.current.generation === generation) {
    throw new Error('STATE_SUCCESSFUL_ROUND_MANIFEST_CORRUPT: The same state generation maps to different successful rounds.');
  }
  const next = {
    version: 1,
    current: { generation: generation, roundId: roundId, committedAt: new Date().toISOString() },
    previous: existing ? existing.current : null
  };
  props.setProperty(SUCCESSFUL_ROUND_MANIFEST_KEY, JSON.stringify(next));
  const written = successfulRoundManifest_(props);
  if (!written || written.current.generation !== generation || written.current.roundId !== roundId) {
    throw new Error('STATE_SUCCESSFUL_ROUND_MANIFEST_WRITE_FAILED: Successful-round restore pointer could not be verified.');
  }
  // Drop obsolete ordinary checkpoints only after the new durable pointer was
  // verified. Its current and previous entries remain protected by cleanup.
  const rawCurrentManifest = props.getProperty(STATE_KEY + '_manifest');
  if (!rawCurrentManifest) {
    throw new Error('STATE_SUCCESSFUL_ROUND_MANIFEST_WRITE_FAILED: Current-state manifest is missing.');
  }
  const currentManifest = parseStatePointerManifest_(rawCurrentManifest,
    'STATE_SUCCESSFUL_ROUND_MANIFEST_WRITE_FAILED');
 cleanupOldGenerations_(props, STATE_KEY, currentManifest.generation, null,
 successfulRoundGenerations_(props));
  return true;
}

function syncRoundFenceStatus_() {
  const raw = PropertiesService.getUserProperties().getProperty(ROUND_FENCE_KEY);
  if (!raw) return { active: false };
  try {
    const fence = JSON.parse(raw);
    return {
      active: true,
      valid: !!fence && typeof fence === 'object' && typeof fence.roundId === 'string' && !!fence.roundId &&
        ['arming', 'active'].indexOf(fence.phase) >= 0,
      roundId: fence && fence.roundId || null,
      startedAt: fence && fence.startedAt || null,
      phase: fence && fence.phase || null
    };
  } catch (e) {
    return { active: true, valid: false, roundId: null, startedAt: null, phase: null };
  }
}

function assertNoActiveSyncRoundFence_(code) {
  const fence = syncRoundFenceStatus_();
  if (fence.active) {
    throw new Error((code || 'STATE_CHANGE') +
      '_ROUND_FENCE_ACTIVE: The previous sync round did not complete its durable commit; run syncAll() to recover safely.');
  }
}

function openSyncRoundFence_(roundId) {
  const props = PropertiesService.getUserProperties();
  const expectedRoundId = String(roundId || Date.now());
  SYNC_ROUND_FENCE_ACTIVE_ = false;
  SYNC_ROUND_FENCE_ROUND_ID_ = null;
  SYNC_ROUND_PROOF_BASELINE_ = null;
  try {
    props.setProperty(ROUND_FENCE_KEY, JSON.stringify({
      roundId: expectedRoundId,
      startedAt: new Date().toISOString(),
      // The immediately following durable projection changes this to active.
      // A crash while arming has made no current-round proof durable.
      phase: 'arming'
    }));
    const written = JSON.parse(props.getProperty(ROUND_FENCE_KEY) || 'null');
    if (!written || written.roundId !== expectedRoundId || written.phase !== 'arming') {
      throw new Error('round fence read-back mismatch');
    }
  } catch (e) {
    SYNC_ROUND_FENCE_ACTIVE_ = false;
    throw new Error('SYNC_ROUND_FENCE_SET_FAILED: Could not create the sync safety fence; stopped before inventory. ' + e.message);
  }
  SYNC_ROUND_FENCE_ACTIVE_ = true;
  SYNC_ROUND_FENCE_ROUND_ID_ = expectedRoundId;
}

function activateSyncRoundFence_(roundId) {
  const props = PropertiesService.getUserProperties();
  const expectedRoundId = String(roundId || SYNC_ROUND_FENCE_ROUND_ID_ || '');
  const raw = props.getProperty(ROUND_FENCE_KEY);
  let fence;
  try {
    fence = JSON.parse(raw || 'null');
  } catch (e) {
    fence = null;
  }
  if (!fence || fence.roundId !== expectedRoundId || fence.phase !== 'arming') {
    throw new Error('SYNC_ROUND_FENCE_ACTIVATE_FAILED: Sync fence could not transition from arming to active.');
  }
  fence.phase = 'active';
  props.setProperty(ROUND_FENCE_KEY, JSON.stringify(fence));
  const written = syncRoundFenceStatus_();
  if (!written.active || !written.valid || written.roundId !== expectedRoundId || written.phase !== 'active') {
    throw new Error('SYNC_ROUND_FENCE_ACTIVATE_FAILED: Sync fence active read-back does not match.');
  }
}

function clearSyncRoundFence_() {
  const props = PropertiesService.getUserProperties();
  try {
    props.deleteProperty(ROUND_FENCE_KEY);
    if (props.getProperty(ROUND_FENCE_KEY)) {
      throw new Error('round fence property still exists');
    }
  } catch (e) {
    // Keep the execution-local flag true as well. The next sync verifies the
    // durable state before selecting final-commit recovery or the safe baseline.
    throw new Error('SYNC_ROUND_FENCE_CLEAR_FAILED: Final state was saved but the safety fence could not be cleared; the next round will verify durable state before recovering safely. ' + e.message);
  }
  SYNC_ROUND_FENCE_ACTIVE_ = false;
  SYNC_ROUND_FENCE_ROUND_ID_ = null;
  SYNC_ROUND_PROOF_BASELINE_ = null;
}

function exactJournalListPairMeta_(state) {
  const preserved = {};
  ensureListDeletionState_(state);
  Object.keys(state.listDeletionJournal || {}).forEach(function(key) {
    const journal = state.listDeletionJournal[key];
    if (!journal || ['prepared', 'paused'].indexOf(journal.phase) < 0 ||
        !hasExactUniqueListMapPair_(state, journal.gListId, journal.msListId)) return;
    const meta = state.listPairMeta[key];
    if (meta && meta.gListId === journal.gListId && meta.msListId === journal.msListId) {
      preserved[key] = cloneTaskDeletionValue_(meta);
    }
  });
  return preserved;
}

function sameTaskDeletionCandidate_(before, current) {
  if (!before || !current) return false;
  return ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated'].every(function(field) {
    return before[field] === current[field];
  });
}

function roundBaselineTaskCandidates_(state, baseline) {
  const preserved = {};
  const pending = state.pendingTaskDeletions || {};
  Object.keys((baseline && baseline.pendingTaskDeletions) || {}).forEach(function(gId) {
    const before = baseline.pendingTaskDeletions[gId];
    const current = pending[gId];
    // Keep only an unchanged pre-round observation. A reappearance, explicit
    // pause, conflict, or changed missing-side scenario removes it instead of
    // resurrecting stale deletion proof.
    if (sameTaskDeletionCandidate_(before, current) && state.g2m[gId]) {
      preserved[gId] = cloneTaskDeletionValue_(before);
    }
  });
  return preserved;
}

function roundBaselineListCandidates_(state, baseline) {
  const preserved = {};
  const pending = state.pendingListDeletions || {};
  Object.keys((baseline && baseline.pendingListDeletions) || {}).forEach(function(key) {
    const before = baseline.pendingListDeletions[key];
    const current = pending[key];
    if (listDeletionScenarioMatches_(before, current) &&
        state.listMap[before.gListId] === before.msListId) {
      preserved[key] = cloneTaskDeletionValue_(before);
    }
  });
  return preserved;
}

function strippedVolatileProofState_(state, baseline, roundId) {
  const projected = cloneTaskDeletionValue_(state);
  ensureTaskDeletionState_(projected);
  ensureListDeletionState_(projected);
  // A journal is separately durable delete intent. It is the sole exception:
  // recovery needs its exact historical pair meta to classify a remote-success
  // one-sided delete as fresh both-missing, but malformed/rebound journals get
  // no provenance and therefore fail closed.
  projected.listPairMeta = exactJournalListPairMeta_(state);
  projected.pendingTaskDeletions = roundBaselineTaskCandidates_(state, baseline);
  projected.pendingListDeletions = roundBaselineListCandidates_(state, baseline);
  if (roundId) projected.health.roundFenceProjectionId = roundId;
  return projected;
}

function persistSyncState_(state, options) {
  const finalCommit = !!(options && options.finalCommit);
  if (SYNC_ROUND_FENCE_ACTIVE_ && !finalCommit) {
    return saveState_(strippedVolatileProofState_(state, SYNC_ROUND_PROOF_BASELINE_, SYNC_ROUND_FENCE_ROUND_ID_));
  }
  return saveState_(state);
}

function beginSyncRoundProofProjection_(state, roundId, pendingTaskDeletions, pendingListDeletions) {
  SYNC_ROUND_PROOF_BASELINE_ = {
    pendingTaskDeletions: cloneTaskDeletionValue_(pendingTaskDeletions || {}),
    pendingListDeletions: cloneTaskDeletionValue_(pendingListDeletions || {})
  };
  persistSyncState_(state);
  activateSyncRoundFence_(roundId);
}

function sanitizePreexistingSyncRoundFence_(state) {
  const fence = syncRoundFenceStatus_();
  if (!fence.active) return state;
  // This runs before opening the new fence and before every inventory/remote
  // call. Persist first; clear second. A clear failure leaves the old fence
  // for an idempotent repeat and blocks the new round.
  if (!fence.valid) {
    // No verified round identity means no way to distinguish a final commit
    // from volatile proof. Retain the legacy fail-closed behavior.
    const sanitized = strippedVolatileProofState_(state);
    saveState_(sanitized);
    clearSyncRoundFence_();
    return sanitized;
  }
  if (fence.phase === 'arming') {
    // Arming precedes the first inventory/API call. If a hard stop lands in
    // that tiny window, the current state is still the prior completed state.
    clearSyncRoundFence_();
    return state;
  }
  const health = state.health || {};
  if (health.lastSuccessfulRoundId === fence.roundId) {
    // The final main-state commit won the race with the crash. Repair a missed
    // successful-round pointer before releasing the fence.
    const props = PropertiesService.getUserProperties();
    recordSuccessfulSyncRound_(fence.roundId, currentStateGeneration_(props));
    clearSyncRoundFence_();
    return state;
  }
  if (health.roundFenceProjectionId === fence.roundId) {
    // This is the durable non-final projection written immediately after the
    // fence was armed. It contains only the round-start proof baseline.
    clearSyncRoundFence_();
    return state;
  }
  // State created before the projection protocol has no trustworthy marker.
  // Keep the old fail-closed migration path rather than treating a checkpoint
  // as a successful round.
  const sanitized = strippedVolatileProofState_(state);
  saveState_(sanitized);
  clearSyncRoundFence_();
  return sanitized;
}

function loadStateForSync_() {
  const props = PropertiesService.getUserProperties();
  const rawManifest = props.getProperty(STATE_KEY + '_manifest');
  if (!rawManifest) {
    return newState_();
  }
  const raw = loadBlobAtomic_(STATE_KEY);
  if (!raw) {
    throw new Error('STATE_CORRUPT: State exists but cannot be read. Run exportRawSyncState() and pause syncing.');
  }
  return normalizeState_(raw);
}

function loadStateForInspection_() {
  const props = PropertiesService.getUserProperties();
  const rawManifest = props.getProperty(STATE_KEY + '_manifest');
  const raw = loadBlobAtomic_(STATE_KEY);
  if (rawManifest && !raw) {
    return { corrupt: true, state: newState_() };
  }
  try {
    return { corrupt: false, state: normalizeState_(raw) };
  } catch (e) {
    // Inspection must never make malformed resurrection evidence invisible.
    // Keep mutation paths fail-closed in loadStateForSync_, but allow health
    // to report bounded list-tombstone direction/alias reason codes.
    return {
      corrupt: true,
      state: newState_(),
      listTombstoneIntegrityIssues: listTombstoneIntegrityIssues_(raw)
    };
  }
}

function tombstoneEvidenceIsUnexpired_(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return true;
  const at = Number(record.at);
  // Malformed tombstone evidence is deliberately retained by cleanup and must
  // therefore also survive import/restore until an operator reviews it.
  if (!isFinite(at)) return true;
  return at > now - TOMBSTONE_TTL_MS;
}

function assertTombstoneEvidencePreserved_(current, replacement, now) {
  now = now === undefined ? Date.now() : now;
  const replacementTask = replacement && replacement.tombstones || {};
  [
    { current: current.tombstones || {}, replacement: replacementTask, sides: ['g', 'm'], label: 'task tombstone' }
  ].forEach(function(group) {
    group.sides.forEach(function(side) {
      const currentSide = group.current[side] || {};
      const replacementSide = group.replacement[side] || {};
      Object.keys(currentSide).forEach(function(idOrName) {
        const existing = currentSide[idOrName];
        if (!tombstoneEvidenceIsUnexpired_(existing, now)) return;
        const incoming = replacementSide[idOrName];
        const oldAt = existing && typeof existing === 'object' ? Number(existing.at) : NaN;
        const newAt = incoming && typeof incoming === 'object' ? Number(incoming.at) : NaN;
        const preserved = incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
          (isFinite(oldAt) ? isFinite(newAt) && newAt >= oldAt :
            JSON.stringify(incoming) === JSON.stringify(existing));
        if (!preserved) {
          throw new Error('STATE_TOMBSTONE_PRESERVATION_REQUIRED: ' + group.label + ' ' + side +
            '[' + idOrName + '] has not expired; import/restore must not remove or roll back its resurrection evidence.');
        }
      });
    });
  });
  assertListTombstoneCanonicalsPreserved_(current, replacement, now);
}

// List tombstones reserve an exact cross-provider pair, not merely whichever
// individual ID happened to be used as a storage key.  Import/restore must
// therefore not accept a newer, integrity-valid split such as g-old↔ms-new
// plus g-new↔ms-old. Name guards are derived from these canonicals and may be
// repointed only when their underlying canonical evidence survives.

function assertListTombstoneCanonicalsPreserved_(current, replacement, now) {
  const currentTombstones = current && current.listTombstones || {};
  const replacementTombstones = replacement && replacement.listTombstones || {};
  ['g', 'ms'].forEach(function(side) {
    const currentSide = currentTombstones[side] || {};
    const replacementSide = replacementTombstones[side] || {};
    Object.keys(currentSide).forEach(function(id) {
      const existing = currentSide[id];
      const expectedId = side === 'g' ? existing && existing.gListId : existing && existing.msListId;
      // A loaded current state is already strict, but keep this helper
      // conservative if it is called directly by an administrative test/tool.
      if (id !== expectedId || !tombstoneEvidenceIsUnexpired_(existing, now)) return;
      const incoming = replacementSide[id];
      const oldAt = existing && typeof existing === 'object' ? Number(existing.at) : NaN;
      const newAt = incoming && typeof incoming === 'object' ? Number(incoming.at) : NaN;
      const sameCanonical = incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
        incoming.gListId === existing.gListId && incoming.msListId === existing.msListId &&
        incoming.gName === existing.gName && incoming.msName === existing.msName &&
        incoming.source === existing.source;
      const atLeastAsNew = isFinite(oldAt) ? isFinite(newAt) && newAt >= oldAt :
        JSON.stringify(incoming) === JSON.stringify(existing);
      if (!sameCanonical || !atLeastAsNew) {
        throw new Error('STATE_TOMBSTONE_PRESERVATION_REQUIRED: list tombstone ' + side + '[' + id +
          '] has not expired; import/restore must not split, rebind, rename, or roll back its exact-pair resurrection evidence.');
      }
    });
  });
}

function assertHistoricListGuardsPreserved_(current, replacement) {
  const currentGuards = current && current.listDeletionConflicts || {};
  const replacementGuards = replacement && replacement.listDeletionConflicts || {};
  Object.keys(currentGuards).forEach(function(key) {
    const existing = currentGuards[key];
    if (!existing || existing.reason !== 'LIST_REPAIR_HISTORIC_PAIR_GUARD') return;
    const incoming = replacementGuards[key];
    const oldAt = durableEvidenceTimestampMs_(existing.at);
    const newAt = incoming && durableEvidenceTimestampMs_(incoming.at);
    const samePairAndNames = incoming && incoming.reason === existing.reason &&
      incoming.gListId === existing.gListId && incoming.msListId === existing.msListId &&
      (incoming.gTitle || incoming.gName || '') === (existing.gTitle || existing.gName || '') &&
      (incoming.msTitle || incoming.msName || '') === (existing.msTitle || existing.msName || '');
    const atLeastAsNew = oldAt !== null ? newAt !== null && newAt >= oldAt :
      JSON.stringify(incoming) === JSON.stringify(existing);
    if (!samePairAndNames || !atLeastAsNew) {
      throw new Error('STATE_HISTORIC_GUARD_PRESERVATION_REQUIRED: repair historic pair ' + key +
        ' still blocks automatic recreation; import/restore must not remove, rebind, or roll back its reservation evidence.');
    }
  });
}

// Repair guards are written with ISO timestamps, while tombstones use epoch
// milliseconds.  Replacement preflight must compare both forms; treating an
// ISO timestamp as malformed would accept only byte-identical guard records
// and make a genuinely newer safe state impossible to import.

function durableEvidenceTimestampMs_(value) {
  const numberValue = Number(value);
  if (isFinite(numberValue)) return numberValue;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : parsed;
}

function sameEvidenceFields_(existing, incoming, fields) {
  return !!existing && typeof existing === 'object' && !Array.isArray(existing) &&
    !!incoming && typeof incoming === 'object' && !Array.isArray(incoming) && fields.every(function(field) {
    return existing[field] === incoming[field];
  });
}

function sameEvidenceTaskPairs_(existing, incoming) {
  return JSON.stringify(existing.taskPairs || []) === JSON.stringify(incoming.taskPairs || []);
}

function evidenceRecordAtLeastAsNew_(existing, incoming, timestampFields) {
  let oldAt = null;
  let newAt = null;
  (timestampFields || []).some(function(field) {
    oldAt = durableEvidenceTimestampMs_(existing[field]);
    return oldAt !== null;
  });
  (timestampFields || []).some(function(field) {
    newAt = durableEvidenceTimestampMs_(incoming && incoming[field]);
    return newAt !== null;
  });
  // If an older schema/runtime did not emit a usable timestamp, only a
  // byte-identical record is safe.  We must never treat opaque evidence as
  // expired merely because replacement cannot order it.
  return oldAt === null ? JSON.stringify(incoming) === JSON.stringify(existing) :
    newAt !== null && newAt >= oldAt;
}

function assertReservationTablePreserved_(currentTable, replacementTable, label, compatible) {
  Object.keys(currentTable || {}).forEach(function(key) {
    const existing = currentTable[key];
    const incoming = replacementTable && replacementTable[key];
    if (!compatible(existing, incoming)) {
      throw new Error('STATE_DELETION_EVIDENCE_PRESERVATION_REQUIRED: ' + label + '[' + key +
        '] remains an anti-recreate/delete reservation; import/restore must not remove, rebind, or roll back its evidence.');
    }
  });
}

// Import and restore replace a whole state generation.  A first-round
// candidate or a delete-vs-edit conflict reserves the exact task/list pair;
// silently dropping it together with its mapping would let the normal planner
// recreate a possible remote-delete survivor.  These records are therefore
// treated as durable resurrection evidence just like tombstones.  No merge is
// attempted: a replacement must already contain compatible, same-or-newer
// evidence before it may become current.

function assertActiveDeletionEvidencePreserved_(current, replacement) {
  assertHistoricListGuardsPreserved_(current, replacement);
  assertReservationTablePreserved_(
    current && current.pendingTaskDeletions,
    replacement && replacement.pendingTaskDeletions,
    'pendingTaskDeletions',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['gId', 'msId', 'missingSide', 'gListId', 'msListId', 'gUpdated', 'msUpdated']) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['lastConfirmedAt', 'firstConfirmedAt']);
    }
  );
  assertReservationTablePreserved_(
    current && current.taskDeletionConflicts,
    replacement && replacement.taskDeletionConflicts,
    'taskDeletionConflicts',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['msId', 'gListId', 'msListId', 'reason']) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['at']);
    }
  );
  assertReservationTablePreserved_(
    current && current.pendingListDeletions,
    replacement && replacement.pendingListDeletions,
    'pendingListDeletions',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['key', 'gListId', 'msListId', 'gTitle', 'msTitle', 'missingSide',
          'gFingerprint', 'msFingerprint', 'survivorFingerprint', 'taskFingerprint', 'deletable']) &&
        sameEvidenceTaskPairs_(existing, incoming) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['lastConfirmedAt', 'firstConfirmedAt']);
    }
  );
  assertReservationTablePreserved_(
    current && current.listDeletionConflicts,
    replacement && replacement.listDeletionConflicts,
    'listDeletionConflicts',
    function(existing, incoming) {
      return sameEvidenceFields_(existing, incoming,
        ['gListId', 'msListId', 'gTitle', 'msTitle', 'gName', 'msName', 'reason']) &&
        evidenceRecordAtLeastAsNew_(existing, incoming, ['at']);
    }
  );
}

function validateImportedState_(state) {
  const objectFields = ['listMap', 'g2m', 'm2g', 'tombstones', 'listFaults', 'health'];
  const optionalObjectFields = ['pendingTaskDeletions', 'deletionJournal', 'taskMoveJournal',
    'taskDeletionConflicts'];
  if (state.schema !== 2 && state.schema !== 3) {
    throw new Error('IMPORT_INVALID_STATE: Only complete schema=2 or schema=3 exports are accepted.');
  }
  assertStrictSchema2StateShape_(state, 'IMPORT_INVALID_STATE');
  assertStrictSchema3StateShape_(state, 'IMPORT_INVALID_STATE');
  objectFields.forEach(function(field) {
    const value = state[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('IMPORT_INVALID_STATE: Field ' + field + ' must be an object.');
    }
  });
  optionalObjectFields.forEach(function(field) {
    if (state[field] !== undefined &&
        (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field]))) {
      throw new Error('IMPORT_INVALID_STATE: Field ' + field + ' must be an object when provided.');
    }
  });
  assertListMapOneToOne_(state, 'IMPORT_INVALID_STATE');
  Object.keys(state.g2m).forEach(function(gTaskId) {
    const rec = state.g2m[gTaskId];
    if (!rec || typeof rec !== 'object' || !rec.msId || !rec.gListId || !rec.msListId) {
      throw new Error('IMPORT_INVALID_STATE: g2m[' + gTaskId + '] is missing a required ID.');
    }
  });
  validateImportedTaskDeletionState_(state);
  if (state.schema === 3) validateImportedListDeletionState_(state);
}

function validateImportedTaskDeletionRecord_(field, gTaskId, record, requireRound) {
  const hasStrings = record && typeof record === 'object' && !Array.isArray(record) &&
    record.gId === gTaskId && typeof record.msId === 'string' && !!record.msId &&
    typeof record.gListId === 'string' && !!record.gListId &&
    typeof record.msListId === 'string' && !!record.msListId &&
    ['google', 'microsoft', 'both'].indexOf(record.missingSide) >= 0 &&
    (record.gUpdated === null || typeof record.gUpdated === 'string' || record.gUpdated === undefined) &&
    (record.msUpdated === null || typeof record.msUpdated === 'string' || record.msUpdated === undefined);
  if (!hasStrings) {
    throw new Error('IMPORT_INVALID_STATE: ' + field + '[' + gTaskId + '] has an invalid format or task/list ID.');
  }
  if (requireRound &&
      (!Number.isInteger(record.confirmations) || record.confirmations !== 1 ||
       typeof record.lastRoundId !== 'string' || !record.lastRoundId)) {
    throw new Error('IMPORT_INVALID_STATE: pendingTaskDeletions[' + gTaskId + '] has no valid round.');
  }
}

function validateImportedTaskDeletionState_(state) {
  const pending = state.pendingTaskDeletions || {};
  const journals = state.deletionJournal || {};
  const conflicts = state.taskDeletionConflicts || {};
  Object.keys(pending).forEach(function(gTaskId) {
    const record = pending[gTaskId];
    validateImportedTaskDeletionRecord_('pendingTaskDeletions', gTaskId, record, true);
    const mapping = state.g2m[gTaskId];
    if (!mapping || mapping.msId !== record.msId || mapping.gListId !== record.gListId ||
        mapping.msListId !== record.msListId) {
      throw new Error('IMPORT_INVALID_STATE: pendingTaskDeletions[' + gTaskId + '] is inconsistent with its mapping.');
    }
  });
  Object.keys(journals).forEach(function(gTaskId) {
    const record = journals[gTaskId];
    validateImportedTaskDeletionRecord_('deletionJournal', gTaskId, record, false);
    if (record.phase !== 'prepared' && record.phase !== 'paused') {
      throw new Error('IMPORT_INVALID_STATE: deletionJournal[' + gTaskId + '] has an invalid phase.');
    }
    if (typeof record.preparedAt !== 'string' || !record.preparedAt) {
      throw new Error('IMPORT_INVALID_STATE: deletionJournal[' + gTaskId + '] is missing preparedAt.');
    }
    const mapping = state.g2m[gTaskId];
    if (mapping && (mapping.msId !== record.msId || mapping.gListId !== record.gListId ||
        mapping.msListId !== record.msListId)) {
      throw new Error('IMPORT_INVALID_STATE: deletionJournal[' + gTaskId + '] is inconsistent with its mapping.');
    }
  });
  Object.keys(conflicts).forEach(function(gTaskId) {
    const record = conflicts[gTaskId];
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.msId !== 'string' || !record.msId ||
        typeof record.gListId !== 'string' || !record.gListId ||
        typeof record.msListId !== 'string' || !record.msListId ||
        typeof record.reason !== 'string' || !record.reason ||
        typeof record.at !== 'string' || !record.at) {
      throw new Error('IMPORT_INVALID_STATE: taskDeletionConflicts[' + gTaskId + '] has an invalid format or ID.');
    }
  });
}

function validateImportedListDeletionRecord_(field, key, record, requireRound) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.gListId !== 'string' || !record.gListId ||
      typeof record.msListId !== 'string' || !record.msListId ||
      key !== listPairKey_(record.gListId, record.msListId) ||
      ['google', 'microsoft', 'both'].indexOf(record.missingSide) < 0 ||
      typeof record.taskFingerprint !== 'string' || !Array.isArray(record.taskPairs) ||
      record.deletable !== true) {
    throw new Error('IMPORT_INVALID_STATE: ' + field + '[' + key + '] has an invalid format or list ID.');
  }
  if (requireRound && (!Number.isInteger(record.confirmations) || record.confirmations !== 1 ||
      typeof record.lastRoundId !== 'string' || !record.lastRoundId)) {
    throw new Error('IMPORT_INVALID_STATE: pendingListDeletions[' + key + '] has no valid round.');
  }
}

function validateImportedListDeletionState_(state) {
  const fields = ['listPairMeta', 'pendingListDeletions', 'listDeletionJournal',
    'listDeletionConflicts', 'listTombstones', 'listTombstoneNames'];
  fields.forEach(function(field) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error('IMPORT_INVALID_STATE: Field ' + field + ' must be an object.');
    }
  });
  if (!state.listTombstones.g || typeof state.listTombstones.g !== 'object' || Array.isArray(state.listTombstones.g) ||
      !state.listTombstones.ms || typeof state.listTombstones.ms !== 'object' || Array.isArray(state.listTombstones.ms)) {
    throw new Error('IMPORT_INVALID_STATE: listTombstones must contain g/ms objects.');
  }
  if (!state.listTombstoneNames.g || typeof state.listTombstoneNames.g !== 'object' || Array.isArray(state.listTombstoneNames.g) ||
      !state.listTombstoneNames.ms || typeof state.listTombstoneNames.ms !== 'object' || Array.isArray(state.listTombstoneNames.ms)) {
    throw new Error('IMPORT_INVALID_STATE: listTombstoneNames must contain g/ms objects.');
  }
  Object.keys(state.listPairMeta).forEach(function(key) {
    const meta = state.listPairMeta[key];
    if (!meta || typeof meta !== 'object' || key !== listPairKey_(meta.gListId, meta.msListId) ||
        typeof meta.autoBothLiveProvenAt !== 'string' || !meta.autoBothLiveProvenAt) {
      throw new Error('IMPORT_INVALID_STATE: listPairMeta[' + key + '] has an invalid format.');
    }
  });
  Object.keys(state.pendingListDeletions).forEach(function(key) {
    validateImportedListDeletionRecord_('pendingListDeletions', key, state.pendingListDeletions[key], true);
  });
  Object.keys(state.listDeletionJournal).forEach(function(key) {
    const record = state.listDeletionJournal[key];
    validateImportedListDeletionRecord_('listDeletionJournal', key, record, false);
    if (['prepared', 'paused', 'blocked'].indexOf(record.phase) < 0 ||
        typeof record.preparedAt !== 'string' || !record.preparedAt) {
      throw new Error('IMPORT_INVALID_STATE: listDeletionJournal[' + key + '] has an invalid phase.');
    }
  });
  Object.keys(state.listDeletionConflicts).forEach(function(key) {
    const record = state.listDeletionConflicts[key];
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.reason !== 'string' || !record.reason ||
        typeof record.at !== 'string' || !record.at) {
      throw new Error('IMPORT_INVALID_STATE: listDeletionConflicts[' + key + '] has an invalid format.');
    }
  });
  assertListTombstoneIntegrity_(state, 'IMPORT_INVALID_STATE');
}

function validateLoadedListDeletionState_(state) {
  ensureListDeletionState_(state);
  assertListTombstoneIntegrity_(state, 'STATE_MALFORMED');
  Object.keys(state.listPairMeta).forEach(function(key) {
    const meta = state.listPairMeta[key];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
        typeof meta.gListId !== 'string' || typeof meta.msListId !== 'string' ||
        key !== listPairKey_(meta.gListId, meta.msListId) ||
        typeof meta.autoBothLiveProvenAt !== 'string' || !meta.autoBothLiveProvenAt) {
      throw new Error('STATE_MALFORMED: listPairMeta[' + key + '] cannot be used safely.');
    }
  });
  Object.keys(state.pendingListDeletions).forEach(function(key) {
    const rec = state.pendingListDeletions[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
        rec.gListId === undefined || rec.msListId === undefined ||
        key !== listPairKey_(rec.gListId, rec.msListId) || rec.confirmations !== 1 ||
        typeof rec.lastRoundId !== 'string' || !rec.lastRoundId ||
        !Array.isArray(rec.taskPairs) || typeof rec.taskFingerprint !== 'string') {
      throw new Error('STATE_MALFORMED: pendingListDeletions[' + key + '] cannot be used safely.');
    }
  });
  Object.keys(state.listDeletionJournal).forEach(function(key) {
    const rec = state.listDeletionJournal[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
        key !== listPairKey_(rec.gListId, rec.msListId) ||
        ['prepared', 'paused', 'blocked'].indexOf(rec.phase) < 0 ||
        typeof rec.preparedAt !== 'string' || !rec.preparedAt || !Array.isArray(rec.taskPairs)) {
      throw new Error('STATE_MALFORMED: listDeletionJournal[' + key + '] cannot be used safely.');
    }
  });
  Object.keys(state.listDeletionConflicts).forEach(function(key) {
    const rec = state.listDeletionConflicts[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
        typeof rec.reason !== 'string' || !rec.reason || typeof rec.at !== 'string' || !rec.at) {
      throw new Error('STATE_MALFORMED: listDeletionConflicts[' + key + '] cannot be used safely.');
    }
  });
}
