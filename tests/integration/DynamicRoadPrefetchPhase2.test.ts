/**
 * DynamicRoadPrefetchPhase2.test.ts
 *
 * Comprehensive Phase 2 integration test suite for the BetterMaps Dynamic Road
 * Coverage Layer & Prefetching Architecture.
 *
 * 10 Required Test Scenarios:
 * 1. Route corridor coverage planning & dynamic speed scaling
 * 2. Free-drive coverage planning & directional heading bias
 * 3. Route rerouting & lateral deviation handling
 * 4. Multi-tier storage flow (Planner -> Cache -> Source -> Provider)
 * 5. Active tile lifecycle (multi-tile dynamic registration & isolated eviction)
 * 6. Estimator isolation (5,000 processImu iterations with zero I/O & sub-ms latency)
 * 7. Asynchronous prefetch non-blocking verification
 * 8. Graceful degradation under missing or failed road data
 * 9. Route prior candidate scoring & ESKF covariance contraction
 * 10. Real Coventry road-network integration & honest regional unavailability
 *
 * ARCHITECTURAL INVARIANTS:
 * - Estimator tick is strictly synchronous and in-memory (zero I/O, zero Promises).
 * - Zero production math/model modifications.
 * - Zero fake road geometry for non-Coventry benchmark regions.
 * - Provider-neutral, modular contracts.
 */

import { SpatialGridIndex } from "../../src/adapters/road/SpatialGridIndex";
import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import { OfflineFixtureRoadDataSource } from "../../src/adapters/road/OfflineFixtureRoadDataSource";
import {
  PersistentRoadCache,
  DEFAULT_ROAD_CACHE_CONFIG,
} from "../../src/adapters/road/PersistentRoadCache";
import {
  RouteCoveragePlanner,
  DEFAULT_ROUTE_COVERAGE_CONFIG,
  RouteCoverageInput,
} from "../../src/core/navigation/road/RouteCoveragePlanner";
import {
  FreeDriveCoveragePlanner,
  DEFAULT_FREE_DRIVE_CONFIG,
} from "../../src/core/navigation/road/FreeDriveCoveragePlanner";
import {
  RoadDataManager,
  RoadDataManagerDiagnostics,
} from "../../src/core/navigation/road/RoadDataManager";
import {
  RoadTile,
  createDegreeTileKey,
  serializeTileKey,
  parseTileKey,
  TileKey,
} from "../../src/core/navigation/road/RoadTileTypes";
import { RoadSegment } from "../../src/core/navigation/road/RoadTypes";
import { MultiCandidateRoadMatcher } from "../../src/core/navigation/road/MultiCandidateRoadMatcher";
import { ProbabilisticRoadConstraint } from "../../src/core/positioning/constraints/ProbabilisticRoadConstraint";
import { ProbabilisticRouteConstraint } from "../../src/core/positioning/constraints/ProbabilisticRouteConstraint";
import { Eskf } from "../../src/core/positioning/eskf/Eskf";
import { NavigationState } from "../../src/core/positioning/eskf/EskfTypes";
import {
  Wgs84Coordinate,
  enuToWgs84,
  wgs84ToEnu,
} from "../../src/core/positioning/coordinates";
import { EskfPositioningEngine } from "../../src/core/positioning/EskfPositioningEngine";
import { ImuSample } from "../../src/core/types/imu";
import { NavLocation } from "../../src/core/types/location";
import { IStorageDriver } from "../../src/core/storage/IStorageDriver";
import { NavigationManager } from "../../src/core/state/NavigationManager";

declare const require: any;
declare const process: any;
declare const performance: any;
declare const __dirname: string;

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

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

