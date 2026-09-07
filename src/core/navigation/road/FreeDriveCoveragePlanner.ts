/**
 * FreeDriveCoveragePlanner.ts
 *
 * Deterministic free-drive coverage planner for BetterMaps.
 * Calculates the required road-network spatial tile keys when driving without
 * an active navigation destination.
 *
 * Features:
 * - Directional forward coverage bubble biased along heading.
 * - Dynamic forward lookahead scaling with vehicle speed.
 * - Symmetrical circular/box fallback when stationary or at crawling speeds.
 * - Rear retention buffer for U-turn and reversal resilience.
 * - Prioritized deterministic tile key ordering.
 *
 * ARCHITECTURAL RULES:
 * - Pure algorithmic calculation only.
 * - ZERO platform imports (no Google Maps, OSM, Overpass, SQLite, Expo, React Native).
 * - NEVER performs filesystem or network I/O.
 */

import {
  createDegreeTileKey,
  serializeTileKey,
  TileKey,
  TileBoundingBox,
} from "./RoadTileTypes";
import { LatLonAlt } from "../routing/RoutingTypes";

export interface FreeDriveCoveragePlannerConfig {
  /** Base forward lookahead distance in meters (default 800m) */
  baseForwardDistanceMeters: number;
  /** Maximum forward lookahead distance in meters (default 2000m) */
  maxForwardDistanceMeters: number;
  /** Lookahead time horizon in seconds (default 60s): forward = base + speed * horizon */
  timeHorizonSeconds: number;
  /** Lateral coverage width to each side in meters (default 300m) */
  lateralBufferMeters: number;
  /** Rear retention buffer behind vehicle in meters (default 300m) */
  rearRetentionDistanceMeters: number;
  /** Speed threshold below which vehicle is treated as stationary (default 1.0 m/s) */
  stationarySpeedThresholdMps: number;
  /** Spatial degree tile resolution in degrees (default 0.01 deg ≈ 1.1 km) */
  tileResolutionDegrees: number;
}

export const DEFAULT_FREE_DRIVE_CONFIG: FreeDriveCoveragePlannerConfig = {
  baseForwardDistanceMeters: 800.0,
  maxForwardDistanceMeters: 2000.0,
  timeHorizonSeconds: 60.0,
  lateralBufferMeters: 300.0,
  rearRetentionDistanceMeters: 300.0,
  stationarySpeedThresholdMps: 1.0,
  tileResolutionDegrees: 0.01,
};

export interface FreeDriveCoveragePlan {
  /** Ordered, deduplicated required tile keys */
  requiredTileKeys: TileKey[];
  /** Tile key directly containing the vehicle */
  centerTileKey: TileKey;
  /** Tile keys ahead of the vehicle */
  forwardTileKeys: TileKey[];
  /** Tile keys to the sides and rear of the vehicle */
  lateralAndRearTileKeys: TileKey[];
  /** Computed forward lookahead distance in meters */
  forwardDistanceMeters: number;
  /** Whether the planner treated the vehicle as stationary */
  isStationary: boolean;
  /** Bounding box of the coverage envelope */
  bounds: TileBoundingBox;
}

export class FreeDriveCoveragePlanner {
  private readonly config: FreeDriveCoveragePlannerConfig;

  constructor(config?: Partial<FreeDriveCoveragePlannerConfig>) {
    this.config = { ...DEFAULT_FREE_DRIVE_CONFIG, ...config };
  }

  public getConfig(): FreeDriveCoveragePlannerConfig {
    return { ...this.config };
  }

