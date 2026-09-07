/**
 * InMemoryRoadCache.ts
 *
 * In-memory test double implementing IRoadCache.
 * Provides async cache interface for testing tile persistence, eviction, and lifecycle
 * without touching disk or native file systems.
 *
 * ARCHITECTURAL RULE:
 * Belongs in src/adapters/road/. Zero external imports.
 */

import { IRoadCache } from "../../core/navigation/road/IRoadCache";
import {
  RoadTile,
  serializeTileKey,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";

export class InMemoryRoadCache implements IRoadCache {
  private readonly cache: Map<string, RoadTile> = new Map();

  public async getTile(key: TileKey): Promise<RoadTile | null> {
    const tile = this.cache.get(serializeTileKey(key));
    return tile ? JSON.parse(JSON.stringify(tile)) : null;
  }

  public async putTile(tile: RoadTile): Promise<void> {
    this.cache.set(serializeTileKey(tile.key), JSON.parse(JSON.stringify(tile)));
  }

  public async removeTile(key: TileKey): Promise<void> {
    this.cache.delete(serializeTileKey(key));
  }

  public async hasTile(key: TileKey): Promise<boolean> {
    return this.cache.has(serializeTileKey(key));
  }

  public async getCachedKeys(): Promise<TileKey[]> {
    return Array.from(this.cache.values()).map((t) => t.key);
  }

  public async clear(): Promise<void> {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}