/**
 * Shared Navigation State Types for BetterMaps.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Navigation state is strictly separated into:
 * 1. Static/Reference Route Data: ActiveRoute (Metadata, Geometry, Steps) - Immutable
 * 2. Derived Dynamic State: RouteProgress (Calculated geometrically along route arc-length)
 * 3. Positioning & Telemetry: NavigationTelemetry (Driven by LocationProvider abstraction)
 *
 * The UI layer and route progress engine never query GNSS hardware directly.
 * When GNSS is lost and the future IDR engine takes over, the locationSource shifts
 * seamlessly from "GNSS" to "IDR" while the active route, progress, and maneuvers
 * continue uninterrupted.
 */

import { NavLocation, ProviderStatus, ProviderType } from "./location";
import {
  GnssStreamGateState,
  PositionEstimate,
  PositioningStatus,
} from "./positioning";
import { MotionEstimatorDiagnostics } from "../positioning/motionEstimator";

export type NavigationMode = "follow_course" | "follow_north" | "free";

/**
 * Map Camera Perspective.
 * - '2D': Standard flat top-down map (pitch = 0).
 * - '3D': Tilted navigation perspective (pitch = 45-50°).
 */
export type CameraPerspective = "2D" | "3D";

export type NavigationStatus =
  | "idle"
  | "searching"
  | "route_preview"
  | "navigating"
  | "arrived";

export type LocationSourceTag =
  | "GNSS"
  | "IDR"
  | "GNSS+INS"
  | "SIMULATOR"
  | "GNSS STREAM BLOCKED"
  | "NO POSITION";

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface RouteBounds {
  southwest: RoutePoint;
  northeast: RoutePoint;
}

export type ManeuverType =
  | "turn-left"
  | "turn-right"
  | "turn-slight-left"
  | "turn-slight-right"
  | "turn-sharp-left"
  | "turn-sharp-right"
  | "uturn"
  | "straight"
  | "ramp"
  | "fork"
  | "roundabout"
  | "depart"
  | "arrive"
  | "unknown";

export interface RouteStep {
  stepIndex: number;
  instruction: string;
  maneuverType: ManeuverType;
  distanceMeters: number;
  durationSeconds: number;
  startPoint: RoutePoint;
  endPoint: RoutePoint;
  /** Cumulative arc-length distance from route origin where this step begins */
  startDistanceAlongRoute: number;
  /** Cumulative arc-length distance from route origin where this step ends / maneuver occurs */
  endDistanceAlongRoute: number;
}

export interface RouteMetadata {
  id: string;
  destinationName: string;
  destinationAddress: string;
  destinationCoordinate: RoutePoint;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  bounds: RouteBounds;
  isMockRoute?: boolean;
}

export interface RouteGeometry {
  /** Ordered coordinates defining the polyline path */
  points: RoutePoint[];
  /** Precomputed cumulative arc-length distances in meters at each vertex index */
  cumulativeDistances: number[];
  /** Total path length in meters */
  totalLengthMeters: number;
}

export interface ActiveRoute {
  metadata: RouteMetadata;
  geometry: RouteGeometry;
  steps: RouteStep[];
}

export interface RouteProgress {
  /** Distance in meters traveled along the route polyline */
  distanceTraveledMeters: number;
  /** Remaining distance in meters along the route to destination */
  remainingDistanceMeters: number;
  /** Estimated remaining travel time in seconds */
  remainingDurationSeconds: number;
  /** Formatted ETA clock time (e.g. "3:45 PM") */
  etaClock: string;
  /** Index of current active step */
  currentStepIndex: number;
  /** Distance in meters to the upcoming maneuver point */
  distanceToManeuverMeters: number;
  /** The upcoming maneuver step */
  nextManeuver: RouteStep | null;
  /** Perpendicular cross-track distance off the centerline in meters */
  crossTrackDistanceMeters: number;
  /** True if vehicle is significantly deviated from route polyline (> 40m) */
  isOffRoute: boolean;
  /** True if vehicle has arrived within destination radius (< 25m) */
  isArrived: boolean;
}

/**
 * Normalized telemetry payload exposed by NavigationManager to UI components.
 */
export interface NavigationTelemetry {
  currentLocation: NavLocation | null;
  speedKmh: number;
  smoothedHeading: number;
  isHeadingReliable: boolean;
  updateFrequencyHz: number;
  mode: NavigationMode;
  providerStatus: ProviderStatus;
  providerName: string;
  providerType: ProviderType;
  locationSource: LocationSourceTag;
  isDeadReckoning: boolean;
  historyTrail: RoutePoint[];

  // Positioning Engine & Outage Gate State
  currentPositionEstimate: PositionEstimate | null;
  gnssStreamGateState: GnssStreamGateState;
  positioningStatus: PositioningStatus;
  motionDiagnostics?: MotionEstimatorDiagnostics | null;

  // Real Navigation Extension
  navigationStatus: NavigationStatus;
  cameraPerspective: CameraPerspective;
  activeRoute: ActiveRoute | null;
  routeProgress: RouteProgress | null;
  routeError: string | null;
  roadDiagnostics?: any | null;

  // GRU Model Diagnostics (B3_GRU ONNX)
  gruModelDiagnostics?: import("../../adapters/ml/GruOnnxEvaluator").GruOnnxEvaluatorDiagnostics | null;

  // Extended GNSS / ESKF Fusion Diagnostics
  gnssFixCount?: number;
  lastGnssFixAgeMs?: number | null;
  eskfGnssUpdateCount?: number;
  gnssStatus?: "VALID" | "STALE" | "LOST" | "BLOCKED";
  rawGnssLocation?: NavLocation | null;

  // Extended Road Coverage & Memory Diagnostics
  roadCoverageDiagnostics?: RoadCoverageTelemetry | null;
  roadMemoryDiagnostics?: RoadMemoryTelemetry | null;
}

export interface RoadCoverageTelemetry {
  sourcePosition: "LIVE" | "REPLAY";
  currentPosition: { latitude: number; longitude: number } | null;
  coverageAnchor: { latitude: number; longitude: number } | null;
  planner: "ROUTE" | "FREE_DRIVE" | "ROUTE_DEVIATION" | "NONE";
  requiredTileCount: number;
  loadedTileCount: number;
  pendingTileCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  roadCandidatesCount: number;
  roadUpdateCount: number;
  lastCoverageUpdateTimestampMs: number | null;
  coalescedSkipCount?: number;
  lastTriggerReason?: string;
  activeRegionId?: string | null;
}

export interface RoadMemoryTelemetry {
  ramTileCount: number;
  ramRoadBytes: number;
  ramBudgetBytes: number;
  l1CacheBytes: number;
  persistentCacheBytes: number;
  evictionCount: number;
  lastEvictionKey: string | null;
  memoryPressure: "NORMAL" | "PRESSURE" | "AGGRESSIVE";
  activeSegmentCount: number;
  indexedSegmentCount: number;
}
