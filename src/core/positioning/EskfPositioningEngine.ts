/**
 * EskfPositioningEngine.ts
 *
 * Production 15-State Quaternion Error-State Kalman Filter Positioning Engine.
 * Implements IPositioningEngine, replacing direct kinematic dead-reckoning.
 *
 * SENSOR INTEGRATION PIPELINE:
 * Raw Sensor Input
 *   ↓
 * Vehicle-Frame Preprocessing
 *   ↓
 * Eskf.propagate(IMU)
 *   ↓
 * Learned Motion Model (Forward Velocity & Yaw Rate)
 *   ↓
 * Eskf.updateForwardVelocity() & Eskf.updateYawRate()
 *   ↓
 * Eskf.updateNhc() (Soft lateral/vertical velocity suppression)
 *   ↓
 * Probabilistic Route / Road Constraints (Bayesian soft polyline updates)
 *   ↓
 * Posterior PositionEstimate Emitted
 */

import { ImuSample } from "../types/imu";
import { NavLocation } from "../types/location";
import {
  IPositioningEngine,
  PositionEstimate,
  PositionEstimateListener,
  PositioningStatus,
  PositioningStatusListener,
} from "../types/positioning";
import { enuToWgs84, wgs84ToEnu, Wgs84Coordinate } from "./coordinates";
import { Eskf } from "./eskf/Eskf";
import {
  EskfDiagnostics,
  NavigationState,
  VehicleFrameImuMeasurement,
  Vector3,
} from "./eskf/EskfTypes";
import { Matrix15, quatFromRotvec } from "./eskf/EskfMath";
import {
  IMotionEstimator,
  KinematicBaselineEstimator,
} from "./motionEstimator";
import { ProbabilisticRouteConstraint } from "./constraints/ProbabilisticRouteConstraint";
import { ProbabilisticRoadConstraint } from "./constraints/ProbabilisticRoadConstraint";
import { PreExistingRoute } from "../navigation/routing/RoutingTypes";

export interface EskfEngineOptions {
  motionEstimator?: IMotionEstimator;
  routeConstraint?: ProbabilisticRouteConstraint;
  roadConstraint?: ProbabilisticRoadConstraint;
}

export class EskfPositioningEngine implements IPositioningEngine {
  private status: PositioningStatus = "NO_POSITION";
  private currentEstimate: PositionEstimate = this.createEmptyEstimate();

  // 15-State ESKF Core
  private readonly eskf: Eskf;

  // Local metric origin
  private origin: Wgs84Coordinate | null = null;

  // Sliding window of IMU samples for ML motion estimators
  private imuWindow: ImuSample[] = [];
  private readonly maxWindowSamples = 30;

  // Motion Estimator
  private motionEstimator: IMotionEstimator;

  // Probabilistic soft constraints
  private routeConstraint: ProbabilisticRouteConstraint | null = null;
  private roadConstraint: ProbabilisticRoadConstraint | null = null;

  // Diagnostic leakage counter: strictly 0 during GNSS outages
  private gnssMeasurementsDeliveredToEstimator = 0;

  // GNSS Watchdog & Telemetry Tracking
  private lastGnssFixTimestampMs = 0;
  private lastGnssFix: NavLocation | null = null;
  private gnssFixCount = 0;
  private gnssUpdateCount = 0;

  // Event Listeners
  private estimateListeners = new Set<PositionEstimateListener>();
  private statusListeners = new Set<PositioningStatusListener>();

  constructor(options?: EskfEngineOptions) {
    this.eskf = new Eskf();
    this.motionEstimator =
      options?.motionEstimator ?? new KinematicBaselineEstimator();
    this.routeConstraint = options?.routeConstraint ?? null;
    this.roadConstraint = options?.roadConstraint ?? null;
  }

  // ==========================================
  // IPositioningEngine Contract
  // ==========================================

