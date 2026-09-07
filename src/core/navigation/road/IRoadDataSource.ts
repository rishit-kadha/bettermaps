/**
 * IRoadDataSource.ts
 *
 * Asynchronous data source interface for acquiring road network tiles from
 * external sources (OSM Overpass, vector tile endpoints, pre-bundled regional
 * extracts, or mock test fixtures).
 *
 * ARCHITECTURAL RULES:
 * - This interface belongs in src/core/navigation/road/.
 * - It must have ZERO imports from Google Maps, OSM, Overpass, SQLite, Expo, or React Native.
 * - All calls to IRoadDataSource execute strictly asynchronously in background tasks
 *   and NEVER inside the 100 Hz estimator loop.
 */

import { RoadTile, TileKey } from "./RoadTileTypes";

export interface IRoadDataSource {
  /**
   * Asynchronously fetches road tile data for the given tile key.
   * Returns null if the tile cannot be retrieved or contains no road data.
   */
  fetchTile(key: TileKey): Promise<RoadTile | null>;

  /**
   * Returns human-readable source name for logging and diagnostics.
   */
  getSourceName(): string;

  /**
   * Indicates whether this data source is operational and available
   * (e.g. online connectivity check or fixture availability).
   */
  isAvailable(): boolean;
}