  /**
   * Plans the directional road network coverage envelope for free driving.
   *
   * @param currentPos Current vehicle geographic coordinate
   * @param speedMps Current vehicle forward speed in m/s
   * @param headingDeg Vehicle heading in degrees (clockwise from North, 0 to 360)
   */
  public planCoverage(
    currentPos: LatLonAlt,
    speedMps: number,
    headingDeg: number,
  ): FreeDriveCoveragePlan {
    const stepDeg = this.config.tileResolutionDegrees;
    const speed = Math.max(0.0, speedMps);
    const isStationary = speed < this.config.stationarySpeedThresholdMps;

    // Center tile key
    const centerLatIdx = Math.floor(currentPos.latitude / stepDeg);
    const centerLonIdx = Math.floor(currentPos.longitude / stepDeg);
    const centerTileKey = createDegreeTileKey(centerLatIdx, centerLonIdx, stepDeg);
    const centerSerialized = serializeTileKey(centerTileKey);

    let minLat = currentPos.latitude;
    let maxLat = currentPos.latitude;
    let minLon = currentPos.longitude;
    let maxLon = currentPos.longitude;

    const cosLat = Math.max(
      0.1,
      Math.cos((currentPos.latitude * Math.PI) / 180.0),
    );
    const mToLat = 1.0 / 111111.0;
    const mToLon = 1.0 / (111111.0 * cosLat);

    let forwardDistM: number;

    if (isStationary) {
      // -----------------------------------------------------------------------
      // Stationary / Low-Speed Case: Symmetric Circular/Box Envelope
      // -----------------------------------------------------------------------
      forwardDistM = Math.max(
        this.config.lateralBufferMeters,
        this.config.rearRetentionDistanceMeters,
      );
      const radiusM = forwardDistM;

      const dLat = radiusM * mToLat;
      const dLon = radiusM * mToLon;

      minLat = currentPos.latitude - dLat;
      maxLat = currentPos.latitude + dLat;
      minLon = currentPos.longitude - dLon;
      maxLon = currentPos.longitude + dLon;
    } else {
      // -----------------------------------------------------------------------
      // Moving Case: Directional Forward-Biased Envelope
      // -----------------------------------------------------------------------
      const rawFwd =
        this.config.baseForwardDistanceMeters +
        speed * this.config.timeHorizonSeconds;
      forwardDistM = Math.min(this.config.maxForwardDistanceMeters, rawFwd);

      const headingRad = (headingDeg * Math.PI) / 180.0;
      // Unit vectors in ENU: East = +X, North = +Y
      const fwdEast = Math.sin(headingRad);
      const fwdNorth = Math.cos(headingRad);
      const latEast = Math.cos(headingRad);
      const latNorth = -Math.sin(headingRad);

      const dFwd = forwardDistM;
      const dLat = this.config.lateralBufferMeters;
      const dRear = this.config.rearRetentionDistanceMeters;

      // 4 corners of oriented bounding polygon in ENU meters relative to vehicle:
      const cornersEnu: Array<[number, number]> = [
        // Front-Left
        [dFwd * fwdEast - dLat * latEast, dFwd * fwdNorth - dLat * latNorth],
        // Front-Right
        [dFwd * fwdEast + dLat * latEast, dFwd * fwdNorth + dLat * latNorth],
        // Rear-Left
        [-dRear * fwdEast - dLat * latEast, -dRear * fwdNorth - dLat * latNorth],
        // Rear-Right
        [-dRear * fwdEast + dLat * latEast, -dRear * fwdNorth + dLat * latNorth],
        // Vehicle position
        [0.0, 0.0],
        // Mid-Forward
        [0.5 * dFwd * fwdEast, 0.5 * dFwd * fwdNorth],
      ];

      for (const [eastM, northM] of cornersEnu) {
        const ptLat = currentPos.latitude + northM * mToLat;
        const ptLon = currentPos.longitude + eastM * mToLon;

        if (ptLat < minLat) minLat = ptLat;
        if (ptLat > maxLat) maxLat = ptLat;
        if (ptLon < minLon) minLon = ptLon;
        if (ptLon > maxLon) maxLon = ptLon;
      }
    }

    // Discretize bounding box into degree tile indices
    const minLatIdx = Math.floor(minLat / stepDeg);
    const maxLatIdx = Math.floor(maxLat / stepDeg);
    const minLonIdx = Math.floor(minLon / stepDeg);
    const maxLonIdx = Math.floor(maxLon / stepDeg);

    const forwardKeysMap = new Map<string, TileKey>();
    const lateralAndRearKeysMap = new Map<string, TileKey>();

    const headingRad = (headingDeg * Math.PI) / 180.0;
    const fwdEast = Math.sin(headingRad);
    const fwdNorth = Math.cos(headingRad);

    for (let la = minLatIdx; la <= maxLatIdx; la++) {
      for (let lo = minLonIdx; lo <= maxLonIdx; lo++) {
        const k = createDegreeTileKey(la, lo, stepDeg);
        const serialized = serializeTileKey(k);

        // Center tile is handled separately
        if (serialized === centerSerialized) {
          continue;
        }

        if (isStationary) {
          lateralAndRearKeysMap.set(serialized, k);
        } else {
          // Center of this tile in WGS84
          const tileCenterLat = (la + 0.5) * stepDeg;
          const tileCenterLon = (lo + 0.5) * stepDeg;

          // Vector from vehicle to tile center in meters
          const vEast = (tileCenterLon - currentPos.longitude) * 111111.0 * cosLat;
          const vNorth = (tileCenterLat - currentPos.latitude) * 111111.0;

          // Projection onto forward heading vector
          const dotForward = vEast * fwdEast + vNorth * fwdNorth;

          if (dotForward > 0.0) {
            forwardKeysMap.set(serialized, k);
          } else {
            lateralAndRearKeysMap.set(serialized, k);
          }
        }
      }
    }

    const forwardTileKeys = Array.from(forwardKeysMap.values());
    const lateralAndRearTileKeys = Array.from(lateralAndRearKeysMap.values());

    // Deterministic priority ordering: Center Tile -> Forward Tiles -> Lateral/Rear Tiles
    const requiredTileKeys = [
      centerTileKey,
      ...forwardTileKeys,
      ...lateralAndRearTileKeys,
    ];

    return {
      requiredTileKeys,
      centerTileKey,
      forwardTileKeys,
      lateralAndRearTileKeys,
      forwardDistanceMeters: forwardDistM,
      isStationary,
      bounds: {
        minLat,
        maxLat,
        minLon,
        maxLon,
      },
    };
  }
}
