import {
  AvailableProviderId,
  providerRegistry,
} from '../providers';
import {
  ILocationProvider,
  LocationListener,
  NavigationMode,
  NavigationTelemetry,
  NavLocation,
  ProviderStatus,
  ProviderType,
  StatusListener,
} from '../types/location';

export type TelemetryListener = (telemetry: NavigationTelemetry) => void;

/**
 * NavigationManager
 *
 * Coordinates between the active LocationProvider and the UI layer.
 * Maintains navigation state, filters heading/bearing for smooth UI rotation,
 * and maintains vehicle trajectory breadcrumbs.
 */
export class NavigationManager {
  private activeProvider: ILocationProvider;
  private currentMode: NavigationMode = 'follow_course';
  private currentLocation: NavLocation | null = null;
  private smoothedHeading = 0;
  private historyTrail: { latitude: number; longitude: number }[] = [];
  private readonly maxTrailPoints = 100;

  private unsubLocation: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;

  private telemetryListeners = new Set<TelemetryListener>();

  constructor() {
    // Default to GNSS provider for Phase 1
    this.activeProvider = providerRegistry.getGnssProvider();
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
    this.activeProvider = providerRegistry.getProvider(providerId);
    await this.start();
    this.broadcastTelemetry();
  }

  public setNavigationMode(mode: NavigationMode): void {
    this.currentMode = mode;
    this.broadcastTelemetry();
  }

  public toggleNavigationMode(): NavigationMode {
    if (this.currentMode === 'follow_course') {
      this.setNavigationMode('follow_north');
    } else if (this.currentMode === 'follow_north') {
      this.setNavigationMode('free');
    } else {
      this.setNavigationMode('follow_course');
    }
    return this.currentMode;
  }

  public recenter(): void {
    this.setNavigationMode('follow_course');
  }

  public getTelemetry(): NavigationTelemetry {
    const speedMs = this.currentLocation?.speed ?? 0;
    const speedKmh = Math.round(speedMs * 3.6);

    return {
      currentLocation: this.currentLocation,
      speedKmh,
      smoothedHeading: Math.round(this.smoothedHeading),
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

    this.unsubStatus = provider.addStatusListener((status: ProviderStatus) => {
      this.broadcastTelemetry();
    });
  }

  private onLocationUpdate(location: NavLocation): void {
    this.currentLocation = location;

    // Filter and smooth heading (circular interpolation to prevent 359 -> 1 degree snapping)
    if (location.heading !== null && location.heading !== undefined) {
      this.smoothedHeading = this.filterHeading(this.smoothedHeading, location.heading);
    }

    // Append to breadcrumb history trail
    const newPoint = { latitude: location.latitude, longitude: location.longitude };
    this.historyTrail.push(newPoint);
    if (this.historyTrail.length > this.maxTrailPoints) {
      this.historyTrail.shift();
    }

    this.broadcastTelemetry();
  }

  /**
   * Exponential moving average with circular angle difference.
   */
  private filterHeading(current: number, target: number): number {
    let diff = (target - current) % 360;
    if (diff < -180) diff += 360;
    if (diff > 180) diff -= 360;

    // Alpha = 0.35 gives responsive yet stable orientation
    const alpha = 0.35;
    const next = (current + diff * alpha + 360) % 360;
    return next;
  }

  private broadcastTelemetry(): void {
    const telemetry = this.getTelemetry();
    this.telemetryListeners.forEach((fn) => fn(telemetry));
  }
}

export const navigationManager = new NavigationManager();
