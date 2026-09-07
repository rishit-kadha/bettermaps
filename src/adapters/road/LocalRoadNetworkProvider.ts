/**
 * LocalRoadNetworkProvider.ts
 *
 * Offline, provider-neutral IRoadNetworkProvider supporting both static bundled datasets
 * and dynamic runtime tile registration/eviction.
 *
 * Features:
 * - O(1) amortized spatial queries via SpatialGridIndex (< 0.05 ms in-memory)
 * - Strictly synchronous query contract (zero I/O, zero network, zero Promises)
 * - Dynamic tile lifecycle: registerTile, evictTile, hasTile
 * - Multi-tile segment ownership tracking (eviction never deletes segments still owned by other tiles)
 * - Idempotent registration and shared-boundary deduplication
 * - Full topological graph: node adjacency, intersection lookup
 *
 * ARCHITECTURAL RULE:
 * - Zero imports from Google, MapLibre, OSM, OSRM, SQLite, React Native map SDKs.
 * - All provider-specific code stays here in src/adapters/road/.
 */

import { IRoadNetworkProvider } from "../../core/navigation/road/IRoadNetworkProvider";
import {
  RoadTile,
  serializeTileKey,
  TileKey,
} from "../../core/navigation/road/RoadTileTypes";
import {
  RoadIntersection,
  RoadNode,
  RoadSegment,
  SegmentDirectionality,
} from "../../core/navigation/road/RoadTypes";
import { LatLonAlt } from "../../core/navigation/routing/RoutingTypes";
import { SpatialGridIndex } from "./SpatialGridIndex";

// ---------------------------------------------------------------------------
// JSON schema types for backwards-compatible static dataset loading
// ---------------------------------------------------------------------------

interface RoadDatasetNode {
  id: string;
  coordinate: { latitude: number; longitude: number; altitudeM?: number };
  connectedSegmentIds: string[];
}

interface RoadDatasetSegment {
  id: string;
  name?: string;
  startPoint: { latitude: number; longitude: number; altitudeM?: number };
  endPoint: { latitude: number; longitude: number; altitudeM?: number };
  lengthMeters: number;
  bearingDeg: number;
  directionality?: SegmentDirectionality;
  oneWay?: boolean;
  speedLimitMps?: number;
  roadClass?: string;
  laneCount?: number;
  geometry?: Array<{ latitude: number; longitude: number; altitudeM?: number }>;
  startNodeId?: string;
  endNodeId?: string;
}

interface RoadDatasetIntersection {
  nodeId: string;
  coordinate: { latitude: number; longitude: number; altitudeM?: number };
  outboundSegmentIds: string[];
}

interface RoadDataset {
  metadata?: {
    source?: string;
    license?: string;
    region?: string;
    bounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
    schemaVersion?: number;
    segmentCount?: number;
    nodeCount?: number;
  };
  nodes: RoadDatasetNode[];
  segments: RoadDatasetSegment[];
  intersections?: RoadDatasetIntersection[];
}

