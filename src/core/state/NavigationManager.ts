import { AvailableProviderId, providerRegistry } from "../../adapters/location";
import { createPlatformImuProvider } from "../../adapters/imu";
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
import { IImuProvider, ImuSample } from "../types/imu";
import { RoadDataManager } from "../navigation/road/RoadDataManager";
import { LocalRoadNetworkProvider } from "../../adapters/road/LocalRoadNetworkProvider";
import coventryRoadData from "../../../assets/datasets/road_network_coventry.json";
import { offlineRegionPackManager } from "../../adapters/road/OfflineRegionPackManager";
import { registerBundledRegionPacks } from "../../adapters/road/BundledRegionPacks";
import { OsmOverpassRoadDataSource } from "../../adapters/road/OsmOverpassRoadDataSource";
import { PersistentRoadCache } from "../../adapters/road/PersistentRoadCache";
import { MultiCandidateRoadMatcher } from "../navigation/road/MultiCandidateRoadMatcher";
import { ProbabilisticRoadConstraint } from "../positioning/constraints/ProbabilisticRoadConstraint";
import { ProbabilisticRouteConstraint } from "../positioning/constraints/ProbabilisticRouteConstraint";
import { LearnedMotionEstimator } from "../positioning/motionEstimator";
import { gruOnnxEvaluator } from "../../adapters/ml/GruOnnxEvaluator";
import { EskfPositioningEngine } from "../positioning/EskfPositioningEngine";
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

class InertImuProvider implements IImuProvider {
  public readonly name = "Inert IMU (No-op)";
  private status: ProviderStatus = "idle";
  public getStatus(): ProviderStatus {
    return this.status;
  }
  public async start(): Promise<void> {
    this.status = "active";
  }
  public async stop(): Promise<void> {
    this.status = "stopped";
  }
  public addListener(): () => void {
    return () => {};
  }
}

function resolveImuProvider(customProvider?: IImuProvider): IImuProvider {
  if (customProvider) return customProvider;
  try {
    return createPlatformImuProvider();
  } catch (_err) {
    return new InertImuProvider();
  }
}

/**
 * Factory for production live positioning and road-data stack.
 * Wires 15-State ESKF + B3_GRU ONNX Learned Motion Model + LocalRoadNetworkProvider +
 * OsmOverpassRoadDataSource + PersistentRoadCache + MultiCandidateRoadMatcher.
 *
 * The GRU ONNX session is initialized asynchronously in NavigationManager.start()
 * after this factory creates the stack synchronously.
 */
export function createProductionPositioningStack(): {
  positioningEngine: EskfPositioningEngine;
  roadDataManager: RoadDataManager;
  provider: LocalRoadNetworkProvider;
  dataSource: OsmOverpassRoadDataSource;
  cache: PersistentRoadCache;
  roadConstraint: ProbabilisticRoadConstraint;
  routeConstraint: ProbabilisticRouteConstraint;
} {
  const provider = new LocalRoadNetworkProvider(
    coventryRoadData,
    "ProductionRoadNetworkProvider",
  );
  const dataSource = new OsmOverpassRoadDataSource({
    offlineFixturesDir: "assets/datasets/road_tiles_test",
  });
  const cache = new PersistentRoadCache(undefined, {
    keyPrefix: "prod_road_tile:",
  });
  const roadDataManager = new RoadDataManager({
    provider,
    dataSource,
    cache,
    regionPackManager: offlineRegionPackManager,
  });
  registerBundledRegionPacks(offlineRegionPackManager);

  const matcher = new MultiCandidateRoadMatcher(provider);
  const roadConstraint = new ProbabilisticRoadConstraint(matcher);
  const routeConstraint = new ProbabilisticRouteConstraint();
  // Wire B3_GRU ONNX evaluator. The session is loaded async in start().
  // Until READY, evaluateAsync() returns null → LearnedMotionEstimator falls back to kinematic.
  const motionEstimator = new LearnedMotionEstimator("gru", {
    customEvaluator: async (inputTensor) => {
      // inputTensor from LearnedMotionEstimator is a single-step feature vector [[f0..f5]].
      // Push it into the GRU's rolling window (already normalized by the estimator).
      if (inputTensor.length > 0) {
        gruOnnxEvaluator.pushSample(inputTensor[0]);
      }
      // Run ONNX inference over the full 20-sample window.
      const result = await gruOnnxEvaluator.evaluateAsync();
      if (!result) return undefined;
      return {
        forwardVelocity: result.forwardVelocity,
        yawRate: result.yawRate,
      };
    },
  });

  const positioningEngine = new EskfPositioningEngine({
    motionEstimator,
    routeConstraint,
    roadConstraint,
  });

  return {
    positioningEngine,
    roadDataManager,
    provider,
    dataSource,
    cache,
    roadConstraint,
    routeConstraint,
  };
}

