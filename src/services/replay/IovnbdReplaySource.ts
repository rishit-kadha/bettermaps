/**
 * IovnbdReplaySource
 *
 * Real-Time Virtual Clock Replay Engine for IO-VNBD Benchmark Data.
 *
 * ARCHITECTURAL PRINCIPLE & RESEARCH INTEGRITY:
 * 1. Operates on a virtual replay clock separate from wall-clock time.
 * 2. Replay speed (0.25x to 5x) changes wall-clock pacing only; physical dt
 *    between sensor samples strictly preserves the recorded dataset timestamps.
 * 3. Enforces physical separation between Reference GPS and Estimator IMU.
 * 4. Implements the 5 canonical experiment modes: C0, R0, R1, R2, R3.
 * 5. Guarantees that in R0 and R1, dataset GPS never leaks into the estimator.
 */

import { ImuSample } from "../../core/types/imu";
import { NavLocation } from "../../core/types/location";
import { HybridIdrPositioningEngine } from "../../core/positioning/HybridIdrPositioningEngine";
import { EskfPositioningEngine } from "../../core/positioning/EskfPositioningEngine";
import { ProbabilisticRouteConstraint } from "../../core/positioning/constraints/ProbabilisticRouteConstraint";
import { PreExistingRoute } from "../../core/navigation/routing/RoutingTypes";
import {
  ActiveRoute,
  RouteBounds,
  RoutePoint,
} from "../../core/types/navigation";
import { buildRouteGeometry } from "../../core/navigation/routeGeometry";
import {
  IMotionEstimator,
  KinematicBaselineEstimator,
  LearnedMotionEstimator,
  ModelBackendType,
} from "../../core/positioning/motionEstimator";
import { SihMotionEstimator } from "../../core/positioning/sih/SihMotionEstimator";
import { RouteConstraintProvider } from "../../core/positioning/RouteConstraintProvider";
import { ReplayMetricsTracker } from "./ReplayMetricsTracker";
import {
  EvaluationMode,
  ExperimentMode,
  IovnbdFixture,
  IovnbdSample,
  ReplayClockState,
  ReplaySpeed,
  ReplayTelemetry,
  ReplayTelemetryListener,
} from "./types";
import { LocalRoadNetworkProvider } from "../../adapters/road/LocalRoadNetworkProvider";
import { MultiCandidateRoadMatcher } from "../../core/navigation/road/MultiCandidateRoadMatcher";
import { ProbabilisticRoadConstraint } from "../../core/positioning/constraints/ProbabilisticRoadConstraint";
import { RoadDataManager } from "../../core/navigation/road/RoadDataManager";
import { haversineDistance } from "../../core/positioning/coordinates";
import coventryRoadData from "../../../assets/datasets/road_network_coventry.json";
import { gruOnnxEvaluator } from "../../adapters/ml/GruOnnxEvaluator";

// Import bundled default demo fixture (S1: canonical baseline session)
import s1FixtureData from "../../../assets/datasets/iovnbd_s1.json";

export class IovnbdReplaySource {
  private fixture: IovnbdFixture;
  private clockState: ReplayClockState = "STOPPED";
  private speed: ReplaySpeed = 1.0;
  private experimentMode: ExperimentMode = "R3_DROP_RECOVERY";
  private evaluationMode: EvaluationMode = "FINAL_IDR";

  // Replay Clock
  private currentSampleIndex = 0;
  private virtualTimeMs = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private lastWallClockMs = 0;
  private lastTelemetryBroadcastWallMs = 0;

  // Drop / Recovery Configuration
  private outageStartSec = 20.0;
  private outageDurationSec = 30.0; // 20s to 50s
  private wasInOutage = false;

  // Subsystems
  private positioningEngine: EskfPositioningEngine | HybridIdrPositioningEngine;
  private routeConstraintProvider: RouteConstraintProvider;
  private metricsTracker = new ReplayMetricsTracker();
  private roadDataManager: RoadDataManager | null = null;

  // Static Route Polyline (Pre-trip navigation plan for Experiment R1)
  private staticRoutePoints: { latitude: number; longitude: number }[] = [];
  private replayRoute: ActiveRoute | null = null;

  // Telemetry Listeners
  private telemetryListeners = new Set<ReplayTelemetryListener>();

  // Reference Trajectory History for Map Rendering with Downsampling
  private referenceHistory: { latitude: number; longitude: number }[] = [];
  private estimatedHistory: { latitude: number; longitude: number }[] = [];
  private lastRefRecordTimeMs = -1;
  private lastRefLat = 0;
  private lastRefLon = 0;
  private lastEstRecordTimeMs = -1;
  private lastEstLat = 0;
  private lastEstLon = 0;

