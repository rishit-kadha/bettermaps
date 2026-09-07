# BetterMaps — Dynamic Road Network Acquisition & Route Prefetching Architecture

**Document Type:** Architectural Design & Technical Specification  
**Status:** **PROPOSED DESIGN — REVIEW DRAFT (NO CODE CHANGES YET)**  
**Author:** Antigravity (Advanced Agentic AI)  
**Date:** September 6, 2026  
**Target Subsystems:** `RoadDataManager`, `IRoadDataSource`, `IRoadCache`, `RouteCoveragePlanner`, `FreeDriveCoveragePlanner`, `LocalRoadNetworkProvider`, `MultiCandidateRoadMatcher`, `EskfPositioningEngine`

---

## Executive Summary & Core Paradigm

The current BetterMaps prototype bundles a single, static road network dataset (`assets/datasets/road_network_coventry.json`) containing 65 synthetic road segments within a fixed $5 \times 5\,\text{km}$ bounding box in central Coventry. As proven in our forensic audit, this static approach fails completely when the vehicle operates outside that single neighborhood (such as in regional driving or across geographically diverse benchmark sessions).

This document specifies the architectural design for a **Dynamic Road Network Acquisition & Cache Layer**. The core principle is a strict, decoupled division of responsibilities:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             RESPONSIBILITY BOUNDARIES                            │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 1. Google Maps / Google Routes:  Visualization, destination search, trip routing │
│ 2. RoadDataManager:              Dynamic spatial coverage, prefetch, and cache   │
│ 3. LocalRoadNetworkProvider:     In-memory spatial hash exposing cached graph    │
│ 4. ESKF / MultiCandidateMatcher: Consuming nearby candidate roads (0 HTTP/disk)  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The positioning estimator and road matcher **must never directly touch HTTP, tile downloaders, disk I/O, routing SDKs, or Google Maps**. They query a local, in-memory spatial graph provider (`IRoadNetworkProvider`) that is dynamically kept populated by the background `RoadDataManager`.

---

## 1. Current Map & Routing Architecture vs Intended Evolution

### 1.1 Existing Architecture
Currently, the codebase operates with two decoupled paths:
1. **Live App (`NavigationManager.ts`)**:
   - Destination search via Google Places -> route calculation via Google Routes v2 (`src/services/google/routesService.ts`).
   - Yields `ActiveRoute` with 1D polyline points.
   - Position tracking defaults to `GnssPositioningEngine` (raw GPS passthrough).
2. **Replay Lab (`IovnbdReplaySource.ts`)**:
   - Replays IO-VNBD recorded sensor streams.
   - Feeds `EskfPositioningEngine`.
   - Statically loads `road_network_coventry.json` into a single `LocalRoadNetworkProvider`.

### 1.2 The Intended Architecture
```
                               USER / NAVIGATION STATE
               ┌──────────────────────────┴──────────────────────────┐
               ▼                                                     ▼
      [MODE 1: ACTIVE ROUTE]                               [MODE 2: FREE DRIVING]
      Destination entered                                   No destination set
      Google Routes API returns ActiveRoute                 Continuous vehicle movement
               │                                                     │
               ▼                                                     ▼
      RouteCoveragePlanner                                 FreeDriveCoveragePlanner
      - Route corridor buffer (W_lat)                      - Directional coverage bubble
      - Forward horizon: d_base + v * t_horizon            - Speed-dependent forward reach
               │                                                     │
               └──────────────────────────┬──────────────────────────┘
                                          ▼
                                   RoadDataManager
                     (Orchestrates spatial coverage requirements)
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
         [Check IRoadCache]                             [Missing Tiles / Cells]
         Existing valid tiles                                     │
                  │                                               ▼
                  │                                        IRoadDataSource
                  │                                   (Async background fetch:
                  │                                    OSM / Overpass / Vector)
                  │                                               │
                  └───────────────────────┬───────────────────────┘
                                          ▼
                                      IRoadCache
                      (Local persistence: LRU eviction, retention)
                                          │
                                          ▼
                              LocalRoadNetworkProvider
                           (Dynamic SpatialGridIndex in RAM)
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
         MultiCandidateRoadMatcher                  ProbabilisticRouteConstraint
         (5-factor Bayesian scoring)                (Soft polyline constraint)
                     │                                         │
                     └────────────────────┬────────────────────┘
                                          ▼
                              15-State Quaternion ESKF
```

