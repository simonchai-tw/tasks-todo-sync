/* Phase 2A.4: read-only relationship discovery.
 *
 * The production ceiling is intentionally unavailable until a sanitized live
 * measurement is accepted.  Consequently this module is inert by default.
 */

function relationshipDiscoveryPolicy_() {
  return {
    architecture: 'BOUNDED_DIRECT_GET',
    budgetStatus: 'UNMEASURED',
    maxParents: 0
  };
}

function relationshipOpaqueId_(value) {
  return typeof value === 'string' && value.length > 0;
}

function relationshipCandidates_(parentCandidates) {
  if (!Array.isArray(parentCandidates)) return [];
  const seen = {};
  const result = [];
  parentCandidates.forEach(function(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        !relationshipOpaqueId_(candidate.gParentId) ||
        !relationshipOpaqueId_(candidate.msParentId) ||
        !relationshipOpaqueId_(candidate.msListId)) {
      throw new Error('RELATIONSHIP_MALFORMED_CANDIDATE');
    }
    if (seen[candidate.msParentId]) return;
    seen[candidate.msParentId] = true;
    result.push({
      gParentId: candidate.gParentId,
      msParentId: candidate.msParentId,
      msListId: candidate.msListId
    });
  });
  return result;
}

function relationshipParentRecord_(state, msParentId) {
  const table = state && state.subtasks && state.subtasks.parents;
  const record = table && table[msParentId];
  if (record === undefined) {
    return {
      knowledge: 'unknown',
      lastAttemptEpoch: -1,
      lastAttemptedAt: null,
      lastObservedRoundId: null,
      lastObservedAt: null,
      observationEpoch: 0
    };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('STATE_MALFORMED: subtasks.parents record must be an object.');
  }
  return record;
}

function selectRelationshipParents_(state, parentCandidates, maxParents) {
  const candidates = relationshipCandidates_(parentCandidates);
  const limit = Number(maxParents);
  if (!Number.isInteger(limit) || limit <= 0) return [];
  candidates.sort(function(left, right) {
    const a = relationshipParentRecord_(state, left.msParentId);
    const b = relationshipParentRecord_(state, right.msParentId);
    const aAttemptKnown = Number.isInteger(a.lastAttemptEpoch) && a.lastAttemptEpoch >= 0;
    const bAttemptKnown = Number.isInteger(b.lastAttemptEpoch) && b.lastAttemptEpoch >= 0;
    if (aAttemptKnown !== bAttemptKnown) return aAttemptKnown ? 1 : -1;
    if (aAttemptKnown && a.lastAttemptEpoch !== b.lastAttemptEpoch) {
      return a.lastAttemptEpoch - b.lastAttemptEpoch;
    }
    const aObservedKnown = typeof a.lastObservedAt === 'number' && isFinite(a.lastObservedAt) && a.lastObservedAt >= 0;
    const bObservedKnown = typeof b.lastObservedAt === 'number' && isFinite(b.lastObservedAt) && b.lastObservedAt >= 0;
    if (aObservedKnown !== bObservedKnown) return aObservedKnown ? 1 : -1;
    if (aObservedKnown && a.lastObservedAt !== b.lastObservedAt) {
      return a.lastObservedAt - b.lastObservedAt;
    }
    return left.msParentId < right.msParentId ? -1 : left.msParentId > right.msParentId ? 1 : 0;
  });
  return candidates.slice(0, limit);
}

function classifyRelationshipReadError_(error) {
  const message = String((error && error.message) || error || '');
  if (/^HTTP (404|410)(?:\b|:)/.test(message)) return 'PARENT_NOT_FOUND';
  if (/^HTTP (408|429|5\d\d)(?:\b|:)/.test(message) ||
      /TIME_BUDGET_/.test(message) ||
      /(?:network|timeout|timed out|fetch failed|failed to fetch|socket|connection reset|temporar(?:y|ily)|service unavailable)/i.test(message)) {
    return 'UNOBSERVED';
  }
  if ((error && error.name === 'SyntaxError') ||
      /(?:JSON|MALFORMED|PAGINATION_LOOP|PAGE_CAP|value must be|invalid checklist|nextLink)/i.test(message)) {
    return 'MALFORMED';
  }
  // Unknown provider/runtime failures are conservatively non-observations.
  return 'UNOBSERVED';
}

function relationshipNow_(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : Date.now();
}

function relationshipEnsureState_(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !state.subtasks || typeof state.subtasks !== 'object' || Array.isArray(state.subtasks)) {
    throw new Error('STATE_MALFORMED: subtasks namespace is required.');
  }
  if (!state.subtasks.parents || typeof state.subtasks.parents !== 'object' || Array.isArray(state.subtasks.parents)) {
    throw new Error('STATE_MALFORMED: subtasks.parents must be an object.');
  }
  return state.subtasks.parents;
}

function relationshipNextAttemptEpoch_(parents) {
  let maximum = -1;
  Object.keys(parents).forEach(function(key) {
    const value = parents[key] && parents[key].lastAttemptEpoch;
    if (Number.isInteger(value) && value >= 0) maximum = Math.max(maximum, value);
  });
  return maximum + 1;
}