  constructor(
    positioningEngine: EskfPositioningEngine | HybridIdrPositioningEngine,
    routeConstraintProvider: RouteConstraintProvider,
  ) {
    this.positioningEngine = positioningEngine;
    this.routeConstraintProvider = routeConstraintProvider;
    this.fixture = s1FixtureData as unknown as IovnbdFixture;

    // REFERENCE LEAKAGE PROTECTION (Directive 6 & 7):
    // Runtime routes MUST be supplied independently. Reference coordinates are strictly
    // reserved for ground-truth evaluation and cannot be mapped into runtime route priors.
    this.staticRoutePoints = [];
    this.positioningEngine.setStaticRoutePoints(null);
    this.positioningEngine.setRouteConstraintProvider(
      this.routeConstraintProvider,
    );
    if ("getRoadConstraint" in this.positioningEngine) {
      (this.positioningEngine as any)
        .getRoadConstraint()
        ?.setEnabled(this.evaluationMode === "FINAL_IDR");
    }

    // Prime first sample so initial position is ready
    if (this.fixture.samples.length > 0) {
      this.initializeFirstSample();
    }
  }

  public getFixture(): IovnbdFixture {
    return this.fixture;
  }

  public getSessionId(): string {
    return this.fixture?.metadata?.session_id ?? "unknown";
  }

  public loadFixture(fixture: IovnbdFixture): void {
    this.pause();
    this.fixture = fixture;

    // Reset virtual clock, sample index, history, and anchor to t0 FIRST
    this.reset();

    // Generate active route to test destination for the newly selected session if route constraint is enabled
    if (this.routeConstraintProvider.getEnabled()) {
      this.generateRouteFromFixture();
    }

    // Consume per-session calibration from fixture metadata.
    // Falls back to empirically determined default (-1.0) for portrait windshield mount
    // if no calibration is embedded (e.g. freshly-recorded live sessions).
    const calibration = (fixture?.metadata as any)?.calibration;
    const yawSign: number = calibration?.yaw_sign ?? -1.0;
    const currentEst = this.positioningEngine.getMotionEstimator();
    if (currentEst && currentEst.backendType) {
      this.setModelBackend(currentEst.backendType, yawSign);
    }
  }

  public setModelBackend(
    backend: ModelBackendType,
    yawSign: number = -1.0,
  ): void {
    if (backend === "kinematic") {
      this.positioningEngine.setMotionEstimator(
        new KinematicBaselineEstimator({ yawChannel: "pitch", yawSign }),
      );
    } else if (backend === "sih_gru") {
      this.positioningEngine.setMotionEstimator(
        new SihMotionEstimator({ yawChannel: "pitch", yawSign }),
      );
    } else if (backend === "gru") {
      this.positioningEngine.setMotionEstimator(
        new LearnedMotionEstimator("gru", {
          yawChannel: "pitch",
          yawSign,
          customEvaluator: (inputTensor) => {
            if (inputTensor.length > 0) {
              gruOnnxEvaluator.pushSample(inputTensor[0]);
            }
            const syncRes = gruOnnxEvaluator.evaluateSync();
            if (syncRes) return syncRes;
            return gruOnnxEvaluator.evaluateAsync().then((asyncRes) => {
              if (!asyncRes) return undefined;
              return {
                forwardVelocity: asyncRes.forwardVelocity,
                yawRate: asyncRes.yawRate,
              };
            });
          },
        }),
      );
    } else {
      this.positioningEngine.setMotionEstimator(
        new LearnedMotionEstimator(backend, { yawChannel: "pitch", yawSign }),
      );
    }
    this.broadcastTelemetry();
  }

  public getDetailedReport() {
    return {
      session: this.getSessionId(),
      experimentMode: this.experimentMode,
      evaluationMode: this.evaluationMode,
      roadConstraintEnabled:
        "getRoadConstraint" in this.positioningEngine
          ? ((this.positioningEngine as any)
              .getRoadConstraint()
              ?.getEnabled() ?? false)
          : false,
      routeConstraintEnabled: this.routeConstraintProvider.getEnabled(),
      roadUpdateCount:
        "getRoadUpdateCount" in this.positioningEngine
          ? (this.positioningEngine as any).getRoadUpdateCount()
          : 0,
      routeUpdateCount:
        "getRouteUpdateCount" in this.positioningEngine
          ? (this.positioningEngine as any).getRouteUpdateCount()
          : 0,
      outageStartSec: this.outageStartSec,
      outageDurationSec: this.outageDurationSec,
      modelBackend: this.positioningEngine.getMotionEstimator().name,
      ...this.metricsTracker.getDetailedReport(),
    };
  }

  public getStaticRoutePoints(): { latitude: number; longitude: number }[] {
    return this.staticRoutePoints;
  }

