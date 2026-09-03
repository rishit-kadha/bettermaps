/**
 * Core type definitions for BetterMaps navigation and positioning engine.
 *
 * CRITICAL ARCHITECTURAL PRINCIPLE:
 * The UI layer and Navigation State ONLY interact with NavLocation and ILocationProvider.
 * They have NO direct knowledge of GNSS hardware, IMUs, or ML models.
 */

export type ProviderType = 'gnss' | 'idr' | 'hybrid' | 'mock';

export type ProviderStatus =
  | 'idle'
  | 'initializing'
  | 'active'
  | 'permission_denied'
  | 'gnss_unavailable'
  | 'error'
  | 'stopped';

/**
 * Standardized navigation location emitted by all LocationProviders.
 */
export interface NavLocation {
  /** Latitude in decimal degrees (WGS84) */
  latitude: number;
  /** Longitude in decimal degrees (WGS84) */
  longitude: number;
  /** Altitude in meters above WGS84 ellipsoid */
  altitude?: number | null;
  /** Estimated horizontal accuracy radius in meters (68% confidence) */
  accuracy?: number | null;
  /** Estimated vertical accuracy in meters */
  altitudeAccuracy?: number | null;
  /** Course/bearing in degrees (0 - 359.9, 0 = True North, clockwise) */
  heading?: number | null;
  /** Instantaneous speed over ground in meters per second */
  speed?: number | null;
  /** Time of position fix (epoch milliseconds) */
  timestamp: number;
  /** Identity of the provider that produced this fix */
  providerType: ProviderType;
  /** Flag indicating if this fix was dead-reckoned without direct GNSS */
  isDeadReckoning: boolean;
}

export type LocationListener = (location: NavLocation) => void;
export type StatusListener = (status: ProviderStatus, error?: string) => void;

/**
 * Common contract for all positioning engines in the application.
 *
 * In Phase 1:
 *  - GnssLocationProvider: Wraps phone GNSS / FusedLocationProviderClient
 *  - MockLocationProvider: Simulates vehicle driving routes & GNSS dropouts
 *
 * In Phase 2 & 3:
 *  - HybridIdrLocationProvider: Fuses GNSS + IMU (Acc/Gyro/Mag) + IO-VNBD ML
 */
export interface ILocationProvider {
  /** Human-readable name of this provider */
  readonly name: string;
  /** Category tag for telemetry HUD */
  readonly providerType: ProviderType;

  /** Initialize sensors/hardware and begin streaming location fixes */
  start(): Promise<void>;

  /** Cease updates and release hardware resources */
  stop(): Promise<void>;

  /** Query the most recent known location fix synchronously/asynchronously */
  getCurrentLocation(): Promise<NavLocation | null>;

  /** Get current operational status */
  getStatus(): ProviderStatus;

  /** Subscribe to continuous navigation updates. Returns unsubscribe function. */
  addListener(listener: LocationListener): () => void;

  /** Subscribe to provider status/health changes. Returns unsubscribe function. */
  addStatusListener(listener: StatusListener): () => void;
}

/**
 * Map camera tracking modes:
 * - follow_course: Map rotates so vehicle direction of travel is upwards (Course-Up navigation)
 * - follow_north: Map stays oriented North-Up, camera follows vehicle center
 * - free: User is panning/zooming manually; camera does not auto-follow
 */
export type NavigationMode = 'follow_course' | 'follow_north' | 'free';

export interface NavigationTelemetry {
  currentLocation: NavLocation | null;
  speedKmh: number;
  smoothedHeading: number;
  mode: NavigationMode;
  providerStatus: ProviderStatus;
  providerName: string;
  providerType: ProviderType;
  isDeadReckoning: boolean;
  historyTrail: { latitude: number; longitude: number }[];
}
