/**
 * MockRoadDataSource.ts
 *
 * In-memory test double implementing IRoadDataSource.
 * Allows pre-populating synthetic tiles for deterministic testing with zero
 * network or disk I/O.
 *
 * ARCHITECTURAL RULE:
 * Belongs in src/adapters/road/. Zero external imports.
 */

import { IRoadDataSource } from "../../core/navigation/road/IRoadDataSource";
import {
  RoadTile,
  serializeTileKey,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";

export class MockRoadDataSource implements IRoadDataSource {
  private readonly tiles: Map<string, RoadTile> = new Map();
  private readonly fetchCounts: Map<string, number> = new Map();
  private available = true;
  private readonly name: string;

  constructor(name = "MockRoadDataSource") {
    this.name = name;
  }

  public addMockTile(tile: RoadTile): void {
    this.tiles.set(serializeTileKey(tile.key), tile);
  }

  public setAvailable(available: boolean): void {
    this.available = available;
  }

  public async fetchTile(key: TileKey): Promise<RoadTile | null> {
    if (!this.available) return null;
    const keyStr = serializeTileKey(key);
    this.fetchCounts.set(keyStr, (this.fetchCounts.get(keyStr) ?? 0) + 1);
    const tile = this.tiles.get(keyStr);
    return tile ? JSON.parse(JSON.stringify(tile)) : null;
  }

  public getFetchCount(key: TileKey): number {
    return this.fetchCounts.get(serializeTileKey(key)) ?? 0;
  }

  public getTotalFetchCount(): number {
    let total = 0;
    for (const c of this.fetchCounts.values()) total += c;
    return total;
  }

  public getSourceName(): string {
    return this.name;
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public clear(): void {
    this.tiles.clear();
    this.fetchCounts.clear();
  }
}