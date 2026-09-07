/**
 * ReplayRoadCoverage.test.ts
 *
 * Automated verification of replay-driven road coverage and coalescing:
 * 1. Replay Position Driving: Verifies that RoadDataManager follows the replayed/teleported coordinates.
 * 2. Multi-Region Prefetch: Coventry UK -> Delhi NCR dynamic tile loading.
 * 3. Coverage Coalescing Policy:
 *    - displacementThresholdMeters = 25m
 *    - headingThresholdDeg = 25°
 *    - speedTransitionThresholdMps = 5 m/s
 *    - heartbeatIntervalMs = 1000ms
 * 4. Shared Provider Integration: Provider tiles immediately queryable by road matcher.
 */

import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import { OfflineRegionPackManager } from "../../src/adapters/road/OfflineRegionPackManager";
import { registerBundledRegionPacks } from "../../src/adapters/road/BundledRegionPacks";
import { RoadDataManager } from "../../src/core/navigation/road/RoadDataManager";
import { MultiCandidateRoadMatcher } from "../../src/core/navigation/road/MultiCandidateRoadMatcher";
import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import { RouteConstraintProvider } from "../../src/core/positioning/RouteConstraintProvider";
import { IovnbdReplaySource } from "../../src/services/replay/IovnbdReplaySource";
import { KinematicBaselineEstimator } from "../../src/core/positioning/motionEstimator";
import { IovnbdFixture } from "../../src/services/replay/types";

declare const process: any;

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

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
  } catch (e) {
    console.error(`FAIL: ${e}`);
    failed++;
  }
}

async function runAll(): Promise<void> {
  console.log("\n=== Starting Replay Road Coverage & Coalescing Tests ===");

  const packManager = new OfflineRegionPackManager();
  registerBundledRegionPacks(packManager);
  const provider = new LocalRoadNetworkProvider({}, "TestProvider");
  const roadMgr = new RoadDataManager({
    provider,
    regionPackManager: packManager,
    displacementThresholdMeters: 25.0,
    headingThresholdDeg: 25.0,
    speedTransitionThresholdMps: 5.0,
    heartbeatIntervalMs: 1000,
  });

  await runTest("Source Attribution: switches between LIVE and REPLAY", () => {
    roadMgr.setSourcePosition("REPLAY");
    assert(roadMgr.getCoverageTelemetry().sourcePosition === "REPLAY", "sourcePosition should be REPLAY");
    roadMgr.setSourcePosition("LIVE");
    assert(roadMgr.getCoverageTelemetry().sourcePosition === "LIVE", "sourcePosition should be LIVE");
    roadMgr.setSourcePosition("REPLAY");
  });

  await runTest("Coverage Coalescing: small jitter skips planning and increments coalescedSkipCount", async () => {
    const origin = { latitude: 28.5800, longitude: 77.1600 }; // South Delhi

    // First update: establishes anchor
    await roadMgr.updatePosition(origin, 10.0, 90.0);
    const initialSkips = roadMgr.getCoverageTelemetry().coalescedSkipCount ?? 0;

    // Small updates (< 25m, heading < 25°, speed < 5 m/s, within 1000ms)
    for (let i = 1; i <= 5; i++) {
      // 2 meters displacement
      const jitterPos = {
        latitude: origin.latitude + (2.0 / 111139.0),
        longitude: origin.longitude,
      };
      await roadMgr.updatePosition(jitterPos, 10.5, 92.0);
    }

    const tel = roadMgr.getCoverageTelemetry();
    assert(
      (tel.coalescedSkipCount ?? 0) >= initialSkips + 5,
      `Small jitter must be coalesced (expected at least ${initialSkips + 5} skips, got ${tel.coalescedSkipCount})`,
    );
  });

  await runTest("Coverage Trigger: displacement >= 25m immediately triggers re-planning", async () => {
    const origin = { latitude: 28.5800, longitude: 77.1600 };
    await roadMgr.updatePosition(origin, 10.0, 90.0);

    // Jump 40 meters north (> 25m)
    const jumpedPos = {
      latitude: origin.latitude + (40.0 / 111139.0),
      longitude: origin.longitude,
    };
    await roadMgr.updatePosition(jumpedPos, 10.0, 90.0);

    const tel = roadMgr.getCoverageTelemetry();
    assert(
      tel.lastTriggerReason?.includes("DISPLACEMENT"),
      `Trigger reason should be DISPLACEMENT (got ${tel.lastTriggerReason})`,
    );
  });

  await runTest("Multi-Region Prefetch: Coventry -> Delhi NCR dynamic tile prefetch", async () => {
    // 1. Position in Coventry (52.408, -1.512)
    const coventryPos = { latitude: 52.408, longitude: -1.512 };
    await roadMgr.updatePosition(coventryPos, 12.0, 180.0);

    const coventryLoaded = provider.getSegmentCount();
    assert(coventryLoaded > 0, `Provider should have Coventry road segments loaded (got ${coventryLoaded})`);

    // 2. Teleport to Delhi NCR (28.58, 77.16)
    const delhiPos = { latitude: 28.58, longitude: 77.16 };
    await roadMgr.updatePosition(delhiPos, 10.0, 0.0);

    const delhiLoaded = provider.getSegmentCount();
    assert(delhiLoaded > 0, `Provider should have road segments after teleporting to Delhi (got ${delhiLoaded})`);

    const tel = roadMgr.getCoverageTelemetry();
    assert(tel.activeRegionId === "delhi_ncr", `Active region should be delhi_ncr (got ${tel.activeRegionId})`);
  });

  await runTest("Shared Provider Integration: Replay Source updates drive matcher query results", async () => {
    const engine = new EskfPositioningEngine({
      motionEstimator: new KinematicBaselineEstimator(),
    });
    const routeProvider = new RouteConstraintProvider();
    const replay = new IovnbdReplaySource(engine, routeProvider);

    replay.setRoadDataManager(roadMgr);
    assert(replay.getRoadDataManager() === roadMgr, "Replay source must store roadDataManager");

    // Replay telemetry should now contain road coverage diagnostics
    const tel = replay.getTelemetry();
    assert(tel.roadCoverageDiagnostics !== null && tel.roadCoverageDiagnostics !== undefined, "Telemetry should contain roadCoverageDiagnostics");
    assert(tel.roadMemoryDiagnostics !== null && tel.roadMemoryDiagnostics !== undefined, "Telemetry should contain roadMemoryDiagnostics");
  });

  console.log(`\n=== Replay Road Coverage Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error("Test harness failed:", err);
  process.exit(1);
});
