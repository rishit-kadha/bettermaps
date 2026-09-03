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
 * IosGnssLocationProvider
 *
 * iOS Platform Location Adapter.
 * Connects to Apple's CoreLocation framework (via expo-location native bridge).
 * Emits the exact same normalized NavLocation stream as AndroidGnssLocationProvider.
 */
export class IosGnssLocationProvider implements ILocationProvider {
  public readonly name = "iOS CoreLocation (GNSS)";
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
    if (this.lastLocation) return this.lastLocation;

    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      this.lastLocation = this.normalizePosition(position);
      return this.lastLocation;
    } catch {
      return null;
    }
  }

  public async requestPermissions(): Promise<boolean> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === Location.PermissionStatus.GRANTED) {
        await this.start();
        return true;
      }
      this.setStatus("permission_denied", "iOS Location permission denied.");
      return false;
    } catch {
      return false;
    }
  }

  public async start(): Promise<void> {
    if (this.status === "active" || this.status === "initializing") return;

    this.setStatus("initializing");

    try {
      const { status: existingStatus } =
        await Location.getForegroundPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== Location.PermissionStatus.GRANTED) {
        const { status: req } =
          await Location.requestForegroundPermissionsAsync();
        finalStatus = req;
      }

      if (finalStatus !== Location.PermissionStatus.GRANTED) {
        this.setStatus("permission_denied", "iOS Location permission denied.");
        return;
      }

      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 500,
          distanceInterval: 0.5,
        },
        (location) => {
          const navLoc = this.normalizePosition(location);
          this.lastLocation = navLoc;
          if (this.status !== "active") this.setStatus("active");
          this.notifyLocation(navLoc);
        },
      );

      this.setStatus("active");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", `iOS CoreLocation start failed: ${message}`);
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
    if (this.lastLocation) listener(this.lastLocation);
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
    this.statusListeners.forEach((l) => l(status, error));
  }

  private notifyLocation(loc: NavLocation): void {
    this.locationListeners.forEach((l) => l(loc));
  }
}
