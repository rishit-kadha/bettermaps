/**
 * EskfTypes.ts
 *
 * Formal type definitions for the 15-State Quaternion Error-State Kalman Filter (ESKF).
 * Follows the frozen specification in docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md.
 */

/**
 * 3D vector in Euclidean space [x, y, z]
 */
export type Vector3 = [number, number, number];

/**
 * Unit quaternion [qw, qx, qy, qz] with scalar first (Hamilton convention).
 * Represents rotation from vehicle body frame (b) to navigation frame (n).
 */
export type Quaternion = [number, number, number, number];

/**
 * 16-element Nominal Navigation State.
 */
export interface NavigationState {
  /** Metric position in local East-North-Up (ENU) frame [East, North, Up] (meters) */
  positionEnu: Vector3;
  /** Metric velocity in local ENU frame [v_east, v_north, v_up] (m/s) */
  velocityEnu: Vector3;
  /** Body-to-navigation attitude quaternion [qw, qx, qy, qz] (scalar-first) */
  qNb: Quaternion;
  /** Accelerometer sensor bias in vehicle body frame [bx, by, bz] (m/s^2) */
  accelBias: Vector3;
  /** Gyroscope sensor bias in vehicle body frame [bx, by, bz] (rad/s) */
  gyroBias: Vector3;
}

/**
 * 15-element Error State Index Offsets:
 * - 0:3   = delta_p (position error in ENU, meters)
 * - 3:6   = delta_v (velocity error in ENU, m/s)
 * - 6:9   = delta_theta (attitude error in body frame, radians)
 * - 9:12  = delta_ba (accelerometer bias error in body frame, m/s^2)
 * - 12:15 = delta_bg (gyroscope bias error in body frame, rad/s)
 */
export const ESKF_DIM = 15;
export const NOISE_DIM = 12;

export const STATE_IDX = {
  POS: 0,
  VEL: 3,
  ATT: 6,
  ACCEL_BIAS: 9,
  GYRO_BIAS: 12,
} as const;

/**
 * Vehicle-Frame calibrated IMU measurement.
 */
export interface VehicleFrameImuMeasurement {
  /** Timestamp in seconds (monotonic) */
  timestampS: number;
  /** Acceleration in vehicle body frame [forward, left, up] (m/s^2) */
  accelMps2: Vector3;
  /** Angular velocity in vehicle body frame [pitch/roll/yaw depending on mount] (rad/s) */
  gyroRadps: Vector3;
}

/**
 * Runtime-neutral learned motion model prediction.
 */
export interface MotionPrediction {
  timestampS: number;
  forwardVelocityMps: number;
  yawRateRadps: number;
  velocityStdMps: number;
  yawRateStdRadps: number;
  confidence: number;
}

/**
 * Measurement update result diagnostics.
 */
export interface MeasurementUpdateResult {
  accepted: boolean;
  residual: number[];
  innovationCovariance: number[][];
  mahalanobisDistance?: number;
  rejectionReason?: string;
}

/**
 * Structured ESKF runtime diagnostic snapshot.
 */
export interface EskfDiagnostics {
  timestampS: number;
  positionEnu: Vector3;
  velocityEnu: Vector3;
  headingDeg: number;
  accelBias: Vector3;
  gyroBias: Vector3;
  covarianceTrace: number;
  posUncertaintyM: number;
  velUncertaintyMps: number;
  attUncertaintyDeg: number;
  gnssUpdateCount: number;
  motionUpdateCount: number;
  nhcUpdateCount: number;
  roadUpdateCount: number;
  routeUpdateCount: number;
  rejectedUpdatesCount: number;
}
