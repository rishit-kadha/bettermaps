/**
 * DynamicRoadRealDataValidation.test.ts
 *
 * Comprehensive Phase 1.5 validation test suite proving that the Phase 1 dynamic
 * road tile architecture works with REAL road-network tile data.
 *
 * 5 Required Pillars:
 * 1. Dynamic loading & eviction with real Coventry road geometry (multi-tile ownership & isolated eviction)
 * 2. Geographic benchmark coverage table (all 10 IO-VNBD sessions evaluated against real tiles / offline availability)
 * 3. Real road data -> 15-state ESKF causality (state contraction & retention across 3 distinct real tiles)
 * 4. Explicit same-tick pipeline execution order proof via test-harness method spies
 * 5. Estimator I/O isolation (zero filesystem calls, zero network calls, zero Promises in the estimation loop)
 *
 * ARCHITECTURAL INVARIANTS:
 * - Real road network geometry only (zero fake/interpolated roads from trajectories).
 * - Zero production code modifications (instrumentation strictly in test harness).
 * - Strict offline execution (zero network requests).
 */

import { SpatialGridIndex } from "../../src/adapters/road/SpatialGridIndex";
import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import {
  RoadTile,
  createDegreeTileKey,
  serializeTileKey,
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
import { headingFromQuatDeg } from "../../src/core/positioning/eskf/EskfMath";

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

// Global origin (Coventry reference origin)
const ORIGIN: Wgs84Coordinate = {
  latitude: 52.408,
  longitude: -1.512,
  altitude: 100.0,
};

// Fixture paths (handles execution from both tests/ and dist_test/tests/)
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

async function main() {
  console.log("\n===============================================================");
  console.log("  BetterMaps Phase 1.5: Real Road-Network Tile Data Validation");
  console.log("===============================================================\n");

  // Verify fixtures exist
  assert(fs.existsSync(TILE_EAST_PATH), "Coventry East tile fixture must exist");
  assert(fs.existsSync(TILE_WEST_PATH), "Coventry West tile fixture must exist");
  assert(fs.existsSync(TILE_CENTRAL_PATH), "Coventry Central tile fixture must exist");
  assert(fs.existsSync(MANIFEST_PATH), "Fixture manifest must exist");

  const eastTile = loadTileFixture(TILE_EAST_PATH);
  const westTile = loadTileFixture(TILE_WEST_PATH);
  const centralTile = loadTileFixture(TILE_CENTRAL_PATH);

  // ---------------------------------------------------------------------------
  // PILLAR 1: Dynamic Loading & Eviction with Real Coventry Road Geometry
  // ---------------------------------------------------------------------------
  await runTest("Pillar 1: Dynamic Real Tile Ingestion, Multi-Tile Registration & Isolated Eviction", () => {
    const provider = new LocalRoadNetworkProvider(undefined, "DynamicRealTileProvider");

    // 1. Initial empty state
    let diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 0, "Initial provider must have 0 loaded tiles");
    assert(diag.segmentCount === 0, "Initial provider must have 0 segments");
    const emptyNearby = provider.findNearbySegments({ latitude: 52.40175, longitude: -1.5084 }, 200);
    assert(emptyNearby.length === 0, "Query on empty provider must return 0 segments");

    const matcher = new MultiCandidateRoadMatcher(provider);
    const originEnu = wgs84ToEnu({ latitude: 52.40175, longitude: -1.5084 }, ORIGIN);
    const emptyMatch = matcher.match([originEnu.east, originEnu.north], 2.0, ORIGIN);
    assert(emptyMatch === null, "Matcher on empty provider must return null");

    // 2. Register real Coventry East tile
    const regEast = provider.registerTile(eastTile);
    assert(regEast === true, "Registering East tile should return true");
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 1, "loadedTileCount should be 1 after East tile");
    assert(diag.segmentCount === eastTile.segments.length, `segmentCount should equal East tile segments (${eastTile.segments.length})`);

    // Verify matcher identifies real road name
    const matchEast = matcher.match([originEnu.east, originEnu.north], 2.0, ORIGIN);
    assert(matchEast !== null, "Matcher should find candidate on Warwick Road");
    assert(matchEast?.segment.name === "Warwick Road", `Matched segment name must be Warwick Road (got ${matchEast?.segment.name})`);
    assert(matchEast!.normalizedConfidence >= 0.65, "Warwick Road confidence must pass 0.65 threshold");

    // 3. Register real Coventry West tile (adjacent, sharing 23 boundary segments)
    const regWest = provider.registerTile(westTile);
    assert(regWest === true, "Registering West tile should return true");
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 2, "loadedTileCount should be 2 after West tile");

    // Compute expected unique segments: East (52) + West (35) - Shared (23) = 64
    const allUniqueIds = new Set([...eastTile.segments.map((s) => s.id), ...westTile.segments.map((s) => s.id)]);
    assert(diag.segmentCount === allUniqueIds.size, `Segments must be deduplicated across boundary: expected ${allUniqueIds.size}, got ${diag.segmentCount}`);

    // Query West road (Charter Avenue) to verify West tile is live
    const charterEnu = wgs84ToEnu({ latitude: 52.40165, longitude: -1.5335 }, ORIGIN);
    const matchWest = matcher.match([charterEnu.east, charterEnu.north], 86.9, ORIGIN);
    assert(matchWest !== null, "Matcher should find candidate on Charter Avenue in West tile");
    assert(matchWest?.segment.name === "Charter Avenue", `Matched segment name must be Charter Avenue (got ${matchWest?.segment.name})`);

    // 4. Register real Coventry Central tile
    const regCent = provider.registerTile(centralTile);
    assert(regCent === true, "Registering Central tile should return true");
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 3, "loadedTileCount should be 3");

    // 5. Evict East tile: verify isolated eviction preserves shared segments
    const evictEast = provider.evictTile(eastTile.key);
    assert(evictEast === true, "Evicting East tile should return true");
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 2, "loadedTileCount should be 2 after East eviction");

    // Warwick Road (s9) was UNIQUE to East tile -> must be GONE
    const warwickAfter = provider.getSegmentById("s9");
    assert(warwickAfter === null, "Unique East segment (Warwick Road s9) must be removed on eviction");

    // s5 was SHARED between East and West -> must STILL BE PRESENT
    const sharedSegAfter = provider.getSegmentById("s5");
    assert(sharedSegAfter !== null, "Shared boundary segment (s5) must remain retained in memory");
    const sharedNearby = provider.findNearbySegments(sharedSegAfter!.startPoint, 50);
    assert(sharedNearby.some((s) => s.id === "s5"), "Shared segment s5 must remain queryable in spatial index");

    // 6. Evict remaining tiles -> return to completely empty state
    provider.evictTile(westTile.key);
    provider.evictTile(centralTile.key);
    diag = provider.getDiagnostics();
    assert(diag.loadedTileCount === 0, "loadedTileCount should be 0 after all evictions");
    assert(diag.segmentCount === 0, "segmentCount should be 0 after all evictions");
  });

  // ---------------------------------------------------------------------------
  // PILLAR 2: Geographic Benchmark Coverage & Metrics Table (10 Sessions)
  // ---------------------------------------------------------------------------
  await runTest("Pillar 2: 10 IO-VNBD Benchmark Sessions Geographic Coverage & Candidate Scoring Audit", () => {
    const provider = new LocalRoadNetworkProvider(undefined, "BenchmarkCoverageProvider");
    provider.registerTile(eastTile);
    provider.registerTile(westTile);
    provider.registerTile(centralTile);

    const matcher = new MultiCandidateRoadMatcher(provider);

    const BENCHMARK_SESSIONS = [
      { id: "M", coord: { latitude: 52.40256, longitude: -1.50348 }, region: "Coventry East", testHeading: 2.0 },
      { id: "S2", coord: { latitude: 52.40314, longitude: -1.55798 }, region: "Coventry West", testHeading: 86.9 },
      { id: "Vta8", coord: { latitude: 52.86297, longitude: -1.68282 }, region: "Burton upon Trent (Staffordshire)", testHeading: 0.0 },
      { id: "Vta10", coord: { latitude: 52.88177, longitude: -1.71742 }, region: "Stretton (Staffordshire)", testHeading: 0.0 },
      { id: "Vta15", coord: { latitude: 52.96543, longitude: -1.75695 }, region: "Uttoxeter (Staffordshire)", testHeading: 0.0 },
      { id: "Vta21", coord: { latitude: 53.04053, longitude: -1.81736 }, region: "Cheadle (Staffordshire)", testHeading: 0.0 },
      { id: "Vtb12", coord: { latitude: 52.55384, longitude: -1.46679 }, region: "Nuneaton (Warwickshire)", testHeading: 0.0 },
      { id: "Vtb4", coord: { latitude: 53.17105, longitude: -1.67288 }, region: "Matlock (Derbyshire Peak District)", testHeading: 0.0 },
      { id: "Vw14b", coord: { latitude: 52.34884, longitude: -2.07422 }, region: "Bromsgrove (Worcestershire)", testHeading: 0.0 },
      { id: "Vw8", coord: { latitude: 52.20313, longitude: -2.19773 }, region: "Worcester South (Worcestershire)", testHeading: 0.0 },
    ];

    console.log("\n    ------------------------------------------------------------------------------------------------------------------");
    console.log("    Session | Region                           | Status           | Dist to Road | Candidates (45m) | Match ID | Match Conf");
    console.log("    ------------------------------------------------------------------------------------------------------------------");

    let coveredCount = 0;
    let unavailableCount = 0;

    for (const session of BENCHMARK_SESSIONS) {
      const enu = wgs84ToEnu(session.coord, ORIGIN);

      // Query nearby segments within 45m search radius
      const nearby45 = provider.findNearbySegments(session.coord, 45);
      const matchResult = matcher.match([enu.east, enu.north], session.testHeading, ORIGIN);

      // Find nearest segment across all loaded segments
      let minGlobalDist = Infinity;
      let nearestSeg: RoadSegment | null = null;
      for (const s of provider.findNearbySegments(session.coord, 100000)) {
        const dEast = (s.startPoint.longitude - session.coord.longitude) * 111111 * Math.cos((session.coord.latitude * Math.PI) / 180);
        const dNorth = (s.startPoint.latitude - session.coord.latitude) * 111111;
        const d = Math.hypot(dEast, dNorth);
        if (d < minGlobalDist) {
          minGlobalDist = d;
          nearestSeg = s;
        }
      }

      const isCovered = minGlobalDist < 2000.0;
      const statusStr = isCovered ? "COVERED" : "UNAVAILABLE";
      if (isCovered) coveredCount++;
      else unavailableCount++;

      const distStr = minGlobalDist < 1000 ? `${minGlobalDist.toFixed(0)} m` : `${(minGlobalDist / 1000).toFixed(1)} km`;
      const candIdStr = matchResult ? matchResult.segment.id : "null";
      const candConfStr = matchResult ? matchResult.normalizedConfidence.toFixed(3) : "N/A";

      console.log(
        `    ${session.id.padEnd(7)} | ${session.region.padEnd(32)} | ${statusStr.padEnd(16)} | ${distStr.padStart(12)} | ${String(nearby45.length).padStart(16)} | ${candIdStr.padStart(8)} | ${candConfStr.padStart(10)}`
      );

      // Verification invariants:
      if (!isCovered) {
        // Out-of-region benchmark coordinates must NOT have fake road matches
        assert(nearby45.length === 0, `Session ${session.id} must have 0 candidates within 45m in bundled data`);
        assert(matchResult === null, `Session ${session.id} matcher must return null`);
      }
    }
    console.log("    ------------------------------------------------------------------------------------------------------------------\n");

    assert(coveredCount === 2, "Exactly 2 sessions (M, S2) must be covered by Coventry tiles");
    assert(unavailableCount === 8, "Exactly 8 sessions must be classified as UNAVAILABLE in bundled data");

    // Verify corridor representation in Coventry tiles:
    // When vehicle drives along Warwick Road (Session M corridor), matcher MUST match
    const mCorridorEnu = wgs84ToEnu({ latitude: 52.40175, longitude: -1.5084 }, ORIGIN);
    const mMatch = matcher.match([mCorridorEnu.east, mCorridorEnu.north], 2.0, ORIGIN);
    assert(mMatch !== null, "Session M corridor on Warwick Road must match candidate");
    assert(mMatch?.segment.name === "Warwick Road", "Session M corridor candidate must be Warwick Road");

    // When vehicle drives along Charter Avenue (Session S2 corridor), matcher MUST match
    const s2CorridorEnu = wgs84ToEnu({ latitude: 52.40165, longitude: -1.5335 }, ORIGIN);
    const s2Match = matcher.match([s2CorridorEnu.east, s2CorridorEnu.north], 86.9, ORIGIN);
    assert(s2Match !== null, "Session S2 corridor on Charter Avenue must match candidate");
    assert(s2Match?.segment.name === "Charter Avenue", "Session S2 corridor candidate must be Charter Avenue");
  });

  // ---------------------------------------------------------------------------
  // PILLAR 3: Real Road Data -> 15-State ESKF Causality Across 3 Distinct Tiles
  // ---------------------------------------------------------------------------
  await runTest("Pillar 3: Real Road Data -> 15-State ESKF Causality (Contraction & Retention Across 3 Tiles)", () => {
    const provider = new LocalRoadNetworkProvider();
    provider.registerTile(eastTile);
    provider.registerTile(westTile);
    provider.registerTile(centralTile);

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher, {
      baseStdMeters: 5.0,
      inflationFactor: 0.2,
      maxCrossTrackMeters: 30.0,
    });

    const regions = [
      {
        name: "Coventry East (Warwick Road s9)",
        tile: "East",
        centerWgs: { latitude: 52.40175, longitude: -1.5084 },
        headingDeg: 2.0, // Northward
        lateralOffsetEast: 6.0,
        lateralOffsetNorth: 0.0,
      },
      {
        name: "Coventry West (Charter Avenue s22)",
        tile: "West",
        centerWgs: { latitude: 52.40165, longitude: -1.5335 },
        headingDeg: 86.9, // Eastward
        lateralOffsetEast: 0.0,
        lateralOffsetNorth: 5.0,
      },
      {
        name: "Coventry Central Hub (Hales Street s45)",
        tile: "Central",
        centerWgs: { latitude: 52.4125, longitude: -1.509 },
        headingDeg: 31.4, // NNE
        lateralOffsetEast: 5.0 * Math.sin((121.4 * Math.PI) / 180.0),
        lateralOffsetNorth: 5.0 * Math.cos((121.4 * Math.PI) / 180.0),
      },
    ];

    for (const reg of regions) {
      const eskf = new Eskf();
      const midEnu = wgs84ToEnu(reg.centerWgs, ORIGIN);

      const initEast = midEnu.east + reg.lateralOffsetEast;
      const initNorth = midEnu.north + reg.lateralOffsetNorth;

      // Initialize ESKF with orientation matching the road
      const q_init = headingToQuat(reg.headingDeg);
      const headingRad = (reg.headingDeg * Math.PI) / 180.0;
      const velEast = 10.0 * Math.sin(headingRad);
      const velNorth = 10.0 * Math.cos(headingRad);

      eskf.reset({
        positionEnu: [initEast, initNorth, 0.0],
        velocityEnu: [velEast, velNorth, 0.0],
        qNb: q_init,
        accelBias: [0.0, 0.0, 0.0],
        gyroBias: [0.0, 0.0, 0.0],
      });

      const initialErrorM = Math.hypot(reg.lateralOffsetEast, reg.lateralOffsetNorth);

      // 1. Evaluate & Apply synchronously
      const result = roadConstraint.evaluateAndApply(eskf, ORIGIN);
      assert(result.applied === true, `Road constraint must apply successfully in ${reg.name}`);
      assert(result.matchedCandidate !== undefined, `Matched candidate must be returned in ${reg.name}`);

      // 2. Same-tick position contraction verification
      const stateAfter = eskf.getState();
      const residualOffsetEast = stateAfter.positionEnu[0] - midEnu.east;
      const residualOffsetNorth = stateAfter.positionEnu[1] - midEnu.north;
      const contractedErrorM = Math.hypot(residualOffsetEast, residualOffsetNorth);

      assert(
        contractedErrorM < initialErrorM,
        `ESKF state must contract toward real road in same tick in ${reg.name} (was ${initialErrorM.toFixed(2)}m, now ${contractedErrorM.toFixed(2)}m)`
      );

      // 3. Subsequent IMU propagation retains the correction
      eskf.propagate(
        {
          timestampS: 0.1,
          accelMps2: [0.0, 0.0, 9.80665],
          gyroRadps: [0.0, 0.0, 0.0],
        },
        0.1
      );

      const stateProp = eskf.getState();
      const propOffsetEast = stateProp.positionEnu[0] - (midEnu.east + velEast * 0.1);
      const propOffsetNorth = stateProp.positionEnu[1] - (midEnu.north + velNorth * 0.1);
      const propErrorM = Math.hypot(propOffsetEast, propOffsetNorth);

      assertClose(
        propErrorM,
        contractedErrorM,
        0.05,
        `Propagated state must retain road correction in ${reg.name}`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // PILLAR 4: Explicit Same-Tick Pipeline Execution Order Proof
  // ---------------------------------------------------------------------------
  await runTest("Pillar 4: Explicit Same-Tick Pipeline Execution Order Proof (Spies in Harness)", () => {
    const provider = new LocalRoadNetworkProvider();
    provider.registerTile(eastTile);

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher);

    const routeConstraint = new ProbabilisticRouteConstraint();

    const engine = new EskfPositioningEngine({
      roadConstraint,
      routeConstraint,
    });

    // Provide stationary GNSS fixes near Warwick Road to initialize anchor
    for (let i = 0; i < 15; i++) {
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

    // Attach spies strictly in the test harness
    const callOrder: string[] = [];

    const eskf = engine.getEskf();
    const origPropagate = eskf.propagate.bind(eskf);
    eskf.propagate = function (...args: any[]) {
      callOrder.push("propagate");
      return (origPropagate as any)(...args);
    };

    const motionEstimator = engine.getMotionEstimator();
    const origEstimate = motionEstimator.estimate.bind(motionEstimator);
    motionEstimator.estimate = function (...args: any[]) {
      callOrder.push("ML");
      return (origEstimate as any)(...args);
    };

    const origNhc = eskf.updateNhc.bind(eskf);
    eskf.updateNhc = function (...args: any[]) {
      callOrder.push("NHC");
      return (origNhc as any)(...args);
    };

    const origRoad = roadConstraint.evaluateAndApply.bind(roadConstraint);
    roadConstraint.evaluateAndApply = function (...args: any[]) {
      callOrder.push("road");
      return (origRoad as any)(...args);
    };

    const origRoute = routeConstraint.evaluateAndApply.bind(routeConstraint);
    routeConstraint.evaluateAndApply = function (...args: any[]) {
      callOrder.push("route");
      return (origRoute as any)(...args);
    };

    engine.addEstimateListener(() => {
      callOrder.push("PositionEstimate");
    });

    // Process a single IMU sample
    const sample: ImuSample = {
      timestamp: 16000,
      accel: { x: 0.0, y: 1.0, z: 9.80665 },
      gyro: { x: 0.0, y: 0.0, z: 0.0 },
    };

    const estimate = engine.processImu(sample);
    assert(estimate !== null, "engine.processImu must return valid estimate");

    // Verify exact sequence
    const expectedOrder = ["propagate", "ML", "NHC", "road", "route", "PositionEstimate"];
    assert(callOrder.length === expectedOrder.length, `Call count should be ${expectedOrder.length} (got ${callOrder.length})`);
    for (let i = 0; i < expectedOrder.length; i++) {
      assert(
        callOrder[i] === expectedOrder[i],
        `Step ${i} must be '${expectedOrder[i]}' (got '${callOrder[i]}')`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // PILLAR 5: Estimator I/O Isolation Verification (Zero FS, Zero Network, Zero Promises)
  // ---------------------------------------------------------------------------
  await runTest("Pillar 5: Estimator I/O Isolation Verification (5,000 Iteration Zero-I/O Proof)", () => {
    const provider = new LocalRoadNetworkProvider();
    provider.registerTile(eastTile);

    const matcher = new MultiCandidateRoadMatcher(provider);
    const roadConstraint = new ProbabilisticRoadConstraint(matcher);
    const engine = new EskfPositioningEngine({ roadConstraint });

    for (let i = 0; i < 15; i++) {
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

    // Instrument spies on fs, http, https
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
      // 1. In-memory spatial query
      const nearby = provider.findNearbySegments({ latitude: 52.40175, longitude: -1.5084 }, 45);
      assert(!isPromise(nearby), "findNearbySegments must NOT return a Promise");

      // 2. Candidate matching
      const match = matcher.match([250.0, -695.0], 2.0, ORIGIN);
      assert(!isPromise(match), "match must NOT return a Promise");

      // 3. Road constraint evaluation
      const res = roadConstraint.evaluateAndApply(engine.getEskf(), ORIGIN);
      assert(!isPromise(res), "evaluateAndApply must NOT return a Promise");

      // 4. IMU tick processing
      const imuRes = engine.processImu({
        timestamp: 16000 + i * 10,
        accel: { x: 0.0, y: 1.0, z: 9.80665 },
        gyro: { x: 0.0, y: 0.0, z: 0.0 },
      });
      assert(!isPromise(imuRes), "processImu must NOT return a Promise");
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

    assert(fsOperationsCount === 0, `ZERO filesystem operations permitted during estimation (detected: ${fsOperationsCount})`);
    assert(netOperationsCount === 0, `ZERO network operations permitted during estimation (detected: ${netOperationsCount})`);

    const avgUs = (elapsedMs / NUM_ITERATIONS) * 1000.0;
    console.log(`[5,000 Iteration Zero-I/O Latency: ${avgUs.toFixed(2)} µs/tick total]`);
    assert(avgUs < 1000.0, `Total tick execution time must remain sub-millisecond in-memory (measured ${avgUs.toFixed(2)} µs)`);
  });

  console.log(`\n===============================================================`);
  console.log(`  Dynamic Road Real Data Validation Results: ${passed} passed, ${failed} failed`);
  console.log(`===============================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

function isPromise(val: any): boolean {
  return typeof val === "object" && val !== null && typeof val.then === "function";
}

main().catch((err) => {
  console.error("FATAL in test runner:", err);
  process.exit(1);
});
