/**
 * GnssPositioningEngine
 *
 * Baseline GNSS implementation of IPositioningEngine.
 *
 * ARCHITECTURAL RULE:
 * This engine transforms raw/reference GNSS fixes into normalized PositionEstimates.
 * When the GNSS stream gate is DISABLED, it explicitly transitions to NO_POSITION
 * with valid = false and position_source = "NONE".
 *
 * Zero fake positions, zero dead-reckoning extrapolation, and zero stale coordinate reuse.
 * That responsibility is strictly reserved for the future HybridIdrPositioningEngine.
 */

import { NavLocation } from "../types/location";
import {
  IPositioningEngine,
  PositionEstimate,
  PositionEstimateListener,
  PositioningStatus,
  PositioningStatusListener,
} from "../types/positioning";

export class GnssPositioningEngine implements IPositioningEngine {
  private currentEstimate: PositionEstimate = this.createEmptyEstimate();
  private status: PositioningStatus = "NO_POSITION";

  private estimateListeners = new Set<PositionEstimateListener>();
  private statusListeners = new Set<PositioningStatusListener>();

  public processGnss(sample: NavLocation): PositionEstimate {
    this.status = "GNSS_AVAILABLE";

    const accuracy = sample.accuracy ?? 10.0;
    // Normalized confidence metric: 1.0 at <= 5m accuracy, decaying as error radius expands
    const confidence = Math.max(
      0.1,
      Math.min(1.0, 5.0 / Math.max(1.0, accuracy)),
    );

    this.currentEstimate = {
      timestamp_ns: sample.timestamp * 1_000_000,
      timestamp_ms: sample.timestamp,
      latitude: sample.latitude,
      longitude: sample.longitude,
      altitude: sample.altitude ?? null,
      speed: sample.speed ?? null,
      heading: sample.heading ?? null,
      horizontal_accuracy: sample.accuracy ?? null,
      vertical_accuracy:
        sample.verticalAccuracy ?? sample.altitudeAccuracy ?? null,
      position_source: sample.providerType === "mock" ? "MOCK" : "GNSS",
      confidence,
      valid: true,
      isDeadReckoning: false,
    };

    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
    return this.currentEstimate;
  }

  public onGnssBlocked(): PositionEstimate {
    this.status = "GNSS_BLOCKED_SIMULATED";

    this.currentEstimate = {
      timestamp_ns: Date.now() * 1_000_000,
      timestamp_ms: Date.now(),
      latitude: 0,
      longitude: 0,
      altitude: null,
      speed: null,
      heading: null,
      horizontal_accuracy: null,
      vertical_accuracy: null,
      position_source: "NONE",
      confidence: 0.0,
      valid: false,
      isDeadReckoning: false,
    };

    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
    return this.currentEstimate;
  }

  public getCurrentEstimate(): PositionEstimate {
    return this.currentEstimate;
  }

  public getStatus(): PositioningStatus {
    return this.status;
  }

  public addEstimateListener(listener: PositionEstimateListener): () => void {
    this.estimateListeners.add(listener);
    listener(this.currentEstimate);
    return () => {
      this.estimateListeners.delete(listener);
    };
  }

  public addStatusListener(listener: PositioningStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public reset(): void {
    this.status = "NO_POSITION";
    this.currentEstimate = this.createEmptyEstimate();
    this.notifyEstimate(this.currentEstimate);
    this.notifyStatus(this.status);
  }

  private createEmptyEstimate(): PositionEstimate {
    return {
      timestamp_ns: 0,
      timestamp_ms: 0,
      latitude: 0,
      longitude: 0,
      altitude: null,
      speed: null,
      heading: null,
      horizontal_accuracy: null,
      vertical_accuracy: null,
      position_source: "NONE",
      confidence: 0.0,
      valid: false,
      isDeadReckoning: false,
    };
  }

  private notifyEstimate(estimate: PositionEstimate): void {
    this.estimateListeners.forEach((listener) => {
      try {
        listener(estimate);
      } catch (err) {
        console.error("Error in PositionEstimateListener:", err);
      }
    });
  }

  private notifyStatus(status: PositioningStatus): void {
    this.statusListeners.forEach((listener) => {
      try {
        listener(status);
      } catch (err) {
        console.error("Error in PositioningStatusListener:", err);
      }
    });
  }
}

export const gnssPositioningEngine = new GnssPositioningEngine();
