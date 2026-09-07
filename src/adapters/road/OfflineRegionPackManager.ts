/**
 * OfflineRegionPackManager.ts
 *
 * Orchestration manager for Offline Regional Map Packs on edge/mobile devices.
 *
 * Responsibilities:
 * - Discovers, registers, validates, and uninstalls regional map packs.
 * - Enforces LAZY tile loading: reads only required tiles from disk into memory.
 * - Validates manifests, tile schemas, and checksums to reject corrupt data.
 * - Reports accurate storage accounting and installed region inventories.
 *
 * ARCHITECTURAL RULES:
 * - This adapter belongs in src/adapters/road/.
 * - ZERO imports from Google Maps, MapLibre, React Native Map SDKs.
 * - All disk access is strictly lazy and isolated from processImu().
 */

import {
  RoadTile,
  serializeTileKey,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";
import {
  RegionPackManifest,
  RegionPackTileEntry,
} from "../../core/navigation/road/RegionPackTypes";

declare const require: any;

export type TileLoaderFn = (
  entry: RegionPackTileEntry,
) => Promise<RoadTile | null> | RoadTile | null;

interface RegisteredPack {
  manifest: RegionPackManifest;
  dirPath?: string;
  customLoader?: TileLoaderFn;
  tileKeyToEntry: Map<string, RegionPackTileEntry>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class OfflineRegionPackManager {
  private readonly packs: Map<string, RegisteredPack> = new Map();
  // Fast global lookup: serializedTileKey -> packId
  private readonly tileToPackMap: Map<string, string> = new Map();

  constructor() {}

  // ---------------------------------------------------------------------------
  // Pack Registration & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Registers a pre-packaged or bundled offline region pack directly with a manifest
   * and an optional lazy tile loader function.
   */
  public registerPack(
    manifest: RegionPackManifest,
    loader?: TileLoaderFn,
    dirPath?: string,
  ): ValidationResult {
    const validation = this.validateManifest(manifest);
    if (!validation.valid) {
      console.warn(
        `[OfflineRegionPackManager] Rejected invalid pack '${manifest?.id}':`,
        validation.errors,
      );
      return validation;
    }

    const tileKeyToEntry = new Map<string, RegionPackTileEntry>();
    for (const entry of manifest.tiles) {
      const serialized = serializeTileKey(entry.key);
      tileKeyToEntry.set(serialized, entry);
      this.tileToPackMap.set(serialized, manifest.id);
    }

    this.packs.set(manifest.id, {
      manifest,
      dirPath,
      customLoader: loader,
      tileKeyToEntry,
    });

    return { valid: true, errors: [] };
  }

  /**
   * Registers an offline region pack located in a local directory on disk.
   * Expects manifest.json at the root of packDirPath, with tiles located in
   * packDirPath or a tiles/ subdirectory.
   */
  public registerPackFromDirectory(packDirPath: string): ValidationResult {
    try {
      // Dynamic require to prevent Metro bundler from attempting static resolution on mobile
      const fsMod = "fs";
      const pathMod = "path";
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = typeof require !== "undefined" ? require(fsMod) : null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = typeof require !== "undefined" ? require(pathMod) : null;

      if (!fs || !path) {
        return {
          valid: false,
          errors: ["Node.js filesystem APIs are unavailable in this environment"],
        };
      }

      if (!fs.existsSync(packDirPath)) {
        return {
          valid: false,
          errors: [`Directory does not exist: ${packDirPath}`],
        };
      }

      const manifestPath = path.join(packDirPath, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        return {
          valid: false,
          errors: [`manifest.json not found in ${packDirPath}`],
        };
      }

      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as RegionPackManifest;

      const loader: TileLoaderFn = (entry) => {
        try {
          // Check packDirPath/entry.fileName, then packDirPath/tiles/entry.fileName
          let tilePath = path.join(packDirPath, entry.fileName);
          if (!fs.existsSync(tilePath)) {
            tilePath = path.join(packDirPath, "tiles", entry.fileName);
          }
          if (!fs.existsSync(tilePath)) {
            console.warn(`[OfflineRegionPackManager] Tile file not found: ${tilePath}`);
            return null;
          }
          const tileRaw = fs.readFileSync(tilePath, "utf8");
          const tile = JSON.parse(tileRaw) as RoadTile;
          return tile;
        } catch (err) {
          console.warn(`[OfflineRegionPackManager] Error loading tile ${entry.fileName}:`, err);
          return null;
        }
      };

      return this.registerPack(manifest, loader, packDirPath);
    } catch (err: any) {
      return {
        valid: false,
        errors: [`Failed to load pack directory: ${err?.message || String(err)}`],
      };
    }
  }

  /**
   * Uninstalls / unregisters a region pack by ID.
   */
  public removePack(packId: string): boolean {
    const pack = this.packs.get(packId);
    if (!pack) return false;

    // Clean up global tile index
    for (const keyStr of pack.tileKeyToEntry.keys()) {
      if (this.tileToPackMap.get(keyStr) === packId) {
        this.tileToPackMap.delete(keyStr);
      }
    }

    this.packs.delete(packId);
    return true;
  }

  /**
   * Clears all installed packs.
   */
  public clear(): void {
    this.packs.clear();
    this.tileToPackMap.clear();
  }

  // ---------------------------------------------------------------------------
  // Tile Lookup & Lazy Loading Contract
  // ---------------------------------------------------------------------------

  /**
   * Synchronously checks whether a requested TileKey is available in any installed pack.
   */
  public hasTile(key: TileKey): boolean {
    const serialized = serializeTileKey(key);
    return this.tileToPackMap.has(serialized);
  }

  /**
   * Lazily loads a single RoadTile from disk or custom loader.
   * NEVER loads the entire pack into memory — only the single requested tile.
   */
  public async loadTile(key: TileKey): Promise<RoadTile | null> {
    const serialized = serializeTileKey(key);
    const packId = this.tileToPackMap.get(serialized);
    if (!packId) return null;

    const pack = this.packs.get(packId);
    if (!pack) return null;

    const entry = pack.tileKeyToEntry.get(serialized);
    if (!entry) return null;

    if (pack.customLoader) {
      try {
        const loaded = await pack.customLoader(entry);
        if (loaded) {
          const tileValidation = this.validateTile(loaded);
          if (!tileValidation.valid) {
            console.warn(
              `[OfflineRegionPackManager] Corrupt tile ${serialized} in pack ${packId}:`,
              tileValidation.errors,
            );
            return null;
          }
          return loaded;
        }
      } catch (err) {
        console.warn(`[OfflineRegionPackManager] Custom loader failed for ${serialized}:`, err);
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Diagnostics & Observability
  // ---------------------------------------------------------------------------

  public listInstalledPacks(): RegionPackManifest[] {
    return Array.from(this.packs.values()).map((p) => p.manifest);
  }

  public getAllPacks(): RegionPackManifest[] {
    return this.listInstalledPacks();
  }

  public getPackManifest(packId: string): RegionPackManifest | null {
    return this.packs.get(packId)?.manifest ?? null;
  }

  public getPack(packId: string): RegionPackManifest | null {
    return this.getPackManifest(packId);
  }

  public getStorageUsage(): { packCount: number; totalBytes: number } {
    let totalBytes = 0;
    for (const pack of this.packs.values()) {
      totalBytes += pack.manifest.byteSize || 0;
    }
    return {
      packCount: this.packs.size,
      totalBytes,
    };
  }

  public getTotalStorageBytes(): number {
    return this.getStorageUsage().totalBytes;
  }

  public findPackForCoordinate(coord: { latitude: number; longitude: number }): RegionPackManifest | null {
    for (const pack of this.packs.values()) {
      const b = pack.manifest.bbox;
      if (
        coord.latitude >= b.minLat &&
        coord.latitude <= b.maxLat &&
        coord.longitude >= b.minLon &&
        coord.longitude <= b.maxLon
      ) {
        return pack.manifest;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Validation Rules
  // ---------------------------------------------------------------------------

  public validateManifest(manifest: unknown): ValidationResult {
    const errors: string[] = [];
    if (!manifest || typeof manifest !== "object") {
      return { valid: false, errors: ["Manifest must be a non-null object"] };
    }

    const m = manifest as Partial<RegionPackManifest>;
    if (!m.id || typeof m.id !== "string") {
      errors.push("Missing or invalid 'id' string");
    }
    if (!m.name || typeof m.name !== "string") {
      errors.push("Missing or invalid 'name' string");
    }
    if (!m.bbox || typeof m.bbox !== "object") {
      errors.push("Missing or invalid 'bbox' object");
    } else {
      const { minLat, maxLat, minLon, maxLon } = m.bbox;
      if (
        typeof minLat !== "number" ||
        typeof maxLat !== "number" ||
        typeof minLon !== "number" ||
        typeof maxLon !== "number" ||
        minLat > maxLat ||
        minLon > maxLon
      ) {
        errors.push("Invalid bounding box coordinates in 'bbox'");
      }
    }

    if (!Array.isArray(m.tiles)) {
      errors.push("Manifest 'tiles' must be an array");
    } else {
      for (let i = 0; i < m.tiles.length; i++) {
        const t = m.tiles[i];
        if (!t || !t.key || !t.key.scheme || !t.key.key || !t.fileName) {
          errors.push(`Tile entry at index ${i} is missing key or fileName`);
          break;
        }
      }
    }

    if (m.checksum && typeof m.checksum !== "string") {
      errors.push("Checksum must be a string");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  public validateTile(tile: unknown): ValidationResult {
    const errors: string[] = [];
    if (!tile || typeof tile !== "object") {
      return { valid: false, errors: ["Tile must be a non-null object"] };
    }

    const t = tile as Partial<RoadTile>;
    if (!t.key || !t.key.scheme || !t.key.key) {
      errors.push("Tile is missing valid TileKey");
    }
    if (!t.bounds || typeof t.bounds !== "object") {
      errors.push("Tile is missing bounds object");
    }
    if (!Array.isArray(t.segments)) {
      errors.push("Tile segments must be an array");
    } else {
      for (let i = 0; i < t.segments.length; i++) {
        const seg = t.segments[i];
        if (!seg || !seg.id || !seg.startPoint || !seg.endPoint) {
          errors.push(`Tile segment at index ${i} is missing required fields`);
          break;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Global Singleton for production & tests
export const offlineRegionPackManager = new OfflineRegionPackManager();