export interface RoadProviderDiagnostics {
  providerName: string;
  isOffline: boolean;
  initialized: boolean;
  loadedTileCount: number;
  loadedTileKeys: string[];
  segmentCount: number;
  nodeCount: number;
  intersectionCount: number;
  spatialGridCellCount: number;
  totalRamBytes: number;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class LocalRoadNetworkProvider implements IRoadNetworkProvider {
  private readonly segments: Map<string, RoadSegment> = new Map();
  private readonly nodes: Map<string, RoadNode> = new Map();
  private readonly intersections: Map<string, RoadIntersection> = new Map();
  private readonly spatialIndex: SpatialGridIndex = new SpatialGridIndex();

  // Dynamic tile tracking:
  // serializedKey -> TileKey
  private readonly loadedTiles: Map<string, TileKey> = new Map();
  // serializedKey -> approximate RAM bytes
  private readonly tileByteSizes: Map<string, number> = new Map();
  private totalRamBytes = 0;

  // segmentId -> Set of serialized tileKeys owning this segment
  private readonly segmentOwners: Map<string, Set<string>> = new Map();
  // nodeId -> Set of serialized tileKeys owning this node
  private readonly nodeOwners: Map<string, Set<string>> = new Map();
  // intersectionId -> Set of serialized tileKeys owning this intersection
  private readonly intersectionOwners: Map<string, Set<string>> = new Map();

  private readonly providerName: string;
  private initialized = false;

  constructor(dataset?: unknown, name = "LocalRoadNetworkProvider") {
    this.providerName = name;
    if (dataset) {
      this.loadDataset(dataset as RoadDataset);
    }
  }

  // ---------------------------------------------------------------------------
  // IRoadNetworkProvider (Strictly Synchronous In-Memory Contract)
  // ---------------------------------------------------------------------------

  public findNearbySegments(
    center: LatLonAlt,
    radiusMeters: number,
  ): RoadSegment[] {
    if (!this.initialized && this.segments.size === 0) return [];
    return this.spatialIndex.queryRadius(center, radiusMeters);
  }

  public getSegmentById(id: string): RoadSegment | null {
    return this.segments.get(id) ?? null;
  }

  public getOutboundSegments(segmentId: string): RoadSegment[] {
    const segment = this.segments.get(segmentId);
    if (!segment) return [];

    const result: RoadSegment[] = [];
    const visited = new Set<string>();
    visited.add(segmentId);

    // Check both start and end node adjacency
    for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
      if (!nodeId) continue;
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      for (const connectedId of node.connectedSegmentIds) {
        if (visited.has(connectedId)) continue;
        visited.add(connectedId);
        const s = this.segments.get(connectedId);
        if (s) result.push(s);
      }
    }

    return result;
  }

  public getConnectedIntersections(
    center: LatLonAlt,
    radiusMeters: number,
  ): RoadIntersection[] {
    const result: RoadIntersection[] = [];
    const latDelta = radiusMeters / 111111.0;
    const lonDelta =
      radiusMeters /
      (111111.0 * Math.cos((center.latitude * Math.PI) / 180.0));

    for (const intersection of this.intersections.values()) {
      const dLat = Math.abs(
        intersection.coordinate.latitude - center.latitude,
      );
      const dLon = Math.abs(
        intersection.coordinate.longitude - center.longitude,
      );
      if (dLat <= latDelta && dLon <= lonDelta) {
        result.push(intersection);
      }
    }
    return result;
  }

  public getNodeById(nodeId: string): RoadNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  public getProviderName(): string {
    return this.providerName;
  }

  public isOffline(): boolean {
    return true;
  }

  // ---------------------------------------------------------------------------
  // Dynamic Tile Lifecycle Methods
  // ---------------------------------------------------------------------------

  /**
   * Dynamically registers a RoadTile into the provider's active spatial index.
   * Idempotent: returns false if the tileKey is already registered.
   * Additive: segments shared across multiple tiles maintain reference counts
   * so they are not duplicated in the spatial index.
   */
  public registerTile(tile: RoadTile): boolean {
    const keyStr = serializeTileKey(tile.key);
    if (this.loadedTiles.has(keyStr)) {
      return false; // Idempotent: tile already registered
    }

    this.loadedTiles.set(keyStr, tile.key);

    const byteSize =
      tile.metadata?.byteSize && typeof tile.metadata.byteSize === "number"
        ? tile.metadata.byteSize
        : this.calculateTileRamBytes(tile);
    this.tileByteSizes.set(keyStr, byteSize);
    this.totalRamBytes += byteSize;

    // Register segments
    for (const seg of tile.segments) {
      let owners = this.segmentOwners.get(seg.id);
      if (!owners) {
        owners = new Set();
        this.segmentOwners.set(seg.id, owners);
        this.segments.set(seg.id, seg);
        this.spatialIndex.insertSegment(seg);
      }
      owners.add(keyStr);
    }

    // Register nodes
    if (tile.nodes) {
      for (const n of tile.nodes) {
        let owners = this.nodeOwners.get(n.id);
        if (!owners) {
          owners = new Set();
          this.nodeOwners.set(n.id, owners);
          this.nodes.set(n.id, {
            id: n.id,
            coordinate: n.coordinate,
            connectedSegmentIds: [...n.connectedSegmentIds],
          });
        } else {
          const existing = this.nodes.get(n.id)!;
          const merged = Array.from(
            new Set([...existing.connectedSegmentIds, ...n.connectedSegmentIds]),
          );
          existing.connectedSegmentIds = merged;
        }
        owners.add(keyStr);
      }
    }

    // Register intersections
    if (tile.intersections) {
      for (const ix of tile.intersections) {
        let owners = this.intersectionOwners.get(ix.nodeId);
        if (!owners) {
          owners = new Set();
          this.intersectionOwners.set(ix.nodeId, owners);
          this.intersections.set(ix.nodeId, {
            nodeId: ix.nodeId,
            coordinate: ix.coordinate,
            outboundSegmentIds: [...ix.outboundSegmentIds],
          });
        } else {
          const existing = this.intersections.get(ix.nodeId)!;
          const merged = Array.from(
            new Set([...existing.outboundSegmentIds, ...ix.outboundSegmentIds]),
          );
          existing.outboundSegmentIds = merged;
        }
        owners.add(keyStr);
      }
    }

    this.initialized = true;
    return true;
  }