---

## 2. Where the Static Coventry Road Graph Currently Enters

In the current codebase, the static graph enters at a single hard-coded instantiation site:

1. **Source File:** `src/services/replay/IovnbdReplaySource.ts`
   - Line 42: `import coventryRoadData from "../../../assets/datasets/road_network_coventry.json";`
   - Line 716: `const defaultRoadProvider = new LocalRoadNetworkProvider(coventryRoadData);`
   - Line 717: `const defaultRoadMatcher = new MultiCandidateRoadMatcher(defaultRoadProvider);`
   - Line 718: `const defaultRoadConstraint = new ProbabilisticRoadConstraint(defaultRoadMatcher);`
2. **Provider Implementation:** `src/adapters/road/LocalRoadNetworkProvider.ts`
   - Accepts a single static JSON object in its constructor.
   - Parses segments, nodes, and intersections once during construction.
   - Builds an immutable `SpatialGridIndex`.
   - Offers no methods to add, update, stream, or evict tiles.

---

## 3. What Needs to Become Dynamic

To support real-world navigation and regional evaluation, the following four elements must transition from static to dynamic:

| Component | Current Prototype State | Required Dynamic State |
| :--- | :--- | :--- |
| **Data Ingestion** | Single bundled JSON asset (`coventryRoadData`) | Pluggable `IRoadDataSource` fetching geographic bounding boxes or spatial tile keys asynchronously |
| **Spatial Index** | One-time immutable `SpatialGridIndex` | Dynamic `SpatialGridIndex` supporting atomic tile registration (`loadTile`) and eviction (`unloadTile`) |
| **Coverage Scope** | Fixed Coventry box $[52.385, 52.430], [-1.560, -1.480]$ | Dynamic sliding spatial corridor (Route Mode) or directional teardrop bubble (Free-Drive Mode) |
| **Lifecycle & Storage** | Transient in-memory singleton | Durable two-tier cache: In-memory active window + persistent on-disk tile store with LRU eviction |

---

## 4. Proposed Core Interfaces & Component Specifications

All contracts are defined in `src/core/navigation/road/` with **zero platform/vendor imports**.

### 4.1 Spatial Tile Contract (`RoadTile.ts`)

```typescript
export interface TileKey {
  /** Spatial indexing scheme, e.g. zoom-level / x / y or geohash */
  id: string;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface RoadTile {
  key: TileKey;
  fetchedAtTimestampMs: number;
  expiresAtTimestampMs?: number;
  segments: RoadSegment[];
  nodes: RoadNode[];
  intersections: RoadIntersection[];
  byteSize: number;
}
```

### 4.2 Road Data Source Contract (`IRoadDataSource.ts`)

```typescript
export interface IRoadDataSource {
  /** Returns human-readable source name (e.g. "OverpassRoadDataSource", "MockTileSource") */
  getSourceName(): string;

  /** Fetches road network graph for a given geographic bounding box / tile */
  fetchTile(key: TileKey, signal?: AbortSignal): Promise<RoadTile>;

  /** Returns true if this data source can operate without an active internet connection */
  isOfflineCapable(): boolean;
}
```

### 4.3 Road Cache Contract (`IRoadCache.ts`)

```typescript
export interface IRoadCache {
  /** Checks if a tile is currently available locally (in memory or on disk) */
  hasTile(tileId: string): Promise<boolean>;

  /** Retrieves a tile from cache */
  getTile(tileId: string): Promise<RoadTile | null>;

  /** Stores a tile into the local cache */
  putTile(tile: RoadTile): Promise<void>;

  /** Evicts specific tiles from the local cache */
  evictTile(tileId: string): Promise<void>;

  /** Evicts tiles based on LRU policy when exceeding storage budget */
  prune(maxBytes: number): Promise<void>;

  /** Returns list of all currently cached tile IDs */
  getAllCachedTileIds(): Promise<string[]>;
}
```

