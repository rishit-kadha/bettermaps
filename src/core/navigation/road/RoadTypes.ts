/**
 * RoadTypes.ts
 *
 * Types and scoring contracts for multi-hypothesis road matching and network querying.
 * Includes full topology support: RoadNode, RoadIntersection, geometry polylines,
 * directionality, and multi-factor Bayesian scoring fields.
 */

import { LatLonAlt } from "../routing/RoutingTypes";

// ---------------------------------------------------------------------------
// Topology types
// ---------------------------------------------------------------------------

/**
 * A topological node in the road graph (OSM node, intersection point, or dead-end).
 * Each node may be shared by multiple segments, forming the connectivity graph.
 */
export interface RoadNode {
  /** Unique node identifier (e.g., OSM node ID as string) */
  id: string;
  /** WGS84 geographic position */
  coordinate: LatLonAlt;
  /** IDs of all road segments that start or end at this node */
  connectedSegmentIds: string[];
}

/**
 * A topological intersection: a node where >= 2 distinct segments meet.
 * Captured separately to allow fast intersection-centred queries.
 */
export interface RoadIntersection {
  /** Shares ID with the underlying RoadNode */
  nodeId: string;
  /** WGS84 position of the intersection centre */
  coordinate: LatLonAlt;
  /** Segment IDs that can be entered (outbound) from this intersection */
  outboundSegmentIds: string[];
}

// ---------------------------------------------------------------------------
// Directionality
// ---------------------------------------------------------------------------

/**
 * Describes legal vehicle traversal direction on a road segment.
 * - "two_way":       vehicles may travel in either direction (default for most roads)
 * - "forward_only":  vehicles must travel from startNodeId → endNodeId
 * - "backward_only": vehicles must travel from endNodeId → startNodeId
 */
export type SegmentDirectionality =
  | "two_way"
  | "forward_only"
  | "backward_only";

// ---------------------------------------------------------------------------
// Core road segment
// ---------------------------------------------------------------------------

export interface RoadSegment {
  /** Unique segment identifier */
  id: string;
  /** Human-readable road name (e.g., "Kenilworth Road") */
  name?: string;
  /** First endpoint (WGS84) */
  startPoint: LatLonAlt;
  /** Last endpoint (WGS84) */
  endPoint: LatLonAlt;
  /** Total arc length of the segment in metres */
  lengthMeters: number;
  /** Overall bearing from startPoint to endPoint (degrees, 0=N, clockwise) */
  bearingDeg: number;
  /**
   * @deprecated Use directionality instead.
   * Kept for backward compatibility — true ≡ "forward_only"
   */
  oneWay?: boolean;
  /** Legal traversal direction */
  directionality?: SegmentDirectionality;
  /** Posted speed limit converted to m/s */
  speedLimitMps?: number;
  /** OSM highway classification (e.g., "primary", "residential", "motorway") */
  roadClass?: string;
  /** Number of lanes (optional) */
  laneCount?: number;
  /**
   * Full multi-point geometry polyline (WGS84).
   * For straight segments this is just [startPoint, endPoint].
   * For curved roads it contains all intermediate shape points.
   */
  geometry?: LatLonAlt[];
  /** Topology: ID of the node at the start of this segment */
  startNodeId?: string;
  /** Topology: ID of the node at the end of this segment */
  endNodeId?: string;
}

// ---------------------------------------------------------------------------
// Road candidate (output of matcher)
// ---------------------------------------------------------------------------

export interface RoadCandidate {
  segment: RoadSegment;
  projectedPoint: LatLonAlt;
  projectedEnu: [number, number];
  crossTrackDistanceMeters: number;
  alongTrackMeters: number;
  headingDifferenceDeg: number;
  rawScore: number;
  normalizedConfidence: number;
  /**
   * Fraction of the topological-continuity bonus applied to this candidate.
   * 0.0 = no continuity bonus, 1.0 = full bonus was applied.
   */
  topologicalContinuityScore?: number;
  /**
   * Fraction of route-prior bonus applied to this candidate.
   * 0.0 = candidate not on active route, 1.0 = strongly on route.
   */
  routeConsistencyScore?: number;
}

// ---------------------------------------------------------------------------
// Matching configuration
// ---------------------------------------------------------------------------

export interface RoadMatchingConfig {
  /** Spatial radius around estimated position to search for candidate roads (meters) */
  searchRadiusMeters: number;
  /** Minimum posterior confidence required to accept candidate (User spec: >= 0.65) */
  minConfidenceThreshold: number;
  /** Minimum margin between top candidate and runner-up (User spec: >= 0.20) */
  minMarginThreshold: number;
  /** Gaussian distance decay standard deviation in meters */
  distanceSigmaM: number;
  /** Maximum allowable heading divergence in degrees before gating off */
  maxHeadingDeviationDeg: number;
  /** Bonus multiplier applied to previously matched road segment for continuity */
  continuityBonusMultiplier: number;
  /**
   * Multiplicative bonus applied when a candidate shares a graph node with the
   * previously accepted segment (topological connectivity).
   * 1.0 = no bonus (disabled), >1.0 = topology favoured (e.g., 1.3).
   */
  topologyBonusMultiplier: number;
  /**
   * Multiplicative bonus applied when a candidate falls on the active pre-existing
   * route polyline (route prior).
   * 1.0 = no bonus (disabled), >1.0 = route-consistent road favoured (e.g., 1.5).
   */
  routeBonusMultiplier: number;
  /**
   * Multiplicative penalty applied when a vehicle heading violates the legal
   * traversal direction of a one-way segment (wrong-way travel).
   * Must be in [0, 1]. 0.0 = hard reject, 0.1 = severe penalty (default).
   */
  oneWayPenaltyMultiplier: number;
}

export const DEFAULT_ROAD_MATCHING_CONFIG: RoadMatchingConfig = {
  searchRadiusMeters: 45.0,
  minConfidenceThreshold: 0.65,
  minMarginThreshold: 0.2,
  distanceSigmaM: 10.0,
  maxHeadingDeviationDeg: 60.0,
  continuityBonusMultiplier: 1.4,
  topologyBonusMultiplier: 1.3,
  routeBonusMultiplier: 1.5,
  oneWayPenaltyMultiplier: 0.1,
};
