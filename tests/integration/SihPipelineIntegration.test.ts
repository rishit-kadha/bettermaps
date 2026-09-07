/**
 * SihPipelineIntegration.test.ts
 *
 * Integration test suite for the friend's SIH Dead Reckoning pipeline:
 * - SihGruEvaluator (ONNX & Embedded Neural JS)
 * - SihMotionEstimator (50-sample window, vehicle calibration, yaw mapping)
 * - Dynamic switching inside IovnbdReplaySource and EskfPositioningEngine
 */

import { sihGruEvaluator, SihGruEvaluator, normalizeSihFeatures, SIH_NORM_MEANS, SIH_NORM_STDS } from "../../src/adapters/ml/SihGruEvaluator";
import { SihMotionEstimator } from "../../src/core/positioning/sih/SihMotionEstimator";
import { LearnedMotionEstimator } from "../../src/core/positioning/motionEstimator";
import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import { iovnbdReplaySource } from "../../src/services/replay/IovnbdReplaySource";
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

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
  } catch (e: any) {
    console.error(`FAIL: ${e?.message ?? e}`);
    if (e?.stack) console.error(e.stack);
    failed++;
  }
}

function createMockImu(
  timestamp: number,
  accel = { x: 0, y: 0.2, z: 9.81 },
  gyro = { x: 0, y: 0.05, z: 0 }
): ImuSample {
  return { timestamp, accel, gyro };
}