### 4.4 Road Data Manager (`RoadDataManager.ts`)

```typescript
export type RouteCoverageState =
  | "ROUTE_COVERAGE_COMPLETE"    // 100% of required horizon tiles are available
  | "ROUTE_COVERAGE_PARTIAL"     // Current active tiles present; future tiles fetching/missing
  | "ROUTE_COVERAGE_FETCHING"    // Background prefetch in progress
  | "ROUTE_COVERAGE_OFFLINE"     // Network unavailable; operating on local cache
  | "ROUTE_COVERAGE_UNAVAILABLE"; // Vehicle in region with zero cached road data

export interface RoadDataManagerConfig {
  basePrefetchDistanceMeters: number;     // e.g. 500m
  prefetchTimeHorizonSeconds: number;     // e.g. 60s
  lateralCorridorBufferMeters: number;    // e.g. 150m
  rearRetentionDistanceMeters: number;    // e.g. 1000m
  maxActiveCacheBytes: number;            // e.g. 50 MB
  tileResolutionDegrees: number;          // e.g. 0.01 deg (~1.1 km)
}

export class RoadDataManager {
  // Observes vehicle position, speed, heading, and active route
  public onPositionUpdated(pos: LatLonAlt, speedMps: number, headingDeg: number): void;
  public onRouteChanged(newRoute: ActiveRoute | null): void;

  // Lifecycle & control
  public start(): Promise<void>;
  public stop(): Promise<void>;
  public getCoverageState(): RouteCoverageState;

  // Provides the active in-memory provider to the estimator
  public getRoadNetworkProvider(): IRoadNetworkProvider;
}
```

---

## 5. Route Corridor Generation (Mode 1 — Active Route)

When a user enters a destination, Google Routes computes the primary path polyline $P = \{\mathbf{x}_1, \mathbf{x}_2, \dots, \mathbf{x}_K\}$.

```
             Lateral Corridor Buffer (W_lat ≈ 150m)
      ◄──────────────────────────────────────────────────►
       ┌──────────────────────────────────────────────────┐
       │     (Parallel Frontage Road)                     │
       │   ═══════════════════════════════════════════    │
       │               ▲                                  │
       │               │                                  │
       │   ────────────┴─────────────────────────────→   │  (Active Route)
       │               Planned Highway Path               │
       │                                                  │
       │      (Adjacent Off-Ramp / Parallel Surface Road) │
       │   ───────────────────────────────────────────    │
       └──────────────────────────────────────────────────┘
```

### 5.1 Why the Route Polyline Alone is Insufficient
During a GNSS outage in an urban canyon, underpass, or tunnel approach:
1. The vehicle's estimated position experiences lateral drift ($\sigma_{\perp} \approx 10 - 35\,\text{m}$).
2. If the downloaded road graph contains *only* the planned route line, the matcher will forcefully snap the vehicle to the route even if the driver took an unexpected off-ramp or parallel service road.
3. The road graph **must represent physical road reality**, including:
   - Parallel service roads.
   - Exit ramps, overpasses, and merging lanes.
   - Intersecting surface streets for junction disambiguation.

### 5.2 Corridor Tile Discretization Algorithm
1. The route polyline is sampled at interval $\Delta s \le \frac{1}{2} \text{TileSize}$.
2. For each sample $\mathbf{x}_k$, compute a bounding box expanded by lateral buffer $W_{lateral}$:
   $$\text{Box}_k = [\text{lat}_k \pm \Delta \text{lat}_{W}, \text{lon}_k \pm \Delta \text{lon}_{W}]$$
3. Compute the set of spatial tile indices $\mathcal{T}_{\text{corridor}} = \bigcup_{k} \text{Tiles}(\text{Box}_k)$.
4. This produces a contiguous "ribbon" of spatial tiles covering the journey.

---

