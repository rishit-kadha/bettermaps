/**
 * Normalized Measurement Source Abstractions
 *
 * ARCHITECTURAL PRINCIPLE:
 * Strictly decouples the sensor ingestion layer from PositioningEngine.
 * PositioningEngine consumes normalized SensorMeasurements without knowing
 * whether they originate from:
 * - REAL_PHONE_SOURCE: Physical Android SensorManager + FusedLocationProvider
 * - DATASET_REPLAY_SOURCE: IO-VNBD recorded benchmark dataset
 * - Future external hardware IMU / CAN bus
 */

import { ImuSample } from "./imu";
import { NavLocation, ProviderStatus } from "./location";

export type MeasurementSourceType =
  | "REAL_PHONE_SOURCE"
  | "DATASET_REPLAY_SOURCE";

export interface GnssMeasurement {
  type: "GNSS";
  location: NavLocation;
}

export interface ImuMeasurement {
  type: "IMU";
  sample: ImuSample;
}

export type SensorMeasurement = GnssMeasurement | ImuMeasurement;

export type MeasurementListener = (measurement: SensorMeasurement) => void;

export interface IMeasurementSource {
  readonly id: string;
  readonly name: string;
  readonly sourceType: MeasurementSourceType;

  /** Initialize and start data streaming */
  start(): Promise<void>;

  /** Stop data streaming */
  stop(): Promise<void>;

  /** Operational status of the source */
  getStatus(): ProviderStatus;

  /** Subscribe to unified sensor measurement stream */
  addListener(listener: MeasurementListener): () => void;
}
