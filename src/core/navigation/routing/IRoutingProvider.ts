/**
 * IRoutingProvider.ts
 *
 * Decoupled provider-neutral routing engine interface.
 * Core navigation code depends ONLY on this interface, never on third-party SDKs.
 */

import { NormalizedRoute, RouteWaypoint } from "./RoutingTypes";

export interface RouteCalculationOptions {
  avoidTolls?: boolean;
  avoidHighways?: boolean;
  mode?: "driving" | "walking" | "cycling";
}

export interface IRoutingProvider {
  /**
   * Calculates a optimal route connecting origin, destination, and optional waypoints.
   */
  calculateRoute(
    origin: RouteWaypoint,
    destination: RouteWaypoint,
    waypoints?: RouteWaypoint[],
    options?: RouteCalculationOptions,
  ): Promise<NormalizedRoute>;

  /**
   * Returns human-readable provider identifier (e.g., "offline-cache", "osrm-http", "mock").
   */
  getProviderName(): string;

  /**
   * Indicates whether this provider functions without active internet connectivity.
   */
  isOfflineCapable(): boolean;
}