## 6. Dynamic Forward Prefetching & Horizons

The forward prefetch window moves continuously with the vehicle along the corridor:

$$\text{forwardPrefetchDistance} = d_{\text{base}} + v_{\text{current}} \times t_{\text{horizon}}$$

```
                      Vehicle Position (v = 80 km/h)
                                  🚗  (Heading →)
                                   │
 ◄────────── RETENTION ───────────┼───────────────────── PREFETCH HORIZON ─────────────────────►
 [ -1000m ]      [ -500m ]        [ 0m ]        [ +500m ]       [ +1200m ]      [ +2000m ]
 [ Cached ]      [ Cached ]     [ Active ]     [ Prefetch ]    [ Prefetch ]     [ Queue ]
```

### 6.1 Speed-Adaptive Parameterization
- **Stopped / City Traffic ($v \le 5\,\text{m/s}$)**:
  - $d_{\text{prefetch}} = 400\,\text{m} + (5 \times 60) = 700\,\text{m}$ ahead.
  - Conserves network bandwidth; focuses on high-density intersection geometry.
- **Suburban Arterial ($v = 15\,\text{m/s} \approx 54\,\text{km/h}$)**:
  - $d_{\text{prefetch}} = 500\,\text{m} + (15 \times 60) = 1,400\,\text{m}$ ahead.
- **High-Speed Highway ($v = 30\,\text{m/s} \approx 108\,\text{km/h}$)**:
  - $d_{\text{prefetch}} = 800\,\text{m} + (30 \times 60) = 2,600\,\text{m}$ ahead.
  - Ensures that even approaching a long tunnel at $100\,\text{km/h}$, the entire tunnel and exit topology are fully resident in RAM well before satellite signal loss.

### 6.2 Degraded GNSS Early-Prefetch Trigger
If the positioning engine reports degrading satellite geometry ($\text{HDOP} > 3.0$ or satellite count dropping rapidly):
- The prefetch horizon multiplier is immediately expanded by $1.5\times$ to complete pending tile acquisitions before cellular/data coverage degrades inside the impending structure.

---

## 7. Mode 2 — Free Driving / No Active Route

When the user has not selected a destination, BetterMaps must still provide seamless dead reckoning. Without a planned route, the system constructs a **Directional Coverage Bubble** biased along the vehicle's instantaneous heading:

```
                            Movement Heading (θ)
                                     ▲
                                     │
                             ┌───────┴───────┐
                             │               │
                             │               │
                             │   PREFETCH    │
                             │    HORIZON    │  (d_fwd = 800m - 2000m)
                             │               │
                             │               │
                       ┌─────┴───────────────┴─────┐
                       │             🚗            │
                       │          (Vehicle)        │
                       │                           │
                       │       LATERAL BUFFER      │  (W_lat ≈ 300m)
                       └─────────────┬─────────────┘
                                     │
                             [REAR RETENTION]  (d_rear ≈ 300m)
```

### 7.1 Free-Drive Spatial Strategy
1. Determine vehicle position $\mathbf{p}$, smoothed heading $\theta$, and speed $v$.
2. Compute the directional forward vector $\mathbf{u} = [\sin\theta, \cos\theta]$.
3. Construct an oriented bounding box centered at $\mathbf{p} + \frac{1}{2} d_{\text{fwd}} \mathbf{u}$.
4. Query spatial tile grid; tiles directly ahead receive priority 1; tiles to the immediate left/right receive priority 2; rear tiles are held in retention.
5. As the vehicle turns, the prefetch fan rotates smoothly, adjusting the background queue.

---

## 8. Cache Retention & Multi-Tier Eviction Architecture

