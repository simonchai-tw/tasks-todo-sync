/* Step 4: resource visibility projection. Not file synchronization.
 * Native Microsoft linkedResources create is probe-gated and stays uninvoked.
 * Google → Microsoft uses a managed body block until live create evidence exists.
 * The managed block is stripped before ordinary notes fingerprints and merge.
 */

var RESOURCE_BLOCK_BEGIN_ = '--- tasks-todo-sync ---';
var RESOURCE_BLOCK_END_ = '--- tasks-todo-sync end ---';
var RESOURCE_NOTES_MAX_ = 8192;
var RESOURCE_DISPLAY_NAME_MAX_ = 200;
var RESOURCE_OWNED_APP_NAME_ = 'tasks-todo-sync';
var RESOURCE_HEADING_ = Object.freeze({
  MS_LINKS: 'Microsoft To Do links',
  MS_ATTACHMENTS: 'Microsoft To Do attachments',
  G_LINKS: 'Google Tasks links',
  G_ASSIGNMENTS: 'Google Tasks assignments'
});
var RESOURCE_BLOCK_STATUS_ = Object.freeze({
  OWNED: 'OWNED',
  ABSENT: 'ABSENT',
  REMOVED: 'REMOVED',
  AMBIGUOUS: 'RESOURCE_BLOCK_OWNERSHIP_AMBIGUOUS',
  MALFORMED: 'RESOURCE_BLOCK_MALFORMED',
  UNOWNED: 'RESOURCE_BLOCK_UNOWNED'
});

function resourceDigestHex_(prefix, payload) {
  var text = String(prefix || '') + String(payload == null ? '' : payload);
  if (typeof Utilities === 'undefined' || !Utilities || typeof Utilities.computeDigest !== 'function' ||
      !Utilities.DigestAlgorithm || !Utilities.DigestAlgorithm.SHA_256) {
    throw new Error('RESOURCE_FP_UNAVAILABLE: SHA-256 digest is required.');
  }
  var charset = Utilities.Charset && Utilities.Charset.UTF_8;
  var digest = charset
    ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, charset)
    : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  var hex = '';
  var i;
  for (i = 0; i < digest.length && hex.length < 32; i += 1) {
    var b = digest[i];
    if (b < 0) b += 256;
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex.slice(0, 32);
}

function managedBlockFingerprint_(block) {
  if (!block) return null;
  return resourceDigestHex_('tts-rp-block-v1:', block);
}

function resourceToLf_(raw) {
  return String(raw == null ? '' : raw).replace(/\r\n|\r/g, '\n');
}

function parseManagedResourceBlock_(rawNotes, priorFp, intentFp) {
  var original = rawNotes == null ? '' : String(rawNotes);
  var lf = resourceToLf_(original);
  var lines = lf.split('\n');
  var beginCount = 0;
  var endCount = 0;
  var begins = [];
  var ends = [];
  var i;
  for (i = 0; i < lines.length; i += 1) {
    if (lines[i] === RESOURCE_BLOCK_BEGIN_) {
      beginCount += 1;
      begins.push(i);
    }
    if (lines[i] === RESOURCE_BLOCK_END_) {
      endCount += 1;
      ends.push(i);
    }
  }
  if (beginCount === 0 && endCount === 0) {
    if (priorFp) {
      return {
        status: RESOURCE_BLOCK_STATUS_.REMOVED,
        userNotes: original,
        canonicalUserNotes: lf.replace(/\n+$/, ''),
        block: null,
        blockFp: null
      };
    }
    return {
      status: RESOURCE_BLOCK_STATUS_.ABSENT,
      userNotes: original,
      canonicalUserNotes: lf.replace(/\n+$/, ''),
      block: null,
      blockFp: null
    };
  }
  var wellFormed = begins.length === 1 && ends.length === 1 && begins[0] < ends[0] &&
    beginCount === 1 && endCount === 1;
  if (!wellFormed) {
    return {
      status: RESOURCE_BLOCK_STATUS_.MALFORMED,
      userNotes: original,
      canonicalUserNotes: null,
      block: null,
      blockFp: null
    };
  }
  var start = begins[0];
  var end = ends[0];
  var block = lines.slice(start, end + 1).join('\n');
  var blockFp = managedBlockFingerprint_(block);
  var before = lines.slice(0, start);
  var after = lines.slice(end + 1);
  while (before.length && before[before.length - 1] === '') before.pop();
  while (after.length && after[0] === '') after.shift();
  var extracted = before.concat(after).join('\n').replace(/\n+$/, '');
  if (intentFp && blockFp === intentFp) {
    return {
      status: RESOURCE_BLOCK_STATUS_.OWNED,
      userNotes: extracted,
      canonicalUserNotes: extracted,
      block: block,
      blockFp: blockFp
    };
  }
  if (!priorFp) {
    return {
      status: RESOURCE_BLOCK_STATUS_.UNOWNED,
      userNotes: original,
      canonicalUserNotes: null,
      block: block,
      blockFp: blockFp
    };
  }
  if (blockFp !== priorFp) {
    return {
      status: RESOURCE_BLOCK_STATUS_.AMBIGUOUS,
      userNotes: original,
      canonicalUserNotes: extracted,
      block: block,
      blockFp: blockFp
    };
  }
  return {
    status: RESOURCE_BLOCK_STATUS_.OWNED,
    userNotes: extracted,
    canonicalUserNotes: extracted,
    block: block,
    blockFp: blockFp
  };
}

