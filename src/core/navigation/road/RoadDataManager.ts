/**
 * RoadDataManager.ts
 *
 * Background orchestration layer for dynamic road network acquisition, prefetching,
 * caching, spatial index synchronization, and bounded memory management.
 *
 * Responsibilities:
 * - Coordinates RouteCoveragePlanner (Mode 1) and FreeDriveCoveragePlanner (Mode 2).
 * - Manages route deviation transitions (Route -> Deviation -> Reroute).
 * - Enforces source priority:
 *     1. Active RAM (LocalRoadNetworkProvider)
 *     2. Installed Offline Region Pack (OfflineRegionPackManager)
 *     3. Persistent Local Cache (IRoadCache L2)
 *     4. Network Source (IRoadDataSource)
 *     5. Unavailable / Degraded
 * - Implements coverage coalescing to decouple coverage planning from raw 100 Hz IMU ticks.
 * - Enforces strict RAM cache budget with prioritized memory eviction (obsolete/rear first).
 * - Exposes rich diagnostics for UI, replay observability, and telemetry.
 *
 * ARCHITECTURAL INVARIANT:
 * Zero calls from EskfPositioningEngine.processImu() or any estimator code.
 * The estimator only sees the synchronous in-memory LocalRoadNetworkProvider.
 */

import {
  RouteCoveragePlanner,
  RouteCoverageInput,
  RouteCoveragePlan,
} from "./RouteCoveragePlanner";
import {
  FreeDriveCoveragePlanner,
  FreeDriveCoveragePlan,
} from "./FreeDriveCoveragePlanner";
import { IRoadDataSource } from "./IRoadDataSource";
import { IRoadCache } from "./IRoadCache";
import {
  RoadTile,
  serializeTileKey,
  TileKey,
} from "./RoadTileTypes";
import { LocalRoadNetworkProvider } from "../../../adapters/road/LocalRoadNetworkProvider";
import { LatLonAlt } from "../routing/RoutingTypes";
import {
  OfflineRegionPackManager,
  offlineRegionPackManager,
} from "../../../adapters/road/OfflineRegionPackManager";
import {
  RoadCoverageTelemetry,
  RoadMemoryTelemetry,
} from "../../types/navigation";

export type RoadDataManagerMode =
  | "NONE"
  | "FREE_DRIVE"
  | "ROUTE"
  | "ROUTE_DEVIATION";

export type RoadCoverageState =
  | "COMPLETE"
  | "PARTIAL"
  | "FETCHING"
  | "OFFLINE"
  | "UNAVAILABLE";

export type MemoryPressureState = "NORMAL" | "PRESSURE" | "AGGRESSIVE";

export interface RoadDataManagerConfig {
  /** Minimum distance vehicle must move before recalculating coverage (default 25m) */
  displacementThresholdMeters: number;
  /** Heading change threshold before recalculating coverage (default 25 deg) */
  headingThresholdDeg: number;
  /** Speed delta threshold triggering recalculation (default 5.0 m/s) */
  speedTransitionThresholdMps: number;
  /** Heartbeat interval to force coverage check (default 1000ms) */
  heartbeatIntervalMs: number;
  /** Maximum active RAM budget for road tiles in bytes (default 15 MB) */
  maxActiveRoadRamBytes: number;
  /** Fraction of RAM budget where pressure triggers (default 0.70) */
  pressureThresholdFraction: number;
  /** Fraction of RAM budget where aggressive eviction triggers (default 0.85) */
  aggressiveThresholdFraction: number;
  /** Minimum tiles to retain around vehicle even under aggressive pressure (default 3) */
  minTilesToRetain: number;
}

export const DEFAULT_ROAD_DATA_CONFIG: RoadDataManagerConfig = {
  displacementThresholdMeters: 25.0,
  headingThresholdDeg: 25.0,
  speedTransitionThresholdMps: 5.0,
  heartbeatIntervalMs: 1000.0,
  maxActiveRoadRamBytes: 15 * 1024 * 1024, // 15 MB
  pressureThresholdFraction: 0.7,
  aggressiveThresholdFraction: 0.85,
  minTilesToRetain: 3,
};

