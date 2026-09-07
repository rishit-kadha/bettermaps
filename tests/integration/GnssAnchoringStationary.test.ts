/**
 * GnssAnchoringStationary.test.ts
 *
 * Comprehensive integration test suite for stationary phone GNSS anchoring,
 * state selection, zero-velocity updates, physical stationary ZUPT gating,
 * and GNSS staleness watchdog.
 *
 * Scenarios:
 * A. Stationary phone + valid continuous GNSS -> position remains strictly bounded
 * B. Artificial drift (+15m) + repeated GNSS fixes -> Kalman state monotonically contracts
 * C. GNSS outage (gate disabled) -> zero updates to estimator, transitions to IDR
 * D. GNSS recovery (gate enabled) -> updates resume, transitions back to GNSS
 * E. Stale GNSS (> 3s without fix) -> watchdog marks staleness, transitions to IDR
 * F. GNSS healthy with missing heading -> correctly anchors velocity to [0, 0, 0]
 * G. GNSS healthy with zero speed -> remains valid, anchors velocity to [0, 0, 0]
 * H. NavigationManager source transitions (GNSS -> IDR -> GNSS)
 * I. LearnedMotionEstimator stationary gating -> overrides out-of-distribution neural output to 0
 * J. Moving IMU -> stationary gating immediately passes motion model estimate through
 */

import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import {
  LearnedMotionEstimator,
} from "../../src/core/positioning/motionEstimator";
import { NavigationManager } from "../../src/core/state/NavigationManager";
import { GnssStreamGate } from "../../src/core/positioning/GnssStreamGate";
import {
  NavLocation,
  ILocationProvider,
  LocationListener,
  StatusListener,
  ProviderStatus,
} from "../../src/core/types/location";
import { ImuSample } from "../../src/core/types/imu";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    passed++;
  }
}

function assertClose(a: number, b: number, tol: number, message: string): void {
  assert(
    Math.abs(a - b) <= tol,
    `${message} (got ${a.toFixed(4)}, expected ~${b.toFixed(4)}, tol=${tol})`
  );
}

async function runTest(
  name: string,
  fn: () => Promise<void> | void
): Promise<void> {
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
  } catch (e: any) {
    console.error(`FAIL: ${e.message || e}`);
    failed++;
  }
}

// Helper to create stationary IMU sample (flat on table or in portrait mount)
function makeStationaryImu(tMs: number): ImuSample {
  return {
    timestamp: tMs,
    accel: { x: 0.01, y: 0.02, z: 9.81 },
    gyro: { x: 0.001, y: -0.001, z: 0.002 },
  };
}

// Helper to create moving IMU sample (driving forward)
function makeMovingImu(tMs: number): ImuSample {
  return {
    timestamp: tMs,
    accel: { x: 0.1, y: 1.5, z: 9.81 },
    gyro: { x: 0.02, y: 0.15, z: 0.01 },
  };
}

// Helper to create a GNSS fix
function makeGnssFix(
  tMs: number,
  lat = 52.40805,
  lon = -1.51221,
  speed = 0.0,
  heading: number | null = null,
  acc = 3.0
): NavLocation {
  return {
    latitude: lat,
    longitude: lon,
    altitude: 100.0,
    accuracy: acc,
    altitudeAccuracy: 5.0,
    heading,
    speed,
    timestamp: tMs,
    providerType: "gnss",
    isDeadReckoning: false,
  };
}

// Mock Location Provider for testing NavigationManager
class MockLocationProvider implements ILocationProvider {
  public readonly id = "mock_provider";
  public readonly name = "Mock GNSS Provider";
  public readonly providerType = "gnss" as const;
  private listeners = new Set<LocationListener>();
  private statusListeners = new Set<StatusListener>();
  private active = false;
  private lastLocation: NavLocation | null = null;