function applyRelationshipObservation_(state, parent, observation, roundId, nowMs) {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent) ||
      !relationshipOpaqueId_(parent.msParentId)) {
    throw new Error('RELATIONSHIP_MALFORMED_CANDIDATE');
  }
  const parents = relationshipEnsureState_(state);
  const id = parent.msParentId;
  const prior = parents[id];
  const record = prior === undefined ? {
    knowledge: 'unknown',
    lastAttemptEpoch: -1,
    lastAttemptedAt: null,
    lastObservedRoundId: null,
    lastObservedAt: null,
    observationEpoch: 0
  } : relationshipParentRecord_(state, id);
  const attemptAt = relationshipNow_(nowMs);
  record.lastAttemptEpoch = relationshipNextAttemptEpoch_(parents);
  record.lastAttemptedAt = attemptAt;
  const kind = observation && observation.kind;
  if (kind === 'OBSERVED_COMPLETE') {
    if (!Array.isArray(observation.items) || typeof roundId !== 'string' || !roundId) {
      throw new Error('RELATIONSHIP_MALFORMED_OBSERVATION');
    }
    record.knowledge = observation.items.length ? 'present' : 'empty';
    record.lastObservedRoundId = roundId;
    record.lastObservedAt = attemptAt;
    record.observationEpoch = (Number.isInteger(record.observationEpoch) && record.observationEpoch >= 0)
      ? record.observationEpoch + 1 : 0;
  }
  // PARENT_NOT_FOUND, UNOBSERVED, and MALFORMED intentionally preserve all
  // prior observation fields; only this attempt is durable.
  parents[id] = record;
  return record;
}

function discoverRelationshipsReadOnly_(state, parentCandidates, policy, startedAt, roundId, nowMs) {
  const effective = policy && typeof policy === 'object' ? policy : relationshipDiscoveryPolicy_();
  const candidates = relationshipCandidates_(parentCandidates);
  const configuredMax = Number(effective.maxParents);
  const maxParents = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : 0;
  const selected = effective.architecture === 'BOUNDED_DIRECT_GET' && effective.budgetStatus !== 'UNMEASURED'
    ? selectRelationshipParents_(state, candidates, maxParents) : [];
  const beforeFetch = (typeof SYNC_OBSERVABILITY_ !== 'undefined' && SYNC_OBSERVABILITY_)
    ? Number(SYNC_OBSERVABILITY_.urlFetchCalls || 0) : 0;
  const result = {
    budgetStatus: typeof effective.budgetStatus === 'string' ? effective.budgetStatus : 'UNMEASURED',
    eligible: candidates.length,
    scheduled: 0,
    attempted: 0,
    observed: 0,
    unobserved: 0,
    notFound: 0,
    malformed: 0,
    directCollectionRequests: 0,
    graphBatchOuterRequests: 0,
    graphBatchInnerRequests: 0,
    urlFetchCallsDelta: 0,
    itemsByMsParentId: {}
  };
  for (let index = 0; index < selected.length; index += 1) {
    const parent = selected[index];
    const hasTime = !startedAt || typeof remainingTimeOk_ !== 'function' || remainingTimeOk_(startedAt, PAGINATION_RESERVE_MS);
    if (!hasTime) {
      result.unobserved += 1;
      continue;
    }
    result.scheduled += 1;
    if (startedAt && typeof remainingTimeOk_ === 'function' && !remainingTimeOk_(startedAt, PAGINATION_RESERVE_MS)) {
      result.unobserved += 1;
      continue;
    }
    result.attempted += 1;
    let observation;
    try {
      observation = getMsChecklistItemsDirect_(parent.msListId, parent.msParentId);
      if (!observation || observation.kind !== 'OBSERVED_COMPLETE' || !Array.isArray(observation.items)) {
        throw new Error('RELATIONSHIP_MALFORMED_OBSERVATION');
      }
      result.directCollectionRequests += Number(observation.directCollectionRequests) || 0;
      applyRelationshipObservation_(state, parent, observation, roundId, nowMs);
      result.observed += 1;
      result.itemsByMsParentId[parent.msParentId] = observation.items.map(function(item) {
        return { id: item.id, displayName: item.displayName, isChecked: item.isChecked };
      });
    } catch (error) {
      result.directCollectionRequests += Number(error && error.directCollectionRequests) || 0;
      const classification = classifyRelationshipReadError_(error);
      applyRelationshipObservation_(state, parent, { kind: classification }, roundId, nowMs);
      if (classification === 'PARENT_NOT_FOUND') result.notFound += 1;
      else if (classification === 'MALFORMED') result.malformed += 1;
      else result.unobserved += 1;
    }
  }
  const afterFetch = (typeof SYNC_OBSERVABILITY_ !== 'undefined' && SYNC_OBSERVABILITY_)
    ? Number(SYNC_OBSERVABILITY_.urlFetchCalls || 0) : beforeFetch;
  result.urlFetchCallsDelta = Math.max(0, afterFetch - beforeFetch);
  return result;
}
