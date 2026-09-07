import { ILocationProvider } from "../../core/types/location";
import { MockLocationProvider } from "./MockLocationProvider";

export * from "./MockLocationProvider";

export type AvailableProviderId = "native_gnss" | "mock";

/**
 * Creates the platform-appropriate native GNSS location adapter.
 * - Android -> AndroidGnssLocationProvider (wraps FusedLocationProviderClient)
 * - iOS -> IosGnssLocationProvider (wraps CoreLocation)
 * - Other/Web -> MockLocationProvider fallback
 */
export const createPlatformGnssProvider = (): ILocationProvider => {
  let platformOs = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native");
    platformOs = rn?.Platform?.OS ?? "unknown";
  } catch (_e) {
    // Plain Node or non-RN environment
  }

  if (platformOs === "android") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AndroidGnssLocationProvider } = require("./AndroidGnssLocationProvider");
    return new AndroidGnssLocationProvider();
  } else if (platformOs === "ios") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { IosGnssLocationProvider } = require("./IosGnssLocationProvider");
    return new IosGnssLocationProvider();
  }
  return new MockLocationProvider();
};

/**
 * Provider Registry managing platform adapters.
 */
class LocationProviderRegistry {
  private nativeGnssProvider: ILocationProvider | null = null;
  private mockProvider = new MockLocationProvider();

  public getNativeGnssProvider(): ILocationProvider {
    if (!this.nativeGnssProvider) {
      this.nativeGnssProvider = createPlatformGnssProvider();
    }
    return this.nativeGnssProvider;
  }

  public getMockProvider(): MockLocationProvider {
    return this.mockProvider;
  }

  public getProvider(id: AvailableProviderId): ILocationProvider {
    switch (id) {
      case "native_gnss":
        return this.getNativeGnssProvider();
      case "mock":
        return this.mockProvider;
      default:
        return this.getNativeGnssProvider();
    }
  }
}

export const providerRegistry = new LocationProviderRegistry();
