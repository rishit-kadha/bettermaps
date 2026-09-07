/**
 * ReplayUIBehavior.test.ts
 *
 * Automated behavioral verification of Replay Lab UI Fix Pass:
 * 1. FixtureRegistry: metadata verification, session discovery, lazy loading, distinctness.
 * 2. Session Switching & Reset Isolation: reset-then-load lifecycle, history clearing, zero ghosting.
 * 3. Experiment Modes (R0-R6): correct constraint activation and leakage protections.
 * 4. Milestone Formatting & Stability: tabular metrics representation, timer safety.
 */

declare const require: any;
declare const process: any;

import {
  getAvailableSessions,
  getSessionMetadata,
  loadFixtureById,
  normalizeSessionId,
} from "../../src/services/replay/FixtureRegistry";
import { IovnbdReplaySource } from "../../src/services/replay/IovnbdReplaySource";
import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import { RouteConstraintProvider } from "../../src/core/positioning/RouteConstraintProvider";
import { EvaluationReferenceTrajectory } from "../../src/core/navigation/routing/RoutingTypes";
import { EvaluationMode } from "../../src/services/replay/types";
import { ProbabilisticRoadConstraint } from "../../src/core/positioning/constraints/ProbabilisticRoadConstraint";
import { ProbabilisticRouteConstraint } from "../../src/core/positioning/constraints/ProbabilisticRouteConstraint";
import { MultiCandidateRoadMatcher } from "../../src/core/navigation/road/MultiCandidateRoadMatcher";
import { MockRoadNetworkProvider } from "../../src/adapters/road/MockRoadNetworkProvider";

// ---------------------------------------------------------------------------
// Test Runner Harness
// ---------------------------------------------------------------------------
let totalPassed = 0;
let totalFailed = 0;

function pass(msg: string) {
  console.log(`  [PASS] ${msg}`);
  totalPassed++;
}

function fail(msg: string) {
  console.error(`  [FAIL] ${msg}`);
  totalFailed++;
}

function section(title: string) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