  public setPreExistingRoute(route: PreExistingRoute | null): void {
    if (route) {
      if ((route as any)._brand === "EvaluationReferenceTrajectory") {
        throw new Error(
          "Reference Leakage Violation: EvaluationReferenceTrajectory cannot be consumed as a runtime route constraint.",
        );
      }
      this.staticRoutePoints = route.polylinePoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      }));
      this.positioningEngine.setStaticRoutePoints(this.staticRoutePoints);
    } else {
      this.staticRoutePoints = [];
      this.positioningEngine.setStaticRoutePoints(null);
    }
  }

  public setRoadDataManager(roadMgr: RoadDataManager | null): void {
    this.roadDataManager = roadMgr;
    if (roadMgr && "setRoadConstraint" in this.positioningEngine) {
      const provider = roadMgr.getRoadNetworkProvider();
      const matcher = new MultiCandidateRoadMatcher(provider);
      const roadConstraint = new ProbabilisticRoadConstraint(matcher);
      roadConstraint.setEnabled(this.evaluationMode === "FINAL_IDR");
      (this.positioningEngine as EskfPositioningEngine).setRoadConstraint(roadConstraint);
    }
  }

  public getRoadDataManager(): RoadDataManager | null {
    return this.roadDataManager;
  }

  public getReferenceHistory(): { latitude: number; longitude: number }[] {
    return this.referenceHistory;
  }

  public getEstimatedHistory(): { latitude: number; longitude: number }[] {
    return this.estimatedHistory;
  }

  public getEvaluationMode(): EvaluationMode {
    return this.evaluationMode;
  }

  public setEvaluationMode(mode: EvaluationMode): void {
    const wasPlaying = this.clockState === "PLAYING";
    this.reset();
    this.evaluationMode = mode;

    // Standard drop & recovery profile for both final configurations
    this.experimentMode =
      mode === "FINAL_IDR" ? "R6_FULL_DROP_RECOVERY" : "R3_DROP_RECOVERY";

    // Strict One-Variable Invariant: Route is ON in both conditions
    const routeActive = true;
    this.routeConstraintProvider.setEnabled(routeActive);
    if ("getRouteConstraint" in this.positioningEngine) {
      (this.positioningEngine as any)
        .getRouteConstraint()
        ?.setEnabled(routeActive);
    }

    // Road is the single ablated variable
    const roadActive = mode === "FINAL_IDR";
    if ("getRoadConstraint" in this.positioningEngine) {
      (this.positioningEngine as any)
        .getRoadConstraint()
        ?.setEnabled(roadActive);
    }

    if (wasPlaying) {
      this.play();
    } else {
      this.broadcastTelemetry();
    }
  }

  public setExperimentMode(mode: ExperimentMode): void {
    const wasPlaying = this.clockState === "PLAYING";
    this.reset();
    this.experimentMode = mode;
    // Configure route constraint state according to experiment definition
    const routeActive =
      mode === "R1_ROUTE_CONSTRAINED" ||
      mode === "R5_IMU_ML_NHC_ROUTE" ||
      mode === "R6_FULL_DROP_RECOVERY";

    this.routeConstraintProvider.setEnabled(routeActive);
    if ("getRouteConstraint" in this.positioningEngine) {
      (this.positioningEngine as any)
        .getRouteConstraint()
        ?.setEnabled(routeActive);
    }

    const roadActive =
      mode === "R4_IMU_ML_NHC_ROAD" || mode === "R6_FULL_DROP_RECOVERY";
    if ("getRoadConstraint" in this.positioningEngine) {
      (this.positioningEngine as any)
        .getRoadConstraint()
        ?.setEnabled(roadActive);
    }

    this.evaluationMode = roadActive ? "FINAL_IDR" : "FINAL_IDR_ROAD_ABLATION";

    if (mode === "R0_IMU_ONLY") {
      this.positioningEngine.setMotionEstimator(
        new KinematicBaselineEstimator({ yawChannel: "pitch" }),
      );
    }

    if (wasPlaying) {
      this.play();
    } else {
      this.broadcastTelemetry();
    }
  }

  public getReplayRoute(): ActiveRoute | null {
    return this.replayRoute;
  }

  public generateRouteFromFixture(): ActiveRoute | null {
    if (!this.fixture?.samples || this.fixture.samples.length < 2) return null;
    const samples = this.fixture.samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first?.reference || !last?.reference) return null;

    // HONEST 2-POINT ROUTE: origin (session start) → destination (final reference coord).
    // Using only the session's known start and end coordinates — no intermediate future
    // reference trajectory waypoints that would constitute GNSS leakage.
    const routePoints: RoutePoint[] = [
      {
        latitude: first.reference.latitude,
        longitude: first.reference.longitude,
      },
      {
        latitude: last.reference.latitude,
        longitude: last.reference.longitude,
      },
    ];
    const lastPt: RoutePoint = routePoints[1];

    const geometry = buildRouteGeometry(routePoints);
    const bounds: RouteBounds = {
      southwest: {
        latitude: Math.min(...routePoints.map((p) => p.latitude)),
        longitude: Math.min(...routePoints.map((p) => p.longitude)),
      },
      northeast: {
        latitude: Math.max(...routePoints.map((p) => p.latitude)),
        longitude: Math.max(...routePoints.map((p) => p.longitude)),
      },
    };

    const activeRoute: ActiveRoute = {
      metadata: {
        id: `replay_route_${this.fixture.metadata?.session_id ?? "S1"}`,
        destinationName: `IO-VNBD Course (${this.fixture.metadata?.session_id ?? "S1"})`,
        destinationAddress: "Coventry, United Kingdom",
        destinationCoordinate: lastPt,
        totalDistanceMeters: geometry.totalLengthMeters,
        totalDurationSeconds: Math.round(geometry.totalLengthMeters / 10),
        bounds,
        isMockRoute: true,
      },
      geometry,
      steps: [
        {
          stepIndex: 0,
          instruction: "Follow test drive course",
          maneuverType: "depart",
          distanceMeters: geometry.totalLengthMeters,
          durationSeconds: Math.round(geometry.totalLengthMeters / 10),
          startPoint: routePoints[0],
          endPoint: lastPt,
          startDistanceAlongRoute: 0,
          endDistanceAlongRoute: geometry.totalLengthMeters,
        },
      ],
    };

    this.replayRoute = activeRoute;

    const normalizedRoute: PreExistingRoute = {
      id: activeRoute.metadata.id,
      name: activeRoute.metadata.destinationName,
      polylinePoints: routePoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
      totalDistanceMeters: activeRoute.metadata.totalDistanceMeters,
      estimatedDurationSeconds: activeRoute.metadata.totalDurationSeconds,
      sourceProvider: "ReplayFixture",
      creationTimestampMs: Date.now(),
    };
    this.staticRoutePoints = routePoints.map((p) => ({
      latitude: p.latitude,
      longitude: p.longitude,
    }));
    this.positioningEngine.setStaticRoutePoints(this.staticRoutePoints);
    if ("getRouteConstraint" in this.positioningEngine) {
      (this.positioningEngine as any).getRouteConstraint()?.setRoute(normalizedRoute);
    }

    if (this.roadDataManager) {
      this.roadDataManager
        .updateRoute({
          id: activeRoute.metadata.id,
          points: activeRoute.geometry.points,
        })
        .catch((e) => {
          console.warn("[IovnbdReplaySource] roadDataManager.updateRoute error:", e);
        });
    }

    return activeRoute;
  }

  private lastRerouteTimeMs = -1;

  private checkDynamicReroute(
    estLat: number,
    estLon: number,
    currentTimeMs: number,
  ): void {
    if (!this.replayRoute || !this.routeConstraintProvider.getEnabled()) return;
    if (
      this.lastRerouteTimeMs >= 0 &&
      currentTimeMs - this.lastRerouteTimeMs < 5000
    ) {
      return;
    }

    const pts = this.replayRoute.geometry.points;
    if (pts.length < 2) return;

    let minDist = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = haversineDistance(
        estLat,
        estLon,
        pts[i].latitude,
        pts[i].longitude,
      );
      if (d < minDist) minDist = d;
    }

    if (minDist > 25.0) {
      this.lastRerouteTimeMs = currentTimeMs;
      const lastPt = pts[pts.length - 1];
      this.recalculateRouteFromCurrentEstimate(
        { latitude: estLat, longitude: estLon },
        lastPt,
      );
    }
  }

  private recalculateRouteFromCurrentEstimate(
    currentPos: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ): void {
    if (!this.fixture?.samples || this.fixture.samples.length < 2) return;

    const samples = this.fixture.samples;
    // Honest reroute: connect current estimated position directly to fixed destination
    // with zero intermediate future reference waypoints.
    const remainingPoints: RoutePoint[] = [currentPos, destination];

    const geometry = buildRouteGeometry(remainingPoints);
    const bounds: RouteBounds = {
      southwest: {
        latitude: Math.min(...remainingPoints.map((p) => p.latitude)),
        longitude: Math.min(...remainingPoints.map((p) => p.longitude)),
      },
      northeast: {
        latitude: Math.max(...remainingPoints.map((p) => p.latitude)),
        longitude: Math.max(...remainingPoints.map((p) => p.longitude)),
      },
    };

    const updatedRoute: ActiveRoute = {
      metadata: {
        id: `reroute_${this.fixture.metadata?.session_id ?? "S1"}_${Date.now()}`,
        destinationName: `Dynamic Course (${this.fixture.metadata?.session_id ?? "S1"})`,
        destinationAddress: "United Kingdom",
        destinationCoordinate: destination,
        totalDistanceMeters: geometry.totalLengthMeters,
        totalDurationSeconds: Math.round(geometry.totalLengthMeters / 10),
        bounds,
        isMockRoute: true,
      },
      geometry,
      steps: [
        {
          stepIndex: 0,
          instruction: "Follow dynamically updated course",
          maneuverType: "depart",
          distanceMeters: geometry.totalLengthMeters,
          durationSeconds: Math.round(geometry.totalLengthMeters / 10),
          startPoint: currentPos,
          endPoint: destination,
          startDistanceAlongRoute: 0,
          endDistanceAlongRoute: geometry.totalLengthMeters,
        },
      ],
    };

    this.replayRoute = updatedRoute;
    const normalizedRoute: PreExistingRoute = {
      id: updatedRoute.metadata.id,
      name: updatedRoute.metadata.destinationName,
      polylinePoints: remainingPoints.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      })),
      totalDistanceMeters: updatedRoute.metadata.totalDistanceMeters,
      estimatedDurationSeconds: updatedRoute.metadata.totalDurationSeconds,
      sourceProvider: "DynamicReplayReroute",
      creationTimestampMs: Date.now(),
    };
    this.staticRoutePoints = remainingPoints;
    this.positioningEngine.setStaticRoutePoints(this.staticRoutePoints);
    if ("getRouteConstraint" in this.positioningEngine) {
      (this.positioningEngine as any)
        .getRouteConstraint()
        ?.setRoute(normalizedRoute);
    }
  }

  public toggleRouteConstraint(): void {
    const nextState = !this.routeConstraintProvider.getEnabled();
    this.routeConstraintProvider.setEnabled(nextState);

    if (nextState) {
      this.generateRouteFromFixture();
    } else {
      this.replayRoute = null;
      if (this.roadDataManager) {
        this.roadDataManager.updateRoute(null).catch(() => {});
      }
    }
    this.broadcastTelemetry();
  }

  public setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
    this.broadcastTelemetry();
  }

  public setOutageInterval(startSec: number, durationSec: number): void {
    this.outageStartSec = startSec;
    this.outageDurationSec = durationSec;
  }

  public play(): void {
    if (this.clockState === "PLAYING") return;

    this.clockState = "PLAYING";
    this.lastWallClockMs = Date.now();

    // If starting from beginning, prime initial state
    if (this.currentSampleIndex === 0 && this.fixture.samples.length > 0) {
      this.initializeFirstSample();
    }

    this.timerId = setInterval(() => {
      this.onTimerTick();
    }, 20); // 50 Hz internal scheduler tick

    this.broadcastTelemetry();
  }

  public pause(): void {
    if (this.clockState !== "PLAYING") return;
    this.clockState = "PAUSED";
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.broadcastTelemetry();
  }

  public reset(): void {
    this.pause();
    this.clockState = "STOPPED";
    this.currentSampleIndex = 0;
    this.virtualTimeMs = 0;
    this.wasInOutage = false;
    this.referenceHistory = [];
    this.estimatedHistory = [];
    this.lastRefRecordTimeMs = -1;
    this.lastRefLat = 0;
    this.lastRefLon = 0;
    this.lastEstRecordTimeMs = -1;
    this.lastEstLat = 0;
    this.lastEstLon = 0;
    this.lastTelemetryBroadcastWallMs = 0;
    this.metricsTracker.reset();
    this.positioningEngine.reset();
    this.positioningEngine.resetGnssDeliveredCount();
    this.lastRerouteTimeMs = -1;
    if (this.fixture.samples.length > 0) {
      this.initializeFirstSample();
      this.generateRouteFromFixture();
    }
    this.broadcastTelemetry();
  }

  public seek(targetTimeMs: number): void {
    const wasPlaying = this.clockState === "PLAYING";
    this.pause();

    this.virtualTimeMs = Math.max(
      0,
      Math.min(targetTimeMs, this.getTotalDurationMs()),
    );

    // Find sample matching targetTimeMs
    let idx = 0;
    while (
      idx < this.fixture.samples.length - 1 &&
      this.fixture.samples[idx + 1].relative_time_ms <= this.virtualTimeMs
    ) {
      idx++;
    }
    this.currentSampleIndex = idx;

    if (wasPlaying) {
      this.play();
    } else {
      this.broadcastTelemetry();
    }
  }

  public getTotalDurationMs(): number {
    if (this.fixture.samples.length === 0) return 0;
    return this.fixture.samples[this.fixture.samples.length - 1]
      .relative_time_ms;
  }

  public addTelemetryListener(listener: ReplayTelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    listener(this.getTelemetry());
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  public getTelemetry(): ReplayTelemetry {
    const currentSample =
      this.currentSampleIndex < this.fixture.samples.length
        ? this.fixture.samples[this.currentSampleIndex]
        : null;

    const metricSnap = this.metricsTracker.getSnapshot();
    const est = this.positioningEngine.getCurrentEstimate();

    const roadConstraintActive =
      "getRoadConstraint" in this.positioningEngine
        ? ((this.positioningEngine as any).getRoadConstraint()?.getEnabled() ??
          false)
        : false;
    const roadUpdateCount =
      "getRoadUpdateCount" in this.positioningEngine
        ? (this.positioningEngine as any).getRoadUpdateCount()
        : 0;
    const routeUpdateCount =
      "getRouteUpdateCount" in this.positioningEngine
        ? (this.positioningEngine as any).getRouteUpdateCount()
        : 0;

    return {
      clockState: this.clockState,
      elapsedTimeMs: this.virtualTimeMs,
      totalDurationMs: this.getTotalDurationMs(),
      speed: this.speed,
      experimentMode: this.experimentMode,
      currentSampleIndex: this.currentSampleIndex,
      totalSamples: this.fixture.samples.length,
      sessionId: this.getSessionId(),
      modelBackendName: this.positioningEngine.getMotionEstimator().name,
      outageStartSec: this.outageStartSec,
      outageDurationSec: this.outageDurationSec,
      referenceCoordinate: currentSample
        ? {
            latitude: currentSample.reference.latitude,
            longitude: currentSample.reference.longitude,
            speedKmh: currentSample.reference.speed_kmh,
            headingDeg: currentSample.reference.heading_deg,
          }
        : null,
      gnssPermittedIntoEstimator: this.isGnssPermittedNow(),
      gnssDeliveredCount: this.positioningEngine.getGnssDeliveredCount(),
      isDeadReckoning: est.isDeadReckoning,
      routeConstraintActive: this.routeConstraintProvider.getEnabled(),
      instantaneousErrorMeters:
        this.experimentMode === "C0_REFERENCE_ONLY"
          ? 0.0
          : metricSnap.instantaneousErrorMeters,
      cumulativeDistanceTraveledM: metricSnap.cumulativeDistanceTraveledM,
      cumulativeDriftPercent:
        this.experimentMode === "C0_REFERENCE_ONLY"
          ? 0.0
          : metricSnap.driftPercent,
      milestoneErrors: metricSnap.milestoneErrors,
      milestoneDrifts: metricSnap.milestoneDrifts,

      evaluationMode: this.evaluationMode,
      roadConstraintEnabled: roadConstraintActive,
      routeConstraintEnabled: this.routeConstraintProvider.getEnabled(),
      roadUpdateCount,
      routeUpdateCount,
      roadCoverageDiagnostics: this.roadDataManager
        ? this.roadDataManager.getCoverageTelemetry()
        : null,
      roadMemoryDiagnostics: this.roadDataManager
        ? this.roadDataManager.getMemoryTelemetry()
        : null,
      // Defensive copies so React sees new array references on reset/session-change,
      // guaranteeing the map polylines are cleared in the same render cycle.
      referenceTrail: [...this.referenceHistory],
      estimatedTrail: [...this.estimatedHistory],
    };
  }

  /**
   * Evaluates whether reference GNSS is permitted to enter the estimator right now.
   * STRICT LEAKAGE RULE:
   * - C0: FALSE (estimator bypassed)
   * - R0: FALSE (GNSS blocked throughout)
   * - R1: FALSE (GNSS blocked throughout)
   * - R2: TRUE (GNSS allowed throughout)
   * - R3: TRUE before outage, FALSE during outage, TRUE after outage
   */
  private isGnssPermittedNow(): boolean {
    if (this.experimentMode === "C0_REFERENCE_ONLY") return false;
    if (
      this.experimentMode === "R0_PURE_DR" ||
      this.experimentMode === "R0_IMU_ONLY"
    )
      return false;
    if (
      this.experimentMode === "R1_ROUTE_CONSTRAINED" ||
      this.experimentMode === "R1_IMU_ML_VEL" ||
      this.experimentMode === "R2_IMU_ML_VEL_YAW" ||
      this.experimentMode === "R3_IMU_ML_NHC" ||
      this.experimentMode === "R4_IMU_ML_NHC_ROAD" ||
      this.experimentMode === "R5_IMU_ML_NHC_ROUTE"
    ) {
      return false;
    }
    if (this.experimentMode === "R2_FULL_GNSS") return true;

    // R3_DROP_RECOVERY or R6_FULL_DROP_RECOVERY
    const elapsedSec = this.virtualTimeMs / 1000.0;
    const outageEndSec = this.outageStartSec + this.outageDurationSec;
    const isInOutage =
      elapsedSec >= this.outageStartSec && elapsedSec < outageEndSec;

    return !isInOutage;
  }

  private initializeFirstSample(): void {
    if (!this.fixture?.samples || this.fixture.samples.length === 0) return;
    const first = this.fixture.samples[0];
    if (!first?.reference) return;

    const initialLocation: NavLocation = {
      latitude: first.reference.latitude,
      longitude: first.reference.longitude,
      altitude: first.phone_gps?.altitude ?? 0,
      speed: (first.reference.speed_kmh ?? 0) / 3.6,
      heading: first.reference.heading_deg ?? 0,
      accuracy: 3.0,
      timestamp: first.sensor_timestamp_ms ?? Date.now(),
      providerType: "gnss",
      isDeadReckoning: false,
    };

    // Anchor the positioning engine at t0
    this.positioningEngine.processGnss(initialLocation);
    this.metricsTracker.recordGnssDelivered(false);

    // Record initial reference point
    this.referenceHistory = [
      {
        latitude: first.reference.latitude,
        longitude: first.reference.longitude,
      },
    ];
    this.estimatedHistory = [
      {
        latitude: first.reference.latitude,
        longitude: first.reference.longitude,
      },
    ];
    this.lastRefRecordTimeMs = 0;
    this.lastRefLat = first.reference.latitude;
    this.lastRefLon = first.reference.longitude;
    this.lastEstRecordTimeMs = 0;
    this.lastEstLat = first.reference.latitude;
    this.lastEstLon = first.reference.longitude;
  }

  private onTimerTick(): void {
    if (this.clockState !== "PLAYING") return;

    const nowWallMs = Date.now();
    const wallDeltaMs = nowWallMs - this.lastWallClockMs;
    this.lastWallClockMs = nowWallMs;

    // Advance virtual replay time by wallDelta * speed
    this.virtualTimeMs += wallDeltaMs * this.speed;

    // Check if we reached the end of the fixture
    if (this.virtualTimeMs >= this.getTotalDurationMs()) {
      this.virtualTimeMs = this.getTotalDurationMs();
      this.pause();
      return;
    }

    // Process all samples up to current virtualTimeMs
    let advanced = false;
    while (
      this.currentSampleIndex < this.fixture.samples.length &&
      this.fixture.samples[this.currentSampleIndex].relative_time_ms <=
        this.virtualTimeMs
    ) {
      this.emitSample(this.fixture.samples[this.currentSampleIndex]);
      this.currentSampleIndex++;
      advanced = true;
    }

    if (advanced) {
      const elapsedSinceBroadcast = nowWallMs - this.lastTelemetryBroadcastWallMs;
      // Visual cadence throttling: at least 33ms interval (~30 Hz)
      if (elapsedSinceBroadcast >= 33) {
        this.lastTelemetryBroadcastWallMs = nowWallMs;
        this.broadcastTelemetry();
      }
    }
  }

  private emitSample(sample: IovnbdSample): void {
    const gnssPermitted = this.isGnssPermittedNow();

    // Track outage start and end events for drop & recovery modes (R3, R6, FINAL_IDR, FINAL_IDR_ROAD_ABLATION)
    const isOutage =
      !gnssPermitted &&
      (this.experimentMode === "R3_DROP_RECOVERY" ||
        this.experimentMode === "R6_FULL_DROP_RECOVERY");
    let outageBoundaryTransition = false;
    if (isOutage && !this.wasInOutage) {
      this.positioningEngine.onGnssBlocked();
      this.metricsTracker.notifyOutageStarted(sample.relative_time_ms);
      this.wasInOutage = true;
      outageBoundaryTransition = true;
    } else if (!isOutage && this.wasInOutage) {
      this.metricsTracker.notifyOutageEnded(sample.relative_time_ms);
      this.wasInOutage = false;
      outageBoundaryTransition = true;
    }

    // 1. Construct normalized ImuSample (preserving original timestamps and units)
    const imuSample: ImuSample = {
      timestamp: sample.sensor_timestamp_ms,
      accel: {
        x: sample.accel.x,
        y: sample.accel.y,
        z: sample.accel.z,
      },
      gyro: {
        x: sample.gyro.roll,
        y: sample.gyro.pitch, // In IO-VNBD portrait mount, pitch is vehicle yaw
        z: sample.gyro.yaw,
      },
      magnetometer: {
        x: sample.mag.x,
        y: sample.mag.y,
        z: sample.mag.z,
      },
    };

    // 2. Construct reference NavLocation
    const refLat = sample.reference?.latitude ?? 0;
    const refLon = sample.reference?.longitude ?? 0;
    const refSpeed = (sample.reference?.speed_kmh ?? 0) / 3.6;
    const refHeading = sample.reference?.heading_deg ?? 0;

    const refLocation: NavLocation = {
      latitude: refLat,
      longitude: refLon,
      altitude: sample.phone_gps?.altitude ?? 0,
      speed: refSpeed,
      heading: refHeading,
      accuracy: 3.0,
      timestamp: sample.sensor_timestamp_ms ?? Date.now(),
      providerType: "gnss",
      isDeadReckoning: false,
    };

    // 3. Process through PositioningEngine according to Experiment Mode
    let estLat = refLat;
    let estLon = refLon;
    let estSpeed = refSpeed;
    let estHeading = refHeading;

    if (this.experimentMode === "C0_REFERENCE_ONLY") {
      // C0 is Reference-Only Control: zero estimation error, validates reference track
      estLat = sample.reference.latitude;
      estLon = sample.reference.longitude;
    } else if (gnssPermitted) {
      // When GNSS to estimator is permitted, ALWAYS follow it!
      this.positioningEngine.processGnss(refLocation);
      this.metricsTracker.recordGnssDelivered(false);
      // Continuous background IMU propagation maintains bias & orientation filter readiness
      this.positioningEngine.processImu(imuSample);
      estLat = refLat;
      estLon = refLon;
      estSpeed = refSpeed;
      estHeading = refHeading;
    } else {
      // ONLY when GNSS is not available, fall back to our estimator and models!
      const est = this.positioningEngine.processImu(imuSample);
      if (est) {
        estLat = est.latitude;
        estLon = est.longitude;
        if (est.speed !== undefined && est.speed !== null) {
          estSpeed = est.speed;
        }
        if (est.heading !== undefined && est.heading !== null) {
          estHeading = est.heading;
        }
        this.checkDynamicReroute(estLat, estLon, sample.relative_time_ms);
      }
    }

    // 4. Update Reference and Estimated History Trails for Map with Downsampling
    // Downsamples continuous 100 Hz streams to points spaced >= 1.0m or >= 100ms
    // Eliminates continuous array slicing and allocation on every sample tick.
    const sampleTimeMs = sample.relative_time_ms;

    const dRefLat = (refLat - this.lastRefLat) * 111139;
    const cosRef = Math.cos((refLat * Math.PI) / 180);
    const dRefLon = (refLon - this.lastRefLon) * 111139 * cosRef;
    const refDistSq = dRefLat * dRefLat + dRefLon * dRefLon;

    if (
      this.referenceHistory.length === 0 ||
      refDistSq >= 1.0 ||
      sampleTimeMs - this.lastRefRecordTimeMs >= 100
    ) {
      this.referenceHistory.push({
        latitude: refLat,
        longitude: refLon,
      });
      if (this.referenceHistory.length > 500) {
        this.referenceHistory.shift();
      }
      this.lastRefRecordTimeMs = sampleTimeMs;
      this.lastRefLat = refLat;
      this.lastRefLon = refLon;
    }

    const dEstLat = (estLat - this.lastEstLat) * 111139;
    const cosEst = Math.cos((estLat * Math.PI) / 180);
    const dEstLon = (estLon - this.lastEstLon) * 111139 * cosEst;
    const estDistSq = dEstLat * dEstLat + dEstLon * dEstLon;

    if (
      this.estimatedHistory.length === 0 ||
      estDistSq >= 1.0 ||
      sampleTimeMs - this.lastEstRecordTimeMs >= 100
    ) {
      this.estimatedHistory.push({
        latitude: estLat,
        longitude: estLon,
      });
      if (this.estimatedHistory.length > 500) {
        this.estimatedHistory.shift();
      }
      this.lastEstRecordTimeMs = sampleTimeMs;
      this.lastEstLat = estLat;
      this.lastEstLon = estLon;
    }

    // 5. Update RoadDataManager position for prefetch
    if (this.roadDataManager) {
      this.roadDataManager
        .updatePosition(
          { latitude: estLat, longitude: estLon },
          estSpeed,
          estHeading,
        )
        .catch((err) => {
          console.warn(
            "[IovnbdReplaySource] RoadDataManager updatePosition failed:",
            err,
          );
        });
    }

    // 6. Update Metrics Tracker
    if (sample.reference) {
      this.metricsTracker.update(
        refLat,
        refLon,
        estLat,
        estLon,
        sample.relative_time_ms,
        !gnssPermitted,
      );
    }

    // Force immediate broadcast on outage transitions so HUD/UI syncs immediately
    if (outageBoundaryTransition) {
      this.lastTelemetryBroadcastWallMs = Date.now();
      this.broadcastTelemetry();
    }
  }

  public getCurrentEstimatedLocation(): NavLocation | null {
    if (!this.fixture?.samples || this.fixture.samples.length === 0) return null;
    const sampleIdx = Math.min(
      Math.max(0, this.currentSampleIndex),
      this.fixture.samples.length - 1,
    );
    const currentSample = this.fixture.samples[sampleIdx];
    if (!currentSample?.reference) return null;
    const est = this.positioningEngine.getCurrentEstimate();

    if (this.experimentMode === "C0_REFERENCE_ONLY" || !est.valid) {
      return {
        latitude: currentSample.reference.latitude,
        longitude: currentSample.reference.longitude,
        altitude: currentSample.phone_gps?.altitude ?? null,
        speed: (currentSample.reference.speed_kmh ?? 0) / 3.6,
        heading: currentSample.reference.heading_deg ?? 0,
        accuracy: 3.0,
        timestamp: currentSample.sensor_timestamp_ms ?? Date.now(),
        providerType: "mock",
        isDeadReckoning: false,
      };
    }

    return {
      latitude: est.latitude,
      longitude: est.longitude,
      altitude: est.altitude ?? null,
      speed: est.speed ?? null,
      heading: est.heading ?? null,
      accuracy: est.horizontal_accuracy ?? null,
      timestamp: est.timestamp_ms,
      providerType: "mock",
      isDeadReckoning: est.isDeadReckoning,
    };
  }

  public getPositioningEngine():
    | EskfPositioningEngine
    | HybridIdrPositioningEngine {
    return this.positioningEngine;
  }

  public getRouteConstraintProvider(): RouteConstraintProvider {
    return this.routeConstraintProvider;
  }

  private broadcastTelemetry(): void {
    const tel = this.getTelemetry();
    this.telemetryListeners.forEach((listener) => {
      try {
        listener(tel);
      } catch (err) {
        console.error("Error in ReplayTelemetryListener:", err);
      }
    });
  }
}

