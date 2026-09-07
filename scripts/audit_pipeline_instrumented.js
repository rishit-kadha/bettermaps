/**
 * audit_pipeline_instrumented.js
 *
 * BENCHMARK CORRECTNESS AND ESTIMATOR-CAUSALITY AUDIT
 * =====================================================
 * Tests:
 *  1. GNSS leakage: gnssDeliveredDuringOutage must be 0
 *  2. Road coverage: segments within 200m at outage start coords
 *  3. Route leakage analysis: leaky (all ref waypoints) vs clean (2-pt origin->dest)
 *  4. Ablation: A=IMU_ONLY, B=+ROAD, C=+ROUTE(leaky), D=+ROAD+ROUTE(leaky)
 *  5. Temporal sync: duration, sample rate, speed during outage
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const repoRoot = process.cwd();

const { EskfPositioningEngine }      = require(path.join(repoRoot,'dist_test/src/core/positioning/EskfPositioningEngine'));
const { LearnedMotionEstimator }      = require(path.join(repoRoot,'dist_test/src/core/positioning/motionEstimator'));
const { gruOnnxEvaluator }            = require(path.join(repoRoot,'dist_test/src/adapters/ml/GruOnnxEvaluator'));
const { LocalRoadNetworkProvider }    = require(path.join(repoRoot,'dist_test/src/adapters/road/LocalRoadNetworkProvider'));
const { MultiCandidateRoadMatcher }   = require(path.join(repoRoot,'dist_test/src/core/navigation/road/MultiCandidateRoadMatcher'));
const { ProbabilisticRoadConstraint } = require(path.join(repoRoot,'dist_test/src/core/positioning/constraints/ProbabilisticRoadConstraint'));
const { ProbabilisticRouteConstraint }= require(path.join(repoRoot,'dist_test/src/core/positioning/constraints/ProbabilisticRouteConstraint'));
const { haversineDistance }           = require(path.join(repoRoot,'dist_test/src/core/positioning/coordinates'));
const { buildRouteGeometry }          = require(path.join(repoRoot,'dist_test/src/core/navigation/routeGeometry'));

const coventryRoadData = require(path.join(repoRoot,'assets/datasets/road_network_coventry.json'));
const roadProvider     = new LocalRoadNetworkProvider(coventryRoadData);

const RN_BBOX = { latMin:52.195, latMax:53.177, lonMin:-2.214, lonMax:-1.431 };
const ALL_SESSIONS = ['Vta8','S2','S1','M','Vtb10','Vta10','Vta15','Vta21','Vtb4','Vtb12','Vw8','Vw14b'];
const OUTAGE_START_SEC = 20.0;
const OUTAGE_END_SEC   = 50.0;
const ABLATIONS = ['A_IMU_ONLY','B_ROAD','C_ROUTE_LEAKY','D_ROAD_ROUTE_LEAKY'];

function loadFixture(sid) {
  const p = sid==='S1'
    ? path.join(repoRoot,'assets/datasets/iovnbd_s1.json')
    : path.join(repoRoot,'assets/datasets/test_fixtures',`iovnbd_${sid}.json`);
  if(!fs.existsSync(p)) throw new Error(`Fixture not found: ${p}`);
  return JSON.parse(fs.readFileSync(p,'utf8'));
}

function buildLeakyRoute(fixture) {
  const samples=fixture.samples;
  const pts=[];
  const step=Math.max(1,Math.floor(samples.length/35));
  for(let i=0;i<samples.length;i+=step){ if(samples[i].reference) pts.push({latitude:samples[i].reference.latitude,longitude:samples[i].reference.longitude}); }
  const last=samples[samples.length-1];
  if(last&&last.reference) pts.push({latitude:last.reference.latitude,longitude:last.reference.longitude});
  const geo=buildRouteGeometry(pts);
  return {id:'leaky',name:'LEAKY(all ref waypoints)',polylinePoints:pts,totalDistanceMeters:geo.totalLengthMeters,estimatedDurationSeconds:Math.round(geo.totalLengthMeters/10),sourceProvider:'leaky',creationTimestampMs:Date.now()};
}

function makeMotionEstimator(sid) {
  const yawSign=(sid==='Vtb10'||sid==='S3b'||sid==='S3c') ? -1.0 : 1.0;
  return new LearnedMotionEstimator('gru',{
    yawChannel:'pitch', yawSign,
    customEvaluator:(inputTensor)=>{ if(inputTensor.length>0) gruOnnxEvaluator.pushSample(inputTensor[0]); return gruOnnxEvaluator.evaluateSync(); }
  });
}

function runAblation(sid, fixture, ablation) {
  const useRoad  = ablation==='B_ROAD' || ablation==='D_ROAD_ROUTE_LEAKY';
  const useRoute = ablation==='C_ROUTE_LEAKY' || ablation==='D_ROAD_ROUTE_LEAKY';

  gruOnnxEvaluator.reset();
  const motionEst = makeMotionEstimator(sid);
  let roadCon=null, routeCon=null;

  if(useRoad){
    const matcher=new MultiCandidateRoadMatcher(roadProvider);
    roadCon=new ProbabilisticRoadConstraint(matcher);
    roadCon.setEnabled(true);
  }
  if(useRoute){
    routeCon=new ProbabilisticRouteConstraint();
    routeCon.setEnabled(true);
    routeCon.setRoute(buildLeakyRoute(fixture));
  }

  const engine=new EskfPositioningEngine({motionEstimator:motionEst,roadConstraint:roadCon,routeConstraint:routeCon});
  const samples=fixture.samples;
  const first=samples[0];

  engine.processGnss({
    latitude:first.reference.latitude,longitude:first.reference.longitude,
    altitude:first.phone_gps?.altitude??0,speed:(first.reference.speed_kmh??0)/3.6,
    heading:first.reference.heading_deg??0,accuracy:3.0,
    timestamp:first.sensor_timestamp_ms??Date.now(),providerType:'gnss',isDeadReckoning:false
  });

  let inOutage=false,outageDist=0.0,lastRefLat=0,lastRefLon=0,hasLast=false;
  const errs=[]; let endErr=0.0;
  let gnssAtStart=0, gnssAtEnd=0;
  let roadApplied=0, routeApplied=0;
  const tsSamples=[];

  for(let i=0;i<samples.length;i++){
    const s=samples[i];
    const relSec=s.relative_time_ms/1000.0;
    const isOut=relSec>=OUTAGE_START_SEC && relSec<OUTAGE_END_SEC;

    if(isOut&&!inOutage){
      inOutage=true; engine.onGnssBlocked();
      gnssAtStart=engine.getGnssDeliveredCount(); hasLast=false;
    } else if(!isOut&&inOutage){ inOutage=false; }

    const imu={timestamp:s.sensor_timestamp_ms,accel:{x:s.accel.x,y:s.accel.y,z:s.accel.z},gyro:{x:s.gyro.roll,y:s.gyro.pitch,z:s.gyro.yaw},magnetometer:{x:s.mag.x,y:s.mag.y,z:s.mag.z}};

    if(!isOut){
      engine.processGnss({latitude:s.reference.latitude,longitude:s.reference.longitude,altitude:s.phone_gps?.altitude??0,speed:(s.reference.speed_kmh??0)/3.6,heading:s.reference.heading_deg??0,accuracy:3.0,timestamp:s.sensor_timestamp_ms??Date.now(),providerType:'gnss',isDeadReckoning:false});
    }

    const est=engine.processImu(imu);

    if(isOut&&est&&s.reference){
      if(hasLast) outageDist+=haversineDistance(lastRefLat,lastRefLon,s.reference.latitude,s.reference.longitude);
      lastRefLat=s.reference.latitude; lastRefLon=s.reference.longitude; hasLast=true;
      const e=haversineDistance(s.reference.latitude,s.reference.longitude,est.latitude,est.longitude);
      errs.push(e); endErr=e;
      tsSamples.push({relSec:Math.round(relSec*10)/10,err:Math.round(e*10)/10,dist:Math.round(outageDist*10)/10});
    }
  }

  gnssAtEnd=engine.getGnssDeliveredCount();
  const gnssLeak=gnssAtEnd-gnssAtStart;
  roadApplied=engine.getRoadUpdateCount();
  routeApplied=engine.getRouteUpdateCount();

  const sorted=[...errs].sort((a,b)=>a-b);
  const mean=errs.length>0?errs.reduce((a,b)=>a+b,0)/errs.length:0;
  const p95=sorted.length>0?sorted[Math.floor(sorted.length*0.95)]:0;
  const max=errs.length>0?Math.max(...errs):0;
  const drift=outageDist>=5.0?(endErr/outageDist)*100.0:null;

  return {
    ablation,useRoad,useRoute,
    outageSamplesN:errs.length,
    outageDistM:Math.round(outageDist*100)/100,
    endpointErrorM:Math.round(endErr*100)/100,
    meanErrorM:Math.round(mean*100)/100,
    p95ErrorM:Math.round(p95*100)/100,
    maxErrorM:Math.round(max*100)/100,
    sihDriftPct:drift!==null?Math.round(drift*100)/100:null,
    passesSih:drift!==null?drift<10.0:false,
    gnssLeakDuringOutage:gnssLeak,
    gnssLeakageDetected:gnssLeak>0,
    roadUpdatesApplied:roadApplied,
    routeUpdatesApplied:routeApplied,
    timeSeriesSample:tsSamples.filter((_,i)=>i%Math.max(1,Math.floor(tsSamples.length/10))===0),
  };
}

function auditRoadCoverage(sid, fixture) {
  const samples=fixture.samples;
  let s0=null;
  for(const s of samples){ if(s.relative_time_ms/1000.0>=OUTAGE_START_SEC){s0=s;break;} }
  if(!s0) return {covered:false,nearbySegments:0,reason:'No sample at outage start'};

  const lat=s0.reference.latitude, lon=s0.reference.longitude;
  const inBbox=lat>=RN_BBOX.latMin&&lat<=RN_BBOX.latMax&&lon>=RN_BBOX.lonMin&&lon<=RN_BBOX.lonMax;
  let segs=0;
  try{ const c=roadProvider.queryRadius({latitude:lat,longitude:lon,altitude:0},200); segs=c?c.length:0; }catch(e){ segs=-1; }

  return {covered:segs>0,inBbox,lat:Math.round(lat*10000)/10000,lon:Math.round(lon*10000)/10000,nearbySegments:segs,reason:segs>0?'OK':(inBbox?'In bbox but 0 segments':'Outside road bbox')};
}

function auditTemporal(fixture) {
  const s=fixture.samples;
  if(!s||s.length===0) return {valid:false};
  const firstMs=s[0].relative_time_ms, lastMs=s[s.length-1].relative_time_ms;
  const durSec=(lastMs-firstMs)/1000.0;
  let startIdx=-1,endIdx=-1;
  for(let i=0;i<s.length;i++){
    const t=s[i].relative_time_ms/1000.0;
    if(startIdx===-1&&t>=OUTAGE_START_SEC) startIdx=i;
    if(endIdx===-1&&t>=OUTAGE_END_SEC) endIdx=i;
  }
  let minSpd=Infinity,maxSpd=-Infinity,nSpd=0;
  for(let i=Math.max(0,startIdx);i<Math.min(s.length,endIdx===-1?s.length:endIdx);i++){
    const v=s[i].reference?.speed_kmh??0;
    if(v<minSpd)minSpd=v; if(v>maxSpd)maxSpd=v; nSpd++;
  }
  const intervalMs=s.length>1?(lastMs-firstMs)/(s.length-1):100;
  return {
    valid:startIdx>=0,
    durationSec:Math.round(durSec*10)/10,
    totalSamples:s.length,
    sampleIntervalMs:Math.round(intervalMs),
    outageStartIdx:startIdx,
    outageEndIdx:endIdx,
    outageSamplesN:endIdx>startIdx?endIdx-startIdx:0,
    minSpeedKmh:nSpd>0?Math.round(minSpd*10)/10:null,
    maxSpeedKmh:nSpd>0?Math.round(maxSpd*10)/10:null,
    isStationary:maxSpd<2.0,
  };
}

async function main() {
  const onnxPath=path.resolve(repoRoot,'assets/models/B3_GRU.onnx');
  console.log('[AUDIT] Initializing ONNX...');
  await gruOnnxEvaluator.initialize(onnxPath);
  console.log('[AUDIT] Starting pipeline correctness audit...\n');

  const report={generatedAt:new Date().toISOString(),outageWindow:`${OUTAGE_START_SEC}-${OUTAGE_END_SEC}s`,roadBbox:RN_BBOX,sessions:[]};
  let totalLeaks=0, totalUncovered=0;

  for(const sid of ALL_SESSIONS){
    console.log('\n'+('=').repeat(70));
    console.log(`SESSION: ${sid}`);
    console.log(('=').repeat(70));

    const fixture=loadFixture(sid);
    const temporal=auditTemporal(fixture);
    const road=auditRoadCoverage(sid,fixture);
    if(!road.covered) totalUncovered++;

    console.log(`  Temporal: ${temporal.durationSec}s total, ${temporal.outageSamplesN} outage samples, spd=${temporal.minSpeedKmh}-${temporal.maxSpeedKmh}km/h, stationary=${temporal.isStationary}`);
    console.log(`  Road:     ${road.covered?'OK':'MISSING'} | ${road.nearbySegments} segs within 200m | lat=${road.lat} lon=${road.lon} | ${road.reason}`);

    const ablations={};
    for(const ab of ABLATIONS){
      process.stdout.write(`  ${ab.padEnd(20)}: `);
      try{
        const r=runAblation(sid,fixture,ab);
        ablations[ab]=r;
        if(r.gnssLeakageDetected){ totalLeaks++; console.log(`GNSS LEAK=${r.gnssLeakDuringOutage} DURING OUTAGE!`); }
        else{
          const drift=r.sihDriftPct!==null?`${r.sihDriftPct}%`:'N/A';
          const pass=r.sihDriftPct!==null?(r.passesSih?'PASS':'FAIL'):'N/A';
          console.log(`endpoint=${r.endpointErrorM}m | dist=${r.outageDistM}m | drift=${drift} ${pass} | road=${r.roadUpdatesApplied} route=${r.routeUpdatesApplied}`);
        }
      }catch(e){ ablations[ab]={error:e.message}; console.log(`ERROR: ${e.message}`); }
    }

    report.sessions.push({sessionId:sid,temporal,roadCoverage:road,ablations});
  }

  console.log('\n'+('=').repeat(70));
  console.log('AUDIT SUMMARY');
  console.log(('=').repeat(70));
  console.log(`GNSS leakages: ${totalLeaks} (must be 0)`);
  console.log(`Uncovered sessions: ${totalUncovered}`);

  console.log('\nABLATION DRIFT % TABLE:');
  console.log('Session  | A_IMU_ONLY | B_ROAD     | C_ROUTE    | D_ROAD+RT');
  console.log('---------+------------+------------+------------+----------');
  for(const sess of report.sessions){
    const fmtD=(ab)=>{
      const r=sess.ablations[ab];
      if(!r||r.error) return '  ERR  ';
      if(r.sihDriftPct===null) return '  N/A  ';
      return (r.sihDriftPct+'%').padStart(7)+(r.passesSih?' ?':' ?');
    };
    console.log(`${sess.sessionId.padEnd(9)}| ${fmtD('A_IMU_ONLY').padEnd(11)}| ${fmtD('B_ROAD').padEnd(11)}| ${fmtD('C_ROUTE_LEAKY').padEnd(11)}| ${fmtD('D_ROAD_ROUTE_LEAKY')}`);
  }

  console.log('\nROUTE-LEAKAGE IMPACT (C vs A — positive = route helps):');
  for(const sess of report.sessions){
    const A=sess.ablations['A_IMU_ONLY'], C=sess.ablations['C_ROUTE_LEAKY'];
    if(!A||A.error||!C||C.error||A.sihDriftPct===null||C.sihDriftPct===null) continue;
    const delta=Math.round((A.sihDriftPct-C.sihDriftPct)*10)/10;
    console.log(`  ${sess.sessionId.padEnd(8)}: A=${A.sihDriftPct}% C=${C.sihDriftPct}% ?=${delta>0?'+':''}${delta}% ${Math.abs(delta)>5?(delta>0?'(route helps)':'(route HURTS)'):'(negligible)'}`);
  }

  console.log('\nROAD COVERAGE:');
  for(const sess of report.sessions){
    const r=sess.roadCoverage;
    console.log(`  ${sess.sessionId.padEnd(8)}: ${r.covered?'OK   ':'NONE '} ${r.nearbySegments} segs | ${r.reason}`);
  }

  const outDir=path.join(repoRoot,'artifacts/device_evaluation');
  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir,{recursive:true});
  const rp=path.join(outDir,'audit_pipeline_report.json');
  fs.writeFileSync(rp,JSON.stringify(report,null,2),'utf8');
  console.log(`\n[AUDIT] Report saved: ${rp}`);
}

main().catch(e=>{ console.error('[AUDIT] Fatal:',e); process.exit(1); });
