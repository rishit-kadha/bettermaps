/**
 * GnssStreamGate
 *
 * Software gate placed strictly between the platform GNSS adapter and PositioningEngine.
 *
 * CRITICAL RESEARCH RULE:
 * This toggle simulates GNSS denial for the PositioningEngine without disabling
 * actual phone GPS hardware or stopping the background Reference GNSS recording.
 */

import { sensorRecorderManager } from "../../services/sensors/SensorRecorderManager";
import { GnssStreamGateState } from "../types/positioning";

export type GnssGateListener = (state: GnssStreamGateState) => void;

export class GnssStreamGate {
  private state: GnssStreamGateState = "GNSS_STREAM_ENABLED";
  private listeners = new Set<GnssGateListener>();

  public getState(): GnssStreamGateState {
    return this.state;
  }

  public isEnabled(): boolean {
    return this.state === "GNSS_STREAM_ENABLED";
  }

  public enable(): void {
    if (this.state === "GNSS_STREAM_ENABLED") return;
    this.setState("GNSS_STREAM_ENABLED");
  }

  public disable(): void {
    if (this.state === "GNSS_STREAM_DISABLED") return;
    this.setState("GNSS_STREAM_DISABLED");
  }

  public toggle(): GnssStreamGateState {
    const nextState =
      this.state === "GNSS_STREAM_ENABLED"
        ? "GNSS_STREAM_DISABLED"
        : "GNSS_STREAM_ENABLED";
    this.setState(nextState);
    return this.state;
  }

  public addListener(listener: GnssGateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(newState: GnssStreamGateState): void {
    this.state = newState;
    const value = newState === "GNSS_STREAM_ENABLED" ? "enabled" : "disabled";

    // Record authoritative simulation event with nanosecond timestamp in native recorder
    sensorRecorderManager.recordEvent("GNSS_STREAM", value).catch(() => {});

    // Notify registered components (PositioningEngine, NavigationManager, UI)
    this.listeners.forEach((listener) => {
      try {
        listener(this.state);
      } catch (err) {
        console.error("Error in GnssStreamGate listener:", err);
      }
    });
  }
}

export const gnssStreamGate = new GnssStreamGate();