async function main() {
  console.log("==================================================================");
  console.log("SIH DEAD RECKONING PIPELINE INTEGRATION TESTS");
  console.log("==================================================================");

  // ---------------------------------------------------------------------------
  // TEST 1: SihGruEvaluator initialization
  // ---------------------------------------------------------------------------
  await runTest("1. Evaluator initializes successfully", async () => {
    const evaluator = new SihGruEvaluator();
    assert(evaluator.initStatus === "UNINITIALIZED", "Initial status must be UNINITIALIZED");
    await evaluator.initialize();
    assert(evaluator.isReady, "isReady must be true after init");
    const diag = evaluator.getDiagnostics();
    assert(diag.backend === "sih_gru", "Backend must be sih_gru");
    assert(diag.windowTarget === 50, "Window target must be 50");
  });

  // ---------------------------------------------------------------------------
  // TEST 2: 50-sample warm-up guard
  // ---------------------------------------------------------------------------
  await runTest("2. 50-sample warm-up guard", async () => {
    const evaluator = new SihGruEvaluator();
    await evaluator.initialize();

    // Push 49 samples
    for (let i = 0; i < 49; i++) {
      evaluator.pushSample([0.1, -0.05, 0.2, 0.0, 0.01, -0.02]);
    }
    assert(evaluator.windowFill === 49, `windowFill must be 49 (got ${evaluator.windowFill})`);
    const resEarly = await evaluator.evaluateAsync();
    assert(resEarly === null, "Inference must return null before 50 samples");

    // Push 50th sample
    evaluator.pushSample([0.1, -0.05, 0.2, 0.0, 0.01, -0.02]);
    assert(evaluator.windowFill === 50, `windowFill must be 50 (got ${evaluator.windowFill})`);
    const res50 = await evaluator.evaluateAsync();
    assert(res50 !== null, "Inference must succeed once 50 samples are filled");
    assert(res50!.forwardVelocity >= 0, `Velocity must be non-negative (got ${res50!.forwardVelocity})`);
    assert(isFinite(res50!.forwardVelocity), "Velocity must be finite");
  });

  // ---------------------------------------------------------------------------
  // TEST 3: Normalization & Non-negativity
  // ---------------------------------------------------------------------------
  await runTest("3. Normalization statistics and non-negativity constraint", async () => {
    const raw = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    const norm = normalizeSihFeatures(raw);
    assert(norm.length === 6, "Normalized length must be 6");
    for (let i = 0; i < 6; i++) {
      assertClose(norm[i], -SIH_NORM_MEANS[i] / SIH_NORM_STDS[i], 1e-4, `Channel ${i} z-score`);
    }

    const evaluator = new SihGruEvaluator();
    await evaluator.initialize();
    // Feed high negative deceleration
    for (let i = 0; i < 60; i++) {
      evaluator.pushSample([-5.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    }
    const res = await evaluator.evaluateAsync();
    assert(res !== null, "Inference must not be null");
    assert(res!.forwardVelocity >= 0.0, `Velocity must clamp at 0 (got ${res!.forwardVelocity})`);
  });

  // ---------------------------------------------------------------------------
  // TEST 4: SihMotionEstimator contract and kinematics
  // ---------------------------------------------------------------------------
  await runTest("4. SihMotionEstimator IMotionEstimator contract", async () => {
    const estimator = new SihMotionEstimator({ yawChannel: "pitch", yawSign: 1.0 });
    assert(estimator.backendType === "sih_gru", "backendType must be sih_gru");
    assert(estimator.name.includes("SIH"), "Name must mention SIH");

    estimator.primeState(10.0, 0.0);
    const window: ImuSample[] = [];
    for (let i = 0; i < 20; i++) {
      window.push(createMockImu(1000 + i * 100));
    }
    const est = estimator.estimate(window);
    assert(est.forwardVelocity > 0, "Velocity must be positive from primed state");
    assert(isFinite(est.yawRate), "Yaw rate must be finite");
    assert(est.velocityVariance > 0, "Variance must be positive");

    const diag = estimator.getDiagnostics();
    assert(diag.backendType === "sih_gru", "Diagnostics backendType must match");
    assert(diag.targetWindowLength === 50, "targetWindowLength must be 50");
  });

  // ---------------------------------------------------------------------------
  // TEST 5: EskfPositioningEngine integration & propagation
  // ---------------------------------------------------------------------------
  await runTest("5. EskfPositioningEngine runs with SihMotionEstimator", async () => {
    const sihEst = new SihMotionEstimator({ yawChannel: "pitch", yawSign: 1.0 });
    const engine = new EskfPositioningEngine({ motionEstimator: sihEst });

    // Initialize with initial GNSS fix
    engine.processGnss({
      latitude: 52.408,
      longitude: -1.512,
      altitude: 100,
      timestamp: 1000,
      accuracy: 1.0,
      speed: 10.0,
      heading: 90.0,
      providerType: "gnss",
      isDeadReckoning: false,
    });

    // Feed 50 IMU samples
    let estimate: any = null;
    for (let i = 1; i <= 50; i++) {
      const sample = createMockImu(1000 + i * 100, { x: 0, y: 0.1, z: 9.81 }, { x: 0, y: 0.02, z: 0 });
      estimate = engine.processImu(sample);
    }

    assert(estimate !== null, "Estimate must be produced");
    assert(isFinite(estimate.latitude), "Latitude must be finite");
    assert(isFinite(estimate.longitude), "Longitude must be finite");
    assert(isFinite(estimate.speed), "Speed must be finite");
    assert(estimate.speed >= 0, "Speed must be >= 0");
  });

  // ---------------------------------------------------------------------------
  // TEST 6: Dynamic model backend switching in IovnbdReplaySource
  // ---------------------------------------------------------------------------
  await runTest("6. Seamless switching between B3 GRU and SIH GRU in Replay Source", async () => {
    // Default is TCN or GRU
    iovnbdReplaySource.setModelBackend("gru");
    const rep1 = iovnbdReplaySource.getDetailedReport();
    assert(rep1 !== null, "Report must be non-null");

    // Switch to SIH Pipeline
    iovnbdReplaySource.setModelBackend("sih_gru");
    // Switch to Kinematic
    iovnbdReplaySource.setModelBackend("kinematic");
    // Switch back to SIH Pipeline
    iovnbdReplaySource.setModelBackend("sih_gru");

    assert(true, "Switched model backends seamlessly without exception");
  });

  console.log("==================================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