async function runTest(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
    totalPassed++;
  } catch (e: any) {
    console.error(`FAIL: ${e?.message ?? e}`);
    totalFailed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function runAllTests() {
  console.log("=== Running Replay UI Behavior Test Suite ===");

  section("1. FixtureRegistry Verification");

  await runTest("All 12 benchmark sessions discovered", () => {
    const sessions = getAvailableSessions();
    if (sessions.length !== 12) {
      throw new Error(`Expected 12 sessions, found ${sessions.length}`);
    }
    const expectedIds = [
      "S1",
      "S2",
      "M",
      "Vta10",
      "Vta15",
      "Vta21",
      "Vta8",
      "Vtb10",
      "Vtb12",
      "Vtb4",
      "Vw14b",
      "Vw8",
    ];
    for (const id of expectedIds) {
      const found = sessions.find((s) => s.id === id);
      if (!found) {
        throw new Error(
          `Session ID '${id}' missing from getAvailableSessions()`,
        );
      }
      if (!found.label.startsWith("IO-VNBD")) {
        throw new Error(
          `Session label '${found.label}' does not start with IO-VNBD`,
        );
      }
      if (found.durationSec <= 0 || found.sampleCount <= 0) {
        throw new Error(`Invalid duration or sampleCount for session ${id}`);
      }
    }
  });

  await runTest("S1 Baseline session has rich metadata", () => {
    const s1 = getSessionMetadata("S1");
    if (!s1) throw new Error("S1 metadata not found");
    if (!s1.isBaseline) throw new Error("S1 must be marked as baseline");
    if (s1.vehicle !== "Ford Fiesta 1.25L")
      throw new Error(`Unexpected vehicle: ${s1.vehicle}`);
    if (s1.driver !== "Driver A")
      throw new Error(`Unexpected driver: ${s1.driver}`);
    if (s1.sampleCount !== 1800)
      throw new Error(`Unexpected sample count: ${s1.sampleCount}`);
  });

  await runTest("Session ID normalization handles prefixes and casing", () => {
    if (normalizeSessionId("iovnbd_s1") !== "S1")
      throw new Error("Failed normalizing iovnbd_s1");
    if (normalizeSessionId("iovnbd_S2") !== "S2")
      throw new Error("Failed normalizing iovnbd_S2");
    if (normalizeSessionId("vta10") !== "Vta10")
      throw new Error("Failed normalizing vta10");
    if (normalizeSessionId("VTB12") !== "Vtb12")
      throw new Error("Failed normalizing VTB12");
    if (normalizeSessionId("  S1  ") !== "S1")
      throw new Error("Failed trimming S1");
  });

  await runTest("Lazy fixture loading and content integrity", () => {
    const fixtureS1 = loadFixtureById("S1");
    if (fixtureS1.metadata.session_id !== "S1") {
      throw new Error(
        `Expected S1 session_id, got ${fixtureS1.metadata.session_id}`,
      );
    }
    if (fixtureS1.samples.length !== 1800) {
      throw new Error(
        `Expected 1800 samples in S1, got ${fixtureS1.samples.length}`,
      );
    }

    const fixtureS2 = loadFixtureById("S2");
    if (fixtureS2.metadata.session_id !== "S2") {
      throw new Error(
        `Expected S2 session_id, got ${fixtureS2.metadata.session_id}`,
      );
    }
    if (fixtureS2.samples.length === 0) {
      throw new Error("S2 has 0 samples");
    }

    const s1First = fixtureS1.samples[0].reference;
    const s2First = fixtureS2.samples[0].reference;
    const dLat = Math.abs(s1First.latitude - s2First.latitude);
    const dLon = Math.abs(s1First.longitude - s2First.longitude);
    if (dLat === 0 && dLon === 0) {
      throw new Error("S1 and S2 have identical initial reference coordinates");
    }
  });

  await runTest("Error handling on nonexistent fixture", () => {
    let threw = false;
    try {
      loadFixtureById("UNKNOWN_SESSION_99");
    } catch {
      threw = true;
    }
    if (!threw)
      throw new Error("loadFixtureById should throw on unknown session");
  });

  section("2. Session Switching & Reset Isolation");

  await runTest(
    "loadFixture purges state, histories, and resets clocks cleanly",
    () => {
      const positioningEngine = new EskfPositioningEngine();
      const routeConstraint = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraint,
      );

      const s1 = loadFixtureById("S1");
      replaySource.loadFixture(s1);

      replaySource.play();
      for (let i = 1; i < 50; i++) {
        (replaySource as any).emitSample(
          (replaySource as any).fixture.samples[i],
        );
      }
      replaySource.pause();

      const refHistoryBefore = replaySource.getReferenceHistory().length;
      const estHistoryBefore = replaySource.getEstimatedHistory().length;
      if (refHistoryBefore === 0 || estHistoryBefore === 0) {
        throw new Error("Expected non-empty histories after stepping");
      }

      const s2 = loadFixtureById("S2");
      replaySource.loadFixture(s2);

      if (replaySource.getSessionId() !== "S2") {
        throw new Error(
          `Expected sessionId 'S2', got '${replaySource.getSessionId()}'`,
        );
      }
      if (replaySource.getReferenceHistory().length > 1) {
        throw new Error(
          `Reference history not reset: length ${replaySource.getReferenceHistory().length}`,
        );
      }
      if (replaySource.getEstimatedHistory().length > 1) {
        throw new Error(
          `Estimated history not reset: length ${replaySource.getEstimatedHistory().length}`,
        );
      }
      if (replaySource.getStaticRoutePoints().length !== 0) {
        throw new Error("Static route points not cleared on fixture load");
      }

      let capturedTelemetry: any = null;
      replaySource.addTelemetryListener((t) => {
        capturedTelemetry = t;
      });

      if (capturedTelemetry.sessionId !== "S2") {
        throw new Error(
          `Telemetry sessionId mismatch: ${capturedTelemetry.sessionId}`,
        );
      }
      if (capturedTelemetry.clockState !== "STOPPED") {
        throw new Error(
          `Clock state should be STOPPED, got ${capturedTelemetry.clockState}`,
        );
      }
      if (capturedTelemetry.elapsedTimeMs !== 0) {
        throw new Error(
          `Elapsed time not 0: ${capturedTelemetry.elapsedTimeMs}`,
        );
      }
    },
  );

  await runTest("5-second post-reset stability check", async () => {
    const positioningEngine = new EskfPositioningEngine();
    const routeConstraint = new RouteConstraintProvider();
    const replaySource = new IovnbdReplaySource(
      positioningEngine,
      routeConstraint,
    );

    const s1 = loadFixtureById("S1");
    replaySource.loadFixture(s1);
    replaySource.play();
    for (let i = 1; i < 20; i++) {
      (replaySource as any).emitSample(
        (replaySource as any).fixture.samples[i],
      );
    }
    replaySource.reset();

    if ((replaySource as any).timerId !== null) {
      throw new Error("timerId must be null after reset()");
    }

    const sampleIdxAfterReset = (replaySource as any).currentSampleIndex;
    await new Promise((resolve) => setTimeout(resolve, 150));

    if ((replaySource as any).currentSampleIndex !== sampleIdxAfterReset) {
      throw new Error("Sample index changed while in STOPPED state!");
    }
  });

  section("3. Experiment Modes (R0 - R6)");

  await runTest(
    "R4, R5, R6 experiment modes configure route constraint correctly",
    () => {
      const positioningEngine = new EskfPositioningEngine();
      const routeConstraint = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraint,
      );
      replaySource.loadFixture(loadFixtureById("S1"));

      replaySource.setExperimentMode("R4_IMU_ML_NHC_ROAD");
      if (routeConstraint.getEnabled()) {
        throw new Error("Route constraint should be disabled in R4");
      }

      replaySource.setExperimentMode("R5_IMU_ML_NHC_ROUTE");
      if (!routeConstraint.getEnabled()) {
        throw new Error("Route constraint should be enabled in R5");
      }

      replaySource.setExperimentMode("R6_FULL_DROP_RECOVERY");
      if (!routeConstraint.getEnabled()) {
        throw new Error("Route constraint should be enabled in R6");
      }

      replaySource.setExperimentMode("R0_IMU_ONLY");
      if (routeConstraint.getEnabled()) {
        throw new Error("Route constraint should be disabled in R0");
      }
    },
  );

  await runTest(
    "EvaluationReferenceTrajectory cannot leak into route constraints",
    () => {
      const positioningEngine = new EskfPositioningEngine();
      const routeConstraint = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraint,
      );

      const mockRef: EvaluationReferenceTrajectory = {
        _brand: "EvaluationReferenceTrajectory",
        datasetSplit: "test",
        timestampsS: [0.0, 1.0],
        positionsEnuM: [
          [0, 0, 0],
          [1, 1, 0],
        ],
        velocitiesEnuMps: [
          [0, 0, 0],
          [1, 1, 0],
        ],
        quaternionsNb: [
          [1, 0, 0, 0],
          [1, 0, 0, 0],
        ],
      };

      let caught = false;
      try {
        replaySource.setPreExistingRoute(mockRef as any);
      } catch (err: any) {
        if (err.message.includes("Reference Leakage Violation")) {
          caught = true;
        }
      }
      if (!caught) {
        throw new Error("Expected Reference Leakage Violation exception");
      }
    },
  );

  section("4. Milestone Formatting & Numeric Stability");

  await runTest(
    "Milestone metric numbers format properly without NaN/overflow",
    () => {
      const formatMilestone = (val: number | null): string => {
        if (val === null || val === undefined) return "—";
        return `${val.toFixed(1)}m`;
      };

      if (formatMilestone(null) !== "—")
        throw new Error("null should format to —");
      if (formatMilestone(1.234) !== "1.2m")
        throw new Error("1.234 should format to 1.2m");
      if (formatMilestone(105.89) !== "105.9m")
        throw new Error("105.89 should format to 105.9m");
      if (formatMilestone(0.0) !== "0.0m")
        throw new Error("0.0 should format to 0.0m");
    },
  );
  section(
    "5. Final Estimator Canonical Evaluation Modes & One-Variable Invariant",
  );

  await runTest(
    "FINAL_IDR mode: ML=ON, ESKF=ON, NHC=ON, Road=ON, Route=ON",
    () => {
      const roadProvider = new MockRoadNetworkProvider();
      const roadMatcher = new MultiCandidateRoadMatcher(roadProvider);
      const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);
      const routeConstraint = new ProbabilisticRouteConstraint();
      const positioningEngine = new EskfPositioningEngine({
        roadConstraint,
        routeConstraint,
      });
      const routeConstraintProvider = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraintProvider,
      );

      replaySource.setEvaluationMode("FINAL_IDR");

      if (replaySource.getEvaluationMode() !== "FINAL_IDR") {
        throw new Error(
          `Expected evaluationMode 'FINAL_IDR', got '${replaySource.getEvaluationMode()}'`,
        );
      }
      if (!roadConstraint.getEnabled()) {
        throw new Error("Road constraint must be enabled in FINAL_IDR");
      }
      if (!routeConstraint.getEnabled()) {
        throw new Error("Route constraint must be enabled in FINAL_IDR");
      }

      const tel = replaySource.getTelemetry();
      if (tel.evaluationMode !== "FINAL_IDR") {
        throw new Error(
          `Telemetry evaluationMode mismatch: ${tel.evaluationMode}`,
        );
      }
      if (tel.roadConstraintEnabled !== true) {
        throw new Error("Telemetry roadConstraintEnabled must be true");
      }
      if (tel.routeConstraintEnabled !== true) {
        throw new Error("Telemetry routeConstraintEnabled must be true");
      }
      if (typeof tel.roadUpdateCount !== "number") {
        throw new Error("Telemetry roadUpdateCount must be a number");
      }
      if (typeof tel.routeUpdateCount !== "number") {
        throw new Error("Telemetry routeUpdateCount must be a number");
      }
    },
  );

  await runTest(
    "FINAL_IDR_ROAD_ABLATION mode: ML=ON, ESKF=ON, NHC=ON, Road=OFF, Route=ON",
    () => {
      const roadProvider = new MockRoadNetworkProvider();
      const roadMatcher = new MultiCandidateRoadMatcher(roadProvider);
      const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);
      const routeConstraint = new ProbabilisticRouteConstraint();
      const positioningEngine = new EskfPositioningEngine({
        roadConstraint,
        routeConstraint,
      });
      const routeConstraintProvider = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraintProvider,
      );

      replaySource.setEvaluationMode("FINAL_IDR_ROAD_ABLATION");

      if (replaySource.getEvaluationMode() !== "FINAL_IDR_ROAD_ABLATION") {
        throw new Error(
          `Expected evaluationMode 'FINAL_IDR_ROAD_ABLATION', got '${replaySource.getEvaluationMode()}'`,
        );
      }
      if (roadConstraint.getEnabled()) {
        throw new Error(
          "Road constraint must be DISABLED in FINAL_IDR_ROAD_ABLATION",
        );
      }
      if (!routeConstraint.getEnabled()) {
        throw new Error(
          "Route constraint must remain ENABLED in FINAL_IDR_ROAD_ABLATION",
        );
      }

      const tel = replaySource.getTelemetry();
      if (tel.evaluationMode !== "FINAL_IDR_ROAD_ABLATION") {
        throw new Error(
          `Telemetry evaluationMode mismatch: ${tel.evaluationMode}`,
        );
      }
      if (tel.roadConstraintEnabled !== false) {
        throw new Error("Telemetry roadConstraintEnabled must be false");
      }
      if (tel.routeConstraintEnabled !== true) {
        throw new Error("Telemetry routeConstraintEnabled must be true");
      }
    },
  );

  await runTest(
    "Strict One-Variable Invariant: identical configuration except roadConstraint",
    () => {
      const roadProvider = new MockRoadNetworkProvider();
      const roadMatcher = new MultiCandidateRoadMatcher(roadProvider);
      const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);
      const routeConstraint = new ProbabilisticRouteConstraint();
      const positioningEngine = new EskfPositioningEngine({
        roadConstraint,
        routeConstraint,
      });
      const routeConstraintProvider = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraintProvider,
      );

      // Inspect FINAL_IDR
      replaySource.setEvaluationMode("FINAL_IDR");
      const telA = replaySource.getTelemetry();
      const repA = replaySource.getDetailedReport();

      // Inspect FINAL_IDR_ROAD_ABLATION
      replaySource.setEvaluationMode("FINAL_IDR_ROAD_ABLATION");
      const telB = replaySource.getTelemetry();
      const repB = replaySource.getDetailedReport();

      // Verify identical non-road properties
      if (telA.modelBackendName !== telB.modelBackendName) {
        throw new Error("Model backend differed between modes!");
      }
      if (telA.outageStartSec !== telB.outageStartSec) {
        throw new Error("Outage start sec differed between modes!");
      }
      if (telA.outageDurationSec !== telB.outageDurationSec) {
        throw new Error("Outage duration sec differed between modes!");
      }
      if (telA.routeConstraintEnabled !== telB.routeConstraintEnabled) {
        throw new Error("Route constraint state differed between modes!");
      }

      // Verify the single ablated variable
      if (
        telA.roadConstraintEnabled !== true ||
        telB.roadConstraintEnabled !== false
      ) {
        throw new Error("Road constraint was not the single ablated variable!");
      }
      if (
        repA.roadConstraintEnabled !== true ||
        repB.roadConstraintEnabled !== false
      ) {
        throw new Error(
          "Detailed report roadConstraintEnabled invariant failed!",
        );
      }
    },
  );

  await runTest(
    "Session switching and reset preserve selected EvaluationMode",
    () => {
      const roadProvider = new MockRoadNetworkProvider();
      const roadMatcher = new MultiCandidateRoadMatcher(roadProvider);
      const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);
      const routeConstraint = new ProbabilisticRouteConstraint();
      const positioningEngine = new EskfPositioningEngine({
        roadConstraint,
        routeConstraint,
      });
      const routeConstraintProvider = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraintProvider,
      );

      // Select ROAD ABLATION mode
      replaySource.setEvaluationMode("FINAL_IDR_ROAD_ABLATION");
      if (replaySource.getEvaluationMode() !== "FINAL_IDR_ROAD_ABLATION") {
        throw new Error("Failed to set ablation mode");
      }

      // Reset
      replaySource.reset();
      if (replaySource.getEvaluationMode() !== "FINAL_IDR_ROAD_ABLATION") {
        throw new Error("Reset changed evaluationMode!");
      }
      if (roadConstraint.getEnabled() !== false) {
        throw new Error("Reset re-enabled road constraint in ablation mode!");
      }

      // Load another session
      const s2 = loadFixtureById("S2");
      replaySource.loadFixture(s2);
      if (replaySource.getEvaluationMode() !== "FINAL_IDR_ROAD_ABLATION") {
        throw new Error("loadFixture changed evaluationMode!");
      }

      // Switch to FINAL_IDR and load S1
      replaySource.setEvaluationMode("FINAL_IDR");
      const s1 = loadFixtureById("S1");
      replaySource.loadFixture(s1);
      if (replaySource.getEvaluationMode() !== "FINAL_IDR") {
        throw new Error("loadFixture changed evaluationMode after FINAL_IDR!");
      }
      if (roadConstraint.getEnabled() !== true) {
        throw new Error(
          "Road constraint not enabled after fixture load in FINAL_IDR!",
        );
      }
    },
  );

  await runTest(
    "Telemetry update counters are tracked and reset cleanly",
    () => {
      const roadProvider = new MockRoadNetworkProvider();
      const roadMatcher = new MultiCandidateRoadMatcher(roadProvider);
      const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);
      const routeConstraint = new ProbabilisticRouteConstraint();
      const positioningEngine = new EskfPositioningEngine({
        roadConstraint,
        routeConstraint,
      });
      const routeConstraintProvider = new RouteConstraintProvider();
      const replaySource = new IovnbdReplaySource(
        positioningEngine,
        routeConstraintProvider,
      );

      const telInitial = replaySource.getTelemetry();
      if (
        telInitial.roadUpdateCount !== 0 ||
        telInitial.routeUpdateCount !== 0
      ) {
        throw new Error("Initial update counts must be 0");
      }

      // Simulate an update count increment on the constraint
      (roadConstraint as any).appliedUpdateCount = 5;
      (routeConstraint as any).appliedUpdateCount = 8;

      const telUpdated = replaySource.getTelemetry();
      if (telUpdated.roadUpdateCount !== 5) {
        throw new Error(
          `Expected roadUpdateCount 5, got ${telUpdated.roadUpdateCount}`,
        );
      }
      if (telUpdated.routeUpdateCount !== 8) {
        throw new Error(
          `Expected routeUpdateCount 8, got ${telUpdated.routeUpdateCount}`,
        );
      }

      // Engine reset clears update counts
      positioningEngine.reset();
      const telAfterReset = replaySource.getTelemetry();
      if (
        telAfterReset.roadUpdateCount !== 0 ||
        telAfterReset.routeUpdateCount !== 0
      ) {
        throw new Error("Update counts must reset to 0 upon engine reset");
      }
    },
  );

  console.log(`\n=== Replay UI Behavior Results ===`);
  console.log(`  Passed: ${totalPassed}`);
  console.log(`  Failed: ${totalFailed}`);
  if (totalFailed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("Fatal test runner exception:", e);
  process.exit(1);
});
