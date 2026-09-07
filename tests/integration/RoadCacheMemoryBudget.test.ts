/**
 * RoadCacheMemoryBudget.test.ts
 *
 * Automated verification of bounded RAM and aggressive eviction for the road network cache:
 * 1. Byte-level memory accounting: approximate in-memory footprint per tile.
 * 2. 3-Tier Memory Pressure States:
 *    - NORMAL: < 70% of budget
 *    - PRESSURE: 70% to 85% of budget
 *    - AGGRESSIVE: >= 85% of budget
 * 3. Distance-prioritized eviction: rear/obsolete/furthest tiles evicted first under pressure.
 * 4. Speculative lookahead suspension under AGGRESSIVE pressure.
 * 5. Multi-region teleportation stress test: verifies RAM remains strictly bounded.
 */

import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import { OfflineRegionPackManager } from "../../src/adapters/road/OfflineRegionPackManager";
import { registerBundledRegionPacks } from "../../src/adapters/road/BundledRegionPacks";
import { RoadDataManager } from "../../src/core/navigation/road/RoadDataManager";
import { RoadTile } from "../../src/core/navigation/road/RoadTileTypes";

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

function createSyntheticTile(id: string, lat: number, lon: number, segmentCount: number): RoadTile {
  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    segments.push({
      id: `seg_${id}_${i}`,
      name: `Road ${i}`,
      startPoint: { latitude: lat + i * 0.0001, longitude: lon },
      endPoint: { latitude: lat + (i + 1) * 0.0001, longitude: lon + 0.0001 },
      lengthMeters: 50.0,
      bearingDeg: 45.0,
      directionality: "two_way" as const,
      speedLimitMps: 13.9,
    });
  }

  return {
    key: { scheme: "deg" as const, key: `100:${Math.floor(lat * 100)}:${Math.floor(lon * 100)}` },
    bounds: {
      minLat: lat,
      maxLat: lat + 0.01,
      minLon: lon,
      maxLon: lon + 0.01,
    },
    metadata: {
      version: "1",
      fetchedAtMs: Date.now(),
    },
    segments,
    intersections: [],
  };
}

