/**
 * LiveIdrProductionStack.test.ts
 *
 * Comprehensive integration test suite for BetterMaps Phase 3:
 * End-to-end Live IDR integration & production positioning stack.
 */

import {
  OsmOverpassRoadDataSource,
} from "../../src/adapters/road/OsmOverpassRoadDataSource";
import {
  NavigationManager,
  createProductionPositioningStack,
} from "../../src/core/state/NavigationManager";
import {
  createDegreeTileKey,
  createSlippyTileKey,
} from "../../src/core/navigation/road/RoadTileTypes";
import { IImuProvider, ImuListener, ImuSample } from "../../src/core/types/imu";
import {
  ILocationProvider,
  LocationListener,
  NavLocation,
  ProviderStatus,
  StatusListener,
} from "../../src/core/types/location";
import { GnssStreamGate } from "../../src/core/positioning/GnssStreamGate";
import { ActiveRoute } from "../../src/core/types/navigation";

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
    `${message} (got ${a.toFixed(4)}, expected ~${b.toFixed(4)}, tol=${tol})`,
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
  } catch (e: any) {
    console.error(`FAIL: ${e?.message ?? e}`);
    if (e?.stack) console.error(e.stack);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Mock Providers for Controlled Integration Testing
// ---------------------------------------------------------------------------

class TestMockLocationProvider implements ILocationProvider {
  public readonly name = "TestMockLocationProvider";
  public readonly providerType = "mock" as const;
  private status: ProviderStatus = "idle";
  private listeners = new Set<LocationListener>();
  private statusListeners = new Set<StatusListener>();

  public getStatus(): ProviderStatus {
    return this.status;
  }
  public async getCurrentLocation(): Promise<NavLocation | null> {
    return null;
  }
  public async start(): Promise<void> {
    this.status = "active";
  }
  public async stop(): Promise<void> {
    this.status = "stopped";
  }
  public addListener(listener: LocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public addStatusListener(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  public emitLocation(loc: NavLocation): void {
    for (const l of this.listeners) l(loc);
  }
}

class TestMockImuProvider implements IImuProvider {
  public readonly name = "TestMockImuProvider";
  private status: ProviderStatus = "idle";
  private listeners = new Set<ImuListener>();

  public getStatus(): ProviderStatus {
    return this.status;
  }
  public async start(): Promise<void> {
    this.status = "active";
  }
  public async stop(): Promise<void> {
    this.status = "stopped";
  }
  public addListener(listener: ImuListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public emitSample(sample: ImuSample): void {
    for (const l of this.listeners) l(sample);
  }
}

// ---------------------------------------------------------------------------
// Synthetic Overpass OSM Element Generator
// ---------------------------------------------------------------------------

function createMockOverpassWay(
  id: number,
  points: Array<{ lat: number; lon: number }>,
  tags: Record<string, string> = {},
) {
  return {
    type: "way" as const,
    id,
    nodes: points.map((_, i) => 1000 + i),
    geometry: points,
    tags: {
      highway: "primary",
      name: "Test Road",
      ...tags,
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite Execution
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n===============================================================");
  console.log("  BetterMaps Phase 3: Live IDR Integration & Stack Tests");
  console.log("===============================================================\n");

  // =========================================================================
  // TEST 1: OsmOverpassRoadDataSource Bounding Box & Element Parsing
  // =========================================================================
  await runTest("OsmOverpassRoadDataSource — tile key mapping & element parsing", () => {
    const source = new OsmOverpassRoadDataSource();

    // 1. Degree tile key
    const degKey = createDegreeTileKey(5240, -151, 0.01);
    const bboxDeg = source.tileKeyToBoundingBox(degKey);
    assert(bboxDeg !== null, "Degree tile bounding box should not be null");
    assertClose(bboxDeg!.minLat, 52.40, 1e-4, "BBox minLat");
    assertClose(bboxDeg!.maxLat, 52.41, 1e-4, "BBox maxLat");
    assertClose(bboxDeg!.minLon, -1.51, 1e-4, "BBox minLon");
    assertClose(bboxDeg!.maxLon, -1.50, 1e-4, "BBox maxLon");

    // 2. Slippy tile key
    const slippyKey = createSlippyTileKey(14, 8192, 5446);
    const bboxSlippy = source.tileKeyToBoundingBox(slippyKey);
    assert(bboxSlippy !== null, "Slippy tile bounding box should not be null");
    assert(bboxSlippy!.minLat < bboxSlippy!.maxLat, "Slippy minLat < maxLat");
    assert(bboxSlippy!.minLon < bboxSlippy!.maxLon, "Slippy minLon < maxLon");

    // 3. Parse OSM elements into RoadTile
    const mockElements = [
      createMockOverpassWay(
        101,
        [
          { lat: 52.408, lon: -1.512 },
          { lat: 52.409, lon: -1.511 },
          { lat: 52.410, lon: -1.510 },
        ],
        {
          name: "Warwick Road",
          highway: "primary",
          oneway: "yes",
          maxspeed: "30 mph",
          lanes: "2",
        },
      ),
      createMockOverpassWay(
        102,
        [
          { lat: 52.409, lon: -1.511 },
          { lat: 52.409, lon: -1.505 },
        ],
        {
          name: "Kenilworth Road",
          highway: "secondary",
          maxspeed: "40",
        },
      ),
    ];

    const tile = source.parseOsmElementsToTile(degKey, bboxDeg!, mockElements as any);
    assert(tile.segments.length === 2, "Should parse 2 road segments");
    assert(tile.segments[0].id === "osm_w_101", "Segment 1 ID");
    assert(tile.segments[0].name === "Warwick Road", "Segment 1 name");
    assert(tile.segments[0].directionality === "forward_only", "Segment 1 directionality forward_only");
    assert(tile.segments[0].oneWay === true, "Segment 1 oneWay true");
    assertClose(tile.segments[0].speedLimitMps!, 13.41, 0.1, "Speed limit 30 mph in mps");
    assert(tile.segments[0].laneCount === 2, "Lane count 2");
    assert(tile.segments[0].geometry!.length === 3, "Geometry has 3 points");
    assert(tile.segments[0].lengthMeters > 50, "Segment length > 50m");

    // Check topology nodes & intersections
    assert(tile.nodes!.length >= 2, "Topology nodes created");
    assert(tile.intersections!.length >= 1, "Intersection created at shared node");
    assert(
      tile.intersections![0].outboundSegmentIds.includes("osm_w_101") &&
        tile.intersections![0].outboundSegmentIds.includes("osm_w_102"),
      "Intersection links both segments",
    );
  });

  // =========================================================================
  // TEST 2: OsmOverpassRoadDataSource Offline Fallback & Failure Resilience
  // =========================================================================
  await runTest("OsmOverpassRoadDataSource — offline fallback and safe degradation", async () => {
    // Custom failing fetch
    const failingFetch: typeof fetch = async () => {
      throw new Error("Network unreachable (offline mode)");
    };

    const source = new OsmOverpassRoadDataSource({
      fetchFn: failingFetch,
      offlineFixturesDir: "assets/datasets/road_tiles_test",
      minRequestIntervalMs: 0,
    });

    // Coventry East tile exists in assets/datasets/road_tiles_test/
    const coventryEastKey = createDegreeTileKey(5240, -151, 0.01);
    const tile = await source.fetchTile(coventryEastKey);
    assert(tile !== null, "Should load tile from offline fixture directory when network fails");
    assert(tile!.segments.length > 0, "Loaded offline tile has segments");

    // Uncached / non-existent key: should degrade gracefully to null without throwing
    const nonExistentKey = createDegreeTileKey(9999, 9999, 0.01);
    const nullTile = await source.fetchTile(nonExistentKey);
    assert(nullTile === null, "Should return null for missing tile without throwing");

    const diag = source.getDiagnostics();
    assert(diag.queryCount === 2, "Query count tracked");
    assert(diag.fallbackCount >= 1, "Fallback count tracked");
    assert(diag.failureCount >= 1, "Failure count tracked");
  });

  // =========================================================================
  // TEST 3: NavigationManager Production Dual-Stream Setup
  // =========================================================================
  await runTest("NavigationManager — 50 Hz IMU + 1 Hz GNSS normal driving stream", async () => {
    const mockLoc = new TestMockLocationProvider();
    const mockImu = new TestMockImuProvider();
    const streamGate = new GnssStreamGate();

    const nav = new NavigationManager(
      undefined, // Default to production ESKF stack
      streamGate,
      undefined,
      mockImu,
      mockLoc,
    );

    await nav.start();

    let telemetryCount = 0;
    nav.subscribeTelemetry(() => {
      telemetryCount++;
    });

    // 1. First GNSS fix establishes tangency origin and heading
    const initialGnss: NavLocation = {
      latitude: 52.4080,
      longitude: -1.5120,
      altitude: 100,
      accuracy: 3.0,
      speed: 10.0,
      heading: 90.0, // Heading East
      timestamp: 1000,
      providerType: "mock",
      isDeadReckoning: false,
    };
    mockLoc.emitLocation(initialGnss);

    let tel = nav.getTelemetry();
    assert(tel.locationSource === "SIMULATOR" || tel.locationSource === "GNSS", "Initial source GNSS/SIMULATOR");
    assertClose(tel.currentLocation!.latitude, 52.4080, 1e-4, "Initial lat");
    assertClose(tel.currentLocation!.longitude, -1.5120, 1e-4, "Initial lon");
    assert(tel.isDeadReckoning === false, "Not dead reckoning");

    // 2. Stream 50 IMU samples at 50 Hz (1 second) driving East at 10 m/s
    let t = 1000;
    for (let i = 0; i < 50; i++) {
      t += 20;
      mockImu.emitSample({
        timestamp: t,
        accel: { x: 0, y: 0, z: 9.81 },
        gyro: { x: 0, y: 0, z: 0 },
      });
    }

    tel = nav.getTelemetry();
    assert(tel.currentPositionEstimate !== null, "Position estimate exists");
    assert(tel.currentPositionEstimate!.valid === true, "Position estimate is valid");
    assert(tel.isDeadReckoning === false, "Normal driving is not dead reckoning");
    assert(tel.historyTrail.length >= 1, "History trail recorded points");

    await nav.stop();
  });

  // =========================================================================
  // TEST 4: Outage Behavior & Road Constraint Causal Action
  // =========================================================================
  await runTest("Outage Behavior — GNSS blocked -> IDR dead-reckoning -> road constraint applied", async () => {
    const mockLoc = new TestMockLocationProvider();
    const mockImu = new TestMockImuProvider();
    const streamGate = new GnssStreamGate();

    // Setup production stack with a road segment
    const stack = createProductionPositioningStack();

    // Register a realistic road segment aligned with the trajectory
    // Eastward road from (52.4080, -1.5120) to (52.4080, -1.5050)
    stack.provider.registerTile({
      key: createDegreeTileKey(5240, -151, 0.01),
      bounds: { minLat: 52.40, maxLat: 52.41, minLon: -1.52, maxLon: -1.50 },
      segments: [
        {
          id: "coventry_east_road",
          name: "Kenilworth Road",
          startPoint: { latitude: 52.4080, longitude: -1.5120 },
          endPoint: { latitude: 52.4080, longitude: -1.5050 },
          lengthMeters: 476.0,
          bearingDeg: 90.0,
          directionality: "two_way",
          roadClass: "primary",
          speedLimitMps: 13.9,
        },
      ],
    });

    const nav = new NavigationManager(
      stack.positioningEngine,
      streamGate,
      stack.roadDataManager,
      mockImu,
      mockLoc,
    );

    await nav.start();

    // 1. Establish initial fix
    mockLoc.emitLocation({
      latitude: 52.4080,
      longitude: -1.5120,
      altitude: 100,
      accuracy: 2.0,
      speed: 10.0,
      heading: 90.0,
      timestamp: 2000,
      providerType: "mock",
      isDeadReckoning: false,
    });

    const initialGnssDelivered = stack.positioningEngine.getGnssDeliveredCount();
    assert(initialGnssDelivered === 1, "Initial GNSS delivered");

    // 2. Trigger simulated GNSS outage!
    nav.setGnssStreamGate("GNSS_STREAM_DISABLED");
    assert(streamGate.getState() === "GNSS_STREAM_DISABLED", "Gate disabled");

    let tel = nav.getTelemetry();
    assert(tel.locationSource === "GNSS STREAM BLOCKED", "Location source reflects GNSS blocked");
    assert(tel.positioningStatus === "GNSS_BLOCKED_SIMULATED", "Engine in outage state");

    // 3. Emit incoming GNSS fixes during outage: should be 100% blocked
    for (let g = 0; g < 5; g++) {
      mockLoc.emitLocation({
        latitude: 52.4080,
        longitude: -1.5120,
        altitude: 100,
        accuracy: 2.0,
        speed: 10.0,
        heading: 90.0,
        timestamp: 2100 + g * 1000,
        providerType: "mock",
        isDeadReckoning: false,
      });
    }

    assert(
      stack.positioningEngine.getGnssDeliveredCount() === initialGnssDelivered,
      "Zero GNSS fixes leaked through the gate during outage!",
    );

    // 4. Feed 100 IMU samples at 50 Hz (2 seconds of dead-reckoning)
    // Vehicle moves East along road at ~10 m/s with small lateral disturbance
    let t = 2000;
    const initialLon = tel.currentLocation!.longitude;

    for (let i = 0; i < 100; i++) {
      t += 20;
      mockImu.emitSample({
        timestamp: t,
        accel: { x: 0.1, y: 0.0, z: 9.81 },
        gyro: { x: 0, y: 0, z: 0 },
      });
    }

    tel = nav.getTelemetry();

    // 5. Verify IDR status and coordinate progression
    assert(tel.isDeadReckoning === true, "Telemetry confirms isDeadReckoning = true");
    assert(tel.currentPositionEstimate!.isDeadReckoning === true, "Position estimate confirms dead reckoning");
    assert(tel.currentPositionEstimate!.position_source === "IDR", "Position source is IDR");

    // Prove vehicle dead-reckoned forward
    assert(tel.currentLocation!.longitude > initialLon, "Vehicle longitude progressed Eastward during outage!");

    // Prove road constraint applied
    const roadUpdates = stack.positioningEngine.getRoadUpdateCount();
    assert(roadUpdates > 0, `Road constraint applied during outage! (count = ${roadUpdates})`);

    await nav.stop();
  });

  // =========================================================================
  // TEST 5: GNSS Recovery Convergence
  // =========================================================================
  await runTest("GNSS Outage Recovery — smooth Kalman convergence without jumps or NaNs", async () => {
    const mockLoc = new TestMockLocationProvider();
    const mockImu = new TestMockImuProvider();
    const streamGate = new GnssStreamGate();
    const stack = createProductionPositioningStack();

    const nav = new NavigationManager(
      stack.positioningEngine,
      streamGate,
      stack.roadDataManager,
      mockImu,
      mockLoc,
    );

    await nav.start();

    // Initial fix
    mockLoc.emitLocation({
      latitude: 52.4080,
      longitude: -1.5120,
      altitude: 100,
      accuracy: 2.0,
      speed: 10.0,
      heading: 90.0,
      timestamp: 3000,
      providerType: "mock",
      isDeadReckoning: false,
    });

    // Outage for 1 second (50 IMU samples)
    nav.setGnssStreamGate("GNSS_STREAM_DISABLED");
    let t = 3000;
    for (let i = 0; i < 50; i++) {
      t += 20;
      mockImu.emitSample({
        timestamp: t,
        accel: { x: 0, y: 0, z: 9.81 },
        gyro: { x: 0, y: 0, z: 0 },
      });
    }

    let outageTel = nav.getTelemetry();
    assert(outageTel.isDeadReckoning === true, "Was in dead-reckoning");
    const outagePosUncertainty = outageTel.currentPositionEstimate!.horizontal_accuracy!;

    // Recovery: Re-enable GNSS stream gate
    nav.setGnssStreamGate("GNSS_STREAM_ENABLED");
    assert(streamGate.getState() === "GNSS_STREAM_ENABLED", "Gate re-enabled");

    // Deliver recovering GNSS fix at t = 4050ms
    const recoveredFix: NavLocation = {
      latitude: 52.4080,
      longitude: -1.5105,
      altitude: 100,
      accuracy: 2.0,
      speed: 10.0,
      heading: 90.0,
      timestamp: 4050,
      providerType: "mock",
      isDeadReckoning: false,
    };
    mockLoc.emitLocation(recoveredFix);

    const recoveredTel = nav.getTelemetry();
    assert(recoveredTel.isDeadReckoning === false, "Recovered: isDeadReckoning = false");
    assert(recoveredTel.positioningStatus === "GNSS_AVAILABLE", "Status: GNSS_AVAILABLE");
    assert(!isNaN(recoveredTel.currentLocation!.latitude), "No NaN in recovered latitude");
    assert(!isNaN(recoveredTel.currentLocation!.longitude), "No NaN in recovered longitude");
    assert(
      recoveredTel.currentPositionEstimate!.horizontal_accuracy! < outagePosUncertainty,
      "Position uncertainty contracted upon GNSS recovery measurement update!",
    );

    await nav.stop();
  });

  // =========================================================================
  // TEST 6: Route Mode vs Free-Drive Mode Lifecycle in NavigationManager
  // =========================================================================
  await runTest("Route Mode vs Free-Drive Mode — prefetch lifecycle & route constraints", async () => {
    const mockLoc = new TestMockLocationProvider();
    const mockImu = new TestMockImuProvider();
    const streamGate = new GnssStreamGate();
    const stack = createProductionPositioningStack();

    const nav = new NavigationManager(
      stack.positioningEngine,
      streamGate,
      stack.roadDataManager,
      mockImu,
      mockLoc,
    );

    await nav.start();

    // In free drive initially
    let diag = nav.getRoadDataManager()!.getDiagnostics();
    assert(diag.mode === "FREE_DRIVE", "Initially in FREE_DRIVE mode");

    // Preview and start route
    const testRoute: ActiveRoute = {
      metadata: {
        id: "route_pilot_coventry",
        destinationName: "University Campus",
        destinationAddress: "Coventry, UK",
        destinationCoordinate: { latitude: 52.4150, longitude: -1.5050 },
        totalDistanceMeters: 1200,
        totalDurationSeconds: 150,
        bounds: {
          southwest: { latitude: 52.4050, longitude: -1.5150 },
          northeast: { latitude: 52.4160, longitude: -1.5040 },
        },
      },
      geometry: {
        points: [
          { latitude: 52.4080, longitude: -1.5120 },
          { latitude: 52.4100, longitude: -1.5100 },
          { latitude: 52.4150, longitude: -1.5050 },
        ],
        cumulativeDistances: [0, 500, 1200],
        totalLengthMeters: 1200,
      },
      steps: [],
    };

    nav.setRoutePreview(testRoute);
    nav.startNavigation();

    diag = nav.getRoadDataManager()!.getDiagnostics();
    assert(diag.mode === "ROUTE", "Transitions to ROUTE mode when navigation starts");
    assert(diag.activeRouteId === "route_pilot_coventry", "Active route ID set");

    // Stop navigation: reverts to free drive
    nav.stopNavigation();
    diag = nav.getRoadDataManager()!.getDiagnostics();
    assert(diag.mode === "FREE_DRIVE", "Reverts to FREE_DRIVE after stopNavigation()");
    assert(diag.activeRouteId === null, "Active route cleared");

    await nav.stop();
  });

  // =========================================================================
  // TEST 7: Estimator In-Tick Isolation & Execution Guarantee
  // =========================================================================
  await runTest("Estimator In-Tick Isolation — strictly synchronous processImu with sub-ms latency", () => {
    const stack = createProductionPositioningStack();

    // Establish origin
    stack.positioningEngine.processGnss({
      latitude: 52.4080,
      longitude: -1.5120,
      altitude: 100,
      accuracy: 3.0,
      speed: 12.0,
      heading: 90.0,
      timestamp: 5000,
      providerType: "mock",
      isDeadReckoning: false,
    });

    const sample: ImuSample = {
      timestamp: 5020,
      accel: { x: 0, y: 0.1, z: 9.81 },
      gyro: { x: 0, y: 0, z: 0 },
    };

    // Verify return type is synchronous PositionEstimate, NOT a Promise
    const result = stack.positioningEngine.processImu(sample);
    assert(result !== null, "processImu returns PositionEstimate");
    assert(
      typeof (result as any)?.then !== "function",
      "CRITICAL: processImu() must NEVER return a Promise!",
    );

    // Bench 1,000 continuous iterations
    const startMs = performance.now();
    const ITERATIONS = 1000;
    for (let i = 0; i < ITERATIONS; i++) {
      sample.timestamp += 20;
      stack.positioningEngine.processImu(sample);
    }
    const elapsedMs = performance.now() - startMs;
    const avgUs = (elapsedMs / ITERATIONS) * 1000;

    console.log(`[1,000 Sample In-Tick Latency: ${avgUs.toFixed(2)} µs/sample]`);
    assert(avgUs < 500, `Mean per-sample latency (${avgUs.toFixed(2)} µs) < 500 µs`);
  });

  // =========================================================================
  // Final Results
  // =========================================================================
  console.log("\n===============================================================");
  console.log(`  Live IDR Production Stack Results: ${passed} passed, ${failed} failed`);
  console.log("===============================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
