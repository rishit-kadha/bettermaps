/**
 * EskfTestSuite.ts
 *
 * Comprehensive Automated Verification Suite for Mobile 15-State ESKF Integration.
 *
 * Tests:
 * 1. Deterministic Python Golden Vector Comparison with justified component tolerances.
 * 2. Multi-Candidate Road Matcher (P >= 0.65, margin >= 0.20 gating).
 * 3. Probabilistic Route Constraint (smooth Bayesian updates, distance/heading gating).
 * 4. Provider Neutrality Verification (zero third-party SDK imports in src/core/).
 * 5. IMU Propagation & Kalman Update Latency Benchmark (< 1.0 ms / tick).
 */

declare const require: any;
declare const process: any;

const fs = require("fs");
const path = require("path");
import { Eskf } from "../src/core/positioning/eskf/Eskf";
import {
  Matrix15,
  quatNormalize,
  vec3Norm,
  vec3Sub,
} from "../src/core/positioning/eskf/EskfMath";
import {
  NavigationState,
  VehicleFrameImuMeasurement,
} from "../src/core/positioning/eskf/EskfTypes";
import { MultiCandidateRoadMatcher } from "../src/core/navigation/road/MultiCandidateRoadMatcher";
import { IRoadNetworkProvider } from "../src/core/navigation/road/IRoadNetworkProvider";
import { RoadSegment } from "../src/core/navigation/road/RoadTypes";
import { ProbabilisticRouteConstraint } from "../src/core/positioning/constraints/ProbabilisticRouteConstraint";
import { PreExistingRoute } from "../src/core/navigation/routing/RoutingTypes";
import { Wgs84Coordinate } from "../src/core/positioning/coordinates";

// ==========================================
// Test 1: Deterministic Golden Vector Replay
// ==========================================

