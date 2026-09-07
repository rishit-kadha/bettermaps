/**
 * PersistentRoadCache.ts
 *
 * Multi-tier persistent road network tile cache for BetterMaps.
 * Combines an in-memory L1 cache with an optional persistent L2 storage driver
 * (IStorageDriver, backed by FileStorageDriver on React Native / Expo).
 *
 * Features:
 * - Implements IRoadCache with asynchronous access.
 * - LRU eviction when storage exceeds configured byte threshold.
 * - Pure asynchronous API executed outside the estimator loop.
 *
 * ARCHITECTURAL RULE:
 * This adapter belongs in src/adapters/road/.
 * Core positioning code must never import this file.
 */

import { IRoadCache } from "../../core/navigation/road/IRoadCache";
import {
  RoadTile,
  serializeTileKey,
  parseTileKey,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";
import { IStorageDriver } from "../../core/storage/IStorageDriver";

interface CachedEntry {
  tile: RoadTile;
  lastAccessedMs: number;
  byteSize: number;
}

export interface PersistentRoadCacheConfig {
  /** Maximum cache capacity in bytes (default 50 MB) */
  maxBytes: number;
  /** Key prefix used in storage driver */
  keyPrefix: string;
}

export const DEFAULT_ROAD_CACHE_CONFIG: PersistentRoadCacheConfig = {
  maxBytes: 50 * 1024 * 1024, // 50 MB
  keyPrefix: "road_tile:",
};

export class PersistentRoadCache implements IRoadCache {
  private readonly storageDriver?: IStorageDriver;
  private readonly config: PersistentRoadCacheConfig;
  private readonly l1Cache: Map<string, CachedEntry> = new Map();
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(
    storageDriver?: IStorageDriver,
    config?: Partial<PersistentRoadCacheConfig>,
  ) {
    this.storageDriver = storageDriver;
    this.config = { ...DEFAULT_ROAD_CACHE_CONFIG, ...config };
  }

  public async getTile(key: TileKey): Promise<RoadTile | null> {
    const keyStr = serializeTileKey(key);

    // 1. Check L1 Memory Cache
    const entry = this.l1Cache.get(keyStr);
    if (entry) {
      entry.lastAccessedMs = Date.now();
      this.hitCount++;
      return entry.tile;
    }

    // 2. Check L2 Persistent Storage Driver
    if (this.storageDriver) {
      try {
        const raw = await this.storageDriver.getItem(
          `${this.config.keyPrefix}${keyStr}`,
        );
        if (raw) {
          const tile = JSON.parse(raw) as RoadTile;
          const byteSize = raw.length * 2; // Approximate JS string byte size
          this.putL1(keyStr, tile, byteSize);
          this.hitCount++;
          return tile;
        }
      } catch (err) {
        console.warn(`[PersistentRoadCache] Failed to load tile ${keyStr} from storage:`, err);
      }
    }

    this.missCount++;
    return null;
  }

  public async putTile(tile: RoadTile): Promise<void> {
    const keyStr = serializeTileKey(tile.key);
    const serialized = JSON.stringify(tile);
    const byteSize = serialized.length * 2;

    // Put into L1 Memory
    this.putL1(keyStr, tile, byteSize);

    // Put into L2 Storage Driver
    if (this.storageDriver) {
      try {
        await this.storageDriver.setItem(
          `${this.config.keyPrefix}${keyStr}`,
          serialized,
        );
      } catch (err) {
        console.warn(`[PersistentRoadCache] Failed to persist tile ${keyStr}:`, err);
      }
    }

    // Prune if over capacity
    if (this.totalBytes > this.config.maxBytes) {
      await this.prune(this.config.maxBytes);
    }
  }

  public async removeTile(key: TileKey): Promise<void> {
    const keyStr = serializeTileKey(key);
    const entry = this.l1Cache.get(keyStr);
    if (entry) {
      this.totalBytes -= entry.byteSize;
      this.l1Cache.delete(keyStr);
    }

    if (this.storageDriver) {
      try {
        await this.storageDriver.removeItem(
          `${this.config.keyPrefix}${keyStr}`,
        );
      } catch (err) {
        console.warn(`[PersistentRoadCache] Failed to remove tile ${keyStr}:`, err);
      }
    }
  }

  public async hasTile(key: TileKey): Promise<boolean> {
    const keyStr = serializeTileKey(key);
    if (this.l1Cache.has(keyStr)) {
      return true;
    }
    if (this.storageDriver) {
      try {
        const raw = await this.storageDriver.getItem(
          `${this.config.keyPrefix}${keyStr}`,
        );
        return raw !== null;
      } catch {
        return false;
      }
    }
    return false;
  }

  public async getCachedKeys(): Promise<TileKey[]> {
    const keysMap = new Map<string, TileKey>();

    for (const [keyStr, entry] of this.l1Cache.entries()) {
      keysMap.set(keyStr, entry.tile.key);
    }

    if (this.storageDriver) {
      try {
        const allKeys = await this.storageDriver.getAllKeys();
        for (const k of allKeys) {
          if (k.startsWith(this.config.keyPrefix)) {
            const rawKey = k.slice(this.config.keyPrefix.length);
            if (!keysMap.has(rawKey)) {
              keysMap.set(rawKey, parseTileKey(rawKey));
            }
          }
        }
      } catch (err) {
        console.warn("[PersistentRoadCache] Failed to list cached keys:", err);
      }
    }

    return Array.from(keysMap.values());
  }

  public async clear(): Promise<void> {
    this.l1Cache.clear();
    this.totalBytes = 0;

    if (this.storageDriver) {
      try {
        const keys = await this.storageDriver.getAllKeys();
        for (const k of keys) {
          if (k.startsWith(this.config.keyPrefix)) {
            await this.storageDriver.removeItem(k);
          }
        }
      } catch (err) {
        console.warn("[PersistentRoadCache] Failed to clear storage driver:", err);
      }
    }
  }

  public async prune(maxAllowedBytes: number): Promise<void> {
    if (this.totalBytes <= maxAllowedBytes) {
      return;
    }

    // Sort entries by oldest lastAccessedMs
    const entries = Array.from(this.l1Cache.entries()).sort(
      (a, b) => a[1].lastAccessedMs - b[1].lastAccessedMs,
    );

    for (const [keyStr, entry] of entries) {
      if (this.totalBytes <= maxAllowedBytes) {
        break;
      }
      this.totalBytes -= entry.byteSize;
      this.l1Cache.delete(keyStr);
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  public getHitCount(): number {
    return this.hitCount;
  }

  public getMissCount(): number {
    return this.missCount;
  }

  public getByteSize(): number {
    return this.totalBytes;
  }

  public getTileCount(): number {
    return this.l1Cache.size;
  }

  private putL1(keyStr: string, tile: RoadTile, byteSize: number): void {
    const existing = this.l1Cache.get(keyStr);
    if (existing) {
      this.totalBytes -= existing.byteSize;
    }
    this.l1Cache.set(keyStr, {
      tile,
      lastAccessedMs: Date.now(),
      byteSize,
    });
    this.totalBytes += byteSize;
  }
}
