# Map & Routing Provider Decoupling Contract

**Architecture Standard & Provider Adapter Specification**  
_Target Package: `src/core/navigation/` & `src/adapters/`_

---

## 1. Architectural Mandate

The core positioning and navigation engine (`src/core/`) must remain **100% provider-neutral**.

### The Strict Decoupling Rules

1. **Zero Provider SDK Imports in Core**:
   No file within `src/core/` may import:
   - `@react-native-maps/*` or `react-native-maps`
   - `@maplibre/*` or `maplibre-gl`
   - `@google/*` or `google-maps`
   - `mapbox-gl` or `@react-native-mapbox-gl/*`
   - `osrm`, `graphhopper`, or `valhalla` client libraries.
2. **Provider Implementations Live Exclusively in `src/adapters/`**:
   Third-party map renders, vector tile engines, network query clients, and directions API consumers must be implemented in `src/adapters/navigation/` or `src/adapters/routing/`. They must implement the core interfaces defined in `src/core/`.
3. **No Reference Leakage**:
   Evaluation reference trajectories (`EvaluationReferenceTrajectory`) used in benchmark testing must **never** be passed into the runtime estimator as a routing prior. Runtime priors must always be typed as `PreExistingRoute` or `NormalizedRoute`.

---

## 2. Core Routing Contract (`IRoutingProvider`)

Defined in [`src/core/navigation/routing/IRoutingProvider.ts`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/navigation/routing/IRoutingProvider.ts):

```typescript
export interface IRoutingProvider {
  /**
   * Calculates an optimal route connecting origin, destination, and optional waypoints.
   */
  calculateRoute(
    origin: RouteWaypoint,
    destination: RouteWaypoint,
    waypoints?: RouteWaypoint[],
    options?: RouteCalculationOptions,
  ): Promise<NormalizedRoute>;

  /**
   * Returns human-readable provider identifier (e.g. "offline-cache", "osrm-http", "google-directions").
   */
  getProviderName(): string;

  /**
   * Indicates whether this provider functions without active internet connectivity.
   */
  isOfflineCapable(): boolean;
}
```

### Data Model (`NormalizedRoute`)

Agnostic representation of a navigation route:

```typescript
export interface NormalizedRoute {
  id: string;
  name: string;
  polylinePoints: Array<{
    latitude: number;
    longitude: number;
    altitudeM?: number;
  }>;
  totalDistanceMeters: number;
  estimatedDurationSeconds: number;
  sourceProvider: string;
  creationTimestampMs: number;
  segments?: RouteSegment[];
}
```

---

## 3. Core Road Network Contract (`IRoadNetworkProvider`)

Defined in [`src/core/navigation/road/IRoadNetworkProvider.ts`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/navigation/road/IRoadNetworkProvider.ts):

```typescript
export interface IRoadNetworkProvider {
  /**
   * Finds all road segments within radiusMeters of the given coordinate.
   */
  findNearbySegments(
    center: LatLonAlt,
    radiusMeters: number,
  ): Promise<RoadSegment[]> | RoadSegment[];

  /**
   * Looks up a specific segment by unique identifier.
   */
  getSegmentById(id: string): RoadSegment | null;

  /**
   * Returns human-readable provider name.
   */
  getProviderName(): string;

  /**
   * Indicates whether this provider operates completely offline.
   */
  isOffline(): boolean;
}
```

### Data Model (`RoadSegment`)

```typescript
export interface RoadSegment {
  id: string;
  name?: string;
  startPoint: LatLonAlt;
  endPoint: LatLonAlt;
  lengthMeters: number;
  bearingDeg: number;
  oneWay?: boolean;
  speedLimitMps?: number;
  roadClass?: string;
}
```

---

## 4. Multi-Candidate Road Matcher & Gating Contract

The multi-candidate road matcher ([`MultiCandidateRoadMatcher.ts`](file:///c:/Users/rkadh/OneDrive/Documents/GitHub/bettermaps/src/core/navigation/road/MultiCandidateRoadMatcher.ts)) consumes candidates from `IRoadNetworkProvider` and computes Bayesian posterior match probabilities:

$$P(C_i) = \frac{S_{d, i} \cdot S_{h, i} \cdot S_{c, i}}{\sum_j S_{d, j} \cdot S_{h, j} \cdot S_{c, j}}$$

where:

- Distance probability: $S_{d, i} = \exp\left(-\frac{d_{\perp, i}^2}{2 \sigma_d^2}\right)$, $\sigma_d = 10.0\,\text{m}$.
- Heading alignment: $S_{h, i} = \max\left(0, \cos(\Delta \theta_i)\right)$, with bidirectional symmetry for two-way roads.
- Temporal continuity bonus: $S_{c, i} = 1.40$ if $C_i$ matches the previous timestep's segment.

### Ambiguity Gating Rules (MANDATORY)

The engine rejects road candidates and defers constraint injection under two strict criteria:

1. **Confidence Threshold**:
   $$\text{Reject if } P(C_1) < 0.65$$
2. **Ambiguity Margin**:
   $$\text{Reject if } P(C_1) - P(C_2) < 0.20$$

---

## 5. Guide: Adding a New Provider Adapter

To integrate a new navigation provider (e.g. OpenStreetMap Overpass / Valhalla / Vector Tiles):

1. Create a new directory in `src/adapters/routing/<provider_name>/` or `src/adapters/road/<provider_name>/`.
2. Implement `IRoutingProvider` or `IRoadNetworkProvider`.
3. In your adapter, transform the provider-specific response to `NormalizedRoute` or `RoadSegment[]`.
4. Register the adapter into `src/adapters/` registry or pass it to `EskfPositioningEngine`.
5. Run `node dist_test/tests/EskfTestSuite.js` to ensure zero provider violations exist in `src/core/`.
