/**
 * SensorRecorderManager.ts
 *
 * Singleton service coordinating native Android sensor acquisition,
 * high-rate decoupled recording, and UI telemetry broadcasting.
 */

let BetterMapsSensorModule: any = null;
let NativeEventEmitterClass: any = null;
let isAndroidPlatform = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require("react-native");
  if (rn) {
    BetterMapsSensorModule = rn.NativeModules?.BetterMapsSensorModule ?? null;
    NativeEventEmitterClass = rn.NativeEventEmitter;
    isAndroidPlatform = rn.Platform?.OS === "android";
  }
} catch (_err) {
  // Plain Node or non-React-Native environment
}

import {
  HardwareInventory,
  SensorTelemetry,
  SessionListItem,
  SessionSummary,
} from "../../core/types/sensors";
import { NavLocation } from "../../core/types/location";
import { PositionEstimate } from "../../core/types/positioning";

export type SensorTelemetryListener = (telemetry: SensorTelemetry) => void;

class SensorRecorderManager {
  private static instance: SensorRecorderManager;

  private eventEmitter: any = null;
  private telemetryListeners = new Set<SensorTelemetryListener>();
  private latestTelemetry: SensorTelemetry | null = null;
  private isMonitoring = false;

  private constructor() {
    if (isAndroidPlatform && BetterMapsSensorModule && NativeEventEmitterClass) {
      this.eventEmitter = new NativeEventEmitterClass(BetterMapsSensorModule);
      this.eventEmitter.addListener(
        "onSensorTelemetry",
        (telemetry: SensorTelemetry) => {
          this.latestTelemetry = telemetry;
          this.telemetryListeners.forEach((listener) => {
            try {
              listener(telemetry);
            } catch (err) {
              console.error("[SensorRecorderManager] Listener error:", err);
            }
          });
        },
      );
    }
  }

  public static getInstance(): SensorRecorderManager {
    if (!SensorRecorderManager.instance) {
      SensorRecorderManager.instance = new SensorRecorderManager();
    }
    return SensorRecorderManager.instance;
  }

  public isAvailable(): boolean {
    return isAndroidPlatform && !!BetterMapsSensorModule;
  }

  public async getSensorHardwareInfo(): Promise<HardwareInventory | null> {
    if (!this.isAvailable()) return null;
    try {
      return await BetterMapsSensorModule.getSensorHardwareInfo();
    } catch (e) {
      console.error("[SensorRecorderManager] Failed to get hardware info:", e);
      return null;
    }
  }

  public async startMonitoring(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    if (this.isMonitoring) return true;

    try {
      const res = await BetterMapsSensorModule.startSensorMonitoring();
      this.isMonitoring = true;
      return res;
    } catch (e) {
      console.error("[SensorRecorderManager] Failed to start monitoring:", e);
      return false;
    }
  }

  public async stopMonitoring(): Promise<boolean> {
    if (!this.isAvailable() || !this.isMonitoring) return false;

    try {
      const res = await BetterMapsSensorModule.stopSensorMonitoring();
      this.isMonitoring = false;
      return res;
    } catch (e) {
      console.error("[SensorRecorderManager] Failed to stop monitoring:", e);
      return false;
    }
  }

  public async startRecording(sessionPrefix = "session"): Promise<{
    sessionId: string;
    sessionPath: string;
    startTimeEpochMs: number;
  }> {
    if (!this.isAvailable()) {
      throw new Error(
        "BetterMapsSensorModule is only available on native Android.",
      );
    }
    return await BetterMapsSensorModule.startRecording(sessionPrefix);
  }

  public recordGnssLocation(location: NavLocation | null): void {
    if (!this.isAvailable() || !location) return;

    // Send location record asynchronously to native queue
    BetterMapsSensorModule.recordGnssLocation({
      timestampNs: 0, // Native module will use elapsedRealtimeNanos() if 0
      timestampMs: location.timestamp,
      latitude: location.latitude,
      longitude: location.longitude,
      altitude: location.altitude ?? 0,
      accuracy: location.accuracy ?? 0,
      verticalAccuracy: location.verticalAccuracy ?? 0,
      speed: location.speed ?? 0,
      bearing: location.heading ?? 0,
      provider: location.source ?? "fused",
      isMock: location.isMock ?? false,
    }).catch(() => {
      // Ignored if queue full or not recording
    });
  }

  public recordPositionEstimate(estimate: PositionEstimate | null): void {
    if (!this.isAvailable() || !estimate) return;

    BetterMapsSensorModule.recordPositionEstimate({
      timestampNs: estimate.timestamp_ns,
      timestampMs: estimate.timestamp_ms,
      latitude: estimate.latitude,
      longitude: estimate.longitude,
      altitude: estimate.altitude ?? 0,
      speed: estimate.speed ?? 0,
      heading: estimate.heading ?? 0,
      horizontalAccuracy: estimate.horizontal_accuracy ?? 0,
      positionSource: estimate.position_source,
      confidence: estimate.confidence,
      valid: estimate.valid,
    }).catch(() => {
      // Ignored if queue full or not recording
    });
  }

  public async recordEvent(eventType: string, value: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      return await BetterMapsSensorModule.recordEvent(eventType, value);
    } catch (e) {
      console.warn("[SensorRecorderManager] Failed to record event:", e);
      return false;
    }
  }

  public async stopRecording(): Promise<SessionSummary> {
    if (!this.isAvailable()) {
      throw new Error(
        "BetterMapsSensorModule is only available on native Android.",
      );
    }
    return await BetterMapsSensorModule.stopRecording();
  }

  public async listSessions(): Promise<SessionListItem[]> {
    if (!this.isAvailable()) return [];
    try {
      return await BetterMapsSensorModule.listSessions();
    } catch (e) {
      console.error("[SensorRecorderManager] Failed to list sessions:", e);
      return [];
    }
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      return await BetterMapsSensorModule.deleteSession(sessionId);
    } catch (e) {
      console.error("[SensorRecorderManager] Failed to delete session:", e);
      return false;
    }
  }

  public getLatestTelemetry(): SensorTelemetry | null {
    return this.latestTelemetry;
  }

  public addTelemetryListener(listener: SensorTelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    if (this.latestTelemetry) {
      listener(this.latestTelemetry);
    }
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }
}

export const sensorRecorderManager = SensorRecorderManager.getInstance();
