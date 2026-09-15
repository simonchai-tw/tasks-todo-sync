/* ============================================================
 * R-Coefficient Measurement Probe (Live Real Account)
 * Target: Measure S0-S5 strictly read-only within withGlobalLock_.
 * Spec: 2026-09-15-r-coefficient-measurement-order.md
 * ============================================================ */

function runRCoefficientProbe() {
  initializeExecutionBudget_();
  var startedAt = Date.now();
  console.log(JSON.stringify({ type: 'probe_start', startedAt: new Date(startedAt).toISOString() }));

  var lockAcquired = false;
  var probeResult = null;

  try {
    lockAcquired = withGlobalLock_(function() {
      // Step 0. Verify zero mutation baseline
      var stateInitial = loadStateForSync_();
      var stateJsonInitial = JSON.stringify(stateInitial);

      var runs = [];
      var accountShape = {
        googleLists: 0,
        googleTasksTotal: 0,
        googlePagesTotal: 0,
        googleTasksByList: {},
        msLists: 0,
        msTasksTotal: 0,
        msPagesTotal: 0,
        msTasksByList: {}
      };

      for (var iter = 1; iter <= 3; iter++) {
        console.log(JSON.stringify({ type: 'iteration_start', iteration: iter }));
        var timings = {};

        // S0: Baseline state load (+ withGlobalLock overhead)
        var t0_start = Date.now();
        var state = loadStateForSync_();
        var t0_end = Date.now();
        timings.S0 = t0_end - t0_start;

        // S1: Google list inventory
        var t1_start = Date.now();
        var gLists = getGLists_() || [];
        var t1_end = Date.now();
        timings.S1 = t1_end - t1_start;

        // S2: Microsoft list inventory
        var t2_start = Date.now();
        var msLists = getMsLists_() || [];
        var t2_end = Date.now();
        timings.S2 = t2_end - t2_start;

        // S3: Google tasks across all lists
        var t3_start = Date.now();
        var gTasksCount = 0;
        var gPagesCount = 0;
        for (var i = 0; i < gLists.length; i++) {
          var glId = gLists[i].id;
          var gTasks = getGTasks_(glId) || [];
          gTasksCount += gTasks.length;
          var gPages = Math.max(1, Math.ceil(gTasks.length / 100));
          gPagesCount += gPages;
          if (iter === 1) {
            accountShape.googleTasksByList[glId] = { title: gLists[i].title, tasks: gTasks.length, pages: gPages };
          }
        }
        var t3_end = Date.now();
        timings.S3 = t3_end - t3_start;

        // S4: Microsoft tasks across all lists
        var t4_start = Date.now();
        var msTasksCount = 0;
        var msPagesCount = 0;
        for (var j = 0; j < msLists.length; j++) {
          var mlId = msLists[j].id;
          var msTasks = getMsTasks_(mlId) || [];
          msTasksCount += msTasks.length;
          var msPages = Math.max(1, Math.ceil(msTasks.length / 100));
          msPagesCount += msPages;
          if (iter === 1) {
            accountShape.msTasksByList[mlId] = { title: msLists[j].displayName, tasks: msTasks.length, pages: msPages };
          }
        }
        var t4_end = Date.now();
        timings.S4 = t4_end - t4_start;

        if (iter === 1) {
          accountShape.googleLists = gLists.length;
          accountShape.googleTasksTotal = gTasksCount;
          accountShape.googlePagesTotal = gPagesCount;
          accountShape.msLists = msLists.length;
          accountShape.msTasksTotal = msTasksCount;
          accountShape.msPagesTotal = msPagesCount;
        }

        // S5: Overall buildSnapshot_ (cross-validation)
        var t5_start = Date.now();
        var snapshot = buildSnapshot_(state, startedAt);
        var t5_end = Date.now();
        timings.S5 = t5_end - t5_start;

        timings.sum_S0_S4 = timings.S0 + timings.S1 + timings.S2 + timings.S3 + timings.S4;
        timings.S5_discrepancy = timings.S5 - timings.sum_S0_S4;

        var runRecord = {
          type: 'iteration_result',
          iteration: iter,
          timings: timings
        };
        runs.push(runRecord);
        console.log(JSON.stringify(runRecord));
      }

      // Check zero-mutation invariant
      var stateFinal = loadStateForSync_();
      var stateJsonFinal = JSON.stringify(stateFinal);
      if (stateJsonInitial !== stateJsonFinal) {
        throw new Error('ZERO_MUTATION_VIOLATION: State changed during probe execution!');
      }

      function median(arr) {
        var sorted = arr.slice().sort(function(a, b) { return a - b; });
        var mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      }

      var s0_vals = runs.map(function(r) { return r.timings.S0; });
      var s1_vals = runs.map(function(r) { return r.timings.S1; });
      var s2_vals = runs.map(function(r) { return r.timings.S2; });
      var s3_vals = runs.map(function(r) { return r.timings.S3; });
      var s4_vals = runs.map(function(r) { return r.timings.S4; });
      var s5_vals = runs.map(function(r) { return r.timings.S5; });
      var sum_vals = runs.map(function(r) { return r.timings.sum_S0_S4; });

      var medians = {
        S0: median(s0_vals),
        S1: median(s1_vals),
        S2: median(s2_vals),
        S3: median(s3_vals),
        S4: median(s4_vals),
        S5: median(s5_vals),
        R_total: median(sum_vals),
        R_total_S5: median(s5_vals)
      };

      probeResult = {
        type: 'probe_summary',
        accountShape: accountShape,
        runs: runs,
        medians: medians,
        zeroMutationVerified: true,
        completedAt: new Date().toISOString()
      };

      console.log(JSON.stringify(probeResult, null, 2));
      return probeResult;
    });
  } catch (err) {
    console.error(JSON.stringify({ type: 'probe_error', error: String(err && err.message || err) }));
    throw err;
  }

  if (!lockAcquired) {
    console.warn(JSON.stringify({ type: 'probe_aborted', reason: 'LOCK_BUSY' }));
    return { error: 'LOCK_BUSY' };
  }

  return probeResult;
}