  /**
   * Dynamically evicts a RoadTile by key.
   * Segments that are still owned by other loaded tiles are retained in the index.
   * Segments whose only owner was this tile are removed from both memory and the spatial index.
   * Returns true if the tile was found and evicted, false otherwise.
   */
  public evictTile(tileKey: TileKey): boolean {
    const keyStr = serializeTileKey(tileKey);
    if (!this.loadedTiles.has(keyStr)) {
      return false;
    }

    this.loadedTiles.delete(keyStr);
    const b = this.tileByteSizes.get(keyStr) ?? 0;
    this.totalRamBytes = Math.max(0, this.totalRamBytes - b);
    this.tileByteSizes.delete(keyStr);

    // Evict segments owned by this tile
    for (const [segId, owners] of this.segmentOwners.entries()) {
      if (owners.has(keyStr)) {
        owners.delete(keyStr);
        if (owners.size === 0) {
          this.segmentOwners.delete(segId);
          this.segments.delete(segId);
          this.spatialIndex.removeSegment(segId);
        }
      }
    }

    // Evict nodes owned by this tile
    for (const [nodeId, owners] of this.nodeOwners.entries()) {
      if (owners.has(keyStr)) {
        owners.delete(keyStr);
        if (owners.size === 0) {
          this.nodeOwners.delete(nodeId);
          this.nodes.delete(nodeId);
        }
      }
    }

    // Evict intersections owned by this tile
    for (const [ixId, owners] of this.intersectionOwners.entries()) {
      if (owners.has(keyStr)) {
        owners.delete(keyStr);
        if (owners.size === 0) {
          this.intersectionOwners.delete(ixId);
          this.intersections.delete(ixId);
        }
      }
    }

    return true;
  }

  /**
   * Checks whether a tile is currently registered in the provider.
   */
  public hasTile(tileKey: TileKey): boolean {
    return this.loadedTiles.has(serializeTileKey(tileKey));
  }

  /**
   * Returns all currently loaded TileKeys.
   */
  public getLoadedTileKeys(): TileKey[] {
    return Array.from(this.loadedTiles.values());
  }

  /**
   * Returns the count of currently loaded tiles.
   */
  public getLoadedTileCount(): number {
    return this.loadedTiles.size;
  }

  /**
   * Returns the total approximate in-memory RAM bytes occupied by active tiles.
   */
  public getTotalRamBytes(): number {
    return this.totalRamBytes;
  }

  /**
   * Returns the byte size of a specific loaded tile.
   */
  public getTileByteSize(tileKey: TileKey): number {
    return this.tileByteSizes.get(serializeTileKey(tileKey)) ?? 0;
  }