  /**
   * Ingest incoming reference GNSS location fix.
   * Called ONLY when GNSS stream gate is ENABLED.
   * Applies smooth Kalman measurement updates, NOT hard position overwrites.
   */
  public processGnss(sample: NavLocation): PositionEstimate {
    this.gnssMeasurementsDeliveredToEstimator++;
    this.gnssFixCount++;
    this.lastGnssFixTimestampMs = sample.timestamp || Date.now();
    this.lastGnssFix = { ...sample };
    this.status = "GNSS_AVAILABLE";

    const accuracy = sample.accuracy ?? 5.0;

    if (!this.origin) {
      // First fix: establish local tangent plane origin
      this.origin = {
        latitude: sample.latitude,
        longitude: sample.longitude,
        altitude: sample.altitude ?? 0.0,
      };

      const headingDeg = sample.heading ?? 0.0;
      // Heading is clockwise from North (+Y in ENU).
      // Vehicle forward axis +X in body rotates to ENU forward.
      // Yaw angle from ENU East (+X): alpha = 90 - heading.
      const alphaRad = ((90.0 - headingDeg) * Math.PI) / 180.0;
      const qInit = quatFromRotvec([0.0, 0.0, alphaRad]);

      const speedMps = sample.speed ?? 0.0;
      const hRad = (headingDeg * Math.PI) / 180.0;
      const vInit: Vector3 =
        speedMps < 0.3
          ? [0.0, 0.0, 0.0]
          : [
              speedMps * Math.sin(hRad),
              speedMps * Math.cos(hRad),
              0.0,
            ];

      const initState: NavigationState = {
        positionEnu: [0.0, 0.0, 0.0],
        velocityEnu: vInit,
        qNb: qInit,
        accelBias: [0.0, 0.0, 0.0],
        gyroBias: [0.0, 0.0, 0.0],
      };

      // Initial covariance: moderate position/velocity uncertainty
      const initP = Matrix15.fromDiag([
        accuracy * accuracy,
        accuracy * accuracy,
        25.0, // Position variance (m^2)
        4.0,
        4.0,
        1.0, // Velocity variance (m/s)^2
        0.05,
        0.05,
        0.1, // Attitude variance (rad^2)
        0.01,
        0.01,
        0.01, // Accel bias variance (m/s^2)^2
        0.001,
        0.001,
        0.001, // Gyro bias variance (rad/s)^2
      ]);

      this.eskf.reset(initState, initP);
      this.gnssUpdateCount++;
    } else {
      // Subsequent fix: Bayesian measurement update
      const enu = wgs84ToEnu(sample, this.origin);
      this.eskf.updateGnssPosition(
        [enu.east, enu.north, enu.up ?? 0.0],
        Math.max(1.0, accuracy),
      );
      this.gnssUpdateCount++;

      // Velocity update:
      // If speed is practically zero (< 0.3 m/s), device is stationary:
      // ENU velocity is [0, 0, 0] regardless of whether heading is known!
      if (
        sample.speed !== null &&
        sample.speed !== undefined &&
        sample.speed < 0.3
      ) {
        this.eskf.updateGnssVelocity([0.0, 0.0, 0.0], 0.1);
      } else if (
        sample.speed !== null &&
        sample.speed !== undefined &&
        sample.heading !== null &&
        sample.heading !== undefined
      ) {
        const hRad = (sample.heading * Math.PI) / 180.0;
        const speed = sample.speed;
        this.eskf.updateGnssVelocity(
          [speed * Math.sin(hRad), speed * Math.cos(hRad), 0.0],
          1.0,
        );
      }
    }

    // Prime the motion estimator with current ground speed
    if (this.motionEstimator.primeState) {
      const speedMs = sample.speed ?? 0.0;
      const hRad = ((sample.heading ?? 0.0) * Math.PI) / 180.0;
      this.motionEstimator.primeState(speedMs, hRad);
    }

    const postState = this.eskf.getState();
    const diag = this.eskf.getDiagnostics();
    const speed = Math.hypot(
      postState.velocityEnu[0],
      postState.velocityEnu[1],
    );
    const heading = this.eskf.getHeadingDeg();

    this.currentEstimate = {
      timestamp_ns: sample.timestamp * 1_000_000,
      timestamp_ms: sample.timestamp,
      latitude: sample.latitude, // When permitted, strictly follow verified GNSS
      longitude: sample.longitude,
      altitude: sample.altitude ?? null,
      speed: sample.speed ?? speed,
      heading: sample.heading ?? heading,
      horizontal_accuracy: sample.accuracy ?? diag.posUncertaintyM,
      vertical_accuracy:
        sample.verticalAccuracy ?? sample.altitudeAccuracy ?? null,
      position_source: sample.providerType === "mock" ? "MOCK" : "GNSS",
      confidence: 1.0,
      valid: true,
      isDeadReckoning: false,
    };

    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
    return this.currentEstimate;
  }

  /**
   * Notified when the GNSS stream gate is DISABLED (simulating outage).
   * Transitions engine to pure dead-reckoning state.
   */
  public onGnssBlocked(): PositionEstimate {
    this.status = "GNSS_BLOCKED_SIMULATED";

    if (this.currentEstimate.valid) {
      this.currentEstimate = {
        ...this.currentEstimate,
        position_source: "IDR",
        isDeadReckoning: true,
        confidence: Math.max(0.15, this.currentEstimate.confidence * 0.9),
      };
    }

    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
    return this.currentEstimate;
  }