function notesWriteAllowed_(parseStatus) {
  return parseStatus === RESOURCE_BLOCK_STATUS_.OWNED ||
    parseStatus === RESOURCE_BLOCK_STATUS_.ABSENT ||
    parseStatus === RESOURCE_BLOCK_STATUS_.REMOVED;
}

/* Fingerprint of the managed block actually present in the given notes, taken
 * from the provider's own readback after a write.  Null when no block is there.
 * Used to decide whether a persisted write intent can be confirmed. */
function observedManagedBlockFingerprint_(rawNotes) {
  var parsed = parseManagedResourceBlock_(rawNotes, null, null);
  return parsed && parsed.block ? parsed.blockFp : null;
}

function composeManagedNotes_(canonicalUserNotes, managedBlock) {
  var user = canonicalUserNotes == null ? '' : String(canonicalUserNotes);
  var block = managedBlock == null ? '' : String(managedBlock);
  if (!block) return user;
  if (!user) return block;
  return user.replace(/\n+$/, '') + '\n\n' + block;
}

function resourceNormalizeUrl_(url) {
  if (url == null) return { raw: null, clickable: false };
  var raw = String(url).trim();
  if (!raw) return { raw: '', clickable: false };
  try {
    var parsed = new URL(raw);
    if (parsed.username || parsed.password) return { raw: raw, clickable: false };
    if (parsed.protocol === 'https:') return { raw: raw, clickable: true };
    return { raw: raw, clickable: false };
  } catch (ignored) {
    return { raw: raw, clickable: false };
  }
}

function resourceNormalizeDisplayName_(text) {
  var raw = text == null ? '' : String(text);
  var nfc = typeof raw.normalize === 'function' ? raw.normalize('NFC') : raw;
  var cleaned = '';
  var i;
  for (i = 0; i < nfc.length; i += 1) {
    var code = nfc.charCodeAt(i);
    if (code === 9 || code === 10) cleaned += nfc.charAt(i);
    else if (code >= 32 && code !== 127) cleaned += nfc.charAt(i);
  }
  cleaned = cleaned.replace(/\r\n|\r/g, '\n').replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= RESOURCE_DISPLAY_NAME_MAX_) return cleaned;
  return cleaned.slice(0, RESOURCE_DISPLAY_NAME_MAX_);
}

function resourceLabelForGoogleLinkType_(type) {
  var t = String(type || '').toLowerCase();
  if (t === 'email') return 'Gmail';
  if (t === 'chat') return 'Google Chat assignment';
  if (t === 'document' || t === 'docs') return 'Google Docs assignment';
  return 'Google link';
}

