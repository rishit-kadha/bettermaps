/**
 * Platform-independent Location Types & LocationProvider Interface.
 *
 * ARCHITECTURAL PRINCIPLE:
 * The React Native UI and Navigation State ONLY interact with these normalized
 * interfaces. They have zero direct knowledge of Android FusedLocationProviderClient,
 * iOS CoreLocation, or underlying GNSS hardware.
 */

export type ProviderType = "gnss" | "idr" | "hybrid" | "mock";

export type ProviderStatus =
  | "idle"
  | "initializing"
  | "active"
  | "permission_denied"
  | "gnss_unavailable"
  | "error"
  | "stopped";

/**
 * Normalized location state emitted by all platform location adapters.
 */
export interface NavLocation {
  /** Latitude in decimal degrees (WGS84) */
  latitude: number;
  /** Longitude in decimal degrees (WGS84) */
  longitude: number;
  /** Altitude in meters above WGS84 ellipsoid */
  altitude?: number | null;
  /** Estimated horizontal 1-sigma accuracy radius in meters */
  accuracy?: number | null;
  /** Estimated vertical accuracy in meters */
  altitudeAccuracy?: number | null;
  /** Alias for vertical accuracy in meters */
  verticalAccuracy?: number | null;
  /** Course/bearing in degrees (0 - 359.9, 0 = True North, clockwise) */
  heading?: number | null;
  /** Instantaneous speed over ground in meters per second */
  speed?: number | null;
  /** Timestamp of position fix (epoch milliseconds) */
  timestamp: number;
  /** Platform/engine identity that produced this fix */
  providerType: ProviderType;
  /** Flag indicating if this fix was dead-reckoned without direct GNSS */
  isDeadReckoning: boolean;
  /** Specific hardware or OS source string (e.g. 'gps', 'fused', 'mock') */
  source?: string;
  /** Indicates whether the location reading is mocked */
  isMock?: boolean;
}

export type LocationListener = (location: NavLocation) => void;
export type StatusListener = (status: ProviderStatus, error?: string) => void;

/**
 * Platform-independent LocationProvider contract.
 *
 * Implementations:
 * - Android: AndroidGnssLocationProvider (Phase 1)
 * - iOS: IosGnssLocationProvider (Future CoreLocation adapter)
 * - Mock: MockLocationProvider (Route replay & outage simulation)
 * - Future: AndroidHybridLocationProvider / IosHybridLocationProvider (GNSS + IMU + IDR)
 */
export interface ILocationProvider {
  /** Human-readable identifier */
  readonly name: string;
  /** Category tag for telemetry and UI */
  readonly providerType: ProviderType;

  /** Initialize platform sensors and start continuous location updates */
  start(): Promise<void>;

  /** Stop updates and release hardware resources */
  stop(): Promise<void>;

  /** Query the most recent known location synchronously/asynchronously */
  getCurrentLocation(): Promise<NavLocation | null>;

  /** Current operational status */
  getStatus(): ProviderStatus;

  /** Request platform location permissions interactively */
  requestPermissions?(): Promise<boolean>;

  /** Subscribe to continuous navigation updates. Returns unsubscribe function. */
  addListener(listener: LocationListener): () => void;

  /** Subscribe to status changes. Returns unsubscribe function. */
  addStatusListener(listener: StatusListener): () => void;
}
