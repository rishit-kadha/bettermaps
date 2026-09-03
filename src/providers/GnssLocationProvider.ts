import * as Location from 'expo-location';
import {
  ILocationProvider,
  LocationListener,
  NavLocation,
  ProviderStatus,
  ProviderType,
  StatusListener,
} from '../types/location';

/**
 * GnssLocationProvider
 *
 * Concrete implementation of ILocationProvider for Phase 1.
 * Connects directly to the device's native GNSS / GPS subsystem via
 * Android's FusedLocationProviderClient (through expo-location).
 *
 * Output: Standardized NavLocation stream with providerType = 'gnss'
 */
export class GnssLocationProvider implements ILocationProvider {
  public readonly name = 'Device GNSS (Native GPS)';
  public readonly providerType: ProviderType = 'gnss';

  private status: ProviderStatus = 'idle';
  private locationSubscription: Location.LocationSubscription | null = null;
  private lastLocation: NavLocation | null = null;

  private locationListeners = new Set<LocationListener>();
  private statusListeners = new Set<StatusListener>();

  public getStatus(): ProviderStatus {
    return this.status;
  }

  public async getCurrentLocation(): Promise<NavLocation | null> {
    if (this.lastLocation) {
      return this.lastLocation;
    }

    try {
      const position = await Location.getLastKnownPositionAsync({});
      if (position) {
        this.lastLocation = this.normalizePosition(position);
        return this.lastLocation;
      }
    } catch {
      // Non-fatal; continue to fresh fetch
    }

    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      this.lastLocation = this.normalizePosition(position);
      return this.lastLocation;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus('error', `Failed to obtain initial fix: ${message}`);
      return null;
    }
  }

  public async start(): Promise<void> {
    if (this.status === 'active' || this.status === 'initializing') {
      return;
    }

    this.setStatus('initializing');

    try {
      // 1. Check & Request Android Foreground Location Permissions
      const { status: existingStatus } = await Location.getForegroundPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== Location.PermissionStatus.GRANTED) {
        const { status: requestedStatus } = await Location.requestForegroundPermissionsAsync();
        finalStatus = requestedStatus;
      }

      if (finalStatus !== Location.PermissionStatus.GRANTED) {
        this.setStatus('permission_denied', 'Location permission denied by user.');
        return;
      }

      // 2. Check if Location Services are enabled on device
      const isLocationServicesEnabled = await Location.hasServicesEnabledAsync();
      if (!isLocationServicesEnabled) {
        this.setStatus('gnss_unavailable', 'GPS/Location services disabled in system settings.');
        return;
      }

      // 3. Start high-precision continuous navigation stream
      // Using BestForNavigation (uses GPS satellites, Wi-Fi, cell towers + sensor assists)
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 500, // Query at ~2 Hz for Phase 1 GNSS
          distanceInterval: 0.5, // 0.5 meter threshold
        },
        (location) => {
          const navLoc = this.normalizePosition(location);
          this.lastLocation = navLoc;

          if (this.status !== 'active') {
            this.setStatus('active');
          }

          this.notifyLocation(navLoc);
        }
      );

      this.setStatus('active');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus('error', `GNSS provider start failed: ${message}`);
    }
  }

  public async stop(): Promise<void> {
    if (this.locationSubscription) {
      this.locationSubscription.remove();
      this.locationSubscription = null;
    }
    this.setStatus('stopped');
  }

  public addListener(listener: LocationListener): () => void {
    this.locationListeners.add(listener);
    if (this.lastLocation) {
      listener(this.lastLocation);
    }
    return () => {
      this.locationListeners.delete(listener);
    };
  }

  public addStatusListener(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private normalizePosition(loc: Location.LocationObject): NavLocation {
    // Android heading can sometimes be -1 when stationary; normalize to null if invalid
    const heading =
      typeof loc.coords.heading === 'number' && loc.coords.heading >= 0
        ? loc.coords.heading
        : null;

    // Speed in m/s, or null if negative/unavailable
    const speed =
      typeof loc.coords.speed === 'number' && loc.coords.speed >= 0
        ? loc.coords.speed
        : 0;

    return {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      altitude: loc.coords.altitude ?? null,
      accuracy: loc.coords.accuracy ?? null,
      altitudeAccuracy: loc.coords.altitudeAccuracy ?? null,
      heading,
      speed,
      timestamp: loc.timestamp,
      providerType: 'gnss',
      isDeadReckoning: false,
    };
  }

  private setStatus(status: ProviderStatus, error?: string): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status, error));
  }

  private notifyLocation(loc: NavLocation): void {
    this.locationListeners.forEach((listener) => listener(loc));
  }
}
