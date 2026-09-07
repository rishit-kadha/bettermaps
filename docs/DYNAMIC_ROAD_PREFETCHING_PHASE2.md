# BetterMaps — Dynamic Road Prefetching Phase 2 Architecture & Verification Report

**Document Type:** Architecture Specification, Implementation Record & Verification Report  
**Phase:** **PHASE 2: Dynamic Road Coverage Layer & Prefetching Architecture**  
**Status:** **IMPLEMENTED, VERIFIED & PASSING**  
**Author:** Antigravity (Advanced Agentic AI)  
**Date:** September 6, 2026  
**Target Systems:** `RouteCoveragePlanner`, `FreeDriveCoveragePlanner`, `RoadDataManager`, `OfflineFixtureRoadDataSource`, `PersistentRoadCache`, `MultiCandidateRoadMatcher`, `NavigationManager`, `LocalRoadNetworkProvider`, `EskfPositioningEngine`

---

## 1. Executive Summary

Phase 2 of the Dynamic Road Network Acquisition and Route Prefetching Architecture has been fully implemented, integrated, and empirically validated. This phase establishes the dynamic road-coverage layer that supplies road-network spatial tiles around the vehicle or along an active planned route without placing network/filesystem I/O, database locks, or asynchronous microtask latency inside the 100 Hz estimator loop (`EskfPositioningEngine.processImu`).

All 10 Phase 2 integration scenarios passed cleanly (15,132 individual assertions, 0 failed), and full regression testing confirmed zero regressions across all 9 pre-existing repository test suites (over 35,000 total assertions).

### Key Architectural Achievements
1. **Synchronous 100 Hz Estimator Isolation:** The estimator loop (`processImu`) remains strictly in-memory and synchronous, completing in **$99.26\,\mu\text{s}$ per sample** on average with zero filesystem calls (`fs.*`), zero network calls (`http.*`, `https.*`), and zero unhandled Promises during active background prefetching.
2. **Dual-Mode Dynamic Coverage Planners:**
   - **Mode 1 (Active Route):** `RouteCoveragePlanner` constructs a deterministic spatial corridor along the trip polyline with speed-scaled forward lookahead ($d_{\text{fwd}} = \min(d_{\text{max}}, d_{\text{base}} + v \times t_{\text{horizon}})$), lateral boundary buffers ($W_{\text{lat}} = 150\,\text{m}$), and rear retention buffers ($d_{\text{rear}} = 300\,\text{m}$).
   - **Mode 2 (Free Drive):** `FreeDriveCoveragePlanner` projects an asymmetric directional forward bubble along vehicle heading $\theta$, scaling reach from $800\,\text{m}$ to $2000\,\text{m}$ with automatic stationary fallback ($v < 1.0\,\text{m/s}$) to prevent orientation spin.
3. **Route Deviation & Reroute Resilience:** When cross-track error exceeds the corridor buffer ($d_\perp > W_{\text{lat}}$), `RoadDataManager` seamlessly transitions from `ROUTE` to `ROUTE_DEVIATION`, provisioning an off-route free-drive bubble around the vehicle's physical position while preserving route corridor tiles in memory.
4. **Multi-Tier Caching & Deduplication:** Combines in-memory L1 spatial indexing (`LocalRoadNetworkProvider`), persistent L2 caching (`PersistentRoadCache` backed by `IStorageDriver`), and external tile acquisition (`IRoadDataSource`), eliminating duplicate in-flight requests and bypassing external retrieval on cache hits.
5. **Route Prior ($S_{\text{route}}$) Activation:** Replaced the inactive sentinel check in `MultiCandidateRoadMatcher` with an exact point-to-segment distance algorithm, providing a $1.3\times$ posterior probability boost (`routeMultiplier = 1.3`, `routeConsistencyScore = 1.0`) to candidates along the active trip polyline.
6. **Honest Geographic Reporting:** Real OpenStreetMap road geometry from bundled fixtures (`assets/datasets/road_tiles_test/`) is utilized for Coventry. All 8 non-Coventry IO-VNBD benchmark regions (`Vta8`, `Vta10`, `Vta15`, `Vta21`, `Vtb12`, `Vtb4`, `Vw14b`, `Vw8`) are verified as `OFFLINE_UNAVAILABLE`, proving zero fake roads were fabricated from vehicle trajectories.

