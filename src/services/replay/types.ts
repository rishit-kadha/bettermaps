/**
 * IO-VNBD Replay Types & State Definitions
 *
 * Defines the contracts for virtual clock replay, experiment modes (C0 to R3),
 * milestone checkpoints, and telemetry streams.
 */

export interface IovnbdSample {
  index: number;
  relative_time_ms: number;
  sensor_timestamp_ms: number;
  sensor_date_str: string;
  ref_timestamp_sec: number;
  accel: { x: number; y: number; z: number };
  gyro: { yaw: number; pitch: number; roll: number };
  gravity: { x: number; y: number; z: number };
  mag: { x: number; y: number; z: number };
  phone_gps: {
    latitude: number;
    longitude: number;
    altitude: number;
    speed_kmh: number;
    accuracy_m: number;
    heading_deg: number;
  };
  reference: {
    latitude: number;
    longitude: number;
    speed_kmh: number;
    heading_deg: number;
    yaw_rate_deg_s: number;
    steering_deg: number;
    indicated_speed_kmh: number;
  };
}

export interface IovnbdMetadata {
  dataset_name: string;
  session_id: string;
  driver: string;
  vehicle: string;
  phone_model: string;
  phone_mounting: string;
  source_files: string[];
  full_session_sample_count: number;
  full_session_duration_sec: number;
  full_session_distance_m: number;
  fixture_sample_count: number;
  fixture_duration_sec: number;
  fixture_distance_m: number;
  sensor_sample_rate_hz: number;
  reference_sample_rate_hz: number;
  alignment_lag_sec: number;
  alignment_lag_samples: number;
  origin: { latitude: number; longitude: number };
  last_reference: { latitude: number; longitude: number };
  extraction_timestamp_utc: string;
  fixture_version: string;
  /** Per-session IMU axis calibration from reference-correlated analysis */
  calibration?: {
    /** Which gyro channel maps to vehicle yaw rate */
    yaw_channel: 'pitch' | 'yaw' | 'roll';
    /** Sign multiplier: +1.0 or -1.0 (negative = anti-correlated with reference) */
    yaw_sign: number;
    /** Measured evidence used to determine calibration */
    evidence: {
      /** Pearson correlation coefficient between ref_yaw_deg_s and the chosen gyro channel */
      pearson_r: number;
      /** Fraction of moving samples where sign(ref_yaw) === sign(gyro_channel * yaw_sign) */
      sign_agreement: number;
      /** Mean ratio ref_yaw / gyro_channel over moving samples where |gyro| > 0.01 */
      mean_ratio: number;
      /** Number of samples used */
      n_samples: number;
      /** Analysis window (seconds) */
      window_sec: string;
      /** Minimum vehicle speed for sample inclusion (km/h) */
      min_speed_kmh: number;
    };
  } | null;
}

export interface IovnbdFixture {
  metadata: IovnbdMetadata;
  samples: IovnbdSample[];
}

export type ReplayClockState = "STOPPED" | "PLAYING" | "PAUSED";
export type ReplaySpeed = 0.25 | 0.5 | 1.0 | 2.0 | 5.0;

/**
 * Authoritative Experiment Mode Matrix:
 * - C0: Reference-only replay control test (evaluates timing/map with zero DR)
 * - R0: Pure Dead Reckoning (IMU only; GNSS blocked throughout)
 * - R1: Known Route Constraint (IMU + static route polyline; no future GPS leakage)
 * - R2: Reference Visualization (Active GNSS + IMU baseline tracking)
 * - R3: GNSS Drop & Recovery (Pre-outage GNSS -> Outage -> Recovery)
 */
export type ExperimentMode =
  | "C0_REFERENCE_ONLY"
  | "R0_PURE_DR"
  | "R1_ROUTE_CONSTRAINED"
  | "R2_FULL_GNSS"
  | "R3_DROP_RECOVERY"
  | "R0_IMU_ONLY"
  | "R1_IMU_ML_VEL"
  | "R2_IMU_ML_VEL_YAW"
  | "R3_IMU_ML_NHC"
  | "R4_IMU_ML_NHC_ROAD"
  | "R5_IMU_ML_NHC_ROUTE"
  | "R6_FULL_DROP_RECOVERY";

/**
 * Canonical Final Estimator Evaluation Modes:
 * - FINAL_IDR: Full production estimator (TCN + 15-state ESKF + NHC + Road Network + Route Prior)
 * - FINAL_IDR_ROAD_ABLATION: Identical production estimator with road network context ablated (Road OFF)
 */
export type EvaluationMode = "FINAL_IDR" | "FINAL_IDR_ROAD_ABLATION";

export interface MilestoneErrors {
  at5s: number | null;
  at10s: number | null;
  at20s: number | null;
  at30s: number | null;
  at60s: number | null;
}

export interface ReplayTelemetry {
  clockState: ReplayClockState;
  elapsedTimeMs: number;
  totalDurationMs: number;
  speed: ReplaySpeed;
  experimentMode: ExperimentMode;
  currentSampleIndex: number;
  totalSamples: number;

  // Reference Signal
  referenceCoordinate: {
    latitude: number;
    longitude: number;
    speedKmh: number;
    headingDeg: number;
  } | null;

  // Leakage Prevention Diagnostics
  gnssPermittedIntoEstimator: boolean;
  gnssDeliveredCount: number;

  // Dead Reckoning & Constraints
  isDeadReckoning: boolean;
  routeConstraintActive: boolean;

  instantaneousErrorMeters: number | null;
  cumulativeDistanceTraveledM: number;
  cumulativeDriftPercent: number | null;
  milestoneErrors: MilestoneErrors;
  milestoneDrifts: MilestoneErrors;

  // Session & Model Context
  sessionId: string;
  modelBackendName: string;
  outageDurationSec: number;
  outageStartSec: number;

  // Final Evaluation Mode & Diagnostics
  evaluationMode?: EvaluationMode;
  roadConstraintEnabled?: boolean;
  routeConstraintEnabled?: boolean;
  roadUpdateCount?: number;
  routeUpdateCount?: number;
  roadCoverageDiagnostics?: import("../../core/types/navigation").RoadCoverageTelemetry | null;
  roadMemoryDiagnostics?: import("../../core/types/navigation").RoadMemoryTelemetry | null;

  // Trail snapshots — included atomically so map polylines clear on reset/session-change
  // in the same React render cycle as the other telemetry fields.
  referenceTrail: { latitude: number; longitude: number }[];
  estimatedTrail: { latitude: number; longitude: number }[];
}

export type ReplayTelemetryListener = (telemetry: ReplayTelemetry) => void;
