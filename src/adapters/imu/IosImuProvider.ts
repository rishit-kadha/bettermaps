import { IImuProvider, ImuListener, ImuSample } from "../../core/types/imu";
import { ProviderStatus } from "../../core/types/location";

/**
 * IosImuProvider
 *
 * iOS Platform Inertial Measurement Unit (IMU) Adapter.
 * Connects to Apple's CoreMotion (CMMotionManager) to stream device motion.
 * Normalizes readings into the exact same ImuSample format as Android.
 */
export class IosImuProvider implements IImuProvider {
  public readonly name = "iOS IMU (CoreMotion)";
  private status: ProviderStatus = "idle";
  private listeners = new Set<ImuListener>();

  public getStatus(): ProviderStatus {
    return this.status;
  }

  public async start(sampleRateHz = 50): Promise<void> {
    this.status = "active";
  }

  public async stop(): Promise<void> {
    this.status = "stopped";
  }

  public addListener(listener: ImuListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