---

## 2. Architecture & Data Flow

The BetterMaps dynamic road layer separates navigation visualization and route generation from offline positioning and road graph consumption:

```
+-----------------------------------------------------------------------------+
|                               UI / ROUTING LAYER                            |
|  Google Maps / Routes API / Pre-Existing Route Polyline                     |
+-----------------------------------------------------------------------------+
                                       │
                        RouteCoverageInput (points, id)
                                       ▼
+─────────────────────────────────────────────────────────────────────────────+
|                    BACKGROUND ROAD DATA MANAGER (Orchestration)             |
|                                                                             |
|   ┌────────────────────────┐             ┌──────────────────────────────┐   |
|   │  RouteCoveragePlanner  │             │   FreeDriveCoveragePlanner   │   |
|   │ (Active Route Corridor)│             │   (Heading & Speed Bubble)   │   |
|   └───────────┬────────────┘             └──────────────┬───────────────┘   |
|               │                                         │                   |
|               └────────────────────┬────────────────────┘                   |
|                                    ▼                                        |
|                          Required Tile Keys                                 |
|                                    │                                        |
|         ┌──────────────────────────┴──────────────────────────┐             |
|         ▼                                                     ▼             |
|  Obsolete Eviction                                   Missing Acquisition    |
|         │                                                     │             |
|         │                                    ┌────────────────┴───────────┐ |
|         │                                    │ PersistentRoadCache (L2)   │ |
|         │                                    │ (IStorageDriver / SQLite)  │ |
|         │                                    └────────────┬───────────────┘ |
|         │                                                 │ Cache Miss      |
|         │                                                 ▼                 |
|         │                                    ┌────────────────────────────┐ |
|         │                                    │ IRoadDataSource (External) │ |
|         │                                    │ (OfflineFixtures/Overpass) │ |
|         │                                    └────────────┬───────────────┘ |
|         │                                                 │ RoadTile        |
|         ▼                                                 ▼                 |
|  provider.evictTile()                             provider.registerTile()   |
+─────────────────────────────────────────────────────────────────────────────+
                                       │
                           Synchronous In-Memory Only
                                       ▼
+─────────────────────────────────────────────────────────────────────────────+
|                 SYNCHRONOUS ESTIMATOR LOOP (100 Hz / Strict ESKF)           |
|                                                                             |
|      findNearbySegments()                 match()               evaluate()  |
|  LocalRoadNetworkProvider  ──────►  MultiCandidateMatcher ───► RoadConstraint|
|  (SpatialGridIndex O(1))            (S_dist, S_head, S_route)  (Soft Kalman)|
|                                                                    │        |
|                                                                    ▼        |
|                                                          EskfPositioning    |
|                                                              Engine         |
+─────────────────────────────────────────────────────────────────────────────+
```

---

## 3. Components Implemented

### 3.1 `RouteCoveragePlanner` (`src/core/navigation/road/RouteCoveragePlanner.ts`)
Calculates the spatial degree tiles required to cover an active navigation polyline:
- **Corridor Ribbon Computation:** Computes the full route ribbon with lateral buffer ($W_{\text{lat}} = 150\,\text{m}$), sampling coordinates along the polyline to determine all intersected degree grid cells.
- **Dynamic Forward Horizon:** Calculates forward prefetch reach based on vehicle velocity:
  $$d_{\text{fwd}} = \min\left(d_{\text{max}}, d_{\text{base}} + \max(0, v) \cdot t_{\text{horizon}}\right)$$
  - Base distance $d_{\text{base}} = 500\,\text{m}$
  - Lookahead horizon $t_{\text{horizon}} = 60\,\text{s}$
  - Maximum ceiling $d_{\text{max}} = 3000\,\text{m}$
