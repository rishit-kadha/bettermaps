import { ILocationProvider } from "../types/location";
import { GnssLocationProvider } from "./GnssLocationProvider";
import { MockLocationProvider } from "./MockLocationProvider";

export * from "./GnssLocationProvider";
export * from "./MockLocationProvider";

export type AvailableProviderId = "gnss" | "mock";

/**
 * Provider registry to switch between location engines at runtime.
 */
class LocationProviderRegistry {
  private gnssProvider = new GnssLocationProvider();
  private mockProvider = new MockLocationProvider();
  private activeProvider: ILocationProvider = this.gnssProvider;

  public getProvider(id: AvailableProviderId): ILocationProvider {
    switch (id) {
      case "gnss":
        return this.gnssProvider;
      case "mock":
        return this.mockProvider;
      default:
        return this.gnssProvider;
    }
  }

  public getGnssProvider(): GnssLocationProvider {
    return this.gnssProvider;
  }

  public getMockProvider(): MockLocationProvider {
    return this.mockProvider;
  }
}

export const providerRegistry = new LocationProviderRegistry();