  /**
   * Ingest continuous high-rate IMU sample.
   * Feeds vehicle-frame ESKF propagation, motion estimator inference, NHC,
   * and probabilistic road/route constraints.
   */
  public processImu(sample: ImuSample): PositionEstimate | null {
    this.imuWindow.push(sample);
    if (this.imuWindow.length > this.maxWindowSamples) {
      this.imuWindow.shift();
    }

    if (!this.origin) {
      return null;
    }

    // 1. Map raw phone IMU to vehicle body frame:
    // In IO-VNBD portrait windshield mount:
    // Longitudinal (forward) = +Y, Lateral (left) = -X, Vertical (up) = +Z
    // Yaw rate is phone pitch (gyro.y)
    const forwardAccel = sample.accel.y;
    const lateralAccel = -sample.accel.x;
    const verticalAccel = sample.accel.z;

    const rollRate = sample.gyro.x;
    const yawRate = sample.gyro.y;
    const pitchRate = sample.gyro.z;

    const imuMeas: VehicleFrameImuMeasurement = {
      timestampS: sample.timestamp / 1000.0,
      accelMps2: [forwardAccel, lateralAccel, verticalAccel],
      gyroRadps: [rollRate, pitchRate, yawRate],
    };

    // 2. ESKF continuous-discrete propagation
    this.eskf.propagate(imuMeas);

    // 3. Query learned/kinematic motion model
    const motion = this.motionEstimator.estimate(this.imuWindow);

    // 4. Update ESKF with learned forward velocity and yaw rate
    const velStd = Math.sqrt(Math.max(1e-4, motion.velocityVariance));
    this.eskf.updateForwardVelocity(motion.forwardVelocity, velStd);

    const yawStd = Math.sqrt(Math.max(1e-6, motion.yawRateVariance));
    this.eskf.updateYawRate(motion.yawRate, yawStd, yawRate);

    // 5. Update Non-Holonomic Constraints (lateral/vertical velocity ≈ 0)
    this.eskf.updateNhc();

    // 6. Apply soft road constraint (if active)
    try {
      if (this.roadConstraint && this.roadConstraint.getEnabled()) {
        this.roadConstraint.evaluateAndApply(this.eskf, this.origin);
      }
    } catch (err) {
      console.warn("[EskfPositioningEngine] Defensive catch: Road constraint error:", err);
    }

    // 7. Apply soft route constraint (if active)
    try {
      if (this.routeConstraint && this.routeConstraint.getEnabled()) {
        this.routeConstraint.evaluateAndApply(this.eskf, this.origin);
      }
    } catch (err) {
      console.warn("[EskfPositioningEngine] Defensive catch: Route constraint error:", err);
    }

    // 8. Construct posterior PositionEstimate
    const postState = this.eskf.getState();
    const wgs = enuToWgs84(
      {
        east: postState.positionEnu[0],
        north: postState.positionEnu[1],
        up: postState.positionEnu[2],
      },
      this.origin,
    );

    const speed = Math.hypot(
      postState.velocityEnu[0],
      postState.velocityEnu[1],
    );
    const heading = this.eskf.getHeadingDeg();
    const diag = this.eskf.getDiagnostics();

    const isSimulatedOutage = this.status === "GNSS_BLOCKED_SIMULATED";
    const isGnssStale =
      this.lastGnssFixTimestampMs > 0 &&
      sample.timestamp - this.lastGnssFixTimestampMs > 3000;
    const isOutage = isSimulatedOutage || isGnssStale;

    this.currentEstimate = {
      timestamp_ns: sample.timestamp * 1_000_000,
      timestamp_ms: sample.timestamp,
      latitude: isOutage ? wgs.latitude : (this.lastGnssFix?.latitude ?? wgs.latitude),
      longitude: isOutage ? wgs.longitude : (this.lastGnssFix?.longitude ?? wgs.longitude),
      altitude: isOutage ? (wgs.altitude ?? null) : (this.lastGnssFix?.altitude ?? wgs.altitude ?? null),
      speed,
      heading,
      horizontal_accuracy: isOutage ? diag.posUncertaintyM : (this.lastGnssFix?.accuracy ?? diag.posUncertaintyM),
      vertical_accuracy: null,
      position_source: isOutage ? "IDR" : "GNSS+INS",
      confidence: isOutage
        ? Math.max(0.1, Math.min(1.0, 5.0 / Math.max(1.0, diag.posUncertaintyM)))
        : 1.0,
      valid: true,
      isDeadReckoning: isOutage,
    };

    this.notifyEstimate(this.currentEstimate);
    return this.currentEstimate;
  }

  public getCurrentEstimate(): PositionEstimate {
    return this.currentEstimate;
  }

  public getStatus(): PositioningStatus {
    return this.status;
  }

  public addEstimateListener(listener: PositionEstimateListener): () => void {
    this.estimateListeners.add(listener);
    return () => this.estimateListeners.delete(listener);
  }

