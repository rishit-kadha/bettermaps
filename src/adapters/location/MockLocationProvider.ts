import {
  ILocationProvider,
  LocationListener,
  NavLocation,
  ProviderStatus,
  ProviderType,
  StatusListener,
} from "../../core/types/location";

interface Waypoint {
  latitude: number;
  longitude: number;
  speedMs: number;
}

const SAMPLE_ROUTE: Waypoint[] = [
  { latitude: 28.6315, longitude: 77.2167, speedMs: 8.5 },
  { latitude: 28.6322, longitude: 77.2174, speedMs: 11.2 },
  { latitude: 28.6331, longitude: 77.2185, speedMs: 13.8 },
  { latitude: 28.6342, longitude: 77.2198, speedMs: 12.5 },
  { latitude: 28.6355, longitude: 77.2205, speedMs: 14.2 },
  { latitude: 28.6368, longitude: 77.2212, speedMs: 10.0 },
  { latitude: 28.6375, longitude: 77.2225, speedMs: 7.0 },
  { latitude: 28.6372, longitude: 77.2241, speedMs: 9.5 },
  { latitude: 28.636, longitude: 77.2255, speedMs: 12.0 },
  { latitude: 28.6345, longitude: 77.226, speedMs: 13.5 },
  { latitude: 28.633, longitude: 77.2252, speedMs: 11.0 },
  { latitude: 28.6318, longitude: 77.2238, speedMs: 8.0 },
  { latitude: 28.6312, longitude: 77.222, speedMs: 6.5 },
  { latitude: 28.631, longitude: 77.2195, speedMs: 7.5 },
  { latitude: 28.6315, longitude: 77.2167, speedMs: 8.5 },
];

/**
 * MockLocationProvider
 *
 * Development and testing adapter.
 * Simulates real-time vehicle navigation along urban coordinates with dynamic bearing.
 * Features an outage simulation toggle for simulating tunnel entry / GNSS loss.
 */
export class MockLocationProvider implements ILocationProvider {
  public readonly name = "Route Simulator (Development)";
  public readonly providerType: ProviderType = "mock";

  private status: ProviderStatus = "idle";
  private timer: ReturnType<typeof setInterval> | null = null;
  private routeIndex = 0;
  private subStep = 0;
  private readonly subStepsPerLeg = 10;
  private lastLocation: NavLocation | null = null;
  private isGnssOutageSimulated = false;

  private locationListeners = new Set<LocationListener>();
  private statusListeners = new Set<StatusListener>();

  public getStatus(): ProviderStatus {
    return this.status;
  }

  public async getCurrentLocation(): Promise<NavLocation | null> {
    if (!this.lastLocation) {
      const p = SAMPLE_ROUTE[0];
      this.lastLocation = {
        latitude: p.latitude,
        longitude: p.longitude,
        altitude: 216,
        accuracy: 3.5,
        heading: 45,
        speed: p.speedMs,
        timestamp: Date.now(),
        providerType: "mock",
        isDeadReckoning: false,
      };
    }
    return this.lastLocation;
  }

  public async start(): Promise<void> {
    if (this.status === "active") return;

    this.setStatus("active");
    this.routeIndex = 0;
    this.subStep = 0;

    this.timer = setInterval(() => {
      this.tick();
    }, 500);
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.setStatus("stopped");
  }

  public toggleOutageSimulation(): boolean {
    this.isGnssOutageSimulated = !this.isGnssOutageSimulated;
    if (this.isGnssOutageSimulated) {
      this.setStatus("gnss_unavailable", "Simulated GNSS outage (Tunnel Mode)");
    } else {
      this.setStatus("active");
    }
    return this.isGnssOutageSimulated;
  }

  public isOutageActive(): boolean {
    return this.isGnssOutageSimulated;
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

  private tick(): void {
    if (this.isGnssOutageSimulated) return;

    const currentWp = SAMPLE_ROUTE[this.routeIndex];
    const nextIndex = (this.routeIndex + 1) % SAMPLE_ROUTE.length;
    const nextWp = SAMPLE_ROUTE[nextIndex];

    const fraction = this.subStep / this.subStepsPerLeg;
    const lat =
      currentWp.latitude + (nextWp.latitude - currentWp.latitude) * fraction;
    const lng =
      currentWp.longitude + (nextWp.longitude - currentWp.longitude) * fraction;
    const speed =
      currentWp.speedMs + (nextWp.speedMs - currentWp.speedMs) * fraction;

    const bearing = this.calculateBearing(
      currentWp.latitude,
      currentWp.longitude,
      nextWp.latitude,
      nextWp.longitude,
    );

    const location: NavLocation = {
      latitude: lat,
      longitude: lng,
      altitude: 216,
      accuracy: 2.8,
      heading: bearing,
      speed,
      timestamp: Date.now(),
      providerType: "mock",
      isDeadReckoning: false,
    };

    this.lastLocation = location;
    this.locationListeners.forEach((fn) => fn(location));

    this.subStep += 1;
    if (this.subStep >= this.subStepsPerLeg) {
      this.subStep = 0;
      this.routeIndex = nextIndex;
    }
  }

  private calculateBearing(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const toDeg = (r: number) => (r * 180) / Math.PI;

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    let brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  }

  private setStatus(status: ProviderStatus, error?: string): void {
    this.status = status;
    this.statusListeners.forEach((fn) => fn(status, error));
  }
}