// Shared Singleton Factory
const defaultBaselineEstimator = new LearnedMotionEstimator("gru", {
  yawChannel: "pitch",
  yawSign: -1.0,
  customEvaluator: (inputTensor) => {
    if (inputTensor.length > 0) {
      gruOnnxEvaluator.pushSample(inputTensor[0]);
    }
    const syncRes = gruOnnxEvaluator.evaluateSync();
    if (syncRes) return syncRes;
    return gruOnnxEvaluator.evaluateAsync().then((asyncRes) => {
      if (!asyncRes) return undefined;
      return {
        forwardVelocity: asyncRes.forwardVelocity,
        yawRate: asyncRes.yawRate,
      };
    });
  },
});
const defaultRouteConstraintProvider = new RouteConstraintProvider();
const defaultRouteConstraint = new ProbabilisticRouteConstraint();
const defaultRoadProvider = new LocalRoadNetworkProvider(coventryRoadData);
const defaultRoadMatcher = new MultiCandidateRoadMatcher(defaultRoadProvider);
const defaultRoadConstraint = new ProbabilisticRoadConstraint(
  defaultRoadMatcher,
);

export const defaultEskfEngine = new EskfPositioningEngine({
  motionEstimator: defaultBaselineEstimator,
  routeConstraint: defaultRouteConstraint,
  roadConstraint: defaultRoadConstraint,
});

export const iovnbdReplaySource = new IovnbdReplaySource(
  defaultEskfEngine,
  defaultRouteConstraintProvider,
);
