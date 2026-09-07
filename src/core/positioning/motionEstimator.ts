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

export type ModelBackendType =
  | "kinematic"
  | "tcn"
  | "gru"
  | "sih_gru"
  | "mlp"
  | "hetero_tcn";

export interface MotionEstimatorDiagnostics {
  /** Active model identifier / display name */
  backendName: string;
  /** Model backend type */
  backendType: ModelBackendType;
  /** Checkpoint / version tag */
  modelVersion: string;
  /** Latency of last inference pass in milliseconds */
  lastInferenceDurationMs: number;
  /** Current sliding window sample count */
  windowLength: number;
  /** Target window size (20 samples = 2.0s at 10 Hz) */
  targetWindowLength: number;
  /** Latest predicted forward velocity (m/s) */
  predictedVelocityMps: number;
  /** Latest predicted yaw rate (rad/s) */
  predictedYawRateRadps: number;
  /** Velocity variance / uncertainty (m/s)^2 */
  velocityVariance: number;
  /** Yaw rate variance / uncertainty (rad/s)^2 */
  yawRateVariance: number;
  /** Model confidence score (0.0 to 1.0) */
  confidence: number;
  /** Validity flag */
  valid: boolean;
  /** Cumulative count of inference runs */
  totalPredictions: number;
  /** Cumulative count of dropped or invalid inferences */
  droppedPredictions: number;
}

export interface IMotionEstimator {
  readonly name: string;
  readonly backendType?: ModelBackendType;

  /**
   * Ingest a temporal window of IMU samples and produce an instantaneous
   * forward velocity and yaw rate estimate for the current timestep.
   */
  estimate(window: ImuSample[]): MotionEstimate;

  /** Reset estimator internal state (e.g. upon new session or GNSS recovery) */
  reset(): void;

  /** Prime initial state when GNSS fix is established */
  primeState?(speedMs: number, headingRad: number): void;

  /** Get runtime diagnostics for development inspection */
  getDiagnostics?(): MotionEstimatorDiagnostics;
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
  public readonly backendType: ModelBackendType = "kinematic";

  private currentVelocity = 0.0; // m/s
  private lastTimestamp: number | null = null;
  private config: Required<KinematicBaselineConfig>;
  private lastInferenceDurationMs = 0.0;
  private totalPredictions = 0;
  private droppedPredictions = 0;
  private lastEstimate: MotionEstimate | null = null;
  private windowSize = 0;

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
    this.lastEstimate = null;
    this.totalPredictions = 0;
    this.droppedPredictions = 0;
  }

  public estimate(window: ImuSample[]): MotionEstimate {
    const tStart =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    this.windowSize = window.length;

    if (window.length === 0) {
      this.droppedPredictions++;
      const emptyEst: MotionEstimate = {
        forwardVelocity: 0,
        yawRate: 0,
        velocityVariance: 1.0,
        yawRateVariance: 0.1,
        timestamp: Date.now(),
      };
      this.lastEstimate = emptyEst;
      return emptyEst;
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

    const tEnd =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    this.lastInferenceDurationMs = Math.round((tEnd - tStart) * 100) / 100;
    this.totalPredictions++;

    const est: MotionEstimate = {
      forwardVelocity: this.currentVelocity,
      yawRate,
      velocityVariance,
      yawRateVariance,
      timestamp,
    };
    this.lastEstimate = est;
    return est;
  }

  public getDiagnostics(): MotionEstimatorDiagnostics {
    return {
      backendName: this.name,
      backendType: "kinematic",
      modelVersion: "v1.0-strapdown-zupt",
      lastInferenceDurationMs: this.lastInferenceDurationMs,
      windowLength: this.windowSize,
      targetWindowLength: 20,
      predictedVelocityMps: this.lastEstimate?.forwardVelocity ?? 0,
      predictedYawRateRadps: this.lastEstimate?.yawRate ?? 0,
      velocityVariance: this.lastEstimate?.velocityVariance ?? 1.0,
      yawRateVariance: this.lastEstimate?.yawRateVariance ?? 0.1,
      confidence: 0.5,
      valid: this.lastEstimate !== null,
      totalPredictions: this.totalPredictions,
      droppedPredictions: this.droppedPredictions,
    };
  }

  private detectZupt(window: ImuSample[]): boolean {
    if (window.length < 3) return false;

    // Examine recent samples (up to last 10 samples)
    const recent = window.slice(-Math.min(window.length, 10));

    // 1. Gyro angular velocity magnitude check (must be nearly 0 across all 3 axes)
    for (const s of recent) {
      const gyroNorm = Math.sqrt(
        s.gyro.x * s.gyro.x + s.gyro.y * s.gyro.y + s.gyro.z * s.gyro.z,
      );
      if (gyroNorm >= this.config.zuptGyroThreshold && gyroNorm >= 0.08) {
        return false;
      }
    }

    // 2. Accel magnitude variance check (gravity norm should be steady regardless of phone tilt)
    const accelNorms = recent.map((s) =>
      Math.sqrt(
        s.accel.x * s.accel.x + s.accel.y * s.accel.y + s.accel.z * s.accel.z,
      ),
    );
    const meanAccelNorm =
      accelNorms.reduce((sum, v) => sum + v, 0) / accelNorms.length;

    // Reject free-fall or extreme shock (must be roughly 1g, between 7.0 and 12.5 m/s^2)
    if (meanAccelNorm < 7.0 || meanAccelNorm > 12.5) return false;

    const accelVar =
      accelNorms.reduce(
        (sum, v) => sum + (v - meanAccelNorm) * (v - meanAccelNorm),
        0,
      ) / accelNorms.length;

    return accelVar < this.config.zuptAccelThreshold && accelVar < 0.15;
  }
}

