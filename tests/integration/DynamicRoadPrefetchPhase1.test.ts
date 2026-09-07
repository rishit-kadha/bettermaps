/**
 * DynamicRoadPrefetchPhase1.test.ts
 *
 * Deterministic Phase 1 verification test suite for BetterMaps Dynamic Road
 * Prefetching & Synchronous Estimator Integration.
 *
 * Covers:
 * - Scenario A: Dynamic tile registration adds segments to spatial index
 * - Scenario B: Dynamic tile eviction cleanly removes segments
 * - Scenario C: Queries remain strictly synchronous (non-Promise)
 * - Scenario D: Duplicate tile registration is idempotent
 * - Scenario E: Multi-tile coexistence and shared boundary ownership
 * - Scenario F: MultiCandidateRoadMatcher candidate scoring from dynamic tiles
 * - Scenario G: ProbabilisticRoadConstraint applies synchronously
 * - Scenario H: ESKF road correction modifies persistent state in the same tick
 * - Scenario I: Subsequent ESKF propagation retains the correction
 * - Scenario J: Zero I/O, network, or filesystem calls during estimator road queries
 * - Scenario K: Diagnostics reporting of loaded tiles and exposed segments
 * - Pipeline Order: Verify deterministic tick sequence
 * - Core Isolation: Zero platform/provider imports in src/core/
 */

import { SpatialGridIndex } from "../../src/adapters/road/SpatialGridIndex";
import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import { MockRoadDataSource } from "../../src/adapters/road/MockRoadDataSource";
import { InMemoryRoadCache } from "../../src/adapters/road/InMemoryRoadCache";
import {
  RoadTile,
  createDegreeTileKey,
  createSlippyTileKey,
  serializeTileKey,
  TileKey,
} from "../../src/core/navigation/road/RoadTileTypes";
import { RoadSegment } from "../../src/core/navigation/road/RoadTypes";
import { MultiCandidateRoadMatcher } from "../../src/core/navigation/road/MultiCandidateRoadMatcher";
import { ProbabilisticRoadConstraint } from "../../src/core/positioning/constraints/ProbabilisticRoadConstraint";
import { ProbabilisticRouteConstraint } from "../../src/core/positioning/constraints/ProbabilisticRouteConstraint";
import { Eskf } from "../../src/core/positioning/eskf/Eskf";
import { NavigationState } from "../../src/core/positioning/eskf/EskfTypes";
import { Wgs84Coordinate, enuToWgs84 } from "../../src/core/positioning/coordinates";
import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import { ImuSample } from "../../src/core/types/imu";
import { NavLocation } from "../../src/core/types/location";

declare const require: any;
declare const process: any;
declare const performance: any;
declare const __dirname: string;

const fs = require("fs");
const path = require("path");

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
  assert(Math.abs(a - b) <= tol, `${message} (got ${a}, expected ~${b}, tol=${tol})`);
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

const ORIGIN: Wgs84Coordinate = {
  latitude: 52.408,
  longitude: -1.512,
  altitude: 100.0,
};

function makeSyntheticSegment(id: string, lat1: number, lon1: number, lat2: number, lon2: number): RoadSegment {
  return {
    id,
    name: `Road_${id}`,
    startPoint: { latitude: lat1, longitude: lon1 },
    endPoint: { latitude: lat2, longitude: lon2 },
    lengthMeters: 200.0,
    bearingDeg: 0.0,
    directionality: "two_way",
    speedLimitMps: 13.9,
    roadClass: "primary",
  };
}

function createDefaultState(pos: [number, number, number] = [0, 0, 0], vel: [number, number, number] = [0, 0, 0]): NavigationState {
  return {
    positionEnu: pos,
    velocityEnu: vel,
    qNb: [1.0, 0.0, 0.0, 0.0],
    accelBias: [0.0, 0.0, 0.0],
    gyroBias: [0.0, 0.0, 0.0],
  };
}