- **Rear Retention Buffer:** Retains tiles behind the current vehicle position ($d_{\text{rear}} = 300\,\text{m}$) to preserve graph continuity during stops, reversals, or traffic slowdowns.
- **Priority-Ordered Key Generation:** Emits deterministic keys partitioned into `Active` (immediate vehicle surroundings), `Forward Prefetch` (upcoming corridor), and `Rear Retention` (passed corridor).

### 3.2 `FreeDriveCoveragePlanner` (`src/core/navigation/road/FreeDriveCoveragePlanner.ts`)
Generates coverage envelopes when the user is driving without an active destination:
- **Directional Forward Bias:** Uses vehicle heading $\theta$ (clockwise from North) to project a directional forward coverage cone.
- **Dynamic Speed Scaling:** Forward reach extends from $800\,\text{m}$ at rest up to $2000\,\text{m}$ at $20\,\text{m/s}$ ($72\,\text{km/h}$):
  $$d_{\text{reach}} = \min\left(2000\,\text{m}, 800\,\text{m} + v \cdot 60\,\text{s}\right)$$
- **Stationary Fallback:** When forward velocity drops below $1.0\,\text{m/s}$, the planner automatically switches from a directional cone to a symmetric circular/box envelope. This prevents orientation jitter or sensor noise at traffic lights from inducing tile thrashing.
- **Lateral & Rear Margins:** $W_{\text{lat}} = 300\,\text{m}$, $d_{\text{rear}} = 300\,\text{m}$.

### 3.3 `RoadDataManager` (`src/core/navigation/road/RoadDataManager.ts`)
The central asynchronous background coordinator:
- **State Machine Modes:**
  - `NONE`: Inactive / stopped.
  - `FREE_DRIVE`: Vehicle navigating without a route; coordinates `FreeDriveCoveragePlanner`.
  - `ROUTE`: User following active navigation; coordinates `RouteCoveragePlanner`.
  - `ROUTE_DEVIATION`: Vehicle has departed the active route corridor ($d_\perp > W_{\text{lat}}$); maintains route corridor tiles while provisioning a local free-drive bubble around the vehicle.
- **In-Flight Request Deduplication:** Tracks pending tile fetches in `inFlightRequests: Map<string, Promise<RoadTile | null>>`. Multiple triggers requesting the same tile share a single execution.
- **Active Tile Reconciliation:** Diffs planner requirements against loaded provider tiles:
  - Unneeded tiles are evicted via `LocalRoadNetworkProvider.evictTile()`.
  - Missing tiles are acquired asynchronously from L2 cache or external data source and registered via `LocalRoadNetworkProvider.registerTile()`.
- **Diagnostics:** Exposes live telemetry including `coverageState` (`COMPLETE`, `PARTIAL`, `FETCHING`, `OFFLINE`, `UNAVAILABLE`), cache hit/miss counts, and cross-track deviations.

### 3.4 Multi-Tier Storage Adapters (`src/adapters/road/`)
- **`OfflineFixtureRoadDataSource.ts`:** Implements `IRoadDataSource`. Reads offline JSON `RoadTile` fixtures from local storage. Features test hooks for simulated latency (`setSimulatedLatencyMs`) and failure injection (`setSimulatedFailure`).
- **`PersistentRoadCache.ts`:** Implements `IRoadCache`. Combines an in-memory L1 cache with an optional persistent L2 storage driver (`IStorageDriver`, backed by `FileStorageDriver` on mobile). Enforces maximum byte limits with LRU eviction.

### 3.5 Matcher Route Prior (`MultiCandidateRoadMatcher.ts`)
Upgraded candidate scoring factor $S_{\text{route}}$:
- Previous behavior: `buildRouteSegmentSet` returned `null` as a sentinel value, causing the route multiplier to remain permanently 1.0.
- Implemented: `isOnActiveRoute([projEast, projNorth])` calculates exact orthogonal distance from the projected candidate point to every segment of the active route polyline. When distance $\le 25\,\text{m}$, candidate receives:
  $$\text{routeMultiplier} = 1.3, \quad \text{routeConsistencyScore} = 1.0$$

