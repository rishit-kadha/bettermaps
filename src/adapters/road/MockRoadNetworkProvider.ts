/**
 * MockRoadNetworkProvider.ts
 *
 * Configurable synthetic road network provider for isolated unit and integration tests.
 * No network requests, no file I/O, no external dependencies.
 *
 * ARCHITECTURAL RULE:
 * This file belongs in src/adapters/road/.
 * It implements IRoadNetworkProvider using only synthetic in-memory data.
 */

import { IRoadNetworkProvider } from '../../core/navigation/road/IRoadNetworkProvider';
import { RoadIntersection, RoadNode, RoadSegment } from '../../core/navigation/road/RoadTypes';
import { LatLonAlt } from '../../core/navigation/routing/RoutingTypes';

export class MockRoadNetworkProvider implements IRoadNetworkProvider {
  private readonly segments: Map<string, RoadSegment>;
  private readonly nodes: Map<string, RoadNode>;
  private readonly intersections: Map<string, RoadIntersection>;
  private readonly name: string;
  private readonly offline: boolean;

  constructor(options: {
    segments?: RoadSegment[];
    nodes?: RoadNode[];
    intersections?: RoadIntersection[];
    name?: string;
    offline?: boolean;
  } = {}) {
    this.name = options.name ?? 'MockRoadNetworkProvider';
    this.offline = options.offline ?? true;
    this.segments = new Map((options.segments ?? []).map(s => [s.id, s]));
    this.nodes = new Map((options.nodes ?? []).map(n => [n.id, n]));
    this.intersections = new Map((options.intersections ?? []).map(i => [i.nodeId, i]));
  }

  public findNearbySegments(center: LatLonAlt, radiusMeters: number): RoadSegment[] {
    const result: RoadSegment[] = [];
    const latDelta = radiusMeters / 111111.0;
    const lonDelta = radiusMeters / (111111.0 * Math.cos((center.latitude * Math.PI) / 180.0));
    for (const seg of this.segments.values()) {
      const midLat = (seg.startPoint.latitude + seg.endPoint.latitude) / 2;
      const midLon = (seg.startPoint.longitude + seg.endPoint.longitude) / 2;
      if (Math.abs(midLat - center.latitude) <= latDelta &&
          Math.abs(midLon - center.longitude) <= lonDelta) {
        result.push(seg);
      }
    }
    return result;
  }

  public getSegmentById(id: string): RoadSegment | null {
    return this.segments.get(id) ?? null;
  }

  public getOutboundSegments(segmentId: string): RoadSegment[] {
    const seg = this.segments.get(segmentId);
    if (!seg) return [];
    const result: RoadSegment[] = [];
    const visited = new Set<string>([segmentId]);
    for (const nodeId of [seg.startNodeId, seg.endNodeId]) {
      if (!nodeId) continue;
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      for (const connId of node.connectedSegmentIds) {
        if (visited.has(connId)) continue;
        visited.add(connId);
        const s = this.segments.get(connId);
        if (s) result.push(s);
      }
    }
    return result;
  }

  public getConnectedIntersections(center: LatLonAlt, radiusMeters: number): RoadIntersection[] {
    const result: RoadIntersection[] = [];
    const latDelta = radiusMeters / 111111.0;
    const lonDelta = radiusMeters / (111111.0 * Math.cos((center.latitude * Math.PI) / 180.0));
    for (const ix of this.intersections.values()) {
      const dLat = Math.abs(ix.coordinate.latitude - center.latitude);
      const dLon = Math.abs(ix.coordinate.longitude - center.longitude);
      if (dLat <= latDelta && dLon <= lonDelta) result.push(ix);
    }
    return result;
  }

  public getNodeById(nodeId: string): RoadNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  public getProviderName(): string { return this.name; }
  public isOffline(): boolean { return this.offline; }
}