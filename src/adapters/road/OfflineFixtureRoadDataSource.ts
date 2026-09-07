/**
 * OfflineFixtureRoadDataSource.ts
 *
 * Deterministic offline road tile data source for BetterMaps.
 * Implements IRoadDataSource by loading pre-generated offline RoadTile fixtures
 * from memory or local filesystem storage outside the estimator loop.
 *
 * Features:
 * - Pure asynchronous API (returns Promise<RoadTile | null>).
 * - Pluggable simulated latency for async non-blocking verification.
 * - Pluggable failure injection for graceful degradation testing.
 * - Safe null return on missing tiles without throwing.
 *
 * ARCHITECTURAL RULE:
 * This adapter belongs in src/adapters/road/.
 * Core positioning code must never import this file.
 */

import { IRoadDataSource } from "../../core/navigation/road/IRoadDataSource";
import {
  RoadTile,
  serializeTileKey,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";

declare const require: any;

export class OfflineFixtureRoadDataSource implements IRoadDataSource {
  private readonly sourceName: string;
  private readonly fixtures: Map<string, RoadTile> = new Map();
  private simulatedLatencyMs = 0;
  private simulatedFailure = false;
  private fetchCount = 0;

  constructor(name = "OfflineFixtureRoadDataSource") {
    this.sourceName = name;
  }

  /**
   * Registers a RoadTile fixture into the data source.
   */
  public registerFixture(tile: RoadTile): void {
    const keyStr = serializeTileKey(tile.key);
    this.fixtures.set(keyStr, tile);
  }

  /**
   * Loads all JSON tile fixtures from a specified directory.
   */
  public loadFromDirectory(directoryPath: string): number {
    let count = 0;
    try {
      const req = (globalThis as any).require;
      const fs = req ? req("fs") : null;
      const path = req ? req("path") : null;

      if (!fs || !path || !fs.existsSync(directoryPath)) {
        return 0;
      }

      const files: string[] = fs.readdirSync(directoryPath);
      for (const file of files) {
        if (file.endsWith(".json") && file !== "manifest.json") {
          const fullPath = path.join(directoryPath, file);
          const raw = fs.readFileSync(fullPath, "utf8");
          const tile = JSON.parse(raw) as RoadTile;
          if (tile && tile.key && tile.segments) {
            this.registerFixture(tile);
            count++;
          }
        }
      }
    } catch (err) {
      console.warn(`[OfflineFixtureRoadDataSource] Error loading fixtures from ${directoryPath}:`, err);
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // IRoadDataSource
  // ---------------------------------------------------------------------------

  public async fetchTile(key: TileKey): Promise<RoadTile | null> {
    this.fetchCount++;

    if (this.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatencyMs));
    }

    if (this.simulatedFailure) {
      return null;
    }

    const keyStr = serializeTileKey(key);
    const tile = this.fixtures.get(keyStr);
    return tile ?? null;
  }

  public getSourceName(): string {
    return this.sourceName;
  }

  public isAvailable(): boolean {
    return !this.simulatedFailure && this.fixtures.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Diagnostic and Testing Configuration
  // ---------------------------------------------------------------------------

  public setSimulatedLatencyMs(latencyMs: number): void {
    this.simulatedLatencyMs = Math.max(0, latencyMs);
  }

  public setSimulatedFailure(shouldFail: boolean): void {
    this.simulatedFailure = shouldFail;
  }

  public getFetchCount(): number {
    return this.fetchCount;
  }

  public getRegisteredCount(): number {
    return this.fixtures.size;
  }

  public clear(): void {
    this.fixtures.clear();
    this.fetchCount = 0;
  }
}