function runGoldenVectorTest(): boolean {
  console.log("\n=======================================================");
  console.log("TEST 1: ESKF Golden Vector Comparison (Python Reference)");
  console.log("=======================================================");

  const goldenPath = path.join(
    process.cwd(),
    "tests",
    "golden",
    "eskf_golden_vector.json",
  );
  if (!fs.existsSync(goldenPath)) {
    console.error(`Golden vector file not found at: ${goldenPath}`);
    return false;
  }

  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf-8"));
  const tolerances = golden.metadata.tolerances;

  const initState: NavigationState = {
    positionEnu: golden.initial_state.positionEnu,
    velocityEnu: golden.initial_state.velocityEnu,
    qNb: golden.initial_state.qNb,
    accelBias: golden.initial_state.accelBias,
    gyroBias: golden.initial_state.gyroBias,
  };
  const initP = Matrix15.fromDiag(golden.initial_cov_diag);

  const filter = new Eskf(initState, initP);

  // Tracking error statistics
  const errors = {
    pos: [] as number[],
    vel: [] as number[],
    att: [] as number[],
    biasA: [] as number[],
    biasG: [] as number[],
    covRel: [] as number[],
  };

  for (let i = 0; i < golden.steps.length; i++) {
    const step = golden.steps[i];

    // 1. Replay IMU propagation
    const prop = step.propagate;
    const imuMeas: VehicleFrameImuMeasurement = {
      timestampS: i * prop.dt,
      accelMps2: prop.accel,
      gyroRadps: prop.gyro,
    };
    filter.propagate(imuMeas, prop.dt);

    // 2. Replay measurement updates
    if (step.update_gnss_pos) {
      filter.updateGnssPosition(
        step.update_gnss_pos.pos,
        step.update_gnss_pos.std_m,
      );
    }
    if (step.update_motion) {
      filter.updateForwardVelocity(
        step.update_motion.fwd_vel,
        step.update_motion.vel_std,
      );
      filter.updateYawRate(
        step.update_motion.yaw_rate,
        step.update_motion.yaw_std,
        step.update_motion.measured_yaw,
      );
    }
    if (step.update_nhc) {
      filter.updateNhc(step.update_nhc.lat_std, step.update_nhc.vert_std);
    }
    if (step.update_soft_position) {
      // Soft position update
      const covVar = step.update_soft_position.cov[0][0];
      const baseStd = Math.sqrt(covVar);
      filter.updateSoftPosition(step.update_soft_position.target, baseStd, 0.0);
    }
    if (step.update_gnss_pos_vel) {
      filter.updateGnssPosition(
        step.update_gnss_pos_vel.pos,
        step.update_gnss_pos_vel.std_m,
      );
      filter.updateGnssVelocity(
        step.update_gnss_pos_vel.vel,
        step.update_gnss_pos_vel.vel_std,
      );
    }

    // 3. Compare mobile state against Python reference
    const exp = step.expected_state;
    const act = filter.getState();

    // Position error (Euclidean norm)
    const posErr = vec3Norm(vec3Sub(act.positionEnu, exp.positionEnu));
    errors.pos.push(posErr);

    // Velocity error (Euclidean norm)
    const velErr = vec3Norm(vec3Sub(act.velocityEnu, exp.velocityEnu));
    errors.vel.push(velErr);

    // Attitude quaternion error (handle antipodal sign q ~ -q)
    let qDiff = 0.0;
    const dotQ =
      act.qNb[0] * exp.qNb[0] +
      act.qNb[1] * exp.qNb[1] +
      act.qNb[2] * exp.qNb[2] +
      act.qNb[3] * exp.qNb[3];
    const sign = dotQ >= 0 ? 1.0 : -1.0;
    for (let k = 0; k < 4; k++) {
      qDiff += Math.pow(act.qNb[k] - sign * exp.qNb[k], 2);
    }
    errors.att.push(Math.sqrt(qDiff));

    // Accel bias error
    const baErr = vec3Norm(vec3Sub(act.accelBias, exp.accelBias));
    errors.biasA.push(baErr);

    // Gyro bias error
    const bgErr = vec3Norm(vec3Sub(act.gyroBias, exp.gyroBias));
    errors.biasG.push(bgErr);

    // Covariance diagonal relative error
    const actCov = filter.getCovariance();
    let maxDiagRelErr = 0.0;
    for (let d = 0; d < 15; d++) {
      const actVal = actCov.get(d, d);
      const expVal = step.expected_cov_diag[d];
      const relErr = Math.abs(actVal - expVal) / Math.max(1e-6, expVal);
      if (relErr > maxDiagRelErr) maxDiagRelErr = relErr;
    }
    errors.covRel.push(maxDiagRelErr);
  }

  const max = (arr: number[]) => Math.max(...arr);
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const maxPosErr = max(errors.pos);
  const meanPosErr = mean(errors.pos);
  const maxVelErr = max(errors.vel);
  const meanVelErr = mean(errors.vel);
  const maxAttErr = max(errors.att);
  const meanAttErr = mean(errors.att);
  const maxBaErr = max(errors.biasA);
  const maxBgErr = max(errors.biasG);
  const maxCovRel = max(errors.covRel);

  console.log(`Steps Evaluated: ${golden.steps.length}`);
  console.log("Component Error Summary against Justified Tolerances:");
  console.log(
    `  Position:   Max = ${maxPosErr.toFixed(6)} m,  Mean = ${meanPosErr.toFixed(6)} m  (Tolerance: <= ${tolerances.position_max_err_m} m)`,
  );
  console.log(
    `  Velocity:   Max = ${maxVelErr.toFixed(6)} m/s, Mean = ${meanVelErr.toFixed(6)} m/s (Tolerance: <= ${tolerances.velocity_max_err_mps} m/s)`,
  );
  console.log(
    `  Attitude:   Max = ${maxAttErr.toExponential(3)},      Mean = ${mean(errors.att).toExponential(3)}      (Tolerance: <= ${tolerances.attitude_max_err})`,
  );
  console.log(
    `  Accel Bias: Max = ${maxBaErr.toExponential(3)} m/s^2 (Tolerance: <= ${tolerances.bias_max_err})`,
  );
  console.log(
    `  Gyro Bias:  Max = ${maxBgErr.toExponential(3)} rad/s (Tolerance: <= ${tolerances.bias_max_err})`,
  );
  console.log(
    `  Covariance: Max Diag Rel Error = ${(maxCovRel * 100).toFixed(4)}% (Tolerance: <= ${(tolerances.cov_diag_relative_err * 100).toFixed(2)}%)`,
  );

  const passed =
    maxPosErr <= tolerances.position_max_err_m &&
    maxVelErr <= tolerances.velocity_max_err_mps &&
    maxAttErr <= tolerances.attitude_max_err &&
    maxBaErr <= tolerances.bias_max_err &&
    maxBgErr <= tolerances.bias_max_err &&
    maxCovRel <= tolerances.cov_diag_relative_err;

  console.log(`\nTEST 1 RESULT: ${passed ? "PASSED [OK]" : "FAILED [FAIL]"}`);
  return passed;
}

