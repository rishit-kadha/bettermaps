import { Eskf } from "../../core/positioning/eskf/Eskf";
import { EskfPositioningEngine } from "../../core/positioning/EskfPositioningEngine";
import { LearnedMotionEstimator } from "../../core/positioning/motionEstimator";
import { ProbabilisticRouteConstraint } from "../../core/positioning/constraints/ProbabilisticRouteConstraint";
import { ProbabilisticRoadConstraint } from "../../core/positioning/constraints/ProbabilisticRoadConstraint";
import { MultiCandidateRoadMatcher } from "../../core/navigation/road/MultiCandidateRoadMatcher";
import { IRoadNetworkProvider } from "../../core/navigation/road/IRoadNetworkProvider";
import { ImuSample } from "../../core/types/imu";
import { NavLocation } from "../../core/types/location";
import { PreExistingRoute } from "../../core/navigation/routing/RoutingTypes";

export interface LatencyStats {
  stage: string;
  n: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function calculatePercentiles(samplesMs: number[], stage: string): LatencyStats {
  samplesMs.sort((a, b) => a - b);
  const n = samplesMs.length;
  const sum = samplesMs.reduce((acc, v) => acc + v, 0);
  const meanMs = sum / n;
  const medianMs = samplesMs[Math.floor(n * 0.5)];
  const p95Ms = samplesMs[Math.floor(n * 0.95)];
  const p99Ms = samplesMs[Math.floor(n * 0.99)];
  const maxMs = samplesMs[n - 1];

  return {
    stage,
    n,
    meanMs,
    medianMs,
    p95Ms,
    p99Ms,
    maxMs,
  };
}

export function runMobileLatencyBenchmark(numTicks = 2000): Record<string, LatencyStats> {
  const mockRoadProvider: IRoadNetworkProvider = {
    findNearbySegments: () => [
      {
        id: "seg_bench",
        startPoint: { latitude: 52.408, longitude: -1.512 },
        endPoint: { latitude: 52.415, longitude: -1.512 },
        bearingDeg: 0.0,
        lengthMeters: 700.0,
      },
    ],
    getSegmentById: () => null,
    getProviderName: () => "BenchmarkMock",
    isOffline: () => true,
  };
  const roadMatcher = new MultiCandidateRoadMatcher(mockRoadProvider);
  const roadConstraint = new ProbabilisticRoadConstraint(roadMatcher);

  const mockRoute: PreExistingRoute = {
    id: "route_bench",
    name: "Bench Route",
    polylinePoints: [
      { latitude: 52.408, longitude: -1.512 },
      { latitude: 52.415, longitude: -1.512 },
    ],
    totalDistanceMeters: 700.0,
    estimatedDurationSeconds: 60.0,
    sourceProvider: "mock",
    creationTimestampMs: Date.now(),
  };
  const routeConstraint = new ProbabilisticRouteConstraint();
  routeConstraint.setRoute(mockRoute);

  const motionEstimator = new LearnedMotionEstimator("tcn");
  const engine = new EskfPositioningEngine({
    motionEstimator,
    roadConstraint,
    routeConstraint,
  });

  const originFix: NavLocation = {
    latitude: 52.408,
    longitude: -1.512,
    altitude: 100.0,
    accuracy: 3.0,
    speed: 12.0,
    heading: 0.0,
    timestamp: 1000,
    providerType: "gnss",
    isDeadReckoning: false,
  };
  engine.processGnss(originFix);

  const preprocessingTimes: number[] = [];
  const mlInferenceTimes: number[] = [];
  const eskfPropagateTimes: number[] = [];
  const nhcUpdateTimes: number[] = [];
  const roadConstraintTimes: number[] = [];
  const routeConstraintTimes: number[] = [];
  const totalTickTimes: number[] = [];

  const standaloneEskf = new Eskf();
  standaloneEskf.reset();

  const imuWindow: ImuSample[] = [];
  for (let i = 0; i < 20; i++) {
    imuWindow.push({
      timestamp: 1000 + i * 100,
      accel: { x: 0.1, y: 0.2, z: 9.80665 },
      gyro: { x: 0.001, y: 0.002, z: 0.001 },
    });
  }

  // Warmup (200 ticks)
  for (let i = 0; i < 200; i++) {
    const sample: ImuSample = {
      timestamp: 2000 + i * 100,
      accel: { x: 0.05 * Math.sin(i * 0.1), y: 0.1 * Math.cos(i * 0.1), z: 9.80665 },
      gyro: { x: 0.001, y: 0.001, z: 0.01 * Math.sin(i * 0.05) },
    };
    engine.processImu(sample);
  }

  // Timing loop
  for (let i = 0; i < numTicks; i++) {
    const ts = 3000 + i * 100;
    const sample: ImuSample = {
      timestamp: ts,
      accel: { x: 0.05 * Math.sin(i * 0.1), y: 0.1 * Math.cos(i * 0.1), z: 9.80665 },
      gyro: { x: 0.001, y: 0.001, z: 0.01 * Math.sin(i * 0.05) },
    };

    // 1. Preprocessing / Window Extraction
    const tp0 = performance.now();
    const testWindow = imuWindow.slice(-20);
    const forwardAccel = sample.accel.y;
    const lateralAccel = -sample.accel.x;
    const verticalAccel = sample.accel.z;
    const tp1 = performance.now();
    preprocessingTimes.push(tp1 - tp0);

    // 2. ML Inference (Tiny Causal TCN)
    const t0 = performance.now();
    motionEstimator.estimate(testWindow);
    const t1 = performance.now();
    mlInferenceTimes.push(t1 - t0);

    // 3. ESKF IMU Propagation
    const t2 = performance.now();
    standaloneEskf.propagate(
      {
        timestampS: ts / 1000.0,
        accelMps2: [forwardAccel, lateralAccel, verticalAccel],
        gyroRadps: [sample.gyro.x, sample.gyro.y, sample.gyro.z],
      },
      0.1,
    );
    const t3 = performance.now();
    eskfPropagateTimes.push(t3 - t2);

    // 4. NHC Update
    const t4 = performance.now();
    standaloneEskf.updateNhc(0.35, 0.2);
    const t5 = performance.now();
    nhcUpdateTimes.push(t5 - t4);

    // 5. Road Constraint
    const tRoad0 = performance.now();
    roadConstraint.evaluateAndApply(standaloneEskf, {
      latitude: 52.408,
      longitude: -1.512,
      altitude: 100.0,
    });
    const tRoad1 = performance.now();
    roadConstraintTimes.push(tRoad1 - tRoad0);

    // 6. Route Constraint
    const tRoute0 = performance.now();
    routeConstraint.evaluateAndApply(standaloneEskf, {
      latitude: 52.408,
      longitude: -1.512,
      altitude: 100.0,
    });
    const tRoute1 = performance.now();
    routeConstraintTimes.push(tRoute1 - tRoute0);

    // 7. Full Pipeline End-to-End Tick
    const tFull0 = performance.now();
    engine.processImu(sample);
    const tFull1 = performance.now();
    totalTickTimes.push(tFull1 - tFull0);
  }

  return {
    preprocessing: calculatePercentiles(preprocessingTimes, "IMU Preprocessing & Windowing"),
    mlInference: calculatePercentiles(mlInferenceTimes, "ML Motion Model (Tiny Causal TCN)"),
    eskfPropagate: calculatePercentiles(eskfPropagateTimes, "ESKF IMU Propagation Step"),
    nhcUpdate: calculatePercentiles(nhcUpdateTimes, "Non-Holonomic Constraints (NHC)"),
    roadConstraint: calculatePercentiles(roadConstraintTimes, "Probabilistic Road Constraint"),
    routeConstraint: calculatePercentiles(routeConstraintTimes, "Probabilistic Route Constraint"),
    totalTick: calculatePercentiles(totalTickTimes, "Total Estimator Tick (End-to-End)"),
  };
}
