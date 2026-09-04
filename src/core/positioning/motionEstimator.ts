/**
 * MotionEstimator Interface & Classical Kinematic Baseline
 *
 * ARCHITECTURAL RULE (RESEARCH INTEGRITY):
 * 1. IMotionEstimator defines the contract for local vehicle-motion estimation.
 * 2. KinematicBaselineEstimator is a CLASSICAL BASELINE ONLY (Baseline 2).
 *    It integrates raw/preprocessed accelerometer and gyroscope signals.
 *    Accelerometer bias causes velocity drift; velocity drift causes quadratic position drift.
 *    This behavior is physically honest, mathematically expected, and establishes the reference
 *    benchmark against which future learned estimators will be compared.
 * 3. Future learned models (Tiny-TCN, GRU, MLP) will implement IMotionEstimator without
 *    altering PositioningEngine or the navigation dataflow.
 */

import { ImuSample } from "../types/imu";

export interface MotionEstimate {
  /** Predicted vehicle forward velocity along longitudinal axis (m/s) */
  forwardVelocity: number;
  /** Predicted vehicle yaw rate around vertical axis (rad/s, positive = counter-clockwise) */
  yawRate: number;
  /** Estimated variance / uncertainty of forward velocity (m/s)^2 */
  velocityVariance: number;
  /** Estimated variance / uncertainty of yaw rate (rad/s)^2 */
  yawRateVariance: number;
  /** Monotonic or epoch timestamp of the estimate (ms) */
  timestamp: number;
}

export interface IMotionEstimator {
  readonly name: string;

  /**
   * Ingest a temporal window of IMU samples and produce an instantaneous
   * forward velocity and yaw rate estimate for the current timestep.
   */
  estimate(window: ImuSample[]): MotionEstimate;

  /** Reset estimator internal state (e.g. upon new session or GNSS recovery) */
  reset(): void;

  /** Prime initial state when GNSS fix is established */
  primeState?(speedMs: number, headingRad: number): void;
}

export interface KinematicBaselineConfig {
  /** Damping factor preventing runaway positive integration (1/s) */
  dampingFactor?: number;
  /** Stationary ZUPT acceleration threshold (m/s^2) */
  zuptAccelThreshold?: number;
  /** Stationary ZUPT gyro threshold (rad/s) */
  zuptGyroThreshold?: number;
  /**
   * Channel mapping for yaw rate:
   * In IO-VNBD, portrait windshield mount (tilt ~85°) means phone Gyro Pitch
   * is aligned with vehicle yaw rate.
   * "pitch" | "yaw" | "roll"
   */
  yawChannel?: "pitch" | "yaw" | "roll";
  yawSign?: number;
}

/**
 * KinematicBaselineEstimator
 *
 * Classical dead-reckoning baseline integrating forward acceleration
 * and gyroscope yaw rate with Zero-Velocity Updates (ZUPT).
 *
 * KNOWN PHYSICAL LIMITATIONS:
 * - Uncorrected accelerometer bias b_a integrates into linear velocity error (v_err ~ b_a * t)
 * - Velocity error double-integrates into quadratic position drift (p_err ~ 0.5 * b_a * t^2)
 * - Road grade / vehicle pitch leaks gravity (9.81 * sin(theta)) into longitudinal acceleration
 */
export class KinematicBaselineEstimator implements IMotionEstimator {
  public readonly name = "Classical Kinematic Baseline (Strapdown INS + ZUPT)";

  private currentVelocity = 0.0; // m/s
  private lastTimestamp: number | null = null;
  private config: Required<KinematicBaselineConfig>;

  constructor(config?: KinematicBaselineConfig) {
    this.config = {
      dampingFactor: config?.dampingFactor ?? 0.015,
      zuptAccelThreshold: config?.zuptAccelThreshold ?? 0.25,
      zuptGyroThreshold: config?.zuptGyroThreshold ?? 0.05,
      yawChannel: config?.yawChannel ?? "pitch", // Default to IO-VNBD S1 portrait mount
      yawSign: config?.yawSign ?? 1.0,
    };
  }

  public primeState(speedMs: number, _headingRad: number): void {
    this.currentVelocity = Math.max(0, speedMs);
  }

  public reset(): void {
    this.currentVelocity = 0.0;
    this.lastTimestamp = null;
  }

  public estimate(window: ImuSample[]): MotionEstimate {
    if (window.length === 0) {
      return {
        forwardVelocity: 0,
        yawRate: 0,
        velocityVariance: 1.0,
        yawRateVariance: 0.1,
        timestamp: Date.now(),
      };
    }

    const latest = window[window.length - 1];
    const timestamp = latest.timestamp;

    // 1. Determine physical dt from sample timestamps (preserving original timing)
    let dt = 0.1; // Default 100ms
    if (this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
      dt = Math.min(0.5, (timestamp - this.lastTimestamp) / 1000.0);
    }
    this.lastTimestamp = timestamp;

    // 2. Extract yaw rate according to dataset-specific mounting calibration
    let rawYaw = 0;
    if (this.config.yawChannel === "pitch") {
      rawYaw = latest.gyro.y; // Pitch axis in Android coordinates
    } else if (this.config.yawChannel === "yaw") {
      rawYaw = latest.gyro.z; // Z axis in Android coordinates
    } else {
      rawYaw = latest.gyro.x;
    }
    const yawRate = rawYaw * this.config.yawSign;

    // 3. Extract dynamic forward acceleration (longitudinal force)
    // For IO-VNBD portrait mount, vehicle forward acceleration is along phone +Y
    const forwardAccel = latest.accel.y;

    // 4. Zero-Velocity Update (ZUPT) Detection over recent window
    const isStationary = this.detectZupt(window);

    if (isStationary) {
      // Vehicle stopped: force zero velocity and freeze integration
      this.currentVelocity = 0.0;
    } else {
      // Kinematic integration with gentle damping
      const rawV = this.currentVelocity + forwardAccel * dt;
      const dampedV = rawV * (1.0 - this.config.dampingFactor * dt);
      // Vehicle navigates forward on road
      this.currentVelocity = Math.max(0.0, dampedV);
    }

    // Heuristic baseline uncertainty: variance grows with elapsed time without GNSS
    const velocityVariance = Math.max(
      0.25,
      0.05 * this.currentVelocity * this.currentVelocity + 0.1,
    );
    const yawRateVariance = Math.max(0.01, 0.02 * Math.abs(yawRate) + 0.005);

    return {
      forwardVelocity: this.currentVelocity,
      yawRate,
      velocityVariance,
      yawRateVariance,
      timestamp,
    };
  }

  private detectZupt(window: ImuSample[]): boolean {
    if (window.length < 3) return false;

    // Examine recent samples (up to last 5 = 0.5s at 10 Hz)
    const recent = window.slice(-5);
    const accelMags = recent.map((s) => Math.abs(s.accel.y));
    const gyroMags = recent.map((s) => {
      const g = this.config.yawChannel === "pitch" ? s.gyro.y : s.gyro.z;
      return Math.abs(g);
    });

    const maxAccel = Math.max(...accelMags);
    const maxGyro = Math.max(...gyroMags);

    return (
      maxAccel < this.config.zuptAccelThreshold &&
      maxGyro < this.config.zuptGyroThreshold
    );
  }
}
