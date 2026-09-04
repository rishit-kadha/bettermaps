/**
 * sensors.ts
 *
 * Research-grade TypeScript definitions for Android/Cross-Platform
 * sensor acquisition, high-frequency recording, and data-integrity tracking.
 */

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface RawSensorReading {
  /** Authoritative hardware monotonic timestamp in nanoseconds (elapsedRealtimeNanos) */
  timestampNs: number;
  /** Monotonic Unix epoch millisecond equivalent */
  timestampMs: number;
  x: number;
  y: number;
  z: number;
}

export interface DerivedOrientationReading {
  timestampNs: number;
  timestampMs: number;
  rollRad: number;
  pitchRad: number;
  yawRad: number;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

export interface SensorHardwareInfo {
  available: boolean;
  name?: string;
  vendor?: string;
  version?: number;
  type?: number;
  resolution?: number;
  maxRange?: number;
  minDelayUs?: number;
}

export interface HardwareInventory {
  accelerometer: SensorHardwareInfo;
  gyroscope: SensorHardwareInfo;
  magnetometer: SensorHardwareInfo;
  rotationVector: SensorHardwareInfo;
}

export interface LiveSensorStream {
  x: number;
  y: number;
  z: number;
  hz: number;
  timestampNs: number;
}

export interface LiveOrientationStream {
  rollRad: number;
  pitchRad: number;
  yawRad: number;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
  hz: number;
  timestampNs: number;
}

export interface RecordingTelemetry {
  isRecording: boolean;
  sessionId: string;
  elapsedSeconds: number;
  accelSamples: number;
  gyroSamples: number;
  magSamples: number;
  orientSamples: number;
  gnssSamples: number;
  positionEstimateSamples?: number;
  eventsCount?: number;
  droppedSamples: number;
}

export interface SensorTelemetry {
  accelerometer: LiveSensorStream;
  gyroscope: LiveSensorStream;
  magnetometer: LiveSensorStream;
  orientation: LiveOrientationStream;
  recording: RecordingTelemetry;
}

export interface SessionSummary {
  sessionId: string;
  sessionPath: string;
  durationSeconds: number;
  accelSamples: number;
  gyroSamples: number;
  magSamples: number;
  orientSamples: number;
  gnssSamples: number;
  positionEstimateSamples?: number;
  eventsCount?: number;
  droppedSamples: number;
}

export interface SessionListItem {
  sessionId: string;
  path: string;
  lastModified: number;
  sizeBytes: number;
  durationSeconds?: number;
  accelSamples?: number;
}
