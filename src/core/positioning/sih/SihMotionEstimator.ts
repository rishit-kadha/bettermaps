/**
 * SihMotionEstimator.ts
 *
 * IMotionEstimator implementation for the friend's SIH Dead Reckoning pipeline.
 * Wraps SihGruEvaluator (50-sample 2-layer GRU velocity predictor) and extracts
 * aligned yaw rate from vehicle-frame gyroscope signals.
 */

import { ImuSample } from "../../types/imu";
import {
  IMotionEstimator,
  ModelBackendType,
  MotionEstimate,
  MotionEstimatorDiagnostics,
} from "../motionEstimator";
import { sihGruEvaluator } from "../../../adapters/ml/SihGruEvaluator";

export interface SihMotionEstimatorConfig {
  yawChannel?: "pitch" | "yaw" | "roll";
  yawSign?: number;
  forwardAccelChannel?: "x" | "y" | "z";
  forwardAccelSign?: number;
  customEvaluator?: (inputWindow: number[][]) => Promise<{ forwardVelocity: number } | undefined>;
}

export class SihMotionEstimator implements IMotionEstimator {
  public readonly name = "SIH Dead Reckoning (Friend's 50-step GRU)";
  public readonly backendType: ModelBackendType = "sih_gru";

  private config: Required<Omit<SihMotionEstimatorConfig, "customEvaluator">> & {
    customEvaluator?: SihMotionEstimatorConfig["customEvaluator"];
  };

  private primedVelocity = 0.0;
  private currentVelocity = 0.0;
  private lastTimestamp: number | null = null;
  private lastInferenceDurationMs = 0.0;
  private totalPredictions = 0;
  private droppedPredictions = 0;
  private lastEstimate: MotionEstimate | null = null;
  private windowSize = 0;
  private _cachedVelocity: number | null = null;

  constructor(config?: SihMotionEstimatorConfig) {
    this.config = {
      yawChannel: config?.yawChannel ?? "pitch",
      yawSign: config?.yawSign ?? 1.0,
      forwardAccelChannel: config?.forwardAccelChannel ?? "y",
      forwardAccelSign: config?.forwardAccelSign ?? 1.0,
      customEvaluator: config?.customEvaluator,
    };

    // Ensure evaluator is initialized
    sihGruEvaluator.initialize().catch((err) => {
      console.warn("[SihMotionEstimator] Evaluator async init warning:", err);
    });
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
    this._cachedVelocity = null;
    this.totalPredictions = 0;
    this.droppedPredictions = 0;
    sihGruEvaluator.reset();
  }

  public estimate(window: ImuSample[]): MotionEstimate {
    const tStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.windowSize = window.length;

    if (window.length === 0) {
      this.droppedPredictions++;
      const est: MotionEstimate = {
        forwardVelocity: 0,
        yawRate: 0,
        velocityVariance: 2.0 * 2.0,
        yawRateVariance: 0.15 * 0.15,
        timestamp: Date.now(),
      };
      this.lastEstimate = est;
      return est;
    }

    const latest = window[window.length - 1];
    const timestamp = latest.timestamp;

    let dt = 0.1;
    if (this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
      dt = Math.min(0.5, (timestamp - this.lastTimestamp) / 1000.0);
    }
    this.lastTimestamp = timestamp;

    // Preprocessing: Map phone sensors into vehicle frame
    // Channels: [linear_accel_x, linear_accel_y, linear_accel_z, angular_vel_x, angular_vel_y, angular_vel_z]
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

    // Push 6 clean IMU features to SIH Evaluator
    const sample6 = [
      forwardAccel,
      lateralAccel,
      verticalAccel,
      rollRate,
      pitchRate,
      yawRate,
    ];
    sihGruEvaluator.pushSample(sample6);

    // Evaluate velocity
    let predictedSpeed: number | null = null;

    if (this.config.customEvaluator) {
      // Async evaluator branch
      this.config.customEvaluator([sample6]).then((res) => {
        if (res && isFinite(res.forwardVelocity)) {
          this._cachedVelocity = Math.max(0, res.forwardVelocity);
        }
      }).catch(() => {});

      if (this._cachedVelocity !== null) {
        predictedSpeed = this._cachedVelocity;
      }
    } else {
      // Synchronous embedded neural evaluation or latest resolved ONNX prediction
      const neuralResult = sihGruEvaluator.evaluateNeural();
      if (neuralResult && isFinite(neuralResult.forwardVelocity)) {
        predictedSpeed = neuralResult.forwardVelocity;
      }

      // Also trigger async ONNX evaluation in background
      sihGruEvaluator.evaluateAsync().then((res) => {
        if (res && isFinite(res.forwardVelocity)) {
          this._cachedVelocity = res.forwardVelocity;
        }
      }).catch(() => {});
    }

    if (predictedSpeed !== null && sihGruEvaluator.windowFill >= 50) {
      this.currentVelocity = predictedSpeed;
      this.totalPredictions++;
    } else {
      // Kinematic coasting / warm-up fallback
      this.currentVelocity = Math.max(0, this.currentVelocity + forwardAccel * dt * 0.85);
      // Gentle damping
      this.currentVelocity *= (1.0 - 0.015 * dt);
      this.droppedPredictions++;
    }

    const tEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.lastInferenceDurationMs = tEnd - tStart;

    const est: MotionEstimate = {
      forwardVelocity: this.currentVelocity,
      yawRate: yawRate,
      velocityVariance: 1.8 * 1.8,
      yawRateVariance: 0.12 * 0.12,
      timestamp: timestamp,
    };
    this.lastEstimate = est;
    return est;
  }

  public getDiagnostics(): MotionEstimatorDiagnostics {
    const evalDiag = sihGruEvaluator.getDiagnostics();
    return {
      backendName: this.name,
      backendType: this.backendType,
      modelVersion: "gru_clean_velocity.pt (SIH 2-layer GRU)",
      lastInferenceDurationMs: this.lastInferenceDurationMs,
      windowLength: evalDiag.windowFill,
      targetWindowLength: 50,
      predictedVelocityMps: this.currentVelocity,
      predictedYawRateRadps: this.lastEstimate?.yawRate ?? 0,
      velocityVariance: 1.8 * 1.8,
      yawRateVariance: 0.12 * 0.12,
      confidence: evalDiag.inferenceReady ? 0.90 : 0.40,
      valid: evalDiag.inferenceReady,
      totalPredictions: this.totalPredictions,
      droppedPredictions: this.droppedPredictions,
    };
  }
}