To prevent memory bloat on low-end mobile devices while avoiding repeated network requests, caching is organized into **three operational tiers**:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             THREE-TIER CACHE DESIGN                              │
├──────────────────────────────────────────────────────────────────────────────────┤
│ TIER 1: In-Memory Active Spatial Hash (SpatialGridIndex in RAM, ~5 - 10 MB)      │
│         - Holds tiles within Active and Immediate Prefetch zones                 │
│         - O(1) amortized candidate lookup (<0.1 ms per ESKF tick)                │
├──────────────────────────────────────────────────────────────────────────────────┤
│ TIER 2: Local SQLite / JSON Document Cache (Flash Storage, ~50 - 100 MB)         │
│         - Persisted on device via IStorageDriver / FileStorageDriver             │
│         - Survives app restarts and process kills                                │
│         - Indexed by TileKey with LRU timestamp tracking                         │
├──────────────────────────────────────────────────────────────────────────────────┤
│ TIER 3: Bundled Regional Base Fallback (Read-Only Bundle Asset)                  │
│         - High-priority static package (e.g. city centers or test regions)       │
│         - Zero network dependency                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 8.1 Retention Zone (Preventing Churn)
- Tiles behind the vehicle are **retained in RAM for at least $1,000\,\text{m}$ or 5 minutes of travel time**.
- If a driver makes a U-turn or misses a turn, the road data for the road they just traversed is already in memory.
- Eviction from RAM is based on Euclidean distance from current vehicle position:
  $$\text{Distance}(\text{Tile}, \mathbf{p}_{\text{veh}}) > d_{\text{retention}} \implies \text{Unload to Disk}$$

---

## 9. Handling Route Changes & Re-Routing

When the driver departs from the planned route:

```
        Original Planned Corridor (Cancelled)
     ═══════════════════════════════════════════════► (Aborted)
                     \
                      \  Vehicle turns onto unpredicted side road
                       ▼
                     🚗  [Deviation Detected]
                       \
                        \  New Route Recalculated by Google Routes
                         ▼
     ───────────────────────────────────────────────► New Corridor (Active)
```

1. **Immediate Fallback to Free-Drive Bubble**:
   The instant the vehicle departs the corridor by $>W_{lateral}$, `RoadDataManager` immediately activates the `FreeDriveCoveragePlanner` around the current vehicle position so road matching never experiences a void.
2. **New Route Ingestion**:
   When `NavigationManager` completes recalculation and emits the new `ActiveRoute`:
   - `RouteCoveragePlanner` generates the new tile set $\mathcal{T}_{\text{new}}$.
   - Intersection $\mathcal{T}_{\text{new}} \cap \mathcal{T}_{\text{cached}}$ is retained without network traffic.
   - Non-overlapping tiles ahead on the new corridor are queued for immediate download.
   - Pending download tasks for the abandoned corridor are cancelled immediately via `AbortController`.

---

## 10. Offline Behavior & Graceful Degradation

A fundamental architectural rule of BetterMaps is:
**ROAD DATA IS AN OPTIONAL BAYESIAN MEASUREMENT SOURCE, NOT A PREREQUISITE FOR FILTER EXECUTION.**

```
                     IS ROAD DATA AVAILABLE FOR CURRENT POSITION?
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼ YES                                       ▼ NO
         Execute Road Matcher                        Bypass Road Update Cleanly
                    │                                           │
                    ▼                                           ▼
         Candidate Accepted?                         ESKF continues propagation:
          ├── YES: eskf.updateSoftPosition()         - IMU integration
          └── NO:  Skip road update                  - ML motion model (v_fwd, yaw)
                    │                                - Non-Holonomic Constraints (NHC)
                    └─────────────────────┬─────────────────────┘
                                          ▼
                             Valid PositionEstimate Emitted
```

### Degradation Hierarchy:
1. **Full Coverage (`ROUTE_COVERAGE_COMPLETE`)**:
   ESKF fuses IMU + ML + NHC + Road observation updates + Route constraint.
2. **Partial Coverage (`ROUTE_COVERAGE_PARTIAL`)**:
   ESKF fuses road constraints where available; skips cleanly when traversing uncached tiles.
3. **Zero Road Coverage (`ROUTE_COVERAGE_OFFLINE` / `UNAVAILABLE`)**:
   ESKF runs pure inertial dead reckoning (`TinyCausalTCN` + ESKF + NHC). Position estimates remain continuous, smooth, and physically bounded without NaN values or exceptions.