  public addStatusListener(listener: PositioningStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public reset(): void {
    this.status = "NO_POSITION";
    this.currentEstimate = this.createEmptyEstimate();
    this.origin = null;
    this.imuWindow = [];
    this.gnssMeasurementsDeliveredToEstimator = 0;
    this.lastGnssFixTimestampMs = 0;
    this.gnssFixCount = 0;
    this.gnssUpdateCount = 0;
    this.eskf.reset();
    this.motionEstimator.reset();
    if (this.routeConstraint) {
      this.routeConstraint.reset();
    }
    if (this.roadConstraint) {
      this.roadConstraint.reset();
    }
  }

  public getLastGnssFixTimestampMs(): number {
    return this.lastGnssFixTimestampMs;
  }

  public getGnssFixCount(): number {
    return this.gnssFixCount;
  }

  public getGnssUpdateCount(): number {
    return this.gnssUpdateCount;
  }

  public isGnssStale(nowMs: number = Date.now()): boolean {
    if (this.lastGnssFixTimestampMs === 0) return true;
    return nowMs - this.lastGnssFixTimestampMs > 3000;
  }

  // ==========================================
  // Extensions & Diagnostics
  // ==========================================

  public getEskf(): Eskf {
    return this.eskf;
  }

  public getEskfDiagnostics(): EskfDiagnostics {
    return this.eskf.getDiagnostics();
  }

  public getOrigin(): Wgs84Coordinate | null {
    return this.origin ? { ...this.origin } : null;
  }

  public setMotionEstimator(estimator: IMotionEstimator): void {
    this.motionEstimator = estimator;
  }

  public getMotionEstimator(): IMotionEstimator {
    return this.motionEstimator;
  }

  public setRouteConstraint(
    constraint: ProbabilisticRouteConstraint | null,
  ): void {
    this.routeConstraint = constraint;
  }

  public getRouteConstraint(): ProbabilisticRouteConstraint | null {
    return this.routeConstraint;
  }

  public setRoadConstraint(
    constraint: ProbabilisticRoadConstraint | null,
  ): void {
    this.roadConstraint = constraint;
  }

  public getRoadConstraint(): ProbabilisticRoadConstraint | null {
    return this.roadConstraint;
  }

  public setStaticRoutePoints(
    points: { latitude: number; longitude: number }[] | null,
  ): void {
    if (!points || points.length < 2) {
      if (this.routeConstraint) {
        this.routeConstraint.setRoute(null);
      }
      return;
    }

    const route: PreExistingRoute = {
      id: "static_route",
      name: "Pre-Existing Route",
      polylinePoints: points.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
      totalDistanceMeters: 0,
      estimatedDurationSeconds: 0,
      sourceProvider: "static_pre_trip",
      creationTimestampMs: Date.now(),
    };

    if (!this.routeConstraint) {
      this.routeConstraint = new ProbabilisticRouteConstraint();
    }
    this.routeConstraint.setRoute(route, this.origin ?? undefined);
  }

  /**
   * Compatibility adapter for legacy RouteConstraintProvider interface.
   */
  public setRouteConstraintProvider(
    provider: any,
    routePoints?: { latitude: number; longitude: number }[] | null,
  ): void {
    if (provider && provider.getEnabled) {
      if (!this.routeConstraint) {
        this.routeConstraint = new ProbabilisticRouteConstraint();
      }
      this.routeConstraint.setEnabled(provider.getEnabled());
    }
    if (routePoints !== undefined) {
      this.setStaticRoutePoints(routePoints);
    }
  }

  public getGnssDeliveredCount(): number {
    return this.gnssMeasurementsDeliveredToEstimator;
  }

  public resetGnssDeliveredCount(): void {
    this.gnssMeasurementsDeliveredToEstimator = 0;
  }

  public getRoadUpdateCount(): number {
    return this.roadConstraint?.getAppliedUpdateCount() ?? 0;
  }

  public getRouteUpdateCount(): number {
    return this.routeConstraint?.getAppliedUpdateCount() ?? 0;
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private notifyEstimate(estimate: PositionEstimate): void {
    for (const listener of this.estimateListeners) {
      try {
        listener(estimate);
      } catch (err) {
        console.error(
          "[EskfPositioningEngine] Error in estimateListener:",
          err,
        );
      }
    }
  }

  private notifyStatus(status: PositioningStatus): void {
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        console.error("[EskfPositioningEngine] Error in statusListener:", err);
      }
    }
  }

  private createEmptyEstimate(): PositionEstimate {
    return {
      timestamp_ns: 0,
      timestamp_ms: 0,
      latitude: 0,
      longitude: 0,
      altitude: null,
      speed: null,
      heading: null,
      horizontal_accuracy: null,
      vertical_accuracy: null,
      position_source: "NONE",
      confidence: 0,
      valid: false,
      isDeadReckoning: false,
    };
  }
}