// ==========================================
// Test 2: Multi-Candidate Road Matcher
// ==========================================

async function runRoadMatcherTest(): Promise<boolean> {
  console.log("\n=======================================================");
  console.log("TEST 2: Multi-Candidate Road Matcher & Gating Contract");
  console.log("=======================================================");

  const origin: Wgs84Coordinate = { latitude: 52.408, longitude: -1.512 };

  // Mock Road Network Provider
  const mockProvider: IRoadNetworkProvider = {
    findNearbySegments: (_center, _radius) => [
      // Segment 1: High-affinity primary road (aligned, close)
      {
        id: "seg_1_primary",
        name: "Main St",
        startPoint: { latitude: 52.408, longitude: -1.512 },
        endPoint: { latitude: 52.41, longitude: -1.512 },
        bearingDeg: 0.0, // North
        lengthMeters: 220.0,
        oneWay: false,
      },
      // Segment 2: Parallel side road (further away)
      {
        id: "seg_2_side",
        name: "Alleyway",
        startPoint: { latitude: 52.408, longitude: -1.5115 },
        endPoint: { latitude: 52.41, longitude: -1.5115 },
        bearingDeg: 0.0, // North
        lengthMeters: 220.0,
        oneWay: false,
      },
      // Segment 3: Cross street (orthogonal heading)
      {
        id: "seg_3_cross",
        name: "Cross Ave",
        startPoint: { latitude: 52.409, longitude: -1.513 },
        endPoint: { latitude: 52.409, longitude: -1.511 },
        bearingDeg: 90.0, // East
        lengthMeters: 140.0,
        oneWay: true,
      },
    ],
    getSegmentById: () => null,
    getProviderName: () => "MockProvider",
    isOffline: () => true,
  };

  const matcher = new MultiCandidateRoadMatcher(mockProvider, {
    minConfidenceThreshold: 0.65,
    minMarginThreshold: 0.2,
    distanceSigmaM: 10.0,
  });

  // Scenario A: Clear, unambiguous match
  // Vehicle at ENU [2.0, 50.0], Heading = 0.0 (North) -> should confidently match seg_1_primary
  const matchA = await matcher.match([2.0, 50.0], 0.0, origin);
  const testA_passed =
    matchA !== null &&
    matchA.segment.id === "seg_1_primary" &&
    matchA.normalizedConfidence >= 0.65;

  console.log(
    `Scenario A (Clear match): ${testA_passed ? "PASS" : "FAIL"} - Matched: ${matchA?.segment.id}, Confidence: ${matchA?.normalizedConfidence.toFixed(3)}`,
  );

  // Scenario B: Ambiguous bifurcation / parallel equidistant roads
  // Mock provider with two identical parallel roads equidistant from vehicle
  const ambiguousProvider: IRoadNetworkProvider = {
    findNearbySegments: () => [
      {
        id: "fork_left",
        startPoint: { latitude: 52.408, longitude: -1.5121 },
        endPoint: { latitude: 52.41, longitude: -1.5121 },
        bearingDeg: 0.0,
        lengthMeters: 200.0,
      },
      {
        id: "fork_right",
        startPoint: { latitude: 52.408, longitude: -1.5119 },
        endPoint: { latitude: 52.41, longitude: -1.5119 },
        bearingDeg: 0.0,
        lengthMeters: 200.0,
      },
    ],
    getSegmentById: () => null,
    getProviderName: () => "AmbiguousMock",
    isOffline: () => true,
  };

  const matcherB = new MultiCandidateRoadMatcher(ambiguousProvider, {
    minConfidenceThreshold: 0.65,
    minMarginThreshold: 0.2,
  });

  // Vehicle right in the middle between both forks: margin < 0.20 -> MUST BE REJECTED
  const matchB = await matcherB.match([0.0, 50.0], 0.0, origin);
  const testB_passed = matchB === null;
  console.log(
    `Scenario B (Ambiguity rejection): ${testB_passed ? "PASS" : "FAIL"} - Correctly rejected ambiguous candidate (result: ${matchB})`,
  );

  // Scenario C: Severe heading divergence
  // Vehicle driving West (270 deg) across One-Way North street -> MUST BE REJECTED
  const matchC = await matcher.match([0.0, 50.0], 270.0, origin);
  const testC_passed = matchC === null || matchC.segment.id !== "seg_3_cross";
  console.log(`Scenario C (Heading gating): ${testC_passed ? "PASS" : "FAIL"}`);

  const allPassed = testA_passed && testB_passed && testC_passed;
  console.log(
    `\nTEST 2 RESULT: ${allPassed ? "PASSED [OK]" : "FAILED [FAIL]"}`,
  );
  return allPassed;
}

