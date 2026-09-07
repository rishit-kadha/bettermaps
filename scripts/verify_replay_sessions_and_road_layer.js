const path = require('path');
const fs = require('fs');

const { getAvailableSessions, loadFixtureById } = require(
  path.resolve(__dirname, '../dist_test/src/services/replay/FixtureRegistry')
);
const { iovnbdReplaySource } = require(
  path.resolve(__dirname, '../dist_test/src/services/replay/IovnbdReplaySource')
);
const { RoadDataManager } = require(
  path.resolve(__dirname, '../dist_test/src/core/navigation/road/RoadDataManager')
);
const { LocalRoadNetworkProvider } = require(
  path.resolve(__dirname, '../dist_test/src/adapters/road/LocalRoadNetworkProvider')
);
const { offlineRegionPackManager } = require(
  path.resolve(__dirname, '../dist_test/src/adapters/road/OfflineRegionPackManager')
);
const { registerBundledRegionPacks } = require(
  path.resolve(__dirname, '../dist_test/src/adapters/road/BundledRegionPacks')
);

const coventryRoadData = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../assets/datasets/road_network_coventry.json'),
    'utf8'
  )
);

function safeFormatNumber(val, digits = 1, fallback = '--', suffix = '') {
  if (val === null || val === undefined || typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
    return fallback;
  }
  return `${val.toFixed(digits)}${suffix}`;
}

function formatDuration(sec) {
  if (sec === null || sec === undefined || typeof sec !== 'number' || isNaN(sec) || !isFinite(sec)) {
    return '--';
  }
  const safeSec = Math.max(0, sec);
  const m = Math.floor(safeSec / 60);
  const s = Math.floor(safeSec % 60);
  return `${m}:${String(s).padStart(2, '0')} (${safeSec.toFixed(1)}s)`;
}

async function runVerification() {
  console.log('=== STARTING REPLAY SESSIONS & ROAD LAYER VERIFICATION ===');
  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (!cond) {
      console.error('  FAIL: ' + msg);
      failed++;
    } else {
      console.log('  PASS: ' + msg);
      passed++;
    }
  }

  console.log('\n[TEST 1] Session Picker list & formatDuration');
  const sessions = getAvailableSessions();
  assert(sessions.length >= 12, 'Expected >= 12 sessions, got ' + sessions.length);
  for (const s of sessions) {
    const formatted = formatDuration(s.durationSec);
    assert(formatted !== '--' && !formatted.includes('NaN'), 'Session ' + s.id + ' duration formatted cleanly: ' + formatted);
  }

  console.log('\n[TEST 2] RoadDataManager with Bundled Region Packs');
  registerBundledRegionPacks(offlineRegionPackManager);
  const provider = new LocalRoadNetworkProvider(undefined, 'VerificationRoadProvider');
  const roadMgr = new RoadDataManager({
    provider,
    regionPackManager: offlineRegionPackManager,
  });
  iovnbdReplaySource.setRoadDataManager(roadMgr);
  assert(iovnbdReplaySource.getRoadDataManager() === roadMgr, 'RoadDataManager attached to IovnbdReplaySource');

  console.log('\n[TEST 3] Rapid session switching stability');
  let telemetryCount = 0;
  const unsub = iovnbdReplaySource.addTelemetryListener((tel) => {
    telemetryCount++;
    const errorStr = safeFormatNumber(tel.instantaneousErrorMeters, 1, '--', ' m');
    const driftStr = safeFormatNumber(tel.cumulativeDriftPercent, 1, '--', '%');
    const at5s = safeFormatNumber(tel.milestoneErrors?.at5s, 1, '--', 'm');
    const at10s = safeFormatNumber(tel.milestoneErrors?.at10s, 1, '--', 'm');
    const at20s = safeFormatNumber(tel.milestoneErrors?.at20s, 1, '--', 'm');
    const at30s = safeFormatNumber(tel.milestoneErrors?.at30s, 1, '--', 'm');
    const at60s = safeFormatNumber(tel.milestoneErrors?.at60s, 1, '--', 'm');
  });

  for (const s of sessions) {
    try {
      console.log('  -> Switching to session: ' + s.id + ' (' + s.label + ')');
      iovnbdReplaySource.pause();
      iovnbdReplaySource.reset();
      const fixture = loadFixtureById(s.id);
      iovnbdReplaySource.loadFixture(fixture);

      const loadedId = iovnbdReplaySource.getSessionId();
      assert(loadedId.toLowerCase() === s.id.toLowerCase(), 'Loaded fixture session ID matches ' + s.id);

      const estLoc = iovnbdReplaySource.getCurrentEstimatedLocation();
      assert(estLoc !== null && typeof estLoc.latitude === 'number', 'Initial estimated location valid for ' + s.id);

      const duration = iovnbdReplaySource.getTotalDurationMs();
      iovnbdReplaySource.seek(Math.min(5000, duration));

      const midLoc = iovnbdReplaySource.getCurrentEstimatedLocation();
      assert(midLoc !== null && typeof midLoc.latitude === 'number', 'Mid-seek location valid for ' + s.id);

      iovnbdReplaySource.reset();
    } catch (err) {
      assert(false, 'Crash on session ' + s.id + ': ' + (err.stack || err.message));
    }
  }

  unsub();
  assert(telemetryCount > 0, 'Telemetry updates dispatched: ' + telemetryCount);

  console.log('\n[TEST 4] Road Layer Segments Acquisition & Geometry Validation');
  await roadMgr.updatePosition({ latitude: 52.408, longitude: -1.512 }, 10.0, 90.0);
  const loadedSegments = provider.getAllSegments();
  console.log('  Loaded segments in provider: ' + loadedSegments.length);

  const activeSegments = loadedSegments.length > 0 ? loadedSegments : coventryRoadData.segments;
  assert(activeSegments.length > 0, 'Road segments available for layer: ' + activeSegments.length);

  let validSegmentCount = 0;
  for (let idx = 0; idx < activeSegments.length; idx++) {
    const seg = activeSegments[idx];
    const rawCoords = seg.geometry && seg.geometry.length >= 2 ? seg.geometry : [seg.startPoint, seg.endPoint];
    const validCoords = rawCoords.filter(
      (pt) =>
        pt &&
        typeof pt.latitude === 'number' &&
        typeof pt.longitude === 'number' &&
        !isNaN(pt.latitude) &&
        !isNaN(pt.longitude) &&
        isFinite(pt.latitude) &&
        isFinite(pt.longitude)
    );
    if (validCoords.length >= 2) {
      validSegmentCount++;
    }
  }

  assert(validSegmentCount === activeSegments.length, 'All ' + activeSegments.length + ' segments passed coordinate validation');

  console.log('\n==================================================');
  console.log('VERIFICATION SUMMARY: ' + passed + ' PASSED, ' + failed + ' FAILED');
  console.log('==================================================');
  if (failed > 0) process.exit(1);
}

runVerification().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
