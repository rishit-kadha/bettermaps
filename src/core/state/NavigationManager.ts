import { AvailableProviderId, providerRegistry } from "../../adapters/location";
import { sensorRecorderManager } from "../../services/sensors/SensorRecorderManager";
import {
  calculateRouteProgress,
  createInitialProgress,
} from "../navigation/routeGeometry";
import {
  gnssPositioningEngine,
  GnssPositioningEngine,
} from "../positioning/GnssPositioningEngine";
import { gnssStreamGate, GnssStreamGate } from "../positioning/GnssStreamGate";
import {
  ILocationProvider,
  NavLocation,
  ProviderStatus,
} from "../types/location";
import {
  ActiveRoute,
  CameraPerspective,
  LocationSourceTag,
  NavigationMode,
  NavigationStatus,
  NavigationTelemetry,
  RouteProgress,
} from "../types/navigation";
import {
  GnssStreamGateState,
  IPositioningEngine,
  PositionEstimate,
  PositioningStatus,
} from "../types/positioning";

export type TelemetryListener = (telemetry: NavigationTelemetry) => void;

/**
 * NavigationManager
 *
 * Core shared navigation state coordinator.
 * Maintains positioning history, calculates real-time update rate (Hz),
 * performs circular heading filtering, and orchestrates camera tracking modes.
 *
 * ARCHITECTURAL RULE:
 * Strictly separates:
 * 1. Sensor measurements (NavLocation / GNSS Reference)
 * 2. Positioning output (PositionEstimate produced by IPositioningEngine)
 * 3. Navigation output (NavigationTelemetry / ActiveRoute / RouteProgress)
 */
export class NavigationManager {
  private activeProvider: ILocationProvider;
  private positioningEngine: IPositioningEngine;
  private streamGate: GnssStreamGate;
  private currentEstimate: PositionEstimate | null = null;

  private currentMode: NavigationMode = "follow_course";
  private currentLocation: NavLocation | null = null;
  private smoothedHeading = 0;
  private isHeadingReliable = false;
  private updateTimestamps: number[] = [];
  private historyTrail: { latitude: number; longitude: number }[] = [];
  private readonly maxTrailPoints = 100;

  // Real Navigation Extension State
  private navigationStatus: NavigationStatus = "idle";
  private cameraPerspective: CameraPerspective = "2D";
  private activeRoute: ActiveRoute | null = null;
  private routeProgress: RouteProgress | null = null;
  private routeError: string | null = null;

  private unsubLocation: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;
  private unsubGate: (() => void) | null = null;

  private telemetryListeners = new Set<TelemetryListener>();

