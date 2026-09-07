// Minimal expo-sensors interfaces to prevent hard import from breaking Node.js test environments
interface SensorSubscription {
  remove(): void;
}
interface SensorModule<T> {
  setUpdateInterval(intervalMs: number): void;
  addListener(listener: (data: T) => void): SensorSubscription;
}
interface ExpoSensors {
  Accelerometer: SensorModule<{ x: number; y: number; z: number }>;
  Gyroscope: SensorModule<{ x: number; y: number; z: number }>;
  Magnetometer: SensorModule<{ x: number; y: number; z: number }>;
}

import {
  IImuProvider,
  ImuListener,
  ImuSample,
  Vector3D,
} from "../../core/types/imu";
import { ProviderStatus } from "../../core/types/location";

/**
 * AndroidImuProvider
 *
 * Android Platform Inertial Measurement Unit (IMU) Adapter.
 * Connects directly to Android SensorManager (via native sensor bridge)
 * to stream high-frequency Accelerometer, Gyroscope, and Magnetometer data.
 *
 * Normalizes all sensor readings into cross-platform ImuSample frames
 * for consumption by the IDR engine.
 */
export class AndroidImuProvider implements IImuProvider {
  public readonly name = "Android IMU (SensorManager)";

  private status: ProviderStatus = "idle";
  private accelSub: SensorSubscription | null = null;
  private gyroSub: SensorSubscription | null = null;
  private magSub: SensorSubscription | null = null;

  private latestAccel: Vector3D = { x: 0, y: 0, z: 9.81 };
  private latestGyro: Vector3D = { x: 0, y: 0, z: 0 };
  private latestMag: Vector3D | undefined = undefined;

  private listeners = new Set<ImuListener>();

  public getStatus(): ProviderStatus {
    return this.status;
  }

  public async start(sampleRateHz = 50): Promise<void> {
    if (this.status === "active") return;

    this.status = "initializing";

    try {
      let expoSensors: ExpoSensors | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expoSensors = require("expo-sensors") as ExpoSensors;
      } catch (_e) {
        // Not in Expo environment
      }

      if (!expoSensors) {
        this.status = "error";
        return;
      }

      const { Accelerometer, Gyroscope, Magnetometer } = expoSensors;

      // Calculate update interval in milliseconds (e.g. 50 Hz -> 20ms)
      const intervalMs = Math.max(10, Math.round(1000 / sampleRateHz));

      Accelerometer.setUpdateInterval(intervalMs);
      Gyroscope.setUpdateInterval(intervalMs);
      Magnetometer.setUpdateInterval(intervalMs);

      // 1. Accelerometer subscription (m/s^2 in Android SensorEvent)
      // Note: expo-sensors reports acceleration in G's (1g = 9.81 m/s^2); normalize to m/s^2
      this.accelSub = Accelerometer.addListener((data) => {
        this.latestAccel = {
          x: data.x * 9.80665,
          y: data.y * 9.80665,
          z: data.z * 9.80665,
        };
        this.emitSample();
      });

      // 2. Gyroscope subscription (rad/s)
      this.gyroSub = Gyroscope.addListener((data) => {
        this.latestGyro = {
          x: data.x,
          y: data.y,
          z: data.z,
        };
      });

      // 3. Magnetometer subscription (microteslas, uT)
      this.magSub = Magnetometer.addListener((data) => {
        this.latestMag = {
          x: data.x,
          y: data.y,
          z: data.z,
        };
      });

      this.status = "active";
    } catch (err) {
      this.status = "error";
    }
  }

  public async stop(): Promise<void> {
    if (this.accelSub) {
      this.accelSub.remove();
      this.accelSub = null;
    }
    if (this.gyroSub) {
      this.gyroSub.remove();
      this.gyroSub = null;
    }
    if (this.magSub) {
      this.magSub.remove();
      this.magSub = null;
    }
    this.status = "stopped";
  }

  public addListener(listener: ImuListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitSample(): void {
    const sample: ImuSample = {
      timestamp: Date.now(),
      accel: this.latestAccel,
      gyro: this.latestGyro,
      magnetometer: this.latestMag,
    };

    this.listeners.forEach((listener) => listener(sample));
  }
}