/**
 * NavigationManager
 *
 * Core shared navigation state coordinator.
 * Maintains positioning history, calculates real-time update rate (Hz),
 * performs circular heading filtering, and orchestrates camera tracking modes.
 *
 * In Phase 3, NavigationManager bridges live 50 Hz IMU sensors directly into
 * the ESKF positioning engine while orchestrating RoadDataManager in the background.
 */
export class NavigationManager {
  private activeProvider: ILocationProvider;
  private imuProvider: IImuProvider;
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
  private roadDataManager: RoadDataManager | null = null;
  private lastRawGnssLocation: NavLocation | null = null;

  private unsubLocation: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;
  private unsubImu: (() => void) | null = null;
  private unsubGate: (() => void) | null = null;
  private unsubRoadData: (() => void) | null = null;

  private telemetryListeners = new Set<TelemetryListener>();
  private lastTelemetryBroadcastMs = 0;

  constructor(
    positioningEngine?: IPositioningEngine,
    streamGate: GnssStreamGate = gnssStreamGate,
    roadDataManager?: RoadDataManager,
    imuProvider?: IImuProvider,
    locationProvider?: ILocationProvider,
  ) {
    let defaultRoadMgr = roadDataManager ?? null;
    if (!positioningEngine) {
      const stack = createProductionPositioningStack();
      this.positioningEngine = stack.positioningEngine;
      defaultRoadMgr = defaultRoadMgr ?? stack.roadDataManager;
    } else {
      this.positioningEngine = positioningEngine;
    }

    this.streamGate = streamGate;
    this.roadDataManager = defaultRoadMgr;
    this.activeProvider =
      locationProvider ?? providerRegistry.getNativeGnssProvider();
    this.imuProvider = resolveImuProvider(imuProvider);

    // Listen to stream gate state transitions
    this.unsubGate = this.streamGate.addListener((gateState) => {
      if (gateState === "GNSS_STREAM_DISABLED") {
        const blockedEstimate = this.positioningEngine.onGnssBlocked();
        sensorRecorderManager.recordPositionEstimate(blockedEstimate);
        this.currentEstimate = blockedEstimate;
        this.isHeadingReliable = false;
      }
      this.broadcastTelemetry(true);
    });

    if (this.roadDataManager && typeof this.roadDataManager.addRoadDataListener === "function") {
      this.unsubRoadData = this.roadDataManager.addRoadDataListener(() => {
        this.broadcastTelemetry(true);
      });
    }
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

    this.bindImuProvider(this.imuProvider);
    await this.imuProvider.start(50);

    if (this.roadDataManager) {
      await this.roadDataManager.start();
    }

    // Initialize B3_GRU ONNX session asynchronously.
    // Does not block start() — kinematic fallback used until READY.
    gruOnnxEvaluator.initialize().catch((err) => {
      console.warn("[NavigationManager] GRU model init error:", err);
    });
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

    if (this.unsubImu) {
      this.unsubImu();
      this.unsubImu = null;
    }
    await this.imuProvider.stop();

    if (this.unsubRoadData) {
      this.unsubRoadData();
      this.unsubRoadData = null;
    }

    if (this.roadDataManager) {
      await this.roadDataManager.stop();
    }
  }

  public async switchProvider(providerId: AvailableProviderId): Promise<void> {
    await this.stop();
    this.updateTimestamps = [];
    this.positioningEngine.reset();
    this.activeProvider = providerRegistry.getProvider(providerId);
    await this.start();
    this.broadcastTelemetry(true);
  }

  public setNavigationMode(mode: NavigationMode): void {
    this.currentMode = mode;
    this.broadcastTelemetry(true);
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
    this.broadcastTelemetry(true);
  }

  public toggleCameraPerspective(): CameraPerspective {
    this.cameraPerspective = this.cameraPerspective === "2D" ? "3D" : "2D";
    this.broadcastTelemetry(true);
    return this.cameraPerspective;
  }

