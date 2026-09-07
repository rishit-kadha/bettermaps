/**
 * IRoadCache.ts
 *
 * Asynchronous persistence and cache interface for road network tiles.
 * Supports L2 disk/filesystem cache (backed by IStorageDriver or FileStorageDriver)
 * as well as in-memory test doubles.
 *
 * ARCHITECTURAL RULES:
 * - This interface belongs in src/core/navigation/road/.
 * - ZERO platform imports (no Expo, React Native, SQLite, or filesystem APIs).
 * - The estimator never calls IRoadCache directly; cache management runs
 *   strictly asynchronously in background coordinator tasks.
 */

import { RoadTile, TileKey } from "./RoadTileTypes";

export interface IRoadCache {
  /**
   * Retrieves a cached road tile by its key, or null if not in cache.
   */
  getTile(key: TileKey): Promise<RoadTile | null>;

  /**
   * Stores or updates a road tile in the persistent cache.
   */
  putTile(tile: RoadTile): Promise<void>;

  /**
   * Removes a specific tile from the cache.
   */
  removeTile(key: TileKey): Promise<void>;

  /**
   * Checks whether a tile exists in the cache without loading full geometry.
   */
  hasTile(key: TileKey): Promise<boolean>;

  /**
   * Returns all tile keys currently present in the cache.
   */
  getCachedKeys(): Promise<TileKey[]>;

  /**
   * Clears all tiles from the cache.
   */
  clear(): Promise<void>;
}