function projectGoogleResources_(googleTask) {
  var out = [];
  var seen = {};
  var links = googleTask && Array.isArray(googleTask.links) ? googleTask.links : [];
  var i;
  for (i = 0; i < links.length; i += 1) {
    var link = links[i];
    var url = resourceNormalizeUrl_(link && link.link);
    if (!url.raw) continue;
    var key = 'google_link\0' + url.raw;
    if (seen[key]) continue;
    seen[key] = true;
    var named = resourceNormalizeDisplayName_(link && link.description);
    out.push({
      kind: 'google_link',
      stableKey: url.raw,
      displayName: named || resourceLabelForGoogleLinkType_(link && link.type),
      webUrl: url.clickable ? url.raw : null
    });
  }
  var info = googleTask && googleTask.assignmentInfo;
  if (info && typeof info === 'object') {
    var driveId = info.driveResourceInfo && info.driveResourceInfo.driveFileId
      ? String(info.driveResourceInfo.driveFileId) : null;
    var space = info.spaceInfo && info.spaceInfo.space ? String(info.spaceInfo.space) : null;
    var linkToTask = info.linkToTask ? String(info.linkToTask) : null;
    var urlInfo = resourceNormalizeUrl_(linkToTask);
    var stableKey = driveId || space || urlInfo.raw;
    if (stableKey) {
      var aKey = 'google_assignment\0' + stableKey;
      if (!seen[aKey]) {
        seen[aKey] = true;
        var display = resourceNormalizeDisplayName_(info.displayName || info.title);
        if (!display) {
          if (driveId) display = 'Google Docs assignment';
          else if (space) display = 'Google Chat assignment';
          else display = 'Google assignment';
        }
        out.push({
          kind: 'google_assignment',
          stableKey: stableKey,
          displayName: display,
          webUrl: urlInfo.clickable ? urlInfo.raw : null
        });
      }
    }
  }
  return out;
}

function isOwnedMsLinkedResource_(item) {
  if (!item) return false;
  var app = String(item.applicationName || '');
  var ext = String(item.externalId || '');
  return app === RESOURCE_OWNED_APP_NAME_ && /^tts:g:v1:[0-9a-f]{32}$/.test(ext);
}

function projectMicrosoftResources_(msTask, msLinkedResources) {
  var out = [];
  var seen = {};
  // Preferred: observed items passed in from the dedicated linkedResources
  // collection GET. Fallback: the inline field (Graph never returns it, so an
  // absent field means UNOBSERVED, never empty).
  var links = Array.isArray(msLinkedResources) ? msLinkedResources
    : (msTask && Array.isArray(msTask.linkedResources) ? msTask.linkedResources : null);
  var i;
  if (links === null) return null;
  for (i = 0; i < links.length; i += 1) {
    var item = links[i];
    if (!item || isOwnedMsLinkedResource_(item)) continue;
    var url = resourceNormalizeUrl_(item.webUrl);
    var stableKey = item.id ? String(item.id) : (url.raw || String(item.externalId || ''));
    if (!stableKey) continue;
    var key = 'ms_linked_resource\0' + stableKey;
    if (seen[key]) continue;
    seen[key] = true;
    var named = resourceNormalizeDisplayName_(item.displayName);
    out.push({
      kind: 'ms_linked_resource',
      stableKey: stableKey,
      displayName: named || 'Microsoft link',
      webUrl: url.clickable ? url.raw : null
    });
  }
  var attachments = msTask && Array.isArray(msTask.attachments) ? msTask.attachments : [];
  for (i = 0; i < attachments.length; i += 1) {
    var att = attachments[i];
    if (!att) continue;
    var attKey = 'ms_attachment\0' + String(att.id || att.name || i);
    if (seen[attKey]) continue;
    seen[attKey] = true;
    out.push({
      kind: 'ms_attachment',
      stableKey: String(att.id || att.name || i),
      displayName: resourceNormalizeDisplayName_(att.name) || 'Microsoft attachment',
      webUrl: null
    });
  }
  return out;
}

function resourcePriorityRank_(resource, direction) {
  var hasUrl = !!(resource && resource.webUrl);
  if (direction === 'm2g') {
    if (resource.kind === 'ms_linked_resource' && hasUrl) return 0;
    if (resource.kind === 'ms_linked_resource') return 1;
    return 2;
  }
  if (resource.kind === 'google_link' && hasUrl) return 0;
  if (resource.kind === 'google_link') return 1;
  if (resource.kind === 'google_assignment' && hasUrl) return 2;
  return 3;
}

function resourceHeading_(resource, direction) {
  if (direction === 'm2g') {
    return resource.kind === 'ms_attachment' ? RESOURCE_HEADING_.MS_ATTACHMENTS : RESOURCE_HEADING_.MS_LINKS;
  }
  return resource.kind === 'google_assignment' ? RESOURCE_HEADING_.G_ASSIGNMENTS : RESOURCE_HEADING_.G_LINKS;
}

function wrapResourceBlock_(bodyLines) {
  return [RESOURCE_BLOCK_BEGIN_].concat(bodyLines).concat([RESOURCE_BLOCK_END_]).join('\n');
}