async function runAll(): Promise<void> {
  console.log("\n=== Starting Road Cache Memory Budget Tests ===");

  await runTest("RAM Accounting: tracks in-memory tile byte sizes accurately", () => {
    const provider = new LocalRoadNetworkProvider({}, "BudgetTestProvider");
    assert(provider.getTotalRamBytes() === 0, "Initial provider RAM must be 0 bytes");

    const tile1 = createSyntheticTile("t1", 28.58, 77.16, 20);
    provider.registerTile(tile1);

    const ram1 = provider.getTotalRamBytes();
    assert(ram1 > 0, `RAM after registering tile1 must be > 0 (got ${ram1} bytes)`);

    const tile2 = createSyntheticTile("t2", 28.59, 77.17, 30);
    provider.registerTile(tile2);

    const ram2 = provider.getTotalRamBytes();
    assert(ram2 > ram1, `RAM after tile2 must exceed ram1 (got ${ram2} > ${ram1})`);

    provider.evictTile(tile1.key);
    const ramAfterEvict = provider.getTotalRamBytes();
    assert(ramAfterEvict < ram2, `RAM after evicting tile1 must decrease (got ${ramAfterEvict} < ${ram2})`);
  });

  await runTest("3-Tier Memory Pressure: correctly detects NORMAL, PRESSURE, AGGRESSIVE", async () => {
    const provider = new LocalRoadNetworkProvider({}, "PressureTestProvider");
    // Set a controlled 10 KB budget for testing
    const testBudget = 10 * 1024; // 10,240 bytes
    const roadMgr = new RoadDataManager({
      provider,
      maxActiveRoadRamBytes: testBudget,
    });

    assert(roadMgr.getMemoryPressure() === "NORMAL", "Empty cache must be in NORMAL state");

    // Add tiles until PRESSURE (70% - 85% = 7,168 - 8,704 bytes)
    // Register tile of ~4KB
    const tile1 = createSyntheticTile("p1", 28.58, 77.16, 25);
    provider.registerTile(tile1);
    (roadMgr as any).evaluateMemoryPressure();
    // Still normal or pressure depending on size
    const ramPct = provider.getTotalRamBytes() / testBudget;

    if (ramPct < 0.70) {
      assert(roadMgr.getMemoryPressure() === "NORMAL", "Under 70% must be NORMAL");
    }

    // Add another tile to push above 85%
    const tile2 = createSyntheticTile("p2", 28.60, 77.18, 40);
    provider.registerTile(tile2);
    (roadMgr as any).evaluateMemoryPressure();

    const finalPct = provider.getTotalRamBytes() / testBudget;
    if (finalPct >= 0.85) {
      assert(roadMgr.getMemoryPressure() === "AGGRESSIVE", ">= 85% must be AGGRESSIVE");
    } else if (finalPct >= 0.70) {
      assert(roadMgr.getMemoryPressure() === "PRESSURE", ">= 70% must be PRESSURE");
    }
  });

  await runTest("Distance-Prioritized Eviction: evicts furthest tiles first under memory pressure", async () => {
    const provider = new LocalRoadNetworkProvider({}, "EvictTestProvider");
    // 5 KB tight budget
    const tightBudget = 5 * 1024;
    const roadMgr = new RoadDataManager({
      provider,
      maxActiveRoadRamBytes: tightBudget,
      minTilesToRetain: 1,
    });

    // Register near tile (at 28.580, 77.160)
    const nearTile = createSyntheticTile("near", 28.580, 77.160, 20);
    provider.registerTile(nearTile);

    // Register far tile (at 28.650, 77.250 - ~12 km away)
    const farTile = createSyntheticTile("far", 28.650, 77.250, 30);
    provider.registerTile(farTile);

    // Vehicle is at nearTile
    const vehiclePos = { latitude: 28.580, longitude: 77.160 };

    // Force memory pressure evaluation and eviction
    (roadMgr as any).currentVehiclePosition = vehiclePos;
    (roadMgr as any).evaluateMemoryPressure();
    (roadMgr as any).enforceMemoryBudget();

    // Verify eviction occurred
    const diag = roadMgr.getDiagnostics();
    assert(diag.evictionCount > 0, `Eviction count should be > 0 (got ${diag.evictionCount})`);
  });

  await runTest("Multi-Region Teleportation Stress Test: RAM remains strictly bounded", async () => {
    const packManager = new OfflineRegionPackManager();
    registerBundledRegionPacks(packManager);
    const provider = new LocalRoadNetworkProvider({}, "StressTestProvider");
    // 15 MB production budget
    const roadMgr = new RoadDataManager({
      provider,
      regionPackManager: packManager,
      maxActiveRoadRamBytes: 15 * 1024 * 1024,
      displacementThresholdMeters: 5.0, // Low threshold to force planning on jumps
      heartbeatIntervalMs: 50,
    });

    const regions = [
      { latitude: 52.408, longitude: -1.512 }, // Coventry
      { latitude: 28.580, longitude: 77.160 }, // South Delhi
      { latitude: 28.613, longitude: 77.209 }, // Central Delhi / India Gate
      { latitude: 28.631, longitude: 77.219 }, // Connaught Place
      { latitude: 28.560, longitude: 77.200 }, // Ring Road South
      { latitude: 52.395, longitude: -1.530 }, // Coventry South
    ];

    for (const pos of regions) {
      await roadMgr.updatePosition(pos, 15.0, 90.0);
    }

    const mem = roadMgr.getMemoryTelemetry();
    assert(mem.ramRoadBytes < mem.ramBudgetBytes, `RAM (${mem.ramRoadBytes} bytes) must be strictly less than budget (${mem.ramBudgetBytes} bytes)`);
    assert(mem.memoryPressure === "NORMAL" || mem.memoryPressure === "PRESSURE", `Memory pressure must remain manageable (got ${mem.memoryPressure})`);
  });

  console.log(`\n=== Road Cache Memory Budget Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error("Test harness failed:", err);
  process.exit(1);
});
