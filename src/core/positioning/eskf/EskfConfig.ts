/**
 * EskfConfig.ts
 *
 * Configuration parameters for the 15-State Quaternion Mobile ESKF.
 * Matches frozen specification in docs/MOBILE_ESKF_MATHEMATICAL_SPEC.md.
 */

export interface EskfNoiseConfig {
  /** Continuous accelerometer process noise density (m/s^2) */
  accelNoiseDensity: number;
  /** Continuous gyroscope process noise density (rad/s) */
  gyroNoiseDensity: number;
  /** Continuous accelerometer bias random walk density (m/s^2 / sqrt(s)) */
  accelBiasRandomWalk: number;
  /** Continuous gyroscope bias random walk density (rad/s / sqrt(s)) */
  gyroBiasRandomWalk: number;
}

export interface EskfMeasurementConfig {
  /** Default GNSS position measurement standard deviation in meters */
  defaultGnssPositionStdM: number;
  /** Default GNSS velocity measurement standard deviation in m/s */
  defaultGnssVelocityStdMps: number;
  /** Minimum forward speed required to activate Non-Holonomic Constraints (m/s) */
  nhcSpeedThresholdMps: number;
  /** Soft Non-Holonomic lateral velocity standard deviation (m/s) */
  nhcLateralStdMps: number;
  /** Soft Non-Holonomic vertical velocity standard deviation (m/s) */
  nhcVerticalStdMps: number;
  /** Soft polyline constraint base standard deviation in meters */
  softPolylineBaseStdM: number;
  /** Soft polyline residual-based covariance inflation factor */
  softPolylineInflationFactor: number;
  /** Maximum cross-track distance before soft constraint gates off (meters) */
  maxPolylineCrossTrackM: number;
  /** Minimum heading alignment cosine required to apply route/road constraint */
  minHeadingAlignmentCosine: number;
}

export interface EskfTimingConfig {
  /** Maximum allowable IMU propagation step in seconds */
  maxPropagationDtS: number;
  /** Minimum allowable IMU propagation step in seconds */
  minPropagationDtS: number;
}

export interface EskfFullConfig {
  gravityMagnitude: number;
  noise: EskfNoiseConfig;
  measurements: EskfMeasurementConfig;
  timing: EskfTimingConfig;
}

export const DEFAULT_ESKF_CONFIG: EskfFullConfig = {
  gravityMagnitude: 9.80665,
  noise: {
    accelNoiseDensity: 0.35,
    gyroNoiseDensity: 0.03,
    accelBiasRandomWalk: 0.01,
    gyroBiasRandomWalk: 0.002,
  },
  measurements: {
    defaultGnssPositionStdM: 5.0,
    defaultGnssVelocityStdMps: 1.0,
    nhcSpeedThresholdMps: 1.5,
    nhcLateralStdMps: 0.35,
    nhcVerticalStdMps: 0.2,
    softPolylineBaseStdM: 8.0,
    softPolylineInflationFactor: 0.5,
    maxPolylineCrossTrackM: 35.0,
    minHeadingAlignmentCosine: 0.0,
  },
  timing: {
    maxPropagationDtS: 1.0,
    minPropagationDtS: 0.0001,
  },
};
