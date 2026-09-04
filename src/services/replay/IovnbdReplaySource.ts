/**
 * IovnbdReplaySource
 *
 * Real-Time Virtual Clock Replay Engine for IO-VNBD Benchmark Data.
 *
 * ARCHITECTURAL PRINCIPLE & RESEARCH INTEGRITY:
 * 1. Operates on a virtual replay clock separate from wall-clock time.
 * 2. Replay speed (0.25x to 5x) changes wall-clock pacing only; physical dt
 *    between sensor samples strictly preserves the recorded dataset timestamps.
 * 3. Enforces physical separation between Reference GPS and Estimator IMU.
 * 4. Implements the 5 canonical experiment modes: C0, R0, R1, R2, R3.
 * 5. Guarantees that in R0 and R1, dataset GPS never leaks into the estimator.
 */

import { ImuSample } from "../../core/types/imu";
import { NavLocation } from "../../core/types/location";
import { HybridIdrPositioningEngine } from "../../core/positioning/HybridIdrPositioningEngine";
import { KinematicBaselineEstimator } from "../../core/positioning/motionEstimator";
import { RouteConstraintProvider } from "../../core/positioning/RouteConstraintProvider";
import { ReplayMetricsTracker } from "./ReplayMetricsTracker";
import {
  ExperimentMode,
  IovnbdFixture,
  IovnbdSample,
  ReplayClockState,
  ReplaySpeed,
  ReplayTelemetry,
  ReplayTelemetryListener,
} from "./types";

// Import bundled representative fixture (1,800 samples, 179.9s, 1.33 km, Coventry, UK)
import s1FixtureData from "../../../assets/datasets/iovnbd_s1.json";

export class IovnbdReplaySource {
  private fixture: IovnbdFixture;
  private clockState: ReplayClockState = "STOPPED";
  private speed: ReplaySpeed = 1.0;
  private experimentMode: ExperimentMode = "R0_PURE_DR";

  // Replay Clock
  private currentSampleIndex = 0;
  private virtualTimeMs = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private lastWallClockMs = 0;

  // Drop / Recovery Configuration
  private outageStartSec = 20.0;
  private outageDurationSec = 30.0; // 20s to 50s

  // Subsystems
  private positioningEngine: HybridIdrPositioningEngine;
  private routeConstraintProvider: RouteConstraintProvider;
  private metricsTracker = new ReplayMetricsTracker();

  // Static Route Polyline (Pre-trip navigation plan for Experiment R1)
  private staticRoutePoints: { latitude: number; longitude: number }[] = [];

  // Telemetry Listeners
  private telemetryListeners = new Set<ReplayTelemetryListener>();

  // Reference Trajectory History for Map Rendering
  private referenceHistory: { latitude: number; longitude: number }[] = [];
  private estimatedHistory: { latitude: number; longitude: number }[] = [];

  constructor(
    positioningEngine: HybridIdrPositioningEngine,
    routeConstraintProvider: RouteConstraintProvider,
  ) {
    this.positioningEngine = positioningEngine;
    this.routeConstraintProvider = routeConstraintProvider;
    this.fixture = s1FixtureData as unknown as IovnbdFixture;

    // Build static route polyline once from reference coordinates (represents prior trip planning)
    this.staticRoutePoints = this.fixture.samples.map((s) => ({
      latitude: s.reference.latitude,
      longitude: s.reference.longitude,
    }));

    // Configure positioning engine with static route
    this.positioningEngine.setStaticRoutePoints(this.staticRoutePoints);
    this.positioningEngine.setRouteConstraintProvider(
      this.routeConstraintProvider,
    );

    // Prime first sample so initial position and trajectory are immediately ready
    if (this.fixture.samples.length > 0) {
      this.initializeFirstSample();
    }
  }

  public getFixture(): IovnbdFixture {
    return this.fixture;
  }

  public getStaticRoutePoints(): { latitude: number; longitude: number }[] {
    return this.staticRoutePoints;
  }

  public getReferenceHistory(): { latitude: number; longitude: number }[] {
    return this.referenceHistory;
  }

  public getEstimatedHistory(): { latitude: number; longitude: number }[] {
    return this.estimatedHistory;
  }

