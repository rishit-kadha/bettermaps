/**
 * RouteCoveragePlanner.ts
 *
 * Deterministic route corridor coverage planner for BetterMaps.
 * Calculates the required set of road-network spatial tile keys needed to
 * cover an active navigation route, dynamic forward prefetch horizon, and
 * rear retention buffer.
 *
 * ARCHITECTURAL RULES:
 * - Pure algorithmic calculation only.
 * - ZERO imports from Google Maps SDK, OSM, Overpass, SQLite, Expo, or React Native.
 * - Provider-neutral: accepts generic RouteCoverageInput.
 * - NEVER performs filesystem or network I/O.
 */

import {
  createDegreeTileKey,
  serializeTileKey,
  TileKey,
  TileBoundingBox,
} from "./RoadTileTypes";
import { LatLonAlt } from "../routing/RoutingTypes";

export interface RouteCoveragePlannerConfig {
  /** Lateral expansion buffer around the route in meters (default 150m) */
  lateralBufferMeters: number;
  /** Base lookahead distance in meters (default 500m) */
  baseLookaheadDistanceMeters: number;
  /** Lookahead time horizon in seconds (default 60s): forward = base + speed * horizon */
  timeHorizonSeconds: number;
  /** Maximum forward lookahead distance in meters (default 3000m) */
  maxLookaheadDistanceMeters: number;
  /** Rear retention buffer in meters behind the current vehicle position (default 300m) */
  rearRetentionDistanceMeters: number;
  /** Spatial degree tile resolution in degrees (default 0.01 deg ≈ 1.1 km) */
  tileResolutionDegrees: number;
}

export const DEFAULT_ROUTE_COVERAGE_CONFIG: RouteCoveragePlannerConfig = {
  lateralBufferMeters: 150.0,
  baseLookaheadDistanceMeters: 500.0,
  timeHorizonSeconds: 60.0,
  maxLookaheadDistanceMeters: 3000.0,
  rearRetentionDistanceMeters: 300.0,
  tileResolutionDegrees: 0.01,
};

export interface RouteCoverageInput {
  id?: string;
  points: LatLonAlt[];
}

export interface RouteCoveragePlan {
  /** All required tile keys (ordered: Active -> Forward Prefetch -> Rear Retention) */
  requiredTileKeys: TileKey[];
  /** Tile keys immediately surrounding the vehicle's current position */
  activeTileKeys: TileKey[];
  /** Tile keys within the forward lookahead horizon */
  forwardPrefetchTileKeys: TileKey[];
  /** Tile keys within the rear retention buffer */
  rearRetentionTileKeys: TileKey[];
  /** Whether the vehicle's position has deviated beyond the lateral corridor buffer */
  isOffRoute: boolean;
  /** Orthogonal cross-track distance from the route in meters */
  crossTrackDistanceMeters: number;
  /** Distance along the route polyline in meters */
  alongTrackMeters: number;
  /** Total computed forward lookahead distance in meters */
  forwardLookaheadMeters: number;
  /** Bounding box of the active coverage window */
  coverageBounds: TileBoundingBox;
}

export class RouteCoveragePlanner {
  private readonly config: RouteCoveragePlannerConfig;
  private activeRoute: RouteCoverageInput | null = null;
  private cumulativeDistancesM: number[] = [];
  private totalRouteLengthM = 0.0;
  private cachedCorridorTileKeys: TileKey[] | null = null;

  constructor(config?: Partial<RouteCoveragePlannerConfig>) {
    this.config = { ...DEFAULT_ROUTE_COVERAGE_CONFIG, ...config };
  }

  public setRoute(route: RouteCoverageInput | null): void {
    this.activeRoute = route;
    this.cachedCorridorTileKeys = null;
    this.cumulativeDistancesM = [];
    this.totalRouteLengthM = 0.0;

    if (!route || route.points.length < 2) {
      return;
    }

    // Precompute cumulative arc-length distances
    this.cumulativeDistancesM.push(0.0);
    for (let i = 0; i < route.points.length - 1; i++) {
      const p1 = route.points[i];
      const p2 = route.points[i + 1];
      const dist = this.distanceMeters(p1, p2);
      this.totalRouteLengthM += dist;
      this.cumulativeDistancesM.push(this.totalRouteLengthM);
    }
  }