function isPromise(val: unknown): boolean {
  return (
    val !== null &&
    typeof val === "object" &&
    typeof (val as any).then === "function"
  );
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

// Global Coventry reference origin
const ORIGIN: Wgs84Coordinate = {
  latitude: 52.408,
  longitude: -1.512,
  altitude: 100.0,
};

// Fixture paths
const FIXTURES_DIR = fs.existsSync(path.resolve(__dirname, "../../assets/datasets/road_tiles_test"))
  ? path.resolve(__dirname, "../../assets/datasets/road_tiles_test")
  : path.resolve(__dirname, "../../../assets/datasets/road_tiles_test");
const TILE_EAST_PATH = path.join(FIXTURES_DIR, "tile_coventry_east.json");
const TILE_WEST_PATH = path.join(FIXTURES_DIR, "tile_coventry_west.json");
const TILE_CENTRAL_PATH = path.join(FIXTURES_DIR, "tile_coventry_central.json");
const MANIFEST_PATH = path.join(FIXTURES_DIR, "manifest.json");

function loadTileFixture(filePath: string): RoadTile {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as RoadTile;
}

/** Converts heading in degrees (clockwise from North) to orientation quaternion qNb */
function headingToQuat(headingDeg: number): [number, number, number, number] {
  const alphaRad = ((90.0 - headingDeg) * Math.PI) / 180.0;
  return [Math.cos(alphaRad / 2), 0.0, 0.0, Math.sin(alphaRad / 2)];
}

/** In-memory mock storage driver for persistent cache testing */
class MockStorageDriver implements IStorageDriver {
  private store: Map<string, string> = new Map();
  public getCount = 0;
  public putCount = 0;

  async getItem(key: string): Promise<string | null> {
    this.getCount++;
    return this.store.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.putCount++;
    this.store.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
  async getAllKeys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
}

async function main() {
  console.log("\n===============================================================");
  console.log("  BetterMaps Phase 2: Dynamic Road Coverage Integration Tests");
  console.log("===============================================================\n");

  assert(fs.existsSync(TILE_EAST_PATH), "Coventry East tile fixture must exist");
  assert(fs.existsSync(TILE_WEST_PATH), "Coventry West tile fixture must exist");
  assert(fs.existsSync(TILE_CENTRAL_PATH), "Coventry Central tile fixture must exist");

  const eastTile = loadTileFixture(TILE_EAST_PATH);
  const westTile = loadTileFixture(TILE_WEST_PATH);
  const centralTile = loadTileFixture(TILE_CENTRAL_PATH);

  // ---------------------------------------------------------------------------
  // SCENARIO 1: Route corridor coverage planning & dynamic speed scaling
  // ---------------------------------------------------------------------------
  await runTest("Scenario 1: Route corridor coverage planning & dynamic speed scaling", () => {
    const planner = new RouteCoveragePlanner({
      lateralBufferMeters: 150.0,
      baseLookaheadDistanceMeters: 500.0,
      timeHorizonSeconds: 60.0,
      maxLookaheadDistanceMeters: 3000.0,
      rearRetentionDistanceMeters: 1200.0,
      tileResolutionDegrees: 0.01,
    });

    // Realistic Coventry route along A429 Kenilworth/Warwick corridor (~2.6 km)
    const routeInput: RouteCoverageInput = {
      id: "coventry-a429",
      points: [
        { latitude: 52.395, longitude: -1.515 },
        { latitude: 52.405, longitude: -1.510 },
        { latitude: 52.415, longitude: -1.505 },
      ],
    };

    planner.setRoute(routeInput);

    // 1. Static full-corridor ribbon computation
    const corridorKeys1 = planner.computeCorridorTileKeys();
    const corridorKeys2 = planner.computeCorridorTileKeys();
    assert(corridorKeys1.length > 0, "Corridor keys must not be empty");
    assert(
      corridorKeys1.length === corridorKeys2.length,
      "computeCorridorTileKeys must be deterministic and idempotent",
    );

    // 2. Dynamic forward lookahead scaling with speed
    const currentPos = { latitude: 52.400, longitude: -1.5125 };

    // At v = 0 m/s: forward lookahead = base (500m)
    const plan0 = planner.planCoverage(currentPos, 0.0);
    assertClose(plan0.forwardLookaheadMeters, 500.0, 1e-3, "Lookahead at 0 m/s must be base distance (500m)");
    assert(!plan0.isOffRoute, "Vehicle within 150m of route must not be off-route");

    // At v = 25 m/s: forward lookahead = 500 + 25 * 60 = 2000m
    const plan25 = planner.planCoverage(currentPos, 25.0);
    assertClose(plan25.forwardLookaheadMeters, 2000.0, 1e-3, "Lookahead at 25 m/s must scale to 2000m");
    assert(
      plan25.forwardPrefetchTileKeys.length >= plan0.forwardPrefetchTileKeys.length,
      "High-speed lookahead must encompass equal or more forward prefetch tiles",
    );

    // At v = 60 m/s: forward lookahead capped at max (3000m)
    const planMax = planner.planCoverage(currentPos, 60.0);
    assertClose(planMax.forwardLookaheadMeters, 3000.0, 1e-3, "Lookahead at 60 m/s must be clamped at max (3000m)");

    // 3. Rear retention buffer (with rearRetentionDistanceMeters = 1200m)
    const midRoutePos = { latitude: 52.410, longitude: -1.5075 };
    const planMid = planner.planCoverage(midRoutePos, 10.0);
    assert(
      planMid.rearRetentionTileKeys.length > 0,
      "Vehicle advanced along route must retain rear tiles behind vehicle",
    );
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Free-drive coverage planning & directional heading bias
  // ---------------------------------------------------------------------------
  await runTest("Scenario 2: Free-drive coverage planning & directional heading bias", () => {
    const planner = new FreeDriveCoveragePlanner({
      baseForwardDistanceMeters: 800.0,
      maxForwardDistanceMeters: 2000.0,
      timeHorizonSeconds: 60.0,
      stationarySpeedThresholdMps: 1.0,
      tileResolutionDegrees: 0.01,
    });

    const pos = { latitude: 52.408, longitude: -1.512 };

    // 1. Stationary fallback (v < 1.0 m/s): symmetric envelope
    const planStationary = planner.planCoverage(pos, 0.5, 0.0);
    assert(planStationary.isStationary, "v = 0.5 m/s must be treated as stationary");
    assert(
      planStationary.requiredTileKeys.length >= 1,
      "Stationary plan must include center and surrounding buffer tiles",
    );

    // 2. Moving North (heading = 0 deg)
    const planNorth = planner.planCoverage(pos, 15.0, 0.0);
    assert(!planNorth.isStationary, "v = 15 m/s is not stationary");
    const northKeys = planNorth.forwardTileKeys;
    assert(northKeys.length > 0, "Moving north must generate forward prefetch tiles");
    const centerLatIdx = Math.floor(pos.latitude / 0.01);
    for (const k of northKeys) {
      const parts = k.key.split(":");
      const latIdx = parseInt(parts[1], 10);
      assert(
        latIdx >= centerLatIdx,
        "Forward tiles when heading North must be northward (lat >= center)",
      );
    }

    // 3. Moving East (heading = 90 deg)
    const planEast = planner.planCoverage(pos, 15.0, 90.0);
    const eastKeys = planEast.forwardTileKeys;
    assert(eastKeys.length > 0, "Moving east must generate forward prefetch tiles");
    const centerLonIdx = Math.floor(pos.longitude / 0.01);
    for (const k of eastKeys) {
      const parts = k.key.split(":");
      const lonIdx = parseInt(parts[2], 10);
      assert(
        lonIdx >= centerLonIdx,
        "Forward tiles when heading East must be eastward (lon >= center)",
      );
    }

    // 4. Speed lookahead scaling
    const plan10 = planner.planCoverage(pos, 10.0, 0.0);
    // 800 + 10 * 60 = 1400m
    assertClose(plan10.forwardDistanceMeters, 1400.0, 1e-3, "Forward reach at 10 m/s must be 1400m");
    const plan30 = planner.planCoverage(pos, 30.0, 0.0);
    // clamped at max (2000m)
    assertClose(plan30.forwardDistanceMeters, 2000.0, 1e-3, "Forward reach at 30 m/s must clamp at 2000m");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Route rerouting & lateral deviation handling
  // ---------------------------------------------------------------------------
  await runTest("Scenario 3: Route rerouting & lateral deviation handling", async () => {
    const provider = new LocalRoadNetworkProvider();
    const manager = new RoadDataManager({ provider });

    const route1: RouteCoverageInput = {
      id: "trip-alpha",
      points: [
        { latitude: 52.400, longitude: -1.510 },
        { latitude: 52.410, longitude: -1.510 },
      ],
    };

    // 1. Activate route
    await manager.updateRoute(route1);
    let diag = manager.getDiagnostics();
    assert(diag.mode === "ROUTE", "Mode should be ROUTE after setting route");
    assert(diag.activeRouteId === "trip-alpha", "activeRouteId must match trip-alpha");
    assert(!diag.isOffRoute, "Initial state should not be off route");

    // 2. Drive along route (cross-track = 0m)
    await manager.updatePosition({ latitude: 52.405, longitude: -1.510 }, 10.0, 0.0);
    diag = manager.getDiagnostics();
    assert(diag.mode === "ROUTE", "Vehicle on-route must stay in ROUTE mode");
    assert(!diag.isOffRoute, "Vehicle on-route must have isOffRoute = false");

    // 3. Driver deviates off-route by 500m (corridor lateral buffer is 150m)
    const offRoutePos = { latitude: 52.405, longitude: -1.5027 };
    await manager.updatePosition(offRoutePos, 10.0, 90.0);
    diag = manager.getDiagnostics();
    assert(diag.isOffRoute, "Vehicle 500m away must trigger isOffRoute = true");
    assert(
      diag.mode === "ROUTE_DEVIATION",
      `Off-route vehicle must switch to ROUTE_DEVIATION mode (got ${diag.mode})`,
    );

    // 4. Reroute with a new active route
    const route2: RouteCoverageInput = {
      id: "trip-beta-rerouted",
      points: [
        { latitude: 52.405, longitude: -1.5027 },
        { latitude: 52.415, longitude: -1.5027 },
      ],
    };
    await manager.updateRoute(route2);
    diag = manager.getDiagnostics();
    assert(diag.mode === "ROUTE", "Setting new route must restore ROUTE mode");
    assert(diag.activeRouteId === "trip-beta-rerouted", "Route ID must update to trip-beta-rerouted");
    assert(!diag.isOffRoute, "Reroute must reset isOffRoute to false");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 4: Multi-tier storage flow (Planner -> Cache -> Source -> Provider)
  // ---------------------------------------------------------------------------
  await runTest("Scenario 4: Multi-tier storage flow (Planner -> Cache -> Source -> Provider)", async () => {
    const storageDriver = new MockStorageDriver();
    const cache = new PersistentRoadCache(storageDriver);
    const dataSource = new OfflineFixtureRoadDataSource();
    dataSource.registerFixture(eastTile);

    // Focused planner requiring strictly the East tile (100:5240:-151)
    const routePlanner = new RouteCoveragePlanner({
      lateralBufferMeters: 50.0,
      baseLookaheadDistanceMeters: 50.0,
      timeHorizonSeconds: 0.0,
      rearRetentionDistanceMeters: 0.0,
      tileResolutionDegrees: 0.01,
    });

    const provider = new LocalRoadNetworkProvider();
    const manager = new RoadDataManager({
      routePlanner,
      dataSource,
      cache,
      provider,
    });

    const eastRoute: RouteCoverageInput = {
      id: "east-trip",
      points: [
        { latitude: 52.4017, longitude: -1.5084 },
        { latitude: 52.4018, longitude: -1.5084 },
      ],
    };

    // 1. Initial route activation and position update (Cache miss -> Data source hit)
    await manager.updateRoute(eastRoute);
    const posEast = { latitude: 52.40175, longitude: -1.5084 };
    await manager.updatePosition(posEast, 0.0, 0.0);

    let diag = manager.getDiagnostics();
    assert(diag.cacheMissCount >= 1, "Initial acquisition must record cache miss");
    assert(provider.hasTile(eastTile.key), "East tile must be registered in provider after acquisition");

    // Verify tile was also persisted into L2 storage driver
    const l2Keys = await storageDriver.getAllKeys();
    assert(
      l2Keys.some((k) => k.includes("deg:100:5240:-151")),
      "East tile must be stored in L2 storage driver",
    );

    // 2. Evict East tile from provider
    provider.evictTile(eastTile.key);
    assert(!provider.hasTile(eastTile.key), "Provider must have evicted East tile");

    // 3. Second request for East tile (Cache hit -> Data source bypassed)
    const fetchCountBefore = dataSource.getFetchCount();
    await manager.updatePosition(posEast, 0.0, 0.0);

    diag = manager.getDiagnostics();
    assert(diag.cacheHitCount >= 1, "Second acquisition must record cache hit");
    assert(
      dataSource.getFetchCount() === fetchCountBefore,
      "Data source must NOT be invoked on cache hit",
    );
    assert(provider.hasTile(eastTile.key), "East tile must be re-registered into provider from cache");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 5: Active tile lifecycle (multi-tile dynamic registration & isolated eviction)
  // ---------------------------------------------------------------------------
  await runTest("Scenario 5: Active tile lifecycle (multi-tile dynamic registration & isolated eviction)", () => {
    const provider = new LocalRoadNetworkProvider();

    // Register East and Central tiles
    provider.registerTile(eastTile);
    provider.registerTile(centralTile);

    let diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 2, "Provider must have 2 loaded tiles");

    // Identify shared boundary segment (s5)
    const segS5 = provider.getSegmentById("s5");
    assert(segS5 !== null, "Segment s5 should exist in provider");

    // Evict Central tile
    provider.evictTile(centralTile.key);
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 1, "Provider should have 1 tile remaining");

    // Segment s5 was also in East tile -> must remain retained!
    const segS5After = provider.getSegmentById("s5");
    assert(
      segS5After !== null,
      "Shared boundary segment s5 must NOT be evicted while East tile remains loaded",
    );
    const nearby = provider.findNearbySegments(segS5!.startPoint, 50);
    assert(
      nearby.some((s) => s.id === "s5"),
      "Shared segment s5 must remain queryable in spatial index",
    );

    // Evict East tile
    provider.evictTile(eastTile.key);
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 0, "Provider must have 0 tiles after all evictions");
    assert(provider.getSegmentById("s5") === null, "Segment s5 must be evicted after both owners removed");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 6: Estimator isolation (5,000 processImu iterations with zero I/O & sub-ms latency)
  // ---------------------------------------------------------------------------
  await runTest("Scenario 6: Estimator isolation (5,000 processImu iterations with zero I/O & sub-ms latency)", async () => {
    const provider = new LocalRoadNetworkProvider();
    provider.registerTile(eastTile);

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher);
    const engine = new EskfPositioningEngine({ roadConstraint });

    // Initialize GNSS
    for (let i = 0; i < 10; i++) {
      engine.processGnss({
        latitude: 52.40175,
        longitude: -1.5084,
        altitude: 100.0,
        accuracy: 1.0,
        speed: 10.0,
        heading: 2.0,
        timestamp: i * 1000,
        providerType: "gnss",
        isDeadReckoning: false,
      });
    }

    // Set up spies on fs, http, https
    let fsOperationsCount = 0;
    const fsSpies = ["readFileSync", "readFile", "openSync", "statSync", "existsSync"];
    const origFsFns: Record<string, any> = {};

    for (const fn of fsSpies) {
      if (typeof fs[fn] === "function") {
        origFsFns[fn] = fs[fn];
        fs[fn] = function (...args: any[]) {
          fsOperationsCount++;
          return origFsFns[fn].apply(fs, args);
        };
      }
    }

    let netOperationsCount = 0;
    const origHttpGet = http.get;
    const origHttpRequest = http.request;
    const origHttpsGet = https.get;
    const origHttpsRequest = https.request;

    http.get = function (...args: any[]) {
      netOperationsCount++;
      return origHttpGet.apply(http, args);
    };
    http.request = function (...args: any[]) {
      netOperationsCount++;
      return origHttpRequest.apply(http, args);
    };
    https.get = function (...args: any[]) {
      netOperationsCount++;
      return origHttpsGet.apply(https, args);
    };
    https.request = function (...args: any[]) {
      netOperationsCount++;
      return origHttpsRequest.apply(https, args);
    };

    const NUM_ITERATIONS = 5000;
    const t0 = performance.now();

    for (let i = 0; i < NUM_ITERATIONS; i++) {
      // 1. Synchronous estimator tick
      const estimate = engine.processImu({
        timestamp: 16000 + i * 10,
        accel: { x: 0.0, y: 1.0, z: 9.80665 },
        gyro: { x: 0.0, y: 0.0, z: 0.0 },
      });

      assert(!isPromise(estimate), "processImu must NOT return a Promise");
      assert(Number.isFinite(estimate.latitude), "Latitude must be finite number");
      assert(Number.isFinite(estimate.longitude), "Longitude must be finite number");
    }

    const elapsedMs = performance.now() - t0;

    // Restore original functions
    for (const fn of fsSpies) {
      if (origFsFns[fn]) fs[fn] = origFsFns[fn];
    }
    http.get = origHttpGet;
    http.request = origHttpRequest;
    https.get = origHttpsGet;
    https.request = origHttpsRequest;

    assert(fsOperationsCount === 0, `ZERO filesystem calls permitted in processImu (detected: ${fsOperationsCount})`);
    assert(netOperationsCount === 0, `ZERO network calls permitted in processImu (detected: ${netOperationsCount})`);

    const avgUs = (elapsedMs / NUM_ITERATIONS) * 1000.0;
    console.log(`[5,000 Iteration Loop Latency: ${avgUs.toFixed(2)} µs/sample]`);
    assert(avgUs < 1000.0, `Execution time must be sub-millisecond (measured: ${avgUs.toFixed(2)} µs)`);
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 7: Asynchronous prefetch non-blocking verification
  // ---------------------------------------------------------------------------
  await runTest("Scenario 7: Asynchronous prefetch non-blocking verification", async () => {
    const dataSource = new OfflineFixtureRoadDataSource();
    dataSource.registerFixture(westTile);
    // Inject 300 ms simulated fetch latency
    dataSource.setSimulatedLatencyMs(300);

    const provider = new LocalRoadNetworkProvider();
    const manager = new RoadDataManager({ dataSource, provider });

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher);
    const engine = new EskfPositioningEngine({ roadConstraint });

    // Position at 52.405, -1.55 directly triggers West tile (100:5240:-155)
    const backgroundPromise = manager.updatePosition(
      { latitude: 52.405, longitude: -1.55 },
      10.0,
      86.9,
    );

    // Call estimator processImu immediately
    const t0 = performance.now();
    const estimate = engine.processImu({
      timestamp: 20000,
      accel: { x: 0.0, y: 1.0, z: 9.80665 },
      gyro: { x: 0.0, y: 0.0, z: 0.0 },
    });
    const imuElapsedMs = performance.now() - t0;

    assert(!isPromise(estimate), "processImu must execute synchronously");
    assert(
      imuElapsedMs < 10.0,
      `processImu must not block on 300ms async prefetch (measured: ${imuElapsedMs.toFixed(3)} ms)`,
    );

    // Now await background prefetch to settle cleanly
    await backgroundPromise;
    assert(provider.hasTile(westTile.key), "West tile must be registered after async fetch completes");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 8: Graceful degradation under missing or failed road data
  // ---------------------------------------------------------------------------
  await runTest("Scenario 8: Graceful degradation under missing or failed road data", async () => {
    const dataSource = new OfflineFixtureRoadDataSource();
    // Simulate failure injection (returns null for any tile request)
    dataSource.setSimulatedFailure(true);

    const provider = new LocalRoadNetworkProvider();
    const manager = new RoadDataManager({ dataSource, provider });

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher);
    const engine = new EskfPositioningEngine({ roadConstraint });

    // Establish GNSS origin first
    for (let i = 0; i < 5; i++) {
      engine.processGnss({
        latitude: 52.408,
        longitude: -1.512,
        altitude: 100.0,
        accuracy: 1.0,
        speed: 10.0,
        heading: 0.0,
        timestamp: i * 1000,
        providerType: "gnss",
        isDeadReckoning: false,
      });
    }

    // Request position update where tile fails to fetch
    await manager.updatePosition({ latitude: 52.408, longitude: -1.512 }, 10.0, 0.0);

    const diag = manager.getDiagnostics();
    assert(
      diag.coverageState === "PARTIAL" ||
        diag.coverageState === "UNAVAILABLE" ||
        diag.coverageState === "OFFLINE",
      `Coverage state must degrade gracefully (got ${diag.coverageState})`,
    );

    // Verify estimator continues dead-reckoning without exceptions
    let threwError = false;
    try {
      for (let i = 0; i < 50; i++) {
        const est = engine.processImu({
          timestamp: 30000 + i * 10,
          accel: { x: 0.0, y: 0.0, z: 9.80665 },
          gyro: { x: 0.0, y: 0.0, z: 0.0 },
        });
        assert(Number.isFinite(est.latitude), "Latitude must remain finite under degraded road data");
      }
    } catch {
      threwError = true;
    }

    assert(!threwError, "Estimator must continue dead-reckoning uninterrupted when road data fails");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 9: Route prior candidate scoring & ESKF covariance contraction
  // ---------------------------------------------------------------------------
  await runTest("Scenario 9: Route prior candidate scoring & ESKF covariance contraction", () => {
    const provider = new LocalRoadNetworkProvider();
    provider.registerTile(eastTile);

    const matcher = new MultiCandidateRoadMatcher(provider, {
      routeBonusMultiplier: 1.3,
    });

    const routePolyline: RouteCoverageInput = {
      id: "warwick-route",
      points: [
        { latitude: 52.400, longitude: -1.5085 },
        { latitude: 52.404, longitude: -1.5083 },
      ],
    };

    // Warwick Road vehicle position
    const warwickPos = { latitude: 52.40175, longitude: -1.5084 };
    const warwickEnu = wgs84ToEnu(warwickPos, ORIGIN);

    // 1. Matching WITHOUT active route
    matcher.setActiveRoute(null);
    matcher.reset();
    const matchNoRoute = matcher.match([warwickEnu.east, warwickEnu.north], 2.0, ORIGIN);
    assert(matchNoRoute !== null, "Must match Warwick Road without active route");
    const scoreNoRoute = matchNoRoute!.rawScore;

    // 2. Matching WITH active route
    matcher.reset();
    matcher.setActiveRoute({ polylinePoints: routePolyline.points });
    const matchWithRoute = matcher.match([warwickEnu.east, warwickEnu.north], 2.0, ORIGIN);
    assert(matchWithRoute !== null, "Must match Warwick Road with active route");
    const scoreWithRoute = matchWithRoute!.rawScore;

    // Verify route prior applied 1.3x multiplier
    assertClose(
      scoreWithRoute / scoreNoRoute,
      1.3,
      1e-2,
      "Active route candidate must receive 1.3x route bonus multiplier",
    );
    assert(
      matchWithRoute!.routeConsistencyScore === 1.0,
      "routeConsistencyScore must be 1.0 for on-route candidate",
    );

    // 3. ESKF covariance contraction test
    const eskf = new Eskf();
    eskf.reset({
      positionEnu: [warwickEnu.east + 5.0, warwickEnu.north, 0.0],
      velocityEnu: [0.0, 10.0, 0.0],
      qNb: headingToQuat(2.0),
      accelBias: [0.0, 0.0, 0.0],
      gyroBias: [0.0, 0.0, 0.0],
    });

    const covPrior = eskf.getCovariance();
    const varPrior = covPrior.get(0, 0) * covPrior.get(1, 1) * covPrior.get(2, 2);

    const roadConstraint = new ProbabilisticRoadConstraint(matcher, {
      baseStdMeters: 5.0,
      inflationFactor: 0.2,
      maxCrossTrackMeters: 30.0,
    });

    const correction = roadConstraint.evaluateAndApply(eskf, ORIGIN);
    assert(correction.applied, "Road constraint correction must be applied to ESKF");

    const covPost = eskf.getCovariance();
    const varPost = covPost.get(0, 0) * covPost.get(1, 1) * covPost.get(2, 2);
    assert(
      varPost < varPrior,
      `Bayesian road constraint must contract position covariance: prior ${varPrior.toFixed(2)} -> post ${varPost.toFixed(2)}`,
    );

    const stateAfter = eskf.getState();
    const posErrorAfter = Math.hypot(
      stateAfter.positionEnu[0] - warwickEnu.east,
      stateAfter.positionEnu[1] - warwickEnu.north,
    );
    assert(
      posErrorAfter < 5.0,
      `ESKF position must contract toward Warwick Road (was 5.0m, now ${posErrorAfter.toFixed(2)}m)`,
    );
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 10: Real Coventry road-network integration & honest regional unavailability
  // ---------------------------------------------------------------------------
  await runTest("Scenario 10: Real Coventry road-network integration & honest regional unavailability", async () => {
    const dataSource = new OfflineFixtureRoadDataSource();
    const count = dataSource.loadFromDirectory(FIXTURES_DIR);
    assert(count >= 3, `Must load at least 3 Coventry fixtures from ${FIXTURES_DIR} (loaded ${count})`);

    const provider = new LocalRoadNetworkProvider();
    const manager = new RoadDataManager({ dataSource, provider });

    // Vehicle moving through Coventry regions, dynamically acquiring each tile
    // 1. Coventry East (Warwick Road corridor)
    await manager.updatePosition(
      { latitude: 52.40175, longitude: -1.5084 },
      10.0,
      2.0,
    );
    assert(provider.hasTile(eastTile.key), "East tile must be dynamically acquired");
    const eastSegs = provider.findNearbySegments(
      { latitude: 52.40175, longitude: -1.5084 },
      50,
    );
    assert(eastSegs.length > 0, "Warwick Road segment must be found in East tile");

    // 2. Coventry Central Hub (Ring Road corridor)
    await manager.updatePosition(
      { latitude: 52.4125, longitude: -1.52 },
      10.0,
      31.4,
    );
    assert(provider.hasTile(centralTile.key), "Central tile must be dynamically acquired");
    const centralSegs = provider.findNearbySegments(
      { latitude: 52.4115, longitude: -1.514 },
      100,
    );
    assert(centralSegs.length > 0, "Ring road segment must be found in Central tile");

    // 3. Coventry West (Charter Avenue corridor)
    await manager.updatePosition(
      { latitude: 52.405, longitude: -1.55 },
      10.0,
      86.9,
    );
    assert(provider.hasTile(westTile.key), "West tile must be dynamically acquired");
    const westSegs = provider.findNearbySegments(
      { latitude: 52.4015, longitude: -1.538 },
      100,
    );
    assert(westSegs.length > 0, "Charter Avenue segment must be found in West tile");

    // HONEST REGIONAL COVERAGE AUDIT:
    // Verify that the 8 non-Coventry IO-VNBD benchmark regions return null from the offline data source
    const nonCoventrySessions = [
      { name: "Vta8", origin: { lat: 52.86297, lon: -1.68282 }, region: "Burton upon Trent" },
      { name: "Vta10", origin: { lat: 52.88177, lon: -1.71742 }, region: "Stretton" },
      { name: "Vta15", origin: { lat: 52.96543, lon: -1.75695 }, region: "Uttoxeter" },
      { name: "Vta21", origin: { lat: 53.04053, lon: -1.81736 }, region: "Cheadle" },
      { name: "Vtb12", origin: { lat: 52.55384, lon: -1.46679 }, region: "Nuneaton" },
      { name: "Vtb4", origin: { lat: 53.17105, lon: -1.67288 }, region: "Matlock" },
      { name: "Vw14b", origin: { lat: 52.34884, lon: -2.07422 }, region: "Bromsgrove" },
      { name: "Vw8", origin: { lat: 52.92211, lon: -1.47712 }, region: "Derby" },
    ];

    for (const session of nonCoventrySessions) {
      const latIdx = Math.floor(session.origin.lat / 0.01);
      const lonIdx = Math.floor(session.origin.lon / 0.01);
      const key = createDegreeTileKey(latIdx, lonIdx, 0.01);
      const fetched = await dataSource.fetchTile(key);
      assert(
        fetched === null,
        `Non-Coventry benchmark session ${session.name} (${session.region}) must return null (OFFLINE_UNAVAILABLE) without fake roads`,
      );
    }
  });

  console.log(`\n===============================================================`);
  console.log(`  Dynamic Road Prefetch Phase 2 Results: ${passed} passed, ${failed} failed`);
  console.log(`===============================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL: Uncaught error in Phase 2 test runner:", err);
  process.exit(1);
});