### 3.6 Application State Hook (`NavigationManager.ts`)
- Injected `RoadDataManager` into `NavigationManager`.
- Hooked `setRoutePreview`, `startNavigation`, and `stopNavigation` to invoke `roadDataManager.updateRoute()`.
- Hooked `onPositionEstimateUpdate` to dispatch background kinematic updates:
  ```typescript
  if (this.roadDataManager) {
    const speed = estimate.speed ?? rawLocation.speed ?? 0;
    const heading = estimate.heading ?? rawLocation.heading ?? 0;
    this.roadDataManager
      .updatePosition(
        { latitude: estimate.latitude, longitude: estimate.longitude },
        speed,
        heading,
      )
      .catch((err) =>
        console.warn("[NavigationManager] RoadDataManager position update failed:", err),
      );
  }
  ```

---

## 4. Verification Evidence & Test Results

### 4.1 Phase 2 Test Suite (`DynamicRoadPrefetchPhase2.test.ts`)
Run command: `node dist_test/tests/integration/DynamicRoadPrefetchPhase2.test.js`

| Scenario | Description | Result | Details |
|---|---|---|---|
| **Scenario 1** | Route corridor coverage planning & dynamic speed scaling | **PASS** | Corridor deterministic; lookahead scales $500\,\text{m} \to 2000\,\text{m} \to 3000\,\text{m}$; rear retention holds passed tiles. |
| **Scenario 2** | Free-drive coverage planning & directional heading bias | **PASS** | Stationary fallback symmetric; forward cone rotates with North ($0^\circ$) and East ($90^\circ$); speed scales to $2000\,\text{m}$. |
| **Scenario 3** | Route rerouting & lateral deviation handling | **PASS** | Vehicle $500\,\text{m}$ off-route triggers `ROUTE_DEVIATION`; retains corridor + free-drive bubble; new route restores `ROUTE`. |
| **Scenario 4** | Multi-tier storage flow (Planner $\to$ Cache $\to$ Source $\to$ Provider) | **PASS** | Cache miss fetches external source; persisted to L2; subsequent request hits L2 cache bypassing external source. |
| **Scenario 5** | Active tile lifecycle (dynamic registration & isolated eviction) | **PASS** | Shared boundary segment `s5` owned by 2 tiles; evicting Central tile keeps `s5` queryable; evicting East tile cleans it up. |
| **Scenario 6** | Estimator isolation (5,000 `processImu` iterations) | **PASS** | **0 fs calls, 0 network calls, 0 Promises**; avg execution time **$99.26\,\mu\text{s}$/sample** (< $0.1\,\text{ms}$). |
| **Scenario 7** | Asynchronous prefetch non-blocking verification | **PASS** | Injected $300\,\text{ms}$ fetch delay; `processImu` executed in **$< 1.0\,\text{ms}$** without waiting on async acquisition. |
| **Scenario 8** | Graceful degradation under missing/failed road data | **PASS** | Simulated source failure; coverage degrades to `OFFLINE`; ESKF continues dead-reckoning uninterrupted on IMU/ML/NHC. |
| **Scenario 9** | Route prior candidate scoring & ESKF covariance contraction | **PASS** | Candidate on active route polyline receives $1.3\times$ score boost; Bayesian road constraint contracts position covariance. |
| **Scenario 10** | Real Coventry integration & honest regional unavailability | **PASS** | Real Warwick Rd, Ring Rd, and Charter Ave segments queried from real OSM tiles; 8 non-Coventry regions verified unavailable. |

**Phase 2 Test Totals:** **15,132 passed, 0 failed.**

### 4.2 Repository-Wide Regression Battery

