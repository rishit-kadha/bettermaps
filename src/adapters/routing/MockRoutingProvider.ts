/**
 * MockRoutingProvider.ts
 *
 * Synthetic routing provider for testing without internet or Google Maps access.
 * Generates deterministic routes from waypoint arrays.
 *
 * ARCHITECTURAL RULE:
 * This file belongs in src/adapters/routing/.
 * It implements IRoutingProvider using purely synthetic in-memory data.
 */

import { IRoutingProvider } from '../../core/navigation/routing/IRoutingProvider';
import { LatLonAlt, NormalizedRoute } from '../../core/navigation/routing/RoutingTypes';

function haversineMeters(a: LatLonAlt, b: LatLonAlt): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const aa = sinDlat * sinDlat +
    Math.cos((a.latitude * Math.PI) / 180) *
    Math.cos((b.latitude * Math.PI) / 180) *
    sinDlon * sinDlon;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

export class MockRoutingProvider implements IRoutingProvider {
  private readonly name: string;
  private readonly speedMps: number;
  private routeIdCounter = 0;

  constructor(options: { name?: string; speedMps?: number } = {}) {
    this.name = options.name ?? 'MockRoutingProvider';
    this.speedMps = options.speedMps ?? 10.0;
  }

  public async calculateRoute(
    origin: LatLonAlt,
    destination: LatLonAlt,
    waypoints?: LatLonAlt[],
  ): Promise<NormalizedRoute> {
    const allPoints: LatLonAlt[] = [origin, ...(waypoints ?? []), destination];
    let totalDistanceMeters = 0;
    for (let i = 1; i < allPoints.length; i++) {
      totalDistanceMeters += haversineMeters(allPoints[i - 1], allPoints[i]);
    }
    const estimatedDurationSeconds = totalDistanceMeters / this.speedMps;
    this.routeIdCounter++;
    return {
      id: `mock-route-${this.routeIdCounter}`,
      name: `Mock Route ${this.routeIdCounter}`,
      polylinePoints: allPoints,
      totalDistanceMeters,
      estimatedDurationSeconds,
      sourceProvider: this.name,
      creationTimestampMs: Date.now(),
    };
  }

  public getProviderName(): string { return this.name; }
  public isOfflineCapable(): boolean { return true; }
}