  constructor(
    positioningEngine: IPositioningEngine = gnssPositioningEngine,
    streamGate: GnssStreamGate = gnssStreamGate,
  ) {
    this.positioningEngine = positioningEngine;
    this.streamGate = streamGate;
    // Default to platform-native GNSS adapter (AndroidGnssLocationProvider on Android)
    this.activeProvider = providerRegistry.getNativeGnssProvider();

    // Listen to stream gate state transitions
    this.unsubGate = this.streamGate.addListener((gateState) => {
      if (gateState === "GNSS_STREAM_DISABLED") {
        const blockedEstimate = this.positioningEngine.onGnssBlocked();
        sensorRecorderManager.recordPositionEstimate(blockedEstimate);
        this.currentEstimate = blockedEstimate;
        this.isHeadingReliable = false;
      }
      this.broadcastTelemetry();
    });
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

  public setCameraPerspective(perspective: CameraPerspective): void {
    this.cameraPerspective = perspective;
    this.broadcastTelemetry();
  }

  public toggleCameraPerspective(): CameraPerspective {
    this.cameraPerspective = this.cameraPerspective === "2D" ? "3D" : "2D";
    this.broadcastTelemetry();
    return this.cameraPerspective;
  }

  // --- Real Navigation Actions ---

  public setSearching(searching: boolean): void {
    if (searching && this.navigationStatus === "idle") {
      this.navigationStatus = "searching";
      this.broadcastTelemetry();
    } else if (!searching && this.navigationStatus === "searching") {
      this.navigationStatus = "idle";
      this.broadcastTelemetry();
    }
  }

  public setRoutePreview(route: ActiveRoute): void {
    this.activeRoute = route;
    this.routeError = null;
    this.navigationStatus = "route_preview";
    this.routeProgress = createInitialProgress(route);
    this.currentMode = "free"; // Allow framing the entire route overview
    this.broadcastTelemetry();
  }

  public setRouteError(error: string | null): void {
    this.routeError = error;
    this.broadcastTelemetry();
  }

  public startNavigation(): void {
    if (!this.activeRoute) return;
    this.navigationStatus = "navigating";
    this.currentMode = "follow_course"; // Heading-following driving mode

    if (this.currentLocation) {
      this.routeProgress = calculateRouteProgress(
        this.activeRoute,
        this.currentLocation,
        this.routeProgress,
      );
    }

    this.broadcastTelemetry();
  }

  public stopNavigation(): void {
    this.navigationStatus = "idle";
    this.activeRoute = null;
    this.routeProgress = null;
    this.routeError = null;
    this.currentMode = "follow_course";
    this.broadcastTelemetry();
  }

  public getTelemetry(): NavigationTelemetry {
    const speedMs = this.currentLocation?.speed ?? 0;
    const speedKmh = Math.round(speedMs * 3.6);
    const updateFrequencyHz = this.calculateUpdateFrequencyHz();

    return {
      currentLocation: this.currentLocation
        ? { ...this.currentLocation }
        : null,
      speedKmh,
      smoothedHeading: Math.round(this.smoothedHeading),
      isHeadingReliable: this.isHeadingReliable,
      updateFrequencyHz,
      mode: this.currentMode,
      providerStatus: this.activeProvider.getStatus(),
      providerName: this.activeProvider.name,
      providerType: this.activeProvider.providerType,
      locationSource: this.determineLocationSource(),
      isDeadReckoning: this.currentEstimate?.isDeadReckoning ?? false,
      historyTrail: [...this.historyTrail],

      // Positioning Engine & Outage Gate State
      currentPositionEstimate: this.currentEstimate
        ? { ...this.currentEstimate }
        : null,
      gnssStreamGateState: this.streamGate.getState(),
      positioningStatus: this.positioningEngine.getStatus(),
      motionDiagnostics:
        "getMotionEstimator" in this.positioningEngine &&
        typeof (this.positioningEngine as any).getMotionEstimator === "function"
          ? (this.positioningEngine as any)
              .getMotionEstimator()
              ?.getDiagnostics?.() ?? null
          : null,

      // Navigation State
      navigationStatus: this.navigationStatus,
      cameraPerspective: this.cameraPerspective,
      activeRoute: this.activeRoute ? { ...this.activeRoute } : null,
      routeProgress: this.routeProgress ? { ...this.routeProgress } : null,
      routeError: this.routeError,
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

  public getGate(): GnssStreamGate {
    return this.streamGate;
  }

  public toggleGnssStreamGate(): GnssStreamGateState {
    return this.streamGate.toggle();
  }

  public setGnssStreamGate(state: GnssStreamGateState): void {
    if (state === "GNSS_STREAM_ENABLED") {
      this.streamGate.enable();
    } else {
      this.streamGate.disable();
    }
  }

  public getPositioningEngine(): IPositioningEngine {
    return this.positioningEngine;
  }

  public setPositioningEngine(engine: IPositioningEngine): void {
    this.positioningEngine = engine;
  }

  private determineLocationSource(): LocationSourceTag {
    if (!this.streamGate.isEnabled()) {
      return "GNSS STREAM BLOCKED";
    }
    if (this.positioningEngine.getStatus() === "NO_POSITION") {
      return "NO POSITION";
    }
    if (this.activeProvider.providerType === "mock") return "SIMULATOR";
    if (this.currentEstimate?.isDeadReckoning) return "IDR";
    if (this.currentEstimate?.position_source === "GNSS+INS") return "GNSS+INS";
    return "GNSS";
  }

  private bindProvider(provider: ILocationProvider): void {
    if (this.unsubLocation) this.unsubLocation();
    if (this.unsubStatus) this.unsubStatus();

    this.unsubLocation = provider.addListener((location: NavLocation) => {
      // 1. Reference GNSS Recorder: ALWAYS record incoming reference location fix (never interrupted!)
      sensorRecorderManager.recordGnssLocation(location);

      // 2. GNSS Stream Gate Check
      if (this.streamGate.isEnabled()) {
        const estimate = this.positioningEngine.processGnss(location);
        sensorRecorderManager.recordPositionEstimate(estimate);
        this.currentEstimate = estimate;
        this.onPositionEstimateUpdate(estimate, location);
      } else {
        const blockedEstimate = this.positioningEngine.onGnssBlocked();
        sensorRecorderManager.recordPositionEstimate(blockedEstimate);
        this.currentEstimate = blockedEstimate;
        this.isHeadingReliable = false;
        // Do NOT update vehicle coordinates! Do NOT advance route progress!
        this.broadcastTelemetry();
      }
    });

    this.unsubStatus = provider.addStatusListener((_status: ProviderStatus) => {
      this.broadcastTelemetry();
    });
  }

  private onPositionEstimateUpdate(
    estimate: PositionEstimate,
    rawLocation: NavLocation,
  ): void {
    const now = Date.now();
    this.currentLocation = { ...rawLocation };

    // Track timestamps for update frequency (Hz) calculation immutably
    const nextTimestamps = [...this.updateTimestamps, now];
    if (nextTimestamps.length > 10) {
      nextTimestamps.shift();
    }
    this.updateTimestamps = nextTimestamps;

    // Determine heading reliability
    const speedMs = estimate.speed ?? rawLocation.speed ?? 0;
    const heading = estimate.heading ?? rawLocation.heading;
    const hasValidHeading =
      heading !== null && heading !== undefined && heading >= 0;

    if (
      hasValidHeading &&
      (speedMs >= 0.5 || rawLocation.providerType === "mock")
    ) {
      this.isHeadingReliable = true;
      this.smoothedHeading = this.filterHeading(this.smoothedHeading, heading!);
    } else if (hasValidHeading) {
      // Vehicle is stationary: retain orientation without noisy spinning
      this.isHeadingReliable = false;
    } else {
      this.isHeadingReliable = false;
    }

    // Append to breadcrumb history trail immutably
    const newPoint = {
      latitude: estimate.latitude,
      longitude: estimate.longitude,
    };
    const nextTrail = [...this.historyTrail, newPoint];
    if (nextTrail.length > this.maxTrailPoints) {
      nextTrail.shift();
    }
    this.historyTrail = nextTrail;

    // Update real-time route progress along cumulative route geometry
    if (
      (this.navigationStatus === "navigating" ||
        this.navigationStatus === "route_preview") &&
      this.activeRoute
    ) {
      this.routeProgress = calculateRouteProgress(
        this.activeRoute,
        this.currentLocation,
        this.routeProgress,
      );

      if (
        this.routeProgress.isArrived &&
        this.navigationStatus === "navigating"
      ) {
        this.navigationStatus = "arrived";
      }
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
