import { Platform } from "react-native";
import { IImuProvider } from "../../core/types/imu";
import { AndroidImuProvider } from "./AndroidImuProvider";
import { IosImuProvider } from "./IosImuProvider";

export * from "./AndroidImuProvider";
export * from "./IosImuProvider";

/**
 * Resolves platform-appropriate IMU sensor adapter.
 */
export const createPlatformImuProvider = (): IImuProvider => {
  if (Platform.OS === "android") {
    return new AndroidImuProvider();
  }
  return new IosImuProvider();
};
