# Road Network & Route Layer Forensic Audit

**Document Version:** 1.0.0  
**Status:** COMPLETE (Phase 1 Baseline Audit)  
**Date:** September 2026  
**Target:** BetterMaps Mobile IDR Navigation Pipeline

---

## 1. Executive Summary

This document performs an exhaustive audit of the road network and route navigation layer within the BetterMaps / Seamless IDR codebase. Following the implementation and numerical verification of the 15-state mobile Error-State Kalman Filter (ESKF), Non-Holonomic Constraints (NHC), and learned motion models, the navigation stack requires a real, provider-neutral road network provider and a persistent offline route storage layer to enable production road- and route-constrained dead-reckoning.

---

## 2. Current Interfaces & Architectural Contracts

### 2.1 Routing Subsystem (`src/core/navigation/routing/`)

1. **`IRoutingProvider.ts`**:
   - `calculateRoute(origin, destination, waypoints?, options?): Promise<NormalizedRoute>`
   - `getProviderName(): string`
   - `isOfflineCapable(): boolean`
   - _Contract Evaluation:_ Clean, provider-neutral contract. Decoupled from Google Directions, OSRM, GraphHopper, or MapLibre APIs.

2. **`RoutingTypes.ts`**:
   - `LatLonAlt`: Metric/degree coordinates (`latitude`, `longitude`, `altitudeM?`).
   - `RouteWaypoint`: Waypoint with optional human-readable name.
   - `RouteSegment`: Segment with indices, endpoints, distance, and bearing.
   - `NormalizedRoute`: Provider-neutral route model containing `polylinePoints`, `totalDistanceMeters`, `estimatedDurationSeconds`, `sourceProvider`, and `creationTimestampMs`.
   - `PreExistingRoute`: Type alias to `NormalizedRoute`, establishing the semantic prior of a planned trip route.
   - `EvaluationReferenceTrajectory`: Strictly branded type (`_brand: "EvaluationReferenceTrajectory"`) reserved for evaluation scoring, preventing reference leakage.

3. **`OfflineRouteStore.ts`**:
   - Implements `IOfflineRouteStore`: `saveRoute()`, `getRoute()`, `getActiveRoute()`, `setActiveRoute()`, `getAllRoutes()`, `clear()`, `exportJson()`, `importJson()`.
   - _Current Implementation:_ Uses an in-memory `Map<string, NormalizedRoute>()`.
   - _Defect:_ **Volatile.** Loses all cached routes upon app reload, process restart, or OS memory reclamation.

### 2.2 Road Network Subsystem (`src/core/navigation/road/`)

1. **`IRoadNetworkProvider.ts`**:
   - `findNearbySegments(center: LatLonAlt, radiusMeters: number): Promise<RoadSegment[]> | RoadSegment[]`
   - `getSegmentById(id: string): RoadSegment | null`
   - `getProviderName(): string`
   - `isOffline(): boolean`
   - _Contract Evaluation:_ Sound high-level interface, but lacks methods for topological adjacency (`getOutboundSegments`, `getIntersections`).

2. **`RoadTypes.ts`**:
   - `RoadSegment`: Defines `id`, `name`, `startPoint`, `endPoint`, `lengthMeters`, `bearingDeg`, `oneWay`, `speedLimitMps`, `roadClass`.
   - `RoadCandidate`: Extends segment with `projectedPoint`, `projectedEnu`, `crossTrackDistanceMeters`, `alongTrackMeters`, `headingDifferenceDeg`, `rawScore`, `normalizedConfidence`.
   - `RoadMatchingConfig`: Scoring hyperparameters (search radius, confidence threshold $\ge 0.65$, margin threshold $\ge 0.20$, distance sigma, heading deviation limit, continuity bonus).
   - _Missing Types:_ No `RoadIntersection`, `NodeId`, or topological connectivity representation.