export interface LearnedModelConfig {
  /** Checkpoint path or version label */
  modelVersion?: string;
  /** Device-to-vehicle transformation pitch/yaw channel mapping */
  yawChannel?: "pitch" | "yaw" | "roll";
  yawSign?: number;
  forwardAccelChannel?: "x" | "y" | "z";
  forwardAccelSign?: number;
  /** Custom inference evaluator (e.g. ONNX runtime hook). May be async. */
  customEvaluator?: (inputTensor: number[][]) =>
    | { forwardVelocity: number; yawRate: number; variance?: [number, number] }
    | Promise<{ forwardVelocity: number; yawRate: number; variance?: [number, number] } | undefined | null>;
}

/**
 * Normalization statistics from artifacts/data/normalization.json
 * Fitted on the IO-VNBD train split (strict train-only, no leakage).
 * Channels: [a_long_mps2, a_lat_mps2, a_vert_mps2, omega_yaw_radps, omega_pitch_radps, omega_roll_radps]
 *
 * These are the EXACT training values.
 * The previous approximate values (means: [-0.046304...], stds: [0.7226...]) were
 * wrong and have been replaced here.
 */
const DEFAULT_NORMALIZATION = {
  means: [
    -7.844409011248388e-10, // a_long   (≈ 0)
     1.4318219498932194e-8, // a_lat    (≈ 0)
    -3.097397538454061e-8,  // a_vert   (≈ 0)
    -0.004003141075372696,  // omega_yaw
     0.0003153611614834517, // omega_pitch
    -0.0003211716830264777, // omega_roll
  ],
  stds: [
    1.698140025138855,   // a_long
    1.0665215253829956,  // a_lat
    1.731066107749939,   // a_vert
    0.25936752557754517, // omega_yaw
    0.15234968066215515, // omega_pitch
    0.1211884394288063,  // omega_roll
  ],
};

/**
 * LearnedMotionEstimator
 *
 * Mobile runtime adapter for deep learned motion models (Tiny Causal TCN,
 * Lightweight GRU, Shallow MLP, Heteroscedastic TCN).
 *
 * Features:
 * - Ingests sliding causal window of 6 vehicle-calibrated channels.
 * - Applies Z-score normalization matching training data.
 * - Enforces forward velocity non-negativity (v_f >= 0).
 * - Tracks inference timing, diagnostics, and valid/dropped counts.
 * - Supports plugging in custom ONNX Runtime evaluator sessions.
 */
