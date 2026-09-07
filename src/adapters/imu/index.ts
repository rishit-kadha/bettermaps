import { IImuProvider } from "../../core/types/imu";
import { AndroidImuProvider } from "./AndroidImuProvider";
import { IosImuProvider } from "./IosImuProvider";

export * from "./AndroidImuProvider";
export * from "./IosImuProvider";

/**
 * Resolves platform-appropriate IMU sensor adapter.
 */
export const createPlatformImuProvider = (): IImuProvider => {
  let platformOs = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native");
    platformOs = rn?.Platform?.OS ?? "unknown";
  } catch (_e) {
    // Plain Node or non-RN environment
  }

  if (platformOs === "android") {
    return new AndroidImuProvider();
  }
  return new IosImuProvider();
};
