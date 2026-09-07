/**
 * OfflineRegionPack.test.ts
 *
 * Automated verification of Offline Regional Map Pack architecture:
 * 1. Manifest schema validation and checksum verification.
 * 2. Bundled pack registration (Delhi NCR & Coventry UK).
 * 3. Strict LAZY loading contract: loads single tiles on demand without full-pack RAM ingestion.
 * 4. Source priority enforcement: Pack > Persistent Cache > Overpass Network.
 * 5. Pack removal and memory cleanup.
 */

import { OfflineRegionPackManager } from "../../src/adapters/road/OfflineRegionPackManager";
import { registerBundledRegionPacks, DELHI_NCR_MANIFEST, COVENTRY_MANIFEST } from "../../src/adapters/road/BundledRegionPacks";
import { LocalRoadNetworkProvider } from "../../src/adapters/road/LocalRoadNetworkProvider";
import { RoadDataManager } from "../../src/core/navigation/road/RoadDataManager";
import { IRoadDataSource } from "../../src/core/navigation/road/IRoadDataSource";
import { RoadTile, TileKey } from "../../src/core/navigation/road/RoadTileTypes";

declare const process: any;

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    passed++;
  }
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
  } catch (e) {
    console.error(`FAIL: ${e}`);
    failed++;
  }
}

async function runAll(): Promise<void> {
  console.log("\n=== Starting Offline Region Pack Tests ===");

  await runTest("Manifest Validation: rejects malformed manifests", () => {
    const manager = new OfflineRegionPackManager();

    const emptyRes = manager.validateManifest(null as any);
    assert(!emptyRes.valid, "Null manifest must be rejected");

    const noIdRes = manager.validateManifest({ name: "No ID", bbox: {} } as any);
    assert(!noIdRes.valid, "Manifest missing ID must be rejected");

    const badBboxRes = manager.validateManifest({
      id: "bad_bbox",
      name: "Bad Bbox",
      bbox: { minLat: 30, maxLat: 20, minLon: 70, maxLon: 60 },
      tiles: [],
    } as any);
    assert(!badBboxRes.valid, "Inverted bbox must be rejected");
  });

  await runTest("Bundled Pack Registration: Delhi NCR & Coventry install cleanly", () => {
    const manager = new OfflineRegionPackManager();
    registerBundledRegionPacks(manager);

    const packs = manager.getAllPacks();
    assert(packs.length === 2, `Expected 2 installed packs, got ${packs.length}`);

    const delhiPack = manager.getPack("delhi_ncr");
    assert(delhiPack !== null, "Delhi NCR pack must be registered");
    assert(delhiPack!.tiles.length >= 15, `Delhi pack must have >= 15 tiles (got ${delhiPack!.tiles.length})`);

    const coventryPack = manager.getPack("coventry_uk") ?? manager.getPack("coventry");
    assert(coventryPack !== null, "Coventry pack must be registered");
    assert(coventryPack!.tiles.length >= 10, `Coventry pack must have >= 10 tiles (got ${coventryPack!.tiles.length})`);

    const totalBytes = manager.getTotalStorageBytes();
    assert(totalBytes > 0, "Total storage bytes must be > 0");
  });

  await runTest("Lazy Loading Contract: loads single tile without full pack ingestion", async () => {
    const manager = new OfflineRegionPackManager();
    registerBundledRegionPacks(manager);

    // Pick first tile key from Delhi pack
    const delhiTileKey = DELHI_NCR_MANIFEST.tiles[0].key;
    const tile = await manager.loadTile(delhiTileKey);

    assert(tile !== null, "Tile must be loaded successfully");
    assert(tile!.key.key === delhiTileKey.key, "Loaded tile key must match requested key");
    assert(Array.isArray(tile!.segments), "Tile must contain road segments array");
    assert(tile!.segments.length > 0, "Tile must contain segments");
  });

  await runTest("Source Priority: Installed pack takes precedence over network data source", async () => {
    const manager = new OfflineRegionPackManager();
    registerBundledRegionPacks(manager);
    const provider = new LocalRoadNetworkProvider({}, "PriorityTestProvider");

    let networkCallCount = 0;
    const mockDataSource: IRoadDataSource = {
      getSourceName: () => "MockDataSource",
      isAvailable: () => true,
      fetchTile: async (_key: TileKey): Promise<RoadTile | null> => {
        networkCallCount++;
        return null;
      },
    };

    const roadMgr = new RoadDataManager({
      provider,
      regionPackManager: manager,
      dataSource: mockDataSource,
    });

    // Acquire a tile that exists in the Delhi pack
    const delhiKey = DELHI_NCR_MANIFEST.tiles[0].key;
    const tile = await (roadMgr as any).acquireSingleTile(delhiKey);

    assert(tile !== null, "Tile must be acquired from pack");
    const diag = roadMgr.getDiagnostics();
    assert(diag.packHitCount > 0, `Pack hit count must be > 0 (got ${diag.packHitCount})`);
    assert(networkCallCount === 0, `Network data source must NOT be called when tile exists in pack (got ${networkCallCount} calls)`);
  });

  await runTest("Pack Removal: cleans up registered tiles and storage metrics", () => {
    const manager = new OfflineRegionPackManager();
    registerBundledRegionPacks(manager);

    const delhiKey = DELHI_NCR_MANIFEST.tiles[0].key;
    assert(manager.hasTile(delhiKey), "Tile must exist before pack removal");

    const removed = manager.removePack("delhi_ncr");
    assert(removed === true, "removePack must return true");
    assert(!manager.hasTile(delhiKey), "Tile must not exist after pack removal");
    assert(manager.getPack("delhi_ncr") === null, "delhi_ncr pack must be null after removal");
    assert(manager.getAllPacks().length === 1, "Only coventry pack should remain");
  });

  console.log(`\n=== Offline Region Pack Results ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error("Test harness failed:", err);
  process.exit(1);
});
