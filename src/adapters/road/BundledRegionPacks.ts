/**
 * BundledRegionPacks.ts
 *
 * Pre-bundled offline regional map packs for edge deployment:
 * 1. Delhi NCR (South Delhi room area 28.58, 77.16 to Connaught Place, India Gate, Ring Road)
 * 2. Coventry, UK (IO-VNBD driving benchmark region)
 *
 * Provides hybrid resolution for both Node.js (via process.cwd()) and React Native Metro bundler.
 */

import { OfflineRegionPackManager } from "./OfflineRegionPackManager";
import { RegionPackManifest } from "../../core/navigation/road/RegionPackTypes";
import { RoadTile } from "../../core/navigation/road/RoadTileTypes";

declare const require: any;
declare const process: any;

function loadManifest(relPath: string, fallback: () => any): RegionPackManifest {
  try {
    const fsMod = "fs";
    const pathMod = "path";
    const fs = typeof require !== "undefined" ? require(fsMod) : null;
    const path = typeof require !== "undefined" ? require(pathMod) : null;
    if (fs && path && typeof process !== "undefined" && process.cwd) {
      const fullPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        return JSON.parse(fs.readFileSync(fullPath, "utf8")) as RegionPackManifest;
      }
    }
  } catch {
    // Ignore and fallback
  }
  return fallback() as RegionPackManifest;
}

export const DELHI_NCR_MANIFEST: RegionPackManifest = loadManifest(
  "assets/region_packs/delhi_ncr/manifest.json",
  () => require("../../../assets/region_packs/delhi_ncr/manifest.json"),
);

export const COVENTRY_MANIFEST: RegionPackManifest = loadManifest(
  "assets/region_packs/coventry/manifest.json",
  () => require("../../../assets/region_packs/coventry/manifest.json"),
);

// Lazy loaders for React Native bundling (never called synchronously at module load time)
const LAZY_BUNDLED_TILES: Record<string, () => any> = {
  // Delhi NCR tiles
  "delhi_ncr:tiles/tile_100_2856_7720.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2856_7720.json"),
  "delhi_ncr:tiles/tile_100_2858_7716.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2858_7716.json"),
  "delhi_ncr:tiles/tile_100_2858_7717.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2858_7717.json"),
  "delhi_ncr:tiles/tile_100_2858_7718.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2858_7718.json"),
  "delhi_ncr:tiles/tile_100_2858_7720.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2858_7720.json"),
  "delhi_ncr:tiles/tile_100_2858_7722.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2858_7722.json"),
  "delhi_ncr:tiles/tile_100_2860_7719.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2860_7719.json"),
  "delhi_ncr:tiles/tile_100_2860_7722.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2860_7722.json"),
  "delhi_ncr:tiles/tile_100_2861_7720.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2861_7720.json"),
  "delhi_ncr:tiles/tile_100_2861_7721.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2861_7721.json"),
  "delhi_ncr:tiles/tile_100_2861_7722.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2861_7722.json"),
  "delhi_ncr:tiles/tile_100_2861_7723.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2861_7723.json"),
  "delhi_ncr:tiles/tile_100_2862_7721.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2862_7721.json"),
  "delhi_ncr:tiles/tile_100_2862_7722.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2862_7722.json"),
  "delhi_ncr:tiles/tile_100_2862_7723.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2862_7723.json"),
  "delhi_ncr:tiles/tile_100_2863_7721.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2863_7721.json"),
  "delhi_ncr:tiles/tile_100_2863_7722.json": () => require("../../../assets/region_packs/delhi_ncr/tiles/tile_100_2863_7722.json"),

  // Coventry UK tiles (all 30 tiles generated from OpenStreetMap highway network)
  "coventry:tiles/tile_100_5238_-149.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5238_-149.json"),
  "coventry:tiles/tile_100_5238_-150.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5238_-150.json"),
  "coventry:tiles/tile_100_5238_-151.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5238_-151.json"),
  "coventry:tiles/tile_100_5238_-152.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5238_-152.json"),
  "coventry:tiles/tile_100_5238_-153.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5238_-153.json"),
  "coventry:tiles/tile_100_5238_-154.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5238_-154.json"),
  "coventry:tiles/tile_100_5239_-149.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-149.json"),
  "coventry:tiles/tile_100_5239_-150.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-150.json"),
  "coventry:tiles/tile_100_5239_-151.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-151.json"),
  "coventry:tiles/tile_100_5239_-152.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-152.json"),
  "coventry:tiles/tile_100_5239_-153.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-153.json"),
  "coventry:tiles/tile_100_5239_-154.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-154.json"),
  "coventry:tiles/tile_100_5239_-155.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5239_-155.json"),
  "coventry:tiles/tile_100_5240_-149.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5240_-149.json"),
  "coventry:tiles/tile_100_5240_-150.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5240_-150.json"),
  "coventry:tiles/tile_100_5240_-151.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5240_-151.json"),
  "coventry:tiles/tile_100_5240_-152.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5240_-152.json"),
  "coventry:tiles/tile_100_5240_-153.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5240_-153.json"),
  "coventry:tiles/tile_100_5240_-154.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5240_-154.json"),
  "coventry:tiles/tile_100_5241_-149.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-149.json"),
  "coventry:tiles/tile_100_5241_-150.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-150.json"),
  "coventry:tiles/tile_100_5241_-151.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-151.json"),
  "coventry:tiles/tile_100_5241_-152.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-152.json"),
  "coventry:tiles/tile_100_5241_-153.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-153.json"),
  "coventry:tiles/tile_100_5241_-154.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-154.json"),
  "coventry:tiles/tile_100_5241_-155.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5241_-155.json"),
  "coventry:tiles/tile_100_5242_-151.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5242_-151.json"),
  "coventry:tiles/tile_100_5242_-152.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5242_-152.json"),
  "coventry:tiles/tile_100_5242_-153.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5242_-153.json"),
  "coventry:tiles/tile_100_5242_-154.json": () => require("../../../assets/region_packs/coventry/tiles/tile_100_5242_-154.json"),
};

function resolveTile(packId: string, relPackDir: string, fileName: string): RoadTile | null {
  try {
    const fsMod = "fs";
    const pathMod = "path";
    const fs = typeof require !== "undefined" ? require(fsMod) : null;
    const path = typeof require !== "undefined" ? require(pathMod) : null;
    if (fs && path && typeof process !== "undefined" && process.cwd) {
      const fullPath = path.resolve(process.cwd(), relPackDir, fileName);
      if (fs.existsSync(fullPath)) {
        return JSON.parse(fs.readFileSync(fullPath, "utf8")) as RoadTile;
      }
    }
  } catch {
    // Ignore and fallback
  }

  const key = `${packId}:${fileName}`;
  const lazy = LAZY_BUNDLED_TILES[key];
  if (lazy) {
    try {
      return lazy() as RoadTile;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Registers both pre-bundled regional map packs (Delhi NCR and Coventry)
 * with the given OfflineRegionPackManager.
 */
export function registerBundledRegionPacks(
  manager: OfflineRegionPackManager,
): void {
  // 1. Delhi NCR
  manager.registerPack(
    DELHI_NCR_MANIFEST,
    (entry) => resolveTile("delhi_ncr", "assets/region_packs/delhi_ncr", entry.fileName),
    "assets/region_packs/delhi_ncr",
  );

  // 2. Coventry UK
  manager.registerPack(
    COVENTRY_MANIFEST,
    (entry) => resolveTile("coventry", "assets/region_packs/coventry", entry.fileName),
    "assets/region_packs/coventry",
  );
}