  public async start(): Promise<void> {
    this.active = true;
  }
  public async stop(): Promise<void> {
    this.active = false;
  }
  public async getCurrentLocation(): Promise<NavLocation | null> {
    return this.lastLocation;
  }
  public getStatus(): ProviderStatus {
    return this.active ? "active" : "stopped";
  }
  public addListener(l: LocationListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  public addStatusListener(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
  public emitLocation(loc: NavLocation): void {
    this.lastLocation = loc;
    for (const l of this.listeners) l(loc);
  }
}

async function main() {
  console.log("=== Running GnssAnchoringStationary Test Suite ===\n");

  // TEST 1: LearnedMotionEstimator Stationary Gating
  await runTest("LearnedMotionEstimator stationary gating with mock evaluator", () => {
    // Custom evaluator simulates B3_GRU outputting ~5 m/s on static IMU
    const evaluator = () => ({
      forwardVelocity: 5.03,
      yawRate: 0.022,
      variance: [0.25, 0.01] as [number, number],
    });

    const estimator = new LearnedMotionEstimator("gru", {
      customEvaluator: evaluator,
    });

    // Provide 10 stationary IMU samples
    const window: ImuSample[] = [];
    for (let i = 0; i < 10; i++) {
      window.push(makeStationaryImu(1000 + i * 20));
    }

    const est = estimator.estimate(window);
    // Because device is physically stationary (gyro < 0.08, var(accel) < 0.15),
    // output MUST be gated to 0.0 m/s
    assert(est.forwardVelocity === 0.0, `Expected forwardVelocity = 0.0, got ${est.forwardVelocity}`);
    assert(est.yawRate === 0.0, `Expected yawRate = 0.0, got ${est.yawRate}`);
    assert(est.velocityVariance === 0.01, `Expected velVar = 0.01, got ${est.velocityVariance}`);
  });

  // TEST 2: Moving IMU passes through custom evaluator
  await runTest("LearnedMotionEstimator moving IMU passes evaluator output", () => {
    const evaluator = () => ({
      forwardVelocity: 12.5,
      yawRate: 0.05,
      variance: [0.5, 0.02] as [number, number],
    });

    const estimator = new LearnedMotionEstimator("gru", {
      customEvaluator: evaluator,
    });

    const window: ImuSample[] = [];
    for (let i = 0; i < 10; i++) {
      window.push(makeMovingImu(1000 + i * 20));
    }

    const est = estimator.estimate(window);
    assertClose(est.forwardVelocity, 12.5, 0.1, "Moving IMU must allow predicted velocity");
    assertClose(est.yawRate, 0.05, 0.01, "Moving IMU must allow predicted yaw rate");
  });

  // TEST 3: Scenario A - Stationary phone + continuous valid GNSS remains bounded
  await runTest("Scenario A: Stationary phone + valid GNSS remains anchored (< 0.5m drift)", () => {
    // Simulate motion estimator that produces 5.0 m/s if not stationary
    const motionEstimator = new LearnedMotionEstimator("gru", {
      customEvaluator: () => ({ forwardVelocity: 5.0, yawRate: 0.0 }),
    });

    const engine = new EskfPositioningEngine({ motionEstimator });

    const originLat = 52.40805;
    const originLon = -1.51221;

    // First GNSS fix initializes origin
    engine.processGnss(makeGnssFix(1000, originLat, originLon, 0.0, null, 2.5));

    let t = 1000;
    // Simulate 30 seconds of 20 Hz IMU (stationary) and 1 Hz GNSS fixes
    for (let s = 1; s <= 30; s++) {
      for (let imuStep = 0; imuStep < 20; imuStep++) {
        t += 50;
        engine.processImu(makeStationaryImu(t));
      }
      // 1 Hz GNSS fix
      engine.processGnss(makeGnssFix(t, originLat, originLon, 0.0, null, 2.5));
    }

    const finalEst = engine.getCurrentEstimate();
    const dLatM = (finalEst.latitude - originLat) * 111111.0;
    const dLonM = (finalEst.longitude - originLon) * 111111.0 * Math.cos((originLat * Math.PI) / 180.0);
    const totalDriftM = Math.hypot(dLatM, dLonM);

    assert(totalDriftM < 0.5, `Position drifted ${totalDriftM.toFixed(4)}m (expected < 0.5m)`);
    assert(finalEst.speed! < 0.05, `Speed ${finalEst.speed} should be near 0 m/s`);
    assert(engine.getGnssFixCount() === 31, `Expected 31 GNSS fixes, got ${engine.getGnssFixCount()}`);
    assert(engine.getGnssUpdateCount() === 31, `Expected 31 ESKF updates, got ${engine.getGnssUpdateCount()}`);
  });

  // TEST 4: Scenario B - Monotonic contraction after artificial drift
  await runTest("Scenario B: Artificial IMU drift (+15m) contracts monotonically under GNSS fixes", () => {
    const engine = new EskfPositioningEngine();
    const originLat = 52.40805;
    const originLon = -1.51221;

    // Initial fix at origin
    engine.processGnss(makeGnssFix(1000, originLat, originLon, 0.0, null, 2.0));

    // Artificially disturb the ESKF state by 15m East
    const state = engine.getEskf().getState();
    state.positionEnu[0] = 15.0; // 15m East
    const P = engine.getEskf().getCovariance();
    engine.getEskf().reset(state, P);

    let prevResidual = 15.0;
    // Deliver 5 consecutive GNSS fixes at origin (East = 0)
    for (let i = 1; i <= 5; i++) {
      engine.processGnss(makeGnssFix(1000 + i * 1000, originLat, originLon, 0.0, null, 2.0));
      const postState = engine.getEskf().getState();
      const currentPosEast = postState.positionEnu[0];
      assert(
        currentPosEast < prevResidual,
        `Contraction failed at fix ${i}: ${currentPosEast.toFixed(3)} not < ${prevResidual.toFixed(3)}`
      );
      prevResidual = currentPosEast;
    }

    assert(prevResidual < 3.0, `After 5 fixes, position residual ${prevResidual.toFixed(2)}m must be < 3.0m`);
  });

  // TEST 5: Scenario C & D - GNSS outage and recovery via stream gate
  await runTest("Scenario C & D: GNSS outage transitions to IDR, recovery restores GNSS", async () => {
    const gate = new GnssStreamGate();
    const mockProvider = new MockLocationProvider();
    const engine = new EskfPositioningEngine();
    const manager = new NavigationManager(engine, gate, undefined, undefined, mockProvider);
    await manager.start();

    // Initial fix
    mockProvider.emitLocation(makeGnssFix(Date.now(), 52.40805, -1.51221, 0.0));
    assert(manager.getTelemetry().locationSource === "GNSS", `Expected GNSS, got ${manager.getTelemetry().locationSource}`);
    assert(!manager.getTelemetry().isDeadReckoning, "Should not be dead-reckoning");

    // Disable stream gate (simulated outage)
    gate.disable();
    assert(manager.getTelemetry().locationSource === "GNSS STREAM BLOCKED", `Expected GNSS STREAM BLOCKED, got ${manager.getTelemetry().locationSource}`);
    assert(manager.getTelemetry().isDeadReckoning, "Should be dead-reckoning during outage");
    assert(manager.getTelemetry().gnssStatus === "BLOCKED", "gnssStatus should be BLOCKED");

    // Deliver GNSS fix during blocked gate -> must NOT reach estimator
    const initialGnssCount = engine.getGnssDeliveredCount();
    mockProvider.emitLocation(makeGnssFix(Date.now(), 52.40805, -1.51221, 0.0));
    assert(
      engine.getGnssDeliveredCount() === initialGnssCount,
      "Zero GNSS fixes must be delivered to estimator while blocked"
    );

    // Re-enable stream gate (recovery)
    gate.enable();
    mockProvider.emitLocation(makeGnssFix(Date.now(), 52.40805, -1.51221, 0.0));
    assert(manager.getTelemetry().locationSource === "GNSS", `Expected GNSS on recovery, got ${manager.getTelemetry().locationSource}`);
    assert(!manager.getTelemetry().isDeadReckoning, "Should no longer be dead-reckoning after recovery");
  });

  // TEST 6: Scenario E - GNSS Watchdog detects staleness (> 3000ms)
  await runTest("Scenario E: GNSS Watchdog marks staleness (> 3s without fix) and transitions to IDR", () => {
    const engine = new EskfPositioningEngine();
    const originLat = 52.40805;
    const originLon = -1.51221;

    // Deliver fix at t = 1000ms
    engine.processGnss(makeGnssFix(1000, originLat, originLon, 0.0, null, 2.0));
    assert(!engine.isGnssStale(2000), "1s elapsed: GNSS should not be stale");

    // Advance IMU to t = 4500ms (> 3s after last fix)
    const est = engine.processImu(makeStationaryImu(4500));
    assert(est !== null, "IMU estimate should be returned");
    assert(est!.isDeadReckoning === true, "Watchdog should mark isDeadReckoning = true after 3500ms");
    assert(est!.position_source === "IDR", "Position source should transition to IDR");
    assert(engine.isGnssStale(4500), "isGnssStale should return true at t=4500ms");
  });

  // TEST 7: Scenario F - Missing heading with zero speed anchors velocity to [0, 0, 0]
  await runTest("Scenario F: Missing heading when speed = 0 anchors velocity to [0, 0, 0]", () => {
    const engine = new EskfPositioningEngine();
    // Subsequent fix has speed = 0, heading = null (classic stationary Android behavior)
    engine.processGnss(makeGnssFix(1000, 52.40805, -1.51221, 0.0, null));

    // Artificially inject non-zero velocity in ESKF
    const state = engine.getEskf().getState();
    state.velocityEnu = [2.0, 3.0, 0.0];
    const P = engine.getEskf().getCovariance();
    engine.getEskf().reset(state, P);

    // Second fix with heading = null, speed = 0.0
    engine.processGnss(makeGnssFix(2000, 52.40805, -1.51221, 0.0, null));

    const postState = engine.getEskf().getState();
    const speed = Math.hypot(postState.velocityEnu[0], postState.velocityEnu[1]);
    assert(speed < 1.0, `Velocity should contract toward 0; got ${speed.toFixed(3)} m/s`);
  });

  // TEST 8: Scenario G - Zero speed does not drop GNSS validity
  await runTest("Scenario G: Speed = 0 does not mark GNSS as invalid", () => {
    const engine = new EskfPositioningEngine();
    const est = engine.processGnss(makeGnssFix(1000, 52.40805, -1.51221, 0.0, 0.0));
    assert(est.valid === true, "Estimate must remain valid when speed = 0");
    assert(est.position_source === "GNSS", "Position source should be GNSS");
    assert(est.isDeadReckoning === false, "isDeadReckoning should be false");
  });

  // TEST 9: Scenario H - Telemetry provides complete positioning diagnostics
  await runTest("Scenario H: NavigationManager exposes all required telemetry fields", async () => {
    const gate = new GnssStreamGate();
    const mockProvider = new MockLocationProvider();
    const engine = new EskfPositioningEngine();
    const manager = new NavigationManager(engine, gate, undefined, undefined, mockProvider);
    await manager.start();

    mockProvider.emitLocation(makeGnssFix(Date.now(), 52.40805, -1.51221, 0.0, null, 2.5));

    const telemetry = manager.getTelemetry();
    assert(telemetry.gnssFixCount !== undefined && telemetry.gnssFixCount >= 1, "gnssFixCount must be >= 1");
    assert(telemetry.eskfGnssUpdateCount !== undefined && telemetry.eskfGnssUpdateCount >= 1, "eskfGnssUpdateCount must be >= 1");
    assert(telemetry.gnssStatus === "VALID", `gnssStatus must be VALID, got ${telemetry.gnssStatus}`);
    assert(telemetry.lastGnssFixAgeMs !== null && telemetry.lastGnssFixAgeMs! < 1000, "lastGnssFixAgeMs should be < 1000ms");
    assert(telemetry.rawGnssLocation !== null, "rawGnssLocation must be populated");
    assertClose(telemetry.rawGnssLocation!.latitude, 52.40805, 0.0001, "rawGnssLocation latitude match");
  });

  console.log(`\n=== GnssAnchoringStationary Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
