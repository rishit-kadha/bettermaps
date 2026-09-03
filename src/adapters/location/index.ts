import { Platform } from "react-native";
import { ILocationProvider } from "../../core/types/location";
import { AndroidGnssLocationProvider } from "./AndroidGnssLocationProvider";
import { IosGnssLocationProvider } from "./IosGnssLocationProvider";
import { MockLocationProvider } from "./MockLocationProvider";

export * from "./AndroidGnssLocationProvider";
export * from "./IosGnssLocationProvider";
export * from "./MockLocationProvider";

export type AvailableProviderId = "native_gnss" | "mock";

/**
 * Creates the platform-appropriate native GNSS location adapter.
 * - Android -> AndroidGnssLocationProvider (wraps FusedLocationProviderClient)
 * - iOS -> IosGnssLocationProvider (wraps CoreLocation)
 * - Other/Web -> MockLocationProvider fallback
 */
export const createPlatformGnssProvider = (): ILocationProvider => {
  if (Platform.OS === "android") {
    return new AndroidGnssLocationProvider();
  } else if (Platform.OS === "ios") {
    return new IosGnssLocationProvider();
  }
  return new MockLocationProvider();
};

/**
 * Provider Registry managing platform adapters.
 */
class LocationProviderRegistry {
  private nativeGnssProvider: ILocationProvider = createPlatformGnssProvider();
  private mockProvider = new MockLocationProvider();

  public getNativeGnssProvider(): ILocationProvider {
    return this.nativeGnssProvider;
  }

  public getMockProvider(): MockLocationProvider {
    return this.mockProvider;
  }

  public getProvider(id: AvailableProviderId): ILocationProvider {
    switch (id) {
      case "native_gnss":
        return this.nativeGnssProvider;
      case "mock":
        return this.mockProvider;
      default:
        return this.nativeGnssProvider;
    }
  }
}

export const providerRegistry = new LocationProviderRegistry();