  public getRoute(): RouteCoverageInput | null {
    return this.activeRoute;
  }

  public getConfig(): RouteCoveragePlannerConfig {
    return { ...this.config };
  }

  /**
   * Computes the complete static tile corridor covering the full length of the route.
   */
  public computeCorridorTileKeys(): TileKey[] {
    if (this.cachedCorridorTileKeys) {
      return this.cachedCorridorTileKeys;
    }
    if (!this.activeRoute || this.activeRoute.points.length < 2) {
      return [];
    }

    const keyMap = new Map<string, TileKey>();
    const pts = this.activeRoute.points;
    const stepDeg = this.config.tileResolutionDegrees;
    const bufM = this.config.lateralBufferMeters;

    // Sample route every ~250m to capture all tiles crossed by the ribbon
    const sampleIntervalM = Math.min(250.0, stepDeg * 111111 * 0.5);
    const numSamples = Math.max(2, Math.ceil(this.totalRouteLengthM / sampleIntervalM));

    for (let s = 0; s <= numSamples; s++) {
      const targetDist = (s / numSamples) * this.totalRouteLengthM;
      const coord = this.interpolateCoordinateAtDistance(targetDist);
      if (!coord) continue;

      const dLat = bufM / 111111.0;
      const cosLat = Math.cos((coord.latitude * Math.PI) / 180.0);
      const dLon = bufM / (111111.0 * Math.max(0.1, Math.abs(cosLat)));

      const minLat = coord.latitude - dLat;
      const maxLat = coord.latitude + dLat;
      const minLon = coord.longitude - dLon;
      const maxLon = coord.longitude + dLon;

      const minLatIdx = Math.floor(minLat / stepDeg);
      const maxLatIdx = Math.floor(maxLat / stepDeg);
      const minLonIdx = Math.floor(minLon / stepDeg);
      const maxLonIdx = Math.floor(maxLon / stepDeg);

      for (let la = minLatIdx; la <= maxLatIdx; la++) {
        for (let lo = minLonIdx; lo <= maxLonIdx; lo++) {
          const tKey = createDegreeTileKey(la, lo, stepDeg);
          const serialized = serializeTileKey(tKey);
          if (!keyMap.has(serialized)) {
            keyMap.set(serialized, tKey);
          }
        }
      }
    }

    this.cachedCorridorTileKeys = Array.from(keyMap.values());
    return this.cachedCorridorTileKeys;
  }