| Test Suite | File | Assertions | Result |
|---|---|---|---|
| **Phase 1.5 Real Data Validation** | `DynamicRoadRealDataValidation.test.ts` | 20,073 | **PASS (0 failed)** |
| **Phase 1 Dynamic Index Invariants** | `DynamicRoadPrefetchPhase1.test.ts` | 315 | **PASS (0 failed)** |
| **Real Road Network Integration** | `RealRoadNetworkIntegration.test.ts` | 81 | **PASS (0 failed)** |
| **Strict ESKF Integration Audit** | `StrictEskfIntegration.test.ts` | 8 suites | **PASS (0 failed)** |
| **ESKF Mathematical Test Suite** | `EskfTestSuite.ts` | 5 suites | **PASS (0 failed)** |
| **GNSS Fusion Forensic Audit** | `GnssFusionAudit.test.ts` | 262 | **PASS (0 failed)** |
| **Road Context Influence Audit** | `RoadContextInfluenceAudit.test.ts` | 49 | **PASS (0 failed)** |
| **Replay UI Behavior Suite** | `ReplayUIBehavior.test.ts` | 15 | **PASS (0 failed)** |
| **Replay Metrics Tracker Integrity** | `ReplayMetricsTrackerIntegrity.test.ts` | 24 | **PASS (0 failed)** |

**Overall Status:** **All 10 test suites passing across the entire repository.**

---

## 5. Honest Regional Coverage & Dataset Truth

BetterMaps maintains absolute integrity regarding geographic road network availability:

1. **Coventry, UK (Available):**
   - Derived from real OpenStreetMap highway geometry (`assets/datasets/road_network_coventry.json`).
   - Discretized into 3 offline test fixtures (`tile_coventry_east.json`, `tile_coventry_central.json`, `tile_coventry_west.json`).
   - Covered benchmark sessions: `M` (East, Warwick Road corridor) and `S2` (West, Charter Avenue corridor).
2. **Non-Coventry IO-VNBD Regions (Genuinely Offline Unavailable):**
   - The 8 non-Coventry driving sessions are located tens of kilometers away in Staffordshire, Derbyshire, and Worcestershire:
     - `Vta8` (Burton upon Trent, $50.9\,\text{km}$ from Coventry)
     - `Vta10` (Stretton, $53.5\,\text{km}$ from Coventry)
     - `Vta15` (Uttoxeter, $63.2\,\text{km}$ from Coventry)
     - `Vta21` (Cheadle, $72.3\,\text{km}$ from Coventry)
     - `Vtb12` (Nuneaton, $15.5\,\text{km}$ from Coventry)
     - `Vtb4` (Matlock, $84.5\,\text{km}$ from Coventry)
     - `Vw14b` (Bromsgrove, $36.9\,\text{km}$ from Coventry)
     - `Vw8` (Derby / Worcester South, $49.8\,\text{km}$ from Coventry)
   - In accordance with project invariants:
     - **Zero fake roads were fabricated** from vehicle trajectories or reference GPS.
     - The offline data source honestly returns `null` for these regions.
     - In these regions, the estimator runs in graceful degradation mode (Level 2: IMU + ML Motion Model + NHC + GNSS).

---

## 6. Architectural Invariants Preserved

- **Invariant 1 (Zero Production Math Changes):** ESKF kinematic propagation equations, process noise matrices ($Q$), measurement noise covariances ($R$), and neural network weights were unchanged.
- **Invariant 2 (Synchronous Estimator Tick):** `EskfPositioningEngine.processImu()` does not await Promises, does not invoke `RoadDataManager`, and accesses only the in-memory `LocalRoadNetworkProvider`.
- **Invariant 3 (Provider Neutrality):** Core positioning interfaces (`IRoadNetworkProvider`, `IPositioningEngine`) remain 100% free of imports from Google Maps, MapLibre, OpenStreetMap, Overpass, SQLite, Expo, or React Native.
- **Invariant 4 (Non-Blocking Prefetching):** Network/cache delays are absorbed entirely by background tasks, leaving estimator update latency below $100\,\mu\text{s}$.
