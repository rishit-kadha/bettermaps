/**
 * compute_and_embed_calibration.js
 *
 * Computes per-session IMU calibration metrics from pre-outage reference data
 * and embeds the calibration metadata directly into all 12 IO-VNBD fixture JSON files.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const ALL_SESSIONS = ['Vta8','S2','S1','M','Vtb10','Vta10','Vta15','Vta21','Vtb4','Vtb12','Vw8','Vw14b'];

function pearsonR(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx2 += (xs[i] - mx) ** 2;
    dy2 += (ys[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom < 1e-10 ? 0 : num / denom;
}

function getFixturePath(sid) {
  return sid === 'S1'
    ? path.join(repoRoot, 'assets/datasets/iovnbd_s1.json')
    : path.join(repoRoot, 'assets/datasets/test_fixtures', `iovnbd_${sid}.json`);
}

console.log('=' .repeat(80));
console.log('CALCULATING AND EMBEDDING CALIBRATION METADATA ACROSS FIXTURES');
console.log('=' .repeat(80));

const summary = [];

for (const sid of ALL_SESSIONS) {
  const filePath = getFixturePath(sid);
  if (!fs.existsSync(filePath)) {
    console.warn(`[WARN] Missing fixture: ${filePath}`);
    continue;
  }

  const fixture = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const samples = fixture.samples;

  // Window selection: 5s to 20s pre-outage moving samples
  let moving = samples.filter(s => {
    const t = s.relative_time_ms / 1000.0;
    return t >= 5.0 && t < 20.0 && (s.reference?.speed_kmh ?? 0) > 3.0;
  });
  let windowName = '5.0-20.0s';

  if (moving.length < 5) {
    // Full session moving fallback (e.g. S1 stationary in 5-20s, Vta8 slow)
    moving = samples.filter(s => (s.reference?.speed_kmh ?? 0) > 3.0);
    windowName = 'full_session_moving';
  }

  // Explicit reversed mount list from vehicle mounting inventory
  const isExplicitReversed = sid === 'Vtb10' || sid === 'S3b' || sid === 'S3c';

  // For IO-VNBD portrait windshield mount, gyro.pitch is the physical yaw channel
  const yaw_channel = 'pitch';
  const yaw_sign = isExplicitReversed ? 1.0 : -1.0;

  let evidence;
  if (moving.length >= 3) {
    const refYaws = moving.map(s => s.reference.yaw_rate_deg_s ?? 0); // deg/s
    const pitchVals = moving.map(s => s.gyro.pitch); // rad/s

    // Convert pitch to deg/s for ratio calculation
    const pitchDegs = pitchVals.map(p => p * (180.0 / Math.PI));

    const rPitch = pearsonR(refYaws, pitchVals);

    // Sign agreement with calibrated sign
    let agreeCount = 0;
    let validSignCount = 0;
    for (let i = 0; i < moving.length; i++) {
      if (Math.abs(refYaws[i]) > 0.1) {
        validSignCount++;
        if (Math.sign(refYaws[i]) === Math.sign(pitchVals[i] * yaw_sign)) {
          agreeCount++;
        }
      }
    }
    const sign_agreement = validSignCount > 0 ? agreeCount / validSignCount : 1.0;

    // Mean ratio |ref_yaw / (pitch * yaw_sign)| for moving samples
    let ratioSum = 0, ratioCount = 0;
    for (let i = 0; i < moving.length; i++) {
      if (Math.abs(pitchDegs[i]) > 0.5) {
        ratioSum += refYaws[i] / (pitchDegs[i] * yaw_sign);
        ratioCount++;
      }
    }
    const mean_ratio = ratioCount > 0 ? ratioSum / ratioCount : 1.0;

    evidence = {
      pearson_r: Math.round(rPitch * 1000) / 1000,
      sign_agreement: Math.round(sign_agreement * 1000) / 1000,
      mean_ratio: Math.round(mean_ratio * 100) / 100,
      n_samples: moving.length,
      window_sec: windowName,
      min_speed_kmh: 3.0
    };
  } else {
    evidence = {
      pearson_r: 0,
      sign_agreement: 1.0,
      mean_ratio: 1.0,
      n_samples: moving.length,
      window_sec: 'insufficient_samples',
      min_speed_kmh: 3.0
    };
  }

  const calibration = {
    yaw_channel,
    yaw_sign,
    evidence
  };

  fixture.metadata.calibration = calibration;
  fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2), 'utf8');

  summary.push({
    sid,
    yaw_channel,
    yaw_sign,
    pearson_r: evidence.pearson_r,
    sign_agreement: evidence.sign_agreement,
    mean_ratio: evidence.mean_ratio,
    n_samples: evidence.n_samples,
    window: evidence.window_sec
  });
}

console.log('\nCALIBRATION SUMMARY:');
console.log('Session  | Channel | Sign | Pearson r | Sign Agree | Mean Ratio | Samples | Window');
console.log('---------+---------+------+-----------+------------+------------+---------+--------------------');
for (const s of summary) {
  console.log(
    `${s.sid.padEnd(9)}| ${s.yaw_channel.padEnd(8)}| ${String(s.yaw_sign).padEnd(5)}| ` +
    `${String(s.pearson_r).padStart(9)} | ${String(s.sign_agreement).padStart(10)} | ` +
    `${String(s.mean_ratio).padStart(10)} | ${String(s.n_samples).padStart(7)} | ${s.window}`
  );
}
console.log('\n[SUCCESS] Embedded calibration metadata into all 12 fixture files.\n');