function renderManagedResourceBlock_(resources, direction, userNotes, limit) {
  direction = direction || 'm2g';
  userNotes = userNotes == null ? '' : String(userNotes);
  limit = limit == null ? RESOURCE_NOTES_MAX_ : limit;
  var separator = userNotes ? 2 : 0;
  var available = limit - userNotes.length - separator;
  var emptyMarkers = wrapResourceBlock_([]);
  if (available < emptyMarkers.length) return { block: null, omitted: (resources || []).length };
  var list = Array.isArray(resources) ? resources.slice() : [];
  if (!list.length) return { block: null, omitted: 0 };

  function blockFor(included) {
    var groups = {};
    var i;
    var sorted = included.slice().sort(function(a, b) {
      var pa = resourcePriorityRank_(a, direction);
      var pb = resourcePriorityRank_(b, direction);
      if (pa !== pb) return pa - pb;
      var sa = String(a.stableKey || '');
      var sb = String(b.stableKey || '');
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return 0;
    });
    for (i = 0; i < sorted.length; i += 1) {
      var heading = resourceHeading_(sorted[i], direction);
      if (!groups[heading]) groups[heading] = [];
      groups[heading].push(sorted[i]);
    }
    var order = direction === 'm2g'
      ? [RESOURCE_HEADING_.MS_LINKS, RESOURCE_HEADING_.MS_ATTACHMENTS]
      : [RESOURCE_HEADING_.G_LINKS, RESOURCE_HEADING_.G_ASSIGNMENTS];
    var lines = [];
    var h;
    for (h = 0; h < order.length; h += 1) {
      var items = groups[order[h]] || [];
      if (!items.length) continue;
      if (lines.length) lines.push('');
      lines.push(order[h]);
      var j;
      for (j = 0; j < items.length; j += 1) {
        lines.push('- ' + items[j].displayName);
        if (items[j].webUrl) lines.push('  ' + items[j].webUrl);
      }
    }
    return wrapResourceBlock_(lines);
  }

  var full = blockFor(list);
  if (full.length <= available) return { block: full, omitted: 0 };
  var ranked = list.slice().sort(function(a, b) {
    return resourcePriorityRank_(a, direction) - resourcePriorityRank_(b, direction);
  });
  var included = [];
  var r;
  for (r = 0; r < ranked.length; r += 1) {
    var trial = included.concat([ranked[r]]);
    var omitted = list.length - trial.length;
    var candidate = blockFor(trial);
    var sized = omitted > 0 ? candidate + '\n+ ' + omitted + ' more' : candidate;
    if (sized.length <= available) included.push(ranked[r]);
    else break;
  }
  if (!included.length) return { block: null, omitted: list.length };
  var left = list.length - included.length;
  var block = blockFor(included);
  if (left > 0) block = block + '\n+ ' + left + ' more';
  if (block.length > available) return { block: null, omitted: list.length };
  return { block: block, omitted: left };
}

function googleNotesWriteBlocked_(googleTask) {
  return !!(googleTask && googleTask.assignmentInfo && typeof googleTask.assignmentInfo === 'object');
}

function nativeLinkedResourceCreateEffective_(safety) {
  /* Probe-gated: requested flag is recorded, but create stays uninvoked. */
  return false && !!(safety && safety.enableNativeLinkedResources);
}

function createMsLinkedResourceNoRetry_(listId, taskId, body) {
  return graphFetch_(MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(taskId) + '/linkedResources', {
      method: 'post',
      payload: JSON.stringify(body || {}),
      __noRetry: true
    });
}

/* Per-pair MS linkedResources observation, wired into ordinaryReconcileMappedPair_
 * via field-merge.gs. Default: UNOBSERVED (undefined) so the M->G branch stays
 * closed exactly as before. A round that wants the observation overrides this
 * (bounded budget + fail-closed) without changing the inventory shape.
 * Must stay a plain function (not const/arrow): the field-merge call site
 * probes it with typeof so older load orders keep working. */
function msLinkedObservationForPair_(rec, msTask) {
  return undefined;
}

