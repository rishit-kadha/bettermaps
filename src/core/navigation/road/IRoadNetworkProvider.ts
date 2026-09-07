/**
 * IRoadNetworkProvider.ts
 *
 * Provider-neutral interface for querying geometric and topological road data.
 * Implementations may query local tiled vector data, OpenStreetMap GeoJSON,
 * pre-extracted route corridors, or offline spatial indices.
 *
 * ARCHITECTURAL RULE:
 * This interface belongs in src/core/navigation/road/.
 * It must have ZERO imports from Google, MapLibre, OSM, OSRM, SQLite,
 * or any React Native map SDK. All provider-specific code lives in src/adapters/.
 *
 * All querying methods exposed to the estimator must be strictly synchronous
 * and execute in-memory with zero I/O or Promise overhead.
 */

import { LatLonAlt } from "../routing/RoutingTypes";
import { RoadIntersection, RoadNode, RoadSegment } from "./RoadTypes";

export interface IRoadNetworkProvider {
  /**
   * Finds all road segments within radiusMeters of the given coordinate.
   * Returns an empty array (never null/undefined) if no segments are found.
   * Must execute strictly synchronously from an in-memory spatial index.
   */
  findNearbySegments(
    center: LatLonAlt,
    radiusMeters: number,
  ): RoadSegment[];

  /**
   * Looks up a specific segment by unique identifier.
   * Returns null if the segment is not found.
   */
  getSegmentById(id: string): RoadSegment | null;

  /**
   * Returns all road segments that are topologically connected to the
   * given segment (i.e., share a start or end node with it).
   * Returns an empty array if topology is unavailable or segment not found.
   */
  getOutboundSegments?(segmentId: string): RoadSegment[];

  /**
   * Returns all intersections (multi-segment junction nodes) within radiusMeters
   * of the given coordinate.
   * Returns an empty array if no intersections are found.
   */
  getConnectedIntersections?(
    center: LatLonAlt,
    radiusMeters: number,
  ): RoadIntersection[];

  /**
   * Looks up a topological node by its unique identifier.
   * Returns null if the node is not found or topology is unavailable.
   */
  getNodeById?(nodeId: string): RoadNode | null;

  /**
   * Returns human-readable provider name for logging and diagnostics.
   */
  getProviderName(): string;

  /**
   * Indicates whether this provider operates completely offline.
   * An offline provider must never make network requests at runtime.
   */
  isOffline(): boolean;
}