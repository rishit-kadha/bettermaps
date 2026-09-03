/**
 * Normalized Cross-Platform IMU Sensor Types & ImuProvider Interface.
 *
 * ARCHITECTURAL PRINCIPLE:
 * The React Native layer and IDR Core receive this normalized representation
 * regardless of whether data comes from Android SensorManager, iOS CoreMotion,
 * an external CAN bus IMU, or the IO-VNBD benchmark dataset.
 */

import { ProviderStatus } from "./location";

/**
 * 3-axis vector representation for inertial measurements.
 * Follows standard SI units:
 * - Accel: m/s^2
 * - Gyro: rad/s (or deg/s, normalized)
 * - Magnetometer: microteslas (uT)
 */
export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Cross-platform normalized IMU sample.
 */
export interface ImuSample {
  /** Timestamp of sample in milliseconds (epoch or monotonic) */
  timestamp: number;
  /** Linear acceleration (m/s^2) */
  accel: Vector3D;
  /** Angular velocity / rotation rate (rad/s) */
  gyro: Vector3D;
  /** Geomagnetic field strength (microteslas, uT) */
  magnetometer?: Vector3D;
}

export type ImuListener = (sample: ImuSample) => void;

/**
 * Platform-independent ImuProvider interface.
 *
 * Implementations:
 * - AndroidAdapter: Wraps Android SensorManager (SENSOR_DELAY_FASTEST / SENSOR_DELAY_GAME)
 * - IosAdapter: Wraps iOS CoreMotion (CMMotionManager)
 * - ExternalImuAdapter: Connects to external high-rate CAN/BLE IMU
 * - DatasetAdapter: Replays IO-VNBD benchmark dataset for offline evaluation
 */
export interface IImuProvider {
  readonly name: string;

  /** Start high-frequency sensor streaming (e.g. 50 Hz, 100 Hz, 200 Hz) */
  start(sampleRateHz?: number): Promise<void>;

  /** Stop sensor listening and release hardware listeners */
  stop(): Promise<void>;

  /** Operational status of IMU hardware */
  getStatus(): ProviderStatus;

  /** Subscribe to high-rate normalized IMU stream */
  addListener(listener: ImuListener): () => void;
}