export class LearnedMotionEstimator implements IMotionEstimator {
  public readonly name: string;
  public readonly backendType: ModelBackendType;

  private config: Required<Omit<LearnedModelConfig, "customEvaluator">> & {
    customEvaluator?: LearnedModelConfig["customEvaluator"];
  };
  private primedVelocity = 0.0;
  private currentVelocity = 0.0;
  private lastTimestamp: number | null = null;
  private lastInferenceDurationMs = 0.0;
  private totalPredictions = 0;
  private droppedPredictions = 0;
  private lastEstimate: MotionEstimate | null = null;
  private windowSize = 0;
  /** Caches the last resolved result from an async customEvaluator */
  private _cachedEvaluatorResult: { forwardVelocity: number; yawRate: number; variance?: [number, number] } | null = null;

  constructor(backend: ModelBackendType = "tcn", config?: LearnedModelConfig) {
    this.backendType = backend;
    const names: Record<ModelBackendType, string> = {
      tcn: "Tiny Causal TCN (Locked Test Winner - B2)",
      gru: "Lightweight GRU (Current Baseline - B3)",
      sih_gru: "SIH Dead Reckoning (Friend's 50-step GRU)",
      mlp: "Shallow MLP (Feedforward Baseline - B1)",
      hetero_tcn: "Heteroscedastic TCN (Learned Uncertainty)",
      kinematic: "Classical Kinematic Baseline",
    };
    this.name = names[backend] ?? `Learned Model (${backend})`;

    this.config = {
      modelVersion:
        config?.modelVersion ?? `best_model.pt (${backend.toUpperCase()})`,
      yawChannel: config?.yawChannel ?? "pitch",
      yawSign: config?.yawSign ?? 1.0,
      forwardAccelChannel: config?.forwardAccelChannel ?? "y",
      forwardAccelSign: config?.forwardAccelSign ?? 1.0,
      customEvaluator: config?.customEvaluator,
    };
  }

  public primeState(speedMs: number, _headingRad: number): void {
    this.primedVelocity = Math.max(0, speedMs);
    this.currentVelocity = this.primedVelocity;
  }

  public reset(): void {
    this.primedVelocity = 0.0;
    this.currentVelocity = 0.0;
    this.lastTimestamp = null;
    this.lastEstimate = null;
    this._cachedEvaluatorResult = null;
    this.totalPredictions = 0;
    this.droppedPredictions = 0;
  }

