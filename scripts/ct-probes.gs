/* ============================================================
 * CT Contract Probes — Live Provider Verification
 * Run these from the Apps Script editor to verify real API contracts.
 * Each function returns structured JSON evidence.
 * ============================================================ */

/**
 * Master runner for all Phase 3 Live Subtask tests.
 * Placed at the top so it is automatically the selected function in the GAS editor.
 */
/**
 * Master runner for ALL Step 2A Live Tests (Complete Verification):
 * 1. Clean both sides
 * 2. Setup config
 * 3. G2M creation
 * 4. M2G creation
 * 5. Bidirectional updates (completion + rename)
 * 6. Safe 2-round Deletion & tombstones (G2M & M2G)
 * 7. Operator inspection surface
 * 8. Clean both sides
 */
function runAllStep2ALiveTests() {
  Logger.log('############################################');
  Logger.log('### RUNNING COMPLETE STEP 2A LIVE VERIFICATION ###');
  Logger.log('############################################');

  // Step 1: Initial cleanup & config
  cleanBothSides();
  setupSubtaskSyncConfig();
  Utilities.sleep(2000);

  // Step 2: G2M
  const g2m = testSubtaskLiveG2M();
  Utilities.sleep(2000);

  // Step 3: M2G
  const m2g = testSubtaskLiveM2G();
  Utilities.sleep(2000);

  // Step 4: Updates
  const updates = testSubtaskLiveUpdates();
  Utilities.sleep(2000);

  // Step 5: Deletion (2-round confirmation & tombstones)
  const deletion = testSubtaskLiveDeletion();
  Utilities.sleep(2000);

  // Step 6: Operator inspection
  const inspection = testSubtaskLiveOperatorInspect();
  Utilities.sleep(1000);

  // Step 7: Final cleanup
  const finalClean = cleanBothSides();

  const allPass = g2m.pass && m2g.pass && updates.pass && deletion.pass && inspection.pass;
  const summary = {
    allPass: allPass,
    g2m: g2m,
    m2g: m2g,
    updates: updates,
    deletion: deletion,
    inspection: inspection,
    finalClean: finalClean
  };

  Logger.log('============================================');
  Logger.log('=== ALL STEP 2A LIVE TESTS: ' + (allPass ? 'ALL PASS (100%)' : 'SOME FAILED') + ' ===');
  Logger.log('============================================');
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * CT-01: Google child task insert under parent using ?parent= parameter.
 * Verifies: child is created with correct parent field, omitting `previous` inserts at front.
 */
function ct01_googleChildInsert() {
  const safety = getSafetyConfig_();
  const lists = getGLists_();
  if (!lists.length) return { error: 'NO_GOOGLE_LISTS' };
  const listId = lists[0].id;

  // Create parent
  const parent = createGTask_(listId, { title: 'CT01-Parent-' + Date.now() });
  Logger.log('Parent created: ' + JSON.stringify({ id: parent.id, title: parent.title }));

  // Create child under parent (no `previous` param)
  const child = gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks?parent=' +
    encodeURIComponent(parent.id), {
      method: 'post',
      payload: JSON.stringify({ title: 'CT01-Child-' + Date.now(), status: 'needsAction' })
    });

  Logger.log('Child created: ' + JSON.stringify({ id: child.id, parent: child.parent, title: child.title }));

  // Verify child has correct parent
  const readBack = getGTask_(listId, child.id);
  const evidence = {
    ct: 'CT-01',
    pass: readBack.parent === parent.id,
    parentId: parent.id,
    childId: child.id,
    childParentField: readBack.parent,
    childPosition: readBack.position
  };

  // Cleanup
  deleteGTask_(listId, child.id);
  deleteGTask_(listId, parent.id);
  Logger.log('CT-01 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-03: Microsoft To Do Checklist Item CRUD and ID stability.
 * Verifies: create, rename, check/uncheck, and that IDs remain stable.
 */
function ct03_msChecklistCrud() {
  const msAuth = microsoftAuth_();
  if (!msAuth.hasAccess()) return { error: 'NO_MS_AUTH' };

  const msLists = getMsLists_();
  if (!msLists.length) return { error: 'NO_MS_LISTS' };
  const listId = msLists[0].id;

  // Create parent task
  const parent = createMsTask_(listId, { title: 'CT03-Parent-' + Date.now() });
  Logger.log('MS Parent: ' + JSON.stringify({ id: parent.id }));

  // Create checklist item
  const item = createMsChecklistItemNoRetry_(listId, parent.id, 'CT03-Original-Title', false);
  Logger.log('Checklist created: ' + JSON.stringify(item));
  const originalId = item.id;

  // Rename
  const renamed = updateMsChecklistItemNoRetry_(listId, parent.id, originalId,
    { displayName: 'CT03-Renamed-Title' });
  const idAfterRename = renamed.id;

  // Check (mark completed)
  const checked = updateMsChecklistItemNoRetry_(listId, parent.id, originalId,
    { isChecked: true });
  const idAfterCheck = checked.id;

  // Uncheck
  const unchecked = updateMsChecklistItemNoRetry_(listId, parent.id, originalId,
    { isChecked: false });
  const idAfterUncheck = unchecked.id;

  // Read back full collection
  const readBack = getMsChecklistItemsDirect_(listId, parent.id);

  const evidence = {
    ct: 'CT-03',
    pass: originalId === idAfterRename && originalId === idAfterCheck && originalId === idAfterUncheck,
    originalId: originalId,
    idAfterRename: idAfterRename,
    idAfterCheck: idAfterCheck,
    idAfterUncheck: idAfterUncheck,
    finalDisplayName: readBack.items.length ? readBack.items[0].displayName : null,
    finalIsChecked: readBack.items.length ? readBack.items[0].isChecked : null,
    collectionKind: readBack.kind,
    itemCount: readBack.items.length
  };

  // Cleanup
  deleteMsTask_(listId, parent.id);
  Logger.log('CT-03 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-05: Microsoft Graph $expand=checklistItems behavior.
 * Verifies: whether $expand actually returns checklist items inline.
 */
function ct05_msExpandBehavior() {
  const msAuth = microsoftAuth_();
  if (!msAuth.hasAccess()) return { error: 'NO_MS_AUTH' };

  const msLists = getMsLists_();
  if (!msLists.length) return { error: 'NO_MS_LISTS' };
  const listId = msLists[0].id;

  // Create parent with checklist
  const parent = createMsTask_(listId, { title: 'CT05-ExpandTest-' + Date.now() });
  createMsChecklistItemNoRetry_(listId, parent.id, 'CT05-Item-A', false);
  createMsChecklistItemNoRetry_(listId, parent.id, 'CT05-Item-B', true);

  // Try $expand=checklistItems
  let expandResult, expandError;
  try {
    expandResult = graphFetch_(
      MS_TODO_BASE + '/' + encodeURIComponent(listId) + '/tasks/' +
      encodeURIComponent(parent.id) + '?$expand=checklistItems',
      microsoftTaskRequestOptions_({ method: 'get' })
    );
  } catch (e) {
    expandError = String(e);
  }

  // Also try direct collection for comparison
  const directResult = getMsChecklistItemsDirect_(listId, parent.id);

  const evidence = {
    ct: 'CT-05',
    expandHasChecklistItems: expandResult && Array.isArray(expandResult.checklistItems),
    expandItemCount: expandResult && expandResult.checklistItems ? expandResult.checklistItems.length : 0,
    expandError: expandError || null,
    directItemCount: directResult.items.length,
    classification: expandResult && Array.isArray(expandResult.checklistItems) && expandResult.checklistItems.length === 2
      ? 'EXPAND_COMPLETE' : 'EXPAND_UNRELIABLE'
  };

  // Cleanup
  deleteMsTask_(listId, parent.id);
  Logger.log('CT-05 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-06: Parent lastModifiedDateTime bumps on checklist CRUD.
 */
function ct06_parentTimestampOnChecklistChange() {
  const msAuth = microsoftAuth_();
  if (!msAuth.hasAccess()) return { error: 'NO_MS_AUTH' };

  const msLists = getMsLists_();
  const listId = msLists[0].id;

  const parent = createMsTask_(listId, { title: 'CT06-Timestamp-' + Date.now() });
  const tsBefore = parent.lastModifiedDateTime;

  Utilities.sleep(1500); // Ensure timestamp granularity

  const item = createMsChecklistItemNoRetry_(listId, parent.id, 'CT06-Item', false);

  // Re-read parent
  const parentAfter = getMsTask_(listId, parent.id);
  const tsAfter = parentAfter.lastModifiedDateTime;

  const evidence = {
    ct: 'CT-06',
    pass: tsAfter > tsBefore,
    timestampBefore: tsBefore,
    timestampAfter: tsAfter,
    delta: new Date(tsAfter) - new Date(tsBefore)
  };

  deleteMsTask_(listId, parent.id);
  Logger.log('CT-06 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-08: Google Tasks same-list reparent preserves task ID.
 */
function ct08_googleReparentPreservesId() {
  const lists = getGLists_();
  const listId = lists[0].id;

  const parentA = createGTask_(listId, { title: 'CT08-ParentA-' + Date.now() });
  const parentB = createGTask_(listId, { title: 'CT08-ParentB-' + Date.now() });

  // Create child under parentA
  const child = gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks?parent=' +
    encodeURIComponent(parentA.id), {
      method: 'post',
      payload: JSON.stringify({ title: 'CT08-Child-' + Date.now(), status: 'needsAction' })
    });
  const originalId = child.id;

  // Move child to parentB
  const moved = gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks/' +
    encodeURIComponent(child.id) + '/move?parent=' + encodeURIComponent(parentB.id), {
      method: 'post'
    });

  const evidence = {
    ct: 'CT-08',
    pass: moved.id === originalId && moved.parent === parentB.id,
    originalId: originalId,
    movedId: moved.id,
    originalParent: parentA.id,
    newParent: moved.parent
  };

  deleteGTask_(listId, child.id);
  deleteGTask_(listId, parentA.id);
  deleteGTask_(listId, parentB.id);
  Logger.log('CT-08 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-09: Deleting parent leaves child with parent=null (or becomes top-level).
 */
function ct09_parentDeletionChildState() {
  const lists = getGLists_();
  const listId = lists[0].id;

  const parent = createGTask_(listId, { title: 'CT09-Parent-' + Date.now() });
  const child = gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks?parent=' +
    encodeURIComponent(parent.id), {
      method: 'post',
      payload: JSON.stringify({ title: 'CT09-Orphan-' + Date.now(), status: 'needsAction' })
    });

  // Delete parent
  deleteGTask_(listId, parent.id);

  // Read child
  const childAfter = getGTask_(listId, child.id);

  const evidence = {
    ct: 'CT-09',
    childSurvived: !!childAfter,
    parentFieldAfterDeletion: childAfter ? (childAfter.parent || null) : 'CHILD_GONE',
    pass: !!childAfter && !childAfter.parent
  };

  if (childAfter) deleteGTask_(listId, child.id);
  Logger.log('CT-09 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-10: Parent completion does NOT cascade to children.
 */
function ct10_parentCompletionNoCascade() {
  const lists = getGLists_();
  const listId = lists[0].id;

  const parent = createGTask_(listId, { title: 'CT10-Parent-' + Date.now() });
  const child = gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks?parent=' +
    encodeURIComponent(parent.id), {
      method: 'post',
      payload: JSON.stringify({ title: 'CT10-Child-' + Date.now(), status: 'needsAction' })
    });

  // Complete parent
  updateGTask_(listId, parent.id, { status: 'completed' });

  Utilities.sleep(1000);

  // Read child
  const childAfter = getGTask_(listId, child.id);

  const evidence = {
    ct: 'CT-10',
    pass: childAfter && childAfter.status === 'needsAction',
    parentStatus: 'completed',
    childStatusAfter: childAfter ? childAfter.status : 'NOT_FOUND'
  };

  deleteGTask_(listId, child.id);
  deleteGTask_(listId, parent.id);
  Logger.log('CT-10 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * CT-11: Title Unicode NFC round-trip preservation.
 */
function ct11_titleUnicodeRoundTrip() {
  const lists = getGLists_();
  const listId = lists[0].id;
  const msLists = getMsLists_();
  const msListId = msLists[0].id;

  // Test various Unicode titles
  const testTitles = [
    'CT11-ASCII-Simple',
    'CT11-中文測試-繁體',
    'CT11-Café-résumé',
    'CT11-🎯-emoji-test',
    'CT11-  spaces  trim  '
  ];

  const results = [];
  for (const title of testTitles) {
    // Google round-trip
    const gTask = createGTask_(listId, { title: title });
    const gRead = getGTask_(listId, gTask.id);
    const gMatch = gRead.title === title.trim(); // Google trims

    // MS round-trip
    const msParent = createMsTask_(msListId, { title: 'CT11-MSParent-' + Date.now() });
    const msItem = createMsChecklistItemNoRetry_(msListId, msParent.id, title.trim(), false);
    const msRead = getMsChecklistItemsDirect_(msListId, msParent.id);
    const msMatch = msRead.items.length && msRead.items[0].displayName === title.trim();

    results.push({
      original: title,
      trimmed: title.trim(),
      googleTitle: gRead.title,
      googleMatch: gMatch,
      msTitle: msRead.items.length ? msRead.items[0].displayName : null,
      msMatch: msMatch
    });

    deleteGTask_(listId, gTask.id);
    deleteMsTask_(msListId, msParent.id);
  }

  const evidence = {
    ct: 'CT-11',
    pass: results.every(r => r.googleMatch && r.msMatch),
    results: results
  };

  Logger.log('CT-11 evidence: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * Run all CT probes and return combined evidence.
 */
function runAllCtProbes() {
  const results = {};
  const probes = [
    ['CT-01', ct01_googleChildInsert],
    ['CT-03', ct03_msChecklistCrud],
    ['CT-05', ct05_msExpandBehavior],
    ['CT-06', ct06_parentTimestampOnChecklistChange],
    ['CT-08', ct08_googleReparentPreservesId],
    ['CT-09', ct09_parentDeletionChildState],
    ['CT-10', ct10_parentCompletionNoCascade],
    ['CT-11', ct11_titleUnicodeRoundTrip]
  ];

  for (const [name, fn] of probes) {
    try {
      results[name] = fn();
      Logger.log(name + ': ' + (results[name].pass ? 'PASS' : 'FAIL'));
    } catch (e) {
      results[name] = { error: String(e), pass: false };
      Logger.log(name + ': ERROR - ' + e);
    }
    Utilities.sleep(500); // Rate limit courtesy
  }

  const allPass = Object.values(results).every(r => r.pass);
  Logger.log('=== ALL CT PROBES: ' + (allPass ? 'PASS' : 'SOME FAILED') + ' ===');
  return results;
}

/**
 * Clean all tasks from Google Tasks (all lists).
 */
function cleanAllGoogleTasks() {
  const lists = getGLists_();
  let totalDeleted = 0;
  for (const list of lists) {
    const tasks = getGTasks_(list.id, { showCompleted: true, showHidden: true });
    for (const task of tasks) {
      deleteGTask_(list.id, task.id);
      totalDeleted++;
    }
  }
  Logger.log('Cleaned ' + totalDeleted + ' Google tasks across ' + lists.length + ' lists.');
  return { googleTasksDeleted: totalDeleted, listsScanned: lists.length };
}

/**
 * Clean all tasks from Microsoft To Do (all lists except built-in).
 */
function cleanAllMsTasks() {
  const lists = getMsLists_();
  let totalDeleted = 0;
  for (const list of lists) {
    const tasks = getMsTasks_(list.id);
    for (const task of tasks) {
      deleteMsTask_(list.id, task.id);
      totalDeleted++;
    }
  }
  Logger.log('Cleaned ' + totalDeleted + ' MS To Do tasks across ' + lists.length + ' lists.');
  return { msTasksDeleted: totalDeleted, listsScanned: lists.length };
}

/**
 * Clean BOTH sides — Google Tasks and Microsoft To Do.
 */
function cleanBothSides() {
  const g = cleanAllGoogleTasks();
  const m = cleanAllMsTasks();
  return { google: g, microsoft: m };
}

/**
 * Configure environment for Subtask Sync Live Testing.
 */
function setupSubtaskSyncConfig() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('SYNC_ENABLE_SUBTASKS', 'true');
  p.setProperty('SYNC_ALLOW_DELETIONS', 'true');
  p.setProperty('SYNC_ALLOW_TASK_MOVES', 'true');
  p.setProperty('SYNC_LIST_DISCOVERY_MODE', 'auto');
  
  // Clear any existing sync state from ScriptProperties
  p.deleteProperty('sync_state_main');
  p.deleteProperty('sync_state_main_round_fence');
  p.deleteProperty('sync_state_main_successful_round_manifest');
  
  // Clear any old/malformed sync state blobs from UserProperties
  // (PRESERVING all MS OAuth tokens: MS_PERSONAL_ACCESS_TOKEN, MS_PERSONAL_REFRESH_TOKEN, etc.)
  const u = PropertiesService.getUserProperties();
  const deletedKeys = [];
  u.getKeys().forEach(function(k) {
    if (k.indexOf('sync_state_') === 0 || k.indexOf('TASK_CREATE_') === 0 || k.indexOf('SYNC_') === 0) {
      u.deleteProperty(k);
      deletedKeys.push(k);
    }
  });
  Logger.log('Cleared UserProperties sync state keys: ' + JSON.stringify(deletedKeys));
  
  const safety = getSafetyConfig_();
  Logger.log('Subtask sync enabled: ' + safety.enableSubtasks);
  return { enableSubtasks: safety.enableSubtasks, deletedKeys: deletedKeys };
}

/**
 * Live Subtask Test Phase 3.1: Google Parent + Child -> Microsoft Checklist Item.
 */
function testSubtaskLiveG2M() {
  setupSubtaskSyncConfig();
  cleanBothSides();
  Utilities.sleep(1000);

  const lists = getGLists_();
  const listId = lists[0].id;

  // 1. Create Google Parent task
  const parent = createGTask_(listId, { title: 'Parent-G2M-Live' });
  Logger.log('Created Google Parent: ' + parent.id);

  // 2. Create Google Child task under parent
  const child = createGChildTask_(listId, parent.id, 'Child-G2M-Live');
  Logger.log('Created Google Child: ' + child.id + ' parent=' + child.parent);

  // 3. First sync round: maps the top-level parent task
  Logger.log('Running Sync Round 1 (Parent mapping)...');
  syncAll();
  Utilities.sleep(2000);

  // 4. Second sync round: with parent mapped, child is reconciled to MS checklist item
  Logger.log('Running Sync Round 2 (Subtask sync)...');
  syncAll();
  Utilities.sleep(2000);

  // 5. Verify on Microsoft side
  const msLists = getMsLists_();
  const msListId = msLists[0].id;
  const msTasks = getMsTasks_(msListId);
  const msParent = msTasks.find(t => t.title === 'Parent-G2M-Live');

  let checklistItems = [];
  if (msParent) {
    const directResult = getMsChecklistItemsDirect_(msListId, msParent.id);
    checklistItems = directResult.items || [];
  }

  const matchingChild = checklistItems.find(item => item.displayName === 'Child-G2M-Live');
  const pass = !!(msParent && matchingChild && matchingChild.isChecked === false);

  const evidence = {
    test: 'Subtask-G2M-Live',
    pass: pass,
    googleParentId: parent.id,
    googleChildId: child.id,
    msParentFound: !!msParent,
    msParentId: msParent ? msParent.id : null,
    checklistCount: checklistItems.length,
    matchingChecklistFound: !!matchingChild,
    checklistItemId: matchingChild ? matchingChild.id : null,
    checklistItemStatus: matchingChild ? matchingChild.isChecked : null
  };

  Logger.log('=== G2M SUBTASK TEST EVIDENCE ===: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * Helper to create a Google child task.
 */
function createGChildTask_(listId, parentId, title) {
  return gFetch_('/lists/' + encodeURIComponent(listId) + '/tasks?parent=' +
    encodeURIComponent(parentId), {
      method: 'post',
      payload: JSON.stringify({ title: title, status: 'needsAction' })
    });
}

/**
 * Live Subtask Test Phase 3.2: Microsoft Parent + Checklist Item -> Google Child.
 */
function testSubtaskLiveM2G() {
  const msLists = getMsLists_();
  const msListId = msLists[0].id;

  // 1. Create MS Parent task
  const msParent = createMsTask_(msListId, { title: 'Parent-M2G-Live' });
  Logger.log('Created MS Parent: ' + msParent.id);

  // 2. Create MS Checklist Item under parent
  const msItem = createMsChecklistItemNoRetry_(msListId, msParent.id, 'Child-M2G-Live', false);
  Logger.log('Created MS Checklist: ' + msItem.id);

  // 3. First sync round: maps the MS parent task to Google
  Logger.log('Running Sync Round 1 (Parent mapping)...');
  syncAll();
  Utilities.sleep(2000);

  // 4. Second sync round: syncs checklist item to Google child
  Logger.log('Running Sync Round 2 (Subtask sync)...');
  syncAll();
  Utilities.sleep(2000);

  // 5. Verify on Google side
  const gLists = getGLists_();
  const gListId = gLists[0].id;
  const gTasks = getGTasks_(gListId, { showCompleted: true, showHidden: true });
  const gParent = gTasks.find(t => t.title === 'Parent-M2G-Live');

  let gChildren = [];
  if (gParent) {
    gChildren = gTasks.filter(t => t.parent === gParent.id);
  }

  const matchingChild = gChildren.find(t => t.title === 'Child-M2G-Live');
  const pass = !!(gParent && matchingChild && matchingChild.status === 'needsAction');

  const evidence = {
    test: 'Subtask-M2G-Live',
    pass: pass,
    msParentId: msParent.id,
    msChecklistId: msItem.id,
    googleParentFound: !!gParent,
    googleParentId: gParent ? gParent.id : null,
    googleChildrenCount: gChildren.length,
    matchingChildFound: !!matchingChild,
    childTaskId: matchingChild ? matchingChild.id : null,
    childStatus: matchingChild ? matchingChild.status : null
  };

  Logger.log('=== M2G SUBTASK TEST EVIDENCE ===: ' + JSON.stringify(evidence));
  return evidence;
}

/**
 * Live Subtask Test Phase 3.3: Bidirectional Updates (Title + Completion).
 */
function testSubtaskLiveUpdates() {
  const msLists = getMsLists_();
  const msListId = msLists[0].id;
  const gLists = getGLists_();
  const gListId = gLists[0].id;

  // 1. Find MS Parent from G2M test
  const msTasks = getMsTasks_(msListId);
  const msParent = msTasks.find(t => t.title === 'Parent-G2M-Live');
  if (!msParent) return { error: 'PARENT_NOT_FOUND', pass: false };

  const directResult = getMsChecklistItemsDirect_(msListId, msParent.id);
  const msItem = (directResult.items || []).find(i => i.displayName === 'Child-G2M-Live');
  if (!msItem) return { error: 'CHECKLIST_ITEM_NOT_FOUND', pass: false };

  // 2. Mark MS Checklist Item as completed (isChecked = true)
  Logger.log('Checking MS checklist item...');
  updateMsChecklistItemNoRetry_(msListId, msParent.id, msItem.id, { isChecked: true });

  // 3. Sync
  Logger.log('Running sync for completion propagation...');
  syncAll();
  Utilities.sleep(2000);

  // 4. Verify Google child is completed
  const gTasks = getGTasks_(gListId, { showCompleted: true, showHidden: true });
  const gParent = gTasks.find(t => t.title === 'Parent-G2M-Live');
  const gChild = gTasks.find(t => t.parent === gParent.id);

  const completionPass = gChild && gChild.status === 'completed';
  Logger.log('Completion sync pass: ' + completionPass + ' (status: ' + (gChild ? gChild.status : 'null') + ')');

  // 5. Update Google child title
  Logger.log('Renaming Google child task...');
  updateGTask_(gListId, gChild.id, { title: 'Child-G2M-Renamed' });

  // 6. Sync
  Logger.log('Running sync for title propagation...');
  syncAll();
  Utilities.sleep(2000);

  // 7. Verify MS checklist item has new title
  const readBack = getMsChecklistItemsDirect_(msListId, msParent.id);
  const updatedItem = (readBack.items || []).find(i => i.id === msItem.id);
  const renamePass = updatedItem && updatedItem.displayName === 'Child-G2M-Renamed';
  Logger.log('Rename sync pass: ' + renamePass + ' (name: ' + (updatedItem ? updatedItem.displayName : 'null') + ')');

  const evidence = {
    test: 'Subtask-Updates-Live',
    pass: completionPass && renamePass,
    completionPass: completionPass,
    renamePass: renamePass,
    finalGoogleStatus: gChild ? gChild.status : null,
    finalMsDisplayName: updatedItem ? updatedItem.displayName : null
  };

  Logger.log('=== UPDATES TEST EVIDENCE ===: ' + JSON.stringify(evidence));
  return evidence;
}



/**
 * Live Subtask Test Phase 3.4: Safe Subtask Deletion (2-round confirmation & tombstones).
 */
function testSubtaskLiveDeletion() {
  const gLists = getGLists_();
  const gListId = gLists[0].id;
  const msLists = getMsLists_();
  const msListId = msLists[0].id;

  Logger.log('=== Starting Subtask Live Deletion Test ===');

  // --- Part A: Google Child Deletion -> MS Checklist Item Deletion ---
  Logger.log('Part A: Testing Google Child Deletion -> MS Checklist Item');
  const gParentA = createGTask_(gListId, { title: 'Parent-Del-G2M-' + Date.now() });
  const gChildA = createGChildTask_(gListId, gParentA.id, 'Child-Del-G2M-' + Date.now());
  Logger.log('Created Google Parent: ' + gParentA.id + ', Child: ' + gChildA.id);

  syncAll();
  Utilities.sleep(2000);
  syncAll();
  Utilities.sleep(2000);

  let msTasks = getMsTasks_(msListId);
  const msParentA = msTasks.find(t => t.title === gParentA.title);
  let directA = msParentA ? getMsChecklistItemsDirect_(msListId, msParentA.id).items : [];
  let msChildA = directA.find(i => i.displayName === gChildA.title);
  const mappedOkA = !!(msParentA && msChildA);
  Logger.log('Part A Initial Mapping established: ' + mappedOkA);

  Logger.log('Deleting Google child task...');
  deleteGTask_(gListId, gChildA.id);
  Utilities.sleep(1000);

  Logger.log('Sync Round 1 (1st deletion observation)...');
  syncAll();
  Utilities.sleep(2000);

  directA = getMsChecklistItemsDirect_(msListId, msParentA.id).items || [];
  msChildA = directA.find(i => i.displayName === gChildA.title);
  const survivedRound1 = !!msChildA;
  Logger.log('Checklist item survived round 1: ' + survivedRound1);

  let state = loadStateForSync_();
  let pendingA = state.subtasks && state.subtasks.pendingDeletions && state.subtasks.pendingDeletions[gChildA.id];
  const streak1 = pendingA && pendingA.missingStreak === 1;
  Logger.log('Deletion streak after round 1 is 1: ' + streak1);

  Logger.log('Sync Round 2 (2nd deletion observation -> execute delete)...');
  syncAll();
  Utilities.sleep(2000);

  directA = getMsChecklistItemsDirect_(msListId, msParentA.id).items || [];
  msChildA = directA.find(i => i.displayName === gChildA.title);
  const deletedRound2 = !msChildA;
  Logger.log('Checklist item deleted after round 2: ' + deletedRound2);

  state = loadStateForSync_();
  const mappingRemovedA = !state.subtasks.mappings[gChildA.id];
  const tombstoneGA = !!(state.subtasks.tombstones && state.subtasks.tombstones.g && state.subtasks.tombstones.g[gChildA.id]);
  Logger.log('Mapping removed: ' + mappingRemovedA + ', Tombstone G: ' + tombstoneGA);

  const partAPass = mappedOkA && survivedRound1 && streak1 && deletedRound2 && mappingRemovedA && tombstoneGA;

  try { deleteGTask_(gListId, gParentA.id); } catch(e) {}
  try { if (msParentA) deleteMsTask_(msListId, msParentA.id); } catch(e) {}

  // --- Part B: MS Checklist Item Deletion -> Google Child Deletion ---
  Logger.log('Part B: Testing MS Checklist Item Deletion -> Google Child');
  const msParentB = createMsTask_(msListId, { title: 'Parent-Del-M2G-' + Date.now() });
  const msChildB = createMsChecklistItemNoRetry_(msListId, msParentB.id, 'Child-Del-M2G-' + Date.now(), false);
  Logger.log('Created MS Parent: ' + msParentB.id + ', Checklist: ' + msChildB.id);

  syncAll();
  Utilities.sleep(2000);
  syncAll();
  Utilities.sleep(2000);

  let gTasks = getGTasks_(gListId, { showCompleted: true, showHidden: true });
  const gParentB = gTasks.find(t => t.title === msParentB.title);
  let gChildB = gParentB ? gTasks.find(t => t.parent === gParentB.id && t.title === msChildB.displayName) : null;
  const mappedOkB = !!(gParentB && gChildB);
  Logger.log('Part B Initial Mapping established: ' + mappedOkB);

  Logger.log('Deleting MS checklist item...');
  deleteMsChecklistItemNoRetry_(msListId, msParentB.id, msChildB.id);
  Utilities.sleep(1000);

  Logger.log('Sync Round 1 (1st deletion observation)...');
  syncAll();
  Utilities.sleep(2000);

  gTasks = getGTasks_(gListId, { showCompleted: true, showHidden: true });
  gChildB = gParentB ? gTasks.find(t => t.id === gChildB.id) : null;
  const survivedRound1B = !!gChildB;
  Logger.log('Google child survived round 1: ' + survivedRound1B);

  state = loadStateForSync_();
  let pendingB = gChildB && state.subtasks && state.subtasks.pendingDeletions && state.subtasks.pendingDeletions[gChildB.id];
  const streak1B = pendingB && pendingB.missingStreak === 1;
  Logger.log('Deletion streak after round 1 is 1: ' + streak1B);

  Logger.log('Sync Round 2 (2nd deletion observation -> execute delete)...');
  syncAll();
  Utilities.sleep(2000);

  gTasks = getGTasks_(gListId, { showCompleted: true, showHidden: true });
  const deletedRound2B = gChildB ? !gTasks.find(t => t.id === gChildB.id) : true;
  Logger.log('Google child deleted after round 2: ' + deletedRound2B);

  state = loadStateForSync_();
  const mappingRemovedB = gChildB ? !state.subtasks.mappings[gChildB.id] : true;

  const partBPass = mappedOkB && survivedRound1B && streak1B && deletedRound2B && mappingRemovedB;

  try { if (gParentB) deleteGTask_(gListId, gParentB.id); } catch(e) {}
  try { deleteMsTask_(msListId, msParentB.id); } catch(e) {}

  const evidence = {
    test: 'Subtask-Deletion-Live',
    pass: partAPass && partBPass,
    partA_G2M: {
      pass: partAPass,
      mappedOk: mappedOkA,
      survivedRound1: survivedRound1,
      streak1: streak1,
      deletedRound2: deletedRound2,
      mappingRemoved: mappingRemovedA,
      tombstoneG: tombstoneGA
    },
    partB_M2G: {
      pass: partBPass,
      mappedOk: mappedOkB,
      survivedRound1: survivedRound1B,
      streak1: streak1B,
      deletedRound2: deletedRound2B,
      mappingRemoved: mappingRemovedB
    }
  };

  Logger.log('=== SUBTASK DELETION TEST EVIDENCE ===: ' + JSON.stringify(evidence, null, 2));
  return evidence;
}

/**
 * Live Subtask Test Phase 3.5: Operator Inspection Surface.
 */
function testSubtaskLiveOperatorInspect() {
  Logger.log('=== Starting Operator Inspection Live Test ===');
  const report = inspectSubtaskOperations();
  const hasKeys = report && typeof report.operationCount === 'number' &&
    Array.isArray(report.operations) && typeof report.subtasks === 'object' &&
    typeof report.note === 'string';

  const obs = report && report.subtasks;
  const hasObservability = obs && typeof obs.mappings === 'number' &&
    typeof obs.createUncertain === 'number' && typeof obs.updateUncertain === 'number' &&
    typeof obs.deletionJournals === 'number' && typeof obs.pendingDeletions === 'number' &&
    typeof obs.conflicts === 'number' && typeof obs.tombstones === 'number';

  const rawJson = JSON.stringify(report);
  const noSecrets = rawJson.indexOf('Bearer') < 0 && rawJson.indexOf('token') < 0 &&
    rawJson.indexOf('secret') < 0;

  const pass = !!(hasKeys && hasObservability && noSecrets);
  const evidence = {
    test: 'Subtask-Operator-Inspect-Live',
    pass: pass,
    operationCount: report ? report.operationCount : null,
    subtasksObservability: obs,
    noSecretsLeaked: noSecrets
  };

  Logger.log('=== OPERATOR INSPECTION EVIDENCE ===: ' + JSON.stringify(evidence, null, 2));
  return evidence;
}