function planResourceProjection_(googleTask, msTask, rec, safety, userNotesGoogle, userNotesMicrosoft, msObservation) {
  var res = (rec && rec.res) || {};
  var diagnostic = [];
  var gParsed = parseManagedResourceBlock_(googleTask && googleTask.notes, res.gBlockFp, res.gBlockIntentFp);
  var msText = microsoftNotesPlainTextProjection_(msTask);
  var msParsed = parseManagedResourceBlock_(msText, res.msBlockFp, res.msBlockIntentFp);
  var nextRes = {
    gBlockFp: res.gBlockFp || null,
    msBlockFp: res.msBlockFp || null
  };
  var writeGoogle = false;
  var writeMicrosoft = false;
  var googleNotes = null;
  var microsoftBody = null;
  var googleBlock = notesWriteAllowed_(gParsed.status) ? (gParsed.block || null) : null;
  var microsoftBlock = notesWriteAllowed_(msParsed.status) ? (msParsed.block || null) : null;

  var gResources = projectGoogleResources_(googleTask);
  // msObservation is the dedicated linkedResources collection observation
  // ({kind:'OBSERVED_COMPLETE', items}) fetched per-pair with a bounded budget.
  // Without it the MS side is UNOBSERVED (null): the M->G branch stays closed
  // and the diagnostic records it. An observed-but-empty collection projects
  // an empty set, which is a different fact from unobserved.
  var msObservedItems = (msObservation && msObservation.kind === 'OBSERVED_COMPLETE' &&
    Array.isArray(msObservation.items)) ? msObservation.items : null;
  var msObservationComplete = msObservedItems !== null;
  var msResources = msObservationComplete ? projectMicrosoftResources_(msTask, msObservedItems) : [];

  if (nativeLinkedResourceCreateEffective_(safety)) {
    diagnostic.push('NATIVE_LINKED_RESOURCE_CREATE_SKIPPED');
  }

  var msUser = userNotesMicrosoft == null ? (msParsed.canonicalUserNotes || '') : userNotesMicrosoft;
  if (notesWriteAllowed_(msParsed.status)) {
    if (gResources.length) {
      var renderedMs = renderManagedResourceBlock_(gResources, 'g2m', msUser, RESOURCE_NOTES_MAX_);
      microsoftBlock = renderedMs.block || null;
      var nextMsFp = managedBlockFingerprint_(microsoftBlock);
      if ((microsoftBlock || '') !== (msParsed.block || '')) writeMicrosoft = true;
      nextRes.msBlockFp = nextMsFp;
    }
    var composedMs = composeManagedNotes_(msUser, microsoftBlock);
    microsoftBody = {
      contentType: (msTask && msTask.body && String(msTask.body.contentType || '').toLowerCase() === 'html')
        ? 'html' : 'text',
      content: (msTask && msTask.body && String(msTask.body.contentType || '').toLowerCase() === 'html')
        ? textToHtml_(composedMs) : composedMs
    };
  } else {
    diagnostic.push(msParsed.status);
  }

  var gUser = userNotesGoogle == null ? (gParsed.canonicalUserNotes || '') : userNotesGoogle;
  if (!msObservationComplete) {
    diagnostic.push('INCOMPLETE_MICROSOFT_RESOURCE_OBSERVATION');
  } else if (googleNotesWriteBlocked_(googleTask)) {
    diagnostic.push('GOOGLE_NOTES_ASSIGNMENT_BLOCKED');
  } else if (notesWriteAllowed_(gParsed.status)) {
    var renderedG = renderManagedResourceBlock_(msResources, 'm2g', gUser, RESOURCE_NOTES_MAX_);
    googleBlock = renderedG.block || googleBlock;
    var nextGFp = managedBlockFingerprint_(googleBlock);
    if ((googleBlock || '') !== (gParsed.block || '')) writeGoogle = true;
    nextRes.gBlockFp = nextGFp;
    googleNotes = composeManagedNotes_(gUser, googleBlock);
  } else {
    diagnostic.push(gParsed.status);
  }

  if (!nextRes.gBlockFp && !nextRes.msBlockFp) nextRes = res.gBlockFp || res.msBlockFp ? nextRes : null;
  if (nextRes && !nextRes.gBlockFp && !nextRes.msBlockFp) nextRes = null;

  // W4: the block we intend to write, per side, or null when this pass writes
  // nothing.  This is a pure planning output: the caller persists it as an
  // intent marker BEFORE touching a provider, and only promotes it to a
  // confirmed fingerprint once the provider's readback matches it.
  var blockIntent = {
    google: writeGoogle && nextRes ? (nextRes.gBlockFp || null) : null,
    microsoft: writeMicrosoft && nextRes ? (nextRes.msBlockFp || null) : null
  };

  return {
    writeGoogle: writeGoogle,
    writeMicrosoft: writeMicrosoft,
    googleNotes: googleNotes,
    microsoftBody: microsoftBody,
    googleBlock: googleBlock,
    microsoftBlock: microsoftBlock,
    nextRes: nextRes,
    blockIntent: blockIntent,
    diagnostic: diagnostic,
    nativeCreate: false,
    gParseStatus: gParsed.status,
    msParseStatus: msParsed.status
  };
}