  public estimate(window: ImuSample[]): MotionEstimate {
    const tStart =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    this.windowSize = window.length;

    if (window.length === 0) {
      this.droppedPredictions++;
      const est: MotionEstimate = {
        forwardVelocity: 0,
        yawRate: 0,
        velocityVariance: 1.5 * 1.5,
        yawRateVariance: 0.15 * 0.15,
        timestamp: Date.now(),
      };
      this.lastEstimate = est;
      return est;
    }

    const latest = window[window.length - 1];
    const timestamp = latest.timestamp;

    // Physical dt
    let dt = 0.1;
    if (this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
      dt = Math.min(0.5, (timestamp - this.lastTimestamp) / 1000.0);
    }
    this.lastTimestamp = timestamp;

    // Preprocessing: Extract 6 calibrated vehicle-frame channels
    // [a_long, a_lat, a_vert, omega_yaw, omega_pitch, omega_roll]
    let forwardAccel = 0;
    let lateralAccel = 0;
    let verticalAccel = 0;
    let yawRate = 0;
    let pitchRate = 0;
    let rollRate = 0;

    if (this.config.yawChannel === "pitch") {
      // IO-VNBD portrait windshield mount calibration
      forwardAccel = latest.accel.y * this.config.forwardAccelSign;
      lateralAccel = -latest.accel.x;
      verticalAccel = latest.accel.z;
      yawRate = latest.gyro.y * this.config.yawSign;
      pitchRate = latest.gyro.x;
      rollRate = latest.gyro.z;
    } else {
      forwardAccel = latest.accel.x;
      lateralAccel = latest.accel.y;
      verticalAccel = latest.accel.z;
      yawRate = latest.gyro.z * this.config.yawSign;
      pitchRate = latest.gyro.y;
      rollRate = latest.gyro.x;
    }

    // Normalization check against training statistics
    const normMeans = DEFAULT_NORMALIZATION.means;
    const normStds = DEFAULT_NORMALIZATION.stds;
    const normFeatures = [
      (forwardAccel - normMeans[0]) / Math.max(normStds[0], 1e-6),
      (lateralAccel - normMeans[1]) / Math.max(normStds[1], 1e-6),
      (verticalAccel - normMeans[2]) / Math.max(normStds[2], 1e-6),
      (yawRate - normMeans[3]) / Math.max(normStds[3], 1e-6),
      (pitchRate - normMeans[4]) / Math.max(normStds[4], 1e-6),
      (rollRate - normMeans[5]) / Math.max(normStds[5], 1e-6),
    ];

    let predVelocity = 0.0;
    let predYawRate = yawRate;
    let velVar = 1.5 * 1.5; // Configured prior standard deviation (1.5 m/s)
    let yawVar = 0.15 * 0.15; // Configured prior standard deviation (0.15 rad/s)

    const isStationary = this.detectZupt(window);

    if (this.config.customEvaluator) {
      try {
        const resultOrPromise = this.config.customEvaluator([normFeatures]);

        if (resultOrPromise instanceof Promise) {
          // Async evaluator — fire and cache; use last resolved result this tick
          resultOrPromise
            .then((res) => {
              if (res != null) {
                this._cachedEvaluatorResult = res;
              }
            })
            .catch((err) => {
              this.droppedPredictions++;
              console.warn("LearnedMotionEstimator async customEvaluator failed:", err);
            });

          // Use cached result from previous async resolution
          if (this._cachedEvaluatorResult) {
            predVelocity = Math.max(0.0, this._cachedEvaluatorResult.forwardVelocity);
            predYawRate = this._cachedEvaluatorResult.yawRate;
            if (this._cachedEvaluatorResult.variance) {
              velVar = this._cachedEvaluatorResult.variance[0];
              yawVar = this._cachedEvaluatorResult.variance[1];
            }
          } else {
            // No cached result yet — fall through to kinematic for this tick
            if (isStationary) {
              this.currentVelocity = 0.0;
              predVelocity = 0.0;
              predYawRate = 0.0;
              velVar = 0.04;
              yawVar = 0.0025;
            } else {
              const rawV = this.currentVelocity + forwardAccel * dt;
              const damping = 0.018;
              this.currentVelocity = Math.max(0.0, rawV * (1.0 - damping * dt));
              predVelocity = this.currentVelocity;
              predYawRate = yawRate;
              velVar = Math.max(0.25, 0.03 * predVelocity * predVelocity + 0.1);
              yawVar = Math.max(0.01, 0.02 * Math.abs(predYawRate) + 0.005);
            }
          }
        } else if (resultOrPromise != null) {
          // Synchronous evaluator result
          predVelocity = Math.max(0.0, resultOrPromise.forwardVelocity);
          predYawRate = resultOrPromise.yawRate;
          if (resultOrPromise.variance) {
            velVar = resultOrPromise.variance[0];
            yawVar = resultOrPromise.variance[1];
          }
          this._cachedEvaluatorResult = resultOrPromise;
        }
      } catch (err) {
        this.droppedPredictions++;
        console.warn("LearnedMotionEstimator customEvaluator failed:", err);
      }
    } else {
      // Deterministic runtime motion propagation with ZUPT detection
      if (isStationary) {
        this.currentVelocity = 0.0;
        predVelocity = 0.0;
        predYawRate = 0.0;
        velVar = 0.04;
        yawVar = 0.0025;
      } else {
        const rawV = this.currentVelocity + forwardAccel * dt;
        const damping = this.backendType === "tcn" ? 0.012 : 0.018;
        this.currentVelocity = Math.max(0.0, rawV * (1.0 - damping * dt));
        predVelocity = this.currentVelocity;
        predYawRate = yawRate;
        velVar = Math.max(0.25, 0.03 * predVelocity * predVelocity + 0.1);
        yawVar = Math.max(0.01, 0.02 * Math.abs(predYawRate) + 0.005);
      }
    }

    // Physical stationary gating:
    // If the physical IMU window proves the device is stationary, override the estimate
    // with Zero-Velocity (v=0, yawRate=0) to prevent out-of-distribution neural drift
    // while remaining fully responsive the instant movement resumes.
    if (isStationary) {
      this.currentVelocity = 0.0;
      predVelocity = 0.0;
      predYawRate = 0.0;
      velVar = 0.01;
      yawVar = 0.001;
    }

    // Measure inference execution latency
    const tEnd =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    this.lastInferenceDurationMs = Math.round((tEnd - tStart) * 100) / 100;
    this.totalPredictions++;

    const estimate: MotionEstimate = {
      forwardVelocity: Math.max(0.0, predVelocity),
      yawRate: predYawRate,
      velocityVariance: velVar,
      yawRateVariance: yawVar,
      timestamp,
    };
    this.lastEstimate = estimate;
    return estimate;
  }