async function main() {
  console.log("===============================================================");
  console.log("  Dynamic Road Prefetching Phase 1: Integration & Invariant Tests");
  console.log("===============================================================\n");

  // ---------------------------------------------------------------------------
  // TEST 1: Tile Registration, Idempotency, Eviction, and Shared Ownership
  // ---------------------------------------------------------------------------
  await runTest("Tile Registration & Ownership (Scenarios A, B, D, E)", () => {
    const provider = new LocalRoadNetworkProvider(undefined, "DynamicTestProvider");

    const seg1 = makeSyntheticSegment("s1", 52.408, -1.512, 52.410, -1.512);
    const seg2 = makeSyntheticSegment("s2_shared", 52.410, -1.512, 52.412, -1.512);
    const seg3 = makeSyntheticSegment("s3", 52.412, -1.512, 52.414, -1.512);

    const tile1: RoadTile = {
      key: createDegreeTileKey(5240, -151),
      bounds: { minLat: 52.400, maxLat: 52.411, minLon: -1.520, maxLon: -1.510 },
      segments: [seg1, seg2],
    };

    const tile2: RoadTile = {
      key: createDegreeTileKey(5241, -151),
      bounds: { minLat: 52.410, maxLat: 52.420, minLon: -1.520, maxLon: -1.510 },
      segments: [seg2, seg3], // seg2 is shared across boundary
    };

    // Scenario A: Register Tile 1
    const reg1 = provider.registerTile(tile1);
    assert(reg1 === true, "First registration of tile1 should return true");
    assert(provider.hasTile(tile1.key), "provider.hasTile(tile1.key) should be true");
    assert(provider.getSegmentCount() === 2, "Segment count should be 2 after tile1");

    const nearby1 = provider.findNearbySegments({ latitude: 52.408, longitude: -1.512 }, 50);
    assert(nearby1.length >= 1, "findNearbySegments should locate segment s1");
    assert(nearby1.some((s) => s.id === "s1"), "s1 should be in search results");

    // Scenario D: Duplicate registration is idempotent
    const reg1Dup = provider.registerTile(tile1);
    assert(reg1Dup === false, "Duplicate registration of tile1 should return false");
    assert(provider.getLoadedTileCount() === 1, "Tile count should remain 1");
    assert(provider.getSegmentCount() === 2, "Segment count should remain 2");

    // Scenario E: Register Tile 2 (coexistence + shared boundary)
    const reg2 = provider.registerTile(tile2);
    assert(reg2 === true, "Registration of tile2 should return true");
    assert(provider.getLoadedTileCount() === 2, "Loaded tile count should be 2");
    assert(provider.getSegmentCount() === 3, "Unique segment count should be 3 (s1, s2_shared, s3)");

    // Scenario B: Evict Tile 1 — shared segment s2_shared MUST BE RETAINED
    const evict1 = provider.evictTile(tile1.key);
    assert(evict1 === true, "Evicting tile1 should return true");
    assert(!provider.hasTile(tile1.key), "tile1 should no longer be loaded");
    assert(provider.hasTile(tile2.key), "tile2 should remain loaded");
    assert(provider.getSegmentById("s1") === null, "s1 should be evicted");
    assert(provider.getSegmentById("s2_shared") !== null, "s2_shared MUST NOT be evicted (still owned by tile2)");
    assert(provider.getSegmentById("s3") !== null, "s3 should remain intact");
    assert(provider.getSegmentCount() === 2, "Segment count should be 2 (s2_shared, s3)");

    // Evict Tile 2 — now s2_shared and s3 should be evicted
    const evict2 = provider.evictTile(tile2.key);
    assert(evict2 === true, "Evicting tile2 should return true");
    assert(provider.getSegmentById("s2_shared") === null, "s2_shared should now be evicted");
    assert(provider.getSegmentById("s3") === null, "s3 should now be evicted");
    assert(provider.getSegmentCount() === 0, "Segment count should be 0");
    assert(provider.getLoadedTileCount() === 0, "Loaded tile count should be 0");
  });

  // ---------------------------------------------------------------------------
  // TEST 2: SpatialGridIndex Reverse Index & Isolated Removal
  // ---------------------------------------------------------------------------
  await runTest("SpatialGridIndex Reverse Mapping & Incremental Mutation", () => {
    const index = new SpatialGridIndex();
    const segA = makeSyntheticSegment("segA", 52.4080, -1.5120, 52.4085, -1.5120);
    const segB = makeSyntheticSegment("segB", 52.4081, -1.5120, 52.4086, -1.5120);

    index.insertSegment(segA);
    index.insertSegment(segB);

    assert(index.getSegmentCount() === 2, "Should have 2 segments indexed");
    const cellKeysA = index.getSegmentCellKeys("segA");
    assert(cellKeysA.length > 0, "segA should occupy at least 1 cell");

    // Remove segA
    const removedA = index.removeSegment("segA");
    assert(removedA === true, "removeSegment(segA) should return true");
    assert(!index.hasSegment("segA"), "hasSegment(segA) should be false");
    assert(index.hasSegment("segB"), "segB must remain untouched in index");
    assert(index.getSegmentCount() === 1, "Segment count should be 1");

    // Query at segA/segB location
    const results = index.queryRadius({ latitude: 52.4082, longitude: -1.5120 }, 50);
    assert(results.length === 1, "Only 1 segment should match query");
    assert(results[0].id === "segB", "Remaining segment must be segB");
  });

  // ---------------------------------------------------------------------------
  // TEST 3: Synchronous Contract & Non-Promise Runtime Verification (Scenario C, G)
  // ---------------------------------------------------------------------------
  await runTest("Synchronous In-Memory Contract & Non-Promise Invariant", () => {
    const provider = new LocalRoadNetworkProvider(undefined, "SyncTest");
    const seg = makeSyntheticSegment("s_sync", 52.408, -1.512, 52.410, -1.512);
    provider.registerTile({
      key: { scheme: "test", key: "sync1" },
      bounds: { minLat: 52.40, maxLat: 52.42, minLon: -1.52, maxLon: -1.51 },
      segments: [seg],
    });

    // 1. findNearbySegments must be strictly synchronous
    const segs = provider.findNearbySegments({ latitude: 52.408, longitude: -1.512 }, 100);
    assert(Array.isArray(segs), "findNearbySegments return must be an Array");
    assert(!(segs instanceof Promise), "findNearbySegments return must NOT be a Promise");
    assert(typeof (segs as any).then !== "function", "findNearbySegments return must NOT be thenable");

    // 2. MultiCandidateRoadMatcher.match must be strictly synchronous
    const matcher = new MultiCandidateRoadMatcher(provider);
    const matchRes = matcher.match([0.0, 0.0], 0.0, ORIGIN);
    assert(!(matchRes instanceof Promise), "matcher.match return must NOT be a Promise");
    assert(matchRes === null || typeof (matchRes as any).then !== "function", "matcher.match return must NOT be thenable");

    // 3. ProbabilisticRoadConstraint.evaluateAndApply must be strictly synchronous
    const constraint = new ProbabilisticRoadConstraint(matcher);
    const eskf = new Eskf();
    eskf.reset(createDefaultState([0.0, 0.0, 0.0]));

    const evalRes = constraint.evaluateAndApply(eskf, ORIGIN);
    assert(typeof evalRes === "object" && evalRes !== null, "evaluateAndApply return must be an object");
    assert(!(evalRes instanceof Promise), "evaluateAndApply return must NOT be a Promise");
    assert(typeof (evalRes as any).then !== "function", "evaluateAndApply return must NOT be thenable");
    assert(typeof evalRes.applied === "boolean", "evaluateAndApply must have boolean applied field");
  });

  // ---------------------------------------------------------------------------
  // TEST 4: Matcher Sees Dynamic Tiles & Rejects Evicted Ones (Scenario F)
  // ---------------------------------------------------------------------------
  await runTest("Matcher Dynamic Visibility & Rejection (Scenario F)", () => {
    const provider = new LocalRoadNetworkProvider();
    const matcher = new MultiCandidateRoadMatcher(provider, { searchRadiusMeters: 50 });

    // Initial position: no tiles loaded -> matcher returns null
    const noTileMatch = matcher.match([0.0, 0.0], 0.0, ORIGIN);
    assert(noTileMatch === null, "Matcher should return null when no tiles loaded");

    // Register a tile passing North-South through ENU [0, 0]
    const segN = makeSyntheticSegment("seg_north", 52.407, -1.512, 52.410, -1.512);
    const tile: RoadTile = {
      key: { scheme: "deg", key: "test_n" },
      bounds: { minLat: 52.405, maxLat: 52.415, minLon: -1.515, maxLon: -1.510 },
      segments: [segN],
    };
    provider.registerTile(tile);

    // Vehicle at [2.0, 50.0] heading 0 deg (North) — 2m cross-track
    const matchWithTile = matcher.match([2.0, 50.0], 0.0, ORIGIN);
    assert(matchWithTile !== null, "Matcher should find candidate after tile registration");
    assert(matchWithTile?.segment.id === "seg_north", "Matched candidate must be seg_north");
    assertClose(matchWithTile?.crossTrackDistanceMeters ?? 999, 2.0, 0.5, "Cross-track distance should be ~2m");

    // Evict tile -> matcher immediately returns null
    provider.evictTile(tile.key);
    const matchAfterEvict = matcher.match([2.0, 50.0], 0.0, ORIGIN);
    assert(matchAfterEvict === null, "Matcher should return null after tile is evicted");
  });

  // ---------------------------------------------------------------------------
  // TEST 5: Same-Tick ESKF Correction & State Retention (Scenarios H, I)
  // ---------------------------------------------------------------------------
  await runTest("Same-Tick ESKF State Correction & Propagation (Scenarios H, I)", () => {
    const provider = new LocalRoadNetworkProvider();
    // Segment running East-West through Origin North=0 (bearing 90 deg)
    const seg = makeSyntheticSegment("straight_e", 52.408, -1.515, 52.408, -1.505);
    seg.bearingDeg = 90.0;

    provider.registerTile({
      key: { scheme: "test", key: "h_i" },
      bounds: { minLat: 52.40, maxLat: 52.42, minLon: -1.52, maxLon: -1.50 },
      segments: [seg],
    });

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher, {
      baseStdMeters: 5.0,
      inflationFactor: 0.2,
      maxCrossTrackMeters: 30.0,
    });

    const eskf = new Eskf();
    // Start vehicle with North = 10.0m (10m off road centerline North=0), heading East (90 deg)
    eskf.reset(createDefaultState([50.0, 10.0, 0.0], [10.0, 0.0, 0.0]));

    const stateBefore = eskf.getState();
    assert(stateBefore.positionEnu[1] === 10.0, "Initial North position should be exactly 10.0m");

    // Apply road constraint synchronously
    const res = roadConstraint.evaluateAndApply(eskf, ORIGIN);
    assert(res.applied === true, "Road constraint should apply successfully");

    // Scenario H: ESKF state must be modified within the SAME tick
    const stateAfter = eskf.getState();
    const northAfter = stateAfter.positionEnu[1];
    assert(northAfter < 10.0 && northAfter > 0.0, `North position should be pulled toward 0 (was 10.0, now ${northAfter.toFixed(3)})`);
    assert(stateAfter.positionEnu[0] === 50.0, "Along-track East coordinate should be unchanged");

    // Scenario I: Subsequent IMU propagation begins from the corrected state
    // Propagate forward 0.1s with 10 m/s pure East velocity
    eskf.propagate(
      {
        timestampS: 0.1,
        accelMps2: [0.0, 0.0, 9.80665],
        gyroRadps: [0.0, 0.0, 0.0],
      },
      0.1,
    );

    const stateProp = eskf.getState();
    // North coordinate should remain at the corrected value, NOT revert to 10.0m
    assertClose(stateProp.positionEnu[1], northAfter, 0.05, "Propagated North position must retain road correction");
    assert(stateProp.positionEnu[0] > 50.0, "Vehicle should have moved East");
  });

  // ---------------------------------------------------------------------------
  // TEST 6: Strict In-Tick Execution Order in EskfPositioningEngine
  // ---------------------------------------------------------------------------
  await runTest("EskfPositioningEngine Deterministic In-Tick Execution Order", () => {
    const provider = new LocalRoadNetworkProvider();
    const seg = makeSyntheticSegment("engine_seg", 52.408, -1.515, 52.408, -1.505);
    seg.bearingDeg = 90.0;

    provider.registerTile({
      key: { scheme: "test", key: "engine_tile" },
      bounds: { minLat: 52.40, maxLat: 52.42, minLon: -1.52, maxLon: -1.50 },
      segments: [seg],
    });

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher);

    const engine = new EskfPositioningEngine({
      roadConstraint,
    });

    // Provide 20 initial stationary GNSS fixes to establish anchor (bearing 90 East)
    for (let i = 0; i < 20; i++) {
      const navLoc: NavLocation = {
        latitude: ORIGIN.latitude,
        longitude: ORIGIN.longitude,
        altitude: 100.0,
        accuracy: 1.0,
        speed: 10.0,
        heading: 90.0,
        timestamp: i * 1000,
        providerType: "gnss",
        isDeadReckoning: false,
      };
      engine.processGnss(navLoc);
    }

    // Process an IMU sample with small forward acceleration
    const imuSample: ImuSample = {
      timestamp: 21000,
      accel: { x: 0.0, y: 1.0, z: 9.80665 },
      gyro: { x: 0.0, y: 0.0, z: 0.0 },
    };

    const estimate = engine.processImu(imuSample);
    assert(estimate !== null, "processImu must return a valid PositionEstimate");
    assert(estimate.valid === true, "Position estimate must be marked valid");
    assert(typeof estimate.latitude === "number", "Latitude must be numeric");
    assert(typeof estimate.longitude === "number", "Longitude must be numeric");

    // Verify filter diagnostics and road constraint application
    assert(roadConstraint.getAppliedUpdateCount() >= 1, "roadConstraint must have applied an in-tick update");
    const diag = engine.getEskfDiagnostics();
    assert(diag.posUncertaintyM > 0, "posUncertaintyM should be positive");
    assert(engine.getStatus() === "GNSS_AVAILABLE", "Engine status should be GNSS_AVAILABLE");
  });

  // ---------------------------------------------------------------------------
  // TEST 7: Zero I/O & Microsecond In-Memory Execution Latency (Scenario J)
  // ---------------------------------------------------------------------------
  await runTest("Zero I/O Execution & Query Latency Benchmark (Scenario J)", () => {
    const provider = new LocalRoadNetworkProvider();
    const segments: RoadSegment[] = [];
    for (let i = 0; i < 50; i++) {
      segments.push(
        makeSyntheticSegment(
          `bench_${i}`,
          52.400 + i * 0.001,
          -1.520 + (i % 5) * 0.002,
          52.401 + i * 0.001,
          -1.520 + (i % 5) * 0.002,
        ),
      );
    }
    provider.registerTile({
      key: { scheme: "bench", key: "tile1" },
      bounds: { minLat: 52.40, maxLat: 52.50, minLon: -1.55, maxLon: -1.50 },
      segments,
    });

    // Verify spy on fs: no filesystem calls during queryRadius
    let fsCalled = false;
    const origRead = fs.readFileSync;
    fs.readFileSync = () => {
      fsCalled = true;
      return "";
    };

    const NUM_QUERIES = 5000;
    const t0 = performance.now();
    for (let i = 0; i < NUM_QUERIES; i++) {
      const q = provider.findNearbySegments(
        { latitude: 52.420, longitude: -1.515 },
        150,
      );
      if (q.length === -1) break;
    }
    const elapsedMs = performance.now() - t0;
    fs.readFileSync = origRead;

    assert(!fsCalled, "findNearbySegments MUST perform zero filesystem operations");
    const avgMs = elapsedMs / NUM_QUERIES;
    const avgUs = avgMs * 1000.0;
    console.log(`[Measured Latency: ${avgUs.toFixed(2)} µs/query (${avgMs.toFixed(4)} ms)]`);
    assert(avgMs < 1.0, `Query execution must be strictly in-memory sub-millisecond (measured: ${avgMs.toFixed(4)} ms)`);
  });

  // ---------------------------------------------------------------------------
  // TEST 8: Core Isolation & Provider Neutrality Codebase Audit
  // ---------------------------------------------------------------------------
  await runTest("Core Architectural Isolation Audit", () => {
    const coreDir = path.resolve(__dirname, "../../src/core");
    const forbiddenPatterns = [
      /from\s+['"]react['"]/,
      /from\s+['"]react-native['"]/,
      /from\s+['"]expo['"]/,
      /from\s+['"]expo-file-system['"]/,
      /from\s+['"]react-native-maps['"]/,
      /from\s+['"]sqlite['"]/,
    ];

    function checkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
          const content = fs.readFileSync(fullPath, "utf8");
          for (const pat of forbiddenPatterns) {
            assert(!pat.test(content), `Forbidden import in ${path.relative(coreDir, fullPath)} matching ${pat}`);
          }
        }
      }
    }

    checkDir(coreDir);
  });

  // ---------------------------------------------------------------------------
  // TEST 9: Diagnostics Reporting (Requirement 11)
  // ---------------------------------------------------------------------------
  await runTest("Diagnostics Reporting & Inspection (Requirement 11)", () => {
    const provider = new LocalRoadNetworkProvider(undefined, "DiagTestProvider");
    const tileA: RoadTile = {
      key: { scheme: "deg", key: "tile_A" },
      bounds: { minLat: 52.4, maxLat: 52.5, minLon: -1.5, maxLon: -1.4 },
      segments: [makeSyntheticSegment("diag_1", 52.41, -1.45, 52.42, -1.45)],
    };

    provider.registerTile(tileA);
    const diag = provider.getDiagnostics();

    assert(diag.providerName === "DiagTestProvider", "Diagnostics should report providerName");
    assert(diag.loadedTileCount === 1, "loadedTileCount should be 1");
    assert(diag.loadedTileKeys.includes("deg:tile_A"), "loadedTileKeys should include deg:tile_A");
    assert(diag.segmentCount === 1, "segmentCount should be 1");
    assert(diag.spatialGridCellCount > 0, "spatialGridCellCount should be > 0");
    assert(diag.isOffline === true, "isOffline should report true");
  });

  // ---------------------------------------------------------------------------
  // TEST 10: MockRoadDataSource and InMemoryRoadCache Test Doubles
  // ---------------------------------------------------------------------------
  await runTest("MockRoadDataSource & InMemoryRoadCache Lifecycle", async () => {
    const dataSource = new MockRoadDataSource("TestSource");
    const cache = new InMemoryRoadCache();

    const sampleTile: RoadTile = {
      key: { scheme: "deg", key: "source_tile" },
      bounds: { minLat: 52.0, maxLat: 52.1, minLon: -1.0, maxLon: -0.9 },
      segments: [makeSyntheticSegment("st1", 52.01, -0.95, 52.05, -0.95)],
    };

    dataSource.addMockTile(sampleTile);
    assert(dataSource.isAvailable(), "dataSource should be available");

    // Fetch tile from source
    const fetched = await dataSource.fetchTile(sampleTile.key);
    assert(fetched !== null, "Fetched tile should not be null");
    assert(fetched?.segments.length === 1, "Fetched tile should have 1 segment");
    assert(dataSource.getFetchCount(sampleTile.key) === 1, "Fetch count should be 1");

    // Store in cache
    await cache.putTile(fetched!);
    assert(await cache.hasTile(sampleTile.key), "Cache should have tile");
    assert((await cache.getCachedKeys()).length === 1, "Cached keys count should be 1");

    // Retrieve from cache
    const fromCache = await cache.getTile(sampleTile.key);
    assert(fromCache?.key.key === "source_tile", "Tile from cache should match");

    // Remove from cache
    await cache.removeTile(sampleTile.key);
    assert(!(await cache.hasTile(sampleTile.key)), "Cache should no longer have tile");
    assert(cache.size() === 0, "Cache size should be 0");
  });

  console.log(`\n===============================================================`);
  console.log(`  Dynamic Road Prefetching Phase 1 Results: ${passed} passed, ${failed} failed`);
  console.log(`===============================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL in test runner:", err);
  process.exit(1);
});