export interface RoadDataManagerDiagnostics {
  mode: RoadDataManagerMode;
  coverageState: RoadCoverageState;
  activeRouteId: string | null;
  requestedTileCount: number;
  loadedTileCount: number;
  pendingTileCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  packHitCount: number;
  sourceFailureCount: number;
  activeTileKeys: string[];
  lastAcquisitionTimestampMs: number | null;
  isOffRoute: boolean;
  crossTrackDistanceMeters: number;
  memoryPressure: MemoryPressureState;
  ramRoadBytes: number;
  ramBudgetBytes: number;
  evictionCount: number;
  lastEvictionKey: string | null;
}

export interface RoadDataManagerOptions extends Partial<RoadDataManagerConfig> {
  routePlanner?: RouteCoveragePlanner;
  freeDrivePlanner?: FreeDriveCoveragePlanner;
  dataSource?: IRoadDataSource;
  cache?: IRoadCache;
  provider?: LocalRoadNetworkProvider;
  regionPackManager?: OfflineRegionPackManager;
  config?: Partial<RoadDataManagerConfig>;
}

export class RoadDataManager {
  private readonly routePlanner: RouteCoveragePlanner;
  private readonly freeDrivePlanner: FreeDriveCoveragePlanner;
  private readonly dataSource?: IRoadDataSource;
  private readonly cache?: IRoadCache;
  private readonly provider: LocalRoadNetworkProvider;
  private readonly regionPackManager: OfflineRegionPackManager;
  private readonly config: RoadDataManagerConfig;

  private mode: RoadDataManagerMode = "FREE_DRIVE";
  private coverageState: RoadCoverageState = "COMPLETE";
  private activeRouteId: string | null = null;
  private isOffRoute = false;
  private lastCrossTrackM = 0.0;

  // Source attribution & anchor tracking
  private sourcePosition: "LIVE" | "REPLAY" = "LIVE";
  private currentVehiclePosition: LatLonAlt | null = null;
  private lastCoverageAnchor: LatLonAlt | null = null;
  private lastCoverageHeading = 0.0;
  private lastCoverageSpeed = 0.0;
  private lastCoveragePlanTimestampMs = 0;

  // Telemetry & metrics
  private cacheHitCount = 0;
  private cacheMissCount = 0;
  private packHitCount = 0;
  private sourceFailureCount = 0;
  private lastAcquisitionTimestampMs: number | null = null;
  private evictionCount = 0;
  private lastEvictionKey: string | null = null;
  private memoryPressure: MemoryPressureState = "NORMAL";
  private coalescedSkipCount = 0;
  private lastTriggerReason = "INIT";

  // In-flight acquisition deduplication map: serializedKey -> Promise<RoadTile | null>
  private readonly inFlightRequests: Map<string, Promise<RoadTile | null>> =
    new Map();

  // Currently required keys from the latest planner execution
  private latestRequiredKeys: Map<string, TileKey> = new Map();

  private readonly roadDataListeners = new Set<() => void>();

  private isRunning = false;