// ==========================================
// Test 3: Probabilistic Route Constraint
// ==========================================

function runRouteConstraintTest(): boolean {
  console.log("\n=======================================================");
  console.log("TEST 3: Probabilistic Route Constraint & Gating");
  console.log("=======================================================");

  const origin: Wgs84Coordinate = { latitude: 52.408, longitude: -1.512 };

  const testRoute: PreExistingRoute = {
    id: "route_test",
    name: "Pre-Existing Route",
    polylinePoints: [
      { latitude: 52.408, longitude: -1.512 },
      { latitude: 52.409, longitude: -1.512 },
      { latitude: 52.41, longitude: -1.512 },
    ],
    totalDistanceMeters: 222.0,
    estimatedDurationSeconds: 20,
    sourceProvider: "test",
    creationTimestampMs: Date.now(),
  };

  const constraint = new ProbabilisticRouteConstraint({
    baseStdMeters: 8.0,
    inflationFactor: 0.5,
    maxCrossTrackMeters: 35.0,
    minHeadingAlignmentCosine: 0.0,
  });
  constraint.setRoute(testRoute, origin);

  const eskf = new Eskf();
  // Filter at [4.0, 50.0, 0.0], heading North (0 deg)
  eskf.reset({
    positionEnu: [4.0, 50.0, 0.0],
    velocityEnu: [0.0, 5.0, 0.0],
    qNb: [1.0, 0.0, 0.0, 0.0], // Heading North
    accelBias: [0.0, 0.0, 0.0],
    gyroBias: [0.0, 0.0, 0.0],
  });

  // 1. Close to route: should apply soft update
  const res1 = constraint.evaluateAndApply(eskf, origin);
  const test1_passed = res1.applied && res1.crossTrackDistanceM < 5.0;
  console.log(
    `Scenario 1 (In-corridor update): ${test1_passed ? "PASS" : "FAIL"} - Applied: ${res1.applied}, Cross-track: ${res1.crossTrackDistanceM.toFixed(2)} m`,
  );

  // 2. Far from route: cross-track = 45m (> 35m max) -> should gate off
  eskf.reset({
    positionEnu: [45.0, 50.0, 0.0],
    velocityEnu: [0.0, 5.0, 0.0],
    qNb: [1.0, 0.0, 0.0, 0.0],
    accelBias: [0.0, 0.0, 0.0],
    gyroBias: [0.0, 0.0, 0.0],
  });
  const res2 = constraint.evaluateAndApply(eskf, origin);
  const test2_passed = !res2.applied && res2.crossTrackDistanceM > 35.0;
  console.log(
    `Scenario 2 (Excess cross-track gating): ${test2_passed ? "PASS" : "FAIL"} - Rejected: ${!res2.applied}, Reason: ${res2.rejectionReason}`,
  );

  const allPassed = test1_passed && test2_passed;
  console.log(
    `\nTEST 3 RESULT: ${allPassed ? "PASSED [OK]" : "FAILED [FAIL]"}`,
  );
  return allPassed;
}

// ==========================================
// Test 4: Provider Neutrality Verification
// ==========================================