  // --- Real Navigation Actions ---

  public setSearching(searching: boolean): void {
    if (searching && this.navigationStatus === "idle") {
      this.navigationStatus = "searching";
      this.broadcastTelemetry(true);
    } else if (!searching && this.navigationStatus === "searching") {
      this.navigationStatus = "idle";
      this.broadcastTelemetry(true);
    }
  }

  public setRoutePreview(route: ActiveRoute): void {
    this.activeRoute = route;
    this.routeError = null;
    this.navigationStatus = "route_preview";
    this.routeProgress = createInitialProgress(route);
    this.currentMode = "free";

    if (
      "setStaticRoutePoints" in this.positioningEngine &&
      typeof (this.positioningEngine as any).setStaticRoutePoints === "function"
    ) {
      (this.positioningEngine as any).setStaticRoutePoints(
        route.geometry.points,
      );
    }

    if (this.roadDataManager) {
      this.roadDataManager
        .updateRoute({
          id: route.metadata.id,
          points: route.geometry.points,
        })
        .catch((err) =>
          console.warn("[NavigationManager] RoadDataManager route preview failed:", err),
        );
    }

    this.broadcastTelemetry(true);
  }

  public setRouteError(error: string | null): void {
    this.routeError = error;
    this.broadcastTelemetry(true);
  }

  public startNavigation(): void {
    if (!this.activeRoute) return;
    this.navigationStatus = "navigating";
    this.currentMode = "follow_course";

    if (
      "setStaticRoutePoints" in this.positioningEngine &&
      typeof (this.positioningEngine as any).setStaticRoutePoints === "function"
    ) {
      (this.positioningEngine as any).setStaticRoutePoints(
        this.activeRoute.geometry.points,
      );
    }

    if (this.currentLocation) {
      this.routeProgress = calculateRouteProgress(
        this.activeRoute,
        this.currentLocation,
        this.routeProgress,
      );
    }

    if (this.roadDataManager && this.activeRoute) {
      this.roadDataManager
        .updateRoute({
          id: this.activeRoute.metadata.id,
          points: this.activeRoute.geometry.points,
        })
        .catch((err) =>
          console.warn("[NavigationManager] RoadDataManager start navigation failed:", err),
        );
    }

    this.broadcastTelemetry(true);
  }

  public stopNavigation(): void {
    this.navigationStatus = "idle";
    this.activeRoute = null;
    this.routeProgress = null;
    this.routeError = null;
    this.currentMode = "follow_course";

    if (
      "setStaticRoutePoints" in this.positioningEngine &&
      typeof (this.positioningEngine as any).setStaticRoutePoints === "function"
    ) {
      (this.positioningEngine as any).setStaticRoutePoints(null);
    }

    if (this.roadDataManager) {
      this.roadDataManager
        .updateRoute(null)
        .catch((err) =>
          console.warn("[NavigationManager] RoadDataManager clear route failed:", err),
        );
    }

    this.broadcastTelemetry(true);
  }

  public setRoadDataManager(manager: RoadDataManager | null): void {
    if (this.unsubRoadData) {
      this.unsubRoadData();
      this.unsubRoadData = null;
    }
    this.roadDataManager = manager;
    if (manager && typeof manager.addRoadDataListener === "function") {
      this.unsubRoadData = manager.addRoadDataListener(() => {
        this.broadcastTelemetry(true);
      });
    }
  }

  public getRoadDataManager(): RoadDataManager | null {
    return this.roadDataManager;
  }

  public getImuProvider(): IImuProvider {
    return this.imuProvider;
  }

  public setImuProvider(provider: IImuProvider): void {
    this.imuProvider = provider;
  }