  /**
   * Clears all loaded tiles, segments, nodes, intersections, and spatial indices.
   */
  public clearAllTiles(): void {
    this.loadedTiles.clear();
    this.tileByteSizes.clear();
    this.totalRamBytes = 0;
    this.segmentOwners.clear();
    this.nodeOwners.clear();
    this.intersectionOwners.clear();
    this.segments.clear();
    this.nodes.clear();
    this.intersections.clear();
    this.spatialIndex.clear();
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Diagnostic accessors
  // ---------------------------------------------------------------------------

  public getDiagnostics(): RoadProviderDiagnostics {
    return {
      providerName: this.providerName,
      isOffline: this.isOffline(),
      initialized: this.initialized,
      loadedTileCount: this.loadedTiles.size,
      loadedTileKeys: Array.from(this.loadedTiles.keys()),
      segmentCount: this.segments.size,
      nodeCount: this.nodes.size,
      intersectionCount: this.intersections.size,
      spatialGridCellCount: this.spatialIndex.getCellCount(),
      totalRamBytes: this.totalRamBytes,
    };
  }

  public getSegmentCount(): number {
    return this.segments.size;
  }

  /**
   * Returns all currently loaded road segments as an array.
   * Used only by debug/diagnostics visualization — NOT by estimator.
   */
  public getAllSegments(): RoadSegment[] {
    return Array.from(this.segments.values());
  }

  public getNodeCount(): number {
    return this.nodes.size;
  }

  public getIntersectionCount(): number {
    return this.intersections.size;
  }

  private calculateTileRamBytes(tile: RoadTile): number {
    let bytes = 200; // Object & bookkeeping overhead
    for (const seg of tile.segments) {
      bytes +=
        180 +
        (seg.geometry ? seg.geometry.length * 16 : 32) +
        (seg.name ? seg.name.length * 2 : 0);
    }
    if (tile.nodes) {
      for (const n of tile.nodes) {
        bytes += 90 + (n.connectedSegmentIds ? n.connectedSegmentIds.length * 20 : 0);
      }
    }
    if (tile.intersections) {
      for (const ix of tile.intersections) {
        bytes +=
          90 + (ix.outboundSegmentIds ? ix.outboundSegmentIds.length * 20 : 0);
      }
    }
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // Backwards-compatible static dataset loading
  // ---------------------------------------------------------------------------

  private loadDataset(dataset: RoadDataset): void {
    if (!dataset || !dataset.segments || !dataset.nodes) {
      console.warn(
        "[LocalRoadNetworkProvider] Invalid or empty dataset provided.",
      );
      return;
    }

    // Convert dataset into a canonical RoadTile with a static key
    const staticKey: TileKey = {
      scheme: "static",
      key: "bundled_coventry",
    };

    const segments: RoadSegment[] = [];
    for (const s of dataset.segments) {
      segments.push({
        id: s.id,
        name: s.name,
        startPoint: s.startPoint,
        endPoint: s.endPoint,
        lengthMeters: s.lengthMeters,
        bearingDeg: s.bearingDeg,
        directionality:
          s.directionality ?? (s.oneWay ? "forward_only" : "two_way"),
        oneWay: s.oneWay ?? (s.directionality === "forward_only"),
        speedLimitMps: s.speedLimitMps,
        roadClass: s.roadClass,
        laneCount: s.laneCount,
        geometry: s.geometry,
        startNodeId: s.startNodeId,
        endNodeId: s.endNodeId,
      });
    }

    const nodes: RoadNode[] = dataset.nodes.map((n) => ({
      id: n.id,
      coordinate: n.coordinate,
      connectedSegmentIds: n.connectedSegmentIds ?? [],
    }));

    const intersections: RoadIntersection[] = (
      dataset.intersections ?? []
    ).map((ix) => ({
      nodeId: ix.nodeId,
      coordinate: ix.coordinate,
      outboundSegmentIds: ix.outboundSegmentIds ?? [],
    }));

    const bounds = dataset.metadata?.bounds ?? {
      minLat: 52.385,
      maxLat: 52.43,
      minLon: -1.56,
      maxLon: -1.48,
    };

    const tile: RoadTile = {
      key: staticKey,
      bounds,
      segments,
      nodes,
      intersections,
      metadata: {
        source: dataset.metadata?.source ?? "static_bundle",
        version: String(dataset.metadata?.schemaVersion ?? 1),
      },
    };

    this.registerTile(tile);

    console.log(
      `[LocalRoadNetworkProvider] Loaded ${this.segments.size} segments, ` +
        `${this.nodes.size} nodes, ${this.intersections.size} intersections. ` +
        `Spatial index: ${this.spatialIndex.getCellCount()} cells.`,
    );
  }
}