/**
 * benchmark_clean_ablation.js
 *
 * DEFINITIVE HONEST SIH BENCHMARK — CLEAN ABLATION STUDY
 * ========================================================
 * Configurations:
 *   A = IMU + B3-GRU + ESKF + NHC
 *   B = A + ROAD
 *   C = A + ROUTE (honest 2-point: origin→destination only)
 *   D = A + ROAD + ROUTE
 *
 * Instrumentation per session/config:
 *   - outage distance, endpoint error, SIH drift %, mean/median/P95/max error
 *   - GRU inference count, ESKF propagation count
 *   - GNSS updates before outage, DURING outage (must be 0), after outage
 *   - road match attempts, road corrections applied
 *   - route match attempts, route corrections applied
 *   - road coverage at outage-start coordinates
 *   - temporal alignment verification
 *   - per-session yaw calibration evidence
 *
 * GNSS causality: counts ONLY samples with 20s <= t < 50s
 * Route: 2-point honest route only (no intermediate ref waypoints)
 * yawSign: from fixture metadata.calibration or default -1.0
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const repoRoot = process.cwd();

const { EskfPositioningEngine }       = require(path.join(repoRoot,'dist_test/src/core/positioning/EskfPositioningEngine'));
const { LearnedMotionEstimator }       = require(path.join(repoRoot,'dist_test/src/core/positioning/motionEstimator'));
const { gruOnnxEvaluator }             = require(path.join(repoRoot,'dist_test/src/adapters/ml/GruOnnxEvaluator'));
const { LocalRoadNetworkProvider }     = require(path.join(repoRoot,'dist_test/src/adapters/road/LocalRoadNetworkProvider'));
const { MultiCandidateRoadMatcher }    = require(path.join(repoRoot,'dist_test/src/core/navigation/road/MultiCandidateRoadMatcher'));
const { ProbabilisticRoadConstraint }  = require(path.join(repoRoot,'dist_test/src/core/positioning/constraints/ProbabilisticRoadConstraint'));
const { ProbabilisticRouteConstraint } = require(path.join(repoRoot,'dist_test/src/core/positioning/constraints/ProbabilisticRouteConstraint'));
const { haversineDistance }            = require(path.join(repoRoot,'dist_test/src/core/positioning/coordinates'));
const { buildRouteGeometry }           = require(path.join(repoRoot,'dist_test/src/core/navigation/routeGeometry'));

const coventryRoadData = require(path.join(repoRoot,'assets/datasets/road_network_coventry.json'));
const roadProvider     = new LocalRoadNetworkProvider(coventryRoadData);

const ALL_SESSIONS = ['Vta8','S2','S1','M','Vtb10','Vta10','Vta15','Vta21','Vtb4','Vtb12','Vw8','Vw14b'];
const OUTAGE_START_SEC = 20.0;
const OUTAGE_END_SEC   = 50.0;
const CONFIGS = ['A_IMU_ONLY','B_ROAD','C_ROUTE','D_ROAD_ROUTE'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadFixture(sid) {
  const p = sid === 'S1'
    ? path.join(repoRoot,'assets/datasets/iovnbd_s1.json')
    : path.join(repoRoot,'assets/datasets/test_fixtures',`iovnbd_${sid}.json`);
  if (!fs.existsSync(p)) throw new Error(`Fixture not found: ${p}`);
  return JSON.parse(fs.readFileSync(p,'utf8'));
}

function pearsonR(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a,b)=>a+b,0)/n;
  const my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx2=0, dy2=0;
  for (let i=0;i<n;i++) { num+=(xs[i]-mx)*(ys[i]-my); dx2+=(xs[i]-mx)**2; dy2+=(ys[i]-my)**2; }
  const denom = Math.sqrt(dx2*dy2);
  return denom < 1e-10 ? 0 : num/denom;
}

function computeYawCalibration(fixture) {
  // 1. Try embedded calibration in fixture
  const embedded = fixture.metadata?.calibration;
  if (embedded) {
    return {
      source: 'fixture_metadata',
      yaw_channel: embedded.yaw_channel,
      yaw_sign:    embedded.yaw_sign,
      evidence:    embedded.evidence,
    };
  }

  // 2. Compute from reference data (fallback)
  const samples = fixture.samples;
  const moving = samples.filter(s => {
    const t = s.relative_time_ms / 1000.0;
    return t >= 5.0 && t < OUTAGE_START_SEC && (s.reference?.speed_kmh ?? 0) > 3.0;
  });

  if (moving.length < 5) {
    return { source: 'default', yaw_channel: 'pitch', yaw_sign: -1.0, evidence: null };
  }

  const refYaws  = moving.map(s => s.reference.yaw_rate_deg_s);
  const pitchVals = moving.map(s => s.gyro.pitch);
  const yawVals   = moving.map(s => s.gyro.yaw);
  const rollVals  = moving.map(s => s.gyro.roll);

  const rPitch = pearsonR(refYaws, pitchVals);
  const rYaw   = pearsonR(refYaws, yawVals);
  const rRoll  = pearsonR(refYaws, rollVals);

  // Best channel by |r|
  const best = [[Math.abs(rPitch),'pitch',rPitch],[Math.abs(rYaw),'yaw',rYaw],[Math.abs(rRoll),'roll',rRoll]]
    .sort((a,b)=>b[0]-a[0])[0];
  const bestChannel = best[1];
  const bestR       = best[2];
  const yaw_sign    = bestR < 0 ? -1.0 : 1.0;

  // Sign agreement
  const channelVals = bestChannel==='pitch'?pitchVals:bestChannel==='yaw'?yawVals:rollVals;
  const signAgreement = moving.filter((_,i)=>
    Math.sign(refYaws[i])===Math.sign(channelVals[i]*yaw_sign) && Math.abs(refYaws[i])>0.1
  ).length / moving.filter((_,i)=>Math.abs(refYaws[i])>0.1).length;

  // Mean ratio
  const ratioSamples = moving.filter((_,i)=>Math.abs(channelVals[i])>0.01);
  const meanRatio = ratioSamples.length > 0
    ? ratioSamples.reduce((acc,_,i)=>acc+refYaws[i]/channelVals[i],0)/ratioSamples.length
    : 0;

  return {
    source: 'computed',
    yaw_channel: bestChannel,
    yaw_sign,
    evidence: {
      pearson_r:     Math.round(bestR*1000)/1000,
      sign_agreement:Math.round(signAgreement*1000)/1000,
      mean_ratio:    Math.round(meanRatio*100)/100,
      n_samples:     moving.length,
      window_sec:    `5.0-${OUTAGE_START_SEC}`,
      min_speed_kmh: 3.0,
    }
  };
}

function verifyRoadCoverage(fixture) {
  const samples = fixture.samples;
  let outageStartSample = null;
  for (const s of samples) {
    if (s.relative_time_ms / 1000.0 >= OUTAGE_START_SEC) { outageStartSample = s; break; }
  }
  if (!outageStartSample) return { covered: false, nearbySegments: 0, lat: null, lon: null, reason: 'No sample at outage start' };

  const lat = outageStartSample.reference.latitude;
  const lon = outageStartSample.reference.longitude;
  let segs = 0;
  try {
    const res = roadProvider.findNearbySegments({ latitude: lat, longitude: lon, altitude: 0 }, 200);
    segs = res ? res.length : 0;
  } catch(e) { segs = -1; }

  // Road network bbox
  const allSegs = roadProvider.getAllSegments ? roadProvider.getAllSegments() : [];
  let rnLatMin=Infinity, rnLatMax=-Infinity, rnLonMin=Infinity, rnLonMax=-Infinity;
  if (allSegs.length > 0 && allSegs[0].startNode) {
    for (const seg of allSegs.slice(0,100)) {
      if (seg.startNode) { rnLatMin=Math.min(rnLatMin,seg.startNode.lat); rnLatMax=Math.max(rnLatMax,seg.startNode.lat); rnLonMin=Math.min(rnLonMin,seg.startNode.lon); rnLonMax=Math.max(rnLonMax,seg.startNode.lon); }
    }
  }

  return {
    covered: segs > 0,
    nearbySegments: segs,
    lat: Math.round(lat*10000)/10000,
    lon: Math.round(lon*10000)/10000,
    reason: segs > 0 ? 'OK' : 'No road segments within 200m at outage-start position',
  };
}

function verifyTemporalAlignment(fixture) {
  const s = fixture.samples;
  if (!s || s.length === 0) return { valid: false };
  const firstMs = s[0].relative_time_ms, lastMs = s[s.length-1].relative_time_ms;
  const durSec = (lastMs-firstMs)/1000.0;

  let outageStartIdx=-1, outageEndIdx=-1;
  for (let i=0;i<s.length;i++) {
    const t = s[i].relative_time_ms/1000.0;
    if (outageStartIdx===-1 && t>=OUTAGE_START_SEC) outageStartIdx=i;
    if (outageEndIdx===-1   && t>=OUTAGE_END_SEC)   outageEndIdx=i;
  }

  // IMU timestamp continuity check (first 10 pairs)
  const imuGaps = [];
  for (let i=1;i<Math.min(11,s.length);i++) {
    imuGaps.push(s[i].sensor_timestamp_ms - s[i-1].sensor_timestamp_ms);
  }
  const meanImuGapMs = imuGaps.length > 0 ? imuGaps.reduce((a,b)=>a+b,0)/imuGaps.length : 0;
  const maxImuGapMs  = imuGaps.length > 0 ? Math.max(...imuGaps) : 0;

  // Speed range during outage
  let minSpd=Infinity, maxSpd=-Infinity, outageN=0;
  const end = outageEndIdx===-1 ? s.length : outageEndIdx;
  for (let i=Math.max(0,outageStartIdx);i<end;i++) {
    const v = s[i].reference?.speed_kmh ?? 0;
    if (v<minSpd) minSpd=v; if (v>maxSpd) maxSpd=v; outageN++;
  }

  return {
    valid: outageStartIdx >= 0,
    durationSec: Math.round(durSec*10)/10,
    totalSamples: s.length,
    sampleIntervalMs: Math.round((lastMs-firstMs)/(s.length-1)),
    imuMeanGapMs: Math.round(meanImuGapMs*10)/10,
    imuMaxGapMs: Math.round(maxImuGapMs*10)/10,
    firstRelMs: firstMs,
    lastRelMs: lastMs,
    outageStartIdx,
    outageEndIdx,
    outageSamplesN: outageN,
    minSpeedKmhDuringOutage: outageN>0 ? Math.round(minSpd*10)/10 : null,
    maxSpeedKmhDuringOutage: outageN>0 ? Math.round(maxSpd*10)/10 : null,
    isStationaryDuringOutage: maxSpd < 2.0,
    // Verify outage aligns with reference timestamps
    outageStartRelSec: outageStartIdx>=0 ? Math.round(s[outageStartIdx].relative_time_ms/100)/10 : null,
    outageEndRelSec:   outageEndIdx>=0 ? Math.round(s[outageEndIdx].relative_time_ms/100)/10 : null,
  };
}

function buildHonestRoute(fixture) {
  // HONEST: origin = first sample reference, destination = last sample reference
  // EXACTLY 2 points. No intermediate future trajectory waypoints.
  const samples = fixture.samples;
  const first = samples[0];
  const last  = samples[samples.length-1];
  if (!first?.reference || !last?.reference) return null;

  const routePoints = [
    { latitude: first.reference.latitude, longitude: first.reference.longitude },
    { latitude: last.reference.latitude,  longitude: last.reference.longitude  },
  ];
  const geometry = buildRouteGeometry(routePoints);
  return {
    id: `honest_route_${fixture.metadata?.session_id ?? 'test'}`,
    name: 'Honest 2-point route: origin → final destination only',
    polylinePoints: routePoints,
    totalDistanceMeters: geometry.totalLengthMeters,
    estimatedDurationSeconds: Math.round(geometry.totalLengthMeters / 10),
    sourceProvider: 'SIH_Benchmark_Honest',
    creationTimestampMs: Date.now(),
  };
}

function runConfig(sid, fixture, config, calibration) {
  const useRoad  = config === 'B_ROAD'      || config === 'D_ROAD_ROUTE';
  const useRoute = config === 'C_ROUTE'     || config === 'D_ROAD_ROUTE';

  const yawSign    = calibration.yaw_sign ?? -1.0;
  const yawChannel = calibration.yaw_channel ?? 'pitch';

  // GRU inference counter (wraps the custom evaluator)
  let gruInferenceCount = 0;
  gruOnnxEvaluator.reset();
  const motionEst = new LearnedMotionEstimator('gru', {
    yawChannel,
    yawSign,
    customEvaluator: (inputTensor) => {
      gruInferenceCount++;
      if (inputTensor.length > 0) gruOnnxEvaluator.pushSample(inputTensor[0]);
      return gruOnnxEvaluator.evaluateSync();
    },
  });

  let roadConstraint  = null;
  let routeConstraint = null;

  if (useRoad) {
    const matcher = new MultiCandidateRoadMatcher(roadProvider);
    roadConstraint = new ProbabilisticRoadConstraint(matcher);
    roadConstraint.setEnabled(true);
  }

  if (useRoute) {
    const route = buildHonestRoute(fixture);
    if (route) {
      routeConstraint = new ProbabilisticRouteConstraint();
      routeConstraint.setEnabled(true);
      routeConstraint.setRoute(route);
    }
  }

  const engine = new EskfPositioningEngine({
    motionEstimator: motionEst,
    roadConstraint,
    routeConstraint,
  });

  const samples = fixture.samples;
  const first   = samples[0];

  // Prime with first GNSS fix
  engine.processGnss({
    latitude: first.reference.latitude, longitude: first.reference.longitude,
    altitude: first.phone_gps?.altitude ?? 0,
    speed:    (first.reference.speed_kmh ?? 0) / 3.6,
    heading:  first.reference.heading_deg ?? 0,
    accuracy: 3.0, timestamp: first.sensor_timestamp_ms ?? Date.now(),
    providerType: 'gnss', isDeadReckoning: false,
  });

  // Instrumentation counters
  let gnssBeforeOutage = 1; // includes prime
  let gnssDuringOutage = 0; // MUST be 0
  let gnssAfterOutage  = 0;
  let eskfPropagations = 0;
  let roadAttemptsDuringOutage  = 0;
  let routeAttemptsDuringOutage = 0;

  let inOutage = false;
  let outageDist = 0.0, lastRefLat = 0, lastRefLon = 0, hasLast = false;
  const errs = []; let endErr = 0.0;

  let gnssAtOutageStart = 0, gnssAtOutageEnd = 0;
  let roadAtOutageStart = 0, roadAtOutageEnd = 0;
  let routeAtOutageStart = 0, routeAtOutageEnd = 0;

  for (let i = 0; i < samples.length; i++) {
    const s   = samples[i];
    const relSec = s.relative_time_ms / 1000.0;
    const isOutage  = relSec >= OUTAGE_START_SEC && relSec < OUTAGE_END_SEC;
    const preOutage = relSec < OUTAGE_START_SEC;
    const postOutage= relSec >= OUTAGE_END_SEC;

    if (isOutage && !inOutage) {
      inOutage = true;
      engine.onGnssBlocked();
      gnssAtOutageStart = engine.getGnssDeliveredCount();
      roadAtOutageStart = engine.getRoadUpdateCount();
      routeAtOutageStart = engine.getRouteUpdateCount();
      hasLast = false;
    } else if (!isOutage && inOutage) {
      inOutage = false;
      gnssAtOutageEnd = engine.getGnssDeliveredCount();
      roadAtOutageEnd = engine.getRoadUpdateCount();
      routeAtOutageEnd = engine.getRouteUpdateCount();
    }

    const imu = {
      timestamp: s.sensor_timestamp_ms,
      accel: { x: s.accel.x, y: s.accel.y, z: s.accel.z },
      gyro:  { x: s.gyro.roll, y: s.gyro.pitch, z: s.gyro.yaw },
      magnetometer: { x: s.mag.x, y: s.mag.y, z: s.mag.z },
    };

    if (!isOutage) {
      // i === 0 is already processed (prime), skip to avoid double-count
      if (i > 0) {
        engine.processGnss({
          latitude: s.reference.latitude, longitude: s.reference.longitude,
          altitude: s.phone_gps?.altitude ?? 0,
          speed:    (s.reference.speed_kmh ?? 0) / 3.6,
          heading:  s.reference.heading_deg ?? 0,
          accuracy: 3.0, timestamp: s.sensor_timestamp_ms ?? Date.now(),
          providerType: 'gnss', isDeadReckoning: false,
        });
        if (preOutage)  gnssBeforeOutage++;
        if (postOutage) gnssAfterOutage++;
      }
    } else {
      // During outage: verify we are NOT calling processGnss
      // (we never call it here — but count would confirm)
      gnssDuringOutage += 0; // explicit: nothing added here
    }

    eskfPropagations++;
    const est = engine.processImu(imu);

    // Track outage-window constraint attempts
    if (isOutage) {
      if (useRoad)  roadAttemptsDuringOutage++;
      if (useRoute) routeAttemptsDuringOutage++;
    }

    // Accumulate outage error
    if (isOutage && est && s.reference) {
      if (hasLast) outageDist += haversineDistance(lastRefLat, lastRefLon, s.reference.latitude, s.reference.longitude);
      lastRefLat = s.reference.latitude;
      lastRefLon = s.reference.longitude;
      hasLast    = true;
      const e    = haversineDistance(s.reference.latitude, s.reference.longitude, est.latitude, est.longitude);
      errs.push(e);
      endErr = e;
    }
  }

  // Verify GNSS causality: gnssDuringOutage is computed from the counter above = 0 always
  // Cross-check with engine counter: gnssDeliveredCount should not grow during outage
  // We verify this separately by checking the engine delivered count difference

  const sorted  = [...errs].sort((a,b) => a-b);
  const mean     = errs.length > 0 ? errs.reduce((a,b)=>a+b,0)/errs.length : 0;
  const median   = sorted.length > 0 ? sorted[Math.floor(sorted.length*0.5)] : 0;
  const p95      = sorted.length > 0 ? sorted[Math.floor(sorted.length*0.95)] : 0;
  const max      = errs.length > 0 ? Math.max(...errs) : 0;
  const sihDrift = outageDist >= 5.0 ? (endErr / outageDist) * 100.0 : null;

  const roadAppliedDuringOutage  = (inOutage ? engine.getRoadUpdateCount() : roadAtOutageEnd) - roadAtOutageStart;
  const routeAppliedDuringOutage = (inOutage ? engine.getRouteUpdateCount() : routeAtOutageEnd) - routeAtOutageStart;
  const gnssDeliveredDuringOutage = (inOutage ? engine.getGnssDeliveredCount() : gnssAtOutageEnd) - gnssAtOutageStart;
  const gnssRecoveryUpdates = engine.getGnssDeliveredCount() - (inOutage ? engine.getGnssDeliveredCount() : gnssAtOutageEnd);

  return {
    config,
    useRoad, useRoute,
    // Core SIH metrics
    outageDistM:        Math.round(outageDist*100)/100,
    endpointErrorM:     Math.round(endErr*100)/100,
    sihDriftPct:        sihDrift !== null ? Math.round(sihDrift*100)/100 : null,
    passesSih:          sihDrift !== null ? sihDrift < 10.0 : false,
    meanErrorM:         Math.round(mean*100)/100,
    medianErrorM:       Math.round(median*100)/100,
    p95ErrorM:          Math.round(p95*100)/100,
    maxErrorM:          Math.round(max*100)/100,
    // Instrumentation
    gruInferenceCount,
    eskfPropagations,
    gnssBeforeOutage,
    gnssDuringOutage:   gnssDeliveredDuringOutage, // Measured strictly during 20s <= t < 50s
    gnssRecoveryUpdates,
    gnssAfterOutage,
    roadAttemptsDuringOutage,
    roadCorrectionsApplied:  roadAppliedDuringOutage,
    routeAttemptsDuringOutage,
    routeCorrectionsApplied: routeAppliedDuringOutage,
    outageSamplesN:     errs.length,
    // Route honesty verification
    routeWaypointCount: useRoute ? 2 : 0,
  };
}

async function main() {
  const onnxPath = path.resolve(repoRoot,'assets/models/B3_GRU.onnx');
  console.log('[BENCHMARK] Initializing ONNX runtime...');
  await gruOnnxEvaluator.initialize(onnxPath);
  console.log('[BENCHMARK] Starting definitive honest ablation benchmark...\n');

  const report = {
    generatedAt: new Date().toISOString(),
    outageWindow: `${OUTAGE_START_SEC}-${OUTAGE_END_SEC}s`,
    configs: CONFIGS,
    sessions: [],
  };

  // Per-session results
  for (const sid of ALL_SESSIONS) {
    console.log('\n' + '='.repeat(74));
    console.log(`SESSION: ${sid}`);
    console.log('='.repeat(74));

    const fixture = loadFixture(sid);

    // Calibration
    const calibration = computeYawCalibration(fixture);
    console.log(`  Calibration: channel=${calibration.yaw_channel} sign=${calibration.yaw_sign} pearsonR=${calibration.evidence?.pearson_r ?? 'N/A'} signAgree=${calibration.evidence?.sign_agreement ?? 'N/A'} n=${calibration.evidence?.n_samples ?? 'N/A'} source=${calibration.source}`);

    // Temporal alignment
    const temporal = verifyTemporalAlignment(fixture);
    console.log(`  Temporal: ${temporal.durationSec}s total, ${temporal.outageSamplesN} outage samples, ${temporal.sampleIntervalMs}ms interval, spd=${temporal.minSpeedKmhDuringOutage}-${temporal.maxSpeedKmhDuringOutage}km/h, stationary=${temporal.isStationaryDuringOutage}`);
    console.log(`  Temporal outage: relSec ${temporal.outageStartRelSec}s → ${temporal.outageEndRelSec}s`);

    // Road coverage
    const roadCov = verifyRoadCoverage(fixture);
    console.log(`  Road coverage: ${roadCov.covered ? 'OK' : 'MISSING'} | ${roadCov.nearbySegments} segs within 200m at lat=${roadCov.lat} lon=${roadCov.lon}`);

    // Run 4 configs
    const configResults = {};
    for (const cfg of CONFIGS) {
      process.stdout.write(`  ${cfg.padEnd(14)}: `);
      try {
        const r = runConfig(sid, fixture, cfg, calibration);
        configResults[cfg] = r;

        // Verify GNSS causality
        if (r.gnssDuringOutage !== 0) {
          console.log(`GNSS CAUSALITY VIOLATION: ${r.gnssDuringOutage} updates during outage!`);
        } else {
          const driftStr = r.sihDriftPct !== null ? `${r.sihDriftPct}%` : 'N/A(dist<5m)';
          const passStr  = r.sihDriftPct !== null ? (r.passesSih ? 'PASS✓' : 'FAIL✗') : 'N/A';
          console.log(`endpoint=${r.endpointErrorM}m dist=${r.outageDistM}m drift=${driftStr} ${passStr} | gru=${r.gruInferenceCount} eskf=${r.eskfPropagations} gnssB/D/A=${r.gnssBeforeOutage}/${r.gnssDuringOutage}/${r.gnssAfterOutage} road=${r.roadCorrectionsApplied}/${r.roadAttemptsDuringOutage} route=${r.routeCorrectionsApplied}/${r.routeAttemptsDuringOutage}`);
        }
      } catch(e) {
        configResults[cfg] = { error: e.message };
        console.log(`ERROR: ${e.message}`);
      }
    }

    report.sessions.push({
      sessionId: sid,
      calibration,
      temporal,
      roadCoverage: roadCov,
      configs: configResults,
    });
  }

  // ─── Summary Tables ──────────────────────────────────────────────────────────
  console.log('\n\n' + '='.repeat(74));
  console.log('CORRECTNESS FINDINGS');
  console.log('='.repeat(74));
  console.log('\nGNSS CAUSALITY (gnssDuringOutage must be 0 for all):');
  let allClean = true;
  for (const sess of report.sessions) {
    for (const cfg of CONFIGS) {
      const r = sess.configs[cfg];
      if (r && !r.error && r.gnssDuringOutage !== 0) {
        console.log(`  VIOLATION: ${sess.sessionId} ${cfg}: ${r.gnssDuringOutage} GNSS updates during outage`);
        allClean = false;
      }
    }
  }
  if (allClean) console.log('  ✓ All sessions: 0 GNSS updates delivered during outage window');

  console.log('\nROAD COVERAGE:');
  for (const sess of report.sessions) {
    const r = sess.roadCoverage;
    console.log(`  ${sess.sessionId.padEnd(8)}: ${r.covered ? '✓ OK  ' : '✗ NONE'} ${String(r.nearbySegments).padStart(4)} segs | lat=${r.lat} lon=${r.lon}`);
  }

  console.log('\nYAW CALIBRATION:');
  console.log('  Session  | ch    | sign | pearsonR | signAgree | n    | source');
  console.log('  ---------+-------+------+----------+-----------+------+--------');
  for (const sess of report.sessions) {
    const c = sess.calibration;
    const ev = c.evidence;
    console.log(`  ${sess.sessionId.padEnd(9)}| ${(c.yaw_channel??'').padEnd(6)}| ${String(c.yaw_sign).padEnd(5)}| ${ev ? String(ev.pearson_r).padStart(8) : '     N/A'}| ${ev ? String(ev.sign_agreement).padStart(9) : '      N/A'} | ${ev ? String(ev.n_samples).padStart(4) : ' N/A'} | ${c.source}`);
  }

  console.log('\n\n' + '='.repeat(74));
  console.log('HONEST ABLATION RESULTS — SIH DRIFT % (endpoint / outage_dist × 100)');
  console.log('='.repeat(74));
  const fmt = (sess, cfg) => {
    const r = sess.configs[cfg];
    if (!r || r.error) return '   ERR   ';
    if (r.sihDriftPct === null) return '   N/A   ';
    return (r.sihDriftPct + '%').padStart(7) + (r.passesSih ? '✓' : '✗');
  };
  console.log('Session  | A_IMU_ONLY     | B_ROAD         | C_ROUTE        | D_ROAD_ROUTE');
  console.log('---------+----------------+----------------+----------------+----------------');
  for (const sess of report.sessions) {
    console.log(`${sess.sessionId.padEnd(9)}| ${fmt(sess,'A_IMU_ONLY').padEnd(15)}| ${fmt(sess,'B_ROAD').padEnd(15)}| ${fmt(sess,'C_ROUTE').padEnd(15)}| ${fmt(sess,'D_ROAD_ROUTE')}`);
  }

  console.log('\nDETAILED STATS (Config A — baseline):');
  console.log('Session  | Endpt(m) | OuDist(m) | Mean(m) | Med(m) | P95(m) | Max(m)');
  console.log('---------+----------+-----------+---------+--------+--------+--------');
  for (const sess of report.sessions) {
    const r = sess.configs['A_IMU_ONLY'];
    if (!r || r.error) { console.log(`${sess.sessionId.padEnd(9)}| ERROR`); continue; }
    console.log(`${sess.sessionId.padEnd(9)}| ${String(r.endpointErrorM).padStart(8)} | ${String(r.outageDistM).padStart(9)} | ${String(r.meanErrorM).padStart(7)} | ${String(r.medianErrorM).padStart(6)} | ${String(r.p95ErrorM).padStart(6)} | ${r.maxErrorM}`);
  }

  console.log('\nINSTRUMENTATION (Config A — GRU/ESKF counts):');
  console.log('Session  | GRU inf | ESKF prop | gnssBefore | gnssAfter | roadAttempt | routeAttempt');
  console.log('---------+---------+-----------+------------+-----------+-------------+-------------');
  for (const sess of report.sessions) {
    const r = sess.configs['A_IMU_ONLY'];
    if (!r || r.error) { console.log(`${sess.sessionId.padEnd(9)}| ERROR`); continue; }
    console.log(`${sess.sessionId.padEnd(9)}| ${String(r.gruInferenceCount).padStart(7)} | ${String(r.eskfPropagations).padStart(9)} | ${String(r.gnssBeforeOutage).padStart(10)} | ${String(r.gnssAfterOutage).padStart(9)} | ${String(r.roadAttemptsDuringOutage).padStart(11)} | ${r.routeAttemptsDuringOutage}`);
  }

  console.log('\nROAD EFFECTIVENESS (Config B):');
  console.log('Session  | Attempts | Applied | Rate  | EndpointError | SIH Drift');
  console.log('---------+----------+---------+-------+---------------+----------');
  for (const sess of report.sessions) {
    const r = sess.configs['B_ROAD'];
    if (!r || r.error) { console.log(`${sess.sessionId.padEnd(9)}| ERROR`); continue; }
    const rate = r.roadAttemptsDuringOutage > 0 ? Math.round(r.roadCorrectionsApplied/r.roadAttemptsDuringOutage*1000)/10 : 0;
    const drift = r.sihDriftPct !== null ? r.sihDriftPct + '%' : 'N/A';
    console.log(`${sess.sessionId.padEnd(9)}| ${String(r.roadAttemptsDuringOutage).padStart(8)} | ${String(r.roadCorrectionsApplied).padStart(7)} | ${String(rate+'%').padStart(5)} | ${String(r.endpointErrorM+'m').padStart(13)} | ${drift}`);
  }

  console.log('\nROUTE EFFECTIVENESS (Config C — HONEST 2-point):');
  console.log('Session  | Attempts | Applied | Rate  | EndpointError | SIH Drift');
  console.log('---------+----------+---------+-------+---------------+----------');
  for (const sess of report.sessions) {
    const r = sess.configs['C_ROUTE'];
    if (!r || r.error) { console.log(`${sess.sessionId.padEnd(9)}| ERROR`); continue; }
    const rate = r.routeAttemptsDuringOutage > 0 ? Math.round(r.routeCorrectionsApplied/r.routeAttemptsDuringOutage*1000)/10 : 0;
    const drift = r.sihDriftPct !== null ? r.sihDriftPct + '%' : 'N/A';
    console.log(`${sess.sessionId.padEnd(9)}| ${String(r.routeAttemptsDuringOutage).padStart(8)} | ${String(r.routeCorrectionsApplied).padStart(7)} | ${String(rate+'%').padStart(5)} | ${String(r.endpointErrorM+'m').padStart(13)} | ${drift}`);
  }

  console.log('\n\n' + '='.repeat(74));
  console.log('REMAINING ERROR SOURCES ANALYSIS');
  console.log('='.repeat(74));
  // Compare A vs D for each session to see combined effect
  for (const sess of report.sessions) {
    const A = sess.configs['A_IMU_ONLY'];
    const D = sess.configs['D_ROAD_ROUTE'];
    if (!A || A.error || !D || D.error) continue;
    if (A.sihDriftPct === null || D.sihDriftPct === null) continue;
    const delta = Math.round((A.sihDriftPct - D.sihDriftPct)*10)/10;
    const spd = sess.temporal.maxSpeedKmhDuringOutage;
    console.log(`  ${sess.sessionId.padEnd(8)}: A=${A.sihDriftPct}% D=${D.sihDriftPct}% Δ=${delta>=0?'+':' '}${delta}pp | maxSpd=${spd}km/h | road=${D.roadCorrectionsApplied} route=${D.routeCorrectionsApplied}`);
  }

  console.log('\nSIH PASS/FAIL SUMMARY:');
  let passCount = 0, totalMoving = 0;
  for (const sess of report.sessions) {
    const A = sess.configs['A_IMU_ONLY'];
    if (!A || A.error || A.sihDriftPct === null) continue;
    totalMoving++;
    const passA = A.sihDriftPct < 10.0;
    if (passA) passCount++;
    console.log(`  ${sess.sessionId.padEnd(8)}: Config-A ${A.sihDriftPct}% → ${passA ? 'PASS <10%' : 'FAIL'} | Config-D ${sess.configs['D_ROAD_ROUTE']?.sihDriftPct ?? 'N/A'}% → ${sess.configs['D_ROAD_ROUTE']?.passesSih ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\n  ${passCount}/${totalMoving} moving sessions pass <10% SIH with Config A`);
  console.log('  NOTE: System is NOT SIH-compliant as currently configured.');

  // Save JSON report
  const outDir = path.join(repoRoot,'artifacts/device_evaluation');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir,{recursive:true});
  const rp = path.join(outDir,'benchmark_clean_ablation_report.json');
  fs.writeFileSync(rp, JSON.stringify(report,null,2),'utf8');
  console.log(`\n[BENCHMARK] Full report saved: ${rp}`);
}

main().catch(e => { console.error('[BENCHMARK] Fatal:',e); process.exit(1); });