  public getTelemetry(): NavigationTelemetry {
    const speedMs = this.currentLocation?.speed ?? 0;
    const speedKmh = Math.round(speedMs * 3.6);
    const updateFrequencyHz = this.calculateUpdateFrequencyHz();

    const now = Date.now();
    const lastGnssFixTime =
      (this.positioningEngine as any).getLastGnssFixTimestampMs?.() ??
      this.lastRawGnssLocation?.timestamp ??
      0;
    const lastGnssFixAgeMs =
      lastGnssFixTime > 0 ? Math.max(0, now - lastGnssFixTime) : null;
    const gnssFixCount =
      (this.positioningEngine as any).getGnssFixCount?.() ?? 0;
    const eskfGnssUpdateCount =
      (this.positioningEngine as any).getGnssUpdateCount?.() ?? 0;

    let gnssStatus: "VALID" | "STALE" | "LOST" | "BLOCKED" = "VALID";
    if (!this.streamGate.isEnabled()) {
      gnssStatus = "BLOCKED";
    } else if (lastGnssFixAgeMs === null || lastGnssFixAgeMs > 10000) {
      gnssStatus = "LOST";
    } else if (lastGnssFixAgeMs > 3000) {
      gnssStatus = "STALE";
    } else {
      gnssStatus = "VALID";
    }

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
          ? ((this.positioningEngine as any)
              .getMotionEstimator()
              ?.getDiagnostics?.() ?? null)
          : null,

      // Navigation State
      navigationStatus: this.navigationStatus,
      cameraPerspective: this.cameraPerspective,
      activeRoute: this.activeRoute ? { ...this.activeRoute } : null,
      routeProgress: this.routeProgress ? { ...this.routeProgress } : null,
      routeError: this.routeError,
      roadDiagnostics: this.roadDataManager ? this.roadDataManager.getDiagnostics() : null,
      roadCoverageDiagnostics: this.roadDataManager ? this.roadDataManager.getCoverageTelemetry() : null,
      roadMemoryDiagnostics: this.roadDataManager ? this.roadDataManager.getMemoryTelemetry() : null,

      // GRU Model Diagnostics
      gruModelDiagnostics: gruOnnxEvaluator.getDiagnostics(),

      // Extended GNSS / ESKF Fusion Diagnostics
      gnssFixCount,
      lastGnssFixAgeMs,
      eskfGnssUpdateCount,
      gnssStatus,
      rawGnssLocation: this.lastRawGnssLocation ? { ...this.lastRawGnssLocation } : null,
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

  public setGnssStreamGate(state: GnssStreamGateState | "open" | "closed"): void {
    if (state === "GNSS_STREAM_ENABLED" || state === "open") {
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

    const lastGnssFixTime =
      (this.positioningEngine as any).getLastGnssFixTimestampMs?.() ??
      this.lastRawGnssLocation?.timestamp ??
      0;
    const isStale =
      lastGnssFixTime > 0 && Date.now() - lastGnssFixTime > 3000;

    if (this.currentEstimate?.isDeadReckoning || isStale) return "IDR";
    if (this.currentEstimate?.position_source === "GNSS+INS") return "GNSS+INS";
    return "GNSS";
  }

  private bindProvider(provider: ILocationProvider): void {
    if (this.unsubLocation) this.unsubLocation();
    if (this.unsubStatus) this.unsubStatus();

    this.unsubLocation = provider.addListener((location: NavLocation) => {
      this.lastRawGnssLocation = location;
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
        this.broadcastTelemetry(true);
      }
    });

    this.unsubStatus = provider.addStatusListener((_status: ProviderStatus) => {
      this.broadcastTelemetry(true);
    });
  }

  private bindImuProvider(imu: IImuProvider): void {
    if (this.unsubImu) {
      this.unsubImu();
      this.unsubImu = null;
    }
    if (!imu.addListener) return;

    this.unsubImu = imu.addListener((sample: ImuSample) => {
      // Synchronously feed to positioning engine (zero promises, non-blocking)
      if (this.positioningEngine.processImu) {
        const estimate = this.positioningEngine.processImu(sample);
        if (estimate && estimate.valid) {
          sensorRecorderManager.recordPositionEstimate(estimate);
          this.currentEstimate = estimate;
          this.onPositionEstimateUpdate(estimate, null);
        }
      }
    });
  }

  private isGnssPermittedAndAvailable(): boolean {
    if (!this.streamGate.isEnabled()) return false;
    if (!this.lastRawGnssLocation) return false;
    const now = Date.now();
    const lastFixTime =
      (this.positioningEngine as any).getLastGnssFixTimestampMs?.() ??
      this.lastRawGnssLocation.timestamp ??
      0;
    if (lastFixTime <= 0) return false;
    return now - lastFixTime <= 3000;
  }

  private onPositionEstimateUpdate(
    estimate: PositionEstimate,
    rawLocation: NavLocation | null,
  ): void {
    const now = Date.now();
    const gnssActive = this.isGnssPermittedAndAvailable();

    if (rawLocation) {
      // GNSS fix arrived and is permitted: follow it directly
      this.currentLocation = { ...rawLocation };
    } else if (!gnssActive) {
      // GNSS is NOT available: fall back to our estimator and models!
      this.currentLocation = {
        latitude: estimate.latitude,
        longitude: estimate.longitude,
        altitude: estimate.altitude,
        accuracy: estimate.horizontal_accuracy,
        heading: estimate.heading,
        speed: estimate.speed,
        timestamp: estimate.timestamp_ms || now,
        providerType: (estimate.isDeadReckoning ? "idr" : "gnss") as any,
        isDeadReckoning: estimate.isDeadReckoning ?? false,
      };
    } else {
      // GNSS to estimator is permitted and fresh: always keep following GNSS!
      if (this.currentLocation && estimate.heading !== null && estimate.heading !== undefined) {
        const speedMs = estimate.speed ?? this.currentLocation.speed ?? 0;
        if (speedMs >= 0.5) {
          this.smoothedHeading = this.filterHeading(this.smoothedHeading, estimate.heading);
          this.isHeadingReliable = true;
        }
      }
      return;
    }

    // Track timestamps for update frequency (Hz) calculation immutably
    const nextTimestamps = [...this.updateTimestamps, now];
    if (nextTimestamps.length > 10) {
      nextTimestamps.shift();
    }
    this.updateTimestamps = nextTimestamps;

    // Determine heading reliability
    const speedMs = estimate.speed ?? rawLocation?.speed ?? 0;
    const heading = estimate.heading ?? rawLocation?.heading;
    const hasValidHeading =
      heading !== null && heading !== undefined && heading >= 0;

    if (
      hasValidHeading &&
      (speedMs >= 0.5 || rawLocation?.providerType === "mock")
    ) {
      this.isHeadingReliable = true;
      this.smoothedHeading = this.filterHeading(this.smoothedHeading, heading!);
    } else if (hasValidHeading) {
      // Vehicle is stationary: retain orientation without noisy spinning
      this.isHeadingReliable = false;
    } else {
      this.isHeadingReliable = false;
    }

    // Append to breadcrumb history trail with distance threshold (1.0m)
    const newPoint = {
      latitude: this.currentLocation.latitude,
      longitude: this.currentLocation.longitude,
    };
    const lastPoint =
      this.historyTrail.length > 0
        ? this.historyTrail[this.historyTrail.length - 1]
        : null;

    if (!lastPoint || this.calculateDistanceMeters(lastPoint, newPoint) >= 1.0) {
      const nextTrail = [...this.historyTrail, newPoint];
      if (nextTrail.length > this.maxTrailPoints) {
        nextTrail.shift();
      }
      this.historyTrail = nextTrail;
    }

    // Update real-time route progress along cumulative route geometry
    if (
      (this.navigationStatus === "navigating" ||
        this.navigationStatus === "route_preview") &&
      this.activeRoute &&
      this.currentLocation
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

    if (this.roadDataManager) {
      const speed = estimate.speed ?? rawLocation?.speed ?? 0;
      const hDeg = estimate.heading ?? rawLocation?.heading ?? 0;
      this.roadDataManager
        .updatePosition(
          { latitude: estimate.latitude, longitude: estimate.longitude },
          speed,
          hDeg,
        )
        .catch((err) =>
          console.warn(
            "[NavigationManager] RoadDataManager position update failed:",
            err,
          ),
        );
    }

    // Broadcast telemetry: force on raw GNSS fix, throttled to 25 Hz on high-frequency IMU
    this.broadcastTelemetry(rawLocation !== null);
  }

  private calculateDistanceMeters(
    p1: { latitude: number; longitude: number },
    p2: { latitude: number; longitude: number },
  ): number {
    const dLat = ((p2.latitude - p1.latitude) * Math.PI) / 180.0;
    const dLon = ((p2.longitude - p1.longitude) * Math.PI) / 180.0;
    const lat1 = (p1.latitude * Math.PI) / 180.0;
    const lat2 = (p2.latitude * Math.PI) / 180.0;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371000.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  private broadcastTelemetry(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastTelemetryBroadcastMs < 40) {
      return;
    }
    this.lastTelemetryBroadcastMs = now;
    const telemetry = this.getTelemetry();
    this.telemetryListeners.forEach((fn) => fn(telemetry));
  }
}

export const navigationManager = new NavigationManager();
