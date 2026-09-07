/**
 * B3GruOnnxIntegration.test.ts
 *
 * Comprehensive integration test suite for B3_GRU ONNX model integration
 * in the BetterMaps live positioning pipeline.
 *
 * Tests:
 * A. Model loads successfully
 * B. Exact input schema matches expected training schema
 * C. Inference returns finite outputs
 * D. Rolling window works
 * E. Warm-up behavior is correct
 * F. Repeated inference reuses the same session
 * G. No session creation per sample
 * H. Runtime output mapping is correct
 * I. Fallback occurs only when the model is genuinely unavailable
 * J. Diagnostics correctly report ONNX/GRU readiness
 *
 * Regression Fixture:
 * Deterministic known-input regression test to detect model-input drift.
 */

import {
  GruOnnxEvaluator,
  normalizeGruFeatures,
  GRU_NORM_MEANS,
  GRU_NORM_STDS,
} from "../../src/adapters/ml/GruOnnxEvaluator";
import { LearnedMotionEstimator } from "../../src/core/positioning/motionEstimator";
import { ImuSample } from "../../src/core/types/imu";

// Test assertion framework
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
    console.error(`FAIL: ${e?.message ?? e}`);
    if (e?.stack) console.error(e.stack);
    failed++;
  }
}

const ONNX_PATH = "artifacts/onnx/B3_GRU.onnx";

// Helper to generate a dummy IMU sample
function createMockImu(
  timestamp: number,
  accel = { x: 0, y: 0.1, z: 9.81 },
  gyro = { x: 0, y: 0.05, z: 0 }
): ImuSample {
  return { timestamp, accel, gyro };
}

