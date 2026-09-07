/**
 * GnssFusionAudit.test.ts
 *
 * Forensic Integration Test Suite auditing GNSS fusion and fallback behavior
 * in the BetterMaps Mobile ESKF Positioning Engine.
 *
 * Tests:
 * - Test A: GNSS ON vs GNSS OFF produces different estimator state.
 * - Test B: Counterfactual GNSS measurement changes estimator state predictably.
 * - Test C: GNSS recovery produces an ESKF update.
 * - Test D: No stale GNSS measurement is reused during outage.
 * - Test E: GNSS + road + route can coexist.
 * - Test F: Road OFF and Road ON have identical GNSS behavior.
 * - Test G: First GNSS fix initialization does not prevent later GNSS fusion.
 * - Test H: No direct hard GNSS position overwrite occurs in the active estimator.
 */

import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import { LearnedMotionEstimator } from "../../src/core/positioning/motionEstimator";
import { Eskf } from "../../src/core/positioning/eskf/Eskf";
import {
  Matrix15,
  vec3Norm,
  vec3Sub,
} from "../../src/core/positioning/eskf/EskfMath";
import { Vector3 } from "../../src/core/positioning/eskf/EskfTypes";
import { ProbabilisticRoadConstraint } from "../../src/core/positioning/constraints/ProbabilisticRoadConstraint";
import { ProbabilisticRouteConstraint } from "../../src/core/positioning/constraints/ProbabilisticRouteConstraint";
import { MultiCandidateRoadMatcher } from "../../src/core/navigation/road/MultiCandidateRoadMatcher";
import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import { RouteConstraintProvider } from "../../src/core/positioning/RouteConstraintProvider";
import { IovnbdReplaySource } from "../../src/services/replay/IovnbdReplaySource";
import { NavLocation } from "../../src/core/types/location";
import { ImuSample } from "../../src/core/types/imu";
import {
  Wgs84Coordinate,
  enuToWgs84,
  wgs84ToEnu,
} from "../../src/core/positioning/coordinates";

const coventryRoadData = require("../../assets/datasets/road_network_coventry.json");
const s1Fixture = require("../../assets/datasets/iovnbd_s1.json");

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
    `${message} (got ${a}, expected ~${b}, tol=${tol})`,
  );
}

async function runTest(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
  } catch (e) {
    console.error(`FAIL: ${e}`);
    failed++;
  }
}

const ORIGIN: Wgs84Coordinate = {
  latitude: 52.408,
  longitude: -1.512,
  altitude: 100.0,
};

function createMockOriginFix(timestamp = 1000): NavLocation {
  return {
    latitude: ORIGIN.latitude,
    longitude: ORIGIN.longitude,
    altitude: ORIGIN.altitude,
    speed: 10.0,
    heading: 90.0, // East
    accuracy: 3.0,
    timestamp,
    providerType: "gnss",
    isDeadReckoning: false,
  };
}

function createSyntheticImu(
  timestamp: number,
  accelY = 0.0,
  gyroPitch = 0.0,
): ImuSample {
  return {
    timestamp,
    accel: { x: 0.0, y: accelY, z: 9.80665 },
    gyro: { x: 0.0, y: gyroPitch, z: 0.0 },
    magnetometer: { x: 0.0, y: 0.0, z: 0.0 },
  };
}

