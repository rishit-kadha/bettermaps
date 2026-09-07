/**
 * RoadTileTypes.ts
 *
 * Foundational spatial tile abstractions and data models for dynamic road
 * network caching, prefetching, and spatial indexing.
 *
 * ARCHITECTURAL RULES:
 * - Pure data interfaces and spatial key helpers only.
 * - ZERO external imports (no Google Maps, OSM, Overpass, SQLite, Expo, React Native).
 * - Provider-neutral: TileKey supports degree grids, Slippy tiles, and custom schemes.
 */

import { RoadIntersection, RoadNode, RoadSegment } from "./RoadTypes";

/**
 * Canonical spatial tile identifier.
 * Provider-neutral and generic across multiple discretization schemes.
 */
export interface TileKey {
  /** Discretization scheme: "deg" (degree grid), "slippy" (XYZ), or custom */
  scheme: string;
  /** Unique serialized key payload, e.g. "5240:-151" or "15:16384:10892" */
  key: string;
}

/**
 * Geographic bounding box for a spatial tile.
 */
export interface TileBoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Metadata associated with a cached or fetched road tile.
 */
export interface RoadTileMetadata {
  fetchedAtMs?: number;
  byteSize?: number;
  source?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Complete road network tile containing geographic segments, nodes, and intersections.
 */
export interface RoadTile {
  /** Unique tile key */
  key: TileKey;
  /** Bounding box of the tile */
  bounds: TileBoundingBox;
  /** Array of road segments within this tile */
  segments: RoadSegment[];
  /** Optional topological nodes */
  nodes?: RoadNode[];
  /** Optional intersection records */
  intersections?: RoadIntersection[];
  /** Optional metadata */
  metadata?: RoadTileMetadata;
}

// ---------------------------------------------------------------------------
// TileKey serialization and factory utilities
// ---------------------------------------------------------------------------

/**
 * Serializes a TileKey into a canonical string format: `${scheme}:${key}`.
 */
export function serializeTileKey(tileKey: TileKey): string {
  return `${tileKey.scheme}:${tileKey.key}`;
}

/**
 * Deserializes a canonical string into a TileKey.
 */
export function parseTileKey(str: string): TileKey {
  const colonIdx = str.indexOf(":");
  if (colonIdx === -1) {
    return { scheme: "generic", key: str };
  }
  return {
    scheme: str.slice(0, colonIdx),
    key: str.slice(colonIdx + 1),
  };
}

/**
 * Creates a generic degree-grid TileKey without fixing a permanent tile size.
 */
export function createDegreeTileKey(
  latIdx: number,
  lonIdx: number,
  stepDeg = 0.01,
): TileKey {
  const stepInt = Math.round(stepDeg * 10000);
  return {
    scheme: "deg",
    key: `${stepInt}:${latIdx}:${lonIdx}`,
  };
}

/**
 * Creates a Slippy map (XYZ) TileKey without committing to a specific zoom.
 */
export function createSlippyTileKey(z: number, x: number, y: number): TileKey {
  return {
    scheme: "slippy",
    key: `${z}:${x}:${y}`,
  };
}