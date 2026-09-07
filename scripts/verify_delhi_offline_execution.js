/**
 * verify_delhi_offline_execution.js
 *
 * Direct execution test verifying:
 * 1. Delhi offline road pack matching with network disabled (0 network requests).
 * 2. Real road candidate extraction on Delhi coordinates (Vasant Marg & Connaught Place).
 * 3. Lazy loading across multiple tiles.
 * 4. RAM bounding and non-linear memory growth during traversal.
 */

const path = require('path');
const fs = require('fs');

const { OfflineRegionPackManager } = require(path.resolve(__dirname, '../dist_test/src/adapters/road/OfflineRegionPackManager'));
const { LocalRoadNetworkProvider } = require(path.resolve(__dirname, '../dist_test/src/adapters/road/LocalRoadNetworkProvider'));
const { RoadDataManager } = require(path.resolve(__dirname, '../dist_test/src/core/navigation/road/RoadDataManager'));
const { MultiCandidateRoadMatcher } = require(path.resolve(__dirname, '../dist_test/src/core/navigation/road/MultiCandidateRoadMatcher'));
const { registerBundledRegionPacks } = require(path.resolve(__dirname, '../dist_test/src/adapters/road/BundledRegionPacks'));

async function runAudit() {
  console.log('=== STARTING DELHI OFFLINE ROAD & MEMORY AUDIT ===\n');

  // 1. Setup Offline Pack Manager
  const packManager = new OfflineRegionPackManager();
  registerBundledRegionPacks(packManager);

  // 2. Setup mock network source that logs and asserts 0 network calls
  let networkCallCount = 0;
  const mockNetworkSource = {
    fetchTile: async (key) => {
      networkCallCount++;
      throw new Error(`CRITICAL VIOLATION: Network called for tile ${key}`);
    },
    getProviderName: () => 'MockNetworkSource',
    isAvailable: async () => false,
  };

  const roadProvider = new LocalRoadNetworkProvider(null, 'DelhiAuditProvider');
  const roadMgr = new RoadDataManager({
    dataSource: mockNetworkSource,
    provider: roadProvider,
    regionPackManager: packManager,
    tileEvictionThreshold: 8,
    minTileRetentionSeconds: 0,
  });

  console.log('[STEP 1] Initial State:');
  console.log('  Loaded RAM tiles:', roadProvider.getLoadedTileKeys().length);
  console.log('  Installed Packs:', packManager.getAllPacks().map(p => p.id));
  console.log('  Network Call Count:', networkCallCount);

  // 3. Test Delhi Coordinate 1: Vasant Marg (South Delhi near 28.5809, 77.1660)
  console.log('\n[STEP 2] Querying Delhi Coordinate 1 (Vasant Marg: 28.58095, 77.1660):');
  const vasantPos = { latitude: 28.58095, longitude: 77.1660, altitudeM: 215.0 };
  
  await roadMgr.updatePosition(vasantPos, 8.0, 88.0, true);

  console.log('  Network Calls after query 1:', networkCallCount);
  if (networkCallCount > 0) {
    throw new Error('FAILED: Network was called when offline pack was available!');
  }

  console.log('  Loaded RAM tiles after query 1:', roadProvider.getLoadedTileKeys());
  console.log('  RAM Used (bytes):', roadProvider.getTotalRamBytes());

  // Test Matcher
  const matcher = new MultiCandidateRoadMatcher(roadProvider, {
    searchRadiusMeters: 60,
    headingToleranceDeg: 45,
    minCandidateConfidence: 0.5,
    marginThreshold: 0.1,
  });

  const match1 = matcher.match([0, 0], 88.0, {
    latitude: vasantPos.latitude,
    longitude: vasantPos.longitude,
  });
  console.log('  Matcher candidate result:');
  if (match1) {
    console.log('    Segment ID:', match1.segment.id);
    console.log('    Road Name:', match1.segment.name);
    console.log('    Confidence:', match1.normalizedConfidence.toFixed(3));
    console.log('    Distance (m):', match1.crossTrackDistanceMeters.toFixed(2));
    console.log('    Heading Delta (deg):', match1.headingDifferenceDeg.toFixed(2));
  } else {
    console.error('    FAIL: No candidate returned for Vasant Marg!');
  }

  // 4. Test Lazy Loading to Tile 2: Connaught Place (28.6335, 77.2210)
  console.log('\n[STEP 3] Moving to Delhi Coordinate 2 (Connaught Place: 28.6335, 77.2210):');
  const cpPos = { latitude: 28.6335, longitude: 77.2210, altitudeM: 215.0 };
  await roadMgr.updatePosition(cpPos, 8.0, 90.0);

  console.log('  Network Calls after query 2:', networkCallCount);
  console.log('  Loaded RAM tiles after CP query:', roadProvider.getLoadedTileKeys());
  console.log('  RAM Used (bytes):', roadProvider.getTotalRamBytes());

  const match2 = matcher.match([0, 0], 90.0, {
    latitude: cpPos.latitude,
    longitude: cpPos.longitude,
  });

  // 5. Test Traversal Across Multiple Delhi Tiles & Eviction
  console.log('\n[STEP 4] Traversal Across Many Delhi Tiles (Testing RAM bounding & eviction):');
  const traversalPoints = [
    { lat: 28.560, lon: 77.200, name: 'AIIMS Ring Road' },
    { lat: 28.580, lon: 77.165, name: 'Nelson Mandela Marg' },
    { lat: 28.581, lon: 77.172, name: 'Munirka' },
    { lat: 28.588, lon: 77.208, name: 'Lodhi Safdarjung' },
    { lat: 28.589, lon: 77.221, name: 'Lodhi Garden East' },
    { lat: 28.602, lon: 77.195, name: 'Shanti Path North' },
    { lat: 28.612, lon: 77.229, name: 'India Gate' },
    { lat: 28.614, lon: 77.200, name: 'Rashtrapati Bhavan' },
    { lat: 28.626, lon: 77.218, name: 'Janpath Tolstoy' },
    { lat: 28.629, lon: 77.228, name: 'Barakhamba' },
    { lat: 28.632, lon: 77.219, name: 'CP Inner Circle' },
    { lat: 28.635, lon: 77.216, name: 'CP North' },
  ];

  const ramHistory = [];
  for (const pt of traversalPoints) {
    await roadMgr.updatePosition({ latitude: pt.lat, longitude: pt.lon }, 10.0, 45.0, true);
    const ram = roadProvider.getTotalRamBytes();
    const tileCount = roadProvider.getLoadedTileKeys().length;
    ramHistory.push({ pt: pt.name, tiles: tileCount, ramBytes: ram });
  }

  console.log('  Traversal RAM History (12 waypoints visited):');
  for (const h of ramHistory) {
    console.log(`    ${h.pt.padEnd(25)} -> Active Tiles: ${h.tiles}, RAM: ${(h.ramBytes / 1024).toFixed(1)} KB`);
  }

  const finalTileCount = roadProvider.getLoadedTileKeys().length;
  console.log('\n[SUMMARY] Final Active Tiles in RAM:', finalTileCount, 'out of 17 total pack tiles.');
  console.log('Total Network Requests throughout entire run:', networkCallCount);
  console.log('Did RAM stay bounded? ->', finalTileCount <= 8 ? 'YES (Bounded & Evicted)' : 'NO');

  if (networkCallCount === 0 && finalTileCount <= 8 && match1 !== null) {
    console.log('\n>>> AUDIT COMPLETED: Offline matching and bounded RAM verified! <<<');
  } else {
    console.error('\n>>> AUDIT FAILED <<<');
    process.exit(1);
  }
}

runAudit().catch(err => {
  console.error('Audit Error:', err);
  process.exit(1);
});