async function runAllTests(): Promise<void> {
  console.log("=== Running GNSS Fusion & Fallback Forensic Audit Suite ===\n");

  // =========================================================================
  // Test A: GNSS ON vs GNSS OFF produces different estimator state
  // =========================================================================
  await runTest(
    "Test A: GNSS ON vs GNSS OFF produces different estimator state",
    () => {
      const engineOff = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });
      const engineOn = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });

      const originFix = createMockOriginFix(1000);
      engineOff.processGnss(originFix);
      engineOn.processGnss(originFix);

      // Run 20 steps (2 seconds)
      // Vehicle moving East at ~10 m/s
      for (let k = 1; k <= 20; k++) {
        const t = 1000 + k * 100;
        const imu = createSyntheticImu(t, 0.5, 0.0);

        // In Engine ON: supply GNSS fix pulled slightly North (+5m North)
        const gnssFix: NavLocation = {
          latitude: ORIGIN.latitude + 5.0 / 111132.95,
          longitude:
            ORIGIN.longitude +
            (k * 1.0) /
              (111111.0 * Math.cos((ORIGIN.latitude * Math.PI) / 180.0)),
          altitude: 100.0,
          speed: 10.0,
          heading: 90.0,
          accuracy: 2.0,
          timestamp: t,
          providerType: "gnss",
          isDeadReckoning: false,
        };

        engineOff.processImu(imu);

        engineOn.processGnss(gnssFix);
        engineOn.processImu(imu);
      }

      const stateOff = engineOff.getEskf().getState();
      const stateOn = engineOn.getEskf().getState();
      const covOff = engineOff.getEskf().getCovariance();
      const covOn = engineOn.getEskf().getCovariance();

      // 1. Position states must diverge significantly
      const posDiff = vec3Norm(
        vec3Sub(stateOn.positionEnu, stateOff.positionEnu),
      );
      assert(
        posDiff > 1.0,
        `States must diverge due to GNSS (posDiff=${posDiff.toFixed(3)}m)`,
      );

      // 2. North position of Engine ON must be pulled towards +5m GNSS bias
      assert(
        stateOn.positionEnu[1] > stateOff.positionEnu[1],
        `Engine ON North (${stateOn.positionEnu[1].toFixed(2)}) must exceed Engine OFF (${stateOff.positionEnu[1].toFixed(2)})`,
      );

      // 3. Covariance with GNSS must be tighter than GNSS OFF
      const posVarOff = covOff.get(0, 0) + covOff.get(1, 1);
      const posVarOn = covOn.get(0, 0) + covOn.get(1, 1);
      assert(
        posVarOn < posVarOff,
        `GNSS ON covariance (${posVarOn.toFixed(3)}) must be smaller than GNSS OFF (${posVarOff.toFixed(3)})`,
      );

      // 4. GNSS delivered count and update count check
      assert(
        engineOff.getGnssDeliveredCount() === 1,
        `Engine OFF delivered count should be 1 (got ${engineOff.getGnssDeliveredCount()})`,
      );
      assert(
        engineOn.getGnssDeliveredCount() === 21,
        `Engine ON delivered count should be 21 (got ${engineOn.getGnssDeliveredCount()})`,
      );
      assert(
        engineOn.getEskfDiagnostics().gnssUpdateCount === 40,
        `Engine ON should have 40 GNSS updates applied (20 pos + 20 vel, got ${engineOn.getEskfDiagnostics().gnssUpdateCount})`,
      );
      assert(
        engineOff.getEskfDiagnostics().gnssUpdateCount === 0,
        `Engine OFF should have 0 GNSS updates applied (got ${engineOff.getEskfDiagnostics().gnssUpdateCount})`,
      );
    },
  );

  // =========================================================================
  // Test B: Counterfactual GNSS measurement changes estimator state predictably
  // =========================================================================
  await runTest(
    "Test B: Counterfactual GNSS measurement changes estimator state predictably",
    () => {
      const engineA = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });
      const engineB = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });

      const originFix = createMockOriginFix(1000);
      engineA.processGnss(originFix);
      engineB.processGnss(originFix);

      // Run 5 IMU samples identically to accumulate some process noise
      for (let k = 1; k <= 5; k++) {
        const imu = createSyntheticImu(1000 + k * 100, 0.0, 0.0);
        engineA.processImu(imu);
        engineB.processImu(imu);
      }

      const preStateA = engineA.getEskf().getState().positionEnu[0];
      const preStateB = engineB.getEskf().getState().positionEnu[0];
      assertClose(
        preStateA,
        preStateB,
        1e-6,
        "Pre-measurement states must be identical",
      );

      // Condition A: GNSS East = 0m (relative to origin)
      const fixA: NavLocation = {
        latitude: ORIGIN.latitude,
        longitude: ORIGIN.longitude,
        altitude: 100.0,
        accuracy: 3.0,
        timestamp: 1600,
        providerType: "gnss",
        isDeadReckoning: false,
      };

      // Condition B: GNSS East = +10m (counterfactual measurement)
      const lonDelta10m =
        10.0 / (111111.0 * Math.cos((ORIGIN.latitude * Math.PI) / 180.0));
      const fixB: NavLocation = {
        latitude: ORIGIN.latitude,
        longitude: ORIGIN.longitude + lonDelta10m,
        altitude: 100.0,
        accuracy: 3.0,
        timestamp: 1600,
        providerType: "gnss",
        isDeadReckoning: false,
      };

      engineA.processGnss(fixA);
      engineB.processGnss(fixB);

      const postStateA = engineA.getEskf().getState().positionEnu[0];
      const postStateB = engineB.getEskf().getState().positionEnu[0];

      const deltaEast = postStateB - postStateA;
      assert(
        deltaEast > 0.5 && deltaEast < 10.0,
        `Counterfactual GNSS +10m East must shift estimator by Kalman gain fraction (deltaEast=${deltaEast.toFixed(3)}m)`,
      );
    },
  );

  // =========================================================================
  // Test C: GNSS recovery produces an ESKF update
  // =========================================================================
  await runTest("Test C: GNSS recovery produces an ESKF update", () => {
    const engine = new EskfPositioningEngine({
      motionEstimator: new LearnedMotionEstimator("kinematic"),
    });

    const originFix = createMockOriginFix(1000);
    engine.processGnss(originFix);

    // Enter outage
    engine.onGnssBlocked();
    assert(
      engine.getStatus() === "GNSS_BLOCKED_SIMULATED",
      "Status must transition to GNSS_BLOCKED_SIMULATED",
    );

    // Propagate 300 IMU samples (30s) during outage
    for (let k = 1; k <= 300; k++) {
      const imu = createSyntheticImu(1000 + k * 100, 0.1, 0.0);
      engine.processImu(imu);
    }

    const preRecoveryPos = [...engine.getEskf().getState().positionEnu];
    const preRecoveryVar = engine.getEskfDiagnostics().posUncertaintyM;

    // Recovery GNSS fix arrives at true vehicle position (say 30m East of dead-reckoned position)
    const recoveryEast = preRecoveryPos[0] + 30.0;
    const lonDelta =
      recoveryEast / (111111.0 * Math.cos((ORIGIN.latitude * Math.PI) / 180.0));
    const recoveryFix: NavLocation = {
      latitude: ORIGIN.latitude,
      longitude: ORIGIN.longitude + lonDelta,
      altitude: 100.0,
      speed: 10.0,
      heading: 90.0,
      accuracy: 3.0,
      timestamp: 31100,
      providerType: "gnss",
      isDeadReckoning: false,
    };

    const recoveryEst = engine.processGnss(recoveryFix);
    const postRecoveryPos = engine.getEskf().getState().positionEnu;
    const postRecoveryVar = engine.getEskfDiagnostics().posUncertaintyM;

    // 1. Status must return to GNSS_AVAILABLE
    assert(
      engine.getStatus() === "GNSS_AVAILABLE",
      `Status must transition to GNSS_AVAILABLE (got ${engine.getStatus()})`,
    );

    // 2. Position must move towards recovery fix (East should increase)
    assert(
      postRecoveryPos[0] > preRecoveryPos[0],
      `Recovery fix must pull position East (pre=${preRecoveryPos[0].toFixed(2)}, post=${postRecoveryPos[0].toFixed(2)})`,
    );

    // 3. Must be a smooth Kalman update, NOT an instantaneous snap to recoveryEast
    assert(
      Math.abs(postRecoveryPos[0] - recoveryEast) > 0.01,
      `Recovery must be a Bayesian update, not hard snap (post=${postRecoveryPos[0].toFixed(2)}, target=${recoveryEast.toFixed(2)})`,
    );

    // 4. Uncertainty must drop significantly upon recovery
    assert(
      postRecoveryVar < preRecoveryVar,
      `Uncertainty must contract upon recovery (pre=${preRecoveryVar.toFixed(2)}m, post=${postRecoveryVar.toFixed(2)}m)`,
    );

    // 5. Returned estimate flags
    assert(
      recoveryEst.isDeadReckoning === false,
      "isDeadReckoning must be false upon recovery fix",
    );
    assert(
      recoveryEst.position_source === "GNSS",
      `position_source must be GNSS (got ${recoveryEst.position_source})`,
    );
  });

  // =========================================================================
  // Test D: No stale GNSS measurement is reused during outage
  // =========================================================================
  await runTest(
    "Test D: No stale GNSS measurement is reused during outage",
    () => {
      const engine = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });

      const originFix = createMockOriginFix(1000);
      engine.processGnss(originFix);

      const deliveredAtOrigin = engine.getGnssDeliveredCount();
      const gnssUpdatesAtOrigin = engine.getEskfDiagnostics().gnssUpdateCount;

      // Enter outage
      engine.onGnssBlocked();

      // Run 100 IMU samples during outage
      for (let k = 1; k <= 100; k++) {
        const imu = createSyntheticImu(1000 + k * 100, 0.0, 0.0);
        const est = engine.processImu(imu);

        assert(
          est.isDeadReckoning === true,
          `Sample ${k}: isDeadReckoning must remain true during outage`,
        );
        assert(
          est.position_source === "IDR",
          `Sample ${k}: position_source must be IDR during outage`,
        );
      }

      // Verify zero GNSS deliveries or updates occurred during the entire 100-step outage
      assert(
        engine.getGnssDeliveredCount() === deliveredAtOrigin,
        `getGnssDeliveredCount must not increment during outage (expected ${deliveredAtOrigin}, got ${engine.getGnssDeliveredCount()})`,
      );
      assert(
        engine.getEskfDiagnostics().gnssUpdateCount === gnssUpdatesAtOrigin,
        `ESKF gnssUpdateCount must not increment during outage (expected ${gnssUpdatesAtOrigin}, got ${engine.getEskfDiagnostics().gnssUpdateCount})`,
      );
    },
  );

  // =========================================================================
  // Test E: GNSS + road + route can coexist
  // =========================================================================
  await runTest("Test E: GNSS + road + route can coexist", () => {
    const roadProvider = new LocalRoadNetworkProvider(coventryRoadData);
    const roadMatcher = new MultiCandidateRoadMatcher(roadProvider);
    const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);
    const routeConstraint = new ProbabilisticRouteConstraint();

    // Set a synthetic route along East direction
    routeConstraint.setRoute({
      id: "test-route",
      name: "Eastbound Route",
      polylinePoints: [
        { latitude: ORIGIN.latitude, longitude: ORIGIN.longitude },
        { latitude: ORIGIN.latitude, longitude: ORIGIN.longitude + 0.01 },
      ],
      totalDistanceMeters: 1000,
      estimatedDurationSeconds: 100,
      sourceProvider: "test",
      creationTimestampMs: Date.now(),
    });

    const engine = new EskfPositioningEngine({
      motionEstimator: new LearnedMotionEstimator("kinematic"),
      roadConstraint,
      routeConstraint,
    });

    roadConstraint.setEnabled(true);
    routeConstraint.setEnabled(true);

    const originFix = createMockOriginFix(1000);
    engine.processGnss(originFix);

    // Run 10 steps with GNSS, IMU, Road, and Route active concurrently
    for (let k = 1; k <= 10; k++) {
      const t = 1000 + k * 100;
      const gnssFix: NavLocation = {
        latitude: ORIGIN.latitude,
        longitude:
          ORIGIN.longitude +
          (k * 1.0) /
            (111111.0 * Math.cos((ORIGIN.latitude * Math.PI) / 180.0)),
        altitude: 100.0,
        speed: 10.0,
        heading: 90.0,
        accuracy: 3.0,
        timestamp: t,
        providerType: "gnss",
        isDeadReckoning: false,
      };

      engine.processGnss(gnssFix);

      const imu = createSyntheticImu(t, 0.0, 0.0);
      const est = engine.processImu(imu);

      assert(est !== null, `Step ${k}: PositionEstimate must not be null`);
      assert(
        !Number.isNaN(est.latitude),
        `Step ${k}: Latitude must not be NaN`,
      );
      assert(
        !Number.isNaN(est.longitude),
        `Step ${k}: Longitude must not be NaN`,
      );
    }

    const diag = engine.getEskfDiagnostics();
    assert(
      diag.gnssUpdateCount === 20,
      `All 20 GNSS updates (10 pos + 10 vel) must be applied (got ${diag.gnssUpdateCount})`,
    );
    assert(
      diag.posUncertaintyM > 0 && diag.posUncertaintyM < 5.0,
      `Covariance must be positive and bounded (got ${diag.posUncertaintyM.toFixed(2)}m)`,
    );
  });

  // =========================================================================
  // Test F: Road OFF and Road ON have identical GNSS behavior
  // =========================================================================
  await runTest(
    "Test F: Road OFF and Road ON have identical GNSS behavior",
    () => {
      const engineRoadOn = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("tcn"),
      });
      const engineRoadOff = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("tcn"),
      });

      const replayOn = new IovnbdReplaySource(
        engineRoadOn,
        new RouteConstraintProvider(),
      );
      const replayOff = new IovnbdReplaySource(
        engineRoadOff,
        new RouteConstraintProvider(),
      );

      replayOn.loadFixture(s1Fixture);
      replayOff.loadFixture(s1Fixture);

      replayOn.setEvaluationMode("FINAL_IDR");
      replayOff.setEvaluationMode("FINAL_IDR_ROAD_ABLATION");

      // Process the first 300 samples across pre-outage (0-20s) and outage (20-30s)
      for (let i = 0; i < 300; i++) {
        const sample = s1Fixture.samples[i];
        (replayOn as any).virtualTimeMs = sample.relative_time_ms;
        (replayOff as any).virtualTimeMs = sample.relative_time_ms;

        (replayOn as any).emitSample(sample);
        (replayOff as any).emitSample(sample);
      }

      // Both must have the EXACT same GNSS delivered count
      const deliveredOn = engineRoadOn.getGnssDeliveredCount();
      const deliveredOff = engineRoadOff.getGnssDeliveredCount();
      assert(
        deliveredOn === deliveredOff,
        `GNSS delivered count must be identical between Road ON and Road OFF (ON=${deliveredOn}, OFF=${deliveredOff})`,
      );

      // Both must have the EXACT same ESKF GNSS update count
      const gnssUpdatesOn = engineRoadOn.getEskfDiagnostics().gnssUpdateCount;
      const gnssUpdatesOff = engineRoadOff.getEskfDiagnostics().gnssUpdateCount;
      assert(
        gnssUpdatesOn === gnssUpdatesOff,
        `ESKF GNSS update counts must be identical (ON=${gnssUpdatesOn}, OFF=${gnssUpdatesOff})`,
      );

      // Verify outage timing was identical (201 pre-outage fixes for both)
      assert(
        deliveredOn === 202, // 1 origin + 201 pre-outage
        `Expected 202 fixes delivered by sample 300 (got ${deliveredOn})`,
      );
    },
  );

  // =========================================================================
  // Test G: First GNSS fix initialization does not prevent later GNSS fusion
  // =========================================================================
  await runTest(
    "Test G: First GNSS fix initialization does not prevent later GNSS fusion",
    () => {
      const engine = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });

      // Fix 1: t=0 establishes origin
      const fix1 = createMockOriginFix(1000);
      engine.processGnss(fix1);
      assert(
        engine.getGnssDeliveredCount() === 1,
        "Fix 1 delivered count must be 1",
      );
      assert(
        engine.getEskfDiagnostics().gnssUpdateCount === 0,
        "Fix 1 establishes origin/reset, not an incremental measurement update",
      );

      // Fix 2: t=1s (subsequent fix)
      const fix2: NavLocation = {
        ...fix1,
        timestamp: 2000,
        longitude: ORIGIN.longitude + 0.0001,
      };
      engine.processGnss(fix2);
      assert(
        engine.getGnssDeliveredCount() === 2,
        "Fix 2 delivered count must be 2",
      );
      assert(
        engine.getEskfDiagnostics().gnssUpdateCount === 2,
        `Fix 2 must trigger pos + vel ESKF measurement updates (expected 2, got ${engine.getEskfDiagnostics().gnssUpdateCount})`,
      );

      // Fix 3: t=2s (subsequent fix)
      const fix3: NavLocation = {
        ...fix1,
        timestamp: 3000,
        longitude: ORIGIN.longitude + 0.0002,
      };
      engine.processGnss(fix3);
      assert(
        engine.getGnssDeliveredCount() === 3,
        "Fix 3 delivered count must be 3",
      );
      assert(
        engine.getEskfDiagnostics().gnssUpdateCount === 4,
        `Fix 3 must trigger pos + vel ESKF measurement updates (expected 4, got ${engine.getEskfDiagnostics().gnssUpdateCount})`,
      );
    },
  );

  // =========================================================================
  // Test H: No direct hard GNSS position overwrite occurs in the active estimator
  // =========================================================================
  await runTest(
    "Test H: No direct hard GNSS position overwrite occurs in the active estimator",
    () => {
      const engine = new EskfPositioningEngine({
        motionEstimator: new LearnedMotionEstimator("kinematic"),
      });

      // Initialize at origin
      const originFix = createMockOriginFix(1000);
      engine.processGnss(originFix);

      // Propagate 10 IMU samples: engine moves East by ~10m
      for (let k = 1; k <= 10; k++) {
        const imu = createSyntheticImu(1000 + k * 100, 0.0, 0.0);
        engine.processImu(imu);
      }

      const preEast = engine.getEskf().getState().positionEnu[0];

      // Inject a GNSS fix that is 20m ahead of current position
      const targetEast = preEast + 20.0;
      const lonDelta =
        targetEast / (111111.0 * Math.cos((ORIGIN.latitude * Math.PI) / 180.0));
      const farFix: NavLocation = {
        latitude: ORIGIN.latitude,
        longitude: ORIGIN.longitude + lonDelta,
        altitude: 100.0,
        speed: 10.0,
        heading: 90.0,
        accuracy: 4.0, // R = 16.0 m^2
        timestamp: 2100,
        providerType: "gnss",
        isDeadReckoning: false,
      };

      engine.processGnss(farFix);
      const postEast = engine.getEskf().getState().positionEnu[0];

      // In a hard overwrite: postEast == targetEast (exactly +20m)
      // In a Bayesian update: postEast is between preEast and targetEast: preEast < postEast < targetEast
      assert(
        postEast > preEast,
        `Bayesian update must pull state towards measurement (pre=${preEast.toFixed(2)}, post=${postEast.toFixed(2)})`,
      );
      assert(
        postEast < targetEast,
        `Bayesian update must NOT hard-snap to measurement (post=${postEast.toFixed(2)}, target=${targetEast.toFixed(2)})`,
      );
      const snapDistance = Math.abs(postEast - targetEast);
      assert(
        snapDistance > 1.0,
        `Position must not snap directly to measurement (remaining gap=${snapDistance.toFixed(2)}m)`,
      );
    },
  );

  console.log(`\n=== GnssFusionAudit Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runAllTests().catch((err) => {
  console.error("Fatal error running GNSS fusion audit:", err);
  process.exit(1);
});