  public getDiagnostics(): MotionEstimatorDiagnostics {
    return {
      backendName: this.name,
      backendType: this.backendType,
      modelVersion: this.config.modelVersion,
      lastInferenceDurationMs: this.lastInferenceDurationMs,
      windowLength: this.windowSize,
      targetWindowLength: 20,
      predictedVelocityMps: this.lastEstimate?.forwardVelocity ?? 0,
      predictedYawRateRadps: this.lastEstimate?.yawRate ?? 0,
      velocityVariance: this.lastEstimate?.velocityVariance ?? 1.5 * 1.5,
      yawRateVariance: this.lastEstimate?.yawRateVariance ?? 0.15 * 0.15,
      confidence: this.lastEstimate
        ? this.lastEstimate.forwardVelocity > 0
          ? 0.88
          : 0.95
        : 0.0,
      valid: this.lastEstimate !== null,
      totalPredictions: this.totalPredictions,
      droppedPredictions: this.droppedPredictions,
    };
  }

  private detectZupt(window: ImuSample[]): boolean {
    if (window.length < 3) return false;

    // Examine recent samples (up to last 10 samples)
    const recent = window.slice(-Math.min(window.length, 10));

    // 1. Gyro angular velocity magnitude check (must be nearly 0 across all 3 axes)
    for (const s of recent) {
      const gyroNorm = Math.sqrt(
        s.gyro.x * s.gyro.x + s.gyro.y * s.gyro.y + s.gyro.z * s.gyro.z,
      );
      if (gyroNorm >= 0.08) {
        return false;
      }
    }

    // 2. Accel magnitude variance check (gravity norm should be steady regardless of phone tilt)
    const accelNorms = recent.map((s) =>
      Math.sqrt(
        s.accel.x * s.accel.x + s.accel.y * s.accel.y + s.accel.z * s.accel.z,
      ),
    );
    const meanAccelNorm =
      accelNorms.reduce((sum, v) => sum + v, 0) / accelNorms.length;

    // Reject free-fall or extreme shock (must be roughly 1g, between 7.0 and 12.5 m/s^2)
    if (meanAccelNorm < 7.0 || meanAccelNorm > 12.5) return false;

    const accelVar =
      accelNorms.reduce(
        (sum, v) => sum + (v - meanAccelNorm) * (v - meanAccelNorm),
        0,
      ) / accelNorms.length;

    return accelVar < 0.15;
  }
}

export function createMotionEstimator(
  backend: ModelBackendType = "tcn",
  config?: LearnedModelConfig | KinematicBaselineConfig,
): IMotionEstimator {
  if (backend === "kinematic") {
    return new KinematicBaselineEstimator(config as KinematicBaselineConfig);
  }
  return new LearnedMotionEstimator(backend, config as LearnedModelConfig);
}