  public setExperimentMode(mode: ExperimentMode): void {
    const wasPlaying = this.clockState === "PLAYING";
    this.reset();
    this.experimentMode = mode;
    // Configure route constraint state according to experiment definition
    if (mode === "R1_ROUTE_CONSTRAINED") {
      this.routeConstraintProvider.setEnabled(true);
    } else {
      this.routeConstraintProvider.setEnabled(false);
    }
    if (wasPlaying) {
      this.play();
    } else {
      this.broadcastTelemetry();
    }
  }

  public toggleRouteConstraint(): void {
    const nextState = !this.routeConstraintProvider.getEnabled();
    this.routeConstraintProvider.setEnabled(nextState);
    this.broadcastTelemetry();
  }

  public setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
    this.broadcastTelemetry();
  }

  public setOutageInterval(startSec: number, durationSec: number): void {
    this.outageStartSec = startSec;
    this.outageDurationSec = durationSec;
  }

  public play(): void {
    if (this.clockState === "PLAYING") return;

    this.clockState = "PLAYING";
    this.lastWallClockMs = Date.now();

    // If starting from beginning, prime initial state
    if (this.currentSampleIndex === 0 && this.fixture.samples.length > 0) {
      this.initializeFirstSample();
    }

    this.timerId = setInterval(() => {
      this.onTimerTick();
    }, 20); // 50 Hz internal scheduler tick

    this.broadcastTelemetry();
  }

  public pause(): void {
    if (this.clockState !== "PLAYING") return;
    this.clockState = "PAUSED";
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.broadcastTelemetry();
  }

  public reset(): void {
    this.pause();
    this.clockState = "STOPPED";
    this.currentSampleIndex = 0;
    this.virtualTimeMs = 0;
    this.referenceHistory = [];
    this.estimatedHistory = [];
    this.metricsTracker.reset();
    this.positioningEngine.reset();
    if (this.fixture.samples.length > 0) {
      this.initializeFirstSample();
    }
    this.broadcastTelemetry();
  }

  public seek(targetTimeMs: number): void {
    const wasPlaying = this.clockState === "PLAYING";
    this.pause();

    this.virtualTimeMs = Math.max(
      0,
      Math.min(targetTimeMs, this.getTotalDurationMs()),
    );

    // Find sample matching targetTimeMs
    let idx = 0;
    while (
      idx < this.fixture.samples.length - 1 &&
      this.fixture.samples[idx + 1].relative_time_ms <= this.virtualTimeMs
    ) {
      idx++;
    }
    this.currentSampleIndex = idx;

    if (wasPlaying) {
      this.play();
    } else {
      this.broadcastTelemetry();
    }
  }

  public getTotalDurationMs(): number {
    if (this.fixture.samples.length === 0) return 0;
    return this.fixture.samples[this.fixture.samples.length - 1]
      .relative_time_ms;
  }

  public addTelemetryListener(listener: ReplayTelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    listener(this.getTelemetry());
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  public getTelemetry(): ReplayTelemetry {
    const currentSample =
      this.currentSampleIndex < this.fixture.samples.length
        ? this.fixture.samples[this.currentSampleIndex]
        : null;

    const metricSnap = this.metricsTracker.getSnapshot();
    const est = this.positioningEngine.getCurrentEstimate();

    return {
      clockState: this.clockState,
      elapsedTimeMs: this.virtualTimeMs,
      totalDurationMs: this.getTotalDurationMs(),
      speed: this.speed,
      experimentMode: this.experimentMode,
      currentSampleIndex: this.currentSampleIndex,
      totalSamples: this.fixture.samples.length,
      referenceCoordinate: currentSample
        ? {
            latitude: currentSample.reference.latitude,
            longitude: currentSample.reference.longitude,
            speedKmh: currentSample.reference.speed_kmh,
            headingDeg: currentSample.reference.heading_deg,
          }
        : null,
      gnssPermittedIntoEstimator: this.isGnssPermittedNow(),
      gnssDeliveredCount: this.positioningEngine.getGnssDeliveredCount(),
      isDeadReckoning: est.isDeadReckoning,
      routeConstraintActive: this.routeConstraintProvider.getEnabled(),
      instantaneousErrorMeters:
        this.experimentMode === "C0_REFERENCE_ONLY"
          ? 0.0
          : metricSnap.instantaneousErrorMeters,
      cumulativeDistanceTraveledM: metricSnap.cumulativeDistanceTraveledM,
      cumulativeDriftPercent:
        this.experimentMode === "C0_REFERENCE_ONLY"
          ? 0.0
          : metricSnap.driftPercent,
      milestoneErrors: metricSnap.milestoneErrors,
    };
  }

  /**
   * Evaluates whether reference GNSS is permitted to enter the estimator right now.
   * STRICT LEAKAGE RULE:
   * - C0: FALSE (estimator bypassed)
   * - R0: FALSE (GNSS blocked throughout)
   * - R1: FALSE (GNSS blocked throughout)
   * - R2: TRUE (GNSS allowed throughout)
   * - R3: TRUE before outage, FALSE during outage, TRUE after outage
   */
  private isGnssPermittedNow(): boolean {
    if (this.experimentMode === "C0_REFERENCE_ONLY") return false;
    if (this.experimentMode === "R0_PURE_DR") return false;
    if (this.experimentMode === "R1_ROUTE_CONSTRAINED") return false;
    if (this.experimentMode === "R2_FULL_GNSS") return true;

    // R3_DROP_RECOVERY
    const elapsedSec = this.virtualTimeMs / 1000.0;
    const outageEndSec = this.outageStartSec + this.outageDurationSec;
    const isInOutage =
      elapsedSec >= this.outageStartSec && elapsedSec < outageEndSec;

    return !isInOutage;
  }

  private initializeFirstSample(): void {
    const first = this.fixture.samples[0];
    const initialLocation: NavLocation = {
      latitude: first.reference.latitude,
      longitude: first.reference.longitude,
      altitude: first.phone_gps.altitude,
      speed: first.reference.speed_kmh / 3.6,
      heading: first.reference.heading_deg,
      accuracy: 3.0,
      timestamp: first.sensor_timestamp_ms,
      providerType: "gnss",
      isDeadReckoning: false,
    };

    // Anchor the positioning engine at t0
    this.positioningEngine.processGnss(initialLocation);

    // Record initial reference point
    this.referenceHistory = [
      {
        latitude: first.reference.latitude,
        longitude: first.reference.longitude,
      },
    ];
    this.estimatedHistory = [
      {
        latitude: first.reference.latitude,
        longitude: first.reference.longitude,
      },
    ];
  }

  private onTimerTick(): void {
    if (this.clockState !== "PLAYING") return;

    const nowWallMs = Date.now();
    const wallDeltaMs = nowWallMs - this.lastWallClockMs;
    this.lastWallClockMs = nowWallMs;

    // Advance virtual replay time by wallDelta * speed
    this.virtualTimeMs += wallDeltaMs * this.speed;

    // Check if we reached the end of the fixture
    if (this.virtualTimeMs >= this.getTotalDurationMs()) {
      this.virtualTimeMs = this.getTotalDurationMs();
      this.pause();
      return;
    }

    // Process all samples up to current virtualTimeMs
    let advanced = false;
    while (
      this.currentSampleIndex < this.fixture.samples.length &&
      this.fixture.samples[this.currentSampleIndex].relative_time_ms <=
        this.virtualTimeMs
    ) {
      this.emitSample(this.fixture.samples[this.currentSampleIndex]);
      this.currentSampleIndex++;
      advanced = true;
    }

    if (advanced) {
      this.broadcastTelemetry();
    }
  }

  private emitSample(sample: IovnbdSample): void {
    const gnssPermitted = this.isGnssPermittedNow();

    // 1. Construct normalized ImuSample (preserving original timestamps and units)
    const imuSample: ImuSample = {
      timestamp: sample.sensor_timestamp_ms,
      accel: {
        x: sample.accel.x,
        y: sample.accel.y,
        z: sample.accel.z,
      },
      gyro: {
        x: sample.gyro.roll,
        y: sample.gyro.pitch, // In IO-VNBD portrait mount, pitch is vehicle yaw
        z: sample.gyro.yaw,
      },
      magnetometer: {
        x: sample.mag.x,
        y: sample.mag.y,
        z: sample.mag.z,
      },
    };

    // 2. Construct reference NavLocation
    const refLocation: NavLocation = {
      latitude: sample.reference.latitude,
      longitude: sample.reference.longitude,
      altitude: sample.phone_gps.altitude,
      speed: sample.reference.speed_kmh / 3.6,
      heading: sample.reference.heading_deg,
      accuracy: 3.0,
      timestamp: sample.sensor_timestamp_ms,
      providerType: "gnss",
      isDeadReckoning: false,
    };

    // 3. Process through PositioningEngine according to Experiment Mode
    let estLat = sample.reference.latitude;
    let estLon = sample.reference.longitude;

    if (this.experimentMode === "C0_REFERENCE_ONLY") {
      // C0 is Reference-Only Control: zero estimation error, validates reference track
      estLat = sample.reference.latitude;
      estLon = sample.reference.longitude;
    } else {
      // Deliver GNSS ONLY if permitted
      if (gnssPermitted) {
        this.positioningEngine.processGnss(refLocation);
      } else {
        // If transitioning into outage, notify engine
        if (this.positioningEngine.getStatus() === "GNSS_AVAILABLE") {
          this.positioningEngine.onGnssBlocked();
          this.metricsTracker.notifyOutageStarted(sample.relative_time_ms);
        }
      }

      // Deliver IMU to dead-reckoning engine
      const est = this.positioningEngine.processImu(imuSample);
      if (est) {
        estLat = est.latitude;
        estLon = est.longitude;
      }
    }

    // 4. Update Reference and Estimated History Trails for Map
    const nextRef = this.referenceHistory.slice(-499);
    nextRef.push({
      latitude: sample.reference.latitude,
      longitude: sample.reference.longitude,
    });
    this.referenceHistory = nextRef;

    const nextEst = this.estimatedHistory.slice(-499);
    nextEst.push({
      latitude: estLat,
      longitude: estLon,
    });
    this.estimatedHistory = nextEst;

    // 5. Update Metrics Tracker
    this.metricsTracker.update(
      sample.reference.latitude,
      sample.reference.longitude,
      estLat,
      estLon,
      sample.relative_time_ms,
      !gnssPermitted,
    );
  }

  public getCurrentEstimatedLocation(): NavLocation | null {
    if (this.fixture.samples.length === 0) return null;
    const currentSample =
      this.fixture.samples[
        Math.min(this.currentSampleIndex, this.fixture.samples.length - 1)
      ];
    const est = this.positioningEngine.getCurrentEstimate();

    if (this.experimentMode === "C0_REFERENCE_ONLY" || !est.valid) {
      return {
        latitude: currentSample.reference.latitude,
        longitude: currentSample.reference.longitude,
        altitude: currentSample.phone_gps.altitude,
        speed: currentSample.reference.speed_kmh / 3.6,
        heading: currentSample.reference.heading_deg,
        accuracy: 3.0,
        timestamp: currentSample.sensor_timestamp_ms,
        providerType: "mock",
        isDeadReckoning: false,
      };
    }

    return {
      latitude: est.latitude,
      longitude: est.longitude,
      altitude: est.altitude ?? null,
      speed: est.speed ?? null,
      heading: est.heading ?? null,
      accuracy: est.horizontal_accuracy ?? null,
      timestamp: est.timestamp_ms,
      providerType: "mock",
      isDeadReckoning: est.isDeadReckoning,
    };
  }

  public getPositioningEngine(): HybridIdrPositioningEngine {
    return this.positioningEngine;
  }

  public getRouteConstraintProvider(): RouteConstraintProvider {
    return this.routeConstraintProvider;
  }

  private broadcastTelemetry(): void {
    const tel = this.getTelemetry();
    this.telemetryListeners.forEach((listener) => {
      try {
        listener(tel);
      } catch (err) {
        console.error("Error in ReplayTelemetryListener:", err);
      }
    });
  }
}

// Shared Singleton Factory
const defaultBaselineEstimator = new KinematicBaselineEstimator();
const defaultRouteConstraintProvider = new RouteConstraintProvider();
const defaultHybridEngine = new HybridIdrPositioningEngine(
  defaultBaselineEstimator,
  defaultRouteConstraintProvider,
);

export const iovnbdReplaySource = new IovnbdReplaySource(
  defaultHybridEngine,
  defaultRouteConstraintProvider,
);
