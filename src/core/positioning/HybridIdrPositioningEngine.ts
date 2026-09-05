/**
 * HybridIdrPositioningEngine
 *
 * Hybrid Positioning Engine implementing the IPositioningEngine contract.
 *
 * ARCHITECTURAL PRINCIPLE & RESEARCH INTEGRITY:
 * 1. Supports both GNSS anchoring and continuous dead-reckoning from IMU inputs.
 * 2. Ingests IMU samples into a causal sliding window and queries IMotionEstimator.
 * 3. Dead-reckoning integration operates strictly in local metric East-North-Up (ENU) coordinates.
 * 4. Incorporates an atomic diagnostic counter: gnssMeasurementsDeliveredToEstimator.
 *    In MODE_B_OUTAGE, this counter MUST remain strictly 0.
 * 5. Can be seamlessly hooked to RouteConstraintProvider for soft road preference.
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
import {
  IMotionEstimator,
  KinematicBaselineEstimator,
} from "./motionEstimator";
import { RouteConstraintProvider } from "./RouteConstraintProvider";

export class HybridIdrPositioningEngine implements IPositioningEngine {
  private status: PositioningStatus = "NO_POSITION";
  private currentEstimate: PositionEstimate = this.createEmptyEstimate();

  // Local metric coordinate frame state
  private origin: Wgs84Coordinate | null = null;
  private currentEastMeters = 0.0;
  private currentNorthMeters = 0.0;
  private currentHeadingDeg = 0.0;
  private lastImuTimestamp: number | null = null;

  // IMU sliding window (e.g. 2.0 seconds = 20 samples at 10 Hz)
  private imuWindow: ImuSample[] = [];
  private readonly maxWindowSamples = 30;

  // Motion Estimator (defaults to classical kinematic baseline)
  private motionEstimator: IMotionEstimator;

  // Optional Route Constraint Provider
  private routeConstraintProvider: RouteConstraintProvider | null = null;
  private staticRoutePoints: { latitude: number; longitude: number }[] | null =
    null;

  // DIAGNOSTIC LEAKAGE COUNTER: Verified strictly during testing
  private gnssMeasurementsDeliveredToEstimator = 0;

  // Event Listeners
  private estimateListeners = new Set<PositionEstimateListener>();
  private statusListeners = new Set<PositioningStatusListener>();

  constructor(
    motionEstimator: IMotionEstimator = new KinematicBaselineEstimator(),
    routeConstraintProvider: RouteConstraintProvider | null = null,
  ) {
    this.motionEstimator = motionEstimator;
    this.routeConstraintProvider = routeConstraintProvider;
  }

  public setMotionEstimator(estimator: IMotionEstimator): void {
    this.motionEstimator = estimator;
  }

  public getMotionEstimator(): IMotionEstimator {
    return this.motionEstimator;
  }

  public setRouteConstraintProvider(
    provider: RouteConstraintProvider | null,
    routePoints?: { latitude: number; longitude: number }[] | null,
  ): void {
    this.routeConstraintProvider = provider;
    if (routePoints !== undefined) {
      this.staticRoutePoints = routePoints;
    }
  }

  public setStaticRoutePoints(
    points: { latitude: number; longitude: number }[] | null,
  ): void {
    this.staticRoutePoints = points;
  }

  /**
   * Diagnostic counter reporting the exact number of GNSS fixes
   * delivered to this estimator. Must be exactly 0 during outages.
   */
  public getGnssDeliveredCount(): number {
    return this.gnssMeasurementsDeliveredToEstimator;
  }

  public resetGnssDeliveredCount(): void {
    this.gnssMeasurementsDeliveredToEstimator = 0;
  }

  /**
   * Ingest incoming reference GNSS location fix.
   * Called ONLY when GNSS stream gate is ENABLED.
   */
  public processGnss(sample: NavLocation): PositionEstimate {
    this.gnssMeasurementsDeliveredToEstimator++;
    this.status = "GNSS_AVAILABLE";

    const accuracy = sample.accuracy ?? 5.0;
    const confidence = Math.max(
      0.1,
      Math.min(1.0, 5.0 / Math.max(1.0, accuracy)),
    );

    // Anchor local ENU origin on first fix or re-anchor upon recovery
    if (!this.origin) {
      this.origin = {
        latitude: sample.latitude,
        longitude: sample.longitude,
        altitude: sample.altitude,
      };
      this.currentEastMeters = 0.0;
      this.currentNorthMeters = 0.0;
    } else {
      // Synchronize local metric frame with GNSS
      const enu = wgs84ToEnu(sample, this.origin);
      this.currentEastMeters = enu.east;
      this.currentNorthMeters = enu.north;
    }

    if (sample.heading !== null && sample.heading !== undefined) {
      this.currentHeadingDeg = sample.heading;
    }

    // Prime the motion estimator with current ground speed
    const speedMs = sample.speed ?? 0;
    if (this.motionEstimator.primeState) {
      this.motionEstimator.primeState(
        speedMs,
        (this.currentHeadingDeg * Math.PI) / 180.0,
      );
    }

    this.currentEstimate = {
      timestamp_ns: sample.timestamp * 1_000_000,
      timestamp_ms: sample.timestamp,
      latitude: sample.latitude,
      longitude: sample.longitude,
      altitude: sample.altitude ?? null,
      speed: sample.speed ?? null,
      heading: this.currentHeadingDeg,
      horizontal_accuracy: sample.accuracy ?? null,
      vertical_accuracy:
        sample.verticalAccuracy ?? sample.altitudeAccuracy ?? null,
      position_source: sample.providerType === "mock" ? "MOCK" : "GNSS",
      confidence,
      valid: true,
      isDeadReckoning: false,
    };

    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
    return this.currentEstimate;
  }

  /**
   * Notified when the GNSS stream gate is DISABLED (simulating outage).
   * Seamlessly transitions the engine to dead-reckoning mode without resetting coordinates.
   */
  public onGnssBlocked(): PositionEstimate {
    this.status = "GNSS_BLOCKED_SIMULATED";

    // If we have a valid estimate, mark it as dead reckoning
    if (this.currentEstimate.valid) {
      this.currentEstimate = {
        ...this.currentEstimate,
        position_source: "IDR",
        isDeadReckoning: true,
        confidence: Math.max(0.2, this.currentEstimate.confidence * 0.9),
      };
    }

    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
    return this.currentEstimate;
  }

  /**
   * Ingest continuous high-rate IMU sample.
   * Feeds sliding window, calls motion estimator, and propagates metric dead reckoning.
   */
  public processImu(sample: ImuSample): PositionEstimate | null {
    // 1. Maintain sliding window
    this.imuWindow.push(sample);
    if (this.imuWindow.length > this.maxWindowSamples) {
      this.imuWindow.shift();
    }

    // If we have never received an origin fix, cannot dead-reckon yet
    if (!this.origin) {
      return null;
    }

    // 2. Query motion estimator
    const motion = this.motionEstimator.estimate(this.imuWindow);

    // 3. Physical dt calculation
    let dt = 0.1;
    if (
      this.lastImuTimestamp !== null &&
      sample.timestamp > this.lastImuTimestamp
    ) {
      dt = Math.min(0.5, (sample.timestamp - this.lastImuTimestamp) / 1000.0);
    }
    this.lastImuTimestamp = sample.timestamp;

    // 4. Update heading from estimated yaw rate
    // yawRate is in rad/s, positive counter-clockwise
    // Heading in navigation is clockwise from North in degrees
    const deltaHeadingDeg = (-(motion.yawRate * 180.0) / Math.PI) * dt;
    this.currentHeadingDeg =
      (this.currentHeadingDeg + deltaHeadingDeg + 360.0) % 360.0;

    // 5. Integrate position in metric ENU frame (meters)
    // theta is clockwise from North: East = v * sin(theta), North = v * cos(theta)
    const headingRad = (this.currentHeadingDeg * Math.PI) / 180.0;
    const distanceTraveledMeters = motion.forwardVelocity * dt;

    const deltaEast = distanceTraveledMeters * Math.sin(headingRad);
    const deltaNorth = distanceTraveledMeters * Math.cos(headingRad);

    this.currentEastMeters += deltaEast;
    this.currentNorthMeters += deltaNorth;

    // 6. Convert unconstrained ENU to WGS84
    const unconstrainedWgs = enuToWgs84(
      { east: this.currentEastMeters, north: this.currentNorthMeters },
      this.origin,
    );

    let finalLat = unconstrainedWgs.latitude;
    let finalLon = unconstrainedWgs.longitude;

    const unconstrainedEstimate: PositionEstimate = {
      timestamp_ns: sample.timestamp * 1_000_000,
      timestamp_ms: sample.timestamp,
      latitude: finalLat,
      longitude: finalLon,
      altitude: this.origin.altitude ?? null,
      speed: motion.forwardVelocity,
      heading: Math.round(this.currentHeadingDeg * 10) / 10,
      horizontal_accuracy: Math.sqrt(motion.velocityVariance) * 2.0,
      vertical_accuracy: null,
      position_source: this.status === "GNSS_AVAILABLE" ? "GNSS+INS" : "IDR",
      confidence: this.status === "GNSS_AVAILABLE" ? 0.9 : 0.6,
      valid: true,
      isDeadReckoning: this.status !== "GNSS_AVAILABLE",
    };

    // 7. Apply soft bounded route constraint if configured
    if (
      this.routeConstraintProvider &&
      this.staticRoutePoints &&
      this.staticRoutePoints.length >= 2
    ) {
      const constraintResult = this.routeConstraintProvider.applyConstraint(
        unconstrainedEstimate,
        this.staticRoutePoints,
        this.origin,
      );

      finalLat = constraintResult.constrainedEstimate.latitude;
      finalLon = constraintResult.constrainedEstimate.longitude;

      this.currentEstimate = constraintResult.constrainedEstimate;
    } else {
      this.currentEstimate = unconstrainedEstimate;
    }

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
    listener(this.currentEstimate);
    return () => {
      this.estimateListeners.delete(listener);
    };
  }

  public addStatusListener(listener: PositioningStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public reset(): void {
    this.status = "NO_POSITION";
    this.currentEstimate = this.createEmptyEstimate();
    this.origin = null;
    this.currentEastMeters = 0.0;
    this.currentNorthMeters = 0.0;
    this.currentHeadingDeg = 0.0;
    this.lastImuTimestamp = null;
    this.imuWindow = [];
    this.gnssMeasurementsDeliveredToEstimator = 0;
    this.motionEstimator.reset();
    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
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
      confidence: 0.0,
      valid: false,
      isDeadReckoning: false,
    };
  }

  private notifyEstimate(estimate: PositionEstimate): void {
    this.estimateListeners.forEach((l) => {
      try {
        l(estimate);
      } catch (err) {
        console.error("Error in PositionEstimateListener:", err);
      }
    });
  }

  private notifyStatus(status: PositioningStatus): void {
    this.statusListeners.forEach((l) => {
      try {
        l(status);
      } catch (err) {
        console.error("Error in PositioningStatusListener:", err);
      }
    });
  }
}
