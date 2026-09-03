import { AvailableProviderId, providerRegistry } from "../../adapters/location";
import {
  ILocationProvider,
  NavLocation,
  ProviderStatus,
} from "../types/location";
import { NavigationMode, NavigationTelemetry } from "../types/navigation";

export type TelemetryListener = (telemetry: NavigationTelemetry) => void;

/**
 * NavigationManager
 *
 * Core shared navigation state coordinator.
 * Maintains positioning history, calculates real-time update rate (Hz),
 * performs circular heading filtering, and orchestrates camera tracking modes.
 */
export class NavigationManager {
  private activeProvider: ILocationProvider;
  private currentMode: NavigationMode = "follow_course";
  private currentLocation: NavLocation | null = null;
  private smoothedHeading = 0;
  private isHeadingReliable = false;
  private updateTimestamps: number[] = [];
  private historyTrail: { latitude: number; longitude: number }[] = [];
  private readonly maxTrailPoints = 100;

  private unsubLocation: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;

  private telemetryListeners = new Set<TelemetryListener>();

  constructor() {
    // Default to platform-native GNSS adapter (AndroidGnssLocationProvider on Android)
    this.activeProvider = providerRegistry.getNativeGnssProvider();
  }

  public async requestPermissions(): Promise<boolean> {
    if (this.activeProvider.requestPermissions) {
      return await this.activeProvider.requestPermissions();
    }
    return true;
  }

  public async start(): Promise<void> {
    this.bindProvider(this.activeProvider);
    await this.activeProvider.start();
  }

  public async stop(): Promise<void> {
    if (this.unsubLocation) {
      this.unsubLocation();
      this.unsubLocation = null;
    }
    if (this.unsubStatus) {
      this.unsubStatus();
      this.unsubStatus = null;
    }
    await this.activeProvider.stop();
  }

  public async switchProvider(providerId: AvailableProviderId): Promise<void> {
    await this.stop();
    this.updateTimestamps = [];
    this.activeProvider = providerRegistry.getProvider(providerId);
    await this.start();
    this.broadcastTelemetry();
  }

  public setNavigationMode(mode: NavigationMode): void {
    this.currentMode = mode;
    this.broadcastTelemetry();
  }

  public toggleNavigationMode(): NavigationMode {
    if (this.currentMode === "follow_course") {
      this.setNavigationMode("follow_north");
    } else if (this.currentMode === "follow_north") {
      this.setNavigationMode("free");
    } else {
      this.setNavigationMode("follow_course");
    }
    return this.currentMode;
  }

  public recenter(): void {
    this.setNavigationMode("follow_course");
  }

  public getTelemetry(): NavigationTelemetry {
    const speedMs = this.currentLocation?.speed ?? 0;
    const speedKmh = Math.round(speedMs * 3.6);
    const updateFrequencyHz = this.calculateUpdateFrequencyHz();

    return {
      currentLocation: this.currentLocation,
      speedKmh,
      smoothedHeading: Math.round(this.smoothedHeading),
      isHeadingReliable: this.isHeadingReliable,
      updateFrequencyHz,
      mode: this.currentMode,
      providerStatus: this.activeProvider.getStatus(),
      providerName: this.activeProvider.name,
      providerType: this.activeProvider.providerType,
      isDeadReckoning: this.currentLocation?.isDeadReckoning ?? false,
      historyTrail: this.historyTrail,
    };
  }

  public subscribeTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    listener(this.getTelemetry());
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  public getActiveProvider(): ILocationProvider {
    return this.activeProvider;
  }

  private bindProvider(provider: ILocationProvider): void {
    if (this.unsubLocation) this.unsubLocation();
    if (this.unsubStatus) this.unsubStatus();

    this.unsubLocation = provider.addListener((location: NavLocation) => {
      this.onLocationUpdate(location);
    });

    this.unsubStatus = provider.addStatusListener((_status: ProviderStatus) => {
      this.broadcastTelemetry();
    });
  }

  private onLocationUpdate(location: NavLocation): void {
    const now = Date.now();
    this.currentLocation = location;

    // Track timestamps for update frequency (Hz) calculation
    this.updateTimestamps.push(now);
    if (this.updateTimestamps.length > 10) {
      this.updateTimestamps.shift();
    }

    // Determine heading reliability
    const speedMs = location.speed ?? 0;
    const hasValidHeading =
      location.heading !== null &&
      location.heading !== undefined &&
      location.heading >= 0;

    if (
      hasValidHeading &&
      (speedMs >= 0.5 || location.providerType === "mock")
    ) {
      this.isHeadingReliable = true;
      this.smoothedHeading = this.filterHeading(
        this.smoothedHeading,
        location.heading!,
      );
    } else if (hasValidHeading) {
      // Vehicle is stationary: retain orientation without noisy spinning
      this.isHeadingReliable = false;
    } else {
      this.isHeadingReliable = false;
    }

    // Append to breadcrumb history trail
    const newPoint = {
      latitude: location.latitude,
      longitude: location.longitude,
    };
    this.historyTrail.push(newPoint);
    if (this.historyTrail.length > this.maxTrailPoints) {
      this.historyTrail.shift();
    }

    this.broadcastTelemetry();
  }

  /**
   * Rolling frequency calculation in approximate Hz.
   */
  private calculateUpdateFrequencyHz(): number {
    if (this.updateTimestamps.length < 2) return 0;

    const newest = this.updateTimestamps[this.updateTimestamps.length - 1];
    const oldest = this.updateTimestamps[0];
    const timeSpanSec = (newest - oldest) / 1000;

    if (Date.now() - newest > 4000) return 0;
    if (timeSpanSec <= 0) return 0;

    const hz = (this.updateTimestamps.length - 1) / timeSpanSec;
    return Math.round(hz * 10) / 10;
  }

  /**
   * Circular exponential moving average avoiding 0/360 boundary discontinuities.
   */
  private filterHeading(current: number, target: number): number {
    let diff = (target - current) % 360;
    if (diff < -180) diff += 360;
    if (diff > 180) diff -= 360;

    const alpha = 0.35;
    return (current + diff * alpha + 360) % 360;
  }

  private broadcastTelemetry(): void {
    const telemetry = this.getTelemetry();
    this.telemetryListeners.forEach((fn) => fn(telemetry));
  }
}

export const navigationManager = new NavigationManager();