---

## 11. How the Cached Graph Reaches `LocalRoadNetworkProvider`

To preserve the sub-millisecond execution budget of the ESKF, `LocalRoadNetworkProvider` must not query disk or network on every tick.

### The Dynamic Graph Bridge:
```typescript
export class DynamicRoadNetworkProvider implements IRoadNetworkProvider {
  private readonly spatialIndex = new SpatialGridIndex();
  private readonly loadedTiles = new Map<string, RoadTile>();

  // Synchronous O(1) query for ESKF
  public findNearbySegments(center: LatLonAlt, radiusMeters: number): RoadSegment[] {
    return this.spatialIndex.queryRadius(center, radiusMeters);
  }

  // Invoked asynchronously by RoadDataManager in the background
  public registerTile(tile: RoadTile): void {
    if (this.loadedTiles.has(tile.key.id)) return;
    this.loadedTiles.set(tile.key.id, tile);
    this.spatialIndex.addSegments(tile.segments);
  }

  public evictTile(tileId: string): void {
    const tile = this.loadedTiles.get(tileId);
    if (!tile) return;
    this.spatialIndex.removeSegments(tile.segments.map(s => s.id));
    this.loadedTiles.delete(tileId);
  }

  public isOffline(): boolean {
    return true; // Queries are 100% in-memory; zero network latency
  }
}
```

- **Execution Guarantee:** `findNearbySegments` is **strictly synchronous** and takes $<0.05\,\text{ms}$, maintaining the $10\,\text{ms}$ (100 Hz) tick budget on Snapdragon 7-series processors.

---

## 12. Provider Neutrality & Decoupling

The architecture enforces strict modular boundaries:
- **Core Layer (`src/core/navigation/road/`)**:
  - Contains `IRoadDataSource`, `IRoadCache`, `RoadDataManager`, `RouteCoveragePlanner`, `FreeDriveCoveragePlanner`.
  - Zero imports from Google Maps, MapLibre, OpenStreetMap Overpass, SQLite, or React Native.
- **Adapter Layer (`src/adapters/road/`)**:
  - `OverpassRoadDataSource`: Queries OSM Overpass API or vector tile servers.
  - `SqliteRoadCache`: Backed by SQLite or file system.
  - `DynamicRoadNetworkProvider`: Manages spatial indexing.
  - `BundledJsonRoadDataSource`: Loads static regional fallback datasets.

Switching from OpenStreetMap to an enterprise road graph, custom municipal GIS server, or vector tile endpoint requires **zero changes to the ESKF, matcher, or route coverage planners**.

---

## 13. Exact Road Data Required by the Estimator

The estimator requires only a lean geometric-topological graph:

| Field | Type | Purpose in Estimator | Required? |
| :--- | :--- | :--- | :---: |
| **`id`** | `string` | Unique identifier for continuity and tracking | **YES** |
| **`geometry`** | `LatLonAlt[]` | Multi-point polyline for orthogonal distance projection ($\mathbf{p}_{proj}$) | **YES** |
| **`startPoint` / `endPoint`** | `LatLonAlt` | Vector endpoints for bounding box and heading | **YES** |
| **`bearingDeg`** | `number` | Direction angle for heading alignment scoring $S_{heading} = \cos(\Delta\theta)$ | **YES** |
| **`directionality`** | `SegmentDirectionality` | Penalizes wrong-way traversal on one-way streets ($S_{dir}$) | **YES** |
| **`speedLimitMps`** | `number` | Velocity consistency gating | Optional |
| **`roadClass`** | `string` | Prior weight bonus (highway vs alleyway) | Optional |
| **`startNodeId` / `endNodeId`** | `string` | Topological adjacency for continuity bonus $S_{topo}$ | **YES** |
| **`streetName` / `toll` / `surface`** | `string` | Metadata for UI; ignored by filter | **NO** |

---

## 14. Zero Reference-Trajectory Leakage in Benchmark Evaluation

In replay evaluation (e.g. IO-VNBD), ground truth reference coordinates must remain untainted:

