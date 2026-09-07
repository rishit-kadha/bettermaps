/**
 * OfflineRouteStore.ts
 *
 * Two implementations of offline route storage:
 *
 *  1. OfflineRouteStore  – synchronous, in-memory Map (unchanged original).
 *  2. PersistentOfflineRouteStore – async, backed by an IStorageDriver
 *     (e.g. FileStorageDriver) so routes survive process restarts.
 *
 * Deterministic, offline-first storage and retrieval for pre-existing trip routes.
 * Decoupled from any external storage engine or map provider.
 */

import { IStorageDriver } from '../../storage/IStorageDriver';
import { NormalizedRoute, PreExistingRoute } from './RoutingTypes';

// ---------------------------------------------------------------------------
// Shared interface (sync methods – kept for backwards compatibility)
// ---------------------------------------------------------------------------

export interface IOfflineRouteStore {
  saveRoute(route: NormalizedRoute): void;
  getRoute(routeId: string): NormalizedRoute | null;
  getActiveRoute(): PreExistingRoute | null;
  setActiveRoute(route: PreExistingRoute | null): void;
  getAllRoutes(): NormalizedRoute[];
  clear(): void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RouteValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateRoute(route: unknown): RouteValidationResult {
  const errors: string[] = [];

  if (route === null || typeof route !== 'object') {
    return { valid: false, errors: ['route must be a non-null object'] };
  }

  const r = route as Record<string, unknown>;

  if (typeof r.id !== 'string' || r.id.trim() === '') {
    errors.push('id must be a non-empty string');
  }
  if (typeof r.name !== 'string') {
    errors.push('name must be a string');
  }
  if (typeof r.sourceProvider !== 'string') {
    errors.push('sourceProvider must be a string');
  }
  if (
    typeof r.totalDistanceMeters !== 'number' ||
    !isFinite(r.totalDistanceMeters) ||
    r.totalDistanceMeters <= 0 ||
    r.totalDistanceMeters >= 1_000_000
  ) {
    errors.push('totalDistanceMeters must be a positive finite number less than 1,000,000');
  }
  if (typeof r.estimatedDurationSeconds !== 'number' || !isFinite(r.estimatedDurationSeconds)) {
    errors.push('estimatedDurationSeconds must be a finite number');
  }
  if (typeof r.creationTimestampMs !== 'number' || !isFinite(r.creationTimestampMs)) {
    errors.push('creationTimestampMs must be a finite number');
  }

  if (!Array.isArray(r.polylinePoints) || (r.polylinePoints as unknown[]).length < 2) {
    errors.push('polylinePoints must be an array with at least 2 points');
  } else {
    const points = r.polylinePoints as unknown[];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i] as Record<string, unknown>;
      if (
        typeof pt.latitude !== 'number' ||
        !isFinite(pt.latitude) ||
        pt.latitude < -90 ||
        pt.latitude > 90
      ) {
        errors.push(`polylinePoints[${i}].latitude must be a finite number in [-90, 90]`);
      }
      if (
        typeof pt.longitude !== 'number' ||
        !isFinite(pt.longitude) ||
        pt.longitude < -180 ||
        pt.longitude > 180
      ) {
        errors.push(`polylinePoints[${i}].longitude must be a finite number in [-180, 180]`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// In-memory implementation (original, unchanged)
// ---------------------------------------------------------------------------

export class OfflineRouteStore implements IOfflineRouteStore {
  private routes: Map<string, NormalizedRoute> = new Map();
  private activeRouteId: string | null = null;

  constructor(initialRoutes?: NormalizedRoute[]) {
    if (initialRoutes) {
      for (const r of initialRoutes) {
        this.saveRoute(r);
      }
    }
  }

  public saveRoute(route: NormalizedRoute): void {
    this.routes.set(route.id, {
      ...route,
      polylinePoints: route.polylinePoints.map((p) => ({ ...p })),
      segments: route.segments
        ? route.segments.map((s) => ({ ...s }))
        : undefined,
    });
  }

  public getRoute(routeId: string): NormalizedRoute | null {
    const r = this.routes.get(routeId);
    return r ? { ...r } : null;
  }

  public getActiveRoute(): PreExistingRoute | null {
    if (!this.activeRouteId) return null;
    return this.getRoute(this.activeRouteId);
  }

  public setActiveRoute(route: PreExistingRoute | null): void {
    if (route === null) {
      this.activeRouteId = null;
      return;
    }
    this.saveRoute(route);
    this.activeRouteId = route.id;
  }

  public getAllRoutes(): NormalizedRoute[] {
    return Array.from(this.routes.values()).map((r) => ({ ...r }));
  }

  public clear(): void {
    this.routes.clear();
    this.activeRouteId = null;
  }

  public exportJson(): string {
    return JSON.stringify({
      activeRouteId: this.activeRouteId,
      routes: Array.from(this.routes.values()),
    });
  }

  public importJson(jsonStr: string): void {
    try {
      const data = JSON.parse(jsonStr);
      if (Array.isArray(data.routes)) {
        for (const r of data.routes) {
          this.saveRoute(r);
        }
      }
      if (data.activeRouteId && this.routes.has(data.activeRouteId)) {
        this.activeRouteId = data.activeRouteId;
      }
    } catch (err) {
      console.warn('[OfflineRouteStore] Failed to import route JSON:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent implementation (async, driver-backed)
// ---------------------------------------------------------------------------

const STORAGE_KEY_ACTIVE_ROUTE = '__active_route_id__';
const STORAGE_KEY_ROUTE_PREFIX = 'route:';

export class PersistentOfflineRouteStore {
  private readonly driver: IStorageDriver;

  constructor(driver: IStorageDriver) {
    this.driver = driver;
  }

  public async saveRoute(route: NormalizedRoute): Promise<void> {
    const result = validateRoute(route);
    if (!result.valid) {
      throw new Error(
        `[PersistentOfflineRouteStore] Invalid route: ${result.errors.join('; ')}`
      );
    }
    await this.driver.setItem(`${STORAGE_KEY_ROUTE_PREFIX}${route.id}`, JSON.stringify(route));
  }

  public async loadRoute(routeId: string): Promise<NormalizedRoute | null> {
    const raw = await this.driver.getItem(`${STORAGE_KEY_ROUTE_PREFIX}${routeId}`);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = validateRoute(parsed);
      if (!result.valid) {
        console.warn(
          `[PersistentOfflineRouteStore] Stored route "${routeId}" failed validation:`,
          result.errors
        );
        return null;
      }
      return parsed as NormalizedRoute;
    } catch (err) {
      console.warn(`[PersistentOfflineRouteStore] Failed to parse route "${routeId}":`, err);
      return null;
    }
  }

  public async deleteRoute(routeId: string): Promise<boolean> {
    const key = `${STORAGE_KEY_ROUTE_PREFIX}${routeId}`;
    const existing = await this.driver.getItem(key);
    if (existing === null) return false;
    await this.driver.removeItem(key);
    // Clear active route pointer if it pointed to this route
    const activeId = await this.driver.getItem(STORAGE_KEY_ACTIVE_ROUTE);
    if (activeId === routeId) {
      await this.driver.removeItem(STORAGE_KEY_ACTIVE_ROUTE);
    }
    return true;
  }

  public async listRoutes(): Promise<NormalizedRoute[]> {
    const allKeys = await this.driver.getAllKeys();
    const routeKeys = allKeys.filter((k) => k.startsWith(STORAGE_KEY_ROUTE_PREFIX));
    const routes: NormalizedRoute[] = [];
    for (const key of routeKeys) {
      const routeId = key.slice(STORAGE_KEY_ROUTE_PREFIX.length);
      const route = await this.loadRoute(routeId);
      if (route !== null) {
        routes.push(route);
      }
    }
    return routes;
  }

  public async hasRoute(routeId: string): Promise<boolean> {
    const raw = await this.driver.getItem(`${STORAGE_KEY_ROUTE_PREFIX}${routeId}`);
    return raw !== null;
  }

  public async getActiveRoute(): Promise<NormalizedRoute | null> {
    const activeId = await this.driver.getItem(STORAGE_KEY_ACTIVE_ROUTE);
    if (!activeId) return null;
    return this.loadRoute(activeId);
  }

  public async setActiveRoute(route: PreExistingRoute | null): Promise<void> {
    if (route === null) {
      await this.driver.removeItem(STORAGE_KEY_ACTIVE_ROUTE);
      return;
    }
    await this.saveRoute(route);
    await this.driver.setItem(STORAGE_KEY_ACTIVE_ROUTE, route.id);
  }

  public async clearAll(): Promise<void> {
    await this.driver.clear();
  }

  public validateRoute(route: unknown): RouteValidationResult {
    return validateRoute(route);
  }
}
