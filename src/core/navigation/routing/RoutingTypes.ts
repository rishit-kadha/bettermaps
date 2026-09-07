/**
 * RoutingTypes.ts
 *
 * Provider-neutral routing and trajectory type definitions.
 *
 * ARCHITECTURAL RULE:
 * Strict separation between evaluation ground truth (ReferenceTrajectory)
 * and runtime navigation priors (PreExistingRoute / NormalizedRoute).
 * Evaluation reference files MUST NEVER be used as runtime routing priors.
 */

export interface LatLonAlt {
  latitude: number;
  longitude: number;
  altitudeM?: number;
}

export interface RouteWaypoint extends LatLonAlt {
  name?: string;
}

export interface RouteSegment {
  startIndex: number;
  endIndex: number;
  startPoint: LatLonAlt;
  endPoint: LatLonAlt;
  lengthMeters: number;
  bearingDeg: number;
}

/**
 * Normalized provider-neutral route model.
 * Agnostic to whether it was computed by OSRM, Google Maps, Valhalla, GraphHopper, or loaded offline.
 */
export interface NormalizedRoute {
  id: string;
  name: string;
  polylinePoints: LatLonAlt[];
  totalDistanceMeters: number;
  estimatedDurationSeconds: number;
  sourceProvider: string;
  creationTimestampMs: number;
  segments?: RouteSegment[];
}

/**
 * Explicitly typed PreExistingRoute:
 * Represents an active trip route known prior to or during travel.
 */
export type PreExistingRoute = NormalizedRoute;

/**
 * Strict ReferenceTrajectory type used ONLY for offline benchmark/evaluation scoring.
 * Cannot be passed into runtime constraint estimators.
 */
export interface EvaluationReferenceTrajectory {
  readonly _brand: "EvaluationReferenceTrajectory";
  datasetSplit: string;
  timestampsS: number[];
  positionsEnuM: Array<[number, number, number]>;
  velocitiesEnuMps: Array<[number, number, number]>;
  quaternionsNb: Array<[number, number, number, number]>;
}
