import * as Location from "expo-location";
import {
  ILocationProvider,
  LocationListener,
  NavLocation,
  ProviderStatus,
  ProviderType,
  StatusListener,
} from "../../core/types/location";

/**
 * AndroidGnssLocationProvider
 *
 * Android Native Platform Location Adapter.
 * Connects directly to Android's FusedLocationProviderClient (via expo-location native module)
 * to stream high-accuracy GNSS/GPS coordinates, course bearing, and ground speed.
 *
 * Emits normalized NavLocation objects to the shared React Native layer.
 */
export class AndroidGnssLocationProvider implements ILocationProvider {
  public readonly name = "Android GNSS (Fused Location)";
  public readonly providerType: ProviderType = "gnss";

  private status: ProviderStatus = "idle";
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
      // Non-fatal; proceed to fresh GPS acquisition
    }

    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      this.lastLocation = this.normalizePosition(position);
      return this.lastLocation;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", `Failed to obtain initial GPS fix: ${message}`);
      return null;
    }
  }

  public async requestPermissions(): Promise<boolean> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === Location.PermissionStatus.GRANTED) {
        await this.start();
        return true;
      } else {
        this.setStatus(
          "permission_denied",
          "Android location permission denied by user.",
        );
        return false;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", `Permission request failed: ${message}`);
      return false;
    }
  }

  public async start(): Promise<void> {
    if (this.status === "active" || this.status === "initializing") {
      return;
    }

    this.setStatus("initializing");

    try {
      // 1. Verify / Request Android Foreground Location Permissions
      const { status: existingStatus } =
        await Location.getForegroundPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== Location.PermissionStatus.GRANTED) {
        const { status: requestedStatus } =
          await Location.requestForegroundPermissionsAsync();
        finalStatus = requestedStatus;
      }

      if (finalStatus !== Location.PermissionStatus.GRANTED) {
        this.setStatus(
          "permission_denied",
          "Location permission denied by user.",
        );
        return;
      }

      // 2. Verify Android Location Services are toggled on in device settings
      const isLocationServicesEnabled =
        await Location.hasServicesEnabledAsync();
      if (!isLocationServicesEnabled) {
        this.setStatus(
          "gnss_unavailable",
          "GPS/Location services disabled in Android settings.",
        );
        return;
      }

      // 3. Start high-precision continuous navigation stream from FusedLocationProviderClient
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 500, // Query interval ~2 Hz for continuous GNSS
          distanceInterval: 0, // 0m displacement: deliver updates continuously even when stationary
        },
        (location) => {
          const navLoc = this.normalizePosition(location);
          this.lastLocation = navLoc;

          if (this.status !== "active") {
            this.setStatus("active");
          }

          this.notifyLocation(navLoc);
        },
      );

      this.setStatus("active");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", `Android GNSS provider start failed: ${message}`);
    }
  }

  public async stop(): Promise<void> {
    if (this.locationSubscription) {
      this.locationSubscription.remove();
      this.locationSubscription = null;
    }
    this.setStatus("stopped");
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
    const heading =
      typeof loc.coords.heading === "number" && loc.coords.heading >= 0
        ? loc.coords.heading
        : null;

    const speed =
      typeof loc.coords.speed === "number" && loc.coords.speed >= 0
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
      providerType: "gnss",
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