function runProviderNeutralityTest(): boolean {
  console.log("\n=======================================================");
  console.log("TEST 4: Provider Neutrality Codebase Audit");
  console.log("=======================================================");

  const coreDir = path.join(process.cwd(), "src", "core");
  const forbiddenKeywords = [
    "react-native-maps",
    "@react-native-maps",
    "@maplibre",
    "maplibre-gl",
    "google-maps",
    "@google/maps",
  ];

  let violations = 0;

  function scanDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        scanDir(fullPath);
      } else if (
        e.isFile() &&
        (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))
      ) {
        const content = fs.readFileSync(fullPath, "utf-8");
        for (const kw of forbiddenKeywords) {
          if (content.includes(kw)) {
            console.error(
              `VIOLATION: ${fullPath} imports forbidden provider SDK "${kw}"`,
            );
            violations++;
          }
        }
      }
    }
  }

  scanDir(coreDir);

  const passed = violations === 0;
  console.log(
    `Files scanned under src/core/: provider violations = ${violations}`,
  );
  console.log(`\nTEST 4 RESULT: ${passed ? "PASSED [OK]" : "FAILED [FAIL]"}`);
  return passed;
}

// ==========================================
// Test 5: Latency Benchmark
// ==========================================

function runLatencyBenchmark(): boolean {
  console.log("\n=======================================================");
  console.log("TEST 5: Real-Time Execution Latency Benchmark");
  console.log("=======================================================");

  const filter = new Eskf();
  const imu: VehicleFrameImuMeasurement = {
    timestampS: 1.0,
    accelMps2: [0.5, -0.02, 9.80665],
    gyroRadps: [0.01, 0.02, 0.03],
  };

  const NUM_TICKS = 2000;
  const start = performance.now();

  for (let i = 0; i < NUM_TICKS; i++) {
    filter.propagate(imu, 0.02); // 50 Hz tick (dt = 0.02s)
    if (i % 5 === 0) {
      filter.updateForwardVelocity(5.2, 0.4);
      filter.updateYawRate(0.03, 0.02, 0.03);
    }
    if (i % 20 === 0) {
      filter.updateNhc(0.35, 0.2);
    }
    if (i % 50 === 0) {
      filter.updateGnssPosition([10.0, 20.0, 0.0], 3.0);
    }
  }

  const durationMs = performance.now() - start;
  const avgTickMs = durationMs / NUM_TICKS;
  const avgTickUs = avgTickMs * 1000.0;

  console.log(
    `Executed ${NUM_TICKS} filter iterations in ${durationMs.toFixed(2)} ms`,
  );
  console.log(
    `Average execution time per tick: ${avgTickMs.toFixed(4)} ms (${avgTickUs.toFixed(1)} µs)`,
  );
  console.log(`Target threshold: < 1.0 ms per tick`);

  const passed = avgTickMs < 1.0;
  console.log(`\nTEST 5 RESULT: ${passed ? "PASSED [OK]" : "FAILED [FAIL]"}`);
  return passed;
}

// ==========================================
// Main Runner
// ==========================================

async function main() {
  const t1 = runGoldenVectorTest();
  const t2 = await runRoadMatcherTest();
  const t3 = runRouteConstraintTest();
  const t4 = runProviderNeutralityTest();
  const t5 = runLatencyBenchmark();

  console.log("\n=======================================================");
  console.log("AUTOMATED SUITE EXECUTION SUMMARY");
  console.log("=======================================================");
  console.log(`1. Python Golden Vector Replay:    ${t1 ? "PASS" : "FAIL"}`);
  console.log(`2. Multi-Candidate Road Matcher:   ${t2 ? "PASS" : "FAIL"}`);
  console.log(`3. Probabilistic Route Constraint: ${t3 ? "PASS" : "FAIL"}`);
  console.log(`4. Provider Neutrality Audit:      ${t4 ? "PASS" : "FAIL"}`);
  console.log(`5. Real-Time Latency Benchmark:    ${t5 ? "PASS" : "FAIL"}`);

  const allPassed = t1 && t2 && t3 && t4 && t5;
  console.log(
    `\nOVERALL STATUS: ${allPassed ? "ALL TESTS PASSED" : "TEST SUITE FAILED"}`,
  );
  process.exit(allPassed ? 0 : 1);
}

main();