```
                  IO-VNBD Dataset Recording
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   [Sensor Input: IMU]             [Reference Coordinates: Ground Truth]
   Fed to ESKF Pipeline            STRICTLY RESERVED FOR ERROR SCORING:
                                   e(t) = ||p_est(t) - p_ref(t)||
                                              │
                                              ▼
                                   [LEAKAGE FIREWALL]
                                   Must NEVER be used to:
                                   - Generate synthetic road segments
                                   - Define route polylines
                                   - Nudge the filter state
```

### Safeguards:
1. `IRoadDataSource` in benchmark mode fetches the actual road network corresponding to the session's geographic coordinates from an **independent map database** (e.g. OSM for Uttoxeter or Worcester), NOT by extracting the vehicle's driving path.
2. Route corridors for benchmark evaluation are generated by querying an external routing engine from the session's start coordinate to end coordinate, producing realistic alternative paths and intersections.

---

## 15. Supporting Regional IO-VNBD Evaluation Sessions

With dynamic prefetching, BetterMaps can effortlessly evaluate across all 11 IO-VNBD test sessions:

| Session | Region | Coordinates | Dynamic Prefetch Action |
| :--- | :--- | :---: | :--- |
| **`M`** | Coventry City Center | $[52.402, -1.502]$ | Fetches $1\,\text{km}$ corridor covering Coventry shopping district |
| **`S2`** | Tile Hill, Coventry | $[52.403, -1.557]$ | Fetches Tile Hill arterial corridors |
| **`Vta10`** | Uttoxeter, Staffordshire | $[52.883, -1.738]$ | Fetches rural A518 corridor & junction network |
| **`Vta15`** | Ashbourne, Derbyshire | $[52.965, -1.750]$ | Fetches A515 Derbyshire road network |
| **`Vta21`** | Leek, Peak District | $[53.041, -1.805]$ | Fetches winding rural road graph |
| **`Vtb10`** | Atherstone, Warwickshire | $[52.558, -1.483]$ | Fetches B4116 corridor |
| **`Vtb12`** | Nuneaton, Warwickshire | $[52.553, -1.463]$ | Fetches Nuneaton urban network |
| **`Vtb4`** | Bakewell, Derbyshire | $[53.171, -1.674]$ | Fetches Peak District park roads |
| **`Vw14b`** | Bromsgrove, Worcestershire | $[52.352, -2.053]$ | Fetches A38 highway & frontage roads |
| **`Vw8`** | Worcester, Worcestershire | $[52.202, -2.200]$ | Fetches Worcester river crossing & city network |

The identical positioning engine executes across all 11 sessions, dynamically loading and caching each region's real road network as the vehicle drives.

---

## 16. Implementation Roadmap (Phased Approach)

To ensure zero disruption to current verified ESKF mathematics, implementation should proceed in three distinct, reviewable phases:

1. **Phase 1: Dynamic Spatial Graph & Cache Contracts (`src/core/navigation/road/`)**
   - Create `IRoadDataSource`, `IRoadCache`, `TileKey`, `RoadTile`.
   - Upgrade `LocalRoadNetworkProvider` to `DynamicRoadNetworkProvider` supporting runtime segment addition and eviction.
   - Make `ProbabilisticRoadConstraint.evaluateAndApply()` strictly synchronous.
2. **Phase 2: Pluggable Data Sources & Coverage Planners (`src/adapters/road/` & `src/core/`)**
   - Implement `RouteCoveragePlanner` (corridor extraction around `ActiveRoute`).
   - Implement `FreeDriveCoveragePlanner` (directional heading bubble).
   - Implement `RoadDataManager` coordinator.
   - Create offline tile package source for the 11 IO-VNBD test sessions.
3. **Phase 3: Real Navigation & Replay Integration**
   - Connect `RoadDataManager` to `NavigationManager` in the live app.
   - Connect `RoadDataManager` to `IovnbdReplaySource` in Replay Lab.
   - Verify real-time 100 Hz performance and zero reference leakage on the physical OnePlus Nord CE4.