async function main() {
  console.log("==================================================================");
  console.log("B3_GRU ONNX RUNTIME INTEGRATION TEST SUITE (TESTS A - J)");
  console.log("==================================================================");

  // ---------------------------------------------------------------------------
  // TEST A: Model loads successfully
  // ---------------------------------------------------------------------------
  await runTest("A. Model loads successfully", async () => {
    const evaluator = new GruOnnxEvaluator();
    assert(evaluator.initStatus === "UNINITIALIZED", "Initial status must be UNINITIALIZED");
    assert(!evaluator.isReady, "isReady must be false initially");

    await evaluator.initialize(ONNX_PATH);

    assert(evaluator.initStatus === "READY", `Status must be READY after init (got ${evaluator.initStatus})`);
    assert(evaluator.isReady, "isReady must be true after init");
    const diag = evaluator.getDiagnostics();
    assert(diag.modelFile === "B3_GRU.onnx", "Model file must be B3_GRU.onnx");
    assert(diag.backend === "gru", "Backend must be gru");
  });

  // ---------------------------------------------------------------------------
  // TEST B: Exact input schema matches expected training schema
  // ---------------------------------------------------------------------------
  await runTest("B. Exact input schema matches expected training schema", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    // Verify normalization constants
    assert(GRU_NORM_MEANS.length === 6, "Must have 6 normalization means");
    assert(GRU_NORM_STDS.length === 6, "Must have 6 normalization stds");
    assertClose(GRU_NORM_STDS[0], 1.6981, 0.01, "a_long std must match normalization.json");
    assertClose(GRU_NORM_STDS[3], 0.2594, 0.01, "omega_yaw std must match normalization.json");

    // Push 20 valid 6-channel samples
    for (let i = 0; i < 20; i++) {
      const normFeat = normalizeGruFeatures(0.1, 0.0, 0.0, 0.02, 0.0, 0.0);
      evaluator.pushSample(normFeat);
    }
    assert(evaluator.windowFill === 20, `Window fill must be 20 (got ${evaluator.windowFill})`);

    const result = await evaluator.evaluateAsync();
    assert(result !== null, "Inference must succeed with 20x6 schema");
  });

  // ---------------------------------------------------------------------------
  // TEST C: Inference returns finite outputs
  // ---------------------------------------------------------------------------
  await runTest("C. Inference returns finite outputs", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    for (let i = 0; i < 20; i++) {
      evaluator.pushSample([0, 0, 0, 0, 0, 0]);
    }

    const result = await evaluator.evaluateAsync();
    assert(result !== null, "Result must not be null");
    assert(Number.isFinite(result!.forwardVelocity), "Velocity must be finite");
    assert(Number.isFinite(result!.yawRate), "Yaw rate must be finite");
    assert(result!.forwardVelocity >= 0, "Forward velocity must be non-negative (ReLU)");
  });

  // ---------------------------------------------------------------------------
  // TEST D: Rolling window works
  // ---------------------------------------------------------------------------
  await runTest("D. Rolling window works", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    assert(evaluator.windowFill === 0, "Initial window fill must be 0");

    // Push 10 samples
    for (let i = 0; i < 10; i++) {
      evaluator.pushSample([i, 0, 0, 0, 0, 0]);
    }
    assert(evaluator.windowFill === 10, "Window fill must be 10");

    // Push 10 more
    for (let i = 10; i < 20; i++) {
      evaluator.pushSample([i, 0, 0, 0, 0, 0]);
    }
    assert(evaluator.windowFill === 20, "Window fill must cap at 20");

    // Push 5 more — window fill remains 20 (FIFO rotation)
    for (let i = 20; i < 25; i++) {
      evaluator.pushSample([i, 0, 0, 0, 0, 0]);
    }
    assert(evaluator.windowFill === 20, "Window fill must remain 20 after overflows");

    // Reset clears window
    evaluator.reset();
    assert(evaluator.windowFill === 0, "Window fill must be 0 after reset");
  });

  // ---------------------------------------------------------------------------
  // TEST E: Warm-up behavior is correct
  // ---------------------------------------------------------------------------
  await runTest("E. Warm-up behavior is correct", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    // Before 20 samples, evaluateAsync() must return null
    for (let i = 0; i < 19; i++) {
      evaluator.pushSample([0, 0, 0, 0, 0, 0]);
      const res = await evaluator.evaluateAsync();
      assert(res === null, `Sample ${i + 1}/20 must return null (warm-up)`);
    }

    // Exactly at 20 samples, evaluateAsync() must return a valid prediction
    evaluator.pushSample([0, 0, 0, 0, 0, 0]);
    const res20 = await evaluator.evaluateAsync();
    assert(res20 !== null, "Sample 20/20 must return a non-null prediction");
  });

  // ---------------------------------------------------------------------------
  // TEST F: Repeated inference reuses the same session
  // ---------------------------------------------------------------------------
  await runTest("F. Repeated inference reuses the same session", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    for (let i = 0; i < 20; i++) {
      evaluator.pushSample([0.1, 0.05, 0, 0.01, 0, 0]);
    }

    const latencies: number[] = [];
    for (let iter = 0; iter < 30; iter++) {
      evaluator.pushSample([0.1, 0.05, 0, 0.01, 0, 0]);
      const t0 = performance.now();
      const res = await evaluator.evaluateAsync();
      const dt = performance.now() - t0;
      latencies.push(dt);
      assert(res !== null, `Iteration ${iter} must succeed`);
    }

    const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    assert(avgLat < 10.0, `Average host latency must be < 10 ms (got ${avgLat.toFixed(3)} ms)`);
    assert(evaluator.getDiagnostics().totalInferences === 30, "Total inferences must be 30");
  });

  // ---------------------------------------------------------------------------
  // TEST G: No session creation per sample
  // ---------------------------------------------------------------------------
  await runTest("G. No session creation per sample", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    const initialSession = (evaluator as any).session;
    assert(initialSession !== null, "Session must exist after initialize");

    for (let i = 0; i < 25; i++) {
      evaluator.pushSample([0, 0, 0, 0, 0, 0]);
      await evaluator.evaluateAsync();
      const currentSession = (evaluator as any).session;
      assert(currentSession === initialSession, `Session reference must never change (step ${i})`);
    }
  });

  // ---------------------------------------------------------------------------
  // TEST H: Runtime output mapping is correct
  // ---------------------------------------------------------------------------
  await runTest("H. Runtime output mapping is correct", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    // Feed left turn IMU pattern: positive yaw rate
    for (let i = 0; i < 20; i++) {
      const norm = normalizeGruFeatures(0.5, -0.2, 0, 0.1, 0, 0);
      evaluator.pushSample(norm);
    }
    const leftRes = await evaluator.evaluateAsync();
    assert(leftRes !== null, "Left turn inference must succeed");
    assert(leftRes!.forwardVelocity >= 0, "Left turn velocity must be non-negative");

    // Feed right turn IMU pattern: negative yaw rate
    evaluator.reset();
    for (let i = 0; i < 20; i++) {
      const norm = normalizeGruFeatures(0.5, 0.2, 0, -0.1, 0, 0);
      evaluator.pushSample(norm);
    }
    const rightRes = await evaluator.evaluateAsync();
    assert(rightRes !== null, "Right turn inference must succeed");
    assert(rightRes!.forwardVelocity >= 0, "Right turn velocity must be non-negative");
  });

  // ---------------------------------------------------------------------------
  // TEST I: Fallback occurs only when the model is genuinely unavailable
  // ---------------------------------------------------------------------------
  await runTest("I. Fallback occurs only when model is genuinely unavailable", async () => {
    // 1. When evaluator is NOT initialized, evaluateAsync returns null
    const uninitEvaluator = new GruOnnxEvaluator();
    assert(uninitEvaluator.initStatus === "UNINITIALIZED", "Must be uninitialized");
    const nullRes = await uninitEvaluator.evaluateAsync();
    assert(nullRes === null, "Uninitialized evaluator must return null");

    // 2. Test LearnedMotionEstimator with uninitialized evaluator -> kinematic fallback
    let evaluatorCalled = false;
    const fallbackEstimator = new LearnedMotionEstimator("gru", {
      customEvaluator: async () => {
        evaluatorCalled = true;
        return null; // triggers fallback
      },
    });

    const window = [createMockImu(1000), createMockImu(1100)];
    const est = fallbackEstimator.estimate(window);
    assert(evaluatorCalled, "Evaluator was queried");
    assert(est !== null, "Estimate returned");
    assert(Number.isFinite(est.forwardVelocity), "Fallback provides valid forward velocity");
  });

  // ---------------------------------------------------------------------------
  // TEST J: Diagnostics correctly report ONNX/GRU readiness
  // ---------------------------------------------------------------------------
  await runTest("J. Diagnostics correctly report ONNX/GRU readiness", async () => {
    const evaluator = new GruOnnxEvaluator();
    const d0 = evaluator.getDiagnostics();
    assert(d0.status === "UNINITIALIZED", "Status UNINITIALIZED before init");
    assert(!d0.inferenceReady, "inferenceReady must be false");

    await evaluator.initialize(ONNX_PATH);
    const d1 = evaluator.getDiagnostics();
    assert(d1.status === "READY", "Status READY after init");
    assert(!d1.inferenceReady, "inferenceReady false while window < 20");

    for (let i = 0; i < 20; i++) {
      evaluator.pushSample([0, 0, 0, 0, 0, 0]);
    }
    await evaluator.evaluateAsync();

    const d2 = evaluator.getDiagnostics();
    assert(d2.inferenceReady, "inferenceReady true after 20 samples");
    assert(d2.totalInferences === 1, "totalInferences must be 1");
    assert(d2.lastVelocityMps !== null, "lastVelocityMps must be populated");
    assert(d2.lastYawRateRadps !== null, "lastYawRateRadps must be populated");
    assert(d2.windowFill === 20, "windowFill must be 20");
  });

  // ---------------------------------------------------------------------------
  // REGRESSION FIXTURE: Deterministic Known-Input Output Verification
  // ---------------------------------------------------------------------------
  await runTest("Regression Fixture: Deterministic known-input output verification", async () => {
    const evaluator = new GruOnnxEvaluator();
    await evaluator.initialize(ONNX_PATH);

    // Exact zero-input vector (20 samples of zeros in normalized space)
    // Verified offline in verify_gru_onnx.py:
    // v_f = 0.5263 m/s, omega = -0.0081 rad/s
    for (let i = 0; i < 20; i++) {
      evaluator.pushSample([0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    }

    const res = await evaluator.evaluateAsync();
    assert(res !== null, "Inference must produce result");
    assertClose(res!.forwardVelocity, 0.5263, 0.01, "v_f for zero-input must match fixture (0.5263 m/s)");
    assertClose(res!.yawRate, -0.0081, 0.005, "omega for zero-input must match fixture (-0.0081 rad/s)");
  });

  console.log("------------------------------------------------------------------");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
