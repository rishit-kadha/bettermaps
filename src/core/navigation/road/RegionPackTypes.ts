/**
 * RegionPackTypes.ts
 *
 * Foundational data models and contracts for Offline Regional Map Packs.
 *
 * ARCHITECTURAL RULES:
 * - Pure data interfaces and serialization helpers only.
 * - ZERO platform imports (no Google Maps, OSM, SQLite, Expo, React Native).
 * - Strictly provider-neutral: packs contain RoadTile geometry for the estimator,
 *   completely independent of online basemap visualization layers.
 */

import { TileBoundingBox, TileKey } from "./RoadTileTypes";

/**
 * Individual tile descriptor within a region pack manifest.
 */
export interface RegionPackTileEntry {
  /** Canonical tile key */
  key: TileKey;
  /** Relative file name inside the pack directory/archive, e.g. "tile_2863_7721.json" */
  fileName: string;
  /** Geographic bounding box of the tile */
  bounds: TileBoundingBox;
  /** Total road segments contained in this tile */
  segmentCount: number;
  /** Optional topological node count */
  nodeCount?: number;
  /** Optional intersection count */
  intersectionCount?: number;
  /** Serialized file size in bytes */
  byteSize: number;
  /** Optional cryptographic or CRC checksum for integrity validation */
  checksum?: string;
}

/**
 * Complete manifest metadata for an offline regional map pack.
 */
export interface RegionPackManifest {
  /** Unique pack identifier, e.g. "delhi_ncr" or "coventry_uk" */
  id: string;
  /** Human-readable region display name, e.g. "Delhi NCR Road Network" */
  name: string;
  /** Geographic bounding box covering the entire regional pack */
  bbox: TileBoundingBox;
  /** Spatial discretization scheme (default: "deg") */
  tileScheme: string;
  /** Schema version of the road data format */
  roadDataVersion: number;
  /** Source attribution string (e.g. "OpenStreetMap contributors") */
  source: string;
  /** Legal license identifier (e.g. "ODbL 1.0") */
  license: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Total on-disk storage size in bytes */
  byteSize: number;
  /** Manifest-level checksum for integrity verification */
  checksum: string;
  /** Ordered array of tile entries */
  tiles: RegionPackTileEntry[];
}

/**
 * Summary status for an installed or available region pack.
 */
export interface RegionPackStatus {
  manifest: RegionPackManifest;
  isInstalled: boolean;
  installedAtMs?: number;
  storageSizeBytes: number;
  tileCount: number;
}