3. **`MultiCandidateRoadMatcher.ts`**:
   - Multi-hypothesis candidate generator evaluating nearby segments.
   - Projects current estimated ENU position onto segment line lines.
   - Scores candidates via Bayesian weighting: $S = S_{\text{dist}} \times S_{\text{heading}} \times S_{\text{cont}}$.
   - Enforces the user's strict ambiguity rejection contract:
     $$P(C_1) \ge 0.65 \quad \text{AND} \quad P(C_1) - P(C_2) \ge 0.20$$
   - _Limitation:_ Assumes segments are independent straight lines; does not leverage graph topology or route prior consistency.

### 2.3 Constraint & Positioning Engines

1. **`ProbabilisticRouteConstraint.ts`**:
   - Projects nominal ESKF position onto active route polyline.
   - Generates soft Kalman measurement: $\mathbf{z} = \mathbf{p}_{\text{proj}} - \mathbf{p}_{\text{nom}}$.
   - Adaptive covariance inflation: $R = (\sigma_{\text{base}}^2 + (\kappa \cdot d_\perp)^2) I_2$.
   - Gates off when cross-track exceeds threshold ($35\,\text{m}$) or heading diverges.

2. **`ProbabilisticRoadConstraint.ts`**:
   - Calls `MultiCandidateRoadMatcher.match()`.
   - If unambiguous candidate accepted, injects measurement update into ESKF.

3. **`EskfPositioningEngine.ts`**:
   - Coordinates IMU propagation, ML motion predictions, NHC, and soft constraints.
   - Persistently updates state vector and error covariance matrix $P$.

4. **`IovnbdReplaySource.ts`**:
   - Replays benchmark sessions. Reference coordinates are completely decoupled from runtime constraints.

---

## 3. Analysis of Current Assumptions & Limitations

| Subsystem               | Current Assumption                                       | Production Reality / Defect                                                                                            |
| :---------------------- | :------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **Road Geometry**       | Disconnected line segments (`startPoint` to `endPoint`). | Real roads form a directed topological graph with intersections, turn restrictions, and multi-segment curves.          |
| **Spatial Querying**    | Brute-force array filtering (`segments.filter(...)`).    | Brute-force scanning fails on real road datasets ($10^4 - 10^6$ edges). Requires a spatial index (Grid / R-Tree).      |
| **Road Dataset**        | Zero offline road data in repository (mock data only).   | Needs a real, licensed offline road dataset (OpenStreetMap extract) covering the operational area.                     |
| **Route Storage**       | In-memory JavaScript `Map()`.                            | Does not survive app restart, background eviction, or offline reboots. Requires durable disk storage.                  |
| **Route Validation**    | Assumes route is valid if present.                       | Stored routes can be corrupted, stale, or malformed. Requires schema and geometry validation.                          |
| **Road + Route Fusion** | Road matcher and route constraint operate independently. | Road matcher should use active route as a Bayesian prior to resolve ambiguous parallel roads or complex intersections. |

---

## 4. Expected Provider Boundaries

To preserve strict provider neutrality:

1. **Core Navigation (`src/core/`):**
   - Strictly defines domain contracts (`IRoadNetworkProvider`, `IRoutingProvider`, `IPersistentRouteStorage`).
   - Contains zero imports from `@react-native-maps`, `react-native-maps`, `@maplibre`, `google`, `osrm`, or SQLite native modules.
2. **Adapters Layer (`src/adapters/`):**
   - Implements specific providers:
     - `src/adapters/road/LocalRoadNetworkProvider.ts` (offline spatially-indexed road graph).
     - `src/adapters/routing/OfflineRoutingProvider.ts` / `MockRoutingProvider.ts`.
     - `src/adapters/storage/FileRouteStorageDriver.ts` / `AsyncRouteStorageDriver.ts`.
3. **Services & UI (`src/services/`, `src/components/`):**
   - Orchestrates map rendering, replay controls, and UI state without bleeding provider details into the positioning engine.

---

_End of Phase 1 Audit Report._
