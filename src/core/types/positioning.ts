/**
 * Platform-independent Positioning Types & PositioningEngine Contract.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Strictly separates:
 * 1. Sensor Measurements: NavLocation (Reference GNSS), ImuSample
 * 2. Positioning Output: PositionEstimate (produced by PositioningEngine)
 * 3. Navigation Output: NavigationState / NavigationTelemetry (consumed by UI/Map)
 *
 * This allows swapping GnssPositioningEngine with future HybridIdrPositioningEngine
 * without touching the route progress engine or Google Maps UI layer.
 */

import { NavLocation } from "./location";

/**
 * Normalized identification of the positioning source producing an estimate.
 * - 'GNSS': Direct satellite navigation / Fused Location fix
 * - 'GNSS+INS': Tightly/loosely coupled GNSS + IMU sensor fusion
 * - 'IDR': Pure Intelligent Dead Reckoning during GNSS denial
 * - 'MOCK': Simulated trajectory for local emulator/offline testing
 * - 'NONE': No valid position available (e.g. during simulated GNSS outage prior to IDR)
 */
export type PositionSource = "GNSS" | "GNSS+INS" | "IDR" | "MOCK" | "NONE";

/**
 * Software gate controlling whether incoming GNSS measurements are fed to PositioningEngine.
 */
export type GnssStreamGateState =
  | "GNSS_STREAM_ENABLED"
  | "GNSS_STREAM_DISABLED";

/**
 * High-level lifecycle state of the PositioningEngine.
 */
export type PositioningStatus =
  | "GNSS_AVAILABLE"
  | "GNSS_BLOCKED_SIMULATED"
  | "NO_POSITION";

/**
 * Normalized position estimate emitted by IPositioningEngine.
 *
 * Every estimate contains an authoritative monotonic nanosecond timestamp (timestamp_ns)
 * identical to the Linux kernel clock used for raw IMU events and GNSS fixes.
 */
export interface PositionEstimate {
  /** Authoritative monotonic timestamp in nanoseconds (elapsedRealtimeNanos) */
  timestamp_ns: number;
  /** Wall-clock epoch milliseconds */
  timestamp_ms: number;
  /** Latitude in decimal degrees (WGS84) */
  latitude: number;
  /** Longitude in decimal degrees (WGS84) */
  longitude: number;
  /** Altitude in meters above WGS84 ellipsoid */
  altitude?: number | null;
  /** Instantaneous speed over ground in meters per second */
  speed?: number | null;
  /** Course/bearing in degrees (0 - 359.9, 0 = True North, clockwise) */
  heading?: number | null;
  /** Estimated horizontal 1-sigma accuracy radius in meters */
  horizontal_accuracy?: number | null;
  /** Estimated vertical accuracy in meters */
  vertical_accuracy?: number | null;
  /** Originating positioning technology */
  position_source: PositionSource;
  /** Estimate confidence score (0.0 to 1.0) */
  confidence: number;
  /**
   * Explicit validity flag.
   * - true: Valid coordinate fix usable for navigation and route tracking.
   * - false: Outage or denied state where no valid position could be calculated.
   */
  valid: boolean;
  /** Flag indicating whether this estimate is dead-reckoned without active GNSS */
  isDeadReckoning: boolean;
}

export type PositionEstimateListener = (estimate: PositionEstimate) => void;
export type PositioningStatusListener = (status: PositioningStatus) => void;

/**
 * Platform-independent PositioningEngine contract.
 *
 * Implementations:
 * - GnssPositioningEngine (Phase 3A: GNSS-driven with software stream gating)
 * - HybridIdrPositioningEngine (Phase 3B: GNSS + IMU + ML Velocity + ESKF)
 */
export interface IPositioningEngine {
  /**
   * Ingest an incoming reference GNSS location fix.
   * Only called when GNSS stream gate is ENABLED.
   */
  processGnss(sample: NavLocation): PositionEstimate;

  /**
   * Optional ingestion of high-rate IMU sample for inertial dead-reckoning engines.
   */
  processImu?(sample: import("./imu").ImuSample): PositionEstimate | null;

  onGnssBlocked(): PositionEstimate;

  /** Returns the most recent position estimate */
  getCurrentEstimate(): PositionEstimate;

  /** Returns current positioning lifecycle status */
  getStatus(): PositioningStatus;

  /** Subscribe to new position estimates */
  addEstimateListener(listener: PositionEstimateListener): () => void;

  /** Subscribe to positioning status changes */
  addStatusListener(listener: PositioningStatusListener): () => void;

  /** Reset engine state */
  reset(): void;
}
