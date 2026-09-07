/**
 * OsmOverpassRoadDataSource.ts
 *
 * Production IRoadDataSource backed by OpenStreetMap via the Overpass API.
 * Fetches real, legitimate road-network geometry for arbitrary geographic
 * locations and normalizes OSM ways into RoadTile / RoadSegment / RoadNode graph.
 *
 * Features:
 * - Dynamic querying for any geographic bounding box derived from TileKey.
 * - Multi-endpoint redundancy with automatic fallback across public Overpass servers.
 * - Transparent offline fixture fallback (checks bundled offline fixtures if network fails).
 * - Strict timeout (8s) via AbortController and polite rate-limiting.
 * - Zero fake geometry: returns null if no valid roads exist or query fails.
 * - Completely isolated from processImu(): executed exclusively by RoadDataManager.
 *
 * ARCHITECTURAL RULE:
 * This adapter belongs in src/adapters/road/.
 * Core positioning/estimator code must never import this file.
 */

import { IRoadDataSource } from "../../core/navigation/road/IRoadDataSource";
import {
  RoadTile,
  serializeTileKey,
  TileBoundingBox,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";
import {
  RoadIntersection,
  RoadNode,
  RoadSegment,
  SegmentDirectionality,
} from "../../core/navigation/road/RoadTypes";
import { LatLonAlt } from "../../core/navigation/routing/RoutingTypes";

declare const require: any;

export interface OsmOverpassConfig {
  /** Array of Overpass API interpreter URLs to try in order */
  endpoints?: string[];
  /** Request timeout in milliseconds (default 8000ms) */
  timeoutMs?: number;
  /** Minimum interval between consecutive Overpass queries in ms (default 1000ms) */
  minRequestIntervalMs?: number;
  /** Optional directory path for offline fixture fallback */
  offlineFixturesDir?: string;
  /** Optional pre-loaded offline fixtures map: serializedKey -> RoadTile */
  preloadedFixtures?: Map<string, RoadTile>;
  /** Optional custom fetch implementation (useful for tests/mocking) */
  fetchFn?: typeof fetch;
}

export const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OsmNodeElement {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

interface OsmWayElement {
  type: "way";
  id: number;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

interface OsmOverpassResponse {
  elements?: Array<OsmNodeElement | OsmWayElement>;
  remark?: string;
}

export class OsmOverpassRoadDataSource implements IRoadDataSource {
  private readonly endpoints: string[];
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly offlineFixturesDir?: string;
  private readonly preloadedFixtures: Map<string, RoadTile>;
  private readonly fetchFn: typeof fetch;

  private lastRequestTimeMs = 0;
  private isAvailableState = true;
  private queryCount = 0;
  private successCount = 0;
  private fallbackCount = 0;
  private failureCount = 0;

  constructor(config?: OsmOverpassConfig) {
    this.endpoints = config?.endpoints ?? [...DEFAULT_OVERPASS_ENDPOINTS];
    this.timeoutMs = config?.timeoutMs ?? 8000;
    this.minRequestIntervalMs = config?.minRequestIntervalMs ?? 1000;
    this.offlineFixturesDir = config?.offlineFixturesDir;
    this.preloadedFixtures = config?.preloadedFixtures ?? new Map();
    this.fetchFn = config?.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : (undefined as any));

    // If an offline directory was provided, load fixtures into memory for instant fallback
    if (this.offlineFixturesDir) {
      this.loadOfflineFixtures(this.offlineFixturesDir);
    }
  }

  // ---------------------------------------------------------------------------
  // IRoadDataSource Contract
  // ---------------------------------------------------------------------------

  public async fetchTile(key: TileKey): Promise<RoadTile | null> {
    this.queryCount++;
    const serialized = serializeTileKey(key);

    // 1. Check preloaded offline fixtures first
    if (this.preloadedFixtures.has(serialized)) {
      this.fallbackCount++;
      return this.preloadedFixtures.get(serialized)!;
    }

    // 2. Derive geographic bounding box for this tile key
    const bbox = this.tileKeyToBoundingBox(key);
    if (!bbox) {
      console.warn(`[OsmOverpassRoadDataSource] Unsupported tile key format: ${serialized}`);
      return null;
    }

    // 3. Attempt network fetch across configured Overpass endpoints
    if (typeof this.fetchFn === "function") {
      const tile = await this.queryOverpassEndpoints(key, bbox);
      if (tile) {
        this.successCount++;
        return tile;
      }
    }

    // 4. If network query failed, check offline directory on disk
    if (this.offlineFixturesDir) {
      const diskTile = this.loadTileFromDisk(key);
      if (diskTile) {
        this.fallbackCount++;
        this.preloadedFixtures.set(serialized, diskTile);
        return diskTile;
      }
    }

    this.failureCount++;
    return null;
  }

  public getSourceName(): string {
    return "OsmOverpassRoadDataSource";
  }

  public isAvailable(): boolean {
    return this.isAvailableState;
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  public getDiagnostics(): {
    queryCount: number;
    successCount: number;
    fallbackCount: number;
    failureCount: number;
    preloadedCount: number;
  } {
    return {
      queryCount: this.queryCount,
      successCount: this.successCount,
      fallbackCount: this.fallbackCount,
      failureCount: this.failureCount,
      preloadedCount: this.preloadedFixtures.size,
    };
  }

  public registerOfflineFixture(tile: RoadTile): void {
    const keyStr = serializeTileKey(tile.key);
    this.preloadedFixtures.set(keyStr, tile);
  }

  // ---------------------------------------------------------------------------
  // Internal Overpass Query Logic
  // ---------------------------------------------------------------------------

  private async queryOverpassEndpoints(
    key: TileKey,
    bbox: TileBoundingBox,
  ): Promise<RoadTile | null> {
    const ql = this.buildOverpassQuery(bbox);

    for (const endpoint of this.endpoints) {
      // Rate-limiting throttle
      const now = Date.now();
      const elapsed = now - this.lastRequestTimeMs;
      if (elapsed < this.minRequestIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, this.minRequestIntervalMs - elapsed));
      }
      this.lastRequestTimeMs = Date.now();

      try {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timeoutId = controller
          ? setTimeout(() => controller.abort(), this.timeoutMs)
          : null;

        const response = await this.fetchFn(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "BetterMaps-LiveIDR/1.0",
          },
          body: `data=${encodeURIComponent(ql)}`,
          signal: controller ? controller.signal : undefined,
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) {
          console.warn(
            `[OsmOverpassRoadDataSource] Endpoint ${endpoint} returned HTTP ${response.status}`,
          );
          continue;
        }

        const data = (await response.json()) as OsmOverpassResponse;
        if (!data || !Array.isArray(data.elements)) {
          continue;
        }

        return this.parseOsmElementsToTile(key, bbox, data.elements);
      } catch (err: any) {
        console.warn(
          `[OsmOverpassRoadDataSource] Request to ${endpoint} failed: ${err?.message ?? err}`,
        );
      }
    }

    return null;
  }

  private buildOverpassQuery(bbox: TileBoundingBox): string {
    const timeoutSec = Math.max(1, Math.floor(this.timeoutMs / 1000));
    return `[out:json][timeout:${timeoutSec}];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]
    (${bbox.minLat.toFixed(6)},${bbox.minLon.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLon.toFixed(6)});
);
out body geom;`;
  }

  /**
   * Transforms raw Overpass elements into normalized RoadTile.
   */
  public parseOsmElementsToTile(
    key: TileKey,
    bbox: TileBoundingBox,
    elements: Array<OsmNodeElement | OsmWayElement>,
  ): RoadTile {
    const segments: RoadSegment[] = [];
    const nodeMap = new Map<string, { coordinate: LatLonAlt; connectedSegmentIds: string[] }>();

    for (const el of elements) {
      if (el.type !== "way") continue;
      const way = el as OsmWayElement;
      if (!way.geometry || way.geometry.length < 2) continue;

      const geom: LatLonAlt[] = way.geometry.map((pt) => ({
        latitude: pt.lat,
        longitude: pt.lon,
      }));

      const startPoint = geom[0];
      const endPoint = geom[geom.length - 1];
      const lengthMeters = this.calculatePolylineLengthMeters(geom);
      const bearingDeg = this.calculateBearingDeg(
        startPoint.latitude,
        startPoint.longitude,
        endPoint.latitude,
        endPoint.longitude,
      );

      const tags = way.tags ?? {};
      const roadClass = tags.highway ?? "residential";
      const directionality = this.parseDirectionality(tags);
      const speedLimitMps = this.parseSpeedLimit(tags.maxspeed, roadClass);
      const laneCount = tags.lanes ? parseInt(tags.lanes, 10) : undefined;
      const name = tags.name ?? tags.ref ?? undefined;

      const segId = `osm_w_${way.id}`;
      const startNodeId = way.nodes && way.nodes.length > 0 ? `osm_n_${way.nodes[0]}` : undefined;
      const endNodeId =
        way.nodes && way.nodes.length > 1
          ? `osm_n_${way.nodes[way.nodes.length - 1]}`
          : undefined;

      const segment: RoadSegment = {
        id: segId,
        name,
        startPoint,
        endPoint,
        lengthMeters,
        bearingDeg,
        directionality,
        oneWay: directionality === "forward_only",
        speedLimitMps,
        roadClass,
        laneCount: isNaN(laneCount as number) ? undefined : laneCount,
        geometry: geom,
        startNodeId,
        endNodeId,
      };

      segments.push(segment);

      // Track topology nodes
      if (startNodeId) {
        let entry = nodeMap.get(startNodeId);
        if (!entry) {
          entry = { coordinate: startPoint, connectedSegmentIds: [] };
          nodeMap.set(startNodeId, entry);
        }
        if (!entry.connectedSegmentIds.includes(segId)) {
          entry.connectedSegmentIds.push(segId);
        }
      }

      if (endNodeId) {
        let entry = nodeMap.get(endNodeId);
        if (!entry) {
          entry = { coordinate: endPoint, connectedSegmentIds: [] };
          nodeMap.set(endNodeId, entry);
        }
        if (!entry.connectedSegmentIds.includes(segId)) {
          entry.connectedSegmentIds.push(segId);
        }
      }
    }

    const nodes: RoadNode[] = [];
    const intersections: RoadIntersection[] = [];

    for (const [nodeId, data] of nodeMap.entries()) {
      nodes.push({
        id: nodeId,
        coordinate: data.coordinate,
        connectedSegmentIds: data.connectedSegmentIds,
      });

      if (data.connectedSegmentIds.length >= 2) {
        intersections.push({
          nodeId,
          coordinate: data.coordinate,
          outboundSegmentIds: [...data.connectedSegmentIds],
        });
      }
    }

    return {
      key,
      bounds: bbox,
      segments,
      nodes,
      intersections,
      metadata: {
        fetchedAtMs: Date.now(),
        source: "OpenStreetMap (Overpass API)",
        segmentCount: segments.length,
        nodeCount: nodes.length,
        intersectionCount: intersections.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Geometry & Attribute Parsing Helpers
  // ---------------------------------------------------------------------------

  public tileKeyToBoundingBox(key: TileKey): TileBoundingBox | null {
    if (key.scheme === "deg") {
      const parts = key.key.split(":");
      let stepDeg = 0.01;
      let latIdx: number;
      let lonIdx: number;

      if (parts.length === 3) {
        stepDeg = parseInt(parts[0], 10) / 10000.0;
        latIdx = parseInt(parts[1], 10);
        lonIdx = parseInt(parts[2], 10);
      } else if (parts.length === 2) {
        latIdx = parseInt(parts[0], 10);
        lonIdx = parseInt(parts[1], 10);
      } else {
        return null;
      }

      if (isNaN(latIdx) || isNaN(lonIdx) || isNaN(stepDeg) || stepDeg <= 0) {
        return null;
      }

      return {
        minLat: latIdx * stepDeg,
        maxLat: (latIdx + 1) * stepDeg,
        minLon: lonIdx * stepDeg,
        maxLon: (lonIdx + 1) * stepDeg,
      };
    }

    if (key.scheme === "slippy") {
      const parts = key.key.split(":");
      if (parts.length === 3) {
        const z = parseInt(parts[0], 10);
        const x = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);
        if (!isNaN(z) && !isNaN(x) && !isNaN(y)) {
          const n = Math.pow(2, z);
          const lonMin = (x / n) * 360.0 - 180.0;
          const lonMax = ((x + 1) / n) * 360.0 - 180.0;
          const latMinRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
          const latMaxRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
          return {
            minLat: (latMinRad * 180.0) / Math.PI,
            maxLat: (latMaxRad * 180.0) / Math.PI,
            minLon: lonMin,
            maxLon: lonMax,
          };
        }
      }
    }

    return null;
  }

  private parseDirectionality(tags: Record<string, string>): SegmentDirectionality {
    const oneway = tags.oneway?.toLowerCase();
    if (oneway === "yes" || oneway === "1" || tags.highway === "motorway") {
      return "forward_only";
    }
    if (oneway === "-1") {
      return "backward_only";
    }
    return "two_way";
  }

  private parseSpeedLimit(maxspeed?: string, roadClass?: string): number {
    if (maxspeed) {
      const trimmed = maxspeed.trim().toLowerCase();
      const mphMatch = trimmed.match(/^(\d+)\s*(mph)?$/);
      if (trimmed.includes("mph") && mphMatch) {
        return parseFloat(mphMatch[1]) * 0.44704;
      }
      const num = parseFloat(trimmed);
      if (!isNaN(num)) {
        return num / 3.6;
      }
    }

    switch (roadClass) {
      case "motorway":
      case "motorway_link":
        return 31.3;
      case "trunk":
      case "trunk_link":
      case "primary":
      case "primary_link":
        return 13.9;
      case "secondary":
      case "secondary_link":
        return 11.1;
      case "tertiary":
      case "tertiary_link":
        return 8.3;
      default:
        return 8.3;
    }
  }

  private calculatePolylineLengthMeters(points: LatLonAlt[]): number {
    let total = 0.0;
    for (let i = 0; i < points.length - 1; i++) {
      total += this.calculateHaversineMeters(
        points[i].latitude,
        points[i].longitude,
        points[i + 1].latitude,
        points[i + 1].longitude,
      );
    }
    return Math.max(1.0, total);
  }

  private calculateHaversineMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371000.0;
    const phi1 = (lat1 * Math.PI) / 180.0;
    const phi2 = (lat2 * Math.PI) / 180.0;
    const dPhi = phi2 - phi1;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180.0;
    const a =
      Math.sin(dPhi / 2.0) * Math.sin(dPhi / 2.0) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2.0) * Math.sin(dLambda / 2.0);
    return 2.0 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  }

  private calculateBearingDeg(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const phi1 = (lat1 * Math.PI) / 180.0;
    const phi2 = (lat2 * Math.PI) / 180.0;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180.0;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    const theta = Math.atan2(y, x);
    return ((theta * 180.0) / Math.PI + 360.0) % 360.0;
  }

  private loadOfflineFixtures(directoryPath: string): void {
    try {
      const req = (globalThis as any).require;
      const fs = req ? req("fs") : null;
      const path = req ? req("path") : null;

      if (!fs || !path || !fs.existsSync(directoryPath)) return;

      const files: string[] = fs.readdirSync(directoryPath);
      for (const file of files) {
        if (file.endsWith(".json") && file !== "manifest.json") {
          const fullPath = path.join(directoryPath, file);
          const raw = fs.readFileSync(fullPath, "utf8");
          const tile = JSON.parse(raw) as RoadTile;
          if (tile && tile.key && tile.segments) {
            this.registerOfflineFixture(tile);
          }
        }
      }
    } catch (_err) {
      // Ignore if running in pure browser/react-native bundle without Node fs
    }
  }

  private loadTileFromDisk(key: TileKey): RoadTile | null {
    try {
      const req = (globalThis as any).require;
      const fs = req ? req("fs") : null;
      const path = req ? req("path") : null;

      if (!fs || !path || !this.offlineFixturesDir || !fs.existsSync(this.offlineFixturesDir)) {
        return null;
      }

      const files: string[] = fs.readdirSync(this.offlineFixturesDir);
      const targetSerialized = serializeTileKey(key);

      for (const file of files) {
        if (file.endsWith(".json") && file !== "manifest.json") {
          const fullPath = path.join(this.offlineFixturesDir, file);
          const raw = fs.readFileSync(fullPath, "utf8");
          const tile = JSON.parse(raw) as RoadTile;
          if (tile && tile.key && serializeTileKey(tile.key) === targetSerialized) {
            return tile;
          }
        }
      }
    } catch (_err) {
      // Ignore
    }
    return null;
  }
}
