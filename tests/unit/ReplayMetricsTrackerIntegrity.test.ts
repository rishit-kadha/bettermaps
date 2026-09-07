import { ReplayMetricsTracker } from '../../src/services/replay/ReplayMetricsTracker';

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    totalFailed++;
  } else {
    console.log(`  [PASS] ${message}`);
    totalPassed++;
  }
}

function assertClose(a: number, b: number, tol = 0.05, message = '') {
  assert(Math.abs(a - b) <= tol, `${message} (got ${a}, expected ~${b}, tol=${tol})`);
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  console.log(`\n--- ${name} ---`);
  try {
    await fn();
  } catch (err: any) {
    console.error(`  [EXCEPTION] ${err?.message ?? err}`);
    totalFailed++;
  }
}

async function main() {
  console.log('===============================================================');
  console.log('REPLAY METRICS TRACKER INTEGRITY & DUAL DRIFT TEST SUITE');
  console.log('===============================================================');

  await runTest('1. Dual Drift Reporting & Distinction (Endpoint vs Maximum)', () => {
    const tracker = new ReplayMetricsTracker();
    tracker.reset();

    // 0s to 20s: Pre-outage moving north along lon -1.500
    // Lat 52.000 to 52.002 (~222m)
    tracker.update(52.000, -1.500, 52.000, -1.500, 0, false);
    tracker.update(52.001, -1.500, 52.001, -1.500, 10000, false);
    tracker.update(52.002, -1.500, 52.002, -1.500, 20000, false);

    // 20s: Outage begins
    tracker.notifyOutageStarted(20000);

    // During outage: vehicle travels from 52.002 to 52.006 (~444.6m)
    // At t=25s, estimator drifts out by 50m (peak excursion)
    // 50m north in lat is ~0.00045 deg
    tracker.update(52.004, -1.500, 52.00445, -1.500, 25000, true);

    // At t=30s (end of outage), estimator pulls back to only 20m error
    // 20m north in lat is ~0.00018 deg
    tracker.update(52.006, -1.500, 52.00618, -1.500, 30000, true);

    // End outage at 30s
    tracker.notifyOutageEnded(30000);

    const report = tracker.getDetailedReport();

    assertClose(report.endpointErrorMeters, 20.0, 1.0, 'Endpoint error should be ~20m');
    assertClose(report.outageMaxErrorMeters, 50.0, 1.0, 'Max outage error should be ~50m');
    assertClose(report.outageDistanceMeters, 444.6, 5.0, 'Outage distance should be ~444.6m');

    // Expected Endpoint Drift % = 20 / 444.6 * 100 = 4.5% (< 10% -> PASS SIH)
    // Expected Max Drift % = 50 / 444.6 * 100 = 11.2% (>= 10% -> FAIL SIH)
    assertClose(report.endpointDriftPercent, 4.5, 0.5, 'Endpoint drift should be ~4.5%');
    assertClose(report.maxDriftPercent, 11.2, 0.5, 'Max drift should be ~11.2%');

    assert(report.under10pctEndpointDrift === true, 'SIH Endpoint Drift must PASS (<10%)');
    assert(report.under10pctMaxDrift === false, 'SIH Max Drift must FAIL (>=10%)');
    assert(report.errorBeforeRecoveryMeters === report.endpointErrorMeters, 'errorBeforeRecovery matches endpointError');
  });

  await runTest('2. Zero Distance & Zero Division Safety', () => {
    const tracker = new ReplayMetricsTracker();
    tracker.reset();

    tracker.notifyOutageStarted(20000);
    // Stationary vehicle during outage
    tracker.update(52.000, -1.500, 52.0001, -1.500, 21000, true);
    tracker.update(52.000, -1.500, 52.0001, -1.500, 22000, true);
    tracker.notifyOutageEnded(22000);

    const report = tracker.getDetailedReport();
    assert(Number.isFinite(report.endpointDriftPercent), 'Endpoint drift is finite when distance is zero');
    assert(Number.isFinite(report.maxDriftPercent), 'Max drift is finite when distance is zero');
    assert(report.endpointDriftPercent === 0.0, 'Endpoint drift is 0.0 when distance <= 0.1m');
    assert(report.maxDriftPercent === 0.0, 'Max drift is 0.0 when distance <= 0.1m');
  });

  await runTest('3. Percentile Calculations (P90 and P95)', () => {
    const tracker = new ReplayMetricsTracker();
    tracker.reset();
    tracker.notifyOutageStarted(0);

    // Feed 100 samples with errors 1m through 100m
    for (let i = 1; i <= 100; i++) {
      // 1m in lat is approx 0.000009 deg
      const dLat = i * (1.0 / 111111.0);
      tracker.update(52.000, -1.500, 52.000 + dLat, -1.500, i * 100, true);
    }
    tracker.notifyOutageEnded(10000);

    const report = tracker.getDetailedReport();
    assertClose(report.outageMedianErrorMeters, 51.0, 2.0, 'Median should be ~50-51m');
    assertClose(report.outageP90ErrorMeters, 91.0, 2.0, 'P90 should be ~90-91m');
    assertClose(report.outageP95ErrorMeters, 96.0, 2.0, 'P95 should be ~95-96m');
    assertClose(report.outageMaxErrorMeters, 100.0, 1.0, 'Max should be 100m');
  });

  await runTest('4. Recovery Milestones and Convergence Time Tracking', () => {
    const tracker = new ReplayMetricsTracker();
    tracker.reset();

    // Outage from 20s to 40s
    tracker.notifyOutageStarted(20000);
    // At end of outage (40s), error is 25m
    tracker.update(52.000, -1.500, 52.000225, -1.500, 40000, true);
    tracker.notifyOutageEnded(40000);

    // 40.1s (first fix after outage): error drops to 12m
    tracker.update(52.000, -1.500, 52.000108, -1.500, 40100, false);

    // 40.5s: error drops to 8m (< 10m convergence!)
    tracker.update(52.000, -1.500, 52.000072, -1.500, 40500, false);

    // 41.0s (1s milestone): error is 6m
    tracker.update(52.000, -1.500, 52.000054, -1.500, 41000, false);

    // 41.5s: error drops to 4m (< 5m convergence!)
    tracker.update(52.000, -1.500, 52.000036, -1.500, 41500, false);

    // 42.0s (2s milestone): error is 3m
    tracker.update(52.000, -1.500, 52.000027, -1.500, 42000, false);

    // 43.0s: error drops to 1.5m (< 2m convergence!)
    tracker.update(52.000, -1.500, 52.0000135, -1.500, 43000, false);

    // 45.0s (5s milestone): error is 0.8m
    tracker.update(52.000, -1.500, 52.0000072, -1.500, 45000, false);

    const report = tracker.getDetailedReport();

    assertClose(report.errorBeforeRecoveryMeters, 25.0, 1.0, 'Error before recovery ~25m');
    assertClose(report.errorFirstFixAfterOutageMeters!, 12.0, 1.0, 'Error first fix ~12m');
    assertClose(report.recoveryMilestones.at1s!, 6.0, 1.0, 'Recovery 1s milestone ~6m');
    assertClose(report.recoveryMilestones.at2s!, 3.0, 1.0, 'Recovery 2s milestone ~3m');
    assertClose(report.recoveryMilestones.at5s!, 0.8, 0.5, 'Recovery 5s milestone ~0.8m');

    assertClose(report.timeToUnder10mSec!, 0.5, 0.1, 'Time to <10m ~0.5s');
    assertClose(report.timeToUnder5mSec!, 1.5, 0.1, 'Time to <5m ~1.5s');
    assertClose(report.timeToUnder2mSec!, 3.0, 0.1, 'Time to <2m ~3.0s');
  });

  console.log(`\n===============================================================`);
  console.log(`RESULTS: ${totalPassed} Passed, ${totalFailed} Failed`);
  console.log(`===============================================================`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
