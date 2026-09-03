# BetterMaps System Architecture

## SIH Problem Statement: "AI-ML based Intelligent Dead Reckoning System for Seamless Navigation"

---

## 1. Architectural Philosophy

BetterMaps is engineered to deliver continuous, reliable vehicle positioning in GNSS-denied environments (tunnels, underground parking, dense urban canyons, dense tree cover) using smartphone inertial sensors (accelerometer, gyroscope, magnetometer) fused with GNSS.

Rather than reinventing mapping or navigation graphics from scratch, BetterMaps pairs standard **Google Maps ecosystem** visualization with a **modular positioning engine abstraction**.

The UI and camera management layers **never interact directly with device GPS hardware**. Instead, they receive positioning information exclusively through the `ILocationProvider` interface:

```
+-----------------------------------------------------------------------------------+
|                                 UI & Map Layer                                    |
|   NavigationMap (Google Maps) | NavigationHUD (Telemetry) | NavigationControls     |
+-----------------------------------------------------------------------------------+
                                         ▲
                                         │ Consumes NavLocation & State
+-----------------------------------------------------------------------------------+
|                              Navigation State Layer                               |
|   NavigationManager (Heading smoothing, Camera follow modes, Trajectory history)  |
+-----------------------------------------------------------------------------------+
                                         ▲
                                         │ Emits standard NavLocation stream
+-----------------------------------------------------------------------------------+
|                        Positioning Engine Abstraction                             |
|                               ILocationProvider                                   |
+-----------------------------------------------------------------------------------+
                   ▲                                               ▲
                   │                                               │
+--------------------------------------+       +------------------------------------+
|         GnssLocationProvider         |       |        MockLocationProvider        |
|               (Phase 1)              |       |      (Phase 1 Dev & Testing)       |
|  - Android Fused Location Provider   |       |  - Realistic city driving route    |
|  - Fine GPS + Satellite tracking     |       |  - Tunnel / GNSS outage simulation |
|  - Standard 1-2 Hz location fixes    |       |  - Decoupling validation           |
+--------------------------------------+       +------------------------------------+
                   ▲
                   │ (Future Evolution)
+-----------------------------------------------------------------------------------+
|                             HybridIdrLocationProvider                             |
|                                   (Phases 2 & 3)                                  |
|  ┌─────────────────────────────────────────────────────────────────────────────┐  |
|  │  1. High-Rate IMU Ingestion (Acc, Gyro, Mag @ 50-200 Hz via SensorManager)  │  |
|  │  2. IMU Preprocessing: Noise filtering, vibration & pothole suppression     │  |
|  │  3. Phone-to-Vehicle Attitude Estimation & Dynamic Alignment                │  |
|  │  4. ML Forward Velocity Estimator (Trained on IO-VNBD dataset)              │  |
|  │  5. INS Strapdown Mechanization (Attitude, Velocity, Position integration)  │  |
|  │  6. Non-Holonomic Constraints (NHC) & Zero Velocity Updates (ZUPT)          │  |
|  │  7. GNSS + INS Extended Kalman Filter (EKF) / Error-State Kalman Filter     │  |
|  │  8. Map-Matching Drift Correction                                           │  |
|  │  9. 10 Hz Unified Navigation State Output                                   │  |
|  └─────────────────────────────────────────────────────────────────────────────┘  |
+-----------------------------------------------------------------------------------+
```

---

## 2. Core Abstractions (`src/types/location.ts`)

### `NavLocation`

All position fixes are normalized into `NavLocation`:

```typescript
export interface NavLocation {
  latitude: number; // WGS84 latitude
  longitude: number; // WGS84 longitude
  altitude?: number | null; // Altitude in meters
  accuracy?: number | null; // Horizontal accuracy radius (meters)
  heading?: number | null; // Heading / course (0-359.9 deg, 0 = True North)
  speed?: number | null; // Speed over ground (m/s)
  timestamp: number; // Epoch milliseconds
  providerType: ProviderType; // 'gnss' | 'idr' | 'hybrid' | 'mock'
  isDeadReckoning: boolean; // true when GNSS is lost & dead reckoning is active
}
```

### `ILocationProvider`

The universal interface implemented by all positioning providers:

```typescript
export interface ILocationProvider {
  readonly name: string;
  readonly providerType: ProviderType;

  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrentLocation(): Promise<NavLocation | null>;
  getStatus(): ProviderStatus;
  addListener(listener: LocationListener): () => void;
  addStatusListener(listener: StatusListener): () => void;
}
```

---

## 3. Phase 1 Implementation

### `GnssLocationProvider`

- Integrates with Android's `FusedLocationProviderClient` via `expo-location`.
- Configured with `Accuracy.BestForNavigation` (uses GPS, GLONASS, Galileo, BeiDou, Wi-Fi, and cell assistance).
- Handles permission acquisition (`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`).
- Detects whether device location services are toggled on.
- Normalizes raw Android location updates into `NavLocation`.

### `MockLocationProvider`

- Provides realistic urban vehicle driving simulation with smooth waypoint interpolation, heading calculation, and variable speed profiles.
- Features **Tunnel / GPS Outage Simulation**: toggling the outage causes GNSS loss, demonstrating how the UI and provider status react when satellites disappear.

### `NavigationManager`

- Manages the active provider lifecycle.
- Manages map tracking modes:
  - `follow_course`: Course-Up mode with 3D tilted camera (45° pitch) matching driving direction.
  - `follow_north`: North-Up mode with top-down 2D camera.
  - `free`: Unconstrained pan/zoom inspection. Automatically activates when the user touches the map.
- Implements a circular exponential filter (`filterHeading`) for smooth heading rotation without snapping across the 0°/360° boundary.
- Maintains a trajectory breadcrumb history trail.

### UI Components

- **`NavigationMap`**: Native Google Maps view (`react-native-maps`, `PROVIDER_GOOGLE`), animated camera synchronization, and route breadcrumb polyline.
- **`VehiclePuck`**: Navigation puck displaying orientation chevron and pulse ring; changes color from Google Blue to Amber when in dead-reckoning state.
- **`NavigationHUD`**: Real-time HUD showing speed (km/h), heading with cardinal notation (e.g., `042° NE`), accuracy radius, coordinate readout, and engine status badge.
- **`NavigationControls`**: One-touch controls for tracking mode switching, camera recentering, and live GNSS vs simulation route selection.

---

## 4. Roadmap to Phase 2 & 3: Intelligent Dead Reckoning

### Phase 2: Sensor Ingestion & Kinematic Dead Reckoning

1. **High-Rate IMU Ingestion**:
   - Access `SensorManager` on Android for Accelerometer, Gyroscope, and Magnetometer at 50 Hz – 100 Hz.
2. **Attitude and Heading Reference System (AHRS)**:
   - Quaternion-based complementary filter or Madgwick/Mahony filter to estimate device orientation relative to the vehicle coordinate frame.
3. **Gravity Removal & Vibration Suppression**:
   - Bandpass / Butterworth filtering to suppress engine vibrations, road noise, potholes, and speed bumps.
4. **Basic Kinematic Dead Reckoning**:
   - Integrate longitudinal acceleration with Non-Holonomic Constraints (NHC) assuming zero lateral slip for ground vehicles.

### Phase 3: AI/ML Forward Velocity & Fusion (IO-VNBD Dataset)

1. **IO-VNBD Model**:
   - Train a lightweight 1D-CNN or GRU model on the [IO-VNBD](https://github.com/onyekpeu/IO-VNBD) (Inertial and Odometry Benchmark Dataset for Ground Vehicle Positioning) to estimate instantaneous forward vehicle speed from raw IMU windows.
2. **Edge Deployment**:
   - Quantize model to TFLite / ONNX Runtime Mobile for sub-5ms inference on budget Android smartphones.
3. **Error-State Kalman Filter (ESKF)**:
   - When GNSS is available: Fuse GNSS + IMU to continuously calibrate accelerometer/gyroscope biases and phone-to-vehicle alignment.
   - When GNSS is lost: Transition seamlessly to Dead Reckoning using ML forward velocity + gyro heading + NHC.
   - When GNSS returns: Seamlessly re-converge position and update filter covariance without trajectory jumping.
4. **Integration**:
   - Wrap the entire pipeline in `HybridIdrLocationProvider` implementing `ILocationProvider`.
   - The UI continues to run completely unmodified!