  constructor(options?: RoadDataManagerOptions) {
    this.routePlanner = options?.routePlanner ?? new RouteCoveragePlanner();
    this.freeDrivePlanner =
      options?.freeDrivePlanner ?? new FreeDriveCoveragePlanner();
    this.dataSource = options?.dataSource;
    this.cache = options?.cache;
    this.provider = options?.provider ?? new LocalRoadNetworkProvider();
    this.regionPackManager =
      options?.regionPackManager ?? offlineRegionPackManager;
    this.config = {
      ...DEFAULT_ROAD_DATA_CONFIG,
      ...options,
      ...options?.config,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Control
  // ---------------------------------------------------------------------------

  public async start(): Promise<void> {
    this.isRunning = true;
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.inFlightRequests.clear();
    this.latestRequiredKeys.clear();
    this.mode = "NONE";
  }

  public setSourcePosition(source: "LIVE" | "REPLAY"): void {
    if (this.sourcePosition !== source) {
      this.sourcePosition = source;
      // Force immediate re-evaluation on source switch
      this.lastCoverageAnchor = null;
    }
  }

  public getSourcePosition(): "LIVE" | "REPLAY" {
    return this.sourcePosition;
  }

  // ---------------------------------------------------------------------------
  // Navigation & Route Events
  // ---------------------------------------------------------------------------

  public async updateRoute(route: RouteCoverageInput | null): Promise<void> {
    this.routePlanner.setRoute(route);

    if (route && route.points.length >= 2) {
      this.mode = "ROUTE";
      this.activeRouteId = route.id ?? "active_route";
      this.isOffRoute = false;
      this.lastCrossTrackM = 0.0;
      this.lastCoverageAnchor = null; // Force plan

      const corridorKeys = this.routePlanner.computeCorridorTileKeys();
      if (corridorKeys.length > 0) {
        const initialBatch = corridorKeys.slice(0, 5);
        await this.acquireTiles(initialBatch);
      }
    } else {
      this.mode = "FREE_DRIVE";
      this.activeRouteId = null;
      this.isOffRoute = false;
      this.lastCrossTrackM = 0.0;
      this.lastCoverageAnchor = null; // Force plan
    }
  }

  /**
   * Updates vehicle kinematic state with COALESCING policy.
   * If movement is within thresholds, skips heavy coverage planning.
   * Executes completely asynchronously outside the estimator loop.
   */
  public async updatePosition(
    pos: LatLonAlt,
    speedMps: number,
    headingDeg: number,
  ): Promise<void> {
    this.currentVehiclePosition = { ...pos };

    if (!this.isRunning && this.mode === "NONE") {
      this.isRunning = true;
      this.mode = this.activeRouteId ? "ROUTE" : "FREE_DRIVE";
    }

    const now = Date.now();

    // -------------------------------------------------------------------------
    // Coverage Coalescing Check
    // -------------------------------------------------------------------------
    if (this.lastCoverageAnchor) {
      const dPos = this.calculateDistanceMeters(this.lastCoverageAnchor, pos);
      const dHeading = Math.abs(this.lastCoverageHeading - headingDeg);
      const dSpeed = Math.abs(this.lastCoverageSpeed - speedMps);
      const dt = now - this.lastCoveragePlanTimestampMs;

      if (
        dPos < this.config.displacementThresholdMeters &&
        dHeading < this.config.headingThresholdDeg &&
        dSpeed < this.config.speedTransitionThresholdMps &&
        dt < this.config.heartbeatIntervalMs
      ) {
        // Position change is small and heartbeat has not expired — skip re-planning
        this.coalescedSkipCount++;
        return;
      }

      if (dPos >= this.config.displacementThresholdMeters) {
        this.lastTriggerReason = `DISPLACEMENT (${dPos.toFixed(1)}m)`;
      } else if (dHeading >= this.config.headingThresholdDeg) {
        this.lastTriggerReason = `HEADING (${dHeading.toFixed(1)}°)`;
      } else if (dSpeed >= this.config.speedTransitionThresholdMps) {
        this.lastTriggerReason = `SPEED (${dSpeed.toFixed(1)}m/s)`;
      } else {
        this.lastTriggerReason = `HEARTBEAT (${dt}ms)`;
      }
    } else {
      this.lastTriggerReason = "INITIAL_ANCHOR";
    }

    // Update anchor
    this.lastCoverageAnchor = { ...pos };
    this.lastCoverageHeading = headingDeg;
    this.lastCoverageSpeed = speedMps;
    this.lastCoveragePlanTimestampMs = now;

    // Evaluate memory pressure before planning
    this.evaluateMemoryPressure();

    let requiredKeys: TileKey[] = [];

    if (this.mode === "ROUTE" || this.mode === "ROUTE_DEVIATION") {
      const routePlan: RouteCoveragePlan = this.routePlanner.planCoverage(
        pos,
        speedMps,
        headingDeg,
      );

      this.isOffRoute = routePlan.isOffRoute;
      this.lastCrossTrackM = routePlan.crossTrackDistanceMeters;

      if (routePlan.isOffRoute) {
        this.mode = "ROUTE_DEVIATION";
        const freeDrivePlan = this.freeDrivePlanner.planCoverage(
          pos,
          speedMps,
          headingDeg,
        );

        const combined = new Map<string, TileKey>();
        for (const k of freeDrivePlan.requiredTileKeys) {
          combined.set(serializeTileKey(k), k);
        }
        for (const k of routePlan.activeTileKeys) {
          combined.set(serializeTileKey(k), k);
        }
        requiredKeys = Array.from(combined.values());
      } else {
        this.mode = "ROUTE";
        requiredKeys = routePlan.requiredTileKeys;
      }
    } else {
      // FREE DRIVE MODE
      this.mode = "FREE_DRIVE";
      this.isOffRoute = false;
      this.lastCrossTrackM = 0.0;

      // In AGGRESSIVE memory pressure, shorten lookahead to conserve RAM
      const plan = this.freeDrivePlanner.planCoverage(
        pos,
        this.memoryPressure === "AGGRESSIVE" ? Math.min(speedMps, 3.0) : speedMps,
        headingDeg,
      );
      requiredKeys = plan.requiredTileKeys;
    }

    // Update internal tracking
    this.latestRequiredKeys.clear();
    for (const k of requiredKeys) {
      this.latestRequiredKeys.set(serializeTileKey(k), k);
    }

    // Reconcile with active provider
    await this.reconcileActiveTiles(requiredKeys);
  }

  // ---------------------------------------------------------------------------
  // Tile Reconciliation & Memory Management
  // ---------------------------------------------------------------------------

  private async reconcileActiveTiles(requiredKeys: TileKey[]): Promise<void> {
    const diag = this.provider.getDiagnostics();
    const loadedKeysSet = new Set(diag.loadedTileKeys);
    const requiredKeysSet = new Set(requiredKeys.map(serializeTileKey));

    // 1. Evict obsolete tiles: loaded tiles no longer in the required set
    let evictedAny = false;
    for (const loadedKeyStr of loadedKeysSet) {
      if (!requiredKeysSet.has(loadedKeyStr)) {
        const colonIdx = loadedKeyStr.indexOf(":");
        const scheme = colonIdx !== -1 ? loadedKeyStr.slice(0, colonIdx) : "deg";
        const key = colonIdx !== -1 ? loadedKeyStr.slice(colonIdx + 1) : loadedKeyStr;
        this.provider.evictTile({ scheme, key });
        this.evictionCount++;
        this.lastEvictionKey = loadedKeyStr;
        evictedAny = true;
      }
    }
    if (evictedAny) {
      this.notifyRoadDataChanged();
    }

    // 2. Identify missing required tiles
    const missingKeys: TileKey[] = [];
    for (const reqKey of requiredKeys) {
      const serialized = serializeTileKey(reqKey);
      if (!this.provider.hasTile(reqKey)) {
        missingKeys.push(reqKey);
      }
    }

    // 3. Acquire missing tiles (if not under aggressive memory clamp)
    if (missingKeys.length > 0) {
      this.coverageState = "FETCHING";
      await this.acquireTiles(missingKeys);
    }

    // 4. Memory Pressure Check & Prioritized Eviction
    this.enforceMemoryBudget();

    // 5. Update final coverage state
    this.updateCoverageState();
  }

  private evaluateMemoryPressure(): void {
    const currentRam = this.provider.getTotalRamBytes();
    const maxRam = this.config.maxActiveRoadRamBytes;
    const ratio = maxRam > 0 ? currentRam / maxRam : 0;

    if (ratio >= this.config.aggressiveThresholdFraction) {
      this.memoryPressure = "AGGRESSIVE";
    } else if (ratio >= this.config.pressureThresholdFraction) {
      this.memoryPressure = "PRESSURE";
    } else {
      this.memoryPressure = "NORMAL";
    }
  }

  private enforceMemoryBudget(): void {
    this.evaluateMemoryPressure();
    if (this.memoryPressure === "NORMAL") return;

    let currentRam = this.provider.getTotalRamBytes();
    const targetRam =
      this.config.maxActiveRoadRamBytes * this.config.pressureThresholdFraction;

    if (currentRam <= targetRam) return;

    // Prioritized eviction: evict tiles farthest from current vehicle position
    const loadedKeys = this.provider.getLoadedTileKeys();
    if (loadedKeys.length <= this.config.minTilesToRetain) return;

    const currentPos = this.currentVehiclePosition;
    if (!currentPos) return;

    // Sort loaded tiles by distance from vehicle (descending: farthest first)
    const scoredTiles = loadedKeys.map((k) => {
      const dist = this.estimateTileDistance(k, currentPos);
      const isRequired = this.latestRequiredKeys.has(serializeTileKey(k));
      // Non-required tiles have enormous distance score to evict first
      const priorityScore = isRequired ? dist : dist + 100000.0;
      return { key: k, score: priorityScore };
    });

    scoredTiles.sort((a, b) => b.score - a.score);

    let budgetEvicted = false;
    for (const item of scoredTiles) {
      if (this.provider.getLoadedTileCount() <= this.config.minTilesToRetain) {
        break;
      }
      if (this.provider.getTotalRamBytes() <= targetRam) {
        break;
      }

      this.provider.evictTile(item.key);
      this.evictionCount++;
      this.lastEvictionKey = serializeTileKey(item.key);
      budgetEvicted = true;
    }

    if (budgetEvicted) {
      this.notifyRoadDataChanged();
    }

    this.evaluateMemoryPressure();
  }

  private estimateTileDistance(key: TileKey, pos: LatLonAlt): number {
    if (key.scheme === "deg") {
      const parts = key.key.split(":");
      if (parts.length === 3) {
        const step = parseInt(parts[0], 10) / 10000.0;
        const latIdx = parseInt(parts[1], 10);
        const lonIdx = parseInt(parts[2], 10);
        const tileCenterLat = (latIdx + 0.5) * step;
        const tileCenterLon = (lonIdx + 0.5) * step;
        return this.calculateDistanceMeters(pos, {
          latitude: tileCenterLat,
          longitude: tileCenterLon,
        });
      }
    }
    return 1000.0;
  }

  private isTileCoveredByInstalledPack(key: TileKey): boolean {
    if (!this.regionPackManager) return false;
    if (this.regionPackManager.hasTile(key)) return true;

    if (key.scheme === "deg") {
      const parts = key.key.split(":");
      if (parts.length === 3) {
        const step = parseInt(parts[0], 10) / 10000.0;
        const latIdx = parseInt(parts[1], 10);
        const lonIdx = parseInt(parts[2], 10);
        const lat = (latIdx + 0.5) * step;
        const lon = (lonIdx + 0.5) * step;
        const pack = this.regionPackManager.findPackForCoordinate({
          latitude: lat,
          longitude: lon,
        });
        if (pack) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Source Priority Tile Acquisition
  // ---------------------------------------------------------------------------

  private async acquireTiles(keys: TileKey[]): Promise<void> {
    const promises: Array<Promise<void>> = [];

    for (const key of keys) {
      const serialized = serializeTileKey(key);

      // Deduplicate in-flight requests
      if (this.inFlightRequests.has(serialized)) {
        continue;
      }

      const fetchPromise = this.acquireSingleTile(key);
      this.inFlightRequests.set(serialized, fetchPromise);

      promises.push(
        fetchPromise
          .then((tile) => {
            this.inFlightRequests.delete(serialized);
            if (tile) {
              this.provider.registerTile(tile);
              this.lastAcquisitionTimestampMs = Date.now();
              this.notifyRoadDataChanged();
            }
          })
          .catch((err) => {
            this.inFlightRequests.delete(serialized);
            this.sourceFailureCount++;
            console.warn(`[RoadDataManager] Failed to acquire tile ${serialized}:`, err);
          }),
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Enforces strict source lookup priority:
   * 1. Active Memory (already checked in provider)
   * 2. Installed Offline Region Pack (disk / local asset)
   * 3. Persistent Cache (L2)
   * 4. Network Source (Overpass API)
   * 5. Unavailable
   */
  private async acquireSingleTile(key: TileKey): Promise<RoadTile | null> {
    // -------------------------------------------------------------------------
    // Priority 2: Installed Offline Region Pack
    // -------------------------------------------------------------------------
    if (this.regionPackManager && this.regionPackManager.hasTile(key)) {
      try {
        const packTile = await this.regionPackManager.loadTile(key);
        if (packTile) {
          this.packHitCount++;
          // Never query network if tile exists in installed offline pack!
          return packTile;
        }
      } catch (err) {
        console.warn("[RoadDataManager] Offline region pack lookup failed:", err);
      }
    }

    // If the vehicle is inside an installed offline regional pack, or the tile is
    // within the pack's bounding box, do NOT query the network — the offline pack
    // is the authoritative data source for this geographic region.
    if (this.regionPackManager) {
      if (this.isTileCoveredByInstalledPack(key)) {
        return null;
      }
      if (
        this.currentVehiclePosition &&
        this.regionPackManager.findPackForCoordinate(this.currentVehiclePosition)
      ) {
        return null;
      }
    }

    // -------------------------------------------------------------------------
    // Priority 3: Persistent Local Cache (L2)
    // -------------------------------------------------------------------------
    if (this.cache) {
      try {
        const cached = await this.cache.getTile(key);
        if (cached) {
          this.cacheHitCount++;
          return cached;
        }
        this.cacheMissCount++;
      } catch (err) {
        console.warn("[RoadDataManager] Cache lookup failed:", err);
      }
    }

    // -------------------------------------------------------------------------
    // Priority 4: External Network Source (Overpass API)
    // -------------------------------------------------------------------------
    if (this.dataSource) {
      if (typeof (this.dataSource as any).isAvailable === "function") {
        try {
          const available = await (this.dataSource as any).isAvailable();
          if (!available) {
            return null;
          }
        } catch {
          return null;
        }
      }

      try {
        const fetched = await this.dataSource.fetchTile(key);
        if (fetched) {
          if (this.cache) {
            this.cache.putTile(fetched).catch((err) => {
              console.warn("[RoadDataManager] Failed to cache fetched tile:", err);
            });
          }
          return fetched;
        }
      } catch (err) {
        this.sourceFailureCount++;
        console.warn("[RoadDataManager] Data source fetch failed:", err);
      }
    }

    return null;
  }

  private updateCoverageState(): void {
    const diag = this.provider.getDiagnostics();
    const reqCount = this.latestRequiredKeys.size;
    const loadedCount = diag.loadedTileCount;

    if (this.inFlightRequests.size > 0) {
      this.coverageState = "FETCHING";
    } else if (reqCount > 0 && loadedCount >= reqCount) {
      this.coverageState = "COMPLETE";
    } else if (loadedCount > 0) {
      this.coverageState = "PARTIAL";
    } else if (this.dataSource && !this.dataSource.isAvailable()) {
      this.coverageState = "OFFLINE";
    } else {
      this.coverageState = "UNAVAILABLE";
    }
  }

  private calculateDistanceMeters(p1: LatLonAlt, p2: LatLonAlt): number {
    const R = 6371000.0;
    const phi1 = (p1.latitude * Math.PI) / 180.0;
    const phi2 = (p2.latitude * Math.PI) / 180.0;
    const dPhi = phi2 - phi1;
    const dLambda = ((p2.longitude - p1.longitude) * Math.PI) / 180.0;
    const a =
      Math.sin(dPhi / 2.0) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2.0) ** 2;
    return 2.0 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  }

  // ---------------------------------------------------------------------------
  // Public Accessors & Extended Telemetry
  // ---------------------------------------------------------------------------

  public getRoadNetworkProvider(): LocalRoadNetworkProvider {
    return this.provider;
  }

  public getRegionPackManager(): OfflineRegionPackManager {
    return this.regionPackManager;
  }

  public getCoverageState(): RoadCoverageState {
    return this.coverageState;
  }

  public getMode(): RoadDataManagerMode {
    return this.mode;
  }

  public getMemoryPressure(): MemoryPressureState {
    return this.memoryPressure;
  }

  public getEvictionCount(): number {
    return this.evictionCount;
  }

  public addRoadDataListener(listener: () => void): () => void {
    this.roadDataListeners.add(listener);
    return () => {
      this.roadDataListeners.delete(listener);
    };
  }

  private notifyRoadDataChanged(): void {
    for (const listener of this.roadDataListeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[RoadDataManager] roadDataListener error:", err);
      }
    }
  }

  public getDiagnostics(): RoadDataManagerDiagnostics {
    const diag = this.provider.getDiagnostics();
    return {
      mode: this.mode,
      coverageState: this.coverageState,
      activeRouteId: this.activeRouteId,
      requestedTileCount: this.latestRequiredKeys.size,
      loadedTileCount: diag.loadedTileCount,
      pendingTileCount: this.inFlightRequests.size,
      cacheHitCount: this.cacheHitCount,
      cacheMissCount: this.cacheMissCount,
      packHitCount: this.packHitCount,
      sourceFailureCount: this.sourceFailureCount,
      activeTileKeys: [...diag.loadedTileKeys],
      lastAcquisitionTimestampMs: this.lastAcquisitionTimestampMs,
      isOffRoute: this.isOffRoute,
      crossTrackDistanceMeters: this.lastCrossTrackM,
      memoryPressure: this.memoryPressure,
      ramRoadBytes: this.provider.getTotalRamBytes(),
      ramBudgetBytes: this.config.maxActiveRoadRamBytes,
      evictionCount: this.evictionCount,
      lastEvictionKey: this.lastEvictionKey,
    };
  }

  public getCoverageTelemetry(
    roadCandidatesCount = 0,
    roadUpdateCount = 0,
  ): RoadCoverageTelemetry {
    const diag = this.provider.getDiagnostics();
    return {
      sourcePosition: this.sourcePosition,
      currentPosition: this.currentVehiclePosition
        ? {
            latitude: this.currentVehiclePosition.latitude,
            longitude: this.currentVehiclePosition.longitude,
          }
        : null,
      coverageAnchor: this.lastCoverageAnchor
        ? {
            latitude: this.lastCoverageAnchor.latitude,
            longitude: this.lastCoverageAnchor.longitude,
          }
        : null,
      planner: this.mode,
      requiredTileCount: this.latestRequiredKeys.size,
      loadedTileCount: diag.loadedTileCount,
      pendingTileCount: this.inFlightRequests.size,
      cacheHitCount: this.cacheHitCount,
      cacheMissCount: this.cacheMissCount,
      roadCandidatesCount,
      roadUpdateCount,
      lastCoverageUpdateTimestampMs: this.lastCoveragePlanTimestampMs,
      coalescedSkipCount: this.coalescedSkipCount,
      lastTriggerReason: this.lastTriggerReason,
      activeRegionId: this.currentVehiclePosition
        ? this.regionPackManager.findPackForCoordinate(this.currentVehiclePosition)?.id ?? null
        : null,
    };
  }

  public getMemoryTelemetry(): RoadMemoryTelemetry {
    const diag = this.provider.getDiagnostics();
    const l1CacheBytes = (this.cache as any)?.getTotalBytes?.() ?? 0;
    const persistentCacheBytes = l1CacheBytes;
    return {
      ramTileCount: diag.loadedTileCount,
      ramRoadBytes: this.provider.getTotalRamBytes(),
      ramBudgetBytes: this.config.maxActiveRoadRamBytes,
      l1CacheBytes,
      persistentCacheBytes,
      evictionCount: this.evictionCount,
      lastEvictionKey: this.lastEvictionKey,
      memoryPressure: this.memoryPressure,
      activeSegmentCount: diag.segmentCount,
      indexedSegmentCount: diag.segmentCount,
    };
  }

  public isEstimatorIsolated(): boolean {
    return true;
  }
}