  /**
   * Plans the dynamic road coverage window around the moving vehicle:
   * 1. Orthogonally projects position onto the route polyline.
   * 2. Computes forward lookahead horizon based on speed.
   * 3. Partitions required tiles into Active, Forward Prefetch, and Rear Retention.
   */
  public planCoverage(
    currentPos: LatLonAlt,
    speedMps: number,
    _headingDeg?: number,
  ): RouteCoveragePlan {
    const emptyBounds: TileBoundingBox = {
      minLat: currentPos.latitude,
      maxLat: currentPos.latitude,
      minLon: currentPos.longitude,
      maxLon: currentPos.longitude,
    };

    if (!this.activeRoute || this.activeRoute.points.length < 2) {
      return {
        requiredTileKeys: [],
        activeTileKeys: [],
        forwardPrefetchTileKeys: [],
        rearRetentionTileKeys: [],
        isOffRoute: true,
        crossTrackDistanceMeters: Infinity,
        alongTrackMeters: 0.0,
        forwardLookaheadMeters: this.config.baseLookaheadDistanceMeters,
        coverageBounds: emptyBounds,
      };
    }

    // 1. Find projection onto the route polyline
    const projection = this.projectOntoRoute(currentPos);
    const crossTrackM = projection.crossTrackMeters;
    const alongTrackM = projection.alongTrackMeters;
    const isOffRoute = crossTrackM > this.config.lateralBufferMeters;

    // 2. Compute dynamic forward lookahead horizon
    const rawFwd =
      this.config.baseLookaheadDistanceMeters +
      Math.max(0.0, speedMps) * this.config.timeHorizonSeconds;
    const forwardLookaheadM = Math.min(
      this.config.maxLookaheadDistanceMeters,
      rawFwd,
    );

    const rearRetentionM = this.config.rearRetentionDistanceMeters;

    // Range along route to retain & prefetch:
    const sStart = Math.max(0.0, alongTrackM - rearRetentionM);
    const sActiveEnd = Math.min(
      this.totalRouteLengthM,
      alongTrackM + this.config.baseLookaheadDistanceMeters,
    );
    const sFwdEnd = Math.min(
      this.totalRouteLengthM,
      alongTrackM + forwardLookaheadM,
    );

    // 3. Collect tiles in each zone
    const activeKeysMap = new Map<string, TileKey>();
    const forwardKeysMap = new Map<string, TileKey>();
    const rearKeysMap = new Map<string, TileKey>();

    // Bounding box tracking for total coverage window
    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity;

    const addTilesForWindow = (
      startDist: number,
      endDist: number,
      targetMap: Map<string, TileKey>,
    ) => {
      if (endDist < startDist) return;
      const step = 200.0;
      const count = Math.max(2, Math.ceil((endDist - startDist) / step));
      const stepDeg = this.config.tileResolutionDegrees;
      const bufM = this.config.lateralBufferMeters;

      for (let i = 0; i <= count; i++) {
        const d = startDist + (i / count) * (endDist - startDist);
        const pt = this.interpolateCoordinateAtDistance(d);
        if (!pt) continue;

        const dLat = bufM / 111111.0;
        const cosLat = Math.cos((pt.latitude * Math.PI) / 180.0);
        const dLon = bufM / (111111.0 * Math.max(0.1, Math.abs(cosLat)));

        const ptMinLat = pt.latitude - dLat;
        const ptMaxLat = pt.latitude + dLat;
        const ptMinLon = pt.longitude - dLon;
        const ptMaxLon = pt.longitude + dLon;

        if (ptMinLat < minLat) minLat = ptMinLat;
        if (ptMaxLat > maxLat) maxLat = ptMaxLat;
        if (ptMinLon < minLon) minLon = ptMinLon;
        if (ptMaxLon > maxLon) maxLon = ptMaxLon;

        const minLatIdx = Math.floor(ptMinLat / stepDeg);
        const maxLatIdx = Math.floor(ptMaxLat / stepDeg);
        const minLonIdx = Math.floor(ptMinLon / stepDeg);
        const maxLonIdx = Math.floor(ptMaxLon / stepDeg);

        for (let la = minLatIdx; la <= maxLatIdx; la++) {
          for (let lo = minLonIdx; lo <= maxLonIdx; lo++) {
            const k = createDegreeTileKey(la, lo, stepDeg);
            const serialized = serializeTileKey(k);
            if (!targetMap.has(serialized)) {
              targetMap.set(serialized, k);
            }
          }
        }
      }
    };

    // Active zone: from current position to base lookahead
    addTilesForWindow(alongTrackM, sActiveEnd, activeKeysMap);

    // Forward prefetch zone: from base lookahead to full horizon
    addTilesForWindow(sActiveEnd, sFwdEnd, forwardKeysMap);

    // Rear retention zone: from rear limit to current position
    addTilesForWindow(sStart, alongTrackM, rearKeysMap);

    // Also ensure current vehicle position tile is explicitly in active zone
    const stepDeg = this.config.tileResolutionDegrees;
    const vehLatIdx = Math.floor(currentPos.latitude / stepDeg);
    const vehLonIdx = Math.floor(currentPos.longitude / stepDeg);
    const vehKey = createDegreeTileKey(vehLatIdx, vehLonIdx, stepDeg);
    activeKeysMap.set(serializeTileKey(vehKey), vehKey);

    // Filter forward and rear to not duplicate active keys
    for (const k of activeKeysMap.keys()) {
      forwardKeysMap.delete(k);
      rearKeysMap.delete(k);
    }
    for (const k of forwardKeysMap.keys()) {
      rearKeysMap.delete(k);
    }

    const activeTileKeys = Array.from(activeKeysMap.values());
    const forwardPrefetchTileKeys = Array.from(forwardKeysMap.values());
    const rearRetentionTileKeys = Array.from(rearKeysMap.values());

    // Deterministic combined required list: Active -> Forward -> Rear
    const requiredTileKeys = [
      ...activeTileKeys,
      ...forwardPrefetchTileKeys,
      ...rearRetentionTileKeys,
    ];

    return {
      requiredTileKeys,
      activeTileKeys,
      forwardPrefetchTileKeys,
      rearRetentionTileKeys,
      isOffRoute,
      crossTrackDistanceMeters: crossTrackM,
      alongTrackMeters: alongTrackM,
      forwardLookaheadMeters: forwardLookaheadM,
      coverageBounds: {
        minLat: isFinite(minLat) ? minLat : currentPos.latitude,
        maxLat: isFinite(maxLat) ? maxLat : currentPos.latitude,
        minLon: isFinite(minLon) ? minLon : currentPos.longitude,
        maxLon: isFinite(maxLon) ? maxLon : currentPos.longitude,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Geometric Helper Functions
  // ---------------------------------------------------------------------------

  private distanceMeters(p1: LatLonAlt, p2: LatLonAlt): number {
    const dLat = (p2.latitude - p1.latitude) * 111111.0;
    const avgLat = ((p1.latitude + p2.latitude) * Math.PI) / 360.0;
    const dLon = (p2.longitude - p1.longitude) * 111111.0 * Math.cos(avgLat);
    return Math.hypot(dLat, dLon);
  }

  private projectOntoRoute(pos: LatLonAlt): {
    crossTrackMeters: number;
    alongTrackMeters: number;
  } {
    if (!this.activeRoute || this.activeRoute.points.length < 2) {
      return { crossTrackMeters: Infinity, alongTrackMeters: 0.0 };
    }

    const pts = this.activeRoute.points;
    let bestDistSq = Infinity;
    let bestAlongTrack = 0.0;

    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];

      const cosLat = Math.cos((p1.latitude * Math.PI) / 180.0);
      const sx = (p2.longitude - p1.longitude) * 111111.0 * cosLat;
      const sy = (p2.latitude - p1.latitude) * 111111.0;
      const lenSq = sx * sx + sy * sy;
      if (lenSq < 1e-4) continue;

      const px = (pos.longitude - p1.longitude) * 111111.0 * cosLat;
      const py = (pos.latitude - p1.latitude) * 111111.0;

      const t = Math.max(0.0, Math.min(1.0, (px * sx + py * sy) / lenSq));
      const projX = t * sx;
      const projY = t * sy;
      const distSq = (px - projX) * (px - projX) + (py - projY) * (py - projY);

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        const segLen = Math.sqrt(lenSq);
        bestAlongTrack = this.cumulativeDistancesM[i] + t * segLen;
      }
    }

    return {
      crossTrackMeters: Math.sqrt(bestDistSq),
      alongTrackMeters: bestAlongTrack,
    };
  }

  private interpolateCoordinateAtDistance(targetM: number): LatLonAlt | null {
    if (!this.activeRoute || this.activeRoute.points.length < 2) {
      return null;
    }

    const pts = this.activeRoute.points;
    const cum = this.cumulativeDistancesM;

    if (targetM <= 0.0) return { ...pts[0] };
    if (targetM >= this.totalRouteLengthM) return { ...pts[pts.length - 1] };

    // Find segment
    for (let i = 0; i < cum.length - 1; i++) {
      if (targetM >= cum[i] && targetM <= cum[i + 1]) {
        const segLen = cum[i + 1] - cum[i];
        const fraction = segLen > 1e-4 ? (targetM - cum[i]) / segLen : 0.0;
        const p1 = pts[i];
        const p2 = pts[i + 1];
        return {
          latitude: p1.latitude + fraction * (p2.latitude - p1.latitude),
          longitude: p1.longitude + fraction * (p2.longitude - p1.longitude),
        };
      }
    }

    return { ...pts[pts.length - 1] };
  }
}
